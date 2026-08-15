//! 运营-销售数据视图（P3-1 / BLF-701，frontend `app/dashboard/operations/daily-analysis/` 的 GPUI 等价）
//!
//! 在 Dashboard 既有数据管线（`daily_analysis_all` + 四态状态机 + 竞态保护）之上
//! 建立「业务页」范式：
//!
//! - **筛选**：项目（Select）/ 站点（US/DE/UK/全部站点）/ 周期（近 7 天 / 近 30 天），
//!   任一项变化即重拉（对齐 frontend `useUrlParam` + `loadData`）；
//! - **三路数据分发**（对齐 frontend `daily-analysis-client.tsx`）：全部项目+具体站点 →
//!   `GET /daily-analysis/all`（`project_ids` 逗号连接）；单项目+全部站点 →
//!   `GET /daily-analysis/all-countries`（跨国家聚合）；单项目+具体站点 →
//!   `GET /daily-analysis`（P3-1 新增的 client 方法）；当前期 + 对比期并行拉取
//!   （`tokio::join!`），对比期失败不阻塞主数据；
//! - **数字带**：复用 `stat_band`（`KpiSummary` 口径 + 环比 delta）；
//! - **维度下钻**：项目维度（`project_breakdown` 展开，含环比）或站点维度
//!   （`country_breakdown` 展开），可排序列（销售额 / 广告花费 / 订单量）；
//! - **销售明细**：每日汇总（summary_rows）与 SKU 明细（detail_rows）双 Tab，
//!   字段与 frontend 展示列 1:1。
//!
//! 组件策略（沿用 Phase 2 基线）：表格 `gpui_component::table::Table`（列排序 /
//! 虚拟滚动），筛选器 `select::Select` + `tab::TabBar`（segmented），Loading /
//! Error / Empty 复用 Dashboard 的四态渲染骨架（Skeleton / Alert / Icon+文案）。
//!
//! 与 frontend 的已知差异（有意保留，GUI 能力边界）：
//! - 无 Excel 导出、无图表（真图表归 P3-2）、无 SKU 搜索筛选、无 URL search param 同步；
//! - 「全部项目 × 全部站点」后端不支持：Error 态给出明确提示（对齐 frontend toast 文案）。

use std::collections::HashMap;

use chrono::{Days, NaiveDate};
use gpui::{
    div, prelude::*, px, App, AsyncApp, Context, CursorStyle, Entity, FontWeight, Render,
    SharedString, WeakEntity, Window,
};
use gpui_component::{
    alert::Alert,
    button::Button,
    h_flex,
    select::{SearchableVec, Select, SelectEvent, SelectState},
    skeleton::Skeleton,
    spinner::Spinner,
    tab::{Tab, TabBar},
    table::{Column, ColumnSort, Table, TableDelegate, TableState},
    v_flex, Icon, IconName, IndexPath, Sizable, StyledExt,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::dashboard::{
    CountryBreakdownEntry, DailyAnalysisDetailRow, DailyAnalysisRow, KpiSummary,
    ProjectBreakdownEntry,
};

use crate::theme::AppTheme;
use crate::views::dashboard::{last_7_days_window, ProjectId};
use crate::views::stat_band::{stat_band, stat_band_skeleton};
use crate::widgets::top_projects::{fmt_money_precise, fmt_num_precise};

/// 本页在侧栏中的 URL（root.rs 据此路由到本视图；与 gui-domain::sidebar 的销售数据条目一致）
pub const DAILY_ANALYSIS_URL: &str = "/dashboard/operations/daily-analysis";

/// 「全部站点」哨兵值（对齐 frontend `CountryOption 'ALL'`；后端 normalize_country 接受）
pub const COUNTRY_ALL: &str = "ALL";

/// 站点选项（对齐 frontend `COUNTRY_OPTIONS` 顺序：具体站点在前、全部站点兜底）
pub const COUNTRY_OPTIONS: [&str; 4] = ["US", "DE", "UK", "ALL"];

/// 站点中文标签（对齐 frontend `getCountryLabel` 的口径子集）
pub fn country_label(country: &str) -> &'static str {
    match country {
        "US" => "美国站",
        "DE" => "德国站",
        "UK" => "英国站",
        _ => "全部站点",
    }
}

/// 周期预设
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WindowPreset {
    /// 近 7 天（昨日为界，与 Dashboard 同一窗口口径）
    #[default]
    Last7Days,
    /// 近 30 天（昨日为界）
    Last30Days,
}

impl WindowPreset {
    pub fn label(self) -> &'static str {
        match self {
            Self::Last7Days => "近 7 天",
            Self::Last30Days => "近 30 天",
        }
    }
}

/// 周期窗口（对齐 frontend `lastSevenDaysRange`：to = 昨天，窗口含 to 共 N 天）
pub fn window_for(preset: WindowPreset, today: NaiveDate) -> (NaiveDate, NaiveDate) {
    match preset {
        WindowPreset::Last7Days => last_7_days_window(today),
        WindowPreset::Last30Days => {
            let to = today.pred_opt().unwrap_or(today);
            let from = to.checked_sub_days(Days::new(29)).unwrap_or(to);
            (from, to)
        }
    }
}

/// 对比期窗口：与当前窗口等长的紧邻前一个窗口（对齐 frontend `getPreviousPeriodRange`
/// 的非整月分支：`prevTo = from - 1`，`prevFrom = prevTo - dayCount + 1`）。
pub fn previous_window(window: (NaiveDate, NaiveDate)) -> (NaiveDate, NaiveDate) {
    let (from, to) = window;
    let span_days = (to - from).num_days().max(0) as u64;
    let prev_to = from.pred_opt().unwrap_or(from);
    let prev_from = prev_to
        .checked_sub_days(Days::new(span_days))
        .unwrap_or(prev_to);
    (prev_from, prev_to)
}

/// 加载模式（对齐 frontend 三路分发）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadMode {
    /// 全部项目 + 具体站点 → `GET /daily-analysis/all`
    AllProjects,
    /// 单项目 + 全部站点 → `GET /daily-analysis/all-countries`
    AllCountries,
    /// 单项目 + 具体站点 → `GET /daily-analysis`
    SingleProject,
}

/// 由筛选条件推导加载模式（纯函数，供测试）
pub fn load_mode(selected_project_id: Option<ProjectId>, country: &str) -> LoadMode {
    match (selected_project_id, country == COUNTRY_ALL) {
        (None, _) => LoadMode::AllProjects,
        (Some(_), true) => LoadMode::AllCountries,
        (Some(_), false) => LoadMode::SingleProject,
    }
}

/// 维度下钻行（项目维度或站点维度；站点维度无环比）
#[derive(Debug, Clone, PartialEq)]
pub struct DimensionRow {
    pub name: String,
    pub total_sales: f64,
    pub total_ad_spend: f64,
    pub total_orders: i64,
    /// 销售额环比（%）；无对比期 / 对比期为 0 → None（显示「—」）
    pub change: Option<f64>,
    /// 站点维度时标注源币种（如 DE → EUR），项目维度为 None
    pub source_currency: Option<String>,
}

/// 项目维度聚合（纯函数）：只统计能取到 breakdown 且 summary_rows 非空的项目，
/// 按销售额降序（不截断——本页是下钻视图，对齐 frontend 项目维度口径）。
pub fn compute_project_totals(
    project_breakdown: &HashMap<i64, ProjectBreakdownEntry>,
    compare_breakdown: Option<&HashMap<i64, ProjectBreakdownEntry>>,
    projects: &[ManagedProject],
) -> Vec<DimensionRow> {
    let mut rows: Vec<DimensionRow> = Vec::new();
    for project in projects {
        let Some(entry) = project_breakdown.get(&project.id) else {
            continue;
        };
        if entry.summary_rows.is_empty() {
            continue;
        }
        let mut total_sales = 0.0f64;
        let mut total_ad_spend = 0.0f64;
        let mut total_orders = 0i64;
        for r in &entry.summary_rows {
            total_sales += r.sales_amount;
            total_ad_spend += r.ad_spend;
            total_orders += r.order_qty;
        }
        let prev_sales: f64 = compare_breakdown
            .and_then(|map| map.get(&project.id))
            .map(|e| e.summary_rows.iter().map(|r| r.sales_amount).sum())
            .unwrap_or(0.0);
        let change = if prev_sales > 0.0 {
            Some((total_sales - prev_sales) / prev_sales * 100.0)
        } else {
            None
        };
        rows.push(DimensionRow {
            name: if entry.project_name.is_empty() {
                project.name.clone()
            } else {
                entry.project_name.clone()
            },
            total_sales,
            total_ad_spend,
            total_orders,
            change,
            source_currency: None,
        });
    }
    rows.sort_by(|a, b| b.total_sales.total_cmp(&a.total_sales));
    rows
}

