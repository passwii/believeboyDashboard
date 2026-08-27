//! AI 智能 → AI Chat API（P5-6，BLF-737）
//!
//! 端点对齐 backend `backend/app/api/v1/endpoints/ai_chat.py`（CRUD）与
//! `ai_chat_v2.py`（V2 SSE 流式），与 web 端 Next.js 代理层
//! `frontend/app/api/ai-chat/**/route.ts` 的转发口径一致：
//!
//! - `GET /api/v1/ai/config` → AI 配置（模型列表 / 默认模型 / 超时等）；
//! - `GET|POST /api/v1/ai/conversations` → 会话列表 / 新建；
//! - `DELETE /api/v1/ai/conversations/{id}` → 删除会话（204）；
//! - `GET /api/v1/ai/conversations/{id}/messages` → 历史消息；
//! - `POST /api/v1/ai/conversations/{id}/messages/stream` → **SSE 流式对话**
//!   （Anthropic Messages 协议 + 项目扩展 `done` 事件，见
//!   [`gui_domain::ai_chat::StreamEvent`]；web 消费口径
//!   `frontend/lib/api/ai-chat-stream-v2.ts`）；
//! - `POST /api/v1/ai/conversations/{id}/cancel` → 取消进行中的流
//!   （跨 worker 生效，后端 Redis GETDEL）。
//!
//! ## 流式实现说明（GPUI + reqwest 可行性结论）
//!
//! reqwest 0.12 无需 `stream` feature 即可用 `Response::chunk()` 逐块读
//! 响应体；per-request `.timeout()` 覆盖 client 级 30s 总超时（流式对话
//! 可持续数分钟）。本模块把「HTTP 读块 → SSE 分帧 → JSON 解析」封装为
//! [`Client::ai_stream_message`]，解析出的事件经 `tokio::sync::mpsc`
//! channel 推给调用方（tokio sync 原语不依赖 tokio reactor，可在 GPUI
//! smol executor 上 `recv().await`）。发送端在应用级 tokio runtime
//! （gui-app `runtime()`）上驱动。
//!
//! 未接入（对齐 web 端能力集，GUI v1 精简，见视图模块头注释）：
//! - 会话重命名 `PATCH /conversations/{id}`、标题重生成 `POST /conversations/{id}`；
//! - 消息编辑 / 删除 `PATCH|DELETE .../messages/{messageId}`；
//! - `Last-Event-ID` 断线续传（GUI v1 不做重连）。

use std::time::Duration;

use serde::Serialize;

use gui_domain::ai_chat::{AiChatConfig, AiChatMessageItem, AiConversation, StreamEvent};

use crate::client::Client;
use crate::error::ApiError;

/// 流式请求整体超时兜底（后端 LLM timeout 默认 90~120s，多轮工具调用可更长；
/// 10 分钟足够覆盖正常轮次，防后端异常挂起拖死 UI）
const STREAM_TIMEOUT: Duration = Duration::from_secs(600);

/// `GET /api/v1/ai/config`
pub(crate) const CONFIG_PATH: &str = "/api/v1/ai/config";
/// `GET|POST /api/v1/ai/conversations`
pub(crate) const CONVERSATIONS_PATH: &str = "/api/v1/ai/conversations";
/// cancel 子路径（前缀拼接）
pub(crate) const CANCEL_PATH_SUFFIX: &str = "/cancel";
/// messages 子路径（前缀拼接）
pub(crate) const MESSAGES_PATH_SUFFIX: &str = "/messages";

/// 发送消息请求体（backend `MessageCreate` 子集——GUI v1 只消费
/// content / model / enable_web_search / regenerate；其余字段后端有默认值，
/// 不序列化）
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct AiChatMessageCreate {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 场景化 system prompt（客服交流等；空串 = 后端默认。backend
    /// `MessageCreate.system_prompt` 字段，web 代理层由场景预设拼装）
    #[serde(default = "String::new", skip_serializing_if = "String::is_empty")]
    pub system_prompt: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub regenerate: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub enable_web_search: bool,
}

/// 单条 SSE 帧（分帧产物）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    /// `id:` 行（Last-Event-ID 续传用；GUI v1 不消费）
    pub id: Option<String>,
    /// `data:` 行内容（多行 data 以 `\n` 连接）
    pub data: String,
}

