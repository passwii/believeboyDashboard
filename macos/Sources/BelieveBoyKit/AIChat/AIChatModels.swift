import Foundation

// MARK: - 配置（GET /ai/config）

/// `GET /api/v1/ai/config` 的响应（`backend/app/schemas/ai_chat.py:AIChatConfigResponse`）。
///
/// 三件在桌面上「不能想当然」的事：
/// 1. **`models` 已经是「可用模型」**（后端按 blocklist 过滤过），三个分组
///    （`premiumModels` / `basicModels` / `reasoningModels`）是它的**子集**，且后端用
///    `m.lower() in set` 判归属 —— 大小写不敏感，所以同一个模型可能同时出现在两个组里。
///    桌面端照抄这个判据（不自己重新分组），否则两端的「高级 / 基础」标签会不一致。
/// 2. **`providerConfigured = false` 是合法状态**：后端没配 LLM provider 时 `models`
///    可能是空的、`defaultModel` 也可能是个占位串 —— 此时正确行为是提示"后端未配置
///    provider"，而不是发一个注定失败的对话请求。
/// 3. Web 侧 `AIChatConfig` 里的 `overviewOptions` / `detailOptions` / `scenarios`
///    **不是这个端点的字段**：它们由 Next.js 服务端（`lib/server/ai-chat.ts`）拼进响应。
///    桌面端直连后端，所以这三项由本仓库的 `AIChatPresetCatalog` 复刻（见 `AIChatCatalog.swift`）。
public struct AIChatConfig: Decodable, Sendable, Equatable {
    public let providerConfigured: Bool
    public let webSearchConfigured: Bool
    public let models: [String]
    public let defaultModel: String
    public let premiumModels: [String]
    public let basicModels: [String]
    public let reasoningModels: [String]
    public let defaultReasoningEffort: String
    public let timeoutSeconds: Int
    public let maxConversationTurns: Int
    public let webSearchMaxResults: Int

    public init(
        providerConfigured: Bool,
        webSearchConfigured: Bool,
        models: [String],
        defaultModel: String,
        premiumModels: [String] = [],
        basicModels: [String] = [],
        reasoningModels: [String] = [],
        defaultReasoningEffort: String = "medium",
        timeoutSeconds: Int = 0,
        maxConversationTurns: Int = 10,
        webSearchMaxResults: Int = 5
    ) {
        self.providerConfigured = providerConfigured
        self.webSearchConfigured = webSearchConfigured
        self.models = models
        self.defaultModel = defaultModel
        self.premiumModels = premiumModels
        self.basicModels = basicModels
        self.reasoningModels = reasoningModels
        self.defaultReasoningEffort = defaultReasoningEffort
        self.timeoutSeconds = timeoutSeconds
        self.maxConversationTurns = maxConversationTurns
        self.webSearchMaxResults = webSearchMaxResults
    }
}

// MARK: - 会话与消息（GET/POST/PATCH/DELETE /ai/conversations…）

/// 一个会话（`ConversationItem`）。
///
/// 时间戳保持**字符串**（与 `JobSummary` 同口径）：后端是 Pydantic 的 ISO8601，
/// 可能带 6 位小数秒、可能无时区，解成 `Date` 会在这些形态上崩；展示走
/// `AgentOpsFormatting.parseISO8601` / `absoluteTime`。
public struct AIChatConversation: Decodable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let title: String
    public let createdAt: String
    public let updatedAt: String
    /// 会话累计 token（列表端点给，详情端点不校验这两项时后端默认 0）。
    public let totalPromptTokens: Int
    public let totalCompletionTokens: Int
    public let totalTokens: Int

    public init(
        id: Int,
        title: String,
        createdAt: String,
        updatedAt: String,
        totalPromptTokens: Int = 0,
        totalCompletionTokens: Int = 0,
        totalTokens: Int = 0
    ) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.totalPromptTokens = totalPromptTokens
        self.totalCompletionTokens = totalCompletionTokens
        self.totalTokens = totalTokens
    }
}