/// 站点维度聚合（纯函数）：`country_breakdown` 展开，按销售额降序。
pub fn compute_country_totals(
    country_breakdown: &HashMap<String, CountryBreakdownEntry>,
) -> Vec<DimensionRow> {
    let mut rows: Vec<DimensionRow> = country_breakdown
        .iter()
        .map(|(country, entry)| {
            let mut total_sales = 0.0f64;
            let mut total_ad_spend = 0.0f64;
            let mut total_orders = 0i64;
            for r in &entry.summary_rows {
                total_sales += r.sales_amount;
                total_ad_spend += r.ad_spend;
                total_orders += r.order_qty;
            }
            DimensionRow {
                name: country_label(country).to_string(),
                total_sales,
                total_ad_spend,
                total_orders,
                change: None,
                source_currency: entry.source_currency.clone(),
            }
        })
        .collect();
    rows.sort_by(|a, b| b.total_sales.total_cmp(&a.total_sales));
    rows
}

/// 销售数据载荷（Loaded 持有）
#[derive(Debug, Clone, PartialEq)]
pub struct DailyAnalysisData {
    /// 当前用户可管理的项目列表（reload 时刷新）
    pub projects: Vec<ManagedProject>,
    /// 本次请求的加载模式
    pub mode: LoadMode,
    pub country: String,
    pub window: (NaiveDate, NaiveDate),
    /// 每日汇总行（对齐 frontend summary 表）
    pub summary_rows: Vec<DailyAnalysisRow>,
    /// SKU 粒度明细行（对齐 frontend detail 表）
    pub detail_rows: Vec<DailyAnalysisDetailRow>,
    /// 维度下钻行（项目维度 或 站点维度）
    pub dimension_rows: Vec<DimensionRow>,
    /// 跨国家模式下的统一币种（如 "USD"）；其余模式 None
    pub currency: Option<String>,
    /// 币种说明（跨国家模式后端返回；其余模式 None）
    pub currency_note: Option<String>,
    /// 对比期 KPI（数字带环比）；对比期拉取失败 / 无数据 → None（环比显示「—」）
    pub compare_kpi: Option<KpiSummary>,
}

impl DailyAnalysisData {
    /// 空态判定（对齐 frontend `hasData`）：没有任何汇总行 → 空态
    pub fn is_empty(&self) -> bool {
        self.summary_rows.is_empty()
    }
}

/// 四态状态机（沿用 Dashboard 模式）
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum DailyAnalysisState {
    Loading,
    Loaded(DailyAnalysisData),
    Empty,
    Error(String),
}

impl DailyAnalysisState {
    /// 状态转移：拉取结果 → 落点状态（唯一合法的「拉取完成」转移）
    pub fn from_fetch_result(result: Result<DailyAnalysisData, String>) -> Self {
        match result {
            Ok(data) if data.is_empty() => Self::Empty,
            Ok(data) => Self::Loaded(data),
            Err(msg) => Self::Error(msg),
        }
    }
}

/// 明细 Tab
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetailTab {
    Summary,
    SkuDetail,
}

/// 销售数据视图（四态状态机 + 筛选重拉 + 请求竞态保护）
pub struct DailyAnalysisView {
    state: Entity<DailyAnalysisState>,
    client: Client,
    /// 项目列表（reload 刷新；供项目 Select 选项与维度表回退名）
    projects: Vec<ManagedProject>,
    /// 当前选中项目；`None` = 全部项目
    selected_project_id: Option<ProjectId>,
    country: String,
    window_preset: WindowPreset,
    active_tab: DetailTab,
    /// 请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,
    /// 项目筛选器（SelectState 需 Window 创建 → 首个渲染帧懒建）
    project_select: Option<Entity<SelectState<SearchableVec<SharedString>>>>,
    /// 已注入 Select 的项目指纹（全部项目 id 连接）；变化时同步选项
    select_fingerprint: String,
    /// 维度下钻表
    dimension_table: Option<Entity<TableState<DimensionDelegate>>>,
    /// 每日汇总表
    summary_table: Option<Entity<TableState<SummaryDelegate>>>,
    /// SKU 明细表
    detail_table: Option<Entity<TableState<DetailDelegate>>>,
    /// 表格行缓存（建表 / 刷新共用；apply_result 先落这里）
    dimension_rows: Vec<DimensionRow>,
    summary_rows: Vec<DailyAnalysisRow>,
    detail_rows: Vec<DailyAnalysisDetailRow>,
}

