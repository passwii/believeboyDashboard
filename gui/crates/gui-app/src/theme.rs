//! 视觉 token 模块——高密度暗色工具主题（BLF-792，父 issue「暗色主题规格」节）
//!
//! 设计基调：专业交易终端（Bloomberg / Fintech）风格跨境电商中台——
//! 零外边距平铺、极致空间利用率、等宽数字、1px 边界表达层级（不用重投影）。
//!
//! 四层设计：
//! 1. **外观层**：gpui-component `Theme`（`cx.theme()`）承载亮/暗外观开关；
//!    本应用**默认锁定 Dark**（[`ThemePreference::Dark`] 为默认偏好，UI 不再
//!    暴露切换入口）。[`ThemePreference`] 枚举与 Light/FollowSystem 代码路径
//!    **保留但休眠**（不删除，避免破坏既有测试与未来恢复口）。
//! 2. **语义层**：[`AppTheme`] 承载业务语义色板。暗态对齐四层背景栈
//!    [`BG_ROOT`] / [`BG_PANEL`] / [`BG_CARD`] / [`BG_HOVER`] + 分隔线
//!    [`BORDER_SEPARATOR`] + 微语义色 [`SEMANTIC_POSITIVE`] /
//!    [`SEMANTIC_WARNING`] / [`SEMANTIC_DANGER`]（常量可 grep 审计，回归锁见
//!    `dark_utility_background_stack_contract`）。视图只消费 `AppTheme`，
//!    不散落十六进制字面量。
//! 3. **排版层（紧凑字阶）**：文字一律走显式字号 token（px），禁止裸数字
//!    字面量字号（源码级回归锁见 widgets/page_header.rs 测试）：
//!    - **标题级**：[`FONT_TITLE_LG`]（页面大标题 PageHeader / KPI 数值）或
//!      [`FONT_TITLE`]（卡片小标题）+ `font_semibold` + `text_primary`；
//!    - **正文/数据级**：[`FONT_BASE`] = 13px（10pt）——表格单元格、表单正文；
//!    - **辅助级**：[`FONT_XS`]（表头 / 筛选 label / 副标题）/ [`FONT_2XS`]
//!      （图表轴标签 / 时间戳 / 徽标）/ [`FONT_SM`]（次级说明）。
//!
//!    数字列/金额/时间戳另加等宽字体（[`FONT_MONO_FAMILY`]，JetBrains Mono
//!    内嵌打包）+ tabular-nums，见
//!    [`crate::widgets::data_table::TabularNumsExt::mono_tabular_nums`]。
//!
//!    迁移期兼容：存量视图仍走 gpui rem 系 `text_xs/sm/base/...` 字阶，由各
//!    视图迁移批次逐个切换到本组 token（父 issue 阶段计划）；共享 chrome
//!    （PageHeader / DataTable / stat_band KPI）已在 BLF-792 完成切换。
//! 4. **度量层**：间距最小尺度收敛为 [`SPACE_MIN`]/[`SPACE_SM`]/[`SPACE_MD`]
//!    （2/4/8px，小间距直接用 gpui 的 `.px_*/.gap_*` 4px 工具类）；控件标准高
//!    两档 [`HEIGHT_CONTROL_SM`]/[`HEIGHT_CONTROL_MD`]；表头行高
//!    [`TABLE_HEADER_HEIGHT`]。圆角沿用 gpui-component `Theme::radius`。
//!
//!    高密度模式下**取消宽窗内容居中上限**（原 CONTENT_MAX_WIDTH=1440 +
//!    content_guard 居中已移除）：主工作区全幅平铺，容器外 padding 0、内部
//!    间距锁 4/8px；`content_guard` 保留为全宽透传壳，待 Stage2 外壳框架
//!    重构时移除调用点。
//!
//! 迁移说明：macOS HIG 舒适字阶（rem 系 xs=12/sm=14/base=16）与跟随系统亮暗
//! 已被本契约取代；浅色语义色板（`AppTheme::light`）仅服务休眠路径，不再维护。

