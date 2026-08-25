//! 右侧 Inspector 上下文抽屉（BLF-796，Stage5）
//!
//! 六区外壳最右列的实装：280~340px 可调宽、Cmd+B 显隐切换（可见性与宽度经
//! [`crate::prefs`] 持久化，组合根读写）、按 Canvas 当前视图自适应三种内容形态。
//!
//! **三态内容适配器**：[`InspectorMode`] 枚举 + [`mode_for_view`] 静态注册表
//! （轻量总线——各视图以 `view_key` 声明所需形态）。未注册形态的页面抽屉整体
//! 隐藏入口（零宽、不渲染空面板），Cmd+B 不响应。
//!
//! | 形态 | 内容 | 注册页 |
//! |---|---|---|
//! | Operations 运营态 | Pending 订单流（轮询刷新）+ 库存告警 feed | 销售数据 |
//! | Ads 广告态 | ACoS/ROAS 等概览指标卡 + 关键词表现列表 | 广告分析 / 广告数据 |
//! | Copilot AI 态 | 流式响应容器（Stage9 会话工作台复用预留） | AI Chat |
//!
//! **数据源口径**（父 issue 规则：gui-api-client 现有端点优先，缺口用确定性
//! mock 并标注）：
//! - Ads 态：`ad_analysis_overview` 真实端点；项目/站点/日期随 Console Bar
//!   筛选联动。站点为「全部」或未选项目时不拉取，渲染引导提示。
//! - Operations 态：**数据缺口** —— Live Pending 订单流无对应端点（BLF-795
//!   PR 已记录「Pending 数据源未接入」）；库存告警后端虽有 `/alerts/events`
//!   但 gui-api-client 未封装。两者本期用确定性 mock 数据演示 feed 与轮询
//!   机制（[`mock_pending_rows`] / [`mock_alert_rows`] 纯函数），待端点封装
//!   后在迁移批次接入真实数据。
//! - Copilot 态：静态容器壳，会话与流式能力归 Stage9。

use chrono::NaiveDate;
use gpui::prelude::*;
use gpui::{
    div, px, AnimationExt, Context, CursorStyle, Div, DragMoveEvent, EventEmitter, FontWeight,
    IntoElement, MouseButton, MouseUpEvent, Render, SharedString, Stateful, WeakEntity, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants},
    Icon, IconName, Sizable,
};
use gui_api_client::Client;
use gui_domain::advertising::AdOverviewResponse;

use crate::theme::{AppTheme, FONT_2XS, FONT_MONO_FAMILY, FONT_XS};
use crate::views::shell::{INSPECTOR_WIDTH, INSPECTOR_WIDTH_MAX, INSPECTOR_WIDTH_MIN};

// ---------------------------------------------------------------------------
// 形态注册表（轻量总线）
// ---------------------------------------------------------------------------

/// Inspector 内容形态（三态适配器；各视图经 [`mode_for_view`] 注册）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InspectorMode {
    /// 运营态：Pending 订单流 + 库存告警 feed
    Operations,
    /// 广告态：ACoS/ROAS 概览卡 + 关键词表现列表
    Ads,
    /// AI 态：Copilot 流式响应容器
    Copilot,
}

impl InspectorMode {
    /// 头部标题
    fn title(self) -> &'static str {
        match self {
            InspectorMode::Operations => "运营动态",
            InspectorMode::Ads => "广告速览",
            InspectorMode::Copilot => "Copilot",
        }
    }

    /// 标题旁形态徽标（弱化色等宽小字）
    fn badge(self) -> &'static str {
        match self {
            InspectorMode::Operations => "PENDING·ALERTS",
            InspectorMode::Ads => "OVERVIEW",
            InspectorMode::Copilot => "AI",
        }
    }
}

