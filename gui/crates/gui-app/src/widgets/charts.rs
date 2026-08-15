//! Dashboard 图表真渲染（P3-2 / BLF-702，BLF-672 遗留项 v1.1 收口）
//!
//! 把 GUI-8（1.0-c）的 6 张图表占位卡（`chart_placeholder`）换成
//! gpui-component `chart` 模块真图表，数据源复用 P3-1 daily-analysis 管线
//! （`DashboardData` 的 summary_rows / project_breakdown / country_breakdown +
//! 对比期）。图表顺序 / 标题 / 描述 / 高度与 frontend `app/dashboard/page.tsx`
//! 挂载顺序及 `v2-*-chart.tsx` 的 CardTitle / CardDescription 逐字对齐。
//!
//! ## 图表选型（调研结论：gpui-component 0.5.1 `chart` 模块）
//!
//! 可用图型：`LineChart`（单序列折线）/ `AreaChart`（多序列面积，**唯一支持
//! 多 y 序列的图型**）/ `BarChart`（单序列柱状，支持每柱 fill + 柱顶 label）/
//! `PieChart`（饼图/环形图，无内建图例与标签）/ `CandlestickChart`。
//! 无 radar / sankey / 双 Y 轴 / Y 轴刻度文字（只画 X 轴标签 + 虚线网格）。
//!
//! 六卡映射：
//! | 卡 | frontend 图型 | GUI 图型 | 说明 |
//! |---|---|---|---|
//! | 销售额 | Bar(销售额)+Line(销量) 双轴 | `LineChart` 单序列 | 趋势折线；销量并入头部环比 |
//! | 销售额 vs 广告花费 | 双线双轴 | `AreaChart` 双序列 | 双轴不支持 → 共用轴（诚实呈现量级差），PR 说明 |
//! | 项目销售额对比 | 纵向 Bar Top 5 | `PieChart` 环形 + 图例 | 占比（平台/项目）；图例含金额与百分比 |
//! | 跨国家销售额 | 横向 Bar Top 6 | `BarChart` 纵向 | 占比（站点）；柱顶 $K 标签 |
//! | 库存水位 | Area + 大数字 | `AreaChart` 单序列 + 快照数字 | 与 frontend 同构 |
//! | 流量与转化 | Bar+Line 双轴 + footer | `AreaChart`(浏览量) + footer 统计 | 转化率并入 footer（双轴不支持） |
//!
//! ## 已知差异（能力不足的回退，写入 PR 说明）
//!
//! - 无 Y 轴刻度 → 量级信息由头部环比 / 图例金额 / 柱顶标签 / footer 统计补足；
//! - 无双 Y 轴 → 销售额 vs 广告花费共用轴（销售额数百~数千，广告花费数十~数百，
//!   同一尺度下仍可观察趋势与量级差）；
//! - 无饼图内建标签 → 环形图右侧自绘图例（名称 + 金额 + 占比）。
//!
//! ## 架构（沿用 Phase 1/2 模式）
//!
//! - 纯函数数据派生（`revenue_trend` / `sales_vs_spend` / `project_share` /
//!   `country_share` / `stock_trend` / `traffic_stats`）——不依赖 gpui，可单测；
//! - 展示层只做「渲染」：图表元素（`LineChart` 等）实现 `gpui::Element`，
//!   布局尺寸 = 父容器 full（须放入固定高度 div，`chart_height_px` 对齐
//!   frontend `chartClass` 的 md 档 h-80=320 / h-64=256）；
//! - 卡片语言沿用 P2-4（radius_lg + 轻投影 + 头部图标气泡），色板用 AppTheme
//!   chart_* token（hex 集中在 theme.rs）。

use chrono::{Datelike, NaiveDate};
use gpui::{
    div, prelude::*, px, FontWeight, Hsla, IntoElement, ParentElement, SharedString, Styled,
};
use gpui_component::{
    chart::{AreaChart, BarChart, LineChart, PieChart},
    h_flex, v_flex, Icon, Sizable, StyledExt,
};
use gui_domain::dashboard::DailyAnalysisRow;

use crate::theme::AppTheme;
use crate::views::daily_analysis::country_label;
use crate::views::dashboard::{CountryBreakdownData, DashboardData};
use crate::views::stat_band::{format_compact_currency, pct_change, render_delta};
use crate::widgets::top_projects::{fmt_money_precise, fmt_num_precise};

// ---------------------------------------------------------------------------
// 数据派生（纯函数，供测试；口径对齐 frontend v2-*-chart.tsx）
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