use std::borrow::Cow;

use gpui::{point, px, rgb, App, BoxShadow, Hsla, Window};
use gpui_component::{ActiveTheme, ThemeMode};

// ---------------------------------------------------------------------------
// 背景栈与微语义色（grep 审计锚点；BLF-792「色板值与规格一一对应」）
// ---------------------------------------------------------------------------

/// 背景栈 L0：应用根底（Root）
pub const BG_ROOT: u32 = 0x0d0d0e;
/// 背景栈 L1：面板（Panel，侧栏/工具条）
pub const BG_PANEL: u32 = 0x141417;
/// 背景栈 L2：卡片表面（Card）
pub const BG_CARD: u32 = 0x1c1c21;
/// 背景栈 L3：hover 与选中底（Hover & Selected）
pub const BG_HOVER: u32 = 0x272730;
/// 分隔线 / 边框（1px 表达层级，不用重投影）
pub const BORDER_SEPARATOR: u32 = 0x232328;
/// 微语义色：正向 / 有货 / 涨
pub const SEMANTIC_POSITIVE: u32 = 0x22c55e;
/// 微语义色：警示 / 待处理
pub const SEMANTIC_WARNING: u32 = 0xf59e0b;
/// 微语义色：危险 / 缺货 / 跌
pub const SEMANTIC_DANGER: u32 = 0xef4444;

// ---------------------------------------------------------------------------
// 紧凑字阶（px 显式 token；标题 11~13pt bold ≈ 14~17px，正文/数据 10pt = 13px）
//
// 本组 token 是后续阶段的排版地基：共享 chrome（PageHeader / DataTable /
// stat_band KPI）已在 BLF-792 消费 FONT_XS / FONT_BASE / FONT_TITLE_LG，
// 其余 token 由各视图迁移批次逐个接入——在接入前挂 dead_code 允许
// （与 widgets 公共 API 面的既有惯例一致）。
// ---------------------------------------------------------------------------

/// 辅助级：图表轴标签 / 时间戳 / 徽标
#[allow(dead_code)]
pub const FONT_2XS: f32 = 10.0;
/// 次要级：表头 / 筛选 label / 副标题
pub const FONT_XS: f32 = 11.0;
/// 次级说明（介于辅助与正文之间）
#[allow(dead_code)]
pub const FONT_SM: f32 = 12.0;
/// 正文 / 数据基准（10pt = 13px）
pub const FONT_BASE: f32 = 13.0;
/// 小标题 / 卡片标题（11pt bold 下限）
#[allow(dead_code)]
pub const FONT_TITLE: f32 = 14.0;
/// 页面大标题 / KPI 数值（13pt bold 上限）
pub const FONT_TITLE_LG: f32 = 17.0;

// ---------------------------------------------------------------------------
// 控件度量与间距 token（控件高度由模板阶段组件化时消费，间距由各视图迁移批次接入）
// ---------------------------------------------------------------------------

/// 最小间距（2px）
#[allow(dead_code)]
pub const SPACE_MIN: f32 = 2.0;
/// 标准小间距（4px；与 gpui `.gap_1/.p_1` 一致）
#[allow(dead_code)]
pub const SPACE_SM: f32 = 4.0;
/// 标准中间距（8px；与 gpui `.gap_2/.p_2` 一致）
#[allow(dead_code)]
pub const SPACE_MD: f32 = 8.0;
/// 控件标准高·紧凑档（输入/按钮）
#[allow(dead_code)]
pub const HEIGHT_CONTROL_SM: f32 = 24.0;
/// 控件标准高·标准档（输入/按钮）
#[allow(dead_code)]
pub const HEIGHT_CONTROL_MD: f32 = 28.0;
/// 数据表表头行高
pub const TABLE_HEADER_HEIGHT: f32 = 28.0;

