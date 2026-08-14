//! Dashboard 图表占位卡（GUI-8 / 1.0-c）
//!
//! v1.0 先在 6 个图表位置放占位卡：标题 + 描述 + 中央「图表 v1.1 接入」+ 灰底边框，
//! 卡片的标题 / 描述 / 顺序 / 图表区高度与 frontend 对齐：
//! - 标题 / 描述 = `components/dashboard-v2/v2-*-chart.tsx` 的 `CardTitle` / `CardDescription`
//! - 顺序 = `app/dashboard/page.tsx` 挂载顺序（V2Revenue → V2Channel → V2Project →
//!   V2Country → V2Stock → V2Traffic）
//! - 布局 = frontend `V2Grid`（lg 4 列 + 每卡 col-span-2 → 每行 2 张）
//! - 高度 = frontend `chartClass` 的 md 档（h-80=320px / h-64=256px）
//!
//! v1.1 远期：替换为 gpui-component `Chart`（line/bar/area/pie/radar/candlestick/sankey），
//! 数据源 = GUI-5 返回（gui-api-client）+ GUI-4 类型（gui-domain）。占位卡 id 作为替换锚点。

use gpui::{div, px, FontWeight, InteractiveElement, IntoElement, ParentElement, Styled};
use gpui_component::{Theme, v_flex};

/// 单个图表占位卡规格（与 frontend 图表卡一致，纯数据便于契约测试）
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChartPlaceholderSpec {
    /// 元素 id（测试定位 / v1.1 真图表替换锚点）
    pub id: &'static str,
    /// 卡片标题（= frontend CardTitle）
    pub title: &'static str,
    /// 卡片描述（= frontend CardDescription）
    pub description: &'static str,
    /// 图表区高度 px（frontend chartClass 的 md 档：h-80=320 / h-64=256）
    pub chart_height_px: f32,
}

/// 6 个图表占位卡 —— 顺序 = frontend `app/dashboard/page.tsx` 挂载顺序
pub const DASHBOARD_CHART_PLACEHOLDERS: [ChartPlaceholderSpec; 6] = [
    // 1. V2RevenueChart — 收入趋势
    ChartPlaceholderSpec {
        id: "chart-placeholder-revenue",
        title: "销售额",
        description: "每日销售额与销量（近 7 天）",
        chart_height_px: 320.0, // h-80
    },
    // 2. V2ChannelChart — 渠道分布
    ChartPlaceholderSpec {
        id: "chart-placeholder-channel",
        title: "销售额 vs 广告花费",
        description: "每日销售额与广告花费对比（近 7 天，双轴）",
        chart_height_px: 320.0, // h-80
    },
    // 3. V2ProjectChart — 项目对比
    ChartPlaceholderSpec {
        id: "chart-placeholder-project",
        title: "项目销售额对比",
        description: "近 7 天各项目销售额 Top 5",
        chart_height_px: 256.0, // h-64
    },
    // 4. V2CountryChart — 国家分布
    ChartPlaceholderSpec {
        id: "chart-placeholder-country",
        title: "跨国家销售额",
        description: "各站点销售额分布",
        chart_height_px: 256.0, // h-64
    },
    // 5. V2StockChart — 库存走势
    ChartPlaceholderSpec {
        id: "chart-placeholder-stock",
        title: "库存水位",
        description: "可用库存每日变化（近 7 天）",
        chart_height_px: 256.0, // h-64
    },
    // 6. V2TrafficChart — 流量
    ChartPlaceholderSpec {
        id: "chart-placeholder-traffic",
        title: "流量与转化",
        description: "浏览量趋势与转化率（近 7 天）",
        chart_height_px: 256.0, // h-64
    },
];

