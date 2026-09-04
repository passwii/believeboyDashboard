//! AI Chat 领域类型（P5-6，BLF-737）
//!
//! AI 智能 → AI Chat。字段对齐 backend `backend/app/schemas/ai_chat.py`
//! （`ConversationItem` / `MessageItem` / `AIChatConfigResponse`）与
//! `ai_chat_v2.py` 的 SSE 流协议（Anthropic Messages 协议 + 项目扩展
//! `done` 事件），消费口径与 web 端
//! `frontend/lib/api/ai-chat-stream-v2.ts` 一致。
//!
//! 口径说明：
//! - `created_at` 等时间戳：后端 datetime 序列化字符串，视图层原样展示；
//! - `search_sources`：后端 `list[dict[str, str | float | None]]`，GUI v1
//!   不渲染来源卡片，保留原始 JSON（`serde_json::Value`）不丢数据；
//! - SSE 事件解析走 [`StreamEvent::from_json`]：未知 `type` 容忍为
//!   [`StreamEvent::Unknown`]（与 web 端「未知事件忽略」前向兼容一致），
//!   已知事件缺字段用 `#[serde(default)]` 容错。

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 会话 / 消息 / 配置（backend schemas/ai_chat.py 1:1）
// ---------------------------------------------------------------------------

/// 会话（backend `ConversationItem`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiConversation {
    pub id: i64,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub total_prompt_tokens: i64,
    #[serde(default)]
    pub total_completion_tokens: i64,
    #[serde(default)]
    pub total_tokens: i64,
}

/// 消息（backend `MessageItem`；`search_sources` 保留原始 JSON）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiChatMessageItem {
    pub id: i64,
    pub conversation_id: i64,
    /// `"user"` | `"assistant"`（backend str 字段，视图层按字面量判断）
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub search_sources: Vec<serde_json::Value>,
    #[serde(default)]
    pub search_time_range: Option<String>,
    #[serde(default = "default_true")]
    pub is_complete: bool,
    #[serde(default)]
    pub prompt_tokens: i64,
    #[serde(default)]
    pub completion_tokens: i64,
    #[serde(default)]
    pub total_tokens: i64,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    pub created_at: String,
}

fn default_true() -> bool {
    true
}

impl AiChatMessageItem {
    /// 是否助手消息（backend role == "assistant"）
    pub fn is_assistant(&self) -> bool {
        self.role == "assistant"
    }
}

/// AI 配置（backend `AIChatConfigResponse`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiChatConfig {
    pub provider_configured: bool,
    pub web_search_configured: bool,
    #[serde(default)]
    pub models: Vec<String>,
    pub default_model: String,
    #[serde(default)]
    pub premium_models: Vec<String>,
    #[serde(default)]
    pub basic_models: Vec<String>,
    #[serde(default)]
    pub reasoning_models: Vec<String>,
    #[serde(default = "default_reasoning_effort")]
    pub default_reasoning_effort: String,
    pub timeout_seconds: i64,
    #[serde(default = "default_max_turns")]
    pub max_conversation_turns: i64,
    #[serde(default = "default_web_search_max_results")]
    pub web_search_max_results: i64,
}

fn default_reasoning_effort() -> String {
    "medium".to_string()
}

fn default_max_turns() -> i64 {
    10
}

fn default_web_search_max_results() -> i64 {
    5
}

// ---------------------------------------------------------------------------
// V2 SSE 流协议（Anthropic Messages + 项目扩展 done；对齐 ai-chat-stream-v2.ts）
// ---------------------------------------------------------------------------

/// 流式用量（backend `message_delta.usage` / `done.token_usage`）
///
/// 后端两种载荷字段名不同：`message_delta.usage` 发 Anthropic 形
/// `input_tokens`/`output_tokens`（events.py Usage），`done.token_usage` 发
/// OpenAI 形 `prompt_tokens`/`completion_tokens`（schemas/ai_chat.py TokenUsage）。
/// 与 web 端 normalizeV2Usage（ai-chat-stream-v2.ts）对齐，此处用 serde alias
/// 统一接收两种命名。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct StreamUsage {
    #[serde(default, alias = "input_tokens")]
    pub prompt_tokens: i64,
    #[serde(default, alias = "output_tokens")]
    pub completion_tokens: i64,
    #[serde(default)]
    pub total_tokens: i64,
}

