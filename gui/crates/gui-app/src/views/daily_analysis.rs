//! 运营 → 销售数据视图（P3-1，BLF-701；BLF-798 起 Pattern A 模板套版）
//!
//! frontend `app/dashboard/operations/daily-analysis/page.tsx` 的 GPUI 等价：
//! **Pattern A「控制台工具栏 + 超密度数据网格」原型页**——顶部 FilterToolbar
//! （数据维度切换 + SKU 关键词搜索 + 广告状态筛选 + 刷新），中部虚拟化大表
//! （[`DataGrid`]：粘性表头 / 列宽拖拽 / 横向滚动 / 斑马纹），底部 pinned
//! 分页聚合条（聚合摘要数字 mono；含 **Pending 口径标注**）。
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
//! - **KPI**：Loaded 后推送 Console Bar 统计 pill（GMV / 订单数；Pending 数据源
//!   未接入，恒为 None 不出位）；页内聚合条同步给出合计与 Pending 口径标注。
//!
//! 已知差异（有意保留，GPUI 0.2 能力边界 / 本阶段范围）：
//! - 项目 / 站点 / 日期筛选由 Stage4 Console Bar 唯一权威承载（BLF-795），
//!   页内不再重复渲染三维筛选；
//! - Pending 订单数后端无现成端点：聚合条以「—」占位并标注统计口径缺口；
//! - 图表真渲染属 Stage8（Pattern B 双轴分析画布），本页「每日汇总」以数据
//!   网格呈现每日聚合行。

use std::collections::HashMap;

use chrono::NaiveDate;

use gpui::{
    div, prelude::*, px, App, AsyncApp, Context, Entity, EventEmitter, SharedString, WeakEntity,
    Window,
};
use gpui_component::{
    button::Button,
    h_flex,
    input::{InputEvent, InputState},
    menu::{DropdownMenu, PopupMenuItem},
    v_flex, Icon, IconName, Sizable,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::dashboard::{
    CountryBreakdownEntry, DailyAnalysisConsoleResponse, DailyAnalysisDetailRow, DailyAnalysisRow,
    KpiSummary, ProjectBreakdownEntry,
};

use crate::theme::AppTheme;
use crate::views::dashboard::last_7_days_window;
use crate::widgets::console_bar::{ConsoleStats, ConsoleStatsEvent};
use crate::widgets::data_grid::{
    change_indicator, grid_footer_bar, pattern_a_shell, AggregateItem, AggregateTone, DataGrid,
};
use crate::widgets::data_table::ColumnDef;
use crate::widgets::date_range::DateRange;
use crate::widgets::filter_bar::{toolbar_search_input, toolbar_spacer};
use crate::widgets::page_header::PageHeader;
use crate::widgets::pagination::PageState;
use crate::widgets::state_views::{self, SkeletonBlock};
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

// ---------------------------------------------------------------------------
// 工具栏筛选模型（纯函数，可单测）
// ---------------------------------------------------------------------------

/// 广告投放状态筛选（状态下拉；语义 = 该行是否有广告活动发生）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AdFilter {
    /// 全部
    #[default]
    All,
    /// 仅广告投放（有广告订单 / 花费）
    WithAds,
    /// 无广告投放
    WithoutAds,
}

impl AdFilter {
    /// 下拉选项（label 顺序即菜单顺序）
    pub const OPTIONS: [(&'static str, AdFilter); 3] = [
        ("全部", AdFilter::All),
        ("仅广告投放", AdFilter::WithAds),
        ("无广告投放", AdFilter::WithoutAds),
    ];

    /// 是否命中该行（has_ads 由各数据集定义：明细看广告订单，汇总/下钻看花费）
    pub fn matches(self, has_ads: bool) -> bool {
        match self {
            Self::All => true,
            Self::WithAds => has_ads,
            Self::WithoutAds => !has_ads,
        }
    }

    fn label(self) -> &'static str {
        Self::OPTIONS
            .iter()
            .find(|(_, f)| *f == self)
            .map(|(label, _)| *label)
            .unwrap_or("全部")
    }
}

/// 关键词命中（大小写不敏感的包含匹配；任一字段命中即可）
pub fn text_matches(query: &str, haystacks: &[&str]) -> bool {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return true;
    }
    haystacks.iter().any(|h| h.to_lowercase().contains(&q))
}

/// 明细行筛选（SKU 关键词 × 广告状态；纯函数）
pub fn filter_detail_rows(
    rows: &[DailyAnalysisDetailRow],
    query: &str,
    ad_filter: AdFilter,
) -> Vec<DailyAnalysisDetailRow> {
    rows.iter()
        .filter(|r| {
            text_matches(query, &[&r.sku, r.asin.as_deref().unwrap_or("")])
                && ad_filter.matches(r.ad_orders > 0)
        })
        .cloned()
        .collect()
}

/// 每日汇总行筛选（日期关键词 × 广告状态；纯函数）
pub fn filter_daily_rows(
    rows: &[DailyAnalysisRow],
    query: &str,
    ad_filter: AdFilter,
) -> Vec<DailyAnalysisRow> {
    rows.iter()
        .filter(|r| {
            text_matches(query, &[&r.date.to_string()]) && ad_filter.matches(r.ad_spend > 0.0)
        })
        .cloned()
        .collect()
}

/// 下钻行筛选（名称关键词 × 广告状态；纯函数）
pub fn filter_breakdown_rows(
    rows: &[BreakdownRow],
    query: &str,
    ad_filter: AdFilter,
) -> Vec<BreakdownRow> {
    rows.iter()
        .filter(|r| {
            text_matches(query, &[&r.name]) && ad_filter.matches(r.ad_spend > 0.0)
        })
        .cloned()
        .collect()
}

/// 页面数据集切换（工具栏「数据维度」下拉）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum GridDataset {
    /// SKU 明细（默认）
    #[default]
    Detail,
    /// 每日汇总（图表 Stage8 接入前的数据形态）
    Daily,
    /// 维度下钻（项目 / 国家）
    Breakdown,
}

impl GridDataset {
    /// 下拉选项 label
    pub fn label(self) -> &'static str {
        match self {
            Self::Detail => "SKU 明细",
            Self::Daily => "每日汇总",
            Self::Breakdown => "维度下钻",
        }
    }
}

// ---------------------------------------------------------------------------
// 维度下钻（纯派生，可单测）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 数据载荷与状态机
// ---------------------------------------------------------------------------

