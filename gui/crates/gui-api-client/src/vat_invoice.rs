//! 财务资金 → VAT 发票 API（P5-5，BLF-733）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/vat_invoices.py`，与 web 端
//! `frontend/app/dashboard/finance/vat-invoice/lib/vat-history-api.ts` 的参数
//! 口径一致：
//! - `GET /api/v1/vat-invoices?project_id&status&q` → **裸数组**（非分页信封；
//!   后端 `limit` 默认 100 / 上限 500，web 端不传 → GUI 同口径不传）；
//! - `GET /api/v1/vat-invoices/{id}` → 详情（带 `lines` 明细行）。
//!
//! 未接入（写入链路走 web 端，对齐 BLF-726 发货管理 / BLF-731 订单信息 /
//! BLF-732 汇率信息「写入走 web 端」取舍）：
//! - `POST /api/v1/vat-invoices`（建草稿 / 签发）——签发依赖客户端 PDF 生成
//!   （web 用 jsPDF），GPUI 无等价物；
//! - `POST /api/v1/vat-invoices/{id}/pdf`（上传 PDF 触发签发）、
//!   `POST /api/v1/vat-invoices/{id}/void`（作废）；
//! - `GET /api/v1/vat-invoices/{id}/pdf`（302 → R2 公共 URL）——GUI 详情侧
//!   直接 `open_url(detail.r2_url)` 打开系统浏览器预览（GUI-12 站点导航直达
//!   范式），不经过需鉴权头的 302 端点；
//! - `/vat-entities` CRUD（Seller 主体维护，新建发票流程的前置数据）。
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 与上下文头；生产后端 dashboard 路由另需
//! `Authorization: Bearer` api_key（BLF-711，见 client.rs）。

use crate::client::Client;
use crate::error::ApiError;
use crate::query::QueryBuilder;
use gui_domain::vat_invoice::{VatInvoiceDetail, VatInvoiceListItem};

/// `GET /api/v1/vat-invoices` —— 发票历史列表（裸数组）
pub(crate) const LIST_PATH: &str = "/api/v1/vat-invoices";

/// `GET /api/v1/vat-invoices/{id}`（前缀 + id 拼接）
pub(crate) const ITEM_PATH_PREFIX: &str = "/api/v1/vat-invoices";

/// 发票历史共享筛选（对齐 web `VatInvoiceHistoryPanel` 的筛选下拉 +
/// 关键字输入；`q` 匹配发票号 / 订单号，后端 LIKE 查询）
#[derive(Debug, Clone, Default, PartialEq)]
pub struct VatInvoiceFilter {
    /// 店铺 ID（`None` = 全部 VAT 店铺；后端校验项目访问权）
    pub project_id: Option<i64>,
    /// 状态（draft / issued / voided；`None` = 全部）
    pub status: Option<String>,
    /// 关键字（发票号 / 订单号模糊匹配；空白串不携带）
    pub q: Option<String>,
}

impl VatInvoiceFilter {
    /// 组装列表 query 参数（顺序稳定，便于 mockito 逐参断言；空条件不携带，
    /// `q` trim 后为空不携带——对齐 web `v !== ''` 判断）
    pub fn base_query(&self) -> QueryBuilder {
        let q = self
            .q
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        QueryBuilder::new()
            .with_opt("project_id", self.project_id)
            .with_opt("status", self.status.as_deref())
            .with_opt("q", q)
    }
}

impl Client {
    /// 发票历史列表（对齐 web `listInvoices`：裸数组，无分页信封；
    /// 后端默认 `limit=100`，web 端不传 → 同口径不传）
    pub async fn vat_invoice_list(
        &self,
        filter: &VatInvoiceFilter,
    ) -> Result<Vec<VatInvoiceListItem>, ApiError> {
        self.get_json(LIST_PATH, &filter.base_query().into_pairs())
            .await
    }

