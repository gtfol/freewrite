import Foundation

protocol TextCleaner: Sendable { func clean(_ text: String) async throws -> String }

struct OnDeviceTextCleaner: TextCleaner {
    func clean(_ text: String) async throws -> String { Self.cleanLocally(text) }

    // Deliberately narrow English rules. Ambiguous uses of “like” are kept.
    static func removingFillers(_ text: String) -> String {
        var result = text.replacingOccurrences(of: #"(?i)(?<![\p{L}\p{N}])(?:um+|uh+|erm+)(?![\p{L}\p{N}])[,;:]?[ \t]*"#,
                                               with: "", options: .regularExpression)
        result = result.replacingOccurrences(of: #"(?i),[ \t]*like,[ \t]*"#, with: " ", options: .regularExpression)
        result = result.replacingOccurrences(of: #"(?i)(^|[.!?]\s+)like,[ \t]*"#,
                                             with: "$1", options: .regularExpression)
        return result
    }

    static func cleanLocally(_ text: String) -> String {
        var result = removingFillers(text)
        result = result.replacingOccurrences(of: #"[ \t]{2,}"#, with: " ", options: .regularExpression)
        result = result.replacingOccurrences(of: #"\s+([,.;:!?])"#, with: "$1", options: .regularExpression)
        result = result.replacingOccurrences(of: #",\s*([,.!?])"#, with: "$1", options: .regularExpression)
        result = result.trimmingCharacters(in: .whitespacesAndNewlines)
        result = result.replacingOccurrences(of: #"\bi\b"#, with: "I", options: .regularExpression)
        var sentenceStart = true
        result = result.map { character -> String in
            defer {
                if character.isLetter || character.isNumber { sentenceStart = false }
                if ".!?\n".contains(character) { sentenceStart = true }
            }
            return sentenceStart && character.isLetter ? String(character).uppercased() : String(character)
        }.joined()
        if let last = result.last, last.isLetter || last.isNumber { result += "." }
        return result
    }

    static func words(_ text: String) -> [String] {
        text.lowercased().split { !$0.isLetter && !$0.isNumber && $0 != "'" && $0 != "’" }
            .map { $0.replacingOccurrences(of: "’", with: "'") }
    }

    // Remote output must retain every non-filler word, in its original order.
    static func preservesWords(raw: String, cleaned: String) -> Bool {
        words(removingFillers(raw)) == words(cleaned)
    }
}
