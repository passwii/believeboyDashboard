//! 广告模块（sidebar 一级分类「广告」）
//!
//! 数据源：
//! - `GET /api/v1/ad-analysis/overview` —— 广告分析概览（adAgentV2 汇总，
//!   对齐 frontend `app/dashboard/advertising/ad-analysis/overview`）；
//! - `GET /api/v1/internal/ad-data/projects/{id}/ad-upload-files` —— 项目已入库
//!   的广告报表文件列表（判断哪些报表类型有成功数据）；
//! - `GET /api/v1/internal/ad-data/projects/{id}/ad-{endpoint}-raw` —— 某报表
//!   类型的原始行（对齐 frontend `app/dashboard/advertising/ad-data` 的
//!   `lib/ad-data.ts` 展示列与格式化口径）。
//!
//! 字段命名沿用后端 Pydantic 模型（snake_case）1:1；ad-analysis 的 `top_*` /
//! `trend_summary` 是 `list[dict[str, object]]`，本模块对 GUI 展示所需字段做
//! 定型（Option + default 容忍缺省）；ad-data 原始行 10 种报表字段各异，
//! 用 `serde_json::Value` 承载 + 列配置驱动展示。

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 广告分析概览（/ad-analysis/overview）
// ---------------------------------------------------------------------------

/// 指标卡（backend `AdAnalysisMetricCard` 1:1；`display_value` 已由后端格式化）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdMetricCard {
    pub label: String,
    pub value: f64,
    pub display_value: String,
    #[serde(default)]
    pub helper: Option<String>,
}

/// 风险卡（backend `AdAnalysisIssueCard` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdIssueCard {
    pub title: String,
    pub level: String,
    pub summary: String,
    #[serde(default)]
    pub drill_to: Option<String>,
    #[serde(default)]
    pub next_step: Option<String>,
}

/// 叙事段落（backend `AdAnalysisNarrativeSection` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdNarrativeSection {
    pub title: String,
    pub summary: String,
    #[serde(default)]
    pub evidence: Vec<String>,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub drill_to: Option<String>,
}

/// 周期对比（backend `AdAnalysisPeriodComparison` 1:1；字段全可缺省）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AdPeriodComparison {
    #[serde(default)]
    pub current_start: Option<String>,
    #[serde(default)]
    pub current_end: Option<String>,
    #[serde(default)]
    pub previous_start: Option<String>,
    #[serde(default)]
    pub previous_end: Option<String>,
    #[serde(default)]
    pub spend_change_ratio: Option<f64>,
    #[serde(default)]
    pub clicks_change_ratio: Option<f64>,
    #[serde(default)]
    pub sales_change_ratio: Option<f64>,
    #[serde(default)]
    pub orders_change_ratio: Option<f64>,
    #[serde(default)]
    pub cpc_change_ratio: Option<f64>,
    #[serde(default)]
    pub acos_change_ratio: Option<f64>,
    #[serde(default)]
    pub summary: Option<String>,
}

/// 近 7 日趋势行（`trend_summary[]` 定型；字段容忍缺省，比率字段为小数）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdTrendRow {
    #[serde(default)]
    pub report_date: Option<String>,
    #[serde(default)]
    pub spend: f64,
    #[serde(default)]
    pub clicks: i64,
    #[serde(default)]
    pub cpc: f64,
    /// 花费环比（小数，如 0.12 = +12%）；缺省/不可得为 None（显示「—」）
    #[serde(default)]
    pub spend_change_ratio: Option<f64>,
}

/// 高消耗活动行（`top_campaigns[]` 定型）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdTopCampaignRow {
    #[serde(default)]
    pub campaign_name: Option<String>,
    #[serde(default)]
    pub spend: f64,
    #[serde(default)]
    pub sales_7d: f64,
    #[serde(default)]
    pub orders_7d: i64,
    /// ACOS（小数，如 0.37 = 37%）
    #[serde(default)]
    pub acos: f64,
}

/// 高消耗 SKU 行（`top_products[]` 定型）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdTopProductRow {
    #[serde(default)]
    pub ad_sku: Option<String>,
    #[serde(default)]
    pub spend: f64,
    #[serde(default)]
    pub sales_7d: f64,
    #[serde(default)]
    pub orders_7d: i64,
    #[serde(default)]
    pub acos: f64,
}

/// 浪费搜索词行（`top_waste_terms[]` 定型）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdTopWasteTermRow {
    #[serde(default)]
    pub search_term: Option<String>,
    #[serde(default)]
    pub campaign_name: Option<String>,
    #[serde(default)]
    pub clicks: i64,
    #[serde(default)]
    pub spend: f64,
    #[serde(default)]
    pub orders_7d: i64,
}

/// `GET /api/v1/ad-analysis/overview` 响应（backend `AdAnalysisOverviewResponse` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdOverviewResponse {
    pub project_id: i64,
    pub country: String,
    #[serde(default)]
    pub metrics: Vec<AdMetricCard>,
    #[serde(default)]
    pub issue_cards: Vec<AdIssueCard>,
    #[serde(default)]
    pub narrative_sections: Vec<AdNarrativeSection>,
    #[serde(default)]
    pub comparison: Option<AdPeriodComparison>,
    #[serde(default)]
    pub top_campaigns: Vec<AdTopCampaignRow>,
    #[serde(default)]
    pub top_products: Vec<AdTopProductRow>,
    #[serde(default)]
    pub top_waste_terms: Vec<AdTopWasteTermRow>,
    #[serde(default)]
    pub trend_summary: Vec<AdTrendRow>,
}

// ---------------------------------------------------------------------------
// 广告分析子 Tab（/ad-analysis/{campaigns|products|…}，BLF-799 Pattern B）
//
// 除 overview / time-trend 外的 7+1 个子 Tab 响应同构：
// `{ project_id, country, summary_cards[], narrative_sections[], items[] }`；
// `items` 是后端 `list[dict[str, object]]`（字段随 Tab 而异），GUI 用
// [`serde_json::Value`] 承载 + [`ad_analysis_tabs`] 列配置驱动展示
// （与 ad-data 原始行同一策略）。比率字段为小数（0.37），展示口径沿用
// [`AdFormat::Percent`] 的 ×100 规则。
// ---------------------------------------------------------------------------

