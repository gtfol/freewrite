import XCTest
import SwiftData
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
    func testKeychainConsentAndRemoval() throws {
        let store = KeychainCredentials(service: "dev.gtfol.freewrite.tests.\(UUID())")
        defer { try? store.remove() }
        XCTAssertNil(try store.read())
        XCTAssertThrowsError(try store.save(key: "synthetic-only", consent: false))
        try store.save(key: "synthetic-only", consent: true)
        XCTAssertEqual(try store.read()?.key, "synthetic-only")
        XCTAssertEqual(try store.read()?.consent, true)
        try store.remove(); XCTAssertNil(try store.read())
    }
}
