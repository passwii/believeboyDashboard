import BelieveBoyKit
import Foundation
import Observation

/// 「AI 智能 → 客服交流」的视图状态：场景选择 + 引导字段 + 一次生成。
///
/// 与 AI Chat 页**共用同一份底座**（`GET /ai/config` → `POST /ai/conversations` →
/// `POST .../messages/stream`），差别只在输入区与产物呈现：
///
/// | 维度 | AI Chat | 客服交流 |
/// | --- | --- | --- |
/// | 历史 | 有会话列表与消息历史 | 无列表：每次生成新建一个「客服交流」会话（与 Web 同口径，`tone-card.tsx:98`） |
/// | 输入 | 自由文本 + 附件 + 结构化 prompt | 自由粘贴 + 场景引导字段，二者拼成 `content` |
/// | system prompt | `buildSystemPrompt(overview, detail)` | `buildScenarioSystemPrompt(scenario, tone, language, length)` |
/// | 产物 | 消息气泡（Markdown） | 单块输出 + 复制 / 导出 `.md` |
///
/// 为什么直接复用 `AIChatClient` / `AIChatTurnAccumulator` 而不另写：这两页在后端是同一套
/// 协议（同一个流端点、同一份事件序列），另写一份只会在下一次协议改动时分叉。
@MainActor
@Observable
public final class CustomerServiceStore {
    public enum TaskPurpose {
        public static let config = "cs-config"
        public static let generate = "cs-generate"
        public static let cancel = "cs-cancel"

        public static func key(_ routeID: String, _ purpose: String) -> String {
            "\(routeID):\(purpose)"
        }
    }

    // MARK: - 配置

    public private(set) var configPhase: AIChatPhase = .idle
    public private(set) var config: AIChatConfig?

    // MARK: - 场景与输入

    public private(set) var scenarioID: String
    public private(set) var toneID: String?
    public private(set) var language: AIChatLanguage = .zh
    public private(set) var length: AIChatLength = .standard
    public private(set) var freeText: String = ""
    public private(set) var guidedFields: [String: String] = [:]

    // MARK: - 产物

    public private(set) var output = AIChatTurnAccumulator()
    public private(set) var isGenerating = false
    public private(set) var isStopping = false
    public private(set) var error: String?
    /// 本次生成用的会话 id（新建后即记住；停止生成要它）。
    public private(set) var conversationID: Int?
    /// 本轮流式请求的唯一标记（`nil` = 没有在跑的流）。
    ///
    /// 与 `AIChatStore.StreamLease` 同口径：取消是**异步**的 —— `stop` 之后用户能立即再
    /// 生成一次，而上一次生成的残帧 / 收尾 / 后端 cancel 回包都还可能跑到主 actor 上。
    /// 归属一旦摘掉，它们就写不动任何状态（不会把上一轮的错误、游标清空或收尾落到新一轮）。
    private var generationToken: UUID?
    public private(set) var lastEventKinds: [String] = []
    public private(set) var resumeCursor: String?
    public private(set) var lastPayload: AIChatSendPayload?
    /// 生成次数 —— 视图按钮的幂等锚点，也在用例里用来断言「只发了一次」。
    public private(set) var generationCount = 0

    public init(scenarioID: String? = nil) {
        let fallback = AIChatPresetCatalog.defaultScenarioID
        let requested = scenarioID ?? fallback
        self.scenarioID = AIChatPresetCatalog.scenario(id: requested)?.isDisabled == false
            ? requested
            : fallback
    }

    // MARK: - 派生

    public var scenarios: [AIChatScenario] { AIChatPresetCatalog.scenarios }

    public var scenario: AIChatScenario? { AIChatPresetCatalog.scenario(id: scenarioID) }

    public var toneOptions: [AIChatToneOption] { scenario?.toneOptions ?? [] }

    public var selectedTone: AIChatToneOption? {
        AIChatPresetCatalog.tone(scenarioID: scenarioID, toneID: toneID)
    }

    public var providerReady: Bool { config?.providerConfigured ?? false }

    /// 实际会拼出的 system prompt（UI 上可展开核对 —— 两端提示词不同的 bug 最难查）。
    public var systemPromptPreview: String {
        AIChatPresetCatalog.buildScenarioSystemPrompt(
            scenarioID: scenarioID,
            toneID: toneID,
            language: scenario?.languageToggle == true ? language : nil,
            length: length
        )
    }

    /// 实际会拼出的 user content（同样可展开核对）。
    public var userContentPreview: String {
        AIChatPresetCatalog.buildUserContent(
            freeText: freeText,
            guidedFields: guidedFields,
            schema: scenario?.inputSchema ?? []
        )
    }

