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
//! - GPUI 无 tabular-nums 字体特性支持，数字用等宽性较弱的比例数字（视觉差异极小）。

use gpui::{div, prelude::*, px, Hsla, IntoElement, ParentElement};
use gpui_component::{
    Icon, IconName, Sizable, StyledExt, Theme, h_flex, skeleton::Skeleton, tooltip::Tooltip, v_flex,
};
use gui_domain::dashboard::KpiSummary;

/// 环比说明文案（Tooltip 悬停展示）
const DELTA_TOOLTIP: &str = "环比上一周期（近 7 天 vs 前一 7 天）";

/// 单个 KPI 卡数据（纯展示派生，可单测）
#[derive(Debug, Clone, PartialEq)]
pub struct KpiStat {
    pub label: &'static str,
    /// 格式化后的展示值（如 "$3.1K" / "5.00%"）；None = 数据不可得（毛利润）→ 显示 "—"
    pub value: Option<String>,
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
            delta: Some(pct_change(current.sales_amount, comparison.sales_amount)),
        },
        KpiStat {
            label: "订单量",
            value: Some(format_compact_number(current.order_qty)),
            delta: Some(pct_change(
                current.order_qty as f64,
                comparison.order_qty as f64,
            )),
        },
        KpiStat {
            label: "广告花费",
            value: Some(format_compact_currency(current.ad_spend)),
            delta: Some(pct_change(current.ad_spend, comparison.ad_spend)),
        },
        KpiStat {
            label: "ACoS",
            value: Some(format_percent(current.acos)),
            delta: Some(pct_change(current.acos, comparison.acos)),
        },
        KpiStat {
            label: "转化率",
            value: Some(format_percent(current.conversion_rate)),
            delta: Some(pct_change(
                current.conversion_rate,
                comparison.conversion_rate,
            )),
        },
        KpiStat {
            label: "毛利润",
            value: current.gross_profit.map(format_compact_currency),
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
pub fn stat_band(current: &KpiSummary, comparison: &KpiSummary, theme: &Theme) -> impl IntoElement {
    let stats = compute_stats(current, comparison);
    h_flex()
        .id("stat-band")
        .gap_3()
        .children(stats.iter().map(|stat| render_card(stat, theme)))
}

/// 加载态：6 张骨架卡（数字位置放 Skeleton，对齐 frontend loading 骨架结构）
pub fn stat_band_skeleton(theme: &Theme) -> impl IntoElement {
    h_flex()
        .id("stat-band-skeleton")
        .gap_3()
        .children((0..6).map(|_| skeleton_card(theme)))
}

/// 单张 KPI 卡：label + 环比 delta（右上）+ 大数字
fn render_card(stat: &KpiStat, theme: &Theme) -> impl IntoElement {
    // 对齐 frontend `text-blue-700 dark:text-foreground`：亮色主题数值用品牌蓝，暗色用前景色
    let value_color = if theme.is_dark() {
        theme.foreground
    } else {
        theme.blue
    };
    // 转 owned String（gpui 元素要求 'static 内容，且保持返回类型无生命周期参数）
    let value_text = stat.value.clone().unwrap_or_else(|| "—".to_string());
    v_flex()
        .flex_1()
        .gap_2()
        .p_3()
        .rounded(theme.radius)
        .border_1()
        .border_color(theme.border)
        .bg(theme.background)
        .child(
            h_flex()
                .justify_between()
                .items_center()
                .child(div().text_sm().text_color(theme.muted_foreground).child(stat.label))
                .child(render_delta(stat.delta, theme, stat.label)),
        )
        .child(
            div()
                .text_2xl()
                .font_semibold()
                .text_color(value_color)
                .child(value_text),
        )
}

/// 环比 delta：涨绿（bullish）/ 跌红（bearish）/ 持平（中性灰 Minus）；
/// 不可得 → "—"。悬停显示环比说明 Tooltip（`id` 保证每张卡唯一；tooltip 属
/// `StatefulInteractiveElement`，需先 `.id()` 提升为 `Stateful<Div>`）。
fn render_delta(delta: Option<f64>, theme: &Theme, label: &'static str) -> impl IntoElement {
    match delta {
        None => div()
            .text_sm()
            .text_color(theme.muted_foreground)
            .child("—")
            .into_any_element(),
        Some(d) if d > 0.0 => {
            delta_row(d, theme.bullish, IconName::ChevronUp, label).into_any_element()
        }
        Some(d) if d < 0.0 => {
            delta_row(d.abs(), theme.bearish, IconName::ChevronDown, label).into_any_element()
        }
        Some(_) => delta_row(0.0, theme.muted_foreground, IconName::Minus, label).into_any_element(),
    }
}

/// delta 行：箭头图标 + 绝对值百分比（对齐 frontend `DeltaIcon` + `DeltaValue` absolute）
fn delta_row(
    abs_delta: f64,
    color: Hsla,
    icon: IconName,
    label: &'static str,
) -> impl IntoElement {
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

/// 骨架卡：label / 数字 / delta 三档占位（对齐 frontend V2Stats loading 结构）
fn skeleton_card(theme: &Theme) -> impl IntoElement {
    v_flex()
        .flex_1()
        .gap_2()
        .p_3()
        .rounded(theme.radius)
        .border_1()
        .border_color(theme.border)
        .bg(theme.background)
        .child(div().w(px(64.)).child(Skeleton::new()))
        .child(div().w(px(96.)).h(px(28.)).child(Skeleton::new()))
        .child(div().w(px(80.)).child(Skeleton::new()))
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
}
