import SwiftUI

struct SettingsView: View {
    var model: WriterModel
    @Environment(AccountModel.self) private var account
    @State private var deletingUserID: String?
    @State private var deleteConfirmation = ""
    @State private var showDelete = false
    @AppStorage(Analytics.preferenceKey) private var analyticsEnabled = true

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "settings")
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    accountSection
                    Rectangle().fill(FreewriteStyle.divider).frame(height: 0.5)
                    HStack(spacing: 0) {
                        Text("lock backspace")
                        InfoButton(title: "lock backspace", paragraphs: [
                            "keep moving forward: typing can add words, but cannot delete or replace them.",
                            "dictation cleanup can still be undone."
                        ])
                        Spacer(minLength: 8)
                        Toggle("lock backspace", isOn: Binding(get: { model.backspaceLocked }, set: { model.setBackspaceLocked($0) }))
                            .labelsHidden()
                    }
                    Rectangle().fill(FreewriteStyle.divider).frame(height: 0.5)
                    HStack(spacing: 0) {
                        Text("dictation")
                        InfoButton(title: "dictation", paragraphs: [
                            "speech is transcribed on this iPhone. audio stays in memory and is never saved or uploaded. words save as you speak.",
                            "after you stop, on-device cleanup removes clear English fillers and tidies punctuation. other languages keep their transcript. tap undo cleanup to restore your original words."
                        ])
                        Spacer(minLength: 8)
                        Text("on-device").font(FreewriteStyle.caption).foregroundStyle(FreewriteStyle.secondary)
                    }
                    Rectangle().fill(FreewriteStyle.divider).frame(height: 0.5)
                    HStack(spacing: 0) {
                        Text("usage analytics")
                        InfoButton(title: "usage analytics", paragraphs: [
                            "basic usage events help us improve freewrite. PostHog receives a random installation identifier and app version, never your writing, dictation, name, or email.",
                            "no screen recordings or advertising tracking. turn this off to stop sending analytics from this iPhone."
                        ])
                        Spacer(minLength: 8)
                        Toggle("usage analytics", isOn: $analyticsEnabled).labelsHidden()
                            .onChange(of: analyticsEnabled) { _, enabled in Analytics.setEnabled(enabled) }
                    }
                    Rectangle().fill(FreewriteStyle.divider).frame(height: 0.5)
                    VStack(alignment: .leading, spacing: 0) {
                        SupportLink()
                        Link("terms of service", destination: URL(string: "https://freewrite.gtfol.dev/ios/terms")!).frame(minHeight: 44)
                        Link("privacy policy", destination: URL(string: "https://freewrite.gtfol.dev/ios/privacy")!)
                            .frame(minHeight: 44)
                        Link("contact us", destination: URL(string: "https://gtfol.dev/contact")!).frame(minHeight: 44)
                    }.foregroundStyle(FreewriteStyle.secondary)
                }.padding(20)
            }
        }.freewriteScreen()
            .task { await account.refresh() }
            .alert("delete your freewrite account?", isPresented: $showDelete) {
                TextField("type DELETE", text: $deleteConfirmation)
                    .textInputAutocapitalization(.characters).autocorrectionDisabled()
                Button("cancel", role: .cancel) { deletingUserID = nil; deleteConfirmation = "" }
                Button("delete account", role: .destructive) {
                    if let id = deletingUserID { Task { await account.deleteAccount(expectedUserID: id) } }
                    deletingUserID = nil; deleteConfirmation = ""
                }.disabled(deleteConfirmation != "DELETE" || account.busy)
            } message: {
                Text("this permanently deletes your web account and its synced writing, articles, and drawings. entries saved only on this iPhone remain. this cannot be undone.")
            }
    }

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                Text("account")
                InfoButton(title: "account", paragraphs: [
                    "use the same account as freewrite on the web. your sign-in is stored securely on this iPhone.",
                    "this test build supports signing in and out. entries still stay on this iPhone; cloud sync is coming next."
                ])
                Spacer()
                if account.busy { ProgressView().controlSize(.small) }
            }
            if let login = account.login {
                Text(login.user.name.isEmpty ? login.user.email : login.user.name).padding(.top, 4)
                Text(login.user.email).font(FreewriteStyle.caption).foregroundStyle(FreewriteStyle.secondary).textSelection(.enabled)
                Link("open freewrite", destination: URL(string: "https://freewrite.gtfol.dev")!).frame(minHeight: 44)
                Button("sign out") { Task { await account.signOut() } }.frame(minHeight: 44).disabled(account.busy)
                Button("delete account", role: .destructive) {
                    deletingUserID = login.user.id; deleteConfirmation = ""; showDelete = true
                }.frame(minHeight: 44).disabled(account.busy)
            } else {
                Button(account.busy ? "signing in…" : "sign in to freewrite") {
                    model.background()
                    guard model.flush() else { return }
                    Task { await account.signIn() }
                }.frame(minHeight: 44).disabled(account.busy)
                Link("open freewrite", destination: URL(string: "https://freewrite.gtfol.dev")!).frame(minHeight: 44)
            }
            if let error = account.error {
                Text(error).font(FreewriteStyle.caption).fixedSize(horizontal: false, vertical: true).padding(.top, 8)
            }
        }
    }
}
