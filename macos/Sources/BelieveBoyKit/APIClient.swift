import Foundation

/// 请求超时分层，对齐 Web 端代理策略
/// （`frontend/lib/server/backend-proxy-timeout-policy.ts`）。
///
/// 桌面端不经 Next.js 代理，但沿用同一张表 —— 两端对"同一端点该等多久"的
/// 预期必须一致，否则会出现在 Web 上正常、在桌面端提前超时的割裂。
public enum RequestTier: Sendable {
    /// 流式（SSE / NDJSON）：不设超时。
    case stream
    /// 报表组装 / 邮件派发。
    case report
    /// AI / 洞察生成。
    case ai
    /// 统计与聚合。
    case stats
    /// 单资源详情。
    case detail
    /// 集合列表与轻量探针。
    case list

    /// 该档位的请求超时；`nil` = 不设超时（流式）。
    public var timeout: TimeInterval? {
        switch self {
        case .stream: return nil
        case .report: return 60
        case .ai: return 30
        case .stats: return 15
        case .detail: return 10
        case .list: return 5
        }
    }

    /// 无超时档（`.stream`）实际写到 `URLRequest.timeoutInterval` 上的值。
    ///
    /// `URLRequest` 没有「禁用超时」开关 —— 不写就等于 Foundation 默认的 60s，
    /// 会把长时间没有数据的 SSE / NDJSON 在 60s 处掐断。故显式抬到一个远超任何真实
    /// 会话上限的值；真正的兜底是 `URLSessionConfiguration.timeoutIntervalForResource`
    /// （默认 7 天，会话级，不由本客户端控制）。
    public static let unboundedTimeout: TimeInterval = 60 * 60 * 24 * 365
}

/// 后端 HTTP 客户端。值语义、无可变共享状态，天然 `Sendable`。
public struct APIClient: Sendable {
    /// 后端 API 前缀（`backend/app/main.py` 的 `prefix="/api/v1"`）。
    public static let apiPrefix = "/api/v1"

    // 以下成员为 `internal` 而非 `private`：写入（`Networking/APIClient+Write.swift`）、
    // multipart 上传、SSE 流式与下载（同目录）都是**同模块内的扩展**，需要复用同一套
    // 请求构造与错误分类（超时分层 / 凭据注入 / 账号上下文 / 401·403 归类）。
    // 复制一份构造逻辑到别的文件才是真风险 —— 两处迟早漂移。`internal` 不越出
    // BelieveBoyKit 模块，UI 层看到的公开面不变。
    let baseURL: URL
    let apiKey: String?
    /// 账号上下文（`X-Operator` / `X-User-Id` / `X-Is-Admin`）。`nil` = 无账号档案。
    let userContext: UserContext?
    let session: URLSession
    let decoder: JSONDecoder
    let encoder: JSONEncoder

    public init(
        baseURL: URL,
        apiKey: String?,
        userContext: UserContext? = nil,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.userContext = userContext
        self.session = session
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        self.decoder = decoder
        self.encoder = JSONEncoder()
    }

    public init(config: AppConfig, userContext: UserContext? = nil, session: URLSession = .shared) {
        self.init(
            baseURL: config.baseURL,
            apiKey: config.apiKey,
            userContext: userContext,
            session: session
        )
    }

    /// 由一次会话构造客户端：凭据与账号上下文都来自它，避免二者被分别传错。
    public init(config: AppConfig, authSession: AuthSession, session: URLSession = .shared) {
        self.init(
            baseURL: config.baseURL,
            apiKey: authSession.apiKey,
            userContext: authSession.user.map(UserContext.from),
            session: session
        )
    }

    /// 该客户端是否带凭据（UI 据此提前拦截，避免无谓的 401 往返）。
    public var hasCredential: Bool { apiKey != nil }

    /// 发起 GET 并解码为 `T`。
    ///
    /// - Parameters:
    ///   - path: API 相对路径，如 `/health`；`/api/v1` 前缀自动拼接。
    ///   - query: 查询参数，仅非空时附加。
    ///   - tier: 超时分层。
    ///   - authenticated: 是否附加 `X-API-Key`。免鉴权探针（`/health/live`）传 `false`。
    public func get<T: Decodable & Sendable>(
        _ path: String,
        query: [String: String] = [:],
        tier: RequestTier = .list,
        authenticated: Bool = true
    ) async throws -> T {
        let request = try makeRequest(
            method: "GET",
            path: path,
            query: query,
            body: nil,
            tier: tier,
            authenticated: authenticated
        )
        return try await send(request)
    }

    /// 发起 POST（JSON 请求体）并解码为 `T`。
    ///
    /// - Parameters:
    ///   - path: API 相对路径，如 `/auth/login`。
    ///   - body: `Encodable` 请求体，用 `JSONEncoder` 编码（键名按模型原样发送）。
    ///   - tier: 超时分层。登录要等密码哈希校验 + 建会话，`.detail`(10s) 比列表档合理。
    ///   - authenticated: 是否附加 `X-API-Key`。登录必须传 `false` —— 此刻还没有 key。
    public func post<Body: Encodable & Sendable, T: Decodable & Sendable>(
        _ path: String,
        body: Body,
        tier: RequestTier = .detail,
        authenticated: Bool = true
    ) async throws -> T {
        let payload: Data
        do {
            payload = try encoder.encode(body)
        } catch {
            throw APIError.decoding("请求体编码失败：\(error.localizedDescription)")
        }
        let request = try makeRequest(
            method: "POST",
            path: path,
            query: [:],
            body: payload,
            tier: tier,
            authenticated: authenticated
        )
        return try await send(request)
    }

