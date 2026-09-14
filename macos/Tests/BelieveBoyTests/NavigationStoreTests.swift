import BelieveBoyKit
import XCTest

@testable import BelieveBoyUI

/// 外壳状态机 —— 验收 1/3 与「切换模块无泄漏 Task」的直接证据。
///
/// `NavigationStore` 是选中态、折叠态、持久化与任务作用域的唯一落点，因此这些用例断言
/// 的是「一次选择之后，状态、落盘、在跑的任务分别变成什么」，而不是某个视图的回调次数。
@MainActor
final class NavigationStoreTests: XCTestCase {
    private func makeStore(
        seeded: ShellPreferences? = nil,
        tasks: ModuleTaskScope = ModuleTaskScope()
    ) -> (NavigationStore, InMemoryShellPreferencesStore) {
        let preferences = InMemoryShellPreferencesStore(seeded: seeded)
        let store = NavigationStore(preferences: preferences, tasks: tasks)
        return (store, preferences)
    }

    // MARK: - 启动状态

    func testStoreStartsOnOverviewWithoutSelection() {
        let (store, _) = makeStore()

        XCTAssertNil(store.selectedGroupID)
        XCTAssertNil(store.selectedRouteID)
        XCTAssertNil(store.selectedGroup)
        XCTAssertNil(store.selectedItem)
        XCTAssertEqual(store.selectionTaskKey, NavigationStore.overviewTaskKey)
        XCTAssertEqual(store.columnVisibility, .automatic)
    }

    func testStoreRestoresSelectionVisibilityAndWindowFrame() {
        let (store, _) = makeStore(
            seeded: ShellPreferences(
                selectedGroupID: "reports",
                selectedRouteID: "/dashboard/reports/order-info",
                columnVisibility: .detailOnly,
                windowFrame: WindowFrame(x: 60, y: 60, width: 1080, height: 720)
            )
        )

        XCTAssertEqual(store.selectedGroupID, "reports")
        XCTAssertEqual(store.selectedRouteID, "/dashboard/reports/order-info")
        XCTAssertEqual(store.selectedItem?.title, "订单信息")
        XCTAssertEqual(store.columnVisibility, .detailOnly, "侧栏折叠态必须恢复")
        XCTAssertEqual(store.windowFrame, WindowFrame(x: 60, y: 60, width: 1080, height: 720))
    }

    /// 落盘的选中项已不在 catalog 里 → 回到概览，而不是渲染一个不存在的页面。
    func testStoreDropsStaleRestoredSelection() {
        let (store, _) = makeStore(
            seeded: ShellPreferences(
                selectedGroupID: "reports",
                selectedRouteID: "/dashboard/reports/removed-page",
                columnVisibility: .all
            )
        )

        XCTAssertNil(store.selectedRouteID)
        XCTAssertNil(store.selectedGroupID)
        XCTAssertEqual(store.columnVisibility, .all, "折叠态与选中项是两件事，不跟着丢")
    }

    // MARK: - 选择语义

    func testSelectingGroupEntersItsFirstItem() {
        let (store, preferences) = makeStore()

        store.select(groupID: "reports")

        XCTAssertEqual(store.selectedGroupID, "reports")
        XCTAssertEqual(
            store.selectedRouteID,
            "/dashboard/reports/monthly-report/display",
            "点分组即进该组默认页（与 Web 一致）"
        )
        XCTAssertEqual(preferences.preferences?.selectedRouteID, store.selectedRouteID, "选择要落盘")
    }

    func testSelectingGroupKeepsCurrentItemWhenItBelongsToThatGroup() {
        let (store, _) = makeStore()
        store.select(routeID: "/dashboard/reports/order-info")

        store.select(groupID: "reports")

        XCTAssertEqual(store.selectedRouteID, "/dashboard/reports/order-info", "组内已有选中项不该被重置")
    }

    /// 条目才是路由真相：选中「Agent 接入管理」（路由在 /dashboard/system/ 下）后，
    /// 侧栏分组必须跟着切到「运营」。
    func testSelectingRouteAlignsGroupWithItemOwner() {
        let (store, _) = makeStore()

        store.select(routeID: "/dashboard/system/agent-management")

        XCTAssertEqual(store.selectedGroupID, "operations")
        XCTAssertEqual(store.selectedItem?.title, "Agent 接入管理")
    }

    func testUnknownGroupOrRouteIsIgnored() {
        let (store, preferences) = makeStore()

        store.select(groupID: "not-a-group")
        store.select(routeID: "/dashboard/not-a-page")

        XCTAssertNil(store.selectedGroupID)
        XCTAssertNil(store.selectedRouteID)
        XCTAssertNil(preferences.preferences, "无效选择不该触发落盘")
    }

    func testShowOverviewClearsSelectionAndPersists() {
        let (store, preferences) = makeStore()
        store.select(routeID: "/dashboard/crm/leads")

        store.showOverview()

        XCTAssertNil(store.selectedGroupID)
        XCTAssertNil(store.selectedRouteID)
        XCTAssertEqual(store.selectionTaskKey, NavigationStore.overviewTaskKey)
        XCTAssertNil(preferences.preferences?.selectedRouteID)
    }

    func testColumnVisibilityChangePersistsAndRepeatsAreNoOps() {
        let (store, preferences) = makeStore()

        store.setColumnVisibility(.detailOnly)
        let writes = preferences.saveCalls

        store.setColumnVisibility(.detailOnly)

        XCTAssertEqual(store.columnVisibility, .detailOnly)
        XCTAssertEqual(preferences.preferences?.columnVisibility, .detailOnly)
        XCTAssertEqual(preferences.saveCalls, writes, "值没变就不重复写")
    }