/// 一条消息（`MessageItem`）。
public struct AIChatMessage: Decodable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let conversationId: Int
    /// `user` / `assistant`（后端是裸 `str`，不做枚举校验 —— 未知值按原样保留，
    /// 渲染层按「非 user 即 assistant」处理，避免将来加角色时整条消息解不开）。
    public let role: String
    public let content: String
    public let searchSources: [AIChatSearchSource]
    /// 联网搜索的时间范围 chip（`day` / `week` / `month` / `year` / `all`）。
    public let searchTimeRange: String?
    public let isComplete: Bool
    public let promptTokens: Int
    public let completionTokens: Int
    public let totalTokens: Int
    public let durationMs: Int?
    public let createdAt: String

    public var isUser: Bool { role == "user" }
    public var isAssistant: Bool { role == "assistant" }

    public init(
        id: Int,
        conversationId: Int,
        role: String,
        content: String,
        searchSources: [AIChatSearchSource] = [],
        searchTimeRange: String? = nil,
        isComplete: Bool = true,
        promptTokens: Int = 0,
        completionTokens: Int = 0,
        totalTokens: Int = 0,
        durationMs: Int? = nil,
        createdAt: String = ""
    ) {
        self.id = id
        self.conversationId = conversationId
        self.role = role
        self.content = content
        self.searchSources = searchSources
        self.searchTimeRange = searchTimeRange
        self.isComplete = isComplete
        self.promptTokens = promptTokens
        self.completionTokens = completionTokens
        self.totalTokens = totalTokens
        self.durationMs = durationMs
        self.createdAt = createdAt
    }
}

/// 一条联网搜索结果卡片（`MessageItem.search_sources` 的元素）。
///
/// 后端的声明类型是 `list[dict[str, str | float | None]]` —— **声明宽、实际窄**：
/// 键名由搜索工具决定，`score` 是数字而其余是字符串，历史数据里还可能出现 `None`。
/// 因此逐字段**宽容解码**（数字 / 布尔也能读成文本，反之亦然），未知键忽略：
/// 一个字段的形状漂移不该让整条消息解不开（解不开 = 整个会话历史报错）。
public struct AIChatSearchSource: Decodable, Sendable, Equatable, Hashable {
    public let title: String?
    public let url: String?
    public let snippet: String?
    public let domain: String?
    public let score: Double?
    public let favicon: String?

    public init(
        title: String? = nil,
        url: String? = nil,
        snippet: String? = nil,
        domain: String? = nil,
        score: Double? = nil,
        favicon: String? = nil
    ) {
        self.title = title
        self.url = url
        self.snippet = snippet
        self.domain = domain
        self.score = score
        self.favicon = favicon
    }

    private enum CodingKeys: String, CodingKey {
        case title, url, snippet, domain, score, favicon
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = container.lenientString(.title)
        url = container.lenientString(.url)
        snippet = container.lenientString(.snippet)
        domain = container.lenientString(.domain)
        score = container.lenientDouble(.score)
        favicon = container.lenientString(.favicon)
    }

    /// 展示标题：`title` 为空时退回域名，再退回 URL，最后给一个不撒谎的占位。
    public var displayTitle: String {
        title?.trimmedNonEmpty ?? domain?.trimmedNonEmpty ?? url?.trimmedNonEmpty ?? "（无标题来源）"
    }
}

// MARK: - 请求体

/// `POST /ai/conversations` 与 `PATCH /ai/conversations/{id}` 的请求体
/// （`ConversationCreate`：`title` 可空）。
public struct AIChatConversationPayload: Encodable, Sendable, Equatable {
    public let title: String?

    public init(title: String?) {
        self.title = title
    }
}

/// `PATCH /ai/conversations/{id}/messages/{mid}` 的请求体
/// （`AIChatMessageUpdate`：`content` 必填，1~8000）。
public struct AIChatMessageEdit: Encodable, Sendable, Equatable {
    public let content: String

    public init(content: String) {
        self.content = content
    }
}

/// `POST /ai/conversations/{id}/messages/stream` 的请求体（`MessageCreate`）。
///
/// 字段全部照抄后端（`snake_case` 原样发；`APIClient.encoder` 不做键名转换）：
/// - `content` 上限 8000、`attached_file_content` 上限 55000 —— 超限是后端 422，
///   客户端按「输入框硬上限 + 上传回填」两条路保证不越界。
/// - `regenerate` 只在「启用联网搜索」时允许（否则后端 400），见 `AIChatCatalog` 的说明。
public struct AIChatSendPayload: Encodable, Sendable, Equatable {
    public let content: String
    public let model: String?
    public let systemPrompt: String
    public let reasoningEffort: String?
    public let regenerate: Bool
    public let targetMessageId: Int?
    public let enableWebSearch: Bool
    public let attachedFileContent: String?
    public let attachedFileName: String?

