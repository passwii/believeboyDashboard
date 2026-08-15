//! 视觉 token 模块（P2-2 主题系统基线，BLF-689）
//!
//! 三层设计：
//! 1. **外观层**：gpui-component `Theme`（`cx.theme()`）管理全局亮/暗外观，
//!    由 `main.rs` 的窗口外观监听自动跟随系统（`Theme::sync_system_appearance`）；
//!    用户偏好（跟随系统/浅色/深色）见 [`ThemePreference`] + [`ThemePref`]。
//! 2. **语义层**：[`AppTheme`] 从当前外观派生出业务语义色板——背景层级
//!    （window/sidebar/card）、文字层级、强调色、分隔线、成功/警告/危险状态色。
//!    视图只消费 `AppTheme`，不散落十六进制字面量。
//! 3. **度量层**：间距以 gpui 内建 4px 尺度工具（`.px_1/2/4`、`.gap_1/2/…`）与
//!    [`SPACE_*`]（仅自定义大间距）为准；圆角/字号沿用 gpui-component
//!    `Theme::radius / radius_lg / font_size` 与 gpui 的 `text_xs/sm/base/...`
//!    系统字体层级（macOS HIG 系统排版，不另造轮子）。
//!
//! 迁移说明：此前 `Theme::dark_sidebar_light_content()`（深侧栏+浅内容区混合外观）
//! 已废弃——跟随系统后侧栏与内容区同亮同暗，语义字段全部收敛到 [`AppTheme`]。

use gpui::{point, px, rgb, App, BoxShadow, Hsla, Window};
use gpui_component::{ActiveTheme, ThemeMode};

/// 4px 间距尺度上的常用大间距（间距 token；小间距直接用 gpui 的 `.px_*/.gap_*`
/// 4px 工具类，语义一致，不重复定义）
pub const SPACE_10: f32 = 40.0;
pub const SPACE_12: f32 = 48.0;

/// 主题偏好：跟随系统（默认）/ 浅色 / 深色
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThemePreference {
    /// 跟随系统外观（默认）；系统切亮/暗时应用无感跟随
    #[default]
    FollowSystem,
    Light,
    Dark,
}

impl ThemePreference {
    /// 菜单显示名
    pub fn label(self) -> &'static str {
        match self {
            Self::FollowSystem => "跟随系统",
            Self::Light => "浅色",
            Self::Dark => "深色",
        }
    }

    /// 是否强制指定外观（非跟随系统）
    pub fn is_explicit(self) -> bool {
        !matches!(self, Self::FollowSystem)
    }
}

/// 全局主题偏好（`cx.set_global` / `cx.global`）；默认跟随系统
#[derive(Debug, Clone, Copy, Default)]
pub struct ThemePref(pub ThemePreference);

impl gpui::Global for ThemePref {}

/// 应用主题偏好到全局外观
///
/// - 跟随系统 → `sync_system_appearance`（取窗口当前外观）
/// - 浅色/深色 → 强制 `ThemeMode`
///
/// `window` 传 `Some` 时同步触发该窗口重绘（无闪烁：单帧内完成换肤）。
pub fn set_theme_pref(pref: ThemePreference, window: Option<&mut Window>, cx: &mut App) {
    cx.set_global(ThemePref(pref));
    match pref {
        ThemePreference::FollowSystem => gpui_component::Theme::sync_system_appearance(window, cx),
        ThemePreference::Light => gpui_component::Theme::change(ThemeMode::Light, window, cx),
        ThemePreference::Dark => gpui_component::Theme::change(ThemeMode::Dark, window, cx),
    }
}

/// 窗口外观变化回调（由 `Window::observe_window_appearance` 注册）。
///
/// 仅「跟随系统」偏好下同步外观；显式浅色/深色时忽略系统变化。
pub fn on_window_appearance_changed(window: &mut Window, cx: &mut App) {
    let pref = cx
        .try_global::<ThemePref>()
        .map(|p| p.0)
        .unwrap_or_default();
    if !pref.is_explicit() {
        gpui_component::Theme::sync_system_appearance(Some(window), cx);
    }
}