/// 渲染单张图表占位卡：白底卡片（标题 + 描述）+ 灰底虚线框图表区（中央「图表 v1.1 接入」）
pub fn chart_placeholder_card(
    spec: &ChartPlaceholderSpec,
    theme: &Theme,
) -> impl IntoElement {
    v_flex()
        .id(spec.id)
        .w_full()
        .rounded(px(8.))
        .border_1()
        .border_color(theme.border)
        .bg(theme.background)
        .p_4()
        .gap_3()
        .child(
            // 卡片头部：标题 + 描述
            v_flex()
                .gap_1()
                .child(
                    div()
                        .text_size(px(14.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.foreground)
                        .child(spec.title),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(theme.muted_foreground)
                        .child(spec.description),
                ),
        )
        .child(
            // 图表占位区：灰底 + 虚线边框 + 中央文案（v1.1 被真图表替换）
            div()
                .w_full()
                .h(px(spec.chart_height_px))
                .rounded(px(6.))
                .border_1()
                .border_dashed()
                .border_color(theme.border)
                .bg(theme.secondary)
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .text_size(px(13.))
                        .text_color(theme.muted_foreground)
                        .child("图表 v1.1 接入"),
                ),
        )
}

/// 渲染 6 卡网格：2 列（对齐 frontend `lg:grid-cols-4` + 每卡 `col-span-2` → 每行 2 张）
pub fn render_chart_placeholder_grid(theme: &Theme) -> impl IntoElement {
    div()
        .id("dashboard-chart-placeholders")
        .grid()
        .grid_cols(2)
        .gap_3()
        .children(
            DASHBOARD_CHART_PLACEHOLDERS
                .iter()
                .map(|spec| chart_placeholder_card(spec, theme)),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// frontend 图表卡标题（v2-*-chart.tsx CardTitle），顺序 = page.tsx 挂载顺序
    const EXPECTED_TITLES: [&str; 6] = [
        "销售额",
        "销售额 vs 广告花费",
        "项目销售额对比",
        "跨国家销售额",
        "库存水位",
        "流量与转化",
    ];

    /// frontend 图表卡描述（v2-*-chart.tsx CardDescription），逐字对齐
    const EXPECTED_DESCRIPTIONS: [&str; 6] = [
        "每日销售额与销量（近 7 天）",
        "每日销售额与广告花费对比（近 7 天，双轴）",
        "近 7 天各项目销售额 Top 5",
        "各站点销售额分布",
        "可用库存每日变化（近 7 天）",
        "浏览量趋势与转化率（近 7 天）",
    ];

    #[test]
    fn six_placeholders_in_frontend_order() {
        let titles: Vec<&str> = DASHBOARD_CHART_PLACEHOLDERS
            .iter()
            .map(|s| s.title)
            .collect();
        assert_eq!(titles, EXPECTED_TITLES);
    }

    #[test]
    fn descriptions_match_frontend_copy() {
        let descriptions: Vec<&str> = DASHBOARD_CHART_PLACEHOLDERS
            .iter()
            .map(|s| s.description)
            .collect();
        assert_eq!(descriptions, EXPECTED_DESCRIPTIONS);
    }

    #[test]
    fn ids_unique_and_nonempty() {
        let ids: Vec<&str> = DASHBOARD_CHART_PLACEHOLDERS.iter().map(|s| s.id).collect();
        let unique: std::collections::HashSet<&str> = ids.iter().copied().collect();
        assert_eq!(unique.len(), ids.len(), "id 必须唯一（v1.1 替换锚点）");
        for id in &ids {
            assert!(!id.is_empty());
        }
    }

    #[test]
    fn chart_heights_match_frontend_md_breakpoint() {
        // 前两张（收入趋势 / 渠道分布）chartClass 为 h-60 md:h-80 → 取 md 档 320px
        assert_eq!(DASHBOARD_CHART_PLACEHOLDERS[0].chart_height_px, 320.0);
        assert_eq!(DASHBOARD_CHART_PLACEHOLDERS[1].chart_height_px, 320.0);
        // 其余四张为 h-52 md:h-64 → 取 md 档 256px
        for spec in &DASHBOARD_CHART_PLACEHOLDERS[2..] {
            assert_eq!(spec.chart_height_px, 256.0);
        }
    }
}
