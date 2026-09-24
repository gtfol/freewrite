import SwiftUI

struct SettingsView: View {
    var model: WriterModel

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: "settings")
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
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
    }
}
