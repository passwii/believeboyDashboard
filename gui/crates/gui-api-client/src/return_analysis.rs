//! 运营 → 退货分析 API（P5-1，BLF-715）
//!
//! 端点对齐 backend（`backend/app/api/v1/endpoints/return_analysis.py`，与 frontend
//! `app/dashboard/operations/return-analysis/return-analysis-client.tsx` 调用口径一致）：
//! - `GET /api/v1/return-analysis` —— 退货分析全量响应（排行 / 原因 / 趋势 /
//!   商品状态 / 库存状态 / 顾客反馈 / AI 总结 / 星期与仓库分布）
//!
//! query 契约（对齐 frontend `URLSearchParams`）：
//! - `project_id`：必填（>0）；
//! - `country`：`US` / `DE` / `UK`（后端默认 `US`，本模块始终显式携带）；
//! - `start_date` / `end_date`：必填，`YYYY-MM-DD` 闭区间。
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 三个 header（backend `protected` 依赖读取，见 client.rs）。

use chrono::NaiveDate;
use gui_domain::operations::return_analysis::ReturnAnalysisResponse;

use crate::client::Client;
use crate::error::ApiError;
use crate::query::QueryBuilder;

/// `GET /return-analysis` —— 退货分析全量响应
pub(crate) const RETURN_ANALYSIS_PATH: &str = "/api/v1/return-analysis";

impl Client {
    /// 退货分析（排行 / 原因 / 趋势 / 状态分布 / 反馈 / 总结）
    ///
    /// 对齐 frontend `loadData` 的 query 口径：`project_id` / `country` /
    /// `start_date` / `end_date` 四参全带；后端 Redis v2 缓存 + snapshot 双段式
    /// 加速（本客户端不额外缓存）。
    pub async fn return_analysis(
        &self,
        project_id: i64,
        country: &str,
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> Result<ReturnAnalysisResponse, ApiError> {
        let query = QueryBuilder::new()
            .with("project_id", project_id)
            .with("country", country)
            .with("start_date", start_date)
            .with("end_date", end_date);
        self.get_json(RETURN_ANALYSIS_PATH, &query.into_pairs())
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;

    /// 契约测试：路径锁定 backend 实际路由 `/return-analysis`
    #[test]
    fn return_analysis_path_matches_backend_route() {
        assert_eq!(RETURN_ANALYSIS_PATH, "/api/v1/return-analysis");
    }

    #[tokio::test]
    async fn return_analysis_sends_query_params_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", RETURN_ANALYSIS_PATH)
            .match_query(Matcher::AllOf(vec![
                Matcher::UrlEncoded("project_id".into(), "3".into()),
                Matcher::UrlEncoded("country".into(), "US".into()),
                Matcher::UrlEncoded("start_date".into(), "2026-08-07".into()),
                Matcher::UrlEncoded("end_date".into(), "2026-08-13".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "project_id": 3,
                    "project_name": "测试项目 A",
                    "country": "US",
                    "start_date": "2026-08-07",
                    "end_date": "2026-08-13",
                    "summary": {
                        "total_returns": 10,
                        "total_quantity": 12,
                        "unique_skus": 3,
                        "top_return_sku": "SKU-1",
                        "top_return_reason": "OTHER",
                        "total_sales_quantity": 120,
                        "total_sales_amount": 2400.0,
                        "overall_return_rate": 10.0
                    },
                    "summary_text": "📊 总览\n退货单数 10。",
                    "ranking_rows": [
                        {
                            "sku": "SKU-1",
                            "asin": "B0001",
                            "product_name": "产品一",
                            "total_quantity": 8,
                            "return_count": 6,
                            "sales_quantity": 60,
                            "return_rate": 13.3,
                            "avg_return_cycle_days": 4.2,
                            "min_return_cycle_days": 1,
                            "max_return_cycle_days": 8
                        }
                    ],
                    "reason_rows": [],
                    "trend_rows": [],
                    "disposition_rows": [],
                    "status_rows": [],
                    "feedback_rows": [],
                    "weekday_rows": [],
                    "fulfillment_center_rows": [],
                    "multi_item_return_count": 1,
                    "multi_item_return_quantity": 2
                }"#,
            )
            .create();

        let client = Client::new(server.url());
        let start = NaiveDate::from_ymd_opt(2026, 8, 7).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 8, 13).unwrap();
        let resp = client
            .return_analysis(3, "US", start, end)
            .await
            .expect("请求失败");

        m.assert();
        assert_eq!(resp.project_id, 3);
        assert_eq!(resp.project_name, "测试项目 A");
        assert_eq!(resp.summary.overall_return_rate, 10.0);
        assert_eq!(resp.summary.top_return_reason.as_deref(), Some("OTHER"));
        assert_eq!(resp.ranking_rows.len(), 1);
        assert_eq!(resp.ranking_rows[0].sku, "SKU-1");
        assert_eq!(resp.ranking_rows[0].avg_return_cycle_days, Some(4.2));
        assert_eq!(resp.multi_item_return_count, 1);
        assert!(resp.reason_rows.is_empty());
    }

    #[tokio::test]
    async fn return_analysis_handles_server_error_detail() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", RETURN_ANALYSIS_PATH)
            .match_query(Matcher::Any)
            .with_status(400)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"project not found"}"#)
            .create();

        let client = Client::new(server.url());
        let start = NaiveDate::from_ymd_opt(2026, 8, 7).unwrap();
        let end = NaiveDate::from_ymd_opt(2026, 8, 13).unwrap();
        let err = client
            .return_analysis(999, "US", start, end)
            .await
            .expect_err("应返回错误");

        m.assert();
        assert_eq!(err.status(), Some(400));
        assert_eq!(err.user_message(), "project not found");
    }
}
