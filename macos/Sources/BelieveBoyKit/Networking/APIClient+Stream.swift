import Foundation

/// 服务端推送（SSE）消费端。
///
/// 5 个后端家族用 `text/event-stream`（AI 对话 / 洞察 / CRM / 数字办公 / 洞察 run），
/// 它们的共同点是「一条连接上持续吐事件」：普通 `data(for:)` 会等连接关闭才返回，
/// 在 SSE 上等于永不返回。所以这里走 `URLSession.bytes(for:)`，逐帧产出。
///
/// 三条硬约束及其落点：
/// 1. **不设超时**：走 `.stream` 档（S2 定的 `RequestTier.unboundedTimeout`）——
///    SSE 的数据间隙可以远超 60s，用默认档会在间隙处被 `timeoutInterval` 掐断。
/// 2. **逐块消费**：`AsyncThrowingStream` 每收到一个完整帧就 `yield`，调用方
///    `for try await` 能立刻拿到，不必等整条流结束。
/// 3. **可取消且不留 Task**：取消消费方（或外部取消）→ 内部 `Task` 被取消 →
///    `bytes(for:)` 迭代退出 → URLSession 任务被拆掉（`onTermination` 里显式
///    `task.cancel()`，不依赖 `AsyncThrowingStream` 被释放的时机）。
public extension APIClient {

    /// 打开一条 SSE 连接。
    ///
    /// 不是 `async throws`：请求构造失败（`invalidBaseURL` / `missingCredential`）
    /// 与连接失败都以「流的第一个错误」形式出现，调用方只需 `for try await` 一处
    /// 处理 —— 否则每个调用点都要先 `try await` 再 `try await` 循环体，多一层缩进
    /// 却不增加信息量。
    ///
    /// - Parameters:
    ///   - path: API 相对路径，如 `/insight/runs/<id>/stream`。
    ///   - query: 查询参数。
    ///   - lastEventID: 断线续传游标（写 `Last-Event-ID` 头；后端
    ///     `insight_runs.py` 用它从断点继续，而不是从头重放）。
    ///   - tier: 默认 `.stream`；显式暴露以便个别端点需要有限超时。
    ///   - authenticated: 是否带凭据。
    func stream(
        _ path: String,
        query: [String: String] = [:],
        lastEventID: String? = nil,
        tier: RequestTier = .stream,
        authenticated: Bool = true
    ) -> AsyncThrowingStream<ServerSentEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = try makeRequest(
                        method: "GET",
                        path: path,
                        query: query,
                        body: nil,
                        tier: tier,
                        authenticated: authenticated
                    )
                    // Accept 与 Web 端代理的流式识别口径一致
                    // （`backend-proxy-timeout-policy.ts` 认 `text/event-stream`）。
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
                    if let lastEventID = lastEventID?.trimmedNonEmpty {
                        request.setValue(lastEventID, forHTTPHeaderField: "Last-Event-ID")
                    }

                    let (bytes, response) = try await session.bytes(for: request)
                    let http = try httpResponse(response, data: Data())
                    guard (200..<300).contains(http.statusCode) else {
                        throw Self.statusError(http.statusCode, data: try await Self.drain(bytes, limit: 4096))
                    }

                    var parser = SSEFrameParser()
                    var lineBuffer = Data()
                    lineBuffer.reserveCapacity(512)
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        lineBuffer.append(byte)
                        // 按行喂解析器：一帧可能跨多个网络分片，也可能一个分片里有多帧，
                        // 解析器自己处理这两种情况，这里只负责切行。
                        if byte == 0x0A {
                            for event in parser.feed(lineBuffer) {
                                continuation.yield(event)
                            }
                            lineBuffer.removeAll(keepingCapacity: true)
                        }
                    }
                    for event in parser.finish() {
                        continuation.yield(event)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    // 取消不是错误：调用方主动收手（切模块 / 关视图）时不该看到红色错误。
                    continuation.finish()
                } catch let error as APIError {
                    continuation.finish(throwing: error)
                } catch {
                    continuation.finish(throwing: APIError.transport(Self.describe(error)))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// 读出错响应体（有上限）—— 非 2xx 时不带 body 的报错对排查毫无帮助
    /// （后端 403 的 `{"detail":"Invalid API key"}` 正是重登判断的依据）。
    private static func drain(_ bytes: URLSession.AsyncBytes, limit: Int) async throws -> Data {
        var data = Data()
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count >= limit { break }
            }
        } catch {
            // 读错误体失败不该覆盖原始的状态码错误。
            return data
        }
        return data
    }
}
