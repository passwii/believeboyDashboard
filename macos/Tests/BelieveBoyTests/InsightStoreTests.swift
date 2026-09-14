import BelieveBoyKit
import Foundation
import XCTest

@testable import BelieveBoyUI

/// 假数据源：把三页的六个端点都做成可编排的闭包（成功 / 失败 / 挂起 / 逐帧四种）。
///
/// `@unchecked Sendable` + 锁：`InsightDataProviding` 的调用点在 store 的 `@Sendable`
/// 闭包里（跨 actor），而计数器要被断言读 —— 读写共用一把锁。
final class FakeInsightProvider: InsightDataProviding, @unchecked Sendable {
    struct State {
        var projectsCalls = 0
        var insightsQueries: [InsightListQuery] = []
        var detailCalls: [Int] = []
        var schedulesCalls = 0
        var runDetailCalls: [String] = []
        var runStreamRequests: [(runID: String, lastEventID: String?)] = []
        var insightStreamRequests: [Int] = []
    }

    private let box = LockedBox(State())
    private let message: @Sendable (String) -> Error

    var state: State { box.value }

    var projectsResult: @Sendable (Int) async throws -> [AdProject]
    var insightsResult: @Sendable (Int, InsightListQuery) async throws -> InsightListResponse
    var detailResult: @Sendable (Int, Int) async throws -> InsightDetail
    var schedulesResult: @Sendable (Int) async throws -> InsightScheduleListResponse
    var runDetailResult: @Sendable (Int, String) async throws -> InsightRunDetail
    var insightStream: @Sendable (Int, Int) -> AsyncThrowingStream<ServerSentEvent, Error>
    var runStream:
        @Sendable (Int, String, String?) -> AsyncThrowingStream<ServerSentEvent, Error>

    init(
        projectsResult: @escaping @Sendable (Int) async throws -> [AdProject] = { _ in
            [AdProject(id: 1, name: "铨富", country: "US", isActive: true)]
        },
        insightsResult: @escaping @Sendable (Int, InsightListQuery) async throws -> InsightListResponse = {
            _, _ in InsightListResponse(items: [], total: 0)
        },
        detailResult: @escaping @Sendable (Int, Int) async throws -> InsightDetail = { _, _ in
            throw APIError.http(status: 500, body: "unset")
        },
        schedulesResult: @escaping @Sendable (Int) async throws -> InsightScheduleListResponse = { _ in
            InsightScheduleListResponse(items: [], total: 0)
        },
        runDetailResult: @escaping @Sendable (Int, String) async throws -> InsightRunDetail = { _, _ in
            throw APIError.http(status: 500, body: "unset")
        },
        insightStream: @escaping @Sendable (Int, Int) -> AsyncThrowingStream<ServerSentEvent, Error> = {
            _, _ in AsyncThrowingStream { $0.finish() }
        },
        runStream: @escaping @Sendable (Int, String, String?) -> AsyncThrowingStream<
            ServerSentEvent, Error
        > = { _, _, _ in AsyncThrowingStream { $0.finish() } },
        message: @escaping @Sendable (String) -> Error = { APIError.http(status: 500, body: $0) }
    ) {
        self.projectsResult = projectsResult
        self.insightsResult = insightsResult
        self.detailResult = detailResult
        self.schedulesResult = schedulesResult
        self.runDetailResult = runDetailResult
        self.insightStream = insightStream
        self.runStream = runStream
        self.message = message
    }

    func fail(message text: String) -> Error { message(text) }

    func projects() async throws -> [AdProject] {
        box.mutate { $0.projectsCalls += 1 }
        return try await projectsResult(box.value.projectsCalls)
    }

    func insights(query: InsightListQuery) async throws -> InsightListResponse {
        box.mutate { $0.insightsQueries.append(query) }
        return try await insightsResult(box.value.insightsQueries.count, query)
    }

    func insightDetail(id: Int) async throws -> InsightDetail {
        box.mutate { $0.detailCalls.append(id) }
        return try await detailResult(box.value.detailCalls.count, id)
    }

