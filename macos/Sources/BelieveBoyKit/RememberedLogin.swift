import Foundation

/// 「记住密码」保存的那一对输入：邮箱 + 密码。
///
/// 为什么连邮箱一起存：`blf_` key 是**覆盖式轮换**（PLAN §4.1.1）—— 用户在网页端
/// 登录一次，桌面端手里的 key 就失效并被清掉，连账号档案（含邮箱）一起没了。只记
/// 密码的话，回到登录页还得再打一遍邮箱，「记住密码」就只省了一半的事。
public struct RememberedLogin: Codable, Sendable, Equatable {
    public let email: String
    public let password: String

    public init(email: String, password: String) {
        self.email = email
        self.password = password
    }
}

/// 「记住密码」的持久化抽象。
///
/// 只有钥匙串实现（`KeychainRememberedLoginStore`），**没有也不应有**
/// `UserDefaults` 实现：`UserDefaults` 是明文 plist，把密码放进去等于把账号交出去
/// （验收 3 的同一条约束）。
public protocol RememberedLoginStore: Sendable {
    /// 读取已记住的凭据；没记住返回 `nil`。
    func loadLogin() throws -> RememberedLogin?
    /// 写入并覆盖已记住的凭据。
    func saveLogin(_ login: RememberedLogin) throws
    /// 删除已记住的凭据（幂等）。用户取消勾选「记住密码」时走这里。
    func deleteLogin() throws
}

/// 钥匙串实现：`kSecClassGenericPassword` 的第三个条目槽位（另两个是会话 key 与
/// 账号档案，见 `KeychainSessionStore`）。
public struct KeychainRememberedLoginStore: RememberedLoginStore {
    /// 条目账号名。与会话条目分槽，互不覆盖。
    public static let defaultAccount = "remembered-login"

    private let item: KeychainItem

    public init(
        service: String = KeychainCredentialStore.defaultService,
        account: String = KeychainRememberedLoginStore.defaultAccount
    ) {
        self.item = KeychainItem(service: service, account: account)
    }

    public func loadLogin() throws -> RememberedLogin? {
        guard let data = try item.load() else { return nil }
        // 解不出来（旧格式 / 被外部改动）按「没记住」处理：后果只是多打一次密码，
        // 不值得把用户挡在登录页外。
        return try? JSONDecoder().decode(RememberedLogin.self, from: data)
    }

    public func saveLogin(_ login: RememberedLogin) throws {
        try item.save(try JSONEncoder().encode(login))
    }

    public func deleteLogin() throws {
        try item.delete()
    }
}
