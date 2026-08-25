//! CRM → 数据看板 / 待跟进 API（P5-7，BLF-742 / BLF-743）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/crm.py` 的 Dashboard 数据
//! 看板路由（P3c / P8，均仅管理员）与待跟进视图路由（P2b，登录用户可用），
//! 与 web 端 `frontend/lib/crm/api/http-crm-client.ts` 的 `getDashboardStats`
//! / `getLifecycleBoard` / `listFollowUps` 口径一致：
//! - `GET /api/v1/crm/dashboard/stats` → 看板聚合（线索漏斗 / 本月新增 /
//!   跟进活跃度 / 每销售业绩）；
//! - `GET /api/v1/crm/dashboard/lifecycle` → 生命周期看板（创建到首次跟进/
//!   转化/流失 的时间分布 + 当前公海数）；
//! - `GET /api/v1/crm/follow-ups?scope=mine|all` → 待跟进三组（逾期/今日/
//!   本周；非管理员请求 `all` 后端静默降级为 `mine`）。
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
use gui_domain::crm::{
    AuditLogPage, CrmUser, CustomerPage, DashboardStats, FollowUpGroups, LeadPage, LifecycleBoard,
    TaskItem, TaskPage,
};

/// `GET …/crm/dashboard/stats`
pub(crate) const DASHBOARD_STATS_PATH: &str = "/api/v1/crm/dashboard/stats";

/// `GET …/crm/dashboard/lifecycle`
pub(crate) const LIFECYCLE_PATH: &str = "/api/v1/crm/dashboard/lifecycle";

/// `GET …/crm/follow-ups`
pub(crate) const FOLLOW_UPS_PATH: &str = "/api/v1/crm/follow-ups";

impl Client {
    /// CRM 数据看板聚合（对齐 web `getDashboardStats`）
    pub async fn crm_dashboard_stats(&self) -> Result<DashboardStats, ApiError> {
        self.get_json(DASHBOARD_STATS_PATH, &[]).await
    }

    /// 生命周期看板（对齐 web `getLifecycleBoard`）
    pub async fn crm_lifecycle_board(&self) -> Result<LifecycleBoard, ApiError> {
        self.get_json(LIFECYCLE_PATH, &[]).await
    }

    /// 待跟进三组（对齐 web `listFollowUps(scope)`；scope 取 `mine` | `all`，
    /// 非管理员请求 `all` 后端静默降级为 `mine`）
    pub async fn crm_follow_ups(&self, scope: &str) -> Result<FollowUpGroups, ApiError> {
        self.get_json(FOLLOW_UPS_PATH, &[("scope", scope.to_string())])
            .await
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
        let err = client.crm_dashboard_stats().await.expect_err("应返回错误");
        m.assert();
        assert_eq!(err.status(), Some(403));
        assert_eq!(err.user_message(), "仅管理员可访问");
    }

    /// 契约测试：follow-ups 路径锁定 backend 实际路由（防端点漂移）
    #[test]
    fn follow_ups_path_matches_backend_route() {
        assert_eq!(FOLLOW_UPS_PATH, "/api/v1/crm/follow-ups");
    }

    /// mock HTTP：follow-ups 携带 scope query + 会话头；snake_case 三组解析
    #[tokio::test]
    async fn follow_ups_sends_scope_and_session_and_parses_groups() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", FOLLOW_UPS_PATH)
            .match_query(mockito::Matcher::UrlEncoded("scope".into(), "all".into()))
            .match_header("X-User-Id", "u_1")
            .match_header("X-Session-Id", "sess_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "overdue": [
                        {"entity_type": "customer", "entity_id": 3, "name": "客户甲",
                         "subtitle": "制造业", "owner_name": "张三",
                         "next_follow_at": "2026-08-10T09:30:00+08:00",
                         "last_follow_content": "电话沟通报价",
                         "rating": "A", "status": "active"}
                    ],
                    "today": [
                        {"entity_type": "lead", "entity_id": 7, "name": "线索乙",
                         "next_follow_at": "2026-08-21T15:00:00+08:00"}
                    ],
                    "this_week": [],
                    "overdue_count": 1,
                    "total_count": 2
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client.crm_follow_ups("all").await.expect("请求失败");
        m.assert();
        assert_eq!(resp.overdue.len(), 1);
        assert_eq!(resp.today.len(), 1);
        assert!(resp.this_week.is_empty());
        assert_eq!(resp.overdue_count, 1);
        assert_eq!(resp.total_count, 2);
        assert_eq!(resp.overdue[0].rating.as_deref(), Some("A"));
        assert!(resp.overdue[0].is_customer());
        assert!(!resp.today[0].is_customer());
    }

    /// mock HTTP：空分组（全 default 字段）解析不炸
    #[tokio::test]
    async fn follow_ups_parses_empty_groups() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", FOLLOW_UPS_PATH)
            .match_query(mockito::Matcher::UrlEncoded(
                "scope".into(),
                "mine".into(),
            ))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"overdue": [], "today": [], "this_week": [], "overdue_count": 0, "total_count": 0}"#)
            .create();

        let client = session_client(&server.url());
        let resp = client.crm_follow_ups("mine").await.expect("请求失败");
        m.assert();
        assert_eq!(resp.total_count, 0);
        assert!(resp.overdue.is_empty() && resp.today.is_empty() && resp.this_week.is_empty());
    }
}