/// 解析一块 SSE 文本为帧序列 + 余量（半帧留待下块拼接）。
///
/// 与 web 端 `parseSSEChunk`（frontend/lib/api/ai-chat-stream-v2.ts）同口径：
/// 事件以空行（`\n\n`）分隔；`id:` / `data:` 行提取，其余字段忽略；
/// 容忍行尾 `\r`。无数据的帧跳过。
pub fn parse_sse_chunk(buffer: &str) -> (Vec<SseFrame>, String) {
    // 统一换行：容忍 \r\n（部分代理 / 调试工具会改写行尾）
    let buffer = buffer.replace("\r\n", "\n");
    let mut frames = Vec::new();
    // 最后一个 "\n\n" 之后的内容是半帧（还没有结尾空行），留待下块拼接
    let (complete, remaining) = match buffer.rfind("\n\n") {
        Some(pos) => (&buffer[..pos], buffer[pos + 2..].to_string()),
        None => ("", buffer),
    };

    for part in complete.split("\n\n") {
        if part.trim().is_empty() {
            continue;
        }
        let mut id: Option<String> = None;
        let mut data_lines: Vec<&str> = Vec::new();
        for line in part.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if let Some(rest) = line.strip_prefix("id:") {
                id = Some(rest.trim().to_string());
            } else if let Some(rest) = line.strip_prefix("data:") {
                data_lines.push(rest.strip_prefix(' ').unwrap_or(rest));
            }
            // event: / retry: / 注释行（: 开头）忽略
        }
        let data = data_lines.join("\n");
        if !data.is_empty() {
            frames.push(SseFrame { id, data });
        }
    }

    (frames, remaining)
}

impl Client {
    /// AI 配置（模型列表 / 默认模型 / provider 是否配置等）
    pub async fn ai_chat_config(&self) -> Result<AiChatConfig, ApiError> {
        self.get_json(CONFIG_PATH, &[]).await
    }

    /// 会话列表（后端按 updated_at 倒序）
    pub async fn ai_conversation_list(&self) -> Result<Vec<AiConversation>, ApiError> {
        self.get_json(CONVERSATIONS_PATH, &[]).await
    }

    /// 新建会话（title 可空——后端首轮流结束后自动生成标题）
    pub async fn ai_conversation_create(
        &self,
        title: Option<String>,
    ) -> Result<AiConversation, ApiError> {
        #[derive(Serialize)]
        struct Body {
            #[serde(skip_serializing_if = "Option::is_none")]
            title: Option<String>,
        }
        self.request_json(
            reqwest::Method::POST,
            CONVERSATIONS_PATH,
            &[],
            Some(&Body { title }),
        )
        .await
    }

    /// 删除会话（204 空响应体）
    pub async fn ai_conversation_delete(&self, conversation_id: i64) -> Result<(), ApiError> {
        let path = format!("{CONVERSATIONS_PATH}/{conversation_id}");
        self.request_discard::<AiChatMessageCreate>(reqwest::Method::DELETE, &path, &[], None)
            .await
    }

    /// 历史消息（按 created_at 正序）
    pub async fn ai_message_list(
        &self,
        conversation_id: i64,
    ) -> Result<Vec<AiChatMessageItem>, ApiError> {
        let path = format!("{CONVERSATIONS_PATH}/{conversation_id}{MESSAGES_PATH_SUFFIX}");
        self.get_json(&path, &[]).await
    }

    /// 取消进行中的流式对话（跨 worker 生效；取消失败不影响 UI——流可能已结束）
    pub async fn ai_stream_cancel(&self, conversation_id: i64) -> Result<(), ApiError> {
        let path = format!("{CONVERSATIONS_PATH}/{conversation_id}{CANCEL_PATH_SUFFIX}");
        self.request_discard::<AiChatMessageCreate>(reqwest::Method::POST, &path, &[], None)
            .await
    }