// ---------------------------------------------------------------------------
// 大间距（沿用 BLF-689；placeholder 等占位视图仍在用）
// ---------------------------------------------------------------------------

/// 4px 间距尺度上的常用大间距（间距 token；小间距直接用 gpui 的 `.px_*/.gap_*`
/// 4px 工具类，语义一致，不重复定义）
pub const SPACE_10: f32 = 40.0;
pub const SPACE_12: f32 = 48.0;

// ---------------------------------------------------------------------------
// 等宽数字字体（JetBrains Mono 内嵌打包，OFL 许可随字体文件分发）
// ---------------------------------------------------------------------------

/// 数字列 / 金额 / 时间戳的等宽字体家族名（`register_embedded_fonts` 注册后生效）
pub const FONT_MONO_FAMILY: &str = "JetBrains Mono";

/// 注册内嵌字体（JetBrains Mono Regular/SemiBold；main 启动时调用一次）。
///
/// 打包进二进制（include_bytes），.app bundle / Windows exe 均不依赖系统装字体；
/// 注册失败不致命（回退系统等宽），仅记录日志。
pub fn register_embedded_fonts(cx: &mut App) {
    let fonts = vec![
        Cow::Borrowed(include_bytes!("../assets/fonts/JetBrainsMono-Regular.ttf").as_slice()),
        Cow::Borrowed(include_bytes!("../assets/fonts/JetBrainsMono-SemiBold.ttf").as_slice()),
    ];
    if let Err(e) = cx.text_system().add_fonts(fonts) {
        tracing::warn!("内嵌 JetBrains Mono 注册失败（数字将回退系统等宽字体）: {e}");
    }
}

/// 主题偏好：深色（默认锁定）/ 浅色（休眠）/ 跟随系统（休眠）
///
/// BLF-792 起 UI 不再暴露外观切换入口，应用启动即强制深色
/// （main.rs `set_theme_pref(ThemePreference::Dark)`）。枚举与浅色/跟随系统
/// 路径保留为休眠代码（测试与未来「设置页恢复切换」的挂点），不属于活跃契约。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThemePreference {
    /// 深色（默认锁定；BLF-792 高密度暗色工具主题的唯一活跃外观）
    #[default]
    Dark,
    /// 浅色（休眠：不在 UI 暴露，仅测试/恢复口使用）
    #[allow(dead_code)]
    Light,
    /// 跟随系统（休眠：不在 UI 暴露，仅测试/恢复口使用）
    #[allow(dead_code)]
    FollowSystem,
}

impl ThemePreference {
    /// 菜单显示名（休眠：BLF-792 下线外观切换菜单后无活跃消费方，
    /// 保留供未来「设置页恢复切换」）
    #[allow(dead_code)]
    pub fn label(self) -> &'static str {
        match self {
            Self::Dark => "深色",
            Self::Light => "浅色",
            Self::FollowSystem => "跟随系统",
        }
    }

    /// 是否强制指定外观（非跟随系统）
    pub fn is_explicit(self) -> bool {
        !matches!(self, Self::FollowSystem)
    }
}

/// 全局主题偏好（`cx.set_global` / `cx.global`）；默认锁定深色
#[derive(Debug, Clone, Copy, Default)]
pub struct ThemePref(pub ThemePreference);

impl gpui::Global for ThemePref {}

/// 应用主题偏好到全局外观
///
/// - 深色/浅色 → 强制 `ThemeMode`
/// - 跟随系统（休眠）→ `sync_system_appearance`（取窗口当前外观）
///
/// `window` 传 `Some` 时同步触发该窗口重绘（无闪烁：单帧内完成换肤）。
pub fn set_theme_pref(pref: ThemePreference, window: Option<&mut Window>, cx: &mut App) {
    cx.set_global(ThemePref(pref));
    match pref {
        ThemePreference::Dark => gpui_component::Theme::change(ThemeMode::Dark, window, cx),
        ThemePreference::Light => gpui_component::Theme::change(ThemeMode::Light, window, cx),
        ThemePreference::FollowSystem => gpui_component::Theme::sync_system_appearance(window, cx),
    }
}

