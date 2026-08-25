//! 报表中心 → 定时报告视图（P3-5，BLF-705）
//!
//! frontend `app/dashboard/reports/scheduled-reports/` 的 GPUI 等价（只读查看，
//! 不触发生成 / 重发 / 订阅写操作——P3-5 范围边界）：
//!
//! - **订阅管理 tab**：订阅列表（状态 / 频率 / 发送计划 / 国家 / 项目 / 邮箱 /
//!   AI 模型），客户端过滤（频率 + 启用状态），数据源
//!   `GET /scheduled-reports/subscriptions`（+ `/projects/manage` 解析项目名）；
//! - **调度记录 tab**：台账按日分组列表（状态 / 预计时间 / 频率 / 项目 / 国家 /
//!   发送时间），顶部汇总卡（应发 / 成功 / 失败 / 缺失 / 可重发）+ 频率 / 状态
//!   过滤 + 刷新；点击行展开详情（错误信息 / AI 摘要 / 查看最近一次报告截图——
//!   用系统默认浏览器打开 R2 原图，对齐 backend `screenshot_r2_url` 产物约定）。
//!
//! 架构（复用 Phase 1/2/3 基建，对齐 P3-1 daily_analysis 范式）：
//! - **四态状态机**：`Loading / Loaded / Empty / Error`，`latest_request_id`
//!   竞态保护（只有最新请求的响应才落点）；
//! - **tab 懒加载**：对齐 frontend BEL-422——非激活 tab 不拉数，首次激活才
//!   加载；切走不卸载（状态保留，切回不重拉）；
//! - **筛选**：gpui-component `DropdownMenu`（对齐 P3-1 筛选栏范式）；
//! - **台账日期窗口**：固定「近 7 天」（对齐 P3-1 日期范围决策，前端日期选择器
//!   留后续增强），按 `expected_date` 分组（backend 按日分页口径）。
//!
//! 已知差异（有意保留，GPUI 0.2 能力边界 / P3-5 范围）：
//! - 订阅增删改 / 启用停用 / 台账重发 / AI 摘要重新生成等写操作不接入（只读）；
//! - 截图不在窗口内嵌显示（远程 R2 图片加载管线不引入），用
//!   `App::open_url` 调系统默认浏览器查看原图（对齐 GUI-12 站点导航直达范式）；
//! - 台账邮箱筛选 / 日期范围选择器未接入（P3-5 不做，留后续增强）。

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Datelike, Local, NaiveDate, Utc};
use gpui::{
    div, prelude::*, px, AsyncApp, Context, CursorStyle, Entity, FontWeight, MouseButton,
    Render, SharedString, WeakEntity, Window,
};
use gpui_component::{
    button::Button,
    h_flex,
    menu::{DropdownMenu, PopupMenuItem},
    v_flex, Icon, IconName, Sizable,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::scheduled_reports::{LedgerItem, LedgerListResponse, Subscription};

use crate::theme::AppTheme;
use crate::views::dashboard::last_7_days_window;
use crate::widgets::layout::content_guard;
use crate::widgets::pattern_b::{pattern_b_shell, tab_bar, tabs_zone, TabItem};
use crate::widgets::state_views::{self, EmptyIcon, SkeletonBlock};
use crate::widgets::page_header::PageHeader;

/// 本页在侧栏中的 URL（root.rs 据此路由到本视图；与 gui-domain::sidebar 的定时报告条目一致）
pub const SCHEDULED_REPORTS_URL: &str = "/dashboard/reports/scheduled-reports";

/// 台账 tab 的日期窗口：近 7 天（对齐 P3-1 日期范围决策）
const LEDGER_WINDOW_DAYS: u32 = 7;

/// 订阅 tab 的频率过滤（value = 后端 frequency 入参；"all" = 不限）
const SUB_FREQUENCY_FILTERS: [(&str, &str); 4] = [
    ("all", "全部频率"),
    ("daily", "每日"),
    ("weekly", "每周"),
    ("monthly", "每月"),
];

/// 订阅 tab 的启用状态过滤
const SUB_STATUS_FILTERS: [(&str, &str); 3] = [
    ("all", "全部状态"),
    ("enabled", "启用"),
    ("disabled", "已暂停"),
];

/// 台账 tab 的频率过滤（"all" = 不限）
const LEDGER_FREQUENCY_FILTERS: [(&str, &str); 4] = [
    ("all", "全部频率"),
    ("daily", "每日"),
    ("weekly", "每周"),
    ("monthly", "每月"),
];

/// 台账 tab 的状态过滤（value = backend status 取值；"all" = 不限）
const LEDGER_STATUS_FILTERS: [(&str, &str); 4] = [
    ("all", "全部状态"),
    ("sent", "成功"),
    ("failed", "失败"),
    ("missing", "缺失"),
];

/// 周几展示名（0=周一..6=周日，对齐 frontend `WEEKDAY_LABELS`）
pub fn weekday_name(weekday: i64) -> &'static str {
    match weekday.rem_euclid(7) {
        0 => "周一",
        1 => "周二",
        2 => "周三",
        3 => "周四",
        4 => "周五",
        5 => "周六",
        _ => "周日",
    }
}

/// 频率展示名（对齐 frontend `FREQUENCY_LABELS`）
pub fn frequency_label(frequency: &str) -> &'static str {
    match frequency {
        "daily" => "每日",
        "weekly" => "每周",
        "monthly" => "每月",
        _ => "未知",
    }
}

/// 发送计划展示名（对齐 frontend 表格「发送时间」列）：
/// - daily → 「每天 HH:MM」
/// - weekly → 「每周周X HH:MM」（0=周一..6=周日，缺省周一）
/// - monthly → 「每月 N 号 HH:MM」（缺省 2 号）
pub fn schedule_label(sub: &Subscription) -> String {
    let time = format!("{:02}:{:02}", sub.dispatch_hour, sub.dispatch_minute);
    match sub.frequency.as_str() {
        "weekly" => format!(
            "每周{} {}",
            weekday_name(sub.dispatch_weekday.unwrap_or(0)),
            time
        ),
        "monthly" => format!("每月 {} 号 {}", sub.dispatch_day.unwrap_or(2), time),
        _ => format!("每天 {}", time),
    }
}

/// 台账状态展示（对齐 frontend `STATUS_LABELS`）：返回 (标签, 符号)
pub fn status_meta(status: &str) -> (&'static str, &'static str) {
    match status {
        "sent" => ("成功", "✓"),
        "failed" => ("失败", "✗"),
        "missing" => ("缺失", "⚠"),
        _ => ("未知", "?"),
    }
}

/// 订阅 tab 客户端过滤（对齐 frontend `filteredSubscriptions`：
/// 频率 + 启用状态；纯函数，供单测）
pub fn filter_subscriptions(
    subs: &[Subscription],
    frequency: &str,
    status: &str,
) -> Vec<Subscription> {
    subs.iter()
        .filter(|sub| frequency == "all" || sub.frequency == frequency)
        .filter(|sub| {
            status == "all"
                || (status == "enabled" && sub.enabled)
                || (status == "disabled" && !sub.enabled)
        })
        .cloned()
        .collect()
}

/// 项目名解析（对齐 frontend `resolveProjectNames`）：`"*"` → 全部项目；
/// 逗号分隔 ID → 项目名，未知 ID 回退「项目{id}」。
pub fn resolve_project_label(project_ids: &str, projects: &[ManagedProject]) -> String {
    if project_ids.trim() == "*" {
        return "全部项目".to_string();
    }
    let names: Vec<String> = project_ids
        .split(',')
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .map(|id| {
            projects
                .iter()
                .find(|p| p.id.to_string() == id)
                .map(|p| p.name.clone())
                .unwrap_or_else(|| format!("项目{id}"))
        })
        .collect();
    if names.is_empty() {
        "全部项目".to_string()
    } else {
        names.join(", ")
    }
}

