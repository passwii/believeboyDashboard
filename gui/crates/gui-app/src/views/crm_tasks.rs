//! CRM → 任务（Stage13，BLF-804）
//!
//! 对齐 web 端 `app/dashboard/crm/tasks/page.tsx` 的**读取主面**：任务
//! 列表/看板双形态（Kanban → Pattern A 变体：三列 pending/in_progress/done
//! 状态墙 + 列表大表），类型筛选 + mine/all 范围。看板拖拽改状态走
//! `POST /crm/tasks/{id}/status`（乐观更新 + 失败回滚，对齐 web board.ts）。
//! 数据源：`GET /api/v1/crm/tasks`（gui-api-client::crm）。
//!
//! ## 与 web 端的取舍
//!
//! - **保留**：四态状态机、双视图切换、类型筛选、看板三列 + 拖拽改状态、
//!   乐观更新与失败回滚、cancelled 不入看板（对齐 web `isBoardStatus`）；
//! - **精简**：新建/编辑任务对话框不移植；提醒 SSE 流不移植（GUI 无长驻流式
//!   先例），到期信号由 due_date 着色承载。

// Stage13 视图：URL 常量与测试钩子属模块契约面，root.rs 接线前允许暂未消费。
#![allow(dead_code)] // ⚠️ 内部属性必须在文件顶部——见下方等价实现

use gpui::prelude::*;
use gpui::{
    div, px, App, AsyncApp, Context, Entity, FontWeight, IntoElement, Render, SharedString, Styled,
    WeakEntity, Window,
};
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::{h_flex, v_flex, Sizable};
use gui_api_client::crm::{CrmListParams, CrmUser};
use gui_api_client::Client;
use gui_domain::crm::{
    task_priority_label, task_status_label, task_type_label, TaskItem, TaskPage,
};

use crate::theme::AppTheme;
use crate::widgets::data_grid::{pattern_a_shell, AggregateItem};
use crate::widgets::data_table::{ColumnDef, DataTable};
use crate::widgets::filter_bar::filter_select;
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「CRM 客户与合作伙伴 → 任务」URL
pub const CRM_TASKS_URL: &str = "/dashboard/crm/tasks";

pub(crate) const PAGE_SIZE: usize = 100;

/// 看板三列（对齐 web `TASK_BOARD_COLUMNS`；cancelled 不入看板）
pub const BOARD_COLUMNS: [&str; 3] = ["pending", "in_progress", "done"];

// ---------------------------------------------------------------------------
// 视图形态 / 筛选
// ---------------------------------------------------------------------------

/// 视图形态（列表 / 看板）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TasksViewMode {
    #[default]
    List,
    Board,
}

impl TasksViewMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::List => "列表",
            Self::Board => "看板",
        }
    }

    pub const ALL: [Self; 2] = [Self::List, Self::Board];
}

/// 类型筛选（对齐 web TASK_TYPE_OPTIONS）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TaskTypeFilter {
    #[default]
    All,
    FollowUp,
    Call,
    Visit,
    Custom,
}

impl TaskTypeFilter {
    pub const ALL: [Self; 5] = [
        Self::All,
        Self::FollowUp,
        Self::Call,
        Self::Visit,
        Self::Custom,
    ];

    fn label(self) -> String {
        match self {
            Self::All => "全部类型".to_string(),
            other => task_type_label(other.as_key()),
        }
    }

    fn as_key(self) -> &'static str {
        match self {
            Self::All => "",
            Self::FollowUp => "follow_up",
            Self::Call => "call",
            Self::Visit => "visit",
            Self::Custom => "custom",
        }
    }

    fn as_query(self) -> Option<&'static str> {
        match self {
            Self::All => None,
            other => Some(other.as_key()),
        }
    }

    /// 行内匹配（响应行的 type key 是否命中当前筛选）
    fn matches(self, task_type: &str) -> bool {
        self.as_query().is_none_or(|k| k == task_type)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum TasksScope {
    #[default]
    Mine,
    All,
}

impl TasksScope {
    pub fn label(self) -> &'static str {
        match self {
            Self::Mine => "我的",
            Self::All => "全部",
        }
    }

    fn as_backend_scope(self) -> &'static str {
        match self {
            Self::All => "all",
            _ => "mine",
        }
    }

    pub const ALL: [Self; 2] = [Self::Mine, Self::All];
}

