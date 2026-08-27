//! 运营 → 平台巡检视图（P5-1，BLF-717）
//!
//! frontend `app/dashboard/operations/platform-inspection/page.tsx` 的 GPUI 等价：
//! 按周期查看各项目账户健康 / 配送绩效 / 政策合规巡检状态，支持
//! 「概览（项目卡片按风险排序）」与「历史记录（周期筛选 + 明细表）」两个 tab，
//! 并可在概览点击项目卡片进入「编辑报告」面板（账户健康 + 配送绩效 +
//! 政策合规 + 状态说明，保存草稿 / 提交）。
//!
//! 架构（复用 P3-x 既有模式）：
//! - **四态状态机**：`Loading / Loaded / Empty / Error`（沿用 dashboard.rs），
//!   `latest_request_id` 竞态保护；
//! - **数据管线**（对齐 frontend inspection-client 三件套）：
//!   - `inspection_current_period` → 当前周期（后端 get_or_create 当前周）；
//!   - `inspection_overview(period_id)` → 概览（项目快照 + 提交/逾期统计）；
//!   - `inspection_periods` → 历史 tab 周期选择器数据源；
//!   - 历史 tab 首次激活 / 切周期时 `inspection_history` 惰性加载；
//! - **明细表**：P5-0 公共 `DataTable`（BLF-759，列定义 + 状态徽章
//!   `render_element`）；
//! - **编辑面板**：独立实体 [`ReportEditForm`]（platform_inspection_edit.rs），
//!   保存/提交成功 → emit `ReportEditEvent::Changed` → 父视图 reload 概览。
//!
//! 已知差异（有意保留，按 macOS 习惯精简）：
//! - 截图上传 / 图片预览未接入（GPUI 无远程图片管线；概览/历史仅展示截图数量）；
//! - 历史记录无「查看详情」抽屉（概览卡片 + 编辑面板已覆盖详情信息）；
//! - 提交前不弹阈值警告（后端校验为准，编辑面板对已超阈值项做色块提示）。

use chrono::{DateTime, Local, NaiveDate, Utc};
use gpui::{
    div, prelude::*, px, App, AsyncApp, Context, CursorStyle, Entity, FontWeight, MouseButton,
    Render, SharedString, WeakEntity, Window,
};
use gpui_component::{h_flex, menu::PopupMenuItem, v_flex, Icon, IconName, Sizable, StyledExt};
use gui_api_client::Client;
use gui_domain::operations::platform_inspection::{InspectionOverviewItem, InspectionPeriod};

use crate::theme::AppTheme;
use crate::views::platform_inspection_edit::{ReportEditEvent, ReportEditForm};
use crate::widgets::data_table::{ColumnDef, DataTable};
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::{filter_bar, state_views};

/// 本页在侧栏中的 URL（root.rs 据此路由；与 gui-domain::sidebar 的平台巡检条目一致）
pub const PLATFORM_INSPECTION_URL: &str = "/dashboard/operations/platform-inspection";

/// 概览卡片网格列数（对齐 frontend `sm:grid-cols-2 lg:grid-cols-3`：窄窗 2 列，宽窗 3 列）
pub fn overview_columns(window_width: f32) -> usize {
    if window_width >= 1100.0 {
        3
    } else {
        2
    }
}

/// 概览 tab / 历史 tab（对齐 frontend `INSPECTION_TAB_ORDER = ['overview', 'history']`）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InspectionTab {
    Overview,
    History,
}

impl InspectionTab {
    pub fn label(self) -> &'static str {
        match self {
            Self::Overview => "概览",
            Self::History => "历史记录",
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Overview => "overview",
            Self::History => "history",
        }
    }
}

/// 巡检状态 → 中文标签（对齐 frontend STATUS_STYLES）
pub fn status_label(status: &str) -> &'static str {
    match status {
        "submitted" => "已提交",
        "draft" => "草稿",
        "overdue" => "已逾期",
        _ => "待填写",
    }
}

/// 指标严重度（配送绩效阈值判定；对齐 frontend `getMetricSeverity`）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetricSeverity {
    Normal,
    Warning,
    Critical,
}

/// 配送绩效指标阈值（对齐 frontend SHIPPING_THRESHOLDS）
/// - 迟发率：≥2 警告，≥4 严重（越高越差）
/// - 有效追踪率 / 准时交付率：≤97 警告，≤95 严重（越低越差，inverted）
pub fn shipping_metric_severity(key: &str, value: Option<f64>) -> MetricSeverity {
    let Some(value) = value else {
        return MetricSeverity::Normal;
    };
    match key {
        "late_shipment_rate" => {
            if value >= 4.0 {
                MetricSeverity::Critical
            } else if value >= 2.0 {
                MetricSeverity::Warning
            } else {
                MetricSeverity::Normal
            }
        }
        "valid_tracking_rate" | "on_time_delivery_rate" => {
            if value <= 95.0 {
                MetricSeverity::Critical
            } else if value <= 97.0 {
                MetricSeverity::Warning
            } else {
                MetricSeverity::Normal
            }
        }
        _ => MetricSeverity::Normal,
    }
}

/// 卡片风险等级（对齐 frontend `getCardSeverity`：Critical > Warning > Normal）
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CardSeverity {
    Critical,
    Warning,
    Normal,
}

pub fn card_severity(item: &InspectionOverviewItem) -> CardSeverity {
    // Critical：AHR Critical / 合规 ≥3 / 任一配送指标 critical
    if item.account_health_rating.as_deref() == Some("Critical") {
        return CardSeverity::Critical;
    }
    if item.compliance_total.unwrap_or(0) >= 3 {
        return CardSeverity::Critical;
    }
    if shipping_metric_severity("late_shipment_rate", item.late_shipment_rate)
        == MetricSeverity::Critical
        || shipping_metric_severity("valid_tracking_rate", item.valid_tracking_rate)
            == MetricSeverity::Critical
        || shipping_metric_severity("on_time_delivery_rate", item.on_time_delivery_rate)
            == MetricSeverity::Critical
    {
        return CardSeverity::Critical;
    }

    // Warning：AHR At Risk / 合规 ≥1 / 任一配送指标 warning / 客服计数 >0
    if item.account_health_rating.as_deref() == Some("At Risk") {
        return CardSeverity::Warning;
    }
    if item.compliance_total.unwrap_or(0) >= 1 {
        return CardSeverity::Warning;
    }
    if shipping_metric_severity("late_shipment_rate", item.late_shipment_rate)
        == MetricSeverity::Warning
        || shipping_metric_severity("valid_tracking_rate", item.valid_tracking_rate)
            == MetricSeverity::Warning
        || shipping_metric_severity("on_time_delivery_rate", item.on_time_delivery_rate)
            == MetricSeverity::Warning
    {
        return CardSeverity::Warning;
    }
    if item.negative_feedback.unwrap_or(0) > 0
        || item.a2z_claims.unwrap_or(0) > 0
        || item.chargeback_claims.unwrap_or(0) > 0
    {
        return CardSeverity::Warning;
    }

    CardSeverity::Normal
}