/// 占比 / 分布行（项目 / 国家销售额）
#[derive(Debug, Clone, PartialEq)]
pub struct ShareRow {
    pub name: String,
    pub sales: f64,
}

/// 流量汇总（对齐 frontend `computeTrafficStats`）
#[derive(Debug, Clone, PartialEq)]
pub struct TrafficStats {
    pub total_page_views: i64,
    pub total_sessions: i64,
    pub total_units_ordered: i64,
    pub conversion_rate_pct: f64,
}

/// ISO 日期 → "M/D"（对齐 frontend v2-revenue-chart `dayLabel`）
fn day_label(date: NaiveDate) -> String {
    format!("{}/{}", date.month(), date.day())
}

/// 近 7 天每日销售额（趋势折线数据源；对齐 frontend V2RevenueChart chartRows）
pub fn revenue_trend(rows: &[DailyAnalysisRow]) -> Vec<TrendPoint> {
    rows.iter()
        .map(|r| TrendPoint {
            label: day_label(r.date),
            value: r.sales_amount,
        })
        .collect()
}

/// 近 7 天每日销售额 vs 广告花费（对比数据源；对齐 frontend V2ChannelChart data）
pub fn sales_vs_spend(rows: &[DailyAnalysisRow]) -> Vec<SalesSpendPoint> {
    rows.iter()
        .map(|r| SalesSpendPoint {
            label: day_label(r.date),
            sales: r.sales_amount,
            ad_spend: r.ad_spend,
        })
        .collect()
}

/// 项目销售额 Top 5（占比数据源；对齐 frontend V2ProjectChart
/// `computeTopProjects(...).slice(0, 5)`：只统计有聚合行的项目，默认销售额降序）。
///
/// 与 top_projects 表格的有意差异：图表直接消费 `project_breakdown` 全量
/// （管理列表外的项目有数据也展示，名称缺失回退「项目 {id}」），表格仍按
/// frontend 语义以项目列表为基准过滤。
pub fn project_share(data: &DashboardData) -> Vec<ShareRow> {
    const TOP_N: usize = 5;
    let Some(daily) = &data.daily else {
        return Vec::new();
    };
    let mut rows: Vec<ShareRow> = Vec::new();
    for (project_id, entry) in &daily.project_breakdown {
        if entry.summary_rows.is_empty() {
            continue;
        }
        let sales: f64 = entry.summary_rows.iter().map(|r| r.sales_amount).sum();
        let name = if entry.project_name.is_empty() {
            data.projects
                .iter()
                .find(|p| p.id == *project_id)
                .map(|p| p.name.clone())
                .unwrap_or_else(|| format!("项目 {project_id}"))
        } else {
            entry.project_name.clone()
        };
        rows.push(ShareRow { name, sales });
    }
    rows.sort_by(|a, b| b.sales.total_cmp(&a.sales));
    rows.truncate(TOP_N);
    rows
}

/// 国家销售额 Top 6（占比数据源；对齐 frontend `computeCountryTotals`：按销售额
/// 降序取 Top 6，国家展示名用 frontend 站点名）。
pub fn country_share(country: Option<&CountryBreakdownData>) -> Vec<ShareRow> {
    const TOP_N: usize = 6;
    let Some(country) = country else {
        return Vec::new();
    };
    let mut rows: Vec<ShareRow> = Vec::new();
    for (code, entry) in &country.breakdown {
        if entry.summary_rows.is_empty() {
            continue;
        }
        let sales: f64 = entry.summary_rows.iter().map(|r| r.sales_amount).sum();
        rows.push(ShareRow {
            name: country_label(code),
            sales,
        });
    }
    rows.sort_by(|a, b| b.sales.total_cmp(&a.sales));
    rows.truncate(TOP_N);
    rows
}

/// 库存水位（近 7 天可用库存）：趋势点 + 区间末快照（对齐 frontend `computeStockTrend`）
pub fn stock_trend(rows: &[DailyAnalysisRow]) -> (Vec<TrendPoint>, i64) {
    let points: Vec<TrendPoint> = rows
        .iter()
        .map(|r| TrendPoint {
            label: day_label(r.date),
            value: r.available_qty as f64,
        })
        .collect();
    let current = rows.last().map(|r| r.available_qty).unwrap_or(0);
    (points, current)
}

