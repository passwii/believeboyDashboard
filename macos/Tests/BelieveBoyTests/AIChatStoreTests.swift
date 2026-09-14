import BelieveBoyKit
import Foundation
import XCTest

@testable import BelieveBoyUI

/// 可编排的 AI 会话数据源假实现：每个端点都能独立设「成功值 / 失败 / 挂起」，流式端点还能
/// 逐帧编排。
///
/// 为什么需要它（而不是只打桩 URLProtocol）：本页有四条必须精确控制时序的分支 ——
/// 「切会话 / 切模块时在跑的 SSE 被拆掉，且取消不落成错误态」「刷新失败保留旧列表」
/// 「未声明账号与真的没有会话要区分」「停止生成先后端 cancel + 本地拆流」。这些都要求
/// **让某个请求永远不返回**（挂起源），而 URLProtocol 只能在响应里返回内容。
final class ScriptedAIChatProvider: AIChatDataProviding, @unchecked Sendable {
    enum Outcome<Value: Sendable>: Sendable {
        case value(Value)
        /// 抛 `APIError`（贴近真实失败形态：非 2xx）。
        case failure(status: Int)
        /// 一直挂起，直到任务被取消 —— 用来观测 loading 中间态与取消行为。
        case hang
        /// 「活流」：由用例用 `emit(_:)` 逐帧推送。用来造**帧在切换之后才到达**的竞态
        /// （切会话 / 新建会话那一瞬间旧流还活着的窗口）——`.value` / `.hang` 都造不出来。
        case live
    }

    /// 挂起源被取消时的记录器。
    let cancellation = CancellationRecorder()

    private let lock = NSLock()
    private var configOutcome: Outcome<AIChatConfig>
    private var conversationsOutcome: Outcome<[AIChatConversation]>
    private var messagesOutcome: Outcome<[AIChatMessage]>
    private var usageOutcome: Outcome<AIChatUsageStats>
    private var createOutcome: Outcome<AIChatConversation>
    private var uploadOutcome: Outcome<AIFileUploadResponse>
    private var streamOutcome: Outcome<[AIChatStreamFrame]>

    private var createdConversations: [String?] = []
    private var renameCalls: [(id: Int, title: String)] = []
    private var deleteConversationCalls: [Int] = []
    private var editCalls: [(messageID: Int, content: String)] = []
    private var deleteMessageCalls: [Int] = []
    private var cancelCalls: [Int] = []
    private var uploadCalls: [(filename: String, mimeType: String)] = []
    private var usageRanges: [AIChatUsageRange] = []
    private var messagesRequests: [Int] = []
    private var streamRequests: [StreamRequest] = []
    /// 后端 cancel 端点的回包延迟（默认 0）。
    private var cancelDelayNanos: UInt64 = 0
    /// 在飞的活流（`case live`）的 continuation，由 `emit(_:)` 推帧。
    private var liveStreams: [UUID: AsyncThrowingStream<AIChatStreamFrame, Error>.Continuation] = [:]

    struct StreamRequest: Sendable {
        let conversationID: Int
        let content: String
        let systemPrompt: String
        let lastEventID: String?
        let regenerate: Bool
        let enableWebSearch: Bool
        let attachedFileContent: String?
    }

    init(
        config: Outcome<AIChatConfig> = .value(.unconfigured),
        conversations: Outcome<[AIChatConversation]> = .value([]),
        messages: Outcome<[AIChatMessage]> = .value([]),
        usage: Outcome<AIChatUsageStats> = .value(.empty(range: .thirtyDays)),
        create: Outcome<AIChatConversation> = .value(.fixture(id: 100)),
        upload: Outcome<AIFileUploadResponse> = .value(
            AIFileUploadResponse(fileName: "a.csv", fileType: "csv", content: "解析正文")
        ),
        stream: Outcome<[AIChatStreamFrame]> = .value([])
    ) {
        self.configOutcome = config
        self.conversationsOutcome = conversations
        self.messagesOutcome = messages
        self.usageOutcome = usage
        self.createOutcome = create
        self.uploadOutcome = upload
        self.streamOutcome = stream
    }

    // MARK: - 编排

    func setConversations(_ outcome: Outcome<[AIChatConversation]>) { withLock { conversationsOutcome = outcome } }
    func setMessages(_ outcome: Outcome<[AIChatMessage]>) { withLock { messagesOutcome = outcome } }
    func setConfig(_ outcome: Outcome<AIChatConfig>) { withLock { configOutcome = outcome } }
    func setUsage(_ outcome: Outcome<AIChatUsageStats>) { withLock { usageOutcome = outcome } }
    func setCreate(_ outcome: Outcome<AIChatConversation>) { withLock { createOutcome = outcome } }
    func setUpload(_ outcome: Outcome<AIFileUploadResponse>) { withLock { uploadOutcome = outcome } }
    func setStream(_ outcome: Outcome<[AIChatStreamFrame]>) { withLock { streamOutcome = outcome } }
    /// 把 cancel 端点的回包拖慢 —— 用来造「上一轮的取消回包比下一轮晚到」的竞态。
    func setCancelDelay(nanoseconds: UInt64) { withLock { cancelDelayNanos = nanoseconds } }

    // MARK: - 观测

    var createTitles: [String?] { withLock { createdConversations } }
    var renames: [(id: Int, title: String)] { withLock { renameCalls } }
    var deletedConversationIDs: [Int] { withLock { deleteConversationCalls } }
    var edits: [(messageID: Int, content: String)] { withLock { editCalls } }
    var deletedMessageIDs: [Int] { withLock { deleteMessageCalls } }
    var cancelledConversationIDs: [Int] { withLock { cancelCalls } }
    var uploadedFiles: [(filename: String, mimeType: String)] { withLock { uploadCalls } }
    var requestedUsageRanges: [AIChatUsageRange] { withLock { usageRanges } }
    var loadedMessageConversationIDs: [Int] { withLock { messagesRequests } }
    var streams: [StreamRequest] { withLock { streamRequests } }

