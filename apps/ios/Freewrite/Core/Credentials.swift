import Foundation
import Security

struct CleanupCredential: Codable, Sendable {
    let key: String
    let consent: Bool
}

struct KeychainCredentials: Sendable {
    var service = "dev.gtfol.freewrite.cleanup"

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "openai", kSecAttrSynchronizable as String: false]
    }
    func read() throws -> CleanupCredential? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let credential = try? JSONDecoder().decode(CleanupCredential.self, from: data) else { throw WritingError.keychain }
        return credential
    }
    func save(key: String, consent: Bool) throws {
        guard consent, !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw WritingError.consent }
        let data = try JSONEncoder().encode(CleanupCredential(key: key.trimmingCharacters(in: .whitespacesAndNewlines), consent: consent))
        let values: [String: Any] = [kSecValueData as String: data,
                                    kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(values) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw WritingError.keychain }
    }
    func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw WritingError.keychain }
    }
}
