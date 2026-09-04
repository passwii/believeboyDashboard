//! Dashboard 数字带（GUI-7 / 1.0-b，frontend `components/dashboard-v2/v2-stats.tsx` 的 GPUI 等价）
//!
//! 6 个核心 KPI 大数字卡：销售额 / 订单量 / 广告花费 / ACoS / 转化率 / 毛利润，
//! 当前期 vs 对比期（环比上一周期）箭头 + 颜色（涨绿 / 跌红），数字格式化
//! （千分位 / 货币符号 / 百分比）对齐 frontend `v2-format.ts` 的 Intl 行为。
//!
//! 组件策略（用户 2026-08-14 指定：能用库则尽量全部替换，不手写轮子）：
//! - 库无 Statistic 卡组件 → 数字卡用 `div` + 主题语义 token 自绘；
//! - 加载占位 → gpui-component `Skeleton`；
//! - 环比说明 → gpui `div::tooltip` + gpui-component `Tooltip`（悬停 delta 显示）；
//! - 涨绿/跌红 → 主题语义色 `bullish` / `bearish`（亮暗两主题下恒为
//!   绿 #22c55e / 红 #ef4444，对齐 frontend emerald / rose）；0 变化 → 中性灰 `muted_foreground`。
//!
//! 数据口径：全部复用 `gui-domain::dashboard::KpiSummary`（由 `summary_rows`
//! 聚合推导），本模块只做「展示层」派生——delta 计算与数字格式化。
//!
//! 与 frontend 的已知差异（有意保留）：
//! - `format_compact_currency` 在 ≥1000 档取整（Intl `maximumFractionDigits: 0`），
//!   如 3100 → "$3K"（前端同行为）；不追求 0.5 边界的舍入位级一致；
//! - BLF-792 起 KPI 数值统一 JetBrains Mono 等宽 + tabular-nums
//!   （此前注释「GPUI 无 tabular-nums 支持」已过时：data_table 的
//!   FontFeatures tnum 方案可复用）。

use gpui::{
    div, prelude::*, px, AnimationExt, App, Div, Hsla, IntoElement, ParentElement, SharedString,
    Stateful, Styled, Window,
};
use gpui_component::{h_flex, tooltip::Tooltip, v_flex, Icon, IconName, Sizable, StyledExt};
use gui_domain::dashboard::KpiSummary;

use crate::theme::{AppTheme, FONT_TITLE_LG};
use crate::widgets::data_table::TabularNumsExt;

/// 环比说明文案（Tooltip 悬停展示）
const DELTA_TOOLTIP: &str = "环比上一周期（近 7 天 vs 前一 7 天）";

/// KPI 数值类型（P4-2：count-up 插值 + 每帧格式化用）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KpiKind {
    /// 紧凑货币（format_compact_currency）
    Currency,
    /// 紧凑数字（format_compact_number）
    Number,
    /// 百分比（format_percent）
    Percent,
}

impl KpiKind {
    /// 按类型格式化（对齐各展示层函数）
    pub fn format(self, v: f64) -> String {
        match self {
            Self::Currency => format_compact_currency(v),
            Self::Number => format_compact_number(v.round() as i64),
            Self::Percent => format_percent(v),
        }
    }
}

/// 单个 KPI 卡数据（纯展示派生，可单测）
#[derive(Debug, Clone, PartialEq)]
pub struct KpiStat {
    pub label: &'static str,
    /// 格式化后的展示值（如 "$3.1K" / "5.00%"）；None = 数据不可得（毛利润）→ 显示 "—"
    pub value: Option<String>,
    /// P4-2：原始数值（count-up 起点 0 的目标值）；None = 数据不可得 → 不参与 count-up
    pub raw: Option<f64>,
    /// P4-2：数值类型（count-up 每帧格式化用）
    pub kind: KpiKind,
    /// 环比百分比（如 25.0 = +25%，-20.0 = -20%）；None = 无对比期 / 不可得 → 显示 "—"
    pub delta: Option<f64>,
}

/// 环比百分比变化（对齐 frontend `pctChange`：对比期为 0 / 缺失 → 0，不产生 ±∞）
pub fn pct_change(current: f64, previous: f64) -> f64 {
    if previous > 0.0 {
        (current - previous) / previous * 100.0
    } else {
        0.0
    }
}

