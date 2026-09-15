import Foundation

/// 本批 12 条端点与「会话片」两组页面的静态口径。
///
/// 端点路径集中在这里而不是散在各调用点：**给 PR 的「端点 → macos 消费点」对照表**
/// 要靠它逐条核对（12 条一条不少、也不多打一条），散开写就只剩人工数。
///
/// 12 条全部挂 `protected`（`require_api_key`，`blf_` 账号 key 直连可用），**零后端新增路由**：
///
/// | # | 端点 | 方法 | 后端出处 |
/// | --- | --- | --- | --- |
/// | 1 | `/ai/config` | GET | `ai_chat.py:51` |
/// | 2 | `/ai/conversations` | GET | `ai_chat.py:80` |
/// | 3 | `/ai/conversations` | POST | `ai_chat.py:101` |
/// | 4 | `/ai/conversations/{id}` | PATCH | `ai_chat.py:130` |
/// | 5 | `/ai/conversations/{id}` | DELETE | `ai_chat.py:118` |
/// | 6 | `/ai/conversations/{id}/messages` | GET | `ai_chat.py:179` |
/// | 7 | `/ai/conversations/{id}/messages/{mid}` | PATCH | `ai_chat.py:210` |
/// | 8 | `/ai/conversations/{id}/messages/{mid}` | DELETE | `ai_chat.py:192` |
/// | 9 | `/ai/conversations/{id}/messages/stream` | POST · SSE | `ai_chat_v2.py:78` |
/// | 10 | `/ai/conversations/{id}/cancel` | POST | `ai_chat_v2.py:357` |
/// | 11 | `/ai/upload` | POST · multipart | `ai_file_upload.py:12` |
/// | 12 | `/ai/usage/stats` | GET | `ai_chat_usage.py:49` |
///
/// **不做** `POST /ai/conversations/{id}/regenerate-title`（`ai_chat.py:149`）：它真花 AI
/// 配额、Web 只是次要入口，归 S6 的配额类写。
public enum AIChatCatalog {
    /// 两条页面的 route id（= `NavigationItem.id` = 模块任务作用域的 key）。
    public static let chatRouteID = "/dashboard/ai/chat"
    public static let customerServiceRouteID = "/dashboard/ai/customer-service"

    // MARK: - 端点

    public static let configEndpoint = "/ai/config"
    public static let conversationsEndpoint = "/ai/conversations"
    public static let uploadEndpoint = "/ai/upload"
    public static let usageStatsEndpoint = "/ai/usage/stats"

    public static func conversationEndpoint(id: Int) -> String {
        "\(conversationsEndpoint)/\(id)"
    }

    public static func messagesEndpoint(conversationID: Int) -> String {
        "\(conversationEndpoint(id: conversationID))/messages"
    }

    public static func messageEndpoint(conversationID: Int, messageID: Int) -> String {
        "\(messagesEndpoint(conversationID: conversationID))/\(messageID)"
    }

    /// `POST` + SSE：发送一条消息并消费流式回复（12 条里唯一带 body 的流）。
    public static func streamEndpoint(conversationID: Int) -> String {
        "\(messagesEndpoint(conversationID: conversationID))/stream"
    }

    /// 跨 worker 取消（`RedisCancelRegistry` 的 GETDEL）。
    public static func cancelEndpoint(conversationID: Int) -> String {
        "\(conversationEndpoint(id: conversationID))/cancel"
    }

    /// 本批**显式不做**的端点（写在代码里，免得下批以为是漏了）。
    public static func regenerateTitleEndpoint(conversationID: Int) -> String {
        "\(conversationEndpoint(id: conversationID))/regenerate-title"
    }

    // MARK: - 输入约束（照抄后端 Pydantic，客户端不越界）