/// 流量统计（对齐 frontend `computeTrafficStats`：转化率 = units_ordered / page_views × 100）
pub fn compute_traffic_stats(rows: &[DailyAnalysisRow]) -> TrafficStats {
    let mut total_page_views = 0i64;
    let mut total_sessions = 0i64;
    let mut total_units_ordered = 0i64;
    for r in rows {
        total_page_views += r.page_views;
        total_sessions += r.sessions;
        total_units_ordered += r.units_ordered;
    }
    let conversion_rate_pct = if total_page_views > 0 {
        total_units_ordered as f64 / total_page_views as f64 * 100.0
    } else {
        0.0
    };
    TrafficStats {
        total_page_views,
        total_sessions,
        total_units_ordered,
        conversion_rate_pct,
    }
}

/// 流量趋势（浏览量）+ 汇总统计（对齐 frontend V2TrafficChart）
pub fn traffic_trend(rows: &[DailyAnalysisRow]) -> (Vec<TrendPoint>, TrafficStats) {
    let points: Vec<TrendPoint> = rows
        .iter()
        .map(|r| TrendPoint {
            label: day_label(r.date),
            value: r.page_views as f64,
        })
        .collect();
    (points, compute_traffic_stats(rows))
}

/// 销售额环比（当前期 vs 对比期；对齐 frontend delta = (total - prevTotal) / prevTotal × 100，
/// 对比期为 0 / 缺失 → 0，不产生 ±∞）
fn sales_delta(current: &[DailyAnalysisRow], compare: &[DailyAnalysisRow]) -> Option<f64> {
    let total: f64 = current.iter().map(|r| r.sales_amount).sum();
    let prev: f64 = compare.iter().map(|r| r.sales_amount).sum();
    Some(pct_change(total, prev))
}

/// 库存环比（区间末快照 vs 对比期末快照；对齐 frontend `computeStockTrend` 的
/// `delta = prev > 0 ? (current - prev) / prev × 100 : 0`）
fn stock_delta(current: &[DailyAnalysisRow], compare: &[DailyAnalysisRow]) -> Option<f64> {
    let cur = current
        .last()
        .map(|r| r.available_qty as f64)
        .unwrap_or(0.0);
    let prev = compare
        .last()
        .map(|r| r.available_qty as f64)
        .unwrap_or(0.0);
    Some(pct_change(cur, prev))
}

// ---------------------------------------------------------------------------
// 图表元素构建（gpui-component chart）
// ---------------------------------------------------------------------------

/// 把占比行按分段色板着色（供 PieChart / 图例共用，保证扇形与图例颜色一致）
fn decorate(rows: &[ShareRow], palette: &[Hsla; 6]) -> Vec<(ShareRow, Hsla)> {
    rows.iter()
        .enumerate()
        .map(|(i, r)| (r.clone(), palette[i % palette.len()]))
        .collect()
}

/// 趋势折线（单序列；销售额卡）
fn line_chart(points: &[TrendPoint], color: Hsla) -> impl IntoElement {
    LineChart::new(points.to_vec())
        .x(|p| p.label.clone())
        .y(|p| p.value)
        .stroke(color)
        .natural()
        .dot()
        .tick_margin(1)
}

/// 双序列面积图（销售额 vs 广告花费；共用轴）
fn sales_spend_chart(points: &[SalesSpendPoint], theme: &AppTheme) -> impl IntoElement {
    AreaChart::new(points.to_vec())
        .x(|p| p.label.clone())
        .y(|p| p.sales)
        .y(|p| p.ad_spend)
        .stroke(theme.chart_primary)
        .stroke(theme.chart_secondary)
        .fill(theme.chart_primary.opacity(0.18))
        .fill(theme.chart_secondary.opacity(0.18))
        .linear()
        .linear()
        .tick_margin(1)
}

/// 环形占比图（项目销售额；右侧图例由调用方绘制）
fn pie_chart(rows: &[ShareRow], inner_radius: f32, theme: &AppTheme) -> impl IntoElement {
    let palette = theme.chart_palette();
    PieChart::new(decorate(rows, &palette))
        .value(|(r, _)| r.sales as f32)
        .color(|(_, c)| *c)
        .inner_radius(inner_radius)
}

/// 柱状分布图（跨国家销售额；柱顶 $K 标签）
fn bar_chart(rows: &[ShareRow], color: Hsla) -> impl IntoElement {
    BarChart::new(rows.to_vec())
        .x(|r| r.name.clone())
        .y(|r| r.sales)
        .fill(move |_| color)
        .label(|r| format_compact_currency(r.sales))
        .tick_margin(1)
}

/// 单序列面积图（库存 / 流量）
fn area_chart(points: &[TrendPoint], color: Hsla, fill_alpha: f32) -> impl IntoElement {
    AreaChart::new(points.to_vec())
        .x(|p| p.label.clone())
        .y(|p| p.value)
        .stroke(color)
        .fill(color.opacity(fill_alpha))
        .natural()
        .tick_margin(1)
}

