import BelieveBoyKit
import XCTest

/// 外壳状态的持久化与恢复规则 —— 验收 3「窗口尺寸 / 侧栏折叠状态可恢复」的离线证据。
///
/// 恢复是**不可信输入**路径（旧版本落盘、手改 `UserDefaults`、换了显示器），所以规则
/// 全在纯函数里：这些用例直接喂「假 catalog / 假屏幕」，不必起窗口。
final class ShellPreferencesTests: XCTestCase {
    private let mainScreen = WindowFrame(x: 0, y: 0, width: 1440, height: 900)
    private let secondScreen = WindowFrame(x: 1440, y: 0, width: 1920, height: 1080)

    // MARK: - 编解码

    func testCodableRoundTripKeepsEveryField() throws {
        let original = ShellPreferences(
            selectedGroupID: "reports",
            selectedRouteID: "/dashboard/reports/order-info",
            columnVisibility: .detailOnly,
            windowFrame: WindowFrame(x: 120, y: 80, width: 1100, height: 720)
        )

        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ShellPreferences.self, from: data)

        XCTAssertEqual(decoded, original)
    }

    func testSanitizedKeepsValidSelection() {
        let preferences = ShellPreferences(
            selectedGroupID: "crm",
            selectedRouteID: "/dashboard/crm/tasks",
            columnVisibility: .all
        )

        let cleaned = preferences.sanitized()

        XCTAssertEqual(cleaned.selectedGroupID, "crm")
        XCTAssertEqual(cleaned.selectedRouteID, "/dashboard/crm/tasks")
        XCTAssertEqual(cleaned.columnVisibility, .all)
    }

    /// 条目被删 / 改名后不得留下「指向不存在页面」的选中项：连带分组一起清掉，
    /// 详情栏回到概览，而不是渲染一个空壳。
    func testSanitizedDropsRouteThatIsNoLongerInCatalog() {
        let preferences = ShellPreferences(
            selectedGroupID: "reports",
            selectedRouteID: "/dashboard/reports/legacy-page"
        )

        let cleaned = preferences.sanitized()

        XCTAssertNil(cleaned.selectedRouteID)
        XCTAssertNil(cleaned.selectedGroupID)
    }

    /// 分组与条目不一致时以**条目**为准（条目才是路由真相）。
    func testSanitizedAlignsGroupWithRouteOwner() {
        let preferences = ShellPreferences(
            selectedGroupID: "finance",
            selectedRouteID: "/dashboard/crm/tasks"
        )

        let cleaned = preferences.sanitized()

        XCTAssertEqual(cleaned.selectedGroupID, "crm")
        XCTAssertEqual(cleaned.selectedRouteID, "/dashboard/crm/tasks")
    }

    /// 路由在 `/dashboard/system/` 下、却属于「运营」分组的那种条目，恢复后仍归运营。
    func testSanitizedUsesItemPlacementForCrossPrefixRoute() {
        let preferences = ShellPreferences(selectedRouteID: "/dashboard/system/agent-management")

        XCTAssertEqual(preferences.sanitized().selectedGroupID, "operations")
    }

    func testSanitizedDropsUnknownGroupButKeepsValidRoute() {
        let stale = ShellPreferences(selectedGroupID: "closed-group")
        XCTAssertNil(stale.sanitized().selectedGroupID)

        let withRoute = ShellPreferences(
            selectedGroupID: "closed-group",
            selectedRouteID: "/dashboard/tools/page-render"
        )
        XCTAssertEqual(withRoute.sanitized().selectedGroupID, "tools")
    }

    /// 只选分组不选条目是合法状态（内容栏有列表、详情栏给提示）。
    func testSanitizedKeepsGroupWithoutRoute() {
        let cleaned = ShellPreferences(selectedGroupID: "ai").sanitized()

        XCTAssertEqual(cleaned.selectedGroupID, "ai")
        XCTAssertNil(cleaned.selectedRouteID)
    }

    // MARK: - 窗口尺寸的可信度

    func testPlausibleFrameIsKeptAndImplausibleIsDropped() {
        let good = ShellPreferences(windowFrame: WindowFrame(x: 40, y: 40, width: 1000, height: 700))
        XCTAssertEqual(good.sanitized().windowFrame, good.windowFrame)

        // 小于三栏外壳的最小可交互尺寸（640×520）——手改 / 旧版本留下的窄窗。
        let tooSmall = ShellPreferences(windowFrame: WindowFrame(x: 0, y: 0, width: 400, height: 300))
        XCTAssertNil(tooSmall.sanitized().windowFrame)

        // 非有限值（手改 JSON 写出 Infinity / NaN）。
        let notFinite = ShellPreferences(
            windowFrame: WindowFrame(x: .nan, y: 0, width: 1000, height: 700)
        )
        XCTAssertNil(notFinite.sanitized().windowFrame)

        // 荒诞宽度：防止 `setFrame` 直接设出一个不可交互的窗口。
        let absurd = ShellPreferences(windowFrame: WindowFrame(x: 0, y: 0, width: 1_000_000, height: 700))
        XCTAssertNil(absurd.sanitized().windowFrame)
    }

    // MARK: - 夹回可见屏幕

    func testFrameInsideScreenIsUntouched() {
        let frame = WindowFrame(x: 100, y: 100, width: 900, height: 600)
        XCTAssertEqual(frame.clamped(in: [mainScreen]), frame)
    }

    /// 显示器被拔掉后，落盘坐标可能在屏幕外 —— 直接恢复会「启动了但看不见」，
    /// 所以要把它居中到可见屏幕上。
    func testOffscreenFrameIsCenteredOnHostScreen() {
        let offscreen = WindowFrame(x: 9_000, y: 9_000, width: 900, height: 600)

        let clamped = offscreen.clamped(in: [mainScreen])

        XCTAssertEqual(clamped.size, offscreen.size, "只挪位置，不改尺寸")
        XCTAssertEqual(clamped.x, mainScreen.x + (mainScreen.width - clamped.width) / 2)
        XCTAssertEqual(clamped.y, mainScreen.y + (mainScreen.height - clamped.height) / 2)
    }

    /// 部分越界但左上角仍可见 → 推回屏内，而不是整窗居中（尊重用户的原位置）。
    func testPartiallyVisibleFrameIsPushedBackIntoBounds() {
        let overhanging = WindowFrame(x: 1300, y: 800, width: 900, height: 600)

        let clamped = overhanging.clamped(in: [mainScreen])

        XCTAssertGreaterThanOrEqual(clamped.x, mainScreen.x)
        XCTAssertLessThanOrEqual(clamped.x + clamped.width, mainScreen.x + mainScreen.width)
        XCTAssertGreaterThanOrEqual(clamped.y, mainScreen.y)
        XCTAssertLessThanOrEqual(clamped.y + clamped.height, mainScreen.y + mainScreen.height)
    }

    func testFrameSmallerThanMinimumIsRaisedToMinimum() {
        let tiny = WindowFrame(x: 0, y: 0, width: 300, height: 200)

        let clamped = tiny.clamped(in: [mainScreen])

        XCTAssertEqual(clamped.width, WindowFrame.minimum.width)
        XCTAssertEqual(clamped.height, WindowFrame.minimum.height)
    }

    /// 换了更小的屏：窗口比宿主屏还大时先压到屏内，否则标题栏会被推到屏幕外抓不到。
    func testFrameLargerThanScreenIsShrunkToScreen() {
        let huge = WindowFrame(x: 0, y: 0, width: 3000, height: 2000)

        let clamped = huge.clamped(in: [mainScreen])

        XCTAssertEqual(clamped.width, mainScreen.width)
        XCTAssertEqual(clamped.height, mainScreen.height)
    }

    /// 多显示器：落在第二块屏上、且仍在屏幕内的窗口不得被挪回主屏。
    func testFrameOnSecondScreenStaysThere() {
        let frame = WindowFrame(x: 1600, y: 200, width: 900, height: 600)

        XCTAssertEqual(frame.clamped(in: [mainScreen, secondScreen]), frame)
    }

    /// 拿不到屏幕信息（`NSScreen.screens` 为空）时不要凭空挪窗口。
    func testNoScreenInformationLeavesFrameUntouched() {
        let frame = WindowFrame(x: 9_000, y: 9_000, width: 900, height: 600)

        XCTAssertEqual(frame.clamped(in: []), frame)
    }

    // MARK: - UserDefaults 实现

    func testUserDefaultsStoreRoundTrip() {
        let suite = "blf1051.shell.preferences.tests"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        let store = UserDefaultsShellPreferencesStore(suiteName: suite)
        XCTAssertNil(store.loadPreferences(), "干净域里应当没有记录")

        let preferences = ShellPreferences(
            selectedGroupID: "operations",
            selectedRouteID: "/dashboard/operations/daily-analysis",
            columnVisibility: .doubleColumn,
            windowFrame: WindowFrame(x: 10, y: 20, width: 1024, height: 768)
        )
        store.savePreferences(preferences)

        XCTAssertEqual(store.loadPreferences(), preferences)
    }

    /// 落盘内容被写坏 → 当作「没有记录」，不让启动路径崩在解码上。
    func testUserDefaultsStoreTreatsCorruptPayloadAsAbsent() {
        let suite = "blf1051.shell.corrupt.tests"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(Data("not json".utf8), forKey: UserDefaultsShellPreferencesStore.defaultKey)

        let store = UserDefaultsShellPreferencesStore(suiteName: suite)

        XCTAssertNil(store.loadPreferences())
    }
}
