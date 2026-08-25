//! Markdown/HTML 页面渲染领域类型（Stage13，BLF-804）
//!
//! 字段对齐 backend `backend/app/api/v1/endpoints/page_render.py` 的
//! `PageRenderPublic` 响应与 web `page-render-client.tsx` 的 `UploadedPage`。
//!
//! GUI 只读主面消费：历史列表行 + 详情正文（markdown 渲染 / html 源码展示）。

use serde::{Deserialize, Serialize};

/// 一条已分享页面（history 列表行；对齐 web `UploadedPage`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageRenderHistoryItem {
    pub id: String,
    pub title: String,
    /// 来源格式（markdown | html）
    pub source_format: String,
    pub public_url: String,
    pub original_filename: String,
    pub file_size: u64,
    /// 上传时刻（ISO 8601 字符串原样透传）
    pub created_at: String,
}

/// 单页详情（含正文；对齐 backend `PageRenderPublic`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageRenderDetail {
    pub id: String,
    pub title: String,
    /// 来源格式（markdown | html；API client 层从 content_format 映射）
    pub source_format: String,
    pub public_url: String,
    pub original_filename: String,
    pub file_size: u64,
    pub created_at: String,
    /// 正文原文（markdown 正文直接渲染；html 页面展示源码）
    pub content: String,
}

impl PageRenderDetail {
    /// 详情渲染用文本：markdown 直接用；html 落源码原文（TextView markdown
    /// 渲染器按纯文本代码块兜底，不做 html 注入渲染——桌面端安全边界）
    pub fn content_markdown(&self) -> String {
        if self.source_format == "html" {
            format!("```html\n{}\n```", self.content)
        } else {
            self.content.clone()
        }
    }
}
