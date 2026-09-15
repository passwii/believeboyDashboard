import Foundation

/// 一帧流式事件 + 它的 `id:` 游标。
///
/// 为什么不只产出 `AIChatStreamEvent`：续传要用 `Last-Event-ID`，而游标是 **SSE 帧**的
/// 字段（Redis Stream entry id），不是事件体里的东西。把两者一起交出去，调用方就不必
/// 再从原始帧里抠一次 —— 而「抠游标」这件事一旦分叉，续传就会有人用错值。
public struct AIChatStreamFrame: Sendable, Equatable {
    public let event: AIChatStreamEvent
    /// 这一帧的 `id:`（`done` 事件没有 `id:`，故可空）。
    public let eventID: String?

    public init(event: AIChatStreamEvent, eventID: String?) {
        self.event = event
        self.eventID = eventID
    }
}

/// 「AI 会话片」两个页面的数据源抽象。
///
/// 抽协议的理由与 S5.1/S5.2 相同：三态（加载 / 空 / 错误）、取消不落错误态、刷新失败保留
/// 旧列表、流式草稿的收尾判定 —— 这些是**状态机逻辑**，必须在不碰网络的前提下逐条钉住。
/// 测试注入假实现（含失败 / 挂起 / 逐帧三种）。
public protocol AIChatDataProviding: Sendable {
    /// 1. 模型 / 场景配置。
    func config() async throws -> AIChatConfig
    /// 2. 会话列表（按 `X-User-Id` 归属过滤）。
    func conversations() async throws -> [AIChatConversation]
    /// 3. 新建会话（客服交流页的入口：先建会话再发流）。
    func createConversation(title: String?) async throws -> AIChatConversation
    /// 4. 重命名会话。
    func renameConversation(id: Int, title: String) async throws -> AIChatConversation
    /// 5. 删除会话。
    func deleteConversation(id: Int) async throws
    /// 6. 消息历史。
    func messages(conversationID: Int) async throws -> [AIChatMessage]
    /// 7. 编辑消息（后端只接受 user 消息）。
    func editMessage(conversationID: Int, messageID: Int, content: String) async throws -> AIChatMessage
    /// 8. 删除消息。
    func deleteMessage(conversationID: Int, messageID: Int) async throws
    /// 9. 发送 + 流式回复（`POST` + JSON body + SSE）。
    func send(
        conversationID: Int,
        payload: AIChatSendPayload,
        lastEventID: String?
    ) -> AsyncThrowingStream<AIChatStreamFrame, Error>
    /// 10. 停止生成（跨 worker 取消）。
    func cancel(conversationID: Int) async throws -> AIChatCancelResponse
    /// 11. 附件解析（multipart，字段名 `file`）。
    func upload(fileURL: URL, filename: String, mimeType: String) async throws -> AIFileUploadResponse
    /// 12. token 用量统计。
    func usageStats(range: AIChatUsageRange) async throws -> AIChatUsageStats
}

/// 真实实现：直连 `backend/` 既有端点（**零后端改动**，12 条全部 `protected`）。
///
/// 分层超时（对齐 Web，逐条有出处）：
///
/// | 用途 | 端点 | 档 | 与 Web 对齐的依据 |
/// | --- | --- | --- | --- |
/// | 对话流 | `.../messages/stream` | `.stream`（无超时） | Web 的流路由不带 signal（`app/api/ai-chat/.../stream/route.ts` 直传 `upstream.body`） |
/// | 配置 / 会话 / 消息 / 取消 9 条 | `/ai/config`、`/ai/conversations*` | `.list`（5s） | Web 的 `backendFetchJson` 默认 `AbortSignal.timeout(5_000)` |
/// | 附件解析 | `/ai/upload` | `.report`（60s） | **有意不一致**：Web 是同机内存转发（5s 够），桌面端要真把 ≤10MB 的附件经公网上传 —— 5s 会掐断合法的慢链路上传。取 Kit 上传的写档默认值 |
/// | token 用量 | `/ai/usage/stats` | `.stats`（15s） | 物化表区间聚合，与 Kit 的「统计档 15s」同口径 |
public struct AIChatClient: AIChatDataProviding {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    // MARK: - 1. 配置

    public func config() async throws -> AIChatConfig {
        try await client.get(AIChatCatalog.configEndpoint, tier: .list)
    }

    // MARK: - 2~5. 会话

    public func conversations() async throws -> [AIChatConversation] {
        try await client.get(AIChatCatalog.conversationsEndpoint, tier: .list)
    }

    public func createConversation(title: String?) async throws -> AIChatConversation {
        try await client.write(
            .post,
            AIChatCatalog.conversationsEndpoint,
            body: AIChatConversationPayload(title: title),
            tier: .list
        )
    }

    public func renameConversation(id: Int, title: String) async throws -> AIChatConversation {
        try await client.write(
            .patch,
            AIChatCatalog.conversationEndpoint(id: id),
            body: AIChatConversationPayload(title: title),
            tier: .list
        )
    }