/// 窗口外观变化回调（由 `Window::observe_window_appearance` 注册）。
///
/// 仅「跟随系统」偏好下同步外观；显式浅色/深色时忽略系统变化。
/// 当前默认锁定深色（显式），本回调实际处于静默旁路（保留注册链路）。
pub fn on_window_appearance_changed(window: &mut Window, cx: &mut App) {
    let pref = cx
        .try_global::<ThemePref>()
        .map(|p| p.0)
        .unwrap_or_default();
    if !pref.is_explicit() {
        gpui_component::Theme::sync_system_appearance(Some(window), cx);
    }
}

/// 语义色板（业务语义层）
///
/// 暗态（唯一活跃外观）对齐「暗色主题规格」：四层背景栈 + 1px 分隔线 +
/// 微语义色（Tailwind green-500/amber-500/red-500），层级靠 1px 边界表达、
/// 无重投影（卡片投影在暗态完全透明，见 [`AppTheme::card_shadow_box`]）。
/// 浅色板为休眠遗留（macOS HIG 系统色，不再维护）。
#[derive(Clone, Copy, Debug)]
pub struct AppTheme {
    /// 当前是否深色外观
    pub dark: bool,

    // ---- 度量 token（圆角；由 gpui-component 主题派生，亮暗一致）----
    /// 通用元素圆角（px）
    pub radius: f32,
    /// 大元素圆角（px，Dialog/卡片等）
    pub radius_lg: f32,
    // ---- 背景层级 ----
    /// 内容区画布（Root 层 [`BG_ROOT`]）
    pub window_bg: Hsla,
    /// 卡片表面（Card 层 [`BG_CARD`]）
    pub card_bg: Hsla,
    /// 中性填充（图表占位区 / 徽标底 / hover 反馈；Hover 层 [`BG_HOVER`]）
    pub muted_fill: Hsla,
    /// 分隔线（[`BORDER_SEPARATOR`]，1px 表达层级）
    pub separator: Hsla,
    /// 卡片投影色（暗态恒透明——高密度模式不用重投影，靠 1px 边界分层）
    pub card_shadow: Hsla,
    /// 面板底（Panel 层 [`BG_PANEL`]：侧栏 / 工具条 / 子导航；Stage2 外壳
    /// 组件化时消费，侧栏当前经 `sidebar_bg` 同值消费）
    #[allow(dead_code)]
    pub panel_bg: Hsla,

    // ---- 侧栏（Panel 层 + Hover 层选中）----
    pub sidebar_bg: Hsla,
    pub sidebar_border: Hsla,
    pub sidebar_text: Hsla,
    pub sidebar_group_text: Hsla,
    pub sidebar_item_hover: Hsla,
    pub sidebar_item_active_bg: Hsla,
    pub sidebar_item_active_text: Hsla,
    /// 选中指示投影（暗色扁平主题恒透明；字段保留兼容既有消费方）
    pub sidebar_item_shadow: Hsla,
    pub sidebar_footer_text: Hsla,

    // ---- 文字层级 ----
    pub text_primary: Hsla,
    pub text_secondary: Hsla,
    pub text_muted: Hsla,

    // ---- 表格行态 ----
    /// 表格行 hover 底（全部数据行通用；非选中行的指针反馈；[`BG_HOVER`]）
    pub table_row_hover: Hsla,
    /// 表格斑马纹行底（striped 表格的隔行底色；必须与卡底区分）
    pub table_row_stripe: Hsla,

