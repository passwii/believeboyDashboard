//! 财务资金 → VAT 发票领域类型（P5-5，BLF-733）
//!
//! 字段对齐 backend `backend/app/schemas/vat_invoice.py`（`VatInvoiceListItem` /
//! `VatInvoiceResponse` / `VatInvoiceLineResponse` / `VatBuyerIn`），与 web 端
//! `frontend/app/dashboard/finance/vat-invoice/lib/vat-history-api.ts` 的类型
//! 声明同口径。
//!
//! 口径说明：
//! - 后端 Decimal 字段 JSON 序列化为字符串（web `types.ts` 同口径声明
//!   `string`），GUI 保留 `String` 1:1 传输；需要数值排序 / 计算的场景用
//!   [`VatInvoiceListItem::total_incl_f64`] 等解析辅助兜底（解析失败 → 0.0）；
//! - `summary_by_rate` 后端为 `list[Any]`（每行 `{rate, item_excl, item_vat,
//!   shipping_excl, shipping_vat, total}`，Decimal 值可能编码为字符串或数字），
//!   GUI 用 [`summary_row_text`] 防御式读取（对齐 web `String(row.x ?? '')`）；
//! - 状态三值 `draft / issued / voided`，标签语义对齐 web `STATUS_LABEL`
//!   （草稿 / 已签发 / 已作废）；
//! - `buyer` 后端为 `dict[str, Any]`，GUI 按 `VatBuyerIn` 已知 shape 反序列化，
//!   字段全部 `#[serde(default)]` 容忍缺省。

use serde::{Deserialize, Serialize};

/// 发票状态：草稿（backend `status='draft'`）
pub const STATUS_DRAFT: &str = "draft";
/// 发票状态：已签发（上传 PDF 后 `draft → issued`）
pub const STATUS_ISSUED: &str = "issued";
/// 发票状态：已作废（`POST /vat-invoices/{id}/void`）
pub const STATUS_VOIDED: &str = "voided";

/// 状态筛选选项（value, label；对齐 web 历史面板状态下拉）
pub const STATUS_OPTIONS: [(&str, &str); 3] = [
    (STATUS_DRAFT, "草稿"),
    (STATUS_ISSUED, "已签发"),
    (STATUS_VOIDED, "已作废"),
];

/// 状态中文标签（对齐 web `STATUS_LABEL`；未知状态回退「未知」）
pub fn status_label(status: &str) -> &'static str {
    match status {
        STATUS_DRAFT => "草稿",
        STATUS_ISSUED => "已签发",
        STATUS_VOIDED => "已作废",
        _ => "未知",
    }
}

/// 货币符号（对齐 web `CURRENCY_OPTIONS`：EUR → € / GBP → £ / PLN → zł /
/// CZK → Kč / USD → $；未知币种回退空串——列表直接展示货币代码）
pub fn currency_symbol(currency: &str) -> &'static str {
    match currency.trim().to_ascii_uppercase().as_str() {
        "EUR" => "€",
        "GBP" => "£",
        "PLN" => "zł",
        "CZK" => "Kč",
        "USD" => "$",
        _ => "",
    }
}

/// 买方信息（backend `VatBuyerIn` shape；`dict[str, Any]` 防御式缺省）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct VatBuyer {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub address_line: String,
    #[serde(default)]
    pub postal_code: String,
    #[serde(default)]
    pub city: String,
    #[serde(default)]
    pub country: String,
}

/// 发票明细行（backend `VatInvoiceLineResponse` 1:1；金额为 Decimal 字符串）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VatInvoiceLine {
    pub id: i64,
    pub line_no: i64,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub asin: String,
    #[serde(default = "default_qty")]
    pub qty: i64,
    #[serde(default)]
    pub unit_price_incl_vat: String,
    #[serde(default)]
    pub vat_rate: String,
    #[serde(default)]
    pub line_excl: String,
    #[serde(default)]
    pub line_vat: String,
    #[serde(default)]
    pub line_incl: String,
}

fn default_qty() -> i64 {
    1
}