/// 内容块类型（`content_block_start.content_block`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContentBlock {
    /// `"text"` | `"thinking"` | `"tool_use"` | `"tool_result"`
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub thinking: String,
    /// tool_use 块的调用名（联网搜索等）
    #[serde(default)]
    pub name: String,
}

/// 增量 delta 类型（`content_block_delta.delta`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StreamDelta {
    /// `"text_delta"` | `"thinking_delta"` | `"input_json_delta"`
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub partial_json: String,
}

/// 错误体（`error.error`）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamErrorBody {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub message: String,
}

/// `done` 事件载荷（项目扩展：持久化后的消息数据，backend `StreamDoneResponse`；
/// 字段缺省容忍——resume 路径可能缺部分字段）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct StreamDonePayload {
    #[serde(default)]
    pub user_message: Option<AiChatMessageItem>,
    #[serde(default)]
    pub assistant_message: Option<AiChatMessageItem>,
    #[serde(default)]
    pub conversation_title: Option<String>,
    #[serde(default)]
    pub token_usage: Option<StreamUsage>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub title_regenerated: bool,
}

/// V2 SSE 协议事件（解析产物；未知 type → [`StreamEvent::Unknown`] 前向兼容）
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    /// `message_start`：一轮对话开始
    MessageStart { message_id: String, model: String },
    /// `content_block_start`：新内容块（tool_use → 联网搜索开始）
    ContentBlockStart { block: ContentBlock },
    /// `content_block_delta`：增量（text_delta / thinking_delta）
    ContentBlockDelta { delta: StreamDelta },
    /// `content_block_stop`：内容块结束
    ContentBlockStop,
    /// `message_delta`：用量 + stop_reason
    MessageDelta { usage: Option<StreamUsage> },
    /// `message_stop`：流终止标记（载荷由 done 承载）
    MessageStop,
    /// `error`：终态错误
    Error(StreamErrorBody),
    /// `ping`：keepalive（忽略）
    Ping,
    /// `done`（项目扩展）：持久化消息数据
    Done(Box<StreamDonePayload>),
    /// 未知事件类型（前向兼容，忽略）
    Unknown(String),
}

