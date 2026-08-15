//! 站点导航视图（GUI-12 / 2.0）
//!
//! frontend `app/dashboard/operations/site-navigation/page.tsx` 的 GPUI 等价：
//!
//! - 顶部 stats（平台总数 / 资讯论坛 / 平台类型）→ 3 张轻量统计卡；
//! - 平台 / 资讯论坛两个分组（数据权威在 `gui-domain::operations::site_navigation`）；
//! - 2-6 列响应式网格（按窗口宽度，对齐 frontend `grid-cols` 断点）；
//! - 点击平台卡片 → `App::open_url` 用 macOS 默认浏览器打开（系统能力，非内嵌 webview）；
//! - 平台卡片：库无 Card → `div` + 主题语义 token 自绘 + 品牌色渐变 wash
//!   （frontend `tone` 渐变首色 → GPUI `linear_gradient` 两端色近似，透明度 0.22 → 0）。
//!
//! 与 frontend 的已知差异（有意保留，GUI 0.2 能力边界）：
//! - frontend hover `-translate-y-1` 上浮：GPUI 0.2 无 transform，改为 hover 边框高亮 + 阴影加深；
//! - 图标映射：`Globe`（Globe2）/ `BookOpen`（ShoppingBag）/ `ChartPie`（Tag），
//!   IconName 无前端同名图标时取语义最近者。

use gpui::{
    div, linear_color_stop, linear_gradient, prelude::*, px, rgb, ClickEvent, Context, FontWeight,
    Hsla, Render, SharedString, Window,
};
use gpui_component::{h_flex, v_flex, ActiveTheme, Icon, IconName, Sizable, Theme};

use crate::theme::AppTheme;
use gui_domain::operations::site_navigation::{
    forum_count, forum_items, platform_count, platform_items, SiteNavigationItem, TYPE_LABEL,
};

/// 本页在侧栏中的 URL（root.rs 据此路由到本视图；与 gui-domain::sidebar 的站点导航条目一致）
pub const SITE_NAV_URL: &str = "/dashboard/operations/site-navigation";

/// 响应式列数（对齐 frontend `grid-cols-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6`）：
/// - < 768px（移动 / 窄窗）→ 2 列
/// - 768..1280（md）→ 3 列
/// - 1280..1536（xl）→ 4 列
/// - ≥ 1536（2xl）→ 6 列
pub fn grid_columns(window_width: f32) -> usize {
    match window_width {
        w if w < 768.0 => 2,
        w if w < 1280.0 => 3,
        w if w < 1536.0 => 4,
        _ => 6,
    }
}

/// 站点导航视图：纯静态数据（无状态机、无网络），每帧从窗口宽度算列数。
pub struct SiteNavigationView;

impl SiteNavigationView {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SiteNavigationView {
    fn default() -> Self {
        Self::new()
    }
}

impl Render for SiteNavigationView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        // 品牌强调色（P2-2：gpui-component 默认主题未定义 `blue` 基色，改用 AppTheme accent）
        let accent = AppTheme::current(cx).accent;
        // 窗口宽度驱动列数（窗口 resize 自动触发重渲染，列数随之变化）
        let columns = grid_columns(window.bounds().size.width.into());
        let platforms = platform_items();
        let forums = forum_items();

        v_flex()
            .id("site-navigation")
            .size_full()
            .gap_6()
            .p_6()
            .bg(theme.background)
            .overflow_y_scroll()
            .child(header_card(&theme, accent))
            .child(section(
                "平台",
                "核心运营入口",
                &platforms,
                columns,
                &theme,
                cx,
            ))
            .child(section(
                "资讯论坛",
                "行业信息与工具导航",
                &forums,
                columns,
                &theme,
                cx,
            ))
    }
}

// ---------------------------------------------------------------------------
// 顶部：PageHeader 等价（eyebrow pill + 描述 + 3 张 stats 卡）
// ---------------------------------------------------------------------------

/// 顶部统计卡（frontend PageHeader `actions`：平台总数 / 资讯论坛 / 平台类型）
fn header_card(theme: &Theme, accent: Hsla) -> impl IntoElement {
    v_flex()
        .id("site-nav-header")
        .gap_4()
        .p_5()
        .rounded(theme.radius)
        .border_1()
        .border_color(theme.border)
        .bg(theme.background)
        .child(
            h_flex()
                .flex_wrap()
                .items_start()
                .justify_between()
                .gap_4()
                .child(
                    v_flex()
                        .max_w(px(640.))
                        .gap_3()
                        .child(eyebrow_pill(accent))
                        .child(
                            div()
                                .text_sm()
                                .text_color(theme.muted_foreground)
                                .child("聚合主流跨境电商平台与运营入口，做成可视化书签卡片，方便团队一键直达高频站点。"),
                        ),
                )
                .child(
                    h_flex()
                        .gap_2()
                        .children(stats_cards(theme, accent)),
                ),
        )
}

