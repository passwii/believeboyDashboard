import AppKit
import BelieveBoyKit
import SwiftUI
import XCTest

@testable import BelieveBoyUI

/// 「AI 会话片」两页的离屏渲染核对：路由表命中 → 真模块发请求 → 状态机落地 → 界面画出内容。
///
/// 为什么必须离屏渲染：「12 条端点全部接通、可达」在类型层面无法成立 —— 会话列表、消息流、
/// 输入框都是 `ScrollView` / `TextEditor`，只在视图真正挂进窗口后才布局。这里用与线上完全
/// 一样的装配方式（`AppModel` + `APIClient` + `NavigationStore` + `ShellView`，只把
/// `URLSession` 打桩、响应用真实后端快照），因此「模块确实接上线了」不靠人工检查。
///
/// 跨端可见性（验收 3）也落在这里：会话与消息用的是**从真实后端按夹具账号抓下来的响应**，
/// 桌面端以同一 `X-User-Id` 登录后必须看得见、并在同一条 POST 路径上续聊。
@MainActor
final class AIChatRenderingTests: XCTestCase {
    private var scopes: [ModuleTaskScope] = []

    /// 夹具账号（`Fixtures/AIChat/manifest.json` 的 `params.user_id`）。
    private static let fixtureUserID = "99001065"

    override func setUp() {
        super.setUp()
        scopes = []
    }

    override func tearDown() async throws {
        await cancelScopes(scopes)
        scopes = []
        try await super.tearDown()
    }

    // MARK: - 装配

    private func makeSignedInModel(
        userID: String = fixtureUserID,
        handler: @escaping @Sendable (URLRequest) -> StubURLProtocol.Response
    ) -> AppModel {
        let sessionStore = InMemorySessionStore()
        try? sessionStore.saveSession(
            AuthSession(
                apiKey: "blf_AI_CHAT",
                user: AuthenticatedUser(
                    id: userID,
                    name: "夹具账号",
                    email: "fixture@believeboy.com",
                    operatorNameZh: "夹具账号",
                    isAdmin: true,
                    roleType: "admin"
                )
            )
        )
        return AppModel(
            sessionStore: sessionStore,
            rememberedLogins: InMemoryRememberedLoginStore(),
            processEnvironment: [:],
            urlSession: StubURLProtocol.session(handler: handler)
        )
    }

    private func makeShell(model: AppModel, routeID: String) -> (ShellView, NavigationStore) {
        let navigation = NavigationStore(preferences: InMemoryShellPreferencesStore())
        navigation.select(routeID: routeID)
        scopes.append(navigation.tasks)
        return (ShellView(model: model, navigation: navigation), navigation)
    }