    /// 向当前所有活流推帧。返回 `false` = 没有活流（流已被拆掉 / 已结束）。
    @discardableResult
    func emit(_ frames: [AIChatStreamFrame]) -> Bool {
        let continuations = withLock { Array(liveStreams.values) }
        guard !continuations.isEmpty else { return false }
        for frame in frames {
            for continuation in continuations { continuation.yield(frame) }
        }
        return true
    }

    /// 正常结束活流（不是取消）。
    func finishLiveStreams() {
        let continuations = withLock { Array(liveStreams.values) }
        for continuation in continuations { continuation.finish() }
    }

    // MARK: - AIChatDataProviding

    func config() async throws -> AIChatConfig {
        try await resolve(withLock { configOutcome })
    }

    func conversations() async throws -> [AIChatConversation] {
        try await resolve(withLock { conversationsOutcome })
    }

    func createConversation(title: String?) async throws -> AIChatConversation {
        let outcome = withLock {
            createdConversations.append(title)
            return createOutcome
        }
        return try await resolve(outcome)
    }

    func renameConversation(id: Int, title: String) async throws -> AIChatConversation {
        let outcome = withLock {
            renameCalls.append((id, title))
            return Outcome<AIChatConversation>.value(
                .fixture(id: id, title: title)
            )
        }
        return try await resolve(outcome)
    }

    func deleteConversation(id: Int) async throws {
        withLock { deleteConversationCalls.append(id) }
    }

    func messages(conversationID: Int) async throws -> [AIChatMessage] {
        let outcome = withLock {
            messagesRequests.append(conversationID)
            return messagesOutcome
        }
        return try await resolve(outcome)
    }

    func editMessage(conversationID: Int, messageID: Int, content: String) async throws -> AIChatMessage {
        withLock { editCalls.append((messageID, content)) }
        return AIChatMessage(
            id: messageID, conversationId: conversationID, role: "user", content: content
        )
    }

    func deleteMessage(conversationID: Int, messageID: Int) async throws {
        withLock { deleteMessageCalls.append(messageID) }
    }

