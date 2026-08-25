//! AI 智能 → AI Chat（P5-6，BLF-737；BLF-800 套版 Pattern C 三栏工作台）
//!
//! 对齐 web 端 `app/dashboard/ai/chat` + `components/chat/ai-chat-window.tsx`
//! 的核心对话主面。数据源为 backend `/api/v1/ai/**`（V2 SSE 流式协议见
//! [`gui_domain::ai_chat::StreamEvent`]），鉴权与既有视图一致（会话头 +
//! Bearer api_key，BLF-711）。
//!
//! ## 布局（Pattern C 模板，Stage9）
//!
//! [`crate::widgets::pattern_c`] 三栏壳：左会话列表 240px（标题 / 时间 /
//! 未读态 + 新建 / 删除 / 置顶）+ 中流式对话区 flex-1（助手消息 markdown
//! 渲染 + 输入区）+ 右上下文栏 300px（模型参数卡 / 会话统计卡，可整体收起）。
//! 三区注入契约、滚动跟随（上翻暂停 / 回底恢复）与已知坑见模板 doc-comment。
//!
//! ## 与 web 端的取舍（issue 允许按 macOS 原生习惯精简并说明）
//!
//! - **保留**：会话列表 / 新建 / 删除 / 置顶（置顶为 GUI 本地偏好，后端无
//!   字段）、历史消息回放、流式对话（text_delta 增量 + 联网搜索状态 +
//!   done 持久化回填）、模型下拉选择（来自 `/ai/config`）、联网搜索开关、
//!   token 用量 / 耗时元信息、加载 / 错误 / 空态；
//! - **精简**：
//!   - GSAP 动效（ray 背景 / 浮动粒子 / 打字机逐字效果）不移植——流式
//!     节拍快照本身即「打字机」（250ms 一拍，见下方流式管线）；
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
//! 视图在 `cx.spawn` 循环里应用事件。
//!
//! **渲染节拍**：text_delta 只累积进气泡数据（不逐条 notify），由节拍任务每
//! [`STREAM_FLUSH_MILLIS`] 把内容同步到显示快照 `stream_display` 并统一
//! refresh——长回复渲染频率有界（UI 不卡顿），且喂给 `TextView::markdown`
//! 的快照间隔大于其 200ms 防抖窗口（逐 token 直喂会重置防抖 timer 导致
//! 流式期间画面冻结，见 pattern_c 已知坑）。done / 停止 / 出错立即清空
//! 快照走精确终稿渲染；停止保留已生成的部分内容（中断不丢）。
//!
//! 竞态保护：`stream_generation` 代际计数——新发送 / 停止 / 视图销毁都会使旧
//! 消费循环与旧节拍循环失效。

use std::collections::HashMap;
use std::time::Duration;

use gpui::prelude::*;
use gpui::{
    div, px, App, AsyncApp, Context, Entity, EventEmitter, FontWeight, IntoElement, Render,
    SharedString, WeakEntity, Window,
};
use gpui_component::button::{Button, ButtonCustomVariant, ButtonVariants};
use gpui_component::checkbox::Checkbox;
use gpui_component::input::{Input, InputEvent, InputState};
use gpui_component::menu::PopupMenuItem;
use gpui_component::{h_flex, v_flex, Disableable, Icon, IconName, Sizable};
use gui_api_client::ai_chat::AiChatMessageCreate;
use gui_api_client::Client;
use gui_domain::ai_chat::{AiChatMessageItem, AiConversation, StreamEvent};

use crate::theme::{AppTheme, FONT_BASE};
use crate::widgets::data_table::TabularNumsExt;
use crate::widgets::filter_bar;
use crate::widgets::pattern_c::{
    context_card, context_stat_row, format_session_time, is_unread, markdown_body,
    pane_header_base, pattern_c_shell, sort_pinned_first, unread_dot, FollowScroll,
};
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「AI 智能 → AI Chat」URL（数据权威 gui-domain::sidebar）
pub const AI_CHAT_URL: &str = "/dashboard/ai/chat";

/// 流式显示快照节拍（ms；须大于 TextView 200ms 防抖窗口，见模块 doc-comment）
const STREAM_FLUSH_MILLIS: u64 = 250;

/// 气泡最大宽度（px；宽窗下保持可读行长）
const BUBBLE_MAX_WIDTH: f32 = 640.0;