    /// 真实快照路由（未登记的路径直接 `XCTFail`，避免测试静默打到真实网络）。
    private func snapshotHandler(
        configProviderConfigured: Bool = true,
        overrides: [String: StubURLProtocol.Response] = [:]
    ) throws -> @Sendable (URLRequest) -> StubURLProtocol.Response {
        let configBody = try AIChatFixtures.text(fileName: "ai-config.json")
        // 夹具里的 config 是「未配置 provider」的真实形状；渲染用例大多需要一条可发的路径，
        // 因此默认把 provider 打开，个别用例显式用 `configProviderConfigured: false` 保留原样。
        let patchedConfig = configProviderConfigured
            ? configBody
                .replacingOccurrences(of: "\"provider_configured\": false", with: "\"provider_configured\": true")
                .replacingOccurrences(of: "\"models\": []", with: "\"models\": [\"qwen-test\"]")
                .replacingOccurrences(of: "\"default_model\": \"\"", with: "\"default_model\": \"qwen-test\"")
            : configBody
        let conversationsBody = try AIChatFixtures.text(fileName: "ai-conversations.json")
        let messagesBody = try AIChatFixtures.text(fileName: "ai-conversation-messages.json")
        let usageBody = try AIChatFixtures.text(fileName: "ai-usage-stats-30d.json")
        let turn = try AIChatFixtures.streamTurn()
        let conversationID = try AIChatFixtures.manifest().params.conversationID

        let routes: [String: StubURLProtocol.Response] = [
            "/api/v1/ai/config": .json(200, patchedConfig),
            "/api/v1/ai/conversations": .json(200, conversationsBody),
            "/api/v1/ai/conversations/\(conversationID)/messages": .json(200, messagesBody),
            "/api/v1/ai/conversations/\(conversationID)/messages/stream": .stream(200, chunks: [turn]),
            "/api/v1/ai/usage/stats": .json(200, usageBody),
        ]

        return { request in
            let path = request.url?.path ?? ""
            if let override = overrides[path] { return override }
            guard let response = routes[path] else {
                XCTFail("未登记的请求路径：\(request.httpMethod ?? "?") \(path)")
                return .json(500, #"{"detail":"stub: unregistered"}"#)
            }
            return response
        }
    }

    // MARK: - AI Chat 首屏（端点 1 / 2 / 6 / 12）

    /// 「AI 智能 → AI Chat」经 `ModuleRegistry` 命中真模块：配置 + 会话列表 + 消息历史 +
    /// 用量四类请求都在日志里，且界面真的画出了内容。
    func testChatModuleRendersThroughShellRegistry() async throws {
        let model = makeSignedInModel(handler: try snapshotHandler())
        let (shell, navigation) = makeShell(model: model, routeID: AIChatView.routeID)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()

        await waitUntil { navigation.aiChat.usagePhase == .loaded && !navigation.aiChat.messages.isEmpty }

        let paths = StubURLProtocol.loggedPaths
        XCTAssertTrue(paths.contains("/api/v1/ai/config"), "实发：\(paths)")
        XCTAssertTrue(paths.contains("/api/v1/ai/conversations"), "实发：\(paths)")
        XCTAssertTrue(paths.contains { $0.hasSuffix("/messages") }, "实发：\(paths)")
        XCTAssertTrue(paths.contains("/api/v1/ai/usage/stats"), "实发：\(paths)")

        XCTAssertEqual(navigation.aiChat.messages.count, try AIChatFixtures.messages().count)
        XCTAssertTrue(navigation.aiChat.inboxState == .ready)

        hosted.pump()
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0, "消息列表要真的画出来")
    }

    /// **跨端可见性（验收 3）**：桌面端以夹具账号登录后，Web 端建的会话可见、可续聊 ——
    /// 判据是「请求真的带这个 `X-User-Id`」（后端 `ai_chat.py:31` 按它过滤归属）。
    func testConversationFromOtherClientIsVisibleAndContinuable() async throws {
        let model = makeSignedInModel(handler: try snapshotHandler())
        let (shell, navigation) = makeShell(model: model, routeID: AIChatView.routeID)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()

        await waitUntil { navigation.aiChat.contentStateReadyForSend }

        let conversationID = try AIChatFixtures.manifest().params.conversationID
        XCTAssertEqual(navigation.aiChat.conversations.map(\.id), [conversationID])
        XCTAssertEqual(navigation.aiChat.selectedConversationID, conversationID, "Web 端建的会话要自动选中")
        XCTAssertEqual(navigation.aiChat.messages.count, try AIChatFixtures.messages().count)

        // 每一条请求都必须带同一个 X-User-Id —— 这就是「同账号可见」的机制。
        for log in StubURLProtocol.log {
            XCTAssertEqual(log.header("X-User-Id"), Self.fixtureUserID, "\(log.method) \(log.path)")
        }

        // 在该会话上续聊：POST 到同一条路径，且带 body。
        navigation.aiChat.setText("接着聊")
        let provider = try XCTUnwrap(model.aiChatProvider())
        await navigation.aiChat.send(
            using: provider,
            scope: navigation.tasks,
            routeID: AIChatView.routeID
        )

        let streamLog = try XCTUnwrap(StubURLProtocol.log.last { $0.path.hasSuffix("/messages/stream") })
        XCTAssertEqual(streamLog.method, "POST")
        XCTAssertEqual(streamLog.path, "/api/v1/ai/conversations/\(conversationID)/messages/stream")
        XCTAssertEqual(streamLog.jsonObject?["content"] as? String, "接着聊")
        XCTAssertEqual(streamLog.header("Accept"), "text/event-stream")
        // 本轮真的跑到了 `done`（事件序列来自真帧），随后回读历史把草稿收敛成服务端真值：
        // 这是「可续聊」的另一半 —— 发出去的话与回来的回答都落到服务端。
        XCTAssertEqual(navigation.aiChat.lastEventKinds.last, "done")
        XCTAssertTrue(navigation.aiChat.composer.text.isEmpty, "发完清输入框")
        XCTAssertEqual(navigation.aiChat.messages.count, try AIChatFixtures.messages().count)
        XCTAssertTrue(navigation.aiChat.draft.text.isEmpty, "回读成功后草稿交给消息列表")
    }

