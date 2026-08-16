//! 运营 → 项目目标视图（P5-1，BLF-716）
//!
//! frontend `app/dashboard/operations/project-goals/page.tsx` 的 GPUI 等价：
//! 月度/年度销售目标设定与完成进度展示。
//!
//! 架构（沿用 P3 既有模式 + P5-0 公共组件）：
//! - **四态状态机**：`Loading / Loaded / Empty / Error`，`latest_request_id`
//!   竞态保护——只有最新请求的响应才会落点；
//! - **数据管线**：`list_managed_projects` → 自动选中第一个项目（对齐 frontend
//!   `useAutoSelectFirstProject`）→ 并行拉 `project_goals_progress`（进度概览）+
//!   `project_goals_list`（目标列表）；
//! - **筛选**：项目 / 国家（US/DE/UK）/ 年份（近 5 年）→ 复用 `widgets::filter_bar`；
//! - **本月进度三环**：`chart::PieChart` 同心环（外→内 = 截止今日完成率 / 实际月度
//!   进度 / 预估月度完成率），右侧 3 个指标块（对齐 frontend `GoalProgressRings`）；
//! - **明细卡 4 张**：年度完成率 / 本月已达成 / 月度目标 / 日目标；
//! - **两 tab**：进度概览（12 个月进度表，进度条 + 状态徽章）、目标管理（12 个月
//!   目标表，行内 新增/编辑/删除）——复用 `widgets::data_table`；
//! - **写操作**：新增/编辑（POST/PUT）、删除（DELETE，带确认覆盖层）——存后清缓存
//!   语义在 GUI 侧等价为「reload 重拉」；409 冲突给出可读提示。
//!
//! 已知差异（有意保留，macOS 原生习惯 / GPUI 能力边界）：
//! - 三环为同心圆环（非 Apple Watch 分段环），无逐环动画（减少动态路径同样生效）；
//! - 写操作模态用应用内覆盖层（对齐 macOS sheet 观感），不用系统级对话框；
//! - frontend 的 2min 客户端缓存（BEL-423）在 GUI 侧无等价（每次 reload 直拉）。

use chrono::{Datelike, Local};
use gpui::{
    div, prelude::*, px, App, AsyncApp, Context, CursorStyle, Entity, FontWeight, Render,
    SharedString, WeakEntity, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants},
    chart::PieChart,
    h_flex,
    input::{Input, InputEvent, InputState},
    menu::PopupMenuItem,
    v_flex, Disableable, Icon, IconName, Sizable,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::operations::project_goals::{
    currency_symbol, format_money, format_percent, month_status, projected_monthly_rate,
    year_options, MonthStatus, ProjectGoalCreateBody, ProjectGoalItem, ProjectGoalListResponse,
    ProjectGoalProgressResponse, MONTH_NAMES,
};

use crate::theme::AppTheme;
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::{
    data_table::{ColumnDef, DataTable},
    filter_bar, state_views,
};
use crate::widgets::state_views::SkeletonBlock;

/// 本页在侧栏中的 URL（root.rs 据此路由；与 gui-domain::sidebar 的项目目标条目一致）
pub const PROJECT_GOALS_URL: &str = "/dashboard/operations/project-goals";

/// 站点选项（对齐 frontend `COUNTRY_OPTIONS`：US/DE/UK）
const COUNTRY_OPTIONS: [(&str, &str); 3] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
];

/// 默认站点（对齐 frontend `useUrlParam('country', 'US')`）
const DEFAULT_COUNTRY: &str = "US";

/// 目标类型（写操作对话框用）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GoalType {
    Monthly,
    Annual,
}

impl GoalType {
    fn label(self) -> &'static str {
        match self {
            GoalType::Monthly => "月度",
            GoalType::Annual => "年度",
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            GoalType::Monthly => "monthly",
            GoalType::Annual => "annual",
        }
    }
}

/// 目标管理 tab（对齐 frontend Tabs：进度概览 / 目标管理）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GoalsTab {
    Progress,
    Goals,
}

/// 项目目标载荷（Loaded 持有）
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectGoalsData {
    pub projects: Vec<ManagedProject>,
    pub progress: ProjectGoalProgressResponse,
    pub goals: Vec<ProjectGoalItem>,
}

impl ProjectGoalsData {
    /// 空态判定：没有任何项目 → Empty（对齐 frontend `!selectedProjectId` 占位）
    pub fn is_empty(&self) -> bool {
        self.projects.is_empty()
    }
}

/// 项目目标状态机（四态；对齐 dashboard.rs）
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum ProjectGoalsState {
    Loading,
    Loaded(ProjectGoalsData),
    Empty,
    Error(String),
}

impl ProjectGoalsState {
    /// 拉取结果 → 落点状态（唯一合法的「拉取完成」转移）
    pub fn from_fetch_result(result: Result<ProjectGoalsData, String>) -> Self {
        match result {
            Ok(data) if data.is_empty() => Self::Empty,
            Ok(data) => Self::Loaded(data),
            Err(msg) => Self::Error(msg),
        }
    }
}

/// 项目目标视图（状态机 + 项目/国家/年份筛选 + 进度/目标双 tab + 写操作）
pub struct ProjectGoalsView {
    state: Entity<ProjectGoalsState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表（reload 刷新；筛选菜单数据源）
    projects: Vec<ManagedProject>,
    /// 当前选中项目；`None` = 未选择（拉取后自动选第一个）
    selected_project_id: Option<i64>,
    /// 当前站点（"US" / "DE" / "UK"）
    country: &'static str,
    /// 当前年份（对齐 frontend `selectedYear`，默认当前年）
    year: i32,
    /// 请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,
    /// 当前 tab（默认进度概览）
    active_tab: GoalsTab,
    /// 进度概览表（懒建 DataTable，render 期幂等注入行）
    progress_table: Option<Entity<DataTable<ProgressRow>>>,
    /// 目标管理表（懒建 DataTable；操作列闭包捕获视图）
    goals_table: Option<Entity<DataTable<GoalRow>>>,
    /// 写操作对话框（None = 关闭）
    goal_dialog: Option<GoalDialogState>,
    /// 删除确认（None = 关闭）
    confirm_delete: Option<ProjectGoalItem>,
    /// 目标金额输入（对话框打开时懒建，需要 window）
    amount_input: Option<Entity<InputState>>,
    amount_sub: Option<gpui::Subscription>,
    /// 写操作进行中（保存按钮禁用 + 防重复提交）
    saving: bool,
    /// 写操作错误提示（409 冲突等，显示在对话框内）
    dialog_error: Option<String>,
}

/// 写操作对话框状态
#[derive(Debug, Clone)]
struct GoalDialogState {
    goal_type: GoalType,
    /// 目标月份（1-12，仅月度目标）
    period_month: i32,
    /// 正在编辑的目标（None = 新增）
    editing: Option<ProjectGoalItem>,
}

