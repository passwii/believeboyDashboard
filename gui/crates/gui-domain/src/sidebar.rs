//! sidebar 数据权威收编（GUI-3 / 0.3）
//!
//! 与 frontend `lib/sidebar-config.ts` 的 `SIDEBAR_TOP_GROUPS` **1:1 对应**
//! （label / url / matchPrefixes / icon 名称），不调后端、纯硬编码。
//!
//! 维护约定：
//! - **后续每次 frontend sidebar 变化，必须同步本模块**（通过 PR review 流程对齐）；
//! - 条目数核对表（2026-08-14，与 frontend 一致）：
//!   运营 15 + 报表中心 7 + 财务资金 4 + 广告 2 + AI 智能 7 + CRM 7 + 工具箱 2 + 系统管理 8 = **52 子项**；
//! - `icon` 字段存 frontend `IconMap` 的 key（如 `"LayoutDashboard"` / `"Sparkles"` / `"SettingsIcon"`），
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
                item(
                    "站点导航",
                    "/dashboard/operations/site-navigation",
                    "LayoutDashboard",
                ),
                item(
                    "店铺导航",
                    "/dashboard/operations/store-navigation",
                    "Store",
                ),
                item(
                    "销售数据",
                    "/dashboard/operations/daily-analysis",
                    "TrendingUp",
                ),
                item(
                    "退货分析",
                    "/dashboard/operations/return-analysis",
                    "RotateCcw",
                ),
                item("项目目标", "/dashboard/operations/project-goals", "Target"),
                item(
                    "调研分析",
                    "/dashboard/operations/research-analysis",
                    "FileSearch",
                ),
                item(
                    "平台巡检",
                    "/dashboard/operations/platform-inspection",
                    "Shield",
                ),
                item(
                    "库存分析",
                    "/dashboard/operations/inventory-analysis",
                    "Warehouse",
                ),
                item(
                    "按周产品分析",
                    "/dashboard/operations/weekly-product-analysis",
                    "BarChart3",
                ),
                item(
                    "组合分析",
                    "/dashboard/operations/portfolio-overview",
                    "Layers",
                ),
                item("SKU 信息", "/dashboard/operations/sku-info", "FileBarChart"),
                item(
                    "补货分析",
                    "/dashboard/operations/inventory-replenishment",
                    "Repeat2",
                ),
                item(
                    "库存分类账",
                    "/dashboard/operations/inventory-ledger",
                    "ClipboardCheck",
                ),
                item(
                    "季节性补货分析",
                    "/dashboard/operations/seasonal-replenishment",
                    "CalendarRange",
                ),
                item(
                    "发货管理",
                    "/dashboard/operations/shipment-management",
                    "Package",
                ),
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
                item(
                    "产品分析",
                    "/dashboard/reports/product-analysis",
                    "Calculator",
                ),
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
                item(
                    "平台回款",
                    "/dashboard/finance/platform-revenue",
                    "Banknote",
                ),
                item("汇率信息", "/dashboard/finance/exchange-rate", "DollarSign"),
                item("VAT 发票", "/dashboard/finance/vat-invoice", "Receipt"),
                item(
                    "佣金管理",
                    "/dashboard/finance/commission-management",
                    "Coins",
                ),
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
            icon: "Sparkles".into(),
            items: vec![
                item("AI洞察", "/dashboard/ai/insights", "TrendingUp"),
                item_with_prefixes(
                    "AI 广告分析",
                    "/dashboard/ai/ad-analysis",
                    &["/dashboard/ai/ad-analysis"],
                    "BarChart3",
                ),
                item("AI Chat", "/dashboard/ai/chat", "Sparkles"),
                item_with_prefixes(
                    "模型选型",
                    "/dashboard/ai/believeboy-models",
                    &["/dashboard/ai/believeboy-models"],
                    "FileText",
                ),
                item(
                    "客服交流",
                    "/dashboard/ai/customer-service",
                    "MessagesSquare",
                ),
                item("数字员工", "/dashboard/ai/digital-employees", "Users"),
                item(
                    "虚拟办公室",
                    "/dashboard/ai/digital-employees/office",
                    "LayoutDashboard",
                ),
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
                item(
                    "Markdown 转换",
                    "/dashboard/tools/markdown-to-word",
                    "FileText",
                ),
                item(
                    "Markdown/HTML 渲染",
                    "/dashboard/tools/page-render",
                    "FileCode",
                ),
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
                item(
                    "数据库状态",
                    "/dashboard/system/data-management",
                    "Database",
                ),
                item("账号管理", "/dashboard/system/account-management", "Users"),
                item(
                    "运营管理",
                    "/dashboard/system/operator-management",
                    "ShieldUser",
                ),
                item("告警中心", "/dashboard/system/alerts", "Bell"),
                item("日志查看", "/dashboard/system/logs", "History"),
                item(
                    "Agent 接入管理",
                    "/dashboard/system/agent-management",
                    "Shield",
                ),
            ],
        },
    ]
}

