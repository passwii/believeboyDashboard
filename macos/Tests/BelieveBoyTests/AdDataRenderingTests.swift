import AppKit
import BelieveBoyKit
import SwiftUI
import XCTest

@testable import BelieveBoyUI

/// 「广告数据」页的离屏渲染核对：路由表命中 → 真模块发请求 → 状态机落地 → 界面画出内容。
///
/// 为什么必须离屏渲染：验收「11 个端点全部接通、可达」在类型层面无法成立 —— 表格、筛选条、
/// 翻页条都是 `ScrollView` / `LazyVStack`，只在视图真正挂进窗口后才布局。这里用与线上完全
/// 一样的装配方式（`AppModel` + `APIClient` + `NavigationStore` + `ShellView`，只把
/// `URLSession` 打桩、响应用真实后端快照），因此「模块确实接上线了」不靠人工检查。
@MainActor
final class AdDataRenderingTests: XCTestCase {
    // MARK: - 装配

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

    private func makeSignedInModel(routes: [String: StubURLProtocol.Response]) -> AppModel {
        let sessionStore = InMemorySessionStore()
        try? sessionStore.saveSession(AuthSession(apiKey: "blf_AD_DATA", user: .fixtureAdmin))
        return AppModel(
            sessionStore: sessionStore,
            rememberedLogins: InMemoryRememberedLoginStore(),
            processEnvironment: [:],
            urlSession: StubURLProtocol.session(routes: routes)
        )
    }

    private func makeSignedOutModel() -> AppModel {
        AppModel(
            sessionStore: InMemorySessionStore(),
            rememberedLogins: InMemoryRememberedLoginStore(),
            processEnvironment: [:],
            urlSession: StubURLProtocol.session(routes: [:])
        )
    }

    /// 11 个端点的真实快照 + 项目列表，全部登记成打桩路由（`overrides` 用来替换某一条）。
    private func snapshotRoutes(
        overrides: [String: StubURLProtocol.Response] = [:]
    ) throws -> [String: StubURLProtocol.Response] {
        var routes: [String: StubURLProtocol.Response] = [
            "/api/v1/projects/manage": .json(200, Self.projectsBody),
            "/api/v1" + AdDataCatalog.uploadFilesEndpoint(projectID: 1): .json(
                200,
                try AdDataFixtures.text(fileName: try AdDataFixtures.manifest().uploadFiles.file)
            ),
        ]
        for type in AdDataCatalog.reportTypes {
            routes["/api/v1" + AdDataCatalog.rawEndpoint(projectID: 1, endpoint: type.endpoint)] = .json(
                200,
                try AdDataFixtures.text(fileName: try AdDataFixtures.file(forEndpoint: type.endpoint).file)
            )
        }
        routes.merge(overrides) { _, override in override }
        return routes
    }

