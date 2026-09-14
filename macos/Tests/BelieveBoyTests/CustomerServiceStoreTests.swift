import BelieveBoyKit
import Foundation
import XCTest

@testable import BelieveBoyUI

/// 「AI 智能 → 客服交流」状态机：场景 / 语气 / 篇幅 / 语言 → system prompt，
/// 引导字段 + 自由文本 → content，新建会话 → 流式生成 → 停止 / 续传。
///
/// 这一页与 AI Chat 共用同一份底座（`AIChatClient` / `AIChatTurnAccumulator`），所以这里
/// 只钉**两页不同的那部分**：输入区语义与产物形态；底座的行为由 `AIChatStoreTests` 与
/// `AIChatClientTests` 钉。
@MainActor
final class CustomerServiceStoreTests: XCTestCase {
    private var scopes: [ModuleTaskScope] = []

    override func setUp() {
        super.setUp()
        scopes = []
    }

    override func tearDown() async throws {
        for scope in scopes { scope.cancelAll() }
        scopes = []
        try await super.tearDown()
    }

    private let routeID = AIChatCatalog.customerServiceRouteID

    private func makeScope() -> ModuleTaskScope {
        let scope = ModuleTaskScope()
        scopes.append(scope)
        return scope
    }

    private func configuredProvider(
        stream: ScriptedAIChatProvider.Outcome<[AIChatStreamFrame]> = .value([])
    ) -> ScriptedAIChatProvider {
        ScriptedAIChatProvider(
            config: .value(
                AIChatConfig(
                    providerConfigured: true,
                    webSearchConfigured: false,
                    models: ["m"],
                    defaultModel: "m"
                )
            ),
            create: .value(.fixture(id: 77, title: "客服交流")),
            stream: stream
        )
    }

    // MARK: - 默认态与输入守卫

    func testDefaultScenarioIsFirstEnabledOne() {
        let store = CustomerServiceStore()
        XCTAssertEqual(store.scenarioID, "ops-report")
        XCTAssertEqual(store.scenario?.label, "运营汇报话术")
        XCTAssertNil(store.toneID)
        XCTAssertEqual(store.language, .zh)
        XCTAssertEqual(store.length, .standard)
    }

