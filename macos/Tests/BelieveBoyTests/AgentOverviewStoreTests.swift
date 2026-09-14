import BelieveBoyKit
import XCTest

@testable import BelieveBoyUI

/// 「数据流总览」状态机 —— 验收 2（三态）与验收 3（分层超时之外的降级/取消语义）的直接证据。
///
/// provider 是可编排的假实现（`ScriptedAgentOpsProvider`），故这些用例断言的都是
/// 「哪个源什么状态、界面会看到什么」，不需要网络、也不依赖真实后端的时序。
@MainActor
final class AgentOverviewStoreTests: XCTestCase {
    /// 固定 `now`：美西 2026-09-13 09:30（北京 09-14 00:30）—— 本地日期与美西日期不同，
    /// 用来钉住「传出去的 `date` 必须是美西那天」。
    private let fixedNow = AgentOpsFormatting.parseISO8601("2026-09-14T00:30:00+08:00")!

    private var expectedUsDate: String {
        AgentOpsFormatting.usToday(now: fixedNow)
    }

    private func matrix(_ activities: [DomainActivity]) -> DomainSummaryResponse {
        DomainSummaryResponse(
            generatedAt: "2026-09-14T08:43:38.395853Z",
            windowDays: 7,
            items: activities
        )
    }

    private func shipments(_ calls7D: Int = 353) -> DomainActivity {
        DomainActivity.fixture(
            domain: "shipments",
            calls24H: 0,
            calls7D: calls7D,
            writes7D: 34,
            errors7D: 38,
            lastActiveAt: "2026-09-11T18:31:32.647904+08:00"
        )
    }

    private func loadedProvider() -> ScriptedAgentOpsProvider {
        ScriptedAgentOpsProvider(
            matrix: .value(matrix([shipments()])),
            complaints: .value(ComplaintProduction(hasRun: true, needsReply: 3)),
            inspections: .value(InspectionProduction(submitted: 2, total: 20)),
            reports: .value(ReportUploadCompletion(uploaded: 134, total: 150))
        )
    }

    private func load(
        _ store: AgentOverviewStore,
        _ provider: ScriptedAgentOpsProvider,
        scope: ModuleTaskScope = ModuleTaskScope(),
        key: String = "overview"
    ) async {
        await store.load(using: provider, scope: scope, key: key, now: fixedNow)
    }

    private func productionText(_ store: AgentOverviewStore, _ code: String) -> String? {
        store.rows.first { $0.domain.code == code }?.production ?? nil
    }

    private func waitUntil(
        timeout: TimeInterval = 2,
        _ condition: () -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("等待条件超时（\(timeout)s）")
    }

    // MARK: - 加载态 → 有数据

    func testLoadLandsMatrixAndProduction() async {
        let provider = loadedProvider()
        let store = AgentOverviewStore()
        let scope = ModuleTaskScope()

        await load(store, provider, scope: scope)

        XCTAssertEqual(store.pageState, .ready)
        XCTAssertEqual(store.matrixPhase, .loaded)
        XCTAssertEqual(store.complaintsPhase, .loaded)
        XCTAssertEqual(store.inspectionsPhase, .loaded)
        XCTAssertEqual(store.reportsPhase, .loaded)
        XCTAssertEqual(store.rows.count, 17)
        XCTAssertEqual(store.activityDomainCount, 1)
        XCTAssertEqual(store.windowDays, 7)
        XCTAssertEqual(store.lastLoadedAt, fixedNow)
        XCTAssertFalse(store.isRefreshing)
        XCTAssertEqual(productionText(store, "complaint_center"), "待回复 3")
        XCTAssertEqual(productionText(store, "platform_inspection"), "2/20 报告")
        XCTAssertEqual(productionText(store, "report_upload"), "134/150 报表")
        XCTAssertTrue(scope.isEmpty, "加载结束后不该有残留登记")
    }

    /// 「今天」是**美西**今天：北京 00:30 时美西还是前一天，传错会让今日产出整列「—」。
    func testRequestedDateIsLosAngelesTodayNotLocalToday() async {
        let provider = loadedProvider()
        let store = AgentOverviewStore()

        await load(store, provider)

        XCTAssertEqual(expectedUsDate, "2026-09-13", "用例前提：此刻美西仍是 09-13")
        XCTAssertNotEqual(
            expectedUsDate,
            AgentOpsFormatting.usToday(
                now: fixedNow,
                timeZone: TimeZone(identifier: "Asia/Shanghai")!
            ),
            "用例前提：本机时区（北京）此刻已是 09-14，两个日期必须不同才有区分度"
        )
        XCTAssertEqual(provider.requestedDates, [expectedUsDate, expectedUsDate])
        XCTAssertEqual(provider.requestedCountries, ["US"])
        XCTAssertEqual(provider.requestedWindows, [7])
        XCTAssertEqual(
            Set(provider.requestedSources),
            ["matrix", "complaints", "inspections", "reports"]
        )
    }

    // MARK: - 空态

