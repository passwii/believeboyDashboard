import BelieveBoyKit
import Foundation
import Observation

/// 「AI 智能 → AI Chat」的视图状态：会话列表 + 消息历史 + POST-SSE 流式生成 + 用量面板。
///
/// 六条口径决定了这个 store 的形状（见 issue BLF-1065）：
///
/// 1. **POST-SSE 不是新一套**：流走 `APIClient.stream(method:body:)`（S5.4 给既有 SSE
///    消费者加的两个带默认值的参数），帧解析、超时档、取消语义全部复用。
/// 2. **续传在同一个 POST 上**：`resumeCursor` 记住最后一帧的 `id:`，重连时**同时**带
///    `Last-Event-ID` 与同一份 body（`ai_chat_v2.py:96` 读游标，但 `payload` 是必填）。
/// 3. **空态分两种**（`AIChatInboxState`）：缺 `X-User-Id` 时后端静默返回空表，与「真的
///    没有会话」同形 —— 靠 `identity` 区分，不渲染成同一个空态。
/// 4. **三态 + 取消**：加载 / 空 / 错误 + 重试；有旧数据时刷新失败保留旧列表；切会话、
///    切模块、停止生成都取消在跑请求（**含拆 SSE 连接**）且不落错误态。
/// 5. **分层超时**由 `AIChatClient` 承担（流 `.stream` / 元数据 `.list` / 上传 `.report`）。
/// 6. **写面口径**：删除单条消息、删除整个会话给二次确认；其余（新建 / 重命名 / 编辑）
///    直接执行 —— 与 Web 同口径。
///
/// 状态住在 `NavigationStore`（不是视图）：视图是值类型，重绘即重建 —— 放视图里等于
/// 「切走再回来 = 重新拉 + 丢掉当前会话与输入框」。
@MainActor
@Observable
public final class AIChatStore {
    /// 任务 key 的用途后缀（外壳切模块时按 `routeID` 整棵树取消，见 `ModuleTaskScope.cancelTree`）。
    public enum TaskPurpose {
        public static let inbox = "inbox"
        public static let messages = "messages"
        public static let stream = "stream"
        public static let cancel = "cancel"
        public static let usage = "usage"
        public static let upload = "upload"
        public static let mutation = "mutation"

        public static func key(_ routeID: String, _ purpose: String) -> String {
            "\(routeID):\(purpose)"
        }
    }

    // MARK: - 会话列表（端点 2 / 3 / 4 / 5）

    public private(set) var conversationsPhase: AIChatPhase = .idle
    public private(set) var conversations: [AIChatConversation] = []
    /// 有旧列表、但最近一次刷新失败的提示（口径 4：保留旧列表）。
    public private(set) var conversationsRefreshFailure: String?
    /// 账号归属（口径 3）。
    public private(set) var identity: AIChatIdentity = .undeclared

    // MARK: - 配置（端点 1）

    public private(set) var configPhase: AIChatPhase = .idle
    public private(set) var config: AIChatConfig?

    // MARK: - 当前会话与消息（端点 6 / 7 / 8）

    public private(set) var selectedConversationID: Int?
    public private(set) var messagesPhase: AIChatPhase = .idle
    public private(set) var messages: [AIChatMessage] = []
    public private(set) var messagesRefreshFailure: String?

    // MARK: - 流式生成（端点 9 / 10）

    /// 当前这一轮的流式草稿（纯逻辑累加器，见 `AIChatTurnAccumulator`）。
    public private(set) var draft = AIChatTurnAccumulator()
    public private(set) var isStreaming = false
    public private(set) var isStopping = false

    /// 一条流的身份：归属会话 + 唯一 token。
    ///
    /// **为什么需要它**：取消是异步的 —— 切会话 / 新建会话 / 停止生成之后，旧流的帧
    /// （甚至带 `done` 的那一帧）仍可能到达，而 `draft` / `resumeCursor` / `streamError`
    /// 是**当前页面**的展示面。归属一旦摘掉，旧流的任何回调都不再被采信，跨会话串写
    /// （旧会话的标题 / token 落到新会话、旧草稿画在新会话上）就无从发生。
    ///
    /// token 不能省：同一个 `conversationID` 会有先后两条流（切走再切回来重发），只比
    /// 会话 id 会把「旧流的收尾」误认成「新流的收尾」，从而改写新流的状态。
    private struct StreamLease: Equatable {
        let conversationID: Int
        let token: UUID
    }

    /// 当前这条流的归属（`nil` = 没有在跑的流）。**只有它**能写流式状态。
    private var streamLease: StreamLease?

    /// 这条流属于哪个会话（`nil` = 没有在跑的流）。视图与用例用它判断归属。
    public var streamingConversationID: Int? { streamLease?.conversationID }