impl DailyAnalysisView {
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| DailyAnalysisState::Loading);
        Self {
            state,
            client,
            projects: Vec::new(),
            selected_project_id: None,
            country: "US".to_string(),
            window_preset: WindowPreset::default(),
            active_tab: DetailTab::Summary,
            latest_request_id: 0,
            project_select: None,
            select_fingerprint: String::new(),
            dimension_table: None,
            summary_table: None,
            detail_table: None,
            dimension_rows: Vec::new(),
            summary_rows: Vec::new(),
            detail_rows: Vec::new(),
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> DailyAnalysisState {
        self.state.read(cx).clone()
    }

    /// 最新请求序号（测试断言用）
    #[allow(dead_code)]
    pub fn latest_request_id(&self) -> u64 {
        self.latest_request_id
    }

    /// 筛选值（测试断言用）
    #[allow(dead_code)]
    pub fn selected_project_id(&self) -> Option<ProjectId> {
        self.selected_project_id
    }

    /// 重新拉取数据：筛选变化 / 错误重试 / 空态刷新共用入口。
    ///
    /// 每次调用递增 `latest_request_id` 并进入 Loading；响应回来时 `apply_result`
    /// 只应用最新一次（竞态保护，对齐 frontend `latestLoadRequestRef`）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let selected = self.selected_project_id;
        let country = self.country.clone();
        let preset = self.window_preset;

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
                        .block_on(load_daily_analysis(&client, selected, &country, preset))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 切换选中项目（Select Confirm；None = 全部项目）。同一项目为 no-op。
    fn select_project(&mut self, project_id: Option<ProjectId>, cx: &mut Context<Self>) {
        if project_id == self.selected_project_id {
            return;
        }
        self.selected_project_id = project_id;
        self.reload(cx);
    }

    /// 切换站点（TabBar 点击）。同一站点为 no-op。
    fn select_country(&mut self, country: &str, cx: &mut Context<Self>) {
        if country == self.country {
            return;
        }
        self.country = country.to_string();
        self.reload(cx);
    }

    /// 切换周期预设。同一预设为 no-op。
    fn select_window_preset(&mut self, preset: WindowPreset, cx: &mut Context<Self>) {
        if preset == self.window_preset {
            return;
        }
        self.window_preset = preset;
        self.reload(cx);
    }

    /// 切换明细 Tab（每日汇总 / SKU 明细；纯展示切换，不重拉数据）
    fn select_tab(&mut self, tab: DetailTab, cx: &mut Context<Self>) {
        if tab == self.active_tab {
            return;
        }
        self.active_tab = tab;
        cx.notify();
    }

    /// 应用拉取结果：竞态保护 + 表格行缓存 + 状态转移
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
            self.projects = data.projects.clone();
            self.summary_rows = data.summary_rows.clone();
            self.detail_rows = data.detail_rows.clone();
            self.dimension_rows = data.dimension_rows.clone();
            // 已建表则同步行数据（未建表时 render 首帧会用缓存行建表）
            self.push_table_rows(cx);
        }
        self.state.update(cx, |state, cx| {
            *state = DailyAnalysisState::from_fetch_result(result);
            cx.notify();
        });
    }

    /// 把当前行缓存推入已创建的表格（幂等：未建表直接跳过）
    fn push_table_rows(&mut self, cx: &mut Context<Self>) {
        if let Some(table) = &self.dimension_table {
            let rows = self.dimension_rows.clone();
            table.update(cx, |state, cx| {
                state.delegate_mut().set_rows(rows);
                state.refresh(cx);
                cx.notify();
            });
        }
        if let Some(table) = &self.summary_table {
            let rows = self.summary_rows.clone();
            table.update(cx, |state, cx| {
                state.delegate_mut().set_rows(rows);
                state.refresh(cx);
                cx.notify();
            });
        }
        if let Some(table) = &self.detail_table {
            let rows = self.detail_rows.clone();
            table.update(cx, |state, cx| {
                state.delegate_mut().set_rows(rows);
                state.refresh(cx);
                cx.notify();
            });
        }
    }

    // ---------- 项目 Select ----------

    /// 项目选项（"全部项目" + 项目名），与 Select 选项索引一一对应
    fn project_option_labels(&self) -> Vec<SharedString> {
        let mut labels = Vec::with_capacity(self.projects.len() + 1);
        labels.push(SharedString::from("全部项目"));
        labels.extend(
            self.projects
                .iter()
                .map(|p| SharedString::from(p.name.clone())),
        );
        labels
    }

    /// 选项索引 → 项目 id（0 = 全部项目 → None；越界 → None）
    fn project_id_for_index(&self, index: usize) -> Option<ProjectId> {
        if index == 0 {
            return None;
        }
        self.projects.get(index - 1).map(|p| p.id)
    }

    /// 当前选中项在选项中的索引（全部项目 → 0；找不到 → 0）
    fn selected_project_index(&self) -> usize {
        match self.selected_project_id {
            None => 0,
            Some(id) => self
                .projects
                .iter()
                .position(|p| p.id == id)
                .map_or(0, |ix| ix + 1),
        }
    }

    /// 项目指纹（全部项目 id 连接）；项目列表变化时 Select 选项需同步
    fn projects_fingerprint(&self) -> String {
        self.projects
            .iter()
            .map(|p| p.id.to_string())
            .collect::<Vec<_>>()
            .join(",")
    }

    /// 懒建项目 Select（首个渲染帧）+ 订阅 Confirm；项目列表变化时同步选项。
    fn ensure_project_select(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.project_select.is_none() {
            let items = self.project_option_labels();
            let selected_index = Some(IndexPath::new(self.selected_project_index()));
            let state = cx
                .new(|cx| SelectState::new(SearchableVec::new(items), selected_index, window, cx));
            cx.subscribe(&state, |this, _state, event, cx| {
                // SelectState 仅发射 SelectEvent（单一 Confirm 变体）
                let SelectEvent::Confirm(value) = event;
                let index = value
                    .as_ref()
                    .and_then(|v| this.project_option_labels().iter().position(|l| l == v));
                let project_id = index.and_then(|ix| this.project_id_for_index(ix));
                this.select_project(project_id, cx);
            })
            .detach();
            self.project_select = Some(state);
            self.select_fingerprint = self.projects_fingerprint();
        }
        // 项目列表变化（首载 / reload）→ 同步选项并保留当前选中
        let fingerprint = self.projects_fingerprint();
        if fingerprint != self.select_fingerprint {
            if let Some(select) = &self.project_select {
                let items = self.project_option_labels();
                select.update(cx, |state, cx| {
                    state.set_items(SearchableVec::new(items), window, cx);
                });
            }
            self.select_fingerprint = fingerprint;
        }
    }
}