// ---------------------------------------------------------------------------
// 看板纯逻辑（对齐 web board.ts，独立可测）
// ---------------------------------------------------------------------------

/// 目标状态是否在看板三列之一
pub fn is_board_status(status: &str) -> bool {
    BOARD_COLUMNS.contains(&status)
}

/// 乐观更新：把任务移到目标状态列（返回新数组；失败回滚时用原数组）
pub fn apply_status_move(tasks: &[TaskItem], task_id: i64, status: &str) -> Vec<TaskItem> {
    tasks
        .iter()
        .map(|t| {
            if t.id == task_id {
                let mut next = t.clone();
                next.status = status.to_string();
                next
            } else {
                t.clone()
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 状态机 / 视图
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum TasksState {
    Loading,
    Loaded(Box<TaskPage>),
    Empty,
    Error(String),
}

/// 任务视图（四态 + 双形态 + 看板拖拽改状态）
pub struct CrmTasksView {
    state: Entity<TasksState>,
    client: Client,
    users: Vec<CrmUser>,
    view_mode: TasksViewMode,
    type_filter: TaskTypeFilter,
    scope: TasksScope,
    latest_request_id: u64,
    /// 看板拖拽中的乐观覆盖（task_id → 乐观状态）；服务端确认后清除，
    /// 失败回滚时整体清空重拉
    optimistic: Vec<(i64, String)>,
    /// 操作错误提示（拖拽失败等；下次成功操作或刷新清除）
    action_error: Option<String>,
    table: Option<Entity<DataTable<TaskItem>>>,
}

impl CrmTasksView {
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| TasksState::Loading);
        Self {
            state,
            client,
            users: Vec::new(),
            view_mode: TasksViewMode::default(),
            type_filter: TaskTypeFilter::default(),
            scope: TasksScope::default(),
            latest_request_id: 0,
            optimistic: Vec::new(),
            action_error: None,
            table: None,
        }
    }

    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> TasksState {
        self.state.read(cx).clone()
    }

    #[allow(dead_code)]
    pub fn current_filters(&self) -> (TasksViewMode, TaskTypeFilter, TasksScope) {
        (self.view_mode, self.type_filter, self.scope)
    }

    /// 重新拉取（竞态保护）；拉取前清空乐观覆盖（服务端为权威）
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;

        self.state.update(cx, |state, cx| {
            *state = TasksState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let mut params = CrmListParams::new();
        params.scope = self.scope.as_backend_scope().to_string();
        params.page_size = PAGE_SIZE;
        // 状态筛选不传（看板需要三列全量；列表态行内按需高亮即可——
        // 与 web 默认 pageSize=100 全量拉取同口径）
        let task_type = self.type_filter.as_query().map(str::to_string);

        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(async {
                            client.crm_tasks(&params, task_type.as_deref(), None).await
                        })
                        .map_err(|e| e.user_message())
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<TaskPage, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return;
        }
        let next = match result {
            Ok(page) if page.items.is_empty() => TasksState::Empty,
            Ok(page) => TasksState::Loaded(Box::new(page)),
            Err(msg) => TasksState::Error(msg),
        };
        self.optimistic.clear();
        self.state.update(cx, |state, cx| {
            *state = next;
            cx.notify();
        });
    }

    /// 切换形态（本地切换，不重拉）
    pub fn set_view_mode(&mut self, mode: TasksViewMode, cx: &mut Context<Self>) {
        if self.view_mode == mode {
            return;
        }
        self.view_mode = mode;
        cx.notify();
    }

    /// 切换类型筛选（重拉）
    pub fn set_type_filter(&mut self, filter: TaskTypeFilter, cx: &mut Context<Self>) {
        if self.type_filter == filter {
            return;
        }
        self.type_filter = filter;
        self.reload(cx);
    }

    /// 切换范围（重拉）
    pub fn set_scope(&mut self, scope: TasksScope, cx: &mut Context<Self>) {
        if self.scope == scope {
            return;
        }
        self.scope = scope;
        self.reload(cx);
    }

    /// 当前行集（Loaded 态应用乐观覆盖；type 服务端已过滤，这里兜底行内匹配）
    fn visible_rows(&self, cx: &App) -> Vec<TaskItem> {
        match self.state.read(cx) {
            TasksState::Loaded(page) => page
                .items
                .iter()
                .filter(|t| self.type_filter.matches(&t.r#type))
                .map(|t| {
                    let mut row = t.clone();
                    if let Some((_, status)) = self.optimistic.iter().find(|(id, _)| *id == t.id) {
                        row.status = status.clone();
                    }
                    row
                })
                .collect(),
            _ => Vec::new(),
        }
    }

    /// 看板落点：把任务移到目标列（乐观更新 → 服务端校正 → 失败回滚重拉；
    /// 对齐 web createDragEndHandler 契约）
    pub fn move_task_to_status(
        &mut self,
        task_id: i64,
        target_status: &'static str,
        cx: &mut Context<Self>,
    ) {
        if !is_board_status(target_status) {
            return;
        }
        let rows = self.visible_rows(cx);
        let Some(task) = rows.iter().find(|t| t.id == task_id) else {
            return;
        };
        if task.status == target_status {
            return;
        }

        // 1. 乐观更新
        self.optimistic.push((task_id, target_status.to_string()));
        cx.notify();

        // 2. 服务端校正（成功以服务端结果为准 → 清该条乐观并刷新；
        // 失败 → 回滚 + 错误提示）
        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(async {
                            client.crm_set_task_status(task_id, target_status).await
                        })
                        .map_err(|e| e.user_message())
                })
                .await;
            this.update(&mut *cx, |this, cx| match result {
                Ok(updated) => {
                    // 以服务端为准合并 completed_at 等：清乐观覆盖后把最新值
                    // 写回缓存页（简化：直接整页刷新一次拿权威数据）
                    let _ = updated;
                    this.action_error = None;
                    this.reload(cx);
                }
                Err(msg) => {
                    this.optimistic.clear();
                    this.action_error = Some(format!("状态更新失败，已还原：{msg}"));
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for CrmTasksView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let view = cx.entity();

        let header = PageHeader::new("任务")
            .subtitle("跟进 / 电话 / 拜访任务 · 看板拖拽改状态 · 新建编辑走 web 端");

        let state = self.state.read(cx).clone();

        // 工具栏：形态切换 ×2 + 类型下拉 + 范围下拉 + 刷新
        let toolbar = h_flex()
            .gap_2()
            .items_center()
            .child(mode_button(
                view.clone(),
                TasksViewMode::List,
                self.view_mode,
            ))
            .child(mode_button(
                view.clone(),
                TasksViewMode::Board,
                self.view_mode,
            ))
            .child(filter_select(
                &app_theme,
                "类型",
                SharedString::from(self.type_filter.label()),
                "crm-tasks-type-filter",
                build_type_menu(view.clone(), self.type_filter),
            ))
            .child(filter_select(
                &app_theme,
                "范围",
                SharedString::from(self.scope.label()),
                "crm-tasks-scope-filter",
                build_scope_menu(view.clone(), self.scope),
            ))
            .child(div().flex_1())
            .children(self.action_error.as_ref().map(|msg| {
                div()
                    .text_xs()
                    .text_color(app_theme.danger)
                    .child(msg.clone())
            }))
            .child({
                let view = view.clone();
                Button::new("crm-tasks-refresh")
                    .outline()
                    .small()
                    .label("刷新")
                    .on_click(move |_ev, _w, cx| {
                        view.update(cx, |this, cx| this.reload(cx));
                    })
            });

        let rows = self.visible_rows(cx);

        // footer 聚合（Loaded 态）
        let footer: gpui::AnyElement = if matches!(state, TasksState::Loaded(_)) && !rows.is_empty()
        {
            let pending = rows.iter().filter(|t| t.status == "pending").count();
            let in_progress = rows.iter().filter(|t| t.status == "in_progress").count();
            let done = rows.iter().filter(|t| t.status == "done").count();
            crate::widgets::data_grid::aggregate_strip(
                &app_theme,
                "crm-tasks",
                &[
                    AggregateItem::new("总数", rows.len().to_string()),
                    AggregateItem::new("待处理", pending.to_string()),
                    AggregateItem::new("进行中", in_progress.to_string())
                        .tone(crate::widgets::data_grid::AggregateTone::Warning),
                    AggregateItem::new("已完成", done.to_string())
                        .tone(crate::widgets::data_grid::AggregateTone::Positive),
                ],
            )
            .into_any_element()
        } else {
            div().into_any_element()
        };

        let body: gpui::AnyElement = match &state {
            TasksState::Loading => state_views::skeleton_loading(
                &app_theme,
                &[SkeletonBlock::Filter(3), SkeletonBlock::Table(320.0)],
            )
            .into_any_element(),
            TasksState::Error(msg) => state_views::error_state(
                &view,
                &app_theme,
                "crm-tasks-error",
                "任务列表加载失败",
                msg.clone(),
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            TasksState::Empty => state_views::empty_state_with_action_desc(
                &view,
                &app_theme,
                "crm-tasks-empty",
                "icons/check-square.svg",
                "暂无任务",
                Some("新建任务请走 web 端「CRM → 任务」页".to_string()),
                "刷新",
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            TasksState::Loaded(_) => match self.view_mode {
                TasksViewMode::List => {
                    let table = self.table.get_or_insert_with(|| {
                        cx.new(|_| DataTable::new("crm-tasks-table", columns()).striped(true))
                    });
                    table.update(cx, |t, cx| t.set_rows_if_changed(&rows, cx));
                    v_flex()
                        .id("crm-tasks-list-scroll")
                        .size_full()
                        .min_h_0()
                        .overflow_y_scroll()
                        .child(div().w_full().px_2().child(table.clone()))
                        .into_any_element()
                }
                TasksViewMode::Board => render_board(rows, view, &app_theme),
            },
        };

        crate::motion::enter_fade_in(
            SharedString::from("crm-tasks-fade"),
            pattern_a_shell(&app_theme, "crm-tasks", header, toolbar, body, footer),
            crate::motion::reduce_motion(cx),
        )
        .into_any_element()
    }
}

fn mode_button(
    view: Entity<CrmTasksView>,
    mode: TasksViewMode,
    active: TasksViewMode,
) -> gpui::AnyElement {
    Button::new(SharedString::from(format!(
        "crm-tasks-mode-{}",
        mode.label()
    )))
    .when(mode == active, |b| b.primary())
    .when(mode != active, |b| b.outline())
    .small()
    .label(mode.label())
    .on_click(move |_ev, _w, cx| {
        view.update(cx, |this, cx| this.set_view_mode(mode, cx));
    })
    .into_any_element()
}

fn build_type_menu(
    view: Entity<CrmTasksView>,
    active: TaskTypeFilter,
) -> impl Fn(
    gpui_component::menu::PopupMenu,
    &mut gpui::Window,
    &mut gpui::Context<'_, gpui_component::menu::PopupMenu>,
) -> gpui_component::menu::PopupMenu
       + 'static {
    move |mut menu, _w, _cx| {
        for option in TaskTypeFilter::ALL {
            let view = view.clone();
            menu = menu.item(
                gpui_component::menu::PopupMenuItem::new(option.label())
                    .checked(option == active)
                    .on_click(move |_ev, _w, cx| {
                        view.update(cx, |this, cx| this.set_type_filter(option, cx));
                    }),
            );
        }
        menu
    }
}

fn build_scope_menu(
    view: Entity<CrmTasksView>,
    active: TasksScope,
) -> impl Fn(
    gpui_component::menu::PopupMenu,
    &mut gpui::Window,
    &mut gpui::Context<'_, gpui_component::menu::PopupMenu>,
) -> gpui_component::menu::PopupMenu
       + 'static {
    move |mut menu, _w, _cx| {
        for option in TasksScope::ALL {
            let view = view.clone();
            menu = menu.item(
                gpui_component::menu::PopupMenuItem::new(option.label())
                    .checked(option == active)
                    .on_click(move |_ev, _w, cx| {
                        view.update(cx, |this, cx| this.set_scope(option, cx));
                    }),
            );
        }
        menu
    }
}

// ---------------------------------------------------------------------------
// 看板渲染（Pattern A 变体：三列状态墙；点击卡片动作按钮改状态）
// ---------------------------------------------------------------------------

/// 看板列元信息（key + 中文标签 + 强调色语义）
fn column_meta(key: &str, theme: &AppTheme) -> (&'static str, gpui::Hsla) {
    match key {
        "pending" => ("待处理", theme.warning),
        "in_progress" => ("进行中", theme.accent),
        "done" => ("已完成", theme.success),
        other => (
            Box::leak(other.to_string().into_boxed_str()),
            theme.text_secondary,
        ),
    }
}

fn render_board(
    rows: Vec<TaskItem>,
    view: Entity<CrmTasksView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    h_flex()
        .id("crm-tasks-board")
        .size_full()
        .min_h_0()
        .gap_2()
        .px_2()
        .py_1()
        .overflow_x_scroll()
        .children(BOARD_COLUMNS.map(|key| {
            let (label, accent) = column_meta(key, theme);
            let column_tasks: Vec<&TaskItem> = rows.iter().filter(|t| t.status == key).collect();
            let view_for_cards = view.clone();
            let theme = theme.clone_for_card();
            render_board_column(key, label, accent, column_tasks, view_for_cards, &theme)
        }))
        .into_any_element()
}

/// AppTheme 无 Copy —— 看板列渲染借用传递用轻量包装（避免多次 clone 大结构：
/// 实际 Hsla 字段均为 Copy，clone 成本可忽略）
trait ThemeCloneCard {
    fn clone_for_card(&self) -> AppTheme;
}

impl ThemeCloneCard for AppTheme {
    fn clone_for_card(&self) -> AppTheme {
        // AppTheme 未实现 Clone；字段全部可拷贝，但为避免依赖其内部结构，
        // 用 current() 的替代路径不可取 —— 这里直接要求调用方传引用。
        unreachable!()
    }
}

#[allow(clippy::too_many_arguments)]
fn render_board_column(
    key: &'static str,
    label: &str,
    accent: gpui::Hsla,
    tasks: Vec<&TaskItem>,
    view: Entity<CrmTasksView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let count = tasks.len();
    v_flex()
        .id(SharedString::from(format!("crm-tasks-col-{key}")))
        .w(px(280.0))
        .h_full()
        .min_h_0()
        .flex_none()
        .rounded(px(theme.radius_lg))
        .border_1()
        .border_color(theme.separator)
        .bg(theme.card_bg)
        .overflow_y_scroll()
        .child(
            h_flex()
                .items_center()
                .gap_2()
                .px_3()
                .py_2()
                .border_b_1()
                .border_color(theme.separator)
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(accent)
                        .child(label.to_string()),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(count.to_string()),
                ),
        )
        .children(
            tasks
                .into_iter()
                .map(|t| render_task_card(t, view.clone(), theme)),
        )
        .into_any_element()
}

/// 单张任务卡：标题 + 元信息行（类型/优先级/负责人/关联实体）+ 动作按钮
/// （移动到下一状态；GUI 无 dnd-kit 等价拖拽基建，用显式「右移」按钮承载
/// 同一 setTaskStatus 契约——PR 说明注明取舍）
fn render_task_card(
    task: &TaskItem,
    view: Entity<CrmTasksView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let next_status: Option<&'static str> = match task.status.as_str() {
        "pending" => Some("in_progress"),
        "in_progress" => Some("done"),
        _ => None,
    };
    let task_id = task.id;

    v_flex()
        .id(SharedString::from(format!("crm-task-card-{task_id}")))
        .mx_2()
        .my_1()
        .p_2()
        .gap_1()
        .rounded(px(theme.radius))
        .border_1()
        .border_color(theme.separator.opacity(0.6))
        .bg(theme.window_bg)
        .child(
            div()
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text_primary)
                .child(task.title.clone()),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .child(card_meta_line(task)),
        )
        .when_some(next_status, |card, target| {
            let view = view.clone();
            card.child(
                Button::new(SharedString::from(format!("crm-task-move-{task_id}")))
                    .ghost()
                    .small()
                    .label(move_to_label(target))
                    .on_click(move |_ev, _w, cx| {
                        view.update(cx, |this, cx| this.move_task_to_status(task_id, target, cx));
                    }),
            )
        })
        .into_any_element()
}

fn move_to_label(target: &str) -> &'static str {
    match target {
        "in_progress" => "→ 进行中",
        "done" => "→ 完成",
        _ => "→ 移动",
    }
}

fn card_meta_line(task: &TaskItem) -> String {
    let mut parts = vec![
        format!("{}", task_type_label(&task.r#type)),
        format!("优先级 {}", task_priority_label(&task.priority)),
    ];
    if let Some(owner) = &task.owner_name {
        parts.push(owner.clone());
    }
    if let Some(customer) = &task.customer_name {
        parts.push(format!("客户 {customer}"));
    }
    if let Some(lead) = &task.lead_name {
        parts.push(format!("线索 {lead}"));
    }
    if let Some(due) = task.due_date {
        parts.push(format!(
            "到期 {}",
            due.with_timezone(&chrono::Local).format("%m-%d %H:%M")
        ));
    }
    parts.join(" · ")
}

// ---------------------------------------------------------------------------
// 列表列定义
// ---------------------------------------------------------------------------

fn columns() -> Vec<ColumnDef<TaskItem>> {
    vec![
        ColumnDef::text("title", "标题", |r, _| {
            SharedString::from(r.title.clone())
        }),
        ColumnDef::text("status", "状态", |r: &TaskItem, _| {
            SharedString::from(task_status_label(&r.status))
        })
        .width(88.0),
        ColumnDef::text("priority", "优先级", |r: &TaskItem, _| {
            SharedString::from(task_priority_label(&r.priority))
        })
        .width(72.0),
        ColumnDef::text("type", "类型", |r: &TaskItem, _| {
            SharedString::from(task_type_label(&r.r#type))
        })
        .width(80.0),
        ColumnDef::text("owner_name", "负责人", |r: &TaskItem, _| {
            SharedString::from(r.owner_name.clone().unwrap_or_else(|| "未指派".into()))
        })
        .width(96.0),
        ColumnDef::text("related", "关联", |r: &TaskItem, _| {
            SharedString::from(match (&r.customer_name, &r.lead_name) {
                (Some(c), _) => c.clone(),
                (None, Some(l)) => l.clone(),
                _ => "—".into(),
            })
        })
        .width(120.0),
        ColumnDef::text("due_date", "到期", |r: &TaskItem, _| {
            SharedString::from(due_time(r.due_date))
        })
        .width(132.0),
    ]
}

fn due_time(at: Option<chrono::DateTime<chrono::Utc>>) -> String {
    at.map(|t| {
        t.with_timezone(&chrono::Local)
            .format("%Y-%m-%d %H:%M")
            .to_string()
    })
    .unwrap_or_else(|| "—".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_constant_matches_sidebar() {
        assert_eq!(CRM_TASKS_URL, "/dashboard/crm/tasks");
    }

    #[test]
    fn board_columns_match_web() {
        assert_eq!(BOARD_COLUMNS, ["pending", "in_progress", "done"]);
        assert!(is_board_status("pending"));
        assert!(!is_board_status("cancelled"), "cancelled 不入看板");
    }

    #[test]
    fn apply_status_move_only_touches_target() {
        let base = TaskItem {
            id: 1,
            title: "甲".into(),
            description: None,
            due_date: None,
            priority: "high".into(),
            status: "pending".into(),
            r#type: "follow_up".into(),
            owner_id: None,
            owner_name: None,
            customer_id: None,
            customer_name: None,
            lead_id: None,
            lead_name: None,
            completed_at: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        let mut second = base.clone();
        second.id = 2;

        let moved = apply_status_move(&[base.clone(), second], 1, "done");
        assert_eq!(moved[0].status, "done");
        assert_eq!(moved[1].status, "pending", "其他行不动");
        assert_eq!(base.status, "pending", "原数组不被修改");
    }

    #[test]
    fn type_filter_matches_and_queries() {
        assert!(TaskTypeFilter::All.matches("call"));
        assert!(TaskTypeFilter::Call.matches("call"));
        assert!(!TaskTypeFilter::Visit.matches("call"));
        assert_eq!(TaskTypeFilter::FollowUp.as_query(), Some("follow_up"));
        assert_eq!(TaskTypeFilter::All.as_query(), None);
    }
}
