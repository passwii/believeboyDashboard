import Foundation
import Security

/// 钥匙串凭据存储（`kSecClassGenericPassword`）。
///
/// 为什么用钥匙串而不是 `UserDefaults`：API key 等价于账号密码 —— 登录后
/// 下发的 `blf_` key 直接代表该账号的全部权限（`require_api_key` 命中即放行）。
/// `UserDefaults` 是明文 plist，任何本机进程可读；钥匙串条目由系统加密并受
/// 应用签名约束。
public struct KeychainCredentialStore: CredentialStore {
    /// 钥匙串条目归属的 service。改这个值等于换一个存储槽位（旧条目会变孤儿）。
    public static let defaultService = "com.believeboy.dashboard.macos"
    /// 条目账号名。桌面端单个 key，固定值即可。
    public static let defaultAccount = "api-key"

    private let service: String
    private let account: String

    public init(service: String = KeychainCredentialStore.defaultService,
                account: String = KeychainCredentialStore.defaultAccount) {
        self.service = service
        self.account = account
    }

    public func loadAPIKey() throws -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data,
                  let value = String(data: data, encoding: .utf8)?.trimmedNonEmpty else {
                return nil
            }
            return value
        case errSecItemNotFound:
            return nil
        default:
            throw CredentialStoreError.keychain(status: status, message: Self.message(for: status))
        }
    }

    public func saveAPIKey(_ key: String) throws {
        guard let trimmed = key.trimmedNonEmpty else {
            // 空值语义 = 清除，避免写入空字符串导致后续请求带着空 header 出去。
            try deleteAPIKey()
            return
        }
        let data = Data(trimmed.utf8)
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
        switch updateStatus {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var insert = baseQuery
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            let addStatus = SecItemAdd(insert as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw CredentialStoreError.keychain(status: addStatus, message: Self.message(for: addStatus))
            }
        default:
            throw CredentialStoreError.keychain(status: updateStatus, message: Self.message(for: updateStatus))
        }
    }

    public func deleteAPIKey() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CredentialStoreError.keychain(status: status, message: Self.message(for: status))
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// `SecCopyErrorMessageString` 在少数 OSStatus 上返回 nil，退回通用文案。
    private static func message(for status: OSStatus) -> String {
        if let cf = SecCopyErrorMessageString(status, nil) {
            return cf as String
        }
        return "未知错误"
    }
}
