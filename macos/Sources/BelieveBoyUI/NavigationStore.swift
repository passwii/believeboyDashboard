import BelieveBoyKit
import Foundation
import Observation

/// 应用外壳状态：选中分组 / 二级项、侧栏折叠态、窗口尺寸，以及模块任务作用域。
///
/// 与 `AppModel`（登录态 / 连接配置 / 健康检查）分开：两者生命周期不同 —— 登出会重置
/// `AppModel` 的会话态，但外壳的窗口尺寸与侧栏折叠态**没有理由跟着丢**（下次登录回到
/// 原处才是对的）。
///
/// `@MainActor @Observable`（不引 TCA / Redux，同 PLAN §3 的约定）：视图只读本 store，
/// 需要改变时走下面的命令式方法 —— 这一版刻意不引入 `@State` / `@Bindable` 等属性
/// 包装器宏（CLT 下不可用，见 Package.swift 顶部与 PLAN §9），视图侧用显式 `Binding`
/// 包住这些方法。
@MainActor
@Observable
public final class NavigationStore {
    /// 概览（「连接与身份」）不是 catalog 里的条目，而是外壳的**空选中态**：
    /// 启动后先看到连接与身份，点条目才进模块。任务作用域因此需要一个非 route id 的 key。
    public static let overviewTaskKey = "__overview__"

    public let groups: [NavigationGroup]
    /// 模块任务作用域：视图发起的后台工作都登记在这里（见 `ModuleTaskScope`）。
    public let tasks: ModuleTaskScope

    public private(set) var selectedGroupID: String?
    public private(set) var selectedRouteID: String?
    public private(set) var columnVisibility: ShellColumnVisibility
    /// 上次记录的窗口 frame（供进程引导恢复；`nil` = 没记录或记录不可用）。
    public private(set) var windowFrame: WindowFrame?
    /// 偏好设置浮层是否展开（视图无 `@State`，开关态只能放 store）。
    public private(set) var isPreferencesPresented = false

    private let preferences: ShellPreferencesStore

    public init(
        groups: [NavigationGroup] = NavigationCatalog.groups,
        preferences: ShellPreferencesStore = UserDefaultsShellPreferencesStore(),
        tasks: ModuleTaskScope = ModuleTaskScope()
    ) {
        self.groups = groups
        self.preferences = preferences
        self.tasks = tasks

        // 落盘内容不可信（旧版本 / 手改）→ 先 sanitize 再采用，见 `ShellPreferences`。
        let restored = (preferences.loadPreferences() ?? ShellPreferences()).sanitized(catalog: groups)
        selectedGroupID = restored.selectedGroupID
        selectedRouteID = restored.selectedRouteID
        columnVisibility = restored.columnVisibility
        windowFrame = restored.windowFrame
    }

    // MARK: - 派生值

    public var selectedGroup: NavigationGroup? {
        guard let selectedGroupID else { return nil }
        return groups.first { $0.id == selectedGroupID }
    }

    public var selectedItem: NavigationItem? {
        guard let selectedRouteID else { return nil }
        return groups.lazy.flatMap(\.items).first { $0.id == selectedRouteID }
    }

    /// 详情栏当前内容（`nil` = 概览）对应的任务 key。
    public var selectionTaskKey: String { selectedRouteID ?? Self.overviewTaskKey }

    /// 当前完整的可持久化快照。
    public var currentPreferences: ShellPreferences {
        ShellPreferences(
            selectedGroupID: selectedGroupID,
            selectedRouteID: selectedRouteID,
            columnVisibility: columnVisibility,
            windowFrame: windowFrame
        )
    }

    // MARK: - 选择

    /// 选中分组：组内已有选中项就保留，否则落到该组首项（与 Web 点分组即进默认页一致）。
    public func select(groupID: String) {
        guard let group = groups.first(where: { $0.id == groupID }) else { return }
        selectedGroupID = groupID
        if selectedRouteID == nil || !group.items.contains(where: { $0.id == selectedRouteID }) {
            changeRoute(to: group.items.first?.id)
        }
        persist()
    }

    /// 选中二级项（同时把分组对齐到条目所属分组）。
    public func select(routeID: String) {
        guard let owner = groups.first(where: { group in group.items.contains { $0.id == routeID } })
        else { return }
        changeRoute(to: routeID)
        selectedGroupID = owner.id
        persist()
    }

    /// 回到「连接与身份」概览（清空选中）。
    public func showOverview() {
        changeRoute(to: nil)
        selectedGroupID = nil
        persist()
    }

    /// 侧栏可见性（`⌘⌥S` 折叠 / 拖分栏线都会走到这里）。
    public func setColumnVisibility(_ visibility: ShellColumnVisibility) {
        guard visibility != columnVisibility else { return }
        columnVisibility = visibility
        persist()
    }

    /// 偏好设置浮层开关（菜单项与工具栏按钮共用同一条命令式入口）。
    public func setPreferencesPresented(_ presented: Bool) {
        guard presented != isPreferencesPresented else { return }
        isPreferencesPresented = presented
    }

    // MARK: - 窗口尺寸

    /// 记录窗口 frame（`NSWindowDelegate` 在拖动 / 缩放结束后调用）。
    ///
    /// 只记可信的尺寸：写到 `UserDefaults` 里的东西下次要直接拿去 `setFrame`，
    /// 让一个坏值进来等于下次启动窗口跑到屏幕外。
    public func recordWindowFrame(_ frame: WindowFrame) {
        guard frame.isPlausible, frame != windowFrame else { return }
        windowFrame = frame
        persist()
    }

    // MARK: - 内部

    /// 切换选中项，并**取消上一个选中项名下的所有任务**（验收 2：切换模块不留残任务）。
    private func changeRoute(to routeID: String?) {
        guard routeID != selectedRouteID else { return }
        tasks.cancel(key: selectionTaskKey)
        selectedRouteID = routeID
    }

    private func persist() {
        preferences.savePreferences(currentPreferences)
    }
}
