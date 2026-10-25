import XCTest
import SwiftData
import Security
@testable import Freewrite

@MainActor final class PersistenceTests: XCTestCase {
    func testDiskReopenRecoversCheckpoint() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let configuration = ModelConfiguration(url: directory.appendingPathComponent("entries.store"), cloudKitDatabase: .none)
        let entry = Entry(content: "words saved during dictation", now: 1234)
        do {
            let container = try ModelContainer(for: StoredEntry.self, configurations: configuration)
            try SwiftDataEntryStore(container: container).save(entry)
        }
        let reopened = try ModelContainer(for: StoredEntry.self, configurations: configuration)
        XCTAssertEqual(try SwiftDataEntryStore(container: reopened).entries(), [entry])
    }
    func testDeletionCannotBeResurrectedByDelayedSave() throws {
        let container = try ModelContainer(for: StoredEntry.self, configurations: ModelConfiguration(isStoredInMemoryOnly: true))
        let store = SwiftDataEntryStore(container: container)
        let original = Entry(content: "words")
        try store.save(original)
        var deleted = original; deleted.content = ""; deleted.deletedAt = Entry.timestamp()
        try store.save(deleted); try store.save(original)
        XCTAssertTrue(try store.entries().isEmpty)
    }
    func testLocalOnlyStoreMigratesWithoutLosingWriting() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let configuration = ModelConfiguration(url: directory.appendingPathComponent("legacy.store"), cloudKitDatabase: .none)
        do {
            let container = try ModelContainer(for: LegacyLocalStore.StoredEntry.self, configurations: configuration)
            let context = ModelContext(container)
            context.insert(LegacyLocalStore.StoredEntry())
            try context.save()
        }
        let upgraded = try ModelContainer(for: StoredEntry.self, StoredSyncCursor.self, configurations: configuration)
        let store = SwiftDataEntryStore(container: upgraded)
        XCTAssertEqual(try store.entries().first?.content, "writing from build 6")
        XCTAssertEqual(try store.entries().first?.createdAt, 1234)
        try store.switchAccount(to: "alice")
        let request = try store.pendingRequest()
        XCTAssertEqual(request.changes.count, 1)
        XCTAssertEqual(request.changes.first?.baseRev, 0)
        XCTAssertEqual(request.changes.first?.record.content, "writing from build 6")
    }
    func testAccountIsolationAndPendingEditsSurviveReopen() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let configuration = ModelConfiguration(url: directory.appendingPathComponent("sync.store"), cloudKitDatabase: .none)
        let guest = Entry(content: "existing local writing", now: 1234)
        do {
            let container = try ModelContainer(for: StoredEntry.self, StoredSyncCursor.self, configurations: configuration)
            let store = SwiftDataEntryStore(container: container)
            try store.save(guest); try store.switchAccount(to: "alice")
            let request = try store.pendingRequest()
            XCTAssertEqual(request.changes.map(\.record), [guest])
            let response = EntrySyncResponse(results: [.init(id: guest.id, status: "ok", rev: 5, server: nil)], rows: [], cursor: 5, hasMore: false)
            _ = try store.apply(response, sent: request)
            var edited = guest; edited.content = "offline edit"; try store.save(edited)
            try store.switchAccount(to: nil); XCTAssertTrue(try store.entries().isEmpty)
            try store.switchAccount(to: "bob"); XCTAssertTrue(try store.entries().isEmpty)
            XCTAssertTrue(try store.pendingRequest().changes.isEmpty)
        }
        let reopened = try ModelContainer(for: StoredEntry.self, StoredSyncCursor.self, configurations: configuration)
        let store = SwiftDataEntryStore(container: reopened); try store.switchAccount(to: "alice")
        XCTAssertEqual(try store.entries().first?.content, "offline edit")
        let pending = try store.pendingRequest()
        XCTAssertEqual(pending.since, 5); XCTAssertEqual(pending.changes.first?.baseRev, 5)
    }
    func testFailedMergeDoesNotAdvanceCursorOrLoseDraft() throws {
        let container = try ModelContainer(for: StoredEntry.self, StoredSyncCursor.self, configurations: ModelConfiguration(isStoredInMemoryOnly: true))
        let store = SwiftDataEntryStore(container: container); try store.switchAccount(to: "alice")
        let draft = Entry(content: "draft"); try store.save(draft)
        let request = try store.pendingRequest()
        XCTAssertThrowsError(try store.apply(.init(results: [], rows: [], cursor: 50, hasMore: false), sent: request))
        XCTAssertEqual(try store.pendingRequest().since, 0)
        XCTAssertEqual(try store.entries(), [draft])
    }
    func testUpgradeRemovesRetiredCleanupCredential() {
        let service = "dev.gtfol.freewrite.tests.\(UUID())"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "openai",
            kSecAttrSynchronizable as String: false
        ]
        defer { SecItemDelete(query as CFDictionary) }
        let values = query.merging([
            kSecValueData as String: Data("synthetic-retired-credential".utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]) { _, new in new }
        XCTAssertEqual(SecItemAdd(values as CFDictionary, nil), errSecSuccess)
        XCTAssertEqual(RetiredCleanupKey.remove(service: service), errSecSuccess)
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, nil), errSecItemNotFound)
    }
}

// Matches the persisted entity shipped before account sync; the nested type
// keeps its SwiftData entity name while allowing both schemas in this test.
private enum LegacyLocalStore {
    @Model final class StoredEntry {
        @Attribute(.unique) var id: String
        var content: String
        var createdAt: Double
        var updatedAt: Double
        var deletedAt: Double?
        init() {
            id = "legacy-entry"; content = "writing from build 6"
            createdAt = 1234; updatedAt = 1234
        }
    }
}
