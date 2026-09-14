import BelieveBoyKit
import Foundation
import XCTest

@testable import BelieveBoyUI

/// 可编排的广告分析数据源假实现：项目列表与每个 Tab 都能独立设「成功值 / 失败 / 挂起」。
///
/// 为什么需要它（而不是只打桩 URLProtocol）：本页有两条必须精确控制时序的分支 ——
/// 「切 Tab / 改筛选 / 切模块时在跑的请求被取消，且取消不落成错误态」与「刷新失败保留
/// 旧表」。两条都要求**让某个请求永远不返回**，而 `URLProtocol` 只能在响应里返回内容。
///
/// `@unchecked Sendable` + 锁：测试从 `@MainActor` 改配置、从后台任务里读配置。
final class ScriptedAdAnalysisProvider: AdAnalysisDataProviding, @unchecked Sendable {
    enum Outcome<Value: Sendable>: Sendable {
        case value(Value)
        /// 抛 `APIError.http`（贴近真实失败形态：非 2xx）。
        case failure(status: Int)
        /// 一直挂起，直到任务被取消 —— 用来观测 loading 中间态与取消行为。
        case hang
    }

    /// 挂起源 / 失败源被取消时的记录器。
    let cancellation = CancellationRecorder()

    private let lock = NSLock()
    private var projectsOutcome: Outcome<[AdProject]>
    private var tabOutcomes: [String: Outcome<AdAnalysisPayload>]
    private var defaultTabOutcome: Outcome<AdAnalysisPayload>
    private var recordedProjectsCalls = 0
    private var recordedRequests: [(tabKey: String, query: AdAnalysisQuery)] = []

    init(
        projects: Outcome<[AdProject]> = .value([
            AdProject(id: 1, name: "铨富", country: "US"),
            AdProject(id: 4, name: "玥涵", country: "DE"),
        ]),
        defaultTab: Outcome<AdAnalysisPayload> = .value(AdAnalysisPayload()),
        tabOutcomes: [String: Outcome<AdAnalysisPayload>] = [:]
    ) {
        self.projectsOutcome = projects
        self.defaultTabOutcome = defaultTab
        self.tabOutcomes = tabOutcomes
    }

    // MARK: - 编排

    func setProjects(_ outcome: Outcome<[AdProject]>) { withLock { projectsOutcome = outcome } }

    func setTab(_ tabKey: String, _ outcome: Outcome<AdAnalysisPayload>) {
        withLock { tabOutcomes[tabKey] = outcome }
    }

    func setDefaultTab(_ outcome: Outcome<AdAnalysisPayload>) {
        withLock { defaultTabOutcome = outcome }
    }

    // MARK: - 观测

    var projectsCallCount: Int { withLock { recordedProjectsCalls } }

    /// 收到的明细请求（顺序即调用顺序）。
    var requests: [(tabKey: String, query: AdAnalysisQuery)] { withLock { recordedRequests } }

    var requestedTabKeys: [String] { withLock { recordedRequests.map(\.tabKey) } }

    func query(forTabKey tabKey: String) -> AdAnalysisQuery? {
        withLock { recordedRequests.first { $0.tabKey == tabKey }?.query }
    }

    // MARK: - AdAnalysisDataProviding

    func projects() async throws -> [AdProject] {
        let outcome = withLock {
            recordedProjectsCalls += 1
            return projectsOutcome
        }
        return try await resolve(outcome)
    }

    func payload(tab: AdAnalysisTab, query: AdAnalysisQuery) async throws -> AdAnalysisPayload {
        let outcome = withLock {
            recordedRequests.append((tab.key, query))
            return tabOutcomes[tab.key] ?? defaultTabOutcome
        }
        return try await resolve(outcome)
    }