/// `GET …/crm/audit-logs`
pub(crate) const AUDIT_LOGS_PATH: &str = "/api/v1/crm/audit-logs";

impl Client {
    /// CRM 操作审计日志分页查询（对齐 web `listAuditLogs`；仅管理员——
    /// 非管理员请求返回 403，由视图落 Forbidden 态）
    ///
    /// - `entity_type` / `action`：`None` = 不过滤（对齐 web「全部对象/全部操作」）
    /// - `page` 1 起；`page_size` 上限 100（后端 Query 校验）
    pub async fn crm_audit_logs(
        &self,
        entity_type: Option<&str>,
        action: Option<&str>,
        page: usize,
        page_size: usize,
    ) -> Result<AuditLogPage, ApiError> {
        let mut query: Vec<(&str, String)> = Vec::with_capacity(4);
        if let Some(entity) = entity_type {
            query.push(("entity_type", entity.to_string()));
        }
        if let Some(action) = action {
            query.push(("action", action.to_string()));
        }
        query.push(("page", page.to_string()));
        query.push(("page_size", page_size.to_string()));
        let page: AuditLogPage = self.get_json(AUDIT_LOGS_PATH, &query).await?;
        Ok(page)
    }
}

#[cfg(test)]
mod audit_tests {
    use super::*;

    /// 构造一个带会话的 client（与主测试模块同款）
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
    fn audit_logs_path_matches_backend_route() {
        assert_eq!(AUDIT_LOGS_PATH, "/api/v1/crm/audit-logs");
    }

    /// mock HTTP：筛选 + 分页 query 携带；snake_case 响应解析
    #[tokio::test]
    async fn audit_logs_sends_filters_and_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", AUDIT_LOGS_PATH)
            .match_query(mockito::Matcher::UrlEncoded(
                "entity_type".into(),
                "customer".into(),
            ))
            .match_query(mockito::Matcher::UrlEncoded("action".into(), "create".into()))
            .match_query(mockito::Matcher::UrlEncoded("page".into(), "2".into()))
            .match_query(mockito::Matcher::UrlEncoded(
                "page_size".into(),
                "30".into(),
            ))
            .match_header("X-User-Id", "u_1")
            .match_header("X-Session-Id", "sess_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "items": [
                        {"id": 11, "entity_type": "customer", "entity_id": 3,
                         "action": "create", "actor_id": "u-9",
                         "actor_name": "张三", "summary": "创建客户「客户甲」",
                         "created_at": "2026-08-21T10:30:00+08:00"},
                        {"id": 12, "entity_type": "task", "entity_id": 5,
                         "action": "complete", "actor_id": null, "actor_name": null,
                         "summary": null, "created_at": "2026-08-20T02:00:00Z"}
                    ],
                    "total": 42, "page": 2, "page_size": 30
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client
            .crm_audit_logs(Some("customer"), Some("create"), 2, 30)
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.items.len(), 2);
        assert_eq!(resp.total, 42);
        assert_eq!(resp.page, 2);
        assert_eq!(resp.page_size, 30);
        assert_eq!(resp.items[0].entity_type, "customer");
        assert_eq!(resp.items[0].actor_name.as_deref(), Some("张三"));
        assert!(resp.items[1].summary.is_none());
    }

    /// mock HTTP：筛选为 None 时不带 entity_type/action 参数（仅分页）
    #[tokio::test]
    async fn audit_logs_omits_unset_filters() {
        let mut server = mockito::Server::new_async().await;
        // 用 match_request 记录完整 path+query（mockito 1.x 无公开 matched_requests），
        // 断言未设置筛选时请求不带 entity_type / action
        let seen: std::sync::Arc<std::sync::Mutex<String>> =
            std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let seen_for_matcher = seen.clone();
        let m = server
            .mock("GET", AUDIT_LOGS_PATH)
            // 路径匹配含 query；这里用 Any 放行，由 match_request 记录断言
            .match_query(mockito::Matcher::Any)
            .match_request(move |request| {
                if let Ok(mut guard) = seen_for_matcher.lock() {
                    *guard = request.path_and_query().to_string();
                }
                true
            })
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"items": [], "total": 0, "page": 1, "page_size": 30}"#)
            .create_async()
            .await;

        let client = session_client(&server.url());
        let resp = client
            .crm_audit_logs(None, None, 1, 30)
            .await
            .expect("请求失败");
        m.assert();
        assert!(resp.items.is_empty());
        let url = seen.lock().expect("锁不 panic").clone();
        assert!(
            !url.contains("entity_type") && !url.contains("action="),
            "未设置筛选不应带过滤参数：{url}"
        );
        assert!(url.contains("page=1"), "分页参数保留：{url}");
        assert!(url.contains("page_size=30"), "每页行数保留：{url}");
    }

    /// 服务端 403（非管理员）→ 错误状态码透传，供视图落 Forbidden 态
    #[tokio::test]
    async fn audit_logs_propagates_403_status() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", AUDIT_LOGS_PATH)
            .match_query(mockito::Matcher::Any)
            .with_status(403)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"仅管理员可访问"}"#)
            .create();

        let client = session_client(&server.url());
        let err = client
            .crm_audit_logs(None, None, 1, 30)
            .await
            .expect_err("应返回错误");
        m.assert();
        assert_eq!(err.status(), Some(403));
        assert_eq!(err.user_message(), "仅管理员可访问");
    }
}

