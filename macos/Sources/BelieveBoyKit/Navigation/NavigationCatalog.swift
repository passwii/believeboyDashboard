import Foundation

/// 导航目录 —— Web 端侧栏语义在 Swift 侧的**等价物**。
///
/// 权威来源是 `frontend/lib/sidebar-config.ts`（`SIDEBAR_TOP_GROUPS`）：8 个分组、
/// 56 个二级项、18 处 `matchPrefixes`。跨仓库一致性按 PLAN §2.2 仍是**人工对照**
/// （不做代码生成，避免把前端工具链拉进构建期依赖），对照方式：
///
/// ```bash
/// # 分组数（8）
/// grep -c "^    id: '" frontend/lib/sidebar-config.ts
/// # 每组二级项数（19 / 7 / 4 / 2 / 8 / 7 / 2 / 7，合计 56）
/// grep -c "^        title:\|^      { title:" frontend/lib/sidebar-config.ts
/// # matchPrefixes 出现次数（18 个二级项带前缀匹配）
/// grep -c "matchPrefixes: \[" frontend/lib/sidebar-config.ts
/// ```
///
/// `NavigationCatalogTests` 把上面的数字钉在 Swift 侧：本地条目漂移会在测试里报红，
/// 不必等到人工对照才发现。
///
/// **不携带权限位**：`sidebar-config.ts` 的 `roles` / `groupRoles` 目前已全部移除
/// （该文件头写明「可见性改由单页权限（per-page）接管」，`filterByRole` /
/// `getVisibleGroups` 仅保留接口）。桌面端`catalog` 因此只做 分组 / 二级项 /
/// 路由 id（含高亮语义）；照旧口径做 role 过滤反而会与 Web 端可见性不一致。
///
/// **高亮不能只比 `url` 相等**：Web 的 `isLinkActive` 有一条 `/dashboard` 特例
/// （仅精确相等才算活动）加前缀匹配，18 处 `matchPrefixes` 就是为子路径不丢高亮
/// 而存在的（例：`/dashboard/reports/monthly-report/display` 要同时点亮
/// 「财务月报」与其它 `/monthly-report/*` 子页）。`isActive(path:item:)` 复刻这条语义。
public enum NavigationCatalog {
    /// 8 个分组，顺序与 Web 侧栏一致（顺序即侧栏展示顺序）。
    public static let groups: [NavigationGroup] = [
        NavigationGroup(
            id: "operations",
            label: "运营",
            symbol: "rectangle.grid.2x2",
            items: [
                item("数据流总览", "/dashboard/agent-center/overview", "waveform.path.ecg",
                     prefixes: ["/dashboard/agent-center/overview"]),
                item("Agent 员工", "/dashboard/agent-center/employees", "person.2",
                     prefixes: ["/dashboard/agent-center/employees"]),
                item("站点导航", "/dashboard/operations/site-navigation", "rectangle.grid.2x2"),
                item("店铺导航", "/dashboard/operations/store-navigation", "storefront"),
                item("销售数据", "/dashboard/operations/daily-analysis", "chart.line.uptrend.xyaxis"),
                item("退货分析", "/dashboard/operations/return-analysis", "arrow.uturn.backward"),
                item("项目目标", "/dashboard/operations/project-goals", "target"),
                item("调研分析", "/dashboard/operations/research-analysis", "doc.text.magnifyingglass"),
                item("客户消息", "/dashboard/operations/complaint-center", "bubble.left.and.bubble.right",
                     prefixes: ["/dashboard/operations/complaint-center"]),
                item("平台巡检", "/dashboard/operations/platform-inspection", "shield"),
                item("库存分析", "/dashboard/operations/inventory-analysis", "building.2"),
                item("按周产品分析", "/dashboard/operations/weekly-product-analysis", "chart.bar"),
                item("组合分析", "/dashboard/operations/portfolio-overview", "square.stack.3d.up"),
                item("SKU 信息", "/dashboard/operations/sku-info", "chart.bar.doc.horizontal"),
                item("补货分析", "/dashboard/operations/inventory-replenishment", "arrow.triangle.2.circlepath"),
                item("库存分类账", "/dashboard/operations/inventory-ledger", "checklist"),
                item("季节性补货分析", "/dashboard/operations/seasonal-replenishment", "calendar"),
                item("发货管理", "/dashboard/operations/shipment-management", "shippingbox"),
                // 路由在 /dashboard/system/ 下，但分组归属是**运营**：Web 端按条目所在分组
                // 判定（`findGroupByPathname` 取第一个命中），桌面端同构 —— 见
                // `groupID(forPath:)`（它比 `findGroupByPathname` 的「首个命中」语义一致）。
                item("Agent 接入管理", "/dashboard/system/agent-management", "shield"),
            ]
        ),
        NavigationGroup(
            id: "reports",
            label: "报表中心",
            symbol: "chart.bar.doc.horizontal",
            items: [
                item("财务月报", "/dashboard/reports/monthly-report/display", "chart.bar.doc.horizontal",
                     prefixes: ["/dashboard/reports/monthly-report"]),
                item("产品分析", "/dashboard/reports/product-analysis", "function"),
                item("新品核算", "/dashboard/reports/pricing-calculation/new-product", "dollarsign.circle",
                     prefixes: ["/dashboard/reports/pricing-calculation/new-product"]),
                item("店铺测算", "/dashboard/reports/pricing-calculation/shop-calculation", "storefront",
                     prefixes: ["/dashboard/reports/pricing-calculation/shop-calculation"]),
                item("定时报告", "/dashboard/reports/scheduled-reports", "bolt",
                     prefixes: ["/dashboard/reports/scheduled-reports"]),
                item("报表自动化", "/dashboard/reports/auto-upload", "arrow.triangle.2.circlepath"),
                item("订单信息", "/dashboard/reports/order-info", "bag"),
            ]
        ),
        NavigationGroup(
            id: "finance",
            label: "财务资金",
            symbol: "dollarsign",
            items: [
                item("平台回款", "/dashboard/finance/platform-revenue", "banknote"),
                item("汇率信息", "/dashboard/finance/exchange-rate", "dollarsign"),
                item("VAT 发票", "/dashboard/finance/vat-invoice", "doc.plaintext"),
                item("佣金管理", "/dashboard/finance/commission-management", "dollarsign.circle"),
            ]
        ),
        NavigationGroup(
            id: "advertising",
            label: "广告",
            symbol: "chart.bar",
            items: [
                item("广告分析", "/dashboard/advertising/ad-analysis/overview", "chart.bar",
                     prefixes: ["/dashboard/advertising/ad-analysis"]),
                item("广告数据", "/dashboard/advertising/ad-data", "cylinder.split.1x2",
                     prefixes: ["/dashboard/advertising/ad-data"]),
            ]
        ),
        NavigationGroup(
            id: "ai",
            label: "AI 智能",
            symbol: "sparkles",
            items: [
                item("AI洞察", "/dashboard/ai/insights", "chart.line.uptrend.xyaxis"),
                item("AI 广告分析", "/dashboard/ai/ad-analysis", "chart.bar",
                     prefixes: ["/dashboard/ai/ad-analysis"]),
                item("AI 库存健康", "/dashboard/ai/inventory-health", "shippingbox",
                     prefixes: ["/dashboard/ai/inventory-health"]),
                item("AI Chat", "/dashboard/ai/chat", "sparkles"),
                item("模型选型", "/dashboard/ai/believeboy-models", "doc.text",
                     prefixes: ["/dashboard/ai/believeboy-models"]),
                item("客服交流", "/dashboard/ai/customer-service", "bubble.left.and.bubble.right"),
                item("数字员工", "/dashboard/ai/digital-employees", "person.2"),
                item("虚拟办公室", "/dashboard/ai/digital-employees/office", "rectangle.grid.2x2"),
            ]
        ),
        NavigationGroup(
            id: "crm",
            label: "CRM 客户与合作伙伴",
            // Web 用 lucide 的 `Handshake`；`handshake` 不在 macOS 14 的 SF Symbols 里，
            // 取语义最接近的 `person.2.wave.2`（图标只影响观感，不影响导航语义）。
            symbol: "person.2.wave.2",
            items: [
                item("数据看板", "/dashboard/crm/dashboard", "chart.bar",
                     prefixes: ["/dashboard/crm/dashboard"]),
                // 「待跟进」挂的是 Web 动态徽标组件（`CrmFollowUpBadge`）：要拉数据才有值。
                // 占位期**只留语义位**（`requiresLiveData`）、不假装实现，实现在 S4+。
                item("待跟进", "/dashboard/crm/follow-ups", "bell",
                     prefixes: ["/dashboard/crm/follow-ups"], requiresLiveData: true),
                item("客户", "/dashboard/crm/customers", "person.2",
                     prefixes: ["/dashboard/crm/customers", "/dashboard/crm/sea"]),
                item("线索", "/dashboard/crm/leads", "sparkles",
                     prefixes: ["/dashboard/crm/leads"]),
                item("任务", "/dashboard/crm/tasks", "checkmark.square",
                     prefixes: ["/dashboard/crm/tasks"]),
                item("操作日志", "/dashboard/crm/audit", "clock.arrow.circlepath",
                     prefixes: ["/dashboard/crm/audit"]),
                item("CRM 设置", "/dashboard/crm/settings", "gearshape"),
            ]
        ),
        NavigationGroup(
            // 分组 id 与 `sidebar-config.ts` 一致（那里是 `tools`，不是 `toolbox`）。
            id: "tools",
            label: "工具箱",
            symbol: "wrench.and.screwdriver",
            items: [
                item("Markdown 转换", "/dashboard/tools/markdown-to-word", "doc.text"),
                item("Markdown/HTML 渲染", "/dashboard/tools/page-render",
                     "chevron.left.forwardslash.chevron.right"),
            ]
        ),
        NavigationGroup(
            id: "system",
            label: "系统管理",
            symbol: "person.badge.shield.checkmark",
            items: [
                item("更新日志", "/dashboard/system/changelog", "clock.arrow.circlepath"),
                item("项目信息", "/dashboard/system/project-info", "storefront"),
                item("数据库状态", "/dashboard/system/data-management", "cylinder.split.1x2"),
                item("账号管理", "/dashboard/system/account-management", "person.2"),
                item("运营管理", "/dashboard/system/operator-management", "person.badge.shield.checkmark"),
                item("告警中心", "/dashboard/system/alerts", "bell"),
                item("日志查看", "/dashboard/system/logs", "clock.arrow.circlepath"),
            ]
        ),
    ]