    func schedules(query: InsightScheduleQuery) async throws -> InsightScheduleListResponse {
        box.mutate { $0.schedulesCalls += 1 }
        return try await schedulesResult(box.value.schedulesCalls)
    }

    func runDetail(runID: String) async throws -> InsightRunDetail {
        box.mutate { $0.runDetailCalls.append(runID) }
        return try await runDetailResult(box.value.runDetailCalls.count, runID)
    }

    func insightStream(id: Int) -> AsyncThrowingStream<ServerSentEvent, Error> {
        box.mutate { $0.insightStreamRequests.append(id) }
        return insightStream(box.value.insightStreamRequests.count, id)
    }

    func runStream(runID: String, lastEventID: String?) -> AsyncThrowingStream<ServerSentEvent, Error> {
        box.mutate { $0.runStreamRequests.append((runID: runID, lastEventID: lastEventID)) }
        return runStream(box.value.runStreamRequests.count, runID, lastEventID)
    }
}

// MARK: - 测试用的帧构造

enum InsightTestFrames {
    /// 旧链路帧（`data:` 里就是业务 JSON）。
    static func legacy(_ json: String) -> ServerSentEvent {
        ServerSentEvent(data: json)
    }

    static func legacyStatus(_ status: String, subStatus: String? = nil) -> ServerSentEvent {
        let sub = subStatus.map { "\"\($0)\"" } ?? "null"
        return legacy(
            "{\"type\":\"status\",\"status\":\"\(status)\",\"sub_status\":\(sub),\"insight_id\":46}"
        )
    }

    static func legacyDone(content: String) -> ServerSentEvent {
        let escaped = content.replacingOccurrences(of: "\n", with: "\\n")
        return legacy(
            "{\"type\":\"done\",\"status\":\"completed\",\"insight_id\":46,"
                + "\"title\":\"标题\",\"content\":\"\(escaped)\"}"
        )
    }

    /// canonical 帧（带 `id:` 游标）。
    static func canonical(
        runID: String,
        attempt: Int,
        seq: Int,
        type: String,
        extra: String = ""
    ) -> ServerSentEvent {
        let separator = extra.isEmpty ? "" : ","
        return ServerSentEvent(
            id: "\(runID):\(attempt):\(seq)",
            data: "{\"schema_version\":1,\"run_id\":\"\(runID)\",\"attempt\":\(attempt),"
                + "\"seq\":\(seq),\"type\":\"\(type)\"\(separator)\(extra)}"
        )
    }

    static func canonicalDelta(
        runID: String,
        seq: Int,
        text: String
    ) -> ServerSentEvent {
        let escaped = text.replacingOccurrences(of: "\n", with: "\\n")
        return canonical(
            runID: runID,
            attempt: 1,
            seq: seq,
            type: "content.delta",
            extra: "\"slot\":\"main\",\"delta\":\"\(escaped)\""
        )
    }

    static func canonicalDone(runID: String, seq: Int, content: String) -> ServerSentEvent {
        let escaped = content.replacingOccurrences(of: "\n", with: "\\n")
        return canonical(
            runID: runID,
            attempt: 1,
            seq: seq,
            type: "done",
            extra: "\"status\":\"completed\",\"outputs\":{\"main\":{\"format\":\"markdown\","
                + "\"content\":\"\(escaped)\"}}"
        )
    }

