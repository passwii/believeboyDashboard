// Sidebar configuration — mirror of `frontend/lib/sidebar-config.ts`.
//
// BEL-147: the macOS sidebar and the web sidebar are intentionally a
// MIRROR, not a code-share. Whenever the web sidebar changes, this file
// must be updated in lock-step. See `docs/macos-integration.md` (TODO)
// for the sync protocol.
//
// Group structure (7 top-level groups, 45 leaf items — same as web):
//   operations, ai, reporting, analysis, data-management, special, system.

import SwiftUI

// MARK: - Group + item model

struct SidebarGroup: Identifiable, Hashable {
    let id: String
    let title: String
    let systemImage: String
    let accent: String
    let items: [SidebarItem]

    /// All groups, in the same order as the web sidebar.
    static let allGroups: [SidebarGroup] = [
        .operations, .ai, .reporting, .analysis,
        .dataManagement, .special, .system,
    ]

    /// Role-based filtering — mirrors web's `getVisibleGroups(...)`.
    static func visible(for role: SessionUser.Role?) -> [SidebarGroup] {
        guard let role else { return allGroups }
        return allGroups.filter { group in
            group.allowedRoles.isEmpty || group.allowedRoles.contains(role)
        }
    }

    /// Subset of groups that have any items visible to the given role.
    func itemsVisible(for role: SessionUser.Role?) -> [SidebarItem] {
        items.filter { item in
            item.allowedRoles.isEmpty || item.allowedRoles.contains(role ?? .operator)
        }
    }

    /// If non-empty, only these roles see the group at all.
    let allowedRoles: Set<SessionUser.Role>
}

struct SidebarItem: Identifiable, Hashable {
    let id: String              // route key, e.g. "data-management/exchange-rate"
    let title: String           // 显示标题（与 web DASHBOARD_PAGE_TITLES 对齐）
    let routePath: String       // macOS 内部路由
    let systemImage: String     // SF Symbol
    let allowedRoles: Set<SessionUser.Role>
}

// MARK: - Concrete groups
//
// Order, IDs and titles MUST stay aligned with `frontend/lib/sidebar-config.ts`.
// When adding a page on web, add it here in the same group with the same id.

extension SidebarGroup {
    static let operations = SidebarGroup(
        id: "operations",
        title: "运营导航",
        systemImage: "storefront",
        accent: "blue",
        items: [
            SidebarItem(id: "operations/site-navigation", title: "跨境平台书签导航",
                        routePath: "/operations/site-navigation",
                        systemImage: "globe", allowedRoles: []),
            SidebarItem(id: "operations/store-navigation", title: "店铺导航",
                        routePath: "/operations/store-navigation",
                        systemImage: "storefront", allowedRoles: []),
        ],
        allowedRoles: []
    )

    static let ai = SidebarGroup(
        id: "ai",
        title: "AI 面板",
        systemImage: "sparkles",
        accent: "purple",
        items: [
            SidebarItem(id: "ai/page", title: "AI 概览",
                        routePath: "/ai", systemImage: "sparkles", allowedRoles: []),
            SidebarItem(id: "ai/chat", title: "AI Chat",
                        routePath: "/ai/chat", systemImage: "bubble.left.and.bubble.right", allowedRoles: []),
            SidebarItem(id: "ai/insights", title: "AI 洞察",
                        routePath: "/ai/insights", systemImage: "lightbulb", allowedRoles: []),
            SidebarItem(id: "ai/ad-analysis", title: "AI 广告分析",
                        routePath: "/ai/ad-analysis", systemImage: "chart.line.uptrend.xyaxis", allowedRoles: []),
        ],
        allowedRoles: []
    )