/// 台账按 `expected_date` 分组（backend 按日返回；frontend 按日分组 + 降序）。
/// 返回 (日期, 该日条目)，日期按倒序（最新在前）。
pub fn group_ledger_by_day(items: &[LedgerItem]) -> Vec<(&str, Vec<&LedgerItem>)> {
    let mut buckets: HashMap<&str, Vec<&LedgerItem>> = HashMap::new();
    for item in items {
        buckets.entry(item.expected_date.as_str()).or_default().push(item);
    }
    let mut days: Vec<(&str, Vec<&LedgerItem>)> = buckets.into_iter().collect();
    days.sort_by(|a, b| b.0.cmp(a.0));
    days
}

/// UTC 时间 → 本地时区展示（`yyyy-MM-dd HH:mm`；frontend `toLocaleString('zh-CN')` 等价）
pub fn fmt_datetime(dt: DateTime<Utc>) -> String {
    dt.with_timezone(&Local).format("%Y-%m-%d %H:%M").to_string()
}

/// 日期串 → 「周X」展示名（台账按日分组的星期显示；解析失败返回空串）
pub fn date_weekday_label(date: &str) -> String {
    let Ok(d) = NaiveDate::parse_from_str(date, "%Y-%m-%d") else {
        return String::new();
    };
    weekday_name(d.weekday().num_days_from_monday() as i64).to_string()
}

// ---------------------------------------------------------------------------
// tab 与状态机
// ---------------------------------------------------------------------------

/// 两个业务 tab（对齐 frontend layout.tsx：订阅管理 / 调度记录）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportTab {
    Subscriptions,
    Ledger,
}

impl ReportTab {
    #[allow(dead_code)] // TabItem 静态标签接管后保留（契约测试消费）
    pub fn label(self) -> &'static str {
        match self {
            Self::Subscriptions => "订阅管理",
            Self::Ledger => "调度记录",
        }
    }
}

/// 订阅 tab 状态机（四态）
#[derive(Debug, Clone, PartialEq)]
pub enum SubsState {
    Loading,
    Loaded(Vec<Subscription>),
    Empty,
    Error(String),
}

/// 台账 tab 状态机（四态；Loaded 持有完整列表响应）
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum LedgerState {
    Loading,
    Loaded(LedgerListResponse),
    Empty,
    Error(String),
}

impl LedgerState {
    pub fn from_fetch_result(result: Result<LedgerListResponse, String>) -> Self {
        match result {
            Ok(resp) if resp.items.is_empty() => Self::Empty,
            Ok(resp) => Self::Loaded(resp),
            Err(msg) => Self::Error(msg),
        }
    }
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// 定时报告视图（tab 懒加载 + 双状态机 + 竞态保护）
pub struct ScheduledReportsView {
    /// 带会话的 API client
    client: Client,
    /// 当前 tab（初始订阅管理）
    tab: ReportTab,
    /// 订阅 tab 状态机
    subs: Entity<SubsState>,
    /// 订阅 tab 的项目列表（解析项目名；与订阅并行拉取）
    projects: Vec<ManagedProject>,
    /// 台账 tab 状态机
    ledger: Entity<LedgerState>,
    /// 订阅 tab 客户端过滤：频率
    sub_frequency: &'static str,
    /// 订阅 tab 客户端过滤：启用状态
    sub_status: &'static str,
    /// 台账 tab 过滤：频率
    frequency: &'static str,
    /// 台账 tab 过滤：状态
    status_filter: &'static str,
    /// 台账按日分组的展开状态（日期串集合；缺省全部展开）
    expanded_days: HashSet<String>,
    /// 台账选中行（展开详情；点击行切换）
    selected_key: Option<String>,
    /// 请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,
    /// 订阅 tab 是否已触发过首拉（tab 懒加载）
    subs_loaded: bool,
    /// 台账 tab 是否已触发过首拉（tab 懒加载）
    ledger_loaded: bool,
}

impl ScheduledReportsView {
    /// 新建视图：初始 tab 为订阅管理（Loading 待拉数）；root.rs 懒创建后调用
    /// `reload_active_tab` 触发首屏拉取。
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let subs = cx.new(|_| SubsState::Loading);
        let ledger = cx.new(|_| LedgerState::Loading);
        Self {
            client,
            tab: ReportTab::Subscriptions,
            subs,
            projects: Vec::new(),
            ledger,
            sub_frequency: "all",
            sub_status: "all",
            frequency: "all",
            status_filter: "all",
            expanded_days: HashSet::new(),
            selected_key: None,
            latest_request_id: 0,
            subs_loaded: false,
            ledger_loaded: false,
        }
    }

    /// 首屏拉取：加载当前激活 tab 的数据（root.rs 懒创建后调用）
    pub fn reload_active_tab(&mut self, cx: &mut Context<Self>) {
        match self.tab {
            ReportTab::Subscriptions => {
                if !self.subs_loaded {
                    self.reload_subscriptions(cx);
                }
            }
            ReportTab::Ledger => {
                if !self.ledger_loaded {
                    self.reload_ledger(cx);
                }
            }
        }
    }

    /// 切换 tab（懒加载：首次激活才拉数；切走不卸载——状态保留，切回不重拉）
    pub fn select_tab(&mut self, tab: ReportTab, cx: &mut Context<Self>) {
        if tab == self.tab {
            return;
        }
        self.tab = tab;
        self.reload_active_tab(cx);
        cx.notify();
    }

    /// 订阅 tab：切换频率过滤（客户端过滤，不重拉）
    pub fn select_sub_frequency(&mut self, frequency: &'static str, cx: &mut Context<Self>) {
        if frequency == self.sub_frequency {
            return;
        }
        self.sub_frequency = frequency;
        cx.notify();
    }

    /// 订阅 tab：切换启用状态过滤（客户端过滤，不重拉）
    pub fn select_sub_status(&mut self, status: &'static str, cx: &mut Context<Self>) {
        if status == self.sub_status {
            return;
        }
        self.sub_status = status;
        cx.notify();
    }

    /// 台账 tab：切换频率过滤 → 重拉
    pub fn select_ledger_frequency(&mut self, frequency: &'static str, cx: &mut Context<Self>) {
        if frequency == self.frequency {
            return;
        }
        self.frequency = frequency;
        self.reload_ledger(cx);
    }

    /// 台账 tab：切换状态过滤 → 重拉
    pub fn select_ledger_status(&mut self, status: &'static str, cx: &mut Context<Self>) {
        if status == self.status_filter {
            return;
        }
        self.status_filter = status;
        self.reload_ledger(cx);
    }

    /// 台账按日分组：展开 / 收起某一天
    pub fn toggle_day(&mut self, date: String, cx: &mut Context<Self>) {
        if self.expanded_days.contains(&date) {
            self.expanded_days.remove(&date);
        } else {
            self.expanded_days.insert(date);
        }
        cx.notify();
    }

    /// 台账行：选中（展开详情） / 再次点击取消
    pub fn toggle_ledger_item(&mut self, ledger_key: String, cx: &mut Context<Self>) {
        if self.selected_key.as_deref() == Some(ledger_key.as_str()) {
            self.selected_key = None;
        } else {
            self.selected_key = Some(ledger_key);
        }
        cx.notify();
    }

