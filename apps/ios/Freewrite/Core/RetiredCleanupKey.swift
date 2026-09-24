import Security

// Builds 1–2 offered a remote cleanup option. Delete only its old credential
// when upgrading; no code reads it or sends dictated text to a service.
enum RetiredCleanupKey {
    @discardableResult static func remove(service: String = "dev.gtfol.freewrite.cleanup") -> OSStatus {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "openai",
            kSecAttrSynchronizable as String: false
        ] as CFDictionary)
    }
}
