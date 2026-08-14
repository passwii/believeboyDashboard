//! Dashboard 首页（KPI / 趋势 / 项目 / 国家 / 库存 / 流量）
//!
//! 数据源：FastAPI `/api/v1/daily-analysis/*` 系列端点
//! 字段对齐 frontend `app/dashboard/page.tsx` 的 `DailyAnalysisRow`

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

/// daily-analysis 单日一行（与 frontend `DailyAnalysisRow` 1:1）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyAnalysisRow {
    pub date: NaiveDate,

    pub order_qty: i64,
    pub sales_amount: f64,
    pub impressions: i64,
    pub clicks: i64,
    pub cpc: f64,
    pub ad_spend: f64,
    pub ad_orders: i64,
    pub available_qty: i64,
    pub page_views: i64,
    pub units_ordered: i64,
    pub sessions: i64,
    pub ordered_sales_amount: f64,
    pub conversion_rate: f64,
}

/// `/api/v1/daily-analysis/all` 响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyAnalysisResponse {
    pub summary_rows: Vec<DailyAnalysisRow>,
    #[serde(default)]
    pub project_breakdown: std::collections::HashMap<i64, ProjectBreakdownEntry>,
}

/// 单项目下的 summary_rows 子集（`project_breakdown[id]` 的 value）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectBreakdownEntry {
    pub project_name: String,
    pub summary_rows: Vec<DailyAnalysisRow>,
}

/// `/api/v1/daily-analysis/all-countries` 响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyAnalysisAllCountriesResponse {
    pub summary_rows: Vec<DailyAnalysisRow>,
    #[serde(default)]
    pub country_breakdown: std::collections::HashMap<String, CountryBreakdownEntry>,
    #[serde(default)]
    pub currency_note: Option<String>,
}

/// 单国家下的 summary_rows 子集
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CountryBreakdownEntry {
    pub summary_rows: Vec<DailyAnalysisRow>,
}