    /// 重新拉取订阅（首拉 / 刷新 / 错误重试共用入口）
    pub fn reload_subscriptions(&mut self, cx: &mut Context<Self>) {
        self.subs_loaded = true;
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        self.subs.update(cx, |state, cx| {
            *state = SubsState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(load_subscriptions(&client))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_subs_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 重新拉取台账（过滤变化 / 刷新 / 错误重试共用入口）
    pub fn reload_ledger(&mut self, cx: &mut Context<Self>) {
        self.ledger_loaded = true;
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let frequency = self.frequency;
        let status_filter = self.status_filter;
        self.ledger.update(cx, |state, cx| {
            *state = LedgerState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(load_ledger(&client, frequency, status_filter))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_ledger_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 应用订阅拉取结果（竞态保护；Loaded 落点前记录项目列表）
    fn apply_subs_result(
        &mut self,
        request_id: u64,
        result: Result<(Vec<Subscription>, Vec<ManagedProject>), String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok((_, projects)) = &result {
            self.projects = projects.clone();
        }
        let state = match result {
            Ok((items, _)) if items.is_empty() => SubsState::Empty,
            Ok((items, _)) => SubsState::Loaded(items),
            Err(msg) => SubsState::Error(msg),
        };
        self.subs.update(cx, |cur, cx| {
            *cur = state;
            cx.notify();
        });
    }

    /// 应用台账拉取结果（竞态保护）
    fn apply_ledger_result(
        &mut self,
        request_id: u64,
        result: Result<LedgerListResponse, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        let state = LedgerState::from_fetch_result(result);
        self.ledger.update(cx, |cur, cx| {
            *cur = state;
            cx.notify();
        });
    }
}

/// 拉取订阅 + 项目列表（并行；项目列表失败不阻塞订阅展示，回退空列表）。
///
/// 对齐 frontend `fetchSubscriptions`（`Promise.all` 等价）：
/// 订阅失败 → Err；项目失败 → 空项目（项目名回退「项目{id}」）。
async fn load_subscriptions(
    client: &Client,
) -> Result<(Vec<Subscription>, Vec<ManagedProject>), String> {
    let (subs, projects) = tokio::join!(
        client.list_subscriptions(),
        client.list_managed_projects(),
    );
    let subs = subs.map_err(|e| e.user_message())?;
    let projects = projects.unwrap_or_default();
    Ok((subs.items, projects))
}

/// 拉取台账（近 7 天窗口 + 当前过滤）。
///
/// 对齐 frontend `loadLedger`：`start_date` / `end_date` 必填（近 7 天），
/// `frequency` / `status_filter` 传当前过滤值，`limit` 按时间范围天数传
/// （backend 解释为「最近多少天」）。
async fn load_ledger(
    client: &Client,
    frequency: &str,
    status_filter: &str,
) -> Result<LedgerListResponse, String> {
    let today = chrono::Local::now().date_naive();
    let (from, to) = last_7_days_window(today);
    client
        .list_ledger(from, to, frequency, status_filter, None, LEDGER_WINDOW_DAYS as i64)
        .await
        .map_err(|e| e.user_message())
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for ScheduledReportsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let tab = self.tab;
        let view = cx.entity();

        // BLF-803 套版：pattern_b_shell 骨架——Tab 条进工具栏行（下划线式
        // 高密度 Tab 替换原胶囊组），双面板占满剩余高
        let tab_items = [
            TabItem::new("subscriptions", "订阅管理"),
            TabItem::new("ledger", "调度台账"),
        ];
        let active_ix = match tab {
            ReportTab::Ledger => 1,
            _ => 0,
        };
        let strip = tab_bar(&view, &theme, "scheduled-reports", &tab_items, active_ix, |this, ix, cx| {
            this.select_tab(match ix {
                1 => ReportTab::Ledger,
                _ => ReportTab::Subscriptions,
            }, cx);
        });
        let body: gpui::AnyElement = match tab {
            ReportTab::Subscriptions => {
                render_subs_panel(self, cx, &view, &theme).into_any_element()
            }
            ReportTab::Ledger => {
                render_ledger_panel(self, cx, &view, &theme).into_any_element()
            }
        };
        let tabs = tabs_zone(strip, body);
        pattern_b_shell(
            &theme,
            "scheduled-reports",
            PageHeader::new("定时报告").subtitle("订阅管理 · 调度台账（只读查看）"),
            div(),
            0.0,
            div(),
            div(),
            tabs,
        )
    }
}



/// 订阅管理 tab 面板（四态；经 `&self` 读状态，不用 entity 自读——
/// render 期间 entity 已被更新锁占用，`view.read(cx)` 会 panic）
fn render_subs_panel(
    this: &ScheduledReportsView,
    cx: &mut Context<ScheduledReportsView>,
    view: &Entity<ScheduledReportsView>,
    theme: &AppTheme,
) -> impl IntoElement {
    let state = this.subs.read(cx).clone();
    let projects = this.projects.clone();
    let sub_frequency = this.sub_frequency;
    let sub_status = this.sub_status;
    let reduce = crate::motion::reduce_motion(cx);
    match state {
        SubsState::Loading => render_loading(theme).into_any_element(),
        SubsState::Error(msg) => render_error(
            view,
            theme,
            "订阅列表加载失败",
            &msg,
            ReportTab::Subscriptions,
        )
        .into_any_element(),
        SubsState::Empty => render_subs_empty(view, theme).into_any_element(),
        SubsState::Loaded(subs) => {
            let filtered = filter_subscriptions(&subs, sub_frequency, sub_status);
            render_subs_loaded(
                view,
                theme,
                &filtered,
                &projects,
                sub_frequency,
                sub_status,
                subs.len(),
                reduce,
            )
            .into_any_element()
        }
    }
}

/// 调度记录 tab 面板（四态）
fn render_ledger_panel(
    this: &ScheduledReportsView,
    cx: &mut Context<ScheduledReportsView>,
    view: &Entity<ScheduledReportsView>,
    theme: &AppTheme,
) -> impl IntoElement {
    let state = this.ledger.read(cx).clone();
    let frequency = this.frequency;
    let status_filter = this.status_filter;
    let expanded = this.expanded_days.clone();
    let selected = this.selected_key.clone();
    let reduce = crate::motion::reduce_motion(cx);
    match state {
        LedgerState::Loading => render_loading(theme).into_any_element(),
        LedgerState::Error(msg) => render_error(
            view,
            theme,
            "调度记录加载失败",
            &msg,
            ReportTab::Ledger,
        )
        .into_any_element(),
        LedgerState::Empty => render_ledger_empty(view, theme).into_any_element(),
        LedgerState::Loaded(resp) => render_ledger_loaded(
            view,
            theme,
            &resp,
            frequency,
            status_filter,
            &expanded,
            selected.as_deref(),
            reduce,
        )
        .into_any_element(),
    }
}

/// Loading：顶部骨架（P4-6：`state_views::skeleton_loading` 声明式组合）
fn render_loading(theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("scheduled-reports-loading")
        .w_full()
        .gap_3()
        .child(state_views::skeleton_loading(
            theme,
            &[SkeletonBlock::Table(48.0), SkeletonBlock::Table(160.0)],
        ))
}

/// Error：卡片内 Alert + 重试按钮（State 0 公共组件 `state_views::error_state`，
/// 重试按 tab 分别回连 reload_subscriptions / reload_ledger）
fn render_error(
    view: &Entity<ScheduledReportsView>,
    theme: &AppTheme,
    title: &str,
    msg: &str,
    kind: ReportTab,
) -> impl IntoElement {
    state_views::error_state(
        view,
        theme,
        "scheduled-reports-error",
        title.to_string(),
        msg.to_string(),
        move |this, cx| match kind {
            ReportTab::Subscriptions => this.reload_subscriptions(cx),
            ReportTab::Ledger => this.reload_ledger(cx),
        },
    )
}

/// 订阅空态：Icon + 文案 + 刷新（State 0 公共组件 `empty_state_with_action`）
fn render_subs_empty(
    view: &Entity<ScheduledReportsView>,
    theme: &AppTheme,
) -> impl IntoElement {
    state_views::empty_state_with_action(
        view,
        theme,
        "scheduled-reports-subs-empty",
        EmptyIcon::Name(IconName::Inbox),
        "暂无订阅配置",
        "刷新",
        |this, cx| this.reload_subscriptions(cx),
    )
}

/// 台账空态：Icon + 文案 + 说明 + 刷新（State 0 公共组件
/// `empty_state_with_action_desc`，保留「调整筛选条件」说明行）
fn render_ledger_empty(
    view: &Entity<ScheduledReportsView>,
    theme: &AppTheme,
) -> impl IntoElement {
    state_views::empty_state_with_action_desc(
        view,
        theme,
        "scheduled-reports-ledger-empty",
        EmptyIcon::Name(IconName::Inbox),
        "暂无台账记录",
        Some("调整筛选条件或点击「刷新」"),
        "刷新",
        |this, cx| this.reload_ledger(cx),
    )
}

// ---------------------------------------------------------------------------
// 订阅管理 tab（Loaded）
// ---------------------------------------------------------------------------

/// 订阅列表：过滤栏 + 表格（状态 / 项目 / 国家 / 频率 / 发送时间 / 邮箱 / AI 模型）
#[allow(clippy::too_many_arguments)]
fn render_subs_loaded(
    view: &Entity<ScheduledReportsView>,
    theme: &AppTheme,
    filtered: &[Subscription],
    projects: &[ManagedProject],
    sub_frequency: &'static str,
    sub_status: &'static str,
    total: usize,
    reduce: bool,
) -> impl IntoElement {
    // P4-2：列表 enter 轻量 fade-in（一次性；减弱动态时瞬时）
    crate::motion::enter_fade_in(
        gpui::SharedString::from("scheduled-reports-subs-loaded-fade"),
        v_flex()
            .id("scheduled-reports-subs-loaded")
            .w_full()
            .gap_3()
            // 过滤栏受宽窗上限；订阅表保留全宽
            .child(content_guard().child(render_subs_filter_bar(view, sub_frequency, sub_status)))
            .child(render_subs_table(filtered, projects, theme))
            .child(
                div()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child(if total > filtered.len() {
                        format!("已显示 {} 条（共 {} 条）", filtered.len(), total)
                    } else {
                        format!("共 {} 条订阅", total)
                    }),
            ),
        reduce,
    )
}

/// 订阅过滤栏：频率 + 启用状态（DropdownMenu）+ 刷新
fn render_subs_filter_bar(
    view: &Entity<ScheduledReportsView>,
    frequency: &'static str,
    status: &'static str,
) -> impl IntoElement {
    let frequency_label = SUB_FREQUENCY_FILTERS
        .iter()
        .find(|(value, _)| *value == frequency)
        .map(|(_, label)| *label)
        .unwrap_or("全部频率");
    let status_label = SUB_STATUS_FILTERS
        .iter()
        .find(|(value, _)| *value == status)
        .map(|(_, label)| *label)
        .unwrap_or("全部状态");
    let view_for_frequency = view.clone();
    let view_for_status = view.clone();
    let view_for_refresh = view.clone();

    h_flex()
        .id("scheduled-reports-subs-filters")
        .gap_3()
        .items_center()
        .flex_wrap()
        .child(
            Button::new("scheduled-reports-subs-frequency-filter")
                .outline()
                .small()
                .label(frequency_label)
                .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                .dropdown_menu_with_anchor(
                    gpui::Corner::BottomLeft,
                    move |menu, _window, _cx| {
                        let mut menu = menu;
                        for (value, label) in SUB_FREQUENCY_FILTERS {
                            let checked = frequency == value;
                            let view = view_for_frequency.clone();
                            menu = menu.item(
                                PopupMenuItem::new(label).checked(checked).on_click(
                                    move |_, _window, cx| {
                                        view.update(cx, |this, cx| {
                                            this.select_sub_frequency(value, cx)
                                        });
                                    },
                                ),
                            );
                        }
                        menu
                    },
                ),
        )
        .child(
            Button::new("scheduled-reports-subs-status-filter")
                .outline()
                .small()
                .label(status_label)
                .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                .dropdown_menu_with_anchor(
                    gpui::Corner::BottomLeft,
                    move |menu, _window, _cx| {
                        let mut menu = menu;
                        for (value, label) in SUB_STATUS_FILTERS {
                            let checked = status == value;
                            let view = view_for_status.clone();
                            menu = menu.item(
                                PopupMenuItem::new(label).checked(checked).on_click(
                                    move |_, _window, cx| {
                                        view.update(cx, |this, cx| {
                                            this.select_sub_status(value, cx)
                                        });
                                    },
                                ),
                            );
                        }
                        menu
                    },
                ),
        )
        .child(div().flex_1())
        .child(
            Button::new("scheduled-reports-subs-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_, _window, cx| {
                    view_for_refresh.update(cx, |this, cx| this.reload_subscriptions(cx));
                }),
        )
}

/// 订阅表格（div 自绘：固定列宽 + 滚动容器；对齐 frontend 表格列）
fn render_subs_table(
    subs: &[Subscription],
    projects: &[ManagedProject],
    theme: &AppTheme,
) -> impl IntoElement {
    v_flex()
        .id("scheduled-reports-subs-table")
        .w_full()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(
            div()
                .id("scheduled-reports-subs-table-scroll")
                .overflow_x_scroll()
                .child(
                    v_flex()
                        .min_w(px(760.))
                        .child(subs_table_header(theme))
                        .children(
                            subs.iter()
                                .enumerate()
                                .map(|(ix, sub)| {
                                    subs_table_row(sub, projects, ix % 2 == 1, theme)
                                }),
                        )
                        .when(subs.is_empty(), |this| {
                            this.child(
                                div()
                                    .px_4()
                                    .py_8()
                                    .text_center()
                                    .text_sm()
                                    .text_color(theme.text_muted)
                                    .child("没有符合筛选条件的订阅"),
                            )
                        }),
                ),
        )
}

fn subs_table_header(theme: &AppTheme) -> impl IntoElement {
    h_flex()
        .id("scheduled-reports-subs-table-header")
        .px_4()
        .py_2()
        .gap_3()
        .border_b_1()
        .border_color(theme.separator)
        .text_xs()
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.text_muted)
        .child(div().w_16().child("状态"))
        .child(div().w(px(140.)).child("项目"))
        .child(div().w(px(72.)).child("国家"))
        .child(div().w(px(56.)).child("频率"))
        .child(div().w(px(150.)).child("发送时间"))
        .child(div().flex_1().child("邮箱"))
        .child(div().w(px(130.)).child("AI 模型"))
}

fn subs_table_row(
    sub: &Subscription,
    projects: &[ManagedProject],
    tinted: bool,
    theme: &AppTheme,
) -> impl IntoElement {
    let bg = if tinted {
        theme.muted_fill.opacity(0.5)
    } else {
        theme.card_bg
    };
    let project_label = resolve_project_label(&sub.project_ids, projects);
    let email = sub.email.clone().unwrap_or_else(|| "—".to_string());
    let model = sub
        .ai_model
        .clone()
        .unwrap_or_else(|| "默认".to_string());
    h_flex()
        .id(SharedString::from(format!("scheduled-reports-subs-row-{}", sub.id)))
        .px_4()
        .py_1p5()
        .gap_3()
        .bg(bg)
        .text_sm()
        .text_color(theme.text_secondary)
        .child(div().w_16().child(enabled_badge(sub.enabled, theme)))
        .child(
            div()
                .w(px(140.))
                .text_color(theme.text_primary)
                .child(project_label),
        )
        .child(div().w(px(72.)).child(sub.country.clone()))
        .child(div().w(px(56.)).child(frequency_label(&sub.frequency)))
        .child(div().w(px(150.)).child(schedule_label(sub)))
        .child(div().flex_1().child(email))
        .child(div().w(px(130.)).child(model))
}

/// 启用状态徽标（启用 → 成功色；停用 → 中性灰）
fn enabled_badge(enabled: bool, theme: &AppTheme) -> impl IntoElement {
    let (label, color) = if enabled {
        ("启用", theme.success)
    } else {
        ("已暂停", theme.text_muted)
    };
    h_flex()
        .id(SharedString::from(if enabled {
            "scheduled-reports-enabled"
        } else {
            "scheduled-reports-disabled"
        }))
        .items_center()
        .px_1p5()
        .py_0p5()
        .rounded(px(theme.radius))
        .bg(color.opacity(0.12))
        .text_xs()
        .text_color(color)
        .child(label)
}

// ---------------------------------------------------------------------------
// 调度记录 tab（Loaded）
// ---------------------------------------------------------------------------

/// 台账：过滤栏 + 汇总卡 + 按日分组列表（行点击展开详情 / 查看截图）
#[allow(clippy::too_many_arguments)]
fn render_ledger_loaded(
    view: &Entity<ScheduledReportsView>,
    theme: &AppTheme,
    resp: &LedgerListResponse,
    frequency: &'static str,
    status_filter: &'static str,
    expanded: &HashSet<String>,
    selected: Option<&str>,
    reduce: bool,
) -> impl IntoElement {
    let days = group_ledger_by_day(&resp.items);
    // P4-2：台账列表 enter 轻量 fade-in（一次性；减弱动态时瞬时）
    crate::motion::enter_fade_in(
        gpui::SharedString::from("scheduled-reports-ledger-loaded-fade"),
        v_flex()
            .id("scheduled-reports-ledger-loaded")
            .w_full()
            .gap_3()
            // 过滤栏 + 汇总卡受宽窗上限；台账列表保留全宽
            .child(content_guard().child(render_ledger_filter_bar(view, theme, frequency, status_filter)))
            .child(content_guard().child(render_ledger_summary(&resp.summary, theme)))
            .when(resp.total as usize > resp.items.len(), |this| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(theme.warning)
                        .child(format!(
                            "当前范围数据量较大，仅显示最新 {} 条（共 {} 条）。请调整筛选条件查看更早记录。",
                            resp.items.len(),
                            resp.total
                        )),
                )
            })
            .child(render_ledger_days(view, theme, &days, expanded, selected)),
        reduce,
    )
}

/// 台账过滤栏：频率 + 状态（DropdownMenu）+ 刷新
fn render_ledger_filter_bar(
    view: &Entity<ScheduledReportsView>,
    theme: &AppTheme,
    frequency: &'static str,
    status: &'static str,
) -> impl IntoElement {
    let frequency_label = LEDGER_FREQUENCY_FILTERS
        .iter()
        .find(|(value, _)| *value == frequency)
        .map(|(_, label)| *label)
        .unwrap_or("全部频率");
    let status_label = LEDGER_STATUS_FILTERS
        .iter()
        .find(|(value, _)| *value == status)
        .map(|(_, label)| *label)
        .unwrap_or("全部状态");
    let view_for_frequency = view.clone();
    let view_for_status = view.clone();
    let view_for_refresh = view.clone();

    h_flex()
        .id("scheduled-reports-ledger-filters")
        .gap_3()
        .items_center()
        .flex_wrap()
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.text_muted)
                        .child("频率"),
                )
                .child(
                    Button::new("scheduled-reports-ledger-frequency-filter")
                        .outline()
                        .small()
                        .label(frequency_label)
                        .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                        .dropdown_menu_with_anchor(
                            gpui::Corner::BottomLeft,
                            move |menu, _window, _cx| {
                                let mut menu = menu;
                                for (value, label) in LEDGER_FREQUENCY_FILTERS {
                                    let checked = frequency == value;
                                    let view = view_for_frequency.clone();
                                    menu = menu.item(
                                        PopupMenuItem::new(label).checked(checked).on_click(
                                            move |_, _window, cx| {
                                                view.update(cx, |this, cx| {
                                                    this.select_ledger_frequency(value, cx)
                                                });
                                            },
                                        ),
                                    );
                                }
                                menu
                            },
                        ),
                ),
        )
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.text_muted)
                        .child("状态"),
                )
                .child(
                    Button::new("scheduled-reports-ledger-status-filter")
                        .outline()
                        .small()
                        .label(status_label)
                        .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                        .dropdown_menu_with_anchor(
                            gpui::Corner::BottomLeft,
                            move |menu, _window, _cx| {
                                let mut menu = menu;
                                for (value, label) in LEDGER_STATUS_FILTERS {
                                    let checked = status == value;
                                    let view = view_for_status.clone();
                                    menu = menu.item(
                                        PopupMenuItem::new(label).checked(checked).on_click(
                                            move |_, _window, cx| {
                                                view.update(cx, |this, cx| {
                                                    this.select_ledger_status(value, cx)
                                                });
                                            },
                                        ),
                                    );
                                }
                                menu
                            },
                        ),
                ),
        )
        .child(div().flex_1())
        .child(
            Button::new("scheduled-reports-ledger-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_, _window, cx| {
                    view_for_refresh.update(cx, |this, cx| this.reload_ledger(cx));
                }),
        )
}

