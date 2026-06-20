// Keychain wrapper for JWT + refresh tokens.
//
// BEL-147: keeps tokens out of UserDefaults. We use `kSecClassGenericPassword`
// keyed by `access_token` / `refresh_token`. Service identifier mirrors the
// bundle ID so tokens are isolated per-app.

import Foundation
import Security

actor KeychainStore {
    static let shared = KeychainStore()

    private let service: String

    init(service: String = "com.passwii.believeboy.macos.auth") {
        self.service = service
    }

    // MARK: - Access token

    func saveAccessToken(_ token: String, refreshToken: String?) async {
        try? write(value: token, account: "access_token")
        if let refresh = refreshToken {
            try? write(value: refresh, account: "refresh_token")
        }
    }

    func loadAccessToken() async -> String? {
        try? read(account: "access_token")
    }

    func loadRefreshToken() async -> String? {
        try? read(account: "refresh_token")
    }

    // MARK: - Lifecycle

    func clear() async {
        deleteItem(account: "access_token")
        deleteItem(account: "refresh_token")
    }

    // MARK: - Keychain primitives

    private enum KeychainError: Error {
        case unhandled(OSStatus)
    }

    private func write(value: String, account: String) throws {
        guard let data = value.data(using: .utf8) else { return }

        // Delete existing entry first to avoid duplicate-item errors.
        deleteItem(account: account)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.unhandled(status) }
    }

    private func read(account: String) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else {
            if status == errSecItemNotFound { return nil }
            throw KeychainError.unhandled(status)
        }
        guard let data = item as? Data, let str = String(data: data, encoding: .utf8) else {
            return nil
        }
        return str
    }

    private func deleteItem(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
