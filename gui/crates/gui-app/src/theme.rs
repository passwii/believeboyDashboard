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
//!    系统字体层级（macOS HIG 系统排版，不另造轮子）。宽窗度量（内容上限
//!    宽度）见 [`CONTENT_MAX_WIDTH`] + [`crate::widgets::layout::content_guard`]。
//! 4. **排版层级（P4-7，BLF-762）**：文字一律走 gpui `text_*` 字阶（rem 基准
//!    16px：xs=12 / sm=14 / base=16 / lg=18 / xl=20 / 2xl=24），**禁止裸
//!    `text_size(px(...))`**（源码级回归锁见 widgets/page_header.rs 测试）：
//!    - **标题级**：`text_2xl` + `font_semibold` + `text_primary`——页面大标题
//!      （[`crate::widgets::page_header::PageHeader`]）与 KPI 数值（stat_band）；
//!    - **说明级**：`text_sm` + `text_secondary`（正文 / 表格行）或
//!      `text_muted`（筛选 label / 空态 / 辅助说明）；
//!    - **辅助级**：`text_xs` + `text_muted`（图表轴标签 / 时间戳 / 徽标）。
//!
//!    表格数字列另加等宽数字（tabular-nums）保证纵向数位对齐，见
//!    [`crate::widgets::data_table::TabularNumsExt`]。
//!
//! 迁移说明：此前 `Theme::dark_sidebar_light_content()`（深侧栏+浅内容区混合外观）
//! 已废弃——跟随系统后侧栏与内容区同亮同暗，语义字段全部收敛到 [`AppTheme`]。

use gpui::{App, BoxShadow, Hsla, Window, point, px, rgb};
use gpui_component::{ActiveTheme, ThemeMode};

/// 4px 间距尺度上的常用大间距（间距 token；小间距直接用 gpui 的 `.px_*/.gap_*`
/// 4px 工具类，语义一致，不重复定义）
pub const SPACE_10: f32 = 40.0;
pub const SPACE_12: f32 = 48.0;

