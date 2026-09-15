import AppKit
import BelieveBoyKit
import SwiftUI
import XCTest

@testable import BelieveBoyUI

/// 「报表中心 · 上传与分析簇」两页的离屏渲染核对：路由表命中 → 真模块发请求 → 状态机落地 →
/// 界面画出内容。
///
/// 为什么必须离屏渲染：验收里「端点接通、可达」「三态齐备」「识别结果先呈现」在类型层面都
/// 无法成立 —— 卡片、状态矩阵、确认摘要都是只在视图真正挂进窗口后才布局的。这里用与线上
/// 完全一样的装配方式（`AppModel` + `APIClient` + `NavigationStore` + `ShellView`，只把
/// `URLSession` 打桩、响应用真实后端快照），因此「模块确实接上线了」不靠人工检查。
@MainActor
final class ReportRenderingTests: XCTestCase {
    private var scopes: [ModuleTaskScope] = []
    /// 记录每个请求的完整 URL（断言 query 用；`RequestLog` 只有 path）。
    private var urlCapture = URLCapture()

    override func setUp() {
        super.setUp()
        scopes = []
        urlCapture = URLCapture()
    }

    override func tearDown() async throws {
        await cancelScopes(scopes)
        scopes = []
        try await super.tearDown()
    }

    // MARK: - 装配

