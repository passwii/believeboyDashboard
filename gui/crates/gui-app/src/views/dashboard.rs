//! Dashboard 视图状态机（GUI-6 / 1.0-a）
//!
//! 四态状态机 + 项目切换重拉 + 请求竞态保护：
//!
//! ```text
//!              reload() / select_project()
//!        ┌───────────────┐
//!        │               ▼
//!   ┌────┴─────┐   ┌──────────┐
//!   │ Loaded   │   │ Loading  │
//!   │ Empty    │──▶│ (骨架屏)  │
//!   │ Error    │   └────┬─────┘
//!   └──────────┘        │ 拉取完成
//!               ┌───────┴────────┐
//!               ▼                ▼
//!           Loaded(有数据)   Empty(无项目/无数据)
//!               └──────▶ Error(失败)
//! ```
//!
//! - `reload()`：项目切换 / 错误重试 / 空态刷新共用入口，每次递增 `latest_request_id`，
//!   响应回来时只应用「等于最新 id」的那一次（过期响应直接丢弃）——对齐 frontend
//!   `app/dashboard/page.tsx` 的 `latestRequestRef` 竞态保护。
//! - 数据流：`list_managed_projects` → `daily_analysis_all`（近 7 天窗口，`country=US`，
//!   与 frontend 调用口径一致）；无项目时不发聚合请求，直接进 Empty。
//! - 状态持有在 `Entity<DashboardState>` 中（gpui 0.2 的 `Model` 更名），后续
//!   GUI-7/9（数字带 / Top 项目）可以订阅或直接读取。
//! - 展示组件全部来自 gpui-component（用户 2026-08-14 指定组件库）：
//!   Loading → `Skeleton`；Error → `Alert`（内联）；Empty → `Icon` + 文案；主题 → `ActiveTheme`。
//! - GUI-8（1.0-c）已接入 6 张图表占位卡（`widgets::chart_placeholder`，v1.1 换真图表）。