    /// `MessageCreate.content` 的 `max_length`。
    public static let maxMessageLength = 8000
    /// `MessageCreate.attached_file_content` 的 `max_length`。
    public static let maxAttachedFileContentLength = 55000
    /// `ConversationCreate.title` 的 `max_length`。
    public static let maxConversationTitleLength = 255
    /// `POST /ai/upload` 的 multipart 字段名（`file: UploadFile = File(...)`）。
    public static let uploadFieldName = "file"

    /// 推理档（后端 `normalize_reasoning_effort` 只认这三个 + None）。
    public static let reasoningEfforts: [String] = ["low", "medium", "high"]

    public static func reasoningEffortLabel(_ value: String) -> String {
        switch value {
        case "low": return "低"
        case "medium": return "中"
        case "high": return "高"
        default: return value
        }
    }

    /// 「新对话」默认标题 —— 后端首轮自动改名（`DEFAULT_CONVERSATION_TITLE`）的判据。
    public static let defaultConversationTitle = "新对话"
}

// MARK: - Prompt 预设（复刻 frontend/lib/server/ai-chat.ts）

/// 一条 prompt 预设的摘要（`PromptPresetSummary`）。
public struct AIChatPromptOption: Sendable, Equatable, Identifiable, Hashable {
    public let id: String
    public let label: String
    public let description: String
    /// 真正的注入内容（摘要不含它）。
    public let content: String

    public init(id: String, label: String, description: String, content: String = "") {
        self.id = id
        self.label = label
        self.description = description
        self.content = content
    }
}

/// 客服交流的场景字段（`ScenarioField`）。
public struct AIChatScenarioField: Sendable, Equatable, Identifiable, Hashable {
    public enum FieldType: String, Sendable, Equatable, Hashable {
        case textarea
        case text
        case select
    }

    public struct Option: Sendable, Equatable, Hashable, Identifiable {
        public let value: String
        public let label: String
        public var id: String { value }

        public init(value: String, label: String) {
            self.value = value
            self.label = label
        }
    }

    public let key: String
    public let label: String
    public let type: FieldType
    public let placeholder: String?
    public let options: [Option]
    public let isRequired: Bool

    public var id: String { key }

    public init(
        key: String,
        label: String,
        type: FieldType,
        placeholder: String? = nil,
        options: [Option] = [],
        isRequired: Bool = false
    ) {
        self.key = key
        self.label = label
        self.type = type
        self.placeholder = placeholder
        self.options = options
        self.isRequired = isRequired
    }
}

/// 客服交流的语气档（`ToneOption`）。
public struct AIChatToneOption: Sendable, Equatable, Identifiable, Hashable {
    public let id: String
    public let label: String
    public let description: String
    /// 注入 system prompt 的语气指令。
    public let promptSuffix: String

    public init(id: String, label: String, description: String, promptSuffix: String) {
        self.id = id
        self.label = label
        self.description = description
        self.promptSuffix = promptSuffix
    }
}

/// 客服交流的场景（`ScenarioPreset`）。
public struct AIChatScenario: Sendable, Equatable, Identifiable, Hashable {
    public enum Mode: String, Sendable, Equatable, Hashable {
        case refine
        case compose
    }

    public let id: String
    public let label: String
    public let description: String
    public let mode: Mode
    public let systemPrompt: String
    public let inputSchema: [AIChatScenarioField]
    /// 是否显示自由粘贴区（`refine` 场景为 true）。
    public let showFreeTextArea: Bool
    public let outputFormat: String
    public let toneOptions: [AIChatToneOption]
    public let languageToggle: Bool
    /// 占位但未上线（如「邮件撰写」）—— 选项置灰、不可生成。
    public let isDisabled: Bool

    public init(
        id: String,
        label: String,
        description: String,
        mode: Mode,
        systemPrompt: String,
        inputSchema: [AIChatScenarioField] = [],
        showFreeTextArea: Bool,
        outputFormat: String,
        toneOptions: [AIChatToneOption] = [],
        languageToggle: Bool = false,
        isDisabled: Bool = false
    ) {
        self.id = id
        self.label = label
        self.description = description
        self.mode = mode
        self.systemPrompt = systemPrompt
        self.inputSchema = inputSchema
        self.showFreeTextArea = showFreeTextArea
        self.outputFormat = outputFormat
        self.toneOptions = toneOptions
        self.languageToggle = languageToggle
        self.isDisabled = isDisabled
    }
}