/// 通用摘要卡（backend 各 Tab 响应的 `summary_cards[]` 1:1；value 已由后端格式化）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdSummaryCard {
    pub label: String,
    pub value: String,
    #[serde(default)]
    pub helper: Option<String>,
}

/// `GET /api/v1/ad-analysis/{tab}` 通用响应（除 overview / time-trend 外的同构 Tab）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdAnalysisTabResponse {
    pub project_id: i64,
    pub country: String,
    #[serde(default)]
    pub summary_cards: Vec<AdSummaryCard>,
    #[serde(default)]
    pub narrative_sections: Vec<AdNarrativeSection>,
    /// 明细行（字段随 Tab 而异，列配置驱动展示）
    #[serde(default)]
    pub items: Vec<serde_json::Value>,
}

/// `GET /api/v1/ad-analysis/time-trend` 响应（backend `AdAnalysisTimeTrendResponse` 1:1；
/// 明细字段名是 `summary` 而非 `items`，单独定型）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdTimeTrendResponse {
    pub project_id: i64,
    pub country: String,
    /// 每日聚合行（report_date / clicks / spend / cpc / running_spend /
    /// spend_change_ratio），列配置驱动展示
    #[serde(default)]
    pub summary: Vec<serde_json::Value>,
    #[serde(default)]
    pub comparison: Option<AdPeriodComparison>,
}

impl AdTimeTrendResponse {
    /// 归一到通用 Tab 响应（summary → items；GUI 侧统一按 items 消费）
    #[must_use]
    pub fn into_tab_response(self) -> AdAnalysisTabResponse {
        AdAnalysisTabResponse {
            project_id: self.project_id,
            country: self.country,
            summary_cards: Vec::new(),
            narrative_sections: Vec::new(),
            items: self.summary,
        }
    }
}

/// 广告分析子 Tab 列定义（复用 ad-data 的 [`AdColumn`]：key + 中文列名 + 格式）
pub type AdAnalysisColumn = AdColumn;

/// 广告分析子 Tab 配置（Pattern B 下半区一 Tab 一配置；key 即端点路径段）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdAnalysisTabDef {
    /// 端点路径段：`campaigns` → `/ad-analysis/campaigns`
    pub key: &'static str,
    /// Tab 条显示名
    pub label: &'static str,
    /// 明细列配置（items 行 → 表格列）
    pub columns: Vec<AdAnalysisColumn>,
}

impl AdAnalysisTabDef {
    /// 从行里按 key 取原始值（缺字段 → Null，格式化为「-」）
    pub fn value<'a>(&self, row: &'a serde_json::Value, key: &str) -> &'a serde_json::Value {
        row.get(key).unwrap_or(&serde_json::Value::Null)
    }
}

