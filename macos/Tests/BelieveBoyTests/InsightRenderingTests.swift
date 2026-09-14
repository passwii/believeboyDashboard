import AppKit
import BelieveBoyKit
import SwiftUI
import XCTest

@testable import BelieveBoyUI

/// 洞察三页的离屏渲染核对：路由表命中 → 真模块发请求 → 状态机落地 → 界面画出内容。
///
/// 为什么必须离屏渲染：验收「6 条端点全部接通、可达」在类型层面无法成立 —— 列表、筛选条、
/// Markdown 正文都是 `ScrollView` / 条件分支，只在视图真正挂进窗口后才布局。这里用与线上
/// 完全一样的装配方式（`AppModel` + `APIClient` + `NavigationStore` + `ShellView`，只把
/// `URLSession` 打桩、响应用**真实后端快照**），因此「模块确实接上线了」不靠人工检查。
@MainActor
final class InsightRenderingTests: XCTestCase {
    private let runID = "b1f00000-0000-4000-8000-0000000000c1"
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

    private func makeSignedInSession() -> InMemorySessionStore {
        let sessionStore = InMemorySessionStore()
        try? sessionStore.saveSession(AuthSession(apiKey: "blf_INSIGHT", user: .fixtureAdmin))
        return sessionStore
    }

    /// 按路径登记响应。
    private func makeSignedInModel(routes: [String: StubURLProtocol.Response]) -> AppModel {
        AppModel(
            sessionStore: makeSignedInSession(),
            rememberedLogins: InMemoryRememberedLoginStore(),
            processEnvironment: [:],
            urlSession: StubURLProtocol.session(routes: routes)
        )
    }

    /// 按请求内容决定响应（SSE 需要按路径返回流式响应体）。
    private func makeSignedInModel(
        handler: @escaping @Sendable (URLRequest) -> StubURLProtocol.Response
    ) -> AppModel {
        AppModel(
            sessionStore: makeSignedInSession(),
            rememberedLogins: InMemoryRememberedLoginStore(),
            processEnvironment: [:],
            urlSession: StubURLProtocol.session(handler: handler)
        )
    }

    private func makeShell(routeID: String, model: AppModel) -> (ShellView, NavigationStore) {
        let navigation = NavigationStore(preferences: InMemoryShellPreferencesStore())
        navigation.select(routeID: routeID)
        scopes.append(navigation.tasks)
        return (ShellView(model: model, navigation: navigation), navigation)
    }

    private static let projectsBody = InsightRenderingBodies.projects

    /// 3 条端点的真实快照 + 项目列表，全部登记成打桩路由。
    private func insightRoutes(
        overrides: [String: StubURLProtocol.Response] = [:]
    ) throws -> [String: StubURLProtocol.Response] {
        var routes: [String: StubURLProtocol.Response] = [
            "/api/v1/projects/manage": .json(200, InsightRenderingBodies.projects),
            "/api/v1/ai-insights": .json(
                200,
                try InsightFixtures.text(fileName: "ai-insights-list.json")
            ),
            "/api/v1/ai-insights/schedules": .json(
                200,
                try InsightFixtures.text(fileName: "ai-insights-schedules.json")
            ),
            "/api/v1/ai-insights/46": .json(
                200,
                try InsightFixtures.text(fileName: "ai-insights-detail.json")
            ),
        ]
        routes.merge(overrides) { _, override in override }
        return routes
    }

    // MARK: - AI 洞察页

    /// 「AI → AI 洞察」经 `ModuleRegistry` 命中真模块：项目 → 定时列表 → 洞察列表，
    /// 并把内容真的画出来。
    func testAIInsightsModuleRendersThroughShellRegistry() async throws {
        let model = makeSignedInModel(routes: try insightRoutes())
        let (shell, navigation) = makeShell(routeID: AIInsightsView.routeID, model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()

        await waitUntil { navigation.aiInsights.contentState == .ready }

        let paths = StubURLProtocol.loggedPaths
        XCTAssertTrue(paths.contains("/api/v1/projects/manage"), "实发：\(paths)")
        XCTAssertTrue(paths.contains("/api/v1/ai-insights"), "实发：\(paths)")
        XCTAssertTrue(paths.contains("/api/v1/ai-insights/schedules"), "实发：\(paths)")

        // 数值口径与真实快照一致（`total` 是窗口内总数）。
        XCTAssertEqual(navigation.aiInsights.total, try InsightFixtures.insightList().total)

        hosted.pump()
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0, "列表要真的画出来")
    }