    func send(
        conversationID: Int,
        payload: AIChatSendPayload,
        lastEventID: String?
    ) -> AsyncThrowingStream<AIChatStreamFrame, Error> {
        let outcome = withLock {
            streamRequests.append(
                StreamRequest(
                    conversationID: conversationID,
                    content: payload.content,
                    systemPrompt: payload.systemPrompt,
                    lastEventID: lastEventID,
                    regenerate: payload.regenerate,
                    enableWebSearch: payload.enableWebSearch,
                    attachedFileContent: payload.attachedFileContent
                )
            )
            return streamOutcome
        }

        return AsyncThrowingStream { continuation in
            if case .live = outcome {
                let id = UUID()
                withLock { liveStreams[id] = continuation }
                // 活流不主动结束：由用例 emit / finishLiveStreams；被取消时按 `.hang` 同口径记账。
                let holder = Task { try? await Task.sleep(nanoseconds: 30_000_000_000) }
                continuation.onTermination = { [weak self] reason in
                    holder.cancel()
                    guard let self else { return }
                    self.withLock { self.liveStreams[id] = nil }
                    if case .cancelled = reason { self.cancellation.markCancelled() }
                }
                return
            }
            let task = Task { [cancellation] in
                switch outcome {
                case .value(let frames):
                    for frame in frames {
                        if Task.isCancelled { break }
                        continuation.yield(frame)
                    }
                    continuation.finish()
                case .failure(let status):
                    continuation.finish(throwing: APIError.http(status: status, body: "stub failure"))
                case .hang:
                    do {
                        try await Task.sleep(nanoseconds: 30_000_000_000)
                    } catch {
                        // 消费方取消 → 拆流：这里就是「SSE 连接被拆掉」的观测点。
                        cancellation.markCancelled()
                        continuation.finish()
                        return
                    }
                    continuation.finish()
                case .live:
                    // 上面已经提前返回（活流不走这条 task）；这里只为穷举。
                    continuation.finish()
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func cancel(conversationID: Int) async throws -> AIChatCancelResponse {
        let delay = withLock { () -> UInt64 in
            cancelCalls.append(conversationID)
            return cancelDelayNanos
        }
        // 默认 0：绝大多数用例不在乎取消回包的时机。设成非 0 才能造出「回包比下一轮晚」
        // 的竞态（见 `CustomerServiceStoreTests`）。
        if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
        return AIChatCancelResponse(cancelled: true)
    }

    func upload(fileURL: URL, filename: String, mimeType: String) async throws -> AIFileUploadResponse {
        let outcome = withLock {
            uploadCalls.append((filename, mimeType))
            return uploadOutcome
        }
        return try await resolve(outcome)
    }

    func usageStats(range: AIChatUsageRange) async throws -> AIChatUsageStats {
        let outcome = withLock {
            usageRanges.append(range)
            return usageOutcome
        }
        return try await resolve(outcome)
    }

    // MARK: - 内部

    private func resolve<Value: Sendable>(_ outcome: Outcome<Value>) async throws -> Value {
        switch outcome {
        case .value(let value):
            return value
        case .failure(let status):
            if status == 401 || status == 403 {
                throw APIError.unauthorized(status: status, body: "stub failure")
            }
            throw APIError.http(status: status, body: "stub failure")
        case .hang:
            do {
                try await Task.sleep(nanoseconds: 30_000_000_000)
            } catch {
                cancellation.markCancelled()
                throw error
            }
            throw APIError.transport("stub 挂起源未在取消时退出")
        case .live:
            throw APIError.transport("stub 活流只用于流式端点")
        }
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

// MARK: - 夹具

extension AIChatConfig {
    /// 抓取环境（未配置 provider）的真实形状。
    static let unconfigured = AIChatConfig(
        providerConfigured: false,
        webSearchConfigured: false,
        models: [],
        defaultModel: ""
    )
}

extension AIChatConversation {
    static func fixture(id: Int, title: String? = nil) -> AIChatConversation {
        AIChatConversation(
            id: id,
            title: title ?? "会话 \(id)",
            createdAt: "2026-09-14T10:00:00+08:00",
            updatedAt: "2026-09-14T10:00:00+08:00"
        )
    }
}

extension AIChatMessage {
    static func fixture(
        id: Int,
        conversationID: Int,
        role: String = "user",
        content: String = "内容",
        sources: [AIChatSearchSource] = []
    ) -> AIChatMessage {
        AIChatMessage(
            id: id,
            conversationId: conversationID,
            role: role,
            content: content,
            searchSources: sources,
            createdAt: "2026-09-14T10:00:00+08:00"
        )
    }
}

extension AIChatUsageStats {
    static func empty(range: AIChatUsageRange) -> AIChatUsageStats {
        AIChatUsageStats(
            range: range.rawValue,
            startDate: "2026-08-17",
            endDate: "2026-09-15",
            totals: AIChatUsageTotals(),
            daily: [],
            byModel: [],
            snapshotFreshness: AIChatUsageFreshness()
        )
    }
}

extension AIChatStreamFrame {
    static func event(_ event: AIChatStreamEvent, id: String? = nil) -> AIChatStreamFrame {
        AIChatStreamFrame(event: event, eventID: id)
    }
}

/// 「AI 智能 → AI Chat」状态机：三态 / 空态两种成因 / 取消语义 / 写面二次确认 / 续传。
@MainActor
final class AIChatStoreTests: XCTestCase {
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

    private let routeID = AIChatCatalog.chatRouteID

    private func makeScope() -> ModuleTaskScope {
        let scope = ModuleTaskScope()
        scopes.append(scope)
        return scope
    }

    private func makeStore() -> AIChatStore {
        AIChatStore()
    }

    // MARK: - 三态与空态（口径 3 / 4）

    func testInboxFailureThenRetrySucceeds() async {
        let provider = ScriptedAIChatProvider(conversations: .failure(status: 500))
        let store = makeStore()
        let scope = makeScope()

        await store.load(
            using: provider, scope: scope, routeID: routeID, identity: .declared(userID: "1")
        )
        guard case .failed(let message) = store.inboxState else {
            return XCTFail("应当是失败态，实际 \(store.inboxState)")
        }
        XCTAssertTrue(message.contains("stub failure"))

        provider.setConversations(.value([.fixture(id: 7)]))
        await store.loadConversations(using: provider)

        XCTAssertEqual(store.inboxState, .ready)
        XCTAssertEqual(store.conversations.map(\.id), [7])
    }

    /// 口径 3：**未声明账号**与**真的没有会话**都返回空表，界面必须区分。
    func testUndeclaredAccountIsDistinctFromNoConversations() async {
        let provider = ScriptedAIChatProvider(conversations: .value([]))
        let store = makeStore()
        let scope = makeScope()

        await store.load(
            using: provider, scope: scope, routeID: routeID, identity: .undeclared
        )
        XCTAssertEqual(store.inboxState, .undeclaredAccount)
        XCTAssertFalse(store.identity.isDeclared)

        await store.load(
            using: provider, scope: scope, routeID: routeID, identity: .declared(userID: "42")
        )
        XCTAssertEqual(store.inboxState, .noConversations)
        XCTAssertTrue(store.identity.isDeclared)
        XCTAssertEqual(store.identity.userID, "42")
    }

    /// 口径 4：有旧数据时刷新失败**保留旧列表**，只挂一条提示。
    func testRefreshFailureKeepsPreviousConversations() async {
        let provider = ScriptedAIChatProvider(conversations: .value([.fixture(id: 7), .fixture(id: 8)]))
        let store = makeStore()
        let scope = makeScope()

        await store.loadConversations(using: provider, identity: .declared(userID: "1"))
        XCTAssertEqual(store.conversations.count, 2)

        provider.setConversations(.failure(status: 503))
        await store.loadConversations(using: provider)

        XCTAssertEqual(store.conversations.count, 2, "刷新失败不得把旧列表清空")
        XCTAssertEqual(store.inboxState, .ready)
        XCTAssertNotNil(store.conversationsRefreshFailure)
    }

    /// 空会话列表是**正常空态**，不是错误。
    func testEmptyInboxIsNotAFailure() async {
        let provider = ScriptedAIChatProvider(conversations: .value([]))
        let store = makeStore()

        await store.loadConversations(using: provider, identity: .declared(userID: "1"))

        XCTAssertEqual(store.conversationsPhase, .loaded)
        XCTAssertNil(store.conversationsRefreshFailure)
        XCTAssertEqual(store.inboxState, .noConversations)
    }

    /// 进页一次拉三样：会话列表 + 配置 + 用量（各自独立登记，互不取消）。
    func testLoadFetchesConversationsConfigAndUsage() async {
        let provider = ScriptedAIChatProvider(
            conversations: .value([.fixture(id: 7)]),
            messages: .value([.fixture(id: 11, conversationID: 7)])
        )
        let store = makeStore()
        let scope = makeScope()

        await store.load(
            using: provider, scope: scope, routeID: routeID, identity: .declared(userID: "1")
        )

        XCTAssertEqual(store.conversationsPhase, .loaded)
        XCTAssertEqual(store.configPhase, .loaded)
        XCTAssertEqual(store.usagePhase, .loaded)
        XCTAssertEqual(store.selectedConversationID, 7, "自动选中第一个会话（与 Web 同口径）")
        XCTAssertEqual(store.messages.map(\.id), [11])
        XCTAssertEqual(provider.requestedUsageRanges, [.thirtyDays])
    }

    // MARK: - 切会话 / 取消（口径 4）

    /// 切会话：拆掉在跑的 SSE + 拉新会话的消息，且**不落错误态**。
    func testSelectingConversationCancelsRunningStream() async {
        let provider = ScriptedAIChatProvider(
            conversations: .value([.fixture(id: 7), .fixture(id: 8)]),
            messages: .value([]),
            stream: .hang
        )
        let store = makeStore()
        let scope = makeScope()

        await store.load(
            using: provider, scope: scope, routeID: routeID, identity: .declared(userID: "1")
        )
        store.setText("第二条")
        let sending = Task { await store.send(using: provider, scope: scope, routeID: routeID) }
        try? await Task.sleep(nanoseconds: 20_000_000)

        await store.selectConversation(id: 8, using: provider, scope: scope, routeID: routeID)
        await sending.value

        XCTAssertTrue(provider.cancellation.isCancelled, "切会话必须拆掉在跑的 SSE 连接")
        XCTAssertNil(store.streamError, "取消不落错误态")
        XCTAssertFalse(store.isStreaming)
        XCTAssertEqual(store.selectedConversationID, 8)
        XCTAssertEqual(provider.loadedMessageConversationIDs.last, 8)
    }

    /// **回归（Tia 复核阻塞项）**：SSE 在跑时点「新对话」—— 旧流的连接要被拆掉，且上一会话的
    /// 草稿 / 游标 / 载荷不得留在新会话的页面上（口径 4：切会话取消在跑请求）。
    ///
    /// 用 `.live` 活流（而不是 `.hang`）才能让「旧流正在出字」这个前提成立：
    /// `draft` 是 **store 级**的展示面，它没被作废时旧会话的半截回答会画在新会话上。
    func testCreatingConversationCancelsRunningStreamAndDropsPreviousDraft() async {
        let provider = ScriptedAIChatProvider(
            conversations: .value([.fixture(id: 7)]),
            messages: .value([]),
            create: .value(.fixture(id: 99, title: "新会话")),
            stream: .live
        )
        let store = makeStore()
        let scope = makeScope()

        await store.load(
            using: provider, scope: scope, routeID: routeID, identity: .declared(userID: "1")
        )
        store.setText("旧会话的问题")
        let sending = Task { await store.send(using: provider, scope: scope, routeID: routeID) }
        try? await Task.sleep(nanoseconds: 20_000_000)
        provider.emit([.event(.contentBlockDelta(index: 0, delta: .text("旧会话半句")), id: "7-0")])
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(store.streamingConversationID, 7)
        XCTAssertEqual(store.draft.text, "旧会话半句")
        XCTAssertEqual(store.resumeCursor, "7-0")

        await store.createConversation(using: provider, scope: scope, routeID: routeID)
        // 收尾让 `sending` 能等到（新码里流已拆，这一步是空操作；旧码里它让用例**失败**而
        // 不是挂死 —— 「旧流永远不结束」本身就是回归点，但不该表现成测试卡住）。
        provider.finishLiveStreams()
        await sending.value

        XCTAssertEqual(store.selectedConversationID, 99, "新会话要选中")
        XCTAssertTrue(provider.cancellation.isCancelled, "点新对话必须拆掉旧会话的 SSE 连接")
        XCTAssertNil(store.streamingConversationID, "旧流的归属要一并摘掉")
        XCTAssertFalse(store.isStreaming)
        XCTAssertEqual(store.draft.text, "", "上一会话的草稿不得画在新会话上")
        XCTAssertEqual(store.draft.eventKinds, [])
        XCTAssertNil(store.resumeCursor, "游标作废（不得拿旧会话的游标去续新会话的流）")
        XCTAssertNil(store.lastSentPayload)
        XCTAssertFalse(store.canResume)
        XCTAssertNil(store.streamError, "切会话 / 新建会话不是错误态")
    }

    /// **回归（Tia 复核阻塞项）**：旧会话的 `done` 在「已经切到新会话」之后才到达时，
    /// 不得把旧会话的标题 / token 写到新会话上。
    ///
    /// 两条防线各断言一次：（1）旧流被拆掉 —— 帧根本推不进去；（2）就算推进去了，归属守卫
    /// 也会丢弃它（`applyCompletedTurnMetadata` 按**发起这一轮的会话**落地，而非当时的
    /// `selectedConversationID`）。
    func testLateDoneFromPreviousConversationDoesNotTouchNewConversation() async {
        let provider = ScriptedAIChatProvider(
            conversations: .value([.fixture(id: 7, title: "旧会话")]),
            messages: .value([]),
            create: .value(.fixture(id: 99, title: "新会话")),
            stream: .live
        )
        let store = makeStore()
        let scope = makeScope()

        await store.load(
            using: provider, scope: scope, routeID: routeID, identity: .declared(userID: "1")
        )
        store.setText("旧会话的问题")
        let sending = Task { await store.send(using: provider, scope: scope, routeID: routeID) }
        try? await Task.sleep(nanoseconds: 20_000_000)

        await store.createConversation(using: provider, scope: scope, routeID: routeID)

        let lateDone = AIChatStreamFrame.event(.done(
            AIChatStreamDone(
                assistantMessage: .fixture(
                    id: 12, conversationID: 7, role: "assistant", content: "旧会话的回答"
                ),
                conversationTitle: "旧会话自动标题",
                conversationTokenUsage: AIChatTokenUsage(
                    promptTokens: 10, completionTokens: 20, totalTokens: 30
                )
            )
        ))
        // 切换之后立刻推一帧：此时取消可能已经生效、也可能还在传播，两条路径都必须无副作用。
        _ = provider.emit([lateDone])
        provider.finishLiveStreams()
        await sending.value

        XCTAssertTrue(provider.cancellation.isCancelled, "旧会话的 SSE 必须被拆掉")
        XCTAssertFalse(provider.emit([lateDone]), "拆掉之后旧流的帧一律推不进去")
        try? await Task.sleep(nanoseconds: 30_000_000)

        XCTAssertEqual(
            store.conversations.first { $0.id == 99 }?.title, "新会话",
            "旧会话的标题不得写到新会话上"
        )
        XCTAssertEqual(
            store.conversations.first { $0.id == 99 }?.totalTokens, 0,
            "旧会话的 token 不得写到新会话上"
        )
        XCTAssertEqual(store.conversations.first?.id, 99, "列表顺序不变（旧会话没有「刚动过」）")
        XCTAssertEqual(store.conversations.first { $0.id == 7 }?.title, "旧会话", "旧会话本身也没被凭空改名")
        XCTAssertEqual(store.draft.text, "", "旧流的 done 不得留下草稿")
    }

    /// 切会话（不是新建）同样要作废上一会话的流式状态 —— 草稿/游标是 store 级的展示面。
    func testSelectingConversationDropsPreviousDraftAndCursor() async {
        let provider = ScriptedAIChatProvider(
            conversations: .value([.fixture(id: 7), .fixture(id: 8)]),
            messages: .value([]),
            stream: .live
        )
        let store = makeStore()
        let scope = makeScope()

        await store.load(
            using: provider, scope: scope, routeID: routeID, identity: .declared(userID: "1")
        )
        store.setText("旧会话的问题")
        let sending = Task { await store.send(using: provider, scope: scope, routeID: routeID) }
        try? await Task.sleep(nanoseconds: 20_000_000)
        provider.emit([.event(.contentBlockDelta(index: 0, delta: .text("旧半句")), id: "7-0")])
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertEqual(store.draft.text, "旧半句")

        await store.selectConversation(id: 8, using: provider, scope: scope, routeID: routeID)
        provider.finishLiveStreams()
        await sending.value

        XCTAssertTrue(provider.cancellation.isCancelled)
        XCTAssertEqual(store.selectedConversationID, 8)
        XCTAssertEqual(store.draft.text, "", "切过去的会话不该看到上一会话的草稿")
        XCTAssertNil(store.resumeCursor)
        XCTAssertFalse(store.canResume)
        XCTAssertNil(store.streamError)
    }

    /// 取消（切模块）不落错误态，也不把已有列表清掉。
    func testCancellingScopeLeavesNoErrorState() async {
        let provider = ScriptedAIChatProvider(
            conversations: .value([.fixture(id: 7)]),
            messages: .hang
        )
        let store = makeStore()
        let scope = makeScope()

        await store.loadConversations(using: provider)
        let loading = Task {
            await store.selectConversation(id: 7, using: provider, scope: scope, routeID: routeID)
        }
        try? await Task.sleep(nanoseconds: 20_000_000)

        scope.cancelTree(key: routeID)
        await loading.value

        XCTAssertNil(store.messagesPhase.failureMessage, "取消不得落成错误态")
        XCTAssertTrue(store.messages.isEmpty)
        XCTAssertEqual(store.conversations.count, 1, "取消不得清掉会话列表")
    }

    /// `cancelTree` 只收掉该 route 的子树 —— 别的模块的任务不受影响（S5.4 的子 key 语义）。
    func testCancelTreeOnlyAffectsItsOwnSubtree() {
        let scope = makeScope()
        let other = CancellationRecorder()
        scope.run(key: "\(routeID):messages") { _ = try? await Task.sleep(nanoseconds: 5_000_000_000) }
        scope.run(key: "/dashboard/advertising/ad-data") {
            _ = try? await Task.sleep(nanoseconds: 5_000_000_000)
            other.markCancelled()
        }
        XCTAssertEqual(scope.activeKeys.count, 2)

        scope.cancelTree(key: routeID)

        XCTAssertEqual(scope.activeKeys, ["/dashboard/advertising/ad-data"], "只取消自己的子树")
    }

    // MARK: - 流式生成（口径 2 / 8）

    /// 一次成功生成：请求带 system prompt、草稿折出来、输入框清空、标题与 token 落地。
    func testSendAppliesDonePayload() async {
        let provider = ScriptedAIChatProvider(
            config: .value(
                AIChatConfig(
                    providerConfigured: true, webSearchConfigured: true, models: ["m"],
                    defaultModel: "m"
                )
            ),
            conversations: .value([.fixture(id: 7, title: AIChatCatalog.defaultConversationTitle)]),
            messages: .value([]),
            stream: .value([
                .event(.messageStart(messageID: "m1", model: "m", createdAtMillis: 0), id: "1-0"),
                .event(.contentBlockStart(index: 0, block: .text), id: "1-1"),
                .event(.contentBlockDelta(index: 0, delta: .text("你好")), id: "1-2"),
                .event(.contentBlockStop(index: 0), id: "1-3"),
                .event(.messageDelta(usage: AIChatDeltaUsage(inputTokens: 1, outputTokens: 2, totalTokens: 3), stopReason: "end_turn"), id: "1-3"),
                .event(.messageStop, id: "1-3"),
                .event(.done(
                    AIChatStreamDone(
                        userMessage: .fixture(id: 11, conversationID: 7),
                        assistantMessage: .fixture(id: 12, conversationID: 7, role: "assistant", content: "你好"),
                        conversationTitle: "自动标题",
                        tokenUsage: AIChatTokenUsage(promptTokens: 10, completionTokens: 20, totalTokens: 30),
                        conversationTokenUsage: AIChatTokenUsage(promptTokens: 10, completionTokens: 20, totalTokens: 30),
                        durationMs: 1_200
                    )
                )),
            ])
        )
        let store = makeStore()
        let scope = makeScope()

        await store.load(
            using: provider, scope: scope, routeID: routeID, identity: .declared(userID: "1")
        )
        store.setText("你好")
        store.setWebSearchEnabled(true)
        await store.send(using: provider, scope: scope, routeID: routeID)

        XCTAssertEqual(store.draft.outcome, .completed)
        XCTAssertEqual(store.draft.text, "你好")
        XCTAssertEqual(store.composer.text, "", "发送成功后清空输入框")
        XCTAssertNil(store.streamError)
        XCTAssertEqual(store.conversations.first?.title, "自动标题", "首轮自动改名要落到列表上")
        XCTAssertEqual(store.conversations.first?.totalTokens, 30)
        XCTAssertEqual(store.resumeCursor, "1-3", "最后一帧的游标留着（可续传）")

        let request = provider.streams[0]
        XCTAssertEqual(request.content, "你好")
        XCTAssertTrue(request.enableWebSearch)
        XCTAssertTrue(request.systemPrompt.contains(AIChatPresetCatalog.baseInstruction))
        XCTAssertNil(request.lastEventID, "首次请求不带游标")
    }

    /// 续传（口径 2）：**同一个 POST、同一份 body**，只多一个 `Last-Event-ID`。
    func testResumeReusesPayloadAndCursor() async {
        let provider = ScriptedAIChatProvider(
            config: .value(AIChatConfig(providerConfigured: true, webSearchConfigured: false, models: ["m"], defaultModel: "m")),
            conversations: .value([.fixture(id: 7)]),
            stream: .value([
                .event(.messageStart(messageID: "m1", model: "m", createdAtMillis: 0), id: "9-0"),
                .event(.contentBlockDelta(index: 0, delta: .text("半句")), id: "9-1"),
            ])
        )
        let store = makeStore()
        let scope = makeScope()

        await store.load(using: provider, scope: scope, routeID: routeID, identity: .declared(userID: "1"))
        store.setText("问题")
        await store.send(using: provider, scope: scope, routeID: routeID)

        XCTAssertNotNil(store.streamError, "没有终态就结束连接 → 要提示可续传")
        XCTAssertTrue(store.canResume)
        XCTAssertEqual(store.resumeCursor, "9-1")

        provider.setStream(.value([
            .event(.contentBlockDelta(index: 0, delta: .text("补上")), id: "9-2"),
            .event(.messageStop, id: "9-2"),
        ]))
        await store.resume(using: provider, scope: scope, routeID: routeID)

        XCTAssertEqual(provider.streams.count, 2)
        XCTAssertEqual(provider.streams[1].lastEventID, "9-1", "续传必须带游标")
        XCTAssertEqual(provider.streams[1].content, provider.streams[0].content, "并必须重发同一份 body")
        XCTAssertEqual(store.draft.outcome, .stoppedWithoutDone, "续传路径没有 done 是合法的")
        XCTAssertEqual(store.draft.text, "半句补上", "两段增量拼起来")
        XCTAssertNil(store.streamError)
    }

    /// 停止生成（口径 5）：先拆本地流，再打后端 cancel；**不落错误态**。
    func testStopGenerationTearsDownStreamAndCallsCancel() async {
        let provider = ScriptedAIChatProvider(
            config: .value(AIChatConfig(providerConfigured: true, webSearchConfigured: false, models: ["m"], defaultModel: "m")),
            conversations: .value([.fixture(id: 7)]),
            stream: .hang
        )
        let store = makeStore()
        let scope = makeScope()

        await store.load(using: provider, scope: scope, routeID: routeID, identity: .declared(userID: "1"))
        store.setText("长回答")
        let sending = Task { await store.send(using: provider, scope: scope, routeID: routeID) }
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertTrue(store.isStreaming)

        store.stopGeneration(using: provider, scope: scope, routeID: routeID)
        await sending.value
        // cancel 端点在另一个子 key 上跑，等它落地。
        try? await Task.sleep(nanoseconds: 30_000_000)

        XCTAssertTrue(provider.cancellation.isCancelled, "停止必须拆掉本地 SSE 连接")
        XCTAssertEqual(provider.cancelledConversationIDs, [7], "并且要通知后端取消（跨 worker）")
        XCTAssertFalse(store.isStreaming)
        XCTAssertNil(store.streamError, "停止不是错误")
        XCTAssertNil(store.resumeCursor, "停止后游标作废")
    }

    /// 后端 `error` 事件：既保留已收到的正文，也给出可展示的错误。
    func testBackendErrorEventKeepsPartialDraft() async {
        let provider = ScriptedAIChatProvider(
            config: .value(AIChatConfig(providerConfigured: true, webSearchConfigured: false, models: ["m"], defaultModel: "m")),
            conversations: .value([.fixture(id: 7)]),
            stream: .value([
                .event(.contentBlockDelta(index: 0, delta: .text("先写了半句")), id: "3-0"),
                .event(.error(code: "overloaded", message: "服务繁忙"), id: "3-1"),
            ])
        )
        let store = makeStore()
        let scope = makeScope()

        await store.load(using: provider, scope: scope, routeID: routeID, identity: .declared(userID: "1"))
        store.setText("问题")
        await store.send(using: provider, scope: scope, routeID: routeID)

        XCTAssertEqual(store.draft.text, "先写了半句")
        XCTAssertEqual(store.streamError, "服务繁忙（overloaded）")
        XCTAssertEqual(store.composer.text, "问题", "失败时不清空输入框（用户要能重试）")
    }

    /// 输入守卫：超长 / 空内容 / 没有会话都不发。
    func testComposerGuardsBlockSend() async {
        let provider = ScriptedAIChatProvider(
            config: .value(AIChatConfig(providerConfigured: true, webSearchConfigured: false, models: ["m"], defaultModel: "m")),
            conversations: .value([.fixture(id: 7)])
        )
        let store = makeStore()
        let scope = makeScope()

        store.setText("   ")
        XCTAssertFalse(store.composer.canSend, "空白内容不发")

        store.setText(String(repeating: "字", count: AIChatCatalog.maxMessageLength + 1))
        XCTAssertFalse(store.composer.canSend)
        XCTAssertNotNil(store.composer.lengthWarning)
        XCTAssertEqual(store.composer.lengthWarning?.contains("8000"), true)

        store.setText(String(repeating: "字", count: AIChatCatalog.maxMessageLength))
        XCTAssertTrue(store.composer.canSend)
        store.setOverviewPromptID("overview-nope")
        XCTAssertFalse(AIChatPresetCatalog.isValidPromptIDs(overviewID: "overview-nope", detailID: nil))

        await store.send(using: provider, scope: scope, routeID: routeID)
        XCTAssertTrue(provider.streams.isEmpty, "未选中会话时不该发流请求")
    }

    /// 未配置 provider 时 `canSend` 为假（后端确实会失败，不该让用户白等一次）。
    func testUnconfiguredProviderBlocksSend() async {
        let provider = ScriptedAIChatProvider(
            conversations: .value([.fixture(id: 7)]),
            messages: .value([])
        )
        let store = makeStore()
        let scope = makeScope()

        await store.load(using: provider, scope: scope, routeID: routeID, identity: .declared(userID: "1"))
        store.setText("你好")

        XCTAssertFalse(store.providerReady)
        XCTAssertFalse(store.canSend)
    }

    // MARK: - 写面与二次确认（口径 6 / 7）

    func testDeleteConversationRequiresConfirmation() async {
        let provider = ScriptedAIChatProvider(
            conversations: .value([.fixture(id: 7, title: "要删的会话")])
        )
        let store = makeStore()
        let scope = makeScope()

        await store.loadConversations(using: provider)
        store.requestDelete(conversation: .fixture(id: 7, title: "要删的会话"))
        XCTAssertEqual(store.pendingConfirmation, .deleteConversation(id: 7, title: "要删的会话"))
        XCTAssertTrue(provider.deletedConversationIDs.isEmpty, "只是打开确认，不能已删")

        store.dismissConfirmation()
        XCTAssertNil(store.pendingConfirmation)
        XCTAssertTrue(provider.deletedConversationIDs.isEmpty)

        store.requestDelete(conversation: .fixture(id: 7, title: "要删的会话"))
        await store.confirmPending(using: provider, scope: scope, routeID: routeID)

        XCTAssertNil(store.pendingConfirmation)
        XCTAssertEqual(provider.deletedConversationIDs, [7])
        XCTAssertTrue(store.conversations.isEmpty)
        XCTAssertNil(store.selectedConversationID)
    }

    func testDeleteMessageRequiresConfirmationAndTruncatesPreview() async {
        let provider = ScriptedAIChatProvider(
            conversations: .value([.fixture(id: 7)]),
            messages: .value([
                .fixture(id: 11, conversationID: 7, content: "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十"),
            ])
        )
        let store = makeStore()
        let scope = makeScope()

        await store.load(using: provider, scope: scope, routeID: routeID, identity: .declared(userID: "1"))
        store.requestDelete(message: .fixture(id: 11, conversationID: 7, content: "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十"))
        XCTAssertEqual(store.pendingConfirmation, .deleteMessage(id: 11, preview: "一二三四五六七八九十一二三四五六七八九十一二三四…"), "超长正文按 24 字截断加省略号")
        await store.confirmPending(using: provider, scope: scope, routeID: routeID)
        XCTAssertEqual(provider.deletedMessageIDs, [11])
        XCTAssertTrue(store.messages.isEmpty)
    }

    func testRenameAndEditGoThroughWithoutConfirmation() async {
        let provider = ScriptedAIChatProvider(
            conversations: .value([.fixture(id: 7, title: "旧名")]),
            messages: .value([.fixture(id: 11, conversationID: 7, content: "旧内容")])
        )
        let store = makeStore()
        let scope = makeScope()

        await store.load(using: provider, scope: scope, routeID: routeID, identity: .declared(userID: "1"))
        await store.renameConversation(id: 7, title: "  新名  ", using: provider, scope: scope, routeID: routeID)
        XCTAssertEqual(provider.renames.map(\.title), ["新名"], "标题要 trim 后发")
        XCTAssertEqual(store.conversations.first?.title, "新名")
        XCTAssertNil(store.pendingConfirmation, "重命名没有二次确认")

        await store.editMessage(id: 11, content: "新内容", using: provider, scope: scope, routeID: routeID)
        XCTAssertEqual(provider.edits.map(\.content), ["新内容"])
        XCTAssertEqual(store.messages.first?.content, "新内容")

        await store.editMessage(id: 11, content: "   ", using: provider, scope: scope, routeID: routeID)
        XCTAssertEqual(provider.edits.count, 1, "空内容不发（后端 422）")
    }

    // MARK: - 附件（端点 11）

    func testAttachParsesContentAndFeedsNextPayload() async {
        let provider = ScriptedAIChatProvider(
            config: .value(AIChatConfig(providerConfigured: true, webSearchConfigured: false, models: ["m"], defaultModel: "m")),
            conversations: .value([.fixture(id: 7)]),
            upload: .value(
                AIFileUploadResponse(
                    fileName: "报表.csv", fileType: "csv", content: "a,b", truncated: true, truncatedNote: "只取前 100 行"
                )
            ),
            stream: .value([.event(.messageStop, id: "1-0")])
        )
        let store = makeStore()
        let scope = makeScope()

        await store.load(using: provider, scope: scope, routeID: routeID, identity: .declared(userID: "1"))
        await store.attach(
            fileURL: URL(fileURLWithPath: "/tmp/report.csv"),
            filename: "报表.csv",
            mimeType: "text/csv",
            using: provider,
            scope: scope,
            routeID: routeID
        )

        XCTAssertEqual(provider.uploadedFiles.map(\.filename), ["报表.csv"])
        guard case .parsed(let filename, let content, let truncated, let note) = store.composer.attachment else {
            return XCTFail("应当解析成功，实际 \(store.composer.attachment)")
        }
        XCTAssertEqual(filename, "报表.csv")
        XCTAssertEqual(content, "a,b")
        XCTAssertTrue(truncated)
        XCTAssertEqual(note, "只取前 100 行")

        store.setText("看看这个")
        await store.send(using: provider, scope: scope, routeID: routeID)
        XCTAssertEqual(provider.streams.first?.attachedFileContent, "a,b", "附件正文回填进发送体")
        XCTAssertEqual(store.composer.attachment, .none, "发送成功后清掉附件")
    }

    func testAttachFailureSurfacesAndBlocksSend() async {
        let provider = ScriptedAIChatProvider(
            config: .value(AIChatConfig(providerConfigured: true, webSearchConfigured: false, models: ["m"], defaultModel: "m")),
            conversations: .value([.fixture(id: 7)]),
            upload: .failure(status: 400)
        )
        let store = makeStore()
        let scope = makeScope()

        await store.load(using: provider, scope: scope, routeID: routeID, identity: .declared(userID: "1"))
        await store.attach(
            fileURL: URL(fileURLWithPath: "/tmp/x.csv"),
            filename: "x.csv",
            mimeType: "text/csv",
            using: provider,
            scope: scope,
            routeID: routeID
        )

        XCTAssertNotNil(store.composer.attachment.failureMessage)
        store.setText("内容")
        XCTAssertFalse(store.composer.canSend, "解析失败的附件不能带着发")

        store.clearAttachment()
        XCTAssertTrue(store.composer.canSend)
    }

    // MARK: - 用量（端点 12）

    func testUsageRangeSwitchReloads() async {
        let provider = ScriptedAIChatProvider()
        let store = makeStore()
        let scope = makeScope()

        await store.reloadUsage(using: provider, scope: scope, routeID: routeID)
        XCTAssertEqual(provider.requestedUsageRanges, [.thirtyDays])

        store.setUsageRange(.sevenDays)
        await store.reloadUsage(using: provider, scope: scope, routeID: routeID)

        XCTAssertEqual(provider.requestedUsageRanges, [.thirtyDays, .sevenDays])
        XCTAssertEqual(store.usagePhase, .loaded)
        XCTAssertNotNil(store.usage)
    }

    /// 用量失败**不影响**会话列表与消息（它是附属面板）。
    func testUsageFailureDoesNotDisturbInbox() async {
        let provider = ScriptedAIChatProvider(
            conversations: .value([.fixture(id: 7)]),
            messages: .value([.fixture(id: 11, conversationID: 7)]),
            usage: .failure(status: 500)
        )
        let store = makeStore()
        let scope = makeScope()

        await store.load(using: provider, scope: scope, routeID: routeID, identity: .declared(userID: "1"))

        XCTAssertNotNil(store.usagePhase.failureMessage)
        XCTAssertEqual(store.conversations.count, 1)
        XCTAssertEqual(store.messages.count, 1)
        XCTAssertEqual(store.inboxState, .ready)
    }

    // MARK: - 未登录

    func testMissingCredentialFailsWithoutRequest() async {
        let store = makeStore()
        store.failWithoutCredential()

        XCTAssertNotNil(store.conversationsPhase.failureMessage)
        XCTAssertTrue(store.conversationsPhase.failureMessage?.contains("尚未登录") == true)
        XCTAssertFalse(store.providerReady, "没有凭据时不该显示成「可以发」")
    }

    // MARK: - 双页共用的底座

    /// 两页共用同一份目录常量：路由 id 与端点路径不能在某一页被写错（写错就是 404 或占位页）。
    func testCatalogRoutesMatchNavigationItems() {
        XCTAssertEqual(AIChatView.routeID, AIChatCatalog.chatRouteID)
        XCTAssertEqual(CustomerServiceView.routeID, AIChatCatalog.customerServiceRouteID)
        let ids = NavigationCatalog.groups.flatMap(\.items).map(\.id)
        XCTAssertTrue(ids.contains(AIChatCatalog.chatRouteID))
        XCTAssertTrue(ids.contains(AIChatCatalog.customerServiceRouteID))
    }

    /// 端点目录逐条对齐后端（12 条；`regenerate-title` **只登记不使用**）。
    func testCatalogEndpointPaths() {
        XCTAssertEqual(AIChatCatalog.configEndpoint, "/ai/config")
        XCTAssertEqual(AIChatCatalog.conversationsEndpoint, "/ai/conversations")
        XCTAssertEqual(AIChatCatalog.conversationEndpoint(id: 7), "/ai/conversations/7")
        XCTAssertEqual(AIChatCatalog.messagesEndpoint(conversationID: 7), "/ai/conversations/7/messages")
        XCTAssertEqual(AIChatCatalog.messageEndpoint(conversationID: 7, messageID: 11), "/ai/conversations/7/messages/11")
        XCTAssertEqual(AIChatCatalog.streamEndpoint(conversationID: 7), "/ai/conversations/7/messages/stream")
        XCTAssertEqual(AIChatCatalog.cancelEndpoint(conversationID: 7), "/ai/conversations/7/cancel")
        XCTAssertEqual(AIChatCatalog.uploadEndpoint, "/ai/upload")
        XCTAssertEqual(AIChatCatalog.usageStatsEndpoint, "/ai/usage/stats")
        XCTAssertEqual(AIChatCatalog.regenerateTitleEndpoint(conversationID: 7), "/ai/conversations/7/regenerate-title")
    }
}