/// 6 个核心 KPI（对齐 frontend `computeStats` 口径 + `KpiSummary` 字段顺序）
///
/// 毛利润：daily-analysis 载荷不含 COGS，`gross_profit` 恒 `None` → 值显示 "—"、
/// 无环比；待接入利润数据源后自动填充。
pub fn compute_stats(current: &KpiSummary, comparison: &KpiSummary) -> [KpiStat; 6] {
    [
        KpiStat {
            label: "销售额",
            value: Some(format_compact_currency(current.sales_amount)),
            raw: Some(current.sales_amount),
            kind: KpiKind::Currency,
            delta: Some(pct_change(current.sales_amount, comparison.sales_amount)),
        },
        KpiStat {
            label: "订单量",
            value: Some(format_compact_number(current.order_qty)),
            raw: Some(current.order_qty as f64),
            kind: KpiKind::Number,
            delta: Some(pct_change(
                current.order_qty as f64,
                comparison.order_qty as f64,
            )),
        },
        KpiStat {
            label: "广告花费",
            value: Some(format_compact_currency(current.ad_spend)),
            raw: Some(current.ad_spend),
            kind: KpiKind::Currency,
            delta: Some(pct_change(current.ad_spend, comparison.ad_spend)),
        },
        KpiStat {
            label: "ACoS",
            value: Some(format_percent(current.acos)),
            raw: Some(current.acos),
            kind: KpiKind::Percent,
            delta: Some(pct_change(current.acos, comparison.acos)),
        },
        KpiStat {
            label: "转化率",
            value: Some(format_percent(current.conversion_rate)),
            raw: Some(current.conversion_rate),
            kind: KpiKind::Percent,
            delta: Some(pct_change(
                current.conversion_rate,
                comparison.conversion_rate,
            )),
        },
        KpiStat {
            label: "毛利润",
            value: current.gross_profit.map(format_compact_currency),
            raw: current.gross_profit,
            kind: KpiKind::Currency,
            delta: None,
        },
    ]
}

// ---------------------------------------------------------------------------
// 数字格式化（对齐 frontend `components/dashboard-v2/v2-format.ts` 的 Intl 行为）
// ---------------------------------------------------------------------------

/// 紧凑美元（对齐 frontend `formatCompactCurrency`：Intl compact +
/// `maximumFractionDigits: 0`）。如 400 → "$400"、3100 → "$3K"、9999 → "$10K"、
/// 1234567 → "$1M"；负数 → "-$1K"。
///
/// 实现：按原始量级选档（K/M），round-ties-even 取整后若进位跨档再升档
/// （999,999 → 999.999K → 1000 → "$1M"，对齐 Intl 行为）。
pub fn format_compact_currency(value: f64) -> String {
    let sign = if value < 0.0 { "-" } else { "" };
    let v = value.abs();
    if v >= 1_000_000.0 {
        let m = (v / 1_000_000.0).round_ties_even() as i64;
        if m >= 1000 {
            // 极值兜底（KPI 量级不会到，但保持不溢出）
            format!("{sign}${}B", m / 1000)
        } else {
            format!("{sign}${m}M")
        }
    } else if v >= 1_000.0 {
        let k = (v / 1_000.0).round_ties_even() as i64;
        if k >= 1000 {
            // 进位跨档：999,999 → 1000K → 升为 M
            format!("{sign}${}M", k / 1000)
        } else {
            format!("{sign}${k}K")
        }
    } else {
        format!("{sign}${:.0}", v.round_ties_even())
    }
}

/// 紧凑数字（对齐 frontend `formatCompactNumber`：Intl compact +
/// `maximumFractionDigits: 1`）。如 40 → "40"、1234 → "1.2K"、12345 → "12.3K"、
/// 1000000 → "1M"（整档值去 ".0"）。
pub fn format_compact_number(value: i64) -> String {
    let sign = if value < 0 { "-" } else { "" };
    let v = (value as f64).abs();
    if v >= 1_000_000.0 {
        format!("{sign}{}M", trim_zero_frac(v / 1_000_000.0))
    } else if v >= 1_000.0 {
        format!("{sign}{}K", trim_zero_frac(v / 1_000.0))
    } else {
        value.to_string()
    }
}

/// 1 位小数 + 去掉整档的 ".0"（Intl compact 对整档值不显示小数，如 1M / 12K）
fn trim_zero_frac(v: f64) -> String {
    let s = format!("{v:.1}");
    if s.ends_with(".0") {
        s[..s.len() - 2].to_string()
    } else {
        s
    }
}