    /// 扁平化的全部二级项（顺序 = 分组顺序 × 组内顺序）。
    public static var allItems: [NavigationItem] { groups.flatMap(\.items) }

    public static func group(id: String) -> NavigationGroup? {
        groups.first { $0.id == id }
    }

    public static func item(routeID: String) -> NavigationItem? {
        allItems.first { $0.id == routeID }
    }

    /// 路由所属分组（Web `findGroupByPathname` 的「首个命中」语义，按**条目所在分组**
    /// 判定，不看路由前缀）—— 例：`/dashboard/system/agent-management` 属于 `operations`。
    public static func groupID(forRouteID routeID: String) -> String? {
        groups.first { group in group.items.contains { $0.id == routeID } }?.id
    }

    /// 高亮判定，复刻 Web `isLinkActive`。
    ///
    /// 三点必须都照做，否则侧栏高亮会漏：`/dashboard` 特例（仅精确相等）、精确相等、
    /// `matchPrefixes` 前缀匹配（18 处）。
    public static func isActive(path: String, item: NavigationItem) -> Bool {
        if item.id == "/dashboard" { return path == item.id }
        if path == item.id { return true }
        return item.matchPrefixes.contains { path.hasPrefix($0) }
    }

    /// 给定 pathname，命中的第一个二级项（`isActive` 顺序即侧栏顺序，与 Web 一致）。
    public static func item(matchingPath path: String) -> NavigationItem? {
        allItems.first { isActive(path: path, item: $0) }
    }