impl StreamEvent {
    /// 从 SSE `data:` JSON 解析事件。未知 `type` 返回 [`StreamEvent::Unknown`]；
    /// 非 JSON / 缺 `type` 返回 `None`（调用方跳过该帧，与 web 端一致）。
    pub fn from_json(value: &serde_json::Value) -> Option<Self> {
        let kind = value.get("type")?.as_str()?.to_string();
        let event = match kind.as_str() {
            "message_start" => StreamEvent::MessageStart {
                message_id: value
                    .get("message_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                model: value
                    .get("model")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
            },
            "content_block_start" => StreamEvent::ContentBlockStart {
                block: value
                    .get("content_block")
                    .cloned()
                    .and_then(|b| serde_json::from_value(b).ok())
                    .unwrap_or(ContentBlock {
                        kind: "text".into(),
                        text: String::new(),
                        thinking: String::new(),
                        name: String::new(),
                    }),
            },
            "content_block_delta" => StreamEvent::ContentBlockDelta {
                delta: value
                    .get("delta")
                    .cloned()
                    .and_then(|d| serde_json::from_value(d).ok())
                    .unwrap_or(StreamDelta {
                        kind: "text_delta".into(),
                        text: String::new(),
                        partial_json: String::new(),
                    }),
            },
            "content_block_stop" => StreamEvent::ContentBlockStop,
            "message_delta" => StreamEvent::MessageDelta {
                usage: value
                    .get("usage")
                    .filter(|u| !u.is_null())
                    .and_then(|u| serde_json::from_value(u.clone()).ok()),
            },
            "message_stop" => StreamEvent::MessageStop,
            "error" => StreamEvent::Error(
                value
                    .get("error")
                    .cloned()
                    .and_then(|e| serde_json::from_value(e).ok())
                    .unwrap_or(StreamErrorBody {
                        code: "unknown".into(),
                        message: "流式错误".into(),
                    }),
            ),
            "ping" => StreamEvent::Ping,
            "done" => StreamEvent::Done(Box::new(
                serde_json::from_value(value.clone()).unwrap_or_default(),
            )),
            other => StreamEvent::Unknown(other.to_string()),
        };
        Some(event)
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- CRUD 模型 serde 契约 ----------

    #[test]
    fn conversation_parses_backend_shape() {
        let json = serde_json::json!({
            "id": 7, "title": "新对话",
            "created_at": "2026-08-21T00:00:00+00:00",
            "updated_at": "2026-08-21T01:00:00+00:00",
            "total_prompt_tokens": 120, "total_completion_tokens": 456,
            "total_tokens": 576
        });
        let conv: AiConversation = serde_json::from_value(json).expect("解析失败");
        assert_eq!(conv.id, 7);
        assert_eq!(conv.total_tokens, 576);
    }

    #[test]
    fn conversation_tolerates_missing_token_fields() {
        let json = serde_json::json!({
            "id": 1, "title": "t",
            "created_at": "2026-08-21T00:00:00+00:00",
            "updated_at": "2026-08-21T00:00:00+00:00"
        });
        let conv: AiConversation = serde_json::from_value(json).expect("解析失败");
        assert_eq!(conv.total_tokens, 0);
    }

    #[test]
    fn message_item_defaults_and_role_helper() {
        let json = serde_json::json!({
            "id": 3, "conversation_id": 1, "role": "assistant",
            "content": "你好", "created_at": "2026-08-21T00:00:00+00:00"
        });
        let msg: AiChatMessageItem = serde_json::from_value(json).expect("解析失败");
        assert!(msg.is_assistant());
        assert!(msg.is_complete, "is_complete 缺省应为 true");
        assert!(msg.search_sources.is_empty());
        assert_eq!(msg.duration_ms, None);

        let user = AiChatMessageItem {
            role: "user".into(),
            ..msg
        };
        assert!(!user.is_assistant());
    }

    #[test]
    fn config_parses_with_defaults() {
        let json = serde_json::json!({
            "provider_configured": true,
            "web_search_configured": false,
            "models": ["m1", "m2"],
            "default_model": "m1",
            "timeout_seconds": 120
        });
        let cfg: AiChatConfig = serde_json::from_value(json).expect("解析失败");
        assert!(cfg.provider_configured);
        assert_eq!(cfg.default_reasoning_effort, "medium");
        assert_eq!(cfg.max_conversation_turns, 10);
        assert_eq!(cfg.web_search_max_results, 5);
    }

    // ---------- SSE 事件解析 ----------

    #[test]
    fn stream_event_parses_text_delta() {
        let v = serde_json::json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "text_delta", "text": "你好"}
        });
        match StreamEvent::from_json(&v) {
            Some(StreamEvent::ContentBlockDelta { delta }) => {
                assert_eq!(delta.kind, "text_delta");
                assert_eq!(delta.text, "你好");
            }
            other => panic!("应解析为 ContentBlockDelta：{other:?}"),
        }
    }

    #[test]
    fn stream_event_parses_tool_use_start_and_done() {
        let start = serde_json::json!({
            "type": "content_block_start", "index": 1,
            "content_block": {"type": "tool_use", "id": "t1", "name": "web_search", "input": {}}
        });
        match StreamEvent::from_json(&start) {
            Some(StreamEvent::ContentBlockStart { block }) => {
                assert_eq!(block.kind, "tool_use");
                assert_eq!(block.name, "web_search");
            }
            other => panic!("应解析为 ContentBlockStart：{other:?}"),
        }

        let done = serde_json::json!({
            "type": "done",
            "user_message": {
                "id": 1, "conversation_id": 1, "role": "user", "content": "hi",
                "created_at": "2026-08-21T00:00:00+00:00"
            },
            "assistant_message": {
                "id": 2, "conversation_id": 1, "role": "assistant", "content": "hello",
                "total_tokens": 9, "created_at": "2026-08-21T00:00:01+00:00"
            },
            "conversation_title": null,
            "token_usage": {"prompt_tokens": 3, "completion_tokens": 6, "total_tokens": 9},
            "duration_ms": 1500,
            "title_regenerated": false
        });
        match StreamEvent::from_json(&done) {
            Some(StreamEvent::Done(payload)) => {
                let payload = *payload;
                assert_eq!(payload.user_message.expect("user").id, 1);
                assert_eq!(
                    payload.assistant_message.expect("assistant").total_tokens,
                    9
                );
                assert_eq!(payload.token_usage.map(|u| u.total_tokens), Some(9));
                assert_eq!(payload.duration_ms, Some(1500));
                assert!(!payload.title_regenerated);
            }
            other => panic!("应解析为 Done：{other:?}"),
        }
    }

    #[test]
    fn stream_usage_accepts_both_backend_field_namings() {
        // message_delta.usage 发 Anthropic 形 input_tokens/output_tokens（events.py）
        let delta = serde_json::json!({
            "type": "message_delta",
            "usage": {"input_tokens": 3, "output_tokens": 6, "total_tokens": 9}
        });
        match StreamEvent::from_json(&delta) {
            Some(StreamEvent::MessageDelta { usage }) => {
                let u = usage.expect("usage 应解析");
                assert_eq!(
                    (u.prompt_tokens, u.completion_tokens, u.total_tokens),
                    (3, 6, 9)
                );
            }
            other => panic!("应解析为 MessageDelta：{other:?}"),
        }

        // done.token_usage 发 OpenAI 形 prompt_tokens/completion_tokens（schemas TokenUsage）
        let openai: StreamUsage = serde_json::from_value(serde_json::json!(
            {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}
        ))
        .expect("OpenAI 形应解析");
        assert_eq!((openai.prompt_tokens, openai.completion_tokens), (1, 2));
    }

    #[test]
    fn stream_event_error_and_ping_and_stop() {
        let err = serde_json::json!({
            "type": "error", "error": {"code": "timeout", "message": "超时"}
        });
        match StreamEvent::from_json(&err) {
            Some(StreamEvent::Error(body)) => {
                assert_eq!(body.code, "timeout");
                assert_eq!(body.message, "超时");
            }
            other => panic!("应解析为 Error：{other:?}"),
        }
        assert_eq!(
            StreamEvent::from_json(&serde_json::json!({"type": "ping"})),
            Some(StreamEvent::Ping)
        );
        assert_eq!(
            StreamEvent::from_json(&serde_json::json!({"type": "message_stop"})),
            Some(StreamEvent::MessageStop)
        );
        assert_eq!(
            StreamEvent::from_json(
                &serde_json::json!({"type": "message_start", "message_id": "m", "model": "gpt"})
            ),
            Some(StreamEvent::MessageStart {
                message_id: "m".into(),
                model: "gpt".into()
            })
        );
    }

    #[test]
    fn stream_event_unknown_type_is_forward_compatible() {
        // 与 web 端一致：未知事件忽略（解析为 Unknown 而非失败）
        let v = serde_json::json!({"type": "future_event", "x": 1});
        assert_eq!(
            StreamEvent::from_json(&v),
            Some(StreamEvent::Unknown("future_event".into()))
        );
        // 缺 type / 非 JSON → None（调用方跳过）
        assert_eq!(
            StreamEvent::from_json(&serde_json::json!({"data": 1})),
            None
        );
    }

    #[test]
    fn stream_event_missing_nested_fields_fall_back_to_empty() {
        // content_block_delta 缺 delta → 空 text_delta（容错不 panic）
        let v = serde_json::json!({"type": "content_block_delta", "index": 0});
        match StreamEvent::from_json(&v) {
            Some(StreamEvent::ContentBlockDelta { delta }) => {
                assert_eq!(delta.text, "");
            }
            other => panic!("应容错解析：{other:?}"),
        }
    }
}
