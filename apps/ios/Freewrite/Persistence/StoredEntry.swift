import Foundation
import SwiftData

@Model final class StoredEntry {
    @Attribute(.unique) var id: String
    var content: String
    var createdAt: Double
    var updatedAt: Double
    var deletedAt: Double?
    // Optional/defaulted additions allow existing local-only stores to migrate in place.
    var ownerID: String?
    var syncRevision: Int = 0
    var syncedEntry: Data?

    init(_ entry: Entry, ownerID: String? = nil) {
        id = entry.id; content = entry.content; createdAt = entry.createdAt
        updatedAt = entry.updatedAt; deletedAt = entry.deletedAt; self.ownerID = ownerID
    }
    var value: Entry {
        var entry = Entry(id: id, content: content, now: createdAt)
        entry.updatedAt = updatedAt; entry.deletedAt = deletedAt
        return entry
    }
    func set(_ entry: Entry) {
        content = entry.content; createdAt = entry.createdAt; updatedAt = entry.updatedAt; deletedAt = entry.deletedAt
    }
    func state() throws -> SyncEntryState {
        SyncEntryState(entry: value, base: try syncedEntry.map { try JSONDecoder().decode(Entry.self, from: $0) }, rev: syncRevision)
    }
}

@Model final class StoredSyncCursor {
    @Attribute(.unique) var userID: String
    var cursor: Int = 0
    init(userID: String) { self.userID = userID }
}

@MainActor final class SwiftDataEntryStore: SyncEntryStore {
    let context: ModelContext
    private(set) var userID: String?
    init(container: ModelContainer) {
        context = ModelContext(container); context.autosaveEnabled = false
    }
    private func records() throws -> [StoredEntry] {
        let owner = userID
        return try context.fetch(FetchDescriptor<StoredEntry>(predicate: #Predicate { $0.ownerID == owner },
                                                              sortBy: [SortDescriptor(\.createdAt, order: .reverse)]))
    }
    func entries() throws -> [Entry] { try records().filter { $0.deletedAt == nil }.map(\.value) }
    func switchAccount(to userID: String?) throws {
        do {
            // Only never-owned entries are adopted. Signing out never reassigns account writing.
            if let userID {
                let guests = try context.fetch(FetchDescriptor<StoredEntry>(predicate: #Predicate { $0.ownerID == nil }))
                for entry in guests { entry.ownerID = userID }
                try context.save()
            }
            self.userID = userID
        } catch { context.rollback(); throw error }
    }
    func save(_ entry: Entry) throws {
        let id = entry.id
        let request = FetchDescriptor<StoredEntry>(predicate: #Predicate { $0.id == id })
        do {
            if let stored = try context.fetch(request).first {
                guard stored.ownerID == userID else { throw EntrySyncError.storage }
                // A delayed save must not resurrect a deletion.
                guard stored.deletedAt == nil || entry.deletedAt != nil else { return }
                stored.set(entry)
            } else { context.insert(StoredEntry(entry, ownerID: userID)) }
            try context.save()
        } catch { context.rollback(); throw error }
    }
    private func checkpoint() throws -> StoredSyncCursor {
        guard let owner = userID else { throw EntrySyncError.storage }
        if let existing = try context.fetch(FetchDescriptor<StoredSyncCursor>(predicate: #Predicate { $0.userID == owner })).first {
            return existing
        }
        let created = StoredSyncCursor(userID: owner); context.insert(created)
        return created
    }
    func pendingRequest() throws -> EntrySyncRequest {
        let cursor = try checkpoint().cursor
        var changes: [EntrySyncChange] = []
        for record in try records() {
            let state = try record.state()
            guard state.dirty else { continue }
            guard state.entry.content.utf16.count <= 500_000 else { throw EntrySyncError.tooLarge }
            let change = EntrySyncChange(record: state.entry, baseRev: state.rev)
            let candidate = EntrySyncRequest(since: cursor, changes: changes + [change])
            if try JSONEncoder().encode(candidate).count > 3_500_000 { break }
            changes.append(change)
            if changes.count == 20 { break }
        }
        return EntrySyncRequest(since: cursor, changes: changes)
    }
    func apply(_ response: EntrySyncResponse, sent: EntrySyncRequest) throws -> [String: String] {
        do {
            let existing = try records()
            var merge = EntrySyncMerge(states: try Dictionary(uniqueKeysWithValues: existing.map { ($0.id, try $0.state()) }))
            try merge.receive(response, sent: sent)
            let byID = Dictionary(uniqueKeysWithValues: existing.map { ($0.id, $0) })
            for (id, state) in merge.states {
                let stored: StoredEntry
                if let record = byID[id] { stored = record }
                else {
                    // Never overwrite a row belonging to another account, even on an ID collision.
                    let matches = try context.fetch(FetchDescriptor<StoredEntry>(predicate: #Predicate { $0.id == id }))
                    guard matches.isEmpty else { throw EntrySyncError.storage }
                    stored = StoredEntry(state.entry, ownerID: userID); context.insert(stored)
                }
                stored.set(state.entry); stored.syncRevision = state.rev
                stored.syncedEntry = try state.base.map { try JSONEncoder().encode($0) }
            }
            try checkpoint().cursor = response.cursor
            try context.save() // Cursor, acknowledgements and conflict copies commit together.
            return merge.preserved
        } catch { context.rollback(); throw error }
    }
}
