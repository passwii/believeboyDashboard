//! 退货分析（P5-1，BLF-715）
//!
//! frontend `app/dashboard/operations/return-analysis` 的 GPUI 数据层：
//! `GET /api/v1/return-analysis`（backend `app/api/v1/endpoints/return_analysis.py`
//! 双段式：Redis v2 缓存 → snapshot 物化表 → 现场聚合 fallback）。
//!
//! 字段命名沿用后端 Pydantic 模型（snake_case）1:1；列表字段全部 `#[serde(default)]`
//! 容忍缺省，`Option` 字段容忍 null。`reason_display` / `disposition_display` /
//! `status_display` / `weekday_display` 已由后端翻译为中文，本模块不做二次翻译；
//! 仅 `summary.top_return_reason`（原始码）需要 [`translate_reason`] 翻译展示。
//!
//! 站点选项（对齐 frontend `CountryOption = 'US' | 'DE' | 'UK'`）；
//! 日期区间为闭区间 `[start_date, end_date]`（YYYY-MM-DD），由视图提供。

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 高退货排行
// ---------------------------------------------------------------------------

/// 高退货排行项（backend `ReturnRankingItem` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReturnRankingItem {
    pub sku: String,
    #[serde(default)]
    pub asin: Option<String>,
    #[serde(default)]
    pub product_name: Option<String>,
    /// 退货总数量
    pub total_quantity: i64,
    /// 退货单数
    pub return_count: i64,
    /// 同周期销售数量
    #[serde(default)]
    pub sales_quantity: i64,
    /// 退货率（退货数量/销售数量），百分比
    #[serde(default)]
    pub return_rate: f64,
    /// 平均退货周期（天）= 退货日期 - 原单日期，按 (order_id, sku) 精准匹配
    #[serde(default)]
    pub avg_return_cycle_days: Option<f64>,
    /// 最快退货周期（天）
    #[serde(default)]
    pub min_return_cycle_days: Option<i64>,
    /// 最慢退货周期（天）
    #[serde(default)]
    pub max_return_cycle_days: Option<i64>,
}

// ---------------------------------------------------------------------------
// 退货原因
// ---------------------------------------------------------------------------

/// 退货原因分析项（backend `ReturnReasonItem` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReturnReasonItem {
    pub reason: String,
    /// 后端已翻译的中文显示
    pub reason_display: String,
    pub total_quantity: i64,
    pub return_count: i64,
    pub percentage: f64,
}

// ---------------------------------------------------------------------------
// 退货趋势
// ---------------------------------------------------------------------------

/// 退货时间趋势项（backend `ReturnTrendItem` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReturnTrendItem {
    /// `YYYY-MM-DD`
    pub date: String,
    pub total_quantity: i64,
    pub return_count: i64,
    /// 同日销售数量
    #[serde(default)]
    pub sales_quantity: i64,
    /// 同日销售金额
    #[serde(default)]
    pub sales_amount: f64,
    /// 退货率（退货数量/销售数量），百分比
    #[serde(default)]
    pub return_rate: f64,
}

// ---------------------------------------------------------------------------
// 商品状态 / 库存状态
// ---------------------------------------------------------------------------

/// 商品状态项（backend `DispositionItem` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DispositionItem {
    pub detailed_disposition: String,
    /// 后端已翻译的中文显示
    pub disposition_display: String,
    pub total_quantity: i64,
    pub return_count: i64,
    pub percentage: f64,
}

/// 库存状态项（backend `StatusItem` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatusItem {
    pub status: String,
    /// 后端已翻译的中文显示
    pub status_display: String,
    pub total_quantity: i64,
    pub return_count: i64,
    pub percentage: f64,
}

// ---------------------------------------------------------------------------
// 星期分布 / 仓库分布
// ---------------------------------------------------------------------------

/// 星期分布项（backend `WeekdayItem` 1:1；weekday 0=Monday, 6=Sunday）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeekdayItem {
    pub weekday: i64,
    /// 后端已翻译的中文星期名
    pub weekday_display: String,
    pub return_count: i64,
    pub percentage: f64,
}

