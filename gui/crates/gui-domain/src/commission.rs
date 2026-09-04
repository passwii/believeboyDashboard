//! 财务资金 → 佣金管理领域类型（P5-5，BLF-734）
//!
//! 字段对齐 backend `backend/app/schemas/system_management/commission/project_months.py`
//! 与 `summary.py`，与 web 端 `frontend/app/dashboard/finance/commission-management/`
//! （`types.ts` / `utils.ts`）的类型声明同口径。
//!
//! 口径说明：
//! - 后端金额 / 比例字段均为 `float`（非 Decimal 字符串，与 VAT 发票不同），
//!   GUI 直接用 `f64` 承载；
//! - `payment_status` 后端为枚举 `CommissionProjectPaymentStatus`，JSON 序列化为
//!   字符串（`paid / partial / unpaid`），GUI 用 `String` 承载 + 标签辅助；
//! - `months` 后端为 `dict[str, MonthItem]`（键 = `YYYY-MM`），GUI 用
//!   `BTreeMap` 承载（键序稳定，渲染 1-12 月矩阵时按月键取值）；
//! - 站点固定三值 `US / DE / UK`（web `SITE_ORDER`），货币映射
//!   US→USD / DE→EUR / UK→GBP。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// 回款状态：已回款
pub const PAYMENT_STATUS_PAID: &str = "paid";
/// 回款状态：部分回款
pub const PAYMENT_STATUS_PARTIAL: &str = "partial";
/// 回款状态：未回款
pub const PAYMENT_STATUS_UNPAID: &str = "unpaid";

/// 回款状态选项（value, label；对齐 web 回款状态下拉）
pub const PAYMENT_STATUS_OPTIONS: [(&str, &str); 3] = [
    (PAYMENT_STATUS_PAID, "已回款"),
    (PAYMENT_STATUS_PARTIAL, "部分回款"),
    (PAYMENT_STATUS_UNPAID, "未回款"),
];

/// 回款状态中文标签（未知状态回退「未知」）
pub fn payment_status_label(status: &str) -> &'static str {
    match status {
        PAYMENT_STATUS_PAID => "已回款",
        PAYMENT_STATUS_PARTIAL => "部分回款",
        PAYMENT_STATUS_UNPAID => "未回款",
        _ => "未知",
    }
}

/// 站点顺序（对齐 web `SITE_ORDER`；排序与筛选下拉共用）
pub const SITE_ORDER: [&str; 3] = ["US", "DE", "UK"];

/// 站点 → 货币代码（对齐 web `COUNTRY_TO_CURRENCY`；未知站点回退空串）
pub fn site_currency(country: &str) -> &'static str {
    match country.trim().to_ascii_uppercase().as_str() {
        "US" => "USD",
        "DE" => "EUR",
        "UK" => "GBP",
        _ => "",
    }
}

/// 站点 → 货币符号（对齐 web `formatIncomeWithCurrency` 的 symbol 映射）
pub fn site_currency_symbol(country: &str) -> &'static str {
    match country.trim().to_ascii_uppercase().as_str() {
        "US" => "$",
        "DE" => "€",
        "UK" => "£",
        _ => "",
    }
}

/// 比例 → 百分比文本（对齐 web `formatPercent`：`(value * 100).toFixed(2)%`）
pub fn format_percent(value: f64) -> String {
    format!("{:.2}%", value * 100.0)
}

/// 回款率分档（对齐 web `getReceiveRateColor`；浮点容差 1e-9）
///
/// ≥100% 绿（Positive）/ ≥50% 橙（Warning）/ ≥20% 黄（Yellow）/ <20% 红（Negative）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiveRateLevel {
    /// ≥ 100%
    Positive,
    /// 50% ~ 100%
    Warning,
    /// 20% ~ 50%
    Yellow,
    /// < 20%
    Negative,
}

/// 浮点比较容差（避免 0.999999… 误判为 Warning）
const RATE_EPSILON: f64 = 1e-9;

/// 回款率 → 分档（web 同款阈值 + 容差）
pub fn receive_rate_level(rate: f64) -> ReceiveRateLevel {
    if rate >= 1.0 - RATE_EPSILON {
        ReceiveRateLevel::Positive
    } else if rate >= 0.5 - RATE_EPSILON {
        ReceiveRateLevel::Warning
    } else if rate >= 0.2 - RATE_EPSILON {
        ReceiveRateLevel::Yellow
    } else {
        ReceiveRateLevel::Negative
    }
}

/// 佣金比例标签（对齐 web `getCommissionRatioLabel`）
///
/// 项目元数据 `commission_basis == "cash_received"` → 阶梯文案；
/// 元数据带有限 `commission_rate` → 按元数据比例；否则回退行自带比例。
pub fn commission_ratio_label(
    record_rate: f64,
    commission_basis: Option<&str>,
    commission_rate: Option<f64>,
) -> String {
    if commission_basis.map(str::trim) == Some("cash_received") {
        return "阶梯(7/10/13/15%)".to_string();
    }
    match commission_rate {
        Some(rate) if rate.is_finite() => format_percent(rate),
        _ => format_percent(record_rate),
    }
}

