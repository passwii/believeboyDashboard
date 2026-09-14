import Foundation

/// 一次生成的收尾判定。
///
/// Web 的消费端（`lib/api/ai-chat-stream-v2.ts`）用「有没有 `done`」区分三种收尾，这里把它
/// 显式成类型，免得调用点各写一遍 if：
/// - `completed`：拿到项目扩展的 `done`（持久化载荷在手，可据此替换消息与标题）；
/// - `stoppedWithoutDone`：只见过 `message_stop`（**续传路径的合法形态** ——
///   `_resume_stream` 只转发 Redis Stream 里的原始帧，不会合成 `done`）。Web 把它当错误
///   （「流式响应缺少 done 事件」）是因为它自己从不主动续传；桌面端会真发续传请求，
///   所以这条路径必须能落到「已完成，但没有持久化载荷」而不是报错；
/// - `failed`：`error` 事件。
public enum AIChatTurnOutcome: Sendable, Equatable {
    case completed
    case stoppedWithoutDone
    case failed(String)
    /// 流还没给出任何终态（生成中）。
    case running
}

/// 一次生成的**纯逻辑**累加器：把 SSE 事件序列折成「草稿正文 + 用量 + 收尾载荷」。
///
/// 单独成类型（不写在 store 里）的理由与 S5.3 的 `CanonicalRunAccumulator` 相同：
/// 「事件序列 → 状态」是流式里最容易错的一段（跨帧拼接、`content_block_stop` 的状态翻转、
/// 未知事件不静默丢、终态判定），而它完全不需要网络或视图就能逐条钉住。
///
/// 不变量：
/// - **增量只追加**：`text_delta` / `thinking_delta` 各自按顺序拼接到自己的缓冲；
/// - **未知事件记账**：认不出的 `type` 进 `unknownEventTypes`，UI 能提示「后端发了新事件」，
///   而不是表现成「生成卡住」；
/// - **终态后不再累积**：`done` / `error` 之后到来的增量一律忽略（后端理论上不会再发，
///   但续传/重连可能重放）。
public struct AIChatTurnAccumulator: Sendable, Equatable {
    public private(set) var messageID: String?
    public private(set) var model: String?
    public private(set) var text: String = ""
    public private(set) var thinking: String = ""
    public private(set) var usage: AIChatTokenUsage?
    public private(set) var stopReason: String?
    public private(set) var toolCallCount: Int = 0
    /// 正在调用工具（`tool_use` 块开 → 该块停 = 结束）。Web 用它显示「搜索中…」。
    public private(set) var isSearching: Bool = false
    public private(set) var sawMessageStop: Bool = false
    public private(set) var done: AIChatStreamDone?
    public private(set) var errorMessage: String?
    public private(set) var unknownEventTypes: [String] = []
    /// 本次流经过的事件类型序列（顺序保留、含重复）——「同源同结构」的断言面。
    public private(set) var eventKinds: [String] = []
    /// 最近一次 `id:` 游标（Redis Stream entry id），续传时回传。
    public private(set) var lastEventID: String?

    public init() {}

    /// 折入一帧。`lastEventID` 是这一帧的 `id:` 字段（可为空 —— `done` 事件就没有 `id:`）。
    public mutating func apply(_ event: AIChatStreamEvent, lastEventID: String? = nil) {
        eventKinds.append(event.kind)
        if let lastEventID = lastEventID?.trimmedNonEmpty {
            self.lastEventID = lastEventID
        }

        // 终态之后到来的帧只记账、不改状态（重连可能重放旧帧）。
        //
        // ⚠️ 终态是 `done` / `error`，**不是** `message_stop`：后端的`message_stop`
        // 只标协议收尾，**项目扩展的 `done` 跟在它后面**（`ai_chat_v2.py:206`）。
        // 把 `message_stop` 当终态会把 `done` 连同里面的用量、消息 id、标题一并丢掉。
        guard done == nil, errorMessage == nil else { return }

        switch event {
        case .messageStart(let messageID, let model, _):
            self.messageID = messageID.trimmedNonEmpty
            self.model = model.trimmedNonEmpty

        case .contentBlockStart(_, let block):
            if block.isToolUse {
                toolCallCount += 1
                isSearching = true
            }

        case .contentBlockDelta(_, let delta):
            switch delta {
            case .text(let chunk): text += chunk
            case .thinking(let chunk): thinking += chunk
            case .inputJSON: break // P1 不在 UI 展示工具入参
            case .unknown: break
            }

        case .contentBlockStop:
            if isSearching { isSearching = false }

        case .messageDelta(let usage, let stopReason):
            if let usage { self.usage = AIChatTokenUsage(delta: usage) }
            if let stopReason = stopReason?.trimmedNonEmpty { self.stopReason = stopReason }

        case .messageStop:
            sawMessageStop = true

        case .ping:
            break

        case .error(let code, let message):
            errorMessage = "\(message)（\(code)）"

        case .done(let payload):
            done = payload
            // 载荷里的用量更权威（它是**落库后**的值，`message_delta` 是流内估算）。
            if let usage = payload.tokenUsage { self.usage = usage }
            // `done` 之前若没收到 message_stop，正文用载荷里的完整内容兜底 ——
            // 续传场景下流内的增量可能只有后半段。
            if text.isEmpty, let content = payload.assistantMessage?.content {
                text = content
            }

        case .unknown(let type):
            let name = type.trimmedNonEmpty ?? "（无 type）"
            if !unknownEventTypes.contains(name) { unknownEventTypes.append(name) }
        }
    }

    /// 当前收尾判定（每次 `apply` 后再读）。
    public var outcome: AIChatTurnOutcome {
        if let errorMessage { return .failed(errorMessage) }
        if done != nil { return .completed }
        if sawMessageStop { return .stoppedWithoutDone }
        return .running
    }

    /// 是否已经收尾（`done` / `error`）—— 之后到来的帧不再影响状态。
    public var hasReachedTerminalState: Bool { done != nil || errorMessage != nil }

    /// 是否已经有可见输出（决定「正在生成」是否要显示光标）。
    public var hasVisibleText: Bool { !text.isEmpty }

    /// 生效的用量（`done` 载荷优先，其次 `message_delta`）。
    public var effectiveUsage: AIChatTokenUsage? {
        done?.tokenUsage ?? usage
    }

    /// 助手消息的持久化 id（`done` 载荷给；续传路径可能没有）。
    public var assistantMessageID: Int? { done?.assistantMessage?.id }

    /// 会话标题（`done` 载荷给；仅首轮自动改名时才有意义）。
    public var conversationTitle: String? { done?.conversationTitle?.trimmedNonEmpty }

    /// 联网搜索来源（**只来自 `done` 载荷**：V2 的流内事件不携带来源卡片）。
    public var sources: [AIChatSearchSource] { done?.assistantMessage?.searchSources ?? [] }

    /// 搜索时间范围 chip（同上，只在持久化载荷里）。
    public var searchTimeRange: String? { done?.assistantMessage?.searchTimeRange?.trimmedNonEmpty }

    /// 耗时（毫秒）。
    public var durationMs: Int? { done?.durationMs }

    /// 后端发了握手事件但没有正文 —— 用于「生成中」与「空回复」的区分。
    public var hasAnySignal: Bool { messageID != nil || !eventKinds.isEmpty }
}
