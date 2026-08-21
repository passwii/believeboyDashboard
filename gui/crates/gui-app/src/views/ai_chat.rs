//! AI 智能 → AI Chat（P5-6，BLF-737）
//!
//! 对齐 web 端 `app/dashboard/ai/chat` + `components/chat/ai-chat-window.tsx`
//! （约 1012 行）的核心对话主面：会话侧栏（列表 / 新建 / 删除）+ 消息流
//! （用户 / 助手气泡，SSE 流式增量渲染）+ 输入区（多行输入，Cmd+Enter 发送，
//! 流式中可停止）。数据源为 backend `/api/v1/ai/**`（V2 SSE 流式协议见
//! [`gui_domain::ai_chat::StreamEvent`]），鉴权与既有视图一致（会话头 +
//! Bearer api_key，BLF-711）。
//!
//! ## 与 web 端的取舍（issue 允许按 macOS 原生习惯精简并说明）
//!
//! - **保留**：会话列表 / 新建 / 删除、历史消息回放、流式对话
//!   （text_delta 增量 + 联网搜索状态 + done 持久化回填）、模型下拉选择
//!   （来自 `/ai/config`）、联网搜索开关、token 用量 / 耗时元信息、
//!   加载 / 错误 / 空态；
//! - **精简**：
//!   - GSAP 动效（ray 背景 / 浮动粒子 / 打字机逐字效果）不移植——流式
//!     增量本身即「打字机」，GPUI 侧按原生习惯直接渲染增量文本；
//!   - 会话重命名 / 标题重生成按钮、消息编辑 / 删除 / 重新生成走 web 端
//!     （api-client 未接入对应端点，见 `gui-api-client::ai_chat` 模块注释；
//!     标题自动生成仍生效——done 事件 title_regenerated 时同步侧栏标题）；
//!   - System Prompt 预设 / 场景选择器不移植（web 端在客户端拼装
//!     system_prompt，属提示词工程入口，GUI v1 不暴露）；
//!   - 思考过程（thinking_delta）折叠展示为「思考中…」状态行，不展开全文；
//!   - `Last-Event-ID` 断线续传不做（GUI 单机长连接场景弱需求）；
//!   - web 强制暗色主题不移植——GUI 跟随应用亮暗主题 token。
//!
//! ## 流式管线
//!
//! `send_message` → （无会话先懒创建，对齐 web landing→chat）→
//! `Client::ai_stream_message` 在 tokio runtime 上消费 SSE，事件经
//! `tokio::sync::mpsc` 推回 GPUI executor（tokio sync 原语不依赖 reactor），
//! 视图在 `cx.spawn` 循环里应用事件并 `cx.notify()` 刷新。竞态保护：
//! `stream_generation` 代际计数——新发送 / 停止 / 视图销毁都会使旧消费循环失效。

use gpui::prelude::*;
use gpui::{
    div, px, AsyncApp, Context, Entity, IntoElement, Render, SharedString, WeakEntity, Window,
};
use gpui_component::button::{Button, ButtonCustomVariant, ButtonVariants};
use gpui_component::checkbox::Checkbox;
use gpui_component::input::{Input, InputEvent, InputState};
use gpui_component::menu::PopupMenuItem;
use gpui_component::{h_flex, v_flex, Disableable, Icon, IconName, Sizable};
use gui_api_client::ai_chat::AiChatMessageCreate;
use gui_api_client::Client;
use gui_domain::ai_chat::{AiChatMessageItem, AiConversation, StreamEvent};

use crate::theme::AppTheme;
use crate::widgets::filter_bar;
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「AI 智能 → AI Chat」URL（数据权威 gui-domain::sidebar）
pub const AI_CHAT_URL: &str = "/dashboard/ai/chat";

/// 会话侧栏宽度（px）
const CONVERSATION_PANE_WIDTH: f32 = 224.0;

/// 气泡最大宽度（px；宽窗下保持可读行长）
const BUBBLE_MAX_WIDTH: f32 = 640.0;

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

/// 面板级状态（配置 + 会话列表加载）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiChatState {
    /// 首屏加载中
    Loading,
    /// 就绪（provider 未配置时输入区禁用 + 横幅提示）
    Ready,
    /// 首屏失败（可重试）
    Error(String),
}

/// 消息气泡（视图层 UI 模型；服务端消息与流式占位共用）
#[derive(Debug, Clone, PartialEq)]
pub struct ChatBubble {
    /// `"user"` | `"assistant"`
    pub role: String,
    pub content: String,
    /// 流式进行中（尾部光标）
    pub streaming: bool,
    /// 生成失败（红色文本）
    pub error: bool,
    /// 正在联网搜索（tool_use 块打开）
    pub searching: bool,
    /// 收到过 thinking_delta（显示「思考中…」）
    pub thinking: bool,
    pub total_tokens: i64,
    pub duration_ms: Option<i64>,
}

impl ChatBubble {
    fn user(content: String) -> Self {
        Self {
            role: "user".into(),
            content,
            streaming: false,
            error: false,
            searching: false,
            thinking: false,
            total_tokens: 0,
            duration_ms: None,
        }
    }

    /// 助手流式占位（空内容，等待首个 delta）
    fn assistant_placeholder() -> Self {
        Self {
            role: "assistant".into(),
            content: String::new(),
            streaming: true,
            error: false,
            searching: false,
            thinking: false,
            total_tokens: 0,
            duration_ms: None,
        }
    }