/// 销售数据载荷（Loaded 持有）
#[derive(Debug, Clone, PartialEq)]
pub struct DailyAnalysisData {
    pub projects: Vec<ManagedProject>,
    pub mode: AnalysisMode,
    /// 请求诊断（mode A 由客户端合成；B/C 来自后端 console）
    pub console: DailyAnalysisConsoleResponse,
    /// 每日聚合行（每日汇总网格 / KPI 数字带数据源）
    pub summary_rows: Vec<DailyAnalysisRow>,
    /// SKU 明细行（明细网格数据源）
    pub detail_rows: Vec<DailyAnalysisDetailRow>,
    /// 项目维度（mode A）/ 国家维度（mode B）下钻；mode C 为空
    pub breakdown: Vec<BreakdownRow>,
    /// 对比期（前一 7 天窗口）聚合行（环比用）；拉取失败时为空（显示「—」）
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

    /// Loaded 态的下钻行数（其余态为 `None`；工具栏据此决定是否出「维度下钻」项）
    pub fn loaded_breakdown_len(&self) -> Option<usize> {
        match self {
            Self::Loaded(data) => Some(data.breakdown.len()),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// 销售数据视图（Pattern A 骨架：FilterToolbar + 虚拟化大表 + pinned 底条）
pub struct DailyAnalysisView {
    state: Entity<DailyAnalysisState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表（reload 刷新；Console Bar 菜单数据源由根视图维护）
    projects: Vec<ManagedProject>,
    /// 当前选中项目；`None` = 全部项目
    selected_project_id: Option<i64>,
    /// 当前站点（"US" / "DE" / "UK" / "ALL"）
    country: &'static str,
    /// 日期区间（BLF-795：Console Bar 可驱动；默认近 7 天对齐旧行为）
    date_range: DateRange,
    /// 请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,

    // ---- Pattern A 工具栏状态 ----
    /// 当前数据集（SKU 明细 / 每日汇总 / 维度下钻）
    dataset: GridDataset,
    /// SKU 关键词（客户端过滤当前数据集）
    search_query: String,
    /// 广告投放状态筛选
    ad_filter: AdFilter,
    /// 搜索输入框（懒建 InputState，render 首帧创建；见 ad_data.rs 范式）
    search_input: Option<Entity<InputState>>,
    search_sub: Option<gpui::Subscription>,

    // ---- Pattern A 网格与底条状态 ----
    /// SKU 明细网格
    detail_grid: Entity<DataGrid<DailyAnalysisDetailRow>>,
    /// 每日汇总网格
    daily_grid: Entity<DataGrid<DailyAnalysisRow>>,
    /// 维度下钻网格
    breakdown_grid: Entity<DataGrid<BreakdownRow>>,
    /// 当前页（1-based；refresh_grids 经 PageState 收敛到安全范围）
    page: usize,
    /// 每页行数覆盖（None = DEFAULT_PAGE_SIZE）
    page_size_override: Option<usize>,
    /// 分页状态快照（refresh_grids 重算；底部分页器渲染源）
    page_state: PageState,
    /// 底部聚合条目（随数据集 / 筛选联动刷新；数字一律 mono 渲染）
    aggregates: Vec<AggregateItem>,
}

/// 每页行数选项（对齐 pagination 默认档位）
const PAGE_SIZE_OPTIONS: [usize; 4] = [50, 100, 200, 500];

impl DailyAnalysisView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| DailyAnalysisState::Loading);
        let detail_grid =
            cx.new(|_| DataGrid::new("daily-detail-grid", detail_columns()).striped(true));
        let daily_grid =
            cx.new(|_| DataGrid::new("daily-daily-grid", daily_columns()).striped(true));
        let breakdown_grid = cx.new(|_| DataGrid::new("daily-breakdown-grid", breakdown_columns()));
        let (from, to) = last_7_days_window(chrono::Local::now().date_naive());
        Self {
            state,
            client,
            projects: Vec::new(),
            selected_project_id: None,
            country: DEFAULT_COUNTRY,
            date_range: DateRange::new(Some(from), Some(to)),
            latest_request_id: 0,
            dataset: GridDataset::default(),
            search_query: String::new(),
            ad_filter: AdFilter::default(),
            search_input: None,
            search_sub: None,
            detail_grid,
            daily_grid,
            breakdown_grid,
            page: 1,
            page_size_override: None,
            page_state: PageState::new(1, DEFAULT_PAGE_SIZE, 0),
            aggregates: Vec::new(),
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)] // 视图级测试消费（对齐 dashboard.rs current_state 用法）
    pub fn current_state(&self, cx: &App) -> DailyAnalysisState {
        self.state.read(cx).clone()
    }