// ---------------------------------------------------------------------------
// 卡片渲染
// ---------------------------------------------------------------------------

/// 图表卡外壳：卡片底 + 头部（图标气泡 + 标题 + 环比 + 描述）+ 图表区。
/// `delta` 为 `None` 时头部不渲染环比徽章（对齐 frontend 有/无 Delta 的卡片）。
fn chart_card(
    id: &'static str,
    title: &'static str,
    description: impl Into<SharedString>,
    icon_path: &'static str,
    delta: Option<Option<f64>>,
    theme: &AppTheme,
    body: impl IntoElement,
) -> impl IntoElement {
    // 图标气泡底：亮色 accent_soft（蓝 50）/ 暗色 muted_fill（对齐 frontend
    // `bg-blue-100 dark:bg-[hsl(var(--surface-subtle))]`）
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
                                .text_size(px(14.))
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
                        .text_size(px(12.))
                        .text_color(theme.text_muted)
                        .child(description.into()),
                ),
        )
        .child(body)
}

/// 图表区容器：固定高度（对齐 frontend chartClass md 档）——图表元素 layout
/// 为 Size::full()，必须由父容器给定尺寸。
fn chart_area(chart_height_px: f32, chart: impl IntoElement) -> impl IntoElement {
    div().w_full().h(px(chart_height_px)).child(chart)
}

/// 图表区空态（无该维度数据时居中提示）
fn chart_empty(text: &'static str, chart_height_px: f32, theme: &AppTheme) -> impl IntoElement {
    div()
        .w_full()
        .h(px(chart_height_px))
        .rounded(px(theme.radius))
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(13.))
        .text_color(theme.text_muted)
        .child(text)
}

/// 1. 销售额（趋势折线；环比徽章 + 每日销售额）
fn revenue_card(
    rows: &[DailyAnalysisRow],
    compare: &[DailyAnalysisRow],
    theme: &AppTheme,
) -> impl IntoElement {
    let points = revenue_trend(rows);
    let delta = sales_delta(rows, compare);
    chart_card(
        "chart-revenue",
        "销售额",
        "每日销售额与销量（近 7 天）",
        "icons/trending-up.svg",
        Some(delta),
        theme,
        if points.is_empty() {
            chart_empty("暂无销售数据", 320.0, theme).into_any_element()
        } else {
            chart_area(320.0, line_chart(&points, theme.chart_primary)).into_any_element()
        },
    )
}

/// 2. 销售额 vs 广告花费（双序列面积；共用轴）
fn channel_card(
    rows: &[DailyAnalysisRow],
    compare: &[DailyAnalysisRow],
    theme: &AppTheme,
) -> impl IntoElement {
    let points = sales_vs_spend(rows);
    let delta = sales_delta(rows, compare);
    chart_card(
        "chart-channel",
        "销售额 vs 广告花费",
        "每日销售额与广告花费对比（近 7 天，双轴）",
        "icons/bar-chart-3.svg",
        Some(delta),
        theme,
        if points.is_empty() {
            chart_empty("暂无销售数据", 320.0, theme).into_any_element()
        } else {
            chart_area(320.0, sales_spend_chart(&points, theme)).into_any_element()
        },
    )
}

/// 3. 项目销售额对比（环形占比 + 图例）
fn project_card(data: &DashboardData, theme: &AppTheme) -> impl IntoElement {
    let rows = project_share(data);
    let total: f64 = rows.iter().map(|r| r.sales).sum();
    let palette = theme.chart_palette();
    let legend = legend_list(&rows, &palette, total, theme);
    let body = if rows.is_empty() {
        chart_empty("暂无项目数据", 256.0, theme).into_any_element()
    } else {
        div()
            .w_full()
            .flex()
            .gap_3()
            .items_center()
            .child(
                // 环形图：外径 = 0.4 × 高度（gpui-component 默认），内径取一半 → 环
                div()
                    .flex_1()
                    .child(pie_chart(&rows, 256.0 * 0.4 * 0.5, theme)),
            )
            .child(div().w(px(150.)).child(legend))
            .into_any_element()
    };
    chart_card(
        "chart-project",
        "项目销售额对比",
        "近 7 天各项目销售额 Top 5",
        "icons/store.svg",
        None,
        theme,
        body,
    )
}