/// 拉取销售数据全量载荷（项目列表 + 当前期 + 对比期），与视图解耦便于测试。
///
/// - 项目列表为空 → 空载荷（`is_empty` 归入 Empty 态）；
/// - 「全部项目 × 全部站点」后端不支持 → 明确错误（对齐 frontend toast 文案）；
/// - 对比期失败不阻塞主数据（`compare_kpi = None`，环比显示「—」）。
async fn load_daily_analysis(
    client: &Client,
    selected_project_id: Option<ProjectId>,
    country: &str,
    preset: WindowPreset,
) -> Result<DailyAnalysisData, String> {
    let projects = client
        .list_managed_projects()
        .await
        .map_err(|e| e.user_message())?;
    if projects.is_empty() {
        let (from, to) = window_for(preset, chrono::Local::now().date_naive());
        return Ok(DailyAnalysisData {
            projects: Vec::new(),
            mode: load_mode(selected_project_id, country),
            country: country.to_string(),
            window: (from, to),
            summary_rows: Vec::new(),
            detail_rows: Vec::new(),
            dimension_rows: Vec::new(),
            currency: None,
            currency_note: None,
            compare_kpi: None,
        });
    }
    if selected_project_id.is_none() && country == COUNTRY_ALL {
        return Err(
            "暂不支持「全部项目 × 全部站点」：请先选定具体项目，再选择「全部站点」查看跨国家汇总。"
                .to_string(),
        );
    }

    let mode = load_mode(selected_project_id, country);
    let today = chrono::Local::now().date_naive();
    let window = window_for(preset, today);
    let (from, to) = window;
    let (prev_from, prev_to) = previous_window(window);
    let projects_ref = &projects;
    let selected = selected_project_id;

    match mode {
        LoadMode::AllProjects => {
            let ids = projects
                .iter()
                .map(|p| p.id.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let (cur, prev) = tokio::join!(
                client.daily_analysis_all(&ids, country, from, to),
                client.daily_analysis_all(&ids, country, prev_from, prev_to),
            );
            let cur = cur.map_err(|e| e.user_message())?;
            let compare_breakdown = prev.as_ref().ok().map(|p| &p.project_breakdown);
            Ok(DailyAnalysisData {
                projects: projects_ref.clone(),
                mode,
                country: country.to_string(),
                window,
                summary_rows: cur.summary_rows,
                detail_rows: cur.detail_rows,
                dimension_rows: compute_project_totals(
                    &cur.project_breakdown,
                    compare_breakdown,
                    projects_ref,
                ),
                currency: None,
                currency_note: None,
                compare_kpi: prev.ok().map(|p| KpiSummary::from_rows(&p.summary_rows)),
            })
        }
        LoadMode::AllCountries => {
            let project_id = selected.expect("AllCountries 必有选中项目");
            let (cur, prev) = tokio::join!(
                client.daily_analysis_all_countries(project_id, from, to),
                client.daily_analysis_all_countries(project_id, prev_from, prev_to),
            );
            let cur = cur.map_err(|e| e.user_message())?;
            Ok(DailyAnalysisData {
                projects: projects_ref.clone(),
                mode,
                country: country.to_string(),
                window,
                summary_rows: cur.summary_rows,
                detail_rows: cur.detail_rows,
                dimension_rows: compute_country_totals(&cur.country_breakdown),
                currency: Some(cur.currency.clone()),
                currency_note: cur.currency_note.clone(),
                compare_kpi: prev.ok().map(|p| KpiSummary::from_rows(&p.summary_rows)),
            })
        }
        LoadMode::SingleProject => {
            let project_id = selected.expect("SingleProject 必有选中项目");
            let (cur, prev) = tokio::join!(
                client.daily_analysis(project_id, country, from, to, None),
                client.daily_analysis(project_id, country, prev_from, prev_to, None),
            );
            let cur = cur.map_err(|e| e.user_message())?;
            let compare_breakdown = prev.as_ref().ok().map(|p| &p.project_breakdown);
            Ok(DailyAnalysisData {
                projects: projects_ref.clone(),
                mode,
                country: country.to_string(),
                window,
                summary_rows: cur.summary_rows,
                detail_rows: cur.detail_rows,
                dimension_rows: compute_project_totals(
                    &cur.project_breakdown,
                    compare_breakdown,
                    projects_ref,
                ),
                currency: None,
                currency_note: None,
                compare_kpi: prev.ok().map(|p| KpiSummary::from_rows(&p.summary_rows)),
            })
        }
    }
}

impl Render for DailyAnalysisView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.ensure_project_select(window, cx);
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let this = self;
        match state {
            DailyAnalysisState::Loading => render_loading(&app_theme).into_any_element(),
            DailyAnalysisState::Error(msg) => render_error(cx, &app_theme, &msg).into_any_element(),
            DailyAnalysisState::Empty => render_empty(cx, &app_theme).into_any_element(),
            DailyAnalysisState::Loaded(data) => {
                render_loaded(this, window, cx, &app_theme, &data).into_any_element()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 四态渲染
// ---------------------------------------------------------------------------

/// Loading：筛选骨架 + 数字带骨架 + 表格骨架（与正式布局同构）
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
        .child(div().w_full().h(px(40.)).child(Skeleton::new()))
        .child(stat_band_skeleton(app_theme))
        .child(div().w_full().h(px(260.)).child(Skeleton::new()))
        .child(div().w_full().h(px(280.)).child(Skeleton::new()))
}

/// Error：内联 Alert + 重试按钮（重试 = reload）
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
                    Alert::error("daily-analysis-error-alert", msg)
                        .title("数据加载失败")
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

/// Empty：Icon + 文案 + 刷新按钮
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
                        .child("当前筛选范围内暂无销售数据"),
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

/// Loaded：页面头 + 筛选区 + 数字带 + 维度下钻 + 明细 Tab + 表格
fn render_loaded(
    this: &mut DailyAnalysisView,
    window: &mut Window,
    cx: &mut Context<DailyAnalysisView>,
    app_theme: &AppTheme,
    data: &DailyAnalysisData,
) -> impl IntoElement {
    // 懒建表格（TableState 需 Window；首个渲染帧创建，行数据取自缓存）
    let dimension_table = this.dimension_table.get_or_insert_with(|| {
        let delegate = DimensionDelegate::new(this.dimension_rows.clone());
        cx.new(|cx| TableState::new(delegate, window, cx))
    });
    let summary_table = this.summary_table.get_or_insert_with(|| {
        let delegate = SummaryDelegate::new(this.summary_rows.clone());
        cx.new(|cx| TableState::new(delegate, window, cx))
    });
    let detail_table = this.detail_table.get_or_insert_with(|| {
        let delegate = DetailDelegate::new(this.detail_rows.clone());
        cx.new(|cx| TableState::new(delegate, window, cx))
    });

    let kpi = KpiSummary::from_rows(&data.summary_rows);
    let comparison = data.compare_kpi.unwrap_or_default();
    let (from, to) = data.window;
    let dimension_title = if data.mode == LoadMode::AllCountries {
        "站点维度"
    } else {
        "项目维度"
    };

    // 筛选器（TabBar on_click 为静态闭包 → 捕获 cx.entity()）
    let this_entity = cx.entity();
    let country_index = COUNTRY_OPTIONS
        .iter()
        .position(|c| *c == data.country)
        .unwrap_or(0);
    let preset_index = match this.window_preset {
        WindowPreset::Last7Days => 0,
        WindowPreset::Last30Days => 1,
    };

    v_flex()
        .id("daily-analysis-loaded")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        // 页面头：大标题 + 副标题（对齐 frontend page header）
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
                            "{} · {} · {}（{} ~ {}）· {} 天汇总",
                            if data.mode == LoadMode::AllProjects {
                                format!("{} 个项目", data.projects.len())
                            } else if data.mode == LoadMode::AllCountries {
                                "跨站点汇总".to_string()
                            } else {
                                data.projects
                                    .iter()
                                    .find(|p| Some(p.id) == this.selected_project_id)
                                    .map_or("单项目".to_string(), |p| p.name.clone())
                            },
                            country_label(&data.country),
                            this.window_preset.label(),
                            from,
                            to,
                            data.summary_rows.len(),
                        )),
                ),
        )
        // 筛选区：项目 Select + 站点 + 周期（卡片容器）
        .child(
            v_flex()
                .w_full()
                .gap_3()
                .p_4()
                .rounded(px(app_theme.radius_lg))
                .bg(app_theme.card_bg)
                .shadow(vec![app_theme.card_shadow_box()])
                .child(
                    h_flex()
                        .gap_3()
                        .items_center()
                        .child(
                            div()
                                .text_sm()
                                .text_color(app_theme.text_muted)
                                .child("项目"),
                        )
                        .child(this.project_select.as_ref().map_or_else(
                            || {
                                div()
                                    .w(px(180.))
                                    .h(px(32.))
                                    .child(Skeleton::new())
                                    .into_any_element()
                            },
                            |select| Select::new(select).w(px(220.)).small().into_any_element(),
                        ))
                        .child(div().flex_1()),
                )
                .child(
                    h_flex()
                        .gap_4()
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
                                        .child("站点"),
                                )
                                .child(country_tabs(&this_entity, country_index)),
                        )
                        .child(
                            h_flex()
                                .gap_2()
                                .items_center()
                                .child(
                                    div()
                                        .text_sm()
                                        .text_color(app_theme.text_muted)
                                        .child("周期"),
                                )
                                .child(period_tabs(&this_entity, preset_index)),
                        ),
                ),
        )
        // 数字带（KpiSummary 口径 + 环比 delta，复用 Dashboard 数字带）
        .child(stat_band(&kpi, &comparison, app_theme))
        // 维度下钻（项目 / 站点，可排序）
        .child(
            v_flex()
                .id("daily-analysis-dimension-card")
                .w_full()
                .rounded(px(app_theme.radius_lg))
                .bg(app_theme.card_bg)
                .shadow(vec![app_theme.card_shadow_box()])
                .overflow_y_scroll()
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
                                .child(dimension_title.to_string()),
                        )
                        .child(div().text_sm().text_color(app_theme.text_muted).child(
                            if data.mode == LoadMode::AllCountries {
                                "各站点销售额与广告花费对比".to_string()
                            } else {
                                format!(
                                    "各项目销售额与广告花费对比（{}）",
                                    country_label(&data.country)
                                )
                            },
                        )),
                )
                .child(
                    div()
                        .flex_1()
                        .min_h(px(120.))
                        .child(Table::new(dimension_table).bordered(false).large()),
                ),
        )
        // 销售明细：Tab（每日汇总 / SKU 明细）+ 对应表格
        .child(
            v_flex()
                .id("daily-analysis-detail-card")
                .w_full()
                .rounded(px(app_theme.radius_lg))
                .bg(app_theme.card_bg)
                .shadow(vec![app_theme.card_shadow_box()])
                .overflow_y_scroll()
                .child(
                    v_flex()
                        .gap_1()
                        .px_4()
                        .py_3()
                        .border_b_1()
                        .border_color(app_theme.separator)
                        .child(
                            h_flex()
                                .items_center()
                                .justify_between()
                                .gap_3()
                                .child(
                                    div()
                                        .text_base()
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(app_theme.text_primary)
                                        .child("销售明细"),
                                )
                                .child(detail_tabs(&this_entity, this.active_tab)),
                        )
                        .child(
                            div()
                                .text_sm()
                                .text_color(app_theme.text_muted)
                                .child(format!(
                                    "{} 条汇总 · {} 条 SKU 明细",
                                    data.summary_rows.len(),
                                    data.detail_rows.len()
                                )),
                        ),
                )
                .child(div().flex_1().min_h(px(200.)).child(
                    if this.active_tab == DetailTab::Summary {
                        Table::new(summary_table)
                            .bordered(false)
                            .large()
                            .into_any_element()
                    } else {
                        Table::new(detail_table)
                            .bordered(false)
                            .large()
                            .into_any_element()
                    },
                )),
        )
}

/// 站点筛选（segmented TabBar；点击即重拉）
fn country_tabs(this: &gpui::Entity<DailyAnalysisView>, selected: usize) -> impl IntoElement {
    let this = this.clone();
    TabBar::new("daily-analysis-country-tabs")
        .segmented()
        .small()
        .selected_index(selected)
        .children(
            COUNTRY_OPTIONS
                .iter()
                .map(|c| Tab::new().label(SharedString::from(country_label(c).to_string()))),
        )
        .on_click(move |ix, _window, cx| {
            let ix = *ix;
            let country = COUNTRY_OPTIONS[ix];
            this.update(cx, |this, cx| this.select_country(country, cx));
        })
}