impl ProjectGoalsView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| ProjectGoalsState::Loading);
        Self {
            state,
            client,
            projects: Vec::new(),
            selected_project_id: None,
            country: DEFAULT_COUNTRY,
            year: Local::now().year(),
            latest_request_id: 0,
            active_tab: GoalsTab::Progress,
            progress_table: None,
            goals_table: None,
            goal_dialog: None,
            confirm_delete: None,
            amount_input: None,
            amount_sub: None,
            saving: false,
            dialog_error: None,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> ProjectGoalsState {
        self.state.read(cx).clone()
    }

    /// 重新拉取数据：项目/国家/年份切换、错误重试、空态刷新、写操作后共用入口。
    ///
    /// 每次调用递增 `latest_request_id` 并进入 Loading；响应回来时
    /// `apply_result` 只应用最新一次（竞态保护，对齐 dashboard.rs）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let selected = self.selected_project_id;
        let country = self.country;
        let year = self.year;

        self.state.update(cx, |state, cx| {
            *state = ProjectGoalsState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(load_project_goals(&client, selected, country, year))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 切换选中项目 → reload（同一项目为 no-op）
    pub fn select_project(&mut self, project_id: Option<i64>, cx: &mut Context<Self>) {
        if project_id == self.selected_project_id {
            return;
        }
        self.selected_project_id = project_id;
        self.reload(cx);
    }

    /// 切换站点 → reload（同一站点为 no-op）
    pub fn select_country(&mut self, country: &'static str, cx: &mut Context<Self>) {
        if country == self.country {
            return;
        }
        self.country = country;
        self.reload(cx);
    }

    /// 切换年份 → reload（同一年份为 no-op）
    pub fn select_year(&mut self, year: i32, cx: &mut Context<Self>) {
        if year == self.year {
            return;
        }
        self.year = year;
        self.reload(cx);
    }

    /// 切换 tab（进度概览 / 目标管理）
    pub fn select_tab(&mut self, tab: GoalsTab, cx: &mut Context<Self>) {
        if tab == self.active_tab {
            return;
        }
        self.active_tab = tab;
        cx.notify();
    }

    /// 打开新增对话框（月度带预选月份；年度不带月份）
    pub fn open_create(&mut self, goal_type: GoalType, month: Option<i32>, cx: &mut Context<Self>) {
        let period_month = month.unwrap_or_else(|| Local::now().month() as i32);
        self.goal_dialog = Some(GoalDialogState {
            goal_type,
            period_month: period_month.clamp(1, 12),
            editing: None,
        });
        self.dialog_error = None;
        self.amount_input = None; // 重建输入（编辑值时用新默认值）
        cx.notify();
    }

    /// 打开编辑对话框（目标类型/月份来自目标本身）
    pub fn open_edit(&mut self, goal: ProjectGoalItem, cx: &mut Context<Self>) {
        let goal_type = if goal.is_annual() {
            GoalType::Annual
        } else {
            GoalType::Monthly
        };
        let period_month = goal.period_month.unwrap_or_else(|| Local::now().month() as i32);
        self.goal_dialog = Some(GoalDialogState {
            goal_type,
            period_month: period_month.clamp(1, 12),
            editing: Some(goal),
        });
        self.dialog_error = None;
        self.amount_input = None;
        cx.notify();
    }

    /// 关闭写操作对话框
    fn close_dialog(&mut self, cx: &mut Context<Self>) {
        self.goal_dialog = None;
        self.dialog_error = None;
        self.amount_input = None;
        cx.notify();
    }

    /// 请求删除确认（目标管理表行内删除按钮）
    pub fn request_delete(&mut self, goal: ProjectGoalItem, cx: &mut Context<Self>) {
        self.confirm_delete = Some(goal);
        cx.notify();
    }

    /// 取消删除确认
    fn cancel_delete(&mut self, cx: &mut Context<Self>) {
        self.confirm_delete = None;
        cx.notify();
    }

    /// 保存目标（新增 POST / 编辑 PUT）：
    /// - 从 `amount_input` 读取金额，非法值（空/非数字/负数）在对话框内提示；
    /// - 409 冲突 → 保留对话框并展示后端 detail（「X月目标已存在，请直接编辑现有目标」）；
    /// - 成功 → 关闭对话框 + reload 重拉。
    pub fn save_goal(&mut self, cx: &mut Context<Self>) {
        let Some(dialog) = self.goal_dialog.clone() else {
            return;
        };
        let raw = self
            .amount_input
            .as_ref()
            .map(|input| input.read(cx).value().to_string())
            .unwrap_or_default();
        let amount: f64 = match raw.trim().parse() {
            Ok(v) if v >= 0.0 => v,
            _ => {
                self.dialog_error = Some("请输入有效的目标金额".to_string());
                cx.notify();
                return;
            }
        };
        if amount == 0.0 {
            self.dialog_error = Some("目标金额需大于 0".to_string());
            cx.notify();
            return;
        }

        self.saving = true;
        let Some(project_id) = self.selected_project_id else {
            self.saving = false;
            self.dialog_error = Some("请先选择项目".to_string());
            cx.notify();
            return;
        };
        let client = self.client.clone();
        let country = self.country;
        let year = self.year;
        let goal_type = dialog.goal_type;
        let period_month = dialog.period_month;
        let editing_id = dialog.editing.as_ref().map(|g| g.id);

        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(async {
                        if let Some(id) = editing_id {
                            client
                                .update_project_goal(id, amount)
                                .await
                                .map(|_| ())
                        } else {
                            let body = ProjectGoalCreateBody {
                                project_id,
                                country: country.to_string(),
                                goal_type: goal_type.as_str().to_string(),
                                metric_type: "sales_amount".to_string(),
                                period_year: year,
                                period_month: (goal_type == GoalType::Monthly)
                                    .then_some(period_month),
                                target_amount: amount,
                            };
                            client.create_project_goal(&body).await.map(|_| ())
                        }
                    })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.saving = false;
                match result {
                    Ok(()) => {
                        this.goal_dialog = None;
                        this.dialog_error = None;
                        this.amount_input = None;
                        this.reload(cx);
                    }
                    Err(e) => {
                        this.dialog_error = Some(e.user_message());
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    /// 删除目标（确认后 DELETE + reload）
    pub fn confirm_delete_goal(&mut self, cx: &mut Context<Self>) {
        let Some(goal) = self.confirm_delete.clone() else {
            return;
        };
        self.confirm_delete = None;
        self.saving = true;
        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(client.delete_project_goal(goal.id))
                        .map_err(|e| e.user_message())
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.saving = false;
                if let Err(msg) = result {
                    this.dialog_error = Some(msg);
                }
                this.reload(cx);
            })
            .ok();
        })
        .detach();
    }

    /// 应用拉取结果：竞态保护 + 自动选中第一个项目（对齐 web）+ 落点状态。
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<ProjectGoalsData, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok(data) = &result {
            self.projects = data.projects.clone();
            // 对齐 frontend `useAutoSelectFirstProject`：未选项目时自动选第一个
            if self.selected_project_id.is_none() {
                if let Some(first) = data.projects.first() {
                    self.selected_project_id = Some(first.id);
                    // 项目列表刚就绪，本次载荷可能没带该项目的数据 → 重拉一次
                    if data.progress.project_id != first.id {
                        self.reload(cx);
                        return;
                    }
                }
            }
        }
        self.state.update(cx, |state, cx| {
            *state = ProjectGoalsState::from_fetch_result(result);
            cx.notify();
        });
    }
}

/// 拉取项目目标（项目列表 + 进度 + 目标列表），与视图解耦便于测试。
///
/// 对齐 frontend loadData：未选项目 → 仅项目列表（视图据此自动选中第一个）；
/// 选了项目 → 并行拉 progress + goals。
async fn load_project_goals(
    client: &Client,
    selected_project_id: Option<i64>,
    country: &str,
    year: i32,
) -> Result<ProjectGoalsData, String> {
    let projects = client
        .list_managed_projects()
        .await
        .map_err(|e| e.user_message())?;
    let Some(project_id) = selected_project_id else {
        // 未选项目：返回空进度载荷，视图自动选中第一个项目后重拉
        return Ok(ProjectGoalsData {
            projects,
            progress: ProjectGoalProgressResponse {
                project_id: 0,
                country: country.to_string(),
                year,
                currency: "USD".to_string(),
                monthly_progress: Vec::new(),
                annual_progress: None,
            },
            goals: Vec::new(),
        });
    };

    let (progress, goals): (Result<_, String>, Result<ProjectGoalListResponse, String>) = {
        let p = client.project_goals_progress(project_id, country, year).await;
        let g = client.project_goals_list(project_id, country, year).await;
        (p.map_err(|e| e.user_message()), g.map_err(|e| e.user_message()))
    };
    let progress = progress?;
    let goals = goals?;
    Ok(ProjectGoalsData {
        projects,
        progress,
        goals: goals.goals,
    })
}

// ---------------------------------------------------------------------------
// 展示行类型（DataTable 行；纯展示派生，可单测）
// ---------------------------------------------------------------------------

/// 进度概览表行（12 个月）
#[derive(Debug, Clone, PartialEq)]
pub struct ProgressRow {
    pub item: gui_domain::operations::project_goals::MonthlyProgressItem,
    pub is_current_month: bool,
    pub month_status: MonthStatus,
    /// 运营（包含助理）展示文本（来自项目字段；无则 "—"）
    pub operators: String,
}

/// 目标管理表行（12 个月；合并目标 + 进度）
#[derive(Debug, Clone, PartialEq)]
pub struct GoalRow {
    pub month: i32,
    pub goal: Option<ProjectGoalItem>,
    pub progress: Option<gui_domain::operations::project_goals::MonthlyProgressItem>,
    pub is_current_month: bool,
    pub month_status: MonthStatus,
}

