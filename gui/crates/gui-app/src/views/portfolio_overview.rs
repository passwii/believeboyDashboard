//! 运营 → 组合分析视图（P5-1，BLF-718）
//!
//! frontend `app/dashboard/operations/portfolio-overview/page.tsx` 的 GPUI 等价：
//! 跨项目 KPI 对比（总销售额 / 总订单量 / 总广告费 / 平均转化率 / 项目数量）、
//! 项目对比表、多项目趋势对比、贡献占比环形图。
//!
//! 架构（复用 P3-1 / P5-0 基建）：
//! - **四态状态机**：`Loading / Loaded / Empty / Error`（沿用 dashboard.rs 模式），
//!   `latest_request_id` 竞态保护——只有最新请求的响应才会落点；
//! - **数据管线**：`list_managed_projects` → 选中项目 ID 列表（默认全部）→
//!   `portfolio_overview`（`GET /daily-analysis/all`，与销售数据共用端点，
//!   对齐 frontend `usePortfolioData` 的 BEL-423 2min 客户端缓存口径）；
//! - **派生**：`build_portfolio_summary` 纯函数对齐 frontend `buildPortfolioSummary`
//!   （逐项目 Σ 汇总 + 转化率 / CPC / 贡献占比 + 平均转化率），可单测；
//! - **对比表**：P5-0 公共 `DataTable`（列定义 + 表头排序 + 空态）；
//! - **趋势图 / 环形图**：gpui-component chart（`AreaChart` 多序列折线 +
//!   `PieChart` 环形），色板走 `AppTheme::chart_palette()` 亮暗两态；
//! - **筛选**：P5-0 `filter_bar`（项目多选下拉 + 站点）+ `DateRangePickerState`
//!   （近 7 天默认）+ 刷新。
//!
//! 已知差异（有意保留，GPUI 能力边界 / 说明取舍）：
//! - **默认全选项目**：web 首屏需手动选项目才出数，GUI 默认「全部项目 + US +
//!   近 7 天」首屏即出数据（macOS 原生习惯，工具定位即跨项目对比）；
//! - **项目多选交互**：web 为常驻多选 Popover，GUI 用下拉菜单（点击切换后关闭，
//!   附「全部 / 清空」快捷项）——与其他视图筛选交互一致；
//! - 站点仅 US/DE/UK：组合分析走 `/daily-analysis/all`，后端 `normalize_country`
//!   不接受 `ALL`（422），故不提供「全部站点」；
//! - 对比表无「详情」跳转（web 跳 daily-analysis 页）；数值一律精确千分位
//!   展示（web KPI 卡 ≥1 万用「万」缩写，GUI 统一精确值）；
//! - 趋势图用 `AreaChart` 多序列（gpui-component 唯一多序列图型），fill 透明
//!   呈现纯折线（web 为多 Line）；转化率序列与 web 一致按日求和（非均值）。

use std::collections::HashMap;

use chrono::{Datelike, NaiveDate};
use gpui::{
    div, prelude::*, px, App, AsyncApp, Context, CursorStyle, Entity, FontWeight, Render,
    SharedString, WeakEntity, Window,
};
use gpui_component::{
    button::Button,
    chart::AreaChart,
    h_flex,
    menu::PopupMenuItem,
    v_flex, Icon, Sizable, StyledExt,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::dashboard::{DailyAnalysisResponse, DailyAnalysisRow};

use crate::theme::AppTheme;
use crate::widgets::chart_primitives::{ShareRow, chart_area, chart_empty, donut_share_chart};
use crate::widgets::data_table::{ColumnDef, DataTable};
use crate::widgets::date_range::{DateRange, DateRangeEvent, DateRangePickerState};
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};
use crate::widgets::{filter_bar};

/// 本页在侧栏中的 URL（root.rs 据此路由；与 gui-domain::sidebar 的组合分析条目一致）
pub const PORTFOLIO_URL: &str = "/dashboard/operations/portfolio-overview";

/// 站点选项（对齐 frontend portfolio `CountrySelect`；无「全部站点」——
/// 后端 `/daily-analysis/all` 的 `normalize_country` 只接受 US/DE/UK）
const COUNTRY_OPTIONS: [(&str, &str); 3] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
];

/// 默认站点（对齐 frontend `useState('US')`）
const DEFAULT_COUNTRY: &str = "US";

/// 币种符号（对齐 frontend `CURRENCY_SYMBOL`）
fn currency_symbol(country: &str) -> &'static str {
    match country {
        "DE" => "€",
        "UK" => "£",
        _ => "$",
    }
}

// ---------------------------------------------------------------------------
// 派生数据（对齐 frontend use-portfolio-data.ts `buildPortfolioSummary`）
// ---------------------------------------------------------------------------

/// 单项目组合 KPI（`project_breakdown[id]` 的 Σ 汇总 + 贡献占比）
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectPortfolioKPI {
    pub project_id: i64,
    pub project_name: String,
    pub sales_amount: f64,
    pub order_qty: i64,
    pub ad_spend: f64,
    /// 百分比数值（ordered_sales_amount / sessions × 100；无订单额时为 0）
    pub conversion_rate: f64,
    pub impressions: i64,
    pub clicks: i64,
    /// 单次点击成本（ad_spend / clicks；无点击时为 0）
    pub cpc: f64,
    pub ad_orders: i64,
    pub page_views: i64,
    pub sessions: i64,
    /// 每日聚合行（趋势图数据源）
    pub daily_trend: Vec<DailyAnalysisRow>,
    /// 销售额贡献占比（%）
    pub sales_contribution: f64,
    /// 订单量贡献占比（%）
    pub order_contribution: f64,
    /// 广告费贡献占比（%）
    pub ad_spend_contribution: f64,
    /// 币种符号（展示用；由 country 派生，对比表列渲染需要）
    pub currency: &'static str,
}

/// 组合分析汇总（对齐 frontend `PortfolioSummary`）
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PortfolioSummary {
    /// 按销售额降序（对齐 frontend 对比表初始排序 sales_amount desc）
    pub projects: Vec<ProjectPortfolioKPI>,
    pub total_sales_amount: f64,
    pub total_order_qty: i64,
    pub total_ad_spend: f64,
    /// 百分比数值（total_order_qty / total_sessions × 100；无访问时为 0）
    pub avg_conversion_rate: f64,
    pub total_impressions: i64,
    pub total_clicks: i64,
    pub total_sessions: i64,
}

fn sum_f64(rows: &[DailyAnalysisRow], f: impl Fn(&DailyAnalysisRow) -> f64) -> f64 {
    rows.iter().map(f).sum()
}

fn sum_i64(rows: &[DailyAnalysisRow], f: impl Fn(&DailyAnalysisRow) -> i64) -> i64 {
    rows.iter().map(f).sum()
}

