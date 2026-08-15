//! Dashboard 首页（KPI / 趋势 / 项目 / 国家 / 库存 / 流量）
//!
//! 数据源：FastAPI `/api/v1/daily-analysis/*` 系列端点。
//! 字段对齐 frontend `frontend/types/api-generated/api.d.ts`（OpenAPI 生成，
//! 下游再对齐 `app/dashboard/page.tsx` 与 `components/dashboard-v2/*`），并逐一
//! 对照后端 `backend/app/schemas/daily_analysis.py` 的 Pydantic 模型。
//!
//! 命名对照（api.d.ts ↔ 本模块）：
//! - `DailyAnalysisSummaryRow`   ↔ `DailyAnalysisRow`
//! - `DailyAnalysisDetailRow`    ↔ `DailyAnalysisDetailRow`
//! - `DailyAnalysisConsoleResponse` ↔ `DailyAnalysisConsoleResponse`
//! - `DailyAnalysisAllProjectsResponse` ↔ `DailyAnalysisResponse`（`/all` 端点）
//! - `DailyAnalysisAllCountriesResponse` ↔ `DailyAnalysisAllCountriesResponse`

use std::collections::HashMap;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

/// daily-analysis 单日聚合行（frontend `DailyAnalysisSummaryRow` 1:1）
///
/// 后端 Pydantic 对 `page_views` / `units_ordered` / `sessions` /
/// `ordered_sales_amount` / `conversion_rate` 有默认值，反序列化时同样容忍缺省。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    #[serde(default)]
    pub page_views: i64,
    #[serde(default)]
    pub units_ordered: i64,
    #[serde(default)]
    pub sessions: i64,
    #[serde(default)]
    pub ordered_sales_amount: f64,
    #[serde(default)]
    pub conversion_rate: f64,
}

impl DailyAnalysisRow {
    /// 按字段抽成时间序列（日期升序），直接喂 gpui-component `Chart`：
    ///
    /// ```ignore
    /// let series = DailyAnalysisRow::time_series(&rows, |r| r.sales_amount);
    /// ```
    pub fn time_series(
        rows: &[DailyAnalysisRow],
        value: impl Fn(&DailyAnalysisRow) -> f64,
    ) -> Vec<TimeSeriesPoint> {
        rows.iter()
            .map(|r| TimeSeriesPoint {
                date: r.date,
                value: value(r),
            })
            .collect()
    }
}

/// SKU 粒度明细行（frontend `DailyAnalysisDetailRow` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DailyAnalysisDetailRow {
    pub date: NaiveDate,
    pub sku: String,
    pub asin: Option<String>,
    pub order_qty: i64,
    pub sales_amount: f64,
    pub impressions: i64,
    pub clicks: i64,
    pub cpc: f64,
    pub ad_spend: f64,
    pub ad_orders: i64,
    pub available_qty: i64,
    #[serde(default)]
    pub in_transit_qty: i64,
    #[serde(default)]
    pub page_views: i64,
    #[serde(default)]
    pub units_ordered: i64,
    #[serde(default)]
    pub sessions: i64,
    #[serde(default)]
    pub ordered_sales_amount: f64,
    #[serde(default)]
    pub conversion_rate: f64,
}

/// 各报表最新可用日期（backend `available_dates: dict[str, list[str]]` 的定型视图，
/// key 固定为 sales_report / ad_product_report / inventory_report / business_report）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AvailableDates {
    #[serde(default)]
    pub sales_report: Vec<String>,
    #[serde(default)]
    pub ad_product_report: Vec<String>,
    #[serde(default)]
    pub inventory_report: Vec<String>,
    #[serde(default)]
    pub business_report: Vec<String>,
}

/// 请求诊断信息（frontend `DailyAnalysisConsoleResponse` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DailyAnalysisConsoleResponse {
    pub project_id: i64,
    pub project_name: String,
    pub country: String,
    pub start_date: String,
    pub end_date: String,
    pub requested_days: i64,
    pub summary_days: i64,
    pub detail_rows: i64,
    pub sales_source_days: i64,
    pub ad_source_days: i64,
    pub inventory_source_days: i64,
    pub business_source_days: i64,
    #[serde(default)]
    pub missing_dates: Vec<String>,
    pub latest_sales_date: Option<String>,
    pub latest_ad_date: Option<String>,
    pub latest_inventory_date: Option<String>,
    pub latest_business_date: Option<String>,
}

