#if os(iOS)
import XCTest
import SwiftUI
import UIKit
@testable import Freewrite

@MainActor final class EditorTests: XCTestCase {
    func testTypingPublishesOnlyAfterUIKitCommits() {
        let model = WriterModel(store: MemoryEntries(), transcriber: TestTranscriber(),
                                defaults: UserDefaults(suiteName: "freewrite-typing-\(UUID())")!)
        let coordinator = WritingEditor.Coordinator(model)
        let editor = UITextView()
        for letter in "quick typing 👋" {
            let range = NSRange(location: editor.text.utf16.count, length: 0)
            let before = model.text
            XCTAssertTrue(coordinator.textView(editor, shouldChangeTextIn: range, replacementText: String(letter)))
            XCTAssertEqual(model.text, before)
            editor.text += String(letter)
            editor.selectedRange = NSRange(location: editor.text.utf16.count, length: 0)
            coordinator.textViewDidChange(editor)
            XCTAssertEqual(model.text, editor.text)
            XCTAssertEqual(model.selection, editor.selectedRange)
        }
        model.setBackspaceLocked(true)
        XCTAssertFalse(coordinator.textView(editor, shouldChangeTextIn: NSRange(location: 0, length: 1), replacementText: ""))
    }
    func testNativeUndoRestoresRawTranscript() async throws {
        let transcriber = TestTranscriber()
        let model = WriterModel(store: MemoryEntries(), transcriber: transcriber,
                                defaults: UserDefaults(suiteName: "freewrite-editor-\(UUID())")!)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: WritingEditor(model: model))
        window.rootViewController = host; window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.view.layoutIfNeeded()
        let editor = try XCTUnwrap(findEditor(host.view))
        editor.becomeFirstResponder()
        model.startDictation()
        transcriber.continuation?.yield(.segment("um hello", isFinal: true))
        try await settle { model.text == "um hello" && editor.text == "um hello" }
        await model.stopDictation()
        try await settle { model.phase == .idle && editor.text == "Hello." }
        XCTAssertEqual(model.text, "Hello.")
        XCTAssertEqual(editor.text, "Hello.")
        XCTAssertTrue(editor.undoManager?.canUndo == true)
        editor.undoManager?.undo()
        try await settle { editor.text == "um hello" }
        XCTAssertEqual(model.text, "um hello")
        XCTAssertEqual(editor.text, "um hello")
    }
    private func settle(_ predicate: @escaping @MainActor () -> Bool) async throws {
        for _ in 0..<500 {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Editor did not settle")
    }
    private func findEditor(_ view: UIView) -> UITextView? {
        if let text = view as? UITextView { return text }
        for child in view.subviews { if let found = findEditor(child) { return found } }
        return nil
    }
}
#endif