/// 视图身份 → Inspector 形态注册表。
///
/// 各视图以 `view_key`（`RootView::view_key()` 返回值）在此声明所需形态；
/// 未列出的页面返回 `None` = 未注册 → 抽屉零宽隐藏入口。新页面接入加一行
/// match 分支即可（O(1) 无状态查询，无需事件广播）。
pub(crate) fn mode_for_view(view_key: &str) -> Option<InspectorMode> {
    match view_key {
        // 运营态验收基准页：销售数据（订单流 / 库存告警同属运营域）
        "daily-analysis" => Some(InspectorMode::Operations),
        // 广告态：广告分析 + 广告数据（同域共享概览端点）
        "ad-analysis" | "ad-data" => Some(InspectorMode::Ads),
        // AI 态验收基准页：AI Chat
        "ai-chat" => Some(InspectorMode::Copilot),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// 尺寸契约与事件
// ---------------------------------------------------------------------------

/// 宽度夹紧到 280~340 规格区间（拖拽调宽 / 偏好恢复共用纯函数）
pub(crate) fn clamp_width(width: f32) -> f32 {
    width.clamp(INSPECTOR_WIDTH_MIN, INSPECTOR_WIDTH_MAX)
}

/// 由窗口宽与鼠标横坐标推导抽屉目标宽（手柄贴抽屉左缘，向左拖 = 变宽）
fn width_for_pointer(window_width: f32, pointer_x: f32) -> f32 {
    clamp_width(window_width - pointer_x)
}

/// 抽屉事件（宿主 RootView 订阅后转发组合根持久化）
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum InspectorEvent {
    /// Cmd+B 开合变化（持久化 visible 偏好）
    VisibleChanged(bool),
    /// 拖拽调宽结束（持久化宽度偏好；拖拽过程中不 emit，避免频繁写盘）
    WidthCommitted(f32),
}

/// Operations 轮询周期（mock feed 演示节奏；接真实端点后可收紧到 5~10s）
const OPS_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// 头部行高度（高密度规格：28~32px 控件带）
const HEADER_HEIGHT: f32 = 32.0;
/// feed 行高（高密度规格：24~28px）
const OPS_ROW_HEIGHT: f32 = 26.0;
/// 拖拽手柄命中区宽度
const RESIZE_HANDLE_HIT: f32 = 6.0;
/// 概览指标卡最小宽（窄抽屉下两列换行的下限）
const METRIC_CARD_MIN_W: f32 = 118.0;

/// Copilot 静态演示转录（role, text）；末条 `▊` 模拟流式光标
const COPILOT_TRANSCRIPT: [(&str, &str); 2] = [
    ("user", "帮我总结上周 US 站 ACoS 的变化"),
    (
        "assistant",
        "上周 US 站 ACoS 21.4% → 19.8%，主要由 negative keyword 清理带来 ▊",
    ),
];

/// 拖拽标记类型（on_drag/on_drag_move 配对用；无数据负载）
#[derive(Debug)]
struct InspectorResize;

/// 拖拽视觉反馈：跟随光标的 accent 细条
struct InspectorResizeGhost;

impl Render for InspectorResizeGhost {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        div()
            .w(px(2.0))
            .h(px(48.0))
            .rounded(px(1.0))
            .bg(theme.accent)
    }
}

// ---------------------------------------------------------------------------
// 确定性 mock 数据（Operations 态数据缺口标注，见模块注释）
// ---------------------------------------------------------------------------

/// Pending 订单池（order_no / sku / 滞留分钟 / 金额 USD）
const MOCK_PENDING_POOL: [(&str, &str, i64, f64); 8] = [
    ("114-2203316-4185822", "BB-US-0134", 42, 128.4),
    ("114-7719025-6632147", "BB-US-0087", 95, 76.2),
    ("113-4509812-1157460", "BB-US-0421", 143, 342.8),
    ("112-3384761-9920348", "BB-DE-0102", 201, 89.9),
    ("114-9023178-5540613", "BB-UK-0233", 258, 210.5),
    ("113-6672914-3308572", "BB-US-0315", 372, 56.7),
    ("112-8815403-7761290", "BB-US-0009", 489, 465.0),
    ("114-1250769-2084637", "BB-DE-0351", 604, 133.3),
];

/// 库存告警池（sku / 天数覆盖 / 是否断货风险）
const MOCK_ALERT_POOL: [(&str, i64, bool); 6] = [
    ("BB-US-0134", 3, false),
    ("BB-US-0421", 1, true),
    ("BB-DE-0102", 7, false),
    ("BB-UK-0233", 2, true),
    ("BB-US-0087", 12, false),
    ("BB-US-0315", 5, false),
];

/// 轮询 tick → 确定性 Pending 行（池内轮转取 5 条；无随机数，测试可复现）
fn mock_pending_rows(tick: u64) -> Vec<(&'static str, &'static str, i64, f64)> {
    let start = (tick as usize) % MOCK_PENDING_POOL.len();
    (0..5)
        .map(|i| MOCK_PENDING_POOL[(start + i) % MOCK_PENDING_POOL.len()])
        .collect()
}

/// 轮询 tick → 确定性告警行（池内轮转取 4 条；无随机数，测试可复现）
fn mock_alert_rows(tick: u64) -> Vec<(&'static str, i64, bool)> {
    let start = (tick as usize) % MOCK_ALERT_POOL.len();
    (0..4)
        .map(|i| MOCK_ALERT_POOL[(start + i) % MOCK_ALERT_POOL.len()])
        .collect()
}

// ---------------------------------------------------------------------------
// InspectorView
// ---------------------------------------------------------------------------

/// 广告态数据装载状态
#[derive(Debug, Clone, Default)]
enum AdsState {
    #[default]
    /// 尚未请求（进入广告态且上下文就绪时触发首拉）
    Idle,
    /// 控制条未选项目 → 引导提示
    NeedProject,
    /// 站点为「全部」而概览端点要求具体站点 → 引导提示
    NeedCountry,
    Loading,
    Loaded(Box<AdOverviewResponse>),
    Failed(String),
}

/// 右侧 Inspector 抽屉视图（容器 + 三态内容适配器）
pub struct InspectorView {
    mode: Option<InspectorMode>,
    visible: bool,
    width: f32,
    /// 开合过渡起点宽（toggle 时记录；动画 id 含 generation 驱动重放）
    anim_from: f32,
    anim_gen: u32,

    client: Client,

    // ---- Ads 态 ----
    ads_project_id: Option<i64>,
    ads_country: &'static str,
    ads_date_from: Option<NaiveDate>,
    ads_date_to: Option<NaiveDate>,
    ads_state: AdsState,
    /// 最近一次成功加载的上下文指纹（切项目/站点后判定 stale 重拉）
    ads_loaded_for: Option<(Option<i64>, &'static str)>,
    ads_request_id: u64,

    // ---- Operations 态（mock 管线状态） ----
    ops_tick: u64,
    ops_generation: u64,
    /// 拖拽调宽进行中（move 置位、释放提交后复位；鼠标释放监听据此区分噪声）
    resizing: bool,
}

impl InspectorView {
    pub fn new(client: Client, visible: bool, width: Option<u16>, _cx: &mut Context<Self>) -> Self {
        let width = width
            .map(|w| clamp_width(w as f32))
            .unwrap_or(INSPECTOR_WIDTH);
        Self {
            mode: None,
            visible,
            width,
            anim_from: if visible { width } else { 0.0 },
            anim_gen: 0,
            client,
            ads_project_id: None,
            ads_country: "US",
            ads_date_from: None,
            ads_date_to: None,
            ads_state: AdsState::Idle,
            ads_loaded_for: None,
            ads_request_id: 0,
            ops_tick: 0,
            ops_generation: 0,
            resizing: false,
        }
    }

    // ---------------- 只读状态（测试消费） ----------------

    #[allow(dead_code)] // 测试消费（对齐各视图 current_state 惯例）
    pub(crate) fn mode(&self) -> Option<InspectorMode> {
        self.mode
    }

    #[allow(dead_code)] // 测试消费
    pub(crate) fn visible(&self) -> bool {
        self.visible
    }

    #[allow(dead_code)] // 测试消费
    pub(crate) fn width(&self) -> f32 {
        self.width
    }

    /// 广告态装载状态标签（只读，测试断言用）
    #[allow(dead_code)] // 测试消费（对齐各视图 current_state 惯例）
    pub(crate) fn ads_state_label(&self) -> &'static str {
        match self.ads_state {
            AdsState::Idle => "idle",
            AdsState::NeedProject => "need_project",
            AdsState::NeedCountry => "need_country",
            AdsState::Loading => "loading",
            AdsState::Loaded(_) => "loaded",
            AdsState::Failed(_) => "failed",
        }
    }

    // ---------------- 形态与上下文（RootView 总线入口） ----------------

    /// Canvas 当前视图声明所需形态（未注册 → None → 零宽隐藏入口）。
    ///
    /// 同时接收 Console Bar 当前筛选快照作为 Ads 态数据上下文。形态变化时
    /// 按需重置内容状态并触发首拉 / 轮询；同形态下上下文变化只影响 Ads。
    pub(crate) fn set_mode(
        &mut self,
        mode: Option<InspectorMode>,
        project_id: Option<i64>,
        country: &'static str,
        date_from: Option<NaiveDate>,
        date_to: Option<NaiveDate>,
        cx: &mut Context<Self>,
    ) {
        let context_changed = self.ads_project_id != project_id
            || self.ads_country != country
            || self.ads_date_from != date_from
            || self.ads_date_to != date_to;
        self.ads_project_id = project_id;
        self.ads_country = country;
        self.ads_date_from = date_from;
        self.ads_date_to = date_to;

        if self.mode == mode {
            if mode == Some(InspectorMode::Ads)
                && self.visible
                && context_changed
                && self.ads_stale()
            {
                self.reload_ads(cx);
            }
            return;
        }
        self.mode = mode;
        // 形态切换使旧轮询循环在下个唤醒点自退出
        self.ops_generation = self.ops_generation.wrapping_add(1);
        self.ads_state = AdsState::Idle;
        self.ads_loaded_for = None;

        if self.visible {
            if mode == Some(InspectorMode::Operations) {
                self.start_ops_poll(cx);
            } else if mode == Some(InspectorMode::Ads) {
                self.reload_ads(cx);
            }
        }
        cx.notify();
    }

    /// Console Bar 筛选变化 → 更新 Ads 上下文（仅广告态且可见且 stale 时重拉）。
    pub(crate) fn set_console_context(
        &mut self,
        project_id: Option<i64>,
        country: &'static str,
        date_from: Option<NaiveDate>,
        date_to: Option<NaiveDate>,
        cx: &mut Context<Self>,
    ) {
        self.set_mode_inner_context(project_id, country, date_from, date_to, cx);
    }

    /// Cmd+B 开合切换（未注册形态 no-op——无入口亦不响应快捷键）。
    /// 发 [`InspectorEvent::VisibleChanged`] 供组合根持久化偏好。
    pub(crate) fn toggle_visible(&mut self, cx: &mut Context<Self>) {
        if self.mode.is_none() {
            return;
        }
        self.anim_gen = self.anim_gen.wrapping_add(1);
        self.anim_from = if self.visible { self.width } else { 0.0 };
        self.visible = !self.visible;
        if self.visible {
            if self.mode == Some(InspectorMode::Operations) {
                self.start_ops_poll(cx);
            } else if self.mode == Some(InspectorMode::Ads) && self.ads_stale() {
                self.reload_ads(cx);
            }
        } else {
            self.ops_generation = self.ops_generation.wrapping_add(1);
        }
        cx.emit(InspectorEvent::VisibleChanged(self.visible));
        cx.notify();
    }

    fn set_mode_inner_context(
        &mut self,
        project_id: Option<i64>,
        country: &'static str,
        date_from: Option<NaiveDate>,
        date_to: Option<NaiveDate>,
        cx: &mut Context<Self>,
    ) {
        self.ads_project_id = project_id;
        self.ads_country = country;
        self.ads_date_from = date_from;
        self.ads_date_to = date_to;
        if self.mode == Some(InspectorMode::Ads) && self.visible && self.ads_stale() {
            self.reload_ads(cx);
        }
    }

    // ---------------- Operations 轮询（mock 管线） ----------------

    /// 启动轮询循环：每 [`OPS_POLL_INTERVAL`] 刷新一次 mock feed（tick 驱动，
    /// 行内容由渲染期 [`mock_pending_rows`] / [`mock_alert_rows`] 纯函数推导）。
    ///
    /// generation 守卫：形态切换 / 收起 / 实体销毁后旧循环在下个唤醒点自退出；
    /// 仅可见时 notify（隐藏期间只睡眠）。
    fn start_ops_poll(&mut self, cx: &mut Context<Self>) {
        self.ops_generation = self.ops_generation.wrapping_add(1);
        let generation = self.ops_generation;
        let bg = cx.background_executor().clone();
        cx.spawn(
            async move |this: WeakEntity<Self>, cx: &mut gpui::AsyncApp| loop {
                bg.timer(OPS_POLL_INTERVAL).await;
                let alive = this
                    .update(cx, |this, cx| {
                        if this.ops_generation != generation
                            || this.mode != Some(InspectorMode::Operations)
                            || !this.visible
                        {
                            return false;
                        }
                        this.ops_tick = this.ops_tick.wrapping_add(1);
                        cx.notify();
                        true
                    })
                    .ok()
                    .unwrap_or(false);
                if !alive {
                    break;
                }
            },
        )
        .detach();
    }

    // ---------------- Ads 真实数据管线 ----------------

    /// 相对最近一次成功加载，项目/站点上下文是否已变化
    fn ads_stale(&self) -> bool {
        let loaded = self.ads_loaded_for;
        match (&self.ads_state, loaded) {
            (AdsState::Loaded(_), Some((project, country))) => {
                (project, country) != (self.ads_project_id, self.ads_country)
            }
            _ => true,
        }
    }

    /// 拉取广告概览（竞态保护对齐 ad_analysis.rs：只应用最新 request id）。
    /// 日期缺省时不传 from/to（端点回退最新可用数据窗口，见 advertising.rs）。
    fn reload_ads(&mut self, cx: &mut Context<Self>) {
        let Some(project_id) = self.ads_project_id else {
            self.ads_state = AdsState::NeedProject;
            cx.notify();
            return;
        };
        if self.ads_country == "ALL" {
            // 概览端点要求具体站点（frontend ad-analysis COUNTRY_OPTIONS 无「全部」）
            self.ads_state = AdsState::NeedCountry;
            cx.notify();
            return;
        }

        self.ads_request_id = self.ads_request_id.wrapping_add(1);
        let request_id = self.ads_request_id;
        self.ads_state = AdsState::Loading;
        cx.notify();

        let client = self.client.clone();
        let country = self.ads_country;
        let date_from = self.ads_date_from;
        let date_to = self.ads_date_to;
        let bg = cx.background_executor().clone();
        cx.spawn(
            async move |this: WeakEntity<Self>, cx: &mut gpui::AsyncApp| {
                let result = bg
                    .spawn(async move {
                        crate::runtime::runtime().block_on(
                            client.ad_analysis_overview(project_id, country, date_from, date_to),
                        )
                    })
                    .await;
                this.update(cx, |this, cx| {
                    if this.ads_request_id != request_id {
                        return;
                    }
                    this.ads_state = match result {
                        Ok(overview) => {
                            this.ads_loaded_for = Some((this.ads_project_id, this.ads_country));
                            AdsState::Loaded(Box::new(overview))
                        }
                        Err(e) => AdsState::Failed(e.user_message()),
                    };
                    cx.notify();
                })
                .ok();
            },
        )
        .detach();
    }

    // ---------------- 渲染 ----------------

    /// 手柄拖拽中：按指针位置更新目标宽并重绘（不 emit，松开才提交持久化）
    fn apply_resize(&mut self, window_width: f32, pointer_x: f32, cx: &mut Context<Self>) {
        self.resizing = true;
        let next = width_for_pointer(window_width, pointer_x);
        if (next - self.width).abs() > f32::EPSILON {
            self.width = next;
            cx.notify();
        }
    }

    /// 拖拽结束提交宽度（手柄内松开 = `on_mouse_up` 命中；手柄外松开 =
    /// `on_mouse_up_out` 兜底——两者互斥恰命中其一）。非拖拽期释放一律 no-op。
    fn commit_resize(&mut self, cx: &mut Context<Self>) {
        if !self.resizing {
            return;
        }
        self.resizing = false;
        cx.emit(InspectorEvent::WidthCommitted(self.width));
    }

    /// 左缘拖拽手柄：6px 命中区 + ResizeLeftRight 光标。
    ///
    /// 交互链（gpui DnD 机制）：`on_drag` 启动标记型拖拽 → `on_drag_move`
    /// 在 Capture 相位接收**全窗口** move 事件（指针离开手柄也持续回调）→
    /// 松开时 `on_mouse_up` / `on_mouse_up_out` 二选一命中提交。ghost 渲染
    /// accent 细条作拖拽视觉反馈（[`InspectorResizeGhost`]）。
    fn resize_handle(&self, theme: &AppTheme, cx: &mut Context<Self>) -> Stateful<Div> {
        div()
            .id("inspector-resize-handle")
            .absolute()
            .left_0()
            .top_0()
            .bottom_0()
            .w(px(RESIZE_HANDLE_HIT))
            .cursor(CursorStyle::ResizeLeftRight)
            .hover(|style| style.bg(theme.muted_fill))
            .child(
                // 左缘 1px 细条（常态即见，提示可拖拽）
                div()
                    .absolute()
                    .left(px(1.0))
                    .top_0()
                    .bottom_0()
                    .w(px(1.0))
                    .bg(theme.separator),
            )
            .on_drag(InspectorResize, |_, _, _, cx| {
                cx.new(|_| InspectorResizeGhost)
            })
            .on_drag_move(
                cx.listener(|this, ev: &DragMoveEvent<InspectorResize>, window, cx| {
                    this.apply_resize(
                        window.viewport_size().width.into(),
                        ev.event.position.x.into(),
                        cx,
                    );
                }),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _: &MouseUpEvent, _, cx| this.commit_resize(cx)),
            )
            .on_mouse_up_out(
                MouseButton::Left,
                cx.listener(|this, _: &MouseUpEvent, _, cx| this.commit_resize(cx)),
            )
    }

    /// 头部行（32px）：形态标题 + 徽标 + 收起按钮
    fn header(mode: InspectorMode, theme: &AppTheme, cx: &mut Context<Self>) -> Stateful<Div> {
        div()
            .id("inspector-header")
            .flex()
            .items_center()
            .gap_2()
            .w_full()
            .flex_none()
            .h(px(HEADER_HEIGHT))
            .px_3()
            .border_b_1()
            .border_color(theme.separator)
            .child(
                div()
                    .text_size(px(FONT_XS))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme.text_primary)
                    .child(mode.title()),
            )
            .child(
                div()
                    .text_size(px(FONT_2XS))
                    .font_family(FONT_MONO_FAMILY)
                    .text_color(theme.text_muted)
                    .child(mode.badge()),
            )
            .child(div().id("inspector-header-spacer").flex_1())
            .child(
                Button::new("inspector-close")
                    .ghost()
                    .small()
                    .icon(Icon::new(IconName::PanelRightClose).with_size(px(14.0)))
                    // BLF-828：快捷键文案平台化（macOS ⌘B / Windows Ctrl+B）
                    .tooltip(format!("收起 Inspector（{}）", crate::platform::combo("B")))
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_visible(cx))),
            )
    }

    /// 运营态内容：Pending 订单流（tick 驱动轮转的确定性 mock）+ 库存告警 feed。
    /// 数据缺口标注见模块注释——端点封装后仅替换本函数数据来源，布局不动。
    fn body_ops(theme: &AppTheme, tick: u64) -> Stateful<Div> {
        let pending = mock_pending_rows(tick);
        let alerts = mock_alert_rows(tick);

        let mut pending_rows = Vec::with_capacity(pending.len());
        for (order_no, sku, age_min, amount) in pending {
            pending_rows.push(
                div()
                    .id(SharedString::from(format!("ops-order-{order_no}")))
                    .flex()
                    .items_center()
                    .gap_2()
                    .w_full()
                    .h(px(OPS_ROW_HEIGHT))
                    .px_3()
                    .hover(|style| style.bg(theme.muted_fill))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(FONT_2XS))
                            .font_family(FONT_MONO_FAMILY)
                            .text_color(theme.text_primary)
                            .truncate()
                            .child(order_no),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_size(px(FONT_2XS))
                            .font_family(FONT_MONO_FAMILY)
                            .text_color(theme.text_muted)
                            .child(sku),
                    )
                    .child(age_pill(age_min, theme))
                    .child(
                        div()
                            .flex_none()
                            .w(px(52.0))
                            .text_right()
                            .text_size(px(FONT_2XS))
                            .font_family(FONT_MONO_FAMILY)
                            .text_color(theme.text_primary)
                            .child(format_money_usd(amount)),
                    ),
            );
        }

        let mut alert_rows = Vec::with_capacity(alerts.len());
        for (sku, days_cover, stockout) in alerts {
            alert_rows.push(
                div()
                    .id(SharedString::from(format!("ops-alert-{sku}-{days_cover}")))
                    .flex()
                    .items_center()
                    .gap_2()
                    .w_full()
                    .h(px(OPS_ROW_HEIGHT))
                    .px_3()
                    .hover(|style| style.bg(theme.muted_fill))
                    .child(risk_dot(stockout, theme))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_size(px(FONT_2XS))
                            .font_family(FONT_MONO_FAMILY)
                            .text_color(theme.text_primary)
                            .truncate()
                            .child(sku),
                    )
                    .child(
                        div()
                            .text_size(px(FONT_2XS))
                            .font_family(FONT_MONO_FAMILY)
                            .text_color(if stockout {
                                theme.danger
                            } else {
                                theme.warning
                            })
                            .child(SharedString::from(format!("覆盖 {days_cover} 天"))),
                    )
                    .when(stockout, |row| {
                        row.child(
                            div()
                                .px_1()
                                .rounded(px(2.0))
                                .bg(theme.danger_soft)
                                .text_size(px(FONT_2XS))
                                .font_family(FONT_MONO_FAMILY)
                                .text_color(theme.danger)
                                .child("断货风险"),
                        )
                    }),
            );
        }

        div()
            .id("inspector-body-ops")
            .flex_col()
            .w_full()
            .pb_2()
            .child(section_title("Pending 订单流", theme))
            .children(pending_rows)
            .child(section_title("库存告警", theme))
            .children(alert_rows)
            // 数据缺口标注（父 issue 规则：mock 不阻塞布局交付）
            .child(
                div()
                    .px_3()
                    .pt_2()
                    .text_size(px(FONT_2XS))
                    .text_color(theme.text_muted)
                    .child("演示数据 · Pending/库存告警端点缺口见 BLF-796"),
            )
    }

    /// 广告态内容：概览指标卡 + 关键词表现列表（真实端点 `ad_analysis_overview`）。
    fn body_ads(&self, theme: &AppTheme) -> Stateful<Div> {
        match &self.ads_state {
            AdsState::Idle | AdsState::Loading => hint_body("加载中…", theme),
            AdsState::NeedProject => hint_body("在顶部控制条选择项目后展示广告概览", theme),
            AdsState::NeedCountry => hint_body("「全部站点」暂不支持概览，请选择具体站点", theme),
            AdsState::Failed(msg) => hint_body(&format!("加载失败：{msg}"), theme),
            AdsState::Loaded(overview) => {
                let mut cards = Vec::new();
                for metric in &overview.metrics {
                    cards.push(
                        div()
                            .id(SharedString::from(format!("ads-metric-{}", metric.label)))
                            .flex_col()
                            .flex_1()
                            .min_w(px(METRIC_CARD_MIN_W))
                            .px_2()
                            .py_1()
                            .rounded(px(3.0))
                            .bg(theme.panel_bg)
                            .border_1()
                            .border_color(theme.separator)
                            .child(
                                div()
                                    .text_size(px(FONT_2XS))
                                    .text_color(theme.text_muted)
                                    .truncate()
                                    .child(metric.label.clone()),
                            )
                            .child(
                                div()
                                    .text_size(px(FONT_XS))
                                    .font_family(FONT_MONO_FAMILY)
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.text_primary)
                                    .child(metric.display_value.clone()),
                            )
                            .when_some(metric.helper.clone(), |card, helper| {
                                card.child(
                                    div()
                                        .text_size(px(FONT_2XS))
                                        .text_color(theme.text_secondary)
                                        .truncate()
                                        .child(helper),
                                )
                            }),
                    );
                }

                let mut term_rows = Vec::new();
                for term in &overview.top_waste_terms {
                    term_rows.push(
                        div()
                            .id(SharedString::from(format!(
                                "ads-term-{}-{:.2}",
                                term.search_term.as_deref().unwrap_or("-"),
                                term.spend
                            )))
                            .flex()
                            .items_center()
                            .gap_2()
                            .w_full()
                            .h(px(OPS_ROW_HEIGHT))
                            .px_3()
                            .hover(|style| style.bg(theme.muted_fill))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .text_size(px(FONT_2XS))
                                    .text_color(theme.text_primary)
                                    .truncate()
                                    .child(
                                        term.search_term
                                            .clone()
                                            .unwrap_or_else(|| "（无搜索词）".into()),
                                    ),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .text_size(px(FONT_2XS))
                                    .font_family(FONT_MONO_FAMILY)
                                    .text_color(theme.text_muted)
                                    .child(SharedString::from(format!("{} 次点击", term.clicks))),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .text_size(px(FONT_2XS))
                                    .font_family(FONT_MONO_FAMILY)
                                    .text_color(theme.text_primary)
                                    .child(format_money_usd(term.spend)),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .text_size(px(FONT_2XS))
                                    .font_family(FONT_MONO_FAMILY)
                                    .text_color(if term.orders_7d == 0 {
                                        theme.danger
                                    } else {
                                        theme.success
                                    })
                                    .child(SharedString::from(format!("{} 单", term.orders_7d))),
                            ),
                    );
                }
                let metrics_empty = cards.is_empty();
                let terms_empty = term_rows.is_empty();

                div()
                    .id("inspector-body-ads")
                    .flex_col()
                    .w_full()
                    .pb_2()
                    // 概览卡网格（ACoS / ROAS / 花费等；display_value 后端预制）
                    .child(section_title("概览指标", theme))
                    .when(!metrics_empty, |body| {
                        body.child(
                            div()
                                .id("inspector-ads-metrics")
                                .flex()
                                .flex_wrap()
                                .gap_1()
                                .px_3()
                                .pb_1()
                                .children(cards),
                        )
                    })
                    .child(section_title("关键词表现", theme))
                    .when(!terms_empty, |body| body.children(term_rows))
                    .when(metrics_empty && terms_empty, |body| {
                        body.child(hint_body("当前窗口暂无广告数据", theme))
                    })
            }
        }
    }

    /// AI 态内容：Copilot 流式响应容器壳（静态演示转录；会话/流式能力归
    /// Stage9 会话工作台复用——容器结构即复用边界）。
    fn body_copilot(theme: &AppTheme) -> Stateful<Div> {
        let bubbles: Vec<Stateful<Div>> = COPILOT_TRANSCRIPT
            .iter()
            .enumerate()
            .map(|(index, (role, text))| {
                let is_user = *role == "user";
                let bubble = div()
                    .id(SharedString::from(format!("copilot-bubble-{index}")))
                    .flex_col()
                    .w_full()
                    .px_3()
                    .py_1()
                    .child(
                        div()
                            .max_w_full()
                            .px_2()
                            .py_1()
                            .rounded(px(4.0))
                            .border_1()
                            .border_color(theme.separator)
                            .text_size(px(FONT_2XS))
                            .when(is_user, |b| {
                                b.bg(theme.panel_bg)
                                    .text_color(theme.text_secondary)
                                    .child(text.to_string())
                            })
                            .when(!is_user, |b| {
                                b.bg(theme.card_bg)
                                    .text_color(theme.text_primary)
                                    .child(text.to_string())
                            }),
                    );
                if is_user {
                    // 用户消息靠右（对齐常见会话布局；Stage9 接真实数据后保持）
                    bubble.items_end()
                } else {
                    bubble
                }
            })
            .collect();

        div()
            .id("inspector-body-copilot")
            .flex_col()
            .w_full()
            .h_full()
            .child(
                div()
                    .id("copilot-transcript")
                    .flex_col()
                    .gap_1()
                    .pt_1()
                    .children(bubbles),
            )
            .child(div().id("copilot-spacer").flex_1())
            // 输入条占位（Stage9 接入真实输入与流式渲染）
            .child(
                div()
                    .mx_3()
                    .mb_2()
                    .px_2()
                    .h(px(26.0))
                    .flex()
                    .items_center()
                    .rounded(px(4.0))
                    .border_1()
                    .border_color(theme.separator)
                    .bg(theme.panel_bg)
                    .text_size(px(FONT_2XS))
                    .text_color(theme.text_muted)
                    .child("Stage9 会话工作台接入后启用…"),
            )
    }
}

