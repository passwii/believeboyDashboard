import Foundation

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

    private let item: KeychainItem

    public init(service: String = KeychainCredentialStore.defaultService,
                account: String = KeychainCredentialStore.defaultAccount) {
        self.item = KeychainItem(service: service, account: account)
    }

    public func loadAPIKey() throws -> String? {
        guard let data = try item.load() else { return nil }
        return String(data: data, encoding: .utf8)?.trimmedNonEmpty
    }

    public func saveAPIKey(_ key: String) throws {
        guard let trimmed = key.trimmedNonEmpty else {
            // 空值语义 = 清除，避免写入空字符串导致后续请求带着空 header 出去。
            try deleteAPIKey()
            return
        }
        try item.save(Data(trimmed.utf8))
    }

    public func deleteAPIKey() throws {
        try item.delete()
    }
}