    func testPreferencesPresentedIsCommandDriven() {
        let (store, _) = makeStore()

        XCTAssertFalse(store.isPreferencesPresented)
        store.setPreferencesPresented(true)
        XCTAssertTrue(store.isPreferencesPresented)
        store.setPreferencesPresented(true)
        XCTAssertTrue(store.isPreferencesPresented)
        store.setPreferencesPresented(false)
        XCTAssertFalse(store.isPreferencesPresented)
    }

    // MARK: - 窗口尺寸

    func testRecordWindowFramePersistsPlausibleFrameOnly() {
        let (store, preferences) = makeStore()
        let frame = WindowFrame(x: 100, y: 100, width: 1000, height: 700)

        store.recordWindowFrame(frame)
        XCTAssertEqual(store.windowFrame, frame)
        XCTAssertEqual(preferences.preferences?.windowFrame, frame)

        let writes = preferences.saveCalls
        store.recordWindowFrame(frame)
        XCTAssertEqual(preferences.saveCalls, writes, "同一尺寸不重复写")

        store.recordWindowFrame(WindowFrame(x: 0, y: 0, width: 10, height: 10))
        XCTAssertEqual(store.windowFrame, frame, "不可信的尺寸不得覆盖已记录的")
    }

    // MARK: - 验收 2：切换模块不残留任务

    /// 切换选中项 → 上一个模块名下的任务被取消、登记表清空。
    func testSwitchingModuleCancelsOutgoingTaskAndLeavesNoResidue() async throws {
        let (store, _) = makeStore()
        store.select(groupID: "operations")
        let outgoingKey = try XCTUnwrap(store.selectedRouteID)

        let recorder = CancellationRecorder()
        store.tasks.run(key: store.selectionTaskKey) {
            await withTaskCancellationHandler {
                // 挂起点：一直等到被取消为止。
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 1_000_000)
                }
            } onCancel: {
                recorder.markCancelled()
            }
        }
        XCTAssertFalse(store.tasks.isEmpty)

        store.select(groupID: "reports")

        await waitUntil { recorder.isCancelled }
        XCTAssertTrue(recorder.isCancelled, "切走的模块任务必须被取消，不能留着轮询/请求")
        XCTAssertEqual(store.tasks.activeKeys, [], "旧的登记不该留在表里")
        await waitUntil { store.tasks.isEmpty }
        XCTAssertTrue(store.tasks.isEmpty, "任务收尾后作用域应为空")
        XCTAssertEqual(store.selectionTaskKey, "/dashboard/reports/monthly-report/display")
        XCTAssertNotEqual(store.selectionTaskKey, outgoingKey)
    }

    /// 同一个 key 上重复加载只保留最后一次（模块内「再刷新一次」不会叠出两条并发）。
    func testRepeatedRunOnSameKeyCancelsPrevious() async {
        let (store, _) = makeStore()
        store.select(groupID: "operations")
        let key = store.selectionTaskKey

        let first = CancellationRecorder()
        store.tasks.run(key: key) {
            await withTaskCancellationHandler {
                while !Task.isCancelled { try? await Task.sleep(nanoseconds: 1_000_000) }
            } onCancel: {
                first.markCancelled()
            }
        }

        // 第二次加载同一个 key：它也挂起不结束，这样登记表里应当只剩它。
        let second = CancellationRecorder()
        store.tasks.run(key: key) {
            await withTaskCancellationHandler {
                while !Task.isCancelled { try? await Task.sleep(nanoseconds: 1_000_000) }
            } onCancel: {
                second.markCancelled()
            }
        }

        await waitUntil { first.isCancelled }
        XCTAssertTrue(first.isCancelled, "同 key 重跑必须先取消上一次")
        XCTAssertFalse(second.isCancelled, "新任务不该被自己取消")
        XCTAssertEqual(store.tasks.activeKeys, [key], "同 key 只保留最后一次登记")

        store.tasks.cancelAll()
        await waitUntil { second.isCancelled }
    }

    /// 登出（会话没了）后不该留着任何模块任务继续打后端。
    func testCancelAllClearsEveryRunningTask() async {
        let (store, _) = makeStore()
        store.select(groupID: "operations")

        let recorder = CancellationRecorder()
        store.tasks.run(key: store.selectionTaskKey) {
            await withTaskCancellationHandler {
                while !Task.isCancelled { try? await Task.sleep(nanoseconds: 1_000_000) }
            } onCancel: {
                recorder.markCancelled()
            }
        }

        store.tasks.cancelAll()

        await waitUntil { recorder.isCancelled }
        XCTAssertTrue(recorder.isCancelled)
        XCTAssertEqual(store.tasks.activeKeys, [])
    }

    /// 概览（未选任何模块）也有自己的任务 key：从概览切到模块时同样要取消。
    func testSwitchingFromOverviewCancelsOverviewTask() async {
        let (store, _) = makeStore()
        XCTAssertEqual(store.selectionTaskKey, NavigationStore.overviewTaskKey)

        let recorder = CancellationRecorder()
        store.tasks.run(key: store.selectionTaskKey) {
            await withTaskCancellationHandler {
                while !Task.isCancelled { try? await Task.sleep(nanoseconds: 1_000_000) }
            } onCancel: {
                recorder.markCancelled()
            }
        }

        store.select(groupID: "finance")

        await waitUntil { recorder.isCancelled }
        XCTAssertTrue(recorder.isCancelled, "概览的探测也要在离开时收掉")
    }

    /// 有界轮询：等待异步取消 / 收尾落地。超时即失败，不用固定 sleep 赌时序。
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
}