    /// 当前筛选三元组（项目/站点/日期，只读；根视图回归测试断言用）
    #[allow(dead_code)] // 根视图级测试消费（对齐 current_state 惯例）
    pub fn console_filter_state(&self) -> (Option<i64>, &'static str, DateRange) {
        (self.selected_project_id, self.country, self.date_range)
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
        // BLF-795：区间缺端时回退近 7 天（防御：外部清空等）
        let (from, to) = match (self.date_range.from, self.date_range.to) {
            (Some(f), Some(t)) => (f, t),
            _ => last_7_days_window(chrono::Local::now().date_naive()),
        };

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
                        .block_on(load_daily_analysis(&client, selected, country, from, to))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// BLF-795：Console Bar 筛选一键应用——对比当前三维，只对变化维度落值，
    /// 任一变化仅触发一次 reload（避免逐控件切换造成的多次拉取）。
    /// 返回是否有实际变化。
    pub fn apply_console_filter(
        &mut self,
        project_id: Option<i64>,
        country: &'static str,
        range: DateRange,
        cx: &mut Context<Self>,
    ) -> bool {
        let project_changed = project_id != self.selected_project_id;
        let country_changed = country != self.country;
        // 区间只在两端齐全时才应用（与 reload 的回退口径一致）
        let range_changed =
            range.from.is_some() && range.to.is_some() && range != self.date_range;
        if !project_changed && !country_changed && !range_changed {
            return false;
        }
        if project_changed {
            self.selected_project_id = project_id;
        }
        if country_changed {
            self.country = country;
        }
        if range_changed {
            self.date_range = range;
        }
        self.reload(cx);
        true
    }

    // ---- Pattern A 工具栏动作 ----

    /// 切换数据集 → 重算网格切片与聚合
    pub fn select_dataset(&mut self, dataset: GridDataset, cx: &mut Context<Self>) {
        if dataset == self.dataset {
            return;
        }
        self.dataset = dataset;
        self.refresh_grids(cx);
    }

    /// 搜索关键词变更 → 回到第 1 页重算（实时过滤）
    pub fn set_search_query(&mut self, query: String, cx: &mut Context<Self>) {
        if query == self.search_query {
            return;
        }
        self.search_query = query;
        self.page = 1;
        self.refresh_grids(cx);
    }

    /// 广告状态筛选变更 → 回到第 1 页重算
    pub fn set_ad_filter(&mut self, filter: AdFilter, cx: &mut Context<Self>) {
        if filter == self.ad_filter {
            return;
        }
        self.ad_filter = filter;
        self.page = 1;
        self.refresh_grids(cx);
    }

    /// 翻页（底部分页器回调；页码越界由 PageState 收敛）
    pub fn set_page(&mut self, page: usize, cx: &mut Context<Self>) {
        let target = page.max(1);
        if target == self.page {
            return;
        }
        self.page = target;
        self.refresh_grids(cx);
    }

    /// 改每页行数（回到第 1 页）
    pub fn set_page_size(&mut self, size: usize, cx: &mut Context<Self>) {
        let size = size.max(1);
        if size == self.page_size() {
            return;
        }
        self.page = 1;
        self.page_size_override = Some(size);
        self.refresh_grids(cx);
    }

    fn page_size(&self) -> usize {
        self.page_size_override.unwrap_or(DEFAULT_PAGE_SIZE)
    }

    /// 应用拉取结果：竞态保护（过期响应丢弃）+ Loaded 落点前刷新网格与聚合，
    /// 并把 KPI 推送给 Console Bar 统计 pill。
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
                // BLF-795：KPI 推送给 Console Bar 统计 pill（GMV / 订单数）；
                // BLF-812：Pending 接真实合计（BLF-811 后端字段，与聚合条同源）
                let kpi = KpiSummary::from_rows(&data.summary_rows);
                let pending: i64 = data.summary_rows.iter().map(|r| r.pending_order_qty).sum();
                cx.emit(ConsoleStatsEvent(ConsoleStats {
                    gmv: Some(kpi.sales_amount),
                    orders: Some(kpi.order_qty),
                    pending: Some(pending),
                }));
            }
        }
        self.state.update(cx, |state, cx| {
            *state = DailyAnalysisState::from_fetch_result(result);
            cx.notify();
        });
        self.refresh_grids(cx);
    }

    /// Pattern A 中枢刷新：对当前数据集做 关键词 × 广告状态 过滤 →
    /// 重算分页收敛 → 注入当前页切片到对应网格 → 重算聚合条目。
    /// 数据落点 / 数据集切换 / 搜索 / 状态筛选 / 翻页共用（单一事实来源）。
    fn refresh_grids(&mut self, cx: &mut Context<Self>) {
        let DailyAnalysisState::Loaded(data) = self.state.read(cx).clone() else {
            self.aggregates.clear();
            self.page_state = PageState::new(1, self.page_size(), 0);
            cx.notify();
            return;
        };
        let (query, ad_filter) = (self.search_query.as_str(), self.ad_filter);

        // 三数据集全部按当前筛选刷新（切数据集即见数据）；底条只反映当前数据集
        let detail_rows = filter_detail_rows(&data.detail_rows, query, ad_filter);
        let daily_rows = filter_daily_rows(&data.summary_rows, query, ad_filter);
        let breakdown_rows = filter_breakdown_rows(&data.breakdown, query, ad_filter);

        let detail_slice = {
            let state = PageState::new(self.page, self.page_size(), detail_rows.len());
            page_slice(&detail_rows, &state)
        };
        let daily_slice = {
            let state = PageState::new(self.page, self.page_size(), daily_rows.len());
            page_slice(&daily_rows, &state)
        };
        let breakdown_slice = {
            let state = PageState::new(self.page, self.page_size(), breakdown_rows.len());
            page_slice(&breakdown_rows, &state)
        };

        self.detail_grid
            .update(cx, |g, cx| g.set_rows(detail_slice, cx));
        self.daily_grid
            .update(cx, |g, cx| g.set_rows(daily_slice, cx));
        self.breakdown_grid
            .update(cx, |g, cx| g.set_rows(breakdown_slice, cx));

        self.page_state = PageState::new(
            self.page,
            self.page_size(),
            match self.dataset {
                GridDataset::Detail => detail_rows.len(),
                GridDataset::Daily => daily_rows.len(),
                GridDataset::Breakdown => breakdown_rows.len(),
            },
        );
        self.aggregates = match self.dataset {
            GridDataset::Detail => detail_aggregates(&detail_rows),
            GridDataset::Daily => daily_aggregates(&daily_rows),
            GridDataset::Breakdown => breakdown_aggregates(&breakdown_rows),
        };
        cx.notify();
    }
}

/// BLF-795：Loaded 后向 Console Bar 推送统计 pill 数据
impl EventEmitter<ConsoleStatsEvent> for DailyAnalysisView {}

/// 每页默认行数（Pattern A 高密度档位）
pub const DEFAULT_PAGE_SIZE: usize = 50;

/// 取当前页切片（PageState 收敛后的安全区间）
fn page_slice<T: Clone>(rows: &[T], state: &PageState) -> Vec<T> {
    if rows.is_empty() {
        return Vec::new();
    }
    rows[state.first_index()..=state.last_index()].to_vec()
}

// ---------------------------------------------------------------------------
// 聚合条目（数字一律 mono 渲染于 grid_footer_bar；Pending 含口径标注）
// ---------------------------------------------------------------------------

/// 明细数据集聚合：总销售额（GMV）/ 总订单数 / 总广告花费 / Pending 待发货合计
pub fn detail_aggregates(rows: &[DailyAnalysisDetailRow]) -> Vec<AggregateItem> {
    vec![
        AggregateItem::new(
            "总销售额",
            fmt_money_precise(rows.iter().map(|r| r.sales_amount).sum()),
        ),
        AggregateItem::new(
            "总订单数",
            fmt_num_precise(rows.iter().map(|r| r.order_qty).sum()),
        ),
        AggregateItem::new(
            "广告花费",
            fmt_money_precise(rows.iter().map(|r| r.ad_spend).sum()),
        ),
        pending_item(rows.iter().map(|r| r.pending_order_qty).sum()),
    ]
}