/// 周期筛选（segmented TabBar；点击即重拉）
fn period_tabs(this: &gpui::Entity<DailyAnalysisView>, selected: usize) -> impl IntoElement {
    let this = this.clone();
    TabBar::new("daily-analysis-period-tabs")
        .segmented()
        .small()
        .selected_index(selected)
        .children(
            [WindowPreset::Last7Days, WindowPreset::Last30Days]
                .iter()
                .map(|p| Tab::new().label(p.label())),
        )
        .on_click(move |ix, _window, cx| {
            let preset = if *ix == 0 {
                WindowPreset::Last7Days
            } else {
                WindowPreset::Last30Days
            };
            this.update(cx, |this, cx| this.select_window_preset(preset, cx));
        })
}

/// 明细 Tab（每日汇总 / SKU 明细；纯展示切换）
fn detail_tabs(this: &gpui::Entity<DailyAnalysisView>, active: DetailTab) -> impl IntoElement {
    let this = this.clone();
    TabBar::new("daily-analysis-detail-tabs")
        .segmented()
        .small()
        .selected_index(if active == DetailTab::Summary { 0 } else { 1 })
        .children([DetailTab::Summary, DetailTab::SkuDetail].iter().map(|t| {
            Tab::new().label(match t {
                DetailTab::Summary => "每日汇总",
                DetailTab::SkuDetail => "SKU 明细",
            })
        }))
        .on_click(move |ix, _window, cx| {
            let tab = if *ix == 0 {
                DetailTab::Summary
            } else {
                DetailTab::SkuDetail
            };
            this.update(cx, |this, cx| this.select_tab(tab, cx));
        })
}

// ---------------------------------------------------------------------------
// 维度下钻表（项目 / 站点，可排序列）
// ---------------------------------------------------------------------------

const COL_DIM_NAME: usize = 0;
const COL_DIM_SALES: usize = 1;
const COL_DIM_AD_SPEND: usize = 2;
const COL_DIM_ORDERS: usize = 3;
const COL_DIM_CHANGE: usize = 4;

fn dimension_sortable_col(col_ix: usize) -> bool {
    matches!(col_ix, COL_DIM_SALES | COL_DIM_AD_SPEND | COL_DIM_ORDERS)
}

struct DimensionDelegate {
    rows: Vec<DimensionRow>,
    columns: Vec<Column>,
    sort_col: usize,
    sort_dir: ColumnSort,
}

impl DimensionDelegate {
    fn new(rows: Vec<DimensionRow>) -> Self {
        let mut columns = Self::columns();
        // 默认排序：销售额降序（表头初始即显示降序箭头）
        columns[COL_DIM_SALES].sort = Some(ColumnSort::Descending);
        let mut this = Self {
            rows,
            columns,
            sort_col: COL_DIM_SALES,
            sort_dir: ColumnSort::Descending,
        };
        this.apply_sort();
        this
    }

    fn columns() -> Vec<Column> {
        vec![
            Column::new("name", "维度")
                .width(px(200.))
                .resizable(false)
                .movable(false)
                .selectable(false),
            Column::new("sales", "销售额")
                .width(px(120.))
                .text_right()
                .sortable(),
            Column::new("ad_spend", "广告花费")
                .width(px(120.))
                .text_right()
                .sortable(),
            Column::new("orders", "订单量")
                .width(px(90.))
                .text_right()
                .sortable(),
            Column::new("change", "环比")
                .width(px(120.))
                .text_right()
                .selectable(false),
        ]
    }

    fn set_rows(&mut self, rows: Vec<DimensionRow>) {
        self.rows = rows;
        self.apply_sort();
    }

    fn apply_sort(&mut self) {
        match (self.sort_col, self.sort_dir) {
            (COL_DIM_SALES, ColumnSort::Ascending) => self
                .rows
                .sort_by(|a, b| a.total_sales.total_cmp(&b.total_sales)),
            (COL_DIM_SALES, _) => self
                .rows
                .sort_by(|a, b| b.total_sales.total_cmp(&a.total_sales)),
            (COL_DIM_AD_SPEND, ColumnSort::Ascending) => self
                .rows
                .sort_by(|a, b| a.total_ad_spend.total_cmp(&b.total_ad_spend)),
            (COL_DIM_AD_SPEND, _) => self
                .rows
                .sort_by(|a, b| b.total_ad_spend.total_cmp(&a.total_ad_spend)),
            (COL_DIM_ORDERS, ColumnSort::Ascending) => self.rows.sort_by_key(|r| r.total_orders),
            (COL_DIM_ORDERS, _) => self.rows.sort_by_key(|r| std::cmp::Reverse(r.total_orders)),
            _ => self
                .rows
                .sort_by(|a, b| b.total_sales.total_cmp(&a.total_sales)),
        }
    }

    /// 表头点击的排序切换：与 TableState 内建排序图标循环一致
    fn toggle_sort(&mut self, col_ix: usize) {
        let current = self
            .columns
            .get(col_ix)
            .and_then(|c| c.sort)
            .unwrap_or(ColumnSort::Default);
        let next = match current {
            ColumnSort::Ascending => ColumnSort::Default,
            ColumnSort::Descending => ColumnSort::Ascending,
            ColumnSort::Default => ColumnSort::Descending,
        };
        self.apply_sort_state(col_ix, next);
    }

    /// 应用一次排序状态（内建排序图标与表头点击共用）
    fn apply_sort_state(&mut self, col_ix: usize, sort: ColumnSort) {
        for (ix, col) in self.columns.iter_mut().enumerate() {
            if dimension_sortable_col(ix) {
                col.sort = Some(if ix == col_ix {
                    sort
                } else {
                    ColumnSort::Default
                });
            }
        }
        match sort {
            ColumnSort::Default => {
                self.sort_col = COL_DIM_SALES;
                self.sort_dir = ColumnSort::Descending;
            }
            ColumnSort::Ascending | ColumnSort::Descending => {
                self.sort_col = col_ix;
                self.sort_dir = sort;
            }
        }
        self.apply_sort();
    }
}

impl TableDelegate for DimensionDelegate {
    fn columns_count(&self, _: &App) -> usize {
        self.columns.len()
    }

    fn rows_count(&self, _: &App) -> usize {
        self.rows.len()
    }

    fn column(&self, col_ix: usize, _: &App) -> &Column {
        &self.columns[col_ix]
    }

    fn perform_sort(
        &mut self,
        col_ix: usize,
        sort: ColumnSort,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) {
        self.apply_sort_state(col_ix, sort);
        cx.notify();
    }

    fn render_th(
        &mut self,
        col_ix: usize,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        let name = self.columns[col_ix].name.clone();
        let sortable = dimension_sortable_col(col_ix);
        let theme = AppTheme::current(cx);
        h_flex()
            .id(("dim-th", col_ix))
            .items_center()
            .gap_1()
            .text_color(theme.text_muted)
            .when(sortable, |this| {
                this.cursor(CursorStyle::PointingHand)
                    .text_color(theme.text_primary)
                    .on_click(cx.listener(move |table, _, _, cx| {
                        table.delegate_mut().toggle_sort(col_ix);
                        table.refresh(cx);
                        cx.notify();
                    }))
            })
            .child(div().child(name))
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
            COL_DIM_NAME => h_flex()
                .gap_1()
                .items_center()
                .child(
                    div()
                        .text_size(px(14.))
                        .font_weight(FontWeight::MEDIUM)
                        .truncate()
                        .child(row.name.clone()),
                )
                .when_some(row.source_currency.as_ref(), |this, currency| {
                    this.child(
                        div()
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child(SharedString::from(format!("({currency})"))),
                    )
                })
                .into_any_element(),
            COL_DIM_SALES => div()
                .text_right()
                .text_size(px(14.))
                .child(fmt_money_precise(row.total_sales))
                .into_any_element(),
            COL_DIM_AD_SPEND => div()
                .text_right()
                .text_size(px(14.))
                .text_color(theme.text_muted)
                .child(fmt_money_precise(row.total_ad_spend))
                .into_any_element(),
            COL_DIM_ORDERS => div()
                .text_right()
                .text_size(px(14.))
                .text_color(theme.text_muted)
                .child(fmt_num_precise(row.total_orders))
                .into_any_element(),
            COL_DIM_CHANGE => render_change_cell(row.change, &theme).into_any_element(),
            _ => div().into_any_element(),
        }
    }

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
            .child(
                Icon::new(Icon::empty())
                    .path("icons/store.svg")
                    .with_size(px(24.)),
            )
            .child(div().text_size(px(13.)).child("暂无维度数据"))
            .into_any_element()
    }
}

