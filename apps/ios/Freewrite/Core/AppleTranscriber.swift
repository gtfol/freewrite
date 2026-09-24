#if os(iOS)
import Foundation
import AVFoundation
import Speech

@MainActor final class AppleTranscriber: Transcriber {
    private var engine: AVAudioEngine?
    private var hasTap = false
    private var analyzer: SpeechAnalyzer?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var output: AsyncThrowingStream<TranscriptionEvent, any Error>.Continuation?
    private var setupTask: Task<Void, Never>?
    private var resultsTask: Task<Void, Never>?
    private var progressTask: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []
    private var sessionID: UUID?

    func start() -> AsyncThrowingStream<TranscriptionEvent, any Error> {
        cancel()
        let id = UUID(); sessionID = id
        let (stream, continuation) = AsyncThrowingStream<TranscriptionEvent, any Error>.makeStream()
        output = continuation
        continuation.yield(.preparing)
        setupTask = Task { [weak self] in
            guard let self else { return }
            do { try await self.prepare(id: id) }
            catch {
                guard self.sessionID == id else { return }
                self.fail(error as? WritingError ?? .audio)
            }
        }
        return stream
    }

    private func check(_ id: UUID) throws {
        try Task.checkCancellation()
        guard sessionID == id else { throw CancellationError() }
    }

    private func prepare(id: UUID) async throws {
        if AVAudioApplication.shared.recordPermission == .denied { throw WritingError.microphoneDenied }
        guard SpeechTranscriber.isAvailable else { throw WritingError.unavailable }
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: .current) else { throw WritingError.unsupportedLanguage }
        try check(id)
        guard await AVAudioApplication.requestRecordPermission() else { throw WritingError.microphoneDenied }
        try check(id)
        let speech = SpeechTranscriber(locale: locale, transcriptionOptions: [],
                                       reportingOptions: [.volatileResults], attributeOptions: [])
        do {
            let reserved = await AssetInventory.reservedLocales
            if !reserved.contains(locale) {
                guard try await AssetInventory.reserve(locale: locale) else { throw WritingError.modelDownload }
                // Keep the app's locale reservation so the on-device model stays cached.
                try check(id)
            }
            if let request = try await AssetInventory.assetInstallationRequest(supporting: [speech]) {
                try check(id)
                output?.yield(.downloading(request.progress.fractionCompleted))
                progressTask = Task { [weak self] in
                    while !Task.isCancelled {
                        guard let self, self.sessionID == id else { return }
                        self.output?.yield(.downloading(request.progress.fractionCompleted))
                        do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
                    }
                }
                try await request.downloadAndInstall()
                progressTask?.cancel(); progressTask = nil
            }
        } catch {
            if error is CancellationError { throw error }
            throw WritingError.modelDownload
        }
        try check(id)
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.record, mode: .measurement, options: [.allowBluetoothHFP])
        try audioSession.setActive(true)
        let engine = AVAudioEngine(); self.engine = engine
        let sourceFormat = engine.inputNode.outputFormat(forBus: 0)
        guard sourceFormat.sampleRate > 0, sourceFormat.channelCount > 0,
              let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [speech], considering: sourceFormat) else { throw WritingError.audio }
        try check(id)
        let analyzer = SpeechAnalyzer(modules: [speech]); self.analyzer = analyzer
        try await analyzer.prepareToAnalyze(in: format)
        try check(id)
        let (audio, continuation) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingOldest(24))
        input = continuation
        let bridge = try AudioBufferBridge(from: sourceFormat, to: format, continuation: continuation) { [weak self] in
            Task { @MainActor in
                guard self?.sessionID == id else { return }
                self?.fail(.audio)
            }
        }
        resultsTask = Task { [weak self] in
            do {
                for try await result in speech.results {
                    guard let self, self.sessionID == id else { return }
                    self.output?.yield(.segment(String(result.text.characters), isFinal: result.isFinal))
                }
            } catch {
                guard let self, self.sessionID == id else { return }
                self.fail(.audio)
            }
        }
        try await analyzer.start(inputSequence: audio)
        try check(id)
        engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: sourceFormat) { buffer, _ in bridge.consume(buffer) }
        hasTap = true
        engine.prepare(); try engine.start()
        observeInterruptions(id: id)
        output?.yield(.listening)
    }

    func stop() async {
        guard let id = sessionID else { return }
        guard let analyzer, engine?.isRunning == true else {
            // Cancel microphone/model preparation without starting recording later.
            let continuation = output
            cancel()
            continuation?.finish()
            return
        }
        stopCapture()
        input?.finish(); input = nil
        do {
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            await resultsTask?.value
            guard sessionID == id else { return }
            let continuation = output
            releaseSession()
            continuation?.finish()
        } catch {
            if sessionID == id { fail(.audio) }
        }
    }

    func cancel() {
        let oldAnalyzer = analyzer
        let continuation = output
        releaseSession()
        if let oldAnalyzer { Task { await oldAnalyzer.cancelAndFinishNow() } }
        continuation?.finish()
    }

    private func fail(_ error: WritingError) {
        let oldAnalyzer = analyzer
        let continuation = output
        releaseSession()
        if let oldAnalyzer { Task { await oldAnalyzer.cancelAndFinishNow() } }
        continuation?.finish(throwing: error)
    }

    private func stopCapture() {
        if let engine {
            engine.stop()
            if hasTap { engine.inputNode.removeTap(onBus: 0) }
        }
        engine = nil; hasTap = false
    }

    private func releaseSession() {
        sessionID = nil
        setupTask?.cancel(); setupTask = nil
        progressTask?.cancel(); progressTask = nil
        resultsTask?.cancel(); resultsTask = nil
        stopCapture(); input?.finish(); input = nil; analyzer = nil; output = nil
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func observeInterruptions(id: UUID) {
        for name in [AVAudioSession.interruptionNotification, AVAudioSession.routeChangeNotification,
                     AVAudioSession.mediaServicesWereResetNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard self?.sessionID == id else { return }
                    self?.fail(.interrupted)
                }
            })
        }
    }
}