/// 每日汇总聚合：同明细四项
pub fn daily_aggregates(rows: &[DailyAnalysisRow]) -> Vec<AggregateItem> {
    vec![
        AggregateItem::new(
            "总销售额",
            fmt_money_precise(rows.iter().map(|r| r.sales_amount).sum()),
        ),
        AggregateItem::new(
            "总订单数",
            fmt_num_precise(rows.iter().map(|r| r.order_qty).sum()),
        ),
        AggregateItem::new(
            "广告花费",
            fmt_money_precise(rows.iter().map(|r| r.ad_spend).sum()),
        ),
        pending_item(rows.iter().map(|r| r.pending_order_qty).sum()),
    ]
}

/// 维度下钻聚合：三项合计（无 Pending 维度）
pub fn breakdown_aggregates(rows: &[BreakdownRow]) -> Vec<AggregateItem> {
    vec![
        AggregateItem::new(
            "总销售额",
            fmt_money_precise(rows.iter().map(|r| r.sales).sum()),
        ),
        AggregateItem::new(
            "总订单数",
            fmt_num_precise(rows.iter().map(|r| r.orders).sum()),
        ),
        AggregateItem::new(
            "广告花费",
            fmt_money_precise(rows.iter().map(|r| r.ad_spend).sum()),
        ),
    ]
}

/// Pending 条目：窗口内待发货订单合计 + 警示色与口径标注
/// （BLF-798 占位 → BLF-812 接线：后端 BLF-811 已在行级输出 `pending_order_qty`）
fn pending_item(pending_qty: i64) -> AggregateItem {
    AggregateItem::new("Pending", fmt_num_precise(pending_qty))
        .tone(AggregateTone::Warning)
        .note("口径：窗口内待发货订单")
}

// ---------------------------------------------------------------------------
// 列定义（数值列走 number 构造器 → JetBrains Mono + tnum 右对齐可排序）
// ---------------------------------------------------------------------------

/// 明细网格 12 列（列宽沿用旧 gpui-component Table 版；数值列全部 mono）
fn detail_columns() -> Vec<ColumnDef<DailyAnalysisDetailRow>> {
    vec![
        ColumnDef::text("date", "日期", |r: &DailyAnalysisDetailRow, _| {
            SharedString::from(r.date.to_string())
        })
        .width(96.0)
        .numeric(true),
        ColumnDef::text("sku", "SKU", |_r: &DailyAnalysisDetailRow, _| SharedString::from(""))
            .with_render_element(|r: &DailyAnalysisDetailRow, theme| sku_cell(&r.sku, theme))
            .width(150.0),
        ColumnDef::number("orders", "订单量", |r: &DailyAnalysisDetailRow| r.order_qty as f64, |r: &DailyAnalysisDetailRow, _| {
            SharedString::from(fmt_num_precise(r.order_qty))
        })
        .width(76.0),
        ColumnDef::number("sales", "销售额", |r: &DailyAnalysisDetailRow| r.sales_amount, |r: &DailyAnalysisDetailRow, _| {
            SharedString::from(fmt_money_precise(r.sales_amount))
        })
        .width(104.0),
        ColumnDef::number("ad_spend", "广告花费", |r: &DailyAnalysisDetailRow| r.ad_spend, |r: &DailyAnalysisDetailRow, _| {
            SharedString::from(fmt_money_precise(r.ad_spend))
        })
        .width(104.0),
        ColumnDef::number("impressions", "曝光量", |r: &DailyAnalysisDetailRow| r.impressions as f64, |r: &DailyAnalysisDetailRow, _| {
            SharedString::from(fmt_num_precise(r.impressions))
        })
        .width(92.0),
        ColumnDef::number("clicks", "点击量", |r: &DailyAnalysisDetailRow| r.clicks as f64, |r: &DailyAnalysisDetailRow, _| {
            SharedString::from(fmt_num_precise(r.clicks))
        })
        .width(76.0),
        ColumnDef::number("cpc", "CPC", |r: &DailyAnalysisDetailRow| r.cpc, |r: &DailyAnalysisDetailRow, _| {
            SharedString::from(format!("{:.2}", r.cpc))
        })
        .width(72.0),
        ColumnDef::number("ad_orders", "广告订单", |r: &DailyAnalysisDetailRow| r.ad_orders as f64, |r: &DailyAnalysisDetailRow, _| {
            SharedString::from(fmt_num_precise(r.ad_orders))
        })
        .width(84.0),
        ColumnDef::number("available", "可售库存", |r: &DailyAnalysisDetailRow| r.available_qty as f64, |r: &DailyAnalysisDetailRow, _| {
            SharedString::from(fmt_num_precise(r.available_qty))
        })
        .width(88.0),
        ColumnDef::number("units", "销量", |r: &DailyAnalysisDetailRow| r.units_ordered as f64, |r: &DailyAnalysisDetailRow, _| {
            SharedString::from(fmt_num_precise(r.units_ordered))
        })
        .width(72.0),
        ColumnDef::number("conversion", "转化率", |r: &DailyAnalysisDetailRow| r.conversion_rate, |r: &DailyAnalysisDetailRow, _| {
            SharedString::from(format!("{:.2}%", r.conversion_rate))
        })
        .width(84.0),
    ]
}

/// 每日汇总网格列（日期 + 当日聚合指标）
fn daily_columns() -> Vec<ColumnDef<DailyAnalysisRow>> {
    vec![
        ColumnDef::text("date", "日期", |r: &DailyAnalysisRow, _| {
            SharedString::from(r.date.to_string())
        })
        .width(96.0)
        .numeric(true),
        ColumnDef::number("orders", "订单量", |r: &DailyAnalysisRow| r.order_qty as f64, |r: &DailyAnalysisRow, _| {
            SharedString::from(fmt_num_precise(r.order_qty))
        })
        .width(76.0),
        ColumnDef::number("sales", "销售额", |r: &DailyAnalysisRow| r.sales_amount, |r: &DailyAnalysisRow, _| {
            SharedString::from(fmt_money_precise(r.sales_amount))
        })
        .width(104.0),
        ColumnDef::number("ad_spend", "广告花费", |r: &DailyAnalysisRow| r.ad_spend, |r: &DailyAnalysisRow, _| {
            SharedString::from(fmt_money_precise(r.ad_spend))
        })
        .width(104.0),
        ColumnDef::number("impressions", "曝光量", |r: &DailyAnalysisRow| r.impressions as f64, |r: &DailyAnalysisRow, _| {
            SharedString::from(fmt_num_precise(r.impressions))
        })
        .width(92.0),
        ColumnDef::number("clicks", "点击量", |r: &DailyAnalysisRow| r.clicks as f64, |r: &DailyAnalysisRow, _| {
            SharedString::from(fmt_num_precise(r.clicks))
        })
        .width(76.0),
        ColumnDef::number("cpc", "CPC", |r: &DailyAnalysisRow| r.cpc, |r: &DailyAnalysisRow, _| {
            SharedString::from(format!("{:.2}", r.cpc))
        })
        .width(72.0),
        ColumnDef::number("ad_orders", "广告订单", |r: &DailyAnalysisRow| r.ad_orders as f64, |r: &DailyAnalysisRow, _| {
            SharedString::from(fmt_num_precise(r.ad_orders))
        })
        .width(84.0),
        ColumnDef::number("available", "可售库存", |r: &DailyAnalysisRow| r.available_qty as f64, |r: &DailyAnalysisRow, _| {
            SharedString::from(fmt_num_precise(r.available_qty))
        })
        .width(88.0),
        ColumnDef::number("units", "销量", |r: &DailyAnalysisRow| r.units_ordered as f64, |r: &DailyAnalysisRow, _| {
            SharedString::from(fmt_num_precise(r.units_ordered))
        })
        .width(72.0),
        ColumnDef::number("conversion", "转化率", |r: &DailyAnalysisRow| r.conversion_rate, |r: &DailyAnalysisRow, _| {
            SharedString::from(format!("{:.2}%", r.conversion_rate))
        })
        .width(84.0),
    ]
}

