import SwiftUI

struct WriteView: View {
    @Bindable var model: WriterModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var history = false
    @State private var settings = false

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Text("freewrite").font(FreewriteStyle.heading)
                HStack {
                    Button { Analytics.track(.settingsOpened); settings = true } label: {
                        Image(systemName: "gearshape").font(.system(size: 17, weight: .regular))
                            .frame(width: 44, height: 44)
                    }.accessibilityLabel("settings")
                    Spacer()
                    WritingTools(model: model)
                }
            }.padding(.horizontal, 20)
            if model.current != nil {
                ZStack(alignment: .topLeading) {
                    WritingEditor(model: model)
                    if model.text.isEmpty {
                        Text("begin writing").font(.custom("Lato-Regular", size: 20, relativeTo: .body))
                            .foregroundStyle(FreewriteStyle.secondary).padding(.horizontal, 20).padding(.top, 16)
                            .allowsHitTesting(false).accessibilityHidden(true)
                    }
                }.frame(maxWidth: 650)
            } else { Spacer() }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                status
                Rectangle().fill(FreewriteStyle.divider).frame(height: 0.5)
                HStack(spacing: 8) {
                    Button { if !model.timer.running { Analytics.track(.timerStarted) }; model.timer.toggle() } label: {
                        Text(model.timer.label).monospacedDigit().frame(minWidth: 54, minHeight: 48)
                    }.accessibilityLabel(model.timer.running ? "pause timer" : "start timer")
                        .accessibilityValue(model.timer.label)
                        .contextMenu { Button("reset to 15 minutes") { model.timer.reset() } }
                    Spacer(minLength: 0)
                    Button {
                        if model.active { Task { await model.stopDictation() } }
                        else { model.startDictation() }
                    } label: {
                        Image(systemName: model.active ? "stop.circle" : "mic")
                            .font(.system(size: 21, weight: .regular)).frame(width: 48, height: 48)
                    }.accessibilityLabel(model.active ? "stop dictation" : "dictate")
                        .disabled(model.current == nil || model.phase == .cleaning || model.phase == .stopping)
                    Spacer(minLength: 0)
                    Button { model.newEntry() } label: {
                        Image(systemName: "plus").font(.system(size: 20, weight: .regular)).frame(width: 48, height: 48)
                    }.accessibilityLabel("new entry")
                    Spacer(minLength: 0)
                    Button { Analytics.track(.historyOpened); history = true } label: {
                        Image(systemName: "clock").font(.system(size: 20, weight: .regular)).frame(width: 48, height: 48)
                    }.accessibilityLabel("history")
                }.font(FreewriteStyle.caption).padding(.horizontal, 20)
            }.background(FreewriteStyle.canvas)
        }
        .freewriteScreen()
        .sheet(isPresented: $history) { HistoryView(model: model).presentationBackground(FreewriteStyle.canvas) }
        .sheet(isPresented: $settings) { SettingsView(model: model).presentationBackground(FreewriteStyle.canvas) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { model.background() }
            if phase == .active { model.timer.tick() }
        }
        .task {
            while !Task.isCancelled {
                model.timer.tick()
                do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            }
        }
    }

    @ViewBuilder private var status: some View {
        if model.saveFailed {
            VStack(alignment: .leading, spacing: 8) {
                Text(WritingError.storage.localizedDescription)
                Button("retry save") {
                    if model.current == nil { model.load() } else { _ = model.flush() }
                }.frame(minHeight: 44)
            }.padding(20).font(FreewriteStyle.caption)
        }
        if let notice = model.notice {
            VStack(alignment: .leading, spacing: 4) {
                Text(notice.localizedDescription).fixedSize(horizontal: false, vertical: true)
                if notice == .microphoneDenied {
                    Button("open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }.frame(minHeight: 44)
                }
            }.padding(.horizontal, 20).padding(.vertical, 12).font(FreewriteStyle.caption)
        }
        if model.active {
            HStack(spacing: 10) {
                if model.phase == .downloading { ProgressView(value: model.downloadProgress).frame(width: 60) }
                Text(statusText).accessibilityAddTraits(.updatesFrequently)
            }.font(FreewriteStyle.caption).foregroundStyle(FreewriteStyle.secondary)
                .padding(.horizontal, 20).padding(.vertical, 12)
        } else if model.cleanupUndo != nil {
            Button("undo cleanup") { model.undoCleanup() }
                .font(FreewriteStyle.caption).frame(minHeight: 44).padding(.horizontal, 20)
                .keyboardShortcut("z", modifiers: .command)
        }
    }
    private var statusText: String {
        switch model.phase {
        case .idle: ""
        case .preparing: "preparing dictation…"
        case .downloading: "downloading speech model · \(Int(model.downloadProgress * 100))%"
        case .listening: "listening · tap to stop"
        case .stopping: "finishing dictation…"
        case .cleaning: "cleaning up…"
        }
    }
}
