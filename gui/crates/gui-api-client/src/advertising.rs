//! 广告相关 API
//!
//! 端点对齐 backend（`backend/app/api/v1/`，与 frontend 调用口径一致）：
//! - `ad-analysis/overview`   →  `GET /api/v1/ad-analysis/overview`
//!   （frontend `fetchAdAnalysisCached('overview', ...)`，query：`project_id` /
//!   `country` / 可选 `date_from` / `date_to`）
//! - `ad-upload-files`        →  `GET /api/v1/internal/ad-data/projects/{id}/ad-upload-files`
//!   （frontend `fetchAdUploadFilesCached`，query：`country`）
//! - `ad-{endpoint}-raw`      →  `GET /api/v1/internal/ad-data/projects/{id}/ad-{endpoint}-raw`
//!   （frontend `fetchAdRawCached`，query：`period=custom&country&limit&start_date&end_date`）
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id`（backend `protected` 依赖读取，见 client.rs）；生产后端
//! `require_api_key` 走 `Authorization: Bearer`（`BELIEVEBOY_TOKEN`）。

use chrono::NaiveDate;
use gui_domain::advertising::{
    AdOverviewResponse, AdRawResponse, AdUploadFileItem,
};

use crate::client::Client;
use crate::error::ApiError;

/// `GET /ad-analysis/overview` —— 广告分析概览（adAgentV2 汇总）
const AD_ANALYSIS_OVERVIEW_PATH: &str = "/api/v1/ad-analysis/overview";

/// `GET /internal/ad-data/projects/{project_id}/ad-upload-files` —— 项目已入库报表文件
fn ad_upload_files_path(project_id: i64) -> String {
    format!("/api/v1/internal/ad-data/projects/{project_id}/ad-upload-files")
}

/// `GET /internal/ad-data/projects/{project_id}/ad-{endpoint}-raw` —— 某报表类型原始行
fn ad_raw_path(project_id: i64, endpoint: &str) -> String {
    format!("/api/v1/internal/ad-data/projects/{project_id}/ad-{endpoint}-raw")
}

/// 拉取原始行时的行数上限（对齐 frontend `limit: '10000'`）
const AD_RAW_LIMIT: i64 = 10_000;

impl Client {
    /// 广告分析概览（花费 / ACOS / ROAS 指标卡 + 周期对比 + 趋势 + Top 表）
    ///
    /// 对齐 frontend `fetchAdAnalysisCached('overview', ...)` 的 query 口径：
    /// `project_id`（必填）+ `country` + 可选 `date_from` / `date_to`（缺省时
    /// 后端用最新可用数据窗口）。
    pub async fn ad_analysis_overview(
        &self,
        project_id: i64,
        country: &str,
        date_from: Option<NaiveDate>,
        date_to: Option<NaiveDate>,
    ) -> Result<AdOverviewResponse, ApiError> {
        let mut query = vec![
            ("project_id", project_id.to_string()),
            ("country", country.to_string()),
        ];
        if let Some(from) = date_from {
            query.push(("date_from", from.to_string()));
        }
        if let Some(to) = date_to {
            query.push(("date_to", to.to_string()));
        }
        self.get_json(AD_ANALYSIS_OVERVIEW_PATH, &query).await
    }

    /// 项目已入库的广告报表文件（判断「哪些报表类型有成功入库数据」）。
    ///
    /// 对齐 frontend `fetchAdUploadFilesCached(projectId, country)`：query 仅
    /// `country`（`limit` / `offset` 用后端默认值）。
    pub async fn ad_upload_files(
        &self,
        project_id: i64,
        country: &str,
    ) -> Result<Vec<AdUploadFileItem>, ApiError> {
        let query = [("country", country.to_string())];
        self.get_json(&ad_upload_files_path(project_id), &query).await
    }

    /// 某报表类型的原始行（原始表数据源）。
    ///
    /// 对齐 frontend `fetchAdRawCached(projectId, config.endpoint, query)`：
    /// `period=custom` + `country` + `limit=10000` + `start_date` / `end_date`
    /// （原始行按 `report_end_date` 降序返回，客户端自行搜索/排序/分页）。
    pub async fn ad_data_raw(
        &self,
        project_id: i64,
        endpoint: &str,
        country: &str,
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> Result<AdRawResponse, ApiError> {
        let query = [
            ("period", "custom".to_string()),
            ("country", country.to_string()),
            ("limit", AD_RAW_LIMIT.to_string()),
            ("start_date", start_date.to_string()),
            ("end_date", end_date.to_string()),
        ];
        self.get_json(&ad_raw_path(project_id, endpoint), &query)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;

    /// 契约测试：路径锁定 backend 实际路由
    #[test]
    fn paths_match_backend_routes() {
        assert_eq!(AD_ANALYSIS_OVERVIEW_PATH, "/api/v1/ad-analysis/overview");
        assert_eq!(
            ad_upload_files_path(1),
            "/api/v1/internal/ad-data/projects/1/ad-upload-files"
        );
        assert_eq!(
            ad_raw_path(2, "campaigns"),
            "/api/v1/internal/ad-data/projects/2/ad-campaigns-raw"
        );
        assert_eq!(
            ad_raw_path(2, "search-terms"),
            "/api/v1/internal/ad-data/projects/2/ad-search-terms-raw"
        );
    }

    #[tokio::test]
    async fn ad_analysis_overview_sends_query_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", AD_ANALYSIS_OVERVIEW_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "1".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("date_from".into(), "2026-08-07".into()),
                Matcher::UrlEncoded("date_to".into(), "2026-08-13".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "project_id": 1,
                    "country": "US",
                    "metrics": [
                        {"label": "花费", "value": 122.4, "display_value": "$122.40", "helper": "近 7 天"},
                        {"label": "ACOS", "value": 0.0658, "display_value": "6.58%", "helper": null},
                        {"label": "ROAS", "value": 15.2, "display_value": "15.20", "helper": null}
                    ],
                    "issue_cards": [],
                    "narrative_sections": [],
                    "comparison": null,
                    "top_campaigns": [],
                    "top_products": [],
                    "top_waste_terms": [],
                    "trend_summary": [
                        {"report_date": "2026-08-13", "spend": 18.0, "clicks": 35, "cpc": 0.51, "spend_change_ratio": 0.12}
                    ]
                }"#,
            )
            .create();

        let client = Client::new(server.url());
        let from = NaiveDate::from_ymd_opt(2026, 8, 7).unwrap();
        let to = NaiveDate::from_ymd_opt(2026, 8, 13).unwrap();
        let resp = client
            .ad_analysis_overview(1, "US", Some(from), Some(to))
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.project_id, 1);
        assert_eq!(resp.country, "US");
        assert_eq!(resp.metrics.len(), 3);
        assert_eq!(resp.metrics[0].label, "花费");
        assert_eq!(resp.metrics[0].display_value, "$122.40");
        assert_eq!(resp.metrics[1].display_value, "6.58%");
        assert_eq!(resp.trend_summary.len(), 1);
        assert_eq!(resp.trend_summary[0].spend, 18.0);
        // 缺省列表字段（top_campaigns 等）→ 空
        assert!(resp.top_campaigns.is_empty());
        assert!(resp.issue_cards.is_empty());
    }

    #[tokio::test]
    async fn ad_analysis_overview_omits_dates_by_default() {
        // 契约：date_from / date_to 缺省时不携带（后端用最新数据窗口）
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", AD_ANALYSIS_OVERVIEW_PATH)
            .match_query(Matcher::Regex(
                r"^project_id=2&country=DE$".to_string(),
            ))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"project_id": 2, "country": "DE", "metrics": [], "issue_cards": [], "narrative_sections": [], "comparison": null, "top_campaigns": [], "top_products": [], "top_waste_terms": [], "trend_summary": []}"#,
            )
            .create();

        let client = Client::new(server.url());
        let resp = client
            .ad_analysis_overview(2, "DE", None, None)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.project_id, 2);
        assert!(resp.metrics.is_empty());
    }

    #[tokio::test]
    async fn ad_upload_files_parses_report_file_items() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/internal/ad-data/projects/1/ad-upload-files")
            .match_query(Matcher::UrlEncoded("country".into(), "US".into()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"[
                    {
                        "file_id": 11,
                        "report_type": "ad_campaign_report",
                        "report_label": "广告活动",
                        "country": "US",
                        "period_start_date": "2026-08-01",
                        "period_end_date": "2026-08-13",
                        "version": 3,
                        "is_current": true,
                        "ingestion_status": "success",
                        "row_count_preview": 42,
                        "uploaded_at": "2026-08-14T02:00:00Z"
                    },
                    {
                        "file_id": 12,
                        "report_type": "ad_budget_report",
                        "report_label": "预算",
                        "country": "US",
                        "period_start_date": "2026-08-01",
                        "period_end_date": "2026-08-13",
                        "version": 1,
                        "is_current": false,
                        "ingestion_status": "failed",
                        "row_count_preview": null,
                        "uploaded_at": "2026-08-13T02:00:00Z"
                    }
                ]"#,
            )
            .create();

        let client = Client::new(server.url());
        let files = client.ad_upload_files(1, "US").await.expect("请求失败");

        m.assert();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].report_type, "ad_campaign_report");
        assert_eq!(files[0].report_label, "广告活动");
        assert!(files[0].is_current);
        assert_eq!(files[0].ingestion_status, "success");
        assert_eq!(files[0].row_count_preview, Some(42));
        assert_eq!(files[1].ingestion_status, "failed");
        assert_eq!(files[1].row_count_preview, None);
    }

    #[tokio::test]
    async fn ad_data_raw_sends_period_query_and_parses_rows() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/internal/ad-data/projects/1/ad-campaigns-raw")
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("period".into(), "custom".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("limit".into(), "10000".into()),
                Matcher::UrlEncoded("start_date".into(), "2026-08-01".into()),
                Matcher::UrlEncoded("end_date".into(), "2026-08-13".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "project_id": 1,
                    "period": {"type": "custom", "value": "custom", "start_date": "2026-08-01", "end_date": "2026-08-13"},
                    "country": "US",
                    "data": [
                        {"id": 1, "campaign_name": "活动 A", "impressions": 1200, "clicks": 60, "spend": 30.5, "sales_7d": 500.0, "orders_7d": 4, "acos": 0.061, "roas": 16.39},
                        {"id": 2, "campaign_name": "活动 B", "impressions": 800, "clicks": 30, "spend": 12.0, "sales_7d": 200.0, "orders_7d": 1, "acos": 0.06, "roas": 16.67}
                    ],
                    "summary": {"total_rows": 2, "date_range": ["2026-08-01", "2026-08-13"]}
                }"#,
            )
            .create();

        let client = Client::new(server.url());
        let start = NaiveDate::from_ymd_opt(2026, 8, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 8, 13).unwrap();
        let resp = client
            .ad_data_raw(1, "campaigns", "US", start, end)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.project_id, 1);
        assert_eq!(resp.period.r#type, "custom");
        assert_eq!(resp.country, "US");
        assert_eq!(resp.data.len(), 2);
        assert_eq!(resp.data[0]["campaign_name"], "活动 A");
        assert_eq!(resp.data[0]["spend"], 30.5);
        assert_eq!(resp.summary.total_rows, 2);
        assert_eq!(resp.summary.date_range.len(), 2);
    }

    #[tokio::test]
    async fn ad_data_raw_handles_server_error_detail() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/internal/ad-data/projects/9/ad-targets-raw")
            .match_query(Matcher::Any)
            .with_status(500)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"country required"}"#)
            .create();

        let client = Client::new(server.url());
        let start = NaiveDate::from_ymd_opt(2026, 8, 1).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 8, 13).unwrap();
        let err = client
            .ad_data_raw(9, "targets", "", start, end)
            .await
            .expect_err("应返回错误");

        m.assert();
        assert_eq!(err.status(), Some(500));
        assert_eq!(err.user_message(), "country required");
    }
}