    static let reporting = SidebarGroup(
        id: "reporting",
        title: "运营核算",
        systemImage: "file.bar.chart",
        accent: "green",
        items: [
            SidebarItem(id: "data-reporting/monthly-report", title: "财务月报",
                        routePath: "/data-reporting/monthly-report",
                        systemImage: "doc.text", allowedRoles: []),
            SidebarItem(id: "data-reporting/product-analysis", title: "产品分析",
                        routePath: "/data-reporting/product-analysis",
                        systemImage: "cube.box", allowedRoles: []),
            SidebarItem(id: "data-reporting/pricing-calculation", title: "定价核算",
                        routePath: "/data-reporting/pricing-calculation",
                        systemImage: "function", allowedRoles: []),
            SidebarItem(id: "data-reporting/pricing-calculation/shop-calculation", title: "店铺测算",
                        routePath: "/data-reporting/pricing-calculation/shop-calculation",
                        systemImage: "cart", allowedRoles: []),
            SidebarItem(id: "data-reporting/pricing-calculation/new-product", title: "新品定价",
                        routePath: "/data-reporting/pricing-calculation/new-product",
                        systemImage: "plus.square.on.square", allowedRoles: []),
        ],
        allowedRoles: []
    )

    static let analysis = SidebarGroup(
        id: "analysis",
        title: "数据分析",
        systemImage: "chart.bar.xaxis",
        accent: "orange",
        items: [
            SidebarItem(id: "data-analysis/daily-analysis", title: "销售数据",
                        routePath: "/data-analysis/daily-analysis",
                        systemImage: "calendar", allowedRoles: []),
            SidebarItem(id: "data-analysis/financial-data", title: "月度财务分析",
                        routePath: "/data-analysis/financial-data",
                        systemImage: "dollarsign.circle", allowedRoles: []),
            SidebarItem(id: "data-analysis/return-analysis", title: "退货分析",
                        routePath: "/data-analysis/return-analysis",
                        systemImage: "arrow.uturn.backward", allowedRoles: []),
            SidebarItem(id: "data-analysis/weekly-product-analysis", title: "按周产品分析",
                        routePath: "/data-analysis/weekly-product-analysis",
                        systemImage: "calendar.badge.clock", allowedRoles: []),
            SidebarItem(id: "data-analysis/inventory-analysis", title: "库存分析",
                        routePath: "/data-analysis/inventory-analysis",
                        systemImage: "shippingbox", allowedRoles: []),
            SidebarItem(id: "data-analysis/inventory-replenishment", title: "补货分析",
                        routePath: "/data-analysis/inventory-replenishment",
                        systemImage: "arrow.triangle.2.circlepath", allowedRoles: []),
            SidebarItem(id: "data-analysis/seasonal-replenishment", title: "季节性补货分析",
                        routePath: "/data-analysis/seasonal-replenishment",
                        systemImage: "leaf", allowedRoles: []),
            SidebarItem(id: "data-analysis/project-goals", title: "目标管理",
                        routePath: "/data-analysis/project-goals",
                        systemImage: "target", allowedRoles: []),
            SidebarItem(id: "data-analysis/portfolio-overview", title: "投资组合概览",
                        routePath: "/data-analysis/portfolio-overview",
                        systemImage: "chart.pie", allowedRoles: []),
            SidebarItem(id: "data-analysis/research-analysis", title: "调研分析",
                        routePath: "/data-analysis/research-analysis",
                        systemImage: "magnifyingglass", allowedRoles: []),
            SidebarItem(id: "data-analysis/ad-analysis", title: "广告分析",
                        routePath: "/data-analysis/ad-analysis",
                        systemImage: "megaphone", allowedRoles: []),
        ],
        allowedRoles: []
    )

    static let dataManagement = SidebarGroup(
        id: "data-management",
        title: "数据管理",
        systemImage: "tablecells",
        accent: "teal",
        items: [
            SidebarItem(id: "data-management/exchange-rate", title: "汇率信息",
                        routePath: "/data-management/exchange-rate",
                        systemImage: "dollarsign.arrow.circlepath", allowedRoles: []),
            SidebarItem(id: "data-management/sku-info", title: "SKU 信息中心",
                        routePath: "/data-management/sku-info",
                        systemImage: "barcode", allowedRoles: []),
            SidebarItem(id: "data-management/platform-revenue", title: "平台回款",
                        routePath: "/data-management/platform-revenue",
                        systemImage: "creditcard", allowedRoles: []),
            SidebarItem(id: "data-management/platform-inspection", title: "平台巡检",
                        routePath: "/data-management/platform-inspection",
                        systemImage: "checklist", allowedRoles: []),
            SidebarItem(id: "data-management/report-upload", title: "报表上传",
                        routePath: "/data-management/report-upload",
                        systemImage: "arrow.up.doc", allowedRoles: []),
            SidebarItem(id: "data-management/report-reconciliation", title: "报表核对",
                        routePath: "/data-management/report-reconciliation",
                        systemImage: "arrow.triangle.swap", allowedRoles: []),
            SidebarItem(id: "data-management/shipment-management", title: "发货管理",
                        routePath: "/data-management/shipment-management",
                        systemImage: "truck.box", allowedRoles: []),
            SidebarItem(id: "data-management/vat-invoice", title: "VAT 发票生成器",
                        routePath: "/data-management/vat-invoice",
                        systemImage: "doc.richtext", allowedRoles: []),
            SidebarItem(id: "data-management/auto-upload", title: "报表自动化",
                        routePath: "/data-management/auto-upload",
                        systemImage: "gearshape.2", allowedRoles: []),
        ],
        allowedRoles: []
    )