    private static let projectsBody = #"""
    [{"id": 1, "name": "铨富", "country": "US", "is_active": true, "sort_order": 1}]
    """#

    private func makeShell(model: AppModel) -> (ShellView, NavigationStore) {
        let navigation = NavigationStore(preferences: InMemoryShellPreferencesStore())
        navigation.select(routeID: AdDataCatalog.routeID)
        scopes.append(navigation.tasks)
        return (ShellView(model: model, navigation: navigation), navigation)
    }

    // MARK: - 路由表命中 + 首屏

    /// 「广告 → 广告数据」经 `ModuleRegistry` 命中真模块：取项目列表 → 取入库文件 → 取默认类型的
    /// 原始行 → 渲染出内容。11 个端点里的三类请求（项目 / upload-files / ad-*-raw）都在日志里。
    func testAdDataModuleRendersThroughShellRegistry() async throws {
        let model = makeSignedInModel(routes: try snapshotRoutes())
        let (shell, navigation) = makeShell(model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()

        await waitUntil { navigation.adData.contentState == .ready }

        let paths = StubURLProtocol.loggedPaths
        XCTAssertTrue(paths.contains("/api/v1/projects/manage"), "实发：\(paths)")
        XCTAssertTrue(paths.contains("/api/v1/internal/ad-data/projects/1/ad-upload-files"), "实发：\(paths)")
        XCTAssertTrue(paths.contains("/api/v1/internal/ad-data/projects/1/ad-campaigns-raw"), "实发：\(paths)")
        XCTAssertEqual(navigation.adData.returnedRowCount, 200, "默认类型「广告活动」的真实快照")
        XCTAssertEqual(navigation.adData.tablePage.rows.count, 100, "口径 5：每页 100 行")

        hosted.pump()
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0, "表格要真的画出来")
    }

    /// 切报表类型 → 打到该类型自己的端点（10 个端点各一条路径），并把新数据画出来。
    func testSwitchingReportTypeFetchesItsOwnEndpoint() async throws {
        let model = makeSignedInModel(routes: try snapshotRoutes())
        let (shell, navigation) = makeShell(model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.adData.contentState == .ready }

        let baseline = logBaseline()
        navigation.adData.selectReportType(code: "ad_time_trend_report")
        hosted.pump()
        await waitUntil {
            navigation.adData.selectedTableState.phase == .loaded
                && navigation.adData.selectedReportTypeCode == "ad_time_trend_report"
        }

        XCTAssertTrue(
            loggedPaths(since: baseline).contains("/api/v1/internal/ad-data/projects/1/ad-time-trends-raw"),
            "实发：\(loggedPaths(since: baseline))"
        )
        XCTAssertEqual(navigation.adData.returnedRowCount, 98)
        XCTAssertEqual(navigation.adData.tablePage.totalPages, 1)
        hosted.pump()
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0)
    }

    /// 搜索框过滤的是已拉取的那一页（客户端行为，不改变后端查询）。
    func testSearchFiltersLocallyWithoutNewRequests() async throws {
        let model = makeSignedInModel(routes: try snapshotRoutes())
        let (shell, navigation) = makeShell(model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.adData.contentState == .ready }
        let rowsBefore = navigation.adData.tablePage.filteredCount

        let baseline = logBaseline()
        navigation.adData.setSearch("Auto-DL18")
        hosted.pump()

        XCTAssertLessThan(navigation.adData.tablePage.filteredCount, rowsBefore)
        XCTAssertTrue(
            loggedPaths(since: baseline).isEmpty,
            "搜索是纯客户端过滤，不该产生请求，实发：\(loggedPaths(since: baseline))"
        )
    }

    // MARK: - 三态渲染

    /// 空态：项目有、该类型没有数据 → 显示「无数据」提示而不是空白或 0 行表格。
    ///
    /// 位图判据（橙色提示条 + 条内文案）挡的是「`.empty` 被外层 `EmptyView()` 吃掉」那类回归
    /// —— 那种情况下位图同样非零（页头 / 筛选条一直在画）。
    func testEmptyStateRendersNotice() async throws {
        let routes = try snapshotRoutes(overrides: [
            "/api/v1/internal/ad-data/projects/1/ad-campaigns-raw": .json(
                200,
                #"{"project_id":1,"country":"US","period":{"type":"custom","value":"custom","start_date":"2000-01-01","end_date":"2100-12-31"},"data":[],"summary":{"total_rows":0,"date_range":["2000-01-01","2100-12-31"]}}"#
            ),
        ])
        let model = makeSignedInModel(routes: routes)
        let (shell, navigation) = makeShell(model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.adData.contentState == .empty }

        hosted.pump()
        let bitmap = try hosted.bitmap()
        XCTAssertGreaterThan(opaqueSampleCount(bitmap), 0, "空态也要画出提示")
        XCTAssertTrue(
            warningNoticeIsPainted(bitmap),
            "空态必须画出「无数据」警告提示，而不是一片空白"
        )
    }

    /// 错误态：后端 500 → 失败横幅 + 重试；换成成功响应后重试能恢复。
    func testFailureStateRendersAndRetryRefetches() async throws {
        let routes = try snapshotRoutes(overrides: [
            "/api/v1/internal/ad-data/projects/1/ad-campaigns-raw": .json(500, #"{"detail":"boom"}"#),
        ])
        let model = makeSignedInModel(routes: routes)
        let (shell, navigation) = makeShell(model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil {
            if case .failed = navigation.adData.contentState { return true }
            return false
        }
        XCTAssertNotNil(navigation.adData.failureMessage)

        hosted.pump()
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0, "错误态要画出横幅")

        // 重试：换成成功响应 → 刷新票号驱动重新加载。
        let snapshot = try AdDataFixtures.text(
            fileName: try AdDataFixtures.file(forEndpoint: "campaigns").file
        )
        StubURLProtocol.responder = { request in
            let path = request.url?.path ?? ""
            if path == "/api/v1/internal/ad-data/projects/1/ad-campaigns-raw" {
                return .json(200, snapshot)
            }
            return routes[path] ?? .json(500, "stub: unregistered path \(path)")
        }
        navigation.adData.requestRefresh()
        await waitUntil { navigation.adData.contentState == .ready }

        XCTAssertEqual(navigation.adData.returnedRowCount, 200)
    }

    /// **口径 5**：`data.count == limit` 时页面必须给出「可能被截断」的可见提示。
    func testTruncationNoticeIsPaintedWhenLimitIsReached() async throws {
        let rows = (0..<AdDataCatalog.pageLimit)
            .map { #"{"id":\#($0),"campaign_name":"C\#($0)","spend":1.0}"# }
            .joined(separator: ",")
        let body = #"{"project_id":1,"country":"US","data":[\#(rows)],"summary":{"total_rows":\#(AdDataCatalog.pageLimit),"date_range":["2000-01-01","2100-12-31"]}}"#
        let routes = try snapshotRoutes(overrides: [
            "/api/v1/internal/ad-data/projects/1/ad-campaigns-raw": .json(200, body),
        ])
        let model = makeSignedInModel(routes: routes)
        let (shell, navigation) = makeShell(model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.adData.contentState == .ready }

        XCTAssertTrue(navigation.adData.isTruncated, "顶到 10000 行 → 可能被截断")
        hosted.pump()
        XCTAssertTrue(
            warningNoticeIsPainted(try hosted.bitmap()),
            "截断提示必须是画出来的警告条，不能只在状态里"
        )
    }

    /// 没有可见项目的账号：闸门提示（且不发原始行请求）。
    func testNoVisibleProjectsRendersGate() async throws {
        let routes = try snapshotRoutes(overrides: ["/api/v1/projects/manage": .json(200, "[]")])
        let model = makeSignedInModel(routes: routes)
        let (shell, navigation) = makeShell(model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.adData.projectGate == .noProjects }

        XCTAssertEqual(StubURLProtocol.loggedPaths, ["/api/v1/projects/manage"])
        hosted.pump()
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0)
    }

    /// 未登录：一条请求都不发（凭据缺失由 `AppModel.makeAPIClient()` 提前拦掉）。
    func testSignedOutPageIssuesNoRequests() async throws {
        let model = makeSignedOutModel()
        let navigation = NavigationStore(preferences: InMemoryShellPreferencesStore())
        scopes.append(navigation.tasks)
        let hosted = HostedView(
            view: AdDataView(model: model, navigation: navigation),
            size: NSSize(width: 1100, height: 700)
        )
        hosted.pump()
        await waitUntil {
            if case .failed = navigation.adData.projectGate { return true }
            return false
        }

        XCTAssertTrue(
            loggedPaths(since: 0).isEmpty,
            "未登录不得发请求，实发：\(StubURLProtocol.loggedPaths)"
        )
        hosted.pump()
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0)
    }

    /// 切模块：外壳按 route id 取消在跑任务，回来时任务作用域是干净的（验收 4：不泄漏 Task）。
    func testSwitchingModuleCancelsRunningTasks() async throws {
        let model = makeSignedInModel(routes: try snapshotRoutes())
        let (shell, navigation) = makeShell(model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()

        navigation.select(routeID: "/dashboard/reports/monthly-report/display")
        hosted.pump()
        await waitUntil { navigation.tasks.isEmpty }

        XCTAssertTrue(navigation.tasks.isEmpty, "切走后不该有残留任务")
        XCTAssertEqual(navigation.adData.selectedReportTypeCode, AdDataCatalog.defaultReportTypeCode)
    }
}