    public var canGenerate: Bool {
        guard providerReady, scenario?.isDisabled != true, !isGenerating else { return false }
        return !userContentPreview.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var canStop: Bool { isGenerating && !isStopping }

    /// 生成中但还没有正文。
    public var isAwaitingFirstToken: Bool {
        isGenerating && !output.hasVisibleText && output.thinking.isEmpty
    }

    public var outputText: String { output.text }

    /// 输出区的空态提示（按阶段给不同的话，不用一个「暂无内容」糊过去）。
    public var outputPlaceholder: String {
        if isGenerating { return isAwaitingFirstToken ? "正在生成…" : "" }
        if let error { return "生成失败：\(error)" }
        if output.hasVisibleText { return "" }
        return "还没有产出。填好左侧内容后按「生成」（⌘↩）。"
    }

    // MARK: - 输入命令

    public func selectScenario(id: String) {
        guard let scenario = AIChatPresetCatalog.scenario(id: id), !scenario.isDisabled else { return }
        guard scenario.id != scenarioID else { return }
        scenarioID = id
        // 换场景 = 换字段集：旧场景的语气 / 引导值留着只会拼出一份不属于新场景的 prompt。
        toneID = nil
        guidedFields = [:]
    }

    public func selectTone(id: String?) {
        guard let id else {
            toneID = nil
            return
        }
        guard toneOptions.contains(where: { $0.id == id }) else { return }
        toneID = id
    }

    public func setLanguage(_ language: AIChatLanguage) {
        self.language = language
    }

    public func setLength(_ length: AIChatLength) {
        self.length = length
    }

    public func setFreeText(_ text: String) {
        freeText = text
    }

    public func setGuidedField(_ key: String, _ value: String) {
        guidedFields[key] = value
    }

    public func clearInputs() {
        freeText = ""
        guidedFields = [:]
    }

    public func clearOutput() {
        output = AIChatTurnAccumulator()
        lastEventKinds = []
        error = nil
        resumeCursor = nil
        lastPayload = nil
    }

    public func clearError() {
        error = nil
    }

    // MARK: - 加载配置（端点 1）

    public func load(
        using provider: AIChatDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.config)) { [weak self] in
            guard let self else { return }
            await self.loadConfig(using: provider)
        }.value
    }

    func loadConfig(using provider: AIChatDataProviding) async {
        configPhase = config == nil ? .loading : .loaded
        let outcome = await AIChatStore.capture { try await provider.config() }
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

    public func failWithoutCredential() {
        configPhase = .failed("尚未登录，无法加载 AI 配置。")
    }

    // MARK: - 生成（端点 3 + 9）

    /// 生成一次输出：新建会话 → `POST .../messages/stream`。
    ///
    /// `resume == true` 时不新建会话，而是用上一次的载荷与游标续传（口径 2：
    /// **同一个 POST 路径、同一份 body**，只多一个 `Last-Event-ID` 头）。
    public func generate(
        using provider: AIChatDataProviding,
        scope: ModuleTaskScope,
        routeID: String,
        resume: Bool = false
    ) async {
        if resume {
            guard let payload = lastPayload, resumeCursor != nil, let conversationID else { return }
            // 续传**不重置**产物：它接着上一段流继续累加（后端从游标之后开始发帧）——
            // 重置会把已经收到的半截正文丢掉。
            lastEventKinds = output.eventKinds
            error = nil
            isGenerating = true
            isStopping = false
            generationCount += 1
            let cursor = resumeCursor
            let token = UUID()
            generationToken = token
            let task = scope.run(key: TaskPurpose.key(routeID, TaskPurpose.generate)) { [weak self] in
                await self?.consume(
                    provider: provider,
                    conversationID: conversationID,
                    payload: payload,
                    resumeFrom: cursor,
                    token: token
                )
            }
            await task.value
            guard ownsGeneration(token) else { return }
            generationToken = nil
            isGenerating = false
            isStopping = false
            return
        }

        guard canGenerate else { return }
        let content = userContentPreview
        let payload = AIChatSendPayload(
            content: content,
            model: nil,
            systemPrompt: systemPromptPreview,
            reasoningEffort: nil,
            regenerate: false,
            targetMessageId: nil,
            enableWebSearch: false,
            attachedFileContent: nil,
            attachedFileName: nil
        )

        output = AIChatTurnAccumulator()
        lastEventKinds = []
        error = nil
        resumeCursor = nil
        lastPayload = payload
        isGenerating = true
        isStopping = false
        generationCount += 1
        let token = UUID()
        generationToken = token

        let task = scope.run(key: TaskPurpose.key(routeID, TaskPurpose.generate)) { [weak self] in
            guard let self else { return }
            let created = await AIChatStore.capture {
                try await provider.createConversation(title: "客服交流")
            }
            guard !Task.isCancelled, self.ownsGeneration(token) else { return }
            switch created {
            case .success(let conversation):
                self.conversationID = conversation.id
            case .failure(let failure):
                self.error = failure.message
                return
            }
            guard let conversationID = self.conversationID else { return }
            await self.consume(
                provider: provider,
                conversationID: conversationID,
                payload: payload,
                resumeFrom: nil,
                token: token
            )
        }
        await task.value
        // 只在「还是这一轮」时收尾：`stop` 已经把归属摘掉，那之后 `isGenerating` 属于下一轮。
        guard ownsGeneration(token) else { return }
        generationToken = nil
        isGenerating = false
        isStopping = false
    }

    /// 这一次生成还是「当前这一次」吗？
    private func ownsGeneration(_ token: UUID) -> Bool { generationToken == token }

    /// 消费一条流（与 `AIChatStore.consume` 同形：共用累加器与收尾判定）。
    private func consume(
        provider: AIChatDataProviding,
        conversationID: Int,
        payload: AIChatSendPayload,
        resumeFrom cursor: String?,
        token: UUID
    ) async {
        do {
            for try await frame in provider.send(
                conversationID: conversationID,
                payload: payload,
                lastEventID: cursor
            ) {
                try Task.checkCancellation()
                // 已摘归属（`stop` / 又开了一轮）：上一轮的帧一律丢弃。
                guard ownsGeneration(token) else { return }
                output.apply(frame.event, lastEventID: frame.eventID)
                lastEventKinds = output.eventKinds
                if frame.eventID != nil { resumeCursor = frame.eventID }
                if case .failed(let message) = output.outcome {
                    error = message
                    return
                }
            }
        } catch is CancellationError {
            // 停止生成 / 切场景 / 切模块：取消不落错误态（口径 4）。
            return
        } catch let apiError as APIError {
            guard ownsGeneration(token) else { return }
            error = AIChatStore.message(for: apiError)
            return
        } catch {
            guard ownsGeneration(token) else { return }
            self.error = error.localizedDescription
            return
        }

        // 消费方被取消（停止 / 切场景 / 切模块）时同样要提前退出（同上一条竞态）。
        if Task.isCancelled { return }
        guard ownsGeneration(token) else { return }

        switch output.outcome {
        case .completed, .stoppedWithoutDone:
            error = nil
        case .failed(let message):
            error = message
        case .running:
            error = "流式连接提前结束（未收到 message_stop）；可用『续传』从最后一条事件继续。"
        }
    }

    /// 停止生成（端点 10）：先拆本地 SSE，再打后端 cancel。
    public func stop(
        using provider: AIChatDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) {
        guard isGenerating, let conversationID else { return }
        isStopping = true
        // 先摘归属再拆流：取消是异步的，摘掉之后上一轮的残帧与收尾都写不动状态。
        generationToken = nil
        scope.cancel(key: TaskPurpose.key(routeID, TaskPurpose.generate))
        isGenerating = false
        // 停止后端也就把游标作废了：从已取消的流上续传没有意义（后端那条流已经不在了）。
        // 同步清掉而不是等回包 —— 否则「停止后立即再生成」会把新一轮的游标与载荷误清。
        resumeCursor = nil
        lastPayload = nil
        scope.run(key: TaskPurpose.key(routeID, TaskPurpose.cancel)) { [weak self] in
            let outcome = await AIChatStore.capture { try await provider.cancel(conversationID: conversationID) }
            guard let self, !Task.isCancelled else { return }
            // 已经开了新一轮：这一轮的回包不得改它的状态。
            guard self.generationToken == nil, self.isStopping else { return }
            self.isStopping = false
            if case .failure(let failure) = outcome {
                // 取消失败**不**显示成生成失败：用户要的是停下，本地流已经拆了。
                self.error = "后端取消请求失败（\(failure.message)）；本地流已断开。"
            }
        }
    }

    /// 是否可以续传（有游标 + 有上一次载荷）。
    public var canResume: Bool { resumeCursor != nil && lastPayload != nil && !isGenerating }

    /// 导出 `.md` 的正文（Web `tone-card.tsx` 的 `exportMd` 用 `output` 原文）。
    public var markdownDocument: String { output.text }
}