fn default_usd() -> String {
    "USD".to_string()
}

/// `/api/v1/daily-analysis` 响应（**单项目 + 单国家**主端点；frontend `DailyAnalysisResponse` 1:1）
///
/// 与 [`DailyAnalysisResponse`]（`/all` 端点）不同：本载荷带 `console` 请求诊断
/// （项目名 / 国家 / 日期区间 / 各报表源天数 / 缺失日期），frontend
/// `app/dashboard/operations/daily-analysis` 单项目 + 指定站点时调用此端点。
/// `comparison_summary_rows` 为后端 schema 预留字段（实际载荷恒缺省），
/// 对比期数据由客户端另行拉取（与 frontend `Promise.all` 口径一致）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DailyAnalysisSingleResponse {
    pub console: DailyAnalysisConsoleResponse,
    pub summary_rows: Vec<DailyAnalysisRow>,
    #[serde(default)]
    pub detail_rows: Vec<DailyAnalysisDetailRow>,
    #[serde(default)]
    pub available_dates: AvailableDates,
    #[serde(default)]
    pub comparison_summary_rows: Option<Vec<DailyAnalysisRow>>,
}

/// `/api/v1/daily-analysis/all` 响应（frontend `DailyAnalysisAllProjectsResponse` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DailyAnalysisResponse {
    pub summary_rows: Vec<DailyAnalysisRow>,
    #[serde(default)]
    pub detail_rows: Vec<DailyAnalysisDetailRow>,
    #[serde(default)]
    pub available_dates: AvailableDates,
    #[serde(default)]
    pub project_breakdown: HashMap<i64, ProjectBreakdownEntry>,
}

/// 单项目下的子集（`project_breakdown[id]` 的 value；backend 固定输出 3 个 key）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectBreakdownEntry {
    pub project_name: String,
    pub summary_rows: Vec<DailyAnalysisRow>,
    #[serde(default)]
    pub detail_rows: Vec<DailyAnalysisDetailRow>,
}

/// `/api/v1/daily-analysis/all-countries` 响应（frontend `DailyAnalysisAllCountriesResponse` 1:1）
///
/// 金额字段（sales_amount / ad_spend / ordered_sales_amount）已由后端按当月 CNY
/// 中转折算为 USD 统一展示；顶层 `currency` 固定为 "USD"。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DailyAnalysisAllCountriesResponse {
    pub console: DailyAnalysisConsoleResponse,
    pub summary_rows: Vec<DailyAnalysisRow>,
    #[serde(default)]
    pub detail_rows: Vec<DailyAnalysisDetailRow>,
    #[serde(default)]
    pub available_dates: AvailableDates,
    #[serde(default)]
    pub country_breakdown: HashMap<String, CountryBreakdownEntry>,
    #[serde(default = "default_usd")]
    pub currency: String,
    #[serde(default)]
    pub currency_note: Option<String>,
}

/// 单国家下的子集（`country_breakdown[key]` 的 value；backend 固定输出 4 个 key）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CountryBreakdownEntry {
    pub summary_rows: Vec<DailyAnalysisRow>,
    #[serde(default)]
    pub detail_rows: Vec<DailyAnalysisDetailRow>,
    /// 折算后币种，固定 "USD"
    #[serde(default = "default_usd")]
    pub currency: String,
    /// 源币种（US=USD / DE=EUR / UK=GBP）
    #[serde(default)]
    pub source_currency: Option<String>,
}

/// 6 个核心 KPI 汇总（**派生类型**：由 `summary_rows` 聚合而来，后端不直接返回）
///
/// 口径对齐 frontend（`components/dashboard-v2/v2-stats.tsx` +
/// `components/dashboard/dashboard-ad-spend-chart.tsx`）：
/// - `sales_amount` 销售额 = Σ sales_amount
/// - `order_qty` 订单量 = Σ order_qty
/// - `ad_spend` 广告花费 = Σ ad_spend
/// - `acos` = ad_spend / sales_amount × 100（无销售额时为 0）
/// - `conversion_rate` 转化率 = units_ordered / page_views × 100（无 page_views 时为 0）
/// - `gross_profit` 毛利润：daily-analysis 载荷不含成本（COGS）字段，无法推导，
///   恒为 `None`，待接入利润数据源后再填充
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct KpiSummary {
    pub sales_amount: f64,
    pub order_qty: i64,
    pub ad_spend: f64,
    /// 百分比数值（如 20.0 表示 20%）
    pub acos: f64,
    /// 百分比数值（如 3.5 表示 3.5%）
    pub conversion_rate: f64,
    pub gross_profit: Option<f64>,
}