// ---------------------------------------------------------------------------
// 客户 / 线索 / 任务列表（Stage13，BLF-804）
// ---------------------------------------------------------------------------

pub(crate) const CRM_CUSTOMERS_PATH: &str = "/api/v1/crm/customers";
pub(crate) const CRM_LEADS_PATH: &str = "/api/v1/crm/leads";
pub(crate) const CRM_TASKS_PATH: &str = "/api/v1/crm/tasks";
pub(crate) const CRM_USERS_PATH: &str = "/api/v1/crm/users";

/// CRM 列表查询参数（客户/线索共用；任务另有 type/status 维度走独立方法）
#[derive(Debug, Clone, Default)]
pub struct CrmListParams {
    /// `mine` | `all`（非管理员请求 all 后端静默降级 mine）
    pub scope: String,
    /// 关键词（名称/公司等模糊匹配）
    pub keyword: Option<String>,
    pub page: usize,
    pub page_size: usize,
}

impl CrmListParams {
    /// 默认参数：全部范围 + 第 1 页 100 行（GUI 单页大表口径）
    pub fn new() -> Self {
        Self {
            scope: "all".to_string(),
            keyword: None,
            page: 1,
            page_size: 100,
        }
    }

    fn query(&self) -> Vec<(&'static str, String)> {
        let mut q: Vec<(&'static str, String)> = Vec::with_capacity(4);
        q.push(("scope", self.scope.clone()));
        if let Some(kw) = &self.keyword {
            if !kw.is_empty() {
                q.push(("keyword", kw.clone()));
            }
        }
        q.push(("page", self.page.to_string()));
        q.push(("page_size", self.page_size.to_string()));
        q
    }
}

impl Client {
    /// 客户分页列表（对齐 web `listCustomers`）
    pub async fn crm_customers(&self, params: &CrmListParams) -> Result<CustomerPage, ApiError> {
        let page: CustomerPage = self.get_json(CRM_CUSTOMERS_PATH, &params.query()).await?;
        Ok(page)
    }

    /// 线索分页列表（对齐 web `listLeads`）
    pub async fn crm_leads(&self, params: &CrmListParams) -> Result<LeadPage, ApiError> {
        let page: LeadPage = self.get_json(CRM_LEADS_PATH, &params.query()).await?;
        Ok(page)
    }