/// 按风险排序（Critical → Warning → Normal，各自保持后端顺序）
pub fn sort_by_severity(items: &[InspectionOverviewItem]) -> Vec<InspectionOverviewItem> {
    let mut sorted = items.to_vec();
    sorted.sort_by_key(card_severity);
    sorted
}

/// 是否已过截止时间（对齐 frontend `formatDeadline` 的 isOverdue）
pub fn is_deadline_overdue(deadline: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    now >= deadline
}

/// 日期展示（`2026-08-10`）
pub fn format_date(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

/// 时间展示（本地时区 `08-14 14:30`；None → `—`）
pub fn format_datetime(dt: Option<DateTime<Utc>>) -> String {
    match dt {
        Some(dt) => dt.with_timezone(&Local).format("%m-%d %H:%M").to_string(),
        None => "—".to_string(),
    }
}

/// 概览载荷（Loaded 持有）
#[derive(Debug, Clone, PartialEq)]
pub struct PlatformInspectionData {
    pub period: InspectionPeriod,
    pub items: Vec<InspectionOverviewItem>,
    pub total_projects: i64,
    pub submitted_count: i64,
    pub overdue_count: i64,
    /// 周期列表（历史 tab 选择器数据源；拉取失败时空列表，不阻塞概览）
    pub periods: Vec<InspectionPeriod>,
}

impl PlatformInspectionData {
    /// 空态判定：无可巡检项目（对齐 frontend `overview.items.length === 0`）
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

/// 平台巡检状态机（四态；对齐 dashboard.rs / ad_data.rs）
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum PlatformInspectionState {
    Loading,
    Loaded(PlatformInspectionData),
    Empty,
    Error(String),
}

impl PlatformInspectionState {
    /// 拉取结果 → 落点状态（唯一合法的「拉取完成」转移）
    pub fn from_fetch_result(result: Result<PlatformInspectionData, String>) -> Self {
        match result {
            Ok(data) if data.is_empty() => Self::Empty,
            Ok(data) => Self::Loaded(data),
            Err(msg) => Self::Error(msg),
        }
    }
}

/// 历史表格行（DataTable 行类型；由 InspectionHistoryItem 派生）
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryRow {
    pub id: i64,
    pub project_name: String,
    pub status: String,
    pub account_health_rating: Option<String>,
    pub compliance_total: Option<i64>,
    pub status_summary: Option<String>,
    pub submitted_by: Option<String>,
    pub submitted_at: Option<DateTime<Utc>>,
    pub screenshot_count: usize,
}

impl HistoryRow {
    pub fn from_item(
        item: &gui_domain::operations::platform_inspection::InspectionHistoryItem,
    ) -> Self {
        Self {
            id: item.id,
            project_name: item.project_name.clone(),
            status: item.status.clone(),
            account_health_rating: item.account_health_rating.clone(),
            compliance_total: item.compliance_total,
            status_summary: item.status_summary.clone(),
            submitted_by: item.submitted_by.clone(),
            submitted_at: item.submitted_at,
            screenshot_count: item.screenshots.len(),
        }
    }
}

/// 平台巡检视图（tab + 状态机 + 历史子加载 + 编辑面板宿主）
pub struct PlatformInspectionView {
    state: Entity<PlatformInspectionState>,
    /// 带会话的 API client
    client: Client,
    /// 请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,
    /// 当前 tab
    active_tab: InspectionTab,
    // ---- 历史 tab 子状态（惰性加载，不阻塞概览首屏）----
    /// 周期列表（reload 刷新；周期选择器数据源）
    periods: Vec<InspectionPeriod>,
    /// 历史 tab 当前选中周期（默认 = 当前周期）
    selected_period_id: Option<i64>,
    /// 历史明细表（懒建 DataTable）
    history_table: Option<Entity<DataTable<HistoryRow>>>,
    history_rows: Vec<HistoryRow>,
    history_loading: bool,
    history_error: Option<String>,
    history_request_id: u64,
    /// 已加载的周期 id（避免重复拉取同一周期）
    history_loaded_period: Option<i64>,
    // ---- 编辑面板 ----
    /// 概览点击项目卡片后打开的编辑表单（None = 概览模式）
    edit: Option<Entity<ReportEditForm>>,
    edit_sub: Option<gpui::Subscription>,
}

impl PlatformInspectionView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| PlatformInspectionState::Loading);
        Self {
            state,
            client,
            latest_request_id: 0,
            active_tab: InspectionTab::Overview,
            periods: Vec::new(),
            selected_period_id: None,
            history_table: None,
            history_rows: Vec::new(),
            history_loading: false,
            history_error: None,
            history_request_id: 0,
            history_loaded_period: None,
            edit: None,
            edit_sub: None,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> PlatformInspectionState {
        self.state.read(cx).clone()
    }

    /// 重新拉取数据：错误重试、空态刷新共用入口。
    ///
    /// 每次调用递增 `latest_request_id` 并进入 Loading；响应回来时
    /// `apply_result` 只应用最新一次（竞态保护，对齐 dashboard.rs）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;

        self.state.update(cx, |state, cx| {
            *state = PlatformInspectionState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(load_platform_inspection(&client))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 切换 tab：历史 tab 首次激活 / 切周期时惰性加载历史明细。
    pub fn select_tab(&mut self, tab: InspectionTab, cx: &mut Context<Self>) {
        if tab == self.active_tab {
            return;
        }
        self.active_tab = tab;
        if tab == InspectionTab::History {
            self.ensure_history_loaded(cx);
        }
        cx.notify();
    }

    /// 历史 tab 切换周期 → 重新拉取明细（同一周期 no-op）
    pub fn select_period(&mut self, period_id: i64, cx: &mut Context<Self>) {
        if self.selected_period_id == Some(period_id) {
            return;
        }
        self.selected_period_id = Some(period_id);
        self.ensure_history_loaded(cx);
        cx.notify();
    }

    /// 历史明细惰性加载入口：未加载当前选中周期时触发拉取。
    fn ensure_history_loaded(&mut self, cx: &mut Context<Self>) {
        let Some(period_id) = self.selected_period_id else {
            return;
        };
        if self.history_loaded_period == Some(period_id) {
            return;
        }
        self.history_request_id = self.history_request_id.wrapping_add(1);
        let request_id = self.history_request_id;
        self.history_loading = true;
        self.history_error = None;

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(load_inspection_history(&client, period_id))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                if request_id != this.history_request_id {
                    return; // 过期响应，丢弃
                }
                this.history_loading = false;
                match result {
                    Ok(rows) => {
                        this.history_rows = rows;
                        this.history_loaded_period = Some(period_id);
                    }
                    Err(msg) => this.history_error = Some(msg),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// 概览点击项目卡片 → 打开编辑面板（懒建 ReportEditForm + 订阅事件）。
    pub fn open_edit(&mut self, project_id: i64, project_name: String, cx: &mut Context<Self>) {
        let Some(period_id) = self.loaded_period_id(cx) else {
            return;
        };
        let client = self.client.clone();
        let form =
            cx.new(|cx| ReportEditForm::new(cx, client, period_id, project_id, project_name));
        self.edit_sub = Some(cx.subscribe(&form, |this, _, event: &ReportEditEvent, cx| {
            match event {
                ReportEditEvent::Changed => {
                    // 保存/提交成功 → 关闭编辑面板并刷新概览
                    this.edit = None;
                    this.reload(cx);
                }
                ReportEditEvent::Back => {
                    this.edit = None;
                    cx.notify();
                }
            }
        }));
        self.edit = Some(form);
        cx.notify();
    }

    /// 当前周期 id（Loaded 态持有；编辑面板创建用）
    fn loaded_period_id(&self, cx: &App) -> Option<i64> {
        match &self.state.read(cx) {
            PlatformInspectionState::Loaded(data) => Some(data.period.id),
            _ => None,
        }
    }

    /// 应用概览拉取结果：竞态保护 + Loaded 落点 + 初始化历史周期上下文。
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<PlatformInspectionData, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok(data) = &result {
            if !data.is_empty() {
                self.selected_period_id = Some(data.period.id);
                self.periods = data.periods.clone();
            }
        }
        self.state.update(cx, |state, cx| {
            *state = PlatformInspectionState::from_fetch_result(result);
            cx.notify();
        });
    }
}

/// 拉取概览（当前周期 → 概览 + 周期列表），与视图解耦便于测试。
///
/// 对齐 frontend inspection-client：先取当前周期（后端 get_or_create），
/// 再并行取该周期概览与周期列表；周期列表供历史 tab 选择器使用
/// （失败不阻塞概览，仅选择器无数据）。
async fn load_platform_inspection(client: &Client) -> Result<PlatformInspectionData, String> {
    let period = client
        .inspection_current_period()
        .await
        .map_err(|e| e.user_message())?;
    let (overview, periods) = tokio::join!(
        client.inspection_overview(period.id),
        client.inspection_periods(Some(100), Some(0)),
    );
    let overview = overview.map_err(|e| e.user_message())?;
    let periods = periods.map(|p| p.items).unwrap_or_default();
    Ok(PlatformInspectionData {
        period: overview.period,
        items: overview.items,
        total_projects: overview.total_projects,
        submitted_count: overview.submitted_count,
        overdue_count: overview.overdue_count,
        periods,
    })
}

/// 拉取历史明细（对齐 frontend `fetchInspectionHistory({ periodId, limit: 100 })`）。
async fn load_inspection_history(
    client: &Client,
    period_id: i64,
) -> Result<Vec<HistoryRow>, String> {
    let resp = client
        .inspection_history(Some(period_id), None, Some(100), None)
        .await
        .map_err(|e| e.user_message())?;
    Ok(resp.items.iter().map(HistoryRow::from_item).collect())
}

impl Render for PlatformInspectionView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let view = cx.entity();
        let reduce = crate::motion::reduce_motion(cx);

        // 历史表懒建 + 幂等注入（render 期；无变化不 notify）
        if self.history_table.is_none() {
            self.history_table = Some(cx.new(|_| {
                DataTable::new("pi-history-table", history_columns())
                    .striped(true)
                    .empty_text("暂无历史记录")
            }));
        }
        let rows = self.history_rows.clone();
        if let Some(table) = &self.history_table {
            table.update(cx, |table, cx| table.set_rows_if_changed(&rows, cx));
        }

        v_flex()
            .id("platform-inspection")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(theme.window_bg)
            // 页面头部（P4-5：共享 PageHeader 统一结构）
            .child(PageHeader::new("平台巡检").subtitle("定期记录账户健康状态、截图和状态说明"))
            // tab 栏：概览 / 历史记录（宽窗受内容上限约束）
            .child(content_guard().child(render_tab_bar(&view, self.active_tab, &theme)))
            // tab 内容
            .child(match self.active_tab {
                InspectionTab::Overview => {
                    render_overview_tab(self, window, cx, &view, &theme, &state).into_any_element()
                }
                InspectionTab::History => {
                    render_history_tab(self, cx, &view, &theme).into_any_element()
                }
            })
            .map(|el| {
                crate::motion::enter_fade_in(
                    SharedString::from(format!("pi-tab-{}", self.active_tab.id())),
                    el,
                    reduce,
                )
            })
    }
}

// ---------------------------------------------------------------------------
// tab 栏
// ---------------------------------------------------------------------------

fn render_tab_bar(
    view: &Entity<PlatformInspectionView>,
    active: InspectionTab,
    theme: &AppTheme,
) -> impl IntoElement {
    h_flex()
        .id("pi-tabs")
        .w_full()
        .p_1()
        .gap_1()
        .rounded(px(theme.radius_lg))
        .bg(theme.muted_fill)
        .child(tab_button(
            view,
            InspectionTab::Overview,
            active == InspectionTab::Overview,
            theme,
        ))
        .child(tab_button(
            view,
            InspectionTab::History,
            active == InspectionTab::History,
            theme,
        ))
}

fn tab_button(
    view: &Entity<PlatformInspectionView>,
    tab: InspectionTab,
    selected: bool,
    theme: &AppTheme,
) -> impl IntoElement {
    let view = view.clone();
    div()
        .id(SharedString::from(format!("pi-tab-{}", tab.id())))
        .flex_1()
        .py_1p5()
        .px_3()
        .text_center()
        .text_sm()
        .rounded(px(theme.radius))
        .cursor(CursorStyle::PointingHand)
        .when(selected, |this| {
            this.bg(theme.accent_soft)
                .text_color(theme.accent)
                .font_weight(FontWeight::MEDIUM)
        })
        .when(!selected, |this| {
            this.text_color(theme.text_secondary)
                .hover(|this| this.bg(theme.card_bg.opacity(0.5)))
        })
        .on_mouse_up(MouseButton::Left, move |_, _window, cx| {
            view.update(cx, |this, cx| this.select_tab(tab, cx));
        })
        .child(tab.label())
}

// ---------------------------------------------------------------------------
// 概览 tab
// ---------------------------------------------------------------------------

fn render_overview_tab(
    this: &PlatformInspectionView,
    window: &mut Window,
    _cx: &mut Context<PlatformInspectionView>,
    view: &Entity<PlatformInspectionView>,
    theme: &AppTheme,
    state: &PlatformInspectionState,
) -> impl IntoElement {
    match state {
        PlatformInspectionState::Loading => render_loading(theme).into_any_element(),
        PlatformInspectionState::Error(msg) => state_views::error_state(
            view,
            theme,
            "pi-overview-error",
            "平台巡检加载失败",
            msg.clone(),
            |this, cx| this.reload(cx),
        )
        .into_any_element(),
        PlatformInspectionState::Empty => state_views::empty_state_with_action(
            view,
            theme,
            "pi-overview-empty",
            "icons/shield.svg",
            "当前周期暂无巡检项目（无可访问项目）",
            "刷新",
            |this, cx| this.reload(cx),
        )
        .into_any_element(),
        PlatformInspectionState::Loaded(data) => {
            // 编辑面板模式：概览内容替换为表单（覆盖全内容区）
            if let Some(edit) = &this.edit {
                v_flex()
                    .id("pi-edit-panel")
                    .w_full()
                    .child(edit.clone())
                    .into_any_element()
            } else {
                render_overview_loaded(window, view, theme, data).into_any_element()
            }
        }
    }
}

/// Loading：spinner + 顶部卡片骨架 + 网格骨架
fn render_loading(theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("pi-overview-loading")
        .gap_4()
        .child(state_views::loading_state(theme, "加载中…"))
        .child(
            div()
                .w_full()
                .h(px(110.))
                .child(gpui_component::skeleton::Skeleton::new()),
        )
        .child(div().grid().grid_cols(2).gap_3().children((0..4).map(|_| {
            div()
                .h(px(240.))
                .child(gpui_component::skeleton::Skeleton::new())
        })))
}

/// Loaded：周期摘要卡 + 预警横幅 + 项目卡片网格（风险排序）
fn render_overview_loaded(
    window: &mut Window,
    view: &Entity<PlatformInspectionView>,
    theme: &AppTheme,
    data: &PlatformInspectionData,
) -> impl IntoElement {
    let now = Utc::now();
    let overdue = is_deadline_overdue(data.period.deadline, now);
    let progress_percent = if data.total_projects > 0 {
        (data.submitted_count as f64 / data.total_projects as f64) * 100.0
    } else {
        0.0
    };
    let warning_count = data
        .items
        .iter()
        .filter(|i| card_severity(i) == CardSeverity::Warning)
        .count();
    let critical_count = data
        .items
        .iter()
        .filter(|i| card_severity(i) == CardSeverity::Critical)
        .count();
    let has_alerts = data.overdue_count > 0 || critical_count > 0 || warning_count > 0;
    let columns = overview_columns(window.bounds().size.width.into());
    let sorted = sort_by_severity(&data.items);

    v_flex()
        .id("pi-overview-loaded")
        .gap_4()
        // 周期摘要卡
        .child(period_summary_card(
            theme,
            &data.period,
            overdue,
            data.submitted_count,
            data.total_projects,
            progress_percent,
        ))
        // 预警横幅
        .when(has_alerts, |this| {
            this.child(alert_banner(
                theme,
                data.overdue_count,
                critical_count,
                warning_count,
            ))
        })
        // 项目卡片网格（风险排序）
        .child(
            div()
                .id("pi-project-grid")
                .grid()
                .grid_cols(columns as u16)
                .gap_3()
                .children(sorted.iter().map(|item| {
                    let view = view.clone();
                    let project_id = item.project_id;
                    let project_name = item.project_name.clone();
                    project_card(item, theme, move |_, _, cx| {
                        view.update(cx, |this, cx| {
                            this.open_edit(project_id, project_name.clone(), cx)
                        });
                    })
                })),
        )
}

/// 周期摘要卡：周区间 + 截止时间（逾期红顶） + 进度条 + 提交统计
fn period_summary_card(
    theme: &AppTheme,
    period: &InspectionPeriod,
    overdue: bool,
    submitted_count: i64,
    total_projects: i64,
    progress_percent: f64,
) -> impl IntoElement {
    v_flex()
        .id("pi-period-summary")
        .gap_3()
        .p_4()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .when(overdue, |this| this.border_t_2().border_color(theme.danger))
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .gap_3()
                .child(
                    v_flex()
                        .gap_1()
                        .child(
                            div()
                                .text_lg()
                                .font_semibold()
                                .text_color(theme.text_primary)
                                .child(format!(
                                    "{} - {}",
                                    format_date(period.week_start),
                                    format_date(period.week_end)
                                )),
                        )
                        .child(
                            h_flex()
                                .gap_2()
                                .items_center()
                                .text_sm()
                                .text_color(theme.text_muted)
                                .child(format!(
                                    "截止时间: {}",
                                    format_datetime(Some(period.deadline))
                                ))
                                .when(overdue, |this| {
                                    this.child(div().text_color(theme.danger).child("(已逾期)"))
                                }),
                        ),
                )
                .child(status_pill(
                    theme,
                    &format!("{submitted_count} / {total_projects} 已提交"),
                    theme.text_secondary,
                )),
        )
        .child(
            div()
                .h_1p5()
                .w_full()
                .rounded_full()
                .bg(theme.muted_fill)
                .child(
                    div()
                        .h_full()
                        .rounded_full()
                        .bg(theme.success)
                        .w(px((progress_percent * 2.0).clamp(0.0, 200.0) as f32)),
                ),
        )
}

/// 预警横幅（对齐 frontend：逾期 / 严重异常 / 存在风险 计数，段间 `·` 分隔）
fn alert_banner(
    theme: &AppTheme,
    overdue_count: i64,
    critical_count: usize,
    warning_count: usize,
) -> impl IntoElement {
    let mut segments: Vec<gpui::AnyElement> = Vec::new();
    let mut push_segment = |text: String, color: gpui::Hsla| {
        if !segments.is_empty() {
            segments.push(
                div()
                    .text_color(theme.text_muted)
                    .child("·")
                    .into_any_element(),
            );
        }
        segments.push(
            div()
                .font_weight(FontWeight::MEDIUM)
                .text_color(color)
                .child(text)
                .into_any_element(),
        );
    };
    if overdue_count > 0 {
        push_segment(format!("{overdue_count} 个项目已逾期"), theme.warning);
    }
    if critical_count > 0 {
        push_segment(format!("{critical_count} 个项目严重异常"), theme.danger);
    }
    if warning_count > 0 {
        push_segment(format!("{warning_count} 个项目存在风险"), theme.warning);
    }

    h_flex()
        .id("pi-alert-banner")
        .items_center()
        .gap_3()
        .px_4()
        .py_2p5()
        .rounded(px(theme.radius_lg))
        .border_1()
        .border_color(theme.warning.opacity(0.35))
        .bg(theme.warning.opacity(0.08))
        .child(
            Icon::new(IconName::TriangleAlert)
                .with_size(px(16.))
                .text_color(theme.warning),
        )
        .child(h_flex().gap_2().flex_wrap().text_sm().children(segments))
}

/// 项目卡片：名称 + 状态徽章 + 账号健康 / 配送绩效 / 合规 + 提交信息
fn project_card(
    item: &InspectionOverviewItem,
    theme: &AppTheme,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let severity = card_severity(item);
    let service_total = item.negative_feedback.unwrap_or(0)
        + item.a2z_claims.unwrap_or(0)
        + item.chargeback_claims.unwrap_or(0);
    let screenshot_count = item.screenshots.len();
    let status = item.status.clone();
    let summary = item.status_summary.clone();
    let submitted_by = item.submitted_by.clone();
    let submitted_at = item.submitted_at;

    v_flex()
        .id(SharedString::from(format!("pi-card-{}", item.project_id)))
        .gap_3()
        .p_4()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .cursor(CursorStyle::PointingHand)
        .hover(|this| this.border_color(theme.accent.opacity(0.5)))
        .when(severity == CardSeverity::Critical, |this| {
            this.border_2().border_color(theme.danger.opacity(0.7))
        })
        .when(severity == CardSeverity::Warning, |this| {
            this.border_2().border_color(theme.warning.opacity(0.6))
        })
        .on_click(on_click)
        // 头部：项目名 + 状态徽章
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .gap_2()
                .child(
                    div()
                        .text_sm()
                        .font_semibold()
                        .text_color(theme.text_primary)
                        .truncate()
                        .child(item.project_name.clone()),
                )
                .child(status_badge(theme, &status)),
        )
        // 账号健康：AHR 徽章 + 客服计数
        .child(
            v_flex()
                .gap_1p5()
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child("账号健康"),
                )
                .child(
                    h_flex()
                        .gap_2()
                        .items_center()
                        .child(ahr_badge(theme, item.account_health_rating.as_deref()))
                        .child(service_pill(theme, service_total)),
                ),
        )
        // 配送 & 合规：2×2 指标徽章
        .child(
            v_flex()
                .gap_1p5()
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child("配送 & 合规"),
                )
                .child(
                    div()
                        .grid()
                        .grid_cols(2)
                        .gap_1p5()
                        .child(metric_badge(
                            theme,
                            "迟发率",
                            item.late_shipment_rate,
                            true,
                            shipping_metric_severity("late_shipment_rate", item.late_shipment_rate),
                        ))
                        .child(metric_badge(
                            theme,
                            "有效追踪",
                            item.valid_tracking_rate,
                            true,
                            shipping_metric_severity(
                                "valid_tracking_rate",
                                item.valid_tracking_rate,
                            ),
                        ))
                        .child(metric_badge(
                            theme,
                            "准时交付",
                            item.on_time_delivery_rate,
                            true,
                            shipping_metric_severity(
                                "on_time_delivery_rate",
                                item.on_time_delivery_rate,
                            ),
                        ))
                        .child(compliance_badge(theme, item.compliance_total)),
                ),
        )
        // 底部：提交信息 + 截图数
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .gap_2()
                .border_t_1()
                .border_color(theme.separator)
                .pt_3()
                .text_xs()
                .text_color(theme.text_muted)
                .child(match (submitted_by, submitted_at) {
                    (Some(by), Some(at)) => {
                        div().child(format!("{by} · {}", format_datetime(Some(at))))
                    }
                    (Some(by), None) => div().child(by),
                    _ => div().child("未提交"),
                })
                .child(
                    h_flex()
                        .gap_2()
                        .items_center()
                        .child(if screenshot_count > 0 {
                            h_flex()
                                .gap_1()
                                .items_center()
                                .child(
                                    Icon::new(IconName::GalleryVerticalEnd)
                                        .with_size(px(12.))
                                        .text_color(theme.text_muted),
                                )
                                .child(format!("{screenshot_count}张截图"))
                                .into_any_element()
                        } else {
                            div().into_any_element()
                        })
                        .when(summary.is_some(), |this| {
                            this.child(summary_indicator(theme, summary.as_deref()))
                        }),
                ),
        )
}

