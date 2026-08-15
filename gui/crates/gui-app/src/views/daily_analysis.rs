//! 运营 → 销售数据视图（P3-1，BLF-701）
//!
//! frontend `app/dashboard/operations/daily-analysis/page.tsx` 的 GPUI 等价：
//! 销售趋势 / SKU 明细表 / 项目维度下钻（全部项目时）或国家维度下钻（跨站点时）。
//!
//! 架构（复用 Phase 1/2 基建）：
//! - **四态状态机**：`Loading / Loaded / Empty / Error`（沿用 `dashboard.rs` 模式），
//!   `latest_request_id` 竞态保护——只有最新请求的响应才会落点；
//! - **数据管线**：`list_managed_projects` → 按「项目 × 国家」组合走三种端点
//!   （对齐 frontend `loadData` 的 URLSearchParams 口径）：
//!   - 全部项目 + 指定站点 → `daily_analysis_all`（`project_breakdown` 项目维度下钻）
//!   - 单项目 + 全部站点 → `daily_analysis_all_countries`（`country_breakdown` 国家维度下钻）
//!   - 单项目 + 指定站点 → `daily_analysis`（主端点，带 `console` 请求诊断）
//!   - 全部项目 + 全部站点 → 后端不支持聚合矩阵，报错（对齐 frontend 提示）
//! - **数字带**：复用 `stat_band`（KpiSummary 从 summary_rows 聚合 + 对比期环比）；
//! - **明细表 / 下钻表**：gpui-component `Table`（沿用 `widgets::top_projects.rs` 的
//!   TableDelegate 范式，懒建 TableState）；
//! - **图表边界**：图表真渲染属 P3-2，本棒销售趋势用「占位说明 + 每日列表」呈现。
//!
//! 已知差异（有意保留，GPUI 0.2 能力边界 / P3-1 范围）：
//! - 日期范围固定「近 7 天」（与 Dashboard 一致），日期范围选择器留后续增强；
//! - SKU 筛选 / Excel 导出未接入（frontend 有，P3-1 不做）；
//! - 全部项目模式的 console 由客户端合成（backend `/all` 无 console，对齐 frontend）。

use std::collections::HashMap;

use gpui::{
    div, prelude::*, px, App, AsyncApp, Context, CursorStyle, Entity, FontWeight, Render,
    SharedString, WeakEntity, Window,
};
use gpui_component::{
    alert::Alert,
    button::Button,
    h_flex,
    menu::{DropdownMenu, PopupMenuItem},
    skeleton::Skeleton,
    spinner::Spinner,
    table::{Column, Table, TableDelegate, TableState},
    v_flex, Icon, IconName, Sizable, StyledExt,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::dashboard::{
    CountryBreakdownEntry, DailyAnalysisConsoleResponse, DailyAnalysisDetailRow, DailyAnalysisRow,
    KpiSummary, ProjectBreakdownEntry,
};

use crate::theme::AppTheme;
use crate::views::dashboard::{last_7_days_window, previous_7_days_window};
use crate::views::stat_band::{stat_band, stat_band_skeleton};
use crate::widgets::top_projects::{fmt_money_precise, fmt_num_precise};

/// 本页在侧栏中的 URL（root.rs 据此路由到本视图；与 gui-domain::sidebar 的销售数据条目一致）
pub const DAILY_ANALYSIS_URL: &str = "/dashboard/operations/daily-analysis";

/// 站点选项（对齐 frontend `COUNTRY_OPTIONS`；value = backend 入参，label = 展示名）
const COUNTRY_OPTIONS: [(&str, &str); 4] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
    ("ALL", "全部站点"),
];

/// 默认站点（对齐 frontend `useUrlParam('country', 'US')`）
const DEFAULT_COUNTRY: &str = "US";

/// 站点展示名（`ALL` → 「全部站点」，未知值原样返回）
pub fn country_label(country: &str) -> String {
    COUNTRY_OPTIONS
        .iter()
        .find(|(value, _)| *value == country)
        .map_or_else(|| country.to_string(), |(_, label)| label.to_string())
}

/// 数据模式（对齐 frontend `loadData` 的三个分支）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnalysisMode {
    /// 全部项目 + 指定站点 → `GET /daily-analysis/all`
    AllProjects,
    /// 单项目 + 全部站点 → `GET /daily-analysis/all-countries`
    SingleCountry,
    /// 单项目 + 指定站点 → `GET /daily-analysis`
    SingleProject,
}

/// 由「项目 × 国家」推导数据模式；`None = 全部项目`
pub fn mode_for(project_id: Option<i64>, country: &str) -> Option<AnalysisMode> {
    match (project_id, country) {
        (None, "ALL") => None, // 全部项目 × 全部站点：后端不支持聚合矩阵
        (None, _) => Some(AnalysisMode::AllProjects),
        (Some(_), "ALL") => Some(AnalysisMode::SingleCountry),
        (Some(_), _) => Some(AnalysisMode::SingleProject),
    }
}

/// 下钻行（项目维度 或 国家维度；纯展示派生，可单测）
#[derive(Debug, Clone, PartialEq)]
pub struct BreakdownRow {
    /// 项目名 / 国家展示名
    pub name: String,
    pub sales: f64,
    pub orders: i64,
    pub ad_spend: f64,
    /// 销售额环比（%）；对比期缺失 / 为 0 时为 `None`（显示「—」）
    pub change: Option<f64>,
}

/// 项目维度下钻（对齐 `widgets::top_projects::compute_top_projects` 口径，
/// 但**不截断 Top N**——下钻要看到全部项目；只统计有聚合行的项目）。
pub fn compute_project_breakdown(
    breakdown: &HashMap<i64, ProjectBreakdownEntry>,
    compare: Option<&HashMap<i64, ProjectBreakdownEntry>>,
    projects: &[ManagedProject],
) -> Vec<BreakdownRow> {
    let mut rows: Vec<BreakdownRow> = Vec::new();
    for project in projects {
        let Some(entry) = breakdown.get(&project.id) else {
            continue;
        };
        if entry.summary_rows.is_empty() {
            continue;
        }
        let sales: f64 = entry.summary_rows.iter().map(|r| r.sales_amount).sum();
        let orders: i64 = entry.summary_rows.iter().map(|r| r.order_qty).sum();
        let ad_spend: f64 = entry.summary_rows.iter().map(|r| r.ad_spend).sum();
        let prev_sales: f64 = compare
            .and_then(|map| map.get(&project.id))
            .map(|e| e.summary_rows.iter().map(|r| r.sales_amount).sum())
            .unwrap_or(0.0);
        let change = if prev_sales > 0.0 {
            Some((sales - prev_sales) / prev_sales * 100.0)
        } else {
            None
        };
        rows.push(BreakdownRow {
            name: if entry.project_name.is_empty() {
                project.name.clone()
            } else {
                entry.project_name.clone()
            },
            sales,
            orders,
            ad_spend,
            change,
        });
    }
    rows.sort_by(|a, b| b.sales.total_cmp(&a.sales));
    rows
}