    private func resolve<Value: Sendable>(_ outcome: Outcome<Value>) async throws -> Value {
        switch outcome {
        case .value(let value):
            return value
        case .failure(let status):
            let body = "stub failure \(status)"
            if status == 401 || status == 403 {
                throw APIError.unauthorized(status: status, body: body)
            }
            throw APIError.http(status: status, body: body)
        case .hang:
            do {
                try await Task.sleep(nanoseconds: 30_000_000_000)
            } catch {
                cancellation.markCancelled()
                throw error
            }
            throw APIError.transport("stub 挂起源未在取消时退出")
        }
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

/// 「广告分析」状态机用例：三态、取消、刷新失败保留旧表、口径 1（不传日期）。
@MainActor
final class AdAnalysisStoreTests: XCTestCase {
    private let routeID = AdAnalysisCatalog.routeID

    private func makeStore(projectID: Int? = 1) -> AdAnalysisStore {
        AdAnalysisStore(filters: AdAnalysisStore.Filters(projectID: projectID))
    }

    /// 起一个与视图 `.task(id:)` 等价的加载（真并发：后一次加载靠同 key 取消前一次）。
    @discardableResult
    private func startLoad(
        _ store: AdAnalysisStore,
        provider: AdAnalysisDataProviding,
        scope: ModuleTaskScope
    ) -> Task<Void, Never> {
        Task { @MainActor in
            await store.load(using: provider, scope: scope, key: routeID)
        }
    }

    private func waitUntil(
        timeout: TimeInterval = 3,
        _ condition: () -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("等待条件超时（\(timeout)s）")
    }

    private func campaignsPayload() throws -> AdAnalysisPayload {
        try AdAnalysisFixtures.payload(forTabKey: "campaigns")
    }

    /// 默认落地 Tab 是「总览」，它的明细来自五个 `top_*` 来源而不是 `items`。
    private func overviewPayload() throws -> AdAnalysisPayload {
        try AdAnalysisFixtures.payload(forTabKey: "overview")
    }

    // MARK: - 正常装载

    /// 进页：先取项目列表 → 自动选中第一个 → 取当前 Tab 明细（口径：项目必填）。
    func testLoadsProjectsThenSelectedTab() async throws {
        let store = makeStore(projectID: nil)
        let provider = ScriptedAdAnalysisProvider(defaultTab: .value(try overviewPayload()))
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(provider.projectsCallCount, 1)
        XCTAssertEqual(provider.requestedTabKeys, ["overview"], "默认落地 Tab 是总览")
        XCTAssertEqual(store.filters.projectID, 1, "Web 同口径：进页选中列表第一个项目")
        let query = try XCTUnwrap(provider.query(forTabKey: "overview"))
        XCTAssertEqual(query.projectID, 1)
        XCTAssertEqual(query.country, "US")
        XCTAssertNil(query.dateFrom, "口径 1：未启用日期区间 → 不发 date_from")
        XCTAssertNil(query.dateTo)
        XCTAssertEqual(store.selectedTabState.phase, .loaded)
        XCTAssertEqual(store.contentState, .ready)
        XCTAssertFalse(store.detailRows.isEmpty)
    }

    /// 明细请求必须带 `project_id`（必填参数），没有项目就不发。
    func testNoProjectsShowsGateWithoutTabRequests() async throws {
        let store = makeStore(projectID: nil)
        let provider = ScriptedAdAnalysisProvider(projects: .value([]))
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(store.projectGate, .noProjects)
        XCTAssertTrue(provider.requestedTabKeys.isEmpty, "没有可见项目 → 不发明细请求")
        XCTAssertEqual(store.selectedTabState.phase, .idle)
    }

    func testProjectsFailureBlocksTabRequestsAndCanRetry() async throws {
        let store = makeStore(projectID: 1)
        let provider = ScriptedAdAnalysisProvider(
            projects: .failure(status: 500),
            defaultTab: .value(try campaignsPayload())
        )
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)

        guard case .failed(let message) = store.projectGate else {
            return XCTFail("项目列表失败应落成 failed 闸门，实际 \(store.projectGate)")
        }
        XCTAssertFalse(message.isEmpty)
        XCTAssertTrue(provider.requestedTabKeys.isEmpty)

        // 重试：项目列表成功后台 → 明细照常走。
        provider.setProjects(.value([AdProject(id: 1, name: "铨富")]))
        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(store.projectGate, .ready)
        XCTAssertEqual(provider.requestedTabKeys, ["overview"])
    }

    // MARK: - 三态

    func testEmptyPayloadIsEmptyState() async throws {
        let store = makeStore()
        let provider = ScriptedAdAnalysisProvider(defaultTab: .value(AdAnalysisPayload()))
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(store.contentState, .empty, "无数据要显示「无数据」，不是 0 也不是错误")
        XCTAssertEqual(store.selectedTabState.phase, .loaded)
        XCTAssertNil(store.failureMessage)
    }

    func testFailureWithoutDataIsFailedState() async throws {
        let store = makeStore()
        let provider = ScriptedAdAnalysisProvider(defaultTab: .failure(status: 500))
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(store.contentState, .failed(store.failureMessage ?? ""))
        XCTAssertNotNil(store.failureMessage)
        XCTAssertNil(store.refreshFailure, "没有旧数据时是整页失败，不是「刷新失败」")
        XCTAssertFalse(store.selectedTabState.hasPayload)
    }

    /// 有旧数据时刷新失败：**保留旧表** + 一条黄条，不把可用数据藏起来。
    func testRefreshFailureKeepsPreviousPayload() async throws {
        let store = makeStore()
        let provider = ScriptedAdAnalysisProvider(defaultTab: .value(try overviewPayload()))
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)
        let rowCount = store.detailRows.count
        XCTAssertGreaterThan(rowCount, 0)

        provider.setDefaultTab(.failure(status: 500))
        store.requestRefresh()
        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertNotNil(store.refreshFailure, "刷新失败要提示")
        XCTAssertEqual(store.selectedTabState.phase, .loaded)
        XCTAssertEqual(store.contentState, .ready, "有旧数据 → 仍是 ready，表格还在")
        XCTAssertEqual(store.detailRows.count, rowCount, "旧表必须保留")
    }