/// 广告分析明细 Tab 配置表（10 子 Tab 中除「总览」外的 9 个；顺序对齐 frontend
/// `AD_ANALYSIS_TABS`：总览之后依次 趋势/活动/SKU/已购买商品/搜索词/投放/广告位/
/// 预算/流量质量。总览 Tab 由 overview 端点的定型结构渲染，不入本表）。
///
/// 列选取对齐 frontend 各 *-client.tsx 表头（保留 GUI 可读的关键数值列，
/// 「下钻」动作列在 GUI 无内部路由不实现）。
pub fn ad_analysis_tabs() -> Vec<AdAnalysisTabDef> {
    use AdFormat::{Int as I, Money as M, Percent as P, Ratio as R, Text as T};
    vec![
        AdAnalysisTabDef {
            key: "time-trend",
            label: "趋势",
            columns: vec![
                col("report_date", "日期", T),
                col("clicks", "点击量", I),
                col("spend", "花费", M),
                col("cpc", "CPC", M),
                col("running_spend", "累计花费", M),
                col("spend_change_ratio", "花费环比", P),
            ],
        },
        AdAnalysisTabDef {
            key: "campaigns",
            label: "活动",
            columns: vec![
                col("campaign_name", "活动", T),
                col("grade", "Grade", T),
                col("targeting_type", "类型", T),
                col("status", "状态", T),
                col("budget", "预算", M),
                col("impressions", "展示量", I),
                col("clicks", "点击量", I),
                col("ctr", "CTR", P),
                col("cpc", "CPC", M),
                col("spend", "花费", M),
                col("sales_7d", "Sales", M),
                col("orders_7d", "订单", I),
                col("acos", "ACOS", P),
                col("roas", "ROAS", R),
                col("budget_gap", "预算缺口", M),
                col("budget_utilization_rate", "预算利用率", P),
                col("cross_sell_sales_7d", "关联销售", M),
                col("next_action", "下一步", T),
            ],
        },
        AdAnalysisTabDef {
            key: "products",
            label: "SKU",
            columns: vec![
                col("ad_sku", "SKU", T),
                col("ad_asin", "ASIN", T),
                col("grade", "Grade", T),
                col("primary_campaign", "主活动", T),
                col("impressions", "展示量", I),
                col("clicks", "点击量", I),
                col("ctr", "CTR", P),
                col("cpc", "CPC", M),
                col("spend", "花费", M),
                col("sales_7d", "Sales", M),
                col("orders_7d", "订单", I),
                col("units_7d", "单位数", I),
                col("cvr_7d", "转化率", P),
                col("acos", "ACOS", P),
                col("cross_sell_orders_7d", "关联订单", I),
                col("cross_sell_sales_7d", "关联销售", M),
                col("next_action", "动作", T),
            ],
        },
        AdAnalysisTabDef {
            key: "purchased-products",
            label: "已购买商品",
            columns: vec![
                col("purchased_asin", "关联 ASIN", T),
                col("ad_sku", "广告 SKU", T),
                col("campaign_count", "活动数", I),
                col("other_sku_units_7d", "Units", I),
                col("other_sku_orders_7d", "Orders", I),
                col("other_sku_sales_7d", "Sales", M),
                col("action", "动作", T),
            ],
        },
        AdAnalysisTabDef {
            key: "search-terms",
            label: "搜索词",
            columns: vec![
                col("search_term", "搜索词", T),
                col("match_type", "匹配类型", T),
                col("primary_campaign", "主活动", T),
                col("impressions", "展示量", I),
                col("clicks", "点击量", I),
                col("ctr", "CTR", P),
                col("cpc", "CPC", M),
                col("spend", "花费", M),
                col("sales_7d", "Sales", M),
                col("orders_7d", "订单", I),
                col("cvr_7d", "CVR", P),
                col("acos", "ACOS", P),
                col("impression_share", "份额", P),
                col("impression_rank", "排名", I),
                col("action", "动作", T),
            ],
        },
        AdAnalysisTabDef {
            key: "targets",
            label: "投放",
            columns: vec![
                col("target_text", "投放", T),
                col("match_type", "匹配类型", T),
                col("primary_campaign", "主活动", T),
                col("impressions", "展示量", I),
                col("clicks", "点击量", I),
                col("ctr", "CTR", P),
                col("cpc", "CPC", M),
                col("spend", "花费", M),
                col("sales_7d", "Sales", M),
                col("orders_7d", "订单", I),
                col("cvr_7d", "CVR", P),
                col("acos", "ACOS", P),
                col("top_of_search_impression_share", "首页份额", P),
                col("action", "动作", T),
            ],
        },
        AdAnalysisTabDef {
            key: "placements",
            label: "广告位",
            columns: vec![
                col("placement", "广告位", T),
                col("campaign_name", "活动", T),
                col("impressions", "展示量", I),
                col("clicks", "点击量", I),
                col("ctr", "CTR", P),
                col("cpc", "CPC", M),
                col("spend", "花费", M),
                col("sales_7d", "Sales", M),
                col("orders_7d", "订单", I),
                col("units_7d", "单位数", I),
                col("cvr_7d", "转化率", P),
                col("acos", "ACOS", P),
                col("roas", "ROAS", R),
                col("action", "建议", T),
            ],
        },
        AdAnalysisTabDef {
            key: "budget",
            label: "预算",
            columns: vec![
                col("campaign_name", "活动", T),
                col("status", "状态", T),
                col("budget", "当前预算", M),
                col("suggested_budget", "建议预算", M),
                col("budget_gap", "预算缺口", M),
                col("budget_utilization_rate", "预算利用率", P),
                col("missed_sales_min", "错失销售(最小)", M),
                col("missed_sales_max", "错失销售(最大)", M),
                col("spend", "花费", M),
                col("sales_7d", "Sales", M),
                col("orders_7d", "订单", I),
                col("acos", "ACOS", P),
                col("next_step", "下一步", T),
            ],
        },
        AdAnalysisTabDef {
            key: "traffic-quality",
            label: "流量质量",
            columns: vec![
                col("campaign_name", "活动", T),
                col("status", "状态", T),
                col("risk_level", "风险等级", T),
                col("total_impressions", "总曝光", I),
                col("invalid_impressions", "无效曝光", I),
                col("invalid_impression_rate", "无效曝光率", P),
                col("total_clicks", "总点击", I),
                col("invalid_clicks", "无效点击", I),
                col("invalid_click_rate", "无效点击率", P),
                col("next_step", "下一步", T),
            ],
        },
    ]
}

/// 按 Tab key 查配置（无 → None；overview / 未知 key 均为 None）
pub fn ad_analysis_tab(key: &str) -> Option<AdAnalysisTabDef> {
    ad_analysis_tabs().into_iter().find(|t| t.key == key)
}

// ---------------------------------------------------------------------------
// 广告数据（/internal/ad-data）
// ---------------------------------------------------------------------------

/// 项目已入库的广告报表文件（backend `AdUploadFileItem` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdUploadFileItem {
    pub file_id: i64,
    pub report_type: String,
    pub report_label: String,
    pub country: String,
    pub period_start_date: String,
    pub period_end_date: String,
    pub version: i64,
    pub is_current: bool,
    pub ingestion_status: String,
    #[serde(default)]
    pub row_count_preview: Option<i64>,
    pub uploaded_at: String,
}

/// 周期信息（backend `PeriodInfo` 1:1，嵌入每个 raw 响应）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdPeriodInfo {
    /// "relative" | "custom"
    pub r#type: String,
    pub value: String,
    pub start_date: String,
    pub end_date: String,
}

/// raw 响应 summary（backend `RawSummary` 1:1；字段容忍缺省）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AdRawSummary {
    #[serde(default)]
    pub total_rows: i64,
    #[serde(default)]
    pub date_range: Vec<String>,
}

/// `GET /internal/ad-data/projects/{id}/ad-{endpoint}-raw` 响应（backend `RawResponse` 1:1）
///
/// `data` 用 `serde_json::Value` 承载：10 种报表原始行字段各异，由
/// [`AdReportType`] 列配置驱动展示（对齐 frontend `Record<string, unknown>`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AdRawResponse {
    pub project_id: i64,
    pub period: AdPeriodInfo,
    pub country: String,
    #[serde(default)]
    pub data: Vec<serde_json::Value>,
    #[serde(default)]
    pub summary: AdRawSummary,
}

// ---------------------------------------------------------------------------
// 广告数据列配置（对齐 frontend `lib/ad-data.ts` 的 AD_DATA_REPORT_TYPES）
// ---------------------------------------------------------------------------

/// 展示格式（对齐 frontend `AdDataFormat`）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdFormat {
    Text,
    Int,
    Money,
    /// 比率 → 展示为百分数（原始行里是小数，如 0.37 → "37.00%"）
    Percent,
    /// 比率 → 固定 2 位小数（如 ROAS 3.45）
    Ratio,
    Date,
}

/// 原始表列（字段 key + 中文列名 + 格式）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdColumn {
    pub key: &'static str,
    pub label: &'static str,
    pub format: AdFormat,
}

