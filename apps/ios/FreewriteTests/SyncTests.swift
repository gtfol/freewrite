import XCTest
#if canImport(FreewriteCore)
@testable import FreewriteCore
#else
@testable import Freewrite
#endif

final class SyncTests: XCTestCase {
    func testDownloadKeepsOriginalDateAndDeletion() throws {
        let old = Entry(id: "old", content: "archive", now: 1234)
        var deleted = Entry(id: "deleted", now: 5678); deleted.deletedAt = 6000
        var merge = EntrySyncMerge(states: [:])
        try merge.receive(EntrySyncResponse(results: [], rows: [.init(record: old, rev: 2), .init(record: deleted, rev: 3)], cursor: 3, hasMore: true), sent: .init(since: 0, changes: []))
        XCTAssertEqual(merge.states["old"]?.entry, old)
        XCTAssertEqual(merge.states["deleted"]?.entry.deletedAt, 6000)
        XCTAssertFalse(merge.states["old"]!.dirty)
    }
    func testAcknowledgmentDoesNotLoseTypingDuringRequest() throws {
        let sent = Entry(id: "a", content: "first", now: 100)
        var newer = sent; newer.content = "first and more"; newer.updatedAt = 200
        var merge = EntrySyncMerge(states: ["a": .init(entry: newer)])
        try merge.receive(.init(results: [.init(id: "a", status: "ok", rev: 10, server: nil)], rows: [.init(record: sent, rev: 10)], cursor: 10, hasMore: false), sent: .init(since: 0, changes: [.init(record: sent, baseRev: 0)]))
        XCTAssertEqual(merge.states["a"]?.entry, newer)
        XCTAssertEqual(merge.states["a"]?.base, sent)
        XCTAssertTrue(merge.states["a"]!.dirty)
    }
    func testConflictPreservesLocalCopyBeforeRemoteReplacement() throws {
        let base = Entry(id: "a", content: "base", now: 100)
        var local = base; local.content = "phone edit"
        var remote = base; remote.content = "web edit"
        var merge = EntrySyncMerge(states: ["a": .init(entry: local, base: base, rev: 1)])
        let row = EntrySyncRow(record: remote, rev: 9)
        try merge.receive(.init(results: [.init(id: "a", status: "conflict", rev: nil, server: row)], rows: [row], cursor: 9, hasMore: false), sent: .init(since: 1, changes: [.init(record: local, baseRev: 1)]))
        XCTAssertEqual(merge.states.count, 2)
        XCTAssertEqual(merge.states["a"]?.entry.content, "web edit")
        let copy = try XCTUnwrap(merge.preserved["a"])
        XCTAssertEqual(merge.states[copy]?.entry.content, "phone edit")
        XCTAssertTrue(merge.states[copy]!.dirty)
    }
    func testRemoteDeletionKeepsUnsyncedWordsAsSeparateEntry() throws {
        let base = Entry(id: "a", content: "base", now: 100)
        var local = base; local.content = "unsynced words"
        var remote = base; remote.content = ""; remote.deletedAt = 200
        var merge = EntrySyncMerge(states: ["a": .init(entry: local, base: base, rev: 1)])
        merge.apply(.init(record: remote, rev: 2))
        XCTAssertEqual(merge.states["a"]?.entry.deletedAt, 200)
        XCTAssertEqual(merge.states[try XCTUnwrap(merge.preserved["a"])]?.entry.content, "unsynced words")
    }
    func testUnchangedBaseDoesNotCreateConflictAndOlderPagesCannotOverwrite() {
        let base = Entry(id: "a", content: "base", now: 100)
        var local = base; local.content = "new"
        var merge = EntrySyncMerge(states: ["a": .init(entry: local, base: base, rev: 10)])
        merge.apply(.init(record: base, rev: 9))
        merge.apply(.init(record: base, rev: 11))
        XCTAssertEqual(merge.states["a"]?.entry, local)
        XCTAssertEqual(merge.states["a"]?.rev, 11)
        XCTAssertTrue(merge.preserved.isEmpty)
    }
    func testMissingAcknowledgmentRejectsResponse() {
        let entry = Entry(content: "must stay pending")
        var merge = EntrySyncMerge(states: [entry.id: .init(entry: entry)])
        XCTAssertThrowsError(try merge.receive(.init(results: [], rows: [], cursor: 0, hasMore: false), sent: .init(since: 0, changes: [.init(record: entry, baseRev: 0)])))
        XCTAssertTrue(merge.states[entry.id]!.dirty)
    }
}
