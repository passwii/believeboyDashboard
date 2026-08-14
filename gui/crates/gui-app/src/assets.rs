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

/// 全部内嵌图标路径（与 assets/icons/ 目录一致）
pub const ICON_PATHS: &[&str] = &[
    "icons/ai.svg",
    "icons/banknote.svg",
    "icons/bar-chart-3.svg",
    "icons/bell.svg",
    "icons/calculator.svg",
    "icons/calendar-range.svg",
    "icons/chart-column-big.svg",
    "icons/check-square.svg",
    "icons/clipboard-check.svg",
    "icons/coins.svg",
    "icons/database.svg",
    "icons/dollar-sign.svg",
    "icons/file-bar-chart.svg",
    "icons/file-code.svg",
    "icons/file-search.svg",
    "icons/file-text.svg",
    "icons/handshake.svg",
    "icons/history.svg",
    "icons/layers.svg",
    "icons/layout-dashboard.svg",
    "icons/messages-square.svg",
    "icons/package.svg",
    "icons/receipt.svg",
    "icons/repeat-2.svg",
    "icons/rotate-ccw.svg",
    "icons/settings.svg",
    "icons/shield.svg",
    "icons/shield-user.svg",
    "icons/shopping-bag.svg",
    "icons/sparkles.svg",
    "icons/store.svg",
    "icons/target.svg",
    "icons/trending-up.svg",
    "icons/truck.svg",
    "icons/users.svg",
    "icons/warehouse.svg",
    "icons/wrench.svg",
    "icons/zap.svg",
];

fn icon_file(path: &str) -> Option<Cow<'static, [u8]>> {
    let data: &'static [u8] = match path {
        "icons/ai.svg" => include_bytes!("../assets/icons/ai.svg"),
        "icons/banknote.svg" => include_bytes!("../assets/icons/banknote.svg"),
        "icons/bar-chart-3.svg" => include_bytes!("../assets/icons/bar-chart-3.svg"),
        "icons/bell.svg" => include_bytes!("../assets/icons/bell.svg"),
        "icons/calculator.svg" => include_bytes!("../assets/icons/calculator.svg"),
        "icons/calendar-range.svg" => include_bytes!("../assets/icons/calendar-range.svg"),
        "icons/chart-column-big.svg" => include_bytes!("../assets/icons/chart-column-big.svg"),
        "icons/check-square.svg" => include_bytes!("../assets/icons/check-square.svg"),
        "icons/clipboard-check.svg" => include_bytes!("../assets/icons/clipboard-check.svg"),
        "icons/coins.svg" => include_bytes!("../assets/icons/coins.svg"),
        "icons/database.svg" => include_bytes!("../assets/icons/database.svg"),
        "icons/dollar-sign.svg" => include_bytes!("../assets/icons/dollar-sign.svg"),
        "icons/file-bar-chart.svg" => include_bytes!("../assets/icons/file-bar-chart.svg"),
        "icons/file-code.svg" => include_bytes!("../assets/icons/file-code.svg"),
        "icons/file-search.svg" => include_bytes!("../assets/icons/file-search.svg"),
        "icons/file-text.svg" => include_bytes!("../assets/icons/file-text.svg"),
        "icons/handshake.svg" => include_bytes!("../assets/icons/handshake.svg"),
        "icons/history.svg" => include_bytes!("../assets/icons/history.svg"),
        "icons/layers.svg" => include_bytes!("../assets/icons/layers.svg"),
        "icons/layout-dashboard.svg" => include_bytes!("../assets/icons/layout-dashboard.svg"),
        "icons/messages-square.svg" => include_bytes!("../assets/icons/messages-square.svg"),
        "icons/package.svg" => include_bytes!("../assets/icons/package.svg"),
        "icons/receipt.svg" => include_bytes!("../assets/icons/receipt.svg"),
        "icons/repeat-2.svg" => include_bytes!("../assets/icons/repeat-2.svg"),
        "icons/rotate-ccw.svg" => include_bytes!("../assets/icons/rotate-ccw.svg"),
        "icons/settings.svg" => include_bytes!("../assets/icons/settings.svg"),
        "icons/shield.svg" => include_bytes!("../assets/icons/shield.svg"),
        "icons/shield-user.svg" => include_bytes!("../assets/icons/shield-user.svg"),
        "icons/shopping-bag.svg" => include_bytes!("../assets/icons/shopping-bag.svg"),
        "icons/sparkles.svg" => include_bytes!("../assets/icons/sparkles.svg"),
        "icons/store.svg" => include_bytes!("../assets/icons/store.svg"),
        "icons/target.svg" => include_bytes!("../assets/icons/target.svg"),
        "icons/trending-up.svg" => include_bytes!("../assets/icons/trending-up.svg"),
        "icons/truck.svg" => include_bytes!("../assets/icons/truck.svg"),
        "icons/users.svg" => include_bytes!("../assets/icons/users.svg"),
        "icons/warehouse.svg" => include_bytes!("../assets/icons/warehouse.svg"),
        "icons/wrench.svg" => include_bytes!("../assets/icons/wrench.svg"),
        "icons/zap.svg" => include_bytes!("../assets/icons/zap.svg"),
        _ => return None,
    };
    Some(Cow::Borrowed(data))
}