    /// 流式失败的一次性提示（生成中的传输错误 / 后端 `error` 事件）。
    public private(set) var streamError: String?
    /// 已收帧的续传游标（Redis Stream entry id）；`nil` = 还没有可续的游标。
    public private(set) var resumeCursor: String?
    /// 上一次发送的载荷 —— 续传必须重发同一份 body（口径 2）。
    public private(set) var lastSentPayload: AIChatSendPayload?
    /// 本次流经历过的事件类型序列（「同源同结构」的断言面，也在 UI 上做调试信息）。
    public private(set) var lastEventKinds: [String] = []

    // MARK: - 输入区

    public private(set) var composer = AIChatComposer()

    // MARK: - 用量（端点 12）

    public private(set) var usageRange: AIChatUsageRange = .thirtyDays
    public private(set) var usagePhase: AIChatPhase = .idle
    public private(set) var usage: AIChatUsageStats?

    // MARK: - 附件（端点 11）

    public private(set) var uploadToken: UUID?

    // MARK: - 二次确认（口径 6）

    public private(set) var pendingConfirmation: AIChatConfirmation?

    // MARK: - 派生

    /// 会话列表的空态判定（口径 3）。
    public var inboxState: AIChatInboxState {
        if let message = conversationsPhase.failureMessage, conversations.isEmpty {
            return .failed(message)
        }
        guard conversationsPhase.isLoaded else { return .pending }
        if !identity.isDeclared { return .undeclaredAccount }
        return conversations.isEmpty ? .noConversations : .ready
    }

    /// 当前选中的会话（列表里可能还没有它 —— 刚新建时还没回读列表）。
    public var selectedConversation: AIChatConversation? {
        guard let id = selectedConversationID else { return nil }
        return conversations.first { $0.id == id }
    }

    /// 消息区空态：还没有选中会话 / 选中了但没有消息 / 加载中 / 失败。
    public enum MessageAreaState: Equatable {
        case noConversation
        case loading
        case failed(String)
        case empty
        case ready
    }

    public var messageAreaState: MessageAreaState {
        guard selectedConversationID != nil else { return .noConversation }
        if !messages.isEmpty { return .ready }
        if let message = messagesPhase.failureMessage { return .failed(message) }
        if messagesPhase.isLoading || messagesPhase == .idle { return .loading }
        return .empty
    }

    /// 生成中但还没有正文（显示「思考中…」而不是空消息）。
    public var isAwaitingFirstToken: Bool {
        isStreaming && !draft.hasVisibleText && draft.thinking.isEmpty
    }

    /// 配置有没有就绪到「可以发请求」的程度。
    public var providerReady: Bool { config?.providerConfigured ?? false }

    /// 模型下拉的候选项（`nil` 表示「用后端默认」）。
    public var modelOptions: [String] {
        config?.models ?? []
    }

    /// 生效的模型名（展示用）。
    public var effectiveModelLabel: String {
        composer.model ?? config?.defaultModel ?? "（未取到配置）"
    }

    public var canSend: Bool {
        providerReady && composer.canSend && selectedConversationID != nil && !isStreaming
    }

    /// 用量面板的标题（含「上界」口径说明，不让 ∑distinct 被读成不重复会话数）。
    public var usageHeadline: String? {
        guard let usage else { return nil }
        return "\(usage.startDate) ~ \(usage.endDate) · 共 \(AIChatFormatting.integer(usage.totals.totalTokens)) tokens"
    }

    public init() {}

    // MARK: - 输入区命令

    public func setText(_ text: String) {
        composer.text = text
    }

    public func setModel(_ model: String?) {
        composer.model = model?.trimmedNonEmpty
    }

    public func setReasoningEffort(_ effort: String?) {
        composer.reasoningEffort = effort?.trimmedNonEmpty
    }

    public func setWebSearchEnabled(_ enabled: Bool) {
        composer.webSearchEnabled = enabled
    }

    public func setOverviewPromptID(_ id: String?) {
        composer.overviewPromptID = id
    }

    public func setDetailPromptID(_ id: String?) {
        composer.detailPromptID = id
    }

    public func clearAttachment() {
        composer.attachment = .none
    }

    // MARK: - 就地重命名 / 编辑（需要的“正在进行”状态只能住 store：视图无属性包装器）

    public private(set) var renameTargetID: Int?
    public private(set) var renameDraft: String = ""
    public private(set) var editTargetID: Int?
    public private(set) var editDraft: String = ""

    public func beginRename(id: Int, current: String) {
        renameTargetID = id
        renameDraft = current
    }

    public func setRenameDraft(_ value: String) {
        renameDraft = value
    }

    public func cancelRename() {
        renameTargetID = nil
        renameDraft = ""
    }

    public func beginEdit(id: Int, current: String) {
        editTargetID = id
        editDraft = current
    }

    public func setEditDraft(_ value: String) {
        editDraft = value
    }

    public func cancelEdit() {
        editTargetID = nil
        editDraft = ""
    }

    /// 一次性消费流式错误（`NoticeRow` 的关闭按钮）。
    public func clearStreamError() {
        streamError = nil
    }

    // MARK: - 二次确认