/// 由 `/daily-analysis/all` 响应派生组合汇总（口径对齐 frontend
/// `buildPortfolioSummary`：逐 `project_breakdown` 条目 Σ + 贡献占比 + 平均转化率）。
///
/// - 转化率 = Σordered_sales_amount / Σsessions × 100（无订单额 → 0）；
/// - CPC = ad_spend / clicks（无点击 → 0）；
/// - 贡献占比 = 该项目值 / 总额 × 100（总额为 0 → 0）；
/// - 平均转化率 = total_order_qty / total_sessions × 100（无访问 → 0）；
/// - 结果按销售额降序（对齐 frontend 对比表初始排序）。
pub fn build_portfolio_summary(
    data: &DailyAnalysisResponse,
    projects: &[ManagedProject],
    country: &str,
) -> PortfolioSummary {
    let mut list: Vec<ProjectPortfolioKPI> = Vec::new();
    let mut total_sales_amount = 0.0;
    let mut total_order_qty = 0i64;
    let mut total_ad_spend = 0.0;
    let mut total_impressions = 0i64;
    let mut total_clicks = 0i64;
    let mut total_sessions = 0i64;

    for (project_id, entry) in &data.project_breakdown {
        let rows = &entry.summary_rows;
        let sales_amount = sum_f64(rows, |r| r.sales_amount);
        let order_qty = sum_i64(rows, |r| r.order_qty);
        let ad_spend = sum_f64(rows, |r| r.ad_spend);
        let impressions = sum_i64(rows, |r| r.impressions);
        let clicks = sum_i64(rows, |r| r.clicks);
        let sessions = sum_i64(rows, |r| r.sessions);
        let ordered_sales = sum_f64(rows, |r| r.ordered_sales_amount);

        total_sales_amount += sales_amount;
        total_order_qty += order_qty;
        total_ad_spend += ad_spend;
        total_impressions += impressions;
        total_clicks += clicks;
        total_sessions += sessions;

        let project_name = if entry.project_name.is_empty() {
            projects
                .iter()
                .find(|p| p.id == *project_id)
                .map(|p| p.name.clone())
                .unwrap_or_else(|| format!("项目 {project_id}"))
        } else {
            entry.project_name.clone()
        };

        list.push(ProjectPortfolioKPI {
            project_id: *project_id,
            project_name,
            sales_amount,
            order_qty,
            ad_spend,
            conversion_rate: if ordered_sales > 0.0 && sessions > 0 {
                ordered_sales / sessions as f64 * 100.0
            } else {
                0.0
            },
            impressions,
            clicks,
            cpc: if clicks > 0 { ad_spend / clicks as f64 } else { 0.0 },
            ad_orders: sum_i64(rows, |r| r.ad_orders),
            page_views: sum_i64(rows, |r| r.page_views),
            sessions,
            daily_trend: rows.clone(),
            sales_contribution: 0.0,
            order_contribution: 0.0,
            ad_spend_contribution: 0.0,
            currency: currency_symbol(country),
        });
    }

    // 贡献占比（第二遍；总额已知）
    for p in &mut list {
        p.sales_contribution = if total_sales_amount > 0.0 {
            p.sales_amount / total_sales_amount * 100.0
        } else {
            0.0
        };
        p.order_contribution = if total_order_qty > 0 {
            p.order_qty as f64 / total_order_qty as f64 * 100.0
        } else {
            0.0
        };
        p.ad_spend_contribution = if total_ad_spend > 0.0 {
            p.ad_spend / total_ad_spend * 100.0
        } else {
            0.0
        };
    }

    list.sort_by(|a, b| b.sales_amount.total_cmp(&a.sales_amount));

    PortfolioSummary {
        avg_conversion_rate: if total_sessions > 0 {
            total_order_qty as f64 / total_sessions as f64 * 100.0
        } else {
            0.0
        },
        projects: list,
        total_sales_amount,
        total_order_qty,
        total_ad_spend,
        total_impressions,
        total_clicks,
        total_sessions,
    }
}

// ---------------------------------------------------------------------------
// 图表数据派生（纯函数，可单测）
// ---------------------------------------------------------------------------

/// 趋势图多序列点：X = "MM-DD"，values[i] = 第 i 个项目在当天的指标值
/// （对齐 frontend `tickFormatter={(v) => v.slice(5)}` 的 "MM-DD" 标签）。
#[derive(Debug, Clone, PartialEq)]
pub struct MultiTrendPoint {
    pub label: String,
    /// 按项目下标对齐（与传入 `projects` 顺序一致）
    pub values: Vec<f64>,
}

/// 趋势指标（对齐 frontend `METRIC_CONFIG` 的 4 项）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrendMetric {
    Sales,
    Orders,
    AdSpend,
    Conversion,
}

impl TrendMetric {
    pub const ALL: [(&'static str, &'static str); 4] = [
        ("sales_amount", "销售额"),
        ("order_qty", "订单量"),
        ("ad_spend", "广告费"),
        ("conversion_rate", "转化率"),
    ];

    fn from_key(key: &'static str) -> Self {
        match key {
            "order_qty" => Self::Orders,
            "ad_spend" => Self::AdSpend,
            "conversion_rate" => Self::Conversion,
            _ => Self::Sales,
        }
    }

    fn row_value(self, row: &DailyAnalysisRow) -> f64 {
        match self {
            Self::Sales => row.sales_amount,
            Self::Orders => row.order_qty as f64,
            Self::AdSpend => row.ad_spend,
            // 对齐 frontend：转化率序列按日直接求和（非均值）
            Self::Conversion => row.conversion_rate,
        }
    }
}

/// 多项目趋势序列：按日期合并各项目 daily_trend，同日多项目值存 `values[i]`
/// （对齐 frontend `chartData` 的 dateMap 合并 + 排序）。
pub fn trend_series(
    projects: &[ProjectPortfolioKPI],
    metric: TrendMetric,
) -> Vec<MultiTrendPoint> {
    let mut map: HashMap<NaiveDate, Vec<f64>> = HashMap::new();
    for (ix, project) in projects.iter().enumerate() {
        for row in &project.daily_trend {
            let values = map
                .entry(row.date)
                .or_insert_with(|| vec![0.0; projects.len()]);
            values[ix] += metric.row_value(row);
        }
    }
    let mut dates: Vec<NaiveDate> = map.keys().cloned().collect();
    dates.sort();
    dates
        .into_iter()
        .map(|d| MultiTrendPoint {
            label: format!("{:02}-{:02}", d.month(), d.day()),
            values: map.remove(&d).expect("条目必然存在"),
        })
        .collect()
}

/// 贡献占比指标（对齐 frontend `METRIC_CONFIG`：销售额/订单量/广告费/访问量）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PieMetric {
    Sales,
    Orders,
    AdSpend,
    Sessions,
}

impl PieMetric {
    pub const ALL: [(&'static str, &'static str); 4] = [
        ("sales_amount", "销售额"),
        ("order_qty", "订单量"),
        ("ad_spend", "广告费"),
        ("sessions", "访问量"),
    ];

    fn from_key(key: &'static str) -> Self {
        match key {
            "order_qty" => Self::Orders,
            "ad_spend" => Self::AdSpend,
            "sessions" => Self::Sessions,
            _ => Self::Sales,
        }
    }

    fn kpi_value(self, p: &ProjectPortfolioKPI) -> f64 {
        match self {
            Self::Sales => p.sales_amount,
            Self::Orders => p.order_qty as f64,
            Self::AdSpend => p.ad_spend,
            Self::Sessions => p.sessions as f64,
        }
    }

    /// 数值展示格式化（金额带币种 / 数量千分位）
    fn fmt(self, value: f64, country: &str) -> String {
        match self {
            Self::Sales | Self::AdSpend => fmt_money(value, country),
            Self::Orders | Self::Sessions => fmt_num(value as i64),
        }
    }
}