    /// 任务分页列表（对齐 web `listTasks`；`type` / `status` 可选白名单值）
    ///
    /// - `task_type`：follow_up/call/visit/custom；None = 全部类型
    /// - `status`：pending/in_progress/done/cancelled；None = 全部状态
    pub async fn crm_tasks(
        &self,
        params: &CrmListParams,
        task_type: Option<&str>,
        status: Option<&str>,
    ) -> Result<TaskPage, ApiError> {
        let mut query = params.query();
        // 后端 sort_by 默认 due_date asc（看板列内即到期序），无需显式传
        if let Some(t) = task_type {
            query.push(("type", t.to_string()));
        }
        if let Some(s) = status {
            query.push(("status", s.to_string()));
        }
        let page: TaskPage = self.get_json(CRM_TASKS_PATH, &query).await?;
        Ok(page)
    }

    /// 任务状态变更（对齐 web `setTaskStatus`；POST /tasks/{id}/status）
    ///
    /// 返回服务端校正后的最新任务（completed_at 等由后端置位）。
    pub async fn crm_set_task_status(
        &self,
        task_id: i64,
        status: &str,
    ) -> Result<TaskItem, ApiError> {
        let path = format!("{CRM_TASKS_PATH}/{task_id}/status");
        let body = serde_json::json!({ "status": status });
        let item: TaskItem = self.request_json(reqwest::Method::POST, &path, &[], Some(&body)).await?;
        Ok(item)
    }

    /// CRM 协作用户列表（负责人下拉数据源；对齐 web `useCrmUsers`）
    pub async fn crm_users(&self) -> Result<Vec<CrmUser>, ApiError> {
        let users: Vec<CrmUser> = self.get_json(CRM_USERS_PATH, &[]).await?;
        Ok(users)
    }
}

#[cfg(test)]
mod crm_list_tests {
    use super::*;

    /// 带会话 client（与主测试模块同款）
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

    #[test]
    fn paths_match_backend_routes() {
        assert_eq!(CRM_CUSTOMERS_PATH, "/api/v1/crm/customers");
        assert_eq!(CRM_LEADS_PATH, "/api/v1/crm/leads");
        assert_eq!(CRM_TASKS_PATH, "/api/v1/crm/tasks");
        assert_eq!(CRM_USERS_PATH, "/api/v1/crm/users");
    }

    #[test]
    fn crm_list_params_default_query_shape() {
        let p = CrmListParams::new();
        let q = p.query();
        assert!(q.contains(&("scope", "all".to_string())));
        assert!(q.contains(&("page", "1".to_string())));
        assert!(!q.iter().any(|(k, _)| *k == "keyword"), "无关键词不带 keyword");
        // 带 keyword 时携带
        let mut p2 = CrmListParams::new();
        p2.keyword = Some("甲".to_string());
        assert!(p2.query().iter().any(|(k, v)| *k == "keyword" && v == "甲"));
    }

    /// mock HTTP：customers 携带 scope/page/page_size 并解析 snake_case 响应
    #[tokio::test]
    async fn crm_customers_sends_query_and_parses() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/crm/customers")
            .match_query(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("scope".into(), "all".into()),
                mockito::Matcher::UrlEncoded("page".into(), "1".into()),
                mockito::Matcher::UrlEncoded("page_size".into(), "100".into()),
            ]))
            .match_header("X-User-Id", "u_1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"items": [{"id": 1, "name": "测试客户", "rating": "A",
                    "status": "active", "owner_id": "u-1", "owner_name": "张三",
                    "created_at": "2026-08-01T10:00:00+08:00",
                    "updated_at": "2026-08-20T10:00:00+08:00"}],
                    "total": 1, "page": 1, "page_size": 100}"#,
            )
            .create();

        let client = session_client(&server.url());
        let resp = client.crm_customers(&CrmListParams::new()).await.expect("请求失败");
        m.assert();
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].owner_name.as_deref(), Some("张三"));
    }

    /// mock HTTP：tasks 携带 type/status 过滤并解析
    #[tokio::test]
    async fn crm_tasks_sends_filters_and_parses() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/crm/tasks")
            .match_query(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("scope".into(), "mine".into()),
                mockito::Matcher::UrlEncoded("type".into(), "follow_up".into()),
                mockito::Matcher::UrlEncoded("status".into(), "pending".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"items": [{"id": 7, "title": "跟进任务", "priority": "high",
                    "status": "pending", "type": "follow_up",
                    "created_at": "2026-08-01T10:00:00+08:00",
                    "updated_at": "2026-08-20T10:00:00+08:00"}],
                    "total": 1, "page": 1, "page_size": 100}"#,
            )
            .create();

        let client = session_client(&server.url());
        let mut params = CrmListParams::new();
        params.scope = "mine".to_string();
        let resp = client
            .crm_tasks(&params, Some("follow_up"), Some("pending"))
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].r#type, "follow_up");
    }
}