    private static func item(
        _ title: String,
        _ route: String,
        _ symbol: String,
        prefixes: [String] = [],
        requiresLiveData: Bool = false
    ) -> NavigationItem {
        NavigationItem(
            id: route,
            title: title,
            route: route,
            symbol: symbol,
            matchPrefixes: prefixes,
            requiresLiveData: requiresLiveData
        )
    }
}

/// 侧栏二级项。
public struct NavigationItem: Identifiable, Hashable, Sendable {
    /// 路由 id —— 直接取 Web 的 `url`（同一份权威数据，去重后天然稳定）。
    /// 也是持久化与 `List(selection:)` 的选择载体。
    public let id: String
    public let title: String
    /// Web 路由（`/dashboard/...`）。桌面端目前只有占位视图，故它同时充当
    /// 「这条在 Web 上是什么」的对照物。
    public let route: String
    /// SF Symbol 名（Web 用 lucide 图标；两边只对齐**语义**，不对齐字形）。
    public let symbol: String
    /// Web 前缀匹配串；`isActive` 用它保证子路径不丢高亮。
    public let matchPrefixes: [String]
    /// 该条目的标题右侧需要**实时数据**才能渲染（如 CRM「待跟进」的逾期数徽标）。
    /// 为真时占位视图只显示语义位、不伪造数字。
    public let requiresLiveData: Bool

    public init(
        id: String,
        title: String,
        route: String,
        symbol: String,
        matchPrefixes: [String] = [],
        requiresLiveData: Bool = false
    ) {
        self.id = id
        self.title = title
        self.route = route
        self.symbol = symbol
        self.matchPrefixes = matchPrefixes
        self.requiresLiveData = requiresLiveData
    }
}

/// 侧栏分组。
public struct NavigationGroup: Identifiable, Hashable, Sendable {
    /// 分组 id，与 `sidebar-config.ts` 的 `id` 一字不差（`operations` / `reports` /
    /// `finance` / `advertising` / `ai` / `crm` / `tools` / `system`）。
    public let id: String
    public let label: String
    public let symbol: String
    public let items: [NavigationItem]

    public init(id: String, label: String, symbol: String, items: [NavigationItem]) {
        self.id = id
        self.label = label
        self.symbol = symbol
        self.items = items
    }
}