/// 环比单元格：绿 ↑ / 红 ↓ / 灰 — / 无数据 —
fn render_change_cell(change: Option<f64>, theme: &AppTheme) -> impl IntoElement {
    let (icon, color, text) = match change {
        None => (IconName::Minus, theme.text_muted, "—".to_string()),
        Some(v) if v > 0.5 => (IconName::ArrowUp, theme.success, format!("{:.1}%", v)),
        Some(v) if v < -0.5 => (IconName::ArrowDown, theme.danger, format!("{:.1}%", v)),
        Some(v) => (IconName::Minus, theme.text_muted, format!("{:.1}%", v)),
    };
    h_flex()
        .w_full()
        .justify_end()
        .items_center()
        .gap_1()
        .text_size(px(12.))
        .text_color(color)
        .child(Icon::new(icon).with_size(px(12.)).text_color(color))
        .child(div().child(text))
}

// ---------------------------------------------------------------------------
// 每日汇总表（13 列，对齐 frontend summary 表；非排序）
// ---------------------------------------------------------------------------

/// 汇总表列顺序（与 frontend 表头 1:1）
const SUMMARY_COLUMNS: [&str; 13] = [
    "日期",
    "订单量",
    "销售额",
    "曝光量",
    "点击量",
    "CPC",
    "广告花费",
    "广告订单",
    "可售库存",
    "页面浏览量",
    "销量",
    "访问量",
    "转化率",
];

struct SummaryDelegate {
    rows: Vec<DailyAnalysisRow>,
}

impl SummaryDelegate {
    fn new(rows: Vec<DailyAnalysisRow>) -> Self {
        Self { rows }
    }

    fn set_rows(&mut self, rows: Vec<DailyAnalysisRow>) {
        self.rows = rows;
    }
}

impl TableDelegate for SummaryDelegate {
    fn columns_count(&self, _: &App) -> usize {
        SUMMARY_COLUMNS.len()
    }

    fn rows_count(&self, _: &App) -> usize {
        self.rows.len()
    }

    fn column(&self, col_ix: usize, _: &App) -> &Column {
        // 表头不可排序 / 不可拖拽（对齐 frontend 纯展示表）
        static COLUMNS: std::sync::OnceLock<Vec<Column>> = std::sync::OnceLock::new();
        let columns = COLUMNS.get_or_init(|| {
            SUMMARY_COLUMNS
                .iter()
                .enumerate()
                .map(|(ix, name)| {
                    let width = if ix == 0 { px(120.) } else { px(96.) };
                    Column::new(format!("summary-{ix}"), *name)
                        .width(width)
                        .resizable(false)
                        .movable(false)
                        .selectable(false)
                        .when(ix > 0, |c| c.text_right())
                })
                .collect()
        });
        &columns[col_ix]
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
            0 => div()
                .text_size(px(13.))
                .text_color(theme.text_primary)
                .child(row.date.to_string())
                .into_any_element(),
            1 => numeric_cell(fmt_num_precise(row.order_qty), &theme).into_any_element(),
            2 => numeric_cell(fmt_money_precise(row.sales_amount), &theme).into_any_element(),
            3 => numeric_cell(fmt_num_precise(row.impressions), &theme).into_any_element(),
            4 => numeric_cell(fmt_num_precise(row.clicks), &theme).into_any_element(),
            5 => numeric_cell(fmt_money_precise(row.cpc), &theme).into_any_element(),
            6 => numeric_cell(fmt_money_precise(row.ad_spend), &theme).into_any_element(),
            7 => numeric_cell(fmt_num_precise(row.ad_orders), &theme).into_any_element(),
            8 => numeric_cell(fmt_num_precise(row.available_qty), &theme).into_any_element(),
            9 => numeric_cell(fmt_num_precise(row.page_views), &theme).into_any_element(),
            10 => numeric_cell(fmt_num_precise(row.units_ordered), &theme).into_any_element(),
            11 => numeric_cell(fmt_num_precise(row.sessions), &theme).into_any_element(),
            12 => numeric_cell(percent_cell(row.conversion_rate), &theme).into_any_element(),
            _ => div().into_any_element(),
        }
    }

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
            .child(
                Icon::new(Icon::empty())
                    .path("icons/package.svg")
                    .with_size(px(24.)),
            )
            .child(div().text_size(px(13.)).child("当前筛选范围内暂无汇总数据"))
            .into_any_element()
    }
}

// ---------------------------------------------------------------------------
// SKU 明细表（16 列，对齐 frontend detail 表；非排序）
// ---------------------------------------------------------------------------

/// 明细表列顺序（与 frontend 表头 1:1；品名列后端暂无字段 → 显示「--」）
const DETAIL_COLUMNS: [&str; 16] = [
    "日期",
    "SKU",
    "品名",
    "订单量",
    "销售额",
    "曝光量",
    "点击量",
    "CPC",
    "广告花费",
    "广告订单",
    "可售库存",
    "在途数量",
    "页面浏览量",
    "销量",
    "访问量",
    "转化率",
];

struct DetailDelegate {
    rows: Vec<DailyAnalysisDetailRow>,
}

impl DetailDelegate {
    fn new(rows: Vec<DailyAnalysisDetailRow>) -> Self {
        Self { rows }
    }

    fn set_rows(&mut self, rows: Vec<DailyAnalysisDetailRow>) {
        self.rows = rows;
    }
}

impl TableDelegate for DetailDelegate {
    fn columns_count(&self, _: &App) -> usize {
        DETAIL_COLUMNS.len()
    }

    fn rows_count(&self, _: &App) -> usize {
        self.rows.len()
    }

    fn column(&self, col_ix: usize, _: &App) -> &Column {
        static COLUMNS: std::sync::OnceLock<Vec<Column>> = std::sync::OnceLock::new();
        let columns = COLUMNS.get_or_init(|| {
            DETAIL_COLUMNS
                .iter()
                .enumerate()
                .map(|(ix, name)| {
                    let width = match ix {
                        0 => px(120.),
                        1 | 2 => px(160.),
                        _ => px(96.),
                    };
                    Column::new(format!("detail-{ix}"), *name)
                        .width(width)
                        .resizable(false)
                        .movable(false)
                        .selectable(false)
                        .when(ix > 2, |c| c.text_right())
                })
                .collect()
        });
        &columns[col_ix]
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
            0 => div()
                .text_size(px(13.))
                .text_color(theme.text_primary)
                .child(row.date.to_string())
                .into_any_element(),
            1 => div()
                .text_size(px(13.))
                .font_weight(FontWeight::MEDIUM)
                .truncate()
                .child(row.sku.clone())
                .into_any_element(),
            2 => div()
                .text_size(px(13.))
                .text_color(theme.text_muted)
                .truncate()
                .child("--")
                .into_any_element(),
            3 => numeric_cell(fmt_num_precise(row.order_qty), &theme).into_any_element(),
            4 => numeric_cell(fmt_money_precise(row.sales_amount), &theme).into_any_element(),
            5 => numeric_cell(fmt_num_precise(row.impressions), &theme).into_any_element(),
            6 => numeric_cell(fmt_num_precise(row.clicks), &theme).into_any_element(),
            7 => numeric_cell(fmt_money_precise(row.cpc), &theme).into_any_element(),
            8 => numeric_cell(fmt_money_precise(row.ad_spend), &theme).into_any_element(),
            9 => numeric_cell(fmt_num_precise(row.ad_orders), &theme).into_any_element(),
            10 => numeric_cell(fmt_num_precise(row.available_qty), &theme).into_any_element(),
            11 => numeric_cell(fmt_num_precise(row.in_transit_qty), &theme).into_any_element(),
            12 => numeric_cell(fmt_num_precise(row.page_views), &theme).into_any_element(),
            13 => numeric_cell(fmt_num_precise(row.units_ordered), &theme).into_any_element(),
            14 => numeric_cell(fmt_num_precise(row.sessions), &theme).into_any_element(),
            15 => numeric_cell(percent_cell(row.conversion_rate), &theme).into_any_element(),
            _ => div().into_any_element(),
        }
    }

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
            .child(
                Icon::new(Icon::empty())
                    .path("icons/package.svg")
                    .with_size(px(24.)),
            )
            .child(
                div()
                    .text_size(px(13.))
                    .child("当前筛选范围内暂无 SKU 明细"),
            )
            .into_any_element()
    }
}

