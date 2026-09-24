import Foundation
import Observation

@MainActor @Observable final class WriterModel {
    private(set) var entries: [Entry] = []
    private(set) var current: Entry?
    var selection = NSRange(location: 0, length: 0)
    private(set) var phase = Phase.idle
    private(set) var downloadProgress: Double = 0
    var notice: WritingError?
    private(set) var saveFailed = false
    private(set) var dirty = false
    private(set) var cleanupUndo: CleanupUndo?
    let timer = SessionTimer()
    var backspaceLocked = false
    private let store: any EntryStore
    private let transcriber: any Transcriber
    private let cleaner: any TextCleaner
    private let defaults: UserDefaults
    private var insertion: DictationInsertion?
    private var runID: UUID?
    private var transcriptTask: Task<Void, Never>?
    private var saveTask: Task<Void, Never>?

    enum Phase: Equatable { case idle, preparing, downloading, listening, stopping, cleaning }
    struct CleanupUndo { let id = UUID(); var range: NSRange; let raw: String; let cleaned: String }

    init(store: any EntryStore, transcriber: any Transcriber, cleaner: any TextCleaner = OnDeviceTextCleaner(),
         defaults: UserDefaults = .standard) {
        self.store = store; self.transcriber = transcriber; self.cleaner = cleaner; self.defaults = defaults
        backspaceLocked = defaults.bool(forKey: "backspaceLocked")
        load()
    }

    var text: String { current?.content ?? "" }
    var active: Bool { phase != .idle }

    func load() {
        do {
            entries = try store.entries()
            let last = defaults.string(forKey: "lastEntryID")
            current = entries.first { $0.id == last } ?? entries.first
            if current == nil { newEntry() }
            selection = NSRange(location: text.utf16.count, length: 0)
        } catch { saveFailed = true }
    }

    func setBackspaceLocked(_ locked: Bool) {
        backspaceLocked = locked
        defaults.set(locked, forKey: "backspaceLocked")
    }

    @discardableResult func flush() -> Bool {
        saveTask?.cancel(); saveTask = nil
        guard let current else { return !saveFailed }
        do {
            try store.save(current)
            dirty = false; saveFailed = false
            return true
        } catch { saveFailed = true; return false }
    }