    fn from_server(msg: &AiChatMessageItem) -> Self {
        Self {
            role: msg.role.clone(),
            content: msg.content.clone(),
            streaming: false,
            error: false,
            searching: false,
            thinking: false,
            total_tokens: msg.total_tokens,
            duration_ms: msg.duration_ms,
        }
    }

    fn is_user(&self) -> bool {
        self.role == "user"
    }

    /// 元信息行（token 用量 · 耗时；无用量不显示）
    fn meta_line(&self) -> Option<String> {
        if self.total_tokens <= 0 {
            return None;
        }
        match self.duration_ms {
            Some(ms) => Some(format!("{} tokens · {:.1}s", self.total_tokens, ms as f64 / 1000.0)),
            None => Some(format!("{} tokens", self.total_tokens)),
        }
    }
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// AI Chat 视图：会话侧栏 + 消息流 + 输入区（SSE 流式）
pub struct AiChatView {
    client: Client,
    state: AiChatState,
    /// 会话列表（后端 updated_at 倒序）
    conversations: Vec<AiConversation>,
    /// 当前选中会话（None = 新对话 landing，首条消息时懒创建）
    active_conv: Option<i64>,
    /// 当前会话消息（含流式占位）
    messages: Vec<ChatBubble>,
    /// 历史消息拉取中
    messages_loading: bool,
    /// 输入框（首个渲染时惰性创建，需要 Window）
    input: Option<Entity<InputState>>,
    #[allow(dead_code)]
    input_sub: Option<gpui::Subscription>,
    /// 渲染时待清空的输入框（send 后延迟到 render 清理——set_value 需要 Window）
    pending_clear_input: bool,
    /// 可选模型列表（/ai/config）
    models: Vec<String>,
    selected_model: Option<String>,
    /// provider 是否已配置（未配置 → 输入禁用 + 横幅）
    provider_configured: bool,
    /// 联网搜索开关
    web_search: bool,
    /// 流式进行中
    is_streaming: bool,
    /// 最近一次流式错误（横幅展示，可关闭）
    stream_error: Option<String>,
    /// 面板加载竞态保护（reload）
    pane_request_id: u64,
    /// 会话列表刷新竞态保护
    list_request_id: u64,
    /// 历史消息竞态保护（select_conversation 快速切换）
    messages_request_id: u64,
    /// 流式代际计数（新发送 / 停止 → 旧消费循环失效）
    stream_generation: u64,
}

impl AiChatView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(_cx: &mut Context<Self>, client: Client) -> Self {
        Self {
            client,
            state: AiChatState::Loading,
            conversations: Vec::new(),
            active_conv: None,
            messages: Vec::new(),
            messages_loading: false,
            input: None,
            input_sub: None,
            pending_clear_input: false,
            models: Vec::new(),
            selected_model: None,
            provider_configured: true,
            web_search: false,
            is_streaming: false,
            stream_error: None,
            pane_request_id: 0,
            list_request_id: 0,
            messages_request_id: 0,
            stream_generation: 0,
        }
    }

    // ---------- 首屏 / 会话列表 ----------