use chrono::{Days, NaiveDate};
use gpui::{
    div, prelude::*, px, App, AsyncApp, Context, Entity, MouseButton, Render, WeakEntity, Window,
};
use gpui_component::{
    alert::Alert, h_flex, skeleton::Skeleton, spinner::Spinner, v_flex, ActiveTheme, Icon, Sizable,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::dashboard::{DailyAnalysisResponse, KpiSummary};

use crate::theme::AppTheme;
use crate::views::stat_band::{stat_band, stat_band_skeleton};
use crate::widgets::top_projects::{TopProjectRow, TopProjectsWidget};

/// 项目 ID（对齐 `ManagedProject.id`，i64）
pub type ProjectId = i64;

/// 近 7 天窗口（对齐 frontend：`from = today - 7`，`to = today - 1`，昨天为界）
pub fn last_7_days_window(today: NaiveDate) -> (NaiveDate, NaiveDate) {
    let to = today.pred_opt().unwrap_or(today);
    let from = to.checked_sub_days(Days::new(6)).unwrap_or(to);
    (from, to)
}

/// 对比期窗口（对齐 frontend page.tsx：`prevFrom = from - 7`，`prevTo = from - 1`，
/// 即当前窗口紧邻的前一个 7 天窗口，用于 Top 项目的环比）。
pub fn previous_7_days_window(window: (NaiveDate, NaiveDate)) -> (NaiveDate, NaiveDate) {
    let (from, _to) = window;
    let prev_to = from.pred_opt().unwrap_or(from);
    let prev_from = prev_to.checked_sub_days(Days::new(6)).unwrap_or(prev_to);
    (prev_from, prev_to)
}

/// Dashboard 数据载荷（Loaded 持有；GUI-7/8/9 消费渲染）
#[derive(Debug, Clone, PartialEq)]
pub struct DashboardData {
    /// 当前用户可管理的项目列表（reload 时刷新）
    pub projects: Vec<ManagedProject>,
    /// 聚合数据；`None` = 无项目而未发起聚合请求
    pub daily: Option<DailyAnalysisResponse>,
    /// 对比期（前一 7 天窗口）聚合数据（GUI-9 Top 项目环比用）；
    /// 对比期拉取失败时为 `None`（环比显示「—」，不阻塞主数据）
    pub compare: Option<DailyAnalysisResponse>,
}

impl DashboardData {
    /// 空态判定（对齐 frontend `hasData = currentRows.length > 0`）：
    /// 无项目，或没有任何聚合行 → 空态（暂无销售数据）
    pub fn is_empty(&self) -> bool {
        self.projects.is_empty()
            || self
                .daily
                .as_ref()
                .is_none_or(|d| d.summary_rows.is_empty())
    }

    /// Top 项目聚合行（GUI-9 消费；纯函数聚合，默认销售额降序取 Top 6）
    pub fn top_projects(&self) -> Vec<TopProjectRow> {
        let Some(daily) = &self.daily else {
            return Vec::new();
        };
        let compare = self.compare.as_ref().map(|c| &c.project_breakdown);
        crate::widgets::top_projects::compute_top_projects(
            &daily.project_breakdown,
            compare,
            &self.projects,
        )
    }
}

/// Dashboard 状态机（四态）
///
/// `Loaded` 持有完整载荷（项目 + 本期 + 对比期），变体体积明显大于其余三个；
/// 状态机按「每轮 fetch 一次克隆」使用（render 内 clone 判型），体积影响可接受，
/// 故对 large_enum_variant 显式放行（GUI-9 为环比引入 compare 字段后触发）。
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum DashboardState {
    /// 首屏 / reload 拉取中（骨架屏）
    Loading,
    /// 拉取成功且有数据（GUI-7 数字带 / GUI-8 图表 / GUI-9 Top 项目消费）
    Loaded(DashboardData),
    /// 无项目 或 无聚合数据（空态：Icon + 文案 + 刷新按钮）
    Empty,
    /// 拉取失败（内联 Alert + 重试按钮）
    Error(String),
}

impl DashboardState {
    /// 状态转移：拉取结果 → 落点状态（Loading → Loaded / Empty / Error）
    ///
    /// 这是唯一合法的「拉取完成」转移，供 `DashboardView::apply_result` 使用；
    /// 纯函数形态便于单元测试（不依赖网络 / 视图上下文）。
    pub fn from_fetch_result(result: Result<DashboardData, String>) -> Self {
        match result {
            Ok(data) if data.is_empty() => Self::Empty,
            Ok(data) => Self::Loaded(data),
            Err(msg) => Self::Error(msg),
        }
    }
}

/// Dashboard 视图（状态机 + 数据拉取 + 竞态保护）
pub struct DashboardView {
    /// 状态机（Entity 使其可订阅；GUI-7+ 消费）
    state: Entity<DashboardState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表（reload 时刷新；GUI-9 Top 项目消费，暂只读）
    #[allow(dead_code)]
    projects: Vec<ManagedProject>,
    /// 当前选中项目；`None` = 全部项目（对齐 frontend `ALL_PROJECTS` 默认）
    selected_project_id: Option<ProjectId>,
    /// 请求竞态保护：只有等于最新值的响应才被应用（u64 溢出回绕安全）
    latest_request_id: u64,
    /// Top 项目列表（GUI-9 / 1.0-d）
    top_projects: Entity<TopProjectsWidget>,
}

impl DashboardView {
    /// 新建视图：初始 `Loading`，由调用方（GUI-7 起 root.rs）在合适时机触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client, projects: Vec<ManagedProject>) -> Self {
        let state = cx.new(|_| DashboardState::Loading);
        let top_projects = cx.new(|_| TopProjectsWidget::new());
        Self {
            state,
            client,
            projects,
            selected_project_id: None,
            latest_request_id: 0,
            top_projects,
        }
    }

    /// 当前状态（只读，测试 / GUI-8+ 用）
    #[allow(dead_code)] // GUI-8/9 消费前仅供测试使用
    pub fn current_state(&self, cx: &App) -> DashboardState {
        self.state.read(cx).clone()
    }

    /// 项目列表（只读；GUI-9 Top 项目消费）
    #[allow(dead_code)]
    pub fn projects(&self) -> &[ManagedProject] {
        &self.projects
    }

    /// 选中项目；`None` = 全部项目
    #[allow(dead_code)]
    pub fn selected_project_id(&self) -> Option<ProjectId> {
        self.selected_project_id
    }

    /// 最新请求序号（测试断言用）
    #[allow(dead_code)]
    pub fn latest_request_id(&self) -> u64 {
        self.latest_request_id
    }

    /// 重新拉取数据：项目切换 / 错误重试 / 空态刷新共用入口。
    ///
    /// 每次调用递增 `latest_request_id` 并进入 Loading；响应回来时
    /// `apply_result` 只应用最新一次（竞态保护）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let selected = self.selected_project_id;

        self.state.update(cx, |state, cx| {
            *state = DashboardState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(load_dashboard(&client, selected))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 切换选中项目 → 立即 reload（项目切换重新拉数据）。
    /// 选中同一项目为 no-op，避免无意义的重复请求。
    #[allow(dead_code)] // GUI-8 项目选择器接入前仅供测试使用
    pub fn select_project(&mut self, project_id: Option<ProjectId>, cx: &mut Context<Self>) {
        if project_id == self.selected_project_id {
            return;
        }
        self.selected_project_id = project_id;
        self.reload(cx);
    }

    /// 应用拉取结果：竞态保护（`request_id` 过期 → 丢弃，不触碰状态）。
    /// 纯同步逻辑，可直接在测试中驱动（不依赖真实网络）。
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<DashboardData, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        // Loaded 落点前先把 Top 项目行喂给 GUI-9 组件（数据驱动，非渲染期副作用）
        if let Ok(data) = &result {
            if !data.is_empty() {
                let rows = data.top_projects();
                self.top_projects
                    .update(cx, |widget, cx| widget.set_data(rows, cx));
            }
        }
        self.state.update(cx, |state, cx| {
            *state = DashboardState::from_fetch_result(result);
            cx.notify();
        });
    }
}

/// 拉取 Dashboard 全量数据（项目列表 + 近 7 天聚合数据），与视图解耦便于测试。
///
/// - 项目列表为空 → 返回空载荷（`daily = None`），由 `is_empty` 归入 Empty 态；
/// - `selected_project_id = Some(id)` 时只拉该项目的聚合数据，否则拉全部项目
///   （逗号分隔的整数 id，与 frontend 一致；backend 传 "all" 会 422）。
async fn load_dashboard(
    client: &Client,
    selected_project_id: Option<ProjectId>,
) -> Result<DashboardData, String> {
    let projects = client
        .list_managed_projects()
        .await
        .map_err(|e| e.user_message())?;
    if projects.is_empty() {
        return Ok(DashboardData {
            projects: Vec::new(),
            daily: None,
            compare: None,
        });
    }
    let ids = match selected_project_id {
        Some(id) => id.to_string(),
        None => projects
            .iter()
            .map(|p| p.id.to_string())
            .collect::<Vec<_>>()
            .join(","),
    };
    let today = chrono::Local::now().date_naive();
    let (from, to) = last_7_days_window(today);
    let (compare_from, compare_to) = previous_7_days_window((from, to));
    // 本期 + 对比期并行拉取（对齐 frontend page.tsx 的 Promise.all）；
    // 对比期失败不阻塞主数据（环比显示「—」）
    let (daily, compare) = tokio::join!(
        client.daily_analysis_all(&ids, "US", from, to),
        client.daily_analysis_all(&ids, "US", compare_from, compare_to),
    );
    let daily = daily.map_err(|e| e.user_message())?;
    Ok(DashboardData {
        projects,
        daily: Some(daily),
        compare: compare.ok(),
    })
}

impl Render for DashboardView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let app_theme = AppTheme::current(cx);
        // 克隆状态机（1.0-a 直接克隆；GUI-7+ 若帧率高可改为借用判别字段）
        let state = self.state.read(cx).clone();
        let top_projects = self.top_projects.clone();
        match state {
            DashboardState::Loading => render_loading(&theme, &app_theme).into_any_element(),
            DashboardState::Error(msg) => render_error(cx, &theme, &msg).into_any_element(),
            DashboardState::Empty => render_empty(cx, &theme).into_any_element(),
            DashboardState::Loaded(data) => {
                render_loaded(cx, &theme, &data, top_projects, &app_theme).into_any_element()
            }
        }
    }
}