/// 贡献占比分布行（value 语义随指标变化；`ShareRow.sales` 复用为指标值）
pub fn pie_rows(projects: &[ProjectPortfolioKPI], metric: PieMetric) -> Vec<ShareRow> {
    projects
        .iter()
        .map(|p| ShareRow {
            name: p.project_name.clone(),
            sales: metric.kpi_value(p),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 载荷 / 状态机
// ---------------------------------------------------------------------------

/// 组合分析载荷（Loaded 持有）
#[derive(Debug, Clone, PartialEq)]
pub struct PortfolioData {
    /// 全部可管理项目（多选菜单数据源；reload 刷新）
    pub projects: Vec<ManagedProject>,
    pub summary: PortfolioSummary,
    pub country: String,
    pub from: NaiveDate,
    pub to: NaiveDate,
}

impl PortfolioData {
    /// 空态判定：没有任何项目的聚合行（对齐 frontend `data.projects.length === 0`）
    pub fn is_empty(&self) -> bool {
        self.summary.projects.is_empty()
    }

    /// 空载荷（项目列表仍保留——筛选菜单数据源）
    fn empty(projects: Vec<ManagedProject>) -> Self {
        let today = chrono::Local::now().date_naive();
        Self {
            projects,
            summary: PortfolioSummary::default(),
            country: String::new(),
            from: today,
            to: today,
        }
    }
}

/// 组合分析状态机（四态；对齐 dashboard.rs）
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum PortfolioState {
    Loading,
    Loaded(PortfolioData),
    Empty,
    Error(String),
}

impl PortfolioState {
    /// 拉取结果 → 落点状态（唯一合法的「拉取完成」转移）
    pub fn from_fetch_result(result: Result<PortfolioData, String>) -> Self {
        match result {
            Ok(data) if data.is_empty() => Self::Empty,
            Ok(data) => Self::Loaded(data),
            Err(msg) => Self::Error(msg),
        }
    }
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// 组合分析视图（四态状态机 + 项目多选/站点/日期筛选 + 竞态保护）
pub struct PortfolioOverviewView {
    state: Entity<PortfolioState>,
    /// 带会话的 API client
    client: Client,
    /// 全部可管理项目（reload 刷新；多选菜单数据源）
    projects: Vec<ManagedProject>,
    /// 当前选中项目 ID（空 = 未选）；默认「全部项目」由 `user_touched_selection`
    /// 守卫：未触碰选择时按全部项目拉取
    selected_project_ids: Vec<i64>,
    /// 用户是否已手动调整过项目选择（决定默认全选 / 空选语义）
    user_touched_selection: bool,
    /// 当前站点（"US" / "DE" / "UK"）
    country: &'static str,
    /// 当前日期区间（默认近 7 天）
    range: DateRange,
    /// 请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,
    /// 当前 tab（对比表 / 趋势 / 贡献）
    active_tab: PortfolioTab,
    trend_metric: TrendMetric,
    pie_metric: PieMetric,
    /// 项目对比表（P5-0 DataTable，懒建）
    comparison_table: Entity<DataTable<ProjectPortfolioKPI>>,
    /// 日期区间选择器（P5-0；变更事件回连 reload）
    picker: Entity<DateRangePickerState>,
    /// 日期选择器事件订阅（必须持有，否则事件不送达）
    _picker_sub: Option<gpui::Subscription>,
}

/// 三个内容 tab（对齐 frontend `Tabs`：项目对比 / 趋势对比 / 贡献占比）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortfolioTab {
    Comparison,
    Trend,
    Contribution,
}

impl PortfolioTab {
    fn label(self) -> &'static str {
        match self {
            Self::Comparison => "项目对比",
            Self::Trend => "趋势对比",
            Self::Contribution => "贡献占比",
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Comparison => "comparison",
            Self::Trend => "trend",
            Self::Contribution => "contribution",
        }
    }
}

impl PortfolioOverviewView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| PortfolioState::Loading);
        let comparison_table = cx.new(|_| DataTable::new("portfolio-comparison", comparison_columns()));
        let today = chrono::Local::now().date_naive();
        let range = DateRange::last_days(7, today);
        let picker = cx.new(|cx| {
            let mut p = DateRangePickerState::new(cx);
            p.set_range(range);
            p
        });
        let sub = cx.subscribe(&picker, |this, _entity, ev, cx| {
            let DateRangeEvent::Change(range) = ev;
            this.apply_range(*range, cx);
        });
        Self {
            state,
            client,
            projects: Vec::new(),
            selected_project_ids: Vec::new(),
            user_touched_selection: false,
            country: DEFAULT_COUNTRY,
            range,
            latest_request_id: 0,
            active_tab: PortfolioTab::Comparison,
            trend_metric: TrendMetric::Sales,
            pie_metric: PieMetric::Sales,
            comparison_table,
            picker,
            _picker_sub: Some(sub),
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> PortfolioState {
        self.state.read(cx).clone()
    }

    /// 重新拉取数据：项目/站点/日期切换、错误重试、空态刷新共用入口。
    ///
    /// 每次调用递增 `latest_request_id` 并进入 Loading；响应回来时
    /// `apply_result` 只应用最新一次（竞态保护，对齐 dashboard.rs）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let selected = self.selected_project_ids.clone();
        let user_touched = self.user_touched_selection;
        let country = self.country;
        let range = self.range;

        self.state.update(cx, |state, cx| {
            *state = PortfolioState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(load_portfolio(&client, &selected, user_touched, country, range))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 切换 tab（本地状态，不重新拉数）
    pub fn select_tab(&mut self, tab: PortfolioTab, cx: &mut Context<Self>) {
        if tab == self.active_tab {
            return;
        }
        self.active_tab = tab;
        cx.notify();
    }

    /// 切换趋势指标（本地状态，不重新拉数）
    pub fn select_trend_metric(&mut self, key: &'static str, cx: &mut Context<Self>) {
        let metric = TrendMetric::from_key(key);
        if metric == self.trend_metric {
            return;
        }
        self.trend_metric = metric;
        cx.notify();
    }

    /// 切换贡献指标（本地状态，不重新拉数）
    pub fn select_pie_metric(&mut self, key: &'static str, cx: &mut Context<Self>) {
        let metric = PieMetric::from_key(key);
        if metric == self.pie_metric {
            return;
        }
        self.pie_metric = metric;
        cx.notify();
    }

    /// 切换站点 → reload（同一站点为 no-op）
    pub fn select_country(&mut self, country: &'static str, cx: &mut Context<Self>) {
        if country == self.country {
            return;
        }
        self.country = country;
        self.reload(cx);
    }

    /// 切换日期区间 → reload（同一区间为 no-op；「全部」→ 空态提示）
    pub fn apply_range(&mut self, range: DateRange, cx: &mut Context<Self>) {
        if range == self.range {
            return;
        }
        self.range = range;
        self.reload(cx);
    }

    /// 全选项目 → reload
    pub fn select_all_projects(&mut self, cx: &mut Context<Self>) {
        self.user_touched_selection = true;
        let ids = self.projects.iter().map(|p| p.id).collect::<Vec<_>>();
        if ids == self.selected_project_ids {
            return;
        }
        self.selected_project_ids = ids;
        self.reload(cx);
    }

    /// 清空项目选择 → reload（进入「请选择项目」空态）
    pub fn clear_projects(&mut self, cx: &mut Context<Self>) {
        self.user_touched_selection = true;
        if self.selected_project_ids.is_empty() {
            return;
        }
        self.selected_project_ids.clear();
        self.reload(cx);
    }

    /// 切换单个项目选中 → reload
    pub fn toggle_project(&mut self, project_id: i64, cx: &mut Context<Self>) {
        self.user_touched_selection = true;
        if self.selected_project_ids.contains(&project_id) {
            self.selected_project_ids.retain(|id| *id != project_id);
        } else {
            self.selected_project_ids.push(project_id);
        }
        self.reload(cx);
    }

    /// 应用拉取结果：竞态保护（过期响应丢弃）+ Loaded 落点前把对比表行喂给表格组件。
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<PortfolioData, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok(data) = &result {
            self.projects = data.projects.clone();
            // 首次加载默认「全部项目」：未触碰选择时把选中同步为全部 ID
            if !self.user_touched_selection && !data.projects.is_empty() {
                self.selected_project_ids = data.projects.iter().map(|p| p.id).collect();
            }
            if !data.is_empty() {
                let rows = data.summary.projects.clone();
                self.comparison_table.update(cx, |table, cx| table.set_rows(rows, cx));
            }
        }
        self.state.update(cx, |state, cx| {
            *state = PortfolioState::from_fetch_result(result);
            cx.notify();
        });
    }
}

/// 拉取组合分析（项目列表 + 选中项目聚合），与视图解耦便于测试。
///
/// 对齐 frontend `usePortfolioData`：
/// - 未触碰选择 → 默认全部项目（GUI 首屏即出数据）；
/// - 无选中项目 / 日期区间不完整 → 返回空载荷（归入 Empty 态）；
/// - 其余 → `GET /daily-analysis/all` + 派生汇总。
async fn load_portfolio(
    client: &Client,
    selected_ids: &[i64],
    user_touched: bool,
    country: &str,
    range: DateRange,
) -> Result<PortfolioData, String> {
    let projects = client
        .list_managed_projects()
        .await
        .map_err(|e| e.user_message())?;
    let ids: Vec<i64> = if user_touched {
        selected_ids.to_vec()
    } else {
        projects.iter().map(|p| p.id).collect()
    };
    let Some((from, to)) = range_bounds(range) else {
        return Ok(PortfolioData::empty(projects));
    };
    if ids.is_empty() {
        return Ok(PortfolioData::empty(projects));
    }
    let data = client
        .portfolio_overview(&ids, country, from, to)
        .await
        .map_err(|e| e.user_message())?;
    let summary = build_portfolio_summary(&data, &projects, country);
    Ok(PortfolioData {
        projects,
        summary,
        country: country.to_string(),
        from,
        to,
    })
}

/// 区间转闭区间（两端都有值才返回）
fn range_bounds(range: DateRange) -> Option<(NaiveDate, NaiveDate)> {
    match (range.from, range.to) {
        (Some(from), Some(to)) => Some((from, to)),
        _ => None,
    }
}

impl Render for PortfolioOverviewView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let view = cx.entity();
        let subtitle = match &state {
            PortfolioState::Loaded(data) => format!(
                "{} 个项目 · {} · {} ~ {}",
                data.summary.projects.len(),
                country_label(data.country.as_str()),
                data.from,
                data.to,
            ),
            _ => "跨项目 KPI 对比、趋势分析和贡献占比".to_string(),
        };

        v_flex()
            .id("portfolio-overview")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            // 页面头部（P4-5：共享 PageHeader）
            .child(PageHeader::new("组合分析").subtitle(subtitle))
            // 筛选栏：项目多选 + 站点 + 日期区间 + 刷新（宽窗受内容上限约束）
            .child(content_guard().child(render_filter_bar(
                &view,
                &app_theme,
                &self.projects,
                &self.selected_project_ids,
                self.country,
                self.picker.clone(),
            )))
            // 状态区
            .child(match state {
                PortfolioState::Loading => render_loading(&app_theme).into_any_element(),
                PortfolioState::Error(msg) => state_views::error_state(
                    &view,
                    &app_theme,
                    "portfolio-overview-error",
                    "组合分析加载失败",
                    msg,
                    |this, cx| this.reload(cx),
                )
                .into_any_element(),
                PortfolioState::Empty => {
                    let message = empty_message(self);
                    state_views::empty_state_with_action(
                        &view,
                        &app_theme,
                        "portfolio-overview-empty",
                        "icons/bar-chart-3.svg",
                        message,
                        "刷新",
                        |this, cx| this.reload(cx),
                    )
                    .into_any_element()
                }
                PortfolioState::Loaded(data) => render_loaded(
                    cx,
                    &app_theme,
                    &view,
                    &data,
                    self.active_tab,
                    self.trend_metric,
                    self.pie_metric,
                    self.comparison_table.clone(),
                )
                .into_any_element(),
            })
    }
}

