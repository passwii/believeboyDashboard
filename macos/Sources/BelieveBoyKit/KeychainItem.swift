import Foundation
import Security

/// 钥匙串里的一个 `kSecClassGenericPassword` 条目（service + account 唯一定位）。
///
/// 抽出来是因为 S2 需要两个条目：账号专属 key（机密）与会话档案（`operator_name_zh`
/// / `is_admin` 等）。两者的 CRUD 完全一样，只有 account 不同 —— 复制一份
/// `SecItemCopyMatching` 样板只会让两处各自漂移。
///
/// 为什么档案也放钥匙串而不是 `UserDefaults`：它不是凭据，但它是「后端按谁过滤
/// 数据」的依据，且含邮箱等个人信息。钥匙串条目受系统加密与应用签名约束，
/// `UserDefaults` 是明文 plist。既然已经在钥匙串里有条目，没有理由降级存明文。
struct KeychainItem {
    let service: String
    let account: String

    /// 读取条目内容；不存在返回 `nil`。
    func load() throws -> Data? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            return item as? Data
        case errSecItemNotFound:
            return nil
        default:
            throw CredentialStoreError.keychain(status: status, message: Self.message(for: status))
        }
    }

    /// 写入（存在则覆盖）条目内容。
    func save(_ data: Data) throws {
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

    /// 删除条目（幂等：不存在也算成功）。
    func delete() throws {
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