/// 由「进度概览 + 目标列表 + 项目」派生进度表行（12 个月，对齐 frontend）。
pub fn build_progress_rows(
    data: &ProjectGoalsData,
    current_year: i32,
    current_month: i32,
) -> Vec<ProgressRow> {
    let operators = data
        .projects
        .iter()
        .find(|p| Some(p.id) == data.progress.project_id.into())
        .map(|p| {
            let parts = [p.project_operator.clone(), p.assistant_operator.clone()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            if parts.is_empty() {
                "—".to_string()
            } else {
                parts.join(" / ")
            }
        })
        .unwrap_or_else(|| "—".to_string());
    data.progress
        .monthly_progress
        .iter()
        .map(|item| ProgressRow {
            item: item.clone(),
            is_current_month: item.year == current_year && item.month == current_month,
            month_status: month_status(item.year, item.month, current_year, current_month),
            operators: operators.clone(),
        })
        .collect()
}

/// 由「进度概览 + 目标列表」派生目标表行（固定 12 个月，对齐 frontend `[...Array(12)]`）。
pub fn build_goal_rows(
    data: &ProjectGoalsData,
    year: i32,
    current_year: i32,
    current_month: i32,
) -> Vec<GoalRow> {
    (1..=12)
        .map(|month| {
            let goal = data
                .goals
                .iter()
                .find(|g| g.goal_type == "monthly" && g.period_month == Some(month))
                .cloned();
            let progress = data
                .progress
                .monthly_progress
                .iter()
                .find(|m| m.month == month)
                .cloned();
            GoalRow {
                month,
                goal,
                progress,
                is_current_month: year == current_year && month == current_month,
                month_status: month_status(year, month, current_year, current_month),
            }
        })
        .collect()
}

/// 状态徽章（对齐 frontend `CompletionBadge`：进行中/未开始/达成/未达标）
fn completion_badge(status: MonthStatus, rate: f64, theme: &AppTheme) -> impl IntoElement {
    let (text, bg, fg) = match status {
        MonthStatus::Current => ("进行中", theme.accent_soft, theme.accent),
        MonthStatus::Future => ("未开始", theme.muted_fill, theme.text_muted),
        MonthStatus::Past => {
            if rate >= 1.0 {
                ("达成", theme.success_soft, theme.success)
            } else {
                ("未达标", theme.warning.opacity(0.18), theme.warning)
            }
        }
    };
    div()
        .px_2()
        .py_0p5()
        .rounded_full()
        .text_xs()
        .font_weight(FontWeight::MEDIUM)
        .bg(bg)
        .text_color(fg)
        .child(text)
}

/// 进度条（对齐 frontend `ProgressBar`：超额绿 / 过去未达标橙 / 默认蓝）
fn progress_bar(value: f64, is_past_incomplete: bool, theme: &AppTheme) -> impl IntoElement {
    let pct = (value * 100.0).clamp(0.0, 100.0);
    let over = value > 1.0;
    let color = if over {
        theme.success
    } else if is_past_incomplete {
        theme.warning
    } else {
        theme.accent
    };
    div()
        .w_full()
        .h_2()
        .rounded_full()
        .bg(theme.muted_fill)
        .relative()
        .child(
            div()
                .absolute()
                .left_0()
                .top_0()
                .bottom_0()
                .h_full()
                .rounded_full()
                .bg(color)
                .w(px(pct as f32)),
        )
}

impl Render for ProjectGoalsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let view = cx.entity();

        // 写操作对话框内金额输入懒建（需要 window；对话框关闭后重建）
        if self.goal_dialog.is_some() && self.amount_input.is_none() {
            let initial = self
                .goal_dialog
                .as_ref()
                .and_then(|d| d.editing.as_ref())
                .map(|g| format_money(g.target_amount));
            let input = cx.new(|cx| {
                let mut s = InputState::new(window, cx).placeholder("例如：50000");
                if let Some(v) = initial {
                    s = s.default_value(v);
                }
                s
            });
            self.amount_sub = Some(cx.subscribe(&input, |this, _, _: &InputEvent, _| {
                // Change 事件无需额外动作（保存时读值）；订阅保持输入与视图状态同步
                let _ = this;
            }));
            self.amount_input = Some(input);
        }

        let project_label: SharedString = self
            .selected_project_id
            .and_then(|id| self.projects.iter().find(|p| p.id == id).map(|p| p.name.clone()))
            .map(SharedString::from)
            .unwrap_or_else(|| SharedString::from("请选择项目"));

        v_flex()
            .id("project-goals")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(theme.window_bg)
            // 页面头部（P4-5：共享 PageHeader）
            .child(PageHeader::new("项目目标").subtitle(match &state {
                ProjectGoalsState::Loaded(data) => format!(
                    "{} · {} · {} 年 · 月度/年度销售目标设定与进度",
                    project_label,
                    country_label(self.country),
                    data.progress.year
                ),
                _ => "月度/年度销售目标设定与完成进度（写操作即时生效）".to_string(),
            }))
            // 筛选栏：项目 + 国家 + 年份 + 刷新（宽窗受内容上限约束）
            .child(content_guard().child(render_filter_bar(
                &view,
                &theme,
                &self.projects,
                self.selected_project_id,
                self.country,
                self.year,
            )))
            // 状态区
            .child(match state {
                ProjectGoalsState::Loading => {
                    state_views::skeleton_loading(&theme, &[SkeletonBlock::Table(320.0)])
                        .into_any_element()
                }
                ProjectGoalsState::Error(msg) => state_views::error_state(
                    &view,
                    &theme,
                    "project-goals-error",
                    "项目目标加载失败",
                    msg,
                    |this, cx| this.reload(cx),
                )
                .into_any_element(),
                ProjectGoalsState::Empty => {
                    let message = if self.selected_project_id.is_none() {
                        "请先选择项目以查看目标数据"
                    } else {
                        "暂无项目，请先在 Web 端创建项目"
                    };
                    state_views::empty_state_with_action(
                        &view,
                        &theme,
                        "project-goals-empty",
                        "icons/target.svg",
                        message,
                        "刷新",
                        |this, cx| this.reload(cx),
                    )
                    .into_any_element()
                }
                ProjectGoalsState::Loaded(data) => {
                    let current_year = Local::now().year();
                    let current_month = Local::now().month() as i32;
                    self.sync_tables(&data, current_year, current_month, cx);
                    render_loaded(
                        &view,
                        &theme,
                        &data,
                        self.selected_project_id,
                        self.active_tab,
                        self.progress_table.clone(),
                        self.goals_table.clone(),
                        current_year,
                        current_month,
                        crate::motion::reduce_motion(cx),
                        cx,
                    )
                    .into_any_element()
                }
            })
            // 写操作模态（新增/编辑 + 删除确认）——绝对覆盖层，最上层
            .when(
                self.goal_dialog.is_some() || self.confirm_delete.is_some(),
                |this| this.child(render_modal_overlay(self, cx, &theme)),
            )
    }
}

impl ProjectGoalsView {
    /// 幂等注入两张 DataTable 的行（render 期调用；懒建表格 + set_rows_if_changed）
    fn sync_tables(
        &mut self,
        data: &ProjectGoalsData,
        current_year: i32,
        current_month: i32,
        cx: &mut Context<Self>,
    ) {
        let progress_rows = build_progress_rows(data, current_year, current_month);
        let goal_rows = build_goal_rows(data, self.year, current_year, current_month);

        let progress_table = self.progress_table.get_or_insert_with(|| {
            cx.new(|_| {
                DataTable::new("project-goals-progress-table", progress_columns())
                    .striped(true)
                    .empty_text("暂无月度进度数据")
                    .max_height(420.0)
            })
        });
        progress_table.update(cx, |table, cx| {
            table.set_rows_if_changed(&progress_rows, cx);
        });

        let view = cx.entity();
        let goals_table = self.goals_table.get_or_insert_with(|| {
            cx.new(|_| {
                DataTable::new("project-goals-goals-table", goal_columns(&view))
                    .striped(true)
                    .empty_text("暂无目标数据")
                    .max_height(420.0)
            })
        });
        goals_table.update(cx, |table, cx| {
            table.set_rows_if_changed(&goal_rows, cx);
        });
    }
}

// ---------------------------------------------------------------------------
// 筛选栏（项目 / 国家 / 年份 / 刷新）
// ---------------------------------------------------------------------------