    /// 首屏加载：AI 配置 + 会话列表（首屏 / 错误重试共用入口）
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.pane_request_id = self.pane_request_id.wrapping_add(1);
        let request_id = self.pane_request_id;
        self.state = AiChatState::Loading;
        cx.notify();

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(async {
                        let config = client.ai_chat_config().await.map_err(|e| e.user_message())?;
                        let conversations = client
                            .ai_conversation_list()
                            .await
                            .map_err(|e| e.user_message())?;
                        Ok::<_, String>((config, conversations))
                    })
                })
                .await;
            this.update(cx, |this, cx| {
                if this.pane_request_id != request_id {
                    return; // 过期响应，丢弃
                }
                match result {
                    Ok((config, conversations)) => {
                        this.provider_configured = config.provider_configured;
                        this.models = config.models.clone();
                        this.selected_model = Some(config.default_model.clone());
                        this.conversations = conversations;
                        this.state = AiChatState::Ready;
                    }
                    Err(msg) => {
                        this.state = AiChatState::Error(msg);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// 刷新会话列表（done 后 token / 排序更新；失败静默——下次操作再试）
    fn refresh_conversations(&mut self, cx: &mut Context<Self>) {
        self.list_request_id = self.list_request_id.wrapping_add(1);
        let request_id = self.list_request_id;
        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(client.ai_conversation_list())
                })
                .await;
            this.update(cx, |this, cx| {
                if this.list_request_id != request_id {
                    return;
                }
                if let Ok(list) = result {
                    this.conversations = list;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// 选中会话（拉取历史消息；快速切换由 `messages_request_id` 竞态保护）
    pub fn select_conversation(&mut self, conversation_id: i64, cx: &mut Context<Self>) {
        if self.is_streaming || self.active_conv == Some(conversation_id) {
            return;
        }
        self.active_conv = Some(conversation_id);
        self.messages.clear();
        self.stream_error = None;
        self.messages_loading = true;
        cx.notify();

        self.messages_request_id = self.messages_request_id.wrapping_add(1);
        let request_id = self.messages_request_id;
        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(client.ai_message_list(conversation_id))
                })
                .await;
            this.update(cx, |this, cx| {
                if this.messages_request_id != request_id {
                    return; // 过期响应（已切走），丢弃
                }
                this.messages_loading = false;
                match result {
                    Ok(items) => {
                        this.messages = items.iter().map(ChatBubble::from_server).collect();
                    }
                    Err(e) => {
                        this.stream_error = Some(e.user_message());
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// 新对话（landing 态；会话在首条消息发送时懒创建，避免空会话污染列表）
    pub fn new_conversation(&mut self, cx: &mut Context<Self>) {
        if self.is_streaming {
            return;
        }
        if self.active_conv.is_none() && self.messages.is_empty() {
            return; // 已是 landing 态，no-op
        }
        self.active_conv = None;
        self.messages.clear();
        self.stream_error = None;
        cx.notify();
    }

    /// 删除会话（成功后本地移除；删的是当前会话则回到 landing 态）
    pub fn delete_conversation(&mut self, conversation_id: i64, cx: &mut Context<Self>) {
        if self.is_streaming && self.active_conv == Some(conversation_id) {
            return; // 流式中的会话不可删
        }
        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(client.ai_conversation_delete(conversation_id))
                })
                .await;
            this.update(cx, |this, cx| {
                if result.is_ok() {
                    this.conversations.retain(|c| c.id != conversation_id);
                    if this.active_conv == Some(conversation_id) {
                        this.active_conv = None;
                        this.messages.clear();
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // ---------- 模型 / 开关 ----------

    /// 选择模型（同值为 no-op）
    pub fn select_model(&mut self, model: Option<String>, cx: &mut Context<Self>) {
        if model == self.selected_model {
            return;
        }
        self.selected_model = model;
        cx.notify();
    }

    /// 切换联网搜索
    pub fn set_web_search(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if enabled == self.web_search {
            return;
        }
        self.web_search = enabled;
        cx.notify();
    }

    // ---------- 发送 / 流式 ----------

    /// 发送当前输入（Cmd+Enter / 发送按钮；流式中忽略）
    pub fn send_message(&mut self, cx: &mut Context<Self>) {
        if self.is_streaming || !self.provider_configured {
            return;
        }
        let Some(input) = &self.input else {
            return;
        };
        let content = input.read(cx).value().trim().to_string();
        if content.is_empty() {
            return;
        }
        // set_value 需要 Window，延迟到下一帧 render 清空
        self.pending_clear_input = true;

        // 乐观插入：用户消息 + 助手流式占位
        self.messages.push(ChatBubble::user(content.clone()));
        self.messages.push(ChatBubble::assistant_placeholder());
        self.is_streaming = true;
        self.stream_error = None;
        self.stream_generation = self.stream_generation.wrapping_add(1);
        let generation = self.stream_generation;

        let client = self.client.clone();
        let existing_conv = self.active_conv;
        let model = self.selected_model.clone();
        let web_search = self.web_search;
        let bg = cx.background_executor().clone();

        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            // ① 确保会话存在（landing 态首条消息 → 懒创建，对齐 web）
            let client_for_create = client.clone();
            let conversation_id = match existing_conv {
                Some(id) => id,
                None => {
                    let created = bg
                        .spawn(async move {
                            crate::runtime::runtime()
                                .block_on(client_for_create.ai_conversation_create(None))
                        })
                        .await;
                    match created {
                        Ok(conv) => {
                            let new_id = conv.id;
                            let alive = this
                                .update(cx, |this, cx| {
                                    this.active_conv = Some(new_id);
                                    this.conversations.insert(0, conv);
                                    cx.notify();
                                })
                                .is_ok();
                            if !alive {
                                return;
                            }
                            new_id
                        }
                        Err(e) => {
                            this.update(cx, |this, cx| {
                                this.mark_stream_error(e.user_message(), cx)
                            })
                            .ok();
                            return;
                        }
                    }
                }
            };

            // ② SSE 流式请求 + 事件消费循环
            let payload = AiChatMessageCreate {
                content,
                model,
                regenerate: false,
                enable_web_search: web_search,
            };
            let (tx, rx) =
                tokio::sync::mpsc::unbounded_channel::<Result<StreamEvent, String>>();
            let producer = bg.spawn(async move {
                let _ = crate::runtime::runtime()
                    .block_on(client.ai_stream_message(conversation_id, &payload, tx));
            });

            let mut rx = rx;
            loop {
                match rx.recv().await {
                    Some(Ok(event)) => {
                        let mut stale = false;
                        let alive = this
                            .update(cx, |this, cx| {
                                stale = this.stream_generation != generation;
                                if !stale {
                                    this.apply_stream_event(event, cx);
                                }
                            })
                            .is_ok();
                        if !alive || stale {
                            break;
                        }
                    }
                    Some(Err(msg)) => {
                        this.update(cx, |this, cx| {
                            if this.stream_generation == generation {
                                this.mark_stream_error(msg, cx);
                            }
                        })
                        .ok();
                        break;
                    }
                    None => break, // 发送端结束（流完成）
                }
            }
            drop(rx); // 丢弃接收端 → 生产者下次 send 失败即中断读取（停止 / 切换）
            let _ = producer.await;

            this.update(cx, |this, cx| this.finish_stream(generation, cx))
                .ok();
        })
        .detach();
    }

    /// 停止当前流式回复：代际失效 + 调后端 cancel（跨 worker 生效）
    pub fn stop_streaming(&mut self, cx: &mut Context<Self>) {
        if !self.is_streaming {
            return;
        }
        self.stream_generation = self.stream_generation.wrapping_add(1);
        self.is_streaming = false;
        if let Some(last) = self.messages.last_mut() {
            last.streaming = false;
            last.searching = false;
            last.thinking = false;
        }
        if let Some(conversation_id) = self.active_conv {
            let client = self.client.clone();
            let bg = cx.background_executor().clone();
            cx.spawn(async move |_this, _cx: &mut AsyncApp| {
                // 取消失败不影响 UI（流可能已自然结束）
                let _ = bg
                    .spawn(async move {
                        crate::runtime::runtime()
                            .block_on(client.ai_stream_cancel(conversation_id))
                            .is_ok()
                    })
                    .await;
            })
            .detach();
        }
        cx.notify();
    }

    /// 应用单个流式事件到消息气泡（仅当前代际会被调用）
    fn apply_stream_event(&mut self, event: StreamEvent, cx: &mut Context<Self>) {
        match event {
            StreamEvent::ContentBlockDelta { delta } => {
                if delta.kind == "text_delta" && !delta.text.is_empty() {
                    if let Some(last) = self.messages.last_mut() {
                        last.content.push_str(&delta.text);
                        last.thinking = false;
                    }
                    cx.notify();
                } else if delta.kind == "thinking_delta" && !delta.text.is_empty() {
                    if let Some(last) = self.messages.last_mut() {
                        last.thinking = true;
                    }
                    cx.notify();
                }
                // input_json_delta：工具参数增量，GUI v1 不展示
            }
            StreamEvent::ContentBlockStart { block } => {
                if block.kind == "tool_use" {
                    if let Some(last) = self.messages.last_mut() {
                        last.searching = true;
                    }
                    cx.notify();
                }
            }
            StreamEvent::ContentBlockStop => {
                if let Some(last) = self.messages.last_mut() {
                    last.searching = false;
                }
                cx.notify();
            }
            StreamEvent::Error(body) => {
                let msg = if body.message.trim().is_empty() {
                    "流式错误".to_string()
                } else {
                    body.message
                };
                self.mark_stream_error(msg, cx);
            }
            StreamEvent::Done(payload) => {
                // 用持久化后的双消息回填（拿到服务端 id / token 用量）
                if let (Some(user), Some(assistant)) =
                    (&payload.user_message, &payload.assistant_message)
                {
                    self.messages = vec![
                        ChatBubble::from_server(user),
                        ChatBubble::from_server(assistant),
                    ];
                }
                // 标题自动生成 → 同步侧栏标题
                if payload.title_regenerated {
                    if let (Some(title), Some(conversation_id)) =
                        (&payload.conversation_title, self.active_conv)
                    {
                        if let Some(conv) = self
                            .conversations
                            .iter_mut()
                            .find(|c| c.id == conversation_id)
                        {
                            conv.title = title.clone();
                        }
                    }
                }
                cx.notify();
                // token 用量 / 排序可能变化 → 静默刷新列表
                self.refresh_conversations(cx);
            }
            _ => {}
        }
    }

    /// 流式错误落点：占位气泡标错 + 横幅文案 + 结束流式态
    fn mark_stream_error(&mut self, msg: String, cx: &mut Context<Self>) {
        self.stream_error = Some(msg);
        if let Some(last) = self.messages.last_mut() {
            last.streaming = false;
            last.error = true;
            last.searching = false;
            last.thinking = false;
        }
        self.is_streaming = false;
        cx.notify();
    }

    /// 流式收尾（代际匹配时）：结束 streaming 态
    fn finish_stream(&mut self, generation: u64, cx: &mut Context<Self>) {
        if generation != self.stream_generation {
            return; // 已被新发送 / 停止接管
        }
        self.is_streaming = false;
        if let Some(last) = self.messages.last_mut() {
            last.streaming = false;
            last.searching = false;
            last.thinking = false;
        }
        cx.notify();
    }

    // ---------- 输入框 ----------

    /// 首个渲染时创建多行输入框 + 订阅（需要 `&mut Window` 才能建 InputState）。
    /// Cmd+Enter 发送；普通 Enter 在多行模式下换行（gpui-component 默认行为）。
    fn ensure_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.input.is_some() {
            return;
        }
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("输入消息，开始对话…")
                .multi_line(true)
        });
        let sub = cx.subscribe(&input, |this, _e, event: &InputEvent, cx| {
            if let InputEvent::PressEnter {
                secondary: true,
            } = event
            {
                this.send_message(cx);
            }
        });
        self.input = Some(input);
        self.input_sub = Some(sub);
    }

    /// 消费待清空标记（render 时调用——set_value 需要 Window）
    fn take_pending_clear(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.pending_clear_input {
            return;
        }
        self.pending_clear_input = false;
        if let Some(input) = &self.input {
            input.update(cx, |state, cx| state.set_value("", window, cx));
        }
    }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for AiChatView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        self.ensure_inputs(window, cx);
        self.take_pending_clear(window, cx);

        match &self.state {
            AiChatState::Loading => v_flex()
                .id("ai-chat")
                .size_full()
                .p_6()
                .gap_4()
                .bg(theme.window_bg)
                .child(state_views::skeleton_loading(
                    &theme,
                    &[SkeletonBlock::Title, SkeletonBlock::Kpi(4)],
                ))
                .into_any_element(),
            AiChatState::Error(msg) => v_flex()
                .id("ai-chat")
                .size_full()
                .p_6()
                .bg(theme.window_bg)
                .child(state_views::error_state(
                    &cx.entity(),
                    &theme,
                    "ai-chat-error",
                    "AI Chat 加载失败",
                    msg.clone(),
                    |this, cx| this.reload(cx),
                ))
                .into_any_element(),
            AiChatState::Ready => self.render_ready(cx),
        }
    }
}

impl AiChatView {
    // ---------- 就绪态主布局：会话侧栏 + 右侧对话列 ----------

    fn render_ready(&self, cx: &Context<Self>) -> gpui::AnyElement {
        let theme = AppTheme::current(cx);
        h_flex()
            .id("ai-chat")
            .size_full()
            .bg(theme.window_bg)
            .child(self.render_conversation_pane(&theme, cx))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .child(self.render_top_bar(&theme, cx))
                    .when(!self.provider_configured, |this| {
                        this.child(
                            h_flex()
                                .px_4()
                                .py_1p5()
                                .bg(theme.warning.opacity(0.12))
                                .child(
                                    div().text_xs().text_color(theme.warning).child(
                                        "AI 服务未配置，请联系管理员在后端配置模型 Provider",
                                    ),
                                ),
                        )
                    })
                    .when_some(self.stream_error.clone(), |this, msg| {
                        this.child(
                            h_flex()
                                .px_4()
                                .py_1p5()
                                .bg(theme.danger_soft)
                                .justify_between()
                                .child(
                                    div().text_xs().text_color(theme.danger).child(msg),
                                )
                                .child({
                                    let view = cx.entity();
                                    Button::new("ai-chat-error-dismiss")
                                        .ghost()
                                        .xsmall()
                                        .label("关闭")
                                        .on_click(move |_, _, cx| {
                                            view.update(cx, |this, cx| {
                                                this.stream_error = None;
                                                cx.notify();
                                            });
                                        })
                                }),
                        )
                    })
                    .child(self.render_messages(&theme))
                    .child(self.render_input_bar(&theme, cx)),
            )
            .into_any_element()
    }

    // ---------- 会话侧栏 ----------

    fn render_conversation_pane(
        &self,
        theme: &AppTheme,
        cx: &Context<Self>,
    ) -> gpui::AnyElement {
        let view = cx.entity();
        let mut pane = v_flex()
            .w(px(CONVERSATION_PANE_WIDTH))
            .h_full()
            .flex_shrink_0()
            .border_r_1()
            .border_color(theme.separator)
            .bg(theme.card_bg)
            .child(
                h_flex()
                    .items_center()
                    .justify_between()
                    .px_3()
                    .py_2()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(theme.text_secondary)
                            .child("对话"),
                    )
                    .child({
                        let view = view.clone();
                        Button::new("ai-chat-new")
                            .ghost()
                            .small()
                            .icon(Icon::new(IconName::Plus))
                            .on_click(move |_, _, cx| {
                                view.update(cx, AiChatView::new_conversation);
                            })
                    }),
            );

        let list = div().id("ai-chat-conversations").flex_1().min_h_0().overflow_y_scroll().child(
            v_flex().gap_0p5().px_1p5().pb_2().children(self.conversations.iter().map(|conv| {
                let selected = self.active_conv == Some(conv.id);
                let view_for_select = view.clone();
                let view_for_delete = view.clone();
                let conversation_id = conv.id;
                let title: SharedString = if conv.title.trim().is_empty() {
                    "新对话".into()
                } else {
                    conv.title.clone().into()
                };
                h_flex()
                    .items_center()
                    .gap_1()
                    .mx_1p5()
                    .rounded_md()
                    .when(selected, |this| this.bg(theme.muted_fill))
                    // 主区域：选中会话
                    .child(
                        div()
                            .id(SharedString::from(format!("ai-conv-{conversation_id}")))
                            .flex_1()
                            .min_w_0()
                            .px_2()
                            .py_1p5()
                            .rounded_md()
                            .when(selected, |this| this.bg(theme.muted_fill))
                            .on_click(move |_, _, cx| {
                                view_for_select.update(cx, |this, cx| {
                                    this.select_conversation(conversation_id, cx)
                                });
                            })
                            .child(
                                v_flex().min_w_0().gap_0p5().child(
                                    div()
                                        .text_sm()
                                        .truncate()
                                        .text_color(if selected {
                                            theme.text_primary
                                        } else {
                                            theme.text_secondary
                                        })
                                        .child(title),
                                ),
                            ),
                    )
                    // 删除按钮（独立于选中热区，避免点击冒泡）
                    .child({
                        Button::new(SharedString::from(format!(
                            "ai-conv-del-{conversation_id}"
                        )))
                        .ghost()
                        .xsmall()
                        .icon(Icon::new(IconName::Delete).with_size(px(13.)))
                        .on_click(move |_, _, cx| {
                            view_for_delete.update(cx, |this, cx| {
                                this.delete_conversation(conversation_id, cx)
                            });
                        })
                    })
            })),
        );
        pane = pane.child(list);
        pane.into_any_element()
    }

    // ---------- 顶栏：模型选择 + 联网搜索 + 流式状态 ----------

    fn render_top_bar(&self, theme: &AppTheme, cx: &Context<Self>) -> gpui::AnyElement {
        let view = cx.entity();
        let models = self.models.clone();
        let selected = self.selected_model.clone();
        let model_label: SharedString = selected
            .clone()
            .unwrap_or_else(|| "选择模型".into())
            .into();

        let status: Option<SharedString> = if self.is_streaming {
            Some("正在回复…".into())
        } else {
            None
        };

        h_flex()
            .items_center()
            .gap_4()
            .px_4()
            .py_2()
            .border_b_1()
            .border_color(theme.separator)
            .child(filter_bar::filter_select(
                theme,
                "模型",
                model_label,
                "ai-chat-model-filter",
                move |menu, _window, _cx| {
                    let mut menu = menu;
                    for model in &models {
                        let view = view.clone();
                        let model = model.clone();
                        let checked = Some(&model) == selected.as_ref();
                        menu = menu.item(
                            PopupMenuItem::new(model.clone())
                                .checked(checked)
                                .on_click(move |_ev, _w, cx| {
                                    let model = model.clone();
                                    view.update(cx, |this, cx| {
                                        this.select_model(Some(model), cx)
                                    });
                                }),
                        );
                    }
                    menu
                },
            ))
            .child({
                let view = cx.entity();
                Checkbox::new("ai-chat-web-search")
                    .label("联网搜索")
                    .checked(self.web_search)
                    .on_click(move |checked, _window, cx| {
                        let enabled = *checked;
                        view.update(cx, |this, cx| this.set_web_search(enabled, cx));
                    })
            })
            .child(div().flex_1())
            .children(status.map(|s| {
                div().text_xs().text_color(theme.text_muted).child(s)
            }))
            .into_any_element()
    }

    // ---------- 消息流 ----------

    fn render_messages(&self, theme: &AppTheme) -> gpui::AnyElement {
        if self.messages_loading {
            return div()
                .id("ai-chat-messages")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .child(
                    v_flex().size_full().items_center().justify_center().child(
                        state_views::loading_state(theme, "加载消息…"),
                    ),
                )
                .into_any_element();
        }

        if self.messages.is_empty() {
            return div()
                .id("ai-chat-messages")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .child(
                    v_flex().size_full().items_center().justify_center().gap_2()
                        .child(
                            Icon::new(IconName::Bot)
                                .with_size(px(36.))
                                .text_color(theme.text_muted),
                        )
                        .child(
                            div()
                                .text_base()
                                .font_weight(gpui::FontWeight::SEMIBOLD)
                                .text_color(theme.text_primary)
                                .child("BelieveBoy AI 助手"),
                        )
                        .child(
                            div().text_sm().text_color(theme.text_muted).child(
                                "输入消息开始对话，支持联网搜索与多模型切换",
                            ),
                        ),
                )
                .into_any_element();
        }

        div()
            .id("ai-chat-messages")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .child(
                v_flex()
                    .w_full()
                    .max_w(px(BUBBLE_MAX_WIDTH * 1.35))
                    .mx_auto()
                    .p_4()
                    .gap_3()
                    .children(self.messages.iter().enumerate().map(|(i, bubble)| {
                        chat_bubble(bubble, theme, i)
                    })),
            )
            .into_any_element()
    }

    // ---------- 输入区 ----------

    fn render_input_bar(&self, theme: &AppTheme, cx: &Context<Self>) -> gpui::AnyElement {
        let input = self.input.clone().expect("输入框已在 render 前创建");
        let input_empty = input.read(cx).value().trim().is_empty();
        let send_variant = ButtonCustomVariant::new(cx)
            .color(theme.accent)
            .foreground(theme.on_accent)
            .hover(theme.accent_hover)
            .active(theme.accent_hover)
            .shadow(false);
        let view = cx.entity();

        h_flex()
            .items_end()
            .gap_2()
            .px_4()
            .py_3()
            .border_t_1()
            .border_color(theme.separator)
            .child(Input::new(&input).w_full().h(px(84.)))
            .child(
                v_flex().items_end().gap_1().child(if self.is_streaming {
                    Button::new("ai-chat-stop")
                        .danger()
                        .label("停止")
                        .on_click(move |_, _, cx| {
                            view.update(cx, AiChatView::stop_streaming);
                        })
                        .into_any_element()
                } else {
                    Button::new("ai-chat-send")
                        .custom(send_variant)
                        .label("发送")
                        .disabled(input_empty || !self.provider_configured)
                        .on_click(move |_, _, cx| {
                            view.update(cx, AiChatView::send_message);
                        })
                        .into_any_element()
                })
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child("Cmd+Enter 发送"),
                ),
            )
            .into_any_element()
    }
}

// ---------------------------------------------------------------------------
// 气泡渲染
// ---------------------------------------------------------------------------

/// 单条消息气泡（用户右对齐强调底 / 助手左对齐卡片底）
fn chat_bubble(bubble: &ChatBubble, theme: &AppTheme, index: usize) -> gpui::AnyElement {
    let element_id = SharedString::from(format!("ai-msg-{index}"));
    if bubble.is_user() {
        return h_flex()
            .id(element_id)
            .w_full()
            .justify_end()
            .child(
                div()
                    .max_w(px(BUBBLE_MAX_WIDTH))
                    .rounded_lg()
                    .bg(theme.accent)
                    .px_3()
                    .py_2()
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.on_accent)
                            .child(bubble.content.clone()),
                    ),
            )
            .into_any_element();
    }

    // 助手气泡：状态行 + 正文 + 元信息
    let body_text: SharedString = if bubble.content.is_empty() {
        if bubble.error {
            "生成失败".into()
        } else if bubble.searching {
            "正在联网搜索…".into()
        } else if bubble.thinking {
            "思考中…".into()
        } else {
            "…".into()
        }
    } else {
        let mut text = bubble.content.clone();
        if bubble.streaming && !bubble.searching && !bubble.thinking {
            text.push('▍'); // 流式光标
        }
        text.into()
    };

    v_flex()
        .id(element_id)
        .w_full()
        .items_start()
        .child(
            v_flex()
                .max_w(px(BUBBLE_MAX_WIDTH))
                .rounded_lg()
                .border_1()
                .border_color(theme.separator)
                .bg(theme.card_bg)
                .px_3()
                .py_2()
                .gap_1()
                .children(bubble.searching.then(|| {
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child("正在联网搜索…")
                }))
                .children(bubble.thinking.then(|| {
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child("思考中…")
                }))
                .child(
                    div()
                        .text_sm()
                        .text_color(if bubble.error {
                            theme.danger
                        } else {
                            theme.text_primary
                        })
                        .child(body_text),
                )
                .children(bubble.meta_line().map(|meta| {
                    div().text_xs().text_color(theme.text_muted).child(meta)
                })),
        )
        .into_any_element()
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use gui_domain::ai_chat::{ContentBlock, StreamDelta, StreamDonePayload, StreamErrorBody};

    fn dummy_client() -> Client {
        Client::new("http://127.0.0.1:1")
    }

    fn sample_message(id: i64, role: &str, content: &str) -> AiChatMessageItem {
        AiChatMessageItem {
            id,
            conversation_id: 7,
            role: role.into(),
            content: content.into(),
            search_sources: Vec::new(),
            search_time_range: None,
            is_complete: true,
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: if role == "assistant" { 42 } else { 0 },
            duration_ms: if role == "assistant" { Some(1500) } else { None },
            created_at: "2026-08-21T00:00:00+00:00".into(),
        }
    }

    fn sample_conversation(id: i64) -> AiConversation {
        AiConversation {
            id,
            title: "新对话".into(),
            created_at: "2026-08-21T00:00:00+00:00".into(),
            updated_at: "2026-08-21T00:00:00+00:00".into(),
            total_prompt_tokens: 0,
            total_completion_tokens: 0,
            total_tokens: 0,
        }
    }

    // ---------- 常量 / 模型契约 ----------

    #[test]
    fn url_constant_matches_sidebar() {
        assert_eq!(AI_CHAT_URL, "/dashboard/ai/chat");
    }

    #[test]
    fn chat_bubble_from_server_maps_fields() {
        let assistant = sample_message(2, "assistant", "你好");
        let bubble = ChatBubble::from_server(&assistant);
        assert!(!bubble.is_user());
        assert_eq!(bubble.content, "你好");
        assert_eq!(bubble.total_tokens, 42);
        assert_eq!(bubble.duration_ms, Some(1500));
        assert!(!bubble.streaming && !bubble.error);

        let user = sample_message(1, "user", "hi");
        let bubble = ChatBubble::from_server(&user);
        assert!(bubble.is_user());
        assert_eq!(bubble.total_tokens, 0);
        assert!(bubble.meta_line().is_none(), "无用量不显示元信息行");
    }

    #[test]
    fn meta_line_formats_tokens_and_duration() {
        let mut bubble = ChatBubble::assistant_placeholder();
        bubble.total_tokens = 9;
        assert_eq!(bubble.meta_line(), Some("9 tokens".into()));
        bubble.duration_ms = Some(2300);
        assert_eq!(bubble.meta_line(), Some("9 tokens · 2.3s".into()));
    }

    // ---------- 流式事件状态机（gpui 实体上下文） ----------

    #[gpui::test]
    async fn text_and_thinking_deltas_append_to_placeholder(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| AiChatView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.is_streaming = true; // 模拟 send_message 已进入流式态
            this.messages.push(ChatBubble::user("hi".into()));
            this.messages.push(ChatBubble::assistant_placeholder());

            this.apply_stream_event(
                StreamEvent::ContentBlockDelta {
                    delta: StreamDelta {
                        kind: "text_delta".into(),
                        text: "你".into(),
                        partial_json: String::new(),
                    },
                },
                cx,
            );
            this.apply_stream_event(
                StreamEvent::ContentBlockDelta {
                    delta: StreamDelta {
                        kind: "text_delta".into(),
                        text: "好".into(),
                        partial_json: String::new(),
                    },
                },
                cx,
            );
            assert_eq!(this.messages.last().unwrap().content, "你好");
            assert!(this.is_streaming, "delta 不改变流式态");

            this.apply_stream_event(
                StreamEvent::ContentBlockStart {
                    block: ContentBlock {
                        kind: "tool_use".into(),
                        text: String::new(),
                        thinking: String::new(),
                        name: "web_search".into(),
                    },
                },
                cx,
            );
            assert!(this.messages.last().unwrap().searching);

            this.apply_stream_event(
                StreamEvent::ContentBlockDelta {
                    delta: StreamDelta {
                        kind: "thinking_delta".into(),
                        text: "推理".into(),
                        partial_json: String::new(),
                    },
                },
                cx,
            );
            assert!(this.messages.last().unwrap().thinking);

            this.apply_stream_event(StreamEvent::ContentBlockStop, cx);
            assert!(!this.messages.last().unwrap().searching);
        });
    }

    #[gpui::test]
    async fn done_payload_backfills_messages_and_title(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| AiChatView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.active_conv = Some(7);
            this.conversations = vec![sample_conversation(7)];
            this.messages.push(ChatBubble::user("hi".into()));
            this.messages.push(ChatBubble::assistant_placeholder());

            this.apply_stream_event(
                StreamEvent::Done(Box::new(StreamDonePayload {
                    user_message: Some(sample_message(11, "user", "hi")),
                    assistant_message: Some(sample_message(12, "assistant", "你好")),
                    conversation_title: Some("自动标题".into()),
                    token_usage: None,
                    duration_ms: Some(900),
                    title_regenerated: true,
                })),
                cx,
            );

            assert_eq!(this.messages.len(), 2, "done 回填双消息");
            assert_eq!(this.messages[1].content, "你好");
            assert_eq!(this.messages[1].total_tokens, 42);
            assert!(!this.messages[1].streaming);
            assert_eq!(
                this.conversations[0].title, "自动标题",
                "title_regenerated 同步侧栏标题"
            );
        });
    }

    #[gpui::test]
    async fn error_event_marks_bubble_and_stops_streaming(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| AiChatView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.is_streaming = true;
            this.messages.push(ChatBubble::assistant_placeholder());

            this.apply_stream_event(
                StreamEvent::Error(StreamErrorBody {
                    code: "timeout".into(),
                    message: "超时".into(),
                }),
                cx,
            );

            assert_eq!(this.stream_error.as_deref(), Some("超时"));
            assert!(!this.is_streaming);
            let last = this.messages.last().unwrap();
            assert!(last.error && !last.streaming);
        });
    }

    #[gpui::test]
    async fn finish_stream_respects_generation_guard(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| AiChatView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.is_streaming = true;
            this.stream_generation = 5;
            this.messages.push(ChatBubble::assistant_placeholder());

            // 过期代际 → 不动状态
            this.finish_stream(4, cx);
            assert!(this.is_streaming);

            // 当前代际 → 结束流式态
            this.finish_stream(5, cx);
            assert!(!this.is_streaming);
            assert!(!this.messages.last().unwrap().streaming);
        });
    }

    #[gpui::test]
    async fn stop_streaming_invalidates_generation(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| AiChatView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.is_streaming = true;
            let before = this.stream_generation;
            this.messages.push(ChatBubble::assistant_placeholder());

            this.stop_streaming(cx);
            assert!(!this.is_streaming);
            assert_ne!(this.stream_generation, before, "停止应递增代际");
            assert!(!this.messages.last().unwrap().streaming);
        });
    }

    #[gpui::test]
    async fn select_conversation_ignored_while_streaming(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| AiChatView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.is_streaming = true;
            this.select_conversation(7, cx);
            assert_eq!(this.active_conv, None, "流式中不可切换会话");
            assert!(!this.messages_loading);
        });
    }

    #[gpui::test]
    async fn new_conversation_resets_to_landing(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| AiChatView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.active_conv = Some(7);
            this.messages.push(ChatBubble::user("hi".into()));
            this.stream_error = Some("e".into());

            this.new_conversation(cx);
            assert_eq!(this.active_conv, None);
            assert!(this.messages.is_empty());
            assert_eq!(this.stream_error, None);

            // landing 态重复点新建 → no-op
            this.new_conversation(cx);
            assert_eq!(this.active_conv, None);
        });
    }

    // ---------- 渲染冒烟（亮 / 暗 × 关键状态） ----------

    async fn set_theme(dark: bool, cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(
                if dark {
                    crate::theme::ThemePreference::Dark
                } else {
                    crate::theme::ThemePreference::Light
                },
                None,
                cx,
            );
        });
    }

    #[gpui::test]
    async fn renders_loading_state_in_light_and_dark(cx: &mut gpui::TestAppContext) {
        for dark in [false, true] {
            set_theme(dark, cx).await;
            let (_view, _cx) = cx.add_window_view(|_window, cx| AiChatView::new(cx, dummy_client()));
        }
    }

    #[gpui::test]
    async fn renders_ready_state_in_light_and_dark(cx: &mut gpui::TestAppContext) {
        for dark in [false, true] {
            set_theme(dark, cx).await;
            let (view, cx2) =
                cx.add_window_view(|_window, cx| AiChatView::new(cx, dummy_client()));
            view.update(cx2, |this, cx| {
                this.state = AiChatState::Ready;
                this.models = vec!["believeboy-flash".into()];
                this.selected_model = Some("believeboy-flash".into());
                this.conversations = vec![sample_conversation(7)];
                this.active_conv = Some(7);
                this.messages = vec![
                    ChatBubble::from_server(&sample_message(1, "user", "hi")),
                    ChatBubble::from_server(&sample_message(2, "assistant", "你好")),
                ];
                cx.notify();
            });
            cx2.read(|app| {
                assert_eq!(crate::theme::AppTheme::current(app).dark, dark);
            });
        }
    }

    #[gpui::test]
    async fn renders_error_state_with_retry(cx: &mut gpui::TestAppContext) {
        set_theme(false, cx).await;
        let (view, cx2) = cx.add_window_view(|_window, cx| AiChatView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state = AiChatState::Error("连接失败".into());
            cx.notify();
        });
        // 窗口可绘制不 panic（错误态卡片 + 重试按钮）
    }
}