    /// 用给定帧造一条流（`delay` 用来让取消/重连有可观察的窗口）。
    static func stream(
        _ frames: [ServerSentEvent],
        thenThrow error: Error? = nil,
        delay: Duration = .zero
    ) -> AsyncThrowingStream<ServerSentEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                for frame in frames {
                    if delay > .zero { try? await Task.sleep(for: delay) }
                    if Task.isCancelled { return continuation.finish() }
                    continuation.yield(frame)
                }
                if let error {
                    continuation.finish(throwing: error)
                } else {
                    continuation.finish()
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// 夹具里那条 completed run 的固定 run id（与 `Fixture/Insight/manifest.json` 的 B 段一致）。
///
/// 放在文件级常量而不是测试类的 `static let`：`@MainActor` 测试类的静态属性在非隔离的
/// `@Sendable` 闭包（假数据源的 handler）里读不到。
enum InsightTestRunID {
    static let value = "b1f00000-0000-4000-8000-0000000000c1"
}

// MARK: - 旧链路 store

/// 「AI 洞察」store 的状态机用例（三态 / 分页 / 刷新失败保留旧表 / 取消不落错误态 / 流式）。
@MainActor
final class AIInsightsStoreTests: XCTestCase {
    private var scopes: [ModuleTaskScope] = []

    override func setUp() {
        super.setUp()
        scopes = []
    }

    override func tearDown() async throws {
        await cancelScopes(scopes)
        scopes = []
        try await super.tearDown()
    }

    private func makeScope() -> ModuleTaskScope {
        let scope = ModuleTaskScope()
        scopes.append(scope)
        return scope
    }

    private nonisolated static func listResponse(
        count: Int,
        total: Int,
        offset: Int = 0
    ) -> InsightListResponse {
        let items = (0..<count).map { index in
            InsightListItem(
                id: offset + index + 1,
                projectId: 1,
                projectName: "铨富",
                country: "US",
                title: "洞察 \(offset + index + 1)",
                insightType: "custom",
                dateRangeStart: "2026-05-11",
                dateRangeEnd: "2026-05-17",
                status: "completed",
                subStatus: nil,
                errorMessage: nil,
                createdBy: "纪亚伟",
                createdAt: "2026-05-18T10:00:00+08:00",
                updatedAt: "2026-05-18T10:05:00+08:00"
            )
        }
        return InsightListResponse(items: items, total: total)
    }

    /// 首屏：项目 → 定时列表 → 洞察列表，三态落到 ready，`total` 用后端的值。
    func testLoadFetchesProjectsSchedulesAndList() async {
        let provider = FakeInsightProvider(
            insightsResult: { _, _ in Self.listResponse(count: 3, total: 47) },
            schedulesResult: { _ in
                InsightScheduleListResponse(
                    items: [
                        InsightScheduleItem(
                            id: 1,
                            projectId: 1,
                            projectName: "铨富",
                            country: "US",
                            insightType: "custom",
                            cronExpression: "0 8 * * *",
                            dateRangeStrategy: "last_7_days",
                            model: "claude",
                            isActive: true,
                            runCount: 3,
                            failureCount: 0,
                            lastRunAt: nil,
                            lastInsightId: 46,
                            lastError: nil,
                            nextRunAt: "2026-09-15T08:00:00+08:00",
                            createdBy: "纪亚伟",
                            createdAt: nil,
                            updatedAt: nil
                        )
                    ],
                    total: 1
                )
            }
        )
        let store = AIInsightsStore()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, key: "route")

        XCTAssertEqual(store.contentState, .ready)
        XCTAssertEqual(store.items.count, 3)
        XCTAssertEqual(store.total, 47)
        XCTAssertEqual(store.schedules.count, 1)
        XCTAssertEqual(store.projectGate, .ready)
        XCTAssertEqual(store.filters.projectID, 1, "进页自动选中第一个项目（与 S5.1/S5.2 同口径）")
        XCTAssertEqual(provider.state.insightsQueries.first?.limit, InsightCatalog.pageSize)
    }

    /// 同一组筛选重复触发不再请求（视图 `.task(id:)` 在自动选项目时会把筛选改一次）。
    func testDuplicateLoadIsNotRefetched() async {
        let provider = FakeInsightProvider(
            insightsResult: { _, _ in Self.listResponse(count: 1, total: 1) }
        )
        let store = AIInsightsStore()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, key: "route")
        await store.load(using: provider, scope: scope, key: "route")
        XCTAssertEqual(provider.state.insightsQueries.count, 1, "同一筛选不该发第二次")
    }

