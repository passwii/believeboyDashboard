//! sidebar 数据权威收编（GUI-3 / 0.3）
//!
//! 与 frontend `lib/sidebar-config.ts` 的 `SIDEBAR_TOP_GROUPS` **1:1 对应**
//! （label / url / matchPrefixes / icon 名称），不调后端、纯硬编码。
//!
//! 维护约定：
//! - **后续每次 frontend sidebar 变化，必须同步本模块**（通过 PR review 流程对齐）；
//! - 条目数核对表（2026-08-14，与 frontend 一致）：
//!   运营 15 + 报表中心 7 + 财务资金 4 + 广告 2 + AI 智能 7 + CRM 7 + 工具箱 2 + 系统管理 8 = **52 子项**；
//! - `icon` 字段存 frontend `IconMap` 的 key（如 `"LayoutDashboard"` / `"ChatGptIcon"` / `"SettingsIcon"`），
//!   GUI 端暂不做图标渲染，仅保留名称以便未来 1:1 映射。

use serde::{Deserialize, Serialize};

/// 二级菜单项（对应 frontend `SidebarSubItem`）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SidebarItem {
    pub title: String,
    pub url: String,
    /// 前缀匹配路径（对应 frontend `matchPrefixes`，用于激活态判定）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub match_prefixes: Vec<String>,
    /// 图标名称（frontend `IconMap` 的 key，如 `"LayoutDashboard"`）
    pub icon: String,
}

/// 一级分类（对应 frontend `SidebarTopGroup`）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SidebarGroup {
    pub id: String,
    pub label: String,
    /// 分组图标名称（frontend `IconMap` 的 key）
    pub icon: String,
    pub items: Vec<SidebarItem>,
}