/// 状态徽章（彩色圆角胶囊）
fn status_badge(theme: &AppTheme, status: &str) -> impl IntoElement {
    let (bg, fg) = match status {
        "submitted" => (theme.success_soft, theme.success),
        "draft" => (theme.warning.opacity(0.15), theme.warning),
        "overdue" => (theme.danger_soft, theme.danger),
        _ => (theme.muted_fill, theme.text_muted),
    };
    div()
        .px_2()
        .py_0p5()
        .rounded_full()
        .bg(bg)
        .text_xs()
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg)
        .child(status_label(status))
}

/// AHR 徽章（Healthy/Good 绿色，At Risk 橙，Critical 红；未填 → 虚线占位）
fn ahr_badge(theme: &AppTheme, rating: Option<&str>) -> impl IntoElement {
    match rating {
        Some(rating) => {
            let (bg, fg) = match rating {
                "Critical" => (theme.danger_soft, theme.danger),
                "At Risk" => (theme.warning.opacity(0.15), theme.warning),
                _ => (theme.success_soft, theme.success),
            };
            h_flex()
                .items_center()
                .gap_1p5()
                .px_2()
                .py_0p5()
                .rounded_full()
                .border_1()
                .border_color(bg)
                .bg(bg)
                .child(div().text_xs().text_color(theme.text_muted).child("AHR"))
                .child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(fg)
                        .child(rating.to_string()),
                )
        }
        None => h_flex()
            .items_center()
            .gap_1p5()
            .px_2()
            .py_0p5()
            .rounded_full()
            .border_1()
            .border_color(theme.separator)
            .child(div().text_xs().text_color(theme.text_muted).child("AHR —")),
    }
}