    /// 矩阵成功但窗口内一个域都没有 → **空态**（表格仍在，全占位），不是加载态也不是错误态。
    func testEmptyWindowIsEmptyStateWithRegistryRows() async {
        let provider = ScriptedAgentOpsProvider(matrix: .value(matrix([])))
        let store = AgentOverviewStore()

        await load(store, provider)

        XCTAssertEqual(store.pageState, .empty)
        XCTAssertEqual(store.rows.count, 17, "空窗口也要给出完整注册表行")
        XCTAssertEqual(store.activityDomainCount, 0)
        XCTAssertTrue(store.rows.allSatisfy { $0.activity == nil })
    }

    // MARK: - 错误态

    func testMatrixFailureIsErrorStateAndRetryRecovers() async {
        let provider = ScriptedAgentOpsProvider(matrix: .failure(status: 500))
        let store = AgentOverviewStore()

        await load(store, provider)

        let message = APIError.http(status: 500, body: "stub failure 500").displayMessage
        XCTAssertEqual(store.pageState, .failed(message))
        XCTAssertNil(store.matrix)

        provider.setMatrix(.value(matrix([shipments()])))
        await load(store, provider)

        XCTAssertEqual(store.pageState, .ready)
        XCTAssertNil(store.matrixRefreshFailure)
    }

    /// 401/403 的文案要指向「重新登录」（`APIError.requiresCredentialFix` 的同一条契约）。
    func testUnauthorizedMatrixFailureSurfacesCredentialMessage() async {
        let provider = ScriptedAgentOpsProvider(matrix: .failure(status: 403))
        let store = AgentOverviewStore()

        await load(store, provider)

        guard case .failed(let message) = store.pageState else {
            return XCTFail("期望错误态，实得 \(store.pageState)")
        }
        XCTAssertTrue(message.contains("403"), "错误文案应带上状态码：\(message)")
        XCTAssertTrue(message.contains("API key"), "应指出是凭据问题：\(message)")
    }

    /// 有旧数据时刷新失败：**保留表格**并给出告警横幅，不把整页打成错误页。
    func testRefreshFailureKeepsPreviousDataAndSurfacesBanner() async {
        let provider = loadedProvider()
        let store = AgentOverviewStore()

        await load(store, provider)
        XCTAssertEqual(store.pageState, .ready)

        provider.setMatrix(.failure(status: 503))
        await load(store, provider)

        XCTAssertEqual(store.pageState, .ready, "有旧数据就不该退化成错误页")
        XCTAssertNotNil(store.matrixRefreshFailure)
        XCTAssertEqual(store.activityDomainCount, 1, "旧数据必须还在")
        XCTAssertEqual(productionText(store, "report_upload"), "134/150 报表")
    }

    // MARK: - 单频道降级

    /// 一个产出源失败 → 只有它那两列变占位，其它列与矩阵不受影响（Web 的单频道语义）。
    func testSingleSourceFailureOnlyBlanksItsOwnColumn() async {
        let provider = ScriptedAgentOpsProvider(
            matrix: .value(matrix([shipments()])),
            complaints: .value(ComplaintProduction(hasRun: true, needsReply: 3)),
            inspections: .value(InspectionProduction(submitted: 2, total: 20)),
            reports: .failure(status: 500)
        )
        let store = AgentOverviewStore()

        await load(store, provider)

        XCTAssertEqual(store.pageState, .ready, "一个源失败不该影响矩阵")
        XCTAssertEqual(store.failedProductionSources, ["报表"])
        XCTAssertNil(productionText(store, "report_upload"), "失败的源 → 占位「—」")
        XCTAssertNil(productionText(store, "report_upload_status"))
        XCTAssertEqual(productionText(store, "complaint_center"), "待回复 3", "其它列照常")
        XCTAssertEqual(productionText(store, "platform_inspection"), "2/20 报告")
        XCTAssertEqual(store.reportsPhase.failureMessage?.isEmpty, false)
    }

    func testAllThreeProductionSourcesCanFailTogether() async {
        let provider = ScriptedAgentOpsProvider(
            matrix: .value(matrix([shipments()])),
            complaints: .failure(status: 500),
            inspections: .failure(status: 500),
            reports: .failure(status: 500)
        )
        let store = AgentOverviewStore()

        await load(store, provider)

        XCTAssertEqual(store.failedProductionSources, ["客诉", "巡检", "报表"])
        XCTAssertEqual(store.pageState, .ready)
        XCTAssertTrue(store.rows.allSatisfy { $0.production == nil })
    }

    // MARK: - 中间态与取消

    /// 挂起的源保持 loading（界面转圈），已回来的源照常点亮 —— 与 Web 各 hook 独立
    /// 落地的观感一致。
    func testHangingSourceStaysLoadingWhileOthersLand() async {
        let provider = ScriptedAgentOpsProvider(
            matrix: .value(matrix([shipments()])),
            complaints: .value(ComplaintProduction(hasRun: true, needsReply: 3)),
            inspections: .value(InspectionProduction(submitted: 2, total: 20)),
            reports: .hang
        )
        let store = AgentOverviewStore()
        let scope = ModuleTaskScope()

        let task = Task { await self.load(store, provider, scope: scope) }
        await waitUntil { store.matrixPhase == .loaded && store.complaintsPhase == .loaded }

        XCTAssertEqual(store.reportsPhase, .loading)
        XCTAssertTrue(store.isRefreshing, "还有源在跑 → 页头转圈")
        XCTAssertNil(productionText(store, "report_upload"), "未回来的源先显示占位")
        XCTAssertEqual(store.pageState, .ready, "矩阵已回来 → 页面可用")

        scope.cancel(key: "overview")
        _ = await task.value
        XCTAssertTrue(provider.cancellation.isCancelled, "挂起的源应收到取消")
    }