// AVAudioEngine invokes this bridge only on its serial audio-tap callback.
// Each converted buffer is newly owned by AnalyzerInput and never mutated again.
private final class AudioBufferBridge: @unchecked Sendable {
    let converter: AVAudioConverter
    let format: AVAudioFormat
    let continuation: AsyncStream<AnalyzerInput>.Continuation
    let failed: @Sendable () -> Void

    init(from: AVAudioFormat, to: AVAudioFormat, continuation: AsyncStream<AnalyzerInput>.Continuation,
         failed: @escaping @Sendable () -> Void) throws {
        guard let converter = AVAudioConverter(from: from, to: to) else { throw WritingError.audio }
        self.converter = converter; format = to; self.continuation = continuation; self.failed = failed
    }
    func consume(_ source: AVAudioPCMBuffer) {
        let capacity = AVAudioFrameCount(ceil(Double(source.frameLength) * format.sampleRate / source.format.sampleRate)) + 32
        guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { failed(); return }
        let supply = ConversionInput(source)
        var error: NSError?
        let status = converter.convert(to: converted, error: &error) { _, state in
            supply.next(state)
        }
        guard error == nil, status != .error else { failed(); return }
        guard converted.frameLength > 0 else { return }
        if case .dropped = continuation.yield(AnalyzerInput(buffer: converted)) { failed() }
    }
}

// convert(to:error:withInputFrom:) consumes this synchronously. The lock also
// protects its single-use flag if the converter requests input on another queue.
private final class ConversionInput: @unchecked Sendable {
    private let buffer: AVAudioPCMBuffer
    private let lock = NSLock()
    private var supplied = false
    init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }
    func next(_ state: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer? {
        lock.lock(); defer { lock.unlock() }
        if supplied { state.pointee = .noDataNow; return nil }
        supplied = true; state.pointee = .haveData; return buffer
    }
}
#endif