/// 由侧栏子项 url 解析面包屑路径（一级分类 → 二级标题），如
/// `/dashboard/operations/daily-analysis` → `["运营", "销售数据"]`。
///
/// 先按精确 url 匹配，再按 `match_prefixes` 前缀匹配（广告分析等带前缀项的
/// 深层子路径也能命中）；找不到返回 `None`（Dashboard 着陆页等侧栏之外页面）。
pub fn breadcrumb_for(url: &str) -> Option<Vec<String>> {
    for group in sidebar_groups() {
        for item in &group.items {
            let exact = item.url == url;
            let prefixed = item
                .match_prefixes
                .iter()
                .any(|p| url.starts_with(p.as_str()));
            if exact || prefixed {
                return Some(vec![group.label.clone(), item.title.clone()]);
            }
        }
    }
    None
}

/// 由子项 url 反查所属一级分类 id（BLF-793 Master Rail 选中态绑定用），如
/// `/dashboard/operations/daily-analysis` → `Some("operations")`。
///
/// 匹配规则与 [`breadcrumb_for`] 一致：先精确 url，再 `match_prefixes` 前缀；
/// 侧栏之外的 url（如 Dashboard 着陆页 `/dashboard`）返回 `None`。
pub fn group_id_for_url(url: &str) -> Option<String> {
    for group in sidebar_groups() {
        let hit = group.items.iter().any(|item| {
            item.url == url
                || item
                    .match_prefixes
                    .iter()
                    .any(|p| url.starts_with(p.as_str()))
        });
        if hit {
            return Some(group.id.clone());
        }
    }
    None
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
            let group = groups
                .iter()
                .find(|g| g.id == *id)
                .unwrap_or_else(|| panic!("缺少分组 {id}（frontend 8 大分类之一）"));
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

    /// P4-1：面包屑解析契约——常规项按精确 url 命中（一级分类 → 二级标题），
    /// 带 match_prefixes 的项按前缀命中，侧栏之外的 url（如 Dashboard 着陆页）返回 None。
    #[test]
    fn breadcrumb_for_resolves_group_and_item() {
        // 精确匹配（运营 → 销售数据）
        assert_eq!(
            breadcrumb_for("/dashboard/operations/daily-analysis"),
            Some(vec!["运营".to_string(), "销售数据".to_string()])
        );
        // 精确匹配（报表中心 → 定时报告）
        assert_eq!(
            breadcrumb_for("/dashboard/reports/scheduled-reports"),
            Some(vec!["报表中心".to_string(), "定时报告".to_string()])
        );
        // match_prefixes 前缀匹配（广告 → 广告分析：深层子路径也能命中）
        assert_eq!(
            breadcrumb_for("/dashboard/advertising/ad-analysis/overview"),
            Some(vec!["广告".to_string(), "广告分析".to_string()])
        );
        assert_eq!(
            breadcrumb_for("/dashboard/advertising/ad-analysis/campaign/123"),
            Some(vec!["广告".to_string(), "广告分析".to_string()])
        );
        // 侧栏之外的 url → None（Dashboard 着陆页）
        assert_eq!(breadcrumb_for("/dashboard"), None);
        assert_eq!(breadcrumb_for(""), None);
    }

    /// P4-1：面包屑解析对全部 52 个子项都必须命中（每个子项都能找到所属分类）。
    #[test]
    fn breadcrumb_for_covers_all_items() {
        for group in sidebar_groups() {
            for item in &group.items {
                let path = breadcrumb_for(&item.url).expect("子项 url 应能解析出面包屑");
                assert_eq!(path.len(), 2, "面包屑应有两级（分类 + 标题）");
                assert_eq!(path[0], group.label, "面包屑首级应是所属分类");
                assert_eq!(path[1], item.title, "面包屑末级应是子项标题");
            }
        }
    }

    /// BLF-793：url → 分类反查契约——全部 52 个子项（含 match_prefixes 深层
    /// 子路径）都能映射回自己的分类 id；侧栏之外 url 返回 None。
    #[test]
    fn group_id_for_url_covers_all_items() {
        for group in sidebar_groups() {
            for item in &group.items {
                assert_eq!(
                    group_id_for_url(&item.url).as_deref(),
                    Some(group.id.as_str()),
                    "子项 {} 应归属分类 {}",
                    item.url,
                    group.id
                );
                // match_prefixes 的深层子路径同样命中本分类
                for prefix in &item.match_prefixes {
                    assert_eq!(
                        group_id_for_url(prefix).as_deref(),
                        Some(group.id.as_str()),
                        "前缀 {prefix} 应归属分类 {}",
                        group.id
                    );
                }
            }
        }
        // 侧栏之外的 url → None（Dashboard 着陆页 / 空串）
        assert_eq!(group_id_for_url("/dashboard"), None);
        assert_eq!(group_id_for_url(""), None);
    }

    // -----------------------------------------------------------------------
    // BLF-794：与 frontend `lib/sidebar-config.ts` 的全量契约测试
    //
    // 直接解析 monorepo 内的 TS 权威文件，逐组逐项比对 label / url /
    // matchPrefixes / 图标名 / 顺序。任何一侧改动未同步另一侧时本测试立即失败。
    // -----------------------------------------------------------------------

    /// frontend sidebar-config.ts 的绝对路径（monorepo 根 = crate 的上三级）
    fn frontend_sidebar_config_path() -> std::path::PathBuf {
        let manifest = env!("CARGO_MANIFEST_DIR");
        std::path::Path::new(manifest)
            .join("../../../frontend/lib/sidebar-config.ts")
            .canonicalize()
            .expect("frontend/lib/sidebar-config.ts 必须存在于 monorepo 中")
    }

    /// 取 `marker` 之后的第一个单引号字符串字面量（TS 行内提取）
    fn quoted_after<'a>(line: &'a str, marker: &str) -> Option<&'a str> {
        let start = line.find(marker)? + marker.len();
        let rest = &line[start..];
        let open = rest.find('\'')? + 1;
        let close = rest[open..].find('\'')? + open;
        Some(&rest[open..close])
    }

    /// 取图标名：优先 `IconMap.X`；BLF-850 起兼容直接导入的 Lucide 图标
    /// （如 `icon: Sparkles`，无 IconMap 前缀）
    fn icon_after(line: &str) -> Option<String> {
        if let Some(idx) = line.find("IconMap.") {
            let idx = idx + "IconMap.".len();
            let ident: String = ident_at(&line[idx..]);
            return (!ident.is_empty()).then_some(ident);
        }
        let idx = line.find("icon:")? + "icon:".len();
        let ident = ident_at(line[idx..].trim_start());
        (!ident.is_empty()).then_some(ident)
    }

    /// 取一段文本开头的标识符（字母数字下划线）
    fn ident_at(s: &str) -> String {
        s.chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect()
    }

    /// 解析器自身契约：单行子项 / 多行子项 / matchPrefixes / 分组 icon 四种形态
    #[test]
    fn ts_parser_handles_all_item_shapes() {
        let src = r#"
export type SidebarSubItem = { title: string; url: string }
const IconMap = { Store, Bell }
export const SIDEBAR_TOP_GROUPS = [
  {
    id: 'operations',
    label: '运营',
    icon: IconMap.LayoutDashboard,
    items: [
      { title: '站点导航', url: '/a', icon: IconMap.Store },
      {
        title: '财务月报',
        url: '/b/display',
        matchPrefixes: ['/b'],
        icon: IconMap.FileBarChart,
      },
      {
        title: '客户',
        url: '/c',
        matchPrefixes: ['/c', '/sea'],
        icon: IconMap.Users,
      },
    ],
  },
  {
    id: 'ai',
    label: 'AI 智能',
    icon: Sparkles,
    items: [
      { title: 'AI Chat', url: '/d', icon: Sparkles },
    ],
  },
]
"#;
        let groups = parse_ts_groups(src);
        assert_eq!(groups.len(), 2);
        let g = &groups[0];
        assert_eq!(
            (g.id.as_str(), g.label.as_str(), g.icon.as_str()),
            ("operations", "运营", "LayoutDashboard")
        );
        assert_eq!(g.items.len(), 3);
        assert_eq!(
            g.items[0],
            TsItem {
                title: "站点导航".into(),
                url: "/a".into(),
                match_prefixes: vec![],
                icon: "Store".into()
            }
        );
        assert_eq!(g.items[1].match_prefixes, vec!["/b".to_string()]);
        assert_eq!(g.items[2].match_prefixes, vec!["/c", "/sea"]);
        // BLF-850：分组与子项的**直接导入图标**（无 IconMap 前缀）同样取到
        let ai = &groups[1];
        assert_eq!(ai.icon, "Sparkles", "分组裸标识符图标");
        assert_eq!(ai.items[0].icon, "Sparkles", "单行子项裸标识符图标");
    }

    /// 从 TS 源码提取的分组 / 子项原始条目
    #[derive(Debug, PartialEq, Eq)]
    struct TsGroup {
        id: String,
        label: String,
        icon: String,
        items: Vec<TsItem>,
    }

    #[derive(Debug, PartialEq, Eq)]
    struct TsItem {
        title: String,
        url: String,
        match_prefixes: Vec<String>,
        icon: String,
    }

    /// 顺序扫描 TS 文件的行流状态机（无正则依赖，纯字符串提取）：
    /// - `id: 'x'` → 新分组开始（冲刷上一个）
    /// - `label: 'x'` / `icon: IconMap.X` → 归属当前分组或当前子项
    /// - `title:` 行 → 当前分组内新子项（冲刷上一个；url 可同行或下一行）
    /// - `matchPrefixes: ['a', 'b']` → 归属当前子项
    ///
    /// 类型定义区（`title: string` 等）无引号字面量，不会误命中。
    fn parse_ts_groups(source: &str) -> Vec<TsGroup> {
        fn flush_item(group: &mut Option<TsGroup>, item: &mut Option<TsItem>) {
            if let (Some(g), Some(it)) = (group.as_mut(), item.take()) {
                g.items.push(it);
            }
        }

        /// 单行数组 `['a', 'b']` 内的字符串字面量
        fn quoted_list(line: &str) -> Vec<String> {
            let mut out = Vec::new();
            let Some(rest) = line.split("matchPrefixes:").nth(1) else {
                return out;
            };
            if let (Some(open), Some(close)) = (rest.find('['), rest.find(']')) {
                if open < close {
                    for part in rest[open + 1..close].split(',') {
                        let p = part.trim().trim_matches('\'');
                        if !p.is_empty() {
                            out.push(p.to_string());
                        }
                    }
                }
            }
            out
        }

        let mut groups: Vec<TsGroup> = Vec::new();
        let mut current_group: Option<TsGroup> = None;
        let mut current_item: Option<TsItem> = None;

        for raw_line in source.lines() {
            // 行首 `{` / 行尾 `,` 归一化（单行子项对象与多行对象统一处理）
            let line = raw_line
                .trim()
                .trim_start_matches('{')
                .trim_end_matches(',')
                .trim();
            if line.starts_with("//") || line.is_empty() {
                continue;
            }

            if line.starts_with("id:") {
                let Some(id) = quoted_after(line, "id:") else {
                    continue; // 类型定义区的 `id: string` 无字面量，跳过
                };
                flush_item(&mut current_group, &mut current_item);
                if let Some(prev) = current_group.take() {
                    groups.push(prev);
                }
                current_group = Some(TsGroup {
                    id: id.to_string(),
                    label: String::new(),
                    icon: String::new(),
                    items: Vec::new(),
                });
                continue;
            }
            if line.starts_with("label:") {
                if let Some(label) = quoted_after(line, "label:") {
                    if let Some(g) = current_group.as_mut() {
                        g.label = label.to_string();
                    }
                }
                continue;
            }
            if line.contains("matchPrefixes:") {
                let prefixes = quoted_list(line);
                if let Some(it) = current_item.as_mut() {
                    it.match_prefixes = prefixes;
                }
                continue;
            }
            if line.starts_with("title:") {
                let Some(title) = quoted_after(line, "title:") else {
                    continue; // `title: string` 类型定义行
                };
                flush_item(&mut current_group, &mut current_item);
                let mut item = TsItem {
                    title: title.to_string(),
                    url: String::new(),
                    match_prefixes: Vec::new(),
                    icon: String::new(),
                };
                // 单行子项：url / icon 与标题同行
                if let Some(url) = quoted_after(line, "url:") {
                    item.url = url.to_string();
                }
                if let Some(icon) = icon_after(line) {
                    item.icon = icon;
                }
                current_item = Some(item);
                continue;
            }
            if line.starts_with("url:") {
                if let Some(it) = current_item.as_mut() {
                    it.url = quoted_after(line, "url:").unwrap_or_default().to_string();
                }
                continue;
            }
            if line.starts_with("icon:") || line.contains("IconMap.") {
                if let Some(icon) = icon_after(line) {
                    if let Some(it) = current_item.as_mut() {
                        it.icon = icon;
                    } else if let Some(g) = current_group.as_mut() {
                        g.icon = icon;
                    }
                }
                continue;
            }
        }
        flush_item(&mut current_group, &mut current_item);
        if let Some(prev) = current_group.take() {
            groups.push(prev);
        }
        groups
    }

    /// BLF-794 全量契约：gui-domain 清单必须与 frontend sidebar-config.ts
    /// **一字不差**——8 组顺序一致、每组 label/icon 一致、全部 52 个子项
    /// title/url/matchPrefixes/icon 一致且顺序相同。
    #[test]
    fn matches_frontend_sidebar_config_contract() {
        let path = frontend_sidebar_config_path();
        let source =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("读取 {path:?} 失败：{e}"));
        let ts_groups = parse_ts_groups(&source);
        let rust_groups = sidebar_groups();

        assert_eq!(
            ts_groups.len(),
            8,
            "TS 文件应解析出 8 个一级分类（解析器漂移？）"
        );
        assert_eq!(ts_groups.len(), rust_groups.len(), "一级分类数不一致");

        for (ts, rs) in ts_groups.iter().zip(rust_groups.iter()) {
            assert_eq!(
                ts.id, rs.id,
                "分类 id 顺序不一致：TS={} Rust={}",
                ts.id, rs.id
            );
            assert_eq!(ts.label, rs.label, "分类 {} label 不一致", ts.id);
            assert_eq!(ts.icon, rs.icon, "分类 {} 图标不一致", ts.id);
            assert_eq!(
                ts.items.len(),
                rs.items.len(),
                "分类 {} 子项数不一致",
                ts.id
            );
            for (tsi, rsi) in ts.items.iter().zip(rs.items.iter()) {
                assert_eq!(tsi.title, rsi.title, "{}: 标题不一致", ts.id);
                assert_eq!(tsi.url, rsi.url, "{}: url 不一致", tsi.title);
                assert_eq!(
                    tsi.match_prefixes, rsi.match_prefixes,
                    "{}: matchPrefixes 不一致",
                    tsi.title
                );
                assert_eq!(tsi.icon, rsi.icon, "{}: 图标不一致", tsi.title);
            }
        }
    }
}