    public init(
        content: String,
        model: String? = nil,
        systemPrompt: String = "",
        reasoningEffort: String? = nil,
        regenerate: Bool = false,
        targetMessageId: Int? = nil,
        enableWebSearch: Bool = false,
        attachedFileContent: String? = nil,
        attachedFileName: String? = nil
    ) {
        self.content = content
        self.model = model
        self.systemPrompt = systemPrompt
        self.reasoningEffort = reasoningEffort
        self.regenerate = regenerate
        self.targetMessageId = targetMessageId
        self.enableWebSearch = enableWebSearch
        self.attachedFileContent = attachedFileContent
        self.attachedFileName = attachedFileName
    }

    private enum CodingKeys: String, CodingKey {
        case content, model, regenerate
        case systemPrompt = "system_prompt"
        case reasoningEffort = "reasoning_effort"
        case targetMessageId = "target_message_id"
        case enableWebSearch = "enable_web_search"
        case attachedFileContent = "attached_file_content"
        case attachedFileName = "attached_file_name"
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(content, forKey: .content)
        // 后端 `model: str | None`：空串会被当模型名直接送进 provider，故空即不发。
        try container.encodeIfPresent(model?.trimmedNonEmpty, forKey: .model)
        try container.encode(systemPrompt, forKey: .systemPrompt)
        try container.encodeIfPresent(reasoningEffort?.trimmedNonEmpty, forKey: .reasoningEffort)
        try container.encode(regenerate, forKey: .regenerate)
        try container.encodeIfPresent(targetMessageId, forKey: .targetMessageId)
        try container.encode(enableWebSearch, forKey: .enableWebSearch)
        try container.encodeIfPresent(attachedFileContent?.trimmedNonEmpty, forKey: .attachedFileContent)
        try container.encodeIfPresent(attachedFileName?.trimmedNonEmpty, forKey: .attachedFileName)
    }
}

// MARK: - 取消（POST /ai/conversations/{id}/cancel）

/// `POST /ai/conversations/{id}/cancel` 的响应。
///
/// `cancelled == false` **不是错误**：它表示「那一刻没有在跑的流」（`RedisCancelRegistry`
/// 的 GETDEL 落空）—— 流可能已经正常结束。UI 因此把它读成「已停止/无进行中的生成」，
/// 而不是弹错误。
public struct AIChatCancelResponse: Decodable, Sendable, Equatable {
    public let cancelled: Bool

    public init(cancelled: Bool) {
        self.cancelled = cancelled
    }
}

// MARK: - 附件解析（POST /ai/upload）

/// `POST /api/v1/ai/upload`（multipart，字段名 `file`）的响应
/// （`backend/app/schemas/ai_file_upload.py:AIFileUploadResponse`）。
///
/// 注意 `content` 是**解析出的纯文本**（上限 50000 字符），不是文件本身 ——
/// 桌面端把它回填进发送体的 `attached_file_content`。
public struct AIFileUploadResponse: Decodable, Sendable, Equatable {
    public let fileName: String
    public let fileType: String
    public let content: String
    public let truncated: Bool
    public let truncatedNote: String?

    public init(
        fileName: String,
        fileType: String,
        content: String,
        truncated: Bool = false,
        truncatedNote: String? = nil
    ) {
        self.fileName = fileName
        self.fileType = fileType
        self.content = content
        self.truncated = truncated
        self.truncatedNote = truncatedNote
    }
}

// MARK: - token 用量（GET /ai/usage/stats）

/// `range` 三档（后端 `UsageRange = Literal["7d","30d","90d"]`）。
public enum AIChatUsageRange: String, Sendable, Equatable, CaseIterable, Identifiable {
    case sevenDays = "7d"
    case thirtyDays = "30d"
    case ninetyDays = "90d"

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .sevenDays: return "近 7 天"
        case .thirtyDays: return "近 30 天"
        case .ninetyDays: return "近 90 天"
        }
    }
}