/// 8 个一级分类 + 全部二级子项的权威数据（与 frontend `SIDEBAR_TOP_GROUPS` 顺序一致）。
pub fn sidebar_groups() -> Vec<SidebarGroup> {
    vec![
        // 1. 运营（15 项）
        SidebarGroup {
            id: "operations".into(),
            label: "运营".into(),
            icon: "LayoutDashboard".into(),
            items: vec![
                item("站点导航", "/dashboard/operations/site-navigation", "LayoutDashboard"),
                item("店铺导航", "/dashboard/operations/store-navigation", "Store"),
                item("销售数据", "/dashboard/operations/daily-analysis", "TrendingUp"),
                item("退货分析", "/dashboard/operations/return-analysis", "RotateCcw"),
                item("项目目标", "/dashboard/operations/project-goals", "Target"),
                item("调研分析", "/dashboard/operations/research-analysis", "FileSearch"),
                item("平台巡检", "/dashboard/operations/platform-inspection", "Shield"),
                item("库存分析", "/dashboard/operations/inventory-analysis", "Warehouse"),
                item("按周产品分析", "/dashboard/operations/weekly-product-analysis", "BarChart3"),
                item("组合分析", "/dashboard/operations/portfolio-overview", "Layers"),
                item("SKU 信息", "/dashboard/operations/sku-info", "FileBarChart"),
                item("补货分析", "/dashboard/operations/inventory-replenishment", "Repeat2"),
                item("库存分类账", "/dashboard/operations/inventory-ledger", "ClipboardCheck"),
                item("季节性补货分析", "/dashboard/operations/seasonal-replenishment", "CalendarRange"),
                item("发货管理", "/dashboard/operations/shipment-management", "Package"),
            ],
        },
        // 2. 报表中心（7 项）
        SidebarGroup {
            id: "reports".into(),
            label: "报表中心".into(),
            icon: "FileBarChart".into(),
            items: vec![
                item_with_prefixes(
                    "财务月报",
                    "/dashboard/reports/monthly-report/display",
                    &["/dashboard/reports/monthly-report"],
                    "FileBarChart",
                ),
                item("产品分析", "/dashboard/reports/product-analysis", "Calculator"),
                item_with_prefixes(
                    "新品核算",
                    "/dashboard/reports/pricing-calculation/new-product",
                    &["/dashboard/reports/pricing-calculation/new-product"],
                    "Coins",
                ),
                item_with_prefixes(
                    "店铺测算",
                    "/dashboard/reports/pricing-calculation/shop-calculation",
                    &["/dashboard/reports/pricing-calculation/shop-calculation"],
                    "Store",
                ),
                item_with_prefixes(
                    "定时报告",
                    "/dashboard/reports/scheduled-reports",
                    &["/dashboard/reports/scheduled-reports"],
                    "Zap",
                ),
                item("报表自动化", "/dashboard/reports/auto-upload", "Repeat2"),
                item("订单信息", "/dashboard/reports/order-info", "ShoppingBag"),
            ],
        },
        // 3. 财务资金（4 项）
        SidebarGroup {
            id: "finance".into(),
            label: "财务资金".into(),
            icon: "DollarSign".into(),
            items: vec![
                item("平台回款", "/dashboard/finance/platform-revenue", "Banknote"),
                item("汇率信息", "/dashboard/finance/exchange-rate", "DollarSign"),
                item("VAT 发票", "/dashboard/finance/vat-invoice", "Receipt"),
                item("佣金管理", "/dashboard/finance/commission-management", "Coins"),
            ],
        },
        // 4. 广告（2 项）
        SidebarGroup {
            id: "advertising".into(),
            label: "广告".into(),
            icon: "BarChart3".into(),
            items: vec![
                item_with_prefixes(
                    "广告分析",
                    "/dashboard/advertising/ad-analysis/overview",
                    &["/dashboard/advertising/ad-analysis"],
                    "BarChart3",
                ),
                item_with_prefixes(
                    "广告数据",
                    "/dashboard/advertising/ad-data",
                    &["/dashboard/advertising/ad-data"],
                    "Database",
                ),
            ],
        },
        // 5. AI 智能（7 项）
        SidebarGroup {
            id: "ai".into(),
            label: "AI 智能".into(),
            icon: "ChatGptIcon".into(),
            items: vec![
                item("AI洞察", "/dashboard/ai/insights", "TrendingUp"),
                item_with_prefixes(
                    "AI 广告分析",
                    "/dashboard/ai/ad-analysis",
                    &["/dashboard/ai/ad-analysis"],
                    "BarChart3",
                ),
                item("AI Chat", "/dashboard/ai/chat", "ChatGptIcon"),
                item_with_prefixes(
                    "模型选型",
                    "/dashboard/ai/believeboy-models",
                    &["/dashboard/ai/believeboy-models"],
                    "FileText",
                ),
                item("客服交流", "/dashboard/ai/customer-service", "MessagesSquare"),
                item("数字员工", "/dashboard/ai/digital-employees", "Users"),
                item("虚拟办公室", "/dashboard/ai/digital-employees/office", "LayoutDashboard"),
            ],
        },
        // 6. CRM 客户与合作伙伴（7 项）
        SidebarGroup {
            id: "crm".into(),
            label: "CRM 客户与合作伙伴".into(),
            icon: "Handshake".into(),
            items: vec![
                item_with_prefixes(
                    "数据看板",
                    "/dashboard/crm/dashboard",
                    &["/dashboard/crm/dashboard"],
                    "BarChart3",
                ),
                item_with_prefixes(
                    "待跟进",
                    "/dashboard/crm/follow-ups",
                    &["/dashboard/crm/follow-ups"],
                    "Bell",
                ),
                item_with_prefixes(
                    "客户",
                    "/dashboard/crm/customers",
                    &["/dashboard/crm/customers", "/dashboard/crm/sea"],
                    "Users",
                ),
                item_with_prefixes(
                    "线索",
                    "/dashboard/crm/leads",
                    &["/dashboard/crm/leads"],
                    "Sparkles",
                ),
                item_with_prefixes(
                    "任务",
                    "/dashboard/crm/tasks",
                    &["/dashboard/crm/tasks"],
                    "CheckSquare",
                ),
                item_with_prefixes(
                    "操作日志",
                    "/dashboard/crm/audit",
                    &["/dashboard/crm/audit"],
                    "History",
                ),
                item("CRM 设置", "/dashboard/crm/settings", "SettingsIcon"),
            ],
        },
        // 7. 工具箱（2 项）
        SidebarGroup {
            id: "tools".into(),
            label: "工具箱".into(),
            icon: "Wrench".into(),
            items: vec![
                item("Markdown 转换", "/dashboard/tools/markdown-to-word", "FileText"),
                item("Markdown/HTML 渲染", "/dashboard/tools/page-render", "FileCode"),
            ],
        },
        // 8. 系统管理（8 项）
        SidebarGroup {
            id: "system".into(),
            label: "系统管理".into(),
            icon: "ShieldUser".into(),
            items: vec![
                item("更新日志", "/dashboard/system/changelog", "History"),
                item("项目信息", "/dashboard/system/project-info", "Store"),
                item("数据库状态", "/dashboard/system/data-management", "Database"),
                item("账号管理", "/dashboard/system/account-management", "Users"),
                item("运营管理", "/dashboard/system/operator-management", "ShieldUser"),
                item("告警中心", "/dashboard/system/alerts", "Bell"),
                item("日志查看", "/dashboard/system/logs", "History"),
                item("Agent 接入管理", "/dashboard/system/agent-management", "Shield"),
            ],
        },
    ]
}