/// 国家维度下钻（`country_breakdown` → 展示行，按 frontend 站点顺序 US/DE/UK 排）。
pub fn compute_country_breakdown(
    breakdown: &HashMap<String, CountryBreakdownEntry>,
    compare: Option<&HashMap<String, CountryBreakdownEntry>>,
) -> Vec<BreakdownRow> {
    let mut rows: Vec<BreakdownRow> = Vec::new();
    for (country, entry) in breakdown {
        if entry.summary_rows.is_empty() {
            continue;
        }
        let sales: f64 = entry.summary_rows.iter().map(|r| r.sales_amount).sum();
        let orders: i64 = entry.summary_rows.iter().map(|r| r.order_qty).sum();
        let ad_spend: f64 = entry.summary_rows.iter().map(|r| r.ad_spend).sum();
        let prev_sales: f64 = compare
            .and_then(|map| map.get(country))
            .map(|e| e.summary_rows.iter().map(|r| r.sales_amount).sum())
            .unwrap_or(0.0);
        let change = if prev_sales > 0.0 {
            Some((sales - prev_sales) / prev_sales * 100.0)
        } else {
            None
        };
        rows.push(BreakdownRow {
            name: country_label(country),
            sales,
            orders,
            ad_spend,
            change,
        });
    }
    // frontend 站点顺序：US → DE → UK（未知键排后）
    let order = |name: &str| match name {
        "美国站 (US)" => 0,
        "德国站 (DE)" => 1,
        "英国站 (UK)" => 2,
        _ => 3,
    };
    rows.sort_by_key(|r| order(&r.name));
    rows
}

/// 销售数据载荷（Loaded 持有）
#[derive(Debug, Clone, PartialEq)]
pub struct DailyAnalysisData {
    pub projects: Vec<ManagedProject>,
    pub mode: AnalysisMode,
    /// 请求诊断（mode A 由客户端合成；B/C 来自后端 console）
    pub console: DailyAnalysisConsoleResponse,
    /// 每日聚合行（销售趋势 / KPI 数字带数据源）
    pub summary_rows: Vec<DailyAnalysisRow>,
    /// SKU 明细行（明细表数据源）
    pub detail_rows: Vec<DailyAnalysisDetailRow>,
    /// 项目维度（mode A）/ 国家维度（mode B）下钻；mode C 为空
    pub breakdown: Vec<BreakdownRow>,
    /// 对比期（前一 7 天窗口）聚合行（数字带环比用）；拉取失败时为空（显示「—」）
    pub compare_summary_rows: Vec<DailyAnalysisRow>,
}

impl DailyAnalysisData {
    /// 空态判定（对齐 frontend `hasData`：无项目，或没有任何聚合行）
    pub fn is_empty(&self) -> bool {
        self.projects.is_empty() || self.summary_rows.is_empty()
    }
}

/// 销售数据状态机（四态；对齐 dashboard.rs）
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum DailyAnalysisState {
    Loading,
    Loaded(DailyAnalysisData),
    Empty,
    Error(String),
}

impl DailyAnalysisState {
    /// 拉取结果 → 落点状态（唯一合法的「拉取完成」转移）
    pub fn from_fetch_result(result: Result<DailyAnalysisData, String>) -> Self {
        match result {
            Ok(data) if data.is_empty() => Self::Empty,
            Ok(data) => Self::Loaded(data),
            Err(msg) => Self::Error(msg),
        }
    }
}

/// 销售数据视图（状态机 + 项目/国家筛选 + 竞态保护）
pub struct DailyAnalysisView {
    state: Entity<DailyAnalysisState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表（reload 刷新；筛选菜单数据源）
    projects: Vec<ManagedProject>,
    /// 当前选中项目；`None` = 全部项目
    selected_project_id: Option<i64>,
    /// 当前站点（"US" / "DE" / "UK" / "ALL"）
    country: &'static str,
    /// 请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,
    /// SKU 明细表（懒建 TableState）
    detail_table: Entity<DailyDetailTable>,
    /// 项目/国家维度下钻表（懒建）
    breakdown_table: Entity<BreakdownTable>,
}

impl DailyAnalysisView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| DailyAnalysisState::Loading);
        let detail_table = cx.new(|_| DailyDetailTable::new());
        let breakdown_table = cx.new(|_| BreakdownTable::new());
        Self {
            state,
            client,
            projects: Vec::new(),
            selected_project_id: None,
            country: DEFAULT_COUNTRY,
            latest_request_id: 0,
            detail_table,
            breakdown_table,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)] // 视图级测试消费（对齐 dashboard.rs current_state 用法）
    pub fn current_state(&self, cx: &App) -> DailyAnalysisState {
        self.state.read(cx).clone()
    }

    /// 重新拉取数据：项目/国家切换、错误重试、空态刷新共用入口。
    ///
    /// 每次调用递增 `latest_request_id` 并进入 Loading；响应回来时
    /// `apply_result` 只应用最新一次（竞态保护，对齐 dashboard.rs）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let selected = self.selected_project_id;
        let country = self.country;

        self.state.update(cx, |state, cx| {
            *state = DailyAnalysisState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(load_daily_analysis(&client, selected, country))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 切换选中项目 → reload（`None` = 全部项目；同一项目为 no-op）
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

    /// 应用拉取结果：竞态保护（过期响应丢弃）+ Loaded 落点前把明细/下钻行喂给表格组件。
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<DailyAnalysisData, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok(data) = &result {
            if !data.is_empty() {
                self.projects = data.projects.clone();
                let detail_rows = data.detail_rows.clone();
                self.detail_table
                    .update(cx, |widget, cx| widget.set_data(detail_rows, cx));
                let breakdown = data.breakdown.clone();
                self.breakdown_table
                    .update(cx, |widget, cx| widget.set_data(breakdown, cx));
            }
        }
        self.state.update(cx, |state, cx| {
            *state = DailyAnalysisState::from_fetch_result(result);
            cx.notify();
        });
    }
}

