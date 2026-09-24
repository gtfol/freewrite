import SwiftUI

struct HistoryView: View {
    var model: WriterModel
    @Environment(\.dismiss) private var dismiss
    @State private var deleting: Entry?
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetHeader(title: "history")
            Text("saved on this iPhone").font(FreewriteStyle.caption).foregroundStyle(FreewriteStyle.secondary)
                .padding(.horizontal, 20).padding(.bottom, 20)
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(model.entries) { entry in
                        HStack {
                            Button {
                                model.select(entry)
                                if !model.saveFailed { dismiss() }
                            } label: {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(entry.preview.isEmpty ? "empty entry" : entry.preview).lineLimit(2)
                                    Text(Date(timeIntervalSince1970: entry.createdAt / 1_000), style: .date)
                                        .font(FreewriteStyle.caption).foregroundStyle(FreewriteStyle.secondary)
                                }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 16)
                            }.buttonStyle(.plain)
                            Button { deleting = entry } label: {
                                Image(systemName: "trash").frame(width: 44, height: 44)
                            }.accessibilityLabel("delete entry")
                        }
                        Rectangle().fill(FreewriteStyle.divider).frame(height: 0.5)
                    }
                }.padding(.horizontal, 20)
            }
            if model.saveFailed { Text(WritingError.storage.localizedDescription).font(FreewriteStyle.caption).padding(20) }
        }.freewriteScreen()
        .confirmationDialog("delete this entry?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
            Button("delete entry", role: .destructive) { if let entry = deleting { model.delete(entry) }; deleting = nil }
            Button("cancel", role: .cancel) { deleting = nil }
        }
    }
}