/// Loading：骨架屏（顶部选择器占位 + KPI 卡占位 + 主体占位）
fn render_loading(theme: &gpui_component::Theme, app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("dashboard-loading")
        .size_full()
        .gap_4()
        .p_6()
        .bg(theme.background)
        .child(
            h_flex()
                .gap_2()
                .child(Spinner::new().small().color(theme.foreground.opacity(0.6)))
                .child(div().text_color(theme.muted_foreground).child("加载中…")),
        )
        .child(
            // 顶部项目选择器占位
            div().w(px(180.)).h(px(36.)).child(Skeleton::new()),
        )
        .child(
            // KPI 数字带占位（GUI-7：6 张骨架卡，数字位置放 Skeleton）
            stat_band_skeleton(app_theme),
        )
        .child(
            // 主体内容占位
            div().flex_1().child(Skeleton::new().secondary()),
        )
}

/// Error：内联 Alert + 重试按钮（重试 = reload）
fn render_error(
    cx: &mut Context<DashboardView>,
    theme: &gpui_component::Theme,
    msg: &str,
) -> impl IntoElement {
    v_flex()
        .id("dashboard-error")
        .size_full()
        .gap_3()
        .p_6()
        .bg(theme.background)
        .child(
            Alert::error("dashboard-error", msg)
                .title("数据加载失败")
                .w_full(),
        )
        .child(
            div()
                .px_3()
                .py_1()
                .rounded(px(6.))
                .border_1()
                .border_color(theme.border)
                .text_size(px(13.))
                .text_color(theme.foreground)
                .cursor(gpui::CursorStyle::PointingHand)
                .hover(|style| style.bg(theme.secondary))
                .on_mouse_up(
                    MouseButton::Left,
                    cx.listener(|this, _, _, cx| this.reload(cx)),
                )
                .child("重试"),
        )
}