    public func requestDelete(conversation: AIChatConversation) {
        pendingConfirmation = .deleteConversation(id: conversation.id, title: conversation.title)
    }

    public func requestDelete(message: AIChatMessage) {
        let preview = message.content.trimmingCharacters(in: .whitespacesAndNewlines)
        let clipped = preview.count > 24 ? String(preview.prefix(24)) + "…" : preview
        pendingConfirmation = .deleteMessage(id: message.id, preview: clipped.isEmpty ? "（空消息）" : clipped)
    }

    public func dismissConfirmation() {
        pendingConfirmation = nil
    }

    // MARK: - 加载：配置 + 会话列表 + 用量（进页一次）

    /// 进页加载：配置 → 会话列表 →（选中第一个会话）→ 用量。
    ///
    /// 三条任务**各自登记**在不同的子 key 下：它们互不取消（配置失败不该把会话列表一并
    /// 取消），而切模块时由外壳按 route id 整棵树收掉（口径 4）。
    public func load(
        using provider: AIChatDataProviding,
        scope: ModuleTaskScope,
        routeID: String,
        identity: AIChatIdentity,
        now: Date = Date()
    ) async {
        self.identity = identity
        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.inbox)) { [weak self] in
            await self?.loadConversations(using: provider)
        }.value
        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.messages)) { [weak self] in
            await self?.selectFirstIfNeeded(using: provider, scope: scope, routeID: routeID)
        }.value
        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.usage)) { [weak self] in
            await self?.loadInitialUsage(using: provider)
        }.value
    }
    /// 会话列表（口径 3 / 4）。
    ///
    /// `identity` 传 nil = 沿用上次的（重试 / 刷新路径）；显式传入时同时更新归属判定 ——
    /// 空态文案取的就是它。
    func loadConversations(using provider: AIChatDataProviding, identity: AIChatIdentity? = nil) async {
        if let identity { self.identity = identity }
        // 未声明账号时**照样发请求**：后端会返回空表，这是「可达性」的一部分（不因本地
        // 判断就跳过端点）。但空态文案由 `identity` 决定 —— 这正是「区分两种空」的做法。
        if conversations.isEmpty { conversationsPhase = .loading }
        let outcome = await Self.capture { try await provider.conversations() }
        guard !Task.isCancelled else { return abandonConversations() }

        switch outcome {
        case .success(let list):
            conversations = list
            conversationsPhase = .loaded
            conversationsRefreshFailure = nil
            // 选中的会话被删掉（或在别处删了）→ 退回未选。
            if let id = selectedConversationID, !list.contains(where: { $0.id == id }) {
                selectedConversationID = nil
                messages = []
                messagesPhase = .idle
            }
        case .failure(let failure):
            if conversations.isEmpty {
                conversationsPhase = .failed(failure.message)
                conversationsRefreshFailure = nil
            } else {
                conversationsPhase = .loaded
                conversationsRefreshFailure = failure.message
            }
        }
    }

    /// 配置（端点 1）。失败**不影响**会话列表与消息：配置只决定模型选择器与
    /// 「后端未配置 provider」的提示。
    func loadConfig(using provider: AIChatDataProviding) async {
        configPhase = .loading
        let outcome = await Self.capture { try await provider.config() }
        guard !Task.isCancelled else {
            configPhase = config == nil ? .idle : .loaded
            return
        }
        switch outcome {
        case .success(let config):
            self.config = config
            configPhase = .loaded
        case .failure(let failure):
            configPhase = .failed(failure.message)
        }
    }

    /// 收尾后的回读（`load` 内的「选中第一个」段）。
    ///
    /// 序号上的依赖：没有会话列表就没有可选中的会话，所以这一段必须在会话列表那一段之后。
    private func selectFirstIfNeeded(
        using provider: AIChatDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        if config == nil { await loadConfig(using: provider) }
        guard selectedConversationID == nil else { return }
        guard let first = conversations.first else { return }
        await selectConversation(id: first.id, using: provider, scope: scope, routeID: routeID)
    }

    // MARK: - 会话切换与消息历史（端点 6）

    /// 切换会话：**先取消上一个会话相关的一切在跑任务**（消息历史 + 流），再拉新的历史。
    ///
    /// 切会话要拆掉正在跑的 SSE：那条流属于上一个会话，让它继续写 `draft` 会把 A 会话的
    /// 回答渲染到 B 会话的界面上。取消**不落错误态**（口径 4）。
    public func selectConversation(
        id: Int,
        using provider: AIChatDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        guard selectedConversationID != id else { return }
        // 先拆掉上一会话的流**并作废它的流式状态**：只拆连接不够 —— 旧会话的半截回答会
        // 画在新会话上，`resume` 还可能把旧会话的载荷续到新会话的流上。
        discardStreamState(scope: scope, routeID: routeID)
        selectedConversationID = id
        messages = []
        messagesPhase = .idle
        messagesRefreshFailure = nil
        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.messages)) { [weak self] in
            await self?.loadMessages(conversationID: id, using: provider)
        }.value
    }

    func loadMessages(conversationID: Int, using provider: AIChatDataProviding) async {
        messagesPhase = messages.isEmpty ? .loading : .loaded
        let outcome = await Self.capture { try await provider.messages(conversationID: conversationID) }
        // 切会话 / 切模块的取消：不落错误态、不动已有列表（口径 4）。
        guard !Task.isCancelled, selectedConversationID == conversationID else {
            return abandonMessages()
        }
        switch outcome {
        case .success(let list):
            messages = list
            messagesPhase = .loaded
            messagesRefreshFailure = nil
        case .failure(let failure):
            if messages.isEmpty {
                messagesPhase = .failed(failure.message)
                messagesRefreshFailure = nil
            } else {
                messagesPhase = .loaded
                messagesRefreshFailure = failure.message
            }
        }
    }

    /// 手动重试当前会话的消息历史。
    public func retryMessages(
        using provider: AIChatDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        guard let id = selectedConversationID else { return }
        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.messages)) { [weak self] in
            await self?.loadMessages(conversationID: id, using: provider)
        }.value
    }

    // MARK: - 新建 / 重命名 / 删除会话（端点 3 / 4 / 5）

    /// 新建会话并选中它（Web 的「新对话」按钮）。
    ///
    /// 没有返回值：新会话的选中态由这里直接落地（与 S5.1/S5.2 同形 —— 请求跑在
    /// `ModuleTaskScope` 里、状态在任务内写，调用方不需要把结果搬出来）。
    public func createConversation(
        title: String? = nil,
        using provider: AIChatDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.mutation)) { [weak self] in
            guard let self else { return }
            let outcome = await Self.capture { try await provider.createConversation(title: title) }
            guard !Task.isCancelled else { return }
            switch outcome {
            case .success(let created):
                // **切换前**先把上一会话的流与流式状态收掉（口径 4：切会话取消在跑请求）。
                // 放在「提交切换」处而不是「请求发出」处：新建失败时不该把用户正在看的那
                // 一轮生成白白掐掉。
                self.discardStreamState(scope: scope, routeID: routeID)
                self.conversations.insert(created, at: 0)
                self.conversationsPhase = .loaded
                self.conversationsRefreshFailure = nil
                self.selectedConversationID = created.id
                self.messages = []
                self.messagesPhase = .idle
                self.messagesRefreshFailure = nil
            case .failure(let failure):
                self.conversationsRefreshFailure = failure.message
            }
        }.value
    }

    /// 重命名（端点 4）。直接执行，无二次确认（口径 6）。
    public func renameConversation(
        id: Int,
        title: String,
        using provider: AIChatDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.mutation)) { [weak self] in
            guard let self else { return }
            let outcome = await Self.capture { try await provider.renameConversation(id: id, title: trimmed) }
            guard !Task.isCancelled else { return }
            switch outcome {
            case .success(let updated):
                if let index = self.conversations.firstIndex(where: { $0.id == id }) {
                    self.conversations[index] = updated
                }
                self.conversationsRefreshFailure = nil
            case .failure(let failure):
                self.conversationsRefreshFailure = failure.message
            }
        }.value
    }

    /// 删除会话（端点 5）—— 只由二次确认触发。
    public func deleteConversation(
        id: Int,
        using provider: AIChatDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.mutation)) { [weak self] in
            guard let self else { return }
            let outcome = await Self.capture { try await provider.deleteConversation(id: id) }
            guard !Task.isCancelled else { return }
            switch outcome {
            case .success:
                self.conversations.removeAll { $0.id == id }
                self.conversationsRefreshFailure = nil
                if self.selectedConversationID == id {
                    self.discardStreamState(scope: scope, routeID: routeID)
                    self.selectedConversationID = nil
                    self.messages = []
                    self.messagesPhase = .idle
                    self.messagesRefreshFailure = nil
                }
            case .failure(let failure):
                self.conversationsRefreshFailure = failure.message
            }
        }.value
    }

    // MARK: - 消息编辑 / 删除（端点 7 / 8）

    /// 编辑一条 user 消息（端点 7）。后端只接受 user 消息，assistant 消息返回 400 ——
    /// 原样显示而不是本地拦截（本地拦截会让「为什么编辑不了」变成一个没有解释的置灰按钮）。
    public func editMessage(
        id: Int,
        content: String,
        using provider: AIChatDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        guard let conversationID = selectedConversationID else { return }
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.mutation)) { [weak self] in
            guard let self else { return }
            let outcome = await Self.capture {
                try await provider.editMessage(
                    conversationID: conversationID,
                    messageID: id,
                    content: trimmed
                )
            }
            guard !Task.isCancelled else { return }
            switch outcome {
            case .success(let updated):
                if let index = self.messages.firstIndex(where: { $0.id == id }) {
                    self.messages[index] = updated
                }
                self.messagesRefreshFailure = nil
            case .failure(let failure):
                self.messagesRefreshFailure = failure.message
            }
        }.value
    }

    /// 删除一条消息（端点 8）—— 只由二次确认触发。
    public func deleteMessage(
        id: Int,
        using provider: AIChatDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        guard let conversationID = selectedConversationID else { return }
        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.mutation)) { [weak self] in
            guard let self else { return }
            let outcome = await Self.capture {
                try await provider.deleteMessage(conversationID: conversationID, messageID: id)
            }
            guard !Task.isCancelled else { return }
            switch outcome {
            case .success:
                self.messages.removeAll { $0.id == id }
                self.messagesRefreshFailure = nil
            case .failure(let failure):
                self.messagesRefreshFailure = failure.message
            }
        }.value
    }

    /// 执行当前待确认的操作（`Alert` 的确认按钮）。
    public func confirmPending(
        using provider: AIChatDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        guard let confirmation = pendingConfirmation else { return }
        pendingConfirmation = nil
        switch confirmation {
        case .deleteConversation(let id, _):
            await deleteConversation(id: id, using: provider, scope: scope, routeID: routeID)
        case .deleteMessage(let id, _):
            await deleteMessage(id: id, using: provider, scope: scope, routeID: routeID)
        }
    }

    // MARK: - 附件（端点 11）

    /// 上传并解析附件；成功后正文回填进发送体。
    public func attach(
        fileURL: URL,
        filename: String,
        mimeType: String,
        using provider: AIChatDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        let token = UUID()
        uploadToken = token
        composer.attachment = .parsing(filename: filename)
        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.upload)) { [weak self] in
            guard let self else { return }
            let outcome = await Self.capture {
                try await provider.upload(fileURL: fileURL, filename: filename, mimeType: mimeType)
            }
            // 取消（切模块）或已有更新的上传接管 → 不动状态。
            guard self.uploadToken == token, !Task.isCancelled else { return }
            switch outcome {
            case .success(let response):
                self.composer.attachment = .parsed(
                    filename: response.fileName,
                    content: response.content,
                    truncated: response.truncated,
                    note: response.truncatedNote
                )
            case .failure(let failure):
                self.composer.attachment = .failed(filename: filename, message: failure.message)
            }
        }.value
    }

    // MARK: - 发送（端点 9）与停止（端点 10）

    /// 发送一条消息并消费流式回复。
    ///
    /// - Parameters:
    ///   - regenerateTarget: 非 nil 时走 `regenerate`（后端要求同时 `enable_web_search`）。
    ///   - resume: true 时用 `lastSentPayload` + `resumeCursor` 续传（口径 2），不新增用户消息。
    public func send(
        using provider: AIChatDataProviding,
        scope: ModuleTaskScope,
        routeID: String,
        regenerateTarget: Int? = nil,
        resume: Bool = false
    ) async {
        guard let conversationID = selectedConversationID else { return }

        let payload: AIChatSendPayload
        if resume {
            guard let last = lastSentPayload else { return }
            payload = last
        } else {
            let content = composer.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !content.isEmpty else { return }
            if regenerateTarget == nil {
                guard composer.canSend else { return }
            }
            payload = AIChatSendPayload(
                content: content,
                model: composer.model,
                systemPrompt: composer.systemPrompt,
                reasoningEffort: composer.reasoningEffort,
                regenerate: regenerateTarget != nil,
                targetMessageId: regenerateTarget,
                enableWebSearch: composer.webSearchEnabled,
                attachedFileContent: composer.attachment.parsedContent,
                attachedFileName: composer.attachment.filename
            )
        }

        // 续传**不重置**草稿：它接着上一段流继续累加（后端从游标之后开始发帧）。
        // 重置会把已经收到的半截正文丢掉 —— 用户看到的会变成「只有后半段」。
        if !resume {
            draft = AIChatTurnAccumulator()
            lastEventKinds = []
            resumeCursor = nil
        }
        streamError = nil
        // 这一轮的归属：之后所有流式状态的写入都要先验它（见 `StreamLease`）。
        let lease = StreamLease(conversationID: conversationID, token: UUID())
        streamLease = lease
        isStreaming = true
        isStopping = false
        let resumeFrom = resume ? resumeCursor : nil
        lastSentPayload = payload

        // 本轮的取消锚点：登记在 `:stream` 子 key 下 —— 切会话 / 切模块 / 停止生成都取消它。
        let task = scope.run(key: TaskPurpose.key(routeID, TaskPurpose.stream)) { [weak self] in
            await self?.consume(
                provider: provider,
                lease: lease,
                payload: payload,
                resumeFrom: resumeFrom
            )
        }
        await task.value
        // 只在「这条流还是当前那条」时收尾：切会话 / 新建会话 / 停止生成都已经摘掉了归属，
        // 那之后 `isStreaming` 属于**下一条**流，旧流的收尾不能再改写它。
        guard streamLease == lease else { return }
        streamLease = nil
        isStreaming = false
        isStopping = false
    }

    /// 真正消费一条流：逐帧折进 `draft`，按 `outcome` 收尾。
    private func consume(
        provider: AIChatDataProviding,
        lease: StreamLease,
        payload: AIChatSendPayload,
        resumeFrom cursor: String?
    ) async {
        do {
            for try await frame in provider.send(
                conversationID: lease.conversationID,
                payload: payload,
                lastEventID: cursor
            ) {
                try Task.checkCancellation()
                // 这条流已被摘掉归属（切会话 / 新建会话 / 停止生成 / 又发了一轮）：它的帧
                // 一律丢弃 —— 不写草稿、不动游标、不落错误。取消是异步的，这一步才是
                // 「旧流的帧不会影响当前页」的保证（口径 4）。
                guard ownsStream(lease) else { return }
                draft.apply(frame.event, lastEventID: frame.eventID)
                lastEventKinds = draft.eventKinds
                if frame.eventID != nil { resumeCursor = frame.eventID }
                if case .failed(let message) = draft.outcome {
                    streamError = message
                    return
                }
            }
        } catch is CancellationError {
            // 取消（停止生成 / 切会话 / 切模块）不是错误（口径 4）。
            return
        } catch let error as APIError {
            guard ownsStream(lease) else { return }
            streamError = Self.message(for: error)
            return
        } catch {
            guard ownsStream(lease) else { return }
            streamError = error.localizedDescription
            return
        }

        // 消费方被取消（停止生成 / 切会话 / 切模块）：抛出的路径在 catch 里返回，
        // 但有一条竞态 —— 内层流可能先以「正常结束」收尾，于是循环平静退出。
        // 不在这里补一道判断，它会被当成「连接提前结束」而落成错误态（口径 4 不允许）。
        if Task.isCancelled { return }
        // 同上：归属已摘掉的流平静退出时，`draft` 已经是别人的了，不能再按它的收尾判定
        // 写 `streamError` 或触发回读。
        guard ownsStream(lease) else { return }

        switch draft.outcome {
        case .completed, .stoppedWithoutDone:
            // `.completed` = 拿到 `done`；`.stoppedWithoutDone` = 续传路径的合法收尾
            // （`_resume_stream` 不合成 `done`，`ai_chat_v2.py:213`）。两者**都有产物**，
            // 收尾动作相同 —— 区别只在「能不能从载荷里拿到消息 id 与用量」。
            await finalizeTurn(lease: lease, using: provider)
        case .failed(let message):
            streamError = message
        case .running:
            // 流在没有终态的情况下结束（连接被中途关闭）→ 明确提示可续传，而不是静默当成功。
            streamError = "流式连接提前结束（未收到 message_stop）；可用『继续』从最后一条事件续传。"
        }
    }

    /// 一次生成结束后的落地：清输入框 → 按 `done` 载荷更新会话标题 / token / 排序 →
    /// **回读消息历史**。
    ///
    /// 为什么回读而不是本地插入：`done` 载荷只给 user/assistant 两条消息，而
    /// `regenerate` 会删掉旧的 assistant 行 —— 本地插入迟早与服务端不一致。回读一次的成本
    /// 是 5s 档的一次 GET，换来的是「界面上的消息 = 后端库里的消息」。
    ///
    /// **回读成功且非空才丢掉草稿**：回读失败（或返回空表）时保留草稿 —— 否则刚生成的回答
    /// 会从界面上凭空消失（用户看到的比库里的少，比多一条更糟）。
    /// 收尾**只作用于发起这一轮流式请求的会话**（`lease.conversationID`），不作用于
    /// 「此刻选中的会话」：两者在流跑的过程中会分叉（切会话 / 新建会话），拿后者会把旧会话
    /// 的产物写进新会话。归属已摘掉时整段跳过。
    private func finalizeTurn(lease: StreamLease, using provider: AIChatDataProviding) async {
        guard ownsStream(lease) else { return }
        composer.text = ""
        composer.attachment = .none
        applyCompletedTurnMetadata(conversationID: lease.conversationID)

        await loadMessages(conversationID: lease.conversationID, using: provider)
        // `loadMessages` 有挂起（5s 档）——期间归属可能被摘掉，回来时不能再动展示面。
        guard ownsStream(lease), selectedConversationID == lease.conversationID else { return }
        if messagesRefreshFailure == nil, !messages.isEmpty {
            draft = AIChatTurnAccumulator()
        }
    }

    /// 标题 / token / 列表排序的本地补齐（**服务端仍是权威**，这里只为少一次列表回读）。
    ///
    /// 按**发起这一轮的会话 id** 落地，而不是 `selectedConversationID`。
    private func applyCompletedTurnMetadata(conversationID: Int) {
        guard let index = conversations.firstIndex(where: { $0.id == conversationID }) else {
            // 列表里还没有它（新建后尚未回读列表）→ 不动列表。
            return
        }
        if let title = draft.conversationTitle {
            let old = conversations[index]
            conversations[index] = AIChatConversation(
                id: old.id,
                title: title,
                createdAt: old.createdAt,
                updatedAt: old.updatedAt,
                totalPromptTokens: draft.done?.conversationTokenUsage?.promptTokens ?? old.totalPromptTokens,
                totalCompletionTokens: draft.done?.conversationTokenUsage?.completionTokens ?? old.totalCompletionTokens,
                totalTokens: draft.done?.conversationTokenUsage?.totalTokens ?? old.totalTokens
            )
        }
        // 会话列表排序在 Web 上按 updated_at desc（后端已排序）→ 本地把刚动过的挪到最前。
        let conversation = conversations.remove(at: index)
        conversations.insert(conversation, at: 0)
    }

    /// 用量的一次加载（`load` 的第三段，也是区间切换 / 手动刷新的入口）。
    func loadInitialUsage(using provider: AIChatDataProviding) async {
        await loadUsage(using: provider, range: usageRange)
    }


    /// 停止生成（端点 10）：**先拆本地 SSE 连接**，再打后端 cancel（跨 worker 生效）。
    ///
    /// 顺序不能反：先等后端 cancel 会让「停止」按钮在网络上多等一个 5s 档，而用户按停止时
    /// 期待的是立刻停。后端那条 cancel 是尽力而为（`cancelled: false` 不是错误 —— 流可能
    /// 已经正常结束）。
    public func stopGeneration(
        using provider: AIChatDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) {
        guard let conversationID = selectedConversationID, isStreaming else { return }
        isStopping = true
        cancelStream(scope: scope, routeID: routeID)
        scope.run(key: TaskPurpose.key(routeID, TaskPurpose.cancel)) { [weak self] in
            let outcome = await Self.capture { try await provider.cancel(conversationID: conversationID) }
            guard let self, !Task.isCancelled else { return }
            // 停止后端也就把游标作废了：从已取消的流上续传没有意义（后端那条流已经不在了）。
            self.resumeCursor = nil
            self.lastSentPayload = nil
            switch outcome {
            case .success:
                self.isStopping = false
            case .failure(let failure):
                // 取消失败**不**显示成生成失败：用户要的是停下，本地流已经拆了。
                self.isStopping = false
                self.messagesRefreshFailure = "后端取消请求失败（\(failure.message)）；本地流已断开。"
            }
        }
    }

    /// 拆掉在跑的 SSE 连接（取消 `:stream` 子 key 的那条任务）。
    ///
    /// **先摘归属再取消**：`scope.cancel` 只发出取消信号，旧流的残帧与收尾仍可能跑到主
    /// actor 上 —— 归属一摘，它们就写不动任何流式状态了。
    ///
    /// 草稿**保留**（停止生成时用户要看到已生成的那半截）；切会话要连草稿一起作废，
    /// 用 `discardStreamState`。
    private func cancelStream(scope: ModuleTaskScope, routeID: String) {
        streamLease = nil
        scope.cancel(key: TaskPurpose.key(routeID, TaskPurpose.stream))
        isStreaming = false
        isStopping = false
    }

    /// 切会话 / 新建会话 / 删掉当前会话：拆连接 **+ 整份作废上一会话的流式状态**。
    ///
    /// 为什么不能只 `cancelStream`：`draft` / `resumeCursor` / `lastSentPayload` /
    /// `streamError` 都是「当前页面」的展示面。留着它们，上一会话的半截回答会画在新会话
    /// 上（`AIChatDraftRow` 画的是 store 级的那一份），`resume` 还可能拿上一会话的载荷去
    /// 续新会话的流。
    private func discardStreamState(scope: ModuleTaskScope, routeID: String) {
        cancelStream(scope: scope, routeID: routeID)
        draft = AIChatTurnAccumulator()
        lastEventKinds = []
        streamError = nil
        resumeCursor = nil
        lastSentPayload = nil
    }

    /// 这条流还是「当前那条」吗？
    private func ownsStream(_ lease: StreamLease) -> Bool { streamLease == lease }

    /// 续传（口径 2）：与上一次发送**同一个 POST 路径、同一份 body**，只多一个
    /// `Last-Event-ID` 头。
    public func resume(
        using provider: AIChatDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        guard resumeCursor != nil, lastSentPayload != nil else { return }
        await send(using: provider, scope: scope, routeID: routeID, resume: true)
    }

    public var canResume: Bool { resumeCursor != nil && lastSentPayload != nil && !isStreaming }

    // MARK: - 用量（端点 12）

    public func setUsageRange(_ range: AIChatUsageRange) {
        guard usageRange != range else { return }
        usageRange = range
    }

    public func loadUsage(
        using provider: AIChatDataProviding,
        range: AIChatUsageRange
    ) async {
        usagePhase = usage == nil ? .loading : .loaded
        let outcome = await Self.capture { try await provider.usageStats(range: range) }
        guard !Task.isCancelled, usageRange == range else { return }
        switch outcome {
        case .success(let stats):
            usage = stats
            usagePhase = .loaded
        case .failure(let failure):
            if usage == nil { usagePhase = .failed(failure.message) }
        }
    }

    /// 用量面板的刷新（切档 + 重试共用）。
    public func reloadUsage(
        using provider: AIChatDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.usage)) { [weak self] in
            guard let self else { return }
            await self.loadUsage(using: provider, range: self.usageRange)
        }.value
    }

    // MARK: - 未登录

    /// 没有可用凭据（未登录）时把「会话列表」置为失败态。
    ///
    /// 与 S5.1/S5.2 同口径：不发请求 —— 没有 key 的请求必然 401，把它显示成「凭据被拒绝」
    /// 会把「还没登录」误导成「凭据失效」。
    public func failWithoutCredential() {
        conversationsPhase = .failed("尚未登录，无法加载会话。")
        configPhase = .failed("尚未登录，无法加载 AI 配置。")
    }

    // MARK: - 内部收尾

    private func abandonConversations() {
        guard conversations.isEmpty, conversationsPhase.isLoading else { return }
        conversationsPhase = .idle
    }

    private func abandonMessages() {
        guard messages.isEmpty, messagesPhase.isLoading else { return }
        messagesPhase = .idle
    }

    // MARK: - 工具

    struct LoadFailure: Error, Sendable, Equatable {
        let message: String
    }

    static func message(for error: Error) -> String {
        if let apiError = error as? APIError { return apiError.displayMessage }
        return error.localizedDescription
    }

    static func capture<T: Sendable>(
        _ operation: @Sendable () async throws -> T
    ) async -> Result<T, LoadFailure> {
        do {
            return .success(try await operation())
        } catch {
            return .failure(LoadFailure(message: message(for: error)))
        }
    }
}