/// 百分比（对齐 frontend `formatPercent`：固定 2 位小数 + %，如 5.00%）
pub fn format_percent(value: f64) -> String {
    format!("{value:.2}%")
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/// 数字带：横向 flex 排列 6 张 KPI 卡（当前期 vs 对比期的环比 delta 已含）
///
/// P4-2：大数字 count-up（Loaded 后从 0 计数到目标值，600ms ease-out）；
/// 卡片 hover 背景过渡；减弱动态时瞬时。`window`/`cx` 供 hover 过渡的
/// `use_keyed_state` 使用（视图渲染时传入）。
pub fn stat_band(
    current: &KpiSummary,
    comparison: &KpiSummary,
    theme: &AppTheme,
    window: &mut Window,
    cx: &mut App,
) -> impl IntoElement {
    let stats = compute_stats(current, comparison);
    let reduce = crate::motion::reduce_motion(cx);
    h_flex().id("stat-band").gap_3().children(
        stats
            .iter()
            .map(|stat| render_card(stat, theme, window, cx, reduce)),
    )
}

/// 单张 KPI 卡：label + 环比 delta（右上）+ 大数字
///
/// P2-4（BLF-691）原生卡片质感：`radius_lg` 圆角 + 柔和轻投影 + hover 浅底反馈
/// （对齐 macOS 系统设置/备忘录式卡片），涨绿跌红用语义色（success/danger）。
/// P4-2（BLF-708）：大数字 count-up（有 raw 时从 0 计数到目标，600ms ease-out；
/// 减弱动态/无 raw 时瞬时显示）+ hover 背景过渡（100ms 插值）。
fn render_card(
    stat: &KpiStat,
    theme: &AppTheme,
    window: &mut Window,
    cx: &mut App,
    reduce: bool,
) -> impl IntoElement {
    // 对齐 frontend `text-blue-700 dark:text-foreground`：亮色主题数值用品牌强调色，暗色用前景色
    let value_color = if theme.is_dark() {
        theme.text_primary
    } else {
        theme.accent
    };
    // hover 浅底：亮色用 accent_soft（蓝 50），暗色用 muted_fill（中性微亮）
    let hover_bg = if theme.is_dark() {
        theme.muted_fill
    } else {
        theme.accent_soft
    };
    // P4-2：hover 过渡闭包捕获的 owned 颜色（避免借用 theme 引用逃逸）
    let card_bg = theme.card_bg;
    // 转 owned String（gpui 元素要求 'static 内容，且保持返回类型无生命周期参数）
    let value_text = stat.value.clone().unwrap_or_else(|| "—".to_string());
    // P4-2：count-up 每帧格式化（raw + kind 捕获进动画闭包）
    let raw = stat.raw;
    let kind = stat.kind;
    let label = stat.label;

    let base = v_flex()
        .id(SharedString::from(format!("kpi-card-{label}")))
        .flex_1()
        .gap_2()
        .p_4()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(
            h_flex()
                .justify_between()
                .items_center()
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.text_muted)
                        .child(stat.label),
                )
                .child(render_delta(stat.delta, theme, stat.label)),
        );

    let value_el = if let (Some(raw), false) = (raw, reduce) {
        // count-up：动画 id 编码 label，元素首次出现时从 0 计数到目标
        div()
            .text_size(px(crate::theme::fs(FONT_TITLE_LG)))
            .font_semibold()
            .mono_tabular_nums()
            .text_color(value_color)
            .with_animation(
                SharedString::from(format!("kpi-count-{label}")),
                crate::motion::animation(
                    crate::motion::DURATION_COUNT_UP,
                    crate::motion::ease_out_cubic,
                ),
                move |el, delta| el.child(kind.format(crate::motion::count_up(raw, delta))),
            )
            .into_any_element()
    } else {
        div()
            .text_size(px(crate::theme::fs(FONT_TITLE_LG)))
            .font_semibold()
            .mono_tabular_nums()
            .text_color(value_color)
            .child(value_text)
            .into_any_element()
    };

    crate::motion::hover_transition(
        SharedString::from(format!("kpi-card-{label}")),
        base.child(value_el),
        window,
        cx,
        move |el: Stateful<Div>, t| {
            use gpui::Styled;
            el.bg(crate::motion::lerp_hsla(card_bg, hover_bg, t))
        },
    )
}