    // ---- 强调 / 状态 ----
    /// 强调色（controlAccent 蓝）
    pub accent: Hsla,
    /// 强调色 hover（登录按钮等按压反馈）
    pub accent_hover: Hsla,
    /// 强调色上的前景（accent 背景上的文字/图标）
    pub on_accent: Hsla,
    /// 强调色浅底（徽标/图标气泡背景）
    pub accent_soft: Hsla,
    /// 成功（涨 / 有货；[`SEMANTIC_POSITIVE`]）
    pub success: Hsla,
    /// 警告（警示 / 待处理；[`SEMANTIC_WARNING`]）
    pub warning: Hsla,
    /// 危险（跌 / 缺货 / 错误；[`SEMANTIC_DANGER`]）
    pub danger: Hsla,
    /// 成功浅底（涨 delta 徽章背景，`success` 的低透明度派生）
    pub success_soft: Hsla,
    /// 危险浅底（跌 delta 徽章背景，`danger` 的低透明度派生）
    pub danger_soft: Hsla,

    // ---- 图表序列色（蓝色系；frontend dashboard-v2 chartConfig 对齐）----
    /// 主序列（销售额）
    pub chart_primary: Hsla,
    /// 次序列（销量 / 广告花费）
    pub chart_secondary: Hsla,
    /// 第三序列（库存等单序列强调）
    pub chart_tertiary: Hsla,
}

impl AppTheme {
    /// 当前是否深色外观
    pub fn is_dark(&self) -> bool {
        self.dark
    }

    /// 浅色外观语义色板（**休眠遗留**：macOS HIG 系统色，BLF-792 起不再维护，
    /// 仅服务 ThemePreference::Light 休眠路径与既有测试）
    pub fn light() -> Self {
        Self {
            dark: false,

            // 度量 token
            radius: 6.0,
            radius_lg: 8.0,

            // 背景层级（macOS light system colors）
            window_bg: c(0xf5f5f7),
            card_bg: c(0xffffff),
            muted_fill: c(0xebebf0),
            separator: c(0xe5e5e5),
            card_shadow: c(0x000000).alpha(0.06),
            panel_bg: c(0xececec),

            // 表格行态
            table_row_hover: c(0xebebf0).alpha(0.65),
            table_row_stripe: c(0xebebf0).alpha(0.5),

            // 侧栏
            sidebar_bg: c(0xececec),
            sidebar_border: c(0xe5e5e5),
            sidebar_text: c(0x1d1d1f),
            sidebar_group_text: c(0x86868b),
            sidebar_item_hover: c(0xe8e8ec),
            sidebar_item_active_bg: c(0xffffff),
            sidebar_item_active_text: c(0x1d1d1f),
            sidebar_item_shadow: c(0x000000).alpha(0.06),
            sidebar_footer_text: c(0x86868b),

            // 文字层级（Apple HIG）
            text_primary: c(0x1d1d1f),
            text_secondary: c(0x6e6e73),
            text_muted: c(0xaeaeb2),

            // 强调 / 状态（macOS system colors）
            accent: c(0x007aff),
            accent_hover: c(0x0066cc),
            on_accent: c(0xffffff),
            accent_soft: c(0x007aff).alpha(0.12),
            success: c(0x34c759),
            warning: c(0xff9f0a),
            danger: c(0xff3b30),
            success_soft: c(0x34c759).alpha(0.12),
            danger_soft: c(0xff3b30).alpha(0.12),

            // 图表序列色
            chart_primary: c(0x2563eb),
            chart_secondary: c(0x60a5fa),
            chart_tertiary: c(0x1d4ed8),
        }
    }