/// 项目月度佣金行（backend `CommissionProjectMonthItem` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommissionProjectMonthItem {
    pub id: i64,
    pub report_month: String,
    #[serde(default = "default_country")]
    pub country: String,
    pub project_id: i64,
    pub project_name: String,
    #[serde(default)]
    pub income_total_usd: f64,
    #[serde(default)]
    pub factory_commission_rate: f64,
    #[serde(default)]
    pub usd_to_rmb_rate: f64,
    #[serde(default)]
    pub factory_commission_usd: f64,
    #[serde(default)]
    pub factory_commission_rmb: f64,
    #[serde(default = "default_payment_status")]
    pub payment_status: String,
    #[serde(default)]
    pub received_rmb: f64,
    #[serde(default)]
    pub payment_confirmed_at: Option<String>,
    #[serde(default)]
    pub payment_confirmed_by: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub computed_at: String,
    #[serde(default)]
    pub updated_at: String,
}

fn default_country() -> String {
    "US".to_string()
}

fn default_payment_status() -> String {
    PAYMENT_STATUS_UNPAID.to_string()
}

/// `GET /project-months` 响应（backend `CommissionProjectMonthsResponse`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommissionProjectMonthsResponse {
    pub report_month: String,
    #[serde(default)]
    pub items: Vec<CommissionProjectMonthItem>,
}

/// 年-月汇总行（backend `CommissionYearlyMonthlySummaryItem` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommissionYearlyMonthlySummaryItem {
    pub report_month: String,
    #[serde(default)]
    pub income_total_usd: f64,
    #[serde(default)]
    pub factory_commission_usd: f64,
    #[serde(default)]
    pub factory_commission_rmb: f64,
    #[serde(default)]
    pub received_rmb: f64,
    #[serde(default)]
    pub receive_rate: f64,
}

/// `GET /summary/monthly` 响应（backend `CommissionYearlyMonthlySummaryResponse`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommissionYearlyMonthlySummaryResponse {
    pub year: String,
    #[serde(default)]
    pub items: Vec<CommissionYearlyMonthlySummaryItem>,
}

/// 项目年度汇总的单月格（backend `CommissionProjectMonthlySummaryMonthItem` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommissionProjectMonthlySummaryMonthItem {
    pub report_month: String,
    #[serde(default)]
    pub income_total_usd: f64,
    #[serde(default)]
    pub factory_commission_rmb: f64,
    #[serde(default)]
    pub received_rmb: f64,
    #[serde(default)]
    pub receive_rate: f64,
}

/// 项目年度汇总行（backend `CommissionProjectYearlySummaryItem` 1:1；
/// `months` 键 = `YYYY-MM`，`BTreeMap` 键序稳定）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommissionProjectYearlySummaryItem {
    pub project_id: i64,
    #[serde(default)]
    pub project_name: String,
    #[serde(default)]
    pub months: BTreeMap<String, CommissionProjectMonthlySummaryMonthItem>,
    #[serde(default)]
    pub total_income_usd: f64,
    #[serde(default)]
    pub total_commission_rmb: f64,
    #[serde(default)]
    pub total_received_rmb: f64,
    #[serde(default)]
    pub receive_rate: f64,
}

impl CommissionProjectYearlySummaryItem {
    /// 取某月（`YYYY-MM`）格数据
    pub fn month(&self, month_key: &str) -> Option<&CommissionProjectMonthlySummaryMonthItem> {
        self.months.get(month_key)
    }
}