/// 环比 delta：涨绿（success）/ 跌红（danger）/ 持平（中性灰 Minus）；
/// 不可得 → "—"。悬停显示环比说明 Tooltip（`id` 保证每张卡唯一；tooltip 属
/// `StatefulInteractiveElement`，需先 `.id()` 提升为 `Stateful<Div>`）。
///
/// P2-4：涨/跌改为徽章样式（语义色浅底胶囊），持平/不可得保持纯文字（无底）。
/// P3-2：图表卡头部复用（label 用图表标题保证元素 id 唯一）。
pub(crate) fn render_delta(
    delta: Option<f64>,
    theme: &AppTheme,
    label: &'static str,
) -> impl IntoElement {
    match delta {
        None => div()
            .text_sm()
            .text_color(theme.text_muted)
            .child("—")
            .into_any_element(),
        Some(d) if d > 0.0 => delta_badge(
            d,
            theme.success,
            theme.success_soft,
            IconName::ChevronUp,
            label,
        )
        .into_any_element(),
        Some(d) if d < 0.0 => delta_badge(
            d.abs(),
            theme.danger,
            theme.danger_soft,
            IconName::ChevronDown,
            label,
        )
        .into_any_element(),
        Some(_) => delta_row(0.0, theme.text_muted, IconName::Minus, label).into_any_element(),
    }
}

/// delta 徽章（P2-4）：语义色文字 + 浅底胶囊 + 箭头图标，悬停显示环比说明
fn delta_badge(
    abs_delta: f64,
    color: Hsla,
    soft_bg: Hsla,
    icon: IconName,
    label: &'static str,
) -> impl IntoElement {
    h_flex()
        .id(gpui::SharedString::from(format!("kpi-delta-{label}")))
        .items_center()
        .gap_1()
        .px_1p5()
        .py_0p5()
        .rounded_full()
        .bg(soft_bg)
        .text_sm()
        .text_color(color)
        .tooltip(move |window, cx| Tooltip::new(DELTA_TOOLTIP).build(window, cx))
        .child(Icon::new(icon).with_size(px(12.)).text_color(color))
        .child(div().child(format!("{abs_delta:.1}%")))
}

