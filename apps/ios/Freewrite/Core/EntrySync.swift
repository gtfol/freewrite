import Foundation
import Observation

struct SyncEntryState: Codable, Equatable {
    var entry: Entry
    var base: Entry?
    var rev: Int = 0
    var dirty: Bool { base.map { !entry.sameWriting(as: $0) } ?? true }
}
extension Entry {
    func sameWriting(as other: Entry) -> Bool { content == other.content && (deletedAt == nil) == (other.deletedAt == nil) }
}
struct EntrySyncChange: Codable { let record: Entry; let baseRev: Int }
struct EntrySyncRequest: Codable { let since: Int; let changes: [EntrySyncChange] }
struct EntrySyncRow: Codable { let record: Entry; let rev: Int }
struct EntrySyncOutcome: Codable { let id: String; let status: String; let rev: Int?; let server: EntrySyncRow? }
struct EntrySyncResponse: Codable {
    let results: [EntrySyncOutcome]
    let rows: [EntrySyncRow]
    let cursor: Int
    let hasMore: Bool
}
struct EntrySyncMerge {
    var states: [String: SyncEntryState]
    var preserved: [String: String] = [:]

    mutating func apply(_ row: EntrySyncRow) {
        if let local = states[row.record.id] {
            guard row.rev > local.rev else { return }
            if local.dirty && !local.entry.sameWriting(as: row.record) {
                // The server hasn't changed the writing we edited, so keep our pending edit.
                if let base = local.base, base.sameWriting(as: row.record) {
                    states[row.record.id]?.base = row.record
                    states[row.record.id]?.rev = row.rev
                    return
                }
                // Keep an independently editable copy before accepting a conflicting remote edit/deletion.
                if local.entry.deletedAt == nil && !local.entry.content.isEmpty {
                    var copy = local.entry; copy.id = UUID().uuidString.lowercased()
                    states[copy.id] = SyncEntryState(entry: copy)
                    preserved[local.entry.id] = copy.id
                }
            }
        }
        states[row.record.id] = SyncEntryState(entry: row.record, base: row.record, rev: row.rev)
    }
    mutating func receive(_ response: EntrySyncResponse, sent: EntrySyncRequest) throws {
        guard response.cursor >= sent.since, response.rows.allSatisfy({ $0.rev > 0 && $0.rev <= response.cursor }),
              response.results.count == sent.changes.count,
              Set(response.results.map(\.id)) == Set(sent.changes.map { $0.record.id }) else { throw EntrySyncError.invalidResponse }
        for result in response.results {
            guard let change = sent.changes.first(where: { $0.record.id == result.id }) else { throw EntrySyncError.invalidResponse }
            if result.status == "ok", let rev = result.rev, rev > 0 {
                if let local = states[result.id], rev >= local.rev {
                    // Acknowledging the sent snapshot never marks edits made during the request as synced.
                    states[result.id]?.base = change.record
                    states[result.id]?.rev = rev
                }
            } else if result.status == "conflict", let server = result.server, server.record.id == result.id, server.rev > 0 {
                apply(server)
            } else { throw EntrySyncError.invalidResponse }
        }
        for row in response.rows { apply(row) }
    }
}

enum EntrySyncError: Error, LocalizedError {
    case unavailable, expired, invalidResponse, tooLarge, storage
    var errorDescription: String? {
        switch self {
        case .expired: "sign in again to sync. your writing is saved on this iPhone."
        case .tooLarge: "one entry is too long to sync. your writing is saved on this iPhone."
        case .storage: "couldn’t save synced entries. retry when storage is available."
        case .unavailable, .invalidResponse: "couldn’t sync. your writing is saved on this iPhone; we’ll retry."
        }
    }
}
struct EntrySyncClient: Sendable {
    let transport: any AccountTransport
    func send(_ payload: EntrySyncRequest, token: String) async throws -> EntrySyncResponse {
        var request = URLRequest(url: URL(string: "https://freewrite.gtfol.dev/api/ios/sync")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(payload)
        let result: AccountHTTPResult
        do { result = try await transport.send(request) } catch { throw EntrySyncError.unavailable }
        guard result.status != 401 else { throw EntrySyncError.expired }
        guard result.status == 200 else { throw EntrySyncError.unavailable }
        guard let response = try? JSONDecoder().decode(EntrySyncResponse.self, from: result.data) else { throw EntrySyncError.invalidResponse }
        return response
    }
}

@MainActor protocol SyncEntryStore: EntryStore {
    var userID: String? { get }
    func switchAccount(to userID: String?) throws
    func pendingRequest() throws -> EntrySyncRequest
    func apply(_ response: EntrySyncResponse, sent: EntrySyncRequest) throws -> [String: String]
}

@MainActor @Observable final class EntrySyncModel {
    private(set) var syncing = false
    private(set) var error: String?
    private(set) var needsSignIn = false
    private(set) var lastSynced: Date?
    private(set) var preservedConflict = false
    private let store: any SyncEntryStore
    private let writer: WriterModel
    private let account: AccountModel
    private let client: EntrySyncClient
    private var scheduled: Task<Void, Never>?

    init(store: any SyncEntryStore, writer: WriterModel, account: AccountModel, client: EntrySyncClient) {
        self.store = store; self.writer = writer; self.account = account; self.client = client
        writer.didSave = { [weak self] in self?.schedule() }
    }
    @discardableResult func accountChanged() -> Bool {
        guard store.userID != account.login?.user.id else { return true }
        writer.background()
        guard writer.flush() else { error = WritingError.storage.localizedDescription; return false }
        do {
            try store.switchAccount(to: account.login?.user.id)
            writer.reloadAfterSync(accountChanged: true)
            error = nil; needsSignIn = false; lastSynced = nil; preservedConflict = false
            return true
        } catch { self.error = EntrySyncError.storage.localizedDescription; return false }
    }
    func schedule() {
        guard !syncing else { return }
        scheduled?.cancel()
        scheduled = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
            await self?.syncNow()
        }
    }
    func syncNow() async {
        guard !syncing, accountChanged(), let login = account.login, !writer.active else { return }
        syncing = true; defer { syncing = false }
        do {
            // Bound each pass; foreground polling continues if a very large history needs more pages.
            for _ in 0..<100 {
                try Task.checkCancellation()
                guard account.login == login, store.userID == login.user.id, !writer.active else { return }
                guard writer.flush() else { throw EntrySyncError.storage }
                let request = try store.pendingRequest()
                let response = try await client.send(request, token: login.token)
                try Task.checkCancellation()
                guard account.login == login, store.userID == login.user.id, !writer.active else { return }
                guard writer.flush() else { throw EntrySyncError.storage }
                let copies = try store.apply(response, sent: request)
                preservedConflict = preservedConflict || !copies.isEmpty
                writer.reloadAfterSync(preserved: copies)
                let pending = try store.pendingRequest()
                if !response.hasMore && pending.changes.isEmpty {
                    lastSynced = Date(); error = nil; needsSignIn = false; return
                }
            }
        } catch is CancellationError { }
        catch {
            let failure = error as? EntrySyncError ?? .storage
            needsSignIn = failure == .expired
            self.error = failure.localizedDescription
        }
    }
}