/// 分组数（固定 8）。
pub fn group_count() -> usize {
    sidebar_groups().len()
}

/// 二级子项总数（固定 52，与 frontend 核对表一致）。
pub fn item_count() -> usize {
    sidebar_groups().iter().map(|g| g.items.len()).sum()
}

fn item(title: &str, url: &str, icon: &str) -> SidebarItem {
    SidebarItem {
        title: title.into(),
        url: url.into(),
        match_prefixes: Vec::new(),
        icon: icon.into(),
    }
}

fn item_with_prefixes(title: &str, url: &str, prefixes: &[&str], icon: &str) -> SidebarItem {
    SidebarItem {
        title: title.into(),
        url: url.into(),
        match_prefixes: prefixes.iter().map(|s| s.to_string()).collect(),
        icon: icon.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// frontend `lib/sidebar-config.ts` 条目数核对表（2026-08-14 对齐）：
    /// 运营 15 + 报表中心 7 + 财务资金 4 + 广告 2 + AI 智能 7 + CRM 7 + 工具箱 2 + 系统管理 8 = 52
    const EXPECTED_PER_GROUP: &[(&str, usize)] = &[
        ("operations", 15),
        ("reports", 7),
        ("finance", 4),
        ("advertising", 2),
        ("ai", 7),
        ("crm", 7),
        ("tools", 2),
        ("system", 8),
    ];

    #[test]
    fn group_and_item_counts_match_frontend() {
        let groups = sidebar_groups();
        assert_eq!(groups.len(), 8, "一级分类应为 8 个");
        assert_eq!(item_count(), 52, "二级子项总数应为 52（与 frontend 一致）");
    }

    #[test]
    fn per_group_counts_match_frontend() {
        let groups = sidebar_groups();
        for (id, expected) in EXPECTED_PER_GROUP {
            let group = groups.iter().find(|g| g.id == *id).unwrap_or_else(|| {
                panic!("缺少分组 {id}（frontend 8 大分类之一）")
            });
            assert_eq!(
                group.items.len(),
                *expected,
                "分组 {id}({}) 子项数应等于 frontend 的 {expected}",
                group.label
            );
        }
    }

    #[test]
    fn group_ids_are_unique() {
        let groups = sidebar_groups();
        let mut ids: Vec<&str> = groups.iter().map(|g| g.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), groups.len(), "分组 id 不允许重复");
    }

    #[test]
    fn item_urls_are_unique() {
        let groups = sidebar_groups();
        let mut urls: Vec<&str> = groups
            .iter()
            .flat_map(|g| g.items.iter().map(|it| it.url.as_str()))
            .collect();
        urls.sort_unstable();
        let before = urls.len();
        urls.dedup();
        assert_eq!(urls.len(), before, "子项 url 不允许重复");
    }

    #[test]
    fn every_item_has_title_url_icon() {
        for group in sidebar_groups() {
            assert!(!group.label.is_empty(), "分组 {} 缺 label", group.id);
            assert!(!group.icon.is_empty(), "分组 {} 缺 icon", group.id);
            for item in group.items {
                assert!(!item.title.is_empty(), "{} 缺 title", item.url);
                assert!(!item.url.is_empty(), "{} 缺 url", item.title);
                assert!(!item.icon.is_empty(), "{} 缺 icon", item.title);
            }
        }
    }

    #[test]
    fn serde_roundtrip() {
        let groups = sidebar_groups();
        let json = serde_json::to_string(&groups).expect("序列化失败");
        let back: Vec<SidebarGroup> = serde_json::from_str(&json).expect("反序列化失败");
        assert_eq!(groups, back);
    }
}
