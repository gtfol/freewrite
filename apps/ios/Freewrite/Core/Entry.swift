import Foundation

struct Entry: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var content: String
    var createdAt: Double
    var updatedAt: Double
    var deletedAt: Double?

    init(id: String = UUID().uuidString.lowercased(), content: String = "", now: Double = timestamp()) {
        self.id = id
        self.content = content
        createdAt = now
        updatedAt = now
    }

    static func timestamp() -> Double { (Date().timeIntervalSince1970 * 1_000).rounded(.down) }

    private enum CodingKeys: String, CodingKey { case id, content, createdAt, updatedAt, deletedAt }
    func encode(to encoder: any Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(content, forKey: .content)
        try values.encode(createdAt, forKey: .createdAt)
        try values.encode(updatedAt, forKey: .updatedAt)
        try values.encode(deletedAt, forKey: .deletedAt)
    }

    var preview: String {
        String(content.split(whereSeparator: \.isNewline).first.map(String.init)?.prefix(80) ?? "")
    }
}

@MainActor protocol EntryStore {
    func entries() throws -> [Entry]
    func save(_ entry: Entry) throws
}

enum WritingError: Error, LocalizedError, Equatable {
    case microphoneDenied, unavailable, unsupportedLanguage, modelDownload
    case interrupted, audio, cleanup, storage

    var errorDescription: String? {
        switch self {
        case .microphoneDenied: "microphone access is off. allow it in Settings to dictate."
        case .unavailable: "on-device dictation isn’t available on this device. you can keep typing."
        case .unsupportedLanguage: "on-device dictation doesn’t support your language yet. you can keep typing."
        case .modelDownload: "the speech model couldn’t be prepared. try again in a moment."
        case .interrupted: "dictation stopped after an interruption. your text is still here."
        case .audio: "dictation stopped. your text is still here. tap the microphone to try again."
        case .cleanup: "cleanup didn’t finish. your original words are still here."
        case .storage: "your latest words couldn’t be saved. keep this entry open and retry."
        }
    }
}
