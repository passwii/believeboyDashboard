import AppKit
import BelieveBoyKit
import SwiftUI
import XCTest

@testable import BelieveBoyUI

/// 「广告分析」页的离屏渲染核对：路由表命中 → 真模块发请求 → 状态机落地 → 界面画出内容。
///
/// 为什么必须离屏渲染：验收 1「10 个 Tab 各自可达」在类型层面无法成立 —— Tab 栏、筛选条、
/// 明细网格都是 `ScrollView` / `LazyVStack` / `Chart`，只在视图真正挂进窗口后才布局。
/// 这里用与线上完全一样的装配方式（`AppModel` + `APIClient` + `NavigationStore` +
/// `ShellView`，只把 `URLSession` 打桩、快照用真实后端响应），因此「模块确实接上线了」
/// 不靠人工检查。
@MainActor
final class AdAnalysisRenderingTests: XCTestCase {
    // MARK: - 装配

    private func makeSignedInModel(routes: [String: StubURLProtocol.Response]) -> AppModel {
        let sessionStore = InMemorySessionStore()
        try? sessionStore.saveSession(AuthSession(apiKey: "blf_AD", user: .fixtureAdmin))
        let session = StubURLProtocol.session(routes: routes)
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

    /// 10 个端点的真实快照 + 项目列表，全部登记成打桩路由（`overrides` 用来替换某一条）。
    private func snapshotRoutes(
        overrides: [String: StubURLProtocol.Response] = [:]
    ) throws -> [String: StubURLProtocol.Response] {
        var routes: [String: StubURLProtocol.Response] = [
            "/api/v1/projects/manage": .json(200, Self.projectsBody),
        ]
        for tab in AdAnalysisCatalog.tabs {
            routes["/api/v1" + tab.endpoint] = .json(
                200,
                try AdAnalysisFixtures.text(
                    fileName: try AdAnalysisFixtures.fullHistoryFile(forTabKey: tab.key).file
                )
            )
        }
        routes.merge(overrides) { _, override in override }
        return routes
    }

    private static let projectsBody = #"""
    [{"id": 1, "name": "铨富", "country": "US", "is_active": true, "sort_order": 1}]
    """#

    /// 常驻离屏宿主：**视图必须在等待期间一直活着** —— `NSHostingView` 一释放，视图的
    /// `.task` 就被取消，加载永远到不了「已就绪」（S4 踩过的坑，PLAN §3 ③）。
    /// `@MainActor`：AppKit 的布局 / 取位图都在主 actor 上，非隔离方法会被严格并发拒绝。
    @MainActor
    private final class HostedView {
        private let window: NSWindow
        private let hosting: NSHostingView<AnyView>

        init(view: some View, size: NSSize) {
            hosting = NSHostingView(rootView: AnyView(view))
            hosting.frame = NSRect(origin: .zero, size: size)
            window = NSWindow(
                contentRect: hosting.frame,
                styleMask: [.titled, .resizable],
                backing: .buffered,
                defer: false
            )
            window.isReleasedWhenClosed = false
            window.contentView = hosting
            window.layoutIfNeeded()
            hosting.layoutSubtreeIfNeeded()
        }

        func pump(_ seconds: TimeInterval = 0.2) {
            RunLoop.current.run(until: Date().addingTimeInterval(seconds))
            hosting.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
        }

        func bitmap() throws -> NSBitmapImageRep {
            hosting.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            let bounds = hosting.bounds
            let rep = try XCTUnwrap(
                hosting.bitmapImageRepForCachingDisplay(in: bounds),
                "离屏渲染应能拿到位图"
            )
            hosting.cacheDisplay(in: bounds, to: rep)
            return rep
        }
    }

    /// 空态提示（`NoticeRow(.warning)`）是否**真的被画到了位图上**。
    ///
    /// 判据是该提示条的两件固定特征，二者都要满足：
    /// ① 橙色提示底 —— 横向铺满内容区（`NoticeRow` 的 `Spacer` 把它撑宽）的橙色条带；
    /// ② 条带里真的有文案 —— 近似中性色的字形像素（见 `isNoticeText`）。
    ///
    /// 只查橙色不够（页面别处也可能出现暖色），所以加 ②；而 ② 不能拿「与页面底色对比」
    /// 来判 —— 离屏宿主没有窗口背景，`cacheDisplay` 出来的底色是**透明**的。
    ///
    /// 为什么不查辅助功能树：无头进程里 `NSHostingView.accessibilityChildren()` 返回空
    /// （实测 `count = 0`），拿不到文本，只能退到位图结构。
    private func warningNoticeIsPainted(_ rep: NSBitmapImageRep) -> Bool {
        // 2× 屏下 1280×800 的窗口约 2560×1664 像素，隔 4 采样。
        let stepX = max(1, rep.pixelsWide / 640)
        let stepY = max(1, rep.pixelsHigh / 400)

        var minX = Int.max, maxX = Int.min, minY = Int.max, maxY = Int.min
        for x in stride(from: 0, to: rep.pixelsWide, by: stepX) {
            for y in stride(from: 0, to: rep.pixelsHigh, by: stepY) {
                guard let color = rep.colorAt(x: x, y: y), Self.isWarningOrange(color) else { continue }
                minX = min(minX, x)
                maxX = max(maxX, x)
                minY = min(minY, y)
                maxY = max(maxY, y)
            }
        }
        // 提示条要成「条」：横向铺开、且有高度（不是 1px 描边、也不是一个小图标）。
        guard minX <= maxX, minY <= maxY, maxX - minX > 300, maxY - minY > 20 else { return false }

        var textXs: [Int] = []
        for x in stride(from: minX, through: maxX, by: stepX) {
            for y in stride(from: minY, through: maxY, by: stepY) {
                guard let color = rep.colorAt(x: x, y: y) else { continue }
                if Self.isNoticeText(color) {
                    textXs.append(x)
                }
            }
        }
        guard let leftmost = textXs.min(), let rightmost = textXs.max() else { return false }
        return rightmost - leftmost > 100
    }

    /// 饱和橙：系统橙 `#FF9500`（浅色）/ `#FF9F0A`（深色）都命中，蓝色强调色与红色横幅都不命中。
    private static func isWarningOrange(_ color: NSColor) -> Bool {
        let red = color.redComponent
        let green = color.greenComponent
        let blue = color.blueComponent
        return red > 0.5 && red - blue > 0.25 && red >= green && green > blue
    }

    /// 提示条里的文案像素：近似中性色（浅色外观的黑字 / 深色外观的白字）。
    ///
    /// 用「中性」而不是「与底色对比高」：离屏位图没有窗口背景（提示底的橙色是半透明、
    /// `colorAt` 会把它的颜色解到饱和橙），所以底色对比量不出来；而橙色底与橙色图标
    /// 天然高饱和，中性的字形像素只可能来自文案本身。
    private static func isNoticeText(_ color: NSColor) -> Bool {
        let channels = [color.redComponent, color.greenComponent, color.blueComponent]
        return (channels.max() ?? 0) - (channels.min() ?? 0) < 0.12
    }

    private func opaqueSampleCount(_ rep: NSBitmapImageRep) -> Int {
        let stepX = max(1, rep.pixelsWide / 40)
        let stepY = max(1, rep.pixelsHigh / 40)
        var count = 0
        for x in stride(from: 0, to: rep.pixelsWide, by: stepX) {
            for y in stride(from: 0, to: rep.pixelsHigh, by: stepY) {
                if let color = rep.colorAt(x: x, y: y), color.alphaComponent > 0.01 {
                    count += 1
                }
            }
        }
        return count
    }

    private func waitUntil(
        timeout: TimeInterval = 5,
        _ condition: () -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
        XCTFail("等待条件超时（\(timeout)s）")
    }

    private func makeShell(
        model: AppModel
    ) -> (ShellView, NavigationStore) {
        let navigation = NavigationStore(preferences: InMemoryShellPreferencesStore())
        navigation.select(routeID: AdAnalysisCatalog.routeID)
        scopes.append(navigation.tasks)
        return (ShellView(model: model, navigation: navigation), navigation)
    }

    // MARK: - 测试卫生

    /// 本用例创建过的任务作用域。
    ///
    /// 结束统一取消：`NSHostingView` 一释放，视图的 `.task` 就取消，但**已经登记进
    /// `ModuleTaskScope` 的非结构化任务不会跟着死** —— 残留的加载会跑到下一个用例的
    /// 打桩日志里，把「本页零请求」这类断言变成随机失败（本次实测踩到）。
    private var scopes: [ModuleTaskScope] = []

    override func setUp() {
        super.setUp()
        scopes = []
    }

    override func tearDown() async throws {
        for scope in scopes { scope.cancelAll() }
        try? await Task.sleep(nanoseconds: 30_000_000)
        scopes = []
        try await super.tearDown()
    }

    /// 记录当前打桩日志长度，用来断言「之后没有新增请求」（不依赖全局日志从头干净）。
    private func logBaseline() -> Int { StubURLProtocol.log.count }

    private func loggedPaths(since baseline: Int) -> [String] {
        Array(StubURLProtocol.loggedPaths.dropFirst(baseline))
    }

    // MARK: - 路由表命中 + 首屏

    /// 「广告 → 广告分析」经 `ModuleRegistry` 命中真模块：取项目列表 → 取总览 → 渲染出内容。
    func testAdAnalysisModuleRendersThroughShellRegistry() async throws {
        let model = makeSignedInModel(routes: try snapshotRoutes())
        let (shell, navigation) = makeShell(model: model)
        XCTAssertEqual(navigation.selectedItem?.title, "广告分析")

        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.adAnalysis.contentState == .ready }

        XCTAssertEqual(
            StubURLProtocol.loggedPaths,
            ["/api/v1/projects/manage", "/api/v1/ad-analysis/overview"],
            "进页应只发「项目列表 + 当前 Tab」两次请求"
        )
        XCTAssertEqual(navigation.adAnalysis.selectedTabKey, "overview")
        XCTAssertEqual(navigation.adAnalysis.detailRows.count, 27, "总览明细 = 5+5+5+7+5")

        hosted.pump()
        XCTAssertGreaterThan(
            opaqueSampleCount(try hosted.bitmap()),
            0,
            "有数据的广告分析页应渲染出内容"
        )
        await waitUntil { navigation.tasks.isEmpty }
        XCTAssertTrue(navigation.tasks.isEmpty, "加载结束后模块任务作用域应为空")
    }

    /// 验收 1：10 个 Tab **各自可达** —— 逐个切换，各自发起自己的端点请求并渲染出内容。
    func testEveryTabIsReachableAndRenders() async throws {
        let model = makeSignedInModel(routes: try snapshotRoutes())
        let (shell, navigation) = makeShell(model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.adAnalysis.contentState == .ready }

        for tab in AdAnalysisCatalog.tabs {
            navigation.adAnalysis.selectTab(key: tab.key)
            // 切 Tab 后视图的 `.task(id:)` 会重跑（id = LoadKey，含 tabKey）。
            await waitUntil { navigation.adAnalysis.selectedTabKey == tab.key }
            await waitUntil {
                navigation.adAnalysis.selectedTabState.phase == .loaded
                    && !navigation.adAnalysis.detailRows.isEmpty
            }
            hosted.pump()
            XCTAssertGreaterThan(
                opaqueSampleCount(try hosted.bitmap()),
                0,
                "\(tab.key) 应渲染出内容"
            )
            XCTAssertEqual(
                StubURLProtocol.callCount("/api/v1" + tab.endpoint),
                1,
                "\(tab.key) 应恰好请求一次自己的端点"
            )
        }

        // 10 个端点各一次（总览在进页时已经取过 → 仍是 1 次），项目列表只取一次。
        for tab in AdAnalysisCatalog.tabs {
            XCTAssertEqual(
                StubURLProtocol.callCount("/api/v1" + tab.endpoint),
                1,
                "\(tab.endpoint) 只应被消费一次"
            )
        }
        XCTAssertEqual(StubURLProtocol.callCount("/api/v1/projects/manage"), 1)
    }

    /// 切走再切回：不重置筛选、不重复请求（状态住在外壳的 store 里）。
    func testSwitchingTabsKeepsFiltersAndCachesPayloads() async throws {
        let model = makeSignedInModel(routes: try snapshotRoutes())
        let (shell, navigation) = makeShell(model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.adAnalysis.contentState == .ready }

        navigation.adAnalysis.setCountry("DE")
        await waitUntil { navigation.adAnalysis.selectedTabState.loadedAt != nil && navigation.adAnalysis.filters.country == "DE" }
        let countryAfterLoad = navigation.adAnalysis.filters.country

        navigation.adAnalysis.selectTab(key: "products")
        await waitUntil { navigation.adAnalysis.selectedTabKey == "products" }
        await waitUntil { navigation.adAnalysis.state(forTabKey: "products").phase == .loaded }

        navigation.adAnalysis.selectTab(key: "overview")
        hosted.pump()
        await waitUntil { navigation.adAnalysis.selectedTabKey == "overview" }

        XCTAssertEqual(navigation.adAnalysis.filters.country, countryAfterLoad, "切 Tab 不重置筛选")
        XCTAssertEqual(
            StubURLProtocol.callCount("/api/v1/ad-analysis/overview"),
            1,
            "切回来不该再请求一次（同一组筛选已加载）"
        )
    }

    // MARK: - 三态渲染

    /// 空态：项目有、报表没有 → 显示「无数据」提示而不是空白或 0。
    ///
    /// 两层断言分别挡住两类回归：
    /// ① 文案口径 —— `AdAnalysisTabContentTests` 逐 Tab 钉住「空态 → 提示文本」；
    /// ② 真的画出来了 —— 下面这次位图核对。② 不能只看「像素非零」：首版的 `.empty`
    /// 被外层 `EmptyView()` 吃掉后位图同样非零（页头 / 筛选条 / Tab 栏一直在画），
    /// 所以那条旧断言挡不住它，必须换成本用例的「警告图标 + 紧邻文案」结构判据。
    func testEmptyStateRendersNotice() async throws {
        let routes = try snapshotRoutes(overrides: [
            "/api/v1/ad-analysis/overview": .json(
                200,
                #"{"project_id":1,"country":"US","metrics":[],"issue_cards":[],"narrative_sections":[],"top_campaigns":[],"top_products":[],"top_waste_terms":[],"trend_summary":[],"top_cross_sell_products":[]}"#
            ),
        ])
        let model = makeSignedInModel(routes: routes)
        let (shell, navigation) = makeShell(model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.adAnalysis.contentState == .empty }

        hosted.pump()
        let bitmap = try hosted.bitmap()
        XCTAssertGreaterThan(opaqueSampleCount(bitmap), 0, "空态也要画出提示")
        XCTAssertTrue(
            warningNoticeIsPainted(bitmap),
            "空态必须画出「无数据」警告提示（橙色图标 + 紧跟的文案），而不是一片空白"
        )
    }

    /// 错误态：后端 500 → 失败横幅 + 重试按钮（可再渲染一次）。
    func testFailureStateRendersAndRetryRefetches() async throws {
        let routes = try snapshotRoutes(overrides: [
            "/api/v1/ad-analysis/overview": .json(500, #"{"detail":"boom"}"#),
        ])
        let model = makeSignedInModel(routes: routes)
        let (shell, navigation) = makeShell(model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil {
            if case .failed = navigation.adAnalysis.contentState { return true }
            return false
        }
        XCTAssertNotNil(navigation.adAnalysis.failureMessage)

        hosted.pump()
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0, "错误态要画出横幅")

        // 重试：换成成功响应 → 刷新票号驱动重新加载。
        StubURLProtocol.responder = { request in
            let path = request.url?.path ?? ""
            if path == "/api/v1/ad-analysis/overview" {
                return .json(200, (try? AdAnalysisFixtures.text(fileName: "ad-analysis-overview.json")) ?? "{}")
            }
            return routes[path] ?? .json(500, "stub: unregistered path")
        }
        navigation.adAnalysis.requestRefresh()
        await waitUntil { navigation.adAnalysis.contentState == .ready }
        XCTAssertEqual(navigation.adAnalysis.detailRows.count, 27)
    }

    /// 没有可见项目的账号：闸门提示（且不发任何明细请求）。
    func testNoVisibleProjectsRendersGate() async throws {
        let routes = try snapshotRoutes(overrides: ["/api/v1/projects/manage": .json(200, "[]")])
        let model = makeSignedInModel(routes: routes)
        let (shell, navigation) = makeShell(model: model)
        let hosted = HostedView(view: shell, size: NSSize(width: 1280, height: 800))
        hosted.pump()
        await waitUntil { navigation.adAnalysis.projectGate == .noProjects }

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
            view: AdAnalysisView(model: model, navigation: navigation),
            size: NSSize(width: 1100, height: 700)
        )
        hosted.pump()
        await waitUntil {
            if case .failed = navigation.adAnalysis.projectGate { return true }
            return false
        }

        XCTAssertTrue(
            loggedPaths(since: 0).isEmpty,
            "未登录不得发请求，实发：\(StubURLProtocol.loggedPaths)"
        )
        hosted.pump()
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0)
    }

    /// 删掉已搬运模块后仍走占位：换一个**未搬运**的广告分组条目，零请求（回归保护）。
    func testUnmigratedAdvertisingItemStillUsesPlaceholder() throws {
        let model = makeSignedInModel(routes: try snapshotRoutes())
        let navigation = NavigationStore(preferences: InMemoryShellPreferencesStore())
        scopes.append(navigation.tasks)
        navigation.select(routeID: "/dashboard/advertising/ad-data")
        XCTAssertEqual(navigation.selectedItem?.title, "广告数据")

        // 基线取在挂宿主**之前**：上一个用例残留的任务可能刚落了一条日志，
        // 这里只关心「本页开始渲染之后有没有新增请求」。
        let baseline = logBaseline()
        let hosted = HostedView(
            view: ShellView(model: model, navigation: navigation),
            size: NSSize(width: 1280, height: 800)
        )
        hosted.pump()

        XCTAssertTrue(
            loggedPaths(since: baseline).isEmpty,
            "「广告数据」还没搬运，不得发请求，实发：\(loggedPaths(since: baseline))"
        )
        XCTAssertGreaterThan(opaqueSampleCount(try hosted.bitmap()), 0)
    }
}