/// 客服计数胶囊（>0 → 橙色警告；0 → 绿色）
fn service_pill(theme: &AppTheme, total: i64) -> impl IntoElement {
    let (bg, fg) = if total > 0 {
        (theme.warning.opacity(0.15), theme.warning)
    } else {
        (theme.success_soft, theme.success)
    };
    h_flex()
        .items_center()
        .gap_1p5()
        .px_2()
        .py_0p5()
        .rounded_full()
        .border_1()
        .border_color(bg)
        .bg(bg)
        .child(div().text_xs().text_color(theme.text_muted).child("客服"))
        .child(
            div()
                .text_xs()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(fg)
                .child(total.to_string()),
        )
}

/// 指标徽章（label + 值；超阈值 → 警告/严重着色，未填 → `--`）
fn metric_badge(
    theme: &AppTheme,
    label: &str,
    value: Option<f64>,
    unit_percent: bool,
    severity: MetricSeverity,
) -> impl IntoElement {
    let (bg, fg) = match severity {
        MetricSeverity::Critical => (theme.danger.opacity(0.08), theme.danger),
        MetricSeverity::Warning => (theme.warning.opacity(0.08), theme.warning),
        MetricSeverity::Normal => (theme.muted_fill, theme.text_secondary),
    };
    h_flex()
        .items_center()
        .justify_between()
        .gap_2()
        .px_2p5()
        .py_1p5()
        .rounded(px(theme.radius))
        .bg(bg)
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .child(label.to_string()),
        )
        .child(
            h_flex()
                .gap_1()
                .items_center()
                .child(match severity {
                    MetricSeverity::Critical | MetricSeverity::Warning => {
                        Icon::new(IconName::TriangleAlert)
                            .with_size(px(10.))
                            .text_color(fg)
                            .into_any_element()
                    }
                    MetricSeverity::Normal => div().into_any_element(),
                })
                .child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(fg)
                        .child(match value {
                            Some(v) => {
                                if unit_percent {
                                    format!("{v}%")
                                } else {
                                    format!("{v}")
                                }
                            }
                            None => "--".to_string(),
                        }),
                ),
        )
}