/// 台账汇总卡（应发 / 成功 / 失败 / 缺失 / 可重发；对齐 frontend LedgerSummaryCards）
fn render_ledger_summary(
    summary: &gui_domain::scheduled_reports::LedgerSummary,
    theme: &AppTheme,
) -> impl IntoElement {
    h_flex()
        .id("scheduled-reports-ledger-summary")
        .w_full()
        .gap_3()
        .child(summary_card("应发", summary.expected, theme.accent, theme))
        .child(summary_card("成功", summary.sent, theme.success, theme))
        .child(summary_card("失败", summary.failed, theme.danger, theme))
        .child(summary_card("缺失", summary.missing, theme.warning, theme))
        .child(summary_card("可重发", summary.resendable, theme.text_secondary, theme))
}

/// 单张汇总卡
fn summary_card(label: &str, value: i64, color: gpui::Hsla, theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id(SharedString::from(format!("scheduled-reports-summary-{label}")))
        .flex_1()
        .items_center()
        .gap_1()
        .px_3()
        .py_2p5()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(
            div()
                .text_xl()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(color)
                .child(value.to_string()),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .child(label.to_string()),
        )
}

/// 台账按日分组列表（日期头可展开 / 收起；行点击展开详情）
fn render_ledger_days<'a>(
    view: &Entity<ScheduledReportsView>,
    theme: &AppTheme,
    days: &[(&'a str, Vec<&'a LedgerItem>)],
    expanded: &HashSet<String>,
    selected: Option<&str>,
) -> impl IntoElement {
    v_flex()
        .id("scheduled-reports-ledger-days")
        .w_full()
        .gap_2()
        .children(days.iter().map(|(date, items)| {
            render_ledger_day(view, theme, date, items, expanded.contains(*date), selected)
        }))
}

