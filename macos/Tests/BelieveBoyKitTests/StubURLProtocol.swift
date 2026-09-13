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
        var path: String
        var apiKey: String?
    }

    nonisolated(unsafe) static var responder: (@Sendable (URLRequest) -> Response)?
    nonisolated(unsafe) static var log: [RequestLog] = []

    /// 重置桩件状态，返回打桩后的 session。
    ///
    /// 未登记的路径直接 `XCTFail` —— 避免测试静默打到真实网络。
    static func session(routes: [String: Response]) -> URLSession {
        responder = { request in
            let path = request.url?.path ?? ""
            guard let response = routes[path] else {
                XCTFail("未登记的请求路径：\(path)")
                return Response(status: 500, body: "stub: unregistered path \(path)")
            }
            return response
        }
        log = []
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    // MARK: - URLProtocol

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.log.append(
            RequestLog(
                path: request.url?.path ?? "",
                apiKey: request.value(forHTTPHeaderField: "X-API-Key")
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
}
