import BelieveBoyKit
import Foundation
import XCTest

/// `AIChatClient` 的请求形状：12 条端点的路径 / 方法 / 分层超时，以及 **POST-SSE** 的真实
/// 请求属性（方法、JSON body、`Accept`、续传时的 `Last-Event-ID` + body）。
///
/// 为什么这一层必须断言「真实请求属性」：本批唯一的传输形态扩展就是「POST + body + SSE」
/// （S5.0 的 `stream()` 原本写死 GET + 无体）。只看常量表或调用点代码，证明不了请求真的
/// 是这样发出去的 —— 而 POST-SSE 发错的两种形态（GET 无体 / POST 丢 body）在后端分别是
/// **从头重放**与 **422**，都不会立刻报错。断言取打桩记录里的实际值。
final class AIChatClientTests: XCTestCase {
    private let baseURL = URL(string: "https://backend.test")!

    private func makeClient(
        routes: [String: StubURLProtocol.Response]
    ) -> (AIChatClient, URLCapture) {
        let capture = URLCapture()
        let session = StubURLProtocol.session { request in
            capture.append(request.url)
            let path = request.url?.path ?? ""
            return routes[path] ?? .json(500, #"{"detail":"stub: unregistered path \#(path)"}"#)
        }
        return (makeClient(session: session), capture)
    }

    private func makeClient(session: URLSession) -> AIChatClient {
        let api = APIClient(
            baseURL: baseURL,
            apiKey: "blf_TEST",
            userContext: UserContext(operatorName: "测试员", userId: "user-1", isAdmin: true),
            session: session
        )
        return AIChatClient(client: api)
    }

    private static let conversationBody = #"""
    {"id": 7, "title": "新对话", "created_at": "2026-09-14T10:00:00+08:00",
     "updated_at": "2026-09-14T10:00:00+08:00", "total_prompt_tokens": 0,
     "total_completion_tokens": 0, "total_tokens": 0}
    """#

    private static let messageBody = #"""
    {"id": 11, "conversation_id": 7, "role": "user", "content": "编辑后",
     "search_sources": [], "search_time_range": null, "is_complete": true,
     "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
     "duration_ms": null, "created_at": "2026-09-14T10:00:00+08:00"}
    """#

    private func sendPayload(
        client: AIChatClient,
        lastEventID: String? = nil
    ) async throws -> [AIChatStreamFrame] {
        var frames: [AIChatStreamFrame] = []
        for try await frame in client.send(
            conversationID: 7,
            payload: AIChatSendPayload(
                content: "你好",
                model: "gpt-test",
                systemPrompt: "你是助手。",
                reasoningEffort: "high",
                enableWebSearch: true,
                attachedFileContent: "附件正文",
                attachedFileName: "a.csv"
            ),
            lastEventID: lastEventID
        ) {
            frames.append(frame)
        }
        return frames
    }

    // MARK: - 12 条端点的路径与方法

    /// 本批 12 条端点一条不少、一条不多 —— 路径写错一个字符就是 404。
    func testAllTwelveEndpointsUseTheirOwnPathsAndMethods() async throws {
        // 按 `方法 + 路径` 分派：`/ai/conversations` 的 GET（数组）与 POST（对象）响应形状不同，
        // 只按路径登记的路由表在这里不够用。
        let capture = URLCapture()
        let session = StubURLProtocol.session { request in
            let path = request.url?.path ?? ""
            let method = request.httpMethod ?? ""
            capture.append(request.url)
            switch (method, path) {
            case ("GET", "/api/v1/ai/config"):
                return .json(200, #"{"provider_configured": false, "web_search_configured": false, "models": [], "default_model": "", "premium_models": [], "basic_models": [], "reasoning_models": [], "default_reasoning_effort": "medium", "timeout_seconds": 90, "max_conversation_turns": 10, "web_search_max_results": 5}"#)
            case ("GET", "/api/v1/ai/conversations"):
                return .json(200, "[\(Self.conversationBody)]")
            case ("POST", "/api/v1/ai/conversations"):
                return .json(200, Self.conversationBody)
            case ("PATCH", "/api/v1/ai/conversations/7"):
                return .json(200, Self.conversationBody)
            case ("DELETE", "/api/v1/ai/conversations/7"):
                return .json(204, "")
            case ("GET", "/api/v1/ai/conversations/7/messages"):
                return .json(200, "[\(Self.messageBody)]")
            case ("PATCH", "/api/v1/ai/conversations/7/messages/11"):
                return .json(200, Self.messageBody)
            case ("DELETE", "/api/v1/ai/conversations/7/messages/11"):
                return .json(204, "")
            case ("POST", "/api/v1/ai/conversations/7/cancel"):
                return .json(200, #"{"cancelled": true}"#)
            case ("GET", "/api/v1/ai/usage/stats"):
                return .json(200, Self.usageBody)
            default:
                XCTFail("未登记的请求：\(method) \(path)")
                return .json(500, #"{"detail":"stub: unregistered"}"#)
            }
        }
        let client = makeClient(session: session)

        // 逐条带标签地跑：一条失败时能直接看到是哪个端点（泛型解码错误本身不带端点名）。
        await probeAll(client: client)

        XCTAssertEqual(
            StubURLProtocol.log.map { "\($0.method) \($0.path)" },
            [
                "GET /api/v1/ai/config",
                "GET /api/v1/ai/conversations",
                "POST /api/v1/ai/conversations",
                "PATCH /api/v1/ai/conversations/7",
                "GET /api/v1/ai/conversations/7/messages",
                "PATCH /api/v1/ai/conversations/7/messages/11",
                "POST /api/v1/ai/conversations/7/cancel",
                "GET /api/v1/ai/usage/stats",
                "DELETE /api/v1/ai/conversations/7",
                "DELETE /api/v1/ai/conversations/7/messages/11",
            ]
        )
        XCTAssertEqual(capture.query(forPath: "/api/v1/ai/usage/stats"), "range=7d")
    }

    /// 依次打 10 条端点，失败时报出是哪一条。
    private func probeAll(client: AIChatClient) async {
        func probe(_ label: String, _ operation: () async throws -> Void) async {
            do {
                try await operation()
            } catch {
                XCTFail("\(label) 失败：\(error)")
            }
        }
        await probe("1 config") { _ = try await client.config() }
        await probe("2 conversations") { _ = try await client.conversations() }
        await probe("3 create") { _ = try await client.createConversation(title: "新对话") }
        await probe("4 rename") { _ = try await client.renameConversation(id: 7, title: "改名") }
        await probe("6 messages") { _ = try await client.messages(conversationID: 7) }
        await probe("7 edit") {
            _ = try await client.editMessage(conversationID: 7, messageID: 11, content: "编辑后")
        }
        await probe("10 cancel") { _ = try await client.cancel(conversationID: 7) }
        await probe("12 usage") { _ = try await client.usageStats(range: .sevenDays) }
        await probe("5 delete conversation") { try await client.deleteConversation(id: 7) }
        await probe("8 delete message") {
            try await client.deleteMessage(conversationID: 7, messageID: 11)
        }
    }

    /// 写请求体：新建 / 重命名只带 `title`；取消带空 `{}` —— 后端三个端点各自的契约。
    func testWriteBodiesMatchBackendContracts() async throws {
        let (client, _) = try makeClient(routes: [
            "/api/v1/ai/conversations": .json(200, Self.conversationBody),
            "/api/v1/ai/conversations/7": .json(200, Self.conversationBody),
            "/api/v1/ai/conversations/7/cancel": .json(200, #"{"cancelled": false}"#),
            "/api/v1/ai/conversations/7/messages/11": .json(200, Self.messageBody),
        ])

        _ = try await client.createConversation(title: nil)
        _ = try await client.renameConversation(id: 7, title: "新标题")
        let cancelled = try await client.cancel(conversationID: 7)
        XCTAssertFalse(cancelled.cancelled, "`cancelled: false` 是合法响应（那一刻没有在跑的流）")
        _ = try await client.editMessage(conversationID: 7, messageID: 11, content: "编辑后")

        let bodies = StubURLProtocol.log.map(\.body)
        // `String?` 的 nil 由合成编码器走 `encodeIfPresent` → 键**整个省略**（不是 `null`）：
        // 后端 `ConversationCreate(title: str | None = None)` 两种都收，但断言要写实际形态。
        XCTAssertEqual(bodies[0], "{}")
        XCTAssertEqual(bodies[1], #"{"title":"新标题"}"#)
        XCTAssertEqual(bodies[2], "{}", "取消端点没有 body 字段：发空对象")
        XCTAssertEqual(bodies[3], #"{"content":"编辑后"}"#)
        for log in StubURLProtocol.log {
            XCTAssertEqual(log.header("Content-Type"), "application/json")
        }
    }

    // MARK: - POST-SSE（端点 9）

    /// **本批最核心的一条**：流式请求真的是 `POST + JSON body + Accept: text/event-stream`。
    func testStreamRequestIsPostWithJSONBodyAndEventStreamAccept() async throws {
        let (client, capture) = try makeClient(routes: [
            "/api/v1/ai/conversations/7/messages/stream": .stream(
                200,
                chunks: [
                    "id: 1-0\ndata: {\"type\":\"message_start\",\"message_id\":\"m1\",\"model\":\"capture\"}\n\n",
                    "id: 1-1\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"你\"}}\n\n",
                    "data: {\"type\":\"message_stop\"}\n\n",
                ]
            ),
        ])

        let frames = try await sendPayload(client: client)

        XCTAssertEqual(
            capture.urls.map(\.path),
            ["/api/v1/ai/conversations/7/messages/stream"]
        )
        let log = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertEqual(log.method, "POST", "会话消息**只有** POST 一条路（无流式发送的 GET 端点）")
        XCTAssertEqual(log.header("Accept"), "text/event-stream")
        XCTAssertEqual(log.header("Content-Type"), "application/json")
        XCTAssertEqual(log.header("Cache-Control"), "no-cache")
        XCTAssertNil(log.header("Last-Event-ID"), "首次请求不带游标")
        XCTAssertEqual(log.timeout, RequestTier.unboundedTimeout, "流式走 `.stream` 档（无超时）")
        XCTAssertEqual(log.apiKey, "blf_TEST")
        XCTAssertEqual(log.header("X-User-Id"), "user-1", "会话归属按 X-User-Id")

        // body 是 `MessageCreate`：字段名照后端 Pydantic（snake_case），空格串按「不发」处理。
        let body = try XCTUnwrap(log.jsonObject)
        XCTAssertEqual(body["content"] as? String, "你好")
        XCTAssertEqual(body["model"] as? String, "gpt-test")
        XCTAssertEqual(body["system_prompt"] as? String, "你是助手。")
        XCTAssertEqual(body["reasoning_effort"] as? String, "high")
        XCTAssertEqual(body["enable_web_search"] as? Bool, true)
        XCTAssertEqual(body["attached_file_content"] as? String, "附件正文")
        XCTAssertEqual(body["attached_file_name"] as? String, "a.csv")
        XCTAssertEqual(body["regenerate"] as? Bool, false)
        XCTAssertNil(body["target_message_id"], "非 regenerate 时不发目标消息 id")

        XCTAssertEqual(frames.map(\.event.kind), ["message_start", "content_block_delta", "message_stop"])
        XCTAssertEqual(frames.map(\.eventID), ["1-0", "1-1", nil], "游标随帧带出来（done 事件没有 id）")
    }

    /// 续传：**同一个 POST、同一份 body**，只多一个 `Last-Event-ID` 头。
    func testResumeRequestKeepsBodyAndAddsLastEventIDHeader() async throws {
        let (client, capture) = try makeClient(routes: [
            "/api/v1/ai/conversations/7/messages/stream": .stream(
                200,
                chunks: [
                    "id: 2-5\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"续\"}}\n\n",
                    "data: {\"type\":\"message_stop\"}\n\n",
                ]
            ),
        ])

        let frames = try await sendPayload(client: client, lastEventID: "2-4")

        XCTAssertEqual(capture.urls.map(\.path).count, 1)
        let log = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertEqual(log.method, "POST")
        XCTAssertEqual(log.header("Last-Event-ID"), "2-4", "续传靠游标，而不是重拉全量")
        let body = try XCTUnwrap(log.jsonObject)
        XCTAssertEqual(body["content"] as? String, "你好", "续传必须重发 body（`payload` 是必填）")
        XCTAssertEqual(frames.first?.eventID, "2-5")
    }

    /// 空白游标不写头（`trimmedNonEmpty`）—— 免得发一个空的 `Last-Event-ID` 让后端从头重放。
    func testBlankCursorIsNotSent() async throws {
        let (client, _) = try makeClient(routes: [
            "/api/v1/ai/conversations/7/messages/stream": .stream(
                200,
                chunks: ["data: {\"type\":\"message_stop\"}\n\n"]
            ),
        ])

        _ = try await sendPayload(client: client, lastEventID: "   ")
        XCTAssertNil(StubURLProtocol.log.first?.header("Last-Event-ID"))
    }

    /// 非 2xx 的流请求：错误分类沿用 `APIError`（401/403 → 需修凭据），并把后端 detail 带出来。
    func testStreamErrorStatusMapsToAPIError() async throws {
        let (client, _) = try makeClient(routes: [
            "/api/v1/ai/conversations/7/messages/stream": .json(403, #"{"detail":"Invalid API key"}"#),
        ])

        do {
            _ = try await sendPayload(client: client)
            XCTFail("403 应当抛错")
        } catch let error as APIError {
            XCTAssertTrue(error.requiresCredentialFix, "实际错误：\(error)")
            guard case .unauthorized(let status, let body) = error else {
                return XCTFail("应当是 unauthorized，实际 \(error)")
            }
            XCTAssertEqual(status, 403)
            XCTAssertTrue(body.contains("Invalid API key"), "后端 detail 要带出来：\(body)")
        }
    }

    /// 后端 `error` 事件不会让流抛错 —— 它以**领域事件**交付，由状态机决定怎么呈现
    /// （抛错会丢掉「已经收到的正文」）。
    func testBackendErrorEventIsDeliveredNotThrown() async throws {
        let (client, _) = try makeClient(routes: [
            "/api/v1/ai/conversations/7/messages/stream": .stream(
                200,
                chunks: ["data: {\"type\":\"error\",\"error\":{\"code\":\"overloaded\",\"message\":\"忙\"}}\n\n"]
            ),
        ])

        let frames = try await sendPayload(client: client)
        XCTAssertEqual(frames.map(\.event.kind), ["error"])
    }

    // MARK: - 附件上传（端点 11）

    /// multipart：字段名 `file`、中文文件名双形态、显式 `Content-Length`、走写档（60s）。
    func testUploadRequestIsMultipartWithFileField() async throws {
        let (client, _) = try makeClient(routes: [
            "/api/v1/ai/upload": .json(
                200,
                #"{"file_name":"报表.csv","file_type":"csv","content":"a,b","truncated":false,"truncated_note":null}"#
            ),
        ])

        let temporary = FileManager.default.temporaryDirectory
            .appendingPathComponent("blf1065-\(UUID().uuidString)-报表.csv")
        try "a,b\n1,2\n".write(to: temporary, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: temporary) }

        let response = try await client.upload(
            fileURL: temporary,
            filename: "报表.csv",
            mimeType: "text/csv"
        )

        XCTAssertEqual(response.fileName, "报表.csv")
        XCTAssertEqual(response.content, "a,b")
        XCTAssertFalse(response.truncated)

        let log = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertEqual(log.method, "POST")
        XCTAssertEqual(log.path, "/api/v1/ai/upload")
        XCTAssertTrue(
            (log.header("Content-Type") ?? "").hasPrefix("multipart/form-data; boundary="),
            "实际 Content-Type：\(log.header("Content-Type") ?? "nil")"
        )
        XCTAssertNotNil(log.header("Content-Length"), "上传体显式带 Content-Length（不走 chunked）")
        let body = try XCTUnwrap(log.body)
        XCTAssertTrue(body.contains("name=\"file\""), "字段名必须是 `file`（后端 `File(...)`）")
        XCTAssertTrue(body.contains("报表.csv"), "文件名原样进 body（中文文件名）")
        XCTAssertTrue(body.contains("1,2"), "文件内容在最后一段")
        XCTAssertEqual(log.timeout, RequestTier.report.timeout, "附件上传走写档（60s）")
    }

    // MARK: - 分层超时

    /// 元数据 9 条走列表档（5s，对齐 Web 代理的 `backendFetchJson` 默认 5_000）；
    /// 用量走统计档（15s）。断言的是**实际写进 URLRequest 的值**。
    func testMetadataCallsUseListTierAndUsageUsesStatsTier() async throws {
        let (client, _) = try makeClient(routes: [
            "/api/v1/ai/config": .json(200, #"{"provider_configured": false, "web_search_configured": false, "models": [], "default_model": "", "premium_models": [], "basic_models": [], "reasoning_models": [], "default_reasoning_effort": "medium", "timeout_seconds": 90, "max_conversation_turns": 10, "web_search_max_results": 5}"#),
            "/api/v1/ai/conversations": .json(200, "[]"),
            "/api/v1/ai/conversations/7/messages": .json(200, "[]"),
            "/api/v1/ai/conversations/7/cancel": .json(200, #"{"cancelled": true}"#),
            "/api/v1/ai/usage/stats": .json(200, Self.usageBody),
        ])

        _ = try await client.config()
        _ = try await client.conversations()
        _ = try await client.messages(conversationID: 7)
        _ = try await client.cancel(conversationID: 7)
        _ = try await client.usageStats(range: .ninetyDays)

        XCTAssertEqual(
            StubURLProtocol.log.map(\.timeout),
            [5, 5, 5, 5, RequestTier.stats.timeout]
        )
        XCTAssertEqual(StubURLProtocol.log.last?.timeout, 15)
    }

    // MARK: - 凭据

    func testMissingCredentialFailsBeforeAnyRequest() async throws {
        let session = StubURLProtocol.session(routes: [:])
        let api = APIClient(baseURL: baseURL, apiKey: nil, session: session)
        let client = AIChatClient(client: api)

        do {
            _ = try await client.conversations()
            XCTFail("没有凭据应当直接抛错")
        } catch let error as APIError {
            guard case .missingCredential = error else {
                return XCTFail("应当是 missingCredential，实际 \(error)")
            }
        }
        XCTAssertTrue(StubURLProtocol.log.isEmpty, "缺凭据不得发出请求")
    }

    // MARK: - 真实快照走真实客户端

    /// 四份真响应经**真实** `APIClient` 链路解出来：请求形状与解码在被测链路上一起跑通。
    func testRealSnapshotsDecodeThroughRealClient() async throws {
        let (client, _) = try makeClient(routes: [
            "/api/v1/ai/config": .json(200, try AIChatFixtures.text(fileName: "ai-config.json")),
            "/api/v1/ai/conversations": .json(200, try AIChatFixtures.text(fileName: "ai-conversations.json")),
            "/api/v1/ai/conversations/7/messages": .json(
                200,
                try AIChatFixtures.text(fileName: "ai-conversation-messages.json")
            ),
            "/api/v1/ai/usage/stats": .json(200, try AIChatFixtures.text(fileName: "ai-usage-stats-30d.json")),
        ])

        let config = try await client.config()
        XCTAssertFalse(config.providerConfigured)
        let conversations = try await client.conversations()
        XCTAssertEqual(conversations.count, try AIChatFixtures.conversations().count)
        let messages = try await client.messages(conversationID: 7)
        XCTAssertEqual(messages.count, try AIChatFixtures.messages().count)
        XCTAssertTrue(messages.contains { !$0.searchSources.isEmpty })
        let usage = try await client.usageStats(range: .thirtyDays)
        XCTAssertEqual(usage.daily.count, 30)
    }

    /// 真帧经真实客户端 + 真实解码器走一遍（含 `done` 事件里的持久化载荷）。
    func testRealStreamSnapshotFlowsThroughRealClient() async throws {
        let (client, _) = try makeClient(routes: [
            "/api/v1/ai/conversations/7/messages/stream": .stream(
                200,
                chunks: [try AIChatFixtures.streamTurn()]
            ),
        ])

        let frames = try await sendPayload(client: client)
        var accumulator = AIChatTurnAccumulator()
        for frame in frames { accumulator.apply(frame.event, lastEventID: frame.eventID) }

        XCTAssertEqual(accumulator.outcome, .completed)
        XCTAssertEqual(accumulator.text, try AIChatFixtures.messages().first { $0.isAssistant }?.content)
        XCTAssertNotNil(accumulator.lastEventID)
    }

    // MARK: - 夹具

    private static let usageBody = #"""
    {"range": "30d", "start_date": "2026-08-17", "end_date": "2026-09-15",
     "totals": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
                "message_count": 0, "conversation_count": 0},
     "daily": [], "by_model": [],
     "snapshot_freshness": {"latest_data_date": null, "latest_computed_at": null}}
    """#
}