/// 单日分组：日期头（日期 + 周几 + 条数 + 展开箭头）+ 行列表
fn render_ledger_day<'a>(
    view: &Entity<ScheduledReportsView>,
    theme: &AppTheme,
    date: &'a str,
    items: &[&'a LedgerItem],
    is_expanded: bool,
    selected: Option<&str>,
) -> impl IntoElement {
    let view_for_toggle = view.clone();
    let date_owned = date.to_string();
    let weekday = date_weekday_label(date);

    v_flex()
        .id(SharedString::from(format!("scheduled-reports-day-{date}")))
        .w_full()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(
            h_flex()
                .id(SharedString::from(format!("scheduled-reports-day-header-{date}")))
                .px_4()
                .py_2()
                .gap_2()
                .items_center()
                .cursor(CursorStyle::PointingHand)
                .hover(|this| this.bg(theme.muted_fill.opacity(0.5)))
                .on_mouse_up(
                    MouseButton::Left,
                    move |_, _window, cx| {
                        view_for_toggle.update(cx, |this, cx| {
                            this.toggle_day(date_owned.clone(), cx)
                        });
                    },
                )
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_primary)
                        .child(date.to_string()),
                )
                .when(!weekday.is_empty(), |this| {
                    this.child(
                        div()
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child(weekday),
                    )
                })
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(format!("{} 条", items.len())),
                )
                .child(div().flex_1())
                .child(
                    Icon::new(if is_expanded {
                        IconName::ChevronUp
                    } else {
                        IconName::ChevronDown
                    })
                    .with_size(px(14.))
                    .text_color(theme.text_muted),
                ),
        )
        .when(is_expanded, |this| {
            this.child(
                div()
                    .border_t_1()
                    .border_color(theme.separator)
                    .children(
                        items
                            .iter()
                            .map(|item| render_ledger_row(view, theme, item, selected)),
                    ),
            )
        })
}