/// 维度下钻网格列（名称 + 合计指标 + 环比语义色）
fn breakdown_columns() -> Vec<ColumnDef<BreakdownRow>> {
    vec![
        ColumnDef::text("name", "名称", |_r: &BreakdownRow, _| SharedString::from(""))
            .with_render_element(|r: &BreakdownRow, theme| sku_cell(&r.name, theme))
            .width(200.0),
        ColumnDef::number("sales", "销售额", |r: &BreakdownRow| r.sales, |r: &BreakdownRow, _| {
            SharedString::from(fmt_money_precise(r.sales))
        })
        .width(120.0),
        ColumnDef::number("orders", "订单量", |r: &BreakdownRow| r.orders as f64, |r: &BreakdownRow, _| {
            SharedString::from(fmt_num_precise(r.orders))
        })
        .width(90.0),
        ColumnDef::number("ad_spend", "广告花费", |r: &BreakdownRow| r.ad_spend, |r: &BreakdownRow, _| {
            SharedString::from(fmt_money_precise(r.ad_spend))
        })
        .width(120.0),
        ColumnDef::number("change", "环比", |r: &BreakdownRow| r.change.unwrap_or(f64::MIN), |_r, _| {
            SharedString::from("")
        })
        .width(110.0)
        .with_render_element(|r: &BreakdownRow, theme| change_indicator(r.change, theme)),
    ]
}

/// 主键文本单元格（primary 色 + 截断）
fn sku_cell(text: &str, theme: &AppTheme) -> gpui::AnyElement {
    div()
        .truncate()
        .text_color(theme.text_primary)
        .child(SharedString::from(text.to_string()))
        .into_any_element()
}

// ---------------------------------------------------------------------------
// 渲染（Pattern A 骨架：四态外壳 + 工具栏 + 网格 + pinned 底条）
// ---------------------------------------------------------------------------

impl Render for DailyAnalysisView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();

        // 搜索输入框懒建（首帧；InputState::new 需要 window）
        if self.search_input.is_none() {
            let input =
                cx.new(|cx| InputState::new(window, cx).placeholder("搜索 SKU / ASIN…"));
            self.search_sub =
                Some(cx.subscribe(&input, |this, _e, event: &InputEvent, cx| {
                    if let InputEvent::Change = event {
                        let query = this
                            .search_input
                            .as_ref()
                            .map(|input| input.read(cx).value().to_string())
                            .unwrap_or_default();
                        this.set_search_query(query, cx);
                    }
                }));
            self.search_input = Some(input);
        }

        match state {
            DailyAnalysisState::Loading => render_loading(&app_theme).into_any_element(),
            DailyAnalysisState::Error(msg) => render_error(cx, &app_theme, &msg).into_any_element(),
            DailyAnalysisState::Empty => render_empty(cx, &app_theme).into_any_element(),
            DailyAnalysisState::Loaded(_) => self.render_loaded(&app_theme, window, cx).into_any_element(),
        }
    }
}

impl DailyAnalysisView {
    /// Loaded：Pattern A 骨架——FilterToolbar 行 + 虚拟化大表 + pinned 聚合分页条
    fn render_loaded(
        &mut self,
        app_theme: &AppTheme,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let view = cx.entity();
        let reduce = crate::motion::reduce_motion(cx);

        // 工具栏内容：数据维度下拉 + 搜索输入 + 广告状态下拉 + 弹性位 + 刷新
        let dataset = self.dataset;
        let ad_filter = self.ad_filter;
        let breakdown_available = self
            .state
            .read(cx)
            .loaded_breakdown_len()
            .map(|len| len > 0)
            .unwrap_or(false);
        let toolbar = h_flex()
            .gap_2()
            .items_center()
            // 数据维度切换（下拉；下钻维度无数据时菜单项禁用置灰）
            .child(dataset_menu(&view, dataset, breakdown_available))
            .child(toolbar_search_input(
                app_theme,
                self.search_input.as_ref().expect("搜索框已懒建"),
                "daily-analysis-search",
                200.0,
            ))
            .child(ad_filter_menu(view.clone(), ad_filter))
            .child(toolbar_spacer())
            .child(
                Button::new("daily-analysis-refresh")
                    .outline()
                    .small()
                    .label("刷新")
                    .on_click({
                        let view = view.clone();
                        move |_, _window, cx| {
                            view.update(cx, |this, cx| this.reload(cx));
                        }
                    }),
            );

        // 当前数据集网格
        let grid: gpui::AnyElement = match self.dataset {
            GridDataset::Detail => self.detail_grid.clone().into_any_element(),
            GridDataset::Daily => self.daily_grid.clone().into_any_element(),
            GridDataset::Breakdown => self.breakdown_grid.clone().into_any_element(),
        };

        // 页面头部（全仓库业务视图一致性契约；副标题 = 项目/站点/窗口口径）
        let console = match self.state.read(cx).clone() {
            DailyAnalysisState::Loaded(data) => data.console,
            _ => unreachable!("render_loaded 仅在 Loaded 态进入"),
        };
        let header = PageHeader::new("销售数据").subtitle(format!(
            "{} · {} · {} ~ {} · {} 天汇总",
            console.project_name,
            country_label(&console.country),
            console.start_date,
            console.end_date,
            console.summary_days
        ));

        // pinned 底部聚合分页条（聚合数字 mono；分页器复用公共构建块）
        let aggregates = self.aggregates.clone();
        let page_state = self.page_state;
        let footer = grid_footer_bar(
            &view,
            app_theme,
            "daily-analysis",
            &aggregates,
            &page_state,
            &PAGE_SIZE_OPTIONS,
            |this, page, cx| this.set_page(page, cx),
            |this, size, cx| this.set_page_size(size, cx),
        );

        crate::motion::enter_fade_in(
            gpui::SharedString::from("daily-analysis-loaded-fade"),
            pattern_a_shell(app_theme, "daily-analysis", header, toolbar, grid, footer),
            reduce,
        )
    }
}

