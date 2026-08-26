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
    "icons/search.svg",
    "icons/settings.svg",
    // BLF-828：Windows caption buttons 四图标（最小化/最大化/还原/关闭；
    // 形状对齐 Lucide minus / square / copy / x，stroke 惯例同目录其余图标）
    "icons/window-close.svg",
    "icons/window-maximize.svg",
    "icons/window-minimize.svg",
    "icons/window-restore.svg",
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
        "icons/search.svg" => include_bytes!("../assets/icons/search.svg"),
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
        "icons/window-close.svg" => include_bytes!("../assets/icons/window-close.svg"),
        "icons/window-maximize.svg" => include_bytes!("../assets/icons/window-maximize.svg"),
        "icons/window-minimize.svg" => include_bytes!("../assets/icons/window-minimize.svg"),
        "icons/window-restore.svg" => include_bytes!("../assets/icons/window-restore.svg"),
        _ => return None,
    };
    Some(Cow::Borrowed(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 资源注册契约：ICON_PATHS 列出的每个图标都必须能被 icon_file 解析
    /// （include_bytes 编译期已保证文件存在；本测试防「列表有、映射漏」的疏漏）。
    #[test]
    fn all_icon_paths_resolve() {
        for path in ICON_PATHS {
            assert!(icon_file(path).is_some(), "图标未在 icon_file 注册: {path}");
        }
    }

    /// 登录窗新增资源（BLF-712）显式在列：应用 logo / 邮箱 / 密码锁 / 显隐眼
    /// （eye.svg 是 gpui-component `Input::mask_toggle` 的 `IconName::Eye` 解析路径，
    /// 缺了密码显隐按钮图标会渲染空白）。
    #[test]
    fn login_icons_are_registered() {
        for path in [
            "icons/logo.svg",
            "icons/mail.svg",
            "icons/lock.svg",
            "icons/eye.svg",
        ] {
            assert!(ICON_PATHS.contains(&path), "缺少登录窗图标 {path}");
            assert!(icon_file(path).is_some());
        }
    }

    /// BLF-712：logo.svg 渲染契约——用 gpui 同款 SVG 渲染器（resvg/usvg）离屏渲染
    /// 256×256，验证白色图形层几何与 make-icon.py（AppIcon.icns）一致：
    /// 4 根柱状图不透明白、柱间隙透明（渐变底由登录视图 linear_gradient 绘制，
    /// 本文件不携带背景）、上升趋势箭头存在、圆角外/图形外全透明。
    #[test]
    fn logo_svg_renders_big_sur_icon_geometry() {
        let svg = icon_file("icons/logo.svg").expect("logo.svg 已注册");
        let tree = resvg::usvg::Tree::from_data(&svg, &resvg::usvg::Options::default())
            .expect("logo.svg 可被 usvg 解析");
        let mut pixmap = resvg::tiny_skia::Pixmap::new(256, 256).expect("256×256 pixmap 创建成功");

        let scale = 256.0 / tree.size().width();
        resvg::render(
            &tree,
            resvg::usvg::Transform::from_scale(scale, scale),
            &mut pixmap.as_mut(),
        );

        let px = |x: u32, y: u32| pixmap.pixel(x, y).expect("采样点越界");
        let lum = |c: &resvg::tiny_skia::PremultipliedColorU8| {
            c.red() as u32 + c.green() as u32 + c.blue() as u32
        };

        // 1. 图形外（左上角 5,5，无渐变底/圆角方块）→ 透明
        assert_eq!(px(5, 5).alpha(), 0, "图形外必须透明");

        // 2. 柱状图第 4 根（SVG≈(692,520)，bar4 x645-740/y370-682）→ 不透明白
        let bar = px(173, 130);
        assert_eq!(bar.alpha(), 255, "柱状图必须不透明");
        assert!(lum(&bar) > 740, "柱状图应为白色，实际亮度 {}", lum(&bar));

        // 3. 柱间隙（SVG≈(508,560)，bar2 x403-498 与 bar3 x524-619 之间）→ 透明
        //    （渐变背景由登录视图 linear_gradient 绘制，不在本 SVG 内）
        let gap = px(127, 140);
        assert_eq!(gap.alpha(), 0, "柱间隙应透明（渐变底由视图绘制）");

        // 4. 趋势箭头第 2 段中线（SVG≈(632,450)，线段 524,484→740,416）→ 不透明白
        let tip = px(158, 112);
        assert_eq!(tip.alpha(), 255, "趋势箭头必须存在且不透明");
        assert!(lum(&tip) > 740, "箭头应为白色，实际亮度 {}", lum(&tip));
    }
}