/// 语义色板（业务语义层，从当前外观派生）
///
/// 色值设计对齐 macOS HIG 系统语义色（windowBackground / sidebar / separator /
/// controlAccent）+ frontend 品牌蓝（blue-500），亮暗两态各自成组。
#[derive(Clone, Copy, Debug)]
pub struct AppTheme {
    /// 当前是否深色外观（跟随系统/显式深色）
    pub dark: bool,

    // ---- 度量 token（圆角；由 gpui-component 主题派生，亮暗一致）----
    /// 通用元素圆角（px）
    pub radius: f32,
    /// 大元素圆角（px，Dialog/卡片等）
    pub radius_lg: f32,
    // ---- 背景层级 ----
    /// 内容区画布（windowBackground）
    pub window_bg: Hsla,
    /// 卡片表面
    pub card_bg: Hsla,
    /// 中性浅填充（图表占位区 / 徽标底 / hover 反馈）
    pub muted_fill: Hsla,
    /// 分隔线（separator）
    pub separator: Hsla,
    /// 卡片轻投影色（macOS 原生卡片：柔和低透明度阴影，亮暗两态各自成组）
    pub card_shadow: Hsla,

    // ---- 侧栏（跟随系统亮/暗）----
    pub sidebar_bg: Hsla,
    pub sidebar_border: Hsla,
    pub sidebar_text: Hsla,
    pub sidebar_group_text: Hsla,
    pub sidebar_item_hover: Hsla,
    pub sidebar_item_active_bg: Hsla,
    pub sidebar_item_active_text: Hsla,
    /// 选中胶囊的柔和投影色（macOS 浅色侧栏选中项带轻投影）
    pub sidebar_item_shadow: Hsla,
    pub sidebar_footer_text: Hsla,

    // ---- 文字层级 ----
    pub text_primary: Hsla,
    pub text_secondary: Hsla,
    pub text_muted: Hsla,

    // ---- 强调 / 状态 ----
    /// 强调色（controlAccent，品牌蓝）
    pub accent: Hsla,
    /// 强调色 hover（登录按钮等按压反馈）
    pub accent_hover: Hsla,
    /// 强调色上的前景（accent 背景上的文字/图标）
    pub on_accent: Hsla,
    /// 强调色浅底（徽标/图标气泡背景）
    pub accent_soft: Hsla,
    /// 品牌主色（侧栏品牌块）
    pub brand: Hsla,
    /// 品牌块上的前景点/字
    pub brand_soft: Hsla,
    /// 成功（涨/通过）
    pub success: Hsla,
    /// 警告（警示横幅）
    pub warning: Hsla,
    /// 危险（跌/错误）
    pub danger: Hsla,
    /// 成功浅底（涨 delta 徽章背景，`success` 的低透明度派生）
    pub success_soft: Hsla,
    /// 危险浅底（跌 delta 徽章背景，`danger` 的低透明度派生）
    pub danger_soft: Hsla,
}

impl AppTheme {
    /// 当前是否深色外观
    pub fn is_dark(&self) -> bool {
        self.dark
    }

    /// 浅色外观语义色板
    pub fn light() -> Self {
        Self {
            dark: false,

            // 度量 token
            radius: 6.0,
            radius_lg: 8.0,

            // 背景层级（macOS light：画布 neutral-100、卡片白、分隔 neutral-200）
            window_bg: c(0xf5f5f5),
            card_bg: c(0xffffff),
            muted_fill: c(0xf5f5f5),
            separator: c(0xe5e5e5),
            card_shadow: c(0x000000).alpha(0.06),

            // 侧栏（浅色：macOS 浅侧栏，选中白胶囊 + 轻投影）
            sidebar_bg: c(0xececec),
            sidebar_border: c(0xd4d4d8),
            sidebar_text: c(0x3f3f46),
            sidebar_group_text: c(0x71717a),
            sidebar_item_hover: c(0xd9d9de),
            sidebar_item_active_bg: c(0xffffff),
            sidebar_item_active_text: c(0x18181b),
            sidebar_item_shadow: c(0x000000).alpha(0.09),
            sidebar_footer_text: c(0x71717a),

            // 文字层级
            text_primary: c(0x0a0a0a),
            text_secondary: c(0x525252),
            text_muted: c(0x737373),

            // 强调 / 状态
            accent: c(0x3b82f6),       // blue-500
            accent_hover: c(0x2563eb), // blue-600（hover 加深）
            on_accent: c(0xffffff),
            accent_soft: c(0xeff6ff), // blue-50
            brand: c(0x3b82f6),       // blue-500
            brand_soft: c(0xeff6ff),  // blue-50（brand 方块上的内点）
            success: c(0x22c55e),     // green-500（涨）
            warning: c(0xd97706),     // amber-600
            danger: c(0xef4444),      // red-500（跌）
            success_soft: c(0x22c55e).alpha(0.12),
            danger_soft: c(0xef4444).alpha(0.12),
        }
    }

