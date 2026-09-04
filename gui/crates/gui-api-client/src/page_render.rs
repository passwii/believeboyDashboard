//! Markdown/HTML 页面渲染（page-render）API（Stage13，BLF-804）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/page_render.py`
//!（prefix `/page-render`，history 公开、详情公开；上传/删除走 web 端）：
//! - `GET /api/v1/page-render/history?limit=50` → 已分享页面列表
//! - `GET /api/v1/page-render/{id}` → 单页正文
//!
//! GUI 只读主面：上传与删除写链路不移植（模块头注明，PR 说明）。

use gui_domain::page_render::{PageRenderDetail, PageRenderHistoryItem};
use serde::Deserialize;

use crate::client::Client;
use crate::error::ApiError;

/// `GET /page-render/history`
pub(crate) const PAGE_RENDER_HISTORY_PATH: &str = "/api/v1/page-render/history";

/// history 响应原始形状（backend 返回 `{pages: [...], total}`）
#[derive(Debug, Deserialize)]
struct PageRenderHistoryResponse {
    #[serde(default)]
    pages: Vec<PageRenderHistoryItem>,
}

/// detail 响应原始形状（backend `PageRenderPublic`：id/title/content_format/
/// content/public_url/original_filename/file_size/created_at）
#[derive(Debug, Deserialize)]
pub struct PageRenderDetailRaw {
    pub id: String,
    pub title: String,
    pub content_format: String,
    pub content: String,
    pub public_url: String,
    pub original_filename: String,
    pub file_size: u64,
    pub created_at: String,
}

impl From<PageRenderDetailRaw> for PageRenderDetail {
    fn from(raw: PageRenderDetailRaw) -> Self {
        Self {
            id: raw.id,
            title: raw.title,
            source_format: raw.content_format,
            public_url: raw.public_url,
            original_filename: raw.original_filename,
            file_size: raw.file_size,
            created_at: raw.created_at,
            content: raw.content,
        }
    }
}

impl Client {
    /// 已分享页面历史列表（对齐 web `loadHistory`，limit=50 同口径）
    pub async fn page_render_history(&self) -> Result<Vec<PageRenderHistoryItem>, ApiError> {
        let resp: PageRenderHistoryResponse = self
            .get_json(PAGE_RENDER_HISTORY_PATH, &[("limit", "50".to_string())])
            .await?;
        Ok(resp.pages)
    }

    /// 单页正文（markdown 渲染 / html 源码展示共用）
    pub async fn page_render_detail(&self, id: &str) -> Result<PageRenderDetail, ApiError> {
        let path = format!("/api/v1/page-render/{id}");
        let raw: PageRenderDetailRaw = self.get_json(&path, &[]).await?;
        Ok(raw.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// Stage13 路由契约：history 路径与 backend router prefix 对齐
    #[test]
    fn page_render_paths_match_backend_routes() {
        assert_eq!(PAGE_RENDER_HISTORY_PATH, "/api/v1/page-render/history");
    }

    /// history 响应解析：pages 数组 + snake_case 字段映射
    #[test]
    fn page_render_history_parses_snake_case() {
        let payload = r#"{
            "pages": [
                {
                    "id": "p1",
                    "title": "使用说明",
                    "source_format": "markdown",
                    "public_url": "https://example.com/s/p1",
                    "original_filename": "guide.md",
                    "file_size": 2048,
                    "created_at": "2026-08-25T10:00:00+08:00"
                }
            ],
            "total": 1
        }"#;
        let parsed: PageRenderHistoryResponse = serde_json::from_str(payload).expect("解析失败");
        assert_eq!(parsed.pages.len(), 1);
        assert_eq!(parsed.pages[0].title, "使用说明");
        assert_eq!(parsed.pages[0].source_format, "markdown");
        // client 构造路径可达（与主测试模块同款 session client）
        let _client = session_client("http://127.0.0.1:1");
    }

    /// detail 响应解析：content_format → source_format 映射 + 正文透传
    #[test]
    fn page_render_detail_raw_maps_to_domain() {
        let payload = r#"{
            "id": "p2",
            "title": "HTML 页面",
            "content_format": "html",
            "content": "<h1>hello</h1>",
            "public_url": "https://example.com/s/p2",
            "original_filename": "page.html",
            "file_size": 4096,
            "created_at": "2026-08-25T11:00:00+08:00"
        }"#;
        let raw: PageRenderDetailRaw = serde_json::from_str(payload).expect("解析失败");
        let detail: PageRenderDetail = raw.into();
        assert_eq!(detail.id, "p2");
        assert_eq!(detail.source_format, "html");
        assert_eq!(detail.content, "<h1>hello</h1>");
    }
}