    /// V2 SSE 流式对话：发送一条消息并消费流，解析出的事件逐个推入 `tx`。
    ///
    /// 通道契约：
    /// - `Ok(event)`：协议事件（text_delta / tool_use / done 等）；
    /// - `Err(message)`：终态错误（HTTP 非 2xx / 网络中断 / 流提前结束），
    ///   推送后立即返回；
    /// - 全部事件推完（含 `done`）后通道关闭（tx drop）。
    ///
    /// 返回值仅表示 HTTP 层是否成功建立（非 2xx 已作为 `Err` 推入通道）。
    pub async fn ai_stream_message(
        &self,
        conversation_id: i64,
        payload: &AiChatMessageCreate,
        tx: tokio::sync::mpsc::UnboundedSender<Result<StreamEvent, String>>,
    ) -> Result<(), ApiError> {
        let path = format!("{CONVERSATIONS_PATH}/{conversation_id}/messages/stream");
        let mut resp = match self
            .request_stream(
                reqwest::Method::POST,
                &path,
                &[],
                Some(payload),
                "text/event-stream",
                STREAM_TIMEOUT,
            )
            .await
        {
            Ok(resp) => resp,
            Err(e) => {
                let _ = tx.send(Err(e.user_message()));
                return Err(e);
            }
        };

        let mut buffer = String::new();
        let mut saw_terminal = false;
        loop {
            match resp.chunk().await {
                Ok(Some(bytes)) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));
                    let (frames, remaining) = parse_sse_chunk(&buffer);
                    buffer = remaining;
                    for frame in frames {
                        match serde_json::from_str::<serde_json::Value>(&frame.data) {
                            Ok(value) => {
                                if let Some(event) = StreamEvent::from_json(&value) {
                                    if matches!(event, StreamEvent::Done(_) | StreamEvent::Error(_))
                                    {
                                        saw_terminal = true;
                                    }
                                    if tx.send(Ok(event)).is_err() {
                                        // 接收端已丢弃（用户停止 / 视图销毁）→ 中断读取
                                        return Ok(());
                                    }
                                }
                                // StreamEvent::None（缺 type）→ 跳过该帧
                            }
                            Err(_) => continue, // 非 JSON 帧 → 跳过（对齐 web）
                        }
                    }
                }
                Ok(None) => break, // 流结束
                Err(e) => {
                    let _ = tx.send(Err(format!("流式连接中断：{e}")));
                    return Ok(());
                }
            }
        }

        // 流正常结束但从未收到 done / error → 提示（对齐 web「流式响应提前结束」）
        if !saw_terminal {
            let _ = tx.send(Err("流式响应提前结束".into()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gui_domain::ai_chat::StreamDelta;
    use mockito::Matcher;

    /// 构造一个带会话的 client（与 exchange_rate.rs 同款）
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
        Client::new(base_url)
            .with_session(session)
            .with_api_key("k123")
    }

    // ---------- 契约测试 ----------

    #[test]
    fn paths_match_backend_routes() {
        assert_eq!(CONFIG_PATH, "/api/v1/ai/config");
        assert_eq!(CONVERSATIONS_PATH, "/api/v1/ai/conversations");
        assert_eq!(CANCEL_PATH_SUFFIX, "/cancel");
        assert_eq!(MESSAGES_PATH_SUFFIX, "/messages");
    }

    #[test]
    fn message_create_serializes_gui_v1_subset() {
        let payload = AiChatMessageCreate {
            content: "你好".into(),
            model: Some("believeboy-flash".into()),
            system_prompt: String::new(),
            regenerate: false,
            enable_web_search: true,
        };
        let json = serde_json::to_value(&payload).expect("序列化失败");
        assert_eq!(
            json,
            serde_json::json!({
                "content": "你好",
                "model": "believeboy-flash",
                "enable_web_search": true
            })
        );

        let minimal = AiChatMessageCreate::default();
        let json = serde_json::to_value(&minimal).expect("序列化失败");
        assert_eq!(json, serde_json::json!({"content": ""}));
    }

    // ---------- SSE 分帧解析 ----------

    #[test]
    fn parse_sse_chunk_splits_events_and_keeps_remainder() {
        let (frames, rest) = parse_sse_chunk(
            "id: 1\ndata: {\"a\":1}\n\nid: 2\ndata: {\"b\":2}\n\nid: 3\ndata: {\"par",
        );
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].id.as_deref(), Some("1"));
        assert_eq!(frames[0].data, "{\"a\":1}");
        assert_eq!(frames[1].id.as_deref(), Some("2"));
        assert_eq!(rest, "id: 3\ndata: {\"par");
    }

    #[test]
    fn parse_sse_chunk_joins_multiline_data_and_tolerates_crlf() {
        let (frames, _) =
            parse_sse_chunk("data: line1\r\ndata: line2\r\n\r\n:event x\ndata: y\n\n");
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].data, "line1\nline2");
        assert_eq!(frames[0].id, None);
        // event: 字段被忽略，data 仍提取
        assert_eq!(frames[1].data, "y");
    }

    #[test]
    fn parse_sse_chunk_skips_empty_and_comment_frames() {
        let (frames, _) = parse_sse_chunk(": keepalive\n\n\n\ndata: {\"x\":1}\n\n");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data, "{\"x\":1}");
    }

    #[test]
    fn parse_sse_chunk_empty_buffer_yields_nothing() {
        let (frames, rest) = parse_sse_chunk("");
        assert!(frames.is_empty());
        assert_eq!(rest, "");
    }

    // ---------- CRUD mock HTTP ----------

    #[tokio::test]
    async fn config_parses_backend_response() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", CONFIG_PATH)
            .match_header("Authorization", "Bearer k123")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                    "provider_configured": true, "web_search_configured": true,
                    "models": ["believeboy-flash"], "default_model": "believeboy-flash",
                    "premium_models": [], "basic_models": [], "reasoning_models": [],
                    "default_reasoning_effort": "medium", "timeout_seconds": 120,
                    "max_conversation_turns": 10, "web_search_max_results": 5
                }"#,
            )
            .create();

        let client = session_client(&server.url());
        let cfg = client.ai_chat_config().await.expect("请求失败");
        m.assert();
        assert!(cfg.provider_configured);
        assert_eq!(cfg.default_model, "believeboy-flash");
    }

    #[tokio::test]
    async fn conversation_list_parses_array() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", CONVERSATIONS_PATH)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"[{"id": 7, "title": "新对话",
                     "created_at": "2026-08-21T00:00:00+00:00",
                     "updated_at": "2026-08-21T01:00:00+00:00",
                     "total_tokens": 42}]"#,
            )
            .create();

        let client = session_client(&server.url());
        let list = client.ai_conversation_list().await.expect("请求失败");
        m.assert();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, 7);
        assert_eq!(list[0].total_tokens, 42);
    }

    #[tokio::test]
    async fn conversation_create_posts_title_and_parses_item() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", CONVERSATIONS_PATH)
            .match_body(Matcher::PartialJson(
                serde_json::json!({"title": "测试会话"}),
            ))
            .with_status(201)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"id": 9, "title": "测试会话",
                    "created_at": "2026-08-21T00:00:00+00:00",
                    "updated_at": "2026-08-21T00:00:00+00:00"}"#,
            )
            .create();

        let client = session_client(&server.url());
        let conv = client
            .ai_conversation_create(Some("测试会话".into()))
            .await
            .expect("请求失败");
        m.assert();
        assert_eq!(conv.id, 9);
    }

    #[tokio::test]
    async fn conversation_delete_handles_204() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("DELETE", "/api/v1/ai/conversations/9")
            .with_status(204)
            .create();

        let client = session_client(&server.url());
        client.ai_conversation_delete(9).await.expect("请求失败");
        m.assert();
    }

    #[tokio::test]
    async fn message_list_parses_history() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/v1/ai/conversations/7/messages")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"[{"id": 1, "conversation_id": 7, "role": "user", "content": "hi",
                     "search_sources": [], "is_complete": true,
                     "created_at": "2026-08-21T00:00:00+00:00"},
                    {"id": 2, "conversation_id": 7, "role": "assistant", "content": "hello",
                     "search_sources": [{"title": "s", "url": "https://x"}],
                     "total_tokens": 9, "duration_ms": 800,
                     "created_at": "2026-08-21T00:00:01+00:00"}]"#,
            )
            .create();

        let client = session_client(&server.url());
        let msgs = client.ai_message_list(7).await.expect("请求失败");
        m.assert();
        assert_eq!(msgs.len(), 2);
        assert!(!msgs[0].is_assistant());
        assert!(msgs[1].is_assistant());
        assert_eq!(msgs[1].search_sources.len(), 1);
    }

    #[tokio::test]
    async fn stream_cancel_posts_and_ignores_body() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", "/api/v1/ai/conversations/7/cancel")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"cancelled": true}"#)
            .create();

        let client = session_client(&server.url());
        client.ai_stream_cancel(7).await.expect("请求失败");
        m.assert();
    }

    // ---------- 流式 mock HTTP ----------

    /// SSE 流：两个 text_delta + done 事件分两块到达 → 事件按序推入通道，
    /// 通道以 None（关闭）结束
    #[tokio::test]
    async fn stream_message_pushes_parsed_events_in_order() {
        let mut server = mockito::Server::new_async().await;
        let body1 = "id: 100\ndata: {\"type\":\"message_start\",\"message_id\":\"m1\",\"model\":\"flash\"}\n\n\
                     id: 101\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"你\"}}\n\n";
        let body2 = "id: 102\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"好\"}}\n\n\
                     id: 103\ndata: {\"type\":\"done\",\"user_message\":{\"id\":1,\"conversation_id\":7,\"role\":\"user\",\"content\":\"hi\",\"created_at\":\"2026-08-21T00:00:00+00:00\"},\"assistant_message\":{\"id\":2,\"conversation_id\":7,\"role\":\"assistant\",\"content\":\"你好\",\"created_at\":\"2026-08-21T00:00:01+00:00\"},\"token_usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5},\"duration_ms\":900,\"title_regenerated\":false}\n\n";
        let m = server
            .mock("POST", "/api/v1/ai/conversations/7/messages/stream")
            .match_header("Accept", "text/event-stream")
            .match_header("Authorization", "Bearer k123")
            .match_body(Matcher::PartialJson(serde_json::json!({"content": "hi"})))
            .with_status(200)
            .with_header("content-type", "text/event-stream; charset=utf-8")
            .with_body(format!("{body1}{body2}"))
            .create();

        let client = session_client(&server.url());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let payload = AiChatMessageCreate {
            content: "hi".into(),
            ..Default::default()
        };
        client
            .ai_stream_message(7, &payload, tx)
            .await
            .expect("流式请求失败");
        m.assert();

        let mut events = Vec::new();
        while let Ok(item) = rx.try_recv() {
            events.push(item.expect("不应有错误事件"));
        }
        assert_eq!(events.len(), 4, "start + 2 delta + done");
        assert!(matches!(events[0], StreamEvent::MessageStart { .. }));
        match &events[1] {
            StreamEvent::ContentBlockDelta { delta } => {
                assert_eq!(
                    *delta,
                    StreamDelta {
                        kind: "text_delta".into(),
                        text: "你".into(),
                        partial_json: String::new()
                    }
                );
            }
            other => panic!("应为 text delta：{other:?}"),
        }
        match &events[3] {
            StreamEvent::Done(payload) => {
                assert!(payload.user_message.is_some() && payload.assistant_message.is_some());
                assert_eq!(payload.token_usage.map(|u| u.total_tokens), Some(5));
            }
            other => panic!("应为 done：{other:?}"),
        }
    }

    /// HTTP 非 2xx → 错误消息推入通道（detail 透传）
    #[tokio::test]
    async fn stream_message_propagates_http_error_into_channel() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", "/api/v1/ai/conversations/404/messages/stream")
            .with_status(404)
            .with_header("content-type", "application/json")
            .with_body(r#"{"detail":"Conversation not found"}"#)
            .create();

        let client = Client::new(server.url()).with_api_key("k123");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let payload = AiChatMessageCreate::default();
        let result = client.ai_stream_message(404, &payload, tx).await;
        assert!(result.is_err(), "HTTP 层应返回 Err");
        let msg = rx
            .try_recv()
            .expect("错误应推入通道")
            .expect_err("应为 Err");
        assert_eq!(msg, "Conversation not found");
        m.assert();
    }

    /// 非 JSON 帧 / 缺 type 帧 / ping 被正确处理（ping 推入、坏帧跳过）
    #[tokio::test]
    async fn stream_message_skips_malformed_frames() {
        let mut server = mockito::Server::new_async().await;
        let body = "data: not-json\n\n\
                    data: {\"no_type\": 1}\n\n\
                    data: {\"type\":\"ping\"}\n\n";
        let m = server
            .mock("POST", "/api/v1/ai/conversations/7/messages/stream")
            .with_status(200)
            .with_header("content-type", "text/event-stream")
            .with_body(body)
            .create();

        let client = session_client(&server.url());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        client
            .ai_stream_message(7, &AiChatMessageCreate::default(), tx)
            .await
            .expect("流式请求失败");
        m.assert();

        let mut events = Vec::new();
        while let Ok(item) = rx.try_recv() {
            events.push(item);
        }
        assert_eq!(events.len(), 2, "ping + 流结束错误");
        assert_eq!(events[0], Ok(StreamEvent::Ping));
        assert_eq!(events[1], Err("流式响应提前结束".into()));
    }

    /// 接收端提前丢弃（用户停止）→ 发送失败即中断读取，不 panic 不阻塞
    #[tokio::test]
    async fn stream_message_stops_when_receiver_dropped() {
        let mut server = mockito::Server::new_async().await;
        let body = "data: {\"type\":\"ping\"}\n\ndata: {\"type\":\"ping\"}\n\n";
        let m = server
            .mock("POST", "/api/v1/ai/conversations/7/messages/stream")
            .with_status(200)
            .with_header("content-type", "text/event-stream")
            .with_body(body)
            .create();

        let client = session_client(&server.url());
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        drop(rx);
        let result = client
            .ai_stream_message(7, &AiChatMessageCreate::default(), tx)
            .await;
        assert!(result.is_ok(), "接收端丢弃应静默中断而非报错");
        m.assert();
    }
}
