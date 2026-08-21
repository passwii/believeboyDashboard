//! CRM → 数据看板 API（P5-7，BLF-742）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/crm.py` 的 Dashboard 数据
//! 看板路由（P3c / P8，均仅管理员），与 web 端
//! `frontend/lib/crm/api/http-crm-client.ts` 的 `getDashboardStats` /
//! `getLifecycleBoard` 口径一致：
//! - `GET /api/v1/crm/dashboard/stats` → 看板聚合（线索漏斗 / 本月新增 /
//!   跟进活跃度 / 每销售业绩）；
//! - `GET /api/v1/crm/dashboard/lifecycle` → 生命周期看板（创建到首次跟进/
//!   转化/流失 的时间分布 + 当前公海数）。
//!
//! 未接入（对齐既有「写入/二层面板走 web 端」取舍，见视图模块头说明）：
//! - `GET /api/v1/crm/dashboard/funnel/stage/{stage}`（漏斗二层复盘明细，
//!   web 为点击漏斗层展开的抽屉面板；GUI v1 不做该交互）；
//! - `/dashboard/funnel`（维度漏斗指标）与 `/dashboard/performance`
//!   （业绩看板排名表）：web 数据看板页未消费。
//!
//! 权限提示：两端点后端均 `require_admin`；非管理员会话请求返回 403，
//! 错误消息经 `ApiError::user_message` 透传给视图错误态。
//!
//! 请求鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` /
//! `X-Session-Id` 与上下文头；生产后端 dashboard 路由另需
//! `Authorization: Bearer` api_key（BLF-711，见 client.rs）。

use crate::client::Client;
use crate::error::ApiError;
use gui_domain::crm::{DashboardStats, LifecycleBoard};

/// `GET …/crm/dashboard/stats`
pub(crate) const DASHBOARD_STATS_PATH: &str = "/api/v1/crm/dashboard/stats";

/// `GET …/crm/dashboard/lifecycle`
pub(crate) const LIFECYCLE_PATH: &str = "/api/v1/crm/dashboard/lifecycle";

impl Client {
    /// CRM 数据看板聚合（对齐 web `getDashboardStats`）
    pub async fn crm_dashboard_stats(&self) -> Result<DashboardStats, ApiError> {
        self.get_json(DASHBOARD_STATS_PATH, &[]).await
    }

    /// 生命周期看板（对齐 web `getLifecycleBoard`）
    pub async fn crm_lifecycle_board(&self) -> Result<LifecycleBoard, ApiError> {
        self.get_json(LIFECYCLE_PATH, &[]).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个带会话的 client（会话 header 断言用；与 commission.rs 同款）
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
        assert_eq!(DASHBOARD_STATS_PATH, "/api/v1/crm/dashboard/stats");
        assert_eq!(LIFECYCLE_PATH, "/api/v1/crm/dashboard/lifecycle");
    }

    /// mock HTTP：stats 携带会话头；snake_case 响应解析
    #[tokio::test]
    async fn dashboard_stats_sends_session_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", DASHBOARD_STATS_PATH)
            .match_header("X-User-Id", "u_1")
            .match_header("X-User-Email", "demo@believeboy.com")
            .match_header("X-Session-Id", "sess_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "lead_funnel": {"new": 10, "contacting": 6, "qualified": 3,
                                    "converted": 2, "discarded": 4},
                    "new_this_month": {"new_customers": 5, "new_leads": 10,
                                       "converted_count": 2},
                    "follow_activity": {"follow_count_7d": 18},
                    "per_owner": [
                        {"owner_id": "u-1", "owner_name": "张三",
                         "customer_count": 12, "converted_this_month": 2}
                    ]
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client.crm_dashboard_stats().await.expect("请求失败");
        m.assert();
        assert_eq!(resp.lead_funnel.get("converted"), Some(&2));
        assert_eq!(resp.new_this_month.new_leads, 10);
        assert_eq!(resp.follow_activity.follow_count_7d, 18);
        assert_eq!(resp.per_owner.len(), 1);
        assert_eq!(resp.per_owner[0].owner_name.as_deref(), Some("张三"));
    }

    /// mock HTTP：lifecycle 解析三种分布 + 公海数；无上限桶 max_days=null
    #[tokio::test]
    async fn lifecycle_board_parses_distributions() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", LIFECYCLE_PATH)
            .match_header("X-User-Id", "u_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "first_follow": {
                        "metric": "first_follow", "label": "首次跟进",
                        "description": "客户创建到第一条跟进",
                        "buckets": [
                            {"label": "1 天内", "min_days": 0, "max_days": 1,
                             "count": 8, "pct": 0.4, "cumulative_pct": 0.4}
                        ],
                        "summary": {"sample_count": 20, "total_count": 25,
                                    "avg_days": 4.2, "median_days": 3.0,
                                    "p90_days": 12.0, "max_days": 40.0}
                    },
                    "conversion": {"metric": "conversion", "label": "转化",
                                   "description": "", "buckets": [],
                                   "summary": {"sample_count": 5, "total_count": 25}},
                    "churn": {"metric": "churn", "label": "流失",
                              "description": "", "buckets": [],
                              "summary": {"sample_count": 2, "total_count": 25}},
                    "now_in_sea": 7
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client.crm_lifecycle_board().await.expect("请求失败");
        m.assert();
        assert_eq!(resp.now_in_sea, 7);
        assert_eq!(resp.first_follow.summary.sample_count, 20);
        assert_eq!(resp.first_follow.buckets[0].max_days, Some(1.0));
        assert_eq!(resp.conversion.summary.sample_count, 5);
        assert_eq!(resp.churn.summary.sample_count, 2);
    }

    /// 服务端 403（非管理员）→ 透传错误消息
    #[tokio::test]
    async fn request_propagates_error_message() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", DASHBOARD_STATS_PATH)
            .with_status(403)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"仅管理员可访问"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .crm_dashboard_stats()
            .await
            .expect_err("应返回错误");
        m.assert();
        assert_eq!(err.status(), Some(403));
        assert_eq!(err.user_message(), "仅管理员可访问");
    }
}
