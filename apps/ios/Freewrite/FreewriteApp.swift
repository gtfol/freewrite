import SwiftUI
import SwiftData

@main struct FreewriteApp: App {
    @State private var model: WriterModel?
    @State private var loadError = false
    var body: some Scene {
        WindowGroup {
            Group {
                if let model { WriteView(model: model) }
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
        do {
            let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                       appropriateFor: nil, create: true)
            let configuration = ModelConfiguration(url: support.appendingPathComponent("default.store"), cloudKitDatabase: .none)
            let container = try ModelContainer(for: StoredEntry.self, configurations: configuration)
            model = WriterModel(store: SwiftDataEntryStore(container: container), transcriber: AppleTranscriber(), cleaner: ConfiguredTextCleaner())
            loadError = false
        } catch { loadError = true }
    }
}