    private func saveSoon() {
        // Throttle, rather than debounce: uninterrupted speech still reaches disk.
        guard saveTask == nil else { return }
        saveTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
            self?.saveTask = nil
            _ = self?.flush()
        }
    }

    private func updateText(_ text: String, immediately: Bool = false) {
        guard var entry = current else { return }
        entry.content = text; entry.updatedAt = Entry.timestamp(); current = entry
        if let index = entries.firstIndex(where: { $0.id == entry.id }) { entries[index] = entry }
        dirty = true
        if immediately { _ = flush() } else { saveSoon() }
    }

    func newEntry() {
        guard flush() else { return }
        abandonDictation()
        let entry = Entry()
        do { try store.save(entry) } catch { saveFailed = true; return }
        entries.insert(entry, at: 0); current = entry; selection = NSRange(location: 0, length: 0)
        defaults.set(entry.id, forKey: "lastEntryID"); cleanupUndo = nil; notice = nil
    }

    func select(_ entry: Entry) {
        guard flush() else { return }
        abandonDictation(); current = entry; cleanupUndo = nil; notice = nil
        selection = NSRange(location: text.utf16.count, length: 0)
        defaults.set(entry.id, forKey: "lastEntryID")
    }

    func delete(_ entry: Entry) {
        guard flush() else { return }
        var deleted = entry; deleted.content = ""; deleted.deletedAt = Entry.timestamp(); deleted.updatedAt = deleted.deletedAt!
        do { try store.save(deleted) } catch { saveFailed = true; return }
        entries.removeAll { $0.id == entry.id }
        if current?.id == entry.id {
            abandonDictation(); current = nil; cleanupUndo = nil
            if let next = entries.first { select(next) } else { newEntry() }
        }
    }

    @discardableResult func edit(range: NSRange, replacement: String) -> Bool {
        guard !(backspaceLocked && range.length > 0),
              let next = TextInsertion.replacing(text, range: range, with: replacement) else { return false }
        if var span = insertion {
            if let moved = TextInsertion.adjusted(span.range, for: range, replacementLength: replacement.utf16.count) {
                span.range = moved; insertion = span
            } else { abandonDictation() }
        }
        if var undo = cleanupUndo {
            if let moved = TextInsertion.adjusted(undo.range, for: range, replacementLength: replacement.utf16.count) {
                undo.range = moved; cleanupUndo = undo
            } else { cleanupUndo = nil }
        }
        updateText(next)
        selection = NSRange(location: range.location + replacement.utf16.count, length: 0)
        return true
    }

    func startDictation() {
        guard !active, current != nil else { return }
        let token = UUID(); runID = token; notice = nil; cleanupUndo = nil
        insertion = DictationInsertion(text: text, caret: NSMaxRange(selection))
        phase = .preparing
        let stream = transcriber.start()
        transcriptTask = Task { [weak self] in
            guard let self else { return }
            do {
                for try await event in stream {
                    guard self.runID == token else { return }
                    self.receive(event)
                }
                guard self.runID == token else { return }
                await self.finishCleanup(token: token)
            } catch {
                guard self.runID == token else { return }
                self.notice = error as? WritingError ?? .audio
                self.phase = .idle; self.insertion = nil; self.runID = nil
                _ = self.flush()
            }
        }
    }

    func stopDictation() async {
        guard active, phase != .cleaning, phase != .stopping else { return }
        phase = .stopping
        await transcriber.stop()
    }

    private func receive(_ event: TranscriptionEvent) {
        switch event {
        case .preparing: if phase != .stopping { phase = .preparing }
        case .downloading(let progress): if phase != .stopping { phase = .downloading; downloadProgress = progress }
        case .listening: if phase != .stopping { phase = .listening }
        case .segment(let words, let isFinal):
            guard var span = insertion else { return }
            let prior = span.range
            span.receive(words, isFinal: isFinal)
            guard let next = TextInsertion.replacing(text, range: prior, with: span.inserted) else { abandonDictation(); return }
            span.range.length = span.inserted.utf16.count
            insertion = span
            if selection.location >= NSMaxRange(prior) {
                selection.location += span.range.length - prior.length
            }
            updateText(next, immediately: isFinal)
        }
    }

    private func finishCleanup(token: UUID) async {
        _ = flush() // Raw text is durable before cleanup starts.
        guard let captured = insertion, !captured.transcript.isEmpty else {
            phase = .idle; insertion = nil; runID = nil; return
        }
        phase = .cleaning
        defer {
            if runID == token { phase = .idle; insertion = nil; runID = nil }
        }
        do {
            let cleaned = try await cleaner.clean(captured.transcript)
            guard runID == token, let live = insertion else { return }
            let raw = live.inserted
            let replacement = live.decorated(cleaned)
            guard let range = Range(live.range, in: text), String(text[range]) == raw,
                  let next = TextInsertion.replacing(text, range: live.range, with: replacement) else { return }
            if raw != replacement {
                cleanupUndo = CleanupUndo(range: NSRange(location: live.range.location, length: replacement.utf16.count), raw: raw, cleaned: replacement)
                if selection.location >= NSMaxRange(live.range) { selection.location += replacement.utf16.count - raw.utf16.count }
                updateText(next, immediately: true)
            }
        } catch {
            guard runID == token else { return }
            notice = .cleanup
        }
    }

    func undoCleanup() {
        guard let undo = cleanupUndo, let range = Range(undo.range, in: text), text[range] == undo.cleaned,
              let restored = TextInsertion.replacing(text, range: undo.range, with: undo.raw) else { return }
        updateText(restored, immediately: true)
        selection = NSRange(location: undo.range.location + undo.raw.utf16.count, length: 0)
        cleanupUndo = nil
    }

    func background() {
        let wasActive = active
        abandonDictation(); _ = flush()
        if wasActive { notice = .interrupted }
    }

    private func abandonDictation() {
        runID = nil; transcriptTask?.cancel(); transcriptTask = nil
        transcriber.cancel(); insertion = nil; phase = .idle
    }
}