/// 仓库分布项（backend `FulfillmentCenterItem` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FulfillmentCenterItem {
    pub fulfillment_center_id: String,
    /// 退货单数
    pub return_count: i64,
    /// 退货件数
    pub quantity: i64,
    pub percentage: f64,
}

// ---------------------------------------------------------------------------
// 顾客反馈
// ---------------------------------------------------------------------------

/// 顾客反馈项（backend `CustomerFeedbackItem` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CustomerFeedbackItem {
    pub sku: String,
    pub order_id: String,
    pub reason: String,
    /// 后端已翻译的中文显示
    pub reason_display: String,
    pub customer_comment: String,
    /// `YYYY-MM-DD`
    pub return_date: String,
}

// ---------------------------------------------------------------------------
// 汇总与响应
// ---------------------------------------------------------------------------

/// 退货分析汇总（backend `ReturnAnalysisSummary` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReturnAnalysisSummary {
    /// 退货单数
    pub total_returns: i64,
    /// 退货总量
    pub total_quantity: i64,
    /// 涉及 SKU 数
    pub unique_skus: i64,
    #[serde(default)]
    pub top_return_sku: Option<String>,
    /// 原始退货原因码（展示需经 [`translate_reason`]）
    #[serde(default)]
    pub top_return_reason: Option<String>,
    /// 同期销售数量
    #[serde(default)]
    pub total_sales_quantity: i64,
    /// 同期销售金额
    #[serde(default)]
    pub total_sales_amount: f64,
    /// 整体退货率（退货量/销售量），百分比
    #[serde(default)]
    pub overall_return_rate: f64,
}

/// 退货分析响应（backend `ReturnAnalysisResponse` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReturnAnalysisResponse {
    pub project_id: i64,
    pub project_name: String,
    pub country: String,
    pub start_date: String,
    pub end_date: String,
    pub summary: ReturnAnalysisSummary,
    /// 模板化文字总结（多行；emoji 前缀行为小节标题）
    #[serde(default)]
    pub summary_text: String,
    #[serde(default)]
    pub ranking_rows: Vec<ReturnRankingItem>,
    #[serde(default)]
    pub reason_rows: Vec<ReturnReasonItem>,
    #[serde(default)]
    pub trend_rows: Vec<ReturnTrendItem>,
    #[serde(default)]
    pub disposition_rows: Vec<DispositionItem>,
    #[serde(default)]
    pub status_rows: Vec<StatusItem>,
    #[serde(default)]
    pub feedback_rows: Vec<CustomerFeedbackItem>,
    /// 星期分布
    #[serde(default)]
    pub weekday_rows: Vec<WeekdayItem>,
    /// 仓库分布
    #[serde(default)]
    pub fulfillment_center_rows: Vec<FulfillmentCenterItem>,
    /// 多件退货单数
    #[serde(default)]
    pub multi_item_return_count: i64,
    /// 多件退货涉及总量
    #[serde(default)]
    pub multi_item_return_quantity: i64,
}

// ---------------------------------------------------------------------------
// 站点选项 / 翻译辅助
// ---------------------------------------------------------------------------

/// 站点选项（对齐 frontend `CountryOption = 'US' | 'DE' | 'UK'` 与
/// `COUNTRY_TIMEZONE_MAP` 的站点集合；默认 US）
pub const COUNTRY_OPTIONS: [(&str, &str); 3] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
];

/// 默认站点（对齐 frontend `useUrlParam('country', 'US')`）
pub const DEFAULT_COUNTRY: &str = "US";

/// 站点展示名（未知值原样返回）
pub fn return_country_label(country: &str) -> String {
    COUNTRY_OPTIONS
        .iter()
        .find(|(value, _)| *value == country)
        .map_or_else(|| country.to_string(), |(_, label)| label.to_string())
}