/// 数据维度下拉（Pattern A 工具栏「数据集」选择器）
fn dataset_menu(
    view: &Entity<DailyAnalysisView>,
    current: GridDataset,
    breakdown_available: bool,
) -> impl IntoElement {
    let view = view.clone();
    Button::new("daily-analysis-dataset")
        .outline()
        .small()
        .label(SharedString::from(current.label()))
        .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
        .dropdown_menu_with_anchor(gpui::Corner::BottomLeft, move |menu, _window, _cx| {
            let mut menu = menu;
            for dataset in [GridDataset::Detail, GridDataset::Daily, GridDataset::Breakdown] {
                if dataset == GridDataset::Breakdown && !breakdown_available {
                    continue; // 单项目 × 单站点模式下无下钻数据 → 不出项
                }
                let checked = current == dataset;
                let label = dataset.label();
                let view = view.clone();
                menu = menu.item(
                    PopupMenuItem::new(label)
                        .checked(checked)
                        .on_click(move |_, _window, cx| {
                            view.update(cx, |this, cx| this.select_dataset(dataset, cx));
                        }),
                );
            }
            menu
        })
}

/// 广告状态筛选下拉（Pattern A 工具栏「状态下拉」）
fn ad_filter_menu(view: Entity<DailyAnalysisView>, current: AdFilter) -> impl IntoElement {
    h_flex()
        .gap_1p5()
        .items_center()
        .child(
            Button::new("daily-analysis-ad-filter")
                .outline()
                .small()
                .label(SharedString::from(format!("广告：{}", current.label())))
                .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                .dropdown_menu_with_anchor(gpui::Corner::BottomLeft, move |menu, _window, _cx| {
                    let mut menu = menu;
                    for (label, filter) in AdFilter::OPTIONS {
                        let checked = current == filter;
                        let view = view.clone();
                        menu = menu.item(
                            PopupMenuItem::new(label)
                                .checked(checked)
                                .on_click(move |_, _window, cx| {
                                    view.update(cx, |this, cx| this.set_ad_filter(filter, cx));
                                }),
                        );
                    }
                    menu
                }),
        )
}

// ---------------------------------------------------------------------------
// 四态渲染（Loading / Error / Empty 复用公共 state_views）
// ---------------------------------------------------------------------------

/// Loading：声明式骨架块（筛选行 / 数字带 / 明细表）
fn render_loading(app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("daily-analysis-loading")
        .size_full()
        .bg(app_theme.window_bg)
        .child(state_views::skeleton_loading(
            app_theme,
            &[SkeletonBlock::Title, SkeletonBlock::Filter(3), SkeletonBlock::Kpi(6)],
        ))
        .child(state_views::skeleton_loading(app_theme, &[SkeletonBlock::Table(300.0)]))
}

/// Error：卡片内 Alert + 重试按钮（公共组件 `state_views::error_state`）
fn render_error(
    cx: &mut Context<DailyAnalysisView>,
    app_theme: &AppTheme,
    msg: &str,
) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("daily-analysis-error")
        .size_full()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::error_state(
            &view,
            app_theme,
            "daily-analysis-error",
            "销售数据加载失败",
            msg.to_string(),
            |this, cx| this.reload(cx),
        ))
}

/// Empty：Icon + 文案 + 刷新按钮（公共组件 `empty_state_with_action`）
fn render_empty(cx: &mut Context<DailyAnalysisView>, app_theme: &AppTheme) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("daily-analysis-empty")
        .size_full()
        .items_center()
        .justify_center()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::empty_state_with_action(
            &view,
            app_theme,
            "daily-analysis-empty",
            "icons/package.svg",
            "暂无销售数据",
            "刷新",
            |this, cx| this.reload(cx),
        ))
}

// ---------------------------------------------------------------------------
// 数据管线（与视图解耦便于测试）
// ---------------------------------------------------------------------------