    /// 发票详情（对齐 web `getInvoiceDetail`：带 `lines` 明细行与
    /// `summary_by_rate` 汇总）
    pub async fn vat_invoice_detail(&self, invoice_id: i64) -> Result<VatInvoiceDetail, ApiError> {
        let path = format!("{ITEM_PATH_PREFIX}/{invoice_id}");
        self.get_json(&path, &[]).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gui_domain::vat_invoice::STATUS_ISSUED;
    use mockito::Matcher;

    /// 构造一个带会话的 client（会话 header 断言用；与 exchange_rate.rs 同款）
    fn session_client(base_url: &str) -> Client {
        let session = crate::client::AuthSession {
            user_id: "u_1".into(),
            email: "demo@believeboy.com".into(),
            session_id: "sess_1".into(),
            user_name: Some("测试".into()),
            operator_name_zh: Some("测试运营".into()),
            role_type: gui_domain::auth::UserRoleType::Operator,
            is_admin: false,
        };
        Client::new(base_url).with_session(session)
    }

    /// 契约测试：路径锁定 backend 实际路由（防端点漂移）
    #[test]
    fn paths_match_backend_routes() {
        assert_eq!(LIST_PATH, "/api/v1/vat-invoices");
        assert_eq!(ITEM_PATH_PREFIX, "/api/v1/vat-invoices");
    }

    /// 契约：筛选组装——空条件不携带；`q` trim 后为空不携带
    #[test]
    fn filter_builds_query_and_skips_blank_keyword() {
        let full = VatInvoiceFilter {
            project_id: Some(3),
            status: Some(STATUS_ISSUED.into()),
            q: Some("  INV-5  ".into()),
        };
        assert_eq!(
            full.base_query().into_pairs(),
            vec![
                ("project_id", "3".to_string()),
                ("status", "issued".to_string()),
                ("q", "INV-5".to_string()),
            ]
        );

        let blank_q = VatInvoiceFilter {
            q: Some("   ".into()),
            ..VatInvoiceFilter::default()
        };
        assert!(blank_q.base_query().into_pairs().is_empty());
        assert!(VatInvoiceFilter::default().base_query().is_empty());
    }

    /// mock HTTP：列表请求携带筛选参数 + 会话头；响应按裸数组解析
    #[tokio::test]
    async fn list_sends_params_and_parses_bare_array() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LIST_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("status".into(), "issued".into()),
                Matcher::UrlEncoded("q".into(), "INV".into()),
            ]))
            .match_header("X-User-Id", "u_1")
            .match_header("X-User-Email", "demo@believeboy.com")
            .match_header("X-Session-Id", "sess_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"[
                    {
                        "id": 5, "invoice_no": "INV-5", "project_id": 3,
                        "project_name": "德国店", "currency": "EUR",
                        "order_id": "111-22", "buyer_name": "Hans",
                        "invoice_date": "2026-08-01",
                        "subtotal_excl": "35.36", "total_vat": "6.62",
                        "total_incl": "41.98", "status": "issued",
                        "has_pdf": true,
                        "created_at": "2026-08-01T00:00:00+00:00",
                        "updated_at": "2026-08-02T00:00:00+00:00"
                    }
                ]"#,
            )
            .create();

        let client = session_client(&server.url());
        let filter = VatInvoiceFilter {
            project_id: Some(3),
            status: Some(STATUS_ISSUED.into()),
            q: Some("INV".into()),
        };
        let rows = client.vat_invoice_list(&filter).await.expect("请求失败");

        m.assert();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].invoice_no, "INV-5");
        assert_eq!(rows[0].total_incl, "41.98");
        assert!(rows[0].has_pdf);
    }

    /// mock HTTP：空筛选 → 不带任何 query 参数；空数组解析
    #[tokio::test]
    async fn list_with_empty_filter_returns_empty_vec() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LIST_PATH)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body("[]")
            .create();

        let client = session_client(&server.url());
        let rows = client
            .vat_invoice_list(&VatInvoiceFilter::default())
            .await
            .expect("请求失败");
        m.assert();
        assert!(rows.is_empty());
    }

    /// mock HTTP：详情请求命中 `/vat-invoices/{id}`，解析带 lines 的完整记录
    #[tokio::test]
    async fn detail_parses_full_record_with_lines() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/vat-invoices/5")
            .match_header("X-User-Id", "u_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "id": 5, "invoice_no": "INV-5", "project_id": 3,
                    "seller_entity_id": 2,
                    "seller_snapshot": {"company_name": "ACME EU GmbH"},
                    "buyer": {"name": "Hans", "address_line": "Weg 1",
                              "postal_code": "10115", "city": "Berlin",
                              "country": "DE"},
                    "currency": "EUR", "order_id": "111-22",
                    "invoice_date": "2026-08-01",
                    "shipping_incl_vat": "0.00", "subtotal_excl": "35.36",
                    "total_vat": "6.62", "total_incl": "41.98",
                    "summary_by_rate": [
                        {"rate": "19", "item_excl": "35.36", "item_vat": "6.62",
                         "shipping_excl": "0.00", "shipping_vat": "0.00",
                         "total": "41.98"}
                    ],
                    "r2_key": "vat-invoice/x.pdf", "r2_url": "https://r2/x.pdf",
                    "status": "issued", "void_reason": null, "created_by": null,
                    "created_at": "2026-08-01T00:00:00+00:00",
                    "updated_at": "2026-08-02T00:00:00+00:00",
                    "lines": [
                        {"id": 9, "line_no": 1, "description": "T-shirt",
                         "asin": "B0X", "qty": 2, "unit_price_incl_vat": "20.99",
                         "vat_rate": "19", "line_excl": "35.28",
                         "line_vat": "6.70", "line_incl": "41.98"}
                    ]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let detail = client.vat_invoice_detail(5).await.expect("请求失败");
        m.assert();
        assert_eq!(detail.invoice_no, "INV-5");
        assert_eq!(detail.buyer.name, "Hans");
        assert_eq!(detail.lines.len(), 1);
        assert_eq!(detail.lines[0].qty, 2);
        assert_eq!(detail.summary_by_rate.len(), 1);
        assert_eq!(detail.r2_url.as_deref(), Some("https://r2/x.pdf"));
    }

    /// 服务端 403（无项目访问权）→ 透传错误消息
    #[tokio::test]
    async fn list_propagates_forbidden_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LIST_PATH)
            .match_query(Matcher::UrlEncoded("project_id".into(), "99".into()))
            .with_status(403)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"no access to project"}"#)
            .create();

        let client = Client::new(server.url());
        let filter = VatInvoiceFilter {
            project_id: Some(99),
            ..VatInvoiceFilter::default()
        };
        let err = client
            .vat_invoice_list(&filter)
            .await
            .expect_err("应返回错误");
        m.assert();
        assert_eq!(err.status(), Some(403));
        assert_eq!(err.user_message(), "no access to project");
    }
}
