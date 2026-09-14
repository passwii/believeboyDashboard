import AppKit
import BelieveBoyKit
import SwiftUI
import XCTest

@testable import BelieveBoyUI

/// `ShellView` 的离屏渲染核对 —— 三栏外壳真的能布局出来（不是只在类型层面成立），
/// 且占位视图**一个请求都不发**（验收 2 的静态一半：没有可泄漏的请求）。
///
/// 离屏渲染的必要性：`NavigationSplitView` 的列布局、`List` 的选择高亮都发生在视图
/// 真正挂进窗口之后，纯状态断言覆盖不到「壳子到底画没画出来」。
@MainActor
final class ShellRenderingTests: XCTestCase {
    private func makeSignedInModel(routes: [String: StubURLProtocol.Response]) -> AppModel {
        let sessionStore = InMemorySessionStore()
        try? sessionStore.saveSession(AuthSession(apiKey: "blf_SHELL", user: .fixtureAdmin))
        let session = StubURLProtocol.session(routes: routes)
        return AppModel(
            sessionStore: sessionStore,
            rememberedLogins: InMemoryRememberedLoginStore(),
            processEnvironment: [:],
            urlSession: session
        )
    }

    private var healthRoutes: [String: StubURLProtocol.Response] {
        [
            "/api/v1/health/live": .json(200, #"{"status":"ok","timestamp":1}"#),
            "/api/v1/health": .json(
                200,
                #"{"status":"ok","timestamp":1.0,"database":"ok","database_replica":"not configured",\#n"redis":"ok (1.2ms)","redis_memory":"2.07M","version":"production"}"#
            ),
        ]
    }

    private func makeSignedInModel() -> AppModel {
        makeSignedInModel(routes: healthRoutes)
    }

    /// 「数据流总览」（S4）四个数据源的打桩路由 —— 用真实响应快照，故请求形状与解码
    /// 都在同一条与被测代码一致的路径上跑通。
    private var overviewRoutes: [String: StubURLProtocol.Response] {
        [
            "/api/v1/agent-ops/domain-summary": .json(200, AgentOpsFixtures.domainSummary),
            "/api/v1/complaints/overview": .json(200, AgentOpsFixtures.complaintsWithoutRun),
            "/api/v1/inspections/periods/current": .json(200, AgentOpsFixtures.currentInspectionPeriod),
            "/api/v1/inspections/periods/17/overview": .json(200, AgentOpsFixtures.inspectionOverview),
            "/api/v1/rpa-reports/status": .json(200, AgentOpsFixtures.reportStatus),
        ]
    }

    /// 把视图挂进一个**不前置**的窗口，跑一次布局与绘制后取位图。
    ///
    /// 不 `makeKeyAndOrderFront`：测试不该抢用户的焦点；`NSHostingView` 只要在窗口里
    /// 就能完成布局与 `cacheDisplay`。
    private func render(_ view: some View, size: NSSize) throws -> NSBitmapImageRep {
        let hosted = HostedShell(view: view, size: size)
        hosted.pump()
        return try hosted.bitmap()
    }

    /// 常驻的离屏宿主：**视图必须在等待期间一直活着**。
    ///
    /// 为什么不能只靠 `render`：模块的真加载挂在视图的 `.task` 上 —— 视图一释放，
    /// `.task` 就被取消，加载永远到不了「已就绪」，用例就变成在测取消路径。
    /// 故涉及真模块的用例改为：先建宿主 → `pump` 抽帧 → 等待状态落地 → 再取位图。
    @MainActor
    private final class HostedShell {
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

        /// 抽一帧（SwiftUI 的首轮布局有一部分排在下一轮 runloop）。
        func pump(_ seconds: TimeInterval = 0.25) {
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

    /// 采样统计不透明像素：全透明的缓存说明视图没画出来（README 记过这个坑）。
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

    private func makeNavigation(selecting groupID: String?) -> NavigationStore {
        let store = NavigationStore(preferences: InMemoryShellPreferencesStore())
        if let groupID { store.select(groupID: groupID) }
        return store
    }

    /// 尚未搬运的二级项（S4 只实现了「数据流总览」，其余仍是占位）。
    private let placeholderRoute = "/dashboard/agent-center/employees"

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

    /// 选中一个**尚未实现**的模块 → 详情栏是占位视图 → **零请求**。
    ///
    /// 注：`operations` 分组的第一项已经是 S4 的真模块（会发请求），故这里显式选中
    /// 另一个仍是占位的条目 —— 「占位视图不发请求」这条契约从 S4 起只适用于未搬运项。
    func testPlaceholderDetailRendersWithoutIssuingRequests() throws {
        let model = makeSignedInModel()
        let navigation = makeNavigation(selecting: "operations")
        navigation.select(routeID: placeholderRoute)
        XCTAssertEqual(navigation.selectedItem?.title, "Agent 员工")

        let rep = try render(
            ShellView(model: model, navigation: navigation),
            size: NSSize(width: 1180, height: 720)
        )

        XCTAssertGreaterThan(opaqueSampleCount(rep), 0, "外壳应真实渲染出内容")
        XCTAssertTrue(
            StubURLProtocol.log.isEmpty,
            "占位视图不得发起任何请求，实发：\(StubURLProtocol.loggedPaths)"
        )
    }

    /// 切换模块：前一个占位视图销毁、后一个就位，仍然零请求。
    func testSwitchingModulesKeepsShellRequestFree() throws {
        let model = makeSignedInModel()
        let navigation = makeNavigation(selecting: "operations")
        navigation.select(routeID: placeholderRoute)

        _ = try render(ShellView(model: model, navigation: navigation), size: NSSize(width: 1180, height: 720))
        navigation.select(groupID: "crm")
        _ = try render(ShellView(model: model, navigation: navigation), size: NSSize(width: 1180, height: 720))

        XCTAssertEqual(navigation.selectedGroupID, "crm")
        XCTAssertTrue(StubURLProtocol.log.isEmpty, "模块与指标页的占位视图都不发请求")
    }

    /// S4 的真模块：详情栏渲染「数据流总览」并真的去拿四个源的数据。
    ///
    /// 这条用例把「路由表命中 → 模块发请求 → 状态机落地 → 界面画出内容」串成一条链，
    /// 用的是与线上完全一样的 `AppModel` / `APIClient` / `URLSession` 组装方式
    /// （只是 session 被打桩），因此「模块确实接上线了」不靠人工检查。
    func testOverviewModuleFetchesDataAndRenders() async throws {
        let model = makeSignedInModel(routes: overviewRoutes)
        let navigation = NavigationStore(preferences: InMemoryShellPreferencesStore())
        navigation.select(routeID: AgentOverviewView.routeID)
        XCTAssertEqual(navigation.selectedItem?.title, "数据流总览")

        // 宿主必须在等待期间一直活着（释放 = `.task` 取消 = 加载永远不落地）。
        let hosted = HostedShell(
            view: ShellView(model: model, navigation: navigation),
            size: NSSize(width: 1180, height: 720)
        )
        hosted.pump()
        // 矩阵先落地（`pageState` 只看矩阵），但三个产出源是并发的 —— 断言前要等四个源
        // 全部落定，否则会在「报表列还是占位」的瞬间断一个假失败。
        await waitUntil { navigation.agentOverview.pageState == .ready && !navigation.agentOverview.isRefreshing }

        XCTAssertEqual(
            Set(StubURLProtocol.loggedPaths),
            Set([
                "/api/v1/agent-ops/domain-summary",
                "/api/v1/complaints/overview",
                "/api/v1/inspections/periods/current",
                "/api/v1/inspections/periods/17/overview",
                "/api/v1/rpa-reports/status",
            ]),
            "四个源（巡检两跳）应各发一次，且不多发：\(StubURLProtocol.loggedPaths)"
        )
        XCTAssertEqual(navigation.agentOverview.rows.count, 17)
        XCTAssertEqual(navigation.agentOverview.activityDomainCount, 8, "实测 8 个域有活动")
        XCTAssertEqual(
            navigation.agentOverview.rows.first { $0.domain.code == "report_upload" }?.production ?? nil,
            "134/150 报表"
        )

        // 数据落地后再画一帧：矩阵真的渲染出内容（而不是只有骨架）。
        hosted.pump()
        XCTAssertGreaterThan(
            opaqueSampleCount(try hosted.bitmap()),
            0,
            "有数据的矩阵应渲染出内容"
        )
        // 作用域的清理发生在加载返回之后的一拍（`ModuleTaskScope` 的收尾回调），
        // 所以先等一会儿再断言「无残留」，否则会读到尚未清表的瞬间。
        await waitUntil { navigation.tasks.isEmpty }
        XCTAssertTrue(navigation.tasks.isEmpty, "加载结束后模块任务作用域应为空")
    }
    /// 概览态（未选分组）：渲染的仍是「连接与身份」，工具栏与侧栏同在。
    func testOverviewStateRenders() throws {
        let model = makeSignedInModel()
        let navigation = makeNavigation(selecting: nil)

        let rep = try render(
            ShellView(model: model, navigation: navigation),
            size: NSSize(width: 1180, height: 720)
        )

        XCTAssertGreaterThan(opaqueSampleCount(rep), 0)
        XCTAssertNil(navigation.selectedGroupID)
    }
}