fn render_filter_bar(
    view: &Entity<ProjectGoalsView>,
    app_theme: &AppTheme,
    projects: &[ManagedProject],
    selected_project_id: Option<i64>,
    country: &'static str,
    year: i32,
) -> impl IntoElement {
    let projects_owned = projects.to_vec();
    let project_label: SharedString = match selected_project_id {
        Some(id) => projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| SharedString::from(p.name.clone()))
            .unwrap_or_else(|| SharedString::from("请选择项目")),
        None => SharedString::from("请选择项目"),
    };
    let year_label: SharedString = SharedString::from(format!("{year} 年"));
    let view_for_project = view.clone();
    let view_for_country = view.clone();
    let view_for_year = view.clone();
    let view_for_refresh = view.clone();

    filter_bar::filter_bar_layout(app_theme)
        .child(filter_bar::filter_select(
            app_theme,
            "项目",
            project_label,
            "project-goals-project-filter",
            move |menu, _window, _cx| {
                let mut menu = menu;
                for project in &projects_owned {
                    let checked = selected_project_id == Some(project.id);
                    let id = project.id;
                    let name = project.name.clone();
                    let view = view_for_project.clone();
                    menu = menu.item(
                        PopupMenuItem::new(name)
                            .checked(checked)
                            .on_click(move |_, _window, cx| {
                                view.update(cx, |this, cx| this.select_project(Some(id), cx));
                            }),
                    );
                }
                menu
            },
        ))
        .child(filter_bar::filter_select(
            app_theme,
            "国家",
            country_label(country).into(),
            "project-goals-country-filter",
            move |menu, _window, _cx| {
                let mut menu = menu;
                for (value, label) in COUNTRY_OPTIONS {
                    let checked = country == value;
                    let view = view_for_country.clone();
                    menu = menu.item(
                        PopupMenuItem::new(label).checked(checked).on_click(move |_, _window, cx| {
                            view.update(cx, |this, cx| this.select_country(value, cx));
                        }),
                    );
                }
                menu
            },
        ))
        .child(filter_bar::filter_select(
            app_theme,
            "年份",
            year_label,
            "project-goals-year-filter",
            move |menu, _window, _cx| {
                let mut menu = menu;
                for y in year_options(Local::now().year()) {
                    let checked = year == y;
                    let view = view_for_year.clone();
                    menu = menu.item(
                        PopupMenuItem::new(format!("{y} 年"))
                            .checked(checked)
                            .on_click(move |_, _window, cx| {
                                view.update(cx, |this, cx| this.select_year(y, cx));
                            }),
                    );
                }
                menu
            },
        ))
        .child(div().flex_1())
        .child(
            Button::new("project-goals-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_, _window, cx| {
                    let view = view_for_refresh.clone();
                    view.update(cx, |this, cx| this.reload(cx));
                }),
        )
}

/// 站点展示名（`US` → 「美国站 (US)」）
pub fn country_label(country: &str) -> String {
    COUNTRY_OPTIONS
        .iter()
        .find(|(value, _)| *value == country)
        .map_or_else(|| country.to_string(), |(_, label)| label.to_string())
}

// ---------------------------------------------------------------------------
// Loaded：本月进度 + 明细卡 + 双 tab 表
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn render_loaded(
    view: &Entity<ProjectGoalsView>,
    app_theme: &AppTheme,
    data: &ProjectGoalsData,
    _selected_project_id: Option<i64>,
    active_tab: GoalsTab,
    progress_table: Option<Entity<DataTable<ProgressRow>>>,
    goals_table: Option<Entity<DataTable<GoalRow>>>,
    current_year: i32,
    current_month: i32,
    reduce: bool,
    cx: &mut Context<ProjectGoalsView>,
) -> impl IntoElement {
    let current_month_progress = data
        .progress
        .monthly_progress
        .iter()
        .find(|m| m.year == current_year && m.month == current_month)
        .cloned();
    let currency = &data.progress.currency;
    let symbol = currency_symbol(currency);

    crate::motion::enter_fade_in(
        SharedString::from("project-goals-loaded-fade"),
        v_flex()
            .id("project-goals-loaded")
            .gap_4()
            // ── 本月进度（三环 + 指标块；卡片内容受宽窗上限约束）──
            .when(current_month_progress.is_some(), |this| {
                let m = current_month_progress.as_ref().expect("已判 Some");
                this.child(
                    content_guard().child(
                        v_flex()
                            .gap_3()
                            .child(
                                h_flex()
                                    .gap_2()
                                    .items_center()
                                    .child(
                                        Icon::empty()
                                            .path("icons/bar-chart-3.svg")
                                            .with_size(px(14.))
                                            .text_color(app_theme.accent),
                                    )
                                    .child(
                                        div()
                                            .text_sm()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(app_theme.text_muted)
                                            .child(format!("本月进度 · {}", m.month_label)),
                                    ),
                            )
                            .child(
                                v_flex()
                                    .rounded(px(app_theme.radius_lg))
                                    .bg(app_theme.card_bg)
                                    .shadow(vec![app_theme.card_shadow_box()])
                                    .p_5()
                                    .gap_5()
                                    .child(concentric_rings_section(
                                        m, symbol, app_theme, reduce,
                                    ))
                                    .child(div().h_px().bg(app_theme.separator))
                                    .child(detail_cards(
                                        m,
                                        &data.progress,
                                        symbol,
                                        view,
                                        app_theme,
                                    )),
                            ),
                    ),
                )
            })
            // ── Tabs：进度概览 / 目标管理（表格 tab 保留全宽）──
            .child(content_guard().child(render_tab_bar(view, active_tab, app_theme)))
            .child(match active_tab {
                GoalsTab::Progress => {
                    v_flex()
                        .id("project-goals-progress-tab")
                        .child(progress_table.clone().unwrap_or_else(|| {
                            cx.new(|_| DataTable::new("project-goals-progress-empty", vec![]))
                        }))
                        .into_any_element()
                }
                GoalsTab::Goals => v_flex()
                    .id("project-goals-goals-tab")
                    .gap_3()
                    .child(
                        h_flex()
                            .justify_end()
                            .child(
                                Button::new("project-goals-add")
                                    .primary()
                                    .small()
                                    .icon(Icon::new(IconName::Plus).with_size(px(14.)))
                                    .label("新增月度目标")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.open_create(GoalType::Monthly, None, cx);
                                    })),
                            ),
                    )
                    .child(
                        goals_table
                            .clone()
                            .unwrap_or_else(|| {
                                cx.new(|_| DataTable::new("project-goals-goals-empty", vec![]))
                            }),
                    )
                    .into_any_element(),
            }),
        reduce,
    )
}

/// 顶部 tab 栏（进度概览 / 目标管理）
fn render_tab_bar(
    view: &Entity<ProjectGoalsView>,
    active: GoalsTab,
    theme: &AppTheme,
) -> impl IntoElement {
    h_flex()
        .id("project-goals-tabs")
        .w_full()
        .p_1()
        .gap_1()
        .rounded(px(theme.radius_lg))
        .bg(theme.muted_fill)
        .child(tab_button(
            view,
            GoalsTab::Progress,
            active == GoalsTab::Progress,
            theme,
        ))
        .child(tab_button(
            view,
            GoalsTab::Goals,
            active == GoalsTab::Goals,
            theme,
        ))
}

fn tab_button(
    view: &Entity<ProjectGoalsView>,
    tab: GoalsTab,
    selected: bool,
    theme: &AppTheme,
) -> impl IntoElement {
    let label = match tab {
        GoalsTab::Progress => "进度概览",
        GoalsTab::Goals => "目标管理",
    };
    let view = view.clone();
    div()
        .id(SharedString::from(format!(
            "project-goals-tab-{}",
            match tab {
                GoalsTab::Progress => "progress",
                GoalsTab::Goals => "goals",
            }
        )))
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
        .on_mouse_up(
            gpui::MouseButton::Left,
            move |_, _window, cx| {
                view.update(cx, |this, cx| this.select_tab(tab, cx));
            },
        )
        .child(label)
}

/// 三环指标区（对齐 frontend `GoalProgressRings`：同心环 + 3 指标块）
fn concentric_rings_section(
    m: &gui_domain::operations::project_goals::MonthlyProgressItem,
    symbol: &str,
    theme: &AppTheme,
    reduce: bool,
) -> impl IntoElement {
    let projected = projected_monthly_rate(m.completion_vs_monthly, m.days_in_month, m.today_day);
    let has_target = m.target_amount > 0.0;
    let ring_items = [
        RingItem {
            label: "截止今日完成率",
            value: m.completion_vs_daily,
            display: format_percent(m.completion_vs_daily),
            caption: if has_target {
                format!(
                    "已完成 {symbol}{} / 应完成 {symbol}{}",
                    format_money(m.achieved_amount),
                    format_money(m.cumulative_daily_target)
                )
            } else {
                "未设置本月目标".to_string()
            },
            note: if has_target {
                "当前完成 ÷ 按日摊派的累计目标".to_string()
            } else {
                "前往「目标管理」设置月度目标".to_string()
            },
            color: theme.chart_primary,
        },
        RingItem {
            label: "实际月度进度",
            value: m.completion_vs_monthly,
            display: format_percent(m.completion_vs_monthly),
            caption: if has_target {
                format!(
                    "已完成 {symbol}{} / 目标 {symbol}{}",
                    format_money(m.achieved_amount),
                    format_money(m.target_amount)
                )
            } else {
                "未设置本月目标".to_string()
            },
            note: if has_target {
                "占整月目标的实际比例".to_string()
            } else {
                "前往「目标管理」设置月度目标".to_string()
            },
            color: theme.chart_secondary,
        },
        RingItem {
            label: "预估月度完成率",
            value: projected,
            display: format_percent(projected),
            caption: if has_target {
                "按当前完成节奏外推至月末".to_string()
            } else {
                "未设置本月目标".to_string()
            },
            note: if has_target && m.today_day > 0 {
                format!("线性预估（第 {} / {} 天）", m.today_day, m.days_in_month)
            } else {
                "前往「目标管理」设置月度目标".to_string()
            },
            color: theme.chart_tertiary,
        },
    ];

    crate::motion::enter_fade_in(
        SharedString::from("project-goals-rings-fade"),
        h_flex()
            .id("project-goals-rings")
            .gap_6()
            .items_center()
            // 左：同心三环（外→内 = 指标 1 → 3）
            .child(concentric_rings(&ring_items, theme, reduce))
            // 右：3 个指标块
            .child(
                h_flex()
                    .flex_1()
                    .gap_5()
                    .items_start()
                    .children(ring_items.iter().map(|item| metric_block(item, theme))),
            ),
        reduce,
    )
}