/// 篇幅档与语言档（`LENGTH_INSTRUCTIONS` / `LANGUAGE_INSTRUCTIONS`）。
public enum AIChatLength: String, Sendable, Equatable, CaseIterable, Identifiable {
    case brief
    case standard
    case detailed

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .brief: return "简短"
        case .standard: return "适中"
        case .detailed: return "详细"
        }
    }

    public var instruction: String {
        switch self {
        case .brief: return "篇幅尽量短：结论 + 要点，适合快速同步。"
        case .standard: return "篇幅适中：结构完整但不冗长。"
        case .detailed: return "篇幅可以较长：展开原因、依据与细节。"
        }
    }
}

public enum AIChatLanguage: String, Sendable, Equatable, CaseIterable, Identifiable {
    case zh
    case en

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .zh: return "中文"
        case .en: return "English"
        }
    }

    public var instruction: String {
        switch self {
        case .zh: return "用中文输出。"
        case .en: return "Respond in English."
        }
    }
}

/// Prompt / 场景预设目录 —— `frontend/lib/server/ai-chat.ts` 的 Swift 复刻。
///
/// **为什么要在桌面端复刻**：这些预设**不是后端数据**，而是 Next.js 服务端的常量
/// （`getPromptPresetSummaries` / `buildScenarioSystemPrompt` 都在 `lib/server/ai-chat.ts`，
/// 由 `/api/ai-chat/*` 路由拼进请求或响应）。桌面端直连 FastAPI，拿不到它们 ——
/// 不复刻就只能砍掉「结构化 prompt / 客服场景」这两块 Web 已有的能力。
///
/// 复刻的边界：**只搬常量与拼接规则**，不搬 `lucide-react` 图标（那是渲染细节，
/// 桌面端用自己的 SF Symbol）。`AIChatCatalogTests`（`AIChatDecodingTests` 内）逐条钉住
/// 这些常量，Web 改了这里就会报红。
public enum AIChatPresetCatalog {
    /// 无场景时的兜底（`buildScenarioSystemPrompt` 的 fallback 分支）。
    public static let fallbackSystemPrompt =
        "你是一个乐于助人的智能助手。请使用中文回答问题，尽可能提供准确、有用的信息。"

    /// 通用对话的基础指令（`buildSystemPrompt` 的第一段）。
    public static let baseInstruction =
        "你是一个乐于助人的智能助手。请使用中文回答问题，尽可能提供准确、有用的信息。如果不确定，请如实说明。"

    /// 摘要档（`OVERVIEW_PROMPT_PRESETS`）。
    public static let overviewOptions: [AIChatPromptOption] = [
        AIChatPromptOption(
            id: "overview-structured",
            label: "结构化·先说结论",
            description: "先给出结论要点，再展开说明。",
            content: "回答时先输出一个标题为”总结”的章节，用 3-5 条要点先给出结论、要点和主要建议。"
        ),
        AIChatPromptOption(
            id: "overview-brief",
            label: "结构化·简洁",
            description: "用简洁的语言概括核心结论。",
            content: "回答时先输出一个标题为”总结”的章节，用精炼的语言概括核心结论和主要建议。"
        ),
    ]

    /// 展开档（`DETAIL_PROMPT_PRESETS`）。
    public static let detailOptions: [AIChatPromptOption] = [
        AIChatPromptOption(
            id: "detail-standard",
            label: "展开·标准",
            description: "补充原因、证据和进一步说明。",
            content: "回答时还必须输出一个标题为”详细说明”的章节，展开说明原因拆解、关键依据和补充信息。"
        ),
        AIChatPromptOption(
            id: "detail-stepped",
            label: "展开·分步骤",
            description: "按步骤或分点结构展开说明。",
            content: "回答时还必须输出一个标题为”详细说明”的章节，按”步骤/分点”结构展开每个要点。"
        ),
    ]

