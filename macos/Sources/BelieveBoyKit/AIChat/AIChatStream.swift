import Foundation

/// AI 会话的流式协议（Anthropic Messages 风格 SSE + 本项目扩展）。
///
/// 与 S5.3 的洞察流的**区别**在这里逐条落地：
///
/// | 维度 | 洞察 run 流 | AI 会话流（本文件） |
/// | --- | --- | --- |
/// | 请求 | `GET`（无可发送的 body） | **`POST` + `MessageCreate` JSON body**（必填） |
/// | 游标 | `id:` = run 的 canonical 游标 | `id:` = **Redis Stream entry id**（`encoder.py:28`） |
/// | 续传 | 带 `Last-Event-ID` 重发 GET | 带 `Last-Event-ID` **且必须重发 body**（`ai_chat_v2.py:96`） |
/// | 终态 | 单事件即终态 | `message_stop` + **项目扩展的 `done`**（持久化载荷） |
///
/// 事件类型区分两种「结果」：`message_stop` 只是协议收尾，**业务载荷在 `done`** 里
/// （`_encode_done_sse`）。Web 的消费端把「有 `done` 的 `message_stop`」当成功、「只有
/// `message_stop`」当「缺少 done」（续传路径的合法形态）。桌面端沿用同一判据，
/// 但把「失败」收敛成一条可展示的错误文案，见 `AIChatTurnOutcome`。
public enum AIChatStreamEvent: Sendable, Equatable {
    case messageStart(messageID: String, model: String, createdAtMillis: Int?)
    case contentBlockStart(index: Int, block: AIChatContentBlock)
    case contentBlockDelta(index: Int, delta: AIChatDelta)
    case contentBlockStop(index: Int)
    case messageDelta(usage: AIChatDeltaUsage?, stopReason: String?)
    case messageStop
    case ping
    case error(code: String, message: String)
    /// 项目扩展：一次生成结束后的持久化载荷（用户消息 / 助手消息 / 标题 / 用量）。
    case done(AIChatStreamDone)
    /// 协议演进兜底：认不出的 `type` **不静默丢**，记下来（渲染层会显示「未知事件」提示）
    /// —— 后端加事件类型时，桌面端应当看得见，而不是表现成「生成卡住」。
    case unknown(type: String)

    /// 事件类型序列（断言「同源同结构」用的稳定字符串，与后端 `type` 字段同名）。
    public var kind: String {
        switch self {
        case .messageStart: return "message_start"
        case .contentBlockStart: return "content_block_start"
        case .contentBlockDelta: return "content_block_delta"
        case .contentBlockStop: return "content_block_stop"
        case .messageDelta: return "message_delta"
        case .messageStop: return "message_stop"
        case .ping: return "ping"
        case .error: return "error"
        case .done: return "done"
        case .unknown(let type): return type
        }
    }

    /// 是否终态（`message_stop` / `error` / `done` 之后不该再有增量）。
    public var isTerminal: Bool {
        switch self {
        case .messageStop, .error, .done: return true
        default: return false
        }
    }
}

/// 内容块（`content_block_start` 的 `content_block`）。
public enum AIChatContentBlock: Sendable, Equatable {
    case text
    case thinking
    case toolUse(id: String, name: String, input: [String: JSONValue])
    /// 工具返回结果（本仓库扩展，Anthropic 官方不显式发）。
    case toolResult(toolUseID: String, content: String, isError: Bool)
    case unknown(type: String)

    /// `tool_use` 块是「正在调用工具」的信号 —— Web 用它点亮「搜索中」状态。
    public var isToolUse: Bool {
        if case .toolUse = self { return true }
        return false
    }
}

/// 增量（`content_block_delta` 的 `delta`）。
public enum AIChatDelta: Sendable, Equatable {
    case text(String)
    case thinking(String)
    /// 工具入参的 JSON 分片（P1 不在 UI 上展示，只计数）。
    case inputJSON(String)
    case unknown(type: String)

    public var textValue: String? {
        switch self {
        case .text(let value), .thinking(let value), .inputJSON(let value): return value
        case .unknown: return nil
        }
    }
}