/// 报表类型配置（选择器 label + 接口路径段 + 展示列）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdReportType {
    /// 后端 report_type，如 `ad_campaign_report`
    pub report_type: &'static str,
    /// 选择器 / 导航显示名
    pub label: &'static str,
    /// 接口路径段：`campaigns` → `/ad-campaigns-raw`
    pub endpoint: &'static str,
    pub columns: Vec<AdColumn>,
}

/// 报告开始/结束日期列（每个报表类型共用前缀）
const DATE_COLS: [AdColumn; 2] = [
    AdColumn {
        key: "report_start_date",
        label: "报告开始日期",
        format: AdFormat::Date,
    },
    AdColumn {
        key: "report_end_date",
        label: "报告结束日期",
        format: AdFormat::Date,
    },
];

fn col(key: &'static str, label: &'static str, format: AdFormat) -> AdColumn {
    AdColumn { key, label, format }
}

/// 10 种报表类型（与 frontend `AD_DATA_REPORT_TYPES` 1:1，顺序一致）
pub fn ad_report_types() -> Vec<AdReportType> {
    vec![
        AdReportType {
            report_type: "ad_campaign_report",
            label: "广告活动",
            endpoint: "campaigns",
            columns: vec![
                DATE_COLS[0].clone(),
                DATE_COLS[1].clone(),
                col("campaign_name", "广告活动名称", AdFormat::Text),
                col("portfolio_name", "投资组合", AdFormat::Text),
                col("campaign_type", "广告活动类型", AdFormat::Text),
                col("targeting_type", "定位类型", AdFormat::Text),
                col("bidding_strategy", "竞价策略", AdFormat::Text),
                col("status", "状态", AdFormat::Text),
                col("budget", "预算", AdFormat::Money),
                col("impressions", "展示量", AdFormat::Int),
                col("clicks", "点击量", AdFormat::Int),
                col("ctr", "点击率 CTR", AdFormat::Percent),
                col("spend", "花费", AdFormat::Money),
                col("cpc", "单次点击成本 CPC", AdFormat::Money),
                col("orders_7d", "7天订单数", AdFormat::Int),
                col("sales_7d", "7天销售额", AdFormat::Money),
                col("acos", "ACOS", AdFormat::Percent),
                col("roas", "ROAS", AdFormat::Ratio),
            ],
        },
        AdReportType {
            report_type: "ad_budget_report",
            label: "预算",
            endpoint: "budgets",
            columns: vec![
                DATE_COLS[0].clone(),
                DATE_COLS[1].clone(),
                col("campaign_name", "广告活动名称", AdFormat::Text),
                col("status", "状态", AdFormat::Text),
                col("budget", "当前预算", AdFormat::Money),
                col("suggested_budget", "建议预算", AdFormat::Money),
                col("budget_utilization_rate", "预算利用率", AdFormat::Percent),
                col("missed_impressions_min", "预计错失展示(最小)", AdFormat::Int),
                col("missed_impressions_max", "预计错失展示(最大)", AdFormat::Int),
                col("missed_clicks_min", "预计错失点击(最小)", AdFormat::Int),
                col("missed_clicks_max", "预计错失点击(最大)", AdFormat::Int),
                col("missed_sales_min", "预计错失销售(最小)", AdFormat::Money),
                col("missed_sales_max", "预计错失销售(最大)", AdFormat::Money),
                col("spend", "花费", AdFormat::Money),
                col("sales_7d", "7天销售额", AdFormat::Money),
                col("orders_7d", "7天订单数", AdFormat::Int),
                col("acos", "ACOS", AdFormat::Percent),
            ],
        },
        AdReportType {
            report_type: "ad_target_report",
            label: "搜索词投放",
            endpoint: "targets",
            columns: vec![
                DATE_COLS[0].clone(),
                DATE_COLS[1].clone(),
                col("campaign_name", "广告活动名称", AdFormat::Text),
                col("ad_group_name", "广告组名称", AdFormat::Text),
                col("target_text", "投放", AdFormat::Text),
                col("match_type", "匹配类型", AdFormat::Text),
                col("impressions", "展示量", AdFormat::Int),
                col("top_of_search_impression_share", "首页首位展示量份额", AdFormat::Percent),
                col("clicks", "点击量", AdFormat::Int),
                col("ctr", "点击率 CTR", AdFormat::Percent),
                col("cpc", "单次点击成本 CPC", AdFormat::Money),
                col("spend", "花费", AdFormat::Money),
                col("sales_7d", "7天销售额", AdFormat::Money),
                col("orders_7d", "7天订单数", AdFormat::Int),
                col("units_7d", "7天单位数", AdFormat::Int),
                col("acos", "ACOS", AdFormat::Percent),
                col("roas", "ROAS", AdFormat::Ratio),
                col("cvr_7d", "7天转化率", AdFormat::Percent),
            ],
        },
        AdReportType {
            report_type: "ad_placement_report",
            label: "广告位",
            endpoint: "placements",
            columns: vec![
                DATE_COLS[0].clone(),
                DATE_COLS[1].clone(),
                col("campaign_name", "广告活动名称", AdFormat::Text),
                col("placement", "广告位", AdFormat::Text),
                col("bidding_strategy", "竞价策略", AdFormat::Text),
                col("impressions", "展示量", AdFormat::Int),
                col("clicks", "点击量", AdFormat::Int),
                col("spend", "花费", AdFormat::Money),
                col("cpc", "单次点击成本 CPC", AdFormat::Money),
                col("sales_7d", "7天销售额", AdFormat::Money),
                col("orders_7d", "7天订单数", AdFormat::Int),
                col("units_7d", "7天单位数", AdFormat::Int),
                col("acos", "ACOS", AdFormat::Percent),
                col("roas", "ROAS", AdFormat::Ratio),
            ],
        },
        AdReportType {
            report_type: "ad_search_term_report",
            label: "搜索词",
            endpoint: "search-terms",
            columns: vec![
                DATE_COLS[0].clone(),
                DATE_COLS[1].clone(),
                col("campaign_name", "广告活动名称", AdFormat::Text),
                col("ad_group_name", "广告组名称", AdFormat::Text),
                col("match_type", "匹配类型", AdFormat::Text),
                col("search_term", "客户搜索词", AdFormat::Text),
                col("targeting_type", "定位类型", AdFormat::Text),
                col("impressions", "展示量", AdFormat::Int),
                col("clicks", "点击量", AdFormat::Int),
                col("ctr", "点击率 CTR", AdFormat::Percent),
                col("spend", "花费", AdFormat::Money),
                col("cpc", "单次点击成本 CPC", AdFormat::Money),
                col("orders_7d", "7天订单数", AdFormat::Int),
                col("sales_7d", "7天销售额", AdFormat::Money),
                col("acos", "ACOS", AdFormat::Percent),
                col("roas", "ROAS", AdFormat::Ratio),
                col("cvr_7d", "7天转化率", AdFormat::Percent),
            ],
        },
        AdReportType {
            report_type: "ad_search_term_share_report",
            label: "搜索词展示量份额",
            endpoint: "search-term-shares",
            columns: vec![
                DATE_COLS[0].clone(),
                DATE_COLS[1].clone(),
                col("search_term", "客户搜索词", AdFormat::Text),
                col("impression_rank", "展示量排名", AdFormat::Int),
                col("impression_share", "展示量份额", AdFormat::Percent),
                col("target_text", "投放", AdFormat::Text),
                col("match_type", "匹配类型", AdFormat::Text),
                col("campaign_name", "广告活动名称", AdFormat::Text),
                col("ad_group_name", "广告组名称", AdFormat::Text),
                col("clicks", "点击量", AdFormat::Int),
                col("impressions", "展示量", AdFormat::Int),
                col("ctr", "点击率 CTR", AdFormat::Percent),
                col("spend", "花费", AdFormat::Money),
                col("cpc", "单次点击成本 CPC", AdFormat::Money),
                col("orders_7d", "7天订单数", AdFormat::Int),
                col("sales_7d", "7天销售额", AdFormat::Money),
                col("acos", "ACOS", AdFormat::Percent),
                col("roas", "ROAS", AdFormat::Ratio),
                col("cvr_7d", "7天转化率", AdFormat::Percent),
            ],
        },
        AdReportType {
            report_type: "ad_promoted_product_report",
            label: "推广的商品",
            endpoint: "promoted-products",
            columns: vec![
                DATE_COLS[0].clone(),
                DATE_COLS[1].clone(),
                col("campaign_name", "广告活动名称", AdFormat::Text),
                col("ad_group_name", "广告组名称", AdFormat::Text),
                col("ad_sku", "广告SKU", AdFormat::Text),
                col("ad_asin", "广告ASIN", AdFormat::Text),
                col("impressions", "展示量", AdFormat::Int),
                col("clicks", "点击量", AdFormat::Int),
                col("ctr", "点击率 CTR", AdFormat::Percent),
                col("spend", "花费", AdFormat::Money),
                col("cpc", "单次点击成本 CPC", AdFormat::Money),
                col("orders_7d", "7天订单数", AdFormat::Int),
                col("units_7d", "7天单位数", AdFormat::Int),
                col("sales_7d", "7天销售额", AdFormat::Money),
                col("acos", "ACOS", AdFormat::Percent),
                col("roas", "ROAS", AdFormat::Ratio),
                col("cvr_7d", "7天转化率", AdFormat::Percent),
                col("ad_sku_units_7d", "广告SKU 7天单位数", AdFormat::Int),
                col("other_sku_units_7d", "其他SKU 7天单位数", AdFormat::Int),
                col("ad_sku_sales_7d", "广告SKU 7天销售额", AdFormat::Money),
                col("other_sku_sales_7d", "其他SKU 7天销售额", AdFormat::Money),
                col("scope_status", "范围状态", AdFormat::Text),
            ],
        },
        AdReportType {
            report_type: "ad_time_trend_report",
            label: "按时间查看效果",
            endpoint: "time-trends",
            columns: vec![
                DATE_COLS[0].clone(),
                DATE_COLS[1].clone(),
                col("country", "国家/地区", AdFormat::Text),
                col("currency", "货币", AdFormat::Text),
                col("clicks", "点击量", AdFormat::Int),
                col("cpc", "单次点击成本 CPC", AdFormat::Money),
                col("spend", "花费", AdFormat::Money),
            ],
        },
        AdReportType {
            report_type: "ad_invalid_traffic_report",
            label: "总流量和无效流量",
            endpoint: "invalid-traffic",
            columns: vec![
                DATE_COLS[0].clone(),
                DATE_COLS[1].clone(),
                col("campaign_name", "广告活动名称", AdFormat::Text),
                col("status", "状态", AdFormat::Text),
                col("total_impressions", "总展示量", AdFormat::Int),
                col("valid_impressions", "有效展示量", AdFormat::Int),
                col("invalid_impressions", "无效展示量", AdFormat::Int),
                col("invalid_impression_rate", "无效展示率", AdFormat::Percent),
                col("total_clicks", "总点击量", AdFormat::Int),
                col("valid_clicks", "有效点击量", AdFormat::Int),
                col("invalid_clicks", "无效点击量", AdFormat::Int),
                col("invalid_click_rate", "无效点击率", AdFormat::Percent),
            ],
        },
        AdReportType {
            report_type: "ad_purchased_product_report",
            label: "已购买商品",
            endpoint: "purchased-products",
            columns: vec![
                DATE_COLS[0].clone(),
                DATE_COLS[1].clone(),
                col("campaign_name", "广告活动名称", AdFormat::Text),
                col("ad_group_name", "广告组名称", AdFormat::Text),
                col("ad_sku", "广告SKU", AdFormat::Text),
                col("ad_asin", "广告ASIN", AdFormat::Text),
                col("target_text", "投放", AdFormat::Text),
                col("match_type", "匹配类型", AdFormat::Text),
                col("purchased_asin", "已购买ASIN", AdFormat::Text),
                col("other_sku_units_7d", "其他SKU 7天单位数", AdFormat::Int),
                col("other_sku_orders_7d", "其他SKU 7天订单数", AdFormat::Int),
                col("other_sku_sales_7d", "其他SKU 7天销售额", AdFormat::Money),
            ],
        },
    ]
}