/// 发票历史列表项（backend `VatInvoiceListItem` 1:1；金额为 Decimal 字符串）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VatInvoiceListItem {
    pub id: i64,
    pub invoice_no: String,
    pub project_id: i64,
    #[serde(default)]
    pub project_name: String,
    pub currency: String,
    #[serde(default)]
    pub order_id: String,
    #[serde(default)]
    pub buyer_name: String,
    /// `YYYY-MM-DD`（backend `date`）
    pub invoice_date: String,
    #[serde(default)]
    pub subtotal_excl: String,
    #[serde(default)]
    pub total_vat: String,
    #[serde(default)]
    pub total_incl: String,
    pub status: String,
    #[serde(default)]
    pub has_pdf: bool,
    /// UTC ISO8601（后端 `isoformat()`）
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

impl VatInvoiceListItem {
    /// 含税总额数值（`total_incl` 解析失败 → 0.0；供数值列排序）
    pub fn total_incl_f64(&self) -> f64 {
        self.total_incl.trim().parse::<f64>().unwrap_or(0.0)
    }
}

/// 发票详情（backend `VatInvoiceResponse` 1:1；金额为 Decimal 字符串）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VatInvoiceDetail {
    pub id: i64,
    pub invoice_no: String,
    pub project_id: i64,
    #[serde(default)]
    pub seller_entity_id: Option<i64>,
    /// 卖方快照（`dict[str, Any]`；GUI 不消费内部字段）
    #[serde(default)]
    pub seller_snapshot: serde_json::Value,
    #[serde(default)]
    pub buyer: VatBuyer,
    pub currency: String,
    #[serde(default)]
    pub order_id: String,
    /// `YYYY-MM-DD`
    pub invoice_date: String,
    #[serde(default)]
    pub shipping_incl_vat: String,
    #[serde(default)]
    pub subtotal_excl: String,
    #[serde(default)]
    pub total_vat: String,
    #[serde(default)]
    pub total_incl: String,
    /// 按 VAT 率分桶汇总（`list[Any]`；行 shape 见模块注释，防御式读取）
    #[serde(default)]
    pub summary_by_rate: Vec<serde_json::Value>,
    #[serde(default)]
    pub r2_key: Option<String>,
    #[serde(default)]
    pub r2_url: Option<String>,
    pub status: String,
    #[serde(default)]
    pub void_reason: Option<String>,
    #[serde(default)]
    pub created_by: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub lines: Vec<VatInvoiceLine>,
}

