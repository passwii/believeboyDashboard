//! 内嵌资源（AssetSource）
//!
//! 图标 SVG 通过 `include_bytes!` 编译进二进制，不依赖运行时文件路径
//! （.app bundle / 任意 cwd 启动都安全）。
//!
//! 图标来源：Lucide（ISC License，见 assets/icons/README.md），
//! `ai.svg` 为自定义「消息气泡 + 星芒」AI 标识。

use std::borrow::Cow;

use anyhow::Result;
use gpui::{AssetSource, SharedString};

/// GUI 应用的内嵌资源源
pub struct AppAssets;

impl AssetSource for AppAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(icon_file(path))
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        Ok(ICON_PATHS
            .iter()
            .copied()
            .filter(|p| path.is_empty() || p.starts_with(path))
            .map(SharedString::from)
            .collect())
    }
}

/// 全部内嵌图标路径（与 assets/icons/ 目录一致，按文件名排序）
pub const ICON_PATHS: &[&str] = &[
    "icons/ai.svg",
    "icons/arrow-down.svg",
    "icons/arrow-up.svg",
    "icons/banknote.svg",
    "icons/bar-chart-3.svg",
    "icons/bell.svg",
    "icons/calculator.svg",
    "icons/calendar-range.svg",
    "icons/chart-column-big.svg",
    "icons/check-square.svg",
    "icons/chevron-down.svg",
    "icons/chevron-up.svg",
    "icons/chevrons-up-down.svg",
    "icons/circle-check.svg",
    "icons/circle-x.svg",
    "icons/clipboard-check.svg",
    "icons/close.svg",
    "icons/coins.svg",
    "icons/database.svg",
    "icons/dollar-sign.svg",
    "icons/eye.svg",
    "icons/file-bar-chart.svg",
    "icons/file-code.svg",
    "icons/file-search.svg",
    "icons/file-text.svg",
    "icons/handshake.svg",
    "icons/history.svg",
    "icons/info.svg",
    "icons/layers.svg",
    "icons/layout-dashboard.svg",
    "icons/loader.svg",
    "icons/lock.svg",
    "icons/logo.svg",
    "icons/mail.svg",
    "icons/messages-square.svg",
    "icons/minus.svg",
    "icons/package.svg",
    "icons/receipt.svg",
    "icons/repeat-2.svg",
    "icons/rotate-ccw.svg",
    "icons/settings.svg",
    "icons/shield.svg",
    "icons/shield-user.svg",
    "icons/shopping-bag.svg",
    "icons/sort-ascending.svg",
    "icons/sort-descending.svg",
    "icons/sparkles.svg",
    "icons/store.svg",
    "icons/target.svg",
    "icons/trending-up.svg",
    "icons/triangle-alert.svg",
    "icons/truck.svg",
    "icons/users.svg",
    "icons/warehouse.svg",
    "icons/wrench.svg",
    "icons/zap.svg",
];