/// AI 会话片的展示口径（纯函数，与 Web 逐字对齐）。
public enum AIChatFormatting {
    /// 千分位整数（不走 locale —— 跟随系统区域会让同一份数据在不同机器上显示不同）。
    public static func integer(_ value: Int) -> String {
        NumberText.grouped(String(value))
    }

    /// token 数的紧凑写法（Web `lib/format/token-count.ts` 的 `formatTokenCount`）。
    public static func tokenCount(_ value: Int) -> String {
        switch value {
        case ..<1_000: return "\(value)"
        case ..<1_000_000:
            let thousands = Double(value) / 1_000
            return thousands >= 100
                ? "\(Int(thousands.rounded()))K"
                : String(format: "%.1fK", thousands)
        default:
            let millions = Double(value) / 1_000_000
            return millions >= 100
                ? "\(Int(millions.rounded()))M"
                : String(format: "%.1fM", millions)
        }
    }

    /// 耗时：`duration_ms` → 「1.2s」（Web 的 Timer chip 同样是秒级）。
    public static func duration(_ milliseconds: Int?) -> String? {
        guard let milliseconds, milliseconds > 0 else { return nil }
        if milliseconds < 1_000 { return "\(milliseconds)ms" }
        return String(format: "%.1fs", Double(milliseconds) / 1_000)
    }