/// 弱提示/空态/错误态统一居中文案体
fn hint_body(text: &str, theme: &AppTheme) -> Stateful<Div> {
    div()
        .id("inspector-hint")
        .flex()
        .items_center()
        .justify_center()
        .px_4()
        .py_6()
        .text_size(px(FONT_XS))
        .text_color(theme.text_muted)
        .child(text.to_string())
}

/// 分区标题（10pt 等宽弱化色 + 底部细分隔）
fn section_title(text: &str, theme: &AppTheme) -> Div {
    div()
        .flex()
        .items_center()
        .w_full()
        .px_3()
        .pt_2()
        .pb_1()
        .text_size(px(FONT_2XS))
        .font_family(FONT_MONO_FAMILY)
        .text_color(theme.text_muted)
        .child(SharedString::from(text.to_string()))
}

/// 滞留时长 pill（≥4h 转小时；警示语义色）
fn age_pill(age_min: i64, theme: &AppTheme) -> Div {
    let label = if age_min >= 240 {
        format!("{}h", age_min / 60)
    } else {
        format!("{age_min}m")
    };
    div()
        .px_1()
        .rounded(px(2.0))
        .bg(theme.warning.alpha(0.14))
        .text_size(px(FONT_2XS))
        .font_family(FONT_MONO_FAMILY)
        .text_color(theme.warning)
        .child(SharedString::from(label))
}