/// 退货原因码 → 中文（对齐 frontend `RETURN_REASON_LABELS`；backend
/// `summary.top_return_reason` 返回原始码，需本表翻译；rows 内的
/// `reason_display` 已由后端翻译，不经过本表）
pub const RETURN_REASON_LABELS: [(&str, &str); 14] = [
    ("APPAREL_TOO_LARGE", "服装过大"),
    ("APPAREL_TOO_SMALL", "服装过小"),
    ("QUALITY_UNACCEPTABLE", "质量不合格"),
    ("DID_NOT_LIKE_FABRIC", "不喜欢面料"),
    ("NOT_AS_DESCRIBED", "与描述不符"),
    ("APPAREL_STYLE", "款式问题"),
    ("DEFECTIVE", "有缺陷"),
    ("UNDELIVERABLE_UNKNOWN", "无法投递"),
    ("NEVER_ARRIVED", "未收到"),
    ("UNWANTED_ITEM", "不需要"),
    ("CHANGED_MIND", "改变主意"),
    ("WRONG_ITEM", "错发商品"),
    ("LATE_ARRIVAL", "到货延迟"),
    ("OTHER", "其他"),
];

/// 退货原因码翻译（未知码原样返回；对齐 frontend `translateReason`）
pub fn translate_reason(value: &str) -> String {
    RETURN_REASON_LABELS
        .iter()
        .find(|(code, _)| *code == value)
        .map_or_else(|| value.to_string(), |(_, label)| label.to_string())
}

/// 整体退货率阈值配色（对齐 frontend：>8 红 / >3 黄 / 其余绿）——
/// 返回语义标记，视图层按主题映射具体颜色。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReturnRateLevel {
    /// 偏高（> 8%）
    High,
    /// 关注（3% ~ 8%）
    Medium,
    /// 正常（≤ 3%）
    Low,
}