    /// 深色外观语义色板（唯一活跃外观；BLF-792 暗色工具主题基准值）
    pub fn dark() -> Self {
        Self {
            dark: true,

            // 度量 token
            radius: 6.0,
            radius_lg: 8.0,

            // 背景栈：Root #0d0d0e / Card #1c1c21 / Hover #272730 / Panel #141417 /
            // 分隔线 #232328；投影全透明（1px 边界表达层级，无重投影）
            window_bg: c(BG_ROOT),
            card_bg: c(BG_CARD),
            muted_fill: c(BG_HOVER),
            separator: c(BORDER_SEPARATOR),
            card_shadow: c(0x000000).alpha(0.0),
            panel_bg: c(BG_PANEL),

            // 表格行态：hover 用 Hover 层实色（强反馈）；斑马纹用白色低透明叠加
            // （与卡底区分且弱于 hover）
            table_row_hover: c(BG_HOVER),
            table_row_stripe: c(0xffffff).alpha(0.04),

            // 侧栏：Panel 层底 + Hover 层选中胶囊，扁平无边框投影
            sidebar_bg: c(BG_PANEL),
            sidebar_border: c(BORDER_SEPARATOR),
            sidebar_text: c(0xf5f5f7),
            sidebar_group_text: c(0x98989d),
            sidebar_item_hover: c(BG_HOVER),
            sidebar_item_active_bg: c(BG_HOVER),
            sidebar_item_active_text: c(0xf5f5f7),
            sidebar_item_shadow: c(0x000000).alpha(0.0),
            sidebar_footer_text: c(0x98989d),

            // 文字层级（深底三阶灰）
            text_primary: c(0xf5f5f7),
            text_secondary: c(0xa1a1a6),
            text_muted: c(0x7c7c80),

            // 微语义色（规格定值）+ controlAccent 蓝
            accent: c(0x0a84ff),
            accent_hover: c(0x409cff),
            on_accent: c(0xffffff),
            accent_soft: c(0x0a84ff).alpha(0.16),
            success: c(SEMANTIC_POSITIVE), // #22c55e 正向 / 有货 / 涨
            warning: c(SEMANTIC_WARNING),  // #f59e0b 警示 / 待处理
            danger: c(SEMANTIC_DANGER),    // #ef4444 危险 / 缺货 / 跌
            success_soft: c(SEMANTIC_POSITIVE).alpha(0.14),
            danger_soft: c(SEMANTIC_DANGER).alpha(0.14),

            // 图表序列色（蓝色系，深底提亮）
            chart_primary: c(0x60a5fa),
            chart_secondary: c(0x93c5fd),
            chart_tertiary: c(0x3b82f6),
        }
    }

    /// 图表分段色板（PieChart / BarChart 多分段着色；亮暗两态成组，蓝色系递进）
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

    /// 卡片轻投影。
    ///
    /// 高密度暗色模式（唯一活跃外观）下**恒透明**——层级靠 1px 边界表达，
    /// 不用重投影（规格条款）。函数保留：休眠的浅色板仍产出 macOS 式柔影，
    /// 且全部消费方无需改动。
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
    // 字号/间距 token 的单调性断言（FONT_2XS < FONT_XS < …）在编译期即为常量——
    // 这正是回归锁的本意：任何人改坏 token 序列，本测试立即失败。
    #![allow(clippy::assertions_on_constants)]
    use super::*;

    #[test]
    fn theme_pref_default_is_dark_locked() {
        assert_eq!(ThemePreference::default(), ThemePreference::Dark);
        // 深色为显式外观：窗口外观监听不会把应用带回跟随系统
        assert!(ThemePreference::Dark.is_explicit());
        // 休眠路径保留完整枚举能力
        assert!(ThemePreference::Light.is_explicit());
        assert!(!ThemePreference::FollowSystem.is_explicit());
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
    }

