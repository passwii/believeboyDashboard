//! 报表中心 → 产品分析（P5-4，BLF-727）
//!
//! 对齐 backend `backend/app/schemas/product_analysis_source.py` 的
//! 「产品核算（从数据库读取，无文件上传）」契约（字段 snake_case 1:1；
//! 可选 / 带默认值字段一律 `#[serde(default)]` 容忍缺省）：
//! - `POST /api/v1/product-analysis/calculation/check`
//!   → [`ProductAnalysisCheckResponse`]（数据可用性：单日缺失 / 周期覆盖 /
//!   回款覆盖 / 按周可用性栅格）；
//! - `POST /api/v1/product-analysis/calculation/run`
//!   → [`ProductAnalysisRunResponse`]（执行核算：周期列表，每周期含
//!   中文键 `summary` 指标字典 + `details` SKU 明细字典列表）。
//!
//! 与 frontend `app/dashboard/reports/product-analysis/components/
//! product-analysis-panel.tsx`（「产品分析核算」tab）的 `DataAvailability` /
//! `CalculationRunResponse` 类型 1:1。
//!
//! `summary` / `details` 条目是后端按中文列名组织的指标字典
//! （如「总销售额」/「利润」/「利润率」/「ACOS」），键集合随核算口径可变，
//! 故用 [`serde_json::Value`] 承载、由视图层按需取数（对齐 web
//! `renderCell(period.summary['总销售额'])` / `DETAIL_DISPLAY_COLUMNS` 口径）。
//!
//! 范围取舍（BLF-727）：本期 GUI 只接「产品分析核算」tab（check + run，
//! 零上传）；手动核算 / 月度 SKU 分析两 tab 依赖文件上传 + 识别 + preview，
//! 拆为后续 issue（对齐 research_analysis 的导入端点取舍）。

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 请求体（backend `ProductAnalysisCheckRequest` / `ProductAnalysisRunRequest`）
// ---------------------------------------------------------------------------

/// check 请求体（对齐 `ProductAnalysisCheckRequest` L91）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProductAnalysisCheckBody {
    pub project_id: i64,
    pub country: String,
    pub start_date: NaiveDate,
    pub end_date: NaiveDate,
}

/// run 请求体（对齐 `ProductAnalysisRunRequest` L98；`current_only` web 端
/// 固定传 `true`——只算当前版本数据）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProductAnalysisRunBody {
    pub project_id: i64,
    pub country: String,
    pub start_date: NaiveDate,
    pub end_date: NaiveDate,
    /// web 端固定 `true`；缺省容忍（backend 默认同为 true）
    #[serde(default = "default_current_only")]
    pub current_only: bool,
}

/// `current_only` 反序列化缺省值（与 backend 默认一致）
fn default_current_only() -> bool {
    true
}

// ---------------------------------------------------------------------------
// check 响应（backend `ProductAnalysisCheckResponse` L153）
// ---------------------------------------------------------------------------

/// 周期覆盖条目（对齐 `PeriodCoverageInfoItem` L128；backend 字段为 str 日期）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PeriodCoverageInfoItem {
    pub period_start_date: String,
    pub period_end_date: String,
    #[serde(default)]
    pub source_id: i64,
    #[serde(default)]
    pub covered_dates: Vec<String>,
}

/// 回款周期重叠条目（对齐 `PaymentPeriodOverlapItem` L122）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaymentPeriodOverlapItem {
    pub period_start_date: NaiveDate,
    pub period_end_date: NaiveDate,
    #[serde(default)]
    pub source_id: i64,
}

/// 按周可用性条目（对齐 `WeeklyAvailabilityItem` L135）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeeklyAvailabilityItem {
    #[serde(default)]
    pub iso_year: i64,
    #[serde(default)]
    pub iso_week: i64,
    pub week_start_date: String,
    pub week_end_date: String,
    #[serde(default)]
    pub total_days: i64,
    #[serde(default)]
    pub business_report_available_days: i64,
    #[serde(default)]
    pub ad_report_available_days: i64,
    #[serde(default)]
    pub business_periodic_covered: bool,
    #[serde(default)]
    pub ad_periodic_covered: bool,
    #[serde(default)]
    pub payment_covered: bool,
    pub can_calculate: bool,
    pub is_partial: bool,
    #[serde(default)]
    pub business_missing_dates: Vec<String>,
    #[serde(default)]
    pub ad_missing_dates: Vec<String>,
    #[serde(default)]
    pub payment_objective_empty_dates: Vec<String>,
}

