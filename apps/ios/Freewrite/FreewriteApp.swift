import SwiftUI
import SwiftData

@main struct FreewriteApp: App {
    @State private var model: WriterModel?
    @State private var loadError = false
    @State private var account = AccountModel(credentials: AccountCredentialStore(),
                                             client: FreewriteAccountClient(transport: AccountURLSessionTransport()),
                                             browser: BrowserSignIn(), track: Analytics.track)
    init() { Analytics.setup() }
    var body: some Scene {
        WindowGroup {
            Group {
                if let model { WriteView(model: model).environment(account) }
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
            let container = try ModelContainer(for: StoredEntry.self, configurations: configuration)
            model = WriterModel(store: SwiftDataEntryStore(container: container), transcriber: AppleTranscriber(), track: Analytics.track)
            loadError = false
        } catch { loadError = true }
    }
}