// ---------------------------------------------------------------------------
// 事件（UI 偏好上抛组合根持久化；视图层不碰文件系统，BLF-794~800 纪律）
// ---------------------------------------------------------------------------

/// Pattern C 偏好事件：置顶列表 / 右上下文栏收起态变化
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiChatEvent {
    /// 置顶会话 id 列表全量上抛（组合根直接覆盖持久化）
    PinnedSessionsChanged(Vec<i64>),
    /// 右上下文栏收起态
    ContextPaneCollapsed(bool),
}

impl EventEmitter<AiChatEvent> for AiChatView {}

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
    /// 流式代际计数（新发送 / 停止 → 旧消费循环与旧节拍循环失效）
    stream_generation: u64,

    // ---- BLF-800 Pattern C：三栏工作台状态 ----
    /// 置顶会话 id（GUI 本地偏好，事件链持久化；后端无置顶字段）
    pinned: Vec<i64>,
    /// 未读基线（本次运行的已读快照：会话 → 已读时的 updated_at；首屏
    /// 加载写全量基线避免开屏未读风暴，此后 select / done 时更新）
    read_marks: HashMap<i64, String>,
    /// 右上下文栏收起态（GUI 本地偏好，事件链持久化）
    context_collapsed: bool,
    /// 流式显示快照（喂 markdown 的节流内容；None = 非流式走精确渲染）
    stream_display: Option<String>,
    /// 中区消息流滚动跟随（贴底跟随 / 上翻暂停 / 回底恢复）
    scroll: FollowScroll,
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
            pinned: Vec::new(),
            read_marks: HashMap::new(),
            context_collapsed: false,
            stream_display: None,
            scroll: FollowScroll::new(),
        }
    }

    /// 注入 Pattern C 偏好（root.rs 懒创建时自 ui-prefs.json 恢复）
    pub fn with_session_prefs(
        mut self,
        pinned_conversations: Vec<i64>,
        context_collapsed: bool,
    ) -> Self {
        self.pinned = pinned_conversations;
        self.context_collapsed = context_collapsed;
        self
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
                        // 首屏基线：全量记为已读，避免开屏未读点风暴
                        if this.read_marks.is_empty() {
                            for conv in &conversations {
                                this.read_marks.insert(conv.id, conv.updated_at.clone());
                            }
                        }
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
        // 已读基线推进 + 首帧直落最新消息
        if let Some(conv) = self.conversations.iter().find(|c| c.id == conversation_id) {
            self.read_marks
                .insert(conversation_id, conv.updated_at.clone());
        }
        self.scroll.stick();
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
                        this.scroll.stick(); // 历史落位最新一条
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
        self.scroll.stick();
        cx.notify();
    }

    /// 删除会话（成功后本地移除；删的是当前会话则回到 landing 态；置顶关系一并清理）
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
                    this.read_marks.remove(&conversation_id);
                    this.unpin_conversation(conversation_id, cx);
                    if this.active_conv == Some(conversation_id) {
                        this.active_conv = None;
                        this.messages.clear();
                        this.scroll.stick();
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // ---------- Pattern C：置顶 / 右栏收起 ----------

    /// 切换置顶（本地偏好，全量 id 上抛持久化）
    pub fn toggle_pin(&mut self, conversation_id: i64, cx: &mut Context<Self>) {
        if self.pinned.contains(&conversation_id) {
            self.pinned.retain(|&id| id != conversation_id);
        } else {
            self.pinned.push(conversation_id);
        }
        cx.emit(AiChatEvent::PinnedSessionsChanged(self.pinned.clone()));
        cx.notify();
    }

    /// 取消置顶（内部辅助：删除会话时清理；已未置顶则 no-op）
    fn unpin_conversation(&mut self, conversation_id: i64, cx: &mut Context<Self>) {
        if !self.pinned.contains(&conversation_id) {
            return;
        }
        self.pinned.retain(|&id| id != conversation_id);
        cx.emit(AiChatEvent::PinnedSessionsChanged(self.pinned.clone()));
    }

    /// 切换右上下文栏收起态（本地偏好上抛持久化）
    pub fn toggle_context_pane(&mut self, cx: &mut Context<Self>) {
        self.context_collapsed = !self.context_collapsed;
        cx.emit(AiChatEvent::ContextPaneCollapsed(self.context_collapsed));
        cx.notify();
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
        // 流式显示快照归零（节拍任务逐步推进）
        self.stream_display = Some(String::new());
        self.stream_generation = self.stream_generation.wrapping_add(1);
        let generation = self.stream_generation;

        let client = self.client.clone();
        let existing_conv = self.active_conv;
        let model = self.selected_model.clone();
        let web_search = self.web_search;
        let bg = cx.background_executor().clone();

        // 节拍任务：把气泡累积内容按固定间隔同步到显示快照（渲染频率有界；
        // 快照间隔 > TextView 200ms 防抖窗口，流式期间画面持续推进不冻结）
        let bg_tick = bg.clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            loop {
                bg_tick.timer(Duration::from_millis(STREAM_FLUSH_MILLIS)).await;
                let alive = this
                    .update(cx, |this, cx| {
                        if this.stream_generation != generation || !this.is_streaming {
                            return false;
                        }
                        if let (Some(display), Some(last)) =
                            (this.stream_display.as_mut(), this.messages.last_mut())
                        {
                            if !last.is_user() && last.streaming && *display != last.content {
                                *display = last.content.clone();
                                cx.notify();
                            }
                        }
                        true
                    })
                    .unwrap_or(false);
                if !alive {
                    break;
                }
            }
        })
        .detach();

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
                system_prompt: String::new(),
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

    /// 停止当前流式回复：代际失效 + 调后端 cancel（跨 worker 生效）。
    /// 已生成的部分内容保留在气泡中（中断不丢）。
    pub fn stop_streaming(&mut self, cx: &mut Context<Self>) {
        if !self.is_streaming {
            return;
        }
        self.stream_generation = self.stream_generation.wrapping_add(1);
        self.is_streaming = false;
        self.stream_display = None; // 回到精确渲染：快照外的尾部增量一并呈现
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

    /// 应用单个流式事件到消息气泡（仅当前代际会被调用）。
    /// text_delta 只累积不 notify——渲染由节拍任务统一推进（见模块 doc-comment）。
    fn apply_stream_event(&mut self, event: StreamEvent, cx: &mut Context<Self>) {
        match event {
            StreamEvent::ContentBlockDelta { delta } => {
                if delta.kind == "text_delta" && !delta.text.is_empty() {
                    if let Some(last) = self.messages.last_mut() {
                        last.content.push_str(&delta.text);
                        last.thinking = false;
                    }
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
                // 用持久化后的双消息原位回填尾部（拿到服务端 id / token 用量；
                // 既有历史轮次保持不动——多轮对话不丢前文）
                if let (Some(user), Some(assistant)) =
                    (&payload.user_message, &payload.assistant_message)
                {
                    let user_bubble = ChatBubble::from_server(user);
                    let assistant_bubble = ChatBubble::from_server(assistant);
                    let len = self.messages.len();
                    if len >= 2 {
                        self.messages[len - 2] = user_bubble;
                        self.messages[len - 1] = assistant_bubble;
                    } else {
                        self.messages = vec![user_bubble, assistant_bubble];
                    }
                }
                self.stream_display = None; // 精确终稿渲染
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

    /// 流式错误落点：占位气泡标错 + 横幅文案 + 结束流式态（部分内容保留）
    fn mark_stream_error(&mut self, msg: String, cx: &mut Context<Self>) {
        self.stream_error = Some(msg);
        if let Some(last) = self.messages.last_mut() {
            last.streaming = false;
            last.error = true;
            last.searching = false;
            last.thinking = false;
        }
        self.is_streaming = false;
        self.stream_display = None; // 精确渲染已生成的部分内容
        cx.notify();
    }

    /// 流式收尾（代际匹配时）：结束 streaming 态
    fn finish_stream(&mut self, generation: u64, cx: &mut Context<Self>) {
        if generation != self.stream_generation {
            return; // 已被新发送 / 停止接管
        }
        self.is_streaming = false;
        self.stream_display = None;
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
            AiChatState::Ready => self.render_ready(window, cx),
        }
    }
}

impl AiChatView {
    // ---------- 就绪态主布局：Pattern C 三栏壳 ----------

    fn render_ready(&mut self, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = AppTheme::current(cx);
        // 滚动跟随：上一帧贴底则继续跟随新内容；用户上翻后几何自然离开
        // 底部即暂停，滚回底部 / 点「回到底部」恢复（推导式，无独立暂停位）
        if self.scroll.is_pinned() {
            self.scroll.stick();
        }
        let sessions = self.render_session_pane(&theme, cx);
        let center = self.render_center(window, &theme, cx);
        let context = self.render_context_pane(&theme);
        pattern_c_shell(
            &theme,
            "ai-chat",
            sessions,
            center,
            !self.context_collapsed,
            context,
        )
        .into_any_element()
    }

    // ---------- 左区：会话列表（标题/时间/未读 + 新建/删除/置顶） ----------

    fn render_session_pane(&self, theme: &AppTheme, cx: &Context<Self>) -> gpui::AnyElement {
        let view = cx.entity();
        let header =
            pane_header_base(theme, "ai-chat-sessions-header")
                .child(
                    div()
                        .text_size(px(FONT_BASE))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_secondary)
                        .child(format!("对话 · {}", self.conversations.len())),
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
                });

        if self.conversations.is_empty() {
            return v_flex()
                .h_full()
                .child(header)
                .child(
                    v_flex()
                        .flex_1()
                        .items_center()
                        .justify_center()
                        .px_4()
                        .gap_1()
                        .child(
                            div()
                                .text_size(px(FONT_BASE))
                                .text_color(theme.text_muted)
                                .child("暂无会话"),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.text_muted)
                                .child("点右上角 + 开始新对话"),
                        ),
                )
                .into_any_element();
        }

        // 置顶优先（组内保持服务端 updated_at 倒序）
        let mut ordered = self.conversations.clone();
        sort_pinned_first(&mut ordered, |conv| self.pinned.contains(&conv.id));

        let list = div().id("ai-chat-conversations").flex_1().min_h_0().overflow_y_scroll().child(
            v_flex().gap_0p5().px_1p5().pb_2().children(ordered.iter().map(|conv| {
                let selected = self.active_conv == Some(conv.id);
                let pinned = self.pinned.contains(&conv.id);
                let unread = is_unread(
                    &conv.updated_at,
                    self.read_marks.get(&conv.id).map(String::as_str),
                    selected,
                );
                let time_label = format_session_time(&conv.updated_at);
                let title: SharedString = if conv.title.trim().is_empty() {
                    "新对话".into()
                } else {
                    conv.title.clone().into()
                };

                let view_for_select = view.clone();
                let view_for_pin = view.clone();
                let view_for_delete = view.clone();
                let conversation_id = conv.id;

                h_flex()
                    .items_start()
                    .gap_0p5()
                    .mx_1p5()
                    .my_0p5()
                    .px_1()
                    .py_1()
                    .rounded_md()
                    .when(selected, |this| this.bg(theme.muted_fill))
                    // 置顶星标（独立热区；置顶 accent 实星 / 未置顶 muted 空心）
                    .child({
                        Button::new(SharedString::from(format!(
                            "ai-conv-pin-{conversation_id}"
                        )))
                        .ghost()
                        .xsmall()
                        .icon(
                            Icon::new(if pinned {
                                IconName::Star
                            } else {
                                IconName::StarOff
                            })
                            .with_size(px(13.))
                            .text_color(if pinned {
                                theme.accent
                            } else {
                                theme.text_muted
                            }),
                        )
                        .on_click(move |_, _, cx| {
                            view_for_pin.update(cx, |this, cx| {
                                this.toggle_pin(conversation_id, cx)
                            });
                        })
                    })
                    // 主区域：选中会话（标题 + 未读点 / 时间行）
                    .child(
                        div()
                            .id(SharedString::from(format!("ai-conv-{conversation_id}")))
                            .flex_1()
                            .min_w_0()
                            .cursor(gpui::CursorStyle::PointingHand)
                            .on_click(move |_, _, cx| {
                                view_for_select.update(cx, |this, cx| {
                                    this.select_conversation(conversation_id, cx)
                                });
                            })
                            .child(
                                v_flex().min_w_0().gap_0p5()
                                    .child(
                                        h_flex().items_center().gap_1()
                                            .child(
                                                div()
                                                    .flex_1()
                                                    .min_w_0()
                                                    .truncate()
                                                    .text_size(px(FONT_BASE))
                                                    .text_color(if selected {
                                                        theme.text_primary
                                                    } else {
                                                        theme.text_secondary
                                                    })
                                                    .child(title),
                                            )
                                            .children(unread.then(|| unread_dot(theme))),
                                    ),
                            )
                            .child(if time_label.is_empty() {
                                div().into_any_element()
                            } else {
                                div()
                                    .text_xs()
                                    .mono_tabular_nums()
                                    .text_color(theme.text_muted)
                                    .child(time_label)
                                    .into_any_element()
                            }),
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

        v_flex()
            .h_full()
            .child(header)
            .child(list)
            .into_any_element()
    }

    // ---------- 右区：上下文卡组（模型参数 / 会话统计） ----------

    fn render_context_pane(&self, theme: &AppTheme) -> gpui::AnyElement {
        let header = pane_header_base(theme, "ai-chat-context-header").child(
            div()
                .text_size(px(FONT_BASE))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_secondary)
                .child("上下文"),
        );

        let active_conv = self
            .active_conv
            .and_then(|id| self.conversations.iter().find(|c| c.id == id));

        // 模型参数卡：当前模型 / 联网搜索 / Provider 配置状态
        let model_card = context_card(theme, "ai-chat-card-model", "模型参数")
            .child(context_stat_row(
                theme,
                "模型",
                self.selected_model.clone().unwrap_or_else(|| "未选择".into()),
            ))
            .child(context_stat_row(
                theme,
                "联网搜索",
                if self.web_search { "开启" } else { "关闭" },
            ))
            .child(context_stat_row(
                theme,
                "Provider",
                if self.provider_configured {
                    "已配置"
                } else {
                    "未配置"
                },
            ));

        let mut pane = v_flex().h_full().child(header).child(
            v_flex()
                .id("ai-chat-context-scroll")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .p_2()
                .gap_2()
                .child(model_card),
        );

        match active_conv {
            Some(conv) => {
                // 会话统计卡：随会话切换刷新（id/消息数/token 用量/更新时间）
                let stats_card = context_card(theme, "ai-chat-card-stats", "会话统计")
                    .child(context_stat_row(theme, "会话 ID", format!("#{}", conv.id)))
                    .child(context_stat_row(
                        theme,
                        "消息数",
                        self.messages.len().to_string(),
                    ))
                    .child(context_stat_row(
                        theme,
                        "累计 tokens",
                        conv.total_tokens.to_string(),
                    ))
                    .child(context_stat_row(
                        theme,
                        "更新时间",
                        match format_session_time(&conv.updated_at) {
                            empty if empty.is_empty() => "--".to_string(),
                            label => label,
                        },
                    ));
                pane = pane.child(stats_card);
            }
            None => {
                // landing 态提示卡（客服 / 数字员工复用模板时在此注入客户卡 /
                // Listing SKU 卡等自定义上下文渲染器）
                pane = pane.child(
                    context_card(theme, "ai-chat-card-landing", "新对话").child(
                        div()
                            .px_2()
                            .pb_1p5()
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child("发送首条消息后自动创建会话"),
                    ),
                );
            }
        }

        pane.into_any_element()
    }

    // ---------- 中区：顶栏 + 消息流 + 输入区 ----------

    fn render_center(
        &mut self,
        window: &mut Window,
        theme: &AppTheme,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let show_back_to_bottom =
            !self.scroll.is_pinned() && !self.messages.is_empty() && !self.messages_loading;

        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .child(self.render_top_bar(theme, cx))
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
                        .child(div().text_xs().text_color(theme.danger).child(msg))
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
            // 消息流（relative 容器承载「回到底部」悬浮钮；非交互容器不拦截
            // 下方滚动区的滚轮事件，只有钮本身可点）
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(self.render_messages(theme, window, cx))
                    .children(show_back_to_bottom.then(|| {
                        let view = cx.entity();
                        h_flex()
                            .absolute()
                            .bottom_3()
                            .left_0()
                            .right_0()
                            .justify_center()
                            .child(
                                Button::new("ai-chat-back-to-bottom")
                                    .ghost()
                                    .small()
                                    .icon(Icon::new(IconName::ArrowDown).with_size(px(13.)))
                                    .label("回到底部")
                                    .on_click(move |_, _, cx| {
                                        view.update(cx, |this, cx| {
                                            this.scroll.stick();
                                            cx.notify();
                                        });
                                    }),
                            )
                    })),
            )
            .child(self.render_input_bar(theme, cx))
            .into_any_element()
    }

    // ---------- 中区顶栏：模型选择 + 联网搜索 + 流式状态 + 右栏开关 ----------

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
            .py_1p5()
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
                div()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child(s)
            }))
            .child({
                // Pattern C：右上下文栏整体开合（偏好经事件链持久化）
                let view = cx.entity();
                Button::new("ai-chat-context-toggle")
                    .ghost()
                    .xsmall()
                    .icon(Icon::new(if self.context_collapsed {
                        IconName::PanelRightOpen
                    } else {
                        IconName::PanelRightClose
                    }))
                    .on_click(move |_, _, cx| {
                        view.update(cx, AiChatView::toggle_context_pane);
                    })
            })
            .into_any_element()
    }

    // ---------- 消息流（markdown 渲染 + 滚动跟随） ----------

    fn render_messages(
        &mut self,
        theme: &AppTheme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
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
                                .font_weight(FontWeight::SEMIBOLD)
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

        // markdown 正文逐条构造（TextView 构造需要 &mut Window / App，
        // 无法放进 children 闭包）；元素 id 按「会话 × 下标」稳定唯一，
        // keyed state 跨帧复用实现增量重解析不闪烁
        let conv_key: String = self
            .active_conv
            .map(|id| id.to_string())
            .unwrap_or_else(|| "new".into());
        let last_ix = self.messages.len() - 1;
        let mut bubbles: Vec<gpui::AnyElement> = Vec::with_capacity(self.messages.len());
        for (i, bubble) in self.messages.iter().enumerate() {
            bubbles.push(render_bubble(
                bubble,
                i,
                i == last_ix,
                &conv_key,
                self.stream_display.as_deref(),
                theme,
                window,
                cx,
            ));
        }

        div()
            .id("ai-chat-messages")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(self.scroll.handle())
            .child(
                v_flex()
                    .w_full()
                    .max_w(px(BUBBLE_MAX_WIDTH * 1.35))
                    .mx_auto()
                    .p_4()
                    .gap_3()
                    .children(bubbles),
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


/// 单条消息气泡（用户右对齐强调底纯文本 / 助手左对齐卡片底 markdown）。
/// 流式槽位（末条助手消息且 streaming 中）渲染显示快照 + 光标——快照按
/// STREAM_FLUSH_MILLIS 节拍推进，满足 TextView 200ms 防抖窗口（见模块
/// doc-comment「渲染节拍」）；完成后切回精确内容。
#[allow(clippy::too_many_arguments)]
fn render_bubble(
    bubble: &ChatBubble,
    index: usize,
    is_last: bool,
    conv_key: &str,
    stream_display: Option<&str>,
    theme: &AppTheme,
    window: &mut Window,
    cx: &mut App,
) -> gpui::AnyElement {
    let element_id = SharedString::from(format!("ai-msg-{conv_key}-{index}"));
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

    // 助手气泡：状态行（搜索 / 思考）+ 正文 + 元信息
    let streaming_slot = bubble.streaming && is_last;
    let md_source: String = if streaming_slot {
        format!("{} ▍", stream_display.unwrap_or(""))
    } else {
        bubble.content.clone()
    };

    let body: gpui::AnyElement = if bubble.content.is_empty() && bubble.error {
        div()
            .text_sm()
            .text_color(theme.danger)
            .child("生成失败")
            .into_any_element()
    } else if bubble.content.is_empty() {
        div()
            .text_sm()
            .text_color(theme.text_muted)
            .child("…")
            .into_any_element()
    } else {
        markdown_body(element_id.clone(), md_source, window, cx).into_any_element()
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
                    div().text_xs().text_color(theme.text_muted).child("思考中…")
                }))
                .child(body)
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
            assert!(this.stream_display.is_none(), "done 清空流式快照走精确渲染");
            assert_eq!(
                this.conversations[0].title, "自动标题",
                "title_regenerated 同步侧栏标题"
            );
        });
    }

    #[gpui::test]
    async fn done_splices_tail_and_keeps_history(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| AiChatView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            // 多轮：既有 4 条历史 + 本轮乐观对（user + placeholder）
            this.active_conv = Some(7);
            this.messages = vec![
                ChatBubble::from_server(&sample_message(1, "user", "第一问")),
                ChatBubble::from_server(&sample_message(2, "assistant", "第一答")),
                ChatBubble::user("第二问".into()),
                ChatBubble::assistant_placeholder(),
            ];
            this.stream_display = Some("部分".into());

            this.apply_stream_event(
                StreamEvent::Done(Box::new(StreamDonePayload {
                    user_message: Some(sample_message(11, "user", "第二问")),
                    assistant_message: Some(sample_message(12, "assistant", "第二答")),
                    conversation_title: None,
                    token_usage: None,
                    duration_ms: None,
                    title_regenerated: false,
                })),
                cx,
            );

            assert_eq!(this.messages.len(), 4, "历史轮次不丢");
            assert_eq!(this.messages[0].content, "第一问", "前轮用户消息保持");
            assert_eq!(this.messages[1].content, "第一答", "前轮助手消息保持");
            assert_eq!(this.messages[2].total_tokens, 0, "尾部对被服务端消息替换");
            assert!(!this.messages[3].streaming);
            assert_eq!(this.messages[3].content, "第二答");
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

    // ---------- Pattern C：置顶 / 右栏收起 / 偏好注入 ----------

    #[gpui::test]
    async fn toggle_pin_emits_full_id_list(cx: &mut gpui::TestAppContext) {
        use std::cell::RefCell;
        use std::rc::Rc;

        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let events: Rc<RefCell<Vec<Vec<i64>>>> = Rc::new(RefCell::new(Vec::new()));
        let sink = events.clone();
        let (view, cx2) = cx.add_window_view(move |_window, cx| {
            let handle = cx.entity();
            let sink = sink.clone();
            cx.subscribe(&handle, move |_, _, event: &AiChatEvent, _| match event {
                AiChatEvent::PinnedSessionsChanged(ids) => sink.borrow_mut().push(ids.clone()),
                AiChatEvent::ContextPaneCollapsed(_) => {}
            })
            .detach();
            AiChatView::new(cx, dummy_client())
        });
        view.update(cx2, |this, cx| {
            this.toggle_pin(7, cx);
            this.toggle_pin(11, cx);
            this.toggle_pin(7, cx); // 再点取消
            assert_eq!(this.pinned, vec![11]);
        });
        assert_eq!(
            *events.borrow(),
            vec![vec![7], vec![7, 11], vec![11]],
            "每次变化全量上抛"
        );
    }

    #[gpui::test]
    async fn toggle_context_pane_flips_and_emits(cx: &mut gpui::TestAppContext) {
        use std::cell::RefCell;
        use std::rc::Rc;

        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let seen: Rc<RefCell<Option<bool>>> = Rc::new(RefCell::new(None));
        let sink = seen.clone();
        let (view, cx2) = cx.add_window_view(move |_window, cx| {
            let handle = cx.entity();
            let sink = sink.clone();
            cx.subscribe(&handle, move |_, _, event: &AiChatEvent, _| match event {
                AiChatEvent::ContextPaneCollapsed(collapsed) => {
                    *sink.borrow_mut() = Some(*collapsed);
                }
                AiChatEvent::PinnedSessionsChanged(_) => {}
            })
            .detach();
            AiChatView::new(cx, dummy_client())
        });
        view.update(cx2, |this, cx| {
            assert!(!this.context_collapsed, "默认展开");
            this.toggle_context_pane(cx);
            assert!(this.context_collapsed);
        });
        assert_eq!(*seen.borrow(), Some(true));
    }

    #[gpui::test]
    async fn session_prefs_builder_restores_state(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            AiChatView::new(cx, dummy_client()).with_session_prefs(vec![3, 9], true)
        });
        cx2.read(|app| {
            let this = view.read(app);
            assert_eq!(this.pinned, vec![3, 9], "置顶列表自偏好恢复");
            assert!(this.context_collapsed, "右栏收起态自偏好恢复");
        });
    }

    #[gpui::test]
    async fn stop_streaming_keeps_partial_content_and_clears_display(
        cx: &mut gpui::TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| AiChatView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.is_streaming = true;
            this.messages.push(ChatBubble::user("写一段长文".into()));
            this.messages.push(ChatBubble::assistant_placeholder());
            // 模拟节拍已把部分内容推进快照
            let last = this.messages.last_mut().unwrap();
            last.content.push_str("已生成的部分内容");
            this.stream_display = Some("已生成的部分".into());

            this.stop_streaming(cx);

            assert!(this.stream_display.is_none(), "停止后清空快照走精确渲染");
            assert_eq!(
                this.messages.last().unwrap().content,
                "已生成的部分内容",
                "中断不丢已生成内容（含快照外尾部增量）"
            );
            assert!(!this.messages.last().unwrap().streaming);
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