    /// 已登录的装配：按路径分派真实快照，并把每个请求的 URL 记进 `urlCapture`。
    ///
    /// 用处理器形式而不是 `session(routes:)`：后者只记 path，断言不了 query
    /// （RPA 状态那条的 `report_date` 必须在 query 里）。未登记的路径仍然显式失败，
    /// 避免测试静默打到真实网络。
    private func makeSignedInModel(routes: [String: StubURLProtocol.Response]) -> AppModel {
        let sessionStore = InMemorySessionStore()
        try? sessionStore.saveSession(AuthSession(apiKey: "blf_REPORT", user: .fixtureAdmin))
        let capture = urlCapture
        let session = StubURLProtocol.session { request in
            capture.append(request.url)
            let path = request.url?.path ?? ""
            guard let response = routes[path] else {
                XCTFail("未登记的请求路径：\(path)")
                return .json(500, #"{"detail":"stub: unregistered path \#(path)"}"#)
            }
            return response
        }
        return AppModel(
            sessionStore: sessionStore,
            rememberedLogins: InMemoryRememberedLoginStore(),
            processEnvironment: [:],
            urlSession: session
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

    private static let projectsBody = #"[{"id": 19, "name": "博朗姆", "country": "US", "is_active": true}]"#

    /// 两页共用的真实快照路由（`overrides` 用来替换某一条）。
    private func snapshotRoutes(
        overrides: [String: StubURLProtocol.Response] = [:]
    ) throws -> [String: StubURLProtocol.Response] {
        var routes: [String: StubURLProtocol.Response] = [
            "/api/v1/projects/manage": .json(200, Self.projectsBody),
            "/api/v1/ad-upload/status": .json(
                200,
                try ReportFixtures.text(fileName: "ad-upload-status.json")
            ),
            "/api/v1/rpa-reports/status": .json(
                200,
                try ReportFixtures.text(fileName: "rpa-status.json")
            ),
            "/api/v1/ad-upload/recognize": .json(
                200,
                try ReportFixtures.text(fileName: "ad-upload-recognize.json")
            ),
            "/api/v1/ad-upload/commit": .json(
                200,
                try ReportFixtures.text(fileName: "ad-upload-commit-dry-run.json")
            ),
        ]
        routes.merge(overrides) { _, override in override }
        return routes
    }

    private func makeShell(
        model: AppModel,
        routeID: String,
        reportDate: String? = nil
    ) -> (ShellView, NavigationStore) {
        let navigation = NavigationStore(
            preferences: InMemoryShellPreferencesStore(),
            reportAutomation: reportDate.map { ReportAutomationStore(reportDate: $0) }
                ?? ReportAutomationStore()
        )
        navigation.select(routeID: routeID)
        scopes.append(navigation.tasks)
        return (ShellView(model: model, navigation: navigation), navigation)
    }

    private func temporaryReport(named name: String = "广告推广的商品报告.csv") throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("blf1068-render-\(UUID().uuidString)-\(name)")
        try """
        开始日期,结束日期,广告SKU,广告ASIN,广告活动名称,广告组名称
        2026-09-07,2026-09-07,JDB-10PCS1-4,B0G1SPQL12,夹具广告活动,夹具广告组
        """.write(to: url, atomically: true, encoding: .utf8)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    // MARK: - 产品分析：路由命中 + 首屏

    /// 「报表中心 → 产品分析」经 `ModuleRegistry` 命中真模块：取项目列表 → 取入库状态 →
    /// 画出「本批未搬」的告警与三类报表卡片。
    func testProductAnalysisModuleRendersThroughShellRegistry() async throws {
        let model = makeSignedInModel(routes: try snapshotRoutes())
        let (shell, navigation) = makeShell(
            model: model,
            routeID: ProductAnalysisView.routeID
        )
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()

        await waitUntil {
            navigation.productAnalysis.projectGate == .ready
                && navigation.productAnalysis.statusesPhase == .loaded
        }

        let paths = StubURLProtocol.loggedPaths
        XCTAssertTrue(paths.contains("/api/v1/projects/manage"), "实发：\(paths)")
        XCTAssertTrue(paths.contains("/api/v1/ad-upload/status"), "实发：\(paths)")
        XCTAssertEqual(navigation.productAnalysis.statuses.count, 50, "真实快照的一条不落")
        XCTAssertEqual(navigation.productAnalysis.projectName, "博朗姆")

        hosted.pump()
        let bitmap = try hosted.bitmap()
        XCTAssertGreaterThan(opaqueSampleCount(bitmap), 0, "模块要真的画出来")
        XCTAssertTrue(
            warningNoticeIsPainted(bitmap),
            "「业务 / 付款报告本批未搬」与「还没有识别结果」两条告警必须画在界面上"
        )
    }

    /// 识别 → 确认 → 提交走**真实客户端**（multipart 真发、commit 真发），且确认之前没有写请求。
    func testProductAnalysisRecognitionAndConfirmedCommitThroughRealClient() async throws {
        let model = makeSignedInModel(routes: try snapshotRoutes())
        let (shell, navigation) = makeShell(
            model: model,
            routeID: ProductAnalysisView.routeID
        )
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.productAnalysis.projectGate == .ready }

        let store = navigation.productAnalysis
        let provider = try XCTUnwrap(model.productAnalysisProvider())
        let file = try temporaryReport()

        await store.recognizeFiles(
            [file],
            using: provider,
            scope: navigation.tasks,
            routeID: ProductAnalysisView.routeID
        )
        hosted.pump()

        // 识别阶段：只有 recognize，没有任何 commit。
        XCTAssertEqual(StubURLProtocol.callCount("/api/v1/ad-upload/recognize"), 1)
        XCTAssertEqual(StubURLProtocol.callCount("/api/v1/ad-upload/commit"), 0, "确认之前不能写")
        let recognizeLog = try XCTUnwrap(
            StubURLProtocol.log.last { $0.path == "/api/v1/ad-upload/recognize" }
        )
        XCTAssertEqual(recognizeLog.method, "POST")
        XCTAssertTrue(
            (recognizeLog.header("Content-Type") ?? "").hasPrefix("multipart/form-data; boundary="),
            "实际：\(recognizeLog.header("Content-Type") ?? "nil")"
        )
        XCTAssertTrue(recognizeLog.body?.contains("name=\"file\"") ?? false)
        XCTAssertNotNil(store.recognition(for: "ad_promoted_product_report"))

        // 二次确认：先生成摘要，再确认。
        store.requestCommit(reportType: "ad_promoted_product_report")
        hosted.pump()
        let confirmation = try XCTUnwrap(store.pendingConfirmation)
        XCTAssertTrue(confirmation.summary.joined().contains("dry_run"))
        XCTAssertEqual(StubURLProtocol.callCount("/api/v1/ad-upload/commit"), 0)

        await store.confirmPendingCommit(
            using: provider,
            scope: navigation.tasks,
            routeID: ProductAnalysisView.routeID
        )
        hosted.pump()

        XCTAssertEqual(StubURLProtocol.callCount("/api/v1/ad-upload/commit"), 1)
        XCTAssertTrue(store.isCommitted("ad_promoted_product_report"))
        let committed = try ReportFixtures.commitResult()
        XCTAssertEqual(
            store.form.adReportFileID,
            committed.fileID,
            "带入的是**后端返回的** file_id，不是客户端自己编的"
        )
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0)
    }

    /// 识别失败（真实 400）→ 界面画出一条失败告警，且**没有**写请求。
    func testRecognitionFailurePaintsFailureNoticeAndWritesNothing() async throws {
        let envelope = try ReportFixtures.errorEnvelope(
            fileName: "ad-upload-recognize-unknown-headers.json"
        )
        let model = makeSignedInModel(routes: try snapshotRoutes(overrides: [
            "/api/v1/ad-upload/recognize": .json(
                envelope.status,
                #"{"detail":"\#(envelope.detail)"}"#
            ),
        ]))
        let (shell, navigation) = makeShell(model: model, routeID: ProductAnalysisView.routeID)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.productAnalysis.projectGate == .ready }

        let store = navigation.productAnalysis
        let provider = try XCTUnwrap(model.productAnalysisProvider())
        await store.recognizeFiles(
            [try temporaryReport(named: "随便一个报表.csv")],
            using: provider,
            scope: navigation.tasks,
            routeID: ProductAnalysisView.routeID
        )
        hosted.pump()

        XCTAssertEqual(
            store.items.first?.recognition,
            .failed("后端返回 HTTP 400：{\"detail\":\"\(envelope.detail)\"}")
        )
        XCTAssertEqual(StubURLProtocol.callCount("/api/v1/ad-upload/commit"), 0)
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0)
    }

    /// 未登录：一条请求都不发。
    func testSignedOutProductAnalysisIssuesNoRequests() async throws {
        let model = makeSignedOutModel()
        let navigation = NavigationStore(preferences: InMemoryShellPreferencesStore())
        scopes.append(navigation.tasks)
        let hosted = HostedView(
            view: ProductAnalysisView(model: model, navigation: navigation),
            size: NSSize(width: 1100, height: 700)
        )
        hosted.pump()
        await waitUntil {
            if case .failed = navigation.productAnalysis.projectGate { return true }
            return false
        }

        XCTAssertTrue(
            loggedPaths(since: 0).isEmpty,
            "未登录不得发请求，实发：\(StubURLProtocol.loggedPaths)"
        )
        hosted.pump()
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0)
    }

    // MARK: - 报表自动化：路由命中 + 状态矩阵

    /// 「报表中心 → 报表自动化」命中真模块：取 RPA 状态 → 画出 10 × 15 的状态矩阵。
    func testReportAutomationModuleRendersGridThroughShellRegistry() async throws {
        let model = makeSignedInModel(routes: try snapshotRoutes())
        // 固定到夹具那一天：页面默认取「本机今天」，而夹具是 2026-09-14 —— 不注入日期的话
        // 这条断言会随跑测试的那天飘。
        let (shell, navigation) = makeShell(
            model: model,
            routeID: ReportAutomationView.routeID,
            reportDate: "2026-09-14"
        )
        let hosted = HostedView(view: shell, size: NSSize(width: 1400, height: 900))
        hosted.pump()

        await waitUntil { navigation.reportAutomation.contentState == .ready }

        let request = try XCTUnwrap(StubURLProtocol.log.first { $0.path == "/api/v1/rpa-reports/status" })
        XCTAssertEqual(request.method, "GET")
        XCTAssertEqual(request.timeout, 15, "状态矩阵走统计档 15s")
        let query = try XCTUnwrap(urlCapture.query(forPath: "/api/v1/rpa-reports/status"))
        XCTAssertTrue(query.contains("report_date=2026-09-14"), "必须带报表日期（后端 Query 必填）：\(query)")
        XCTAssertTrue(query.contains("country=US"), query)
        XCTAssertEqual(navigation.reportAutomation.rows.count, 10)
        XCTAssertEqual(navigation.reportAutomation.completeness.text, "133/150")
        XCTAssertFalse(
            StubURLProtocol.loggedPaths.contains("/api/v1/projects/manage"),
            "进页不预拉项目列表（打开筛选下拉才拉）"
        )

        hosted.pump()
        let bitmap = try hosted.bitmap()
        XCTAssertGreaterThan(opaqueSampleCount(bitmap), 0, "状态矩阵要真的画出来")
    }

    /// 当天没有数据 → 画出显式空态（不是错误页、也不是永远转圈）。
    func testReportAutomationEmptyStatePaintsMessage() async throws {
        let model = makeSignedInModel(routes: try snapshotRoutes(overrides: [
            "/api/v1/rpa-reports/status": .json(200, #"{"country": "US", "items": []}"#),
        ]))
        let (shell, navigation) = makeShell(model: model, routeID: ReportAutomationView.routeID)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()

        await waitUntil { navigation.reportAutomation.contentState == .empty }
        hosted.pump()
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0)
    }

    /// 刷新失败：旧表留在界面上，同时画出一条「仍是上一次的数据」提示。
    func testReportAutomationRefreshFailureKeepsTableAndPaintsNotice() async throws {
        let model = makeSignedInModel(routes: try snapshotRoutes())
        let (shell, navigation) = makeShell(model: model, routeID: ReportAutomationView.routeID)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.reportAutomation.contentState == .ready }

        StubURLProtocol.responder = { request in
            if request.url?.path == "/api/v1/rpa-reports/status" {
                return .json(500, #"{"detail":"boom"}"#)
            }
            return .json(200, "{}")
        }
        navigation.reportAutomation.requestRefresh()
        hosted.pump()
        await waitUntil { navigation.reportAutomation.refreshFailure != nil }

        XCTAssertEqual(navigation.reportAutomation.rows.count, 10, "刷新失败保留旧表")
        hosted.pump()
        let bitmap = try hosted.bitmap()
        XCTAssertGreaterThan(opaqueSampleCount(bitmap), 0)
        XCTAssertTrue(warningNoticeIsPainted(bitmap), "「仍是上一次的数据」的黄色提示必须画出来")
    }

    // MARK: - 切模块不泄漏 Task

    /// 切走再切回：外壳按 route id 取消在跑任务，且状态保留（不重新加载）。
    func testSwitchingModuleCancelsTasksAndKeepsState() async throws {
        let model = makeSignedInModel(routes: try snapshotRoutes())
        let (shell, navigation) = makeShell(model: model, routeID: ReportAutomationView.routeID)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.reportAutomation.contentState == .ready }
        let rowsBefore = navigation.reportAutomation.rows.count

        navigation.select(routeID: "/dashboard/reports/monthly-report/display")
        hosted.pump()
        await waitUntil { navigation.tasks.isEmpty }
        XCTAssertTrue(navigation.tasks.isEmpty, "切模块后不留任务：\(navigation.tasks.activeKeys)")

        navigation.select(routeID: ReportAutomationView.routeID)
        hosted.pump()
        XCTAssertEqual(
            navigation.reportAutomation.rows.count,
            rowsBefore,
            "切回来看到的是同一份状态，不是空表"
        )
    }
}