/// 汇总行字段文本（对齐 web `String(row[key] ?? '')`：字符串原样 / 数字
/// `to_string` / 缺省与其它类型 → 空串）
pub fn summary_row_text(row: &serde_json::Value, key: &str) -> String {
    match row.get(key) {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 契约：历史列表项反序列化（backend 真实响应形态，Decimal 为字符串）
    #[test]
    fn list_item_deserializes_backend_sample() {
        let json = r#"{
            "id": 5, "invoice_no": "INV-5", "project_id": 3,
            "project_name": "德国店", "currency": "EUR", "order_id": "111-22",
            "buyer_name": "Hans", "invoice_date": "2026-08-01",
            "subtotal_excl": "35.36", "total_vat": "6.62", "total_incl": "41.98",
            "status": "issued", "has_pdf": true,
            "created_at": "2026-08-01T00:00:00+00:00",
            "updated_at": "2026-08-02T00:00:00+00:00"
        }"#;
        let item: VatInvoiceListItem = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(item.id, 5);
        assert_eq!(item.project_name, "德国店");
        assert_eq!(item.total_incl, "41.98");
        assert_eq!(item.total_incl_f64(), 41.98);
        assert!(item.has_pdf);
    }

    /// 容错：project_name / 金额等缺省字段按 Pydantic 默认值兜底；
    /// 金额非数值时 `total_incl_f64` 兜底 0.0
    #[test]
    fn list_item_tolerates_missing_fields_and_bad_decimal() {
        let json = r#"{"id": 7, "invoice_no": "INV-7", "project_id": 1,
            "currency": "EUR", "invoice_date": "2026-08-01", "status": "draft"}"#;
        let item: VatInvoiceListItem = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(item.project_name, "");
        assert_eq!(item.total_incl, "");
        assert_eq!(item.total_incl_f64(), 0.0);
        assert!(!item.has_pdf);
    }

    /// 契约：详情反序列化（buyer dict / summary_by_rate list[Any] / lines）
    #[test]
    fn detail_deserializes_backend_sample() {
        let json = r#"{
            "id": 5, "invoice_no": "INV-5", "project_id": 3,
            "seller_entity_id": 2,
            "seller_snapshot": {"company_name": "ACME EU GmbH"},
            "buyer": {"name": "Hans", "address_line": "Weg 1", "postal_code": "10115",
                      "city": "Berlin", "country": "DE"},
            "currency": "EUR", "order_id": "111-22", "invoice_date": "2026-08-01",
            "shipping_incl_vat": "0.00", "subtotal_excl": "35.36",
            "total_vat": "6.62", "total_incl": "41.98",
            "summary_by_rate": [
                {"rate": "19", "item_excl": "35.36", "item_vat": "6.62",
                 "shipping_excl": "0.00", "shipping_vat": "0.00", "total": "41.98"}
            ],
            "r2_key": "vat-invoice/x.pdf", "r2_url": "https://r2/x.pdf",
            "status": "issued", "void_reason": null, "created_by": null,
            "created_at": "2026-08-01T00:00:00+00:00",
            "updated_at": "2026-08-02T00:00:00+00:00",
            "lines": [
                {"id": 9, "line_no": 1, "description": "T-shirt", "asin": "B0X",
                 "qty": 2, "unit_price_incl_vat": "20.99", "vat_rate": "19",
                 "line_excl": "35.28", "line_vat": "6.70", "line_incl": "41.98"}
            ]
        }"#;
        let d: VatInvoiceDetail = serde_json::from_str(json).expect("反序列化失败");
        assert_eq!(d.buyer.name, "Hans");
        assert_eq!(d.lines.len(), 1);
        assert_eq!(d.lines[0].qty, 2);
        assert_eq!(d.r2_url.as_deref(), Some("https://r2/x.pdf"));
        assert_eq!(d.summary_by_rate.len(), 1);
        // Decimal 可能编码为字符串——summary_row_text 原样取出
        assert_eq!(summary_row_text(&d.summary_by_rate[0], "rate"), "19");
        assert_eq!(summary_row_text(&d.summary_by_rate[0], "total"), "41.98");
        assert_eq!(summary_row_text(&d.summary_by_rate[0], "missing"), "");
    }

    /// `summary_row_text`：数字编码（FastAPI jsonable Decimal → float 路径）也容忍
    #[test]
    fn summary_row_text_handles_numeric_encoding() {
        let row: serde_json::Value =
            serde_json::json!({"rate": 19, "total": 41.98, "note": null});
        assert_eq!(summary_row_text(&row, "rate"), "19");
        assert_eq!(summary_row_text(&row, "total"), "41.98");
        assert_eq!(summary_row_text(&row, "note"), "");
    }

    /// 状态标签 / 货币符号映射（对齐 web `STATUS_LABEL` / `CURRENCY_OPTIONS`）
    #[test]
    fn status_and_currency_labels_match_web() {
        assert_eq!(status_label(STATUS_DRAFT), "草稿");
        assert_eq!(status_label(STATUS_ISSUED), "已签发");
        assert_eq!(status_label(STATUS_VOIDED), "已作废");
        assert_eq!(status_label("weird"), "未知");
        assert_eq!(STATUS_OPTIONS.len(), 3);

        assert_eq!(currency_symbol("EUR"), "€");
        assert_eq!(currency_symbol("GBP"), "£");
        assert_eq!(currency_symbol("PLN"), "zł");
        assert_eq!(currency_symbol("CZK"), "Kč");
        assert_eq!(currency_symbol("USD"), "$");
        assert_eq!(currency_symbol("JPY"), "");
        // 大小写不敏感
        assert_eq!(currency_symbol("eur"), "€");
    }
}
