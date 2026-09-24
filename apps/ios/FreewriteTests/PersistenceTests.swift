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