    /// 点开一条洞察 → 取明细（真实快照，已终态 → 不再开流）并把 Markdown 正文画出来。
    func testOpeningInsightDetailFetchesAndRendersMarkdown() async throws {
        let model = makeSignedInModel(routes: try insightRoutes())
        let (shell, navigation) = makeShell(routeID: AIInsightsView.routeID, model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.aiInsights.contentState == .ready }

        let baseline = logBaseline()
        navigation.aiInsights.openInsight(id: 46)
        hosted.pump()
        await waitUntil { navigation.aiInsights.detailPhase == .loaded }

        XCTAssertTrue(
            loggedPaths(since: baseline).contains("/api/v1/ai-insights/46"),
            "实发：\(loggedPaths(since: baseline))"
        )
        let detail = try XCTUnwrap(navigation.aiInsights.detail)
        XCTAssertEqual(navigation.aiInsights.detailContent, detail.content)
        XCTAssertFalse(navigation.aiInsights.isDetailLive, "已终态的洞察不该订阅流")
        XCTAssertFalse(
            loggedPaths(since: baseline).contains("/api/v1/ai-insights/46/stream"),
            "终态洞察不该开流"
        )

        hosted.pump()
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0)
    }

    /// 明细加载失败 → 画出红色错误横幅（而不是静默留空）。
    func testDetailFailurePaintsNotice() async throws {
        let model = makeSignedInModel(
            routes: try insightRoutes(overrides: [
                "/api/v1/ai-insights/46": .json(500, #"{"detail":"boom"}"#)
            ])
        )
        let (shell, navigation) = makeShell(routeID: AIInsightsView.routeID, model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.aiInsights.contentState == .ready }

        navigation.aiInsights.openInsight(id: 46)
        hosted.pump()
        await waitUntil { navigation.aiInsights.detailPhase.failureMessage != nil }

        hosted.pump()
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0)
    }

    // MARK: - AI 广告分析页

    /// 「AI → AI 广告分析」经路由表命中：历史列表固定 `insight_type=ad_analysis`，
    /// 明细带维度面板（从 `strategy_metadata` 现取）。
    func testAIAdAnalysisModuleUsesAdAnalysisFilterAndRendersDimensionPanel() async throws {
        // 真实 detail 的 `strategy_metadata` 是 nil（生产快照如此），这里换成一份带
        // `evolution_metadata` 的响应，专门验证维度面板这条渲染路径。
        let detailBody = InsightRenderingBodies.detailWithStrategyMetadata
        let model = makeSignedInModel(
            routes: try insightRoutes(overrides: [
                "/api/v1/ai-insights": .json(
                    200,
                    try InsightFixtures.text(fileName: "ai-insights-ad-analysis-list.json")
                ),
                "/api/v1/ai-insights/46": .json(200, detailBody),
            ])
        )
        let (shell, navigation) = makeShell(routeID: AIAdAnalysisView.routeID, model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()

        await waitUntil { navigation.adAnalysisInsights.contentState == .ready }

        let listRequest = try XCTUnwrap(
            StubURLProtocol.log.first { $0.path == "/api/v1/ai-insights" }
        )
        XCTAssertEqual(
            listRequest.header("X-Operator"),
            // `UserContext` 对中文运营名做百分号编码（HTTP 头不能直接放非 ASCII）
            // —— 这里按已知编码值断言，避免为了读那个内部属性多开一个 `@testable` 导入。
            "%E6%B5%8B%E8%AF%95%E7%AE%A1%E7%90%86%E5%91%98"
        )

        navigation.adAnalysisInsights.openInsight(id: 46)
        hosted.pump()
        await waitUntil { navigation.adAnalysisInsights.detailPhase == .loaded }

        let coverage = try XCTUnwrap(
            InsightDimensionCoverage.parse(
                strategyMetadata: navigation.adAnalysisInsights.detail?.strategyMetadata
            )
        )
        XCTAssertEqual(coverage.analyzed.count, 2)
        XCTAssertEqual(coverage.skipped.count, 1)

        hosted.pump()
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0)
    }

    /// 广告分析页的 canonical run 观察：填 run id → 取 detail → 订阅流（真实 SSE 帧）。
    func testAdAnalysisRunObserverFetchesDetailAndStreams() async throws {
        let model = makeSignedInModel(handler: { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/stream") {
                return .stream(200, chunks: [InsightRenderingBodies.runStreamCompleted])
            }
            if path.contains("/insight/runs/") {
                return .json(200, InsightRenderingBodies.runDetailCompleted)
            }
            if path == "/api/v1/projects/manage" {
                return .json(200, InsightRenderingBodies.projects)
            }
            if path == "/api/v1/ai-insights" {
                return .json(200, InsightRenderingBodies.adAnalysisList)
            }
            if path == "/api/v1/ai-insights/schedules" {
                return .json(200, #"{"items":[],"total":0}"#)
            }
            return .json(404, #"{"detail":"unmapped"}"#)
        })
        let (shell, navigation) = makeShell(routeID: AIAdAnalysisView.routeID, model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.adAnalysisInsights.contentState == .ready }

        // 终态 run：detail 已经落终态，因此不会开流（观察入口仍然可达）。
        navigation.adAnalysisRun.setRunIDInput(runID)
        navigation.adAnalysisRun.submit()
        hosted.pump()
        await waitUntil { navigation.adAnalysisRun.detailPhase == .loaded }

        let paths = StubURLProtocol.loggedPaths
        XCTAssertTrue(paths.contains("/api/v1/insight/runs/\(runID)"), "实发：\(paths)")
        let detail = try XCTUnwrap(navigation.adAnalysisRun.detail)
        XCTAssertEqual(detail.status, "completed")
        XCTAssertEqual(navigation.adAnalysisRun.content, detail.content())

        hosted.pump()
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0)
    }

    // MARK: - AI 库存健康页

    /// 「AI → AI 库存健康」经路由表命中：只有 canonical 两条端点；填 run id → detail + 流。
    func testInventoryHealthModuleRendersRunObserver() async throws {
        let model = makeSignedInModel(handler: { request in
            let path = request.url?.path ?? ""
            if path.hasSuffix("/stream") {
                return .stream(200, chunks: [InsightRenderingBodies.runStreamFailed])
            }
            if path.contains("/insight/runs/") {
                return .json(200, InsightRenderingBodies.runDetailFailed)
            }
            return .json(404, #"{"detail":"unmapped"}"#)
        })
        let (shell, navigation) = makeShell(routeID: AIInventoryHealthView.routeID, model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()

        navigation.inventoryRun.setRunIDInput(runID)
        navigation.inventoryRun.submit()
        hosted.pump()
        await waitUntil { navigation.inventoryRun.detailPhase == .loaded }

        XCTAssertTrue(
            StubURLProtocol.loggedPaths.contains("/api/v1/insight/runs/\(runID)"),
            "实发：\(StubURLProtocol.loggedPaths)"
        )
        // 库存域文案表 + 数值口径（`progress_percent` 直通）。
        XCTAssertEqual(navigation.inventoryRun.panel.label, "库存健康分析生成失败")
        XCTAssertEqual(navigation.inventoryRun.detail?.progressPercent, 40)
        XCTAssertEqual(
            navigation.inventoryRun.detailErrorMessage,
            "provider timed out after 60s"
        )

        hosted.pump()
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0)
    }

    /// 未登记的路径不该被请求 —— 三页都只打它们自己那几条端点（防「顺手多拉一个端点」）。
    func testPagesOnlyTouchTheirOwnEndpoints() async throws {
        let model = makeSignedInModel(routes: try insightRoutes())
        let (shell, navigation) = makeShell(routeID: AIInsightsView.routeID, model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.aiInsights.contentState == .ready }

        let expected: Set<String> = [
            "/api/v1/projects/manage",
            "/api/v1/ai-insights",
            "/api/v1/ai-insights/schedules",
        ]
        XCTAssertEqual(Set(StubURLProtocol.loggedPaths), expected, "实际：\(StubURLProtocol.loggedPaths)")
    }

}

