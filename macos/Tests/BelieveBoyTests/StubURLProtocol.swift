import Foundation
import XCTest

/// 拦截所有请求的 URLProtocol 桩件 —— 测试离线运行，不碰真实后端。
///
/// 静态状态不加锁：XCTest 在同一进程内串行执行同一 suite 的用例，每个用例在发起
/// 请求前重设 `responder` 并清空 `log`（`swift test --parallel` 按 suite 分进程，
/// 本文件只有一个 suite）。
final class StubURLProtocol: URLProtocol {
    struct Response: Sendable {
        var status: Int
        var body: String

        static func json(_ status: Int, _ body: String) -> Response {
            Response(status: status, body: body)
        }
    }

    struct RequestLog: Sendable {
        var method: String
        var path: String
        /// `X-API-Key`（未携带为 nil）。
        var apiKey: String?
        /// 账号上下文三项（`X-Operator` / `X-User-Id` / `X-Is-Admin`）等的原样值。
        var headers: [String: String]
        /// 请求体文本。`URLSession` 会把 `httpBody` 转成流再交给 `URLProtocol`，
        /// 故两处都要读（见 `Self.body(of:)`）。
        var body: String?
        /// 实际交给 URL 加载系统的超时 —— 断言超时策略看这里，不看常量表。
        var timeout: TimeInterval

        func header(_ name: String) -> String? { headers[name] }

        /// 请求体解成 JSON 对象。
        ///
        /// 返回 `[String: String]` 而不是 `[String: Any]`：测试里要断言的是
        /// `email` / `password` 这类文本字段，返回 `Any` 会把每个断言变成
        /// `jsonBody?["k"] as? String`，在泛型 `XCTAssertEqual` 里容易把类型检查器
        /// 搞崩（实测报 “failed to produce diagnostic for expression”）。
        var jsonBody: [String: String]? {
            guard let body, let data = body.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return nil }
            return object.compactMapValues { $0 as? String }
        }
    }

    nonisolated(unsafe) static var responder: (@Sendable (URLRequest) -> Response)?
    nonisolated(unsafe) static var log: [RequestLog] = []

    /// 按路径登记固定响应。未登记的路径直接 `XCTFail` —— 避免测试静默打到真实网络。
    static func session(routes: [String: Response]) -> URLSession {
        session { request in
            let path = request.url?.path ?? ""
            guard let response = routes[path] else {
                XCTFail("未登记的请求路径：\(path)")
                return Response(status: 500, body: "stub: unregistered path \(path)")
            }
            return response
        }
    }

    /// 按请求内容决定响应，用于需要「第 N 次调用返回不同结果」的用例
    /// （如凭据被轮换：首次探测 403，重新登录后同端点 200）。
    static func session(handler: @escaping @Sendable (URLRequest) -> Response) -> URLSession {
        responder = handler
        log = []
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    /// 已记录请求的路径序列（断言「没有多余重试」看它）。
    static var loggedPaths: [String] { log.map(\.path) }

    /// 已记录请求中匹配某路径的次数。
    static func callCount(_ path: String) -> Int {
        log.filter { $0.path == path }.count
    }

    // MARK: - URLProtocol

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.log.append(
            RequestLog(
                method: request.httpMethod ?? "",
                path: request.url?.path ?? "",
                apiKey: request.value(forHTTPHeaderField: "X-API-Key"),
                headers: request.allHTTPHeaderFields ?? [:],
                body: Self.body(of: request),
                timeout: request.timeoutInterval
            )
        )
        guard let responder = Self.responder else {
            XCTFail("桩件未设置 responder")
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let response = responder(request)
        let httpResponse = HTTPURLResponse(
            url: request.url!,
            statusCode: response.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(response.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    /// 读取请求体：`URLSession` 会在交给 `URLProtocol` 之前把 `httpBody` 折叠成
    /// `httpBodyStream`，只读 `httpBody` 会得到 nil，POST 断言就会变成空断言。
    private static func body(of request: URLRequest) -> String? {
        if let data = request.httpBody {
            return String(data: data, encoding: .utf8)
        }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return String(data: data, encoding: .utf8)
    }
}