/// 4. 跨国家销售额（柱状分布；柱顶 $K 标签）
fn country_card(country: Option<&CountryBreakdownData>, theme: &AppTheme) -> impl IntoElement {
    let rows = country_share(country);
    let description = country
        .map(|c| {
            if c.representative_project_name.is_empty() {
                "各站点销售额分布".to_string()
            } else {
                format!("{} · 各站点销售额分布", c.representative_project_name)
            }
        })
        .unwrap_or_else(|| "各站点销售额分布".to_string());
    let body = if rows.is_empty() {
        chart_empty("暂无国家数据", 256.0, theme).into_any_element()
    } else {
        chart_area(256.0, bar_chart(&rows, theme.chart_secondary)).into_any_element()
    };
    chart_card(
        "chart-country",
        "跨国家销售额",
        description,
        "icons/layers.svg",
        None,
        theme,
        body,
    )
}

/// 5. 库存水位（面积图 + 区间末快照大数字）
fn stock_card(
    rows: &[DailyAnalysisRow],
    compare: &[DailyAnalysisRow],
    theme: &AppTheme,
) -> impl IntoElement {
    let (points, current) = stock_trend(rows);
    let delta = stock_delta(rows, compare); // 库存环比 = 区间末快照 vs 对比期末快照（对齐 frontend）
    let body = if points.is_empty() {
        chart_empty("暂无库存数据", 256.0, theme).into_any_element()
    } else {
        v_flex()
            .gap_2()
            .child(
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
                            .child(fmt_num_precise(current)),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child("件 · 区间末快照"),
                    ),
            )
            .child(chart_area(
                256.0 - 44.0,
                area_chart(&points, theme.chart_tertiary, 0.22),
            ))
            .into_any_element()
    };
    chart_card(
        "chart-stock",
        "库存水位",
        "可用库存每日变化（近 7 天）",
        "icons/warehouse.svg",
        Some(delta),
        theme,
        body,
    )
}

/// 6. 流量与转化（浏览量面积图 + footer 统计）
fn traffic_card(rows: &[DailyAnalysisRow], theme: &AppTheme) -> impl IntoElement {
    let (points, stats) = traffic_trend(rows);
    let body = if points.is_empty() {
        chart_empty("暂无流量数据", 256.0, theme).into_any_element()
    } else {
        v_flex()
            .gap_3()
            .child(chart_area(
                256.0 - 60.0,
                area_chart(&points, theme.chart_secondary, 0.18),
            ))
            .child(
                h_flex()
                    .gap_4()
                    .border_t_1()
                    .border_color(theme.separator)
                    .pt_2()
                    .child(stat_item(
                        "总浏览量",
                        fmt_num_precise(stats.total_page_views),
                        theme,
                    ))
                    .child(stat_item(
                        "访客数",
                        fmt_num_precise(stats.total_sessions),
                        theme,
                    ))
                    .child(stat_item(
                        "转化订单",
                        fmt_num_precise(stats.total_units_ordered),
                        theme,
                    ))
                    .child(stat_item(
                        "平均转化率",
                        format!("{:.2}%", stats.conversion_rate_pct),
                        theme,
                    )),
            )
            .into_any_element()
    };
    chart_card(
        "chart-traffic",
        "流量与转化",
        "浏览量趋势与转化率（近 7 天）",
        "icons/zap.svg",
        None,
        theme,
        body,
    )
}

/// footer 统计项（label + 数值）
fn stat_item(
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

/// 占比图例行：色点 + 名称（截断）+ 金额 + 占比
fn legend_list(
    rows: &[ShareRow],
    palette: &[Hsla; 6],
    total: f64,
    theme: &AppTheme,
) -> impl IntoElement {
    let decorated = decorate(rows, palette);
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
                        .text_size(px(12.))
                        .text_color(theme.text_secondary)
                        .truncate()
                        .child(row.name),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(theme.text_muted)
                        .child(fmt_money_precise(row.sales)),
                )
                .child(
                    div()
                        .w(px(44.))
                        .text_right()
                        .text_size(px(12.))
                        .text_color(theme.text_primary)
                        .child(format!("{share:.1}%")),
                )
        }))
}