/// 渲染用例要用的固定响应体。
///
/// 放在**非隔离**的文件级枚举里（不是 `@MainActor` 测试类的 `static let`）：桩件的
/// responder 是 `@Sendable` 闭包，引用主 actor 隔离的静态属性在 Swift 6 严格并发下直接编译失败。
/// 夹具文本读一次；读不到给空串 —— 让「读夹具失败」先红在位图/请求断言上，而不是在这里。
enum InsightRenderingBodies {
    static let projects = #"""
    [{"id": 1, "name": "铨富", "country": "US", "is_active": true, "sort_order": 1}]
    """#

    static let runStreamCompleted = (try? InsightFixtures.runStreamCompletedText()) ?? ""
    static let runStreamFailed = (try? InsightFixtures.runStreamFailedText()) ?? ""
    static let runDetailCompleted =
        (try? InsightFixtures.text(fileName: "insight-run-detail-completed.json")) ?? ""
    static let runDetailFailed =
        (try? InsightFixtures.text(fileName: "insight-run-detail-failed.json")) ?? ""
    static let adAnalysisList =
        (try? InsightFixtures.text(fileName: "ai-insights-ad-analysis-list.json")) ?? ""

    /// 带 `evolution_metadata` 的明细响应（维度面板的渲染路径）。
    static let detailWithStrategyMetadata = #"""
    {"id": 46, "project_id": 1, "project_name": "铨富", "country": "US",
    "title": "广告分析结论", "insight_type": "ad_analysis",
    "date_range_start": "2026-05-11", "date_range_end": "2026-05-17",
    "status": "completed", "sub_status": null, "error_message": null,
    "created_by": "纪亚伟", "created_at": "2026-05-18T10:00:00+08:00",
    "updated_at": "2026-05-18T10:05:00+08:00",
    "content": "# 广告分析结论\n\n近 7 天花费上升。\n\n```chart\n{\"type\":\"line\"}\n```\n\n建议：收紧预算。\n",
    "strategy_metadata": "{\"evolution_metadata\":{\"dimensions_analyzed\":[{\"dimension_id\":\"spend\",\"name\":\"花费\",\"level\":1,\"signal_strength\":\"strong\"},{\"dimension_id\":\"acos\",\"name\":\"ACOS\",\"level\":1}],\"cross_analyses_performed\":[\"花费 × 转化率\"],\"temporal_analyses_performed\":[\"周环比\"],\"dimensions_skipped\":[{\"dimension_id\":\"bid\",\"name\":\"竞价\",\"reason\":\"数据缺失\"}]}}"}
    """#
}
