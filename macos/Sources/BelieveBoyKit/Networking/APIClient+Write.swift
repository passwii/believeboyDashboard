import Foundation

/// HTTP 方法。S1/S2 只用到 GET 与 POST（登录），S5 起每个模块都有写操作。
public enum HTTPMethod: String, Sendable, CaseIterable {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case patch = "PATCH"
    case delete = "DELETE"

    /// 是否允许请求体。GET 带体在部分网关会被直接拒绝，故显式挡掉。
    public var allowsRequestBody: Bool { self != .get }
}

/// JSON 写入：POST / PUT / PATCH / DELETE。
///
/// 与 `post`（登录用的那份）共用同一套请求构造：超时分层、`X-API-Key`、账号上下文、
/// 401/403 → `.unauthorized`。这里补的是「写操作里真正反复用到的四种形状」：
///
/// | 形状 | 方法 |
/// | --- | --- |
/// | 带 JSON 体 + 解响应 | `write(_:_:body:query:tier:authenticated:) -> T` |
/// | 带 JSON 体 + 忽略响应（200 空体 / 204） | `writeIgnoringResponse(_:_:body:...)` |
/// | 无请求体 + 解响应 | `write(_:_:query:tier:authenticated:) -> T` |
/// | 无请求体 + 忽略响应 | `writeIgnoringResponse(_:_:...)` |
///
/// 为什么单独给「忽略响应」一组：后端写端点大量返回 `{"ok": true}` 这类无模型意义的
/// 体（或 204 空体）。逼调用方为每个端点编一个 `struct OkResponse: Decodable` 属于
/// 噪音；而**只用泛型 `T` 覆盖两种形状**又会在 `try await client.write(.delete, path)`
/// 这种不接返回值的调用点上让类型检查器无从推断 `T`（编译期歧义，不是运行时问题）。
/// 拆成两个名字后，每个调用点的意图都是显式的。
public extension APIClient {

    // MARK: - 带请求体

    /// 写入 + JSON 请求体，响应解码为 `T`。
    func write<Body: Encodable & Sendable, T: Decodable & Sendable>(
        _ method: HTTPMethod,
        _ path: String,
        body: Body,
        query: [String: String] = [:],
        tier: RequestTier = .detail,
        authenticated: Bool = true
    ) async throws -> T {
        let request = try encodedRequest(
            method: method,
            path: path,
            body: body,
            query: query,
            tier: tier,
            authenticated: authenticated
        )
        return try await send(request)
    }

    /// 写入 + JSON 请求体，忽略响应体（只看状态码）。
    func writeIgnoringResponse<Body: Encodable & Sendable>(
        _ method: HTTPMethod,
        _ path: String,
        body: Body,
        query: [String: String] = [:],
        tier: RequestTier = .detail,
        authenticated: Bool = true
    ) async throws {
        let request = try encodedRequest(
            method: method,
            path: path,
            body: body,
            query: query,
            tier: tier,
            authenticated: authenticated
        )
        try await sendIgnoringResponse(request)
    }

    // MARK: - 无请求体

    /// 无请求体的写入（如 `DELETE /x/{id}`），响应解码为 `T`。
    func write<T: Decodable & Sendable>(
        _ method: HTTPMethod,
        _ path: String,
        query: [String: String] = [:],
        tier: RequestTier = .detail,
        authenticated: Bool = true
    ) async throws -> T {
        let request = try makeRequest(
            method: method.rawValue,
            path: path,
            query: query,
            body: nil,
            tier: tier,
            authenticated: authenticated
        )
        return try await send(request)
    }

    /// 无请求体的写入，忽略响应体。
    func writeIgnoringResponse(
        _ method: HTTPMethod,
        _ path: String,
        query: [String: String] = [:],
        tier: RequestTier = .detail,
        authenticated: Bool = true
    ) async throws {
        let request = try makeRequest(
            method: method.rawValue,
            path: path,
            query: query,
            body: nil,
            tier: tier,
            authenticated: authenticated
        )
        try await sendIgnoringResponse(request)
    }

    // MARK: - 常用别名（方法名写在调用点上，读起来比 `.write(.put, …)` 直接）

    func put<Body: Encodable & Sendable, T: Decodable & Sendable>(
        _ path: String,
        body: Body,
        tier: RequestTier = .detail,
        authenticated: Bool = true
    ) async throws -> T {
        try await write(.put, path, body: body, tier: tier, authenticated: authenticated)
    }

    func putIgnoringResponse<Body: Encodable & Sendable>(
        _ path: String,
        body: Body,
        tier: RequestTier = .detail,
        authenticated: Bool = true
    ) async throws {
        try await writeIgnoringResponse(.put, path, body: body, tier: tier, authenticated: authenticated)
    }

    func patch<Body: Encodable & Sendable, T: Decodable & Sendable>(
        _ path: String,
        body: Body,
        tier: RequestTier = .detail,
        authenticated: Bool = true
    ) async throws -> T {
        try await write(.patch, path, body: body, tier: tier, authenticated: authenticated)
    }

    func patchIgnoringResponse<Body: Encodable & Sendable>(
        _ path: String,
        body: Body,
        tier: RequestTier = .detail,
        authenticated: Bool = true
    ) async throws {
        try await writeIgnoringResponse(.patch, path, body: body, tier: tier, authenticated: authenticated)
    }

    func delete<T: Decodable & Sendable>(
        _ path: String,
        tier: RequestTier = .detail,
        authenticated: Bool = true
    ) async throws -> T {
        try await write(.delete, path, tier: tier, authenticated: authenticated)
    }

    func deleteIgnoringResponse(
        _ path: String,
        tier: RequestTier = .detail,
        authenticated: Bool = true
    ) async throws {
        try await writeIgnoringResponse(.delete, path, tier: tier, authenticated: authenticated)
    }

    // MARK: - 内部

    /// 编码请求体并造请求。编码失败归 `.decoding`（沿用既有分类：这是「本地数据
    /// 与目标形状不匹配」，不是网络问题）。
    func encodedRequest<Body: Encodable & Sendable>(
        method: HTTPMethod,
        path: String,
        body: Body,
        query: [String: String],
        tier: RequestTier,
        authenticated: Bool
    ) throws -> URLRequest {
        guard method.allowsRequestBody else {
            throw APIError.invalidURL("\(method.rawValue) 不允许请求体")
        }
        let payload: Data
        do {
            payload = try encoder.encode(body)
        } catch {
            throw APIError.decoding("请求体编码失败：\(error.localizedDescription)")
        }
        return try makeRequest(
            method: method.rawValue,
            path: path,
            query: query,
            body: payload,
            tier: tier,
            authenticated: authenticated
        )
    }

    /// 发出请求、只校验状态码，不碰响应体。
    ///
    /// 2xx 一律成功（含 204 空体与 200 空体）；非 2xx 走与 `send` 相同的分类，
    /// 因此 401/403 仍是 `.unauthorized`（`requiresCredentialFix == true`）。
    func sendIgnoringResponse(_ request: URLRequest) async throws {
        let (data, response) = try await transport(request)
        let http = try httpResponse(response, data: data)
        guard (200..<300).contains(http.statusCode) else {
            throw Self.statusError(http.statusCode, data: data)
        }
    }
}
