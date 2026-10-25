import SwiftUI
import SwiftData

@main struct FreewriteApp: App {
    @State private var model: WriterModel?
    @State private var sync: EntrySyncModel?
    @State private var loadError = false
    @State private var account = AccountModel(credentials: AccountCredentialStore(),
                                             client: FreewriteAccountClient(transport: AccountURLSessionTransport()),
                                             browser: BrowserSignIn(), track: Analytics.track)
    init() { Analytics.setup() }
    var body: some Scene {
        WindowGroup {
            Group {
                if let model, let sync { WriteView(model: model).environment(account).environment(sync) }
                else {
                    VStack(spacing: 20) {
                        Text(loadError ? "your entries couldn’t be opened." : "opening freewrite…")
                        if loadError { Button("try again") { load() } }
                    }.frame(maxWidth: .infinity, maxHeight: .infinity).freewriteScreen()
                }
            }.task { if model == nil { load() } }
        }
    }
    @MainActor private func load() {
        RetiredCleanupKey.remove()
        do {
            let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                       appropriateFor: nil, create: true)
            let configuration = ModelConfiguration(url: support.appendingPathComponent("default.store"), cloudKitDatabase: .none)
            let container = try ModelContainer(for: StoredEntry.self, StoredSyncCursor.self, configurations: configuration)
            let store = SwiftDataEntryStore(container: container)
            // Select ownership before loading so cached account entries stay available offline.
            try store.switchAccount(to: account.login?.user.id)
            let writer = WriterModel(store: store, transcriber: AppleTranscriber(), track: Analytics.track)
            model = writer
            sync = EntrySyncModel(store: store, writer: writer, account: account,
                                  client: EntrySyncClient(transport: AccountURLSessionTransport(maxResponseBytes: 32_000_000)))
            loadError = false
        } catch { loadError = true }
    }
}