impl KpiSummary {
    /// 从聚合行推导 KPI 汇总（空切片 → 全 0，gross_profit 为 None）
    pub fn from_rows(rows: &[DailyAnalysisRow]) -> Self {
        let sales_amount: f64 = rows.iter().map(|r| r.sales_amount).sum();
        let order_qty: i64 = rows.iter().map(|r| r.order_qty).sum();
        let ad_spend: f64 = rows.iter().map(|r| r.ad_spend).sum();
        let page_views: i64 = rows.iter().map(|r| r.page_views).sum();
        let units_ordered: i64 = rows.iter().map(|r| r.units_ordered).sum();
        let acos = if sales_amount > 0.0 {
            (ad_spend / sales_amount) * 100.0
        } else {
            0.0
        };
        let conversion_rate = if page_views > 0 {
            (units_ordered as f64 / page_views as f64) * 100.0
        } else {
            0.0
        };
        Self {
            sales_amount,
            order_qty,
            ad_spend,
            acos,
            conversion_rate,
            gross_profit: None,
        }
    }
}

impl From<&[DailyAnalysisRow]> for KpiSummary {
    fn from(rows: &[DailyAnalysisRow]) -> Self {
        Self::from_rows(rows)
    }
}

/// 时间序列点（图表喂数形态：`Vec<(date, value)>` 的定型化，可序列化便于缓存/日志）
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TimeSeriesPoint {
    pub date: NaiveDate,
    pub value: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "expected {a} ≈ {b}");
    }

    #[test]
    fn daily_analysis_single_response_deserializes_sample_json() {
        // 后端 build_daily_analysis 的真实响应形态（GET /api/v1/daily-analysis），
        // 对齐 backend/app/services/daily/analysis.py 的 result dict
        let json = r#"{
            "console": {
                "project_id": 1,
                "project_name": "测试项目 A",
                "country": "US",
                "start_date": "2026-08-07",
                "end_date": "2026-08-13",
                "requested_days": 7,
                "summary_days": 7,
                "detail_rows": 1,
                "sales_source_days": 7,
                "ad_source_days": 7,
                "inventory_source_days": 5,
                "business_source_days": 6,
                "missing_dates": ["2026-08-11"],
                "latest_sales_date": "2026-08-13",
                "latest_ad_date": "2026-08-13",
                "latest_inventory_date": "2026-08-12",
                "latest_business_date": "2026-08-13"
            },
            "summary_rows": [
                {
                    "date": "2026-08-13",
                    "order_qty": 21,
                    "sales_amount": 1860.0,
                    "impressions": 8100,
                    "clicks": 240,
                    "cpc": 0.51,
                    "ad_spend": 122.4,
                    "ad_orders": 4,
                    "available_qty": 90,
                    "page_views": 430,
                    "units_ordered": 15,
                    "sessions": 380,
                    "ordered_sales_amount": 1790.0,
                    "conversion_rate": 3.49
                }
            ],
            "detail_rows": [
                {
                    "date": "2026-08-13",
                    "sku": "B0-A-001",
                    "asin": "B0EXAMPLE1",
                    "order_qty": 4,
                    "sales_amount": 360.0,
                    "impressions": 1800,
                    "clicks": 60,
                    "cpc": 0.48,
                    "ad_spend": 28.8,
                    "ad_orders": 1,
                    "available_qty": 30,
                    "in_transit_qty": 12,
                    "page_views": 96,
                    "units_ordered": 3,
                    "sessions": 80,
                    "ordered_sales_amount": 350.0,
                    "conversion_rate": 3.12
                }
            ],
            "available_dates": {
                "sales_report": ["2026-08-13"],
                "ad_product_report": ["2026-08-13"],
                "inventory_report": ["2026-08-12"],
                "business_report": ["2026-08-13"]
            }
        }"#;
        let resp: DailyAnalysisSingleResponse = serde_json::from_str(json).expect("反序列化失败");

        assert_eq!(resp.console.project_id, 1);
        assert_eq!(resp.console.country, "US");
        assert_eq!(resp.console.requested_days, 7);
        assert_eq!(resp.console.summary_days, 7);
        assert_eq!(resp.console.detail_rows, 1);
        assert_eq!(resp.console.missing_dates, vec!["2026-08-11".to_string()]);
        assert_eq!(
            resp.console.latest_inventory_date.as_deref(),
            Some("2026-08-12")
        );

        assert_eq!(resp.summary_rows.len(), 1);
        assert_eq!(resp.summary_rows[0].date.to_string(), "2026-08-13");
        approx(resp.summary_rows[0].sales_amount, 1860.0);

        assert_eq!(resp.detail_rows.len(), 1);
        assert_eq!(resp.detail_rows[0].sku, "B0-A-001");
        assert_eq!(resp.detail_rows[0].in_transit_qty, 12);

        assert_eq!(
            resp.available_dates.sales_report,
            vec!["2026-08-13".to_string()]
        );
        // 预留字段缺省 → None（后端实际载荷不输出）
        assert_eq!(resp.comparison_summary_rows, None);
    }

    #[test]
    fn daily_analysis_all_response_deserializes_sample_json() {
        // 后端 build_daily_analysis_all_projects 的真实响应形态（/api/v1/daily-analysis/all）
        let json = r#"{
            "summary_rows": [
                {
                    "date": "2026-08-13",
                    "order_qty": 42,
                    "sales_amount": 3100.5,
                    "impressions": 12000,
                    "clicks": 350,
                    "cpc": 0.62,
                    "ad_spend": 217.0,
                    "ad_orders": 6,
                    "available_qty": 180,
                    "page_views": 900,
                    "units_ordered": 31,
                    "sessions": 720,
                    "ordered_sales_amount": 2980.0,
                    "conversion_rate": 3.44
                }
            ],
            "detail_rows": [
                {
                    "date": "2026-08-13",
                    "sku": "B0-A-001",
                    "asin": "B0EXAMPLE1",
                    "order_qty": 12,
                    "sales_amount": 980.0,
                    "impressions": 3400,
                    "clicks": 95,
                    "cpc": 0.58,
                    "ad_spend": 55.1,
                    "ad_orders": 2,
                    "available_qty": 60,
                    "in_transit_qty": 24,
                    "page_views": 240,
                    "units_ordered": 9,
                    "sessions": 200,
                    "ordered_sales_amount": 940.0,
                    "conversion_rate": 3.75
                }
            ],
            "available_dates": {
                "sales_report": ["2026-08-13"],
                "ad_product_report": ["2026-08-13"],
                "inventory_report": ["2026-08-12"],
                "business_report": []
            },
            "project_breakdown": {
                "1": {
                    "project_name": "测试项目 A",
                    "summary_rows": [
                        {
                            "date": "2026-08-13",
                            "order_qty": 42,
                            "sales_amount": 3100.5,
                            "impressions": 12000,
                            "clicks": 350,
                            "cpc": 0.62,
                            "ad_spend": 217.0,
                            "ad_orders": 6,
                            "available_qty": 180,
                            "page_views": 900,
                            "units_ordered": 31,
                            "sessions": 720,
                            "ordered_sales_amount": 2980.0,
                            "conversion_rate": 3.44
                        }
                    ],
                    "detail_rows": []
                }
            }
        }"#;
        let resp: DailyAnalysisResponse = serde_json::from_str(json).expect("反序列化失败");

        assert_eq!(resp.summary_rows.len(), 1);
        let row = &resp.summary_rows[0];
        assert_eq!(row.date.to_string(), "2026-08-13");
        assert_eq!(row.order_qty, 42);
        approx(row.sales_amount, 3100.5);
        assert_eq!(row.clicks, 350);
        approx(row.cpc, 0.62);

        assert_eq!(resp.detail_rows.len(), 1);
        let detail = &resp.detail_rows[0];
        assert_eq!(detail.sku, "B0-A-001");
        assert_eq!(detail.asin.as_deref(), Some("B0EXAMPLE1"));
        assert_eq!(detail.in_transit_qty, 24);

        assert_eq!(
            resp.available_dates.sales_report,
            vec!["2026-08-13".to_string()]
        );
        assert!(resp.available_dates.business_report.is_empty());

        let proj = resp.project_breakdown.get(&1).expect("缺少项目 1");
        assert_eq!(proj.project_name, "测试项目 A");
        assert_eq!(proj.summary_rows.len(), 1);
        assert!(proj.detail_rows.is_empty());
    }

    #[test]
    fn daily_analysis_all_countries_response_deserializes_sample_json() {
        // 后端 build_daily_analysis_all_countries 的真实响应形态（/api/v1/daily-analysis/all-countries）
        let json = r#"{
            "console": {
                "project_id": 1,
                "project_name": "测试项目 A",
                "country": "ALL",
                "start_date": "2026-08-07",
                "end_date": "2026-08-13",
                "requested_days": 7,
                "summary_days": 7,
                "detail_rows": 3,
                "sales_source_days": 7,
                "ad_source_days": 7,
                "inventory_source_days": 5,
                "business_source_days": 6,
                "missing_dates": ["2026-08-11"],
                "latest_sales_date": "2026-08-13",
                "latest_ad_date": "2026-08-13",
                "latest_inventory_date": "2026-08-12",
                "latest_business_date": "2026-08-13"
            },
            "summary_rows": [
                {
                    "date": "2026-08-13",
                    "order_qty": 21,
                    "sales_amount": 1860.0,
                    "impressions": 8100,
                    "clicks": 240,
                    "cpc": 0.51,
                    "ad_spend": 122.4,
                    "ad_orders": 4,
                    "available_qty": 90,
                    "page_views": 430,
                    "units_ordered": 15,
                    "sessions": 380,
                    "ordered_sales_amount": 1790.0,
                    "conversion_rate": 3.49
                }
            ],
            "detail_rows": [],
            "available_dates": {
                "sales_report": ["2026-08-13"],
                "ad_product_report": ["2026-08-13"],
                "inventory_report": [],
                "business_report": ["2026-08-13"]
            },
            "country_breakdown": {
                "US": {
                    "summary_rows": [],
                    "detail_rows": [],
                    "currency": "USD",
                    "source_currency": "USD"
                },
                "DE": {
                    "summary_rows": [],
                    "detail_rows": [],
                    "currency": "USD",
                    "source_currency": "EUR"
                },
                "UK": {
                    "summary_rows": [],
                    "detail_rows": [],
                    "currency": "USD",
                    "source_currency": "GBP"
                }
            },
            "currency": "USD",
            "currency_note": "金额字段已按当月 CNY 中转折算为 USD 统一展示；非金额字段（订单/曝光/点击/库存等）保持原值。"
        }"#;
        let resp: DailyAnalysisAllCountriesResponse =
            serde_json::from_str(json).expect("反序列化失败");

        assert_eq!(resp.console.project_id, 1);
        assert_eq!(resp.console.country, "ALL");
        assert_eq!(resp.console.requested_days, 7);
        assert_eq!(resp.console.missing_dates, vec!["2026-08-11".to_string()]);
        assert_eq!(
            resp.console.latest_inventory_date.as_deref(),
            Some("2026-08-12")
        );
        assert_eq!(resp.summary_rows.len(), 1);
        assert_eq!(resp.currency, "USD");
        assert!(resp.currency_note.is_some());

        let de = resp.country_breakdown.get("DE").expect("缺少 DE");
        assert_eq!(de.currency, "USD");
        assert_eq!(de.source_currency.as_deref(), Some("EUR"));
        let uk = resp.country_breakdown.get("UK").expect("缺少 UK");
        assert_eq!(uk.source_currency.as_deref(), Some("GBP"));
    }

    #[test]
    fn summary_row_tolerates_missing_defaulted_fields() {
        // 后端 Pydantic 默认值字段（page_views/units_ordered/sessions/ordered_sales_amount/
        // conversion_rate）在旧载荷或缺省时也要能反序列化
        let json = r#"{
            "date": "2026-08-13",
            "order_qty": 5,
            "sales_amount": 400.0,
            "impressions": 900,
            "clicks": 30,
            "cpc": 0.4,
            "ad_spend": 12.0,
            "ad_orders": 1,
            "available_qty": 40
        }"#;
        let row: DailyAnalysisRow = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(row.page_views, 0);
        assert_eq!(row.units_ordered, 0);
        assert_eq!(row.sessions, 0);
        approx(row.ordered_sales_amount, 0.0);
        approx(row.conversion_rate, 0.0);
    }

    #[test]
    fn kpi_summary_derives_correct_math() {
        let rows = vec![
            DailyAnalysisRow {
                date: NaiveDate::from_ymd_opt(2026, 8, 12).unwrap(),
                order_qty: 10,
                sales_amount: 1000.0,
                impressions: 2000,
                clicks: 100,
                cpc: 0.5,
                ad_spend: 50.0,
                ad_orders: 2,
                available_qty: 30,
                page_views: 500,
                units_ordered: 20,
                sessions: 400,
                ordered_sales_amount: 950.0,
                conversion_rate: 4.0,
            },
            DailyAnalysisRow {
                date: NaiveDate::from_ymd_opt(2026, 8, 13).unwrap(),
                order_qty: 30,
                sales_amount: 3000.0,
                impressions: 4000,
                clicks: 200,
                cpc: 0.6,
                ad_spend: 150.0,
                ad_orders: 6,
                available_qty: 60,
                page_views: 1000,
                units_ordered: 40,
                sessions: 800,
                ordered_sales_amount: 2800.0,
                conversion_rate: 4.0,
            },
        ];

        let kpi = KpiSummary::from_rows(&rows);
        approx(kpi.sales_amount, 4000.0);
        assert_eq!(kpi.order_qty, 40);
        approx(kpi.ad_spend, 200.0);
        // ACoS = 200 / 4000 × 100 = 5%
        approx(kpi.acos, 5.0);
        // 转化率 = 60 / 1500 × 100 = 4%
        approx(kpi.conversion_rate, 4.0);
        assert_eq!(kpi.gross_profit, None);

        // From<&[DailyAnalysisRow]> 等价入口
        let via_from: KpiSummary = rows.as_slice().into();
        assert_eq!(via_from, kpi);
    }

    #[test]
    fn kpi_summary_empty_rows_are_all_zero() {
        let kpi = KpiSummary::from_rows(&[]);
        approx(kpi.sales_amount, 0.0);
        assert_eq!(kpi.order_qty, 0);
        approx(kpi.ad_spend, 0.0);
        approx(kpi.acos, 0.0);
        approx(kpi.conversion_rate, 0.0);
        assert_eq!(kpi.gross_profit, None);
    }

    #[test]
    fn kpi_summary_acos_and_conversion_guard_division_by_zero() {
        // 无销售额 → ACoS = 0；无 page_views → 转化率 = 0
        let rows = vec![DailyAnalysisRow {
            date: NaiveDate::from_ymd_opt(2026, 8, 13).unwrap(),
            order_qty: 0,
            sales_amount: 0.0,
            impressions: 0,
            clicks: 0,
            cpc: 0.0,
            ad_spend: 100.0,
            ad_orders: 0,
            available_qty: 0,
            page_views: 0,
            units_ordered: 0,
            sessions: 0,
            ordered_sales_amount: 0.0,
            conversion_rate: 0.0,
        }];
        let kpi = KpiSummary::from_rows(&rows);
        approx(kpi.acos, 0.0);
        approx(kpi.conversion_rate, 0.0);
    }

    #[test]
    fn time_series_extracts_field_in_date_order() {
        let rows = vec![
            DailyAnalysisRow {
                date: NaiveDate::from_ymd_opt(2026, 8, 13).unwrap(),
                order_qty: 0,
                sales_amount: 300.0,
                impressions: 0,
                clicks: 0,
                cpc: 0.0,
                ad_spend: 0.0,
                ad_orders: 0,
                available_qty: 0,
                page_views: 0,
                units_ordered: 0,
                sessions: 0,
                ordered_sales_amount: 0.0,
                conversion_rate: 0.0,
            },
            DailyAnalysisRow {
                date: NaiveDate::from_ymd_opt(2026, 8, 12).unwrap(),
                order_qty: 0,
                sales_amount: 150.0,
                impressions: 0,
                clicks: 0,
                cpc: 0.0,
                ad_spend: 0.0,
                ad_orders: 0,
                available_qty: 0,
                page_views: 0,
                units_ordered: 0,
                sessions: 0,
                ordered_sales_amount: 0.0,
                conversion_rate: 0.0,
            },
        ];
        let series = DailyAnalysisRow::time_series(&rows, |r| r.sales_amount);
        assert_eq!(series.len(), 2);
        assert_eq!(series[0].date.to_string(), "2026-08-13");
        approx(series[0].value, 300.0);
        assert_eq!(series[1].date.to_string(), "2026-08-12");
        approx(series[1].value, 150.0);

        // 可序列化（缓存 / 日志场景）
        let json = serde_json::to_string(&series).unwrap();
        let back: Vec<TimeSeriesPoint> = serde_json::from_str(&json).unwrap();
        assert_eq!(back, series);
    }
}