/// 拉取销售数据（项目列表 + 按「项目 × 国家」模式拉主数据与对比期），与视图解耦便于测试。
///
/// 对齐 frontend `loadData`：
/// - 项目列表为空 → 返回空载荷（`summary_rows` 空），由 `is_empty` 归入 Empty 态；
/// - 主数据 + 对比期并行拉取（`Promise.all` 等价）；对比期失败不阻塞主数据
///   （环比显示「—」）；
/// - 全部项目 + 全部站点 → Err（后端不支持聚合矩阵，与 frontend 提示一致）。
async fn load_daily_analysis(
    client: &Client,
    selected_project_id: Option<i64>,
    country: &str,
) -> Result<DailyAnalysisData, String> {
    let projects = client
        .list_managed_projects()
        .await
        .map_err(|e| e.user_message())?;
    let mode = mode_for(selected_project_id, country).ok_or_else(|| {
        "暂不支持「全部项目 × 全部站点」：请先选定具体项目，再选择「全部站点」以查看跨国家汇总。"
            .to_string()
    })?;

    let today = chrono::Local::now().date_naive();
    let (from, to) = last_7_days_window(today);
    let (compare_from, compare_to) = previous_7_days_window((from, to));

    let data = match mode {
        AnalysisMode::AllProjects => {
            let ids = projects
                .iter()
                .map(|p| p.id.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let (current, compare) = tokio::join!(
                client.daily_analysis_all(&ids, country, from, to),
                client.daily_analysis_all(&ids, country, compare_from, compare_to),
            );
            let current = current.map_err(|e| e.user_message())?;
            let console = DailyAnalysisConsoleResponse {
                project_id: 0,
                project_name: "全部项目".to_string(),
                country: country.to_string(),
                start_date: from.to_string(),
                end_date: to.to_string(),
                requested_days: 0,
                summary_days: current.summary_rows.len() as i64,
                detail_rows: current.detail_rows.len() as i64,
                sales_source_days: 0,
                ad_source_days: 0,
                inventory_source_days: 0,
                business_source_days: 0,
                missing_dates: Vec::new(),
                latest_sales_date: None,
                latest_ad_date: None,
                latest_inventory_date: None,
                latest_business_date: None,
            };
            let breakdown = compute_project_breakdown(
                &current.project_breakdown,
                compare.as_ref().ok().map(|c| &c.project_breakdown),
                &projects,
            );
            DailyAnalysisData {
                projects,
                mode,
                console,
                summary_rows: current.summary_rows,
                detail_rows: current.detail_rows,
                breakdown,
                compare_summary_rows: compare.map(|c| c.summary_rows).unwrap_or_default(),
            }
        }
        AnalysisMode::SingleCountry => {
            let project_id = selected_project_id.expect("SingleCountry 必有单项目");
            let (current, compare) = tokio::join!(
                client.daily_analysis_all_countries(project_id, from, to),
                client.daily_analysis_all_countries(project_id, compare_from, compare_to),
            );
            let current = current.map_err(|e| e.user_message())?;
            let breakdown = compute_country_breakdown(
                &current.country_breakdown,
                compare.as_ref().ok().map(|c| &c.country_breakdown),
            );
            DailyAnalysisData {
                projects,
                mode,
                console: current.console,
                summary_rows: current.summary_rows,
                detail_rows: current.detail_rows,
                breakdown,
                compare_summary_rows: compare.map(|c| c.summary_rows).unwrap_or_default(),
            }
        }
        AnalysisMode::SingleProject => {
            let project_id = selected_project_id.expect("SingleProject 必有单项目");
            let (current, compare) = tokio::join!(
                client.daily_analysis(project_id, country, from, to, None, false),
                client.daily_analysis(project_id, country, compare_from, compare_to, None, false),
            );
            let current = current.map_err(|e| e.user_message())?;
            DailyAnalysisData {
                projects,
                mode,
                console: current.console,
                summary_rows: current.summary_rows,
                detail_rows: current.detail_rows,
                breakdown: Vec::new(),
                compare_summary_rows: compare.map(|c| c.summary_rows).unwrap_or_default(),
            }
        }
    };
    Ok(data)
}

impl Render for DailyAnalysisView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let detail_table = self.detail_table.clone();
        let breakdown_table = self.breakdown_table.clone();
        match state {
            DailyAnalysisState::Loading => render_loading(&app_theme).into_any_element(),
            DailyAnalysisState::Error(msg) => render_error(cx, &app_theme, &msg).into_any_element(),
            DailyAnalysisState::Empty => render_empty(cx, &app_theme).into_any_element(),
            DailyAnalysisState::Loaded(data) => render_loaded(
                window,
                cx,
                &app_theme,
                &data,
                self.selected_project_id,
                self.country,
                self.projects.clone(),
                detail_table,
                breakdown_table,
            )
            .into_any_element(),
        }
    }
}

// ---------------------------------------------------------------------------
// 四态渲染
// ---------------------------------------------------------------------------

/// Loading：顶部筛选占位 + 数字带骨架 + 趋势/明细卡骨架（与正式布局同构）
fn render_loading(app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("daily-analysis-loading")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    Spinner::new()
                        .small()
                        .color(app_theme.text_primary.opacity(0.6)),
                )
                .child(div().text_color(app_theme.text_muted).child("加载中…")),
        )
        .child(
            v_flex()
                .gap_2()
                .child(div().w(px(120.)).h(px(24.)).child(Skeleton::new())),
        )
        .child(
            h_flex()
                .gap_2()
                .child(div().w(px(140.)).h(px(32.)).child(Skeleton::new()))
                .child(div().w(px(140.)).h(px(32.)).child(Skeleton::new()))
                .child(div().w(px(80.)).h(px(32.)).child(Skeleton::new())),
        )
        .child(stat_band_skeleton(app_theme))
        .child(div().w_full().h(px(300.)).child(Skeleton::new()))
        .child(div().w_full().h(px(300.)).child(Skeleton::new()))
}

/// Error：内联 Alert + 重试按钮（对齐 dashboard.rs）
fn render_error(
    cx: &mut Context<DailyAnalysisView>,
    app_theme: &AppTheme,
    msg: &str,
) -> impl IntoElement {
    v_flex()
        .id("daily-analysis-error")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(
            v_flex()
                .w_full()
                .gap_3()
                .p_4()
                .rounded(px(app_theme.radius_lg))
                .bg(app_theme.card_bg)
                .shadow(vec![app_theme.card_shadow_box()])
                .child(
                    Alert::error("daily-analysis-error", msg)
                        .title("销售数据加载失败")
                        .w_full(),
                )
                .child(
                    div().w_full().flex().justify_end().child(
                        Button::new("daily-analysis-error-retry")
                            .outline()
                            .small()
                            .label("重试")
                            .on_click(cx.listener(|this, _, _, cx| this.reload(cx))),
                    ),
                ),
        )
}

/// Empty：Icon + 文案 + 刷新按钮（暂无销售数据）
fn render_empty(cx: &mut Context<DailyAnalysisView>, app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("daily-analysis-empty")
        .size_full()
        .items_center()
        .justify_center()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(
            v_flex()
                .items_center()
                .gap_3()
                .px_8()
                .py_10()
                .rounded(px(app_theme.radius_lg))
                .bg(app_theme.card_bg)
                .shadow(vec![app_theme.card_shadow_box()])
                .child(
                    Icon::new(Icon::empty())
                        .path("icons/package.svg")
                        .with_size(px(40.))
                        .text_color(app_theme.text_muted.opacity(0.7)),
                )
                .child(
                    div()
                        .text_size(px(14.))
                        .text_color(app_theme.text_muted)
                        .child("暂无销售数据"),
                )
                .child(
                    Button::new("daily-analysis-empty-refresh")
                        .outline()
                        .small()
                        .label("刷新")
                        .on_click(cx.listener(|this, _, _, cx| this.reload(cx))),
                ),
        )
}

