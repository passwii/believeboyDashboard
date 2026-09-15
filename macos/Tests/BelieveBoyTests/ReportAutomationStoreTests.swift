import BelieveBoyKit
import Foundation
import XCTest

@testable import BelieveBoyUI

/// 可编排的「报表自动化」数据源假实现（项目列表 + RPA 状态）。
final class ScriptedReportAutomationProvider: ReportAutomationDataProviding, @unchecked Sendable {
    enum Outcome<Value: Sendable>: Sendable {
        case value(Value)
        case failure(status: Int)
        case hang
    }

    let cancellation = CancellationRecorder()

    private let lock = NSLock()
    private var projectsOutcome: Outcome<[AdProject]>
    private var statusOutcome: Outcome<RpaReportStatusResponse>
    private var recordedProjectsCalls = 0
    private var recordedQueries: [RpaReportStatusQuery] = []

    init(
        projects: Outcome<[AdProject]> = .value([AdProject(id: 19, name: "博朗姆", country: "US")]),
        status: Outcome<RpaReportStatusResponse> = .value(RpaReportStatusResponse(country: "US", items: []))
    ) {
        self.projectsOutcome = projects
        self.statusOutcome = status
    }

    func setProjects(_ outcome: Outcome<[AdProject]>) { withLock { projectsOutcome = outcome } }
    func setStatus(_ outcome: Outcome<RpaReportStatusResponse>) { withLock { statusOutcome = outcome } }

    var projectsCallCount: Int { withLock { recordedProjectsCalls } }
    var queries: [RpaReportStatusQuery] { withLock { recordedQueries } }

    func projects() async throws -> [AdProject] {
        let outcome = withLock {
            recordedProjectsCalls += 1
            return projectsOutcome
        }
        return try await resolve(outcome)
    }

    func rpaStatus(_ query: RpaReportStatusQuery) async throws -> RpaReportStatusResponse {
        let outcome = withLock { () -> Outcome<RpaReportStatusResponse> in
            recordedQueries.append(query)
            return statusOutcome
        }
        return try await resolve(outcome)
    }