/// 渲染 6 卡图表网格：2 列（对齐 frontend `lg:grid-cols-4` + 每卡 `col-span-2` → 每行 2 张）。
///
/// 数据源全部来自 `DashboardData`（summary_rows / compare / project_breakdown /
/// country_breakdown），Loaded 态下调用；四态协调由 `render_loaded` 负责。
pub fn render_chart_grid(data: &DashboardData, theme: &AppTheme) -> impl IntoElement {
    let rows: &[DailyAnalysisRow] = data
        .daily
        .as_ref()
        .map(|d| d.summary_rows.as_slice())
        .unwrap_or(&[]);
    let compare: &[DailyAnalysisRow] = data
        .compare
        .as_ref()
        .map(|c| c.summary_rows.as_slice())
        .unwrap_or(&[]);
    div()
        .id("dashboard-charts")
        .grid()
        .grid_cols(2)
        .gap_3()
        .child(revenue_card(rows, compare, theme))
        .child(channel_card(rows, compare, theme))
        .child(project_card(data, theme))
        .child(country_card(data.country.as_ref(), theme))
        .child(stock_card(rows, compare, theme))
        .child(traffic_card(rows, theme))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    use gui_domain::dashboard::DailyAnalysisRow;

    /// 构造单日聚合行（只关心图表用到的字段）
    fn row(
        date: &str,
        sales_amount: f64,
        ad_spend: f64,
        available_qty: i64,
        page_views: i64,
        units_ordered: i64,
        sessions: i64,
    ) -> DailyAnalysisRow {
        DailyAnalysisRow {
            date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            order_qty: 0,
            sales_amount,
            impressions: 0,
            clicks: 0,
            cpc: 0.0,
            ad_spend,
            ad_orders: 0,
            available_qty,
            page_views,
            units_ordered,
            sessions,
            ordered_sales_amount: 0.0,
            conversion_rate: 0.0,
        }
    }

    fn row_sales(date: &str, sales: f64) -> DailyAnalysisRow {
        row(date, sales, 0.0, 0, 0, 0, 0)
    }

    fn sample_rows() -> Vec<DailyAnalysisRow> {
        vec![
            row_sales("2026-08-07", 1000.0),
            row_sales("2026-08-08", 1200.0),
            row_sales("2026-08-09", 800.0),
            row_sales("2026-08-10", 1500.0),
            row_sales("2026-08-11", 1100.0),
            row_sales("2026-08-12", 1300.0),
            row_sales("2026-08-13", 1600.0),
        ]
    }

    // ---------- 趋势 ----------

    #[test]
    fn revenue_trend_builds_points_in_order_with_md_labels() {
        let points = revenue_trend(&sample_rows());
        assert_eq!(points.len(), 7);
        // ISO 日期 → "M/D"（对齐 frontend dayLabel）
        assert_eq!(points[0].label, "8/7");
        assert_eq!(points[6].label, "8/13");
        assert_eq!(points[0].value, 1000.0);
        assert_eq!(points[6].value, 1600.0);
    }

    #[test]
    fn sales_vs_spend_carries_both_series() {
        let rows = vec![row("2026-08-13", 1860.0, 122.4, 0, 0, 0, 0)];
        let points = sales_vs_spend(&rows);
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].sales, 1860.0);
        assert_eq!(points[0].ad_spend, 122.4);
        assert_eq!(points[0].label, "8/13");
    }

    #[test]
    fn stock_trend_returns_points_and_last_snapshot() {
        let rows = vec![
            row("2026-08-12", 0.0, 0.0, 90, 0, 0, 0),
            row("2026-08-13", 0.0, 0.0, 75, 0, 0, 0),
        ];
        let (points, current) = stock_trend(&rows);
        assert_eq!(points.len(), 2);
        assert_eq!(points[0].value, 90.0);
        assert_eq!(current, 75);
        // 空输入 → 空点 + 0 快照
        let (points, current) = stock_trend(&[]);
        assert!(points.is_empty());
        assert_eq!(current, 0);
    }

    #[test]
    fn traffic_stats_matches_frontend_formula() {
        let rows = vec![
            row("2026-08-12", 0.0, 0.0, 0, 430, 15, 380),
            row("2026-08-13", 0.0, 0.0, 0, 570, 25, 520),
        ];
        let (points, stats) = traffic_trend(&rows);
        assert_eq!(points.len(), 2);
        assert_eq!(points[1].value, 570.0);
        // 总浏览量 1000，转化订单 40 → 转化率 4.00%
        assert_eq!(stats.total_page_views, 1000);
        assert_eq!(stats.total_sessions, 900);
        assert_eq!(stats.total_units_ordered, 40);
        assert!((stats.conversion_rate_pct - 4.0).abs() < 1e-9);
        // 无浏览量 → 转化率 0
        let stats = compute_traffic_stats(&[]);
        assert_eq!(stats.conversion_rate_pct, 0.0);
    }

    #[test]
    fn sales_delta_uses_compare_period() {
        let current = vec![row_sales("2026-08-13", 1600.0)];
        let compare = vec![row_sales("2026-08-06", 1280.0)];
        // (1600 - 1280) / 1280 × 100 = 25%
        assert_eq!(sales_delta(&current, &compare), Some(25.0));
        // 无对比期 → 0（不产生 ±∞，对齐 frontend）
        assert_eq!(sales_delta(&current, &[]), Some(0.0));
    }

    #[test]
    fn stock_delta_uses_snapshot_values() {
        let current = vec![row("2026-08-13", 0.0, 0.0, 90, 0, 0, 0)];
        let compare = vec![row("2026-08-06", 0.0, 0.0, 75, 0, 0, 0)];
        // (90 - 75) / 75 × 100 = 20%
        assert_eq!(stock_delta(&current, &compare), Some(20.0));
        // 对比期缺失 → 0
        assert_eq!(stock_delta(&current, &[]), Some(0.0));
        // 对比期为 0 → 0（不产生 ±∞）
        let compare_zero = vec![row("2026-08-06", 0.0, 0.0, 0, 0, 0, 0)];
        assert_eq!(stock_delta(&current, &compare_zero), Some(0.0));
    }

    // ---------- 占比（项目 / 国家） ----------

    fn dashboard_with_breakdown(
        entries: Vec<(i64, String, Vec<DailyAnalysisRow>)>,
    ) -> DashboardData {
        use gui_domain::dashboard::ProjectBreakdownEntry;
        let mut breakdown = HashMap::new();
        for (id, name, rows) in entries {
            breakdown.insert(
                id,
                ProjectBreakdownEntry {
                    project_name: name,
                    summary_rows: rows,
                    detail_rows: Vec::new(),
                },
            );
        }
        DashboardData {
            projects: Vec::new(),
            daily: Some(gui_domain::dashboard::DailyAnalysisResponse {
                summary_rows: Vec::new(),
                detail_rows: Vec::new(),
                available_dates: Default::default(),
                project_breakdown: breakdown,
            }),
            compare: None,
            country: None,
        }
    }

    #[test]
    fn project_share_sorts_by_sales_and_truncates_to_five() {
        let mut entries = Vec::new();
        for i in 1..=7 {
            entries.push((
                i as i64,
                format!("项目 {i}"),
                vec![row_sales("2026-08-13", i as f64 * 100.0)],
            ));
        }
        let data = dashboard_with_breakdown(entries);
        let rows = project_share(&data);
        assert_eq!(rows.len(), 5);
        // Top 5 = 项目 7..3
        assert_eq!(rows[0].name, "项目 7");
        assert_eq!(rows[0].sales, 700.0);
        assert_eq!(rows[4].name, "项目 3");
        assert_eq!(rows[4].sales, 300.0);
    }

    #[test]
    fn project_share_skips_empty_and_missing_names_fall_back() {
        // 项目 1 有条目但 summary_rows 为空 → 跳过
        let data = dashboard_with_breakdown(vec![(1, "空项目".to_string(), Vec::new())]);
        assert!(project_share(&data).is_empty());

        // project_name 为空 + projects 列表兜底
        let mut data = dashboard_with_breakdown(vec![(
            2,
            String::new(),
            vec![row_sales("2026-08-13", 500.0)],
        )]);
        data.projects = vec![project_helper(2, "兜底项目")];
        let rows = project_share(&data);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "兜底项目");
    }

    #[test]
    fn project_share_empty_without_daily() {
        let data = DashboardData {
            projects: Vec::new(),
            daily: None,
            compare: None,
            country: None,
        };
        assert!(project_share(&data).is_empty());
    }

    #[test]
    fn country_share_sorts_by_sales_and_uses_site_labels() {
        use gui_domain::dashboard::CountryBreakdownEntry;
        let mut breakdown = HashMap::new();
        breakdown.insert(
            "DE".to_string(),
            CountryBreakdownEntry {
                summary_rows: vec![row_sales("2026-08-13", 2000.0)],
                detail_rows: Vec::new(),
                currency: "USD".to_string(),
                source_currency: Some("EUR".to_string()),
            },
        );
        breakdown.insert(
            "US".to_string(),
            CountryBreakdownEntry {
                summary_rows: vec![row_sales("2026-08-13", 5000.0)],
                detail_rows: Vec::new(),
                currency: "USD".to_string(),
                source_currency: Some("USD".to_string()),
            },
        );
        breakdown.insert(
            "UK".to_string(),
            CountryBreakdownEntry {
                summary_rows: Vec::new(),
                detail_rows: Vec::new(),
                currency: "USD".to_string(),
                source_currency: Some("GBP".to_string()),
            },
        );
        let data = CountryBreakdownData {
            representative_project_name: "测试项目".to_string(),
            breakdown,
        };
        let rows = country_share(Some(&data));
        assert_eq!(rows.len(), 2);
        // 按销售额降序：US(5000) > DE(2000)；UK 空行跳过
        assert_eq!(rows[0].name, "美国站 (US)");
        assert_eq!(rows[0].sales, 5000.0);
        assert_eq!(rows[1].name, "德国站 (DE)");
        assert_eq!(rows[1].sales, 2000.0);
        // None → 空
        assert!(country_share(None).is_empty());
    }

    #[test]
    fn decorate_assigns_palette_colors_round_robin() {
        let rows = vec![
            ShareRow {
                name: "A".into(),
                sales: 1.0,
            },
            ShareRow {
                name: "B".into(),
                sales: 2.0,
            },
        ];
        let palette = AppTheme::light().chart_palette();
        let decorated = decorate(&rows, &palette);
        assert_eq!(decorated.len(), 2);
        assert_eq!(decorated[0].0.name, "A");
        assert_eq!(decorated[0].1, palette[0]);
        assert_eq!(decorated[1].1, palette[1]);
    }

    /// 构造最小 ManagedProject（charts 测试本地构造，避免跨模块测试耦合）
    fn project_helper(id: i64, name: &str) -> gui_domain::common::ManagedProject {
        gui_domain::common::ManagedProject {
            id,
            name: name.to_string(),
            brand_name: None,
            store_address: None,
            project_operator: None,
            assistant_operator: None,
            commission_basis: None,
            commission_rate: None,
            sort_order: 0,
            is_active: true,
            source_file: None,
            has_context: false,
            project_tier: None,
            vat_enabled: false,
        }
    }

    // ---------- 渲染冒烟（亮 / 暗两态） ----------

    fn loaded_data() -> DashboardData {
        use gui_domain::dashboard::{CountryBreakdownEntry, ProjectBreakdownEntry};
        let mut breakdown = HashMap::new();
        breakdown.insert(
            1i64,
            ProjectBreakdownEntry {
                project_name: "测试项目".to_string(),
                summary_rows: vec![row("2026-08-13", 1600.0, 120.0, 90, 430, 15, 380)],
                detail_rows: Vec::new(),
            },
        );
        let mut country = HashMap::new();
        country.insert(
            "US".to_string(),
            CountryBreakdownEntry {
                summary_rows: vec![row("2026-08-13", 1600.0, 120.0, 90, 430, 15, 380)],
                detail_rows: Vec::new(),
                currency: "USD".to_string(),
                source_currency: Some("USD".to_string()),
            },
        );
        DashboardData {
            projects: Vec::new(),
            daily: Some(gui_domain::dashboard::DailyAnalysisResponse {
                summary_rows: sample_rows(),
                detail_rows: Vec::new(),
                available_dates: Default::default(),
                project_breakdown: breakdown,
            }),
            compare: Some(gui_domain::dashboard::DailyAnalysisResponse {
                summary_rows: vec![row_sales("2026-08-06", 1280.0)],
                detail_rows: Vec::new(),
                available_dates: Default::default(),
                project_breakdown: HashMap::new(),
            }),
            country: Some(CountryBreakdownData {
                representative_project_name: "测试项目".to_string(),
                breakdown: country,
            }),
        }
    }

    /// 测试宿主：仅渲染 6 卡图表网格（亮/暗渲染冒烟用）
    struct ChartGridHost {
        data: DashboardData,
        theme: AppTheme,
    }

    impl gpui::Render for ChartGridHost {
        fn render(
            &mut self,
            _window: &mut gpui::Window,
            _cx: &mut gpui::Context<Self>,
        ) -> impl IntoElement {
            render_chart_grid(&self.data, &self.theme)
        }
    }

    #[gpui::test]
    async fn chart_grid_renders_in_light_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let data = loaded_data();
        cx.add_window_view(|_window, cx| ChartGridHost {
            data,
            theme: crate::theme::AppTheme::current(cx),
        });
    }

    #[gpui::test]
    async fn chart_grid_renders_in_dark_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let data = loaded_data();
        let (_host, cx2) = cx.add_window_view(|_window, cx| ChartGridHost {
            data,
            theme: crate::theme::AppTheme::current(cx),
        });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    /// 空数据网格（全维度空）也要能渲染不 panic（四态协调的 Loaded 边界）
    #[gpui::test]
    async fn chart_grid_renders_with_empty_dimensions(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let data = DashboardData {
            projects: Vec::new(),
            daily: None,
            compare: None,
            country: None,
        };
        cx.add_window_view(|_window, cx| ChartGridHost {
            data,
            theme: crate::theme::AppTheme::current(cx),
        });
    }
}