/// Loaded：大标题区 + 筛选栏 + 数字带 + 销售趋势 + 维度下钻 + SKU 明细表
#[allow(clippy::too_many_arguments)]
fn render_loaded(
    window: &mut Window,
    cx: &mut Context<DailyAnalysisView>,
    app_theme: &AppTheme,
    data: &DailyAnalysisData,
    selected_project_id: Option<i64>,
    country: &'static str,
    projects: Vec<ManagedProject>,
    detail_table: Entity<DailyDetailTable>,
    breakdown_table: Entity<BreakdownTable>,
) -> impl IntoElement {
    let kpi = KpiSummary::from_rows(&data.summary_rows);
    let compare_kpi = KpiSummary::from_rows(&data.compare_summary_rows);
    let breakdown_title = match data.mode {
        AnalysisMode::AllProjects => "项目维度",
        AnalysisMode::SingleCountry => "国家维度",
        AnalysisMode::SingleProject => "维度下钻",
    };
    let view = cx.entity();
    let reduce = crate::motion::reduce_motion(cx);

    crate::motion::enter_fade_in(
        gpui::SharedString::from("daily-analysis-loaded-fade"),
        v_flex()
            .id("daily-analysis-loaded")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            // 大标题区：标题 + 副标题（页面层级最上层）
            .child(
                v_flex()
                    .gap_1()
                    .child(
                        div()
                            .text_2xl()
                            .font_semibold()
                            .text_color(app_theme.text_primary)
                            .child("销售数据"),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(app_theme.text_muted)
                            .child(format!(
                                "{} · {} · {} ~ {} · {} 天汇总",
                                data.console.project_name,
                                country_label(&data.console.country),
                                data.console.start_date,
                                data.console.end_date,
                                data.console.summary_days
                            )),
                    ),
            )
            // 筛选栏：项目 + 站点 + 刷新
            .child(render_filter_bar(
                &view,
                app_theme,
                &projects,
                selected_project_id,
                country,
            ))
            // 数字带（复用 stat_band；当前期 vs 对比期环比）
            .child(stat_band(&kpi, &compare_kpi, app_theme, window, cx))
            // 销售趋势：图表 v1.1（P3-2）接入前用「占位说明 + 每日列表」呈现
            .child(trend_card(&data.summary_rows, app_theme))
            // 维度下钻（全部项目 → 项目维度；跨站点 → 国家维度；单项目单站点 → 隐藏）
            .when(!data.breakdown.is_empty(), |page| {
                page.child(breakdown_card(breakdown_title, breakdown_table, app_theme))
            })
            // SKU 明细表
            .child(detail_table),
        reduce,
    )
}

// ---------------------------------------------------------------------------
// 筛选栏（项目 / 站点 / 刷新）
// ---------------------------------------------------------------------------