    /// 刷新失败保留旧表 + 黄条（不闪空）。
    func testRefreshFailureKeepsPreviousRows() async {
        let provider = FakeInsightProvider(
            insightsResult: { index, _ in
                if index == 1 { return Self.listResponse(count: 2, total: 2) }
                throw APIError.transport("网络未连接")
            }
        )
        let store = AIInsightsStore()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, key: "route")
        XCTAssertEqual(store.items.count, 2)

        store.requestRefresh()
        await store.load(using: provider, scope: scope, key: "route")

        XCTAssertEqual(store.items.count, 2, "刷新失败要保留旧表")
        XCTAssertEqual(store.contentState, .ready)
        XCTAssertNotNil(store.refreshFailure)
    }

    /// 分页：`goToPage` 按后端 `total` 夹回，越界请求回第一页 / 最后一页。
    func testPagingUsesServerTotal() async {
        let provider = FakeInsightProvider(
            insightsResult: { _, query in
                Self.listResponse(count: 20, total: 47, offset: query.offset)
            }
        )
        let store = AIInsightsStore()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, key: "route")

        XCTAssertEqual(store.page, 1)
        XCTAssertEqual(store.totalPages, 3)
        XCTAssertTrue(store.canGoNext)
        XCTAssertFalse(store.canGoPrevious)

        store.nextPage()
        XCTAssertEqual(store.offset, 20)
        store.goToPage(99)
        XCTAssertEqual(store.page, 3, "越界页夹回最后一页")
        store.goToPage(-5)
        XCTAssertEqual(store.page, 1)
    }

    /// 取消（切模块）不落错误态：仍在 loading 的列表退回 idle，已有数据保留。
    func testCancellationDoesNotProduceErrorState() async {
        let provider = FakeInsightProvider(
            insightsResult: { _, _ in
                try? await Task.sleep(for: .milliseconds(400))
                return Self.listResponse(count: 1, total: 1)
            }
        )
        let store = AIInsightsStore()
        let scope = makeScope()
        let task = Task { await store.load(using: provider, scope: scope, key: "route") }
        try? await Task.sleep(for: .milliseconds(30))
        scope.cancel(key: "route")
        await task.value

        XCTAssertNil(store.failureMessage, "取消不该落成错误态")
        XCTAssertEqual(store.contentState, .loading, "没有数据时退回 loading（不显示红条）")
    }

    /// 明细 + 旧链路流：`status` 帧改阶段、`done` 帧落正文、终态后回读 detail 并刷新列表。
    func testDetailStreamAppliesFramesAndRefreshesListOnTerminal() async {
        let provider = FakeInsightProvider(
            insightsResult: { _, _ in Self.listResponse(count: 1, total: 1) },
            detailResult: { index, id in
                // 首次取到「生成中」，终态帧之后再回读时已是「已完成」—— 这正是真实链路
                // 的形状：detail 是权威，流只负责推进。
                Self.detail(
                    id: id,
                    status: index == 1 ? "generating" : "completed",
                    content: index == 1 ? "" : "# 终稿\n\n正文"
                )
            },
            insightStream: { _, _ in
                InsightTestFrames.stream([
                    InsightTestFrames.legacyStatus("generating", subStatus: "data_aggregating_ad"),
                    InsightTestFrames.legacyStatus("generating", subStatus: "ai_generating"),
                    InsightTestFrames.legacyDone(content: "# 终稿\n\n正文"),
                ])
            }
        )
        let store = AIInsightsStore()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, key: "route")
        store.openInsight(id: 46)
        await store.loadDetailAndWatch(using: provider, scope: scope, key: "route")

        XCTAssertEqual(store.detailPhase, .loaded)
        XCTAssertEqual(store.stream.eventTypes, ["status", "status", "done"])
        XCTAssertEqual(store.stream.status, "completed")
        XCTAssertTrue(store.stream.isFinished)
        XCTAssertEqual(store.detailContent, "# 终稿\n\n正文")
        XCTAssertEqual(store.stream.panel.busy, false)
        XCTAssertGreaterThanOrEqual(provider.state.detailCalls.count, 2, "终态后要回读权威 detail")
        // 「刷新列表」不是 store 自己再发一次请求，而是把刷新票号推一格 —— 由视图的
        // `.task(id: store.loadKey)` 重跑去加载（这样列表请求仍登记在同一个任务作用域里，
        // 切模块时能一起取消）。
        XCTAssertGreaterThan(store.refreshTicket, 0, "终态后要把列表刷新票号推一格")
    }

    /// 旧链路断流：回读 detail 后重连；重连次数用尽后给出提示，但**不**把 run 判成失败。
    func testStreamDisconnectReconnectsWithBoundedAttempts() async {
        let provider = FakeInsightProvider(
            insightsResult: { _, _ in Self.listResponse(count: 1, total: 1) },
            detailResult: { _, id in Self.detail(id: id, status: "generating", content: "") },
            insightStream: { _, _ in
                // 每次都只发一帧就结束（模拟断流，且 run 始终没到终态）。
                InsightTestFrames.stream([InsightTestFrames.legacyStatus("generating")])
            }
        )
        let store = AIInsightsStore(reconnectDelay: .milliseconds(1), maxReconnects: 2)
        let scope = makeScope()
        await store.load(using: provider, scope: scope, key: "route")
        store.openInsight(id: 46)
        await store.loadDetailAndWatch(using: provider, scope: scope, key: "route")

        XCTAssertEqual(provider.state.insightStreamRequests.count, 3, "首次 + 2 次重连")
        XCTAssertEqual(store.stream.reconnects, 3)
        XCTAssertNotNil(store.stream.errorMessage)
        XCTAssertNotEqual(store.stream.status, "failed", "流没接上不等于 run 失败")
        XCTAssertFalse(store.stream.isFinished)
    }

    /// 未登录不发请求（没有 key 的请求必然 401，不能显示成「凭据被拒绝」）。
    func testMissingCredentialFailsWithoutRequest() {
        let provider = FakeInsightProvider()
        let store = AIInsightsStore()
        store.failWithoutCredential()
        XCTAssertEqual(provider.state.projectsCalls, 0)
        guard case .failed = store.projectGate else {
            return XCTFail("未登录时项目闸门应当落到 failed：\(store.projectGate)")
        }
    }

    private nonisolated static func detail(
        id: Int,
        status: String,
        content: String
    ) -> InsightDetail {
        InsightDetail(
            id: id,
            projectId: 1,
            projectName: "铨富",
            country: "US",
            title: "标题",
            insightType: "custom",
            dateRangeStart: "2026-05-11",
            dateRangeEnd: "2026-05-17",
            status: status,
            subStatus: nil,
            errorMessage: nil,
            createdBy: "纪亚伟",
            createdAt: "2026-05-18T10:00:00+08:00",
            updatedAt: "2026-05-18T10:05:00+08:00",
            content: content,
            strategyMetadata: nil
        )
    }

    /// 无项目：`projectGate` 落到 `noProjects`（列表请求不发 —— 发了也是空）。
    func testNoProjectsGate() async {
        let provider = FakeInsightProvider(projectsResult: { _ in [] })
        let store = AIInsightsStore()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, key: "route")
        XCTAssertEqual(store.projectGate, .noProjects)
    }

    /// 明细加载失败：错误态落在 `detailPhase`，不进 `stream`（流没开过就没有「断流」可言）。
    func testDetailFailureSurfacesInDetailPhase() async {
        let provider = FakeInsightProvider(
            insightsResult: { _, _ in Self.listResponse(count: 1, total: 1) },
            detailResult: { _, _ in throw APIError.http(status: 404, body: #"{"detail":"洞察不存在"}"#) }
        )
        let store = AIInsightsStore()
        let scope = makeScope()
        await store.load(using: provider, scope: scope, key: "route")
        store.openInsight(id: 999)
        await store.loadDetailAndWatch(using: provider, scope: scope, key: "route")
        XCTAssertEqual(
            store.detailPhase,
            .failed(APIError.http(status: 404, body: #"{"detail":"洞察不存在"}"#).displayMessage),
            "错误文案由 APIError 统一给出（不在页面里另写一套）"
        )
        XCTAssertNil(store.stream.errorMessage)
    }
}

// MARK: - canonical run store

/// 「canonical run 观察」store 的用例（游标续传 / 去重 / 终态收尾 / 断线重连 / 输入校验）。
@MainActor
final class CanonicalRunStoreTests: XCTestCase {
    private var scopes: [ModuleTaskScope] = []

    override func setUp() {
        super.setUp()
        scopes = []
    }

    override func tearDown() async throws {
        await cancelScopes(scopes)
        scopes = []
        try await super.tearDown()
    }

    private func makeScope() -> ModuleTaskScope {
        let scope = ModuleTaskScope()
        scopes.append(scope)
        return scope
    }

    private var runID: String { InsightTestRunID.value }

    private nonisolated static func runDetail(
        status: String,
        progress: Int,
        content: String = ""
    ) -> InsightRunDetail {
        InsightRunDetail(
            schemaVersion: 1,
            runId: InsightTestRunID.value,
            attempt: 1,
            roleId: "ad_analysis",
            roleVersion: 1,
            projectId: 427,
            country: "US",
            status: status,
            stage: status == "completed" ? "finalizing" : "generating",
            progressPercent: progress,
            outputFormat: "markdown",
            title: nil,
            outputs: content.isEmpty
                ? [:]
                : ["main": InsightRunOutput(format: "markdown", content: content, contentSha256: nil)],
            artifactId: nil,
            usage: nil,
            error: nil,
            resume: InsightRunResume(latestEventId: nil, currentAttempt: 1, historyAvailable: false),
            createdAt: "2026-09-14T15:54:54Z",
            startedAt: nil,
            completedAt: nil,
            updatedAt: "2026-09-14T15:54:54Z"
        )
    }

    /// 输入校验：非 UUID 直接给提示、不发任何请求（后端路径参数按 `UUID` 解析，否则 422）。
    func testSubmitValidatesUUIDBeforeRequesting() async {
        let provider = FakeInsightProvider()
        let store = CanonicalRunStore(domain: .adAnalysis)
        let scope = makeScope()

        store.setRunIDInput("not-a-uuid")
        store.submit()
        XCTAssertNil(store.runID)
        XCTAssertNotNil(store.inputNotice)
        await store.watch(using: provider, scope: scope, key: "route")
        XCTAssertTrue(provider.state.runDetailCalls.isEmpty)

        store.setRunIDInput(runID)
        store.submit()
        XCTAssertEqual(store.runID, runID)
        XCTAssertNil(store.inputNotice)
    }

    /// 观察一条已完成 run：detail 直接落终态，不订阅流（省一次无谓连接）。
    func testCompletedRunDetailSkipsStream() async {
        let provider = FakeInsightProvider(runDetailResult: { _, _ in
            Self.runDetail(status: "completed", progress: 100, content: "# 终稿\n")
        })
        let store = CanonicalRunStore(domain: .adAnalysis)
        store.setRunIDInput(runID)
        store.submit()
        await store.watch(using: provider, scope: makeScope(), key: "route")

        XCTAssertEqual(store.detailPhase, .loaded)
        XCTAssertEqual(store.content, "# 终稿\n")
        XCTAssertEqual(store.contentState, .final)
        XCTAssertFalse(store.panel.busy)
        XCTAssertTrue(provider.state.runStreamRequests.isEmpty, "终态 run 不该再开流")
    }

    /// 在跑的 run：订阅流，正文按增量累积，`done` 落终稿并记下游标。
    func testActiveRunConsumesStreamAndSettlesAtTerminal() async {
        let provider = FakeInsightProvider(
            runDetailResult: { index, _ in
                index == 1
                    ? Self.runDetail(status: "generating", progress: 30)
                    : Self.runDetail(status: "completed", progress: 100, content: "甲\n乙")
            },
            runStream: { _, _, _ in
                InsightTestFrames.stream([
                    InsightTestFrames.canonicalDelta(runID: InsightTestRunID.value, seq: 1, text: "甲"),
                    InsightTestFrames.canonicalDelta(runID: InsightTestRunID.value, seq: 2, text: "\n乙"),
                    InsightTestFrames.canonicalDone(runID: InsightTestRunID.value, seq: 3, content: "甲\n乙"),
                ])
            }
        )
        let store = CanonicalRunStore(domain: .adAnalysis)
        store.setRunIDInput(runID)
        store.submit()
        await store.watch(using: provider, scope: makeScope(), key: "route")

        XCTAssertEqual(store.stream.eventTypes, ["content.delta", "content.delta", "done"])
        XCTAssertEqual(store.content, "甲\n乙")
        XCTAssertEqual(store.contentState, .final)
        XCTAssertEqual(store.stream.lastEventID, "\(runID):1:3")
        XCTAssertEqual(store.stream.seenCount, 3)
        XCTAssertEqual(store.stream.reconnects, 0)
        XCTAssertNil(store.stream.errorMessage)
        XCTAssertEqual(store.panel.status, "completed")
        XCTAssertEqual(provider.state.runDetailCalls.count, 2, "终态后要回读权威快照")
    }

    /// 重连带游标 —— 第二次连接的 `Last-Event-ID` 是上一轮最后一帧的 `id`，
    /// 且**只应用新帧**（重放帧按 id 去重，正文不会被写两遍）。这是 §口径 2 的真身。
    func testReconnectSendsLastEventIDAndDedupesReplay() async {
        let first = InsightTestFrames.canonicalDelta(runID: InsightTestRunID.value, seq: 1, text: "甲")
        let replay = first
        let last = InsightTestFrames.canonicalDone(runID: InsightTestRunID.value, seq: 2, content: "甲乙")

        let provider = FakeInsightProvider(
            runDetailResult: { index, _ in
                index == 1
                    ? Self.runDetail(status: "generating", progress: 10)
                    : Self.runDetail(status: "completed", progress: 100, content: "甲乙")
            },
            runStream: { index, _, _ in
                index == 1
                    ? InsightTestFrames.stream([first])
                    : InsightTestFrames.stream([replay, last])
            }
        )
        let store = CanonicalRunStore(domain: .adAnalysis, reconnectDelay: .milliseconds(1))
        store.setRunIDInput(runID)
        store.submit()
        await store.watch(using: provider, scope: makeScope(), key: "route")

        let requests = provider.state.runStreamRequests
        XCTAssertEqual(requests.count, 2, "首次 + 1 次重连")
        XCTAssertNil(requests[0].lastEventID, "首次订阅不带游标")
        XCTAssertEqual(requests[1].lastEventID, "\(runID):1:1", "重连必须带上一轮的游标")

        // 重放帧被去重：事件序列里 `content.delta` 只出现一次。
        XCTAssertEqual(store.stream.eventTypes, ["content.delta", "done"])
        XCTAssertEqual(store.content, "甲乙", "重放帧不该把正文写两遍")
        XCTAssertEqual(store.stream.seenCount, 2)
    }

    /// 断流且 run 未终态：重连到上限后提示，但**不**把 run 判成失败（run 由后端继续跑）。
    func testStreamExhaustionDoesNotFailTheRun() async {
        let provider = FakeInsightProvider(
            runDetailResult: { _, _ in Self.runDetail(status: "generating", progress: 5) },
            runStream: { _, _, _ in
                InsightTestFrames.stream(
                    [InsightTestFrames.canonicalDelta(runID: InsightTestRunID.value, seq: 1, text: "甲")],
                    thenThrow: APIError.transport("连接中断")
                )
            }
        )
        let store = CanonicalRunStore(
            domain: .adAnalysis,
            reconnectDelay: .milliseconds(1),
            maxReconnects: 1
        )
        store.setRunIDInput(runID)
        store.submit()
        await store.watch(using: provider, scope: makeScope(), key: "route")

        XCTAssertEqual(provider.state.runStreamRequests.count, 2, "首次 + 1 次重连")
        XCTAssertNotNil(store.stream.errorMessage)
        XCTAssertNotEqual(store.detail?.status, "failed")
        XCTAssertFalse(store.stream.isFinished)
        XCTAssertEqual(store.stream.reconnects, 2)
    }

    /// 取消（切模块）不落错误态：被取消的观察链不写任何失败状态。
    func testCancellationLeavesNoError() async {
        let provider = FakeInsightProvider(
            runDetailResult: { _, _ in
                try? await Task.sleep(for: .milliseconds(300))
                return Self.runDetail(status: "generating", progress: 1)
            }
        )
        let store = CanonicalRunStore(domain: .inventoryHealth)
        store.setRunIDInput(runID)
        store.submit()
        let scope = makeScope()
        let task = Task { await store.watch(using: provider, scope: scope, key: "route") }
        try? await Task.sleep(for: .milliseconds(20))
        scope.cancel(key: "route")
        await task.value

        XCTAssertNil(store.detail)
        XCTAssertNil(store.stream.errorMessage)
        XCTAssertEqual(store.detailPhase, .idle)
    }

    /// 库存域：状态与数值口径（`progress_percent` 直通）都落在 run 上。
    ///
    /// 「重连中文案」这条口径（run 状态保留、标签换文案）在 `InsightPanelMappingTests` 里
    /// 逐条钉住；这里钉的是**数值口径**：`status` / `progress_percent` / `busy` 都取自
    /// run 本身，流接不上也不改写它们。
    func testInventoryDomainKeepsRunStatusAndProgress() async {
        let provider = FakeInsightProvider(
            runDetailResult: { _, _ in Self.runDetail(status: "aggregating", progress: 42) },
            // 流一开即断：走「重连上限 = 0」的短路分支，不必等真实退避。
            runStream: { _, _, _ in InsightTestFrames.stream([]) }
        )
        let store = CanonicalRunStore(
            domain: .inventoryHealth,
            reconnectDelay: .milliseconds(1),
            maxReconnects: 0
        )
        store.setRunIDInput(runID)
        store.submit()
        await store.watch(using: provider, scope: makeScope(), key: "route")

        XCTAssertEqual(store.detail?.status, "aggregating")
        XCTAssertEqual(store.panel.status, "aggregating", "run 状态（后端权威）优先于传输层状态")
        XCTAssertEqual(store.panel.progress, 42, "数值口径：progress_percent 直通")
        XCTAssertTrue(store.panel.busy)
        // 重连预算为 0 → 没进入「重连中」，标签就是库存域自己的文案。
        XCTAssertEqual(store.panel.label, "正在聚合库存与补货数据")
        XCTAssertNotEqual(store.detail?.status, "failed", "流接不上不等于 run 失败")
        XCTAssertNotNil(store.stream.errorMessage, "流接不上要如实说出来")
    }

    /// `clear()` 停止观察：清空选中并把任务键推一次（视图 `.task(id:)` 会随之取消在跑的观察）。
    func testClearStopsWatching() async {
        let provider = FakeInsightProvider(runDetailResult: { _, _ in
            Self.runDetail(status: "completed", progress: 100, content: "# x\n")
        })
        let store = CanonicalRunStore(domain: .adAnalysis)
        store.setRunIDInput(runID)
        store.submit()
        let before = store.watchTicket
        await store.watch(using: provider, scope: makeScope(), key: "route")
        XCTAssertNotNil(store.detail)

        store.clear()
        XCTAssertNil(store.runID)
        XCTAssertNil(store.detail)
        XCTAssertGreaterThan(store.watchTicket, before)
    }
}