/// 台账行：预计时间 / 项目 / 频率徽标 / 状态徽标 / 发送时间；点击展开详情
fn render_ledger_row(
    view: &Entity<ScheduledReportsView>,
    theme: &AppTheme,
    item: &LedgerItem,
    selected: Option<&str>,
) -> impl IntoElement {
    let is_selected = selected == Some(item.ledger_key.as_str());
    let project_label = if item.project_names.is_empty() {
        resolve_project_label(&item.project_ids, &[])
    } else {
        item.project_names.join(", ")
    };
    let expected_at = fmt_datetime(item.expected_at);
    let sent_at = item
        .sent_at
        .map(fmt_datetime)
        .unwrap_or_else(|| "—".to_string());
    let (_, mark) = status_meta(&item.status);
    let status_color = status_color(&item.status, theme);
    let view_for_row = view.clone();
    let key = item.ledger_key.clone();

    v_flex()
        .id(SharedString::from(format!(
            "scheduled-reports-row-{}",
            item.ledger_key
        )))
        .border_b_1()
        .border_color(theme.separator)
        .child(
            h_flex()
                .px_4()
                .py_1p5()
                .gap_3()
                .items_center()
                .text_sm()
                .text_color(theme.text_secondary)
                .cursor(CursorStyle::PointingHand)
                .hover(|this| this.bg(theme.muted_fill.opacity(0.5)))
                .on_mouse_up(
                    MouseButton::Left,
                    move |_, _window, cx| {
                        view_for_row.update(cx, |this, cx| {
                            this.toggle_ledger_item(key.clone(), cx)
                        });
                    },
                )
                .child(
                    h_flex()
                        .w(px(150.))
                        .gap_1p5()
                        .items_center()
                        .child(
                            div()
                                .text_color(theme.text_primary)
                                .child(expected_at),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(status_color)
                                .child(mark),
                        ),
                )
                .child(
                    div()
                        .w(px(180.))
                        .text_color(theme.text_primary)
                        .child(project_label),
                )
                .child(
                    div()
                        .w(px(56.))
                        .text_color(theme.text_muted)
                        .child(frequency_label(&item.frequency)),
                )
                .child(div().w(px(72.)).child(item.country.clone()))
                .child(
                    div()
                        .flex_1()
                        .child(if item.status == "failed" {
                            item.error_message
                                .clone()
                                .unwrap_or_else(|| "发送失败".to_string())
                        } else {
                            format!("发送于 {sent_at}")
                        }),
                )
                .child(status_badge(&item.status, theme)),
        )
        .when(is_selected, |this| {
            this.child(render_ledger_detail(theme, item))
        })
}

/// 台账行状态徽标（成功 → 成功色；失败 → 危险色；缺失 → 警告色）
fn status_badge(status: &str, theme: &AppTheme) -> impl IntoElement {
    let (label, mark) = status_meta(status);
    let color = status_color(status, theme);
    h_flex()
        .id(SharedString::from(format!("scheduled-reports-status-{status}")))
        .items_center()
        .gap_1()
        .px_1p5()
        .py_0p5()
        .rounded(px(theme.radius))
        .bg(color.opacity(0.12))
        .text_xs()
        .text_color(color)
        .child(div().child(mark.to_string()))
        .child(div().child(label.to_string()))
}

/// 状态色（sent → success；failed → danger；missing → warning）
fn status_color(status: &str, theme: &AppTheme) -> gpui::Hsla {
    match status {
        "sent" => theme.success,
        "failed" => theme.danger,
        "missing" => theme.warning,
        _ => theme.text_muted,
    }
}

/// 台账行详情（点击行展开）：详情元信息 + 错误信息 + AI 摘要 + 查看截图
fn render_ledger_detail(theme: &AppTheme, item: &LedgerItem) -> impl IntoElement {
    let expected_at = fmt_datetime(item.expected_at);
    let sent_at = item
        .sent_at
        .map(fmt_datetime)
        .unwrap_or_else(|| "—".to_string());
    let project_label = if item.project_names.is_empty() {
        resolve_project_label(&item.project_ids, &[])
    } else {
        item.project_names.join(", ")
    };
    let ai_summary = item.ai_summary.clone();
    let ai_status = item.ai_summary_status.clone();

    v_flex()
        .id(SharedString::from(format!(
            "scheduled-reports-detail-{}",
            item.ledger_key
        )))
        .px_4()
        .py_3()
        .gap_3()
        .bg(theme.muted_fill.opacity(0.4))
        .text_sm()
        .text_color(theme.text_secondary)
        // 元信息网格
        .child(
            v_flex()
                .gap_1p5()
                .child(detail_row("订阅", &item.ledger_key, theme))
                .child(detail_row("项目", &project_label, theme))
                .child(detail_row("国家", &item.country, theme))
                .child(detail_row("频率", frequency_label(&item.frequency), theme))
                .child(detail_row("预计时间", &expected_at, theme))
                .child(detail_row("发送时间", &sent_at, theme))
                .child(detail_row(
                    "邮箱",
                    item.email.as_deref().unwrap_or("—"),
                    theme,
                ))
                .child(detail_row("AI 模型", item.ai_summary_model.as_deref().unwrap_or("—"), theme)),
        )
        // 错误信息（失败 / 缺失时展示）
        .when(!item.error_message.as_deref().unwrap_or("").is_empty(), |this| {
            this.child(
                v_flex()
                    .gap_1()
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.danger)
                            .child("错误信息"),
                    )
                    .child(
                        div()
                            .px_3()
                            .py_2()
                            .rounded(px(theme.radius))
                            .bg(theme.danger_soft)
                            .text_color(theme.danger)
                            .child(item.error_message.clone().unwrap_or_default()),
                    ),
            )
        })
        // AI 摘要
        .child(
            v_flex()
                .gap_1()
                .child(
                    h_flex()
                        .gap_2()
                        .items_center()
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.text_muted)
                                .child("AI 摘要"),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(match ai_status.as_str() {
                                    "generating" => theme.accent,
                                    "failed" => theme.danger,
                                    _ => theme.text_muted,
                                })
                                .child(ai_summary_status_label(&ai_status)),
                        ),
                )
                .child(
                    div()
                        .px_3()
                        .py_2()
                        .rounded(px(theme.radius))
                        .bg(theme.accent_soft)
                        .text_color(theme.text_secondary)
                        .child(ai_summary_text(&ai_status, ai_summary.as_deref())),
                ),
        )
        // 查看截图（系统默认浏览器打开 R2 原图）
        .child(
            h_flex()
                .gap_3()
                .items_center()
                .child(render_screenshot_button(item, theme))
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child("截图在系统默认浏览器中打开（R2 原图）"),
                ),
        )
}

/// 元信息行（label + value）
fn detail_row(label: &str, value: &str, theme: &AppTheme) -> impl IntoElement {
    h_flex()
        .gap_3()
        .items_center()
        .child(
            div()
                .w(px(72.))
                .text_xs()
                .text_color(theme.text_muted)
                .child(label.to_string()),
        )
        .child(div().flex_1().child(value.to_string()))
}

/// AI 摘要状态展示名
fn ai_summary_status_label(status: &str) -> &'static str {
    match status {
        "pending" => "待生成",
        "generating" => "生成中",
        "done" => "已完成",
        "failed" => "生成失败",
        _ => "未知",
    }
}

/// AI 摘要正文（无内容时按状态回退提示）
fn ai_summary_text(status: &str, summary: Option<&str>) -> String {
    match summary {
        Some(text) if !text.trim().is_empty() => text.to_string(),
        _ => match status {
            "generating" => "AI 摘要生成中…".to_string(),
            "failed" => "AI 摘要生成失败".to_string(),
            "pending" => "尚未生成 AI 摘要".to_string(),
            _ => "暂无 AI 摘要".to_string(),
        },
    }
}