    public func deleteConversation(id: Int) async throws {
        // 后端 `status_code=204`：忽略响应体（`writeIgnoringResponse` 把 204 与 200 空体
        // 一并当成功）。
        try await client.writeIgnoringResponse(
            .delete,
            AIChatCatalog.conversationEndpoint(id: id),
            tier: .list
        )
    }

    // MARK: - 6~8. 消息

    public func messages(conversationID: Int) async throws -> [AIChatMessage] {
        try await client.get(
            AIChatCatalog.messagesEndpoint(conversationID: conversationID),
            tier: .list
        )
    }

    public func editMessage(
        conversationID: Int,
        messageID: Int,
        content: String
    ) async throws -> AIChatMessage {
        try await client.write(
            .patch,
            AIChatCatalog.messageEndpoint(conversationID: conversationID, messageID: messageID),
            body: AIChatMessageEdit(content: content),
            tier: .list
        )
    }

    public func deleteMessage(conversationID: Int, messageID: Int) async throws {
        try await client.writeIgnoringResponse(
            .delete,
            AIChatCatalog.messageEndpoint(conversationID: conversationID, messageID: messageID),
            tier: .list
        )
    }

    // MARK: - 9. 发送（POST-SSE）

    public func send(
        conversationID: Int,
        payload: AIChatSendPayload,
        lastEventID: String? = nil
    ) -> AsyncThrowingStream<AIChatStreamFrame, Error> {
        // 编码失败走与普通写一致的分类（`.decoding`：本地数据与目标形状不匹配），
        // 并且以「流的第一个错误」形式交付 —— 调用方只处理一处。
        let body: Data?
        do {
            body = try client.encoder.encode(payload)
        } catch {
            return AsyncThrowingStream { $0.finish(throwing: APIError.decoding(
                "请求体编码失败：\(error.localizedDescription)"
            )) }
        }

        let raw = client.stream(
            AIChatCatalog.streamEndpoint(conversationID: conversationID),
            method: .post,
            body: body,
            lastEventID: lastEventID,
            tier: .stream
        )

        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await frame in raw {
                        continuation.yield(
                            AIChatStreamFrame(
                                event: AIChatStreamDecoder.decode(frame),
                                eventID: frame.id
                            )
                        )
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func send(
        conversationID: Int,
        payload: AIChatSendPayload
    ) -> AsyncThrowingStream<AIChatStreamFrame, Error> {
        send(conversationID: conversationID, payload: payload, lastEventID: nil)
    }

    // MARK: - 10. 取消

    public func cancel(conversationID: Int) async throws -> AIChatCancelResponse {
        try await client.write(
            .post,
            AIChatCatalog.cancelEndpoint(conversationID: conversationID),
            body: EmptyBody(),
            tier: .list
        )
    }

    // MARK: - 11. 附件

    public func upload(
        fileURL: URL,
        filename: String,
        mimeType: String = "application/octet-stream"
    ) async throws -> AIFileUploadResponse {
        var form = MultipartFormData()
        form.addFile(
            AIChatCatalog.uploadFieldName,
            filename: filename,
            mimeType: mimeType,
            contentsOf: fileURL
        )
        return try await client.upload(AIChatCatalog.uploadEndpoint, form: form)
    }

    /// 内存内容上传（粘贴文本 / 测试用；与磁盘版本共用同一份 multipart 组装）。
    public func upload(
        data: Data,
        filename: String,
        mimeType: String = "application/octet-stream"
    ) async throws -> AIFileUploadResponse {
        var form = MultipartFormData()
        form.addFile(AIChatCatalog.uploadFieldName, filename: filename, mimeType: mimeType, data: data)
        return try await client.upload(AIChatCatalog.uploadEndpoint, form: form)
    }

    // MARK: - 12. 用量

    public func usageStats(range: AIChatUsageRange = .thirtyDays) async throws -> AIChatUsageStats {
        try await client.get(
            AIChatCatalog.usageStatsEndpoint,
            query: ["range": range.rawValue],
            tier: .stats
        )
    }
}

/// 空 JSON 体（`POST .../cancel` 没有 body 字段，但 `write(_:body:)` 需要一个 `Encodable`）。
///
/// 用 `{}` 而不是走 `makeRequest(body: nil)`：取消端点的签名是纯路径参数，两种写法后端都
/// 接受；选带空体的那份是为了让「所有 POST 都显式声明自己发了什么」成立 —— 一次没有任何
/// body 的 POST 在这里是可疑的，不该和 GET 共用一个入口。
public struct EmptyBody: Encodable, Sendable, Equatable {
    public init() {}

    public func encode(to encoder: Encoder) throws {
        _ = encoder.container(keyedBy: EmptyCodingKey.self)
    }

    private enum EmptyCodingKey: String, CodingKey {
        case unused
    }
}