/// delta 行（持平 / 不可得）：箭头图标 + 绝对值百分比，无徽章底（对齐 frontend `DeltaIcon` + `DeltaValue`）
fn delta_row(abs_delta: f64, color: Hsla, icon: IconName, label: &'static str) -> impl IntoElement {
    div()
        .id(gpui::SharedString::from(format!("kpi-delta-{label}")))
        .flex()
        .flex_row()
        .items_center()
        .gap_1()
        .text_sm()
        .text_color(color)
        .tooltip(move |window, cx| Tooltip::new(DELTA_TOOLTIP).build(window, cx))
        .child(Icon::new(icon).with_size(px(12.)).text_color(color))
        .child(div().child(format!("{abs_delta:.1}%")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kpi(
        sales: f64,
        orders: i64,
        ad: f64,
        acos: f64,
        conv: f64,
        gross: Option<f64>,
    ) -> KpiSummary {
        KpiSummary {
            sales_amount: sales,
            order_qty: orders,
            ad_spend: ad,
            acos,
            conversion_rate: conv,
            gross_profit: gross,
        }
    }

    // 对齐 frontend v2-stats.test.tsx：current = 销售额 400 / 订单 40 / 广告 60 / 转化率 5.00%，
    // comparison = 销售额 320 / 订单 50 / 广告 60 / 转化率 4.00%
    fn current() -> KpiSummary {
        kpi(400.0, 40, 60.0, 0.0, 5.0, None)
    }

    fn comparison() -> KpiSummary {
        kpi(320.0, 50, 60.0, 0.0, 4.0, None)
    }

    #[test]
    fn pct_change_matches_frontend() {
        assert_eq!(pct_change(400.0, 320.0), 25.0);
        assert_eq!(pct_change(40.0, 50.0), -20.0);
        assert_eq!(pct_change(60.0, 60.0), 0.0);
        assert_eq!(pct_change(5.0, 4.0), 25.0);
        // 对比期为 0 / 负 → 0（不产生 ±∞，对齐 frontend）
        assert_eq!(pct_change(100.0, 0.0), 0.0);
        assert_eq!(pct_change(100.0, -50.0), 0.0);
    }

    #[test]
    fn format_currency_matches_intl() {
        assert_eq!(format_compact_currency(0.0), "$0");
        assert_eq!(format_compact_currency(400.0), "$400");
        assert_eq!(format_compact_currency(999.0), "$999");
        assert_eq!(format_compact_currency(1000.0), "$1K");
        assert_eq!(format_compact_currency(3100.0), "$3K");
        assert_eq!(format_compact_currency(9999.0), "$10K");
        assert_eq!(format_compact_currency(10000.0), "$10K");
        assert_eq!(format_compact_currency(12345.0), "$12K");
        assert_eq!(format_compact_currency(999_999.0), "$1M");
        assert_eq!(format_compact_currency(1_234_567.0), "$1M");
        assert_eq!(format_compact_currency(1_250_000.0), "$1M");
        assert_eq!(format_compact_currency(-1_234.0), "-$1K");
    }

    #[test]
    fn format_number_matches_intl() {
        assert_eq!(format_compact_number(0), "0");
        assert_eq!(format_compact_number(40), "40");
        assert_eq!(format_compact_number(999), "999");
        assert_eq!(format_compact_number(1234), "1.2K");
        assert_eq!(format_compact_number(12_345), "12.3K");
        assert_eq!(format_compact_number(1_000_000), "1M");
        assert_eq!(format_compact_number(-1_234), "-1.2K");
    }

    #[test]
    fn format_percent_two_decimals() {
        assert_eq!(format_percent(0.0), "0.00%");
        assert_eq!(format_percent(5.0), "5.00%");
        assert_eq!(format_percent(3.44), "3.44%");
        assert_eq!(format_percent(25.125), "25.12%");
    }

    #[test]
    fn compute_stats_matches_frontend_case() {
        let stats = compute_stats(&current(), &comparison());

        assert_eq!(stats[0].label, "销售额");
        assert_eq!(stats[0].value.as_deref(), Some("$400"));
        assert_eq!(stats[0].delta, Some(25.0));

        assert_eq!(stats[1].label, "订单量");
        assert_eq!(stats[1].value.as_deref(), Some("40"));
        assert_eq!(stats[1].delta, Some(-20.0));

        assert_eq!(stats[2].label, "广告花费");
        assert_eq!(stats[2].value.as_deref(), Some("$60"));
        assert_eq!(stats[2].delta, Some(0.0));

        assert_eq!(stats[3].label, "ACoS");
        assert_eq!(stats[3].value.as_deref(), Some("0.00%"));

        assert_eq!(stats[4].label, "转化率");
        assert_eq!(stats[4].value.as_deref(), Some("5.00%"));
        assert_eq!(stats[4].delta, Some(25.0));

        // 毛利润：daily-analysis 无 COGS → None（显示 "—"）
        assert_eq!(stats[5].label, "毛利润");
        assert_eq!(stats[5].value, None);
        assert_eq!(stats[5].delta, None);
    }

    #[test]
    fn compute_stats_flat_when_no_comparison() {
        // 对比期全 0 → 前 5 项 delta 全 0（对齐 frontend：上一周期为空时 delta 为 0）
        let empty = KpiSummary::default();
        let stats = compute_stats(&current(), &empty);
        assert!(stats.iter().take(5).all(|s| s.delta == Some(0.0)));
        assert_eq!(stats[5].delta, None);
    }

    /// P4-2：compute_stats 填 raw/kind——count-up 需要原始数值 + 类型（每帧格式化）
    #[test]
    fn compute_stats_fills_raw_and_kind_for_count_up() {
        let stats = compute_stats(&current(), &comparison());
        assert_eq!(stats[0].raw, Some(400.0));
        assert_eq!(stats[0].kind, KpiKind::Currency);
        assert_eq!(stats[1].raw, Some(40.0));
        assert_eq!(stats[1].kind, KpiKind::Number);
        assert_eq!(stats[3].raw, Some(0.0));
        assert_eq!(stats[3].kind, KpiKind::Percent);
        // 毛利润无数据 → raw None（不参与 count-up，显示 "—"）
        assert_eq!(stats[5].raw, None);
        assert_eq!(stats[5].kind, KpiKind::Currency);
    }

    /// P4-2：KpiKind::format 对齐各展示层函数（count-up 每帧格式化路径）
    #[test]
    fn kpi_kind_format_matches_display_functions() {
        assert_eq!(
            KpiKind::Currency.format(3100.0),
            format_compact_currency(3100.0)
        );
        assert_eq!(KpiKind::Number.format(1234.0), format_compact_number(1234));
        assert_eq!(KpiKind::Percent.format(5.0), format_percent(5.0));
        // 插值中间值也能格式化（count-up 每帧调用，不能 panic）
        assert_eq!(KpiKind::Currency.format(1550.0), "$2K");
        assert_eq!(KpiKind::Percent.format(2.5), "2.50%");
    }
}