/// 查看截图按钮（优先原图，回退缩略图；`App::open_url` 打开系统浏览器）
fn render_screenshot_button(item: &LedgerItem, theme: &AppTheme) -> impl IntoElement {
    let Some(url) = item
        .screenshot_r2_url
        .as_deref()
        .or(item.screenshot_r2_thumb_url.as_deref())
    else {
        // 无截图：不渲染按钮（gpui-component Button 无公开 disabled API，
        // 用中性文案提示，避免伪禁用按钮）
        return h_flex()
            .id(SharedString::from(format!(
                "scheduled-reports-shot-none-{}",
                item.ledger_key
            )))
            .items_center()
            .text_sm()
            .text_color(theme.text_muted)
            .child("无截图")
            .into_any_element();
    };
    let url = url.to_string();
    Button::new(SharedString::from(format!(
        "scheduled-reports-shot-{}",
        item.ledger_key
    )))
    .outline()
    .small()
    .label("查看截图")
    .icon(Icon::new(IconName::ExternalLink).with_size(px(12.)))
    .on_click(move |_, _window, cx| {
        cx.open_url(&url);
    })
    .into_any_element()
}

// ---------------------------------------------------------------------------
// 测试宿主（必须置于 `mod tests` 之前，否则 clippy 报 items_after_test_module）
// ---------------------------------------------------------------------------

/// 测试宿主：包装 Entity 以走完整窗口渲染管线
#[cfg(test)]
struct ScheduledReportsHost {
    view: Entity<ScheduledReportsView>,
}

#[cfg(test)]
impl Render for ScheduledReportsHost {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        self.view.clone().into_any_element()
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use gui_domain::scheduled_reports::LedgerSummary;

    // ---------- 纯函数：展示派生 ----------

    #[test]
    fn frequency_label_matches_frontend() {
        assert_eq!(frequency_label("daily"), "每日");
        assert_eq!(frequency_label("weekly"), "每周");
        assert_eq!(frequency_label("monthly"), "每月");
        assert_eq!(frequency_label("bogus"), "未知");
    }

    #[test]
    fn weekday_name_matches_frontend_weekday_labels() {
        // frontend WEEKDAY_LABELS：0=周一 .. 6=周日
        assert_eq!(weekday_name(0), "周一");
        assert_eq!(weekday_name(6), "周日");
        assert_eq!(weekday_name(-1), "周日"); // rem_euclid 容错
    }

    fn sub(id: i64, frequency: &str, enabled: bool) -> Subscription {
        Subscription {
            id,
            user_id: Some(3),
            email: Some(format!("sub{id}@believeboy.com")),
            project_ids: "1,2".to_string(),
            country: "US".to_string(),
            frequency: frequency.to_string(),
            dispatch_hour: 15,
            dispatch_minute: 0,
            dispatch_weekday: None,
            dispatch_day: None,
            ai_model: None,
            enabled,
            created_at: DateTime::from_timestamp(1_700_000_000, 0).unwrap(),
            updated_at: DateTime::from_timestamp(1_700_000_000, 0).unwrap(),
        }
    }

    #[test]
    fn schedule_label_matches_frontend_send_time_column() {
        let daily = sub(1, "daily", true);
        assert_eq!(schedule_label(&daily), "每天 15:00");

        let mut weekly = sub(2, "weekly", true);
        weekly.dispatch_weekday = Some(0);
        weekly.dispatch_hour = 16;
        weekly.dispatch_minute = 30;
        assert_eq!(schedule_label(&weekly), "每周周一 16:30");

        let mut monthly = sub(3, "monthly", true);
        monthly.dispatch_day = Some(5);
        assert_eq!(schedule_label(&monthly), "每月 5 号 15:00");

        // 缺省回退：weekly 无 weekday → 周一；monthly 无 day → 2 号
        let weekly_no_weekday = sub(4, "weekly", true);
        assert_eq!(schedule_label(&weekly_no_weekday), "每周周一 15:00");
        let monthly_no_day = sub(5, "monthly", true);
        assert_eq!(schedule_label(&monthly_no_day), "每月 2 号 15:00");
    }

    #[test]
    fn status_meta_matches_frontend_status_labels() {
        assert_eq!(status_meta("sent"), ("成功", "✓"));
        assert_eq!(status_meta("failed"), ("失败", "✗"));
        assert_eq!(status_meta("missing"), ("缺失", "⚠"));
    }

    #[test]
    fn filter_subscriptions_matches_frontend_filters() {
        let subs = vec![
            sub(1, "daily", true),
            sub(2, "weekly", true),
            sub(3, "monthly", false),
        ];
        assert_eq!(filter_subscriptions(&subs, "all", "all").len(), 3);
        let weekly = filter_subscriptions(&subs, "weekly", "all");
        assert_eq!(weekly.len(), 1);
        assert_eq!(weekly[0].id, 2);
        let enabled = filter_subscriptions(&subs, "all", "enabled");
        assert_eq!(enabled.len(), 2);
        let disabled = filter_subscriptions(&subs, "all", "disabled");
        assert_eq!(disabled.len(), 1);
        assert_eq!(disabled[0].id, 3);
        // 组合过滤
        let combo = filter_subscriptions(&subs, "monthly", "enabled");
        assert!(combo.is_empty());
    }

    #[test]
    fn resolve_project_label_matches_frontend_resolve_project_names() {
        let projects = vec![ManagedProject {
            id: 1,
            name: "项目 A".to_string(),
            brand_name: None,
            store_address: None,
            project_operator: None,
            assistant_operator: None,
            commission_basis: None,
            commission_rate: None,
            sort_order: 0,
            is_active: true,
            source_file: None,
            has_context: false,
            project_tier: None,
            vat_enabled: false,
        }];
        assert_eq!(resolve_project_label("*", &projects), "全部项目");
        assert_eq!(resolve_project_label("1", &projects), "项目 A");
        assert_eq!(resolve_project_label("1,2", &projects), "项目 A, 项目2");
        assert_eq!(resolve_project_label("", &projects), "全部项目");
        assert_eq!(resolve_project_label(" 1 , 1 ", &projects), "项目 A, 项目 A");
    }

    fn ledger_item(id: i64, date: &str, status: &str) -> LedgerItem {
        LedgerItem {
            id,
            ledger_key: format!("5:{date}"),
            expected_date: date.to_string(),
            expected_at: DateTime::from_timestamp(1_700_000_000, 0).unwrap(),
            frequency: "daily".to_string(),
            subscription_id: 5,
            email: Some("ops@believeboy.com".to_string()),
            project_ids: "1,2".to_string(),
            project_names: vec!["项目 A".to_string(), "项目 B".to_string()],
            country: "US".to_string(),
            status: status.to_string(),
            latest_delivery_log_id: Some(88),
            error_message: None,
            sent_at: Some(DateTime::from_timestamp(1_700_000_100, 0).unwrap()),
            can_resend: false,
            last_checked_at: None,
            screenshot_r2_url: None,
            screenshot_r2_thumb_url: None,
            ai_summary: None,
            ai_summary_status: "pending".to_string(),
            ai_summary_error: None,
            ai_summary_model: None,
            ai_summary_updated_at: None,
        }
    }

    #[test]
    fn group_ledger_by_day_groups_and_sorts_desc() {
        let items = vec![
            ledger_item(1, "2026-08-14", "sent"),
            ledger_item(2, "2026-08-15", "failed"),
            ledger_item(3, "2026-08-15", "sent"),
            ledger_item(4, "2026-08-13", "missing"),
        ];
        let days = group_ledger_by_day(&items);
        // 降序：08-15 → 08-14 → 08-13
        assert_eq!(days.len(), 3);
        assert_eq!(days[0].0, "2026-08-15");
        assert_eq!(days[0].1.len(), 2);
        assert_eq!(days[1].0, "2026-08-14");
        assert_eq!(days[1].1.len(), 1);
        assert_eq!(days[2].0, "2026-08-13");
        assert_eq!(days[2].1[0].status, "missing");
    }

    #[test]
    fn date_weekday_label_parses() {
        assert_eq!(date_weekday_label("2026-08-15"), "周六"); // 2026-08-15 是周六
        assert_eq!(date_weekday_label("2026-08-17"), "周一");
        assert_eq!(date_weekday_label("not-a-date"), "");
    }

    #[test]
    fn ai_summary_text_fallbacks() {
        assert_eq!(ai_summary_text("done", Some("本周销售环比 +12%")), "本周销售环比 +12%");
        assert_eq!(ai_summary_text("generating", None), "AI 摘要生成中…");
        assert_eq!(ai_summary_text("failed", None), "AI 摘要生成失败");
        assert_eq!(ai_summary_text("pending", None), "尚未生成 AI 摘要");
        assert_eq!(ai_summary_text("done", None), "暂无 AI 摘要");
    }