    // MARK: - 取消（不落错误态、不泄漏）

    /// 挂起的请求被取消 → 退回 idle（不是 failed），并且已有数据保留。
    func testCancelledLoadFallsBackToIdleNotFailure() async throws {
        let store = makeStore()
        let provider = ScriptedAdAnalysisProvider(defaultTab: .hang)
        let scope = ModuleTaskScope()

        let task = startLoad(store, provider: provider, scope: scope)
        await waitUntil { store.selectedTabState.phase == .loading }

        scope.cancel(key: routeID)
        await task.value

        XCTAssertEqual(store.selectedTabState.phase, .idle, "取消不是错误")
        XCTAssertNil(store.failureMessage)
        XCTAssertTrue(provider.cancellation.isCancelled, "挂起源应收到取消")
        XCTAssertTrue(scope.isEmpty, "取消后任务作用域应为空（不泄漏 Task）")
    }

    /// 切 Tab：同 key 的新加载会取消上一个 Tab 在跑的请求，且不落成错误态。
    func testSwitchingTabCancelsInFlightRequest() async throws {
        let store = makeStore()
        let provider = ScriptedAdAnalysisProvider(
            defaultTab: .hang,
            tabOutcomes: ["products": .value(try AdAnalysisFixtures.payload(forTabKey: "products"))]
        )
        let scope = ModuleTaskScope()

        let first = startLoad(store, provider: provider, scope: scope)
        await waitUntil { store.selectedTabState.phase == .loading }
        XCTAssertEqual(store.selectedTabKey, "overview")

        // 切到 SKU：新的加载登记在同一个 key 上 → 取消上一个。
        store.selectTab(key: "products")
        let second = startLoad(store, provider: provider, scope: scope)
        await first.value
        await second.value

        XCTAssertEqual(store.selectedTabKey, "products")
        XCTAssertEqual(store.selectedTabState.phase, .loaded)
        XCTAssertEqual(store.detailRows.count, 10, "SKU 快照 10 行")
        XCTAssertEqual(
            store.state(forTabKey: "overview").phase,
            .idle,
            "被取消的总览退回 idle（不是 failed）"
        )
        XCTAssertNil(store.state(forTabKey: "overview").refreshFailure)
    }