/// 合规问题徽章（≥3 红 / ≥1 橙 / 0 绿 / 未填 `--`）
fn compliance_badge(theme: &AppTheme, total: Option<i64>) -> impl IntoElement {
    let (bg, fg) = match total {
        Some(t) if t >= 3 => (theme.danger.opacity(0.08), theme.danger),
        Some(t) if t >= 1 => (theme.warning.opacity(0.08), theme.warning),
        Some(_) => (theme.success_soft, theme.success),
        None => (theme.muted_fill, theme.text_muted),
    };
    h_flex()
        .items_center()
        .justify_between()
        .gap_2()
        .px_2p5()
        .py_1p5()
        .rounded(px(theme.radius))
        .bg(bg)
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .child("合规问题"),
        )
        .child(
            h_flex()
                .gap_1()
                .items_center()
                .child(match total {
                    Some(t) if t > 0 => Icon::new(IconName::TriangleAlert)
                        .with_size(px(10.))
                        .text_color(fg)
                        .into_any_element(),
                    _ => div().into_any_element(),
                })
                .child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(fg)
                        .child(match total {
                            Some(t) => t.to_string(),
                            None => "--".to_string(),
                        }),
                ),
        )
}

/// 状态说明 indicator（有说明时显示文档图标 + 截断摘要；无 tooltip——GPUI 0.2
/// 普通 div 不支持 InteractiveElementExt 的 tooltip（仅 Stateful 元素可用））
fn summary_indicator(theme: &AppTheme, summary: Option<&str>) -> impl IntoElement {
    let summary = summary.unwrap_or_default();
    let truncated: String = if summary.chars().count() > 16 {
        let s: String = summary.chars().take(16).collect();
        format!("{s}…")
    } else {
        summary.to_string()
    };
    h_flex()
        .items_center()
        .gap_1()
        .p_1()
        .rounded(px(theme.radius))
        .text_color(theme.text_muted)
        .hover(|this| this.bg(theme.muted_fill).text_color(theme.text_primary))
        .child(Icon::new(IconName::File).with_size(px(12.)))
        .child(div().max_w(px(140.)).truncate().child(truncated))
}

