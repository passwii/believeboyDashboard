//! 图表基元（P5-0 公共基建，BLF-759）
//!
//! 从 dashboard 图表（BLF-702）中抽象出的可复用图表构建块：折线 / 面积 /
//! 柱状 / 占比环形 + 图例 + 卡片外壳 + 空态。后续业务视图（库存、财务、
//! 报表等）直接复用，不重复造轮子；gpui-component 0.5.1 `chart` 模块
//! 能力边界见 widgets/charts.rs 头部说明（无 radar / sankey / 双 Y 轴等）。
//!
//! 数据形状约定：
//! - [`TrendPoint`]：单序列趋势点（X 标签 + 数值）；
//! - [`ShareRow`]：占比 / 分布行（名称 + 数值），供环形图 / 柱状图 / 图例共用；
//! - [`SalesSpendPoint`]：双序列对比点（dashboard 销售额 vs 广告花费）。
//!
//! 色板统一走 `AppTheme`（`chart_primary / chart_secondary / chart_tertiary /
//! chart_palette()`），亮暗两态由 theme.rs 保证对比度。

use gpui::{div, prelude::*, px, FontWeight, Hsla, IntoElement, ParentElement, SharedString, Styled};
use gpui_component::{
    chart::{AreaChart, BarChart, LineChart, PieChart},
    h_flex, v_flex, Icon, Sizable, StyledExt,
};

use crate::theme::AppTheme;
use crate::views::stat_band::{format_compact_currency, render_delta};
use crate::widgets::top_projects::fmt_money_precise;

// ---------------------------------------------------------------------------
// 数据形状
// ---------------------------------------------------------------------------

/// 趋势图数据点（X 轴标签 = "M/D"，对齐 frontend `dayLabel`）
#[derive(Debug, Clone, PartialEq)]
pub struct TrendPoint {
    pub label: String,
    pub value: f64,
}

/// 双序列对比点（销售额 vs 广告花费）
#[derive(Debug, Clone, PartialEq)]
pub struct SalesSpendPoint {
    pub label: String,
    pub sales: f64,
    pub ad_spend: f64,
}

/// 占比 / 分布行（项目 / 国家销售额等）
#[derive(Debug, Clone, PartialEq)]
pub struct ShareRow {
    pub name: String,
    pub sales: f64,
}

// ---------------------------------------------------------------------------
// 图表构建（gpui-component chart）
// ---------------------------------------------------------------------------

/// 把占比行按分段色板着色（供 PieChart / 图例共用，保证扇形与图例颜色一致）
pub(crate) fn decorate(rows: &[ShareRow], palette: &[Hsla; 6]) -> Vec<(ShareRow, Hsla)> {
    rows.iter()
        .enumerate()
        .map(|(i, r)| (r.clone(), palette[i % palette.len()]))
        .collect()
}

/// 单序列趋势折线（销售额等）
pub fn trend_line_chart(points: &[TrendPoint], color: Hsla) -> impl IntoElement {
    LineChart::new(points.to_vec())
        .x(|p| p.label.clone())
        .y(|p| p.value)
        .stroke(color)
        .natural()
        .dot()
        .tick_margin(1)
}

/// 单序列面积图（库存 / 流量；`fill_alpha` 如 0.22）
pub fn trend_area_chart(points: &[TrendPoint], color: Hsla, fill_alpha: f32) -> impl IntoElement {
    AreaChart::new(points.to_vec())
        .x(|p| p.label.clone())
        .y(|p| p.value)
        .stroke(color)
        .fill(color.opacity(fill_alpha))
        .natural()
        .tick_margin(1)
}

/// 双序列面积图（共用轴；dashboard 销售额 vs 广告花费）
pub fn dual_area_chart(
    points: &[SalesSpendPoint],
    primary: Hsla,
    secondary: Hsla,
) -> impl IntoElement {
    AreaChart::new(points.to_vec())
        .x(|p| p.label.clone())
        .y(|p| p.sales)
        .y(|p| p.ad_spend)
        .stroke(primary)
        .stroke(secondary)
        .fill(primary.opacity(0.18))
        .fill(secondary.opacity(0.18))
        .linear()
        .linear()
        .tick_margin(1)
}

/// 柱状分布图（跨国家等；柱顶 `$K` 标签）
pub fn bar_series_chart(rows: &[ShareRow], color: Hsla) -> impl IntoElement {
    BarChart::new(rows.to_vec())
        .x(|r| r.name.clone())
        .y(|r| r.sales)
        .fill(move |_| color)
        .label(|r| format_compact_currency(r.sales))
        .tick_margin(1)
}