    /// 改筛选：取消在跑请求，并用**新**筛选值重新请求。
    func testFilterChangeCancelsInFlightAndUsesNewFilters() async throws {
        let store = makeStore()
        let provider = ScriptedAdAnalysisProvider(defaultTab: .hang)
        let scope = ModuleTaskScope()

        let first = startLoad(store, provider: provider, scope: scope)
        await waitUntil { store.selectedTabState.phase == .loading }

        store.setCountry("DE")
        provider.setDefaultTab(.value(try campaignsPayload()))
        let second = startLoad(store, provider: provider, scope: scope)
        await first.value
        await second.value

        XCTAssertEqual(provider.requests.count, 2)
        XCTAssertEqual(provider.requests.first?.query.country, "US")
        XCTAssertEqual(provider.requests.last?.query.country, "DE")
        XCTAssertEqual(store.selectedTabState.phase, .loaded)
        XCTAssertNil(store.failureMessage)
    }

    /// 切模块（外壳按 route id 取消）在跑的请求：不落错误态、作用域清空。
    func testModuleSwitchCancelsInFlightWithoutFailure() async throws {
        let store = makeStore()
        let provider = ScriptedAdAnalysisProvider(defaultTab: .hang)
        let scope = ModuleTaskScope()

        let task = startLoad(store, provider: provider, scope: scope)
        await waitUntil { store.selectedTabState.phase == .loading }

        scope.cancel(key: routeID) // 外壳切模块时做的事
        await task.value
        await waitUntil { scope.isEmpty }

        XCTAssertEqual(store.selectedTabState.phase, .idle)
        XCTAssertTrue(scope.isEmpty, "切换模块后不得有残留任务")
    }

    /// 项目列表请求同样受同 key 取消约束（挂起的项目列表被取消 → 闸门回到 pending）。
    func testCancelledProjectsLoadReturnsToPending() async throws {
        let store = makeStore(projectID: nil)
        let provider = ScriptedAdAnalysisProvider(projects: .hang)
        let scope = ModuleTaskScope()

        let task = startLoad(store, provider: provider, scope: scope)
        await waitUntil { store.projectGate == .pending && store.projectsPhase == .loading }

        scope.cancel(key: routeID)
        await task.value

        XCTAssertEqual(store.projectsPhase, .idle, "取消后不是 failed")
        XCTAssertEqual(store.projectGate, .pending)
    }

    // MARK: - 缓存与刷新票号