/// 状态胶囊（周期摘要卡右侧）
fn status_pill(theme: &AppTheme, text: &str, fg: gpui::Hsla) -> impl IntoElement {
    div()
        .px_2p5()
        .py_1()
        .rounded_full()
        .bg(theme.muted_fill)
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg)
        .child(text.to_string())
}

// ---------------------------------------------------------------------------
// 历史 tab
// ---------------------------------------------------------------------------

fn render_history_tab(
    this: &PlatformInspectionView,
    _cx: &mut Context<PlatformInspectionView>,
    view: &Entity<PlatformInspectionView>,
    theme: &AppTheme,
) -> impl IntoElement {
    let table = this.history_table.clone();
    v_flex()
        .id("pi-history")
        .gap_4()
        // 周期选择器
        .child(render_period_selector(this, view, theme))
        // 明细表 / 加载 / 错误
        .child(if this.history_loading {
            v_flex()
                .id("pi-history-loading")
                .gap_4()
                .child(state_views::loading_state(theme, "加载历史记录…"))
                .child(
                    div()
                        .w_full()
                        .h(px(280.))
                        .child(gpui_component::skeleton::Skeleton::new()),
                )
                .into_any_element()
        } else if let Some(msg) = &this.history_error {
            state_views::error_state(
                view,
                theme,
                "pi-history-error",
                "历史记录加载失败",
                msg.clone(),
                |this, cx| {
                    this.history_loaded_period = None;
                    this.ensure_history_loaded(cx);
                    cx.notify();
                },
            )
            .into_any_element()
        } else {
            match table {
                Some(table) => v_flex()
                    .id("pi-history-table-card")
                    .w_full()
                    .rounded(px(theme.radius_lg))
                    .bg(theme.card_bg)
                    .shadow(vec![theme.card_shadow_box()])
                    .overflow_hidden()
                    .child(table.clone())
                    .into_any_element(),
                None => v_flex()
                    .child(state_views::loading_state(theme, "加载历史记录…"))
                    .into_any_element(),
            }
        })
}