/// 同心三环（外→内 200/160/120，PieChart donut 叠放）
fn concentric_rings(items: &[RingItem; 3], theme: &AppTheme, reduce: bool) -> impl IntoElement {
    const SIZES: [f32; 3] = [200.0, 160.0, 120.0];
    const STROKE: f32 = 14.0;
    let track = theme.muted_fill;

    div()
        .id("project-goals-concentric")
        .size(px(208.0))
        .relative()
        .flex_shrink_0()
        .children(items.iter().enumerate().map(|(i, item)| {
            let size = SIZES[i];
            let outer = size * 0.4; // gpui-component PieChart 默认外径 = 0.4 × 高度
            let inner = (outer - STROKE).max(1.0);
            let data = vec![
                RingSlice {
                    value: item.value.clamp(0.0, 1.0) as f32,
                    color: item.color,
                },
                RingSlice {
                    value: (1.0 - item.value.clamp(0.0, 1.0)) as f32,
                    color: track,
                },
            ];
            div()
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .size(px(size))
                        .child(
                            PieChart::new(data)
                                .value(|s| s.value)
                                .color(|s| s.color)
                                .inner_radius(inner),
                        ),
                )
        }))
        // 减弱动态：无入场动画（enter_fade_in 由外层控制，这里不再重复）
        .when(reduce, |this| this)
}

/// 环形图切片数据
#[derive(Clone)]
struct RingSlice {
    value: f32,
    color: gpui::Hsla,
}

/// 单个指标块（色点 + 指标名 + 大号百分比 + 主说明 + 次要说明）
struct RingItem {
    label: &'static str,
    value: f64,
    display: String,
    caption: String,
    note: String,
    color: gpui::Hsla,
}

fn metric_block(item: &RingItem, theme: &AppTheme) -> impl IntoElement {
    let over = item.value >= 1.0;
    h_flex()
        .min_w_0()
        .flex_1()
        .items_start()
        .gap_2()
        .child(div().mt_1p5().size_2p5().flex_shrink_0().rounded_full().bg(item.color))
        .child(
            v_flex()
                .min_w_0()
                .flex_1()
                .gap_0p5()
                .child(
                    h_flex()
                        .gap_1()
                        .items_center()
                        .child(
                            div()
                                .text_xs()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text_muted)
                                .truncate()
                                .child(item.label.to_string()),
                        )
                        .when(over, |this| {
                            this.child(
                                div()
                                    .px_1p5()
                                    .py_px()
                                    .rounded_full()
                                    .text_xs()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .bg(theme.success_soft)
                                    .text_color(theme.success)
                                    .child("超额"),
                            )
                        }),
                )
                .child(
                    div()
                        .text_2xl()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(item.color)
                        .child(item.display.clone()),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .truncate()
                        .child(item.caption.clone()),
                )
                .when(!item.note.is_empty(), |this| {
                    this.child(
                        div()
                            .text_xs()
                            .text_color(theme.text_muted.opacity(0.7))
                            .truncate()
                            .child(item.note.clone()),
                    )
                }),
        )
}

/// 明细卡 4 张（年度完成率 / 本月已达成 / 月度目标 / 日目标）
fn detail_cards(
    m: &gui_domain::operations::project_goals::MonthlyProgressItem,
    progress: &ProjectGoalProgressResponse,
    symbol: &str,
    view: &Entity<ProjectGoalsView>,
    theme: &AppTheme,
) -> impl IntoElement {
    let annual = progress.annual_progress.as_ref();
    let view_annual = view.clone();
    let view_monthly = view.clone();
    let view_goals_tab = view.clone();

    // 年度完成率卡
    let annual_card = if let Some(a) = annual {
        v_flex()
            .gap_0p5()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme.text_primary)
                    .child(format_percent(a.completion_rate)),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child(format!(
                        "目标 {symbol}{}",
                        format_money(a.target_amount)
                    )),
            )
            .into_any_element()
    } else {
        h_flex()
            .gap_2()
            .items_center()
            .justify_between()
            .child(
                div()
                    .text_sm()
                    .text_color(theme.text_muted)
                    .child("未设置"),
            )
            .child(
                Button::new("project-goals-set-annual")
                    .outline()
                    .small()
                    .label("设置")
                    .on_click(move |_, _, cx| {
                        view_annual.update(cx, |this, cx| {
                            this.open_create(GoalType::Annual, None, cx)
                        });
                    }),
            )
            .into_any_element()
    };

    let monthly_card = if m.target_amount > 0.0 {
        v_flex()
            .gap_0p5()
            .child(
                div()
                    .text_lg()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme.text_primary)
                    .child(format!("{symbol} {}", format_money(m.target_amount))),
            )
            .child(
                div()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child("整月销售目标金额"),
            )
            .into_any_element()
    } else {
        h_flex()
            .gap_2()
            .items_center()
            .justify_between()
            .child(
                div()
                    .text_sm()
                    .text_color(theme.text_muted)
                    .child("未设置"),
            )
            .child(
                Button::new("project-goals-goto-goals")
                    .outline()
                    .small()
                    .label("去设置")
                    .on_click(move |_, _, cx| {
                        view_monthly.update(cx, |this, cx| {
                            this.select_tab(GoalsTab::Goals, cx);
                        });
                    }),
            )
            .into_any_element()
    };

    v_flex()
        .id("project-goals-detail-cards")
        .gap_2()
        .child(
            h_flex()
                .gap_2()
                .children([
                    detail_card(
                        "年度完成率",
                        "icons/trending-up.svg",
                        theme,
                        annual_card,
                    ),
                    detail_card(
                        "本月已达成",
                        "icons/dollar-sign.svg",
                        theme,
                        v_flex()
                            .gap_0p5()
                            .child(
                                div()
                                    .text_lg()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.text_primary)
                                    .child(format!(
                                        "{symbol} {}",
                                        format_money(m.achieved_amount)
                                    )),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.text_muted)
                                    .child("当月实际销售额（截至今日）"),
                            )
                            .into_any_element(),
                    ),
                ]),
        )
        .child(
            h_flex()
                .gap_2()
                .children([
                    detail_card(
                        "月度目标",
                        "icons/target.svg",
                        theme,
                        monthly_card,
                    ),
                    detail_card(
                        "日目标",
                        "icons/calendar-range.svg",
                        theme,
                        v_flex()
                            .gap_0p5()
                            .child(
                                div()
                                    .text_lg()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.text_primary)
                                    .child(format!(
                                        "{symbol} {}",
                                        format_money(m.daily_target)
                                    )),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.text_muted)
                                    .child(format!(
                                        "第 {} / {} 天 · 目标 ÷ 天数",
                                        m.today_day, m.days_in_month
                                    )),
                            )
                            .into_any_element(),
                    ),
                ]),
        )
        // 「去设置」切换 tab 后仍可返回进度概览——view_goals_tab 仅占位保持闭包完整
        .when(false, |this| this.child(view_goals_tab.clone().into_any_element()))
}

fn detail_card(
    title: &str,
    icon: &'static str,
    theme: &AppTheme,
    body: impl IntoElement,
) -> impl IntoElement {
    v_flex()
        .flex_1()
        .gap_2()
        .p_3()
        .rounded(px(theme.radius))
        .border_1()
        .border_color(theme.separator)
        .child(
            h_flex()
                .gap_1p5()
                .items_center()
                .child(
                    Icon::empty()
                        .path(icon)
                        .with_size(px(13.))
                        .text_color(theme.text_muted),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(title.to_string()),
                ),
        )
        .child(body)
}

// ---------------------------------------------------------------------------
// 写操作模态（新增/编辑 + 删除确认）
// ---------------------------------------------------------------------------

