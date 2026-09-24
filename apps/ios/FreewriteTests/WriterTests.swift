import XCTest
#if SWIFT_PACKAGE
@testable import FreewriteCore
#else
@testable import Freewrite
#endif

@MainActor final class MemoryEntries: EntryStore {
    var saved: [String: Entry] = [:]
    var failing = false
    func entries() throws -> [Entry] { saved.values.filter { $0.deletedAt == nil }.sorted { $0.createdAt > $1.createdAt } }
    func save(_ entry: Entry) throws { if failing { throw WritingError.storage }; saved[entry.id] = entry }
}
@MainActor final class TestTranscriber: Transcriber {
    var continuation: AsyncThrowingStream<TranscriptionEvent, any Error>.Continuation?
    func start() -> AsyncThrowingStream<TranscriptionEvent, any Error> {
        let (stream, continuation) = AsyncThrowingStream<TranscriptionEvent, any Error>.makeStream()
        self.continuation = continuation
        return stream
    }
    func stop() async { continuation?.finish() }
    func cancel() { continuation?.finish() }
}
struct FailingCleaner: TextCleaner { func clean(_ text: String) async throws -> String { throw WritingError.cleanup } }
actor DelayedCleaner: TextCleaner {
    var continuation: CheckedContinuation<String, Never>?
    func clean(_ text: String) async throws -> String {
        await withCheckedContinuation { continuation = $0 }
    }
    func finish(_ text: String) { continuation?.resume(returning: text); continuation = nil }
    var waiting: Bool { continuation != nil }
}

@MainActor final class WriterTests: XCTestCase {
    func fixture(cleaner: any TextCleaner = OnDeviceTextCleaner()) -> (WriterModel, MemoryEntries, TestTranscriber) {
        let store = MemoryEntries(), transcriber = TestTranscriber()
        let defaults = UserDefaults(suiteName: "freewrite-tests-\(UUID())")!
        return (WriterModel(store: store, transcriber: transcriber, cleaner: cleaner, defaults: defaults), store, transcriber)
    }
    func settle(_ predicate: @escaping @MainActor () -> Bool) async throws {
        for _ in 0..<200 {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("State did not settle")
    }
    func testLiveSegmentsSavedBeforeStopAndUndo() async throws {
        let (writer, store, transcriber) = fixture()
        writer.startDictation()
        transcriber.continuation?.yield(.segment("um hello", isFinal: true))
        try await settle { writer.text == "um hello" }
        XCTAssertEqual(store.saved[writer.current!.id]?.content, "um hello")
        await writer.stopDictation()
        try await settle { writer.phase == .idle }
        XCTAssertEqual(writer.text, "Hello.")
        writer.setBackspaceLocked(true); writer.undoCleanup()
        XCTAssertEqual(writer.text, "um hello")
        XCTAssertEqual(store.saved[writer.current!.id]?.content, "um hello")
    }
    func testProvisionalTextSavedWhileStillRecording() async throws {
        let (writer, store, transcriber) = fixture()
        writer.startDictation()
        transcriber.continuation?.yield(.segment("still speaking", isFinal: false))
        try await settle { writer.text == "still speaking" }
        try await Task.sleep(for: .milliseconds(650))
        XCTAssertEqual(store.saved[writer.current!.id]?.content, "still speaking")
        XCTAssertTrue(writer.active)
        writer.background()
    }
    func testMiddleInsertionAndSurroundingEdits() async throws {
        let (writer, _, transcriber) = fixture()
        writer.edit(range: NSRange(location: 0, length: 0), replacement: "before after")
        writer.selection = NSRange(location: 7, length: 0); writer.startDictation()
        transcriber.continuation?.yield(.segment("um hello", isFinal: true))
        try await settle { writer.text == "before um hello after" }
        writer.edit(range: NSRange(location: 0, length: 0), replacement: "👋 ")
        await writer.stopDictation(); try await settle { writer.phase == .idle }
        XCTAssertEqual(writer.text, "👋 before Hello. after")
        writer.undoCleanup(); XCTAssertEqual(writer.text, "👋 before um hello after")
    }
    func testFailureKeepsRawWords() async throws {
        let (writer, store, transcriber) = fixture(cleaner: FailingCleaner())
        writer.startDictation(); transcriber.continuation?.yield(.segment("um raw words", isFinal: true))
        try await settle { !writer.text.isEmpty }
        await writer.stopDictation(); try await settle { writer.phase == .idle }
        XCTAssertEqual(writer.text, "um raw words"); XCTAssertEqual(writer.notice, .cleanup)
        XCTAssertEqual(store.saved[writer.current!.id]?.content, "um raw words")
    }
    func testInterruptionRetainsLatestProvisionalWords() async throws {
        let (writer, store, transcriber) = fixture()
        writer.startDictation(); transcriber.continuation?.yield(.segment("unfinished words", isFinal: false))
        try await settle { !writer.text.isEmpty }
        transcriber.continuation?.finish(throwing: WritingError.interrupted)
        try await settle { writer.phase == .idle }
        XCTAssertEqual(writer.notice, .interrupted)
        XCTAssertEqual(store.saved[writer.current!.id]?.content, "unfinished words")
    }
    func testLateCleanupCannotOverwriteNewEntry() async throws {
        let cleaner = DelayedCleaner()
        let (writer, _, transcriber) = fixture(cleaner: cleaner)
        writer.startDictation(); transcriber.continuation?.yield(.segment("um hello", isFinal: true))
        try await settle { !writer.text.isEmpty }; await writer.stopDictation()
        try await settle { writer.phase == .cleaning }
        let old = writer.current!.id
        writer.newEntry(); let new = writer.current!.id
        await cleaner.finish("Hello.")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertNotEqual(old, new); XCTAssertEqual(writer.text, "")
    }
    func testManualOverlapCancelsCleanup() async throws {
        let cleaner = DelayedCleaner()
        let (writer, _, transcriber) = fixture(cleaner: cleaner)
        writer.startDictation(); transcriber.continuation?.yield(.segment("um hello", isFinal: true))
        try await settle { !writer.text.isEmpty }; await writer.stopDictation()
        try await settle { writer.phase == .cleaning }
        writer.edit(range: NSRange(location: 3, length: 5), replacement: "goodbye")
        await cleaner.finish("Hello.")
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(writer.text, "um goodbye"); XCTAssertEqual(writer.phase, .idle)
    }
    func testFailedSaveBlocksNavigationAndCanRetry() {
        let (writer, store, _) = fixture()
        let id = writer.current!.id
        writer.edit(range: NSRange(location: 0, length: 0), replacement: "keep me")
        store.failing = true; writer.newEntry()
        XCTAssertEqual(writer.current?.id, id); XCTAssertTrue(writer.saveFailed)
        store.failing = false; XCTAssertTrue(writer.flush())
        XCTAssertEqual(store.saved[id]?.content, "keep me")
    }
    func testLockRejectsDeletionAndAllowsInsertion() {
        let (writer, _, _) = fixture()
        writer.edit(range: NSRange(location: 0, length: 0), replacement: "abc")
        writer.setBackspaceLocked(true)
        XCTAssertFalse(writer.edit(range: NSRange(location: 2, length: 1), replacement: ""))
        XCTAssertTrue(writer.edit(range: NSRange(location: 3, length: 0), replacement: "d"))
        XCTAssertEqual(writer.text, "abcd")
    }
}