/// 周期选择器（filter_select 下拉；数据源 = reload 时拉取的周期列表）
fn render_period_selector(
    this: &PlatformInspectionView,
    view: &Entity<PlatformInspectionView>,
    theme: &AppTheme,
) -> impl IntoElement {
    let periods = this.periods.clone();
    // 闭包须 'static：把选中周期 id（Copy）与 label 派生提前，不借用 view 引用
    let selected = this.selected_period_id;
    let current_label: SharedString = selected
        .and_then(|id| {
            periods.iter().find(|p| p.id == id).map(|p| {
                format!(
                    "{} - {}",
                    format_date(p.week_start),
                    format_date(p.week_end)
                )
            })
        })
        .map(SharedString::from)
        .unwrap_or_else(|| SharedString::from("选择周期"));
    let view = view.clone();

    filter_bar::filter_bar_layout(theme).child(filter_bar::filter_select(
        theme,
        "周期",
        current_label,
        "pi-period-filter",
        move |mut menu, _window, _cx| {
            for period in &periods {
                let checked = selected == Some(period.id);
                let label = format!(
                    "{} - {}",
                    format_date(period.week_start),
                    format_date(period.week_end)
                );
                let period_id = period.id; // Copy；闭包不借用 period 引用
                let view = view.clone();
                menu = menu.item(PopupMenuItem::new(label).checked(checked).on_click(
                    move |_, _window, cx| {
                        view.update(cx, |this, cx| this.select_period(period_id, cx));
                    },
                ));
            }
            menu
        },
    ))
}

/// 历史表格列定义（P5-0 DataTable）
fn history_columns() -> Vec<ColumnDef<HistoryRow>> {
    vec![
        ColumnDef::text("project", "项目", |r: &HistoryRow, _| {
            r.project_name.clone().into()
        })
        .width(180.0),
        ColumnDef::text("status", "状态", |r: &HistoryRow, _| {
            SharedString::from(status_label(&r.status))
        })
        .with_render_element(history_status_badge)
        .width(88.0),
        ColumnDef::text("ahr", "AHR", |r: &HistoryRow, _| {
            SharedString::from(
                r.account_health_rating
                    .as_deref()
                    .unwrap_or("—")
                    .to_string(),
            )
        })
        .width(90.0),
        ColumnDef::number(
            "compliance",
            "合规问题",
            |r: &HistoryRow| r.compliance_total.unwrap_or(0) as f64,
            |r: &HistoryRow, _| {
                SharedString::from(
                    r.compliance_total
                        .map(|t| t.to_string())
                        .unwrap_or_else(|| "—".to_string()),
                )
            },
        )
        .width(96.0),
        ColumnDef::text("summary", "状态说明", |r: &HistoryRow, _| {
            let text = r.status_summary.as_deref().unwrap_or("—");
            if text.chars().count() > 24 {
                let truncated: String = text.chars().take(24).collect();
                SharedString::from(format!("{truncated}…"))
            } else {
                SharedString::from(text.to_string())
            }
        }),
        ColumnDef::text("by", "提交人", |r: &HistoryRow, _| {
            SharedString::from(r.submitted_by.as_deref().unwrap_or("—").to_string())
        })
        .width(100.0),
        ColumnDef::text("at", "提交时间", |r: &HistoryRow, _| {
            SharedString::from(format_datetime(r.submitted_at))
        })
        .width(110.0),
        ColumnDef::number(
            "shots",
            "截图",
            |r: &HistoryRow| r.screenshot_count as f64,
            |r: &HistoryRow, _| SharedString::from(r.screenshot_count.to_string()),
        )
        .width(64.0),
    ]
}

