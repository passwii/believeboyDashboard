import Foundation
import XCTest

/// 拦截所有请求的 URLProtocol 桩件 —— 测试离线运行，不碰真实后端。
///
/// 静态状态不加锁：XCTest 在同一进程内串行执行同一 suite 的用例，每个用例在发起
/// 请求前重设 `responder` 并清空 `log`（`swift test --parallel` 按 suite 分进程）。
final class StubURLProtocol: URLProtocol {
    struct Response: Sendable {
        var status: Int
        var body: String
        /// 分片响应体（SSE / 下载用）：每项各触发一次 `didLoad`，消费者可逐片处理。
        /// 为空时整份 `body` 一次性交付。
        var chunks: [String] = []
        /// 响应头（默认加 `Content-Type: application/json`）。
        var headers: [String: String] = [:]
        /// 交付完分片后**不结束**连接（长连接 SSEM 用：只有取消才结束）。
        var holdsOpen: Bool = false
        /// 相邻分片之间的延迟（秒）；让"逐块消费 / 中途取消"可被真实观察到。
        var chunkDelay: TimeInterval = 0
        /// 传输层失败（DNS / 连接被拒 / 超时）。设置后直接 `didFailWithError`。
        var failure: URLError?

        static func json(_ status: Int, _ body: String) -> Response {
            Response(status: status, body: body)
        }

        /// 分片流式响应（`text/event-stream` 或文件下载）。
        static func stream(
            _ status: Int = 200,
            chunks: [String],
            contentType: String = "text/event-stream",
            headers: [String: String] = [:],
            holdsOpen: Bool = false,
            chunkDelay: TimeInterval = 0
        ) -> Response {
            Response(
                status: status,
                body: "",
                chunks: chunks,
                headers: headers.merging(["Content-Type": contentType]) { current, _ in current },
                holdsOpen: holdsOpen,
                chunkDelay: chunkDelay
            )
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

        /// 请求体解成任意 JSON 对象（嵌套结构用）。
        var jsonObject: [String: Any]? {
            guard let body, let data = body.data(using: .utf8) else { return nil }
            return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        }
    }

    nonisolated(unsafe) static var responder: (@Sendable (URLRequest) -> Response)?
    nonisolated(unsafe) static var log: [RequestLog] = []
    /// `stopLoading` 被调用的次数 —— 取消语义的观测点：URLSession 任务被拆掉时，
    /// URLProtocol 会收到 `stopLoading`，这是「没有把连接和 Task 留在后台」的证据。
    nonisolated(unsafe) static var stopLoadingCount = 0
    /// 被中止的请求路径（按中止顺序）。
    nonisolated(unsafe) static var stoppedPaths: [String] = []

    private static let deliveryQueue = DispatchQueue(label: "StubURLProtocol.delivery")
    private let stoppedLock = NSLock()
    private var stopped = false

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
        stopLoadingCount = 0
        stoppedPaths = []
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

        if let failure = response.failure {
            client?.urlProtocol(self, didFailWithError: failure)
            return
        }

        var headerFields = response.headers
        if headerFields["Content-Type"] == nil {
            headerFields["Content-Type"] = "application/json"
        }
        let httpResponse = HTTPURLResponse(
            url: request.url!,
            statusCode: response.status,
            httpVersion: "HTTP/1.1",
            headerFields: headerFields
        )!
        client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)

        let chunks = response.chunks.isEmpty ? [response.body] : response.chunks
        let holdsOpen = response.holdsOpen
        let delay = response.chunkDelay
        // 交付放到后台队列：分片之间可以插入延迟，让「逐块消费」与「中途取消」
        // 成为可观测的事实，而不是"理论上分片了"。
        Self.deliveryQueue.async {
            for chunk in chunks {
                guard !self.isStopped else { return }
                self.client?.urlProtocol(self, didLoad: Data(chunk.utf8))
                if delay > 0 { Thread.sleep(forTimeInterval: delay) }
            }
            guard !holdsOpen, !self.isStopped else { return }
            self.client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {
        stoppedLock.lock()
        let alreadyStopped = stopped
        stopped = true
        stoppedLock.unlock()
        guard !alreadyStopped else { return }
        Self.stopLoadingCount += 1
        Self.stoppedPaths.append(request.url?.path ?? "")
    }

    private var isStopped: Bool {
        stoppedLock.lock()
        defer { stoppedLock.unlock() }
        return stopped
    }

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

// MARK: - 测试工具

/// 线程安全的取值盒子（跨 actor / 回调写、断言里读）。
final class LockedBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ initial: Value) {
        stored = initial
    }

    var value: Value {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func mutate(_ body: (inout Value) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        body(&stored)
    }
}

/// 记录时间序列（轮询等待 / 下载进度）。
final class RecordingSink<Value>: @unchecked Sendable {
    private let box: LockedBox<[Value]>

    init() {
        box = LockedBox([])
    }

    var values: [Value] { box.value }

    func record(_ value: Value) {
        box.mutate { $0.append(value) }
    }
}