/// check 响应（对齐 `ProductAnalysisCheckResponse` L153）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProductAnalysisCheckResponse {
    /// 业务报告单日缺失日期列表
    pub business_report_missing: Vec<String>,
    /// 广告报告单日缺失日期列表
    pub ad_report_missing: Vec<String>,
    /// 库存报告单日缺失日期列表
    pub inventory_missing: Vec<String>,
    /// 业务报告周期覆盖（周期性数据兜底）
    #[serde(default)]
    pub business_period_info: Vec<PeriodCoverageInfoItem>,
    /// 广告报告周期覆盖
    #[serde(default)]
    pub ad_period_info: Vec<PeriodCoverageInfoItem>,
    /// 仅周期性覆盖（无单日数据）的业务报告日期
    #[serde(default)]
    pub business_periodic_only_missing: Vec<String>,
    /// 仅周期性覆盖的广告报告日期
    #[serde(default)]
    pub ad_periodic_only_missing: Vec<String>,
    /// 与区间重叠的回款周期
    #[serde(default)]
    pub payment_periods_overlapping: Vec<PaymentPeriodOverlapItem>,
    /// 回款是否覆盖全周期
    #[serde(default)]
    pub payment_full_period_covered: bool,
    /// 回款单日覆盖日期列表
    #[serde(default)]
    pub payment_daily_covered_dates: Vec<String>,
    /// 回款目标为空的日期
    #[serde(default)]
    pub payment_objective_empty_dates: Vec<String>,
    /// 是否满足最低核算数据要求（false → 无法执行核算）
    pub has_minimum_data: bool,
    /// 按周可用性栅格（可核算 / 部分缺失）
    #[serde(default)]
    pub weekly_availability: Vec<WeeklyAvailabilityItem>,
}

// ---------------------------------------------------------------------------
// run 响应（backend `ProductAnalysisRunResponse` L181）
// ---------------------------------------------------------------------------

/// 周期完整性（对齐 `PeriodCompleteness` L50）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PeriodCompleteness {
    #[serde(default)]
    pub total_days: i64,
    #[serde(default)]
    pub available_business_days: i64,
    #[serde(default)]
    pub available_ad_days: i64,
    #[serde(default)]
    pub business_missing_dates: Vec<String>,
    #[serde(default)]
    pub ad_missing_dates: Vec<String>,
    #[serde(default)]
    pub payment_covered: bool,
    /// backend 默认 `"none"`；缺省容忍
    #[serde(default)]
    pub payment_type: String,
    /// backend 默认 `true`；缺省按 backend 默认容忍
    #[serde(default = "default_payment_missing")]
    pub payment_missing: bool,
    #[serde(default)]
    pub payment_missing_dates: Vec<String>,
    #[serde(default)]
    pub payment_objective_empty: bool,
    #[serde(default)]
    pub payment_objective_empty_dates: Vec<String>,
}

/// `payment_missing` 反序列化缺省值（与 backend 默认一致）
fn default_payment_missing() -> bool {
    true
}

/// 核算周期条目（对齐 `CalculationPeriodItem` L169）
///
/// `summary` 为中文键指标字典（「总销售额」/「利润」/「利润率」/「ACOS」等）；
/// `details` 为 SKU 明细字典列表（「SKU」/「ASIN」/「总销量」/「广告花费」等）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CalculationPeriodItem {
    /// backend schema 为 str（`report_start_date: str`）
    pub report_start_date: String,
    pub report_end_date: String,
    /// 中文键周期汇总字典
    #[serde(default)]
    pub summary: serde_json::Value,
    /// 中文键 SKU 明细字典列表
    #[serde(default)]
    pub details: Vec<serde_json::Value>,
    #[serde(default)]
    pub is_partial: bool,
    #[serde(default)]
    pub completeness: Option<PeriodCompleteness>,
    /// 是否已写入 PT1（run + 持久化后为 true）
    #[serde(default)]
    pub persisted: bool,
    #[serde(default)]
    pub pt1_id: Option<i64>,
    #[serde(default)]
    pub version: Option<i64>,
}