/// 按退货率阈值分级（对齐 frontend 页面 8 / 3 两个档位）
pub fn return_rate_level(rate: f64) -> ReturnRateLevel {
    if rate > 8.0 {
        ReturnRateLevel::High
    } else if rate > 3.0 {
        ReturnRateLevel::Medium
    } else {
        ReturnRateLevel::Low
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 契约：退货原因码翻译表与 frontend `RETURN_REASON_LABELS` 一致
    #[test]
    fn reason_labels_match_frontend_translation() {
        assert_eq!(translate_reason("QUALITY_UNACCEPTABLE"), "质量不合格");
        assert_eq!(translate_reason("NOT_AS_DESCRIBED"), "与描述不符");
        assert_eq!(translate_reason("LATE_ARRIVAL"), "到货延迟");
        assert_eq!(translate_reason("OTHER"), "其他");
        // 未知码原样返回
        assert_eq!(translate_reason("UNKNOWN_CODE"), "UNKNOWN_CODE");
    }

    /// 契约：站点选项与 frontend `CountryOption` 一致
    #[test]
    fn country_options_match_frontend() {
        assert_eq!(COUNTRY_OPTIONS.len(), 3);
        assert_eq!(DEFAULT_COUNTRY, "US");
        assert_eq!(return_country_label("US"), "美国站 (US)");
        assert_eq!(return_country_label("DE"), "德国站 (DE)");
        assert_eq!(return_country_label("UK"), "英国站 (UK)");
        assert_eq!(return_country_label("FR"), "FR");
    }

    /// 契约：退货率阈值分级与 frontend 8 / 3 档位一致
    #[test]
    fn return_rate_level_thresholds_match_frontend() {
        assert_eq!(return_rate_level(0.0), ReturnRateLevel::Low);
        assert_eq!(return_rate_level(3.0), ReturnRateLevel::Low);
        assert_eq!(return_rate_level(3.1), ReturnRateLevel::Medium);
        assert_eq!(return_rate_level(8.0), ReturnRateLevel::Medium);
        assert_eq!(return_rate_level(8.1), ReturnRateLevel::High);
    }

    /// 契约：响应反序列化容忍缺省列表与 null 字段（对齐后端 Pydantic 默认值）
    #[test]
    fn response_deserializes_with_missing_lists_and_nulls() {
        let json = r#"{
            "project_id": 1,
            "project_name": "测试项目",
            "country": "US",
            "start_date": "2026-08-07",
            "end_date": "2026-08-13",
            "summary": {
                "total_returns": 10,
                "total_quantity": 12,
                "unique_skus": 3,
                "top_return_sku": null,
                "top_return_reason": "OTHER"
            }
        }"#;
        let resp: ReturnAnalysisResponse = serde_json::from_str(json).expect("应可反序列化");
        assert_eq!(resp.project_id, 1);
        assert_eq!(resp.country, "US");
        assert_eq!(resp.summary.total_returns, 10);
        assert_eq!(resp.summary.overall_return_rate, 0.0);
        assert_eq!(resp.summary.top_return_sku, None);
        assert!(resp.ranking_rows.is_empty());
        assert!(resp.reason_rows.is_empty());
        assert!(resp.summary_text.is_empty());
        assert_eq!(resp.multi_item_return_count, 0);
    }

    /// 契约：完整响应解析（与 backend 实际返回字段一致）
    #[test]
    fn full_response_parses() {
        let json = r#"{
            "project_id": 2,
            "project_name": "项目 B",
            "country": "DE",
            "start_date": "2026-08-01",
            "end_date": "2026-08-13",
            "summary": {
                "total_returns": 5,
                "total_quantity": 6,
                "unique_skus": 2,
                "top_return_sku": "SKU-1",
                "top_return_reason": "QUALITY_UNACCEPTABLE",
                "total_sales_quantity": 100,
                "total_sales_amount": 2000.0,
                "overall_return_rate": 6.0
            },
            "summary_text": "📊 总览\n退货单数 5。\n⚠️ 关注质量问题。",
            "ranking_rows": [
                {
                    "sku": "SKU-1",
                    "asin": "B0001",
                    "product_name": "产品一",
                    "total_quantity": 4,
                    "return_count": 3,
                    "sales_quantity": 40,
                    "return_rate": 10.0,
                    "avg_return_cycle_days": 5.5,
                    "min_return_cycle_days": 2,
                    "max_return_cycle_days": 9
                }
            ],
            "reason_rows": [
                {
                    "reason": "QUALITY_UNACCEPTABLE",
                    "reason_display": "质量不合格",
                    "total_quantity": 6,
                    "return_count": 5,
                    "percentage": 83.33
                }
            ],
            "trend_rows": [
                {
                    "date": "2026-08-07",
                    "total_quantity": 2,
                    "return_count": 1,
                    "sales_quantity": 20,
                    "sales_amount": 400.0,
                    "return_rate": 5.0
                }
            ],
            "disposition_rows": [],
            "status_rows": [],
            "feedback_rows": [],
            "weekday_rows": [
                {
                    "weekday": 0,
                    "weekday_display": "周一",
                    "return_count": 2,
                    "percentage": 40.0
                }
            ],
            "fulfillment_center_rows": [
                {
                    "fulfillment_center_id": "FC-1",
                    "return_count": 5,
                    "quantity": 6,
                    "percentage": 100.0
                }
            ],
            "multi_item_return_count": 1,
            "multi_item_return_quantity": 2
        }"#;
        let resp: ReturnAnalysisResponse = serde_json::from_str(json).expect("应可反序列化");
        assert_eq!(resp.summary.overall_return_rate, 6.0);
        assert_eq!(resp.ranking_rows.len(), 1);
        assert_eq!(resp.ranking_rows[0].avg_return_cycle_days, Some(5.5));
        assert_eq!(resp.ranking_rows[0].min_return_cycle_days, Some(2));
        assert_eq!(resp.reason_rows[0].reason_display, "质量不合格");
        assert_eq!(resp.trend_rows[0].sales_amount, 400.0);
        assert_eq!(resp.weekday_rows[0].weekday_display, "周一");
        assert_eq!(resp.fulfillment_center_rows[0].percentage, 100.0);
        assert_eq!(resp.multi_item_return_quantity, 2);
        assert!(resp.summary_text.contains("总览"));
    }
}
