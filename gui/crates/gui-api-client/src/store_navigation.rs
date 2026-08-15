//! 店铺导航 API（BLF-714，P5-1）
//!
//! frontend `app/dashboard/operations/store-navigation/page.tsx` 的数据源：
//! `fetchManagedProjectsCached` → `GET /api/v1/projects/manage`（按 `X-Operator` /
//! `X-Is-Admin` 上下文头过滤当前用户可见项目，即「店铺维度入口」）。
//!
//! 与 Dashboard 首页项目列表**同源**（`dashboard.rs` 的 `MANAGED_PROJECTS_PATH`）——
//! 店铺导航消费 `ManagedProject` 的 id / name / brand_name / store_address 四个字段，
//! 因此不新增 HTTP 表面，本模块是店铺导航的语义入口（对齐每棒一个 api-client 模块
//! 的约定），复用同一路径常量避免端点漂移。
//!
//! 鉴权：`Client` 持有会话时自动携带 `X-User-Id` / `X-User-Email` / `X-Session-Id`
//! 与上下文头；`with_api_key` 时附 `Authorization: Bearer`（生产 dashboard 路由
//! `require_api_key`，见 client.rs / README `BELIEVEBOY_TOKEN`）。

use gui_domain::common::ManagedProject;

use crate::client::Client;
use crate::dashboard::MANAGED_PROJECTS_PATH;
use crate::error::ApiError;

impl Client {
    /// 店铺导航数据源：当前用户可管理的项目列表（每张店铺卡片 = 一个项目）
    pub async fn list_store_navigation(&self) -> Result<Vec<ManagedProject>, ApiError> {
        self.get_json(MANAGED_PROJECTS_PATH, &[]).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Matcher;

    /// 构造一个带会话的 client（会话 header 断言用；与 dashboard.rs 测试同款）
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

    /// 契约测试：店铺导航与 Dashboard 项目列表同源（`/projects/manage`，非
    /// `/projects/managed`）——路径常量直接引用 dashboard.rs，防端点漂移。
    #[test]
    fn store_navigation_shares_managed_projects_endpoint() {
        assert_eq!(MANAGED_PROJECTS_PATH, "/api/v1/projects/manage");
    }

    /// mock HTTP：请求命中 `/api/v1/projects/manage`，携带会话身份头 + 上下文头
    /// （X-Operator 决定可见店铺范围），响应按 ManagedProject 解析出店铺字段。
    #[tokio::test]
    async fn list_store_navigation_sends_session_headers_and_parses_stores() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", MANAGED_PROJECTS_PATH)
            .match_header("X-User-Id", "u_1")
            .match_header("X-User-Email", "demo@believeboy.com")
            .match_header("X-Session-Id", "sess_1")
            .match_header("X-User-Name", "%E6%B5%8B%E8%AF%95")
            .match_header("X-Operator", "%E6%B5%8B%E8%AF%95%E8%BF%90%E8%90%A5")
            .match_header("X-Role-Type", "operator")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"[
                    {"id": 1, "name": "店铺 A", "brand_name": "BelieveBoy",
                     "store_address": "https://sellercentral.amazon.com/1",
                     "sort_order": 1, "is_active": true},
                    {"id": 2, "name": "店铺 B", "brand_name": null,
                     "store_address": null, "sort_order": 2, "is_active": true}
                ]"#,
            )
            .create();

        let client = session_client(&server.url());
        let stores = client.list_store_navigation().await.expect("请求失败");

        m.assert();
        assert_eq!(stores.len(), 2);
        assert_eq!(stores[0].id, 1);
        assert_eq!(stores[0].name, "店铺 A");
        assert_eq!(stores[0].brand_name.as_deref(), Some("BelieveBoy"));
        assert_eq!(
            stores[0].store_address.as_deref(),
            Some("https://sellercentral.amazon.com/1")
        );
        // 缺省字段（brand_name / store_address）容忍反序列化
        assert_eq!(stores[1].brand_name, None);
        assert_eq!(stores[1].store_address, None);
    }

    /// 未认证（401）→ ApiError::Unauthenticated（会话过期时页面进入错误态）
    #[tokio::test]
    async fn unauthenticated_response_maps_to_unauthenticated_error() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", MANAGED_PROJECTS_PATH)
            .with_status(401)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"Invalid or expired session"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .list_store_navigation()
            .await
            .expect_err("应返回错误");

        m.assert();
        assert!(matches!(err, ApiError::Unauthenticated(_)));
        assert!(err.is_unauthorized());
        assert_eq!(err.user_message(), "Invalid or expired session");
    }

    /// 服务端 500 → detail 透传（店铺列表加载失败提示）
    #[tokio::test]
    async fn server_error_passes_through_detail_message() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", MANAGED_PROJECTS_PATH)
            .match_query(Matcher::Any)
            .with_status(500)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"internal error"}"#)
            .create();

        let client = Client::new(server.url());
        let err = client
            .list_store_navigation()
            .await
            .expect_err("应返回错误");

        m.assert();
        assert_eq!(err.status(), Some(500));
        assert!(!err.is_unauthorized());
        assert_eq!(err.user_message(), "internal error");
    }
}