/// `GET /summary/project` 响应（backend `CommissionProjectYearlySummaryResponse`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommissionProjectYearlySummaryResponse {
    pub year: String,
    #[serde(default)]
    pub items: Vec<CommissionProjectYearlySummaryItem>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payment_status_labels_cover_options() {
        assert_eq!(payment_status_label(PAYMENT_STATUS_PAID), "已回款");
        assert_eq!(payment_status_label(PAYMENT_STATUS_PARTIAL), "部分回款");
        assert_eq!(payment_status_label(PAYMENT_STATUS_UNPAID), "未回款");
        assert_eq!(payment_status_label("weird"), "未知");
        assert_eq!(PAYMENT_STATUS_OPTIONS.len(), 3);
    }

    #[test]
    fn site_currency_maps_known_sites() {
        assert_eq!(site_currency("US"), "USD");
        assert_eq!(site_currency("de"), "EUR");
        assert_eq!(site_currency("UK"), "GBP");
        assert_eq!(site_currency("JP"), "");
        assert_eq!(site_currency_symbol("US"), "$");
        assert_eq!(site_currency_symbol("DE"), "€");
        assert_eq!(site_currency_symbol("UK"), "£");
        assert_eq!(site_currency_symbol("JP"), "");
        assert_eq!(SITE_ORDER, ["US", "DE", "UK"]);
    }

    #[test]
    fn format_percent_matches_web_two_decimals() {
        assert_eq!(format_percent(0.07), "7.00%");
        assert_eq!(format_percent(0.123_4), "12.34%");
        assert_eq!(format_percent(0.0), "0.00%");
        assert_eq!(format_percent(1.0), "100.00%");
    }

    #[test]
    fn receive_rate_level_thresholds_match_web() {
        // 容差：0.999999… 仍为 Positive
        assert_eq!(receive_rate_level(1.0), ReceiveRateLevel::Positive);
        assert_eq!(
            receive_rate_level(0.999_999_999),
            ReceiveRateLevel::Positive
        );
        assert_eq!(receive_rate_level(0.5), ReceiveRateLevel::Warning);
        assert_eq!(receive_rate_level(0.499_999_999), ReceiveRateLevel::Warning);
        assert_eq!(receive_rate_level(0.2), ReceiveRateLevel::Yellow);
        assert_eq!(receive_rate_level(0.199_999_999), ReceiveRateLevel::Yellow);
        assert_eq!(receive_rate_level(0.0), ReceiveRateLevel::Negative);
        assert_eq!(receive_rate_level(1.2), ReceiveRateLevel::Positive);
    }

    #[test]
    fn commission_ratio_label_follows_web_priority() {
        // 阶梯口径优先
        assert_eq!(
            commission_ratio_label(0.05, Some("cash_received"), Some(0.05)),
            "阶梯(7/10/13/15%)"
        );
        // 元数据有限比例次之
        assert_eq!(
            commission_ratio_label(0.05, Some("sales_amount"), Some(0.08)),
            "8.00%"
        );
        // 元数据比例缺失 / 非有限 → 行自带比例
        assert_eq!(
            commission_ratio_label(0.05, Some("sales_amount"), None),
            "5.00%"
        );
        assert_eq!(
            commission_ratio_label(0.05, Some("sales_amount"), Some(f64::NAN)),
            "5.00%"
        );
        // 元数据整体缺失 → 行自带比例
        assert_eq!(commission_ratio_label(0.13, None, None), "13.00%");
    }

    #[test]
    fn project_month_item_deserializes_backend_sample() {
        let json = r#"{
            "id": 12, "report_month": "2026-07", "country": "DE",
            "project_id": 3, "project_name": "德国店",
            "income_total_usd": 1234.56, "factory_commission_rate": 0.1,
            "usd_to_rmb_rate": 7.23, "factory_commission_usd": 123.46,
            "factory_commission_rmb": 892.61, "payment_status": "partial",
            "received_rmb": 400.0,
            "payment_confirmed_at": null, "payment_confirmed_by": null,
            "note": null,
            "computed_at": "2026-08-01T00:00:00+00:00",
            "updated_at": "2026-08-02T00:00:00+00:00"
        }"#;
        let item: CommissionProjectMonthItem = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(item.id, 12);
        assert_eq!(item.country, "DE");
        assert_eq!(item.payment_status, "partial");
        assert!((item.factory_commission_rmb - 892.61).abs() < 1e-9);
    }

    #[test]
    fn yearly_summary_deserializes_with_btree_months() {
        let json = r#"{
            "project_id": 3, "project_name": "德国店",
            "months": {
                "2026-02": {"report_month": "2026-02", "income_total_usd": 100.0,
                            "factory_commission_rmb": 70.0, "received_rmb": 70.0,
                            "receive_rate": 1.0},
                "2026-01": {"report_month": "2026-01", "income_total_usd": 200.0,
                            "factory_commission_rmb": 140.0, "received_rmb": 0.0,
                            "receive_rate": 0.0}
            },
            "total_income_usd": 300.0, "total_commission_rmb": 210.0,
            "total_received_rmb": 70.0, "receive_rate": 0.3333
        }"#;
        let item: CommissionProjectYearlySummaryItem =
            serde_json::from_str(json).expect("反序列化失败");
        // BTreeMap 键序稳定：首键为 2026-01
        let first = item.months.keys().next().expect("months 非空");
        assert_eq!(first, "2026-01");
        assert!(item.month("2026-02").is_some());
        assert!(item.month("2026-03").is_none());
        assert!((item.receive_rate - 0.3333).abs() < 1e-9);
    }

    #[test]
    fn responses_tolerate_missing_items() {
        let months: CommissionProjectMonthsResponse =
            serde_json::from_str(r#"{"report_month": "2026-07"}"#).expect("反序列化失败");
        assert!(months.items.is_empty());
        let yearly: CommissionYearlyMonthlySummaryResponse =
            serde_json::from_str(r#"{"year": "2026"}"#).expect("反序列化失败");
        assert!(yearly.items.is_empty());
        let projects: CommissionProjectYearlySummaryResponse =
            serde_json::from_str(r#"{"year": "2026"}"#).expect("反序列化失败");
        assert!(projects.items.is_empty());
    }
}