    /// 同一组筛选不重复请求（等价于 Web 的 2 分钟客户端缓存）。
    func testSameFiltersDoNotRefetch() async throws {
        let store = makeStore()
        let provider = ScriptedAdAnalysisProvider(defaultTab: .value(try campaignsPayload()))
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)
        await store.load(using: provider, scope: scope, key: routeID)
        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(provider.requests.count, 1)
        XCTAssertEqual(provider.projectsCallCount, 1, "项目列表也只取一次")
    }

    /// 手动刷新（`⌘R` / 刷新按钮）即便筛选没变也要重新请求。
    func testRefreshTicketForcesRefetch() async throws {
        let store = makeStore()
        let provider = ScriptedAdAnalysisProvider(defaultTab: .value(try campaignsPayload()))
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)
        store.requestRefresh()
        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(provider.requests.count, 2, "刷新票号 +1 必须绕过「同筛选不重取」")
        XCTAssertEqual(store.refreshTicket, 1)
    }

    /// 同一组筛选已经加载、又正在跑一次重复加载时，不取消在飞请求（视图因「自动选中项目」
    /// 重跑 `.task` 会走到这里）。
    func testDuplicateLoadWhileInFlightIsNotRefetched() async throws {
        let store = makeStore(projectID: nil)
        let provider = ScriptedAdAnalysisProvider(defaultTab: .value(try overviewPayload()))
        let scope = ModuleTaskScope()

        let first = startLoad(store, provider: provider, scope: scope)
        // 第二个加载在第一个还没落地时发起（模拟 `.task(id:)` 因 projectID 自动选中而重跑）。
        let second = startLoad(store, provider: provider, scope: scope)
        await first.value
        await second.value

        XCTAssertEqual(
            provider.requestedTabKeys,
            ["overview"],
            "同一组筛选的重复加载不得变成两次请求（更不得把在飞的那次取消掉）"
        )
        XCTAssertEqual(store.contentState, .ready)
        XCTAssertEqual(store.detailRows.count, 27)
    }

    /// 换筛选值后再切回原筛选值：会重新请求（缓存只认「当前筛选」）。
    func testFilterChangeBackAndForthRefetches() async throws {
        let store = makeStore()
        let provider = ScriptedAdAnalysisProvider(defaultTab: .value(try campaignsPayload()))
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)
        store.setCountry("DE")
        await store.load(using: provider, scope: scope, key: routeID)
        store.setCountry("US")
        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(provider.requests.map(\.query.country), ["US", "DE", "US"])
    }

    // MARK: - 口径 1：不传日期 ≠ 最近 N 天

    /// 日期区间的默认是**关闭**：store 里就算存着日期，没启用就不发（口径 1 的核心）。
    func testDatesAreNotSentUntilDateRangeEnabled() async throws {
        let store = makeStore()
        let provider = ScriptedAdAnalysisProvider(defaultTab: .value(try campaignsPayload()))
        let scope = ModuleTaskScope()

        // 直接写日期值但**不打开**开关：等价于「用户在 UI 上看不到日期、参数也不该出现」。
        store.setDateFrom("2026-08-01")
        store.setDateTo("2026-09-12")
        XCTAssertFalse(store.filters.usesDateRange)

        await store.load(using: provider, scope: scope, key: routeID)

        let query = try XCTUnwrap(provider.query(forTabKey: "overview"))
        XCTAssertNil(query.dateFrom, "未启用日期区间 = 不传（不是「最近 7 天」）")
        XCTAssertNil(query.dateTo)
        XCTAssertEqual(store.filters.effectiveDateFrom, nil)
    }

    func testDatesAreSentWhenDateRangeEnabled() async throws {
        let store = makeStore()
        let provider = ScriptedAdAnalysisProvider(defaultTab: .value(try campaignsPayload()))
        let scope = ModuleTaskScope()

        store.setUsesDateRange(true)
        store.setDateFrom("2026-08-01")
        store.setDateTo("2026-09-12")
        await store.load(using: provider, scope: scope, key: routeID)

        let query = try XCTUnwrap(provider.query(forTabKey: "overview"))
        XCTAssertEqual(query.dateFrom, "2026-08-01")
        XCTAssertEqual(query.dateTo, "2026-09-12")
    }

    /// 关掉日期区间会清空日期值（下次打开不该突然换一个区间）。
    func testDisablingDateRangeClearsValues() {
        let store = makeStore()
        store.setUsesDateRange(true)
        store.setDateFrom("2026-08-01")
        store.setDateTo("2026-09-12")
        store.setUsesDateRange(false)

        XCTAssertNil(store.filters.dateFrom)
        XCTAssertNil(store.filters.dateTo)
    }

    func testClearDateRangeResetsEverything() {
        let store = makeStore()
        store.setUsesDateRange(true)
        store.setDateFrom("2026-08-01")
        store.clearDateRange()

        XCTAssertFalse(store.filters.usesDateRange)
        XCTAssertNil(store.filters.effectiveDateFrom)
    }

    // MARK: - 切 Tab 不重置筛选

    /// 10 个 Tab 共用同一组筛选值：切 Tab 只换 `selectedTabKey`。
    func testSwitchingTabKeepsSharedFilters() {
        let store = makeStore()
        store.setCountry("DE")
        store.setUsesDateRange(true)
        store.setDateFrom("2026-08-01")
        store.setDateTo("2026-09-12")

        for tab in AdAnalysisCatalog.tabs {
            store.selectTab(key: tab.key)
        }

        XCTAssertEqual(store.selectedTabKey, "traffic-quality")
        XCTAssertEqual(store.filters.country, "DE")
        XCTAssertEqual(store.filters.dateFrom, "2026-08-01")
        XCTAssertEqual(store.filters.dateTo, "2026-09-12")
    }

    /// 每个 Tab 的加载状态互相独立（切走的 Tab 保留自己的数据与时间戳）。
    func testTabStatesAreIndependent() async throws {
        let store = makeStore()
        let provider = ScriptedAdAnalysisProvider(
            tabOutcomes: [
                "overview": .value(try AdAnalysisFixtures.payload(forTabKey: "overview")),
                "budget": .value(try AdAnalysisFixtures.payload(forTabKey: "budget")),
            ]
        )
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)
        let overviewRows = store.detailRows.count

        store.selectTab(key: "budget")
        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(store.detailRows.count, 1020)
        XCTAssertEqual(
            store.state(forTabKey: "overview").phase,
            .loaded,
            "切走的总览仍是已加载（切回来不重拉）"
        )
        XCTAssertEqual(store.state(forTabKey: "overview").payload?.detailRows(forTabKey: "overview").count, overviewRows)
        XCTAssertEqual(store.state(forTabKey: "time-trend").phase, .idle, "没打开过的 Tab 保持 idle")
    }

    func testSelectTabIgnoresUnknownKeys() {
        let store = makeStore()
        store.selectTab(key: "overview")
        store.selectTab(key: "not-a-tab")
        XCTAssertEqual(store.selectedTabKey, "overview")
    }

    // MARK: - 未登录

    func testFailWithoutCredentialDoesNotFabricateLoading() {
        let store = makeStore()
        store.failWithoutCredential()

        guard case .failed(let message) = store.projectGate else {
            return XCTFail("未登录应落成失败闸门，实际 \(store.projectGate)")
        }
        XCTAssertFalse(message.isEmpty)
        XCTAssertEqual(store.selectedTabState.phase, .idle, "不得伪造「加载中」")
    }

    /// `APIClient` 的错误文案要经由 store 转成可读文本（不吞错误）。
    func testErrorMessageUsesAPIErrorDisplayMessage() {
        let message = AdAnalysisStore.message(for: APIError.http(status: 500, body: "boom"))
        XCTAssertFalse(message.isEmpty)
        XCTAssertEqual(message, APIError.http(status: 500, body: "boom").displayMessage)
    }

    /// 加载键把 Tab / 筛选 / 刷新票号都算了进去（视图 `.task(id:)` 的驱动器）。
    func testLoadKeyTracksTabFiltersAndRefreshTicket() {
        let store = makeStore()
        let initial = store.loadKey

        store.selectTab(key: "budget")
        XCTAssertNotEqual(store.loadKey, initial)
        let afterTab = store.loadKey

        store.setCountry("DE")
        XCTAssertNotEqual(store.loadKey, afterTab)
        let afterCountry = store.loadKey

        store.requestRefresh()
        XCTAssertNotEqual(store.loadKey, afterCountry)
        XCTAssertEqual(store.loadKey.signature.country, "DE")
        XCTAssertEqual(store.loadKey.tabKey, "budget")
    }
}