/// 空态文案（按「未选项目 / 未选日期 / 无数据」区分，对齐 frontend 提示习惯）
fn empty_message(view: &PortfolioOverviewView) -> String {
    if view.selected_project_ids.is_empty() && !view.projects.is_empty() {
        "请选择项目以查看组合分析".to_string()
    } else if view.range.from.is_none() || view.range.to.is_none() {
        "请选择日期范围以查看组合分析".to_string()
    } else {
        "暂无数据，请检查日期范围或项目选择".to_string()
    }
}

/// Loading：Spinner + 声明式骨架块（KPI 卡 + 图表）
///
/// P4-6：骨架块统一走 `state_views::skeleton_loading` 声明式组合。
fn render_loading(app_theme: &AppTheme) -> impl IntoElement {
    state_views::skeleton_loading(
        app_theme,
        &[
            SkeletonBlock::Kpi(5),
            SkeletonBlock::Chart(300.0),
            SkeletonBlock::Chart(220.0),
        ],
    )
}

/// Loaded：KPI 卡 + tab 栏 + 对应内容
#[allow(clippy::too_many_arguments)]
fn render_loaded(
    cx: &mut Context<PortfolioOverviewView>,
    app_theme: &AppTheme,
    view: &Entity<PortfolioOverviewView>,
    data: &PortfolioData,
    active_tab: PortfolioTab,
    trend_metric: TrendMetric,
    pie_metric: PieMetric,
    comparison_table: Entity<DataTable<ProjectPortfolioKPI>>,
) -> impl IntoElement {
    let reduce = crate::motion::reduce_motion(cx);

    crate::motion::enter_fade_in(
        SharedString::from("portfolio-overview-loaded-fade"),
        v_flex()
            .id("portfolio-overview-loaded")
            .gap_4()
            // KPI 卡（5 张；宽窗受内容上限约束）
            .child(content_guard().child(kpi_cards(&data.summary, data.country.as_str(), app_theme)))
            // tab 栏
            .child(content_guard().child(render_tab_bar(view, active_tab, app_theme)))
            // tab 内容（对比表 = 数据表格保留全宽；趋势/贡献为图表内容受上限约束）
            .child(match active_tab {
                PortfolioTab::Comparison => {
                    comparison_card(comparison_table, app_theme).into_any_element()
                }
                PortfolioTab::Trend => content_guard()
                    .child(trend_panel(
                        view,
                        &data.summary,
                        trend_metric,
                        &data.country,
                        app_theme,
                    ))
                    .into_any_element(),
                PortfolioTab::Contribution => content_guard()
                    .child(contribution_panel(
                        view,
                        &data.summary,
                        pie_metric,
                        &data.country,
                        app_theme,
                    ))
                    .into_any_element(),
            }),
        reduce,
    )
    .into_any_element()
}

// ---------------------------------------------------------------------------
// KPI 卡
// ---------------------------------------------------------------------------

/// 5 张 KPI 卡（总销售额 / 总订单量 / 总广告费 / 平均转化率 / 项目数量）
fn kpi_cards(summary: &PortfolioSummary, country: &str, theme: &AppTheme) -> impl IntoElement {
    h_flex()
        .id("portfolio-kpi-cards")
        .gap_3()
        .flex_wrap()
        .child(kpi_card(
            "总销售额",
            fmt_money(summary.total_sales_amount, country).into(),
            "icons/trending-up.svg",
            None,
            theme,
        ))
        .child(kpi_card(
            "总订单量",
            fmt_num(summary.total_order_qty).into(),
            "icons/shopping-bag.svg",
            None,
            theme,
        ))
        .child(kpi_card(
            "总广告费",
            fmt_money(summary.total_ad_spend, country).into(),
            "icons/coins.svg",
            None,
            theme,
        ))
        .child(kpi_card(
            "平均转化率",
            format!("{:.2}%", summary.avg_conversion_rate).into(),
            "icons/target.svg",
            Some(format!("{} 次访问", fmt_num(summary.total_sessions)).into()),
            theme,
        ))
        .child(kpi_card(
            "项目数量",
            summary.projects.len().to_string().into(),
            "icons/bar-chart-3.svg",
            None,
            theme,
        ))
}

