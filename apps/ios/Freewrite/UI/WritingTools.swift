import SwiftUI

struct WritingTools: View {
    var model: WriterModel

    var body: some View {
        Menu {
            Section("text") {
                Button("heading") { insert("# ", block: true) }
                Button("subheading") { insert("## ", block: true) }
                Button("bold") { insert("**", suffix: "**") }
                Button("italic") { insert("_", suffix: "_") }
                Button("strikethrough") { insert("~~", suffix: "~~") }
                Button("link") { insert("[", suffix: "](https://)") }
            }
            Section("blocks") {
                Button("bullet list") { insert("- ", block: true) }
                Button("numbered list") { insert("1. ", block: true) }
                Button("checklist") { insert("- [ ] ", block: true) }
                Button("quote") { insert("> ", block: true) }
                Button("code block") { insert("```\n", suffix: "\n```", block: true) }
                Button("divider") { insert("\n---\n", block: true) }
            }
        } label: {
            Image(systemName: "text.badge.plus").font(.system(size: 17, weight: .regular))
                .frame(width: 44, height: 44)
        }
        .accessibilityLabel("writing tools")
        .disabled(model.current == nil || model.active || (model.backspaceLocked && model.selection.length > 0))
    }

    private func insert(_ prefix: String, suffix: String = "", block: Bool = false) {
        guard let range = Range(model.selection, in: model.text) else { return }
        let selected = String(model.text[range])
        let needsNewline = block && range.lowerBound > model.text.startIndex && model.text[model.text.index(before: range.lowerBound)] != "\n"
        let leading = (needsNewline ? "\n" : "") + prefix
        let caret = model.selection.location + leading.utf16.count
        guard model.edit(range: model.selection, replacement: leading + selected + suffix) else { return }
        model.selection = NSRange(location: caret, length: selected.utf16.count)
    }
}
