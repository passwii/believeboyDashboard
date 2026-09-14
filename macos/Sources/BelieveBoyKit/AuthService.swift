import Foundation

/// 登录服务：`POST /api/v1/auth/login` → `AuthSession`。
///
/// 单独成类型而不是塞进 `APIClient`：这一层负责把 HTTP 语义（401 / 403 / 429）
/// 翻译成**登录语义**（密码错 / 账号停用 / 限流），并把「200 但没有 api_key」这种
/// 半成功挡在门外。`APIClient` 保持为纯粹的「发请求 + 解码」。
public enum AuthService {
    /// 用邮箱与密码换取会话。
    ///
    /// 响应里的 `api_key` 就是桌面端要长期持有的账号专属 `blf_` key
    /// （BLF-711）。它是**槽内覆盖式轮换**：同一设备槽只有一把有效 key，本次登录会
    /// 使**同一个槽**此前下发的 key 立刻失效，槽之间互不影响（BLF-1059）。
    ///
    /// - Parameters:
    ///   - email: 邮箱，首尾空白会被去掉（与后端 `payload.email.strip().lower()` 同口径）。
    ///   - password: 密码，**原样发送不做 trim** —— 首尾空格可能是密码的一部分。
    ///   - baseURL: 后端根地址。
    ///   - clientID: 设备槽标识（本机 `ClientIdentifier.value`）。**必须显式传**：
    ///     传 `nil` 等于不带该头，后端落 `default` 槽 —— 网页端也在 `default` 槽，
    ///     于是「桌面端登录顶掉网页端」的老问题原样复现。仅本机标识确实取不到、
    ///     且宁愿退化也不愿冒充某台设备时才传 `nil`。
    ///   - session: 注入点，测试用打桩 session。
    /// - Throws: `AuthError` 的分类失败。
    public static func login(
        email: String,
        password: String,
        baseURL: URL,
        clientID: String?,
        session: URLSession = .shared
    ) async throws -> AuthSession {
        guard let email = email.trimmedNonEmpty, !password.isEmpty else {
            throw AuthError.missingInput
        }
        // 登录请求自身不带凭据（此刻还没有），也不带账号上下文 —— 那要等响应回来。
        // 唯一要带的是设备槽标识：它是「往哪个槽写这把新 key」的选择器，不是身份。
        let client = APIClient(baseURL: baseURL, apiKey: nil, userContext: nil, session: session)
        let slotHeaders = clientID.map { [ClientIdentifier.headerName: $0] } ?? [:]
        do {
            let response: LoginResponse = try await client.post(
                "/auth/login",
                body: LoginRequest(email: email, password: password),
                tier: .detail,
                authenticated: false,
                headers: slotHeaders
            )
            return try AuthSession(loginResponse: response)
        } catch let error as APIError {
            throw AuthError.from(error)
        }
    }
}