/// Eyebrow pill（对齐 frontend PageHeader pill 形态：带 icon 的胶囊小标）
fn eyebrow_pill(accent: Hsla) -> impl IntoElement {
    h_flex()
        .items_center()
        .gap_2()
        .rounded_full()
        .border_1()
        .border_color(accent.opacity(0.25))
        .bg(accent.opacity(0.10))
        .px_3()
        .py_1()
        .child(
            Icon::new(IconName::Building2)
                .with_size(px(14.))
                .text_color(accent.opacity(0.9)),
        )
        .child(
            div()
                .text_xs()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(accent.opacity(0.9))
                .child(SharedString::from("运营导航 · 站点导航")),
        )
}

/// 3 张统计卡：图标 + 数值 + 标签（库无 Statistic 卡 → div 自绘，对齐 frontend stats）
fn stats_cards(theme: &Theme, accent: Hsla) -> Vec<impl IntoElement> {
    // (label, value, icon) 对齐 frontend `stats` 数组
    let stats: [(&str, SharedString, IconName); 3] = [
        (
            "平台总数",
            SharedString::from(platform_count().to_string()),
            IconName::Globe,
        ),
        (
            "资讯论坛",
            SharedString::from(forum_count().to_string()),
            IconName::BookOpen,
        ),
        (
            "平台类型",
            SharedString::from(TYPE_LABEL),
            IconName::ChartPie,
        ),
    ];

    stats
        .iter()
        .map(|(label, value, icon)| {
            v_flex()
                .items_center()
                .gap_1()
                .px_3()
                .py_2()
                .w(px(104.))
                .rounded(theme.radius)
                .border_1()
                .border_color(theme.border)
                .bg(theme.muted)
                .child(
                    Icon::new(icon.clone())
                        .with_size(px(16.))
                        .text_color(accent.opacity(0.85)),
                )
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.foreground)
                        .child(value.clone()),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(SharedString::from(*label)),
                )
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 分组 + 平台卡片
// ---------------------------------------------------------------------------

/// 分组区块：标题 + 副标题 + 响应式网格
fn section(
    title: &str,
    subtitle: &str,
    items: &[SiteNavigationItem],
    columns: usize,
    theme: &Theme,
    cx: &mut Context<SiteNavigationView>,
) -> impl IntoElement {
    v_flex()
        .id(SharedString::from(format!("site-nav-section-{title}")))
        .gap_3()
        .child(
            h_flex()
                .items_end()
                .justify_between()
                .gap_3()
                .child(
                    div()
                        .text_lg()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.foreground)
                        .child(SharedString::from(title.to_string())),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(SharedString::from(subtitle.to_string())),
                ),
        )
        .child(
            div()
                .grid()
                .grid_cols(columns as u16)
                .gap_2()
                .children(items.iter().map(|item| platform_card(item, theme, cx))),
        )
}

/// 单张平台卡片：渐变 wash + 名称 + 区域 Badge + 品类 + 「点击直达」
fn platform_card(
    item: &SiteNavigationItem,
    theme: &Theme,
    cx: &mut Context<SiteNavigationView>,
) -> impl IntoElement {
    // frontend `tone` 首色 → 渐变 wash（0.22 → 0 透明度，≈ from-[色]/20~25 via-… to-transparent）
    let accent = accent_hsla(item);
    let href = item.href.clone();
    let card_id = SharedString::from(format!("site-nav-card-{}", item.name));

    v_flex()
        .id(card_id)
        .relative()
        .overflow_hidden()
        .h_full()
        .gap_3()
        .p_4()
        .rounded_2xl()
        .border_1()
        .border_color(theme.border)
        .bg(theme.background)
        .cursor_pointer()
        .hover(|this| {
            this.border_color(accent.opacity(0.55))
                .shadow(vec![gpui::BoxShadow {
                    color: accent.opacity(0.12),
                    blur_radius: px(20.0),
                    spread_radius: px(0.0),
                    offset: gpui::Point {
                        x: px(0.0),
                        y: px(8.0),
                    },
                }])
        })
        .on_click(cx.listener(move |_, _: &ClickEvent, _, cx| {
            tracing::info!(href, "打开外部站点");
            // 用系统默认浏览器打开（macOS Safari / 默认浏览器；非内嵌 webview）
            cx.open_url(&href);
        }))
        // 渐变 wash（absolute 铺底；内容在 relative z 之上）
        .child(div().absolute().inset_0().bg(linear_gradient(
            135.0,
            linear_color_stop(accent.opacity(0.22), 0.0),
            linear_color_stop(accent.opacity(0.0), 1.0),
        )))
        .child(
            v_flex()
                .relative()
                .h_full()
                .gap_3()
                .child(
                    h_flex()
                        .items_start()
                        .justify_between()
                        .gap_3()
                        .child(
                            v_flex()
                                .gap_2()
                                .items_start()
                                .child(
                                    div()
                                        .text_lg()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(theme.foreground)
                                        .child(SharedString::from(item.name.clone())),
                                )
                                .child(region_badge(item, theme)),
                        )
                        .child(
                            // 右上角外链图标（hover 变品牌色）
                            div()
                                .rounded_lg()
                                .border_1()
                                .border_color(theme.border)
                                .bg(theme.muted)
                                .p_1()
                                .text_color(theme.muted_foreground)
                                .hover(|this| this.text_color(accent))
                                .child(Icon::new(IconName::ExternalLink).with_size(px(16.))),
                        ),
                )
                .child(
                    // 品类描述（min-h-12 + flex-1，对齐 frontend 保证底部对齐）
                    div()
                        .min_h(px(48.))
                        .flex_1()
                        .text_sm()
                        .text_color(theme.muted_foreground)
                        .child(SharedString::from(item.category.clone())),
                )
                .child(
                    h_flex()
                        .items_center()
                        .justify_between()
                        .gap_2()
                        .border_t_1()
                        .border_color(theme.border)
                        .pt_3()
                        .child(category_pill(item, theme))
                        .child(
                            h_flex()
                                .items_center()
                                .gap_1()
                                .text_xs()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(accent.opacity(0.8))
                                .child(SharedString::from("点击直达")),
                        ),
                ),
        )
}

