//! 报表中心领域类型（P3-4，BLF-704）
//!
//! 财务月报数据源：FastAPI `/api/v1/monthly-reports/financial-series`。
//! 字段对齐 frontend `app/dashboard/reports/monthly-report/display/display-client.tsx`
//! 的 `FinancialSeriesResponse` / `FinancialSeriesRow` / `FinancialTrendPoint`，
//! 再逐一对照后端 `backend/app/schemas/monthly_report.py` 的 Pydantic 模型。

use serde::{Deserialize, Serialize};

/// 月度财务序列行（backend `MonthlyFinancialSeriesRow` 1:1）
///
/// 后端对 `income_vat_total` / `income_sales_with_tax` / `expense_vat_total` /
/// `credit_card_deduction_usd` / `fob_cost_rmb` / `first_leg_cost_rmb` 有默认值，
/// 反序列化时同样容忍缺省（存量报表 / 字段缺失场景）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FinancialSeriesRow {
    pub report_month: String,
    pub income_sales: f64,
    pub income_refund: f64,
    pub income_adjustment: f64,
    pub income_other: f64,
    pub expense_selling_fee: f64,
    pub expense_fba_fee: f64,
    pub expense_inventory_fee: f64,
    pub expense_service_fee: f64,
    pub expense_advertising: f64,
    pub expense_other_fees: f64,
    pub income_total: f64,
    pub expense_total: f64,
    pub amazon_pay_back: f64,
    #[serde(default)]
    pub income_vat_total: f64,
    #[serde(default)]
    pub income_sales_with_tax: f64,
    #[serde(default)]
    pub expense_vat_total: f64,
    #[serde(default)]
    pub credit_card_deduction_usd: f64,
    #[serde(default)]
    pub fob_cost_rmb: f64,
    #[serde(default)]
    pub first_leg_cost_rmb: f64,
    pub has_source_report: bool,
}

/// 月度趋势点（backend `MonthlyFinancialTrendPoint` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FinancialTrendPoint {
    pub report_month: String,
    pub income_total: f64,
    pub expense_total: f64,
    pub amazon_pay_back: f64,
    pub net_amount: f64,
    #[serde(default)]
    pub vat_total: f64,
    pub has_source_report: bool,
}

/// 月度趋势汇总（backend `MonthlyFinancialTrend` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FinancialTrend {
    pub income_total_sum: f64,
    pub expense_total_sum: f64,
    pub amazon_pay_back_sum: f64,
    pub net_amount_sum: f64,
    pub points: Vec<FinancialTrendPoint>,
}

/// 财务序列响应（backend `MonthlyFinancialSeriesResponse` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FinancialSeriesResponse {
    pub project_id: i64,
    pub project_name: String,
    pub start_month: String,
    pub end_month: String,
    pub rows: Vec<FinancialSeriesRow>,
    pub trend: FinancialTrend,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// backend `/monthly-reports/financial-series` 的真实响应形态（financial-series 口径）
    #[test]
    fn financial_series_response_deserializes_backend_sample() {
        let json = r#"{
            "project_id": 3,
            "project_name": "测试项目 A",
            "start_month": "2025-08",
            "end_month": "2026-07",
            "rows": [
                {
                    "report_month": "2025-08",
                    "income_sales": 12000.5,
                    "income_refund": 120.0,
                    "income_adjustment": 30.0,
                    "income_other": 45.0,
                    "expense_selling_fee": 1800.0,
                    "expense_fba_fee": 2400.0,
                    "expense_inventory_fee": 300.0,
                    "expense_service_fee": 90.0,
                    "expense_advertising": 600.0,
                    "expense_other_fees": 20.0,
                    "income_total": 12195.5,
                    "expense_total": -5210.0,
                    "amazon_pay_back": 6500.0,
                    "credit_card_deduction_usd": 120.0,
                    "fob_cost_rmb": 30000.0,
                    "first_leg_cost_rmb": 5000.0,
                    "has_source_report": true
                }
            ],
            "trend": {
                "income_total_sum": 12195.5,
                "expense_total_sum": -5210.0,
                "amazon_pay_back_sum": 6500.0,
                "net_amount_sum": 6985.5,
                "points": [
                    {
                        "report_month": "2025-08",
                        "income_total": 12195.5,
                        "expense_total": -5210.0,
                        "amazon_pay_back": 6500.0,
                        "net_amount": 6985.5,
                        "has_source_report": true
                    }
                ]
            }
        }"#;
        let resp: FinancialSeriesResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.project_id, 3);
        assert_eq!(resp.project_name, "测试项目 A");
        assert_eq!(resp.rows.len(), 1);
        assert_eq!(resp.rows[0].report_month, "2025-08");
        assert_eq!(resp.rows[0].income_sales, 12000.5);
        // 缺省字段（income_sales_with_tax 等）容忍反序列化
        assert_eq!(resp.rows[0].income_sales_with_tax, 0.0);
        assert_eq!(resp.rows[0].income_vat_total, 0.0);
        assert!(resp.rows[0].has_source_report);
        assert_eq!(resp.trend.points.len(), 1);
        assert_eq!(resp.trend.points[0].vat_total, 0.0);
        assert_eq!(resp.trend.net_amount_sum, 6985.5);
    }
}