    private func resolve<Value: Sendable>(_ outcome: Outcome<Value>) async throws -> Value {
        switch outcome {
        case .value(let value):
            return value
        case .failure(let status):
            throw APIError.http(status: status, body: "stub failure \(status)")
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

/// 「报表自动化」状态页的状态机用例：请求形状、三态、刷新保留旧表、项目筛选、懒加载、取消。
@MainActor
final class ReportAutomationStoreTests: XCTestCase {
    private let routeID = ReportAutomationView.routeID

    private func makeStore(reportDate: String = "2026-09-14") -> ReportAutomationStore {
        ReportAutomationStore(reportDate: reportDate, country: "US")
    }

    private func fixtureStatus() throws -> RpaReportStatusResponse {
        try ReportFixtures.rpaStatus()
    }

    // MARK: - 请求形状

    /// 进页按「报表日期 + 站点」发一次；查询串与页面口径一致。
    func testLoadSendsReportDateAndCountry() async throws {
        let provider = ScriptedReportAutomationProvider(status: .value(try fixtureStatus()))
        let store = makeStore()
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, routeID: routeID)

        XCTAssertEqual(provider.queries.count, 1)
        XCTAssertEqual(provider.queries.first?.reportDate, "2026-09-14")
        XCTAssertEqual(provider.queries.first?.country, "US")
        XCTAssertEqual(store.contentState, .ready)
        XCTAssertEqual(store.rows.count, 10)
        XCTAssertNotNil(store.loadedAt)
        XCTAssertTrue(scope.isEmpty, "加载完不留任务")
    }

    /// 日期不合法（用户正在输入）→ **不发请求**，也不留错误态。
    func testInvalidDateDoesNotRequestAndKeepsIdle() async throws {
        let provider = ScriptedReportAutomationProvider(status: .value(try fixtureStatus()))
        let store = makeStore(reportDate: "2026-9-4")
        await store.load(using: provider, scope: ModuleTaskScope(), routeID: routeID)

        XCTAssertTrue(provider.queries.isEmpty, "10 字符的日期契约由客户端先挡一道")
        XCTAssertEqual(store.phase, .idle)
        XCTAssertEqual(store.contentState, .loading, "没数据也没失败 → 仍是加载档")
    }

    /// 换日期 / 换站点各自再发一次；票号变化也能强制刷新。
    func testDimensionChangesTriggerReload() async throws {
        let provider = ScriptedReportAutomationProvider(status: .value(try fixtureStatus()))
        let store = makeStore()
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, routeID: routeID)
        store.shiftDate(days: -1)
        await store.load(using: provider, scope: scope, routeID: routeID)
        store.setCountry("DE")
        await store.load(using: provider, scope: scope, routeID: routeID)
        store.requestRefresh()
        await store.load(using: provider, scope: scope, routeID: routeID)

        XCTAssertEqual(
            provider.queries.map(\.reportDate),
            ["2026-09-14", "2026-09-13", "2026-09-13", "2026-09-13"]
        )
        XCTAssertEqual(provider.queries.map(\.country), ["US", "US", "DE", "DE"])
    }

    // MARK: - 三态

    /// 空结果 → 显式空态（文案带日期），**不是**错误页、也不是永远转圈。
    func testEmptyResultIsExplicitEmptyState() async throws {
        let provider = ScriptedReportAutomationProvider(
            status: .value(RpaReportStatusResponse(country: "US", items: []))
        )
        let store = makeStore()
        await store.load(using: provider, scope: ModuleTaskScope(), routeID: routeID)

        XCTAssertEqual(store.contentState, .empty)
        XCTAssertTrue(store.emptyMessage.contains("2026-09-14"), store.emptyMessage)
        XCTAssertTrue(store.completeness.isEmpty, "0/0 要判成空而不是「做不满」")
    }

    /// 无数据 + 失败 → 错误态（带可重试的文案）。
    func testFailureWithoutDataIsErrorState() async throws {
        let provider = ScriptedReportAutomationProvider(status: .failure(status: 500))
        let store = makeStore()
        await store.load(using: provider, scope: ModuleTaskScope(), routeID: routeID)

        guard case .failed(let message) = store.contentState else {
            return XCTFail("应当落成错误态，实际 \(store.contentState)")
        }
        XCTAssertTrue(message.contains("500"), message)
        XCTAssertNil(store.refreshFailure, "没有旧数据时不该是「刷新失败」")
    }

    /// **刷新失败保留旧表**（口径 2）：行一字不动，只挂一条提示。
    func testRefreshFailureKeepsPreviousTable() async throws {
        let provider = ScriptedReportAutomationProvider(status: .value(try fixtureStatus()))
        let store = makeStore()
        let scope = ModuleTaskScope()
        await store.load(using: provider, scope: scope, routeID: routeID)
        let before = store.rows

        provider.setStatus(.failure(status: 500))
        await store.load(using: provider, scope: scope, routeID: routeID)

        XCTAssertEqual(store.rows, before, "刷新失败必须保留旧表")
        XCTAssertEqual(store.contentState, .ready)
        XCTAssertNotNil(store.refreshFailure)
        XCTAssertTrue(store.refreshFailure?.contains("500") ?? false)
    }

    // MARK: - 完成度与筛选

    /// 全表完成度与夹具的抽样数字一致（10 个项目 × 15 列，133 个已上传）。
    func testCompletenessMatchesFixtureSample() async throws {
        let provider = ScriptedReportAutomationProvider(status: .value(try fixtureStatus()))
        let store = makeStore()
        await store.load(using: provider, scope: ModuleTaskScope(), routeID: routeID)

        XCTAssertEqual(store.completeness.text, "133/150")
        XCTAssertEqual(store.completeness.total, store.columns.count)
    }

    /// 项目筛选：只影响展示（不发新请求），完成度跟着筛后的行算。
    func testProjectFilterFiltersRowsWithoutRefetching() async throws {
        let provider = ScriptedReportAutomationProvider(status: .value(try fixtureStatus()))
        let store = makeStore()
        let scope = ModuleTaskScope()
        await store.load(using: provider, scope: scope, routeID: routeID)
        XCTAssertEqual(provider.queries.count, 1)

        store.toggleProject("博朗姆")
        XCTAssertEqual(provider.queries.count, 1, "筛选是客户端行为，不重新发请求")
        XCTAssertEqual(store.filteredRows.map(\.projectName), ["博朗姆"])
        XCTAssertEqual(store.completeness.text, "14/15")
        XCTAssertEqual(store.projectFilterLabel, "博朗姆")
        XCTAssertTrue(store.hasProjectFilter)

        store.clearProjectFilter()
        XCTAssertEqual(store.filteredRows.count, 10)
        XCTAssertEqual(store.projectFilterLabel, "全部项目")
    }

    /// 筛选到空集时仍能分辨「筛没了」与「当天没数据」。
    func testFilterToUnmatchedProjectYieldsEmptyFilteredRowsWithData() async throws {
        let provider = ScriptedReportAutomationProvider(status: .value(try fixtureStatus()))
        let store = makeStore()
        await store.load(using: provider, scope: ModuleTaskScope(), routeID: routeID)

        store.toggleProject("这个项目不存在")
        XCTAssertFalse(store.rows.isEmpty, "原始数据还在")
        XCTAssertTrue(store.filteredRows.isEmpty)
        XCTAssertEqual(store.completeness.reported, 0, "空筛选下分母为 0（界面显示「—」）")
        XCTAssertTrue(store.completeness.isEmpty)
    }

    /// 列目录顺序照抄 Web `report-type-labels.ts`。
    func testColumnOrderMatchesWeb() {
        XCTAssertEqual(
            ReportAutomationCatalog.columns.map(\.label),
            [
                "库存", "业务", "销售", "付款", "退货",
                "广告-词份额", "广告-预算", "广告-广告活动", "广告-已购商品", "广告-推广商品",
                "广告-无效流量", "广告-广告位", "广告-搜索词投放", "广告-搜索词", "广告-时间效果",
            ]
        )
        XCTAssertEqual(ReportAutomationCatalog.coreColumns.count, 5)
        XCTAssertEqual(ReportAutomationCatalog.adColumns.count, 10)
    }

    // MARK: - 项目筛选的懒加载

    /// 项目列表只在首次打开筛选时拉一次（Web BEL-422 同口径）。
    func testProjectsAreFetchedLazilyOnce() async throws {
        let provider = ScriptedReportAutomationProvider(status: .value(try fixtureStatus()))
        let store = makeStore()
        let scope = ModuleTaskScope()
        await store.load(using: provider, scope: scope, routeID: routeID)
        XCTAssertEqual(provider.projectsCallCount, 0, "进页不预拉项目列表")

        store.ensureProjects(using: provider, scope: scope, routeID: routeID)
        await waitUntil { store.projectsPhase == .loaded }
        store.ensureProjects(using: provider, scope: scope, routeID: routeID)
        await waitUntil { scope.isEmpty }
        XCTAssertEqual(provider.projectsCallCount, 1, "第二次打开下拉不再拉")
        XCTAssertEqual(store.projectsPhase, .loaded)
    }

    /// 项目列表拉失败**不拖垮**状态矩阵，且失败后允许重试（标记复位）。
    func testProjectsFailureDoesNotBreakGridAndAllowsRetry() async throws {
        let provider = ScriptedReportAutomationProvider(
            projects: .failure(status: 500),
            status: .value(try fixtureStatus())
        )
        let store = makeStore()
        let scope = ModuleTaskScope()
        await store.load(using: provider, scope: scope, routeID: routeID)
        XCTAssertEqual(store.contentState, .ready, "附属信息失败不影响主表")

        store.ensureProjects(using: provider, scope: scope, routeID: routeID)
        await waitUntil { store.projectsPhase.failureMessage != nil }
        store.ensureProjects(using: provider, scope: scope, routeID: routeID)
        await waitUntil { provider.projectsCallCount == 2 }
        XCTAssertEqual(provider.projectsCallCount, 2, "失败后允许再试")
    }

    // MARK: - 取消 / 未登录

    /// 取消（切页 / 改参数）：任务清空、不落错误态、已有数据保留。
    func testCancellingLoadLeavesNoTaskAndNoErrorState() async throws {
        let provider = ScriptedReportAutomationProvider(status: .hang)
        let store = makeStore()
        let scope = ModuleTaskScope()

        let task = Task { @MainActor in
            await store.load(using: provider, scope: scope, routeID: routeID)
        }
        await waitUntil { scope.activeKeys == ["\(routeID):ra-status"] }
        XCTAssertEqual(store.phase, .loading)

        scope.cancelTree(key: routeID)
        await task.value

        XCTAssertTrue(provider.cancellation.isCancelled)
        XCTAssertEqual(store.phase, .idle, "取消不是失败")
        XCTAssertEqual(store.contentState, .loading, "没有数据、没有失败 → 显示加载档")
        await waitUntil { scope.isEmpty }
    }

    /// 未登录：不发请求。
    func testFailWithoutCredentialDoesNotRequest() async throws {
        let provider = ScriptedReportAutomationProvider()
        let store = makeStore()
        store.failWithoutCredential()
        XCTAssertTrue(provider.queries.isEmpty)
        guard case .failed(let message) = store.contentState else {
            return XCTFail("应当落成 failed")
        }
        XCTAssertTrue(message.contains("尚未登录"), message)
    }

    /// 日期导航：前后一天 + 「今天」（本机时区）。
    func testDateNavigationUsesLocalCalendar() throws {
        let timeZone = try XCTUnwrap(TimeZone(identifier: "Asia/Shanghai"))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 3, day: 1, hour: 9)))

        let store = ReportAutomationStore(
            reportDate: ReportCatalog.localDateString(now, timeZone: timeZone)
        )
        store.shiftDate(days: -1)
        XCTAssertEqual(store.reportDate, "2026-02-28", "跨月回退")
        store.shiftDate(days: 1)
        XCTAssertEqual(store.reportDate, "2026-03-01")
        store.shiftDate(days: 5)
        XCTAssertEqual(store.reportDate, "2026-03-06")
        store.goToToday(now: now)
        XCTAssertEqual(store.reportDate, "2026-03-01")
    }

    /// 查询摘要里要能读到「实际查了什么」（比对数值时照它念）。
    func testFilterSummaryMentionsDimensions() async throws {
        let provider = ScriptedReportAutomationProvider(status: .value(try fixtureStatus()))
        let store = makeStore()
        await store.load(using: provider, scope: ModuleTaskScope(), routeID: routeID)
        store.toggleProject("博朗姆")

        let summary = store.filterSummary
        XCTAssertTrue(summary.contains("2026-09-14"), summary)
        XCTAssertTrue(summary.contains("美国站") || summary.contains("US"), summary)
        XCTAssertTrue(summary.contains("博朗姆"), summary)
        XCTAssertTrue(summary.contains("拉取"), "要带数据拉取时刻")
    }
}
