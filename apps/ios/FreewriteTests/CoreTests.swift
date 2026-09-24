import XCTest
#if SWIFT_PACKAGE
@testable import FreewriteCore
#else
@testable import Freewrite
#endif

final class CoreTests: XCTestCase {
    func testFillersAndPunctuation() {
        XCTAssertEqual(OnDeviceTextCleaner.cleanLocally("um, i think uh we should go"), "I think we should go.")
        XCTAssertEqual(OnDeviceTextCleaner.cleanLocally("like, i was, like, ready"), "I was ready.")
        XCTAssertEqual(OnDeviceTextCleaner.cleanLocally("um uh"), "")
    }
    func testMeaningfulWordsStay() {
        for text in ["I like coffee.", "It looks like rain.", "I'd like to go.", "umbrella rhythm hum", "I, like you, enjoy writing."] {
            XCTAssertEqual(OnDeviceTextCleaner.words(OnDeviceTextCleaner.cleanLocally(text)), OnDeviceTextCleaner.words(text))
        }
        XCTAssertFalse(OnDeviceTextCleaner.preservesWords(raw: "I am not ready", cleaned: "I am ready."))
        XCTAssertFalse(OnDeviceTextCleaner.preservesWords(raw: "I like coffee", cleaned: "I coffee."))
        XCTAssertFalse(OnDeviceTextCleaner.preservesWords(raw: "we went home", cleaned: "we returned home."))
        XCTAssertTrue(OnDeviceTextCleaner.preservesWords(raw: "um i am ready", cleaned: "I am ready."))
    }
    func testParagraphsAndUnicode() {
        XCTAssertEqual(OnDeviceTextCleaner.cleanLocally("hello\n\nworld"), "Hello\n\nWorld.")
        XCTAssertTrue(OnDeviceTextCleaner.preservesWords(raw: "café don't stop", cleaned: "Café, don’t stop."))
    }
    func testWebEntryEncoding() throws {
        let entry = Entry(id: "web-id", content: "café 👋", now: 1_790_000_000_123)
        let data = try JSONEncoder().encode(entry)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(json.keys), Set(["id", "content", "createdAt", "updatedAt", "deletedAt"]))
        XCTAssertEqual(json["createdAt"] as? Double, 1_790_000_000_123)
        XCTAssertTrue(json["deletedAt"] is NSNull)
        XCTAssertEqual(try JSONDecoder().decode(Entry.self, from: data), entry)
        let missing = Data(#"{"id":"web","content":"words","createdAt":123,"updatedAt":456}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(Entry.self, from: missing).deletedAt)
    }
    func testTombstoneRoundtrip() throws {
        var entry = Entry(content: "", now: 50)
        entry.deletedAt = 99; entry.updatedAt = 99
        XCTAssertEqual(try JSONDecoder().decode(Entry.self, from: JSONEncoder().encode(entry)), entry)
    }
    func testInsertionAtUnicodeCursor() {
        XCTAssertEqual(TextInsertion.replacing("a👩🏽‍💻b", range: NSRange(location: 8, length: 0), with: " words "), "a👩🏽‍💻 words b")
        XCTAssertNil(TextInsertion.replacing("👋", range: NSRange(location: 1, length: 0), with: "bad"))
        XCTAssertNil(TextInsertion.replacing("abc", range: NSRange(location: 20, length: 1), with: "bad"))
        XCTAssertEqual(TextInsertion.replacing("abc", range: NSRange(location: 1, length: 1), with: "XYZ"), "aXYZc")
    }
    func testRangeRebasingAndOverlap() {
        let anchor = NSRange(location: 5, length: 4)
        XCTAssertEqual(TextInsertion.adjusted(anchor, for: NSRange(location: 1, length: 0), replacementLength: 3), NSRange(location: 8, length: 4))
        XCTAssertEqual(TextInsertion.adjusted(anchor, for: NSRange(location: 9, length: 0), replacementLength: 3), anchor)
        XCTAssertNil(TextInsertion.adjusted(anchor, for: NSRange(location: 6, length: 1), replacementLength: 0))
    }
    func testInterimRevisionsDoNotDuplicate() {
        var insertion = DictationInsertion(text: "before after", caret: 7)
        insertion.receive("hello", isFinal: false)
        insertion.receive("hello there", isFinal: false)
        insertion.receive("Hello there.", isFinal: true)
        insertion.receive("More", isFinal: false)
        XCTAssertEqual(insertion.transcript, "Hello there. More")
        insertion.receive("More words.", isFinal: true)
        XCTAssertEqual(insertion.transcript, "Hello there. More words.")
    }
    func testCleanupRespectsLanguage() async throws {
        let english = try await OnDeviceTextCleaner(locale: Locale(identifier: "en_US")).clean("um i am ready")
        XCTAssertEqual(english, "I am ready.")
        let original = "Um café, por favor"
        let portuguese = try await OnDeviceTextCleaner(locale: Locale(identifier: "pt_BR")).clean(original)
        XCTAssertEqual(portuguese, original)
    }

}

@MainActor final class TimerTests: XCTestCase {
    func testPauseResetAndElapsedTime() {
        let timer = SessionTimer(), start = Date(timeIntervalSince1970: 1_000)
        timer.toggle(now: start); timer.tick(now: start.addingTimeInterval(60))
        XCTAssertEqual(timer.label, "14:00")
        timer.toggle(now: start.addingTimeInterval(90)); XCTAssertEqual(timer.remaining, 810)
        timer.toggle(now: start.addingTimeInterval(100)); timer.tick(now: start.addingTimeInterval(910))
        XCTAssertEqual(timer.label, "15:00"); XCTAssertFalse(timer.running)
    }
}