    /// BLF-792 回归锁：暗色四层背景栈 + 分隔线 + 微语义色必须与规格一字不差
    /// （theme.rs 常量为 grep 审计锚点；本测试防止任何一环悄悄漂移）。
    #[test]
    fn dark_utility_background_stack_contract() {
        let dark = AppTheme::dark();

        // 四层背景栈：Root / Panel / Card / Hover&选中
        assert_eq!(dark.window_bg, c(BG_ROOT));
        assert_eq!(c(BG_ROOT), c(0x0d0d0e), "Root 层规格值 #0d0d0e");
        assert_eq!(dark.panel_bg, c(BG_PANEL));
        assert_eq!(c(BG_PANEL), c(0x141417), "Panel 层规格值 #141417");
        assert_eq!(dark.card_bg, c(BG_CARD));
        assert_eq!(c(BG_CARD), c(0x1c1c21), "Card 层规格值 #1c1c21");
        assert_eq!(
            dark.sidebar_bg, dark.panel_bg,
            "侧栏取 Panel 层（Master Rail 细分色由 Stage2 定）"
        );
        assert_eq!(dark.muted_fill, c(BG_HOVER));
        assert_eq!(c(BG_HOVER), c(0x272730), "Hover&选中层规格值 #272730");
        assert_eq!(dark.sidebar_item_hover, c(BG_HOVER));
        assert_eq!(dark.sidebar_item_active_bg, c(BG_HOVER));

        // 分隔线 + 微语义色
        assert_eq!(dark.separator, c(BORDER_SEPARATOR));
        assert_eq!(c(BORDER_SEPARATOR), c(0x232328), "分隔线规格值 #232328");
        assert_eq!(dark.sidebar_border, c(BORDER_SEPARATOR));
        assert_eq!(dark.success, c(SEMANTIC_POSITIVE));
        assert_eq!(c(SEMANTIC_POSITIVE), c(0x22c55e), "正向规格值 #22c55e");
        assert_eq!(dark.warning, c(SEMANTIC_WARNING));
        assert_eq!(c(SEMANTIC_WARNING), c(0xf59e0b), "警示规格值 #f59e0b");
        assert_eq!(dark.danger, c(SEMANTIC_DANGER));
        assert_eq!(c(SEMANTIC_DANGER), c(0xef4444), "危险规格值 #ef4444");

        // 层级单调性：Root < Panel < Card < Hover（亮度递增的可感知层级）
        for (upper, lower, name) in [
            (dark.panel_bg, dark.window_bg, "Panel>Root"),
            (dark.card_bg, dark.panel_bg, "Card>Panel"),
            (dark.muted_fill, dark.card_bg, "Hover>Card"),
        ] {
            let lum = |col: Hsla| luminance(col);
            assert!(lum(upper) > lum(lower), "背景栈层级必须单调递增（{name}）");
        }
    }

