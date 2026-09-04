//! 汇率信息领域类型（P5-5，BLF-732）
//!
//! 财务资金 → 汇率信息。字段对齐 backend `backend/app/schemas/exchange_rate.py`
//! 的 Pydantic 模型（`ExchangeRateItem` / `ExchangeRateNoteImage` /
//! `ExchangeRateListResponse`）。
//!
//! 口径说明：
//! - 后端以 `year_month`（`YYYY-MM`）承载年月，视图层拆分展示年份 / 月份；
//! - `created_at` / `updated_at`：后端 `datetime.isoformat()` 序列化（UTC），
//!   视图层负责转北京时间展示；
//! - 货币选项 / 徽标符号对齐 web 端 `CURRENCY_OPTIONS` / `getCurrencyBadgeMeta`
//!   （`frontend/app/dashboard/finance/exchange-rate/page.tsx`）。

use serde::{Deserialize, Serialize};

/// 备注图片（backend `ExchangeRateNoteImage` 1:1；`thumbnail_url` 等缺省容忍）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExchangeRateNoteImage {
    pub id: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r2_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_key: Option<String>,
    pub filename: String,
    pub content_type: String,
    #[serde(default)]
    pub size: i64,
    pub uploaded_at: String,
}

/// 单条月度汇率（backend `ExchangeRateItem` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExchangeRateItem {
    pub id: i64,
    pub currency: String,
    #[serde(default)]
    pub currency_name: Option<String>,
    /// `YYYY-MM`（后端 `normalize_year_month` 归一为两位月）
    pub year_month: String,
    pub rate: f64,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub note_images: Vec<ExchangeRateNoteImage>,
    /// UTC ISO8601（后端 `isoformat()`；naive 时按 UTC 解释）
    pub created_at: String,
    pub updated_at: String,
}

impl ExchangeRateItem {
    /// 年份（`year_month` 前段；解析失败 → `None`）
    pub fn year(&self) -> Option<i64> {
        self.year_month
            .split('-')
            .next()
            .and_then(|y| y.parse::<i64>().ok())
    }

    /// 月份（`year_month` 后段；解析失败 / 越界 → `None`）
    pub fn month(&self) -> Option<u32> {
        self.year_month
            .split('-')
            .nth(1)
            .and_then(|m| m.parse::<u32>().ok())
            .filter(|m| (1..=12).contains(m))
    }

    /// 展示用货币名称（`currency_name` 缺省 / 空白 → 回退货币代码，对齐 web
    /// 代理层 `currencyName: rate.currency_name || rate.currency`）
    pub fn display_name(&self) -> &str {
        self.currency_name
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&self.currency)
    }
}

/// 汇率列表响应（backend `ExchangeRateListResponse` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExchangeRateListResponse {
    pub items: Vec<ExchangeRateItem>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

/// 筛选 / 表单货币选项（value, label；对齐 web `CURRENCY_OPTIONS`）
pub const CURRENCY_OPTIONS: [(&str, &str); 10] = [
    ("USD", "USD - 美元"),
    ("EUR", "EUR - 欧元"),
    ("CNY", "CNY - 人民币"),
    ("JPY", "JPY - 日元"),
    ("GBP", "GBP - 英镑"),
    ("HKD", "HKD - 港币"),
    ("AUD", "AUD - 澳元"),
    ("CAD", "CAD - 加元"),
    ("KRW", "KRW - 韩元"),
    ("SGD", "SGD - 新加坡元"),
];

/// 货币徽标符号（对齐 web `getCurrencyBadgeMeta`：USD → `$`、EUR → `€`、其余 → `¤`）
pub fn currency_symbol(currency: &str) -> &'static str {
    match currency.trim().to_ascii_uppercase().as_str() {
        "USD" => "$",
        "EUR" => "€",
        _ => "¤",
    }
}

