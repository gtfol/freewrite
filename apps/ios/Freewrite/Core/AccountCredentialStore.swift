import Foundation
import Security

@MainActor protocol AccountCredentialStoring {
    func read() throws -> FreewriteLogin?
    func save(_ login: FreewriteLogin?) throws
}

struct AccountCredentialStore: AccountCredentialStoring {
    var service = "dev.gtfol.freewrite.account"
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "session", kSecAttrSynchronizable as String: false]
    }
    func read() throws -> FreewriteLogin? {
        var query = query; query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let login = try? JSONDecoder().decode(FreewriteLogin.self, from: data), FreewriteAccountClient.valid(login) else { throw SignInError.storage }
        return login
    }
    func save(_ login: FreewriteLogin?) throws {
        guard let login else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw SignInError.storage }
            return
        }
        guard FreewriteAccountClient.valid(login) else { throw SignInError.storage }
        let attributes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(login),
                                        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes, uniquingKeysWith: { _, new in new }) as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw SignInError.storage }
    }
}