/// 环形占比图（`inner_radius` 为内径 px；图例由 [`share_legend`] 自绘）
pub fn donut_share_chart(
    rows: &[ShareRow],
    inner_radius: f32,
    theme: &AppTheme,
) -> impl IntoElement {
    let palette = theme.chart_palette();
    PieChart::new(decorate(rows, &palette))
        .value(|(r, _)| r.sales as f32)
        .color(|(_, c)| *c)
        .inner_radius(inner_radius)
}

/// 占比图例行：色点 + 名称（截断）+ 金额 + 占比
pub fn share_legend(rows: &[ShareRow], total: f64, theme: &AppTheme) -> impl IntoElement {
    let palette = theme.chart_palette();
    let decorated = decorate(rows, &palette);
    v_flex()
        .gap_2()
        .children(decorated.into_iter().map(|(row, color)| {
            let share = if total > 0.0 {
                row.sales / total * 100.0
            } else {
                0.0
            };
            h_flex()
                .w_full()
                .gap_2()
                .items_center()
                .child(div().size_2p5().rounded_full().bg(color))
                .child(
                    div()
                        .flex_1()
                        .text_xs()
                        .text_color(theme.text_secondary)
                        .truncate()
                        .child(row.name),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(fmt_money_precise(row.sales)),
                )
                .child(
                    div()
                        .w_11()
                        .text_right()
                        .text_xs()
                        .text_color(theme.text_primary)
                        .child(format!("{share:.1}%")),
                )
        }))
}

// ---------------------------------------------------------------------------
// 卡片外壳
// ---------------------------------------------------------------------------

/// 图表卡外壳：卡片底 + 头部（图标气泡 + 标题 + 环比 + 描述）+ 图表区。
/// `delta` 为 `None` 时头部不渲染环比徽章（对齐 frontend 有/无 Delta 的卡片）。
pub fn chart_card(
    id: &'static str,
    title: &'static str,
    description: impl Into<SharedString>,
    icon_path: &'static str,
    delta: Option<Option<f64>>,
    theme: &AppTheme,
    body: impl IntoElement,
) -> impl IntoElement {
    // 图标气泡底：亮色 accent_soft（蓝 50）/ 暗色 muted_fill
    let chip_bg = if theme.is_dark() {
        theme.muted_fill
    } else {
        theme.accent_soft
    };
    let chip_icon = if theme.is_dark() {
        theme.text_muted
    } else {
        theme.accent
    };
    v_flex()
        .id(id)
        .w_full()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .p_4()
        .gap_3()
        .child(
            v_flex()
                .gap_1()
                .child(
                    h_flex()
                        .gap_2()
                        .items_center()
                        .child(
                            h_flex()
                                .size_7()
                                .flex_shrink_0()
                                .items_center()
                                .justify_center()
                                .rounded_md()
                                .bg(chip_bg)
                                .child(
                                    Icon::empty()
                                        .path(icon_path)
                                        .with_size(px(14.))
                                        .text_color(chip_icon),
                                ),
                        )
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.text_primary)
                                .child(title),
                        )
                        .when(delta.is_some(), |this| {
                            let delta = delta.unwrap();
                            this.child(render_delta(delta, theme, title))
                        }),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(description.into()),
                ),
        )
        .child(body)
}

/// 图表区容器：固定高度（图表元素 layout 为 Size::full()，必须由父容器给定尺寸）
pub fn chart_area(chart_height_px: f32, chart: impl IntoElement) -> impl IntoElement {
    div().w_full().h(px(chart_height_px)).child(chart)
}

/// 图表区空态（无该维度数据时居中提示）
pub fn chart_empty(text: &'static str, chart_height_px: f32, theme: &AppTheme) -> impl IntoElement {
    div()
        .w_full()
        .h(px(chart_height_px))
        .rounded(px(theme.radius))
        .flex()
        .items_center()
        .justify_center()
        .text_sm()
        .text_color(theme.text_muted)
        .child(text)
}

/// footer 统计项（label + 数值；流量卡等底部统计条）
pub fn stat_item(
    label: &'static str,
    value: impl Into<SharedString>,
    theme: &AppTheme,
) -> impl IntoElement {
    h_flex()
        .gap_1()
        .text_xs()
        .child(div().text_color(theme.text_muted).child(label))
        .child(
            div()
                .font_semibold()
                .text_color(if theme.is_dark() {
                    theme.text_primary
                } else {
                    theme.accent
                })
                .child(value.into()),
        )
}

/// 大数字展示（库存等区间末快照；与 footer 统计区分）
pub fn big_number(
    value: impl Into<SharedString>,
    unit: impl Into<SharedString>,
    theme: &AppTheme,
) -> impl IntoElement {
    h_flex()
        .gap_1p5()
        .items_baseline()
        .child(
            div()
                .text_2xl()
                .font_semibold()
                .text_color(if theme.is_dark() {
                    theme.text_primary
                } else {
                    theme.accent
                })
                .child(value.into()),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .child(unit.into()),
        )
}