    /// 深色外观语义色板
    pub fn dark() -> Self {
        Self {
            dark: true,

            // 度量 token
            radius: 6.0,
            radius_lg: 8.0,

            // 背景层级（对齐 gpui-component 默认深色：画布 #0a0a0a、卡片 zinc-900）
            window_bg: c(0x0a0a0a),
            card_bg: c(0x18181b),
            muted_fill: c(0x171717),
            separator: c(0x27272a),
            card_shadow: c(0x000000).alpha(0.40),

            // 侧栏（深色：zinc-900，对齐 frontend 深侧栏）
            sidebar_bg: c(0x18181b),
            sidebar_border: c(0x27272a),
            sidebar_text: c(0xd4d4d8),
            sidebar_group_text: c(0x71717a),
            sidebar_item_hover: c(0x27272a),
            sidebar_item_active_bg: c(0x3f3f46),
            sidebar_item_active_text: c(0xffffff),
            sidebar_item_shadow: c(0x000000).alpha(0.30),
            sidebar_footer_text: c(0x71717a),

            // 文字层级
            text_primary: c(0xfafafa),
            text_secondary: c(0xa1a1aa),
            text_muted: c(0x71717a),

            // 强调 / 状态（深色下提亮保证对比度）
            accent: c(0x60a5fa),       // blue-400
            accent_hover: c(0x3b82f6), // blue-500（hover 加深）
            on_accent: c(0xffffff),
            accent_soft: c(0x172554), // blue-950（深底浅蓝）
            brand: c(0x3b82f6),       // blue-500（品牌块深色下保持）
            brand_soft: c(0xeff6ff),  // 亮内点（brand 方块上）
            success: c(0x4ade80),     // green-400
            warning: c(0xfbbf24),     // amber-400
            danger: c(0xf87171),      // red-400
            success_soft: c(0x4ade80).alpha(0.16),
            danger_soft: c(0xf87171).alpha(0.16),
        }
    }

    /// 卡片轻投影（macOS 原生卡片：柔和低透明度、1px 下沉、8px 羽化）
    pub fn card_shadow_box(&self) -> BoxShadow {
        BoxShadow {
            color: self.card_shadow,
            offset: point(px(0.0), px(1.0)),
            blur_radius: px(8.0),
            spread_radius: px(0.0),
        }
    }

    /// 当前外观对应的语义色板（视图渲染入口）
    pub fn current(cx: &App) -> Self {
        let mut theme = if cx.theme().is_dark() {
            Self::dark()
        } else {
            Self::light()
        };
        // 圆角 token 以 gpui-component 主题为唯一来源（亮暗一致）
        theme.radius = f32::from(cx.theme().radius);
        theme.radius_lg = f32::from(cx.theme().radius_lg);
        theme
    }
}

