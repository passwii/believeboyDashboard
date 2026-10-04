import Foundation

/// 登录失败的形态。
///
/// 与 `APIError` 分开是因为**登录请求自己不适用「401/403 → 请重新登录」**那条规则：
/// 登录页上的 401 意思是「邮箱或密码错」，把它映射成 `APIError.unauthorized`
/// 会让 UI 提示用户「去重新登录」—— 而他正站在登录页上。
public enum AuthError: Error, Sendable, Equatable {
    /// 邮箱或密码为空，请求未发出。
    case missingInput
    /// 401：账号或密码不正确。
    case invalidCredentials
    /// 401 `{"detail":"Account disabled"}`：账号已停用（与密码错分开，处置不同）。
    case accountDisabled
    /// 429：登录触发限流（后端 IP 10 次 / 15 分钟，账号 5 次 / 30 分钟）。
    case rateLimited
    /// 其它 401 / 403。
    case rejected(status: Int)
    /// 200 但响应里没有可用 `api_key`（后端 DB 异常时的降级路径）。
    case emptyAPIKey
    /// 传输 / 解码 / 5xx 等底层失败。
    case serverError(APIError)
}

extension AuthError {
    /// 仅网络传输失败和服务端 5xx 可重试；认证失败、限流、解码错误等不重复提交。
    var isRetryable: Bool {
        guard case .serverError(let error) = self else { return false }
        switch error {
        case .transport:
            return true
        case .http(let status, _):
            return (500..<600).contains(status)
        default:
            return false
        }
    }

    /// 把底层 HTTP 错误归类到登录语义。
    static func from(_ error: APIError) -> AuthError {
        switch error {
        case .unauthorized(let status, let body) where status == 401:
            // 后端没有错误码，只能看 detail 文案（`auth.py` 只有这两条 401 分支：
            // "Invalid credentials" / "Account disabled"）。
            let detail = Self.detailMessage(in: body)?.lowercased() ?? ""
            return detail.contains("disabled") ? .accountDisabled : .invalidCredentials
        case .unauthorized(let status, _):
            return .rejected(status: status)
        case .http(let status, _) where status == 429:
            return .rateLimited
        default:
            return .serverError(error)
        }
    }

    /// 取 FastAPI 错误体里的 `detail`；非 JSON 或没有该字段返回 `nil`。
    private static func detailMessage(in body: String) -> String? {
        struct Envelope: Decodable { let detail: String? }
        guard let data = body.data(using: .utf8) else { return nil }
        return (try? JSONDecoder().decode(Envelope.self, from: data))?.detail
    }
}

extension AuthError: LocalizedError {
    public var errorDescription: String? { displayMessage }

    /// 面向用户的一句话说明（中文，可直接展示在登录页）。
    public var displayMessage: String {
        switch self {
        case .missingInput:
            return "请输入邮箱与密码。"
        case .invalidCredentials:
            return "邮箱或密码不正确。"
        case .accountDisabled:
            return "账号已停用，请联系管理员。"
        case .rateLimited:
            return "登录尝试过于频繁，请稍后再试。"
        case .rejected(let status):
            return "登录被拒绝（HTTP \(status)）。"
        case .emptyAPIKey:
            return "后端未下发凭据，请联系管理员（后端数据库异常时会出现）。"
        case .serverError(let error):
            return error.displayMessage
        }
    }
}
