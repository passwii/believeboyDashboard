import Foundation

/// 一个数据面的加载阶段（AI 会话片两页共用）。
///
/// 与广告两页的 `AdLoadPhase` 同形但**不复用**：那两个类型住 `Ads/` 域，AI 会话片引用它
/// 会把「广告页的面板状态」变成两个业务域的公共依赖（S5.5 / S5.6 再抄一次就会三处耦合）。
public enum AIChatPhase: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case failed(String)

    public var isLoading: Bool { self == .loading }

    public var failureMessage: String? {
        if case .failed(let message) = self { return message }
        return nil
    }

    public var isLoaded: Bool { self == .loaded }
}

/// 「空态」的两种成因 —— **必须区分**，这是本批口径 3 的落点。
///
/// 后端 `GET /ai/conversations` 对「缺 `X-User-Id`」的处理是**静默返回空表**
/// （`ai_chat.py:31` 的 `_get_request_user_id` → `None` → service 层按「无归属」处理），
/// 与「这个账号真的一个会话都没有」的响应**一模一样**（都是 `[]`）。
/// 渲染成同一个「暂无会话」就把一个配置问题伪装成了正常空态 —— 用户会一直等一个永远不会
/// 出现的会话，而真正要做的是重新登录。
public enum AIChatInboxState: Equatable, Sendable {
    /// 还在拉取（或还没开始）。
    case pending
    /// 拉取失败（有旧列表时走「刷新失败」提示，不落这里）。
    case failed(String)
    /// **未声明账号**：请求没带 `X-User-Id`（未登录 / 档案缺 id）→ 后端按无归属过滤。
    case undeclaredAccount
    /// 已声明账号，后端确实返回空表。
    case noConversations
    case ready
}

/// 会话归属的判定依据（由视图从 `AppModel` 传入，见口径 3）。
public enum AIChatIdentity: Sendable, Equatable {
    /// 登录档案里有 `id` → 会发 `X-User-Id`，后端的过滤是有效的。
    case declared(userID: String)
    /// 没有可发的 `X-User-Id`（未登录，或档案缺 id）。
    case undeclared

    public var isDeclared: Bool {
        if case .declared = self { return true }
        return false
    }

    public var userID: String? {
        if case .declared(let userID) = self { return userID }
        return nil
    }
}

/// 附件解析的三态（`POST /ai/upload` 的结果）。
public enum AIChatAttachment: Equatable, Sendable {
    case none
    case parsing(filename: String)
    /// 解析成功：`content` 会被回填进发送体的 `attached_file_content`。
    case parsed(filename: String, content: String, truncated: Bool, note: String?)
    case failed(filename: String, message: String)

    public var filename: String? {
        switch self {
        case .none: return nil
        case .parsing(let filename), .failed(let filename, _): return filename
        case .parsed(let filename, _, _, _): return filename
        }
    }

    public var parsedContent: String? {
        if case .parsed(_, let content, _, _) = self { return content }
        return nil
    }

    public var isParsing: Bool {
        if case .parsing = self { return true }
        return false
    }

    public var failureMessage: String? {
        if case .failed(_, let message) = self { return message }
        return nil
    }

    /// 附件里的正文会不会顶到 `MessageCreate.attached_file_content` 的 55000 上限。
    public func exceedsPayloadLimit() -> Bool {
        guard let content = parsedContent else { return false }
        return content.count > AIChatCatalog.maxAttachedFileContentLength
    }
}

/// AI Chat 页的输入区状态（住在 store 里：切走再回来应当原处）。
public struct AIChatComposer: Equatable, Sendable {
    public var text: String = ""
    /// 选中的模型（`nil` = 用后端的 `defaultModel`）。
    public var model: String?
    /// 推理档（`low` / `medium` / `high`）。
    public var reasoningEffort: String?
    /// 联网搜索开关（`regenerate` 的后端前置条件，见口径 7）。
    public var webSearchEnabled: Bool = false
    /// 结构化 prompt 命中项（`overview` / `detail`；`nil` 或 `"none"` = 不注入）。
    public var overviewPromptID: String?
    public var detailPromptID: String?
    public var attachment: AIChatAttachment = .none

    public init() {}

    /// 一次发送实际会用的 system prompt（与 Web 的 `buildSystemPrompt` 逐字一致）。
    public var systemPrompt: String {
        AIChatPresetCatalog.buildSystemPrompt(
            overviewID: overviewPromptID,
            detailID: detailPromptID
        )
    }

    /// 输入是否合法可发（内容非空、未超长、没有正在解析的附件）。
    public var canSend: Bool {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        guard text.count <= AIChatCatalog.maxMessageLength else { return false }
        guard !attachment.isParsing else { return false }
        if case .failed = attachment { return false }
        return true
    }

    /// 输入超长的提示（`nil` = 没超）。
    public var lengthWarning: String? {
        text.count > AIChatCatalog.maxMessageLength
            ? "内容 \(text.count) 字，超过后端上限 \(AIChatCatalog.maxMessageLength) 字 —— 发出去会被 422 拒。"
            : nil
    }
}

/// 需要二次确认的破坏性操作（口径 7：只有删除类要确认）。
public enum AIChatConfirmation: Equatable, Sendable, Identifiable {
    case deleteConversation(id: Int, title: String)
    case deleteMessage(id: Int, preview: String)

    public var id: String {
        switch self {
        case .deleteConversation(let id, _): return "conversation-\(id)"
        case .deleteMessage(let id, _): return "message-\(id)"
        }
    }

    public var title: String {
        switch self {
        case .deleteConversation: return "删除这个会话？"
        case .deleteMessage: return "删除这条消息？"
        }
    }

    public var message: String {
        switch self {
        case .deleteConversation(_, let title):
            return "「\(title)」及其全部消息会被永久删除（后端是硬删，没有回收站）。"
        case .deleteMessage(_, let preview):
            return "「\(preview)」会被永久删除（后端是硬删，没有回收站）。"
        }
    }

    public var confirmLabel: String { "删除" }
}