/// 拉取销售数据（项目列表 + 按「项目 × 国家」模式拉主数据与对比期）。
///
/// 对齐 frontend `loadData`：
/// - 项目列表为空 → 返回空载荷（`summary_rows` 空），由 `is_empty` 归入 Empty 态；
/// - 主数据 + 对比期并行拉取（`Promise.all` 等价）；对比期失败不阻塞主数据
///   （环比显示「—」）；
/// - 全部项目 + 全部站点 → Err（后端不支持聚合矩阵，与 frontend 提示一致）。
///
/// BLF-795：日期区间由调用方给定（Console Bar 驱动）；对比期 = 紧邻其前、
/// 等长的窗口（近 7 天默认口径时与原 `previous_7_days_window` 一致）。
async fn load_daily_analysis(
    client: &Client,
    selected_project_id: Option<i64>,
    country: &str,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<DailyAnalysisData, String> {
    let projects = client
        .list_managed_projects()
        .await
        .map_err(|e| e.user_message())?;
    let mode = mode_for(selected_project_id, country).ok_or_else(|| {
        "暂不支持「全部项目 × 全部站点」：请先选定具体项目，再选择「全部站点」以查看跨国家汇总。"
            .to_string()
    })?;

    // 对比期：紧邻主窗口之前的等长区间
    let span = (to - from).num_days().max(0) as u64 + 1;
    let compare_to = from
        .checked_sub_days(chrono::Days::new(1))
        .unwrap_or(from);
    let compare_from = compare_to
        .checked_sub_days(chrono::Days::new(span - 1))
        .unwrap_or(compare_to);

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

#[cfg(test)]
mod tests {
    use super::*;
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

    // ---------- 纯函数：工具栏筛选（关键词 × 广告状态） ----------

    #[test]
    fn text_matches_is_case_insensitive_contains() {
        assert!(text_matches("", &["anything"]));
        assert!(text_matches("  ", &["anything"]));
        assert!(text_matches("b0-a", &["B0-A-001"]));
        assert!(!text_matches("zzz", &["B0-A-001", "2026-08-13"]));
    }

    #[test]
    fn ad_filter_semantics() {
        assert!(AdFilter::All.matches(true) && AdFilter::All.matches(false));
        assert!(AdFilter::WithAds.matches(true) && !AdFilter::WithAds.matches(false));
        assert!(!AdFilter::WithoutAds.matches(true) && AdFilter::WithoutAds.matches(false));
        assert_eq!(AdFilter::WithAds.label(), "仅广告投放");
    }

    fn detail_row(sku: &str, ad_orders: i64) -> DailyAnalysisDetailRow {
        DailyAnalysisDetailRow {
            date: NaiveDate::parse_from_str("2026-08-13", "%Y-%m-%d").unwrap(),
            sku: sku.to_string(),
            asin: Some("B0TEST01".to_string()),
            order_qty: 4,
            pending_order_qty: 0,
            sales_amount: 360.0,
            impressions: 1800,
            clicks: 60,
            cpc: 0.48,
            ad_spend: 28.8,
            ad_orders,
            available_qty: 30,
            in_transit_qty: 12,
            page_views: 96,
            units_ordered: 3,
            sessions: 80,
            ordered_sales_amount: 350.0,
            conversion_rate: 3.12,
        }
    }

    #[test]
    fn filter_detail_rows_by_keyword_and_ads() {
        let rows = vec![detail_row("B0-A-001", 1), detail_row("B0-B-002", 0)];
        // 全部
        assert_eq!(filter_detail_rows(&rows, "", AdFilter::All).len(), 2);
        // 仅广告投放（ad_orders > 0）
        assert_eq!(
            filter_detail_rows(&rows, "", AdFilter::WithAds)[0].sku,
            "B0-A-001"
        );
        // 无广告投放
        assert_eq!(
            filter_detail_rows(&rows, "", AdFilter::WithoutAds)[0].sku,
            "B0-B-002"
        );
        // 关键词命中 ASIN（大小写不敏感）
        assert_eq!(filter_detail_rows(&rows, "b0test01", AdFilter::All).len(), 2);
        // 关键词 + 状态组合
        assert!(filter_detail_rows(&rows, "A-001", AdFilter::WithoutAds).is_empty());
    }

    #[test]
    fn filter_daily_and_breakdown_rows_by_spend() {
        let daily = vec![row("2026-08-12", 100.0, 1, 20.0), row("2026-08-13", 50.0, 1, 0.0)];
        assert_eq!(filter_daily_rows(&daily, "", AdFilter::WithAds).len(), 1);
        assert_eq!(filter_daily_rows(&daily, "08-13", AdFilter::WithoutAds).len(), 1);

        let breakdown = vec![
            BreakdownRow { name: "项目 A".into(), sales: 100.0, orders: 1, ad_spend: 10.0, change: None },
            BreakdownRow { name: "项目 B".into(), sales: 50.0, orders: 1, ad_spend: 0.0, change: None },
        ];
        assert_eq!(filter_breakdown_rows(&breakdown, "", AdFilter::WithAds).len(), 1);
        assert_eq!(filter_breakdown_rows(&breakdown, "项目 b", AdFilter::All).len(), 1);
    }

    #[test]
    fn page_slice_returns_safe_window() {
        let rows: Vec<usize> = (0..120).collect();
        let s = PageState::new(3, 50, rows.len());
        assert_eq!(page_slice(&rows, &s), (100..120).collect::<Vec<_>>());
        // 越界页被 PageState 收敛到末页
        let s = PageState::new(99, 50, rows.len());
        assert_eq!(page_slice(&rows, &s), (100..120).collect::<Vec<_>>());
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
            pending_order_qty: 0,
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
            &[project(1, "项目 A"), project(2, "项目 B"), project(3, "项目 C")],
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

    // ---------- 聚合条目（Pending 口径标注契约） ----------

    #[test]
    fn aggregates_sum_and_pending_note_present() {
        let mut a = detail_row("A", 1);
        a.pending_order_qty = 2;
        let mut b = detail_row("B", 0);
        b.pending_order_qty = 3;
        let details = vec![a, b];
        let items = detail_aggregates(&details);
        assert_eq!(items.len(), 4);
        assert_eq!(items[0].value, "$720.00");
        assert_eq!(items[1].value, "8");
        assert_eq!(items[2].value, "$57.60");
        // Pending 为窗口内待发货合计（BLF-812 接线，BLF-811 后端字段）
        assert_eq!(items[3].value, "5");
        assert_eq!(items[3].tone, AggregateTone::Warning);
        assert!(items[3].note.is_some());

        // 每日汇总同口径
        let mut daily = row("2026-08-13", 100.0, 4, 1.0);
        daily.pending_order_qty = 7;
        let daily_items = daily_aggregates(&[daily]);
        assert_eq!(daily_items[3].value, "7");

        // 全零行 → Pending 显示 0（不再回退「—」占位）
        let zero_items = detail_aggregates(&[detail_row("A", 0)]);
        assert_eq!(zero_items[3].value, "0");

        let breakdown = vec![BreakdownRow {
            name: "X".into(),
            sales: 100.0,
            orders: 2,
            ad_spend: 5.0,
            change: None,
        }];
        let items = breakdown_aggregates(&breakdown);
        assert_eq!(items.len(), 3);
        assert_eq!(items[1].value, "2");
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

    // ---------- 视图级状态转移 / 竞态保护 / Pattern A 刷新链（TestAppContext） ----------

    /// 构造视图。client 指向不可达地址（127.0.0.1:1 立即 connection refused），
    /// 测试只驱动同步的 apply_result / select_project / select_country。
    fn create_view(cx: &mut gpui::TestAppContext) -> Entity<DailyAnalysisView> {
        cx.update(|cx| {
            gpui_component::init(cx);
            let client = Client::new("http://127.0.0.1:1");
            cx.new(|cx| DailyAnalysisView::new(cx, client))
        })
    }

    fn read_state(cx: &mut gpui::TestAppContext, view: &Entity<DailyAnalysisView>) -> DailyAnalysisState {
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

    /// BLF-795/798：Console Bar 是项目/站点/日期的唯一权威——
    /// apply_console_filter 任一维度变化触发一次 reload，同值回放 no-op。
    #[gpui::test]
    async fn console_filter_changes_trigger_reload(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                let (p, c, r) = this.console_filter_state();
                assert_eq!((p, c), (None, "US"));

                // 切到项目 3 → 变化触发 reload
                assert!(this.apply_console_filter(Some(3), c, r, cx));
                assert_eq!(this.latest_request_id, 1);
                assert_eq!(this.current_state(cx), DailyAnalysisState::Loading);

                // 同值回放（二次进入页面回放快照）：no-op 不重复拉取
                let (p, c, r) = this.console_filter_state();
                assert!(!this.apply_console_filter(p, c, r, cx));
                assert_eq!(this.latest_request_id, 1);

                // 切回全部项目：再次触发
                assert!(this.apply_console_filter(None, c, r, cx));
                assert_eq!(this.latest_request_id, 2);

                // 切站点 → 触发
                let (_, _, r) = this.console_filter_state();
                assert!(this.apply_console_filter(None, "ALL", r, cx));
                assert_eq!(this.latest_request_id, 3);
            });
        });
    }

    /// BLF-798 核心刷新链：apply_result → 明细/下钻网格收到当前页切片；
    /// 过期响应不触碰网格。
    #[gpui::test]
    async fn apply_result_feeds_grids(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        let mut data = sample_data();
        data.detail_rows = vec![detail_row("B0-A-001", 1)];
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
                view.read(app).detail_grid.read(app).rows().len(),
                1,
                "明细网格应收到 1 行"
            );
            // 下钻网格未选中时也随数据落点同步（切数据集即有数据）
            assert_eq!(
                view.read(app).breakdown_grid.read(app).rows().len(),
                1,
                "下钻网格应收到 1 行"
            );
            // 底条聚合同步生成（含 Pending 口径标注项）
            assert_eq!(view.read(app).aggregates.len(), 4);
        });

        // 失败结果不喂表格（保持原有行）
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 2;
                this.apply_result(2, Err("接口 500".to_string()), cx);
            });
        });
        cx.read(|app| {
            assert_eq!(view.read(app).detail_grid.read(app).rows().len(), 1);
        });
    }

    /// BLF-798 工具栏筛选联动：搜索 / 广告状态过滤即时反映到网格切片，
    /// 数据集切换切换数据源，翻页切片正确。
    #[gpui::test]
    async fn toolbar_filters_dataset_switch_and_paging(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        let mut data = sample_data();
        data.detail_rows = (0..120)
            .map(|i| {
                let mut r = detail_row(&format!("SKU-{i:03}"), i64::from(i % 2));
                r.sales_amount = f64::from(i);
                r
            })
            .collect();
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Ok(data), cx);
            });
        });

        // 默认：明细数据集，120 行全量 → 第 1 页 50 行
        cx.read(|app| {
            let v = view.read(app);
            assert_eq!(v.detail_grid.read(app).rows().len(), 50);
            assert_eq!(v.page_state.total, 120);
            assert_eq!(v.page_state.page_count(), 3);
        });

        // 广告状态筛选：仅广告投放（一半行）→ 回第 1 页，60 行总量
        cx.update(|cx| {
            view.update(cx, |this, cx| this.set_ad_filter(AdFilter::WithAds, cx));
        });
        cx.read(|app| {
            let v = view.read(app);
            assert_eq!(v.page_state.total, 60);
            assert!(v.detail_grid.read(app).rows()[0].ad_orders > 0);
        });

        // 搜索命中单行
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.set_search_query("SKU-007".to_string(), cx)
            });
        });
        cx.read(|app| {
            let v = view.read(app);
            assert_eq!(v.page_state.total, 1);
            assert_eq!(v.detail_grid.read(app).rows().len(), 1);
        });

        // 清空搜索回到 60 行（广告筛选仍在）；翻到第 2 页 → 剩余切片 10 行，
        // 首行为过滤序第 51 个奇数行 SKU-101
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.set_search_query(String::new(), cx);
                this.set_page(2, cx);
            });
        });
        cx.read(|app| {
            let v = view.read(app);
            let slice = v.detail_grid.read(app).rows();
            assert_eq!(slice.len(), 10);
            assert!(
                slice[0].sku.ends_with("-101"),
                "过滤后第 2 页首行应为 SKU-101，实际 {}",
                slice[0].sku
            );
        });

        // 切换每日汇总数据集 → 网格换源（summary_rows 1 行）
        cx.update(|cx| {
            view.update(cx, |this, cx| this.select_dataset(GridDataset::Daily, cx));
        });
        cx.read(|app| {
            let v = view.read(app);
            assert_eq!(v.daily_grid.read(app).rows().len(), 1);
            assert_eq!(v.aggregates.len(), 4, "每日汇总同样带 Pending 口径项");
        });

        // 改每页行数 → 回第 1 页并按新页宽切片
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.select_dataset(GridDataset::Detail, cx);
                this.set_ad_filter(AdFilter::All, cx);
                this.set_page_size(100, cx);
            });
        });
        cx.read(|app| {
            let v = view.read(app);
            assert_eq!(v.detail_grid.read(app).rows().len(), 100);
            assert_eq!(v.page_state.page_count(), 2);
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

    fn loaded_sample() -> DailyAnalysisData {
        let mut data = sample_data();
        data.detail_rows = vec![detail_row("B0-A-001", 1)];
        data.breakdown = vec![BreakdownRow {
            name: "测试项目".to_string(),
            sales: 1000.0,
            orders: 10,
            ad_spend: 50.0,
            change: Some(20.0),
        }];
        data
    }

    #[gpui::test]
    async fn daily_analysis_renders_in_both_modes(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        cx.update(|cx| {
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let view = create_view(cx);
        let data = loaded_sample();
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Ok(data), cx);
            });
        });
        // 窗口宿主包装 Entity → 首帧渲染完整路径（工具栏 + 虚拟化大表 + pinned 底条；
        // 含懒建 InputState 首帧创建路径与 uniform_list 可见行实例化）
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
        let view = create_view(cx);
        let (_host, _cx2) =
            cx.add_window_view(|_window, _cx| DailyAnalysisHost { view: view.clone() });
    }

    /// P4-6（BLF-761）三态统一冒烟：Empty 态（无项目 → 统一空态卡片）可渲染不 panic。
    #[gpui::test]
    async fn daily_analysis_empty_state_renders(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(
                    1,
                    Ok(DailyAnalysisData {
                        projects: Vec::new(),
                        ..sample_data()
                    }),
                    cx,
                );
            });
        });
        let (_host, _cx2) =
            cx.add_window_view(|_window, _cx| DailyAnalysisHost { view: view.clone() });
    }
}