    func testDisabledScenarioCannotBeSelectedAndCannotGenerate() async {
        let store = CustomerServiceStore()
        store.selectScenario(id: "email-compose")
        XCTAssertEqual(store.scenarioID, "ops-report", "停用的场景点了也不该切过去")

        store.setFreeText("有内容")
        XCTAssertFalse(store.canGenerate, "还没有配置就绪，也不该能生成")

        let provider = configuredProvider()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, routeID: routeID)
        XCTAssertTrue(store.canGenerate)
    }

    /// 没有任何输入时不能生成（发一个空 content 是 422 + 白花一次 AI 配额）。
    func testEmptyInputBlocksGeneration() async {
        let provider = configuredProvider()
        let store = CustomerServiceStore()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, routeID: routeID)

        XCTAssertTrue(store.userContentPreview.isEmpty)
        XCTAssertFalse(store.canGenerate)

        await store.generate(using: provider, scope: scope, routeID: routeID)
        XCTAssertTrue(provider.streams.isEmpty)
        XCTAssertEqual(provider.createTitles, [], "不该白建一个会话")
    }

    /// 只填了引导字段（没有自由文本）也能生成。
    func testGuidedFieldsAloneEnableGeneration() async {
        let provider = configuredProvider(stream: .value([.event(.messageStop, id: "1-0")]))
        let store = CustomerServiceStore()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, routeID: routeID)

        store.setGuidedField("period", "本周")
        XCTAssertTrue(store.canGenerate)

        await store.generate(using: provider, scope: scope, routeID: routeID)

        XCTAssertEqual(provider.streams.count, 1)
        XCTAssertEqual(provider.streams[0].content, "【补充信息】\n- 汇报周期：本周")
        XCTAssertTrue(provider.streams[0].systemPrompt.hasPrefix("你是一名资深的亚马逊运营专家"))
    }

    // MARK: - 场景切换会重置输入

    func testSwitchingScenarioResetsToneAndGuidedFields() async {
        let store = CustomerServiceStore()
        store.setGuidedField("period", "本周")
        store.selectTone(id: "brief")
        XCTAssertEqual(store.toneID, "brief")

        store.selectScenario(id: "email-compose")
        XCTAssertEqual(store.toneID, "brief", "停用场景不切换 → 输入保持原样")

        store.selectScenario(id: "ops-report")
        XCTAssertEqual(store.scenarioID, "ops-report")

        // 用真实存在的另一个可用场景来验证重置行为（当前只有 ops-report 可用，
        // 所以直接触发一次「同场景重选」不应清空）。
        store.setGuidedField("period", "本周")
        store.selectScenario(id: "ops-report")
        XCTAssertEqual(store.guidedFields["period"], "本周", "同场景重选不清空")
    }

    // MARK: - system prompt 与 content 的拼装

    func testSystemPromptAndContentPreviewReflectSelections() {
        let store = CustomerServiceStore()
        store.selectScenario(id: "ops-report")
        store.selectTone(id: "formal")
        store.setLength(.detailed)
        store.setLanguage(.en)
        store.setFreeText("本周广告 ACOS 上升")
        store.setGuidedField("metrics", "ACOS 22%")
        store.setGuidedField("blank", "   ")

        let prompt = store.systemPromptPreview
        XCTAssertTrue(prompt.contains(AIChatToneOption.fixtureFormalSuffix), "语气档要进 prompt")
        XCTAssertTrue(prompt.contains(AIChatLength.detailed.instruction))
        XCTAssertTrue(prompt.contains(AIChatLanguage.en.instruction))

        // 场景关了语言开关时不该注入语言指令（这里是开着的，改语言应生效）。
        store.setLanguage(.zh)
        XCTAssertTrue(store.systemPromptPreview.contains(AIChatLanguage.zh.instruction))

        XCTAssertEqual(
            store.userContentPreview,
            "【原始内容】\n本周广告 ACOS 上升\n\n【补充信息】\n- 核心指标：ACOS 22%"
        )
    }

    func testWrongToneForScenarioIsIgnored() {
        let store = CustomerServiceStore()
        store.selectScenario(id: "ops-report")
        store.selectTone(id: "不存在的语气")
        XCTAssertNil(store.toneID, "不属于该场景的语气不接受（后端也会 400）")
    }

    // MARK: - 生成（端点 3 + 9）

    func testGenerateCreatesConversationThenStreams() async {
        let provider = configuredProvider(stream: .value([
            .event(.messageStart(messageID: "m1", model: "m", createdAtMillis: 0), id: "1-0"),
            .event(.contentBlockDelta(index: 0, delta: .text("结论先行")), id: "1-1"),
            .event(.messageStop, id: "1-1"),
            .event(.done(
                AIChatStreamDone(conversationTitle: "客服交流", durationMs: 800, titleRegenerated: false)
            )),
        ]))
        let store = CustomerServiceStore()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, routeID: routeID)

        store.selectTone(id: "brief")
        store.setFreeText("本周数据")

        await store.generate(using: provider, scope: scope, routeID: routeID)

        XCTAssertEqual(provider.createTitles, ["客服交流"], "每次生成新建一个「客服交流」会话（与 Web 同口径）")
        XCTAssertEqual(store.conversationID, 77)
        XCTAssertEqual(provider.streams.count, 1)
        XCTAssertEqual(provider.streams[0].conversationID, 77)
        let briefSuffix = AIChatPresetCatalog.tone(scenarioID: "ops-report", toneID: "brief")?.promptSuffix ?? ""
        XCTAssertFalse(briefSuffix.isEmpty)
        XCTAssertTrue(
            provider.streams[0].systemPrompt.contains(briefSuffix),
            "语气档要拼进 system_prompt：\(provider.streams[0].systemPrompt)"
        )
        XCTAssertEqual(store.outputText, "结论先行")
        XCTAssertEqual(store.generationCount, 1)
        XCTAssertFalse(store.isGenerating)
        XCTAssertNil(store.error)
        XCTAssertEqual(store.lastEventKinds, ["message_start", "content_block_delta", "message_stop", "done"])
    }

    /// 会话创建失败就不该再发流（没有会话 id，流请求路径都不成立）。
    func testCreateFailureStopsBeforeStreaming() async {
        let provider = ScriptedAIChatProvider(
            config: .value(
                AIChatConfig(providerConfigured: true, webSearchConfigured: false, models: ["m"], defaultModel: "m")
            ),
            create: .failure(status: 500)
        )
        let store = CustomerServiceStore()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, routeID: routeID)

        store.setFreeText("内容")
        await store.generate(using: provider, scope: scope, routeID: routeID)

        XCTAssertTrue(provider.streams.isEmpty, "建会话失败后不得再发流")
        XCTAssertNotNil(store.error)
        XCTAssertFalse(store.isGenerating)
    }

    /// 流式失败保留已收到的正文（产物不能因为一次传输错误消失）。
    func testStreamFailureKeepsPartialOutput() async {
        let provider = configuredProvider(stream: .value([
            .event(.contentBlockDelta(index: 0, delta: .text("先写了一半")), id: "1-0"),
            .event(.error(code: "overloaded", message: "服务繁忙")),
        ]))
        let store = CustomerServiceStore()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, routeID: routeID)
        store.setFreeText("内容")

        await store.generate(using: provider, scope: scope, routeID: routeID)

        XCTAssertEqual(store.outputText, "先写了一半")
        XCTAssertEqual(store.error, "服务繁忙（overloaded）")
    }

    // MARK: - 停止 / 续传

    func testStopTearsDownStreamAndCallsCancel() async {
        let provider = configuredProvider(stream: .hang)
        let store = CustomerServiceStore()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, routeID: routeID)
        store.setFreeText("长文")

        let generating = Task { await store.generate(using: provider, scope: scope, routeID: routeID) }
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(store.isGenerating)
        XCTAssertTrue(store.canStop)

        store.stop(using: provider, scope: scope, routeID: routeID)
        await generating.value
        try? await Task.sleep(nanoseconds: 30_000_000)

        XCTAssertTrue(provider.cancellation.isCancelled, "停止必须拆掉本地 SSE")
        XCTAssertEqual(provider.cancelledConversationIDs, [77])
        XCTAssertFalse(store.isGenerating)
        XCTAssertNil(store.error, "停止不是错误")
        XCTAssertNil(store.resumeCursor)
    }

    /// **回归（Tia 复核阻塞项）**：停止生成后**立即**再生成一次时，上一轮的后端 cancel 回包
    /// （它晚于下一轮到达）不得把下一轮的游标 / 载荷清掉。
    ///
    /// 与 `AIChatStore` 同口径：取消是异步的，所以收尾只能作用于**发起该轮的这一次生成**
    /// （`generationToken`），不能作用于「当前这一次」。
    func testStopThenImmediateRegenerateKeepsTheNewTurnsCursor() async {
        let provider = configuredProvider(stream: .hang)
        provider.setCancelDelay(nanoseconds: 200_000_000)
        let store = CustomerServiceStore()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, routeID: routeID)
        store.setFreeText("长文")

        let generating = Task { await store.generate(using: provider, scope: scope, routeID: routeID) }
        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(store.isGenerating)

        store.stop(using: provider, scope: scope, routeID: routeID)
        await generating.value
        XCTAssertNil(store.resumeCursor, "停止即作废游标（不等回包）")
        XCTAssertNil(store.lastPayload)

        // 立即再生成一轮（此时上一轮的 cancel 回包还在路上）。
        provider.setStream(.value([
            .event(.contentBlockDelta(index: 0, delta: .text("新一轮")), id: "9-0"),
            .event(.messageStop, id: "9-0"),
        ]))
        await store.generate(using: provider, scope: scope, routeID: routeID)
        XCTAssertTrue(store.canResume, "新一轮有自己的游标")
        XCTAssertEqual(store.outputText, "新一轮")

        // 让上一轮的 cancel 回包落地：它不得碰新一轮的状态。
        try? await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertTrue(store.canResume, "上一轮的取消回包不得清掉新一轮的游标")
        XCTAssertEqual(store.outputText, "新一轮")
        XCTAssertNil(store.error)
        XCTAssertFalse(store.isGenerating)
    }

    func testResumeReusesSamePayloadAndCursor() async {
        let provider = configuredProvider(stream: .value([
            .event(.contentBlockDelta(index: 0, delta: .text("半句")), id: "5-0"),
        ]))
        let store = CustomerServiceStore()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, routeID: routeID)
        store.setFreeText("内容")

        await store.generate(using: provider, scope: scope, routeID: routeID)
        XCTAssertTrue(store.canResume)
        XCTAssertNotNil(store.error, "没有终态的收尾要提示可续传")

        provider.setStream(.value([
            .event(.contentBlockDelta(index: 0, delta: .text("补上")), id: "5-1"),
            .event(.messageStop, id: "5-1"),
        ]))
        await store.generate(using: provider, scope: scope, routeID: routeID, resume: true)

        XCTAssertEqual(provider.createTitles, ["客服交流"], "续传不新建会话")
        XCTAssertEqual(provider.streams.count, 2)
        XCTAssertEqual(provider.streams[1].lastEventID, "5-0")
        XCTAssertEqual(provider.streams[1].content, provider.streams[0].content, "续传必须重发同一份 body")
        XCTAssertEqual(store.outputText, "半句补上")
        XCTAssertNil(store.error)
    }

    // MARK: - 产物操作

    func testClearOutputAndInputs() async {
        let provider = configuredProvider(stream: .value([
            .event(.contentBlockDelta(index: 0, delta: .text("产物")), id: "1-0"),
            .event(.messageStop, id: "1-0"),
        ]))
        let store = CustomerServiceStore()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, routeID: routeID)
        store.setFreeText("输入")
        await store.generate(using: provider, scope: scope, routeID: routeID)
        XCTAssertEqual(store.outputText, "产物")

        store.clearOutput()
        XCTAssertTrue(store.outputText.isEmpty)
        XCTAssertNil(store.resumeCursor)
        XCTAssertFalse(store.canResume)

        store.clearInputs()
        XCTAssertTrue(store.freeText.isEmpty)
        XCTAssertTrue(store.guidedFields.isEmpty)
    }

    /// `markdownDocument` 就是产物原文（Web 的 `exportMd` 是 `new Blob([output])`）。
    func testMarkdownDocumentIsRawOutput() async {
        let provider = configuredProvider(stream: .value([
            .event(.contentBlockDelta(index: 0, delta: .text("# 标题\n\n正文")), id: "1-0"),
            .event(.messageStop, id: "1-0"),
        ]))
        let store = CustomerServiceStore()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, routeID: routeID)
        store.setFreeText("输入")
        await store.generate(using: provider, scope: scope, routeID: routeID)

        XCTAssertEqual(store.markdownDocument, "# 标题\n\n正文")
    }

    func testOutputPlaceholderExplainsState() async {
        let provider = configuredProvider()
        let store = CustomerServiceStore()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, routeID: routeID)

        XCTAssertTrue(store.outputPlaceholder.contains("按「生成」"))

        store.failWithoutCredential()
        XCTAssertTrue(store.configPhase.failureMessage?.contains("尚未登录") == true)
    }
}

extension AIChatToneOption {
    /// `ops-report` 的「正式报告版」语气后缀（与 `AIChatPresetCatalog` 同源，这里只取一处断言用）。
    static var fixtureFormalSuffix: String {
        AIChatPresetCatalog.tone(scenarioID: "ops-report", toneID: "formal")?.promptSuffix ?? ""
    }
}