/// 区域 Badge（Building2 icon + 区域名；对齐 frontend region pill）
fn region_badge(item: &SiteNavigationItem, theme: &Theme) -> impl IntoElement {
    h_flex()
        .items_center()
        .gap_1()
        .rounded_full()
        .border_1()
        .border_color(theme.border)
        .bg(theme.muted)
        .px_2()
        .py_0p5()
        .child(
            Icon::new(IconName::Building2)
                .with_size(px(12.))
                .text_color(theme.muted_foreground),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .child(SharedString::from(item.region.clone())),
        )
}

/// 品类 pill（对齐 frontend 卡片底部品类标签）
fn category_pill(item: &SiteNavigationItem, theme: &Theme) -> impl IntoElement {
    h_flex()
        .items_center()
        .rounded_full()
        .border_1()
        .border_color(theme.border)
        .bg(theme.muted)
        .px_2p5()
        .py_1()
        .child(
            div()
                .text_xs()
                .text_color(theme.foreground.opacity(0.85))
                .child(SharedString::from(item.category.clone())),
        )
}

/// 品牌强调色（frontend `tone` 首色 → Hsla）
fn accent_hsla(item: &SiteNavigationItem) -> Hsla {
    // gpui `rgb()` 接收单个 0xRRGGBB 十六进制值，由三元组拼装
    let hex = (item.accent_rgb.0 as u32) << 16
        | (item.accent_rgb.1 as u32) << 8
        | item.accent_rgb.2 as u32;
    rgb(hex).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_columns_follow_frontend_breakpoints() {
        // frontend: base/sm=2, md(768)=3, xl(1280)=4, 2xl(1536)=6
        assert_eq!(grid_columns(0.0), 2);
        assert_eq!(grid_columns(640.0), 2);
        assert_eq!(grid_columns(767.0), 2);
        assert_eq!(grid_columns(768.0), 3);
        assert_eq!(grid_columns(1000.0), 3);
        assert_eq!(grid_columns(1279.0), 3);
        assert_eq!(grid_columns(1280.0), 4); // 默认主窗口 1280 宽 → 4 列
        assert_eq!(grid_columns(1535.0), 4);
        assert_eq!(grid_columns(1536.0), 6);
        assert_eq!(grid_columns(2560.0), 6);
    }

    #[test]
    fn accent_color_matches_frontend_tone() {
        let items = site_navigation_items_test();
        let amazon = items.iter().find(|i| i.name == "Amazon").unwrap();
        let hsla: Hsla = accent_hsla(amazon);
        let rgba = gpui::Rgba::from(hsla);
        assert_eq!((rgba.r * 255.0).round() as u8, 0xff);
        assert_eq!((rgba.g * 255.0).round() as u8, 0x99);
        assert_eq!((rgba.b * 255.0).round() as u8, 0x00);
    }

    fn site_navigation_items_test() -> Vec<SiteNavigationItem> {
        gui_domain::operations::site_navigation::site_navigation_items()
    }

    // 渲染冒烟：7 卡两组 + stats（TestAppContext + 真实窗口）
    #[gpui::test]
    async fn view_renders_with_sections_and_stats(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        // add_window_view 内部已完成首帧渲染（render 覆盖 header stats + 平台/论坛两组 7 卡）
        let (_view, _cx) = cx.add_window_view(|_window, _cx| SiteNavigationView::new());
    }
}
