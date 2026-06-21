// Keychain wrapper for the macOS client's session state.
//
// BEL-147 stage 1: the backend uses Redis-backed sliding-window sessions
// (see `backend/app/services/infra/redis.py::write_session`) — there is no
// JWT and no refresh endpoint. We persist the entire `SessionContext` (user
// id, email, role, session_id, …) that the backend returned at login time,
// so `AppSession.bootstrap()` can rehydrate on next launch without forcing
// the user to log in again. The session_id is the actual bearer — it gets
// sent as `X-Session-Id` on every request and is the only thing the backend
// uses to validate the call (along with `X-User-Id`).
//
// We use `kSecClassGenericPassword` keyed by a single `session` account;
// the value is a JSON blob. Service identifier mirrors the bundle ID so
// tokens are isolated per-app.

import Foundation
import Security

actor KeychainStore {
    static let shared = KeychainStore()

    private let service: String

    init(service: String = "com.passwii.believeboy.macos.auth") {
        self.service = service
    }

    // MARK: - Session persistence

    func saveSession(_ context: SessionContext) async {
        guard let data = try? JSONEncoder().encode(context) else { return }
        try? write(data: data, account: "session")
    }

    func loadSession() async -> SessionContext? {
        guard let data = try? read(account: "session") else { return nil }
        return try? JSONDecoder().decode(SessionContext.self, from: data)
    }

    // MARK: - Lifecycle

    func clear() async {
        deleteItem(account: "session")
    }

    // MARK: - Keychain primitives

    private enum KeychainError: Error {
        case unhandled(OSStatus)
    }

    private func write(data: Data, account: String) throws {
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

    private func read(account: String) throws -> Data? {
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
        return item as? Data
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

/// Wire-shape of the session blob we keep in Keychain. Mirrors what the
/// backend returns from `/api/v1/auth/login` and reuses the relevant
/// subset from `/api/v1/auth/me` on bootstrap.
struct SessionContext: Codable, Equatable {
    var userId: String
    var email: String
    var userName: String?
    var operatorName: String?
    var roleType: String
    var isAdmin: Bool
    var sessionId: String
}