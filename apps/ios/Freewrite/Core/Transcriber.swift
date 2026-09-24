import Foundation

enum TranscriptionEvent: Sendable {
    case preparing
    case downloading(Double)
    case listening
    case segment(String, isFinal: Bool)
}

@MainActor protocol Transcriber: AnyObject {
    func start() -> AsyncThrowingStream<TranscriptionEvent, any Error>
    func stop() async
    func cancel()
}
