//! 报表自动化（RPA 自动上传）状态 API（P5-4，BLF-730）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/rpa_reports.py` 的
//! `GET /rpa-reports/status`（与 frontend `page.tsx` 的 `loadStatus` 调用口径一致）：
//! query `report_date`（`yyyy-MM-dd`，必填）/ `country`（选填，默认 `"US"`）。
//!
//! 只读：本模块仅提供查看能力（报表自动化为只读状态查看；recognize / commit
//! 等写操作不在 GUI 范围——P5-4 范围边界，对齐 scheduled_reports「仅查看」）。
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id`（backend `protected` 依赖读取，见 client.rs）；生产后端
//! `require_api_key` 走 `Authorization: Bearer`（`BELIEVEBOY_TOKEN`）。

use chrono::NaiveDate;
use gui_domain::auto_upload::RpaReportStatusResponse;

use crate::client::Client;
use crate::error::ApiError;

/// `GET /rpa-reports/status` —— RPA 报表上传状态矩阵
const STATUS_PATH: &str = "/api/v1/rpa-reports/status";

impl Client {
    /// RPA 报表上传状态矩阵（项目 × 报表类型）：
    /// `GET /rpa-reports/status?report_date=YYYY-MM-DD&country=US`
    ///
    /// 对齐 frontend `loadStatus`：query 必带 `report_date`（`yyyy-MM-dd`）+ `country`
    /// （缺省后端按 `"US"` 处理；前端选择器恒传当前站点）。
    pub async fn list_rpa_report_status(
        &self,
        report_date: NaiveDate,
        country: &str,
    ) -> Result<RpaReportStatusResponse, ApiError> {
        let query = [
            ("report_date", report_date.to_string()),
            ("country", country.to_string()),
        ];
        self.get_json(STATUS_PATH, &query).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;

    /// 契约：路径锁定 backend 实际路由
    #[test]
    fn path_matches_backend_route() {
        assert_eq!(STATUS_PATH, "/api/v1/rpa-reports/status");
    }

    /// 契约：query 全量携带 report_date + country，解析 `{ country, items }`
    #[tokio::test]
    async fn list_rpa_report_status_sends_query_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", STATUS_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("report_date".into(), "2026-08-15".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "country": "US",
                    "items": [
                        {
                            "project_id": 3,
                            "project_name": "测试项目 A",
                            "country": "US",
                            "statuses": [
                                {"report_type": "inventory_report", "has_data": true, "is_uploaded": true, "latest_date": "2026-08-15", "status_source": "rpa"},
                                {"report_type": "sales_report", "has_data": true, "is_uploaded": false}
                            ]
                        }
                    ]
                }"#,
            )
            .create();

        let client = Client::new(server.url());
        let date = NaiveDate::from_ymd_opt(2026, 8, 15).unwrap();
        let resp = client
            .list_rpa_report_status(date, "US")
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.country, "US");
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].project_name, "测试项目 A");
        assert_eq!(resp.items[0].statuses.len(), 2);
        assert!(resp.items[0].statuses[0].is_uploaded);
        assert!(!resp.items[0].statuses[1].is_uploaded);
    }

    /// 契约：德国站 query 携带 country=DE
    #[tokio::test]
    async fn list_rpa_report_status_sends_country_de() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", STATUS_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("report_date".into(), "2026-08-01".into()),
                Matcher::UrlEncoded("country".into(), "DE".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{ "country": "DE", "items": [] }"#)
            .create();

        let client = Client::new(server.url());
        let date = NaiveDate::from_ymd_opt(2026, 8, 1).unwrap();
        let resp = client
            .list_rpa_report_status(date, "DE")
            .await
            .expect("请求失败");

        m.assert();
        assert!(resp.items.is_empty());
        assert_eq!(resp.country, "DE");
    }

    /// 契约：后端 500 → ApiError 携带后端 detail
    #[tokio::test]
    async fn list_rpa_report_status_handles_server_error_detail() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", STATUS_PATH)
            .match_query(Matcher::Any)
            .with_status(500)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"report_date 参数无效"}"#)
            .create();

        let client = Client::new(server.url());
        let date = NaiveDate::from_ymd_opt(2026, 8, 15).unwrap();
        let err = client
            .list_rpa_report_status(date, "US")
            .await
            .expect_err("应返回错误");

        m.assert();
        assert_eq!(err.status(), Some(500));
        assert_eq!(err.user_message(), "report_date 参数无效");
    }
}
