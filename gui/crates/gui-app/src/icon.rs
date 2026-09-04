//! 图标 key → 内嵌 SVG 路径映射
//!
//! key 与 frontend `lib/sidebar-config.ts` 的 `IconMap` 键一一对应（如
//! `"LayoutDashboard"` / `"ChatGptIcon"` / `"SettingsIcon"`），保证 gui-domain
//! sidebar 数据里的 icon 名称能稳定解析到实际渲染资源。

/// frontend IconMap key → 内嵌图标资源路径
pub fn icon_path(icon_key: &str) -> &'static str {
    match icon_key {
        "LayoutDashboard" => "icons/layout-dashboard.svg",
        "MessagesSquare" => "icons/messages-square.svg",
        "Store" => "icons/store.svg",
        "ChatGptIcon" => "icons/ai.svg",
        "TrendingUp" => "icons/trending-up.svg",
        "Calculator" => "icons/calculator.svg",
        "FileBarChart" => "icons/file-bar-chart.svg",
        "BarChart3" => "icons/bar-chart-3.svg",
        "ClipboardCheck" => "icons/clipboard-check.svg",
        "CheckSquare" => "icons/check-square.svg",
        "Coins" => "icons/coins.svg",
        "History" => "icons/history.svg",
        "Package" => "icons/package.svg",
        "Receipt" => "icons/receipt.svg",
        "Repeat2" => "icons/repeat-2.svg",
        "Warehouse" => "icons/warehouse.svg",
        "RotateCcw" => "icons/rotate-ccw.svg",
        "Layers" => "icons/layers.svg",
        "FileSearch" => "icons/file-search.svg",
        "FileText" => "icons/file-text.svg",
        "FileCode" => "icons/file-code.svg",
        "Users" => "icons/users.svg",
        "Database" => "icons/database.svg",
        "Shield" => "icons/shield.svg",
        "DollarSign" => "icons/dollar-sign.svg",
        "Banknote" => "icons/banknote.svg",
        "Zap" => "icons/zap.svg",
        "Truck" => "icons/truck.svg",
        "ShoppingBag" => "icons/shopping-bag.svg",
        "ShieldUser" => "icons/shield-user.svg",
        "Sparkles" => "icons/sparkles.svg",
        "ChartColumnBig" => "icons/chart-column-big.svg",
        "Bell" => "icons/bell.svg",
        "CalendarRange" => "icons/calendar-range.svg",
        "Handshake" => "icons/handshake.svg",
        "Target" => "icons/target.svg",
        "SettingsIcon" => "icons/settings.svg",
        "Wrench" => "icons/wrench.svg",
        _ => "icons/layout-dashboard.svg",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gui_domain::sidebar::sidebar_groups;
    use std::collections::HashSet;

    /// 侧栏数据里的每一个 icon 名称都必须有显式映射（不允许落到兜底图标）。
    #[test]
    fn every_sidebar_icon_has_explicit_path() {
        let groups = sidebar_groups();
        let known = groups
            .iter()
            .flat_map(|g| {
                std::iter::once(g.icon.as_str()).chain(g.items.iter().map(|it| it.icon.as_str()))
            })
            .collect::<HashSet<_>>();

        // 兜底路径应只被未知 key 命中；这里要求所有实际用到的 key 都有显式分支
        for key in &known {
            let path = icon_path(key);
            assert!(
                path != "icons/layout-dashboard.svg" || *key == "LayoutDashboard",
                "icon key {key} 落到了兜底图标，请在 icon.rs 补映射"
            );
        }
    }

    /// 映射出的资源路径必须真实存在于内嵌资产表。
    #[test]
    fn mapped_paths_exist_in_assets() {
        use crate::assets::ICON_PATHS;
        for key in [
            "LayoutDashboard",
            "ChatGptIcon",
            "SettingsIcon",
            "Wrench",
            "Banknote",
        ] {
            let path = icon_path(key);
            assert!(
                ICON_PATHS.contains(&path),
                "icon key {key} → {path} 不在 ICON_PATHS 中"
            );
        }
    }
}