/// 单张 KPI 卡（label + 图标气泡 + 大数值 + 可选描述）
fn kpi_card(
    label: &str,
    value: SharedString,
    icon_path: &'static str,
    description: Option<SharedString>,
    theme: &AppTheme,
) -> impl IntoElement {
    // 图标气泡底：亮色 accent_soft / 暗色 muted_fill（对齐 chart_card）
    let chip_bg = if theme.is_dark() {
        theme.muted_fill
    } else {
        theme.accent_soft
    };
    let chip_icon = if theme.is_dark() {
        theme.text_muted
    } else {
        theme.accent
    };
    v_flex()
        .id(SharedString::from(format!("portfolio-kpi-{label}")))
        .flex_1()
        .min_w(px(150.))
        .gap_2()
        .p_4()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_muted)
                        .child(label.to_string()),
                )
                .child(
                    h_flex()
                        .size_7()
                        .items_center()
                        .justify_center()
                        .rounded_md()
                        .bg(chip_bg)
                        .child(
                            Icon::empty()
                                .path(icon_path)
                                .with_size(px(14.))
                                .text_color(chip_icon),
                        ),
                ),
        )
        .child(
            v_flex()
                .gap_1()
                .child(
                    div()
                        .text_2xl()
                        .font_semibold()
                        .text_color(theme.text_primary)
                        .child(value),
                )
                .when(description.is_some(), |this| {
                    this.child(
                        div()
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child(description.clone().expect("已判 Some")),
                    )
                }),
        )
}

// ---------------------------------------------------------------------------
// 筛选栏（项目多选 / 站点 / 日期 / 刷新）
// ---------------------------------------------------------------------------

/// 筛选栏：项目多选 + 站点 + 日期区间 + 刷新（公共 filter_bar 组件）。
#[allow(clippy::too_many_arguments)]
fn render_filter_bar(
    view: &Entity<PortfolioOverviewView>,
    app_theme: &AppTheme,
    projects: &[ManagedProject],
    selected_ids: &[i64],
    country: &'static str,
    picker: Entity<DateRangePickerState>,
) -> impl IntoElement {
    let projects_owned = projects.to_vec();
    let selected_owned = selected_ids.to_vec();
    let all_selected = !projects.is_empty() && selected_ids.len() == projects.len();
    let project_label: SharedString = if projects.is_empty() {
        SharedString::from("加载中…")
    } else if all_selected {
        SharedString::from(format!("全部项目 ({})", projects.len()))
    } else if selected_ids.is_empty() {
        SharedString::from("请选择项目")
    } else {
        SharedString::from(format!("已选 {} 个项目", selected_ids.len()))
    };
    let view_for_project = view.clone();
    let view_for_country = view.clone();
    let view_for_refresh = view.clone();

    filter_bar::filter_bar_layout(app_theme)
        .child(filter_bar::filter_select(
            app_theme,
            "项目",
            project_label,
            "portfolio-project-filter",
            move |menu, _window, _cx| {
                let mut menu = menu;
                // 快捷项：全部 / 清空
                let checked_all = all_selected;
                let view_all = view_for_project.clone();
                menu = menu.item(
                    PopupMenuItem::new("全部项目")
                        .checked(checked_all)
                        .on_click(move |_, _window, cx| {
                            view_all.update(cx, |this, cx| this.select_all_projects(cx));
                        }),
                );
                if !selected_owned.is_empty() {
                    let view_clear = view_for_project.clone();
                    menu = menu.item(
                        PopupMenuItem::new("清空选择")
                            .checked(false)
                            .on_click(move |_, _window, cx| {
                                view_clear.update(cx, |this, cx| this.clear_projects(cx));
                            }),
                    );
                }
                menu = menu.item(PopupMenuItem::separator());
                for project in &projects_owned {
                    let checked = selected_owned.contains(&project.id);
                    let id = project.id;
                    let name = project.name.clone();
                    let view_toggle = view_for_project.clone();
                    menu = menu.item(
                        PopupMenuItem::new(name).checked(checked).on_click(move |_, _window, cx| {
                            view_toggle.update(cx, |this, cx| this.toggle_project(id, cx));
                        }),
                    );
                }
                menu
            },
        ))
        .child(filter_bar::filter_select(
            app_theme,
            "站点",
            country_label(country).into(),
            "portfolio-country-filter",
            move |menu, _window, _cx| {
                let mut menu = menu;
                for (value, label) in COUNTRY_OPTIONS {
                    let checked = country == value;
                    let view_c = view_for_country.clone();
                    menu = menu.item(
                        PopupMenuItem::new(label).checked(checked).on_click(move |_, _window, cx| {
                            view_c.update(cx, |this, cx| this.select_country(value, cx));
                        }),
                    );
                }
                menu
            },
        ))
        .child(picker)
        .child(div().flex_1())
        .child(
            Button::new("portfolio-refresh")
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
// tab 栏
// ---------------------------------------------------------------------------

/// 顶部 tab 栏（对齐 frontend Tabs：项目对比 / 趋势对比 / 贡献占比）
fn render_tab_bar(
    view: &Entity<PortfolioOverviewView>,
    active: PortfolioTab,
    theme: &AppTheme,
) -> impl IntoElement {
    h_flex()
        .id("portfolio-tabs")
        .w_full()
        .p_1()
        .gap_1()
        .rounded(px(theme.radius_lg))
        .bg(theme.muted_fill)
        .child(tab_button(view, PortfolioTab::Comparison, active == PortfolioTab::Comparison, theme))
        .child(tab_button(view, PortfolioTab::Trend, active == PortfolioTab::Trend, theme))
        .child(tab_button(view, PortfolioTab::Contribution, active == PortfolioTab::Contribution, theme))
}

fn tab_button(
    view: &Entity<PortfolioOverviewView>,
    tab: PortfolioTab,
    selected: bool,
    theme: &AppTheme,
) -> impl IntoElement {
    let label = tab.label();
    let view = view.clone();
    div()
        .id(SharedString::from(format!("portfolio-tab-{}", tab.id())))
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
            this.text_color(theme.text_secondary).hover(|this| {
                this.bg(theme.card_bg.opacity(0.5))
            })
        })
        .on_mouse_up(
            gpui::MouseButton::Left,
            move |_, _window, cx| {
                view.update(cx, |this, cx| this.select_tab(tab, cx));
            },
        )
        .child(label.to_string())
}

// ---------------------------------------------------------------------------
// 项目对比表（P5-0 DataTable）
// ---------------------------------------------------------------------------

/// 对比表列定义（币种符号从行数据 `currency` 读取——列闭包是 fn 指针不能捕获）
fn comparison_columns() -> Vec<ColumnDef<ProjectPortfolioKPI>> {
    vec![
        ColumnDef::text(
            "project",
            "项目",
            |p: &ProjectPortfolioKPI, _: &AppTheme| {
                SharedString::from(p.project_name.clone())
            },
        )
        .width(150.0),
        ColumnDef::number(
            "sales",
            "销售额",
            |p: &ProjectPortfolioKPI| p.sales_amount,
            |p: &ProjectPortfolioKPI, _: &AppTheme| {
                SharedString::from(fmt_money(p.sales_amount, p.currency))
            },
        )
        .width(110.0),
        ColumnDef::number(
            "share",
            "占比",
            |p: &ProjectPortfolioKPI| p.sales_contribution,
            |p: &ProjectPortfolioKPI, _: &AppTheme| {
                SharedString::from(format!("{:.2}%", p.sales_contribution))
            },
        )
        .width(80.0),
        ColumnDef::number(
            "orders",
            "订单量",
            |p: &ProjectPortfolioKPI| p.order_qty as f64,
            |p: &ProjectPortfolioKPI, _: &AppTheme| SharedString::from(fmt_num(p.order_qty)),
        )
        .width(80.0),
        ColumnDef::number(
            "ad_spend",
            "广告费",
            |p: &ProjectPortfolioKPI| p.ad_spend,
            |p: &ProjectPortfolioKPI, _: &AppTheme| {
                SharedString::from(fmt_money(p.ad_spend, p.currency))
            },
        )
        .width(100.0),
        ColumnDef::number(
            "cpc",
            "CPC",
            |p: &ProjectPortfolioKPI| p.cpc,
            |p: &ProjectPortfolioKPI, _: &AppTheme| {
                if p.clicks == 0 {
                    SharedString::from("--")
                } else {
                    SharedString::from(fmt_money(p.cpc, p.currency))
                }
            },
        )
        .width(80.0),
        ColumnDef::number(
            "conversion",
            "转化率",
            |p: &ProjectPortfolioKPI| p.conversion_rate,
            |p: &ProjectPortfolioKPI, _: &AppTheme| {
                SharedString::from(format!("{:.2}%", p.conversion_rate))
            },
        )
        .width(80.0),
        ColumnDef::number(
            "clicks",
            "点击量",
            |p: &ProjectPortfolioKPI| p.clicks as f64,
            |p: &ProjectPortfolioKPI, _: &AppTheme| SharedString::from(fmt_num(p.clicks)),
        )
        .width(80.0),
        ColumnDef::number(
            "sessions",
            "访问量",
            |p: &ProjectPortfolioKPI| p.sessions as f64,
            |p: &ProjectPortfolioKPI, _: &AppTheme| SharedString::from(fmt_num(p.sessions)),
        )
        .width(80.0),
    ]
}

