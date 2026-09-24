import Foundation

enum TextInsertion {
    static func replacing(_ text: String, range: NSRange, with replacement: String) -> String? {
        guard range.location >= 0, range.length >= 0,
              range.location <= text.utf16.count, range.length <= text.utf16.count - range.location,
              let swiftRange = Range(range, in: text), NSRange(swiftRange, in: text) == range,
              (swiftRange.lowerBound == text.endIndex || text.indices.contains(swiftRange.lowerBound)),
              (swiftRange.upperBound == text.endIndex || text.indices.contains(swiftRange.upperBound)) else { return nil }
        return text.replacingCharacters(in: swiftRange, with: replacement)
    }

    static func adjusted(_ anchor: NSRange, for edit: NSRange, replacementLength: Int) -> NSRange? {
        if NSMaxRange(edit) <= anchor.location {
            return NSRange(location: anchor.location + replacementLength - edit.length, length: anchor.length)
        }
        if edit.location >= NSMaxRange(anchor) { return anchor }
        return nil // An overlapping manual edit owns the text from now on.
    }

    static func joined(_ first: String, _ second: String) -> String {
        guard let last = first.last, let next = second.first else { return first + second }
        let needsSpace = !last.isWhitespace && !next.isWhitespace && !",.!?;:)]}".contains(next)
        return first + (needsSpace ? " " : "") + second
    }
}

struct DictationInsertion: Sendable {
    var range: NSRange
    private(set) var finalized = ""
    private(set) var provisional = ""
    let prefix: String
    let suffix: String

    init(text: String, caret: Int) {
        let position = min(max(0, caret), text.utf16.count)
        range = NSRange(location: position, length: 0)
        let index = Range(range, in: text)?.lowerBound ?? text.endIndex
        prefix = index > text.startIndex && !text[text.index(before: index)].isWhitespace ? " " : ""
        suffix = index < text.endIndex && !text[index].isWhitespace && !",.!?;:)]}".contains(text[index]) ? " " : ""
    }

    var transcript: String { TextInsertion.joined(finalized, provisional) }
    func decorated(_ text: String) -> String { text.isEmpty ? "" : prefix + text + suffix }
    var inserted: String { decorated(transcript) }

    mutating func receive(_ text: String, isFinal: Bool) {
        if isFinal {
            finalized = TextInsertion.joined(finalized, text)
            provisional = ""
        } else { provisional = text }
    }
}