/// 历史行状态徽章（render_element：彩色胶囊）
fn history_status_badge(r: &HistoryRow, theme: &AppTheme) -> gpui::AnyElement {
    let (bg, fg) = match r.status.as_str() {
        "submitted" => (theme.success_soft, theme.success),
        "draft" => (theme.warning.opacity(0.15), theme.warning),
        "overdue" => (theme.danger_soft, theme.danger),
        _ => (theme.muted_fill, theme.text_muted),
    };
    div()
        .px_2()
        .py_0p5()
        .rounded_full()
        .bg(bg)
        .text_xs()
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg)
        .child(status_label(&r.status))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{NaiveDate, TimeZone};
    use gui_domain::operations::platform_inspection::InspectionOverviewItem;

    /// 测试构造器（8 参数；测试专用）
    #[allow(clippy::too_many_arguments)]
    fn item(
        project_id: i64,
        status: &str,
        ahr: Option<&str>,
        compliance: Option<i64>,
        late: Option<f64>,
        valid: Option<f64>,
        on_time: Option<f64>,
        service: (i64, i64, i64),
    ) -> InspectionOverviewItem {
        InspectionOverviewItem {
            project_id,
            project_name: format!("项目 {project_id}"),
            status: status.to_string(),
            account_health_rating: ahr.map(|s| s.to_string()),
            negative_feedback: Some(service.0),
            a2z_claims: Some(service.1),
            chargeback_claims: Some(service.2),
            late_shipment_rate: late,
            valid_tracking_rate: valid,
            on_time_delivery_rate: on_time,
            compliance_total: compliance,
            ..Default::default()
        }
    }

    #[test]
    fn status_labels_map_known_and_unknown() {
        assert_eq!(status_label("submitted"), "已提交");
        assert_eq!(status_label("draft"), "草稿");
        assert_eq!(status_label("overdue"), "已逾期");
        assert_eq!(status_label("pending"), "待填写");
        assert_eq!(status_label("unknown"), "待填写");
    }

    #[test]
    fn shipping_metric_severity_thresholds() {
        // 迟发率：越高越差
        assert_eq!(
            shipping_metric_severity("late_shipment_rate", Some(1.9)),
            MetricSeverity::Normal
        );
        assert_eq!(
            shipping_metric_severity("late_shipment_rate", Some(2.0)),
            MetricSeverity::Warning
        );
        assert_eq!(
            shipping_metric_severity("late_shipment_rate", Some(4.0)),
            MetricSeverity::Critical
        );
        // 有效追踪 / 准时交付：越低越差（inverted）
        assert_eq!(
            shipping_metric_severity("valid_tracking_rate", Some(98.0)),
            MetricSeverity::Normal
        );
        assert_eq!(
            shipping_metric_severity("valid_tracking_rate", Some(97.0)),
            MetricSeverity::Warning
        );
        assert_eq!(
            shipping_metric_severity("on_time_delivery_rate", Some(95.0)),
            MetricSeverity::Critical
        );
        // 未填 → Normal
        assert_eq!(
            shipping_metric_severity("late_shipment_rate", None),
            MetricSeverity::Normal
        );
    }

    #[test]
    fn card_severity_priority() {
        // Critical 优先
        assert_eq!(
            card_severity(&item(
                1,
                "submitted",
                Some("Critical"),
                Some(0),
                None,
                None,
                None,
                (0, 0, 0)
            )),
            CardSeverity::Critical
        );
        assert_eq!(
            card_severity(&item(
                2,
                "submitted",
                Some("Good"),
                Some(3),
                None,
                None,
                None,
                (0, 0, 0)
            )),
            CardSeverity::Critical
        );
        assert_eq!(
            card_severity(&item(
                3,
                "submitted",
                Some("Good"),
                Some(0),
                Some(5.0),
                None,
                None,
                (0, 0, 0)
            )),
            CardSeverity::Critical
        );
        // Warning
        assert_eq!(
            card_severity(&item(
                4,
                "draft",
                Some("At Risk"),
                Some(0),
                None,
                None,
                None,
                (0, 0, 0)
            )),
            CardSeverity::Warning
        );
        assert_eq!(
            card_severity(&item(
                5,
                "draft",
                Some("Good"),
                Some(1),
                None,
                None,
                None,
                (0, 0, 0)
            )),
            CardSeverity::Warning
        );
        assert_eq!(
            card_severity(&item(
                6,
                "draft",
                Some("Good"),
                Some(0),
                None,
                None,
                None,
                (1, 0, 0)
            )),
            CardSeverity::Warning
        );
        // Normal
        assert_eq!(
            card_severity(&item(
                7,
                "submitted",
                Some("Good"),
                Some(0),
                Some(1.0),
                Some(98.0),
                Some(98.0),
                (0, 0, 0)
            )),
            CardSeverity::Normal
        );
    }

    #[test]
    fn sort_by_severity_orders_critical_warning_normal() {
        let items = vec![
            item(
                1,
                "submitted",
                Some("Good"),
                Some(0),
                None,
                None,
                None,
                (0, 0, 0),
            ),
            item(
                2,
                "submitted",
                Some("Critical"),
                Some(0),
                None,
                None,
                None,
                (0, 0, 0),
            ),
            item(
                3,
                "draft",
                Some("At Risk"),
                Some(0),
                None,
                None,
                None,
                (0, 0, 0),
            ),
        ];
        let sorted = sort_by_severity(&items);
        assert_eq!(sorted[0].project_id, 2, "Critical 应排最前");
        assert_eq!(sorted[1].project_id, 3, "Warning 次之");
        assert_eq!(sorted[2].project_id, 1, "Normal 最后");
    }

    #[test]
    fn deadline_overdue_compares_against_now() {
        let deadline = Utc.with_ymd_and_hms(2026, 8, 16, 2, 0, 0).single().unwrap();
        let before = Utc
            .with_ymd_and_hms(2026, 8, 16, 1, 59, 0)
            .single()
            .unwrap();
        let after = Utc.with_ymd_and_hms(2026, 8, 16, 2, 0, 1).single().unwrap();
        assert!(!is_deadline_overdue(deadline, before));
        assert!(is_deadline_overdue(deadline, after));
        assert!(
            is_deadline_overdue(deadline, deadline),
            "等于截止时间视为逾期"
        );
    }

    #[test]
    fn format_datetime_renders_dash_for_none() {
        assert_eq!(format_datetime(None), "—");
    }

    #[test]
    fn overview_columns_follows_window_width() {
        assert_eq!(overview_columns(800.0), 2);
        assert_eq!(overview_columns(1100.0), 3);
        assert_eq!(overview_columns(2000.0), 3);
    }

    #[test]
    fn history_row_from_item_maps_fields() {
        use gui_domain::operations::platform_inspection::InspectionHistoryItem;
        let item = InspectionHistoryItem {
            id: 1,
            period_id: 2,
            week_start: NaiveDate::from_ymd_opt(2026, 8, 10).unwrap(),
            week_end: NaiveDate::from_ymd_opt(2026, 8, 16).unwrap(),
            project_id: 3,
            project_name: "项目 A".into(),
            status: "submitted".into(),
            account_health_rating: Some("Good".into()),
            compliance_total: Some(2),
            status_summary: Some("正常".into()),
            submitted_by: Some("测试".into()),
            submitted_at: None,
            screenshots: vec![
                gui_domain::operations::platform_inspection::InspectionScreenshotRef {
                    id: 9,
                    ..Default::default()
                },
            ],
        };
        let row = HistoryRow::from_item(&item);
        assert_eq!(row.project_name, "项目 A");
        assert_eq!(row.status, "submitted");
        assert_eq!(row.screenshot_count, 1);
        assert_eq!(row.compliance_total, Some(2));
    }

    // ---------- 渲染冒烟（亮 / 暗 + 各状态） ----------

    /// 测试宿主：同屏渲染概览 Loading / 历史 loading 与 tab 栏（无网络依赖）
    struct PiHost {
        view: Entity<PlatformInspectionView>,
    }

    impl Render for PiHost {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            let view = self.view.clone();
            v_flex().child(view)
        }
    }

    #[gpui::test]
    async fn platform_inspection_renders_light_and_dark(cx: &mut gpui::TestAppContext) {
        for dark in [false, true] {
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
            // client 指向 127.0.0.1:1（必拒绝连接）→ 首屏拉取快速进入 Error 态
            let (_host, cx2) = cx.add_window_view(|_window, cx| {
                let view =
                    cx.new(|cx| PlatformInspectionView::new(cx, Client::new("http://127.0.0.1:1")));
                PiHost { view }
            });
            cx2.read(|app| {
                assert_eq!(crate::theme::AppTheme::current(app).is_dark(), dark);
            });
        }
    }

    #[gpui::test]
    async fn platform_inspection_history_tab_switch(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let (host, cx2) = cx.add_window_view(|_window, cx| {
            let view =
                cx.new(|cx| PlatformInspectionView::new(cx, Client::new("http://127.0.0.1:1")));
            PiHost { view }
        });
        let view = cx2.read(|app| host.read(app).view.clone());
        // 初始 Overview tab；切换到历史 tab → active_tab 跟随
        cx2.read(|app| assert_eq!(view.read(app).active_tab, InspectionTab::Overview));
        view.update(cx2, |this, cx| this.select_tab(InspectionTab::History, cx));
        cx2.read(|app| assert_eq!(view.read(app).active_tab, InspectionTab::History));
        // 再切回概览
        view.update(cx2, |this, cx| this.select_tab(InspectionTab::Overview, cx));
        cx2.read(|app| assert_eq!(view.read(app).active_tab, InspectionTab::Overview));
    }
}