/// 对比表卡（卡片外壳 + DataTable）
fn comparison_card(
    table: Entity<DataTable<ProjectPortfolioKPI>>,
    theme: &AppTheme,
) -> impl IntoElement {
    v_flex()
        .id("portfolio-comparison-card")
        .w_full()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .overflow_hidden()
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
                        .child("项目对比"),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.text_muted)
                        .child("各项目销售额 / 占比 / 订单量 / 广告费 / CPC / 转化率"),
                ),
        )
        .child(table.clone())
}

// ---------------------------------------------------------------------------
// 趋势对比（AreaChart 多序列折线）
// ---------------------------------------------------------------------------

/// 趋势面板：指标下拉 + 多项目折线 + 图例
#[allow(clippy::too_many_arguments)]
fn trend_panel(
    view: &Entity<PortfolioOverviewView>,
    summary: &PortfolioSummary,
    metric: TrendMetric,
    country: &str,
    theme: &AppTheme,
) -> impl IntoElement {
    let points = trend_series(&summary.projects, metric);
    let current = TrendMetric::ALL
        .iter()
        .find(|(key, _)| TrendMetric::from_key(key) == metric)
        .map(|(_, label)| SharedString::from(*label))
        .unwrap_or_else(|| SharedString::from("销售额"));
    let view_for_metric = view.clone();

    let body = if points.is_empty() {
        chart_empty("暂无趋势数据", 300.0, theme).into_any_element()
    } else {
        let palette = theme.chart_palette();
        let mut chart = AreaChart::new(points.clone()).x(|p: &MultiTrendPoint| p.label.clone());
        for ix in 0..summary.projects.len() {
            let color = palette[ix % palette.len()];
            chart = chart
                .y(move |p: &MultiTrendPoint| p.values[ix])
                .stroke(color)
                .fill(color.opacity(0.0));
        }
        div()
            .w_full()
            .gap_3()
            .child(chart_area(300.0, chart))
            .child(multi_series_legend(summary, theme))
            .into_any_element()
    };

    v_flex()
        .id("portfolio-trend")
        .w_full()
        .gap_3()
        .p_4()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_primary)
                        .child("多项目趋势对比"),
                )
                .child(filter_bar::filter_select(
                    theme,
                    "指标",
                    current,
                    "portfolio-trend-metric",
                    move |menu, _window, _cx| {
                        let mut menu = menu;
                        for (key, label) in TrendMetric::ALL {
                            let checked = TrendMetric::from_key(key) == metric;
                            let view_m = view_for_metric.clone();
                            menu = menu.item(
                                PopupMenuItem::new(label).checked(checked).on_click(
                                    move |_, _window, cx| {
                                        view_m.update(cx, |this, cx| {
                                            this.select_trend_metric(key, cx)
                                        });
                                    },
                                ),
                            );
                        }
                        menu
                    },
                )),
        )
        .child(body)
        // 金额量级提示：当前指标的格式化参考（对齐 web 端 Y 轴省略的说明习惯）
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .child(metric_hint(metric, country)),
        )
}

/// 趋势指标的量级提示（图元无 Y 轴刻度，用参考值补足量级信息）
fn metric_hint(metric: TrendMetric, country: &str) -> String {
    match metric {
        TrendMetric::Sales => format!("Y 轴为销售额（{}），图例颜色对应各项目", currency_symbol(country)),
        TrendMetric::Orders => "Y 轴为订单量，图例颜色对应各项目".to_string(),
        TrendMetric::AdSpend => format!("Y 轴为广告费（{}），图例颜色对应各项目", currency_symbol(country)),
        TrendMetric::Conversion => "Y 轴为转化率（%），按日各项目求和（对齐 web）".to_string(),
    }
}

/// 多序列图例：色点 + 项目名（与折线颜色一一对应）
fn multi_series_legend(summary: &PortfolioSummary, theme: &AppTheme) -> impl IntoElement {
    let palette = theme.chart_palette();
    h_flex()
        .id("portfolio-trend-legend")
        .gap_3()
        .flex_wrap()
        .children(
            summary
                .projects
                .iter()
                .enumerate()
                .map(|(ix, p)| {
                    let color = palette[ix % palette.len()];
                    h_flex()
                        .gap_1p5()
                        .items_center()
                        .child(div().size_2p5().rounded_full().bg(color))
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.text_secondary)
                                .child(p.project_name.clone()),
                        )
                }),
        )
}

// ---------------------------------------------------------------------------
// 贡献占比（环形图 + 贡献列表）
// ---------------------------------------------------------------------------

/// 贡献面板：指标下拉 + 环形图 + 贡献列表（色点 + 名称 + 数值 + 占比）
fn contribution_panel(
    view: &Entity<PortfolioOverviewView>,
    summary: &PortfolioSummary,
    metric: PieMetric,
    country: &str,
    theme: &AppTheme,
) -> impl IntoElement {
    let rows = pie_rows(&summary.projects, metric);
    let total: f64 = rows.iter().map(|r| r.sales).sum();
    let current = PieMetric::ALL
        .iter()
        .find(|(key, _)| PieMetric::from_key(key) == metric)
        .map(|(_, label)| SharedString::from(*label))
        .unwrap_or_else(|| SharedString::from("销售额"));
    let view_for_metric = view.clone();

    let body = if rows.is_empty() {
        chart_empty("暂无数据", 280.0, theme).into_any_element()
    } else {
        div()
            .w_full()
            .flex()
            .gap_4()
            .items_center()
            .child(
                div()
                    .flex_1()
                    .child(chart_area(280.0, donut_share_chart(&rows, 56.0, theme))),
            )
            .child(
                div()
                    .w(px(220.))
                    .child(contribution_legend(&rows, metric, country, total, theme)),
            )
            .into_any_element()
    };

    v_flex()
        .id("portfolio-contribution")
        .w_full()
        .gap_3()
        .p_4()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_primary)
                        .child("各项目贡献占比"),
                )
                .child(filter_bar::filter_select(
                    theme,
                    "指标",
                    current,
                    "portfolio-contribution-metric",
                    move |menu, _window, _cx| {
                        let mut menu = menu;
                        for (key, label) in PieMetric::ALL {
                            let checked = PieMetric::from_key(key) == metric;
                            let view_m = view_for_metric.clone();
                            menu = menu.item(
                                PopupMenuItem::new(label).checked(checked).on_click(
                                    move |_, _window, cx| {
                                        view_m.update(cx, |this, cx| {
                                            this.select_pie_metric(key, cx)
                                        });
                                    },
                                ),
                            );
                        }
                        menu
                    },
                )),
        )
        .child(body)
}

