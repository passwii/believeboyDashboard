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
    private func makeSignedInModel() -> AppModel {
        let sessionStore = InMemorySessionStore()
        try? sessionStore.saveSession(AuthSession(apiKey: "blf_SHELL", user: .fixtureAdmin))
        let session = StubURLProtocol.session(routes: [
            "/api/v1/health/live": .json(200, #"{"status":"ok","timestamp":1}"#),
            "/api/v1/health": .json(
                200,
                #"{"status":"ok","timestamp":1.0,"database":"ok","database_replica":"not configured",\#n"redis":"ok (1.2ms)","redis_memory":"2.07M","version":"production"}"#
            ),
        ])
        return AppModel(
            sessionStore: sessionStore,
            rememberedLogins: InMemoryRememberedLoginStore(),
            processEnvironment: [:],
            urlSession: session
        )
    }

    /// 把视图挂进一个**不前置**的窗口，跑一次布局与绘制后取位图。
    ///
    /// 不 `makeKeyAndOrderFront`：测试不该抢用户的焦点；`NSHostingView` 只要在窗口里
    /// 就能完成布局与 `cacheDisplay`。
    private func render(_ view: some View, size: NSSize) throws -> NSBitmapImageRep {
        let hosting = NSHostingView(rootView: view)
        hosting.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(
            contentRect: hosting.frame,
            styleMask: [.titled, .resizable],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.layoutIfNeeded()
        hosting.layoutSubtreeIfNeeded()
        // SwiftUI 的首轮布局有一部分排在下一轮 runloop：给它一拍再取位图，
        // 否则离屏渲染可能拿到一张还没画完（全透明）的缓存。
        RunLoop.current.run(until: Date().addingTimeInterval(0.25))
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

    /// 选中一个模块 → 详情栏是占位视图 → **零请求**（S3 的占位视图不发任何请求，
    /// 因此切换模块时根本没有在跑的请求可泄漏）。
    func testPlaceholderDetailRendersWithoutIssuingRequests() throws {
        let model = makeSignedInModel()
        let navigation = makeNavigation(selecting: "operations")
        XCTAssertEqual(navigation.selectedItem?.title, "数据流总览")

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

        _ = try render(ShellView(model: model, navigation: navigation), size: NSSize(width: 1180, height: 720))
        navigation.select(groupID: "crm")
        _ = try render(ShellView(model: model, navigation: navigation), size: NSSize(width: 1180, height: 720))

        XCTAssertEqual(navigation.selectedGroupID, "crm")
        XCTAssertTrue(StubURLProtocol.log.isEmpty, "模块与指标页的占位视图都不发请求")
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
