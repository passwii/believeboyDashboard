import Foundation

/// `POST /api/v1/auth/login` 的请求体
/// （`backend/app/api/v1/endpoints/auth.py` 的 `LoginRequest`）。
public struct LoginRequest: Encodable, Sendable, Equatable {
    public let email: String
    public let password: String

    public init(email: String, password: String) {
        self.email = email
        self.password = password
    }
}

/// `POST /api/v1/auth/login` 的响应体（后端 `LoginResponse`）。
///
/// 可空字段是**对齐后端默认值**而非容错：`operator_name_zh` 后端可为 `null`，
/// `session_id` / `role_type` / `api_key` 在 Pydantic 里都有默认值，DB 异常时
/// `api_key` 会被降级成空串（`auth.py` 的 `except: rollback()` 分支）。
/// 把这种「200 但没 key」当成成功，用户会拿着空 header 去打下一次请求。
public struct LoginResponse: Decodable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let email: String
    public let operatorNameZh: String?
    public let isAdmin: Bool
    public let isActive: Bool
    public let roleType: String?
    public let sessionId: String?
    public let apiKey: String?
}

/// 登录得到的账号档案。
///
/// 这些字段不参与鉴权，但决定后端按「谁」过滤数据 —— 桌面端不注入它们时，
/// 用户会看到一份不受自己可见性约束的（或空）数据。故随会话持久化，冷启动
/// 时不依赖网络往返就能把 `X-Operator` / `X-User-Id` / `X-Is-Admin` 发出去。
public struct AuthenticatedUser: Codable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let email: String
    public let operatorNameZh: String?
    public let isAdmin: Bool
    /// 后端 `role_type`：`admin` / `operator` / `businessdev`。
    public let roleType: String

    public init(
        id: String,
        name: String,
        email: String,
        operatorNameZh: String?,
        isAdmin: Bool,
        roleType: String
    ) {
        self.id = id
        self.name = name
        self.email = email
        self.operatorNameZh = operatorNameZh
        self.isAdmin = isAdmin
        self.roleType = roleType
    }

    /// `X-Operator` 的取值：中文名优先，缺失时退回账号名。
    /// 与 Web 端代理的 `pickUserName`（`frontend/lib/backend-auth.ts`）同一口径 ——
    /// 后端按 `operator_name_zh` 匹配项目归属，取错名字等于取错数据。
    public var operatorName: String {
        operatorNameZh?.trimmedNonEmpty ?? name
    }
}

/// 一次可用的登录态：凭据 + 账号档案。
///
/// `user == nil` 表示「只有 key，没有账号上下文」—— 环境变量
/// （`BELIEVEBOY_API_KEY`，开发 / CI / 无 GUI 排查）与主 key 走这条路：
/// 它们不带账号信息，因此不发 `X-Operator` 一族请求头，由后端按「未声明操作员」
/// 处理。登录态永远有 `user`。
///
/// **本结构不含密码，也不应有密码字段。**
public struct AuthSession: Sendable, Equatable {
    public let apiKey: String
    public let user: AuthenticatedUser?

    public init(apiKey: String, user: AuthenticatedUser? = nil) {
        self.apiKey = apiKey
        self.user = user
    }
}

extension AuthSession {
    /// 由登录响应构造会话。
    ///
    /// - Throws: `AuthError.accountDisabled`（账号停用）、`AuthError.emptyAPIKey`
    ///   （后端降级路径下发空 key）。
    public init(loginResponse: LoginResponse) throws {
        guard loginResponse.isActive else { throw AuthError.accountDisabled }
        guard let apiKey = loginResponse.apiKey?.trimmedNonEmpty else { throw AuthError.emptyAPIKey }
        self.apiKey = apiKey
        self.user = AuthenticatedUser(
            id: loginResponse.id,
            name: loginResponse.name,
            email: loginResponse.email,
            operatorNameZh: loginResponse.operatorNameZh?.trimmedNonEmpty,
            isAdmin: loginResponse.isAdmin,
            // 后端 `role_type` 有默认值，但 role_type 为空时它以 is_admin 兜底
            // （`auth.py` 的 `UserRoleType.admin if is_admin else operator`），此处同口径。
            roleType: loginResponse.roleType?.trimmedNonEmpty
                ?? (loginResponse.isAdmin ? "admin" : "operator")
        )
    }
}

/// 后端按账号可见性过滤数据所依赖的请求头。
///
/// 权威口径是 Web 端代理（`frontend/lib/backend-auth.ts` 的
/// `applySessionContextHeaders`）与后端读取端（`backend/app/api/deps.py`）。
/// 本类型只承载桌面端需要的三项（`X-Operator` / `X-User-Id` / `X-Is-Admin`）——
/// 其余（`X-User-Email` / `X-Role-Type` / `X-Session-Id`）当前没有端点依赖，
/// 不发比发错更安全。
public struct UserContext: Sendable, Equatable {
    public let operatorName: String?
    public let userId: String?
    public let isAdmin: Bool

    public init(operatorName: String? = nil, userId: String? = nil, isAdmin: Bool = false) {
        self.operatorName = operatorName?.trimmedNonEmpty
        self.userId = userId?.trimmedNonEmpty
        self.isAdmin = isAdmin
    }

    /// 登录档案 → 请求头上下文。
    public static func from(_ user: AuthenticatedUser) -> UserContext {
        UserContext(operatorName: user.operatorName, userId: user.id, isAdmin: user.isAdmin)
    }

    /// 实际写进请求的头部。
    ///
    /// `X-Operator` 是中文名，而 HTTP 头值必须是 ASCII —— 故与 Web 端同样做
    /// percent-encoding，由后端 `app/api/deps.py:_decode_header_value` 解回
    /// （它先试 base64，失败后 `unquote`；`%` 不是 base64 字符，必然落到后者）。
    var headers: [String: String] {
        var headers: [String: String] = [:]
        if let operatorName {
            headers["X-Operator"] = operatorName.percentEncodedForHTTPHeaderValue
        }
        if let userId {
            headers["X-User-Id"] = userId
        }
        headers["X-Is-Admin"] = isAdmin ? "true" : "false"
        return headers
    }
}

extension String {
    /// `encodeURIComponent` 等价实现（保留 `A-Za-z0-9-_.!~*'()`）。
    ///
    /// 不能直接用 `CharacterSet.alphanumerics`：它是 Unicode 语义，中文汉字
    /// 也算「字母」，`addingPercentEncoding` 会原样放行非 ASCII 字符。
    var percentEncodedForHTTPHeaderValue: String {
        let allowed = CharacterSet(
            charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
        )
        return addingPercentEncoding(withAllowedCharacters: allowed) ?? self
    }
}