/// `message_delta` 的用量（Anthropic 形状：in/out）。
public struct AIChatDeltaUsage: Decodable, Sendable, Equatable {
    public let inputTokens: Int
    public let outputTokens: Int
    public let totalTokens: Int

    public init(inputTokens: Int = 0, outputTokens: Int = 0, totalTokens: Int = 0) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.totalTokens = totalTokens
    }
}

/// 持久化载荷里的用量（项目形状：prompt/completion）。
public struct AIChatTokenUsage: Decodable, Sendable, Equatable {
    public let promptTokens: Int
    public let completionTokens: Int
    public let totalTokens: Int

    public init(promptTokens: Int = 0, completionTokens: Int = 0, totalTokens: Int = 0) {
        self.promptTokens = promptTokens
        self.completionTokens = completionTokens
        self.totalTokens = totalTokens
    }

    /// Anthropic 形状 → 项目形状（两个形状只是命名不同，数值同义）。
    public init(delta: AIChatDeltaUsage) {
        self.init(
            promptTokens: delta.inputTokens,
            completionTokens: delta.outputTokens,
            totalTokens: delta.totalTokens
        )
    }
}

/// `done` 事件的载荷（`_encode_done_sse` 的 dict）。
///
/// 每个字段都可空：后端在 `_finalize_db` 里若中途失败会**不发** `done`（只发
/// `message_stop`），而续传路径更是拿不到 `done`。所以解不开某个字段不该让整条流断。
public struct AIChatStreamDone: Sendable, Equatable {
    public let userMessage: AIChatMessage?
    public let assistantMessage: AIChatMessage?
    public let conversationTitle: String?
    public let tokenUsage: AIChatTokenUsage?
    public let conversationTokenUsage: AIChatTokenUsage?
    public let durationMs: Int?
    public let titleRegenerated: Bool

    public init(
        userMessage: AIChatMessage? = nil,
        assistantMessage: AIChatMessage? = nil,
        conversationTitle: String? = nil,
        tokenUsage: AIChatTokenUsage? = nil,
        conversationTokenUsage: AIChatTokenUsage? = nil,
        durationMs: Int? = nil,
        titleRegenerated: Bool = false
    ) {
        self.userMessage = userMessage
        self.assistantMessage = assistantMessage
        self.conversationTitle = conversationTitle
        self.tokenUsage = tokenUsage
        self.conversationTokenUsage = conversationTokenUsage
        self.durationMs = durationMs
        self.titleRegenerated = titleRegenerated
    }
}

// MARK: - 解码

/// 流事件的解码入口：把一帧 SSE 的 `data` 解成 `AIChatStreamEvent`。
///
/// 为什么走一个「全可空」的中间结构体、而不是给 `AIChatStreamEvent` 写 `Decodable`：
/// 后端是 Pydantic 的 discriminated union，而 `done` 是**手搓 dict**（不走 pydantic），
/// 两条路出来的 JSON 形状并不完全一致（`message_stop` 只有 `type`，`ping` 同理）。
/// 中间结构体让「字段缺失 = nil」成为默认，分类逻辑集中在 `classify()` 一处，
/// 也让「未知事件」有明确的落点（而不是解码直接抛错，把一次生成变成硬失败）。
public enum AIChatStreamDecoder {
    /// 解一帧。**不抛错**：认不出来一律 `.unknown(type:)` / `.ping` 兜底 ——
    /// 流里出现一个新事件不该让整次对话报错。
    public static func decode(_ event: ServerSentEvent) -> AIChatStreamEvent {
        guard let raw = try? event.decode(AIChatRawStreamEvent.self) else {
            return .unknown(type: "")
        }
        return classify(raw)
    }