/// 贡献列表（对齐 frontend 环形图下方列表：色点 + 项目 + 数值 + 占比）
fn contribution_legend(
    rows: &[ShareRow],
    metric: PieMetric,
    country: &str,
    total: f64,
    theme: &AppTheme,
) -> impl IntoElement {
    let palette = theme.chart_palette();
    v_flex()
        .id("portfolio-contribution-legend")
        .gap_2()
        .children(rows.iter().enumerate().map(|(ix, row)| {
            let color = palette[ix % palette.len()];
            let share = if total > 0.0 {
                row.sales / total * 100.0
            } else {
                0.0
            };
            h_flex()
                .w_full()
                .gap_2()
                .items_center()
                .child(div().size_2p5().rounded_full().bg(color))
                .child(
                    div()
                        .flex_1()
                        .text_size(px(12.))
                        .text_color(theme.text_secondary)
                        .truncate()
                        .child(row.name.clone()),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(theme.text_muted)
                        .child(metric.fmt(row.sales, country)),
                )
                .child(
                    div()
                        .w_12()
                        .text_right()
                        .text_size(px(12.))
                        .text_color(theme.text_primary)
                        .child(format!("({share:.1}%)")),
                )
        }))
}

// ---------------------------------------------------------------------------
// 数字格式化
// ---------------------------------------------------------------------------

