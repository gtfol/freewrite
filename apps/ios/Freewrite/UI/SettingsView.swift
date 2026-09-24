import SwiftUI

struct SettingsView: View {
    var model: WriterModel
    @State private var key = ""
    @State private var enabled = false
    @State private var confirm = false
    @State private var message: String?
    private let credentials = KeychainCredentials()

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "settings")
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Toggle("lock backspace", isOn: Binding(get: { model.backspaceLocked }, set: { model.setBackspaceLocked($0) }))
                    Text("keep moving forward. cleanup can always be undone.")
                        .font(FreewriteStyle.caption).foregroundStyle(FreewriteStyle.secondary)
                    Rectangle().fill(FreewriteStyle.divider).frame(height: 0.5)
                    Text("dictation").font(FreewriteStyle.heading)
                    Text("speech is transcribed on this iPhone. audio stays in memory and is never saved or uploaded. words save as you speak.")
                    Text("cleanup removes clear English fillers and tidies punctuation. your words stay yours. other languages keep their transcript.")
                        .foregroundStyle(FreewriteStyle.secondary)
                    Rectangle().fill(FreewriteStyle.divider).frame(height: 0.5)
                    Text("optional OpenAI cleanup").font(FreewriteStyle.heading)
                    if enabled {
                        Text("enabled · dictated text goes to OpenAI after you stop")
                        Button("turn off and remove key") {
                            do { try credentials.remove(); enabled = false; message = nil }
                            catch { message = WritingError.keychain.localizedDescription }
                        }.frame(minHeight: 44)
                    } else {
                        SecureField("your OpenAI API key", text: $key)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .padding(.vertical, 12).accessibilityIdentifier("openai-key")
                        Rectangle().fill(FreewriteStyle.divider).frame(height: 0.5)
                        Button("enable text cleanup") { confirm = true }
                            .disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).frame(minHeight: 44)
                    }
                    Text("uses gpt-4.1-mini with your own API account. only the dictated passage is sent, never audio or other entries. the key stays in this iPhone’s Keychain. requests disable response storage; OpenAI’s provider retention policies still apply.")
                        .font(FreewriteStyle.caption).foregroundStyle(FreewriteStyle.secondary)
                    if let message { Text(message).font(FreewriteStyle.caption) }
                }.padding(20)
            }
        }.freewriteScreen()
        .onAppear {
            do { enabled = try credentials.read()?.consent == true }
            catch { message = WritingError.keychain.localizedDescription }
        }
        .alert("send dictated text to OpenAI?", isPresented: $confirm) {
            Button("cancel", role: .cancel) {}
            Button("allow text cleanup") {
                do { try credentials.save(key: key, consent: true); key = ""; enabled = true; message = nil }
                catch { message = WritingError.keychain.localizedDescription }
            }
        } message: {
            Text("after you stop dictating, the passage will be sent to OpenAI for cleanup. audio never leaves this iPhone. usage is billed to your OpenAI account. turn this off and remove your key anytime.")
        }
    }
}