    static func classify(_ raw: AIChatRawStreamEvent) -> AIChatStreamEvent {
        switch raw.type {
        case "message_start":
            return .messageStart(
                messageID: raw.messageId ?? "",
                model: raw.model ?? "",
                createdAtMillis: raw.createdAt
            )
        case "content_block_start":
            return .contentBlockStart(
                index: raw.index ?? 0,
                block: AIChatContentBlock(raw: raw.contentBlock)
            )
        case "content_block_delta":
            return .contentBlockDelta(
                index: raw.index ?? 0,
                delta: AIChatDelta(raw: raw.delta)
            )
        case "content_block_stop":
            return .contentBlockStop(index: raw.index ?? 0)
        case "message_delta":
            return .messageDelta(usage: raw.usage, stopReason: raw.stopReason)
        case "message_stop":
            return .messageStop
        case "ping":
            return .ping
        case "error":
            return .error(
                code: raw.error?.code ?? "unknown",
                message: raw.error?.message ?? "流式错误（后端未给出原因）"
            )
        case "done":
            return .done(
                AIChatStreamDone(
                    userMessage: raw.userMessage,
                    assistantMessage: raw.assistantMessage,
                    conversationTitle: raw.conversationTitle,
                    tokenUsage: raw.tokenUsage,
                    conversationTokenUsage: raw.conversationTokenUsage,
                    durationMs: raw.durationMs,
                    titleRegenerated: raw.titleRegenerated ?? false
                )
            )
        default:
            return .unknown(type: raw.type)
        }
    }
}

/// SSE 帧 `data` 的宽松形状（所有字段可空）。
///
/// 属性名按 `convertFromSnakeCase` **变换之后**的名字写（S4 的教训：`calls_24h` →
/// `calls24H` 而非 `calls24h`）—— 这里逐条核对过：`message_id`→`messageId`、
/// `created_at`→`createdAt`、`content_block`→`contentBlock`、`stop_reason`→`stopReason`、
/// `user_message`→`userMessage`、`conversation_title`→`conversationTitle`、
/// `token_usage`→`tokenUsage`、`duration_ms`→`durationMs`、`title_regenerated`→`titleRegenerated`、
/// `input_tokens`→`inputTokens`、`prompt_tokens`→`promptTokens`。
struct AIChatRawStreamEvent: Decodable, Sendable {
    struct RawError: Decodable, Sendable {
        let code: String?
        let message: String?
    }

    struct RawBlock: Decodable, Sendable {
        let type: String?
        let id: String?
        let name: String?
        let input: [String: JSONValue]?
        let toolUseId: String?
        let content: String?
        let isError: Bool?
    }

    struct RawDelta: Decodable, Sendable {
        let type: String?
        let text: String?
        let partialJson: String?
    }

    let type: String
    let messageId: String?
    let model: String?
    let createdAt: Int?
    let index: Int?
    let contentBlock: RawBlock?
    let delta: RawDelta?
    let usage: AIChatDeltaUsage?
    let stopReason: String?
    let error: RawError?
    let userMessage: AIChatMessage?
    let assistantMessage: AIChatMessage?
    let conversationTitle: String?
    let tokenUsage: AIChatTokenUsage?
    let conversationTokenUsage: AIChatTokenUsage?
    let durationMs: Int?
    let titleRegenerated: Bool?

    private enum CodingKeys: String, CodingKey {
        case type, model, index, delta, usage, error
        case messageId
        case createdAt
        case contentBlock
        case stopReason
        case userMessage
        case assistantMessage
        case conversationTitle
        case tokenUsage
        case conversationTokenUsage
        case durationMs
        case titleRegenerated
    }
}

extension AIChatContentBlock {
    init(raw: AIChatRawStreamEvent.RawBlock?) {
        switch raw?.type {
        case "text": self = .text
        case "thinking": self = .thinking
        case "tool_use":
            self = .toolUse(
                id: raw?.id ?? "",
                name: raw?.name ?? "",
                input: raw?.input ?? [:]
            )
        case "tool_result":
            self = .toolResult(
                toolUseID: raw?.toolUseId ?? "",
                content: raw?.content ?? "",
                isError: raw?.isError ?? false
            )
        case .some(let other): self = .unknown(type: other)
        case .none: self = .unknown(type: "")
        }
    }
}

extension AIChatDelta {
    init(raw: AIChatRawStreamEvent.RawDelta?) {
        switch raw?.type {
        case "text_delta": self = .text(raw?.text ?? "")
        case "thinking_delta": self = .thinking(raw?.text ?? "")
        case "input_json_delta": self = .inputJSON(raw?.partialJson ?? "")
        case .some(let other): self = .unknown(type: other)
        case .none: self = .unknown(type: "")
        }
    }
}