    /// **未声明账号**的空态：请求不带 `X-User-Id` 时后端静默返回空表，界面必须画出与
    /// 「暂无会话」不同的提示（验收 3 的后半句）。
    func testUndeclaredAccountEmptyStateIsPainted() async throws {
        let model = makeSignedInModel(userID: "") { _ in .json(200, "[]") }
        let (shell, navigation) = makeShell(model: model, routeID: AIChatView.routeID)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()

        await waitUntil { navigation.aiChat.conversationsPhase == .loaded }

        XCTAssertEqual(navigation.aiChat.inboxState, .undeclaredAccount)
        XCTAssertFalse(navigation.aiChat.identity.isDeclared)

        hosted.pump()
        XCTAssertTrue(
            warningNoticeIsPainted(try hosted.bitmap()),
            "「未声明账号」要用一条可见的警示横幅画出来，不能渲染成普通空态"
        )
    }

    /// 「真的没有会话」是**正常空态**（不带警示条），与上一条形成对照。
    func testDeclaredAccountWithNoConversationsIsPlainEmptyState() async throws {
        let model = makeSignedInModel(handler: try snapshotHandler(overrides: [
            "/api/v1/ai/conversations": .json(200, "[]"),
        ]))
        let (shell, navigation) = makeShell(model: model, routeID: AIChatView.routeID)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()

        await waitUntil { navigation.aiChat.conversationsPhase == .loaded }

        XCTAssertEqual(navigation.aiChat.inboxState, .noConversations)
        hosted.pump()
        XCTAssertFalse(
            warningNoticeIsPainted(try hosted.bitmap()),
            "正常空态不该出现警示横幅（两种空必须长得不一样）"
        )
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0, "空态也要有文案")
    }

    /// 后端未配置 provider：页面照常渲染并给出明确警示（而 `canSend` 为假，不会白发请求）。
    func testUnconfiguredProviderIsSurfaced() async throws {
        let model = makeSignedInModel(handler: try snapshotHandler(configProviderConfigured: false))
        let (shell, navigation) = makeShell(model: model, routeID: AIChatView.routeID)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()

        await waitUntil { navigation.aiChat.configPhase == .loaded }

        XCTAssertFalse(navigation.aiChat.providerReady)
        navigation.aiChat.setText("你好")
        XCTAssertFalse(navigation.aiChat.canSend)
        XCTAssertTrue(navigation.aiChat.modelOptions.isEmpty, "未配置 provider 时真实响应里没有可用模型")

        hosted.pump()
        XCTAssertTrue(warningNoticeIsPainted(try hosted.bitmap()), "未配置 provider 要用警示条画出来")
    }

    // MARK: - 客服交流（端点 1 / 3 / 9）

    /// 客服交流页：配置 → 新建会话 → POST-SSE 生成，产物画在右栏。
    func testCustomerServiceGeneratesThroughRealRoutes() async throws {
        let conversationID = try AIChatFixtures.manifest().params.conversationID
        let turn = try AIChatFixtures.streamTurn()
        let createBody = """
        {"id": \(conversationID), "title": "客服交流", "created_at": "2026-09-14T10:00:00+08:00",
         "updated_at": "2026-09-14T10:00:00+08:00", "total_prompt_tokens": 0,
         "total_completion_tokens": 0, "total_tokens": 0}
        """
        let model = makeSignedInModel(handler: try snapshotHandler(overrides: [
            "/api/v1/ai/conversations": .json(201, createBody),
            "/api/v1/ai/conversations/\(conversationID)/messages/stream": .stream(200, chunks: [turn]),
        ]))
        let (shell, navigation) = makeShell(model: model, routeID: CustomerServiceView.routeID)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()

        await waitUntil { navigation.customerService.configPhase == .loaded }

        navigation.customerService.setFreeText("本周广告 ACOS 上升")
        navigation.customerService.selectTone(id: "brief")
        XCTAssertTrue(navigation.customerService.canGenerate)

        await navigation.customerService.generate(
            using: try XCTUnwrap(model.aiChatProvider()),
            scope: navigation.tasks,
            routeID: CustomerServiceView.routeID
        )

        let paths = StubURLProtocol.loggedPaths
        XCTAssertTrue(paths.contains("/api/v1/ai/conversations"), "实发：\(paths)")
        XCTAssertTrue(
            paths.contains("/api/v1/ai/conversations/\(conversationID)/messages/stream"),
            "实发：\(paths)"
        )
        XCTAssertEqual(navigation.customerService.conversationID, conversationID)
        XCTAssertFalse(navigation.customerService.outputText.isEmpty, "生成结果要落在产物区")
        XCTAssertEqual(
            navigation.customerService.outputText,
            try AIChatFixtures.messages().first { $0.isAssistant }?.content,
            "流式拼出来的正文必须等于落库正文（同源同结构）"
        )

        hosted.pump()
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0, "产物区要真的画出来")
    }

    /// 两页各自的 route id 在 `NavigationCatalog` 里命中真模块（未命中会退回占位视图）。
    func testBothRoutesAreRegisteredInModuleRegistry() async throws {
        let model = makeSignedInModel(handler: try snapshotHandler())
        for routeID in [AIChatView.routeID, CustomerServiceView.routeID] {
            let navigation = NavigationStore(preferences: InMemoryShellPreferencesStore())
            navigation.select(routeID: routeID)
            let item = try XCTUnwrap(navigation.selectedItem)
            XCTAssertNotNil(
                ModuleRegistry.view(for: item, model: model, navigation: navigation),
                "\(routeID) 应当命中真模块而不是占位视图"
            )
        }
    }

    /// 切换模块：AI 会话页的任务被 `cancelTree` 收掉（含在跑的 SSE），不留残任务。
    func testSwitchingModuleCancelsChatTasks() async throws {
        let conversationID = try AIChatFixtures.manifest().params.conversationID
        let model = makeSignedInModel(handler: try snapshotHandler(overrides: [
            // 永不结束的流：只有取消才会退出（模拟“回答还在生成时切走模块”）。
            "/api/v1/ai/conversations/\(conversationID)/messages/stream": .stream(
                200, chunks: ["id: 1-0\ndata: {\"type\":\"message_start\",\"message_id\":\"m1\",\"model\":\"m\"}\n\n"],
                holdsOpen: true
            ),
        ]))
        let (shell, navigation) = makeShell(model: model, routeID: AIChatView.routeID)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.aiChat.contentStateReadyForSend }

        let provider = try XCTUnwrap(model.aiChatProvider())
        navigation.aiChat.setText("在飞的这条")
        let sending = Task {
            await navigation.aiChat.send(
                using: provider,
                scope: navigation.tasks,
                routeID: AIChatView.routeID
            )
        }
        await waitUntil { navigation.aiChat.isStreaming }
        XCTAssertTrue(
            navigation.tasks.activeKeys.contains(AIChatCatalog.chatRouteID + ":stream"),
            "流式任务要登记在 route 子 key 下：\(navigation.tasks.activeKeys)"
        )

        // 切走模块 → 外壳按 route id 整棵树取消（`NavigationStore.changeRoute` → `cancelTree`）。
        navigation.select(routeID: AIChatCatalog.customerServiceRouteID)
        await sending.value

        XCTAssertFalse(navigation.aiChat.isStreaming)
        XCTAssertNil(navigation.aiChat.streamError, "切模块的取消不是错误")
        XCTAssertTrue(
            navigation.tasks.activeKeys.allSatisfy { !$0.hasPrefix(AIChatView.routeID) },
            "切走后不该还有 AI Chat 的任务：\(navigation.tasks.activeKeys)"
        )
    }
}

extension AIChatStore {
    /// 渲染用例的等待条件：会话与消息都就绪、并且已经可以发请求。
    var contentStateReadyForSend: Bool {
        conversationsPhase == .loaded && !messages.isEmpty && providerReady
    }
}