    /// 取消（切换模块）→ 退回 idle，**不落成错误态**，且不残留任务登记。
    ///
    /// 若把取消当失败，用户每切一次模块就会在回来时看到一个「已取消」的红色横幅。
    func testCancellationRevertsLoadingToIdleWithoutErrorState() async {
        let provider = ScriptedAgentOpsProvider(matrix: .hang)
        let store = AgentOverviewStore()
        let scope = ModuleTaskScope()

        let task = Task { await self.load(store, provider, scope: scope) }
        await waitUntil { store.matrixPhase == .loading }

        scope.cancel(key: "overview")
        _ = await task.value

        XCTAssertEqual(store.matrixPhase, .idle, "取消后应回到 idle，而不是 failed")
        XCTAssertNil(store.matrixRefreshFailure)
        XCTAssertNil(store.matrix)
        XCTAssertEqual(store.pageState, .loading, "无数据 + 未加载 = 仍是加载态，回来会重新拉")
        XCTAssertTrue(provider.cancellation.isCancelled)
        await waitUntil { scope.isEmpty }
        XCTAssertTrue(scope.isEmpty, "取消后作用域应为空（无泄漏登记）")
    }

    /// 连点刷新：同一 key 上只保留最后一次，前一次的挂起请求被取消。
    func testRapidRefreshesCancelPreviousLoad() async {
        let provider = ScriptedAgentOpsProvider(matrix: .hang)
        let store = AgentOverviewStore()
        let scope = ModuleTaskScope()

        let first = Task { await self.load(store, provider, scope: scope) }
        await waitUntil { store.matrixPhase == .loading }

        provider.setMatrix(.value(matrix([shipments()])))
        let second = Task { await self.load(store, provider, scope: scope) }

        _ = await first.value
        _ = await second.value

        XCTAssertEqual(store.matrixPhase, .loaded)
        XCTAssertEqual(store.activityDomainCount, 1)
        XCTAssertTrue(provider.cancellation.isCancelled)
    }

    /// 与真实外壳的接线一致：按当前选中项的 route id 登记，**切换模块即取消**。
    func testSwitchingModuleCancelsInFlightLoad() async {
        let provider = ScriptedAgentOpsProvider(matrix: .hang)
        let scope = ModuleTaskScope()
        let navigation = NavigationStore(preferences: InMemoryShellPreferencesStore(), tasks: scope)
        navigation.select(routeID: AgentOverviewView.routeID)
        XCTAssertEqual(navigation.selectionTaskKey, AgentOverviewView.routeID)

        let task = Task {
            await navigation.agentOverview.load(
                using: provider,
                scope: navigation.tasks,
                key: navigation.selectionTaskKey,
                now: self.fixedNow
            )
        }
        await waitUntil { navigation.agentOverview.matrixPhase == .loading }

        navigation.select(routeID: "/dashboard/operations/site-navigation")

        _ = await task.value

        XCTAssertTrue(provider.cancellation.isCancelled, "切走模块必须取消在跑的加载")
        await waitUntil { scope.isEmpty }
        XCTAssertTrue(scope.isEmpty)
        XCTAssertEqual(navigation.agentOverview.matrixPhase, .idle, "取消不是失败")
    }

    // MARK: - 选中与凭据

    func testSelectionTogglesAndResolvesRow() async {
        let store = AgentOverviewStore()
        await load(store, loadedProvider())

        XCTAssertNil(store.selectedRow)

        store.select(domainCode: "shipments")
        XCTAssertEqual(store.selectedRow?.domain.code, "shipments")
        XCTAssertEqual(store.selectedRow?.activity?.calls7D, 353)

        store.select(domainCode: "shipments")
        XCTAssertNil(store.selectedDomainCode, "再点一次同一行 = 取消选中")

        store.select(domainCode: "sales")
        store.clearSelection()
        XCTAssertNil(store.selectedRow)
    }

    /// 未登录：直接置错误态，**不发请求**（没有 key 的请求必然 401，
    /// 把它显示成「key 被拒绝」会把「还没登录」误导成「凭据失效」）。
    func testMissingCredentialFailsWithoutIssuingRequests() async {
        let provider = ScriptedAgentOpsProvider()
        let store = AgentOverviewStore()

        store.failWithoutCredential()

        guard case .failed(let message) = store.pageState else {
            return XCTFail("期望错误态，实得 \(store.pageState)")
        }
        XCTAssertTrue(message.contains("尚未登录"))
        XCTAssertTrue(provider.requestedSources.isEmpty, "不得发起任何请求")
    }
}