    /// 仅取状态码与响应体，不解码 —— 用于连通性/契约诊断。
    public func status(
        _ path: String,
        tier: RequestTier = .list,
        authenticated: Bool = true
    ) async throws -> (status: Int, body: String) {
        let request = try makeRequest(
            method: "GET",
            path: path,
            query: [:],
            body: nil,
            tier: tier,
            authenticated: authenticated
        )
        let (data, response) = try await transport(request)
        let http = try httpResponse(response, data: data)
        return (http.statusCode, String(data: data, encoding: .utf8) ?? "")
    }

    // MARK: - 内部

    func makeRequest(
        method: String,
        path: String,
        query: [String: String],
        body: Data?,
        tier: RequestTier,
        authenticated: Bool
    ) throws -> URLRequest {
        let url = try Self.url(baseURL: baseURL, path: path, query: query)

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // 无论该档是否设限都显式写一次：不写不会「无超时」，只会拿到 Foundation 的
        // 60s 默认值。
        request.timeoutInterval = tier.timeout ?? RequestTier.unboundedTimeout
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        if authenticated {
            guard let apiKey, let trimmed = apiKey.trimmedNonEmpty else {
                throw APIError.missingCredential
            }
            request.setValue(trimmed, forHTTPHeaderField: "X-API-Key")
            // 账号上下文只在已鉴权请求上发：它描述「以谁的身份」，而登录请求本身
            // 还没有身份可言（此时 userContext 也必然是 nil）。
            for (field, value) in userContext?.headers ?? [:] {
                request.setValue(value, forHTTPHeaderField: field)
            }
        }
        return request
    }

    /// 拼接最终请求 URL。
    ///
    /// `baseURL` 必须是**根地址**（无路径前缀、无 query、无 fragment）。带路径前缀时
    /// `baseURL + "/api/v1"` 有歧义 —— `https://proxy.example.com/api/` 会拼成
    /// `/api/api/v1/...`，而客户端无法判断用户是要让该前缀生效、还是已经在地址里带了
    /// API 段。故显式拒绝（`APIError.invalidBaseURL`），而不是静默拼出一个永远 404 的地址。
    static func url(baseURL: URL, path: String, query: [String: String]) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidBaseURL(baseURL.absoluteString)
        }
        guard components.path.isEmpty || components.path == "/",
              components.query == nil, components.fragment == nil
        else {
            throw APIError.invalidBaseURL(baseURL.absoluteString)
        }

        let normalized = path.hasPrefix("/") ? path : "/" + path
        components.path = Self.apiPrefix + normalized
        if !query.isEmpty {
            components.queryItems = query
                .sorted { $0.key < $1.key }
                .map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else {
            throw APIError.invalidURL(path)
        }
        return url
    }

    func send<T: Decodable & Sendable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await transport(request)
        let http = try httpResponse(response, data: data)
        guard (200..<300).contains(http.statusCode) else {
            throw Self.statusError(http.statusCode, data: data)
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(Self.describe(error))
        }
    }

    func transport(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch let error as URLError {
            throw APIError.transport(Self.describe(error))
        } catch {
            throw APIError.transport(Self.describe(error))
        }
    }

    func httpResponse(_ response: URLResponse, data: Data) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("响应不是 HTTP 响应")
        }
        return http
    }

    static func statusError(_ status: Int, data: Data) -> APIError {
        let body = String(data: data, encoding: .utf8) ?? ""
        if status == 401 || status == 403 {
            return .unauthorized(status: status, body: body)
        }
        return .http(status: status, body: body)
    }

    static func describe(_ error: Error) -> String {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .timedOut: return "请求超时（\(urlError.code.rawValue)）"
            case .cannotConnectToHost: return "无法连接到主机"
            case .cannotFindHost: return "无法解析主机名"
            case .notConnectedToInternet: return "网络未连接"
            case .secureConnectionFailed, .serverCertificateUntrusted:
                return "TLS 校验失败"
            default: return urlError.localizedDescription
            }
        }
        if let decodingError = error as? DecodingError {
            switch decodingError {
            case .keyNotFound(let key, _): return "缺少字段 \(key.stringValue)"
            case .typeMismatch(let type, let context):
                return "字段类型不匹配（期望 \(type)，路径 \(context.codingPath.map(\.stringValue).joined(separator: "."))）"
            case .valueNotFound(let type, let context):
                return "字段值为 null（期望 \(type)，路径 \(context.codingPath.map(\.stringValue).joined(separator: "."))）"
            case .dataCorrupted(let context):
                return "数据损坏（\(context.debugDescription)）"
            @unknown default: return decodingError.localizedDescription
            }
        }
        return error.localizedDescription
    }
}