/// 货币徽标强调文案（对齐 web `getCurrencyBadgeMeta.accent`）
pub fn currency_accent(currency: &str) -> &'static str {
    match currency.trim().to_ascii_uppercase().as_str() {
        "USD" => "美元",
        "EUR" => "欧元",
        _ => "其他货币",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_item(id: i64) -> ExchangeRateItem {
        ExchangeRateItem {
            id,
            currency: "USD".into(),
            currency_name: Some("美元".into()),
            year_month: "2026-08".into(),
            rate: 7.2345,
            description: Some("月初锁汇".into()),
            note_images: Vec::new(),
            created_at: "2026-08-01T00:00:00+00:00".into(),
            updated_at: "2026-08-20T06:23:00+00:00".into(),
        }
    }

    #[test]
    fn year_month_parses_into_year_and_month() {
        let item = sample_item(1);
        assert_eq!(item.year(), Some(2026));
        assert_eq!(item.month(), Some(8));

        let mut bare = sample_item(2);
        bare.year_month = "2025-1".into(); // 非两位月也能解析
        assert_eq!(bare.year(), Some(2025));
        assert_eq!(bare.month(), Some(1));

        let mut bad = sample_item(3);
        bad.year_month = "bad".into();
        assert_eq!(bad.year(), None);
        assert_eq!(bad.month(), None);

        let mut overflow = sample_item(4);
        overflow.year_month = "2026-13".into();
        assert_eq!(overflow.month(), None);
    }

    #[test]
    fn display_name_falls_back_to_currency_code() {
        assert_eq!(sample_item(1).display_name(), "美元");
        let mut blank = sample_item(2);
        blank.currency_name = Some("  ".into());
        assert_eq!(blank.display_name(), "USD");
        let mut none = sample_item(3);
        none.currency_name = None;
        assert_eq!(none.display_name(), "USD");
    }

    #[test]
    fn list_response_deserializes_snake_case_contract() {
        let json = r#"{
            "items": [{
                "id": 11, "currency": "EUR", "currency_name": "欧元",
                "year_month": "2026-07", "rate": 7.85,
                "description": null,
                "note_images": [{
                    "id": "abc", "url": "https://r2/img.webp",
                    "filename": "note.webp", "content_type": "image/webp",
                    "size": 1024, "uploaded_at": "2026-08-01T00:00:00+00:00"
                }],
                "created_at": "2026-08-01T00:00:00+00:00",
                "updated_at": "2026-08-01T00:00:00+00:00"
            }],
            "total": 1, "page": 1, "page_size": 12
        }"#;
        let resp: ExchangeRateListResponse = serde_json::from_str(json).expect("解析失败");
        assert_eq!(resp.total, 1);
        assert_eq!(resp.items.len(), 1);
        let item = &resp.items[0];
        assert_eq!(item.currency, "EUR");
        assert_eq!(item.year_month, "2026-07");
        assert_eq!(item.note_images.len(), 1);
        assert_eq!(item.note_images[0].thumbnail_url, None);
        // 缺省容忍字段（r2_key / thumbnail_key）不阻塞解析
        assert_eq!(item.note_images[0].r2_key, None);
    }

    #[test]
    fn currency_options_align_with_web_page() {
        assert_eq!(CURRENCY_OPTIONS.len(), 10);
        assert_eq!(CURRENCY_OPTIONS[0], ("USD", "USD - 美元"));
        assert_eq!(CURRENCY_OPTIONS[9], ("SGD", "SGD - 新加坡元"));
    }

    #[test]
    fn currency_symbol_and_accent_follow_web_meta() {
        assert_eq!(currency_symbol("USD"), "$");
        assert_eq!(currency_symbol("usd"), "$");
        assert_eq!(currency_symbol("EUR"), "€");
        assert_eq!(currency_symbol("JPY"), "¤");
        assert_eq!(currency_symbol("  GBP ".trim()), "¤");
        assert_eq!(currency_accent("USD"), "美元");
        assert_eq!(currency_accent("EUR"), "欧元");
        assert_eq!(currency_accent("CNY"), "其他货币");
    }
}