fn render_modal_overlay(
    this: &ProjectGoalsView,
    cx: &mut Context<ProjectGoalsView>,
    theme: &AppTheme,
) -> impl IntoElement {
    let overlay = div()
        .id("project-goals-modal-overlay")
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .bg(gpui::hsla(0., 0., 0., 0.35));

    // 删除确认（最高优先级，独立于目标表单）
    if let Some(goal) = &this.confirm_delete {
        let goal_name = goal.display_name();
        let view_confirm = cx.entity();
        let view_cancel = cx.entity();
        return overlay
            .child(
                v_flex()
                    .id("project-goals-delete-confirm")
                    .w(px(360.))
                    .gap_4()
                    .p_5()
                    .rounded(px(theme.radius_lg))
                    .bg(theme.card_bg)
                    .shadow(vec![theme.card_shadow_box()])
                    .child(
                        div()
                            .text_base()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text_primary)
                            .child(format!("确定删除 {goal_name}？")),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.text_muted)
                            .child("删除后不可恢复，相关进度展示将随之更新。"),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .justify_end()
                            .child(
                                Button::new("project-goals-delete-cancel")
                                    .outline()
                                    .small()
                                    .label("取消")
                                    .on_click(move |_, _, cx| {
                                        view_cancel.update(cx, |this, cx| this.cancel_delete(cx));
                                    }),
                            )
                            .child(
                                Button::new("project-goals-delete-confirm-btn")
                                    .primary()
                                    .danger()
                                    .small()
                                    .label("删除")
                                    .on_click(move |_, _, cx| {
                                        view_confirm.update(cx, |this, cx| {
                                            this.confirm_delete_goal(cx)
                                        });
                                    }),
                            ),
                    ),
            )
            .into_any_element();
    }

    // 新增/编辑目标表单
    let Some(dialog) = &this.goal_dialog else {
        return overlay.into_any_element();
    };
    let title = if dialog.editing.is_some() {
        "编辑目标".to_string()
    } else {
        format!("新增 {}目标", dialog.goal_type.label())
    };
    let period_text = if dialog.goal_type == GoalType::Monthly {
        format!(
            "{} 年 {} 月",
            this.year,
            MONTH_NAMES[(dialog.period_month - 1).clamp(0, 11) as usize]
        )
    } else {
        format!("{} 年", this.year)
    };
    let amount_input = this.amount_input.clone();
    let saving = this.saving;
    let dialog_error = this.dialog_error.clone();
    let view_save = cx.entity();
    let view_cancel = cx.entity();
    let view_month_prev = cx.entity();
    let view_month_next = cx.entity();

    overlay
        .child(
            v_flex()
                .id("project-goals-goal-dialog")
                .w(px(400.))
                .gap_4()
                .p_5()
                .rounded(px(theme.radius_lg))
                .bg(theme.card_bg)
                .shadow(vec![theme.card_shadow_box()])
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_primary)
                        .child(title),
                )
                .child(
                    v_flex()
                        .gap_2()
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text_muted)
                                .child(if dialog.goal_type == GoalType::Monthly {
                                    "目标月份"
                                } else {
                                    "目标年份"
                                }),
                        )
                        .child(
                            h_flex()
                                .gap_2()
                                .items_center()
                                .child(
                                    div()
                                        .flex_1()
                                        .rounded_md()
                                        .px_3()
                                        .py_2()
                                        .text_sm()
                                        .bg(theme.muted_fill.opacity(0.5))
                                        .text_color(theme.text_secondary)
                                        .child(period_text.clone()),
                                )
                                .when(
                                    dialog.goal_type == GoalType::Monthly
                                        && dialog.editing.is_none(),
                                    |this| {
                                        this.child(
                                            h_flex()
                                                .gap_1()
                                                .child(
                                                    Button::new("project-goals-month-prev")
                                                        .outline()
                                                        .small()
                                                        .icon(Icon::new(IconName::ChevronDown))
                                                        .on_click(move |_, _, cx| {
                                                            view_month_prev.update(
                                                                cx,
                                                                |this, cx| {
                                                                    if let Some(d) =
                                                                        &mut this.goal_dialog
                                                                    {
                                                                        d.period_month =
                                                                            ((d.period_month - 2)
                                                                                .rem_euclid(12))
                                                                                + 1;
                                                                        cx.notify();
                                                                    }
                                                                },
                                                            );
                                                        }),
                                                )
                                                .child(
                                                    Button::new("project-goals-month-next")
                                                        .outline()
                                                        .small()
                                                        .icon(Icon::new(IconName::ChevronUp))
                                                        .on_click(move |_, _, cx| {
                                                            view_month_next.update(
                                                                cx,
                                                                |this, cx| {
                                                                    if let Some(d) =
                                                                        &mut this.goal_dialog
                                                                    {
                                                                        d.period_month =
                                                                            (d.period_month
                                                                                % 12)
                                                                                + 1;
                                                                        cx.notify();
                                                                    }
                                                                },
                                                            );
                                                        }),
                                                ),
                                        )
                                    },
                                ),
                        ),
                )
                .child(
                    v_flex()
                        .gap_2()
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text_muted)
                                .child("目标金额（按站点原始货币）"),
                        )
                        .when(amount_input.is_some(), |this| {
                            this.child(
                                div().w_full().child(
                                    Input::new(amount_input.as_ref().expect("已判 Some")),
                                ),
                            )
                        })
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.text_muted)
                                .child("填入该月/年度的销售目标金额（按站点原始货币）"),
                        ),
                )
                .when(dialog_error.is_some(), |this| {
                    let msg = dialog_error.as_ref().cloned().unwrap_or_default();
                    this.child(
                        div()
                            .id("project-goals-dialog-error")
                            .px_3()
                            .py_2()
                            .rounded_md()
                            .text_sm()
                            .bg(theme.danger_soft)
                            .text_color(theme.danger)
                            .child(msg),
                    )
                })
                .child(
                    h_flex()
                        .gap_2()
                        .justify_end()
                        .child(
                            Button::new("project-goals-dialog-cancel")
                                .outline()
                                .small()
                                .label("取消")
                                .on_click(move |_, _, cx| {
                                    view_cancel.update(cx, |this, cx| this.close_dialog(cx));
                                }),
                        )
                        .child(
                            Button::new("project-goals-dialog-save")
                                .primary()
                                .small()
                                .label(if saving { "保存中…" } else { "保存" })
                                .disabled(saving)
                                .on_click(move |_, _, cx| {
                                    view_save.update(cx, |this, cx| this.save_goal(cx));
                                }),
                        ),
                ),
        )
        .into_any_element()
}

// ---------------------------------------------------------------------------
// DataTable 列定义
// ---------------------------------------------------------------------------

/// 进度概览表列（月份 / 目标金额 / 已完成 / 月度完成进度 / 状态 / 运营）
fn progress_columns() -> Vec<ColumnDef<ProgressRow>> {
    vec![
        ColumnDef::text("pg-month", "月份", |r: &ProgressRow, _| {
            let base = SharedString::from(r.item.month_label.clone());
            if r.is_current_month {
                SharedString::from(format!("{}（本月）", base))
            } else {
                base
            }
        })
        .width(110.0),
        ColumnDef::number("pg-target", "目标金额", |r: &ProgressRow| r.item.target_amount, |r: &ProgressRow, _| {
            if r.item.target_amount > 0.0 {
                SharedString::from(format_money(r.item.target_amount))
            } else {
                SharedString::from("—")
            }
        })
        .width(110.0),
        ColumnDef::number("pg-achieved", "已完成", |r: &ProgressRow| r.item.achieved_amount, |r: &ProgressRow, _| {
            SharedString::from(format_money(r.item.achieved_amount))
        })
        .width(110.0),
        ColumnDef::text("pg-progress", "月度完成进度", |r: &ProgressRow, _| {
            if r.item.target_amount > 0.0 {
                SharedString::from(format!(
                    "{}  {}/{}  ",
                    format_percent(r.item.completion_vs_monthly),
                    format_money(r.item.achieved_amount),
                    format_money(r.item.target_amount)
                ))
            } else {
                SharedString::from("未设目标")
            }
        })
        .width(210.0)
        .with_render_element(|r: &ProgressRow, theme| {
            if r.item.target_amount > 0.0 {
                let is_past_incomplete =
                    r.month_status == MonthStatus::Past && r.item.completion_vs_monthly < 1.0;
                v_flex()
                    .gap_1()
                    .w_full()
                    .child(progress_bar(r.item.completion_vs_monthly, is_past_incomplete, theme))
                    .child(
                        h_flex()
                            .justify_between()
                            .gap_2()
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child(format_percent(r.item.completion_vs_monthly))
                            .child(
                                div()
                                    .truncate()
                                    .child(format!(
                                        "{} / {}",
                                        format_money(r.item.achieved_amount),
                                        format_money(r.item.target_amount)
                                    )),
                            ),
                    )
                    .into_any_element()
            } else {
                div()
                    .text_sm()
                    .text_color(theme.text_muted)
                    .child("未设目标")
                    .into_any_element()
            }
        }),
        ColumnDef::text("pg-status", "状态", |r: &ProgressRow, _| {
            SharedString::from(match r.month_status {
                MonthStatus::Current => "进行中",
                MonthStatus::Future => "未开始",
                MonthStatus::Past if r.item.completion_vs_monthly >= 1.0 => "达成",
                MonthStatus::Past => "未达标",
            })
        })
        .width(80.0)
        .with_render_element(|r: &ProgressRow, theme| {
            if r.item.target_amount > 0.0 {
                completion_badge(r.month_status, r.item.completion_vs_monthly, theme)
                    .into_any_element()
            } else {
                div().into_any_element()
            }
        }),
        ColumnDef::text("pg-operators", "运营（包含助理）", |r: &ProgressRow, _| {
            SharedString::from(r.operators.clone())
        })
        .width(130.0),
    ]
}