    static let special = SidebarGroup(
        id: "special",
        title: "特殊功能",
        systemImage: "wand.and.stars",
        accent: "indigo",
        items: [
            SidebarItem(id: "special/markdown-to-word", title: "Markdown 转 Word",
                        routePath: "/special/markdown-to-word",
                        systemImage: "text.alignleft", allowedRoles: []),
            SidebarItem(id: "business-dev/overview", title: "业务开发概览",
                        routePath: "/business-dev/overview",
                        systemImage: "rectangle.stack", allowedRoles: [.businessdev, .admin]),
            SidebarItem(id: "business-dev/reports", title: "业务开发报告",
                        routePath: "/business-dev/reports",
                        systemImage: "doc.text.below.ecg", allowedRoles: [.businessdev, .admin]),
            SidebarItem(id: "business-dev/suppliers", title: "供应商管理",
                        routePath: "/business-dev/suppliers",
                        systemImage: "person.2", allowedRoles: [.businessdev, .admin]),
            SidebarItem(id: "digital-employees", title: "数字员工",
                        routePath: "/digital-employees",
                        systemImage: "person.crop.circle.badge.checkmark", allowedRoles: []),
        ],
        allowedRoles: []
    )

    static let system = SidebarGroup(
        id: "system",
        title: "系统管理",
        systemImage: "gearshape",
        accent: "gray",
        items: [
            SidebarItem(id: "system-management/account-management", title: "系统账号管理",
                        routePath: "/system-management/account-management",
                        systemImage: "person.crop.circle", allowedRoles: [.admin]),
            SidebarItem(id: "system-management/operator-management", title: "运营管理",
                        routePath: "/system-management/operator-management",
                        systemImage: "person.3", allowedRoles: [.admin]),
            SidebarItem(id: "system-management/commission-management", title: "佣金管理",
                        routePath: "/system-management/commission-management",
                        systemImage: "percent", allowedRoles: [.admin]),
            SidebarItem(id: "system-management/project-info", title: "项目信息",
                        routePath: "/system-management/project-info",
                        systemImage: "folder", allowedRoles: [.admin]),
            SidebarItem(id: "system-management/data-management", title: "数据库状态",
                        routePath: "/system-management/data-management",
                        systemImage: "cylinder.split.1x2", allowedRoles: [.admin]),
            SidebarItem(id: "system-management/notification-settings", title: "通知设置",
                        routePath: "/system-management/notification-settings",
                        systemImage: "bell", allowedRoles: []),
            SidebarItem(id: "system-management/backup-management", title: "备份管理",
                        routePath: "/system-management/backup-management",
                        systemImage: "externaldrive", allowedRoles: [.admin]),
            SidebarItem(id: "system-management/scheduled-reports", title: "定时报告",
                        routePath: "/system-management/scheduled-reports",
                        systemImage: "clock.arrow.circlepath", allowedRoles: [.admin]),
            SidebarItem(id: "system-management/logs", title: "日志查看",
                        routePath: "/system-management/logs",
                        systemImage: "doc.text.magnifyingglass", allowedRoles: [.admin]),
            SidebarItem(id: "system-management/digital-display", title: "数字大屏",
                        routePath: "/system-management/digital-display",
                        systemImage: "tv", allowedRoles: [.admin]),
        ],
        allowedRoles: [.admin, .operator, .businessdev]
    )
}