    /// Hsla 近似亮度（0..1；仅用于背景栈单调性断言）
    fn luminance(col: Hsla) -> f64 {
        let rgba = gpui::Rgba::from(col);
        let r = f64::from(rgba.r);
        let g = f64::from(rgba.g);
        let b = f64::from(rgba.b);
        0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    /// BLF-792 回归锁：暗态禁重投影——卡片投影与侧栏选中投影必须完全透明
    /// （层级靠 1px 边界表达）；休眠浅色板保留极轻投影不受此约束。
    #[test]
    fn dark_mode_has_no_heavy_shadows() {
        let dark = AppTheme::dark();
        assert_eq!(dark.card_shadow.a, 0.0, "暗态卡片投影必须全透明");
        assert_eq!(dark.sidebar_item_shadow.a, 0.0, "暗态选中投影必须全透明");
        assert!(
            dark.card_shadow_box().color.a == 0.0,
            "card_shadow_box 在暗态必须不可见"
        );
        // 休眠浅色路径不受影响（极轻投影）
        let light = AppTheme::light();
        assert!(light.card_shadow.a > 0.0 && light.card_shadow.a < 0.1);
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
        assert_ne!(
            AppTheme::light().chart_primary,
            AppTheme::dark().chart_primary
        );
        assert_ne!(
            AppTheme::light().chart_secondary,
            AppTheme::dark().chart_secondary
        );
    }

    /// 回归锁：语义状态色（accent/success/danger/warning）在亮暗两态都必须
    /// 完全不透明——防透明黑回归（gpui-component 未定义基色是透明黑）。
    #[test]
    fn semantic_status_colors_are_opaque_in_both_modes() {
        for theme in [AppTheme::light(), AppTheme::dark()] {
            for color in [
                theme.accent,
                theme.success,
                theme.danger,
                theme.warning,
                theme.text_primary,
                theme.text_secondary,
            ] {
                assert_eq!(
                    color.a, 1.0,
                    "语义色必须不透明（防透明黑回归）：{:?}",
                    color
                );
            }
        }
        assert_ne!(AppTheme::light().success, AppTheme::dark().success);
    }

    /// 回归锁：delta 徽章浅底在亮暗两态都可用（半透明、非透明黑、与主色同相）。
    #[test]
    fn delta_soft_tokens_are_usable_in_both_modes() {
        for theme in [AppTheme::light(), AppTheme::dark()] {
            assert!(theme.success_soft.a > 0.0 && theme.success_soft.a < 1.0);
            assert!(theme.danger_soft.a > 0.0 && theme.danger_soft.a < 1.0);
            assert_eq!(theme.success_soft.h, theme.success.h);
            assert_eq!(theme.danger_soft.h, theme.danger.h);
            assert_eq!(theme.success.a, 1.0);
            assert_eq!(theme.danger.a, 1.0);
        }
    }

    /// BLF-792 回归锁：表格行 hover / 斑马纹 token 必须与行底（card_bg）可区分
    /// 且非全透明；hover 反馈强度必须大于斑马纹。
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
    }

    /// BLF-792 回归锁：紧凑字阶 token 必须落在规格区间——
    /// 正文/数据 13px（10pt）、标题 11~13pt bold ≈ 14~17px、辅助 ≤ 12px。
    #[test]
    fn compact_type_scale_tokens_contract() {
        assert_eq!(FONT_BASE, 13.0, "正文/数据基準必须 13px（10pt）");
        for (token, name) in [(FONT_TITLE, "小标题"), (FONT_TITLE_LG, "页面大标题/KPI")] {
            assert!(
                (14.0..=17.0).contains(&token),
                "{name} 必须落在标题区间 11~13pt ≈ 14~17px，实际 {token}"
            );
        }
        assert!(FONT_2XS < FONT_XS);
        assert!(FONT_XS < FONT_SM);
        assert!(FONT_SM < FONT_BASE);
        assert!(FONT_BASE < FONT_TITLE);
        assert!(FONT_TITLE < FONT_TITLE_LG);
    }

    /// BLF-792 回归锁：控件度量与最小间距 token——输入/按钮两档 24~28px、
    /// 表头 28px、最小间距收敛 2/4/8px。
    #[test]
    fn control_metrics_and_spacing_tokens_contract() {
        assert_eq!(HEIGHT_CONTROL_SM, 24.0);
        assert_eq!(HEIGHT_CONTROL_MD, 28.0);
        assert!(HEIGHT_CONTROL_SM < HEIGHT_CONTROL_MD);
        assert_eq!(TABLE_HEADER_HEIGHT, 28.0, "表头行高规格 28px");
        assert_eq!(SPACE_MIN, 2.0);
        assert_eq!(SPACE_SM, 4.0);
        assert_eq!(SPACE_MD, 8.0);
    }

    /// BLF-792 契约：等宽数字字体家族名（内嵌 JetBrains Mono；回归锁防止
    /// 改名导致 data_table mono 列与 add_fonts 注册失配）。
    #[test]
    fn mono_font_family_token_is_jetbrains_mono() {
        assert_eq!(FONT_MONO_FAMILY, "JetBrains Mono");
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

            // 强制浅色 → 恢复（休眠路径仍可用）
            gpui_component::Theme::change(ThemeMode::Light, None, cx);
            assert!(!AppTheme::current(cx).is_dark());
        });
    }
}