/// 筛选栏：项目选择 + 站点选择（gpui-component DropdownMenu）+ 刷新按钮。
///
/// on_click 是静态闭包（`&mut App`），通过捕获 `Entity<DailyAnalysisView>` 更新视图
/// （BLF-692 沉淀的「Button on_click 捕获 cx.entity()」范式）。
fn render_filter_bar(
    view: &Entity<DailyAnalysisView>,
    app_theme: &AppTheme,
    projects: &[ManagedProject],
    selected_project_id: Option<i64>,
    country: &'static str,
) -> impl IntoElement {
    // 菜单 builder 是 `Fn + 'static`（每次打开菜单重新执行）→ 项目列表必须转 owned
    // 才能被 move 捕获；选中项 label 在 builder 外算一次。
    let projects_owned = projects.to_vec();
    let project_label: SharedString = match selected_project_id {
        Some(id) => projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| SharedString::from(p.name.clone()))
            .unwrap_or_else(|| SharedString::from("全部项目")),
        None => SharedString::from("全部项目"),
    };
    let view_for_project = view.clone();
    let view_for_country = view.clone();
    let view_for_refresh = view.clone();

    h_flex()
        .id("daily-analysis-filters")
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
                        .text_color(app_theme.text_muted)
                        .child("项目"),
                )
                .child(
                    Button::new("daily-analysis-project-filter")
                        .outline()
                        .small()
                        .label(project_label)
                        .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                        .dropdown_menu_with_anchor(
                            gpui::Corner::BottomLeft,
                            move |menu, _window, _cx| {
                                // 每次打开菜单、每个 menu item 各克隆一次 Entity
                                // （on_click 是 move 闭包；Entity 非 Copy，不能共享捕获）。
                                let mut menu = menu.item(
                                    PopupMenuItem::new("全部项目")
                                        .checked(selected_project_id.is_none())
                                        .on_click({
                                            let view = view_for_project.clone();
                                            move |_, _window, cx| {
                                                view.update(cx, |this, cx| {
                                                    this.select_project(None, cx)
                                                });
                                            }
                                        }),
                                );
                                for project in &projects_owned {
                                    let checked = selected_project_id == Some(project.id);
                                    let id = project.id;
                                    let name = project.name.clone();
                                    let view = view_for_project.clone();
                                    menu = menu.item(
                                        PopupMenuItem::new(name).checked(checked).on_click(
                                            move |_, _window, cx| {
                                                view.update(cx, |this, cx| {
                                                    this.select_project(Some(id), cx)
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
                        .text_color(app_theme.text_muted)
                        .child("站点"),
                )
                .child(
                    Button::new("daily-analysis-country-filter")
                        .outline()
                        .small()
                        .label(country_label(country))
                        .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                        .dropdown_menu_with_anchor(
                            gpui::Corner::BottomLeft,
                            move |menu, _window, _cx| {
                                let mut menu = menu;
                                for (value, label) in COUNTRY_OPTIONS {
                                    let checked = country == value;
                                    let view = view_for_country.clone();
                                    menu = menu.item(
                                        PopupMenuItem::new(label).checked(checked).on_click(
                                            move |_, _window, cx| {
                                                view.update(cx, |this, cx| {
                                                    this.select_country(value, cx)
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
            div().flex_1(), // spacer
        )
        .child(
            Button::new("daily-analysis-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_, _window, cx| {
                    let view = view_for_refresh.clone();
                    view.update(cx, |this, cx| this.reload(cx));
                }),
        )
}

// ---------------------------------------------------------------------------
// 销售趋势卡（图表 v1.1 接入前：占位说明 + 每日列表）
// ---------------------------------------------------------------------------

/// 销售趋势卡：标题 + 说明 + 每日列表（日期 / 销售额 / 订单量 / 广告花费 / 转化率）。
/// 图表真渲染属 P3-2（gpui-component Chart），本棒按范围边界用列表呈现。
fn trend_card(rows: &[DailyAnalysisRow], app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("daily-analysis-trend")
        .w_full()
        .rounded(px(app_theme.radius_lg))
        .bg(app_theme.card_bg)
        .shadow(vec![app_theme.card_shadow_box()])
        .child(
            v_flex()
                .gap_1()
                .px_4()
                .py_3()
                .border_b_1()
                .border_color(app_theme.separator)
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(app_theme.text_primary)
                        .child("销售趋势"),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(app_theme.text_muted)
                        .child("每日销售额 / 订单量 / 广告花费 / 转化率（图表渲染 v1.1 接入 P3-2，当前列表呈现）"),
                ),
        )
        .child(
            div()
                .id("daily-analysis-trend-scroll")
                .max_h(px(360.))
                .overflow_y_scroll()
                .child(trend_table(rows, app_theme)),
        )
}

/// 趋势表（div 自绘：页内小型列表，无需 TableState 虚拟化）
fn trend_table(rows: &[DailyAnalysisRow], app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("daily-analysis-trend-rows")
        .gap_0()
        .child(trend_header(app_theme))
        .children(
            rows.iter()
                .enumerate()
                .map(|(ix, row)| trend_row(row, ix % 2 == 1, app_theme)),
        )
        .when(rows.is_empty(), |this| {
            this.child(
                div()
                    .px_4()
                    .py_8()
                    .text_center()
                    .text_sm()
                    .text_color(app_theme.text_muted)
                    .child("暂无每日数据"),
            )
        })
}

fn trend_header(app_theme: &AppTheme) -> impl IntoElement {
    h_flex()
        .id("trend-header")
        .px_4()
        .py_2()
        .gap_3()
        .border_b_1()
        .border_color(app_theme.separator)
        .text_xs()
        .font_weight(FontWeight::MEDIUM)
        .text_color(app_theme.text_muted)
        .child(div().w(px(104.)).child("日期"))
        .child(div().w(px(120.)).text_right().child("销售额"))
        .child(div().w(px(88.)).text_right().child("订单量"))
        .child(div().w(px(120.)).text_right().child("广告花费"))
        .child(div().flex_1().text_right().child("转化率"))
}

fn trend_row(row: &DailyAnalysisRow, tinted: bool, app_theme: &AppTheme) -> impl IntoElement {
    let bg = if tinted {
        app_theme.muted_fill.opacity(0.5)
    } else {
        app_theme.card_bg
    };
    h_flex()
        .id(SharedString::from(format!("trend-row-{}", row.date)))
        .px_4()
        .py_1p5()
        .gap_3()
        .bg(bg)
        .text_sm()
        .text_color(app_theme.text_secondary)
        .child(
            div()
                .w(px(104.))
                .text_color(app_theme.text_primary)
                .child(row.date.to_string()),
        )
        .child(
            div()
                .w(px(120.))
                .text_right()
                .child(fmt_money_precise(row.sales_amount)),
        )
        .child(
            div()
                .w(px(88.))
                .text_right()
                .child(fmt_num_precise(row.order_qty)),
        )
        .child(
            div()
                .w(px(120.))
                .text_right()
                .child(fmt_money_precise(row.ad_spend)),
        )
        .child(
            div()
                .flex_1()
                .text_right()
                .child(format!("{:.2}%", row.conversion_rate)),
        )
}

// ---------------------------------------------------------------------------
// 维度下钻表（项目 / 国家）
// ---------------------------------------------------------------------------

/// 维度下钻卡：标题 + 说明 + BreakdownTable
fn breakdown_card(
    title: &str,
    table: Entity<BreakdownTable>,
    app_theme: &AppTheme,
) -> impl IntoElement {
    v_flex()
        .id("daily-analysis-breakdown")
        .w_full()
        .rounded(px(app_theme.radius_lg))
        .bg(app_theme.card_bg)
        .shadow(vec![app_theme.card_shadow_box()])
        .child(
            v_flex()
                .gap_1()
                .px_4()
                .py_3()
                .border_b_1()
                .border_color(app_theme.separator)
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(app_theme.text_primary)
                        .child(SharedString::from(title.to_string())),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(app_theme.text_muted)
                        .child("各维度销售额 / 订单量 / 广告花费与环比（近 7 天）"),
                ),
        )
        .child(div().flex_1().min_h(px(160.)).child(table))
}

// ---------------------------------------------------------------------------
// SKU 明细表（gpui-component Table）
// ---------------------------------------------------------------------------

/// 明细列索引（与 `DetailTableDelegate::columns()` 顺序一致）
const COL_DATE: usize = 0;
const COL_SKU: usize = 1;
const COL_ORDERS: usize = 2;
const COL_SALES: usize = 3;
const COL_AD_SPEND: usize = 4;
const COL_IMPRESSIONS: usize = 5;
const COL_CLICKS: usize = 6;
const COL_CPC: usize = 7;
const COL_AD_ORDERS: usize = 8;
const COL_AVAILABLE: usize = 9;
const COL_UNITS: usize = 10;
const COL_CONVERSION: usize = 11;

/// SKU 明细表数据委托（非排序；按后端日期升序）
struct DetailTableDelegate {
    rows: Vec<DailyAnalysisDetailRow>,
    columns: Vec<Column>,
}

impl DetailTableDelegate {
    fn new(rows: Vec<DailyAnalysisDetailRow>) -> Self {
        Self {
            rows,
            columns: Self::columns(),
        }
    }

    fn columns() -> Vec<Column> {
        vec![
            Column::new("date", "日期").width(px(96.)).selectable(false),
            Column::new("sku", "SKU").width(px(150.)),
            Column::new("orders", "订单量").width(px(76.)).text_right(),
            Column::new("sales", "销售额").width(px(104.)).text_right(),
            Column::new("ad_spend", "广告花费")
                .width(px(104.))
                .text_right(),
            Column::new("impressions", "曝光量")
                .width(px(92.))
                .text_right(),
            Column::new("clicks", "点击量").width(px(76.)).text_right(),
            Column::new("cpc", "CPC").width(px(72.)).text_right(),
            Column::new("ad_orders", "广告订单")
                .width(px(84.))
                .text_right(),
            Column::new("available", "可售库存")
                .width(px(88.))
                .text_right(),
            Column::new("units", "销量").width(px(72.)).text_right(),
            Column::new("conversion", "转化率")
                .width(px(84.))
                .text_right(),
        ]
    }

    fn set_rows(&mut self, rows: Vec<DailyAnalysisDetailRow>) {
        self.rows = rows;
    }
}

impl TableDelegate for DetailTableDelegate {
    fn columns_count(&self, _: &App) -> usize {
        self.columns.len()
    }

    fn rows_count(&self, _: &App) -> usize {
        self.rows.len()
    }

    fn column(&self, col_ix: usize, _: &App) -> &Column {
        &self.columns[col_ix]
    }

    fn render_td(
        &mut self,
        row_ix: usize,
        col_ix: usize,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        let row = &self.rows[row_ix];
        let theme = AppTheme::current(cx);
        match col_ix {
            COL_DATE => div()
                .text_size(px(13.))
                .text_color(theme.text_primary)
                .child(row.date.to_string())
                .into_any_element(),
            COL_SKU => div()
                .text_size(px(13.))
                .font_weight(FontWeight::MEDIUM)
                .truncate()
                .child(row.sku.clone())
                .into_any_element(),
            COL_ORDERS => right_cell(fmt_num_precise(row.order_qty), &theme).into_any_element(),
            COL_SALES => right_cell(fmt_money_precise(row.sales_amount), &theme).into_any_element(),
            COL_AD_SPEND => {
                muted_right_cell(fmt_money_precise(row.ad_spend), &theme).into_any_element()
            }
            COL_IMPRESSIONS => {
                right_cell(fmt_num_precise(row.impressions), &theme).into_any_element()
            }
            COL_CLICKS => right_cell(fmt_num_precise(row.clicks), &theme).into_any_element(),
            COL_CPC => right_cell(format!("{:.2}", row.cpc), &theme).into_any_element(),
            COL_AD_ORDERS => right_cell(fmt_num_precise(row.ad_orders), &theme).into_any_element(),
            COL_AVAILABLE => {
                right_cell(fmt_num_precise(row.available_qty), &theme).into_any_element()
            }
            COL_UNITS => right_cell(fmt_num_precise(row.units_ordered), &theme).into_any_element(),
            COL_CONVERSION => {
                right_cell(format!("{:.2}%", row.conversion_rate), &theme).into_any_element()
            }
            _ => div().into_any_element(),
        }
    }

    /// 空态：Inbox 图标 + 文案
    fn render_empty(
        &mut self,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap_2()
            .text_color(theme.text_muted)
            .child(Icon::new(IconName::Inbox).with_size(px(24.)))
            .child(div().text_size(px(13.)).child("暂无 SKU 明细数据"))
            .into_any_element()
    }
}

/// 右对齐数值单元格（主色）
fn right_cell(text: String, theme: &AppTheme) -> impl IntoElement {
    div()
        .text_right()
        .text_size(px(13.))
        .text_color(theme.text_secondary)
        .child(text)
}

/// 右对齐数值单元格（弱化色：广告花费等次级指标）
fn muted_right_cell(text: String, theme: &AppTheme) -> impl IntoElement {
    div()
        .text_right()
        .text_size(px(13.))
        .text_color(theme.text_muted)
        .child(text)
}

/// SKU 明细表 Widget（懒建 TableState；`set_data` 注入行，幂等）
struct DailyDetailTable {
    table: Option<Entity<TableState<DetailTableDelegate>>>,
    rows: Vec<DailyAnalysisDetailRow>,
}

impl DailyDetailTable {
    fn new() -> Self {
        Self {
            table: None,
            rows: Vec::new(),
        }
    }

    /// 注入明细行（无变化时跳过）
    fn set_data(&mut self, rows: Vec<DailyAnalysisDetailRow>, cx: &mut Context<Self>) {
        if rows == self.rows {
            return;
        }
        self.rows = rows;
        if let Some(table) = &self.table {
            let rows = self.rows.clone();
            table.update(cx, |state, cx| {
                state.delegate_mut().set_rows(rows);
                state.refresh(cx);
                cx.notify();
            });
        }
    }

    #[allow(dead_code)]
    fn rows(&self) -> &[DailyAnalysisDetailRow] {
        &self.rows
    }
}

impl Default for DailyDetailTable {
    fn default() -> Self {
        Self::new()
    }
}

impl Render for DailyDetailTable {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let table = self.table.get_or_insert_with(|| {
            let delegate = DetailTableDelegate::new(self.rows.clone());
            cx.new(|cx| TableState::new(delegate, window, cx))
        });
        let theme = AppTheme::current(cx);
        v_flex()
            .id("daily-analysis-detail")
            .w_full()
            .rounded(px(theme.radius_lg))
            .bg(theme.card_bg)
            .shadow(vec![theme.card_shadow_box()])
            .overflow_y_scroll()
            .child(
                v_flex()
                    .gap_1()
                    .px_4()
                    .py_3()
                    .border_b_1()
                    .border_color(theme.separator)
                    .child(
                        div()
                            .text_base()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text_primary)
                            .child("SKU 明细"),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.text_muted)
                            .child(format!("{} 行 SKU 粒度明细", self.rows.len())),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h(px(220.))
                    .child(Table::new(table).bordered(false).large()),
            )
    }
}

// ---------------------------------------------------------------------------
// 维度下钻表（gpui-component Table）
// ---------------------------------------------------------------------------

/// 下钻列索引（与 `BreakdownTableDelegate::columns()` 顺序一致）
const COL_NAME: usize = 0;
const COL_BREAK_SALES: usize = 1;
const COL_BREAK_ORDERS: usize = 2;
const COL_BREAK_AD_SPEND: usize = 3;
const COL_BREAK_CHANGE: usize = 4;

/// 维度下钻数据委托（非排序；销售额降序 / 站点顺序已在上游排好）
struct BreakdownTableDelegate {
    rows: Vec<BreakdownRow>,
    columns: Vec<Column>,
}

impl BreakdownTableDelegate {
    fn new(rows: Vec<BreakdownRow>) -> Self {
        Self {
            rows,
            columns: Self::columns(),
        }
    }

    fn columns() -> Vec<Column> {
        vec![
            Column::new("name", "名称")
                .width(px(200.))
                .selectable(false),
            Column::new("sales", "销售额").width(px(120.)).text_right(),
            Column::new("orders", "订单量").width(px(90.)).text_right(),
            Column::new("ad_spend", "广告花费")
                .width(px(120.))
                .text_right(),
            Column::new("change", "环比").width(px(110.)).text_right(),
        ]
    }

    fn set_rows(&mut self, rows: Vec<BreakdownRow>) {
        self.rows = rows;
    }
}

impl TableDelegate for BreakdownTableDelegate {
    fn columns_count(&self, _: &App) -> usize {
        self.columns.len()
    }

    fn rows_count(&self, _: &App) -> usize {
        self.rows.len()
    }

    fn column(&self, col_ix: usize, _: &App) -> &Column {
        &self.columns[col_ix]
    }

    fn render_td(
        &mut self,
        row_ix: usize,
        col_ix: usize,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        let row = &self.rows[row_ix];
        let theme = AppTheme::current(cx);
        match col_ix {
            COL_NAME => div()
                .text_size(px(14.))
                .font_weight(FontWeight::MEDIUM)
                .truncate()
                .child(row.name.clone())
                .into_any_element(),
            COL_BREAK_SALES => right_cell(fmt_money_precise(row.sales), &theme).into_any_element(),
            COL_BREAK_ORDERS => right_cell(fmt_num_precise(row.orders), &theme).into_any_element(),
            COL_BREAK_AD_SPEND => {
                muted_right_cell(fmt_money_precise(row.ad_spend), &theme).into_any_element()
            }
            COL_BREAK_CHANGE => render_change_cell(row.change, &theme).into_any_element(),
            _ => div().into_any_element(),
        }
    }
}

/// 环比单元格：图标 + 数值（绿 ↑ / 红 ↓ / 灰 — / 无数据 —）
fn render_change_cell(change: Option<f64>, theme: &AppTheme) -> impl IntoElement {
    let (icon, color, text) = match change {
        None => (IconName::Minus, theme.text_muted, "—".to_string()),
        Some(v) if v > 0.5 => (IconName::ArrowUp, theme.success, format!("{v:.1}%")),
        Some(v) if v < -0.5 => (
            IconName::ArrowDown,
            theme.danger,
            format!("{:.1}%", v.abs()),
        ),
        Some(v) => (IconName::Minus, theme.text_muted, format!("{v:.1}%")),
    };
    h_flex()
        .w_full()
        .justify_end()
        .items_center()
        .gap_1()
        .text_size(px(12.))
        .text_color(color)
        .cursor(CursorStyle::PointingHand)
        .child(Icon::new(icon).with_size(px(12.)).text_color(color))
        .child(div().child(text))
}

/// 维度下钻表 Widget（懒建 TableState；`set_data` 注入行，幂等）
struct BreakdownTable {
    table: Option<Entity<TableState<BreakdownTableDelegate>>>,
    rows: Vec<BreakdownRow>,
}

impl BreakdownTable {
    fn new() -> Self {
        Self {
            table: None,
            rows: Vec::new(),
        }
    }

    /// 注入下钻行（无变化时跳过）
    fn set_data(&mut self, rows: Vec<BreakdownRow>, cx: &mut Context<Self>) {
        if rows == self.rows {
            return;
        }
        self.rows = rows;
        if let Some(table) = &self.table {
            let rows = self.rows.clone();
            table.update(cx, |state, cx| {
                state.delegate_mut().set_rows(rows);
                state.refresh(cx);
                cx.notify();
            });
        }
    }

    #[allow(dead_code)]
    fn rows(&self) -> &[BreakdownRow] {
        &self.rows
    }
}

impl Default for BreakdownTable {
    fn default() -> Self {
        Self::new()
    }
}

impl Render for BreakdownTable {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let table = self.table.get_or_insert_with(|| {
            let delegate = BreakdownTableDelegate::new(self.rows.clone());
            cx.new(|cx| TableState::new(delegate, window, cx))
        });
        div()
            .id("daily-analysis-breakdown-table")
            .w_full()
            .h_full()
            .child(Table::new(table).bordered(false).large())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use std::collections::HashMap;

    // ---------- 纯函数：模式推导 ----------

    #[test]
    fn mode_for_matches_frontend_loaddata_branches() {
        assert_eq!(mode_for(None, "US"), Some(AnalysisMode::AllProjects));
        assert_eq!(mode_for(None, "DE"), Some(AnalysisMode::AllProjects));
        assert_eq!(mode_for(Some(1), "US"), Some(AnalysisMode::SingleProject));
        assert_eq!(mode_for(Some(1), "ALL"), Some(AnalysisMode::SingleCountry));
        // 全部项目 × 全部站点：后端不支持聚合矩阵 → None（调用方报错）
        assert_eq!(mode_for(None, "ALL"), None);
    }

    #[test]
    fn country_label_matches_frontend_options() {
        assert_eq!(country_label("US"), "美国站 (US)");
        assert_eq!(country_label("DE"), "德国站 (DE)");
        assert_eq!(country_label("UK"), "英国站 (UK)");
        assert_eq!(country_label("ALL"), "全部站点");
        assert_eq!(country_label("XX"), "XX");
    }

    // ---------- 纯函数：维度下钻 ----------

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

    fn row(date: &str, sales: f64, orders: i64, ad_spend: f64) -> DailyAnalysisRow {
        DailyAnalysisRow {
            date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            order_qty: orders,
            sales_amount: sales,
            impressions: 0,
            clicks: 0,
            cpc: 0.0,
            ad_spend,
            ad_orders: 0,
            available_qty: 0,
            page_views: 0,
            units_ordered: 0,
            sessions: 0,
            ordered_sales_amount: 0.0,
            conversion_rate: 0.0,
        }
    }

    #[test]
    fn project_breakdown_sums_and_sorts_by_sales() {
        let mut breakdown = HashMap::new();
        breakdown.insert(
            1i64,
            ProjectBreakdownEntry {
                project_name: "项目 A".to_string(),
                summary_rows: vec![
                    row("2026-08-12", 1000.0, 10, 50.0),
                    row("2026-08-13", 2000.0, 20, 100.0),
                ],
                detail_rows: Vec::new(),
            },
        );
        breakdown.insert(
            2i64,
            ProjectBreakdownEntry {
                project_name: "项目 B".to_string(),
                summary_rows: vec![row("2026-08-13", 300.0, 5, 20.0)],
                detail_rows: Vec::new(),
            },
        );
        // 项目 3 有列表但无聚合行 → 不进入下钻
        breakdown.insert(
            3i64,
            ProjectBreakdownEntry {
                project_name: "项目 C".to_string(),
                summary_rows: Vec::new(),
                detail_rows: Vec::new(),
            },
        );
        let mut compare = HashMap::new();
        compare.insert(
            1i64,
            ProjectBreakdownEntry {
                project_name: "项目 A".to_string(),
                summary_rows: vec![row("2026-08-06", 2500.0, 10, 0.0)],
                detail_rows: Vec::new(),
            },
        );

        let rows = compute_project_breakdown(
            &breakdown,
            Some(&compare),
            &[
                project(1, "项目 A"),
                project(2, "项目 B"),
                project(3, "项目 C"),
            ],
        );
        // 销售额降序：A(3000) > B(300)；C 无数据被过滤
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "项目 A");
        assert_eq!(rows[0].sales, 3000.0);
        assert_eq!(rows[0].orders, 30);
        assert_eq!(rows[0].ad_spend, 150.0);
        // 环比 = (3000 - 2500) / 2500 × 100 = 20%
        assert_eq!(rows[0].change, Some(20.0));
        assert_eq!(rows[1].name, "项目 B");
        assert_eq!(rows[1].change, None); // 无对比期
    }

    #[test]
    fn country_breakdown_orders_by_frontend_site_order() {
        let mut breakdown = HashMap::new();
        breakdown.insert(
            "UK".to_string(),
            CountryBreakdownEntry {
                summary_rows: vec![row("2026-08-13", 500.0, 8, 30.0)],
                detail_rows: Vec::new(),
                currency: "USD".to_string(),
                source_currency: Some("GBP".to_string()),
            },
        );
        breakdown.insert(
            "US".to_string(),
            CountryBreakdownEntry {
                summary_rows: vec![row("2026-08-13", 900.0, 12, 40.0)],
                detail_rows: Vec::new(),
                currency: "USD".to_string(),
                source_currency: Some("USD".to_string()),
            },
        );
        // DE 无数据 → 不进下钻
        breakdown.insert(
            "DE".to_string(),
            CountryBreakdownEntry {
                summary_rows: Vec::new(),
                detail_rows: Vec::new(),
                currency: "USD".to_string(),
                source_currency: Some("EUR".to_string()),
            },
        );

        let rows = compute_country_breakdown(&breakdown, None);
        // 站点顺序：US → UK（DE 无数据被过滤）
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "美国站 (US)");
        assert_eq!(rows[0].sales, 900.0);
        assert_eq!(rows[1].name, "英国站 (UK)");
        assert_eq!(rows[1].change, None);
    }

    // ---------- 纯状态机转移 ----------

    fn sample_data() -> DailyAnalysisData {
        DailyAnalysisData {
            projects: vec![project(1, "测试项目")],
            mode: AnalysisMode::AllProjects,
            console: DailyAnalysisConsoleResponse {
                project_id: 0,
                project_name: "全部项目".to_string(),
                country: "US".to_string(),
                start_date: "2026-08-07".to_string(),
                end_date: "2026-08-13".to_string(),
                requested_days: 0,
                summary_days: 1,
                detail_rows: 0,
                sales_source_days: 0,
                ad_source_days: 0,
                inventory_source_days: 0,
                business_source_days: 0,
                missing_dates: Vec::new(),
                latest_sales_date: None,
                latest_ad_date: None,
                latest_inventory_date: None,
                latest_business_date: None,
            },
            summary_rows: vec![row("2026-08-13", 1000.0, 10, 50.0)],
            detail_rows: Vec::new(),
            breakdown: Vec::new(),
            compare_summary_rows: Vec::new(),
        }
    }

    #[test]
    fn from_fetch_result_maps_to_loaded_empty_error() {
        // 成功且有数据 → Loaded
        let data = sample_data();
        assert_eq!(
            DailyAnalysisState::from_fetch_result(Ok(data.clone())),
            DailyAnalysisState::Loaded(data)
        );

        // 无项目 → Empty
        let no_projects = DailyAnalysisData {
            projects: Vec::new(),
            ..sample_data()
        };
        assert_eq!(
            DailyAnalysisState::from_fetch_result(Ok(no_projects)),
            DailyAnalysisState::Empty
        );

        // 有项目但无聚合行 → Empty（对齐 frontend hasData）
        let no_rows = DailyAnalysisData {
            summary_rows: Vec::new(),
            ..sample_data()
        };
        assert_eq!(
            DailyAnalysisState::from_fetch_result(Ok(no_rows)),
            DailyAnalysisState::Empty
        );

        // 失败 → Error（保留后端 detail 文案）
        assert_eq!(
            DailyAnalysisState::from_fetch_result(Err("接口 500".to_string())),
            DailyAnalysisState::Error("接口 500".to_string())
        );
    }

    #[test]
    fn data_is_empty_judgement() {
        assert!(DailyAnalysisData {
            projects: Vec::new(),
            ..sample_data()
        }
        .is_empty());
        assert!(DailyAnalysisData {
            summary_rows: Vec::new(),
            ..sample_data()
        }
        .is_empty());
        assert!(!sample_data().is_empty());
    }

    // ---------- 视图级状态转移 / 竞态保护（TestAppContext，无真实网络） ----------

    /// 构造视图。client 指向不可达地址（127.0.0.1:1 立即 connection refused），
    /// 测试只驱动同步的 apply_result / select_project / select_country。
    fn create_view(cx: &mut gpui::TestAppContext) -> Entity<DailyAnalysisView> {
        cx.update(|cx| {
            let client = Client::new("http://127.0.0.1:1");
            cx.new(|cx| DailyAnalysisView::new(cx, client))
        })
    }

    fn read_state(
        cx: &mut gpui::TestAppContext,
        view: &Entity<DailyAnalysisView>,
    ) -> DailyAnalysisState {
        cx.read(|app| view.read(app).state.read(app).clone())
    }

    #[gpui::test]
    async fn initial_state_is_loading(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        assert_eq!(read_state(cx, &view), DailyAnalysisState::Loading);
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
        assert_eq!(read_state(cx, &view), DailyAnalysisState::Loading);

        // 最新请求 2 的响应正常落点
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.apply_result(2, Ok(data.clone()), cx);
            });
        });
        assert_eq!(read_state(cx, &view), DailyAnalysisState::Loaded(data));
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
            DailyAnalysisState::Error("接口 500".to_string())
        );

        // 无项目 → Empty
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 2;
                this.apply_result(
                    2,
                    Ok(DailyAnalysisData {
                        projects: Vec::new(),
                        ..sample_data()
                    }),
                    cx,
                );
            });
        });
        assert_eq!(read_state(cx, &view), DailyAnalysisState::Empty);
    }

    #[gpui::test]
    async fn select_project_and_country_trigger_reload(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                assert_eq!(this.selected_project_id, None);
                assert_eq!(this.country, "US");
                assert_eq!(this.latest_request_id, 0);

                // 切换到项目 3：更新选中 + 递增请求序号 + 进入 Loading
                this.select_project(Some(3), cx);
                assert_eq!(this.selected_project_id, Some(3));
                assert_eq!(this.latest_request_id, 1);
                assert_eq!(this.current_state(cx), DailyAnalysisState::Loading);

                // 重复选择同一项目：no-op（不递增序号）
                this.select_project(Some(3), cx);
                assert_eq!(this.latest_request_id, 1);

                // 切回全部项目：再次触发
                this.select_project(None, cx);
                assert_eq!(this.selected_project_id, None);
                assert_eq!(this.latest_request_id, 2);

                // 切换站点 → reload；同一站点 no-op
                this.select_country("ALL", cx);
                assert_eq!(this.country, "ALL");
                assert_eq!(this.latest_request_id, 3);
                this.select_country("ALL", cx);
                assert_eq!(this.latest_request_id, 3);
            });
        });
    }

    #[gpui::test]
    async fn apply_result_feeds_detail_and_breakdown_tables(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        let mut data = sample_data();
        data.detail_rows = vec![DailyAnalysisDetailRow {
            date: NaiveDate::parse_from_str("2026-08-13", "%Y-%m-%d").unwrap(),
            sku: "B0-A-001".to_string(),
            asin: None,
            order_qty: 4,
            sales_amount: 360.0,
            impressions: 1800,
            clicks: 60,
            cpc: 0.48,
            ad_spend: 28.8,
            ad_orders: 1,
            available_qty: 30,
            in_transit_qty: 12,
            page_views: 96,
            units_ordered: 3,
            sessions: 80,
            ordered_sales_amount: 350.0,
            conversion_rate: 3.12,
        }];
        data.breakdown = vec![BreakdownRow {
            name: "测试项目".to_string(),
            sales: 1000.0,
            orders: 10,
            ad_spend: 50.0,
            change: None,
        }];

        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Ok(data.clone()), cx);
            });
        });
        cx.read(|app| {
            let state = view.read(app).state.read(app).clone();
            assert_eq!(state, DailyAnalysisState::Loaded(data));
            assert_eq!(
                view.read(app).detail_table.read(app).rows().len(),
                1,
                "明细表应收到 1 行"
            );
            assert_eq!(
                view.read(app).breakdown_table.read(app).rows().len(),
                1,
                "下钻表应收到 1 行"
            );
        });

        // 失败结果不喂表格（保持原有行）
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 2;
                this.apply_result(2, Err("接口 500".to_string()), cx);
            });
        });
        cx.read(|app| {
            assert_eq!(view.read(app).detail_table.read(app).rows().len(), 1);
            assert_eq!(view.read(app).breakdown_table.read(app).rows().len(), 1);
        });
    }

    // ---------- 渲染冒烟（亮 / 暗两态） ----------

    /// 测试宿主：仅渲染 DailyAnalysisView（渲染冒烟用）
    struct DailyAnalysisHost {
        view: Entity<DailyAnalysisView>,
    }

    impl gpui::Render for DailyAnalysisHost {
        fn render(
            &mut self,
            _window: &mut gpui::Window,
            _cx: &mut gpui::Context<Self>,
        ) -> impl IntoElement {
            self.view.clone().into_any_element()
        }
    }

    #[gpui::test]
    async fn daily_analysis_renders_in_both_modes(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let view = create_view(cx);
        // 驱动到 Loaded（1 个项目 + 1 行聚合 + 明细 + 下钻）
        let mut data = sample_data();
        data.detail_rows = vec![DailyAnalysisDetailRow {
            date: NaiveDate::parse_from_str("2026-08-13", "%Y-%m-%d").unwrap(),
            sku: "B0-A-001".to_string(),
            asin: None,
            order_qty: 4,
            sales_amount: 360.0,
            impressions: 1800,
            clicks: 60,
            cpc: 0.48,
            ad_spend: 28.8,
            ad_orders: 1,
            available_qty: 30,
            in_transit_qty: 12,
            page_views: 96,
            units_ordered: 3,
            sessions: 80,
            ordered_sales_amount: 350.0,
            conversion_rate: 3.12,
        }];
        data.breakdown = vec![BreakdownRow {
            name: "测试项目".to_string(),
            sales: 1000.0,
            orders: 10,
            ad_spend: 50.0,
            change: Some(20.0),
        }];
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Ok(data), cx);
            });
        });
        // 窗口宿主包装 Entity → 首帧渲染完整路径（筛选栏 + 数字带 + 趋势 + 下钻 + 明细表）
        let (_host, cx2) =
            cx.add_window_view(|_window, _cx| DailyAnalysisHost { view: view.clone() });
        cx2.read(|app| assert!(!crate::theme::AppTheme::current(app).is_dark()));

        // 经窗口上下文切深色：重新渲染不 panic，语义色板跟随
        cx2.update(|_window, app| {
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, app);
        });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    #[gpui::test]
    async fn daily_analysis_error_state_renders(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Err("暂不支持「全部项目 × 全部站点」".to_string()), cx);
            });
        });
        let (_host, _cx2) =
            cx.add_window_view(|_window, _cx| DailyAnalysisHost { view: view.clone() });
    }

    #[gpui::test]
    async fn daily_analysis_loading_state_renders(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let view = create_view(cx);
        let (_host, _cx2) =
            cx.add_window_view(|_window, _cx| DailyAnalysisHost { view: view.clone() });
    }
}