fn icon_file(path: &str) -> Option<Cow<'static, [u8]>> {
    let data: &'static [u8] = match path {
        "icons/ai.svg" => include_bytes!("../assets/icons/ai.svg"),
        "icons/arrow-down.svg" => include_bytes!("../assets/icons/arrow-down.svg"),
        "icons/arrow-up.svg" => include_bytes!("../assets/icons/arrow-up.svg"),
        "icons/banknote.svg" => include_bytes!("../assets/icons/banknote.svg"),
        "icons/bar-chart-3.svg" => include_bytes!("../assets/icons/bar-chart-3.svg"),
        "icons/bell.svg" => include_bytes!("../assets/icons/bell.svg"),
        "icons/calculator.svg" => include_bytes!("../assets/icons/calculator.svg"),
        "icons/calendar-range.svg" => include_bytes!("../assets/icons/calendar-range.svg"),
        "icons/chart-column-big.svg" => include_bytes!("../assets/icons/chart-column-big.svg"),
        "icons/check-square.svg" => include_bytes!("../assets/icons/check-square.svg"),
        "icons/chevron-down.svg" => include_bytes!("../assets/icons/chevron-down.svg"),
        "icons/chevron-up.svg" => include_bytes!("../assets/icons/chevron-up.svg"),
        "icons/chevrons-up-down.svg" => include_bytes!("../assets/icons/chevrons-up-down.svg"),
        "icons/circle-check.svg" => include_bytes!("../assets/icons/circle-check.svg"),
        "icons/circle-x.svg" => include_bytes!("../assets/icons/circle-x.svg"),
        "icons/clipboard-check.svg" => include_bytes!("../assets/icons/clipboard-check.svg"),
        "icons/close.svg" => include_bytes!("../assets/icons/close.svg"),
        "icons/coins.svg" => include_bytes!("../assets/icons/coins.svg"),
        "icons/database.svg" => include_bytes!("../assets/icons/database.svg"),
        "icons/dollar-sign.svg" => include_bytes!("../assets/icons/dollar-sign.svg"),
        "icons/eye.svg" => include_bytes!("../assets/icons/eye.svg"),
        "icons/file-bar-chart.svg" => include_bytes!("../assets/icons/file-bar-chart.svg"),
        "icons/file-code.svg" => include_bytes!("../assets/icons/file-code.svg"),
        "icons/file-search.svg" => include_bytes!("../assets/icons/file-search.svg"),
        "icons/file-text.svg" => include_bytes!("../assets/icons/file-text.svg"),
        "icons/handshake.svg" => include_bytes!("../assets/icons/handshake.svg"),
        "icons/history.svg" => include_bytes!("../assets/icons/history.svg"),
        "icons/info.svg" => include_bytes!("../assets/icons/info.svg"),
        "icons/layers.svg" => include_bytes!("../assets/icons/layers.svg"),
        "icons/layout-dashboard.svg" => include_bytes!("../assets/icons/layout-dashboard.svg"),
        "icons/loader.svg" => include_bytes!("../assets/icons/loader.svg"),
        "icons/lock.svg" => include_bytes!("../assets/icons/lock.svg"),
        "icons/logo.svg" => include_bytes!("../assets/icons/logo.svg"),
        "icons/mail.svg" => include_bytes!("../assets/icons/mail.svg"),
        "icons/messages-square.svg" => include_bytes!("../assets/icons/messages-square.svg"),
        "icons/minus.svg" => include_bytes!("../assets/icons/minus.svg"),
        "icons/package.svg" => include_bytes!("../assets/icons/package.svg"),
        "icons/receipt.svg" => include_bytes!("../assets/icons/receipt.svg"),
        "icons/repeat-2.svg" => include_bytes!("../assets/icons/repeat-2.svg"),
        "icons/rotate-ccw.svg" => include_bytes!("../assets/icons/rotate-ccw.svg"),
        "icons/settings.svg" => include_bytes!("../assets/icons/settings.svg"),
        "icons/shield.svg" => include_bytes!("../assets/icons/shield.svg"),
        "icons/shield-user.svg" => include_bytes!("../assets/icons/shield-user.svg"),
        "icons/shopping-bag.svg" => include_bytes!("../assets/icons/shopping-bag.svg"),
        "icons/sort-ascending.svg" => include_bytes!("../assets/icons/sort-ascending.svg"),
        "icons/sort-descending.svg" => include_bytes!("../assets/icons/sort-descending.svg"),
        "icons/sparkles.svg" => include_bytes!("../assets/icons/sparkles.svg"),
        "icons/store.svg" => include_bytes!("../assets/icons/store.svg"),
        "icons/target.svg" => include_bytes!("../assets/icons/target.svg"),
        "icons/trending-up.svg" => include_bytes!("../assets/icons/trending-up.svg"),
        "icons/triangle-alert.svg" => include_bytes!("../assets/icons/triangle-alert.svg"),
        "icons/truck.svg" => include_bytes!("../assets/icons/truck.svg"),
        "icons/users.svg" => include_bytes!("../assets/icons/users.svg"),
        "icons/warehouse.svg" => include_bytes!("../assets/icons/warehouse.svg"),
        "icons/wrench.svg" => include_bytes!("../assets/icons/wrench.svg"),
        "icons/zap.svg" => include_bytes!("../assets/icons/zap.svg"),
        _ => return None,
    };
    Some(Cow::Borrowed(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 资产契约（BLF-712）：`ICON_PATHS` 中登记的每个图标都必须能通过 `AppAssets`
    /// 解析出非空内容——防止「登记了路径但 `include_bytes` 表漏写」导致运行时图标空白。
    #[test]
    fn all_embedded_icons_resolve() {
        let assets = AppAssets;
        for path in ICON_PATHS {
            let data = assets
                .load(path)
                .unwrap_or_else(|e| panic!("{path} 加载报错: {e}"))
                .unwrap_or_else(|| panic!("{path} 未在 include_bytes 表中注册"));
            assert!(!data.is_empty(), "{path} 内容为空");
        }
    }

    /// 登录窗口专用图标（logo / mail / lock / eye）必须全部内嵌登记。
    ///
    /// - `eye.svg` 是 gpui-component `Input::mask_toggle` 的 `IconName::Eye` 解析路径
    ///   （icons/eye.svg），缺了密码显隐按钮会渲染空白。
    /// - `logo.svg` 承载 AppIcon 白色柱状图几何（渐变底由登录视图绘制）。
    #[test]
    fn login_window_icons_registered() {
        for path in [
            "icons/logo.svg",
            "icons/mail.svg",
            "icons/lock.svg",
            "icons/eye.svg",
        ] {
            assert!(ICON_PATHS.contains(&path), "{path} 不在 ICON_PATHS 中");
        }
    }
}