/// 目标管理表列（月份 / 目标金额 / 已达成 / 月度进度 / 状态 / 操作）
fn goal_columns(view: &Entity<ProjectGoalsView>) -> Vec<ColumnDef<GoalRow>> {
    let view_edit = view.clone();
    let view_del = view.clone();
    let view_add = view.clone();
    vec![
        ColumnDef::text("gg-month", "月份", move |r: &GoalRow, _| {
            if r.is_current_month {
                SharedString::from(format!("{}年{}（本月）", Local::now().year(), MONTH_NAMES[(r.month - 1) as usize]))
            } else {
                SharedString::from(format!("{}年{}", Local::now().year(), MONTH_NAMES[(r.month - 1) as usize]))
            }
        })
        .width(130.0),
        ColumnDef::number("gg-target", "目标金额", |r: &GoalRow| {
            r.goal.as_ref().map(|g| g.target_amount).unwrap_or(0.0)
        }, |r, _| {
            match &r.goal {
                Some(g) => SharedString::from(format_money(g.target_amount)),
                None => SharedString::from("—"),
            }
        })
        .width(110.0),
        ColumnDef::number("gg-achieved", "已达成", |r: &GoalRow| {
            r.progress.as_ref().map(|p| p.achieved_amount).unwrap_or(0.0)
        }, |r, _| {
            SharedString::from(format_money(
                r.progress.as_ref().map(|p| p.achieved_amount).unwrap_or(0.0),
            ))
        })
        .width(110.0),
        ColumnDef::text("gg-progress", "月度进度", |r: &GoalRow, _| {
            match (&r.goal, &r.progress) {
                (Some(g), Some(p)) if g.target_amount > 0.0 => {
                    SharedString::from(format_percent(p.completion_vs_monthly))
                }
                _ => SharedString::from("—"),
            }
        })
        .width(110.0),
        ColumnDef::text("gg-status", "状态", |r: &GoalRow, _| {
            match (&r.goal, &r.progress) {
                (Some(g), Some(p)) if g.target_amount > 0.0 => {
                    SharedString::from(match r.month_status {
                        MonthStatus::Current => "进行中",
                        MonthStatus::Future => "未开始",
                        MonthStatus::Past if p.completion_vs_monthly >= 1.0 => "达成",
                        MonthStatus::Past => "未达标",
                    })
                }
                _ => SharedString::from("—"),
            }
        })
        .width(80.0)
        .with_render_element(|r: &GoalRow, theme| {
            match (&r.goal, &r.progress) {
                (Some(g), Some(p)) if g.target_amount > 0.0 => {
                    completion_badge(r.month_status, p.completion_vs_monthly, theme)
                        .into_any_element()
                }
                _ => div().into_any_element(),
            }
        }),
        ColumnDef::text("gg-actions", "操作", move |r: &GoalRow, _| {
            // 文本占位；真正按钮由 render_element 渲染（避免空列）
            if r.goal.is_some() {
                SharedString::from("编辑/删除")
            } else {
                SharedString::from("新增")
            }
        })
        .width(100.0)
        .with_render_element(move |r: &GoalRow, theme| {
            let goal = r.goal.clone();
            let month = r.month;
            if let Some(goal) = goal {
                let view_e = view_edit.clone();
                let view_d = view_del.clone();
                let goal_e = goal.clone();
                let goal_d = goal;
                h_flex()
                    .gap_1()
                    .child(
                        Button::new(SharedString::from(format!("gg-edit-{month}")))
                            .ghost()
                            .small()
                            .icon(Icon::new(IconName::CircleX).with_size(px(13.)))
                            .label("编辑")
                            .on_click(move |_, _, cx| {
                                view_e.update(cx, |this, cx| {
                                    this.open_edit(goal_e.clone(), cx)
                                });
                            }),
                    )
                    .child(
                        Button::new(SharedString::from(format!("gg-del-{month}")))
                            .ghost()
                            .danger()
                            .small()
                            .icon(Icon::new(IconName::Delete).with_size(px(13.)))
                            .label("删除")
                            .on_click(move |_, _, cx| {
                                view_d.update(cx, |this, cx| {
                                    this.request_delete(goal_d.clone(), cx)
                                });
                            }),
                    )
                    .into_any_element()
            } else {
                let view_a = view_add.clone();
                Button::new(SharedString::from(format!("gg-add-{month}")))
                    .ghost()
                    .small()
                    .icon(Icon::new(IconName::Plus).with_size(px(13.)))
                    .label("新增")
                    .on_click(move |_, _, cx| {
                        view_a.update(cx, |this, cx| {
                            this.open_create(GoalType::Monthly, Some(month), cx)
                        });
                    })
                    .text_color(theme.accent)
                    .into_any_element()
            }
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use gui_domain::operations::project_goals::MonthlyProgressItem;

    /// 测试视图宿主（渲染冒烟用）
    struct Host {
        view: Entity<ProjectGoalsView>,
    }

    impl gpui::Render for Host {
        fn render(
            &mut self,
            _window: &mut gpui::Window,
            _cx: &mut gpui::Context<Self>,
        ) -> impl IntoElement {
            self.view.clone().into_any_element()
        }
    }

    fn create_view(cx: &mut TestAppContext) -> Entity<ProjectGoalsView> {
        cx.update(|cx| {
            gpui_component::init(cx);
            cx.new(|cx| ProjectGoalsView::new(cx, Client::new("http://127.0.0.1:1")))
        })
    }

    fn sample_progress() -> ProjectGoalProgressResponse {
        ProjectGoalProgressResponse {
            project_id: 1,
            country: "US".into(),
            year: 2026,
            currency: "USD".into(),
            monthly_progress: vec![
                MonthlyProgressItem {
                    year: 2026,
                    month: 7,
                    month_label: "2026年7月".into(),
                    target_amount: 45000.0,
                    achieved_amount: 30000.0,
                    completion_rate: 0.6667,
                    days_in_month: 31,
                    today_day: 31,
                    daily_target: 1451.61,
                    cumulative_daily_target: 45000.0,
                    completion_vs_daily: 0.6667,
                    completion_vs_monthly: 0.6667,
                    currency: "USD".into(),
                },
                MonthlyProgressItem {
                    year: 2026,
                    month: 8,
                    month_label: "2026年8月".into(),
                    target_amount: 50000.0,
                    achieved_amount: 20000.0,
                    completion_rate: 0.4,
                    days_in_month: 31,
                    today_day: 15,
                    daily_target: 1612.9,
                    cumulative_daily_target: 24193.5,
                    completion_vs_daily: 0.8267,
                    completion_vs_monthly: 0.4,
                    currency: "USD".into(),
                },
                MonthlyProgressItem {
                    year: 2026,
                    month: 9,
                    month_label: "2026年9月".into(),
                    target_amount: 0.0,
                    achieved_amount: 0.0,
                    completion_rate: 0.0,
                    days_in_month: 30,
                    today_day: 0,
                    daily_target: 0.0,
                    cumulative_daily_target: 0.0,
                    completion_vs_daily: 0.0,
                    completion_vs_monthly: 0.0,
                    currency: "USD".into(),
                },
            ],
            annual_progress: None,
        }
    }

    fn sample_goals() -> Vec<ProjectGoalItem> {
        vec![
            ProjectGoalItem {
                id: 11,
                project_id: 1,
                country: "US".into(),
                goal_type: "monthly".into(),
                metric_type: "sales_amount".into(),
                period_year: 2026,
                period_month: Some(8),
                target_amount: 50000.0,
                currency: "USD".into(),
                created_at: "2026-08-01T00:00:00Z".into(),
                updated_at: "2026-08-01T00:00:00Z".into(),
            },
            ProjectGoalItem {
                id: 12,
                project_id: 1,
                country: "US".into(),
                goal_type: "annual".into(),
                metric_type: "sales_amount".into(),
                period_year: 2026,
                period_month: None,
                target_amount: 600000.0,
                currency: "USD".into(),
                created_at: "2026-08-01T00:00:00Z".into(),
                updated_at: "2026-08-01T00:00:00Z".into(),
            },
        ]
    }

    fn sample_data() -> ProjectGoalsData {
        ProjectGoalsData {
            projects: vec![ManagedProject {
                id: 1,
                name: "测试项目 A".into(),
                brand_name: None,
                store_address: None,
                project_operator: Some("甲".into()),
                assistant_operator: Some("乙".into()),
                commission_basis: None,
                commission_rate: None,
                sort_order: 1,
                is_active: true,
                source_file: None,
                has_context: true,
                project_tier: None,
                vat_enabled: false,
            }],
            progress: sample_progress(),
            goals: sample_goals(),
        }
    }

    // ---------- 纯函数：展示行派生 ----------

    #[test]
    fn build_progress_rows_marks_current_month_and_status() {
        let data = sample_data();
        let rows = build_progress_rows(&data, 2026, 8);
        assert_eq!(rows.len(), 3);
        assert!(!rows[0].is_current_month);
        assert!(rows[1].is_current_month);
        assert_eq!(rows[1].month_status, MonthStatus::Current);
        assert_eq!(rows[0].month_status, MonthStatus::Past);
        assert_eq!(rows[2].month_status, MonthStatus::Future);
        // 运营（包含助理）
        assert_eq!(rows[0].operators, "甲 / 乙");
    }

    #[test]
    fn build_goal_rows_fills_all_12_months_and_merges_goal_progress() {
        let data = sample_data();
        let rows = build_goal_rows(&data, 2026, 2026, 8);
        assert_eq!(rows.len(), 12);
        // 8 月有目标 + 进度
        let aug = &rows[7];
        assert_eq!(aug.month, 8);
        assert!(aug.goal.is_some());
        assert!(aug.progress.is_some());
        assert!(aug.is_current_month);
        // 无目标的月份 goal=None
        assert!(rows[0].goal.is_none());
        assert_eq!(rows[0].month_status, MonthStatus::Past);
        // 未来月份
        assert_eq!(rows[11].month_status, MonthStatus::Future);
    }

    // ---------- 状态机 ----------

    #[test]
    fn state_machine_maps_results() {
        assert!(matches!(
            ProjectGoalsState::from_fetch_result(Ok(sample_data())),
            ProjectGoalsState::Loaded(_)
        ));
        let empty = ProjectGoalsData {
            projects: vec![],
            ..sample_data()
        };
        assert!(matches!(
            ProjectGoalsState::from_fetch_result(Ok(empty)),
            ProjectGoalsState::Empty
        ));
        assert!(matches!(
            ProjectGoalsState::from_fetch_result(Err("500".to_string())),
            ProjectGoalsState::Error(_)
        ));
    }

    // ---------- 视图交互 ----------

    #[gpui::test]
    async fn select_filters_trigger_reload(cx: &mut TestAppContext) {
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                assert_eq!(this.selected_project_id, None);
                assert_eq!(this.country, "US");
                assert_eq!(this.year, Local::now().year());
                assert_eq!(this.latest_request_id, 0);

                this.select_project(Some(1), cx);
                assert_eq!(this.selected_project_id, Some(1));
                assert_eq!(this.latest_request_id, 1);
                this.select_project(Some(1), cx); // no-op
                assert_eq!(this.latest_request_id, 1);

                this.select_country("DE", cx);
                assert_eq!(this.country, "DE");
                assert_eq!(this.latest_request_id, 2);

                this.select_year(2025, cx);
                assert_eq!(this.year, 2025);
                assert_eq!(this.latest_request_id, 3);
            });
        });
    }

    #[gpui::test]
    async fn tab_switch_and_dialog_open_flow(cx: &mut TestAppContext) {
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                assert_eq!(this.active_tab, GoalsTab::Progress);
                this.select_tab(GoalsTab::Goals, cx);
                assert_eq!(this.active_tab, GoalsTab::Goals);

                // 新增月度目标（当前月）
                this.open_create(GoalType::Monthly, None, cx);
                assert!(this.goal_dialog.is_some());
                assert_eq!(
                    this.goal_dialog.as_ref().map(|d| d.goal_type),
                    Some(GoalType::Monthly)
                );
                assert!(this.amount_input.is_none()); // 渲染期懒建

                // 编辑目标（类型/月份来自目标）
                this.goal_dialog = None;
                this.open_edit(sample_goals()[0].clone(), cx);
                assert_eq!(
                    this.goal_dialog.as_ref().and_then(|d| d.editing.as_ref().map(|g| g.id)),
                    Some(11)
                );
                assert_eq!(
                    this.goal_dialog.as_ref().map(|d| d.period_month),
                    Some(8)
                );

                // 删除确认
                this.goal_dialog = None;
                this.request_delete(sample_goals()[0].clone(), cx);
                assert!(this.confirm_delete.is_some());
                this.cancel_delete(cx);
                assert!(this.confirm_delete.is_none());
            });
        });
    }

    #[gpui::test]
    async fn save_goal_rejects_invalid_amount_without_request(cx: &mut TestAppContext) {
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.open_create(GoalType::Monthly, Some(8), cx);
                // 无输入 → 校验失败，对话框保留 + 错误提示
                this.save_goal(cx);
                assert!(this.goal_dialog.is_some());
                assert!(this.dialog_error.is_some());
                assert!(!this.saving);
            });
        });
    }

    #[gpui::test]
    async fn apply_result_auto_selects_first_project(cx: &mut TestAppContext) {
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                // 首次加载（未选项目）：载荷的 progress.project_id 为 0（未解析），
                // 自动选中第一个项目并触发重拉（对齐 frontend useAutoSelectFirstProject）
                let mut data = sample_data();
                data.progress.project_id = 0;
                this.apply_result(1, Ok(data), cx);
                assert_eq!(this.selected_project_id, Some(1));
                assert_eq!(this.latest_request_id, 2);
                assert!(matches!(
                    this.current_state(cx),
                    ProjectGoalsState::Loading
                ));
            });
        });
    }

    #[gpui::test]
    async fn apply_result_keeps_resolved_project_without_reload(cx: &mut TestAppContext) {
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                // 已解析项目 + 载荷 project_id 匹配 → 直接落点，不重拉
                this.selected_project_id = Some(1);
                this.latest_request_id = 1;
                this.apply_result(1, Ok(sample_data()), cx);
                assert_eq!(this.latest_request_id, 1);
                assert!(matches!(
                    this.current_state(cx),
                    ProjectGoalsState::Loaded(_)
                ));
            });
        });
    }

    // ---------- 渲染冒烟 ----------

    #[gpui::test]
    async fn project_goals_loading_state_renders(cx: &mut TestAppContext) {
        let view = create_view(cx);
        cx.update(|cx| cx.new(|_| Host { view: view.clone() }));
        cx.add_window_view(|_window, _cx| Host {
            view: view.clone(),
        });
    }

    #[gpui::test]
    async fn project_goals_error_state_renders(cx: &mut TestAppContext) {
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Err("接口 500".to_string()), cx);
            });
        });
        cx.add_window_view(|_window, _cx| Host {
            view: view.clone(),
        });
    }

    #[gpui::test]
    async fn project_goals_loaded_state_renders(cx: &mut TestAppContext) {
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.selected_project_id = Some(1);
                this.latest_request_id = 1;
                this.apply_result(1, Ok(sample_data()), cx);
            });
        });
        cx.add_window_view(|_window, _cx| Host {
            view: view.clone(),
        });
    }

    #[gpui::test]
    async fn project_goals_renders_in_dark_mode(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let view = cx.update(|cx| {
            cx.new(|cx| ProjectGoalsView::new(cx, Client::new("http://127.0.0.1:1")))
        });
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.selected_project_id = Some(1);
                this.latest_request_id = 1;
                this.apply_result(1, Ok(sample_data()), cx);
            });
        });
        cx.add_window_view(|_window, _cx| Host {
            view: view.clone(),
        });
        cx.update(|cx| assert!(crate::theme::AppTheme::current(cx).is_dark()));
    }

    #[gpui::test]
    async fn project_goals_modal_overlay_renders(cx: &mut TestAppContext) {
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.open_create(GoalType::Monthly, Some(8), cx);
            });
        });
        // 打开对话框后渲染（金额输入在 render 期懒建，需要 window）
        cx.add_window_view(|_window, _cx| Host {
            view: view.clone(),
        });
        cx.read(|app| assert!(view.read(app).goal_dialog.is_some()));
    }
}