/// 按 report_type 查报表类型配置（无 → None）
pub fn ad_report_type(report_type: &str) -> Option<AdReportType> {
    ad_report_types()
        .into_iter()
        .find(|item| item.report_type == report_type)
}

// ---------------------------------------------------------------------------
// 展示格式化（对齐 frontend `formatAdDataValue`）
// ---------------------------------------------------------------------------

/// 千分位整数（对齐 frontend `toLocaleString` 无小数位）
fn format_int(v: i64) -> String {
    let negative = v < 0;
    let digits = v.abs().to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    if negative {
        out.insert(0, '-');
    }
    out
}

/// 千分位 + 固定小数位（对齐 frontend `toLocaleString(min/max 2)`）
fn format_fixed(v: f64, decimals: usize) -> String {
    let negative = v < 0.0;
    let scale = 10f64.powi(decimals as i32);
    let rounded = (v.abs() * scale).round() / scale;
    let int_str = format_int(rounded.trunc() as i64);
    let frac = (rounded.fract() * scale).round() as u64;
    let frac_str = format!("{frac:0width$}", width = decimals);
    let body = if decimals > 0 {
        format!("{int_str}.{frac_str}")
    } else {
        int_str
    };
    if negative {
        format!("-{body}")
    } else {
        body
    }
}

