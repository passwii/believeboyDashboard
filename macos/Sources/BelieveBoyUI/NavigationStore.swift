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
    /// 「运营 → 数据流总览」（S4）的模块 store。
    ///
    /// 放在外壳里而不是模块视图内：视图是值类型、重绘即重建，把状态放在视图里等于
    /// 「切走再回来 = 重新加载 + 丢失选中行」。由外壳持有后，S5 搬进来的模块照此
    /// 继续往这里加（模块之间共享同一份生命周期）。
    public let agentOverview: AgentOverviewStore
    /// 「广告 → 广告分析」（S5.1）的模块 store：共享筛选条 + 10 个子 Tab 的状态。
    ///
    /// 同样放在外壳里：切 Tab / 切模块再回来不该重新拉数据、也不该丢掉已选项目与站点。
    public let adAnalysis: AdAnalysisStore
    /// 「广告 → 广告数据」（S5.2）的模块 store：10 种报表类型的原始行表 + 客户端搜索 / 排序 /
    /// 翻页 / 行展开。
    ///
    /// 同样住在外壳里：临时的搜索词、翻到第几页、展开了哪几行都是「用户在这个页面上的位置」，
    /// 切走再回来应当原处。两页的筛选条各自持有 `AdFilters`（同一份实现，见 `AdFilters`）。
    public let adData: AdDataStore
    /// 「AI 智能 → AI Chat」（S5.4）的模块 store：会话列表 + 消息历史 + POST-SSE 流式生成。
    ///
    /// 住在外壳里：当前会话、草稿输入、流式草稿、用量面板的区间选择都是「用户在这个页面上的
    /// 位置」—— 切走再回来应当原处（也是「流式跑到一半切模块」能靠 `tasks.cancelTree` 收尾的
    /// 前提：任务登记在外壳的作用域里，而不是跟着视图一起没了）。
    public let aiChat: AIChatStore
    /// 「AI 智能 → 客服交流」（S5.4）的模块 store：场景输入 + 一次生成。
    ///
    /// 与 `aiChat` 分开持有而不是共用：两页的输入区与产物形态不同（会话历史 vs 单块输出），
    /// 共用一份只会让「切页后输入框被对方覆盖」。它们共用的是**底座**（`AIChatClient` /
    /// `AIChatTurnAccumulator` / `AIChatPresetCatalog`），不是状态。
    public let customerService: CustomerServiceStore

    /// 「AI → AI 洞察」（S5.3）的模块 store：洞察列表（分页 + 筛选）+ 明细 + 旧链路流式 +
    /// 定时列表（只读）。
    public let aiInsights: AIInsightsStore

    /// 「AI → AI 广告分析」（S5.3）的模块 store：历史列表固定 `insight_type=ad_analysis`，
    /// 明细带维度面板。
    public let adAnalysisInsights: AIInsightsStore

    /// 「AI → AI 广告分析」的 canonical run 观察（`/insight/runs/{run_id}` + 流）。
    public let adAnalysisRun: CanonicalRunStore

    /// 「AI → AI 库存健康」的 canonical run 观察（库存域文案表）。
    public let inventoryRun: CanonicalRunStore

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
        tasks: ModuleTaskScope = ModuleTaskScope(),
        agentOverview: AgentOverviewStore = AgentOverviewStore(),
        adAnalysis: AdAnalysisStore = AdAnalysisStore(),
        adData: AdDataStore = AdDataStore(),
        aiInsights: AIInsightsStore = AIInsightsStore(),
        adAnalysisInsights: AIInsightsStore = AIInsightsStore(
            insightTypeFilter: InsightCatalog.adAnalysisInsightType
        ),
        adAnalysisRun: CanonicalRunStore = CanonicalRunStore(domain: .adAnalysis),
        inventoryRun: CanonicalRunStore = CanonicalRunStore(domain: .inventoryHealth),
        aiChat: AIChatStore = AIChatStore(),
        customerService: CustomerServiceStore = CustomerServiceStore()
    ) {
        self.groups = groups
        self.preferences = preferences
        self.tasks = tasks
        self.agentOverview = agentOverview
        self.adAnalysis = adAnalysis
        self.adData = adData
        self.aiInsights = aiInsights
        self.adAnalysisInsights = adAnalysisInsights
        self.adAnalysisRun = adAnalysisRun
        self.inventoryRun = inventoryRun
        self.aiChat = aiChat
        self.customerService = customerService

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
    ///
    /// 用 `cancelTree` 而不是 `cancel`：S5.4 起一个模块会有多条互不相干的在跑任务
    /// （会话列表 / 消息历史 / 用量 / 一条 SSE 流），它们各自登记在 `"\(route id):用途"`
    /// 子 key 下（见 `ModuleTaskScope.cancelTree`）。对 S5.1~S5.3 那些只用 route id 一个
    /// key 的模块，退化成与原来完全相同的 `cancel(key:)`，行为不变。
    private func changeRoute(to routeID: String?) {
        guard routeID != selectedRouteID else { return }
        tasks.cancelTree(key: selectionTaskKey)
        selectedRouteID = routeID
    }

    private func persist() {
        preferences.savePreferences(currentPreferences)
    }
}
