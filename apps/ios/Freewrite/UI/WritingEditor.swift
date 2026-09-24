import SwiftUI
import UIKit

struct WritingEditor: UIViewRepresentable {
    var model: WriterModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.colorScheme) private var colorScheme

    func makeCoordinator() -> Coordinator { Coordinator(model) }
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.autocorrectionType = .no; view.spellCheckingType = .no; view.autocapitalizationType = .none
        view.smartQuotesType = .no; view.smartDashesType = .no; view.smartInsertDeleteType = .no
        view.keyboardDismissMode = .interactive
        view.textContainerInset = UIEdgeInsets(top: 16, left: 20, bottom: 24, right: 20)
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
        view.accessibilityLabel = "writing"
        view.accessibilityIdentifier = "writing-editor"
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        let coordinator = context.coordinator
        coordinator.updating = true
        defer { coordinator.updating = false }
        if coordinator.entryID != model.current?.id {
            coordinator.entryID = model.current?.id
            view.undoManager?.removeAllActions()
            coordinator.registeredCleanupID = nil
        }
        if view.text != model.text {
            view.text = model.text
        }
        let font = UIFontMetrics(forTextStyle: .body).scaledFont(for: UIFont(name: "Lato-Regular", size: 20) ?? .systemFont(ofSize: 20))
        let paragraph = NSMutableParagraphStyle(); paragraph.lineSpacing = 8
        view.font = font
        view.textColor = colorScheme == .dark ? UIColor(white: 238/255, alpha: 1) : UIColor(white: 17/255, alpha: 1)
        view.tintColor = view.textColor
        view.typingAttributes = [.font: font, .paragraphStyle: paragraph, .foregroundColor: view.textColor!]
        view.textStorage.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: view.textStorage.length))
        if view.markedTextRange == nil, NSMaxRange(model.selection) <= view.text.utf16.count,
           view.selectedRange != model.selection { view.selectedRange = model.selection }
        if model.active { view.scrollRangeToVisible(view.selectedRange) }
        if let undo = model.cleanupUndo, coordinator.registeredCleanupID != undo.id {
            coordinator.registeredCleanupID = undo.id
            view.undoManager?.beginUndoGrouping()
            view.undoManager?.registerUndo(withTarget: coordinator) { target in target.model.undoCleanup() }
            view.undoManager?.setActionName("cleanup")
            view.undoManager?.endUndoGrouping()
        }
    }

    @MainActor final class Coordinator: NSObject, UITextViewDelegate {
        let model: WriterModel
        var updating = false
        var entryID: String?
        var registeredCleanupID: UUID?
        init(_ model: WriterModel) { self.model = model }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            guard !updating else { return true }
            // Let UIKit finish the edit before publishing it to SwiftUI. Publishing
            // here can redraw the old selection while UIKit is still inserting.
            return !(model.backspaceLocked && range.length > 0)
        }
        func textViewDidChangeSelection(_ textView: UITextView) {
            guard !updating else { return }
            model.selection = textView.selectedRange
        }
        func textViewDidChange(_ textView: UITextView) {
            guard !updating, textView.text != model.text else { return }
            // Handles typing, marked-text commits, and system undo after UIKit commits.
            // Treat the smallest changed span as a manual edit, preserving other anchors.
            let old = Array(model.text), new = Array(textView.text)
            var prefix = 0
            while prefix < min(old.count, new.count), old[prefix] == new[prefix] { prefix += 1 }
            var suffix = 0
            while suffix < min(old.count, new.count) - prefix,
                  old[old.count - 1 - suffix] == new[new.count - 1 - suffix] { suffix += 1 }
            let range = NSRange(location: String(old.prefix(prefix)).utf16.count,
                                length: String(old[prefix..<(old.count - suffix)]).utf16.count)
            let replacement = String(new[prefix..<(new.count - suffix)])
            if !model.edit(range: range, replacement: replacement) { textView.text = model.text }
            model.selection = textView.selectedRange
        }
    }
}