    // ---------- 视图级：状态机 ----------

    fn create_view(cx: &mut gpui::TestAppContext) -> Entity<ScheduledReportsView> {
        cx.new(|cx| ScheduledReportsView::new(cx, Client::new("http://127.0.0.1:1")))
    }

    fn read_subs(
        cx: &gpui::TestAppContext,
        view: &Entity<ScheduledReportsView>,
    ) -> SubsState {
        cx.read(|app| view.read(app).subs.read(app).clone())
    }

    fn read_ledger(
        cx: &gpui::TestAppContext,
        view: &Entity<ScheduledReportsView>,
    ) -> LedgerState {
        cx.read(|app| view.read(app).ledger.read(app).clone())
    }

    fn sample_subscriptions() -> Vec<Subscription> {
        vec![
            sub(1, "daily", true),
            sub(2, "weekly", true),
            sub(3, "monthly", false),
        ]
    }

    fn sample_ledger() -> LedgerListResponse {
        LedgerListResponse {
            items: vec![
                ledger_item(1, "2026-08-15", "sent"),
                ledger_item(2, "2026-08-14", "failed"),
            ],
            total: 2,
            summary: LedgerSummary {
                expected: 14,
                sent: 12,
                failed: 1,
                missing: 1,
                resendable: 2,
            },
        }
    }

    #[gpui::test]
    async fn initial_state_is_loading_and_tab_is_subscriptions(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        assert_eq!(read_subs(cx, &view), SubsState::Loading);
        assert_eq!(read_ledger(cx, &view), LedgerState::Loading);
        assert_eq!(cx.read(|app| view.read(app).tab), ReportTab::Subscriptions);
        assert!(!cx.read(|app| view.read(app).subs_loaded));
        assert!(!cx.read(|app| view.read(app).ledger_loaded));
    }

    #[gpui::test]
    async fn apply_subs_result_transitions(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);

        // Loaded：项目列表一并记录
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_subs_result(1, Ok((sample_subscriptions(), vec![])), cx);
            });
        });
        assert_eq!(read_subs(cx, &view), SubsState::Loaded(sample_subscriptions()));

        // Empty：无订阅
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 2;
                this.apply_subs_result(2, Ok((vec![], vec![])), cx);
            });
        });
        assert_eq!(read_subs(cx, &view), SubsState::Empty);

        // Error
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 3;
                this.apply_subs_result(3, Err("接口 500".to_string()), cx);
            });
        });
        assert_eq!(read_subs(cx, &view), SubsState::Error("接口 500".to_string()));
    }

    #[gpui::test]
    async fn apply_ledger_result_transitions_and_stale_discarded(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);

        // 竞态保护：过期请求 1 的响应被丢弃（当前请求 2）
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 2;
                this.apply_ledger_result(1, Ok(sample_ledger()), cx);
            });
        });
        assert_eq!(read_ledger(cx, &view), LedgerState::Loading);

        // 最新请求 2 正常落点
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.apply_ledger_result(2, Ok(sample_ledger()), cx);
            });
        });
        assert_eq!(read_ledger(cx, &view), LedgerState::Loaded(sample_ledger()));

        // Empty：无台账记录
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 3;
                let empty = LedgerListResponse {
                    items: vec![],
                    total: 0,
                    summary: LedgerSummary {
                        expected: 0,
                        sent: 0,
                        failed: 0,
                        missing: 0,
                        resendable: 0,
                    },
                };
                this.apply_ledger_result(3, Ok(empty), cx);
            });
        });
        assert_eq!(read_ledger(cx, &view), LedgerState::Empty);
    }

    #[gpui::test]
    async fn select_tab_lazily_loads_ledger(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        // 切到台账 → ledger_loaded 置真（触发首拉；client 指向拒绝连接地址 → 最终 Error）
        cx.update(|cx| {
            view.update(cx, |this, cx| this.select_tab(ReportTab::Ledger, cx));
        });
        assert_eq!(cx.read(|app| view.read(app).tab), ReportTab::Ledger);
        assert!(cx.read(|app| view.read(app).ledger_loaded));
        assert!(!cx.read(|app| view.read(app).subs_loaded));
        // 切回订阅 → 订阅尚未拉过 → 触发首拉
        cx.update(|cx| {
            view.update(cx, |this, cx| this.select_tab(ReportTab::Subscriptions, cx));
        });
        assert_eq!(cx.read(|app| view.read(app).tab), ReportTab::Subscriptions);
        assert!(cx.read(|app| view.read(app).subs_loaded));
    }

    #[gpui::test]
    async fn toggle_day_and_ledger_item(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.toggle_day("2026-08-15".to_string(), cx);
                this.toggle_ledger_item("5:2026-08-15".to_string(), cx);
            });
        });
        assert!(cx.read(|app| view.read(app).expanded_days.contains("2026-08-15")));
        assert_eq!(
            cx.read(|app| view.read(app).selected_key.clone()),
            Some("5:2026-08-15".to_string())
        );
        // 再点一次 → 取消选中；再点日期 → 收起
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.toggle_ledger_item("5:2026-08-15".to_string(), cx);
                this.toggle_day("2026-08-15".to_string(), cx);
            });
        });
        assert!(cx.read(|app| view.read(app).selected_key.is_none()));
        assert!(!cx.read(|app| view.read(app).expanded_days.contains("2026-08-15")));
    }

    // ---------- 渲染冒烟 ----------

    #[gpui::test]
    async fn scheduled_reports_renders_subscriptions_loaded_in_both_modes(
        cx: &mut gpui::TestAppContext,
    ) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_subs_result(1, Ok((sample_subscriptions(), vec![])), cx);
            });
        });
        // 窗口宿主包装 Entity → 首帧渲染完整路径（tab 栏 + 过滤栏 + 表格）
        let (_host, cx2) =
            cx.add_window_view(|_window, _cx| ScheduledReportsHost { view: view.clone() });
        cx2.read(|app| assert!(!crate::theme::AppTheme::current(app).is_dark()));

        // 经窗口上下文切深色：重新渲染不 panic，语义色板跟随
        cx2.update(|_window, app| {
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, app);
        });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    #[gpui::test]
    async fn scheduled_reports_renders_ledger_loaded(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let view = create_view(cx);
        // 驱动到台账 tab 的 Loaded（含详情选中路径）
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.tab = ReportTab::Ledger;
                this.ledger_loaded = true;
                this.latest_request_id = 1;
                this.apply_ledger_result(1, Ok(sample_ledger()), cx);
                this.toggle_ledger_item("5:2026-08-15".to_string(), cx);
            });
        });
        let (_host, _cx2) =
            cx.add_window_view(|_window, _cx| ScheduledReportsHost { view: view.clone() });
    }

    #[gpui::test]
    async fn scheduled_reports_renders_empty_states(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let view = create_view(cx);
        // 订阅 Empty + 台账 Empty
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_subs_result(1, Ok((vec![], vec![])), cx);
                this.latest_request_id = 2;
                let empty = LedgerListResponse {
                    items: vec![],
                    total: 0,
                    summary: LedgerSummary {
                        expected: 0,
                        sent: 0,
                        failed: 0,
                        missing: 0,
                        resendable: 0,
                    },
                };
                this.apply_ledger_result(2, Ok(empty), cx);
            });
        });
        let (_host, _cx2) =
            cx.add_window_view(|_window, _cx| ScheduledReportsHost { view: view.clone() });
    }

    #[gpui::test]
    async fn scheduled_reports_renders_error_and_loading(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let view = create_view(cx);
        // 订阅 Error（加载中台账不渲染）
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_subs_result(1, Err("网络连接失败".to_string()), cx);
            });
        });
        let (_host, _cx2) =
            cx.add_window_view(|_window, _cx| ScheduledReportsHost { view: view.clone() });
    }
}