public struct AIChatUsageTotals: Decodable, Sendable, Equatable {
    public let promptTokens: Int
    public let completionTokens: Int
    public let totalTokens: Int
    public let messageCount: Int
    /// **上界**，不是「不重复会话数」：后端口径是 ∑ 每日 distinct-conv，
    /// 同一会话跨多日会被重复计入（`schemas/ai_chat_usage.py` 的 docstring）。
    public let conversationCount: Int

    public init(
        promptTokens: Int = 0,
        completionTokens: Int = 0,
        totalTokens: Int = 0,
        messageCount: Int = 0,
        conversationCount: Int = 0
    ) {
        self.promptTokens = promptTokens
        self.completionTokens = completionTokens
        self.totalTokens = totalTokens
        self.messageCount = messageCount
        self.conversationCount = conversationCount
    }
}

public struct AIChatUsageDailyPoint: Decodable, Sendable, Equatable, Identifiable {
    /// `YYYY-MM-DD`（后端 `date`）。
    public let date: String
    public let promptTokens: Int
    public let completionTokens: Int
    public let totalTokens: Int
    public let messageCount: Int

    public var id: String { date }

    public init(
        date: String,
        promptTokens: Int = 0,
        completionTokens: Int = 0,
        totalTokens: Int = 0,
        messageCount: Int = 0
    ) {
        self.date = date
        self.promptTokens = promptTokens
        self.completionTokens = completionTokens
        self.totalTokens = totalTokens
        self.messageCount = messageCount
    }
}

public struct AIChatUsageModelSummary: Decodable, Sendable, Equatable, Identifiable {
    public let model: String
    public let promptTokens: Int
    public let completionTokens: Int
    public let totalTokens: Int
    public let messageCount: Int

    public var id: String { model }

    public init(
        model: String,
        promptTokens: Int = 0,
        completionTokens: Int = 0,
        totalTokens: Int = 0,
        messageCount: Int = 0
    ) {
        self.model = model
        self.promptTokens = promptTokens
        self.completionTokens = completionTokens
        self.totalTokens = totalTokens
        self.messageCount = messageCount
    }
}

/// 最近一次 Celery 快照写入的元信息（判断「数据到哪天为止」）。
public struct AIChatUsageFreshness: Decodable, Sendable, Equatable {
    public let latestDataDate: String?
    public let latestComputedAt: String?

    public init(latestDataDate: String? = nil, latestComputedAt: String? = nil) {
        self.latestDataDate = latestDataDate
        self.latestComputedAt = latestComputedAt
    }
}

/// `GET /api/v1/ai/usage/stats` 的响应。
public struct AIChatUsageStats: Decodable, Sendable, Equatable {
    public let range: String
    public let startDate: String
    public let endDate: String
    public let totals: AIChatUsageTotals
    /// 区间内逐日（**缺失日期后端已补 0 行**，可直接拉直时间轴）。
    public let daily: [AIChatUsageDailyPoint]
    public let byModel: [AIChatUsageModelSummary]
    public let snapshotFreshness: AIChatUsageFreshness

    public init(
        range: String,
        startDate: String,
        endDate: String,
        totals: AIChatUsageTotals = AIChatUsageTotals(),
        daily: [AIChatUsageDailyPoint] = [],
        byModel: [AIChatUsageModelSummary] = [],
        snapshotFreshness: AIChatUsageFreshness = AIChatUsageFreshness()
    ) {
        self.range = range
        self.startDate = startDate
        self.endDate = endDate
        self.totals = totals
        self.daily = daily
        self.byModel = byModel
        self.snapshotFreshness = snapshotFreshness
    }

    public var rangeOption: AIChatUsageRange? { AIChatUsageRange(rawValue: range) }
}

// MARK: - 宽容解码

/// 逐字段的宽松取值（只服务 `search_sources` 这种「声明宽、实际窄」的动态字典）。
extension KeyedDecodingContainer {
    func lenientString(_ key: Key) -> String? {
        if let value = try? decodeIfPresent(String.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Double.self, forKey: key) { return NumberText.plain(value) }
        if let value = try? decodeIfPresent(Bool.self, forKey: key) { return value ? "true" : "false" }
        return nil
    }

    func lenientDouble(_ key: Key) -> Double? {
        if let value = try? decodeIfPresent(Double.self, forKey: key) { return value }
        if let text = try? decodeIfPresent(String.self, forKey: key) { return Double(text) }
        return nil
    }
}
