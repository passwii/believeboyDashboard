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

    public var timeout: TimeInterval {
        switch self {
        case .stream: return 0
        case .report: return 60
        case .ai: return 30
        case .stats: return 15
        case .detail: return 10
        case .list: return 5
        }
    }
}

/// 后端 HTTP 客户端。值语义、无可变共享状态，天然 `Sendable`。
public struct APIClient: Sendable {
    /// 后端 API 前缀（`backend/app/main.py` 的 `prefix="/api/v1"`）。
    public static let apiPrefix = "/api/v1"

    private let baseURL: URL
    private let apiKey: String?
    private let session: URLSession
    private let decoder: JSONDecoder

    public init(baseURL: URL, apiKey: String?, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.session = session
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        self.decoder = decoder
    }

    public init(config: AppConfig, session: URLSession = .shared) {
        self.init(baseURL: config.baseURL, apiKey: config.apiKey, session: session)
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
        let request = try makeRequest(path: path, query: query, tier: tier, authenticated: authenticated)
        return try await send(request)
    }

    /// 仅取状态码与响应体，不解码 —— 用于连通性/契约诊断。
    public func status(
        _ path: String,
        tier: RequestTier = .list,
        authenticated: Bool = true
    ) async throws -> (status: Int, body: String) {
        let request = try makeRequest(path: path, query: [:], tier: tier, authenticated: authenticated)
        let (data, response) = try await transport(request)
        let http = try httpResponse(response, data: data)
        return (http.statusCode, String(data: data, encoding: .utf8) ?? "")
    }

    // MARK: - 内部

    private func makeRequest(
        path: String,
        query: [String: String],
        tier: RequestTier,
        authenticated: Bool
    ) throws -> URLRequest {
        let normalized = path.hasPrefix("/") ? path : "/" + path
        let full = Self.apiPrefix + normalized
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidURL(baseURL.absoluteString)
        }
        components.path = (components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path) + full
        if !query.isEmpty {
            components.queryItems = query
                .sorted { $0.key < $1.key }
                .map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else {
            throw APIError.invalidURL(full)
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if tier.timeout > 0 {
            request.timeoutInterval = tier.timeout
        }
        if authenticated {
            guard let apiKey, let trimmed = apiKey.trimmedNonEmpty else {
                throw APIError.missingCredential
            }
            request.setValue(trimmed, forHTTPHeaderField: "X-API-Key")
        }
        return request
    }

    private func send<T: Decodable & Sendable>(_ request: URLRequest) async throws -> T {
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

    private func transport(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch let error as URLError {
            throw APIError.transport(Self.describe(error))
        } catch {
            throw APIError.transport(Self.describe(error))
        }
    }

    private func httpResponse(_ response: URLResponse, data: Data) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("响应不是 HTTP 响应")
        }
        return http
    }

    private static func statusError(_ status: Int, data: Data) -> APIError {
        let body = String(data: data, encoding: .utf8) ?? ""
        if status == 401 || status == 403 {
            return .unauthorized(status: status, body: body)
        }
        return .http(status: status, body: body)
    }

    private static func describe(_ error: Error) -> String {
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