/// 从 JSON 值提取数值（数字原样；字符串尝试解析；null/缺省 → None）
fn as_number(value: &serde_json::Value) -> Option<f64> {
    match value {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}

/// 最小可读化：把原始行值转成展示字符串。空值 / 不可解析返回 `-`。
///
/// 对齐 frontend `formatAdDataValue`：percent 是「小数 ×100」的展示口径
/// （原始行里 ctr / acos 等为比率，如 0.37 → "37.00%"）。
pub fn format_ad_value(value: &serde_json::Value, format: AdFormat) -> String {
    match format {
        AdFormat::Int => match as_number(value) {
            Some(n) => format_int(n.round() as i64),
            None => "-".to_string(),
        },
        AdFormat::Money => match as_number(value) {
            Some(n) => format!("${}", format_fixed(n, 2)),
            None => "-".to_string(),
        },
        AdFormat::Percent => match as_number(value) {
            Some(n) => format!("{:.2}%", n * 100.0),
            None => "-".to_string(),
        },
        AdFormat::Ratio => match as_number(value) {
            Some(n) => format!("{n:.2}"),
            None => "-".to_string(),
        },
        AdFormat::Date | AdFormat::Text => match value {
            serde_json::Value::Null => "-".to_string(),
            serde_json::Value::String(s) if s.is_empty() => "-".to_string(),
            other => other.to_string().trim_matches('"').to_string(),
        },
    }
}

/// 该列是否按数值排序（text / date 按字符串排，其余按数值排）
pub fn is_numeric_format(format: AdFormat) -> bool {
    !matches!(format, AdFormat::Text | AdFormat::Date)
}

/// 数值列排序键（BLF-799：`serde_json::Value` 行的动态列排序取值；
/// 数字 / 数字字符串 → f64，其余 None → 调用方落 `f64::NAN` 沉底）
pub fn ad_numeric_value(value: &serde_json::Value) -> Option<f64> {
    match value {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(n: f64) -> serde_json::Value {
        serde_json::json!(n)
    }

    #[test]
    fn report_types_cover_all_ten_endpoints() {
        let types = ad_report_types();
        assert_eq!(types.len(), 10, "应与 frontend AD_DATA_REPORT_TYPES 的 10 种一致");
        // 路径段唯一 + report_type 唯一（表格选择器去重依据）
        let mut endpoints: Vec<&str> = types.iter().map(|t| t.endpoint).collect();
        endpoints.sort_unstable();
        endpoints.dedup();
        assert_eq!(endpoints.len(), types.len(), "endpoint 不允许重复");
        let mut report_types: Vec<&str> = types.iter().map(|t| t.report_type).collect();
        report_types.sort_unstable();
        report_types.dedup();
        assert_eq!(report_types.len(), types.len(), "report_type 不允许重复");
        // 每种类型至少 3 列（日期 2 + 至少 1 业务列）
        for t in &types {
            assert!(t.columns.len() >= 3, "{} 列数异常", t.report_type);
            assert!(!t.label.is_empty());
        }
    }

    #[test]
    fn format_ad_value_matches_frontend() {
        // int：千分位
        assert_eq!(format_ad_value(&v(1234567.0), AdFormat::Int), "1,234,567");
        assert_eq!(format_ad_value(&serde_json::json!(4200), AdFormat::Int), "4,200");
        // money：$ + 2 位小数 + 千分位
        assert_eq!(format_ad_value(&v(1234.5), AdFormat::Money), "$1,234.50");
        assert_eq!(format_ad_value(&v(0.0), AdFormat::Money), "$0.00");
        // percent：小数 ×100 + 2 位小数（对齐 frontend `(Number(v)*100).toFixed(2)%`）
        assert_eq!(format_ad_value(&v(0.37), AdFormat::Percent), "37.00%");
        assert_eq!(format_ad_value(&v(0.0), AdFormat::Percent), "0.00%");
        assert_eq!(format_ad_value(&v(0.12345), AdFormat::Percent), "12.35%");
        // ratio：固定 2 位小数
        assert_eq!(format_ad_value(&v(3.456), AdFormat::Ratio), "3.46");
        // date / text：字符串原样；空 / null → '-'
        assert_eq!(
            format_ad_value(&serde_json::json!("2026-08-13"), AdFormat::Date),
            "2026-08-13"
        );
        assert_eq!(
            format_ad_value(&serde_json::json!("B0-A-001"), AdFormat::Text),
            "B0-A-001"
        );
        assert_eq!(format_ad_value(&serde_json::Value::Null, AdFormat::Text), "-");
        assert_eq!(
            format_ad_value(&serde_json::json!(""), AdFormat::Date),
            "-"
        );
        // 字符串数字也能解析（后端宽松场景）
        assert_eq!(
            format_ad_value(&serde_json::json!("12.5"), AdFormat::Money),
            "$12.50"
        );
        // 不可解析 → '-'
        assert_eq!(
            format_ad_value(&serde_json::json!("abc"), AdFormat::Money),
            "-"
        );
    }

    #[test]
    fn is_numeric_format_classifies() {
        assert!(is_numeric_format(AdFormat::Int));
        assert!(is_numeric_format(AdFormat::Money));
        assert!(is_numeric_format(AdFormat::Percent));
        assert!(is_numeric_format(AdFormat::Ratio));
        assert!(!is_numeric_format(AdFormat::Text));
        assert!(!is_numeric_format(AdFormat::Date));
    }

    #[test]
    fn overview_response_deserializes_sample_json() {
        let json = r#"{
            "project_id": 1,
            "country": "US",
            "metrics": [
                {"label": "花费", "value": 122.4, "display_value": "$122.40", "helper": "近 7 天"},
                {"label": "ACOS", "value": 0.0658, "display_value": "6.58%", "helper": null}
            ],
            "issue_cards": [
                {"title": "高 ACOS 活动", "level": "warning", "summary": "ACOS 高于阈值", "drill_to": "campaigns", "next_step": "检查关键词"}
            ],
            "narrative_sections": [
                {"title": "花费趋势", "summary": "花费环比上升", "evidence": ["花费 +12%"], "action": "关注", "drill_to": "time-trend"}
            ],
            "comparison": {
                "current_start": "2026-08-07", "current_end": "2026-08-13",
                "previous_start": "2026-07-31", "previous_end": "2026-08-06",
                "spend_change_ratio": 0.12, "clicks_change_ratio": -0.05,
                "sales_change_ratio": 0.2, "orders_change_ratio": 0.15,
                "cpc_change_ratio": 0.18, "acos_change_ratio": -0.08,
                "summary": "花费上升但销售增长更快"
            },
            "top_campaigns": [
                {"campaign_name": "活动 A", "spend": 80.0, "sales_7d": 1200.0, "orders_7d": 8, "acos": 0.0667}
            ],
            "top_products": [
                {"ad_sku": "B0-A-001", "spend": 60.0, "sales_7d": 900.0, "orders_7d": 5, "acos": 0.0667}
            ],
            "top_waste_terms": [
                {"search_term": "water bottle", "campaign_name": "活动 B", "clicks": 40, "spend": 22.0, "orders_7d": 0}
            ],
            "trend_summary": [
                {"report_date": "2026-08-13", "spend": 18.0, "clicks": 35, "cpc": 0.51, "spend_change_ratio": 0.12}
            ],
            "top_cross_sell_products": []
        }"#;
        let resp: AdOverviewResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.project_id, 1);
        assert_eq!(resp.country, "US");
        assert_eq!(resp.metrics.len(), 2);
        assert_eq!(resp.metrics[0].display_value, "$122.40");
        assert_eq!(resp.metrics[0].helper.as_deref(), Some("近 7 天"));
        assert_eq!(resp.metrics[1].helper, None);
        assert_eq!(resp.issue_cards[0].drill_to.as_deref(), Some("campaigns"));
        assert_eq!(resp.narrative_sections[0].evidence, vec!["花费 +12%".to_string()]);
        let c = resp.comparison.expect("comparison 应有值");
        assert_eq!(c.current_start.as_deref(), Some("2026-08-07"));
        assert_eq!(c.spend_change_ratio, Some(0.12));
        assert_eq!(resp.top_campaigns[0].campaign_name.as_deref(), Some("活动 A"));
        assert_eq!(resp.top_campaigns[0].acos, 0.0667);
        assert_eq!(resp.top_products[0].ad_sku.as_deref(), Some("B0-A-001"));
        assert_eq!(
            resp.top_waste_terms[0].search_term.as_deref(),
            Some("water bottle")
        );
        assert_eq!(resp.trend_summary[0].report_date.as_deref(), Some("2026-08-13"));
        assert_eq!(resp.trend_summary[0].spend, 18.0);
        assert_eq!(resp.trend_summary[0].spend_change_ratio, Some(0.12));
        // 缺省字段：top_cross_sell_products 未定型（忽略）；metrics 缺 helper → None
        assert_eq!(resp.metrics[1].helper, None);
    }

    #[test]
    fn raw_response_deserializes_sample_json() {
        let json = r#"{
            "project_id": 1,
            "period": {"type": "custom", "value": "custom", "start_date": "2026-08-01", "end_date": "2026-08-13"},
            "country": "US",
            "data": [
                {"id": 1, "campaign_name": "活动 A", "impressions": 1200, "clicks": 60, "spend": 30.5, "sales_7d": 500.0, "acos": 0.061},
                {"id": 2, "campaign_name": "活动 B", "impressions": 800, "clicks": 30, "spend": 12.0, "sales_7d": 200.0, "acos": 0.06}
            ],
            "summary": {"total_rows": 2, "date_range": ["2026-08-01", "2026-08-13"]}
        }"#;
        let resp: AdRawResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.project_id, 1);
        assert_eq!(resp.period.r#type, "custom");
        assert_eq!(resp.period.start_date, "2026-08-01");
        assert_eq!(resp.country, "US");
        assert_eq!(resp.data.len(), 2);
        assert_eq!(resp.data[0]["campaign_name"], "活动 A");
        assert_eq!(resp.summary.total_rows, 2);
        assert_eq!(resp.summary.date_range.len(), 2);
    }

    #[test]
    fn raw_response_tolerates_missing_summary_fields() {
        // 后端 summary 恒输出，但缺省（旧载荷）也要能反序列化
        let json = r#"{"project_id": 1, "period": {"type": "custom", "value": "custom", "start_date": "2026-08-01", "end_date": "2026-08-13"}, "country": "US", "data": [], "summary": {}}"#;
        let resp: AdRawResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.data.len(), 0);
        assert_eq!(resp.summary.total_rows, 0);
        assert!(resp.summary.date_range.is_empty());
    }

    /// BLF-799：9 个明细 Tab 配置齐备、key 唯一且与端点路径段一致；
    /// overview 不入表（由定型结构渲染）。
    #[test]
    fn analysis_tab_defs_cover_nine_item_tabs() {
        let tabs = ad_analysis_tabs();
        assert_eq!(tabs.len(), 9, "除总览外应有 9 个明细 Tab 配置");
        let expected = [
            "time-trend",
            "campaigns",
            "products",
            "purchased-products",
            "search-terms",
            "targets",
            "placements",
            "budget",
            "traffic-quality",
        ];
        let keys: Vec<&str> = tabs.iter().map(|t| t.key).collect();
        assert_eq!(keys, expected, "Tab 顺序对齐 frontend AD_ANALYSIS_TABS");
        for t in &tabs {
            assert!(!t.label.is_empty());
            assert!(t.columns.len() >= 3, "{} 列数异常", t.key);
            // 每列 key 唯一（表格列 id 去重依据）
            let mut col_keys: Vec<&str> = t.columns.iter().map(|c| c.key).collect();
            col_keys.sort_unstable();
            col_keys.dedup();
            assert_eq!(col_keys.len(), t.columns.len(), "{} 列 key 重复", t.key);
        }
        // overview / 未知 key 查不到
        assert!(ad_analysis_tab("overview").is_none());
        assert!(ad_analysis_tab("nope").is_none());
        assert!(ad_analysis_tab("campaigns").is_some());
    }

    /// BLF-799：通用 Tab 响应（items 为 dict 行）+ time-trend 响应都能反序列化，
    /// 缺省列表字段回退空。
    #[test]
    fn analysis_tab_responses_deserialize_sample_json() {
        let tab_json = r#"{
            "project_id": 3,
            "country": "DE",
            "summary_cards": [
                {"label": "活动数", "value": "12", "helper": null},
                {"label": "总花费", "value": "$320.10", "helper": "近 7 天"}
            ],
            "narrative_sections": [
                {"title": "花费趋势", "summary": "环比上升", "evidence": ["+12%"], "action": null}
            ],
            "items": [
                {"campaign_name": "活动 A", "spend": 80.0, "acos": 0.37, "grade": "A"},
                {"campaign_name": "活动 B", "spend": 42.5, "acos": 0.081, "grade": "C"}
            ]
        }"#;
        let resp: AdAnalysisTabResponse = serde_json::from_str(tab_json).expect("反序列化失败");
        assert_eq!(resp.project_id, 3);
        assert_eq!(resp.country, "DE");
        assert_eq!(resp.summary_cards.len(), 2);
        assert_eq!(resp.summary_cards[0].value, "12");
        assert_eq!(resp.narrative_sections.len(), 1);
        assert_eq!(resp.items.len(), 2);
        assert_eq!(resp.items[0]["grade"], "A");

        // 缺省 narrative_sections / summary_cards → 空
        let minimal: AdAnalysisTabResponse = serde_json::from_str(
            r#"{"project_id": 1, "country": "US", "items": []}"#,
        )
        .expect("最小载荷应可解析");
        assert!(minimal.summary_cards.is_empty());
        assert!(minimal.narrative_sections.is_empty());

        let trend_json = r#"{
            "project_id": 1,
            "country": "US",
            "summary": [
                {"report_date": "2026-08-13", "clicks": 35, "spend": 18.0, "cpc": 0.51, "running_spend": 96.4, "spend_change_ratio": 0.12}
            ],
            "comparison": {"current_start": "2026-08-07", "current_end": "2026-08-13", "spend_change_ratio": 0.05}
        }"#;
        let trend: AdTimeTrendResponse = serde_json::from_str(trend_json).expect("反序列化失败");
        assert_eq!(trend.summary.len(), 1);
        assert_eq!(trend.summary[0]["report_date"], "2026-08-13");
        assert_eq!(
            trend.comparison.expect("comparison 应有值").spend_change_ratio,
            Some(0.05)
        );
        // comparison 可缺省
        let trend_min: AdTimeTrendResponse = serde_json::from_str(
            r#"{"project_id": 1, "country": "US", "summary": []}"#,
        )
        .expect("应可解析");
        assert!(trend_min.comparison.is_none());
    }

    /// BLF-799：TabDef::value 对缺字段行回退 Null（格式化层显示「-」）。
    #[test]
    fn tab_def_value_falls_back_to_null() {
        let def = ad_analysis_tab("time-trend").expect("趋势 Tab 应有配置");
        let row = serde_json::json!({"report_date": "2026-08-13", "clicks": 35});
        assert_eq!(def.value(&row, "clicks"), &serde_json::json!(35));
        assert_eq!(def.value(&row, "missing"), &serde_json::Value::Null);
    }

    /// BLF-799：time-trend 归一后 items 承载 summary 行；数值键解析。
    #[test]
    fn time_trend_normalizes_into_tab_response_and_numeric_value_parses() {
        let trend: AdTimeTrendResponse = serde_json::from_str(
            r#"{"project_id": 9, "country": "UK", "summary": [{"clicks": 3}]}"#,
        )
        .expect("应可解析");
        let tab = trend.into_tab_response();
        assert_eq!(tab.project_id, 9);
        assert_eq!(tab.country, "UK");
        assert_eq!(tab.items.len(), 1);

        assert_eq!(ad_numeric_value(&serde_json::json!(12.5)), Some(12.5));
        assert_eq!(ad_numeric_value(&serde_json::json!("0.37")), Some(0.37));
        assert_eq!(ad_numeric_value(&serde_json::Value::Null), None);
        assert_eq!(ad_numeric_value(&serde_json::json!("abc")), None);
    }
}