/// run 响应（对齐 `ProductAnalysisRunResponse` L181）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProductAnalysisRunResponse {
    pub project_id: i64,
    #[serde(default)]
    pub project_name: String,
    #[serde(default)]
    pub country: String,
    #[serde(default)]
    pub total_periods: i64,
    #[serde(default)]
    pub periods: Vec<CalculationPeriodItem>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 反序列化契约：backend `/product-analysis/calculation/check` 真实响应形态
    #[test]
    fn check_response_deserializes_backend_shape() {
        let json = r#"{
            "business_report_missing": ["2026-08-03"],
            "ad_report_missing": [],
            "inventory_missing": ["2026-08-03", "2026-08-04"],
            "business_period_info": [
                {
                    "period_start_date": "2026-08-01",
                    "period_end_date": "2026-08-07",
                    "source_id": 55,
                    "covered_dates": ["2026-08-03", "2026-08-04"]
                }
            ],
            "ad_period_info": [],
            "business_periodic_only_missing": ["2026-08-04"],
            "ad_periodic_only_missing": [],
            "payment_periods_overlapping": [
                {
                    "period_start_date": "2026-07-27",
                    "period_end_date": "2026-08-09",
                    "source_id": 77
                }
            ],
            "payment_full_period_covered": true,
            "payment_daily_covered_dates": ["2026-08-03", "2026-08-04"],
            "payment_objective_empty_dates": [],
            "has_minimum_data": true,
            "weekly_availability": [
                {
                    "iso_year": 2026,
                    "iso_week": 32,
                    "week_start_date": "2026-08-03",
                    "week_end_date": "2026-08-09",
                    "total_days": 7,
                    "business_report_available_days": 6,
                    "ad_report_available_days": 7,
                    "business_periodic_covered": false,
                    "ad_periodic_covered": false,
                    "payment_covered": true,
                    "can_calculate": true,
                    "is_partial": true,
                    "business_missing_dates": ["2026-08-03"],
                    "ad_missing_dates": [],
                    "payment_objective_empty_dates": []
                }
            ]
        }"#;
        let resp: ProductAnalysisCheckResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.business_report_missing, vec!["2026-08-03".to_string()]);
        assert!(resp.ad_report_missing.is_empty());
        assert_eq!(resp.inventory_missing.len(), 2);
        assert_eq!(resp.business_period_info.len(), 1);
        assert_eq!(resp.business_period_info[0].source_id, 55);
        assert_eq!(resp.business_period_info[0].covered_dates.len(), 2);
        assert_eq!(
            resp.payment_periods_overlapping[0].period_start_date,
            NaiveDate::from_ymd_opt(2026, 7, 27).expect("合法日期")
        );
        assert!(resp.payment_full_period_covered);
        assert!(resp.has_minimum_data);
        let week = &resp.weekly_availability[0];
        assert_eq!(week.iso_week, 32);
        assert_eq!(week.business_report_available_days, 6);
        assert!(week.can_calculate);
        assert!(week.is_partial);

        // 缺省字段（周期信息 / 按周栅格）容忍反序列化
        let minimal = r#"{
            "business_report_missing": [],
            "ad_report_missing": [],
            "inventory_missing": [],
            "payment_periods_overlapping": [],
            "payment_full_period_covered": false,
            "payment_daily_covered_dates": [],
            "has_minimum_data": false
        }"#;
        let resp: ProductAnalysisCheckResponse =
            serde_json::from_str(minimal).expect("反序列化失败");
        assert!(!resp.has_minimum_data);
        assert!(resp.weekly_availability.is_empty());
        assert!(resp.business_period_info.is_empty());
    }

    /// 反序列化契约：backend `/product-analysis/calculation/run` 真实响应形态
    /// （中文键 summary + details；persisted / completeness 元信息）
    #[test]
    fn run_response_deserializes_backend_shape() {
        let json = r#"{
            "project_id": 3,
            "project_name": "测试项目 A",
            "country": "US",
            "total_periods": 2,
            "periods": [
                {
                    "report_start_date": "2026-08-03",
                    "report_end_date": "2026-08-09",
                    "summary": {
                        "总销售额": 15320.5,
                        "总销量": 421,
                        "利润": 3064.1,
                        "利润率": 0.2,
                        "ACOS": 0.137,
                        "广告花费": 2100.25
                    },
                    "details": [
                        {
                            "SKU": "SKU-A",
                            "ASIN": "B0TEST123",
                            "总销量": 120,
                            "总销售额": 4560.0,
                            "广告花费": 620.5,
                            "广告销售额": 2280.0,
                            "ACOS": 0.272,
                            "利润": 912.0,
                            "利润率": 0.2
                        }
                    ],
                    "is_partial": true,
                    "completeness": {
                        "total_days": 7,
                        "available_business_days": 6,
                        "available_ad_days": 7,
                        "business_missing_dates": ["2026-08-03"],
                        "ad_missing_dates": [],
                        "payment_covered": true,
                        "payment_type": "daily",
                        "payment_missing": false,
                        "payment_missing_dates": [],
                        "payment_objective_empty": false,
                        "payment_objective_empty_dates": []
                    },
                    "persisted": true,
                    "pt1_id": 101,
                    "version": 2
                },
                {
                    "report_start_date": "2026-07-27",
                    "report_end_date": "2026-08-02",
                    "summary": {},
                    "details": []
                }
            ]
        }"#;
        let resp: ProductAnalysisRunResponse = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(resp.project_id, 3);
        assert_eq!(resp.total_periods, 2);
        assert_eq!(resp.periods.len(), 2);
        let period = &resp.periods[0];
        assert_eq!(
            period.summary.get("总销售额").and_then(|v| v.as_f64()),
            Some(15320.5)
        );
        assert_eq!(period.details.len(), 1);
        assert_eq!(
            period.details[0].get("SKU").and_then(|v| v.as_str()),
            Some("SKU-A")
        );
        assert!(period.is_partial);
        let completeness = period.completeness.as_ref().expect("completeness 存在");
        assert_eq!(completeness.available_business_days, 6);
        assert!(!completeness.payment_missing);
        assert!(period.persisted);
        assert_eq!(period.pt1_id, Some(101));
        // 缺省字段（is_partial / completeness / persisted / pt1_id）容忍反序列化
        let second = &resp.periods[1];
        assert!(!second.is_partial);
        assert_eq!(second.completeness, None);
        assert!(!second.persisted);
        assert_eq!(second.pt1_id, None);
        assert_eq!(second.version, None);
    }

    /// 请求体序列化契约：字段名与 backend 请求模型 1:1
    #[test]
    fn request_bodies_serialize_to_backend_shape() {
        let check = ProductAnalysisCheckBody {
            project_id: 3,
            country: "US".into(),
            start_date: NaiveDate::from_ymd_opt(2026, 8, 3).expect("合法日期"),
            end_date: NaiveDate::from_ymd_opt(2026, 8, 9).expect("合法日期"),
        };
        assert_eq!(
            serde_json::to_value(&check).expect("序列化失败"),
            serde_json::json!({
                "project_id": 3,
                "country": "US",
                "start_date": "2026-08-03",
                "end_date": "2026-08-09"
            })
        );

        let run = ProductAnalysisRunBody {
            project_id: 3,
            country: "DE".into(),
            start_date: NaiveDate::from_ymd_opt(2026, 8, 3).expect("合法日期"),
            end_date: NaiveDate::from_ymd_opt(2026, 8, 9).expect("合法日期"),
            current_only: true,
        };
        assert_eq!(
            serde_json::to_value(&run).expect("序列化失败"),
            serde_json::json!({
                "project_id": 3,
                "country": "DE",
                "start_date": "2026-08-03",
                "end_date": "2026-08-09",
                "current_only": true
            })
        );

        // current_only 缺省 → backend 默认 true
        let run_minimal: ProductAnalysisRunBody = serde_json::from_str(
            r#"{"project_id": 3, "country": "US", "start_date": "2026-08-03", "end_date": "2026-08-09"}"#,
        )
        .expect("反序列化失败");
        assert!(run_minimal.current_only);
    }
}