    /// 客服交流场景（`SCENARIO_PRESETS`，逐字段照抄）。
    public static let scenarios: [AIChatScenario] = [
        AIChatScenario(
            id: "ops-report",
            label: "运营汇报话术",
            description: "亚马逊运营视角，向直属主管汇报数据与结论。",
            mode: .refine,
            systemPrompt: "你是一名资深的亚马逊运营专家，擅长把运营数据转化为清晰、专业、有结论的汇报话术。"
                + "受众是你的直属主管。请严格遵循结构：结论先行 → 数据支撑 → 风险/异常 → 下一步建议。",
            inputSchema: [
                AIChatScenarioField(key: "period", label: "汇报周期", type: .text, placeholder: "如：本周 / 本月"),
                AIChatScenarioField(
                    key: "metrics",
                    label: "核心指标",
                    type: .textarea,
                    placeholder: "销售额 / 订单量 / ACOS / 广告花费 / 利润"
                ),
                AIChatScenarioField(
                    key: "risks",
                    label: "重点事项或异常",
                    type: .textarea,
                    placeholder: "库存告警、排名波动等"
                ),
                AIChatScenarioField(key: "next", label: "下一步计划", type: .textarea, placeholder: "准备做的事"),
            ],
            showFreeTextArea: true,
            outputFormat: "结论先行 → 数据支撑 → 风险/异常 → 下一步建议",
            toneOptions: [
                AIChatToneOption(
                    id: "brief",
                    label: "简洁周报版",
                    description: "一句话结论 + 要点，适合群里快速同步",
                    promptSuffix: "输出简洁的周报版：先一句话结论，再列 3-5 条要点，控制在 200 字以内。"
                ),
                AIChatToneOption(
                    id: "formal",
                    label: "正式报告版",
                    description: "完整结构化报告，适合正式汇报",
                    promptSuffix: "输出正式报告版：完整的结构化段落（结论 / 数据支撑 / 风险异常 / 下一步），用词正式、严谨。"
                ),
                AIChatToneOption(
                    id: "verbal",
                    label: "口头汇报版",
                    description: "口语化、可照读",
                    promptSuffix: "输出口头汇报版：口语化、自然，像当面汇报一样，可直接照着说。"
                ),
            ],
            languageToggle: true
        ),
        AIChatScenario(
            id: "email-compose",
            label: "邮件撰写",
            description: "面向消费者的邮件拟定（即将上线）。",
            mode: .compose,
            systemPrompt: "你是一名专业的客服邮件撰写者，擅长根据上下文为真实消费者拟定邮件。受众是消费者。",
            inputSchema: [
                AIChatScenarioField(
                    key: "recipient",
                    label: "收件人角色 / 场景",
                    type: .text,
                    placeholder: "如：已下单未付款客户"
                ),
                AIChatScenarioField(
                    key: "purpose",
                    label: "邮件目的",
                    type: .text,
                    placeholder: "催付 / 安抚 / 召回 / 通知"
                ),
                AIChatScenarioField(key: "points", label: "关键内容要点", type: .textarea, placeholder: "要传达的核心信息"),
            ],
            showFreeTextArea: false,
            outputFormat: "主题 + 正文",
            toneOptions: [],
            languageToggle: true,
            isDisabled: true
        ),
    ]

    /// 「AI Chat」默认场景 = `ops-report`（Web 的客服交流页首屏选中第一个可用场景）。
    public static var defaultScenarioID: String { scenarios.first { !$0.isDisabled }?.id ?? "" }

    public static func scenario(id: String?) -> AIChatScenario? {
        guard let id, !id.isEmpty else { return nil }
        return scenarios.first { $0.id == id }
    }