    /// 搜索时间范围 chip 的文案（`day` / `week` / `month` / `year`；`all` 与 nil 不显示）。
    public static func searchTimeRangeLabel(_ raw: String?) -> String? {
        switch raw {
        case "day": return "今日"
        case "week": return "近 7 天"
        case "month": return "近 30 天"
        case "year": return "近 1 年"
        default: return nil
        }
    }

    /// 会话时间的展示（`updated_at` ISO8601 → 「今天 14:03」/「9-12 14:03」）。
    public static func conversationTimestamp(_ raw: String?, now: Date = Date(), timeZone: TimeZone = .current) -> String {
        guard let date = AgentOpsFormatting.parseISO8601(raw) else { return "—" }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let formatter = DateFormatter()
        formatter.timeZone = timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        let time = AgentOpsFormatting.clockTime(date, timeZone: timeZone)
        if calendar.isDate(date, inSameDayAs: now) { return "今天 \(time)" }
        formatter.dateFormat = "M-d"
        return "\(formatter.string(from: date)) \(time)"
    }

    /// 消息的 token 脚注（Web `token-footer.tsx` 的三段 + 耗时）。
    public static func tokenFooter(_ message: AIChatMessage) -> String? {
        guard message.totalTokens > 0 || message.durationMs != nil else { return nil }
        var parts: [String] = []
        if message.totalTokens > 0 {
            parts.append("↑\(tokenCount(message.promptTokens)) ↓\(tokenCount(message.completionTokens)) = \(tokenCount(message.totalTokens))")
        }
        if let duration = duration(message.durationMs) { parts.append(duration) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// 会话列表行的副标题。
    public static func conversationSubtitle(_ conversation: AIChatConversation, now: Date = Date()) -> String {
        var text = conversationTimestamp(conversation.updatedAt, now: now)
        if conversation.totalTokens > 0 {
            text += " · \(tokenCount(conversation.totalTokens)) tokens"
        }
        return text
    }
}