// ---------------------------------------------------------------------------
// 单元格辅助
// ---------------------------------------------------------------------------

/// 右对齐数字单元格（统一字号与弱化色）
fn numeric_cell(text: String, theme: &AppTheme) -> impl IntoElement {
    div()
        .text_right()
        .text_size(px(13.))
        .text_color(theme.text_secondary)
        .child(text)
}

/// 转化率展示（后端存小数，×100 转百分比，对齐 frontend `(r*100).toFixed(2)%`）
fn percent_cell(fraction: f64) -> String {
    format!("{:.2}%", fraction * 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

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

    fn row(date: &str, order_qty: i64, sales: f64, ad_spend: f64) -> DailyAnalysisRow {
        DailyAnalysisRow {
            date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            order_qty,
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

    fn entry(name: &str, rows: Vec<DailyAnalysisRow>) -> ProjectBreakdownEntry {
        ProjectBreakdownEntry {
            project_name: name.to_string(),
            summary_rows: rows,
            detail_rows: Vec::new(),
        }
    }

    // ---------- 周期窗口（对齐 frontend 口径） ----------

    #[test]
    fn window_for_last_7_days_matches_dashboard() {
        let today = NaiveDate::from_ymd_opt(2026, 8, 14).unwrap();
        let (from, to) = window_for(WindowPreset::Last7Days, today);
        assert_eq!(to.to_string(), "2026-08-13");
        assert_eq!(from.to_string(), "2026-08-07");
        assert_eq!((to - from).num_days(), 6);
    }

    #[test]
    fn window_for_last_30_days_is_30_day_span() {
        let today = NaiveDate::from_ymd_opt(2026, 8, 14).unwrap();
        let (from, to) = window_for(WindowPreset::Last30Days, today);
        assert_eq!(to.to_string(), "2026-08-13");
        assert_eq!(from.to_string(), "2026-07-15");
        assert_eq!((to - from).num_days(), 29);
    }

    #[test]
    fn previous_window_is_equal_length_immediately_before() {
        // 近 7 天：2026-08-07..2026-08-13 → 对比期 2026-07-31..2026-08-06
        let cur = (
            NaiveDate::from_ymd_opt(2026, 8, 7).unwrap(),
            NaiveDate::from_ymd_opt(2026, 8, 13).unwrap(),
        );
        let prev = previous_window(cur);
        assert_eq!(prev.0.to_string(), "2026-07-31");
        assert_eq!(prev.1.to_string(), "2026-08-06");
        // 近 30 天：等长紧邻前窗口
        let cur30 = (
            NaiveDate::from_ymd_opt(2026, 7, 15).unwrap(),
            NaiveDate::from_ymd_opt(2026, 8, 13).unwrap(),
        );
        let prev30 = previous_window(cur30);
        assert_eq!(prev30.0.to_string(), "2026-06-15");
        assert_eq!(prev30.1.to_string(), "2026-07-14");
    }

    // ---------- 加载模式分发（对齐 frontend 三路） ----------

    #[test]
    fn load_mode_matches_frontend_dispatch() {
        assert_eq!(load_mode(None, "US"), LoadMode::AllProjects);
        assert_eq!(load_mode(None, "ALL"), LoadMode::AllProjects);
        assert_eq!(load_mode(Some(1), "ALL"), LoadMode::AllCountries);
        assert_eq!(load_mode(Some(1), "US"), LoadMode::SingleProject);
        assert_eq!(load_mode(Some(1), "DE"), LoadMode::SingleProject);
    }

    // ---------- 状态机转移 ----------

    #[test]
    fn from_fetch_result_maps_to_loaded_empty_error() {
        let data = DailyAnalysisData {
            projects: vec![project(1, "A")],
            mode: LoadMode::SingleProject,
            country: "US".into(),
            window: (
                NaiveDate::from_ymd_opt(2026, 8, 7).unwrap(),
                NaiveDate::from_ymd_opt(2026, 8, 13).unwrap(),
            ),
            summary_rows: vec![row("2026-08-13", 10, 1000.0, 50.0)],
            detail_rows: Vec::new(),
            dimension_rows: Vec::new(),
            currency: None,
            currency_note: None,
            compare_kpi: None,
        };
        assert_eq!(
            DailyAnalysisState::from_fetch_result(Ok(data.clone())),
            DailyAnalysisState::Loaded(data)
        );

        // 无汇总行 → Empty
        let empty = DailyAnalysisData {
            projects: vec![project(1, "A")],
            mode: LoadMode::SingleProject,
            country: "US".into(),
            window: (
                NaiveDate::from_ymd_opt(2026, 8, 7).unwrap(),
                NaiveDate::from_ymd_opt(2026, 8, 13).unwrap(),
            ),
            summary_rows: Vec::new(),
            detail_rows: Vec::new(),
            dimension_rows: Vec::new(),
            currency: None,
            currency_note: None,
            compare_kpi: None,
        };
        assert_eq!(
            DailyAnalysisState::from_fetch_result(Ok(empty)),
            DailyAnalysisState::Empty
        );

        // 失败 → Error（保留文案）
        assert_eq!(
            DailyAnalysisState::from_fetch_result(Err("连接超时".to_string())),
            DailyAnalysisState::Error("连接超时".to_string())
        );
    }

    // ---------- 项目维度聚合 ----------

    #[test]
    fn compute_project_totals_aggregates_and_sorts_by_sales_desc() {
        let mut breakdown = HashMap::new();
        breakdown.insert(
            1,
            entry(
                "项目 A",
                vec![
                    row("2026-08-12", 10, 1000.0, 50.0),
                    row("2026-08-13", 20, 2000.0, 100.0),
                ],
            ),
        );
        breakdown.insert(
            2,
            entry("项目 B", vec![row("2026-08-13", 50, 5000.0, 250.0)]),
        );
        let projects = vec![project(1, "A"), project(2, "B")];

        let rows = compute_project_totals(&breakdown, None, &projects);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "项目 B");
        assert_eq!(rows[0].total_sales, 5000.0);
        assert_eq!(rows[0].total_orders, 50);
        assert_eq!(rows[1].name, "项目 A");
        assert_eq!(rows[1].total_sales, 3000.0);
        assert_eq!(rows[1].total_ad_spend, 150.0);
        assert_eq!(rows[1].change, None); // 无对比期
    }

    #[test]
    fn compute_project_totals_skips_missing_and_empty_entries() {
        let mut breakdown = HashMap::new();
        breakdown.insert(1, entry("项目 A", vec![row("2026-08-13", 5, 500.0, 0.0)]));
        breakdown.insert(3, entry("项目 C", Vec::new()));
        let projects = vec![project(1, "A"), project(2, "B"), project(3, "C")];
        let rows = compute_project_totals(&breakdown, None, &projects);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "项目 A");
    }

    #[test]
    fn compute_project_totals_change_from_compare_period() {
        let mut breakdown = HashMap::new();
        breakdown.insert(1, entry("项目 A", vec![row("2026-08-13", 5, 1100.0, 0.0)]));
        let mut compare = HashMap::new();
        compare.insert(1, entry("项目 A", vec![row("2026-08-06", 5, 1000.0, 0.0)]));
        let projects = vec![project(1, "A")];

        let rows = compute_project_totals(&breakdown, Some(&compare), &projects);
        assert_eq!(rows[0].change, Some(10.0));

        // 对比期为 0 → None
        let mut compare_zero = HashMap::new();
        compare_zero.insert(1, entry("项目 A", vec![row("2026-08-06", 0, 0.0, 0.0)]));
        let rows = compute_project_totals(&breakdown, Some(&compare_zero), &projects);
        assert_eq!(rows[0].change, None);

        // 对比期缺该项目 → None
        let rows = compute_project_totals(&breakdown, Some(&HashMap::new()), &projects);
        assert_eq!(rows[0].change, None);
    }

    // ---------- 站点维度聚合 ----------

    #[test]
    fn compute_country_totals_aggregates_and_labels() {
        let mut breakdown = HashMap::new();
        breakdown.insert(
            "US".to_string(),
            CountryBreakdownEntry {
                summary_rows: vec![row("2026-08-13", 21, 1860.0, 122.4)],
                detail_rows: Vec::new(),
                currency: "USD".into(),
                source_currency: Some("USD".into()),
            },
        );
        breakdown.insert(
            "DE".to_string(),
            CountryBreakdownEntry {
                summary_rows: vec![row("2026-08-13", 8, 640.0, 30.0)],
                detail_rows: Vec::new(),
                currency: "USD".into(),
                source_currency: Some("EUR".into()),
            },
        );
        let rows = compute_country_totals(&breakdown);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "美国站");
        assert_eq!(rows[0].total_sales, 1860.0);
        assert_eq!(rows[0].source_currency.as_deref(), Some("USD"));
        assert_eq!(rows[1].name, "德国站");
        assert_eq!(rows[1].total_sales, 640.0);
        assert_eq!(rows[1].source_currency.as_deref(), Some("EUR"));
        // 站点维度无环比
        assert_eq!(rows[0].change, None);
    }

    // ---------- 格式化 ----------

    #[test]
    fn percent_cell_matches_frontend() {
        assert_eq!(percent_cell(0.0349), "3.49%");
        assert_eq!(percent_cell(0.0), "0.00%");
        assert_eq!(percent_cell(0.044), "4.40%");
    }

    #[test]
    fn country_label_covers_all_options() {
        assert_eq!(country_label("US"), "美国站");
        assert_eq!(country_label("DE"), "德国站");
        assert_eq!(country_label("UK"), "英国站");
        assert_eq!(country_label("ALL"), "全部站点");
    }

    // ---------- 维度表排序（不依赖网络 / 窗口） ----------

    fn sample_dimension_rows() -> Vec<DimensionRow> {
        vec![
            DimensionRow {
                name: "项目 A".into(),
                total_sales: 3000.0,
                total_ad_spend: 150.0,
                total_orders: 30,
                change: Some(10.5),
                source_currency: None,
            },
            DimensionRow {
                name: "项目 B".into(),
                total_sales: 5000.0,
                total_ad_spend: 250.0,
                total_orders: 50,
                change: None,
                source_currency: None,
            },
            DimensionRow {
                name: "项目 C".into(),
                total_sales: 1000.0,
                total_ad_spend: 60.0,
                total_orders: 10,
                change: Some(-3.2),
                source_currency: None,
            },
        ]
    }

    #[test]
    fn dimension_delegate_default_sort_is_sales_desc() {
        let d = DimensionDelegate::new(sample_dimension_rows());
        let names: Vec<&str> = d.rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["项目 B", "项目 A", "项目 C"]);
        assert_eq!(d.columns[COL_DIM_SALES].sort, Some(ColumnSort::Descending));
        assert_eq!(d.columns[COL_DIM_AD_SPEND].sort, Some(ColumnSort::Default));
    }

    #[test]
    fn dimension_delegate_toggle_sort_cycles() {
        let mut d = DimensionDelegate::new(sample_dimension_rows());
        d.toggle_sort(COL_DIM_AD_SPEND);
        let names: Vec<&str> = d.rows.iter().map(|r| r.name.as_str()).collect();
        // 广告花费 250(B) > 150(A) > 60(C)
        assert_eq!(names, vec!["项目 B", "项目 A", "项目 C"]);
        d.toggle_sort(COL_DIM_AD_SPEND);
        let names: Vec<&str> = d.rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["项目 C", "项目 A", "项目 B"]);
        // 再点 → 回到默认（销售额降序）
        d.toggle_sort(COL_DIM_AD_SPEND);
        let names: Vec<&str> = d.rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["项目 B", "项目 A", "项目 C"]);
    }

    // ---------- 渲染冒烟（TestAppContext + 真实窗口） ----------

    #[gpui::test]
    async fn view_renders_loading_then_error_with_unreachable_server(
        cx: &mut gpui::TestAppContext,
    ) {
        cx.update(gpui_component::init);
        // client 指向必拒绝连接的地址 → 首屏 reload 快速进入 Error 态
        let client = Client::new("http://127.0.0.1:1");
        let (_view, _cx) = cx.add_window_view(|_window, cx| {
            let mut view = DailyAnalysisView::new(cx, client);
            view.reload(cx);
            view
        });
        // 渲染冒烟：Error 态（Alert + 重试）可完整渲染不 panic
        // （reload 在后台执行，render 期间状态为 Loading 或 Error 均可）
    }

    #[gpui::test]
    async fn view_renders_loaded_state_with_mock_server(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let mut server = mockito::Server::new_async().await;
        // 项目列表
        server
            .mock("GET", "/api/v1/projects/manage")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"[{"id": 1, "name": "测试项目 A", "sort_order": 1, "is_active": true}]"#)
            .create();
        // 当前期 + 对比期（/all 模式：全部项目 + US；窗口由真实今日推算，故不断言具体日期）
        for _ in 0..2 {
            server
                .mock("GET", "/api/v1/daily-analysis/all")
                .match_query(mockito::Matcher::Any)
                .with_status(200)
                .with_header("content-type", "application/json")
                .with_body(
                    r#"{
                        "summary_rows": [
                            {
                                "date": "2026-08-13",
                                "order_qty": 42,
                                "sales_amount": 3100.5,
                                "impressions": 12000,
                                "clicks": 350,
                                "cpc": 0.62,
                                "ad_spend": 217.0,
                                "ad_orders": 6,
                                "available_qty": 180,
                                "page_views": 900,
                                "units_ordered": 31,
                                "sessions": 720,
                                "ordered_sales_amount": 2980.0,
                                "conversion_rate": 0.0344
                            }
                        ],
                        "detail_rows": [],
                        "available_dates": {},
                        "project_breakdown": {
                            "1": {
                                "project_name": "测试项目 A",
                                "summary_rows": [
                                    {
                                        "date": "2026-08-13",
                                        "order_qty": 42,
                                        "sales_amount": 3100.5,
                                        "impressions": 12000,
                                        "clicks": 350,
                                        "cpc": 0.62,
                                        "ad_spend": 217.0,
                                        "ad_orders": 6,
                                        "available_qty": 180,
                                        "page_views": 900,
                                        "units_ordered": 31,
                                        "sessions": 720,
                                        "ordered_sales_amount": 2980.0,
                                        "conversion_rate": 0.0344
                                    }
                                ],
                                "detail_rows": []
                            }
                        }
                    }"#,
                )
                .create();
        }

        let client = Client::new(server.url());
        let (view, cx) = cx.add_window_view(|_window, cx| {
            let mut view = DailyAnalysisView::new(cx, client);
            view.reload(cx);
            view
        });
        // 等待后台拉取完成进入 Loaded（condition 内置 3s 超时，mock server 本地响应足够）
        cx.condition(&view, |view, cx| {
            matches!(
                view.current_state(cx),
                DailyAnalysisState::Loaded(_) | DailyAnalysisState::Empty
            )
        })
        .await;
        cx.read(|app| {
            assert!(matches!(
                view.read(app).current_state(app),
                DailyAnalysisState::Loaded(_)
            ));
        });
    }

    #[gpui::test]
    async fn view_renders_in_dark_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let client = Client::new("http://127.0.0.1:1");
        let (_view, _cx) = cx.add_window_view(|_window, cx| {
            let mut view = DailyAnalysisView::new(cx, client);
            view.reload(cx);
            view
        });
        cx.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }
}