/// 千分位 + 固定小数位（对齐 frontend `toLocaleString('zh-CN')` 展示口径）
fn format_number(value: f64, decimals: usize) -> String {
    let negative = value < 0.0;
    let scale = 10f64.powi(decimals as i32);
    let rounded = (value.abs() * scale).round() / scale;
    let integer = rounded.trunc() as u64;
    let frac = rounded.fract();

    let int_str = integer.to_string();
    let mut out = String::with_capacity(int_str.len() + int_str.len() / 3 + decimals + 1);
    for (i, ch) in int_str.chars().enumerate() {
        if i > 0 && (int_str.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    if decimals > 0 {
        out.push('.');
        let frac_val = (frac * scale).round() as u64;
        out.push_str(&format!("{frac_val:0width$}", width = decimals));
    }
    if negative {
        out.insert(0, '-');
    }
    out
}

/// 金额（币种符号 + 2 位小数 + 千分位；对齐 frontend `formatMoney` 的精确档）
fn fmt_money(value: f64, country: &str) -> String {
    format!("{}{}", currency_symbol(country), format_number(value, 2))
}

/// 数量（千分位整数）
fn fmt_num(value: i64) -> String {
    format_number(value as f64, 0)
}

/// 站点展示名（未知值原样返回）
pub fn country_label(country: &str) -> String {
    COUNTRY_OPTIONS
        .iter()
        .find(|(value, _)| *value == country)
        .map_or_else(|| country.to_string(), |(_, label)| label.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::Entity;
    use std::collections::HashMap;

    use gui_domain::dashboard::ProjectBreakdownEntry;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

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

    /// 构造单日聚合行（只关心组合分析用到的字段）
    #[allow(clippy::too_many_arguments)]
    fn row(
        date: &str,
        sales: f64,
        orders: i64,
        ad_spend: f64,
        impressions: i64,
        clicks: i64,
        sessions: i64,
        ordered_sales: f64,
        conversion: f64,
    ) -> DailyAnalysisRow {
        DailyAnalysisRow {
            date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            order_qty: orders,
            sales_amount: sales,
            impressions,
            clicks,
            cpc: if clicks > 0 { ad_spend / clicks as f64 } else { 0.0 },
            ad_spend,
            ad_orders: 0,
            available_qty: 0,
            page_views: 0,
            units_ordered: 0,
            sessions,
            ordered_sales_amount: ordered_sales,
            conversion_rate: conversion,
        }
    }

    fn entry(name: &str, rows: Vec<DailyAnalysisRow>) -> ProjectBreakdownEntry {
        ProjectBreakdownEntry {
            project_name: name.to_string(),
            summary_rows: rows,
            detail_rows: Vec::new(),
        }
    }

    // ---------- build_portfolio_summary（对齐 frontend buildPortfolioSummary） ----------

    #[test]
    fn build_sums_and_contributions_match_frontend_formulas() {
        // 项目 A：2 天销售额 1000+2000=3000，订单 10+20=30，广告 50+100=150，
        //   点击 100+200=300，访问 1000+2000=3000，订单额 900+1900=2800
        let mut breakdown = HashMap::new();
        breakdown.insert(
            1i64,
            entry(
                "项目 A",
                vec![
                    row("2026-08-13", 1000.0, 10, 50.0, 500, 100, 1000, 900.0, 2.5),
                    row("2026-08-14", 2000.0, 20, 100.0, 800, 200, 2000, 1900.0, 3.0),
                ],
            ),
        );
        // 项目 B：1 天销售额 500，订单 5，广告 25，点击 0（CPC → 0，转化率 → 0）
        breakdown.insert(
            2i64,
            entry(
                "项目 B",
                vec![row("2026-08-13", 500.0, 5, 25.0, 100, 0, 400, 0.0, 0.0)],
            ),
        );
        let data = DailyAnalysisResponse {
            summary_rows: Vec::new(),
            detail_rows: Vec::new(),
            available_dates: Default::default(),
            project_breakdown: breakdown,
        };
        let projects = vec![project(1, "项目 A"), project(2, "项目 B")];
        let summary = build_portfolio_summary(&data, &projects, "US");

        // 总额
        assert_eq!(summary.total_sales_amount, 3500.0);
        assert_eq!(summary.total_order_qty, 35);
        assert_eq!(summary.total_ad_spend, 175.0);
        assert_eq!(summary.total_impressions, 1400);
        assert_eq!(summary.total_clicks, 300);
        assert_eq!(summary.total_sessions, 3400);

        // 项目 A：转化率 = 2800/3000×100 ≈ 93.33；CPC = 150/300 = 0.5
        let a = &summary.projects[0];
        assert_eq!(a.project_name, "项目 A");
        assert_eq!(a.sales_amount, 3000.0);
        assert_eq!(a.order_qty, 30);
        assert!((a.conversion_rate - 2800.0 / 3000.0 * 100.0).abs() < 1e-9);
        assert!((a.cpc - 0.5).abs() < 1e-9);
        // 贡献占比
        assert!((a.sales_contribution - 3000.0 / 3500.0 * 100.0).abs() < 1e-9);
        assert!((a.order_contribution - 30.0 / 35.0 * 100.0).abs() < 1e-9);
        assert!((a.ad_spend_contribution - 150.0 / 175.0 * 100.0).abs() < 1e-9);

        // 项目 B：clicks=0 → CPC 0 / 无订单额 → 转化率 0
        let b = &summary.projects[1];
        assert_eq!(b.project_name, "项目 B");
        assert_eq!(b.cpc, 0.0);
        assert_eq!(b.conversion_rate, 0.0);

        // 平均转化率 = 35 / 3400 × 100
        assert!((summary.avg_conversion_rate - 35.0 / 3400.0 * 100.0).abs() < 1e-9);

        // 销售额降序：A(3000) 在前
        assert_eq!(summary.projects.len(), 2);
        assert!(summary.projects[0].sales_amount >= summary.projects[1].sales_amount);

        // 币种符号跟随 country
        assert_eq!(a.currency, "$");
        let de = build_portfolio_summary(&data, &projects, "DE");
        assert_eq!(de.projects[0].currency, "€");
        let uk = build_portfolio_summary(&data, &projects, "UK");
        assert_eq!(uk.projects[0].currency, "£");
    }

    #[test]
    fn build_empty_breakdown_yields_empty_summary() {
        let data = DailyAnalysisResponse {
            summary_rows: Vec::new(),
            detail_rows: Vec::new(),
            available_dates: Default::default(),
            project_breakdown: HashMap::new(),
        };
        let summary = build_portfolio_summary(&data, &[project(1, "A")], "US");
        assert!(summary.projects.is_empty());
        assert_eq!(summary.total_sales_amount, 0.0);
        assert_eq!(summary.avg_conversion_rate, 0.0);
    }

    #[test]
    fn build_falls_back_to_project_list_name() {
        let mut breakdown = HashMap::new();
        breakdown.insert(
            7i64,
            entry("", vec![row("2026-08-13", 100.0, 1, 10.0, 10, 1, 10, 100.0, 1.0)]),
        );
        let data = DailyAnalysisResponse {
            summary_rows: Vec::new(),
            detail_rows: Vec::new(),
            available_dates: Default::default(),
            project_breakdown: breakdown,
        };
        let summary = build_portfolio_summary(&data, &[project(7, "兜底项目")], "US");
        assert_eq!(summary.projects.len(), 1);
        assert_eq!(summary.projects[0].project_name, "兜底项目");
    }

    // ---------- trend_series ----------

    /// 构造带 daily_trend 的 KPI（供图表派生测试；汇总字段从趋势行推导）
    fn kpi(id: i64, name: &str, trend: Vec<DailyAnalysisRow>) -> ProjectPortfolioKPI {
        ProjectPortfolioKPI {
            project_id: id,
            project_name: name.to_string(),
            sales_amount: trend.iter().map(|r| r.sales_amount).sum(),
            order_qty: trend.iter().map(|r| r.order_qty).sum(),
            ad_spend: trend.iter().map(|r| r.ad_spend).sum(),
            conversion_rate: 0.0,
            impressions: trend.iter().map(|r| r.impressions).sum(),
            clicks: trend.iter().map(|r| r.clicks).sum(),
            cpc: 0.0,
            ad_orders: 0,
            page_views: 0,
            sessions: trend.iter().map(|r| r.sessions).sum(),
            daily_trend: trend,
            sales_contribution: 0.0,
            order_contribution: 0.0,
            ad_spend_contribution: 0.0,
            currency: "$",
        }
    }

    #[test]
    fn trend_series_merges_by_date_and_sums_values() {
        let a = kpi(
            1,
            "A",
            vec![
                row("2026-08-13", 100.0, 1, 10.0, 0, 0, 0, 0.0, 0.0),
                row("2026-08-14", 200.0, 2, 20.0, 0, 0, 0, 0.0, 0.0),
            ],
        );
        let b = kpi(
            2,
            "B",
            vec![row("2026-08-14", 300.0, 3, 30.0, 0, 0, 0, 0.0, 0.0)],
        );
        let points = trend_series(&[a, b], TrendMetric::Sales);
        // 2 个日期合并；label = "MM-DD"（对齐 frontend slice(5)）
        assert_eq!(points.len(), 2);
        assert_eq!(points[0].label, "08-13");
        assert_eq!(points[0].values, vec![100.0, 0.0]);
        assert_eq!(points[1].label, "08-14");
        assert_eq!(points[1].values, vec![200.0, 300.0]);
    }

    #[test]
    fn trend_series_metric_selection_reads_row_field() {
        let a = kpi(
            1,
            "A",
            vec![row("2026-08-14", 100.0, 5, 10.0, 0, 0, 0, 0.0, 3.5)],
        );
        // 订单量
        let points = trend_series(std::slice::from_ref(&a), TrendMetric::Orders);
        assert_eq!(points[0].values, vec![5.0]);
        // 广告费
        let points = trend_series(std::slice::from_ref(&a), TrendMetric::AdSpend);
        assert_eq!(points[0].values, vec![10.0]);
        // 转化率（按日求和，对齐 web）
        let points = trend_series(&[a], TrendMetric::Conversion);
        assert_eq!(points[0].values, vec![3.5]);
    }

    // ---------- pie_rows ----------

    #[test]
    fn pie_rows_map_metric_to_kpi_field() {
        let a = kpi(
            1,
            "A",
            vec![row("2026-08-14", 100.0, 5, 10.0, 0, 0, 42, 0.0, 0.0)],
        );
        let rows = pie_rows(std::slice::from_ref(&a), PieMetric::Sessions);
        assert_eq!(rows[0].name, "A");
        assert_eq!(rows[0].sales, 42.0);
        let rows = pie_rows(&[a], PieMetric::Sales);
        assert_eq!(rows[0].sales, 100.0);
    }

    // ---------- 状态机 ----------

    #[test]
    fn from_fetch_result_maps_loaded_empty_error() {
        let data = PortfolioData {
            projects: vec![project(1, "A")],
            summary: PortfolioSummary {
                projects: vec![kpi(1, "A", vec![])],
                ..Default::default()
            },
            country: "US".to_string(),
            from: d(2026, 8, 9),
            to: d(2026, 8, 15),
        };
        assert_eq!(
            PortfolioState::from_fetch_result(Ok(data.clone())),
            PortfolioState::Loaded(data)
        );
        let empty = PortfolioData::empty(vec![]);
        assert!(empty.is_empty());
        assert_eq!(
            PortfolioState::from_fetch_result(Ok(empty)),
            PortfolioState::Empty
        );
        assert_eq!(
            PortfolioState::from_fetch_result(Err("boom".to_string())),
            PortfolioState::Error("boom".to_string())
        );
    }

    // ---------- 渲染冒烟（亮 / 暗 + 四态） ----------

    fn create_view(cx: &mut gpui::TestAppContext) -> Entity<PortfolioOverviewView> {
        let client = Client::new("");
        cx.update(|cx| cx.new(|cx| PortfolioOverviewView::new(cx, client)))
    }

    fn sample_data() -> PortfolioData {
        let a = kpi(
            1,
            "项目 A",
            vec![
                row("2026-08-13", 3000.0, 30, 150.0, 1300, 300, 3000, 2800.0, 2.5),
                row("2026-08-14", 2000.0, 20, 100.0, 800, 200, 2000, 1900.0, 3.0),
            ],
        );
        let b = kpi(2, "项目 B", vec![row("2026-08-13", 500.0, 5, 25.0, 100, 0, 400, 0.0, 0.0)]);
        let mut summary = PortfolioSummary {
            projects: vec![a, b],
            ..Default::default()
        };
        summary.total_sales_amount = 5500.0;
        summary.total_order_qty = 55;
        summary.total_ad_spend = 275.0;
        summary.total_sessions = 5400;
        for p in &mut summary.projects {
            p.sales_contribution = if summary.total_sales_amount > 0.0 {
                p.sales_amount / summary.total_sales_amount * 100.0
            } else {
                0.0
            };
        }
        PortfolioData {
            projects: vec![project(1, "项目 A"), project(2, "项目 B")],
            summary,
            country: "US".to_string(),
            from: d(2026, 8, 9),
            to: d(2026, 8, 15),
        }
    }

    struct PortfolioHost {
        view: Entity<PortfolioOverviewView>,
    }

    impl Render for PortfolioHost {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            self.view.clone().into_any_element()
        }
    }

    #[gpui::test]
    async fn portfolio_renders_loaded_in_light_and_dark(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let view = create_view(cx);
        let data = sample_data();
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Ok(data), cx);
            });
        });
        let (_host, cx2) =
            cx.add_window_view(|_window, _cx| PortfolioHost { view: view.clone() });
        cx2.read(|app| assert!(!crate::theme::AppTheme::current(app).is_dark()));

        // 切深色：重渲染不 panic，语义色板跟随
        cx2.update(|_window, app| {
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, app);
        });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    #[gpui::test]
    async fn portfolio_error_state_renders(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Err("服务暂时不可用".to_string()), cx);
            });
        });
        let (_host, _cx2) =
            cx.add_window_view(|_window, _cx| PortfolioHost { view: view.clone() });
    }

    #[gpui::test]
    async fn portfolio_empty_state_renders(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Ok(PortfolioData::empty(vec![project(1, "A")])), cx);
            });
        });
        let (_host, _cx2) =
            cx.add_window_view(|_window, _cx| PortfolioHost { view: view.clone() });
    }

    #[gpui::test]
    async fn portfolio_loading_state_renders(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let view = create_view(cx);
        let (_host, _cx2) =
            cx.add_window_view(|_window, _cx| PortfolioHost { view: view.clone() });
    }
}
