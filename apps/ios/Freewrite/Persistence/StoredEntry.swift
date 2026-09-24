import Foundation
import SwiftData

@Model final class StoredEntry {
    @Attribute(.unique) var id: String
    var content: String
    var createdAt: Double
    var updatedAt: Double
    var deletedAt: Double?

    init(_ entry: Entry) {
        id = entry.id; content = entry.content; createdAt = entry.createdAt
        updatedAt = entry.updatedAt; deletedAt = entry.deletedAt
    }
    var value: Entry {
        var entry = Entry(id: id, content: content, now: createdAt)
        entry.updatedAt = updatedAt; entry.deletedAt = deletedAt
        return entry
    }
}

@MainActor final class SwiftDataEntryStore: EntryStore {
    let context: ModelContext
    init(container: ModelContainer) {
        context = ModelContext(container); context.autosaveEnabled = false
    }
    func entries() throws -> [Entry] {
        let request = FetchDescriptor<StoredEntry>(predicate: #Predicate { $0.deletedAt == nil },
                                                   sortBy: [SortDescriptor(\.createdAt, order: .reverse)])
        return try context.fetch(request).map(\.value)
    }
    func save(_ entry: Entry) throws {
        let id = entry.id
        let request = FetchDescriptor<StoredEntry>(predicate: #Predicate { $0.id == id })
        do {
            if let stored = try context.fetch(request).first {
                // A delayed save must not resurrect a deletion.
                guard stored.deletedAt == nil || entry.deletedAt != nil else { return }
                stored.content = entry.content; stored.updatedAt = entry.updatedAt; stored.deletedAt = entry.deletedAt
            } else { context.insert(StoredEntry(entry)) }
            try context.save()
        } catch { context.rollback(); throw error }
    }
}