/// 告警风险点（断货 danger / 低覆盖 warning）
fn risk_dot(stockout: bool, theme: &AppTheme) -> Div {
    let dot = div().size(px(6.0)).rounded_full().flex_none();
    if stockout {
        dot.bg(theme.danger)
    } else {
        dot.bg(theme.warning)
    }
}

/// 金额格式化（USD 记号 + 两位小数；等宽列消费方负责字体）
fn format_money_usd(value: f64) -> String {
    format!("${value:.2}")
}

impl EventEmitter<InspectorEvent> for InspectorView {}

impl Render for InspectorView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let reduce = crate::motion::reduce_motion(cx);
        let registered = self.mode.is_some();
        let target = if self.visible && registered {
            self.width
        } else {
            0.0
        };
        let anim_from = self.anim_from;
        let anim_gen = self.anim_gen;
        let opening = self.visible;

        // 未注册形态：零宽隐藏入口（Canvas 占满、无分隔线、Cmd+B no-op）
        if !registered {
            return div()
                .id("inspector-hidden")
                .h_full()
                .w(px(0.0))
                .overflow_hidden()
                .into_any_element();
        }

        let mode = self.mode.unwrap_or(InspectorMode::Operations);
        let header = Self::header(mode, &theme, cx);
        let body = match mode {
            InspectorMode::Operations => Self::body_ops(&theme, self.ops_tick).into_any_element(),
            InspectorMode::Ads => self.body_ads(&theme).into_any_element(),
            InspectorMode::Copilot => Self::body_copilot(&theme).into_any_element(),
        };

        let container = div()
            .id("inspector")
            .relative()
            .flex()
            .flex_col()
            .h_full()
            .overflow_hidden()
            .bg(theme.card_bg)
            .when(target > 0.0, |el| {
                el.border_l_1().border_color(theme.separator)
            })
            .child(header)
            .child(
                div()
                    .id("inspector-body-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(body),
            )
            // 拖拽手柄最后 child = 最上层（覆盖滚动区左缘命中）
            .child(self.resize_handle(&theme, cx));

        // 开合宽度过渡：非减弱动态且处于过渡态时插值动画（Canvas 随 flex 平滑扩展）；
        // 动画完成后同 id 重渲染 delta 恒为 1 → 直接呈现最新目标宽（拖拽调宽亦走此路径）
        if !reduce && (target - anim_from).abs() > f32::EPSILON {
            container
                .with_animation(
                    SharedString::from(format!("inspector-anim-{anim_gen}-{opening}")),
                    crate::motion::animation(
                        crate::motion::DURATION_SIDEBAR,
                        crate::motion::ease_out_cubic,
                    ),
                    move |el, delta| el.w(px(crate::motion::lerp(anim_from, target, delta))),
                )
                .into_any_element()
        } else {
            container.w(px(target)).into_any_element()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    // ------------------------------------------------------------------
    // 纯函数契约
    // ------------------------------------------------------------------

    /// 形态注册表契约：三个验收基准页各归其态；未注册页面（着陆页/占位页/
    /// 其他业务页）一律 None = 零宽隐藏入口。
    #[test]
    fn mode_registry_contract() {
        assert_eq!(
            mode_for_view("daily-analysis"),
            Some(InspectorMode::Operations),
            "销售数据 → 运营态（验收基准）"
        );
        assert_eq!(
            mode_for_view("ad-analysis"),
            Some(InspectorMode::Ads),
            "广告分析 → 广告态（验收基准）"
        );
        assert_eq!(mode_for_view("ad-data"), Some(InspectorMode::Ads));
        assert_eq!(
            mode_for_view("ai-chat"),
            Some(InspectorMode::Copilot),
            "AI Chat → AI 态（验收基准）"
        );
        for unregistered in ["dashboard", "site-navigation", "order-info", "placeholder"] {
            assert_eq!(
                mode_for_view(unregistered),
                None,
                "{unregistered} 未注册形态必须隐藏入口"
            );
        }
    }

    /// 宽度夹紧契约：280~340 闭区间，越界收敛边界（拖拽与偏好恢复共用口径）
    #[test]
    fn clamp_width_bounds() {
        assert_eq!(clamp_width(260.0), 280.0, "下限收敛");
        assert_eq!(clamp_width(350.0), 340.0, "上限收敛");
        assert_eq!(clamp_width(300.0), 300.0);
        assert_eq!(clamp_width(280.0), 280.0);
        assert_eq!(clamp_width(340.0), 340.0);
    }

    /// 拖拽调宽几何契约：手柄贴抽屉左缘，目标宽 = 窗口宽 - 指针 x（向左拖变宽）
    #[test]
    fn width_for_pointer_math() {
        assert_eq!(width_for_pointer(1280.0, 960.0), 320.0);
        assert_eq!(width_for_pointer(1280.0, 1000.0), 280.0, "右推至下限");
        assert_eq!(width_for_pointer(1280.0, 900.0), 340.0, "左拉至上限");
        assert_eq!(width_for_pointer(1280.0, 0.0), 340.0, "极端左拉夹上限");
    }

    /// mock 轮转确定性契约：无随机数；tick 驱动池内轮转且长度恒定（订单 5 /
    /// 告警 4），同 tick 输入必得同输出（测试可复现）
    #[test]
    fn mock_rows_deterministic_rotation() {
        let t0 = mock_pending_rows(0);
        let t0_again = mock_pending_rows(0);
        let t1 = mock_pending_rows(1);
        assert_eq!(t0, t0_again, "同 tick 必须可复现");
        assert_ne!(t0[0], t1[0], "tick 前进应轮转首位");
        assert_eq!(t0.len(), 5);
        assert_eq!(mock_alert_rows(7).len(), 4);

        let a0 = mock_alert_rows(0);
        let a6 = mock_alert_rows(6);
        assert_eq!(a0[0], a6[0], "池长 6 → tick 6 回到起点（周期性）");

        // 滞留 pill 口径：≥4h 转小时由渲染层处理，这里锁池数据形态
        assert!(MOCK_PENDING_POOL
            .iter()
            .all(|(_, _, age, amount)| *age > 0 && *amount > 0.0));
    }

    // ------------------------------------------------------------------
    // 视图状态机（gpui 测试）
    // ------------------------------------------------------------------

    /// Cmd+B 开合契约：未注册形态 no-op（无事件）；注册后 toggle 发
    /// VisibleChanged 且宽度记忆跨开合保持。
    #[gpui::test]
    async fn toggle_visible_emits_and_preserves_width(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let events: Rc<RefCell<Vec<InspectorEvent>>> = Rc::new(RefCell::new(Vec::new()));
        let (view, cx) = cx.add_window_view(|_window, cx| {
            let events = events.clone();
            let inspector = cx.entity();
            cx.subscribe(&inspector, move |_, _, event: &InspectorEvent, _| {
                events.borrow_mut().push(*event);
            })
            .detach();
            InspectorView::new(Client::new(""), true, Some(320), cx)
        });

        // 初始：未注册形态（启动着陆页），visible=true 也应零宽隐藏 + Cmd+B no-op
        cx.read(|app| assert_eq!(view.read(app).mode(), None));
        view.update(cx, |v, cx| v.toggle_visible(cx));
        cx.read(|app| {
            assert!(
                view.read(app).visible(),
                "未注册形态 Cmd+B 必须 no-op（状态保持）"
            );
        });
        assert!(events.borrow().is_empty(), "no-op 不得发事件");

        // 注册运营态 → 开合往返，宽度记忆保持
        view.update(cx, |v, cx| {
            v.set_mode(Some(InspectorMode::Operations), None, "US", None, None, cx)
        });
        view.update(cx, |v, cx| v.toggle_visible(cx)); // 收起
        cx.read(|app| assert!(!view.read(app).visible()));
        view.update(cx, |v, cx| v.toggle_visible(cx)); // 再展开
        cx.read(|app| {
            let v = view.read(app);
            assert!(v.visible());
            assert_eq!(v.width(), 320.0, "宽度记忆必须跨开合保持");
        });
        assert_eq!(
            events.borrow().clone(),
            vec![
                InspectorEvent::VisibleChanged(false),
                InspectorEvent::VisibleChanged(true),
            ],
            "仅真实开合发持久化事件"
        );
    }

    /// Ads 态上下文守卫契约：缺项目 → need_project 不发起请求；站点「全部」→
    /// need_country；同上下文重复声明不重置状态。
    #[gpui::test]
    async fn ads_context_guards(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        use chrono::NaiveDate;
        let (view, cx) =
            cx.add_window_view(|_window, cx| InspectorView::new(Client::new(""), true, None, cx));

        // 进入广告态但控制条未选项目 → 引导提示而非空面板/网络错误
        view.update(cx, |v, cx| {
            v.set_mode(Some(InspectorMode::Ads), None, "US", None, None, cx)
        });
        cx.read(|app| assert_eq!(view.read(app).ads_state_label(), "need_project"));

        // 站点为「全部」（概览端点要求具体站点）→ 同样引导
        view.update(cx, |v, cx| {
            v.set_console_context(Some(7), "ALL", None, None, cx)
        });
        cx.read(|app| assert_eq!(view.read(app).ads_state_label(), "need_country"));

        // 具体项目+站点 → 发起加载（离线 client 异步失败，不阻塞断言）
        let from = NaiveDate::from_ymd_opt(2026, 8, 10).unwrap();
        let to = NaiveDate::from_ymd_opt(2026, 8, 16).unwrap();
        view.update(cx, |v, cx| {
            v.set_console_context(Some(7), "US", Some(from), Some(to), cx)
        });
        cx.run_until_parked();
        let label = cx.read(|app| view.read(app).ads_state_label());
        assert!(
            label == "failed" || label == "loading",
            "合法上下文必须走真实请求管线（离线 → failed），实际 {label}"
        );
    }
}
