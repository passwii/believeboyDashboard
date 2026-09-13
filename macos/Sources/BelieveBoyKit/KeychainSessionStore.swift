import Foundation

/// 登录态（凭据 + 账号档案）的持久化抽象。
///
/// 与 `CredentialStore` 的分工：`CredentialStore` 只管那把 key（「能不能发请求」），
/// `SessionStore` 管一整次会话（「以谁的身份」）。登录/登出走这里，网络层只认
/// 解析后的 `AuthSession`。
public protocol SessionStore: Sendable {
    /// 读取当前会话；未登录返回 `nil`。
    func loadSession() throws -> AuthSession?
    /// 写入并覆盖已有会话。
    func saveSession(_ session: AuthSession) throws
    /// 清除会话（幂等）。401/403 判定凭据失效时也走这里。
    func clearSession() throws
}

/// 钥匙串会话存储：key 走 `CredentialStore`（默认 `KeychainCredentialStore`，
/// 即 S1 就已交付的那个条目，不新增第二把 key），账号档案走同钥匙串的另一个
/// 条目（JSON）。
///
/// 写入顺序是刻意的：先档案、后 key。`loadSession` 以「key 是否存在」判定登录态，
/// 因此「key 在 ⇒ 档案在」必须成立，否则会出现「冷启动有 key 但发不出 X-Operator」
/// 的半登录态 —— 后端会把这种人按「未声明操作员」过滤，用户看到的是空数据而不是报错。
/// key 写失败时回滚刚写的档案，维持该不变式。
public struct KeychainSessionStore: SessionStore {
    /// 档案条目名。与 `CredentialStore` 的 `api-key` 分槽，互不覆盖。
    public static let defaultProfileAccount = "session-profile"

    private let credentials: CredentialStore
    private let profileItem: KeychainItem

    /// - Parameter credentials: key 的存放位置。默认钥匙串；注入点用于测试与
    ///   「只读凭据源」（`EnvironmentCredentialStore`）场景。
    public init(
        service: String = KeychainCredentialStore.defaultService,
        credentials: CredentialStore? = nil
    ) {
        self.credentials = credentials ?? KeychainCredentialStore(service: service)
        self.profileItem = KeychainItem(service: service, account: Self.defaultProfileAccount)
    }

    public func loadSession() throws -> AuthSession? {
        guard let apiKey = try credentials.loadAPIKey()?.trimmedNonEmpty else { return nil }
        // 档案解不出来（旧版本写的、被外部改动）不阻断登录态：`user == nil`
        // 退化成「无账号上下文」，用户至少还能用，重新登录即自愈。
        let user = try profileItem.load().flatMap { data in
            try? JSONDecoder().decode(AuthenticatedUser.self, from: data)
        }
        return AuthSession(apiKey: apiKey, user: user)
    }

    public func saveSession(_ session: AuthSession) throws {
        if let user = session.user {
            try profileItem.save(try JSONEncoder().encode(user))
        } else {
            try profileItem.delete()
        }
        do {
            try credentials.saveAPIKey(session.apiKey)
        } catch {
            try? profileItem.delete()
            throw error
        }
    }

    public func clearSession() throws {
        // 先删 key：key 一没，`loadSession` 立刻返回 nil，即使档案残留也只是孤儿。
        try credentials.deleteAPIKey()
        try profileItem.delete()
    }
}