/// 宽窗度量：卡片 / 表单 / 图表 / 页面头部内容的上限宽度（P4-5，BLF-760）。
///
/// 依据：超宽显示器（≥2K）上内容区若一路拉伸，卡片文案行宽、表单控件跨度过大，
/// 可读性与可操作性显著下降。参考 frontend 的 `max-w-7xl`（1280px）与主流
/// dashboard 的阅读宽度区间（1200–1440px），取 **1440px** 作为统一内容上限并
/// 居中显示（见 [`crate::widgets::layout::content_guard`]）。
///
/// 例外：数据表格（DataTable）需承载多列 + 横向滚动，保留全宽不受此上限约束。
pub const CONTENT_MAX_WIDTH: f32 = 1440.0;

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
/// 色值设计对齐 macOS 经典 light/dark 系统色（Apple HIG system colors：
/// windowBackground / sidebar / separator / controlAccent / systemGreen / systemRed），
/// 亮暗两态各自成组；P4-3（BLF-709）起不再使用前端品牌蓝，全面收敛为 macOS 原生观感。
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

    // ---- 表格行态（P4-7，BLF-762）----
    /// 表格行 hover 底（全部数据行通用；非选中行的指针反馈）
    pub table_row_hover: Hsla,
    /// 表格斑马纹行底（striped 表格的隔行底色；暗态必须与卡底区分）
    pub table_row_stripe: Hsla,

    // ---- 强调 / 状态 ----
    /// 强调色（controlAccent，品牌蓝）
    pub accent: Hsla,
    /// 强调色 hover（登录按钮等按压反馈）
    pub accent_hover: Hsla,
    /// 强调色上的前景（accent 背景上的文字/图标）
    pub on_accent: Hsla,
    /// 强调色浅底（徽标/图标气泡背景）
    pub accent_soft: Hsla,
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

    // ---- 图表序列色（P3-2；frontend dashboard-v2 chartConfig 的蓝色系对齐）----
    /// 主序列（销售额；frontend sales `#2563eb` / 深色 `#60a5fa`）
    pub chart_primary: Hsla,
    /// 次序列（销量 / 广告花费；frontend volume/ad_spend `#60a5fa` / 深色 `#93c5fd`）
    pub chart_secondary: Hsla,
    /// 第三序列（库存等单序列强调；frontend stock `#1d4ed8` / 深色 `#3b82f6`）
    pub chart_tertiary: Hsla,
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

            // 背景层级（macOS light system colors：windowBackground #F5F5F7、
            // controlBackground 白、separator #E5E5E5、中性浅填充 secondarySystemFill）
            window_bg: c(0xf5f5f7),
            card_bg: c(0xffffff),
            muted_fill: c(0xebebf0),
            separator: c(0xe5e5e5),
            card_shadow: c(0x000000).alpha(0.06),

            // 表格行态（浅色：白底上的中性浅填充透明度梯度——hover 强于斑马纹）
            table_row_hover: c(0xebebf0).alpha(0.65),
            table_row_stripe: c(0xebebf0).alpha(0.5),

            // 侧栏（浅色：不透明显实色 #ECECEC——macOS 系统设置/Finder 浅侧栏观感，
            // 选中白胶囊 + 极轻投影；无品牌色块）
            sidebar_bg: c(0xececec),
            sidebar_border: c(0xe5e5e5),
            sidebar_text: c(0x1d1d1f),
            sidebar_group_text: c(0x86868b),
            sidebar_item_hover: c(0xe8e8ec),
            sidebar_item_active_bg: c(0xffffff),
            sidebar_item_active_text: c(0x1d1d1f),
            sidebar_item_shadow: c(0x000000).alpha(0.06),
            sidebar_footer_text: c(0x86868b),

            // 文字层级（Apple HIG：label / secondaryLabel / quaternaryLabel）
            text_primary: c(0x1d1d1f),
            text_secondary: c(0x6e6e73),
            text_muted: c(0xaeaeb2),

            // 强调 / 状态（macOS system colors：controlAccent / systemGreen /
            // systemOrange / systemRed）
            accent: c(0x007aff),       // controlAccent
            accent_hover: c(0x0066cc), // 按压加深
            on_accent: c(0xffffff),
            accent_soft: c(0x007aff).alpha(0.12),
            success: c(0x34c759), // systemGreen（涨）
            warning: c(0xff9f0a), // systemOrange
            danger: c(0xff3b30),  // systemRed（跌）
            success_soft: c(0x34c759).alpha(0.12),
            danger_soft: c(0xff3b30).alpha(0.12),

            // 图表序列色（蓝色系，对齐 frontend dashboard-v2 chartConfig）
            chart_primary: c(0x2563eb),   // blue-600（销售额）
            chart_secondary: c(0x60a5fa), // blue-400（销量 / 广告花费）
            chart_tertiary: c(0x1d4ed8),  // blue-700（库存）
        }
    }

    /// 深色外观语义色板
    pub fn dark() -> Self {
        Self {
            dark: true,

            // 度量 token
            radius: 6.0,
            radius_lg: 8.0,

            // 背景层级（macOS dark system colors：windowBackground #282828、
            // 卡片 elevated #323232、separator #3A3A3C、暗色投影收敛靠 border 区分）
            window_bg: c(0x282828),
            card_bg: c(0x323232),
            muted_fill: c(0x323232),
            separator: c(0x3a3a3c),
            card_shadow: c(0x000000).alpha(0.25),

            // 表格行态（深色：白色叠加提亮——muted_fill 与卡底同色导致 hover/斑马纹
            // 不可见的旧 bug 修复；hover 8% 白强于斑马纹 4% 白，反馈层次分明）
            table_row_hover: c(0xffffff).alpha(0.08),
            table_row_stripe: c(0xffffff).alpha(0.04),

            // 侧栏（深色：与窗口同底 #282828——macOS 暗色侧栏与内容同色，靠选中
            // 灰胶囊 #3A3A3C 区分；选中项无投影，扁平原生）
            sidebar_bg: c(0x282828),
            sidebar_border: c(0x3a3a3c),
            sidebar_text: c(0xf5f5f7),
            sidebar_group_text: c(0x98989d),
            sidebar_item_hover: c(0x323232),
            sidebar_item_active_bg: c(0x3a3a3c),
            sidebar_item_active_text: c(0xf5f5f7),
            sidebar_item_shadow: c(0x000000).alpha(0.0),
            sidebar_footer_text: c(0x98989d),

            // 文字层级（Apple HIG dark：label / secondaryLabel / quaternaryLabel）
            text_primary: c(0xf5f5f7),
            text_secondary: c(0xa1a1a6),
            text_muted: c(0x7c7c80),

            // 强调 / 状态（深色提亮保证对比度）
            accent: c(0x0a84ff),       // controlAccent
            accent_hover: c(0x409cff), // 按压提亮
            on_accent: c(0xffffff),
            accent_soft: c(0x0a84ff).alpha(0.16),
            success: c(0x30d158), // systemGreen（涨）
            warning: c(0xffd60a), // systemYellow
            danger: c(0xff453a),  // systemRed（跌）
            success_soft: c(0x30d158).alpha(0.16),
            danger_soft: c(0xff453a).alpha(0.16),

            // 图表序列色（深色下提亮保证在深底上可见）
            chart_primary: c(0x60a5fa),   // blue-400
            chart_secondary: c(0x93c5fd), // blue-300
            chart_tertiary: c(0x3b82f6),  // blue-500
        }
    }

    /// 图表分段色板（P3-2：PieChart / BarChart 多分段着色；亮暗两态成组，
    /// 蓝色系递进，对齐 frontend dashboard-v2 的 chartConfig 蓝色家族）
    pub fn chart_palette(&self) -> [Hsla; 6] {
        if self.dark {
            [
                c(0x60a5fa), // blue-400
                c(0x93c5fd), // blue-300
                c(0x3b82f6), // blue-500
                c(0xbfdbfe), // blue-200
                c(0x1d4ed8), // blue-700
                c(0x2563eb), // blue-600
            ]
        } else {
            [
                c(0x2563eb), // blue-600
                c(0x60a5fa), // blue-400
                c(0x1d4ed8), // blue-700
                c(0x93c5fd), // blue-300
                c(0x3b82f6), // blue-500
                c(0xbfdbfe), // blue-200
            ]
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
        // 选中胶囊投影两态不一致（浅色极轻、深色无投影）
        assert_ne!(light.sidebar_item_shadow, dark.sidebar_item_shadow);
    }

    /// P4-3（BLF-709）回归锁：配色对齐 macOS 经典 light/dark 系统色
    /// （Apple HIG system colors，BLF-709 基准值）——防止回退到 Tailwind/zinc 色系。
    #[test]
    fn macos_system_color_contract() {
        let light = AppTheme::light();
        let dark = AppTheme::dark();

        // 亮色基准：windowBackground #F5F5F7 / controlBackground #FFFFFF /
        // separator #E5E5E5 / label #1D1D1F / secondaryLabel #6E6E73 /
        // quaternaryLabel #AEAEB2 / controlAccent #007AFF
        assert_eq!(light.window_bg, c(0xf5f5f7));
        assert_eq!(light.card_bg, c(0xffffff));
        assert_eq!(light.separator, c(0xe5e5e5));
        assert_eq!(light.text_primary, c(0x1d1d1f));
        assert_eq!(light.text_secondary, c(0x6e6e73));
        assert_eq!(light.text_muted, c(0xaeaeb2));
        assert_eq!(light.accent, c(0x007aff));

        // 暗色基准：windowBackground #282828 / separator #3A3A3C /
        // label #F5F5F7 / secondaryLabel #A1A1A6 / quaternaryLabel #7C7C80 /
        // controlAccent #0A84FF / 选中灰 #3A3A3C
        assert_eq!(dark.window_bg, c(0x282828));
        assert_eq!(dark.separator, c(0x3a3a3c));
        assert_eq!(dark.text_primary, c(0xf5f5f7));
        assert_eq!(dark.text_secondary, c(0xa1a1a6));
        assert_eq!(dark.text_muted, c(0x7c7c80));
        assert_eq!(dark.accent, c(0x0a84ff));
        assert_eq!(dark.sidebar_item_active_bg, c(0x3a3a3c));

        // 侧栏材质：不透明显实色（P4-3 收敛——半透明叠加系统模糊已弃用）
        assert_eq!(light.sidebar_bg.a, 1.0, "浅色侧栏必须不透明");
        assert_eq!(dark.sidebar_bg.a, 1.0, "深色侧栏必须不透明");
        // 选中胶囊投影：浅色极轻（macOS 原生）、深色无投影（扁平暗侧栏）
        assert!(
            light.sidebar_item_shadow.a > 0.0 && light.sidebar_item_shadow.a < 0.1,
            "浅色选中投影应极轻"
        );
        assert_eq!(dark.sidebar_item_shadow.a, 0.0, "深色选中胶囊无投影");

        // 状态色对齐 macOS system colors（涨绿跌红语义保持）
        assert_eq!(light.success, c(0x34c759));
        assert_eq!(light.danger, c(0xff3b30));
        assert_eq!(dark.success, c(0x30d158));
        assert_eq!(dark.danger, c(0xff453a));
    }

    /// P3-2 回归锁：图表序列色在亮暗两态都必须不透明（可见），
    /// 且分段色板长度固定、主/次序列两态不同（深色下提亮）。
    #[test]
    fn chart_tokens_opaque_and_palette_stable() {
        for theme in [AppTheme::light(), AppTheme::dark()] {
            for color in [
                theme.chart_primary,
                theme.chart_secondary,
                theme.chart_tertiary,
            ] {
                assert_eq!(color.a, 1.0, "图表序列色必须不透明");
            }
            let palette = theme.chart_palette();
            assert_eq!(palette.len(), 6);
            for color in palette {
                assert_eq!(color.a, 1.0, "图表分段色必须不透明");
            }
            // 分段色两两不同（PieChart 扇形可区分）
            for i in 0..palette.len() {
                for j in (i + 1)..palette.len() {
                    assert_ne!(palette[i], palette[j], "分段色 {i}/{j} 重复");
                }
            }
        }
        // 深色下主序列提亮（与浅色不同，保证深底可见度）
        assert_ne!(
            AppTheme::light().chart_primary,
            AppTheme::dark().chart_primary
        );
        assert_ne!(
            AppTheme::light().chart_secondary,
            AppTheme::dark().chart_secondary
        );
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

    /// P4-7（BLF-762）回归锁：表格行 hover / 斑马纹 token 在亮暗两态都必须
    /// 与行底（card_bg）可区分且非全透明——修复暗态 muted_fill == card_bg
    /// 导致 hover / 斑马纹不可见的旧问题；hover 强度必须大于斑马纹（反馈层次）。
    #[test]
    fn table_row_tokens_visible_in_both_modes() {
        for theme in [AppTheme::light(), AppTheme::dark()] {
            assert_ne!(theme.table_row_hover, theme.card_bg, "hover 必须与行底区分");
            assert_ne!(
                theme.table_row_stripe, theme.card_bg,
                "斑马纹必须与行底区分"
            );
            assert!(theme.table_row_hover.a > 0.0, "hover 色不可全透明");
            assert!(theme.table_row_stripe.a > 0.0, "斑马纹色不可全透明");
            assert!(
                theme.table_row_hover.a > theme.table_row_stripe.a,
                "hover 反馈应强于斑马纹"
            );
        }
        // 亮暗两态实现方式不同（浅色中性填充 / 深色白色叠加），值必须不同
        assert_ne!(
            AppTheme::light().table_row_hover,
            AppTheme::dark().table_row_hover
        );
    }

    /// P4-5 回归锁：宽窗度量常量落在合理阅读宽度区间（1200–1440px，
    /// 对齐 frontend max-w-7xl 与主流 dashboard 上限），且卡片内容上限
    /// 大于侧栏展开宽度（保证宽窗下内容确实会被收拢而非恒全宽）。
    #[test]
    fn wide_window_measurement_contract() {
        assert!(
            (1200.0..=1440.0).contains(&CONTENT_MAX_WIDTH),
            "内容上限应在 1200–1440px 阅读宽度区间"
        );
        assert_eq!(CONTENT_MAX_WIDTH % 4.0, 0.0, "必须落在 4px 尺度网格上");
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