    public static func tone(scenarioID: String?, toneID: String?) -> AIChatToneOption? {
        guard let scenario = scenario(id: scenarioID), let toneID else { return nil }
        return scenario.toneOptions.first { $0.id == toneID }
    }

    // MARK: - 拼接规则（与 lib/server/ai-chat.ts 逐字对齐）

    static func promptOption(_ options: [AIChatPromptOption], id: String?) -> AIChatPromptOption? {
        guard let id, !id.isEmpty, id != "none" else { return nil }
        return options.first { $0.id == id }
    }

    /// `buildSystemPrompt(overviewPromptId, detailPromptId)`。
    public static func buildSystemPrompt(overviewID: String?, detailID: String?) -> String {
        var parts = [baseInstruction]
        if let overview = promptOption(overviewOptions, id: overviewID) { parts.append(overview.content) }
        if let detail = promptOption(detailOptions, id: detailID) { parts.append(detail.content) }
        return parts.joined(separator: "\n\n")
    }

    /// `buildScenarioSystemPrompt(scenarioId, toneId, language, length)`。
    public static func buildScenarioSystemPrompt(
        scenarioID: String?,
        toneID: String?,
        language: AIChatLanguage?,
        length: AIChatLength?
    ) -> String {
        guard let scenario = scenario(id: scenarioID) else { return fallbackSystemPrompt }
        var parts = [scenario.systemPrompt]
        if let tone = tone(scenarioID: scenarioID, toneID: toneID) { parts.append(tone.promptSuffix) }
        if let length { parts.append(length.instruction) }
        if let language { parts.append(language.instruction) }
        return parts.joined(separator: "\n\n")
    }

    /// `validatePromptPresetIds` 的等价判定（发请求前本地拦一次，免得白跑一次 400）。
    public static func isValidPromptIDs(overviewID: String?, detailID: String?) -> Bool {
        let overviewOK = !(overviewID?.trimmedNonEmpty.map { id in
            id != "none" && promptOption(overviewOptions, id: id) == nil
        } ?? false)
        let detailOK = !(detailID?.trimmedNonEmpty.map { id in
            id != "none" && promptOption(detailOptions, id: id) == nil
        } ?? false)
        return overviewOK && detailOK
    }

    /// `validateScenarioIds` 的等价判定。
    ///
    /// 后端代理的三条规则照抄：无场景 = 通过；场景不存在或已停用 = 不通过；
    /// 有语气则必须属于该场景。
    public static func isValidScenarioIDs(scenarioID: String?, toneID: String?) -> Bool {
        guard let id = scenarioID?.trimmedNonEmpty else { return true }
        guard let scenario = scenario(id: id), !scenario.isDisabled else { return false }
        guard let toneID = toneID?.trimmedNonEmpty else { return true }
        return scenario.toneOptions.contains { $0.id == toneID }
    }

    // MARK: - 用户内容拼接（frontend/components/customer-service/build-prompt.ts）

    /// `buildUserContent({freeText, guidedFields, schema})`。
    ///
    /// 输出形状必须逐字一致：Web 与桌面端对着同一个后端、同一个场景，
    /// 拼出来的 prompt 不同就等于「同一件事两种结果」。
    public static func buildUserContent(
        freeText: String,
        guidedFields: [String: String],
        schema: [AIChatScenarioField]
    ) -> String {
        var sections: [String] = []
        let free = freeText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !free.isEmpty { sections.append("【原始内容】\n\(free)") }

        let filled = schema.compactMap { field -> (label: String, value: String)? in
            let value = (guidedFields[field.key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { return nil }
            return (field.label, value)
        }
        if !filled.isEmpty {
            let lines = filled.map { "- \($0.label)：\($0.value)" }.joined(separator: "\n")
            sections.append("【补充信息】\n\(lines)")
        }
        return sections.joined(separator: "\n\n")
    }
}