/// 把 0xRRGGBB 转成 GPUI 色值（统一 Hsla，避免 Rgba/Hsla 混用）
fn c(hex: u32) -> Hsla {
    rgb(hex).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_component::PixelsExt;

    #[test]
    fn theme_pref_default_is_follow_system() {
        assert_eq!(ThemePreference::default(), ThemePreference::FollowSystem);
        assert!(!ThemePreference::FollowSystem.is_explicit());
        assert!(ThemePreference::Light.is_explicit());
        assert!(ThemePreference::Dark.is_explicit());
    }

    #[test]
    fn theme_pref_labels() {
        assert_eq!(ThemePreference::FollowSystem.label(), "跟随系统");
        assert_eq!(ThemePreference::Light.label(), "浅色");
        assert_eq!(ThemePreference::Dark.label(), "深色");
    }

    #[test]
    fn app_theme_light_and_dark_differ() {
        let light = AppTheme::light();
        let dark = AppTheme::dark();
        // 亮/暗两态的关键层级必须不同（侧栏、画布、文字、状态色）
        assert_ne!(light.sidebar_bg, dark.sidebar_bg);
        assert_ne!(light.window_bg, dark.window_bg);
        assert_ne!(light.text_primary, dark.text_primary);
        assert_ne!(light.success, dark.success);
        // 选中胶囊投影两态不一致（浅色更弱、深色更强）
        assert_ne!(light.sidebar_item_shadow, dark.sidebar_item_shadow);
        // 品牌蓝两态保持一致（frontend 品牌色恒 blue-500）
        assert_eq!(light.brand, dark.brand);
    }

    /// P2-2 回归锁：语义状态色（accent/success/danger/warning）在亮暗两态都必须
    /// 完全不透明——gpui-component 默认主题的基色（blue/green/red）未定义时是
    /// 透明黑（不可见），本测试防止回退到该 bug。
    #[test]
    fn semantic_status_colors_are_opaque_in_both_modes() {
        for theme in [AppTheme::light(), AppTheme::dark()] {
            for color in [
                theme.accent,
                theme.success,
                theme.danger,
                theme.warning,
                theme.text_primary,
            ] {
                assert_eq!(
                    color.a, 1.0,
                    "语义色必须不透明（防透明黑回归）：{:?}",
                    color
                );
            }
        }
        // 亮暗两态涨跌色语义不同（可见且可区分）
        assert_ne!(AppTheme::light().success, AppTheme::dark().success);
    }

    /// P2-4 回归锁：卡片轻投影与 delta 徽章浅底在亮暗两态都可用（有可见度、成组），
    /// 且 delta 徽章底是语义色的低透明度派生（半透明、非透明黑）。
    #[test]
    fn card_shadow_and_delta_soft_tokens_are_usable_in_both_modes() {
        for theme in [AppTheme::light(), AppTheme::dark()] {
            // 投影色非完全透明（亮态偏弱、暗态偏强，但都必须可见）
            assert!(theme.card_shadow.a > 0.0, "卡片投影色不可全透明");
            let shadow = theme.card_shadow_box();
            assert!(shadow.blur_radius.as_f64() > 0.0, "投影必须有羽化");
            // delta 徽章底：半透明、非透明黑（a 在 (0,1) 区间内）
            assert!(theme.success_soft.a > 0.0 && theme.success_soft.a < 1.0);
            assert!(theme.danger_soft.a > 0.0 && theme.danger_soft.a < 1.0);
            // 软底与主色色相一致（同为纯色，仅透明度不同——Hsla 下 hue 相同）
            assert_eq!(theme.success_soft.h, theme.success.h);
            assert_eq!(theme.danger_soft.h, theme.danger.h);
            // 主色不透明，软底半透明（alpha 已在上方断言）
            assert_eq!(theme.success.a, 1.0);
            assert_eq!(theme.danger.a, 1.0);
        }
        // 亮暗两态的投影强度不同（暗态投影更强以在深底上可见）
        assert_ne!(AppTheme::light().card_shadow, AppTheme::dark().card_shadow);
    }

    /// P2-2 核心契约：`AppTheme::current` 跟随全局主题模式（亮/暗），
    /// 切换模式后取到的语义色板随之切换。
    #[gpui::test]
    async fn app_theme_current_follows_global_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            // 初始（测试环境默认浅色）
            assert!(!AppTheme::current(cx).is_dark());
            assert_eq!(AppTheme::current(cx).window_bg, AppTheme::light().window_bg);

            // 强制深色 → 语义色板跟随
            gpui_component::Theme::change(ThemeMode::Dark, None, cx);
            assert!(AppTheme::current(cx).is_dark());
            assert_eq!(AppTheme::current(cx).window_bg, AppTheme::dark().window_bg);
            assert_ne!(
                AppTheme::current(cx).sidebar_bg,
                AppTheme::light().sidebar_bg
            );

            // 强制浅色 → 恢复
            gpui_component::Theme::change(ThemeMode::Light, None, cx);
            assert!(!AppTheme::current(cx).is_dark());
        });
    }
}
