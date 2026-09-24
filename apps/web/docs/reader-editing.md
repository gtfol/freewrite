# Reader editing

The article toolbar's **Edit** action replaces block-by-block trimming. It opens the imported HTML as an ordinary editable reading surface. Users can select partial sentences, delete, type replacements, add paragraphs, and paste plain text. No writing-only slash menu, music command, timer, or backspace lock is mounted.

Existing imported formatting remains. Math is edited as its TeX text; KaTeX rendering is suspended during editing so generated markup cannot leak into saved content. Pasted text cannot insert scripts or hidden clipboard markup, and changed HTML uses the same sanitizer as imports before saving. Links do not navigate while editing.

Done saves and recalculates the word count. Cancel discards the session. The browser's native undo stack supports the toolbar Undo action and keyboard undo/redo. Restore original is an undoable edit, and the original HTML is retained byte-for-byte through later saves. The source PDF is unchanged. No-op saves retain the prior content and timestamp.

The save transaction compares the current stored body with the editor's starting body. A changed/deleted article produces a visible conflict while retaining the draft. Concurrent title/metadata/note changes survive. The edited article and its sync marker commit together. Existing highlight quotes can reattach where text remains; removed or rewritten quotes may no longer match.

## Verification

- `npm test`: 233 passed, 1 skipped (the existing disposable-Postgres test).
- Lint, TypeScript, and production build pass. The build retains the pre-existing CSS minifier warnings for `::highlight` selectors.
- Added tests for sanitization; repeated edits and exact original restoration; no-op saves; concurrent content changes/deletion; retained PDF bytes and concurrent metadata/notes; and empty-content edits.
- Browser walkthrough with a synthetic imported PDF: select/delete one sentence within a paragraph, Undo, replace it by typing, Done, reload, Restore original, and Undo restoration. Additional checks cover Cancel, literal slash text, plain-text paste, and concurrent edits in two tabs.
- No signed-in account, live sync server, or user document was used. Native browser editing should also receive a Safari/iPhone keyboard and IME smoke check before release.

## Future iOS reader

When the reader is added to the native iPhone app, include direct text editing and partial-paragraph trimming from its first version. Match Done/Cancel, undo, original restoration, retained PDF source, and conflict-safe saves. Exclude writing-only slash commands. This web PR does not add native reader UI; the current iOS slice remains write and dictate.