/// Empty：Icon + 文案 + 刷新按钮（暂无销售数据）
fn render_empty(
    cx: &mut Context<DashboardView>,
    theme: &gpui_component::Theme,
) -> impl IntoElement {
    v_flex()
        .id("dashboard-empty")
        .size_full()
        .items_center()
        .justify_center()
        .gap_3()
        .bg(theme.background)
        .child(
            Icon::new(Icon::empty())
                .path("icons/package.svg")
                .with_size(px(48.))
                .text_color(theme.muted_foreground),
        )
        .child(
            div()
                .text_size(px(14.))
                .text_color(theme.muted_foreground)
                .child("暂无销售数据"),
        )
        .child(
            div()
                .px_3()
                .py_1()
                .rounded(px(6.))
                .border_1()
                .border_color(theme.border)
                .text_size(px(13.))
                .text_color(theme.foreground)
                .cursor(gpui::CursorStyle::PointingHand)
                .hover(|style| style.bg(theme.secondary))
                .on_mouse_up(
                    MouseButton::Left,
                    cx.listener(|this, _, _, cx| this.reload(cx)),
                )
                .child("刷新"),
        )
}

/// Loaded：标题 + 6 张图表占位卡（GUI-8 / 1.0-c）+ Top 项目列表（GUI-9 / 1.0-d）
fn render_loaded(
    _cx: &mut Context<DashboardView>,
    theme: &gpui_component::Theme,
    data: &DashboardData,
    top_projects: Entity<TopProjectsWidget>,
    app_theme: &AppTheme,
) -> impl IntoElement {
    let daily = data.daily.as_ref();
    let kpi = daily.map_or_else(KpiSummary::default, |d| {
        KpiSummary::from_rows(&d.summary_rows)
    });
    let comparison = data.compare.as_ref().map_or_else(KpiSummary::default, |d| {
        KpiSummary::from_rows(&d.summary_rows)
    });
    let day_count = daily.map_or(0, |d| d.summary_rows.len());
    v_flex()
        .id("dashboard-loaded")
        .size_full()
        .gap_3()
        .p_6()
        .bg(theme.background)
        .child(
            div()
                .text_lg()
                .text_color(theme.foreground)
                .child("数据看板"),
        )
        .child(
            div()
                .text_sm()
                .text_color(theme.muted_foreground)
                .child(format!(
                    "已加载：{} 个项目 · 近 7 天 {} 天聚合数据",
                    data.projects.len(),
                    day_count
                )),
        )
        // GUI-7：数字带（6 张 KPI 卡 + 环比 delta，数据口径复用 gui-domain KpiSummary）
        .child(stat_band(&kpi, &comparison, app_theme))
        // GUI-8：6 个图表位置占位卡（v1.1 接 gpui-component Chart 真图表）
        .child(crate::widgets::chart_placeholder::render_chart_placeholder_grid(theme))
        // Top 项目列表（GUI-9 / 1.0-d）
        .child(div().flex_1().min_h(px(240.)).child(top_projects))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use gui_domain::dashboard::{DailyAnalysisResponse, ProjectBreakdownEntry};
    use std::collections::HashMap;

    /// 构造一个最小项目（id + name）
    fn project(id: i64, name: &str) -> ManagedProject {
        ManagedProject {
            id,
            name: name.to_string(),
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
        }
    }

    /// 构造一个带 1 行聚合数据的响应
    fn daily_response(rows: usize) -> DailyAnalysisResponse {
        let mut project_breakdown = HashMap::new();
        project_breakdown.insert(
            1i64,
            ProjectBreakdownEntry {
                project_name: "测试项目".to_string(),
                summary_rows: vec![gui_domain::dashboard::DailyAnalysisRow {
                    date: NaiveDate::from_ymd_opt(2026, 8, 13).unwrap(),
                    order_qty: 10,
                    sales_amount: 1000.0,
                    impressions: 0,
                    clicks: 0,
                    cpc: 0.0,
                    ad_spend: 0.0,
                    ad_orders: 0,
                    available_qty: 0,
                    page_views: 0,
                    units_ordered: 0,
                    sessions: 0,
                    ordered_sales_amount: 0.0,
                    conversion_rate: 0.0,
                }],
                detail_rows: Vec::new(),
            },
        );
        DailyAnalysisResponse {
            summary_rows: vec![gui_domain::dashboard::DailyAnalysisRow {
                date: NaiveDate::from_ymd_opt(2026, 8, 13).unwrap(),
                order_qty: 10,
                sales_amount: 1000.0,
                impressions: 0,
                clicks: 0,
                cpc: 0.0,
                ad_spend: 0.0,
                ad_orders: 0,
                available_qty: 0,
                page_views: 0,
                units_ordered: 0,
                sessions: 0,
                ordered_sales_amount: 0.0,
                conversion_rate: 0.0,
            }]
            .into_iter()
            .take(rows)
            .collect(),
            detail_rows: Vec::new(),
            available_dates: Default::default(),
            project_breakdown,
        }
    }

    fn sample_data() -> DashboardData {
        DashboardData {
            projects: vec![project(1, "测试项目")],
            daily: Some(daily_response(1)),
            compare: None,
        }
    }

    // ---------- 纯状态机转移（不依赖网络 / gpui） ----------

    #[test]
    fn from_fetch_result_maps_to_loaded_empty_error() {
        // 成功且有数据 → Loaded
        let data = sample_data();
        assert_eq!(
            DashboardState::from_fetch_result(Ok(data.clone())),
            DashboardState::Loaded(data)
        );

        // 成功但无项目 → Empty
        let no_projects = DashboardData {
            projects: Vec::new(),
            daily: None,
            compare: None,
        };
        assert_eq!(
            DashboardState::from_fetch_result(Ok(no_projects)),
            DashboardState::Empty
        );

        // 有项目但无聚合行 → Empty（对齐 frontend hasData 判定）
        let no_rows = DashboardData {
            projects: vec![project(1, "测试项目")],
            daily: Some(daily_response(0)),
            compare: None,
        };
        assert_eq!(
            DashboardState::from_fetch_result(Ok(no_rows)),
            DashboardState::Empty
        );

        // 失败 → Error（保留后端 detail 文案）
        assert_eq!(
            DashboardState::from_fetch_result(Err("连接超时".to_string())),
            DashboardState::Error("连接超时".to_string())
        );
    }

    #[test]
    fn last_7_days_window_matches_frontend_contract() {
        let today = NaiveDate::from_ymd_opt(2026, 8, 14).unwrap();
        let (from, to) = last_7_days_window(today);
        // frontend: to = yesterday, from = yesterday - 6
        assert_eq!(to.to_string(), "2026-08-13");
        assert_eq!(from.to_string(), "2026-08-07");
        // 窗口恰好 7 天
        assert_eq!((to - from).num_days(), 6);
    }

    #[test]
    fn dashboard_data_empty_judgement() {
        // 无项目 → 空
        assert!(DashboardData {
            projects: Vec::new(),
            daily: None,
            compare: None,
        }
        .is_empty());
        // 有项目无 daily → 空
        assert!(DashboardData {
            projects: vec![project(1, "A")],
            daily: None,
            compare: None,
        }
        .is_empty());
        // 有项目 + 有行 → 非空
        assert!(!sample_data().is_empty());
    }

    #[test]
    fn previous_7_days_window_matches_frontend_contract() {
        // 当前窗口 2026-08-07..2026-08-13（today = 08-14）
        let cur = last_7_days_window(NaiveDate::from_ymd_opt(2026, 8, 14).unwrap());
        assert_eq!(
            cur,
            (
                NaiveDate::from_ymd_opt(2026, 8, 7).unwrap(),
                NaiveDate::from_ymd_opt(2026, 8, 13).unwrap()
            )
        );
        // frontend: prevFrom = from - 7，prevTo = from - 1
        let prev = previous_7_days_window(cur);
        assert_eq!(prev.0.to_string(), "2026-07-31");
        assert_eq!(prev.1.to_string(), "2026-08-06");
        assert_eq!((prev.1 - prev.0).num_days(), 6);
    }

    #[test]
    fn dashboard_data_top_projects_aggregates_with_compare() {
        // project_breakdown 含项目 1（2 行聚合）+ 项目 2（1 行）；compare 含项目 1 的对比期
        let mut breakdown = HashMap::new();
        breakdown.insert(
            1i64,
            ProjectBreakdownEntry {
                project_name: "项目 A".to_string(),
                summary_rows: vec![
                    gui_domain::dashboard::DailyAnalysisRow {
                        date: NaiveDate::from_ymd_opt(2026, 8, 12).unwrap(),
                        order_qty: 10,
                        sales_amount: 1000.0,
                        impressions: 0,
                        clicks: 0,
                        cpc: 0.0,
                        ad_spend: 50.0,
                        ad_orders: 0,
                        available_qty: 0,
                        page_views: 0,
                        units_ordered: 0,
                        sessions: 0,
                        ordered_sales_amount: 0.0,
                        conversion_rate: 0.0,
                    },
                    gui_domain::dashboard::DailyAnalysisRow {
                        date: NaiveDate::from_ymd_opt(2026, 8, 13).unwrap(),
                        order_qty: 20,
                        sales_amount: 2000.0,
                        impressions: 0,
                        clicks: 0,
                        cpc: 0.0,
                        ad_spend: 100.0,
                        ad_orders: 0,
                        available_qty: 0,
                        page_views: 0,
                        units_ordered: 0,
                        sessions: 0,
                        ordered_sales_amount: 0.0,
                        conversion_rate: 0.0,
                    },
                ],
                detail_rows: Vec::new(),
            },
        );
        breakdown.insert(
            2i64,
            ProjectBreakdownEntry {
                project_name: "项目 B".to_string(),
                summary_rows: vec![gui_domain::dashboard::DailyAnalysisRow {
                    date: NaiveDate::from_ymd_opt(2026, 8, 13).unwrap(),
                    order_qty: 5,
                    sales_amount: 300.0,
                    impressions: 0,
                    clicks: 0,
                    cpc: 0.0,
                    ad_spend: 20.0,
                    ad_orders: 0,
                    available_qty: 0,
                    page_views: 0,
                    units_ordered: 0,
                    sessions: 0,
                    ordered_sales_amount: 0.0,
                    conversion_rate: 0.0,
                }],
                detail_rows: Vec::new(),
            },
        );
        let mut compare_breakdown = HashMap::new();
        compare_breakdown.insert(
            1i64,
            ProjectBreakdownEntry {
                project_name: "项目 A".to_string(),
                summary_rows: vec![gui_domain::dashboard::DailyAnalysisRow {
                    date: NaiveDate::from_ymd_opt(2026, 8, 6).unwrap(),
                    order_qty: 10,
                    sales_amount: 2500.0,
                    impressions: 0,
                    clicks: 0,
                    cpc: 0.0,
                    ad_spend: 0.0,
                    ad_orders: 0,
                    available_qty: 0,
                    page_views: 0,
                    units_ordered: 0,
                    sessions: 0,
                    ordered_sales_amount: 0.0,
                    conversion_rate: 0.0,
                }],
                detail_rows: Vec::new(),
            },
        );

        let data = DashboardData {
            projects: vec![project(1, "项目 A"), project(2, "项目 B")],
            daily: Some(DailyAnalysisResponse {
                summary_rows: Vec::new(),
                detail_rows: Vec::new(),
                available_dates: Default::default(),
                project_breakdown: breakdown,
            }),
            compare: Some(DailyAnalysisResponse {
                summary_rows: Vec::new(),
                detail_rows: Vec::new(),
                available_dates: Default::default(),
                project_breakdown: compare_breakdown,
            }),
        };

        let rows = data.top_projects();
        // 默认销售额降序：项目 A(3000) > 项目 B(300)
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].project_name, "项目 A");
        assert_eq!(rows[0].total_sales, 3000.0);
        assert_eq!(rows[0].total_orders, 30);
        // 环比 = (3000 - 2500) / 2500 × 100 = 20%
        assert_eq!(rows[0].change, Some(20.0));
        // 项目 B 无对比期 → change 为 None
        assert_eq!(rows[1].change, None);
    }

    #[gpui::test]
    async fn apply_result_feeds_top_projects_widget_on_loaded(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        let data = sample_data();
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Ok(data.clone()), cx);
            });
        });
        // 状态落到 Loaded，且 Top 项目组件已收到行（1 个项目）
        cx.read(|app| {
            let state = view.read(app).state.read(app).clone();
            assert_eq!(state, DashboardState::Loaded(data));
            assert_eq!(view.read(app).top_projects.read(app).rows().len(), 1);
        });
        // 失败结果不喂 Top 组件（保持原有行）
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 2;
                this.apply_result(2, Err("接口 500".to_string()), cx);
            });
        });
        cx.read(|app| {
            assert_eq!(view.read(app).top_projects.read(app).rows().len(), 1);
        });
    }

    // ---------- 视图级竞态保护 / 状态转移（TestAppContext，无真实网络） ----------

    /// 构造视图。client 指向不可达地址（127.0.0.1:1 立即 connection refused），
    /// 测试只驱动同步的 apply_result / select_project，不等待网络任务。
    fn create_view(cx: &mut gpui::TestAppContext) -> Entity<DashboardView> {
        cx.update(|cx| {
            let client = Client::new("http://127.0.0.1:1");
            cx.new(|cx| DashboardView::new(cx, client, vec![project(1, "测试项目")]))
        })
    }

    fn read_state(cx: &mut gpui::TestAppContext, view: &Entity<DashboardView>) -> DashboardState {
        cx.read(|app| view.read(app).state.read(app).clone())
    }

    #[gpui::test]
    async fn initial_state_is_loading(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        assert_eq!(read_state(cx, &view), DashboardState::Loading);
    }

    #[gpui::test]
    async fn stale_request_result_is_discarded(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        let data = sample_data();

        // 最新请求是 2；请求 1 的迟到响应必须被丢弃
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 2;
                this.apply_result(1, Ok(data.clone()), cx);
            });
        });
        assert_eq!(read_state(cx, &view), DashboardState::Loading);

        // 最新请求 2 的响应正常落点
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.apply_result(2, Ok(data.clone()), cx);
            });
        });
        assert_eq!(read_state(cx, &view), DashboardState::Loaded(data));
    }

    #[gpui::test]
    async fn apply_result_error_and_empty_transitions(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);

        // 失败 → Error
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Err("接口 500".to_string()), cx);
            });
        });
        assert_eq!(
            read_state(cx, &view),
            DashboardState::Error("接口 500".to_string())
        );

        // 无项目 → Empty
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 2;
                this.apply_result(
                    2,
                    Ok(DashboardData {
                        projects: Vec::new(),
                        daily: None,
                        compare: None,
                    }),
                    cx,
                );
            });
        });
        assert_eq!(read_state(cx, &view), DashboardState::Empty);
    }

    #[gpui::test]
    async fn select_project_switches_and_reloads(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                assert_eq!(this.selected_project_id, None);
                assert_eq!(this.latest_request_id, 0);

                // 切换到项目 3：更新选中 + 递增请求序号 + 进入 Loading
                this.select_project(Some(3), cx);
                assert_eq!(this.selected_project_id, Some(3));
                assert_eq!(this.latest_request_id, 1);
                assert_eq!(this.current_state(cx), DashboardState::Loading);

                // 重复选择同一项目：no-op（不递增序号）
                this.select_project(Some(3), cx);
                assert_eq!(this.latest_request_id, 1);

                // 切回全部项目：再次触发
                this.select_project(None, cx);
                assert_eq!(this.selected_project_id, None);
                assert_eq!(this.latest_request_id, 2);
            });
        });
    }
}
