//! 广告 → 广告分析视图（P3-3，BLF-703；BLF-799 套版 Pattern B「双轴分析画布」）
//!
//! frontend `app/dashboard/advertising/ad-analysis/`（10 子 Tab）的 GPUI 等价：
//!
//! - **上部图表区**（占高 40~50%，分割条可拖拽、比例记忆）：折线（每日花费
//!   时间趋势，源自 overview `trend_summary`）+ 柱状（站点内高消耗活动花费
//!   分布，源自 overview `top_campaigns`）——两图与下部表格同源于同一次
//!   `ad_analysis_overview(project_id, country, date_from, date_to)` 请求，
//!   口径一致；空态 / 加载态统一走 chart_primitives 出口；
//! - **下部子 Tab 区**（占高 50~60%）：10 子 Tab——总览 + 9 明细 Tab（趋势 /
//!   活动 / SKU / 已购买商品 / 搜索词 / 投放 / 广告位 / 预算 / 流量质量）。
//!   总览 Tab 渲染 overview 定型结构（指标卡 / 周期对比 / Top 表 / 分析与
//!   风险）；明细 Tab 各挂独立 [`DataGrid`]（Pattern A 网格骨架复用），数据走
//!   `/ad-analysis/{tab}` 同构端点（gui-domain 列配置驱动展示）；
//! - **懒加载与状态保持**：Tab 首次激活才拉取；已加载 Tab 切换不重复请求
//!   （判据 = 加载参数快照 == 当前筛选参数，见 [`AdAnalysisView::needs_fetch`]）；
//!   筛选变化使全部明细 Tab 失效、激活时重拉；网格实体常驻宿主，切换不销毁
//!   → 列宽 / 排序状态保持。
//!
//! 「站点分布柱状」适配说明：本页为单站点作用域（US/DE/UK 筛选），跨站点
//! 聚合需第二组请求参数、违反「图表与表格同一请求参数」验收条款——故柱状
//! 取当前站点内活动花费分布（Top 活动），与表格严格同参。
//!
//! 架构沿用 Phase 1/2 四态状态机 + 竞态保护（主请求 `latest_request_id` /
//! 每 Tab 独立 request id）；Pattern B 模板见
//! [`crate::widgets::pattern_b`]（多 Tab 复合页接入方式 doc-comment 在彼处）。

use chrono::NaiveDate;
use gpui::{
    div, prelude::*, px, App, AsyncApp, Context, Entity, EventEmitter, FontWeight, IntoElement,
    MouseButton, ParentElement, Render, SharedString, Styled, WeakEntity, Window,
};
use gpui_component::{
    button::Button,
    h_flex,
    menu::{DropdownMenu, PopupMenuItem},
    v_flex, Icon, IconName, Sizable, StyledExt,
};
use gui_api_client::Client;
use gui_domain::advertising::{
    ad_analysis_tab, ad_analysis_tabs, format_ad_value, is_numeric_format, AdAnalysisTabDef,
    AdAnalysisTabResponse, AdIssueCard, AdNarrativeSection, AdOverviewResponse, AdPeriodComparison,
    AdTopCampaignRow, AdTopProductRow, AdTopWasteTermRow, AdTrendRow,
};
use gui_domain::common::ManagedProject;

use crate::theme::{AppTheme, FONT_2XS, FONT_BASE, FONT_TITLE_LG, FONT_XS};
use crate::views::dashboard::last_7_days_window;
use crate::widgets::chart_primitives::{
    bar_series_chart, chart_empty_fill, trend_line_chart, TrendPoint,
};
use crate::widgets::data_grid::{AggregateItem, DataGrid};
use crate::widgets::data_table::{CellAlign, ColumnDef, DataTable, TabularNumsExt};
use crate::widgets::date_range::{DateRange, DateRangeEvent, DateRangePickerState};
use crate::widgets::page_header::PageHeader;
use crate::widgets::pattern_b::{
    apply_split_drag, pattern_b_shell, ratio_from_per_mille, ratio_to_per_mille, split_divider,
    tab_bar, tabs_zone, SplitDrag, SplitDragGhost, TabItem,
};
use crate::widgets::state_views::{self, SkeletonBlock};
use crate::widgets::top_projects::{fmt_money_precise, fmt_num_precise};

/// 本页在侧栏中的 URL（root.rs 据此路由；与 gui-domain::sidebar 的广告分析条目一致）
pub const AD_ANALYSIS_URL: &str = "/dashboard/advertising/ad-analysis/overview";

/// 站点选项（对齐 frontend ad-analysis `COUNTRY_OPTIONS`：US/DE/UK，无「全部站点」）
const COUNTRY_OPTIONS: [(&str, &str); 3] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
];

/// 默认站点（对齐 frontend `useUrlParam('country', 'US')`）
const DEFAULT_COUNTRY: &str = "US";

/// 总览 Tab 下标（Tab 条首项）
pub const OVERVIEW_TAB_IX: usize = 0;

/// 站点展示名（未知值原样返回）
pub fn ad_country_label(country: &str) -> String {
    COUNTRY_OPTIONS
        .iter()
        .find(|(value, _)| *value == country)
        .map_or_else(|| country.to_string(), |(_, label)| label.to_string())
}

/// Pattern B 子 Tab 清单：总览 + 9 明细 Tab（顺序对齐 frontend AD_ANALYSIS_TABS）
pub fn ad_tab_items() -> Vec<TabItem> {
    let mut items = vec![TabItem::new("overview", "总览")];
    items.extend(
        ad_analysis_tabs()
            .into_iter()
            .map(|def| TabItem::new(def.key, def.label)),
    );
    items
}

/// 明细 Tab 行类型（后端 items 为 dict 行，列配置驱动展示）
type TabRow = serde_json::Value;

// ---------------------------------------------------------------------------
// 数据载荷与状态机
// ---------------------------------------------------------------------------

/// 广告分析载荷（Loaded 持有；图表区 + 总览 Tab 数据源）
#[derive(Debug, Clone, PartialEq)]
pub struct AdAnalysisData {
    pub projects: Vec<ManagedProject>,
    pub overview: AdOverviewResponse,
    pub date_from: NaiveDate,
    pub date_to: NaiveDate,
}

impl AdAnalysisData {
    /// 空态判定：没有任何指标卡 / 趋势 / Top 表 → Empty
    /// （对齐 frontend overview-client 的 `!data` 空态；后端无数据时 metrics 为空）
    pub fn is_empty(&self) -> bool {
        self.overview.metrics.is_empty()
            && self.overview.trend_summary.is_empty()
            && self.overview.top_campaigns.is_empty()
            && self.overview.top_products.is_empty()
            && self.overview.top_waste_terms.is_empty()
    }
}

/// 广告分析状态机（四态；对齐 dashboard.rs / daily_analysis.rs）
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum AdAnalysisState {
    Loading,
    Loaded(AdAnalysisData),
    Empty,
    Error(String),
}

impl AdAnalysisState {
    /// 拉取结果 → 落点状态（唯一合法的「拉取完成」转移）
    pub fn from_fetch_result(result: Result<AdAnalysisData, String>) -> Self {
        match result {
            Ok(data) if data.is_empty() => Self::Empty,
            Ok(data) => Self::Loaded(data),
            Err(msg) => Self::Error(msg),
        }
    }
}

/// 一次拉取的筛选参数快照（懒加载判据：Tab 已加载参数 == 当前参数则跳过）
#[derive(Debug, Clone, Copy, PartialEq)]
struct AdFetchParams {
    project_id: Option<i64>,
    country: &'static str,
    from: NaiveDate,
    to: NaiveDate,
}

/// 明细 Tab 三态
#[derive(Debug, Clone, PartialEq)]
enum AdTabStatus {
    Loading,
    Loaded,
    Empty,
    Error(String),
}

/// 明细 Tab 槽位（首次激活时创建并常驻——网格实体不随切换销毁，
/// 列宽 / 排序等状态自然保持）
struct AdTabSlot {
    key: &'static str,
    grid: Entity<DataGrid<TabRow>>,
    status: AdTabStatus,
    aggregates: Vec<AggregateItem>,
    summary_cards: Vec<(String, String)>,
    loaded_params: Option<AdFetchParams>,
    request_id: u64,
}

impl AdTabSlot {
    fn new(def: &AdAnalysisTabDef, cx: &mut Context<AdAnalysisView>) -> Self {
        let grid =
            cx.new(|_| DataGrid::new(grid_id(def.key), value_columns(def)).striped(true));
        Self {
            key: def.key,
            grid,
            status: AdTabStatus::Loading,
            aggregates: Vec::new(),
            summary_cards: Vec::new(),
            loaded_params: None,
            request_id: 0,
        }
    }
}

fn grid_id(key: &str) -> &'static str {
    // DataGrid id 仅作 element id 前缀；Tab key 集合固定，映射成 'static
    match key {
        "time-trend" => "ad-tab-time-trend",
        "campaigns" => "ad-tab-campaigns",
        "products" => "ad-tab-products",
        "purchased-products" => "ad-tab-purchased-products",
        "search-terms" => "ad-tab-search-terms",
        "targets" => "ad-tab-targets",
        "placements" => "ad-tab-placements",
        "budget" => "ad-tab-budget",
        "traffic-quality" => "ad-tab-traffic-quality",
        _ => "ad-tab-other",
    }
}

/// 视图事件（上抛组合根持久化；视图层不碰文件系统，延续 BLF-794~796 纪律）
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AdAnalysisEvent {
    /// 分割条拖拽松手提交（per-mille 编码 400..=500）
    ChartRatioCommitted(u16),
}

impl EventEmitter<AdAnalysisEvent> for AdAnalysisView {}

/// 广告分析视图（Pattern B 双轴画布原型）
pub struct AdAnalysisView {
    state: Entity<AdAnalysisState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表（reload 刷新；筛选菜单数据源）
    projects: Vec<ManagedProject>,
    /// 当前选中项目；概览端点要求必选，`None` 时显示「请先选择项目」
    selected_project_id: Option<i64>,
    /// 当前站点（"US" / "DE" / "UK"）
    country: &'static str,
    /// 日期区间筛选（默认近 7 天；各端点支持 date_from/date_to）
    date_range: DateRange,
    /// 日期区间选择器（懒建 + 订阅 Change）
    date_picker: Option<Entity<DateRangePickerState>>,
    // ---- Pattern B：双轴画布状态 ----
    /// 上部图表区占比（40~50%；拖拽平滑、松手记忆持久化）
    chart_ratio: f32,
    /// 当前活跃 Tab（Tab 条下标；0 = 总览）
    active_tab: usize,
    /// Tab 条目（含总览；构建一次）
    tab_items: Vec<TabItem>,
    /// 明细 Tab 列配置（与 tab_items 对齐；总览位 None）
    tab_defs: Vec<Option<AdAnalysisTabDef>>,
    /// 明细 Tab 槽位（None = 从未激活）
    tabs: Vec<Option<AdTabSlot>>,
    // ---- 总览 Tab 的三张 Top 表（懒建 DataTable，随概览数据幂等注入） ----
    top_campaigns_table: Option<Entity<DataTable<AdTopCampaignRow>>>,
    top_products_table: Option<Entity<DataTable<AdTopProductRow>>>,
    top_waste_terms_table: Option<Entity<DataTable<AdTopWasteTermRow>>>,
    /// 日期区间选择器事件订阅（必须持有，否则变更不送达）
    _subscriptions: Vec<gpui::Subscription>,
    /// 主请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,
}

impl AdAnalysisView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`。
    ///
    /// `initial_ratio_per_mille` 自 UI 偏好恢复分割比例（None 回落默认 45%）。
    pub fn new(
        cx: &mut Context<Self>,
        client: Client,
        initial_ratio_per_mille: Option<u16>,
    ) -> Self {
        let state = cx.new(|_| AdAnalysisState::Loading);
        // 默认近 7 天（对齐旧行为）；订阅日期区间选择器的变更
        let (from, to) = last_7_days_window(chrono::Local::now().date_naive());
        let date_range = DateRange::new(Some(from), Some(to));
        let date_picker = cx.new(DateRangePickerState::new);
        let subscription = cx.subscribe(&date_picker, |this, _entity, ev, cx| {
            let range = match ev {
                DateRangeEvent::Change(range) => *range,
            };
            this.apply_date_range(range, cx);
        });
        let tab_items = ad_tab_items();
        let keys: Vec<Option<&'static str>> = std::iter::once(None)
            .chain(ad_analysis_tabs().into_iter().map(|d| Some(d.key)))
            .collect();
        let tab_defs = tab_items
            .iter()
            .zip(keys)
            .map(|(_, key)| key.map(ad_analysis_key_def))
            .collect();
        Self {
            state,
            client,
            projects: Vec::new(),
            selected_project_id: None,
            country: DEFAULT_COUNTRY,
            date_range,
            date_picker: Some(date_picker),
            chart_ratio: ratio_from_per_mille(initial_ratio_per_mille),
            active_tab: OVERVIEW_TAB_IX,
            tab_defs,
            tabs: (0..tab_items.len()).map(|_| None).collect(),
            tab_items,
            top_campaigns_table: None,
            top_products_table: None,
            top_waste_terms_table: None,
            _subscriptions: vec![subscription],
            latest_request_id: 0,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> AdAnalysisState {
        self.state.read(cx).clone()
    }

    /// 当前筛选三元组（项目/站点/日期，只读；根视图回归测试断言用）
    #[allow(dead_code)] // 根视图级测试消费（对齐 current_state 惯例）
    pub fn console_filter_state(&self) -> (Option<i64>, &'static str, DateRange) {
        (self.selected_project_id, self.country, self.date_range)
    }

    /// 图表区占比快照（测试消费）
    #[allow(dead_code)]
    pub fn chart_ratio(&self) -> f32 {
        self.chart_ratio
    }

    /// 活跃 Tab 快照（测试消费）
    #[allow(dead_code)]
    pub fn active_tab_ix(&self) -> usize {
        self.active_tab
    }

    /// 当前拉取参数快照（未选项目 → None）
    fn fetch_params(&self) -> Option<AdFetchParams> {
        let (from, to) = match (self.date_range.from, self.date_range.to) {
            (Some(f), Some(t)) => (f, t),
            _ => last_7_days_window(chrono::Local::now().date_naive()),
        };
        self.selected_project_id
            .map(|project_id| AdFetchParams {
                project_id: Some(project_id),
                country: self.country,
                from,
                to,
            })
    }

    /// 重新拉取概览（项目/站点切换、错误重试、空态刷新共用入口）。
    ///
    /// 每次调用递增 `latest_request_id` 并进入 Loading；同时**失效全部明细
    /// Tab**（清参数快照，下次激活重拉）并对活跃明细 Tab 立即重拉。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let selected = self.selected_project_id;
        let country = self.country;
        // 未设置区间时回退近 7 天（防御：外部 set_range 清空等）
        let (date_from, date_to) = match (self.date_range.from, self.date_range.to) {
            (Some(f), Some(t)) => (f, t),
            _ => last_7_days_window(chrono::Local::now().date_naive()),
        };

        self.state.update(cx, |state, cx| {
            *state = AdAnalysisState::Loading;
            cx.notify();
        });

        for slot in self.tabs.iter_mut().flatten() {
            slot.loaded_params = None;
        }
        let active = self.active_tab;
        if active != OVERVIEW_TAB_IX {
            self.ensure_tab_loaded(active, cx);
        }

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(load_ad_analysis(&client, selected, country, date_from, date_to))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 切换选中项目 → reload（`None` = 未选择；同一项目为 no-op）
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

    /// 应用日期区间（同一区间 no-op）→ reload
    pub fn apply_date_range(&mut self, range: DateRange, cx: &mut Context<Self>) {
        if self.date_range == range {
            return;
        }
        self.date_range = range;
        self.reload(cx);
    }

    /// BLF-795：Console Bar 筛选一键应用——对比当前三维，只对变化维度落值，
    /// 任一变化仅触发一次 reload。返回是否有实际变化。
    pub fn apply_console_filter(
        &mut self,
        project_id: Option<i64>,
        country: &'static str,
        range: DateRange,
        cx: &mut Context<Self>,
    ) -> bool {
        let project_changed = project_id != self.selected_project_id;
        let country_changed = country != self.country;
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

    // ---- Pattern B 分割比例 ----

    /// 拖拽期更新占比（clamp 由模板常量保证；仅变化时 notify——拖拽平滑）
    pub fn set_chart_ratio(&mut self, ratio: f32, cx: &mut Context<Self>) {
        let clamped = ratio.clamp(
            crate::widgets::pattern_b::MIN_CHART_RATIO,
            crate::widgets::pattern_b::MAX_CHART_RATIO,
        );
        if (clamped - self.chart_ratio).abs() > f32::EPSILON {
            self.chart_ratio = clamped;
            cx.notify();
        }
    }

    /// 松手提交占比 → 上抛组合根持久化（比例记忆）
    pub fn commit_chart_ratio(&mut self, cx: &mut Context<Self>) {
        cx.emit(AdAnalysisEvent::ChartRatioCommitted(ratio_to_per_mille(
            self.chart_ratio,
        )));
    }

    // ---- Pattern B 子 Tab ----

    /// 切换活跃 Tab（同 Tab / 越界 no-op）+ 懒加载
    pub fn activate_tab(&mut self, ix: usize, cx: &mut Context<Self>) {
        if ix >= self.tab_items.len() || ix == self.active_tab {
            return;
        }
        self.active_tab = ix;
        self.ensure_tab_loaded(ix, cx);
        cx.notify();
    }

    /// 懒加载守卫：Tab 未创建过、参数快照过期或上次失败 → 需要拉取；
    /// 否则零请求（「Tab 切换不重复拉取已加载数据」的唯一判据入口）。
    fn needs_fetch(&self, ix: usize, params: &Option<AdFetchParams>) -> bool {
        let Some(slot) = &self.tabs[ix] else {
            return true;
        };
        if slot.loaded_params.as_ref() != params.as_ref() {
            return true;
        }
        matches!(slot.status, AdTabStatus::Error(_))
    }

    /// 确保 Tab 数据就绪（首次激活 / 失效后重拉共用入口）
    fn ensure_tab_loaded(&mut self, ix: usize, cx: &mut Context<Self>) {
        if ix == OVERVIEW_TAB_IX || ix >= self.tab_defs.len() {
            return; // 总览随主状态；越界防御
        }
        let Some(params) = self.fetch_params() else {
            return; // 未选项目：Tab 内容区显示引导（页面级空态亦有提示）
        };
        if !self.needs_fetch(ix, &Some(params)) {
            return;
        }
        let def = self.tab_defs[ix]
            .as_ref()
            .expect("明细 Tab 必有列配置")
            .clone();
        let slot = self.tabs[ix].get_or_insert_with(|| AdTabSlot::new(&def, cx));
        slot.request_id = slot.request_id.wrapping_add(1);
        slot.loaded_params = Some(params);
        slot.status = AdTabStatus::Loading;

        let key = slot.key;
        let request_id = slot.request_id;
        let project_id = params.project_id.expect("fetch_params 已保证 Some");
        let country = params.country;
        let from = params.from;
        let to = params.to;
        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(fetch_ad_tab(
                        &client, key, project_id, country, from, to,
                    ))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_tab_result(key, request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 应用 Tab 拉取结果（竞态保护 + 注入网格 + 聚合派生）
    fn apply_tab_result(
        &mut self,
        key: &'static str,
        request_id: u64,
        result: Result<AdAnalysisTabResponse, String>,
        cx: &mut Context<Self>,
    ) {
        let Some(ix) = self.tab_items.iter().position(|t| t.key == key) else {
            return;
        };
        let Some(slot) = &mut self.tabs[ix] else {
            return;
        };
        if slot.request_id != request_id {
            return; // 过期响应，丢弃
        }
        match result {
            Ok(resp) => {
                slot.summary_cards = resp
                    .summary_cards
                    .iter()
                    .map(|c| (c.label.clone(), c.value.clone()))
                    .collect();
                slot.aggregates = tab_aggregates(&resp.items);
                if resp.items.is_empty() {
                    slot.status = AdTabStatus::Empty;
                } else {
                    slot.grid.update(cx, |grid, cx| grid.set_rows(resp.items, cx));
                    slot.status = AdTabStatus::Loaded;
                }
            }
            Err(msg) => slot.status = AdTabStatus::Error(msg),
        }
        cx.notify();
    }

    /// 重试明细 Tab（清错误态强制重拉）
    fn retry_tab(&mut self, ix: usize, cx: &mut Context<Self>) {
        if let Some(slot) = &mut self.tabs[ix] {
            slot.loaded_params = None;
        }
        self.ensure_tab_loaded(ix, cx);
    }

    /// 应用概览拉取结果：竞态保护（过期响应丢弃）+ Loaded 落点前记录项目列表。
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<AdAnalysisData, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok(data) = &result {
            self.projects = data.projects.clone();
        }
        self.state.update(cx, |state, cx| {
            *state = AdAnalysisState::from_fetch_result(result);
            cx.notify();
        });
    }

    /// 把概览 Top 行同步进三张 DataTable（懒建 + 幂等注入；render 期调用）
    fn sync_top_tables(&mut self, overview: &AdOverviewResponse, cx: &mut Context<Self>) {
        let campaigns = self
            .top_campaigns_table
            .get_or_insert_with(|| {
                cx.new(|_| {
                    DataTable::new("ad-top-campaigns-table", campaign_columns())
                        .striped(true)
                        .empty_text("暂无活动明细")
                        .max_height(240.0)
                })
            });
        campaigns.update(cx, |table, cx| {
            table.set_rows_if_changed(&overview.top_campaigns, cx);
        });
        let products = self
            .top_products_table
            .get_or_insert_with(|| {
                cx.new(|_| {
                    DataTable::new("ad-top-products-table", product_columns())
                        .striped(true)
                        .empty_text("暂无推广商品明细")
                        .max_height(240.0)
                })
            });
        products.update(cx, |table, cx| {
            table.set_rows_if_changed(&overview.top_products, cx);
        });
        let waste = self
            .top_waste_terms_table
            .get_or_insert_with(|| {
                cx.new(|_| {
                    DataTable::new("ad-top-waste-table", waste_columns())
                        .striped(true)
                        .empty_text("暂无浪费词明细")
                        .max_height(240.0)
                })
            });
        waste.update(cx, |table, cx| {
            table.set_rows_if_changed(&overview.top_waste_terms, cx);
        });
    }
}

fn ad_analysis_key_def(key: &'static str) -> AdAnalysisTabDef {
    ad_analysis_tab(key).expect("key 来自 ad_analysis_tabs 本身")
}

/// 拉取单个明细 Tab（time-trend 归一为通用响应；其余直连同构端点）
async fn fetch_ad_tab(
    client: &Client,
    key: &'static str,
    project_id: i64,
    country: &str,
    from: NaiveDate,
    to: NaiveDate,
) -> Result<AdAnalysisTabResponse, String> {
    let result = if key == "time-trend" {
        client
            .ad_analysis_time_trend(project_id, country, Some(from), Some(to))
            .await
            .map(gui_domain::advertising::AdTimeTrendResponse::into_tab_response)
    } else {
        client
            .ad_analysis_tab(key, project_id, country, Some(from), Some(to))
            .await
    };
    result.map_err(|e| e.user_message())
}

/// 拉取广告分析（项目列表 + 概览），与视图解耦便于测试。
///
/// 对齐 frontend overview-client：项目列表为空 → 空载荷（Empty）；
/// 概览端点要求必选项目，未选时返回空载荷（前端同样要求先选项目）。
async fn load_ad_analysis(
    client: &Client,
    selected_project_id: Option<i64>,
    country: &str,
    date_from: chrono::NaiveDate,
    date_to: chrono::NaiveDate,
) -> Result<AdAnalysisData, String> {
    let projects = client
        .list_managed_projects()
        .await
        .map_err(|e| e.user_message())?;

    let Some(project_id) = selected_project_id else {
        return Ok(AdAnalysisData {
            projects,
            overview: AdOverviewResponse {
                project_id: 0,
                country: country.to_string(),
                metrics: Vec::new(),
                issue_cards: Vec::new(),
                narrative_sections: Vec::new(),
                comparison: None,
                top_campaigns: Vec::new(),
                top_products: Vec::new(),
                top_waste_terms: Vec::new(),
                trend_summary: Vec::new(),
            },
            date_from,
            date_to,
        });
    };

    let overview = client
        .ad_analysis_overview(project_id, country, Some(date_from), Some(date_to))
        .await
        .map_err(|e| e.user_message())?;
    Ok(AdAnalysisData {
        projects,
        overview,
        date_from,
        date_to,
    })
}

// ---------------------------------------------------------------------------
// 明细 Tab 列配置与聚合（纯函数可测）
// ---------------------------------------------------------------------------

/// 各格式的默认列宽（px）；Text 无固定宽 → 弹性占满剩余空间
fn column_width(format: gui_domain::advertising::AdFormat) -> Option<f32> {
    use gui_domain::advertising::AdFormat as F;
    match format {
        F::Text => None,
        F::Date => Some(96.0),
        F::Int => Some(76.0),
        F::Money => Some(92.0),
        F::Percent => Some(80.0),
        F::Ratio => Some(68.0),
    }
}

/// domain 列配置 → [`ColumnDef<Value>`]：渲染闭包按列 key 取值格式化；
/// 数值列 mono + 右对齐 + 可排序（排序经 `sort_value_dyn` 闭包取数——
/// 动态行类型的键无法进 fn 指针，data_grid 回落路径专为此而设）。
fn value_columns(def: &AdAnalysisTabDef) -> Vec<ColumnDef<TabRow>> {
    def.columns
        .iter()
        .map(|c| {
            let key = c.key;
            let format = c.format;
            let numeric = is_numeric_format(format);
            let mut col = ColumnDef::<TabRow>::text(c.key, c.label, |_, _| SharedString::default())
                .with_render_element(move |row: &TabRow, _| {
                    let text = format_ad_value(
                        row.get(key).unwrap_or(&serde_json::Value::Null),
                        format,
                    );
                    div().child(text).into_any_element()
                });
            col.width = column_width(format);
            col.numeric = numeric;
            if numeric {
                col.align = CellAlign::Right;
                col.sortable = true;
                col.sort_value_dyn = Some(std::rc::Rc::new(move |row: &TabRow| {
                    gui_domain::advertising::ad_numeric_value(
                        row.get(key).unwrap_or(&serde_json::Value::Null),
                    )
                    .unwrap_or(f64::NAN)
                }));
            }
            col
        })
        .collect()
}

/// 底部聚合摘要（通用口径：行数 + 有则聚合的花费 / 销售 / 订单；数字 mono）
fn tab_aggregates(items: &[TabRow]) -> Vec<AggregateItem> {
    let mut spend = 0.0f64;
    let mut sales = 0.0f64;
    let mut orders = 0i64;
    for row in items {
        if let Some(v) = row
            .get("spend")
            .and_then(gui_domain::advertising::ad_numeric_value)
        {
            spend += v;
        }
        if let Some(v) = row
            .get("sales_7d")
            .and_then(gui_domain::advertising::ad_numeric_value)
        {
            sales += v;
        }
        if let Some(v) = row
            .get("orders_7d")
            .and_then(gui_domain::advertising::ad_numeric_value)
        {
            orders += v.round() as i64;
        }
    }
    vec![
        AggregateItem::new("行数", fmt_num_precise(items.len() as i64)),
        AggregateItem::new("Σ花费", fmt_money_precise(spend)),
        AggregateItem::new("Σ销售", fmt_money_precise(sales)),
        AggregateItem::new("Σ订单", fmt_num_precise(orders)),
    ]
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for AdAnalysisView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let view = cx.entity();
        let project_name = self
            .selected_project_id
            .and_then(|id| {
                self.projects
                    .iter()
                    .find(|p| p.id == id)
                    .map(|p| p.name.clone())
            })
            .unwrap_or_else(|| "广告分析".to_string());

        // 页面头部（共享 PageHeader；副标题随筛选上下文）
        let subtitle = match &state {
            AdAnalysisState::Loaded(data) => format!(
                "{} · {} · {} ~ {} · 双轴分析画布",
                project_name,
                ad_country_label(&data.overview.country),
                data.date_from,
                data.date_to,
            ),
            _ => format!("{project_name} · 双轴分析画布"),
        };
        let header = PageHeader::new("广告分析").subtitle(subtitle);

        // 工具栏内容：项目 + 站点 + 日期 + 弹性位 + 刷新
        let toolbar = h_flex()
            .gap_2()
            .items_center()
            .child(render_project_select(
                &view,
                &theme,
                &self.projects,
                self.selected_project_id,
            ))
            .child(render_country_select(&view, &theme, self.country))
            .when(self.date_picker.is_some(), |bar| {
                bar.child(self.date_picker.clone().expect("已创建"))
            })
            .child(div().flex_1())
            .child(refresh_button(&view));

        // 页面级四态：Loading / Error / Empty 用统一三态视图（含重试 / 引导），
        // Loaded 才进入 Pattern B 画布（对齐其余业务页的四态惯例）
        match state {
            AdAnalysisState::Loading => v_flex()
                .id("ad-analysis")
                .size_full()
                .overflow_hidden()
                .bg(theme.window_bg)
                .child(header)
                .child(
                    h_flex()
                        .w_full()
                        .h(px(crate::widgets::data_grid::FILTER_TOOLBAR_HEIGHT))
                        .flex_none()
                        .items_center()
                        .bg(theme.panel_bg)
                        .border_b_1()
                        .border_color(theme.separator)
                        .px_2()
                        .gap_2()
                        .child(toolbar),
                )
                .child(
                    div()
                        .flex_1()
                        .min_h_0()
                        .p_4()
                        .child(state_views::skeleton_loading(
                            &theme,
                            &[SkeletonBlock::Chart(200.0), SkeletonBlock::Table(240.0)],
                        )),
                )
                .into_any_element(),
            AdAnalysisState::Error(msg) => state_views::error_state(
                &cx.entity(),
                &theme,
                "ad-analysis-error",
                "广告分析加载失败",
                msg,
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            AdAnalysisState::Empty => {
                let needs_project = self.selected_project_id.is_none();
                state_views::empty_state_with_action(
                    &cx.entity(),
                    &theme,
                    "ad-analysis-empty",
                    "icons/package.svg",
                    if needs_project {
                        "请先选择项目以加载广告分析数据"
                    } else {
                        "当前没有可展示的广告分析数据"
                    },
                    "刷新",
                    |this, cx| this.reload(cx),
                )
                .into_any_element()
            }
            AdAnalysisState::Loaded(data) => {
                // 上部图表区（两图并排，同源 overview 数据）
                let charts = render_charts_zone(&theme, &data.overview);

                // 分割条（拖拽起点 + 松手提交；move 监听挂壳上取整壳 bounds）
                let divider = split_divider(&theme, "ad-analysis-split")
                    .on_drag(SplitDrag, |_, _, _, cx| cx.new(|_| SplitDragGhost))
                    .on_mouse_up(
                        MouseButton::Left,
                        cx.listener(|this, _: &gpui::MouseUpEvent, _, cx| {
                            this.commit_chart_ratio(cx)
                        }),
                    )
                    .on_mouse_up_out(
                        MouseButton::Left,
                        cx.listener(|this, _: &gpui::MouseUpEvent, _, cx| {
                            this.commit_chart_ratio(cx)
                        }),
                    );

                // 下部子 Tab 区（10 子 Tab；活跃内容按槽位状态分派）
                let active_ix = self.active_tab;
                let strip = tab_bar(
                    &view,
                    &theme,
                    "ad-analysis",
                    &self.tab_items,
                    active_ix,
                    |this, ix, cx| this.activate_tab(ix, cx),
                );
                let content = self.render_tab_content(active_ix, &theme, &data.overview, cx);
                let tabs = tabs_zone(strip, content);

                pattern_b_shell(
                    &theme,
                    "ad-analysis",
                    header,
                    toolbar,
                    self.chart_ratio,
                    charts,
                    divider,
                    tabs,
                )
                // 占比换算要用整壳 bounds → on_drag_move 必须挂在壳元素上
                .on_drag_move(cx.listener(
                    |this, ev: &gpui::DragMoveEvent<SplitDrag>, _, cx| {
                        apply_split_drag(ev, this, cx, |this, ratio, cx| {
                            this.set_chart_ratio(ratio, cx);
                        });
                    },
                ))
                .into_any_element()
            }
        }
    }
}

impl AdAnalysisView {
    /// 活跃 Tab 内容分派（总览 = 定型结构；明细 = 槽位三态）
    fn render_tab_content(
        &mut self,
        ix: usize,
        app_theme: &AppTheme,
        overview: &AdOverviewResponse,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        if ix == OVERVIEW_TAB_IX {
            self.sync_top_tables(overview, cx);
            let campaigns = self
                .top_campaigns_table
                .clone()
                .expect("sync_top_tables 已注入");
            let products = self
                .top_products_table
                .clone()
                .expect("sync_top_tables 已注入");
            let waste = self
                .top_waste_terms_table
                .clone()
                .expect("sync_top_tables 已注入");
            return render_overview_content(app_theme, overview, campaigns, products, waste)
                .into_any_element();
        }

        let status = self.tabs[ix].as_ref().map(|s| s.status.clone());
        match status {
            None => {
                if self.selected_project_id.is_none() {
                    hint_panel(app_theme, "请先选择项目以加载该维度明细").into_any_element()
                } else {
                    state_views::loading_state(app_theme, "加载中…").into_any_element()
                }
            }
            Some(AdTabStatus::Loading) => {
                state_views::loading_state(app_theme, "加载中…").into_any_element()
            }
            Some(AdTabStatus::Empty) => {
                hint_panel(app_theme, "当前筛选下没有该维度的广告明细").into_any_element()
            }
            Some(AdTabStatus::Error(msg)) => {
                let view = cx.entity();
                v_flex()
                    .size_full()
                    .items_center()
                    .justify_center()
                    .gap_2()
                    .child(
                        div()
                            .text_sm()
                            .text_color(app_theme.danger)
                            .child(format!("加载失败：{msg}")),
                    )
                    .child(
                        Button::new(SharedString::from(format!("ad-tab-retry-{ix}")))
                            .outline()
                            .small()
                            .label("重试")
                            .on_click(move |_, _, cx| {
                                let view = view.clone();
                                view.update(cx, |this, cx| this.retry_tab(ix, cx));
                            }),
                    )
                    .into_any_element()
            }
            Some(AdTabStatus::Loaded) => {
                let slot = self.tabs[ix].as_ref().expect("Loaded 态必有槽位");
                let grid = slot.grid.clone();
                let aggregates = slot.aggregates.clone();
                let summary_cards = slot.summary_cards.clone();
                render_item_tab(app_theme, summary_cards, grid, aggregates).into_any_element()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 上部图表区（折线趋势 + 柱状分布；同源 overview，口径一致）
// ---------------------------------------------------------------------------

/// 上部图表区：两卡并排（折线趋势 + 柱状分布；同源 overview，口径一致）。
/// 仅在页面 Loaded 态进入——数据为空时统一空态填充。
fn render_charts_zone(app_theme: &AppTheme, overview: &AdOverviewResponse) -> gpui::AnyElement {
    let trend_points = spend_trend_points(&overview.trend_summary);
    let campaign_rows = campaign_spend_shares(overview);
    h_flex()
        .id("ad-analysis-charts")
        .size_full()
        .gap_2()
        .px_2()
        .py_1p5()
        .overflow_hidden()
        .child(chart_panel(
            app_theme,
            "ad-chart-spend-trend",
            "每日广告花费趋势",
            "当前窗口逐日花费（同参同源）",
            if trend_points.is_empty() {
                chart_empty_fill("暂无趋势数据", app_theme).into_any_element()
            } else {
                div()
                    .w_full()
                    .h_full()
                    .child(trend_line_chart(&trend_points, app_theme.chart_primary))
                    .into_any_element()
            },
        ))
        .child(chart_panel(
            app_theme,
            "ad-chart-campaign-spend",
            "活动花费分布",
            "当前站点内高消耗活动 Top（同参同源）",
            if campaign_rows.is_empty() {
                chart_empty_fill("暂无活动分布数据", app_theme).into_any_element()
            } else {
                div()
                    .w_full()
                    .h_full()
                    .child(bar_series_chart(&campaign_rows, app_theme.chart_secondary))
                    .into_any_element()
            },
        ))
        .into_any_element()
}

/// 图表面板（Pattern B 上半区标准卡：标题行 + 弹性图表槽；1px 边界分层）
fn chart_panel(
    app_theme: &AppTheme,
    id: &'static str,
    title: &'static str,
    subtitle: &'static str,
    body: gpui::AnyElement,
) -> impl IntoElement {
    v_flex()
        .id(id)
        .flex_1()
        .min_w(px(320.))
        .min_h_0()
        .rounded(px(app_theme.radius_lg))
        .border_1()
        .border_color(app_theme.separator)
        .bg(app_theme.card_bg)
        .overflow_hidden()
        .child(
            v_flex()
                .gap_px()
                .px_3()
                .py_1p5()
                .border_b_1()
                .border_color(app_theme.separator)
                .child(
                    div()
                        .text_size(px(FONT_XS))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(app_theme.text_primary)
                        .child(title),
                )
                .child(
                    div()
                        .text_size(px(FONT_2XS))
                        .text_color(app_theme.text_muted)
                        .child(subtitle),
                ),
        )
        .child(div().id(SharedString::from(format!("{id}-body"))).flex_1().min_h_0().p_2().child(body))
}

/// trend_summary → 折线点（X = M/D，Y = 花费；对齐 charts.rs dayLabel 口径）
fn spend_trend_points(rows: &[AdTrendRow]) -> Vec<TrendPoint> {
    rows.iter()
        .map(|r| TrendPoint {
            label: short_date_label(r.report_date.as_deref().unwrap_or("—")),
            value: r.spend,
        })
        .collect()
}

/// "2026-08-13" → "8/13"（非 ISO 输入原样返回）
fn short_date_label(date: &str) -> String {
    let mut parts = date.split('-');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(_y), Some(m), Some(d)) => format!(
            "{}/{}",
            m.parse::<u32>()
                .map(|v| v.to_string())
                .unwrap_or_else(|_| m.to_string()),
            d.parse::<u32>()
                .map(|v| v.to_string())
                .unwrap_or_else(|_| d.to_string())
        ),
        _ => date.to_string(),
    }
}

/// top_campaigns → 柱状分布行（名称 = 活动名，值 = 花费；降序已在后端保证）
fn campaign_spend_shares(overview: &AdOverviewResponse) -> Vec<crate::widgets::chart_primitives::ShareRow> {
    const TOP_N: usize = 8;
    overview
        .top_campaigns
        .iter()
        .take(TOP_N)
        .map(|row| crate::widgets::chart_primitives::ShareRow {
            name: row.campaign_name.clone().unwrap_or_else(|| "—".to_string()),
            sales: row.spend,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 下部子 Tab 区
// ---------------------------------------------------------------------------

/// 明细 Tab 内容：摘要卡条（可选）+ 虚拟化大表 + 底部聚合条（数字全 mono）
fn render_item_tab(
    app_theme: &AppTheme,
    summary_cards: Vec<(String, String)>,
    grid: Entity<DataGrid<TabRow>>,
    aggregates: Vec<AggregateItem>,
) -> impl IntoElement {
    v_flex()
        .size_full()
        .min_h_0()
        .when(!summary_cards.is_empty(), |col| {
            col.child(
                h_flex()
                    .id("ad-tab-summary-strip")
                    .w_full()
                    .flex_none()
                    .min_h_0()
                    .gap_2()
                    .px_2()
                    .py_1p5()
                    .overflow_x_scroll()
                    .children(summary_cards.iter().map(|(label, value)| {
                        h_flex()
                            .gap_1p5()
                            .items_baseline()
                            .px_2p5()
                            .py_1()
                            .rounded(px(app_theme.radius))
                            .bg(app_theme.muted_fill.opacity(0.5))
                            .child(
                                div()
                                    .text_size(px(FONT_2XS))
                                    .text_color(app_theme.text_muted)
                                    .child(label.clone()),
                            )
                            .child(
                                div()
                                    .text_size(px(FONT_BASE))
                                    .font_weight(FontWeight::MEDIUM)
                                    .mono_tabular_nums()
                                    .text_color(app_theme.text_primary)
                                    .child(value.clone()),
                            )
                    })),
            )
        })
        .child(grid)
        .child(aggregates_strip(app_theme, &aggregates))
}

/// 底部聚合条（grid_footer_bar 左侧同款视觉；明细 Tab 无服务端分页 → 仅聚合）
fn aggregates_strip(app_theme: &AppTheme, aggregates: &[AggregateItem]) -> impl IntoElement {
    h_flex()
        .id("ad-tab-aggregates")
        .w_full()
        .flex_none()
        .h(px(crate::widgets::data_grid::GRID_FOOTER_HEIGHT))
        .px_2()
        .gap_3()
        .items_center()
        .bg(app_theme.panel_bg)
        .border_t_1()
        .border_color(app_theme.separator)
        .children(aggregates.iter().enumerate().map(|(ix, item)| {
            h_flex()
                .id(SharedString::from(format!("ad-agg-{ix}-{}", item.label)))
                .gap_1p5()
                .items_center()
                .when(ix > 0, |this| {
                    this.border_l_1().border_color(app_theme.separator).pl_3()
                })
                .child(
                    div()
                        .text_size(px(FONT_2XS))
                        .text_color(app_theme.text_muted)
                        .child(item.label.clone()),
                )
                .child(
                    div()
                        .mono_tabular_nums()
                        .text_size(px(FONT_BASE))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(item.tone.color(app_theme))
                        .child(item.value.clone()),
                )
        }))
}

/// 总览 Tab 内容：指标卡 + 周期对比 + Top 表 + 结构化分析 / 风险提醒
/// （滚动容器；上半区图表已承载趋势，此处不再重复趋势列表）
fn render_overview_content(
    app_theme: &AppTheme,
    overview: &AdOverviewResponse,
    campaigns: Entity<DataTable<AdTopCampaignRow>>,
    products: Entity<DataTable<AdTopProductRow>>,
    waste: Entity<DataTable<AdTopWasteTermRow>>,
) -> impl IntoElement {
    v_flex()
        .id("ad-overview-content")
        .size_full()
        .min_h_0()
        .overflow_y_scroll()
        .gap_3()
        .p_2()
        .child(metric_cards(&overview.metrics, app_theme))
        .when(overview.comparison.is_some(), |col| {
            col.child(comparison_card(
                overview.comparison.as_ref().expect("已判 Some"),
                app_theme,
            ))
        })
        .child(
            h_flex()
                .id("ad-overview-top-grid")
                .gap_3()
                .flex_wrap()
                .items_start()
                .child(top_table_card(app_theme, "高消耗活动", "按花费排序的 Top 广告活动", campaigns))
                .child(top_table_card(app_theme, "高消耗 SKU", "按花费排序的 Top 推广商品", products))
                .child(top_table_card(app_theme, "浪费搜索词", "有花费但订单贡献为 0 的搜索词", waste)),
        )
        .child(
            h_flex()
                .id("ad-overview-insight-grid")
                .gap_3()
                .flex_wrap()
                .items_start()
                .child(narrative_card(&overview.narrative_sections, app_theme))
                .child(issue_card(&overview.issue_cards, app_theme)),
        )
}

/// 居中提示面板（Tab 内容区的轻量空态 / 引导）
fn hint_panel(app_theme: &AppTheme, text: &str) -> impl IntoElement {
    div()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .text_sm()
        .text_color(app_theme.text_muted)
        .child(text.to_string())
}

// ---------------------------------------------------------------------------
// 总览卡片件（指标卡 / 周期对比 / Top 表 / 分析 / 风险；沿用 P3-3 定稿视觉）
// ---------------------------------------------------------------------------

/// 指标卡网格（flex 自动换行；display_value 由后端格式化，数值 mono 收口）
fn metric_cards(
    metrics: &[gui_domain::advertising::AdMetricCard],
    app_theme: &AppTheme,
) -> impl IntoElement {
    h_flex()
        .id("ad-analysis-metrics")
        .gap_3()
        .flex_wrap()
        .children(metrics.iter().map(|m| {
            let value_color = if app_theme.is_dark() {
                app_theme.text_primary
            } else {
                app_theme.accent
            };
            v_flex()
                .id(SharedString::from(format!("ad-metric-{}", m.label)))
                .flex_1()
                .min_w(px(150.))
                .gap_1p5()
                .p_3()
                .rounded(px(app_theme.radius_lg))
                .border_1()
                .border_color(app_theme.separator)
                .bg(app_theme.card_bg)
                .hover(|this| this.bg(app_theme.muted_fill))
                .child(
                    div()
                        .text_size(px(FONT_XS))
                        .text_color(app_theme.text_muted)
                        .child(m.label.clone()),
                )
                .child(
                    div()
                        .text_size(px(FONT_TITLE_LG))
                        .font_semibold()
                        .mono_tabular_nums()
                        .text_color(value_color)
                        .child(m.display_value.clone()),
                )
                .children(m.helper.clone().map(|h| {
                    div()
                        .text_size(px(FONT_2XS))
                        .text_color(app_theme.text_muted)
                        .child(h)
                }))
        }))
}

/// 周期对比卡：当前 vs 上一周期，6 项变化率（比率 ×100 → %；数字 mono）
fn comparison_card(comparison: &AdPeriodComparison, app_theme: &AppTheme) -> impl IntoElement {
    let current = format!(
        "{} ~ {}",
        comparison.current_start.as_deref().unwrap_or("—"),
        comparison.current_end.as_deref().unwrap_or("—")
    );
    let previous = format!(
        "{} ~ {}",
        comparison.previous_start.as_deref().unwrap_or("—"),
        comparison.previous_end.as_deref().unwrap_or("—")
    );
    let items: [(&str, Option<f64>); 6] = [
        ("花费变化", comparison.spend_change_ratio),
        ("点击变化", comparison.clicks_change_ratio),
        ("销售变化", comparison.sales_change_ratio),
        ("订单变化", comparison.orders_change_ratio),
        ("CPC 变化", comparison.cpc_change_ratio),
        ("ACOS 变化", comparison.acos_change_ratio),
    ];

    v_flex()
        .id("ad-analysis-comparison")
        .w_full()
        .rounded(px(app_theme.radius_lg))
        .border_1()
        .border_color(app_theme.separator)
        .bg(app_theme.card_bg)
        .child(
            v_flex()
                .gap_1()
                .px_3()
                .py_2()
                .border_b_1()
                .border_color(app_theme.separator)
                .child(
                    div()
                        .text_size(px(FONT_BASE))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(app_theme.text_primary)
                        .child("周期对比"),
                )
                .child(
                    div()
                        .text_size(px(FONT_2XS))
                        .mono_tabular_nums()
                        .text_color(app_theme.text_muted)
                        .child(format!("当前周期 {current} 对比上一周期 {previous}")),
                ),
        )
        .child(
            h_flex()
                .gap_2()
                .flex_wrap()
                .px_3()
                .py_2()
                .children(items.iter().map(|(label, ratio)| {
                    v_flex()
                        .id(SharedString::from(format!("ad-compare-{label}")))
                        .flex_1()
                        .min_w(px(120.))
                        .gap_1()
                        .p_2()
                        .rounded(px(app_theme.radius))
                        .bg(app_theme.muted_fill.opacity(0.4))
                        .child(
                            div()
                                .text_size(px(FONT_2XS))
                                .text_color(app_theme.text_muted)
                                .child(*label),
                        )
                        .child(
                            div()
                                .text_size(px(FONT_BASE))
                                .font_weight(FontWeight::MEDIUM)
                                .mono_tabular_nums()
                                .text_color(change_color(*ratio, app_theme))
                                .child(
                                    ratio
                                        .map(|r| format!("{:+.2}%", r * 100.0))
                                        .unwrap_or_else(|| "—".to_string()),
                                ),
                        )
                })),
        )
}

/// 变化率颜色：正 → success，负 → danger，0 / None → 中性
fn change_color(ratio: Option<f64>, app_theme: &AppTheme) -> gpui::Hsla {
    match ratio {
        Some(r) if r > 0.0 => app_theme.success,
        Some(r) if r < 0.0 => app_theme.danger,
        _ => app_theme.text_secondary,
    }
}

/// Top 表卡片外壳：标题 + 说明 + DataTable 实体
fn top_table_card<T: Clone + PartialEq + 'static>(
    app_theme: &AppTheme,
    title: &'static str,
    subtitle: &'static str,
    table: Entity<DataTable<T>>,
) -> impl IntoElement {
    v_flex()
        .id(SharedString::from(format!("ad-top-{}", table.entity_id())))
        .flex_1()
        .min_w(px(300.))
        .rounded(px(app_theme.radius_lg))
        .border_1()
        .border_color(app_theme.separator)
        .bg(app_theme.card_bg)
        .overflow_hidden()
        .child(
            v_flex()
                .gap_px()
                .px_3()
                .py_2()
                .border_b_1()
                .border_color(app_theme.separator)
                .child(
                    div()
                        .text_size(px(FONT_BASE))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(app_theme.text_primary)
                        .child(title.to_string()),
                )
                .child(
                    div()
                        .text_size(px(FONT_2XS))
                        .text_color(app_theme.text_muted)
                        .child(subtitle.to_string()),
                ),
        )
        .child(table)
}

/// 高消耗活动列定义（对齐旧 mini 表头：活动 / Spend / Sales / 订单 / ACOS）
fn campaign_columns() -> Vec<ColumnDef<AdTopCampaignRow>> {
    vec![
        ColumnDef::text("campaign", "活动", |r: &AdTopCampaignRow, _| {
            SharedString::from(r.campaign_name.clone().unwrap_or_else(|| "—".to_string()))
        }),
        ColumnDef::number("spend", "Spend", |r: &AdTopCampaignRow| r.spend, |r: &_, _| {
            SharedString::from(fmt_money_precise(r.spend))
        })
        .width(88.0),
        ColumnDef::number("sales", "Sales", |r: &AdTopCampaignRow| r.sales_7d, |r: &_, _| {
            SharedString::from(fmt_money_precise(r.sales_7d))
        })
        .width(88.0),
        ColumnDef::number("orders", "订单", |r: &AdTopCampaignRow| r.orders_7d as f64, |r: &_, _| {
            SharedString::from(fmt_num_precise(r.orders_7d))
        })
        .width(56.0),
        ColumnDef::number("acos", "ACOS", |r: &AdTopCampaignRow| r.acos, |r: &_, _| {
            SharedString::from(format!("{:.2}%", r.acos * 100.0))
        })
        .width(64.0),
    ]
}

/// 高消耗 SKU 列定义（SKU / Spend / Sales / 订单 / ACOS）
fn product_columns() -> Vec<ColumnDef<AdTopProductRow>> {
    vec![
        ColumnDef::text("sku", "SKU", |r: &AdTopProductRow, _| {
            SharedString::from(r.ad_sku.clone().unwrap_or_else(|| "—".to_string()))
        }),
        ColumnDef::number("spend", "Spend", |r: &AdTopProductRow| r.spend, |r: &_, _| {
            SharedString::from(fmt_money_precise(r.spend))
        })
        .width(88.0),
        ColumnDef::number("sales", "Sales", |r: &AdTopProductRow| r.sales_7d, |r: &_, _| {
            SharedString::from(fmt_money_precise(r.sales_7d))
        })
        .width(88.0),
        ColumnDef::number("orders", "订单", |r: &AdTopProductRow| r.orders_7d as f64, |r: &_, _| {
            SharedString::from(fmt_num_precise(r.orders_7d))
        })
        .width(56.0),
        ColumnDef::number("acos", "ACOS", |r: &AdTopProductRow| r.acos, |r: &_, _| {
            SharedString::from(format!("{:.2}%", r.acos * 100.0))
        })
        .width(64.0),
    ]
}

/// 浪费搜索词列定义（搜索词 / 活动 / 点击 / Spend / 订单）
fn waste_columns() -> Vec<ColumnDef<AdTopWasteTermRow>> {
    vec![
        ColumnDef::text("term", "搜索词", |r: &AdTopWasteTermRow, _| {
            SharedString::from(r.search_term.clone().unwrap_or_else(|| "—".to_string()))
        }),
        ColumnDef::text("campaign", "活动", |r: &AdTopWasteTermRow, _| {
            SharedString::from(r.campaign_name.clone().unwrap_or_else(|| "—".to_string()))
        })
        .width(120.0),
        ColumnDef::number("clicks", "点击", |r: &AdTopWasteTermRow| r.clicks as f64, |r: &_, _| {
            SharedString::from(fmt_num_precise(r.clicks))
        })
        .width(56.0),
        ColumnDef::number("spend", "Spend", |r: &AdTopWasteTermRow| r.spend, |r: &_, _| {
            SharedString::from(fmt_money_precise(r.spend))
        })
        .width(88.0),
        ColumnDef::number("orders", "订单", |r: &AdTopWasteTermRow| r.orders_7d as f64, |r: &_, _| {
            SharedString::from(fmt_num_precise(r.orders_7d))
        })
        .width(56.0),
    ]
}

/// 结构化分析卡（AI 基于广告数据的结构化结论）
fn narrative_card(sections: &[AdNarrativeSection], app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("ad-analysis-narrative")
        .flex_1()
        .min_w(px(300.))
        .rounded(px(app_theme.radius_lg))
        .border_1()
        .border_color(app_theme.separator)
        .bg(app_theme.card_bg)
        .child(
            v_flex()
                .gap_px()
                .px_3()
                .py_2()
                .border_b_1()
                .border_color(app_theme.separator)
                .child(
                    div()
                        .text_size(px(FONT_BASE))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(app_theme.text_primary)
                        .child("结构化分析"),
                )
                .child(
                    div()
                        .text_size(px(FONT_2XS))
                        .text_color(app_theme.text_muted)
                        .child("AI 基于广告数据的结构化结论"),
                ),
        )
        .child(
            v_flex()
                .gap_2()
                .px_3()
                .py_2()
                .children(sections.iter().map(|s| {
                    v_flex()
                        .id(SharedString::from(format!("ad-narrative-{}", s.title)))
                        .gap_1()
                        .p_2()
                        .rounded(px(app_theme.radius))
                        .bg(app_theme.muted_fill.opacity(0.4))
                        .child(
                            div()
                                .text_size(px(FONT_BASE))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(app_theme.text_primary)
                                .child(s.title.clone()),
                        )
                        .child(
                            div()
                                .text_size(px(FONT_BASE))
                                .text_color(app_theme.text_secondary)
                                .child(s.summary.clone()),
                        )
                        .children(s.evidence.iter().map(|e| {
                            div()
                                .text_size(px(FONT_2XS))
                                .text_color(app_theme.text_muted)
                                .child(format!("- {e}"))
                        }))
                        .when(s.action.is_some(), |this| {
                            this.child(
                                div()
                                    .text_size(px(FONT_2XS))
                                    .text_color(app_theme.text_secondary)
                                    .child(format!(
                                        "动作:{}",
                                        s.action.clone().unwrap_or_default()
                                    )),
                            )
                        })
                }))
                .when(sections.is_empty(), |this| {
                    this.child(hint_inline(app_theme, "当前还没有可用的结构化分析结论"))
                }),
        )
}

/// 风险提醒卡（需要关注的广告风险信号）
fn issue_card(issues: &[AdIssueCard], app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("ad-analysis-issues")
        .flex_1()
        .min_w(px(300.))
        .rounded(px(app_theme.radius_lg))
        .border_1()
        .border_color(app_theme.separator)
        .bg(app_theme.card_bg)
        .child(
            v_flex()
                .gap_px()
                .px_3()
                .py_2()
                .border_b_1()
                .border_color(app_theme.separator)
                .child(
                    div()
                        .text_size(px(FONT_BASE))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(app_theme.text_primary)
                        .child("风险提醒"),
                )
                .child(
                    div()
                        .text_size(px(FONT_2XS))
                        .text_color(app_theme.text_muted)
                        .child("需要关注的广告风险信号"),
                ),
        )
        .child(
            v_flex()
                .gap_2()
                .px_3()
                .py_2()
                .children(issues.iter().map(|issue| {
                    v_flex()
                        .id(SharedString::from(format!("ad-issue-{}", issue.title)))
                        .gap_1()
                        .p_2()
                        .rounded(px(app_theme.radius))
                        .bg(app_theme.danger_soft.opacity(0.35))
                        .child(
                            h_flex()
                                .gap_2()
                                .items_center()
                                .child(
                                    Icon::new(IconName::TriangleAlert)
                                        .with_size(px(14.))
                                        .text_color(app_theme.warning),
                                )
                                .child(
                                    div()
                                        .text_size(px(FONT_BASE))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(app_theme.text_primary)
                                        .child(issue.title.clone()),
                                )
                                .child(
                                    div()
                                        .text_size(px(FONT_2XS))
                                        .text_color(app_theme.text_muted)
                                        .child(issue.level.clone()),
                                ),
                        )
                        .child(
                            div()
                                .text_size(px(FONT_BASE))
                                .text_color(app_theme.text_secondary)
                                .child(issue.summary.clone()),
                        )
                        .when(issue.next_step.is_some(), |this| {
                            this.child(
                                div()
                                    .text_size(px(FONT_2XS))
                                    .text_color(app_theme.text_secondary)
                                    .child(format!(
                                        "下一步:{}",
                                        issue.next_step.clone().unwrap_or_default()
                                    )),
                            )
                        })
                }))
                .when(issues.is_empty(), |this| {
                    this.child(hint_inline(app_theme, "当前没有明显风险信号"))
                }),
        )
}

/// 卡片内空态文案（居中灰字小行）
fn hint_inline(app_theme: &AppTheme, text: &str) -> impl IntoElement {
    div()
        .px_2()
        .py_5()
        .text_center()
        .text_size(px(FONT_BASE))
        .text_color(app_theme.text_muted)
        .child(text.to_string())
}

// ---------------------------------------------------------------------------
// 筛选控件（项目 / 站点下拉 + 刷新；on_click 捕获 Entity 范式，BLF-692）
// ---------------------------------------------------------------------------

fn refresh_button(view: &Entity<AdAnalysisView>) -> Button {
    let view = view.clone();
    Button::new("ad-analysis-refresh")
        .outline()
        .small()
        .label("刷新")
        .on_click(move |_, _window, cx| {
            view.update(cx, |this, cx| this.reload(cx));
        })
}

fn render_project_select(
    view: &Entity<AdAnalysisView>,
    app_theme: &AppTheme,
    projects: &[ManagedProject],
    selected_project_id: Option<i64>,
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
    let view_for_project = view.clone();
    h_flex()
        .gap_2()
        .items_center()
        .child(
            div()
                .text_size(px(FONT_XS))
                .text_color(app_theme.text_muted)
                .child("项目"),
        )
        .child(
            Button::new("ad-analysis-project-filter")
                .outline()
                .small()
                .label(project_label)
                .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                .dropdown_menu_with_anchor(
                    gpui::Corner::BottomLeft,
                    move |menu, _window, _cx| {
                        let mut menu = menu;
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
        )
}

fn render_country_select(
    view: &Entity<AdAnalysisView>,
    app_theme: &AppTheme,
    country: &'static str,
) -> impl IntoElement {
    let view_for_country = view.clone();
    h_flex()
        .gap_2()
        .items_center()
        .child(
            div()
                .text_size(px(FONT_XS))
                .text_color(app_theme.text_muted)
                .child("站点"),
        )
        .child(
            Button::new("ad-analysis-country-filter")
                .outline()
                .small()
                .label(ad_country_label(country))
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
                                        view.update(cx, |this, cx| this.select_country(value, cx));
                                    },
                                ),
                            );
                        }
                        menu
                    },
                ),
        )
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use gui_domain::advertising::{AdMetricCard, AdTopCampaignRow};

    // ---------- 纯函数 ----------

    #[test]
    fn ad_country_label_matches_frontend_options() {
        assert_eq!(ad_country_label("US"), "美国站 (US)");
        assert_eq!(ad_country_label("DE"), "德国站 (DE)");
        assert_eq!(ad_country_label("UK"), "英国站 (UK)");
        assert_eq!(ad_country_label("FR"), "FR");
    }

    fn sample_data() -> AdAnalysisData {
        AdAnalysisData {
            projects: vec![ManagedProject {
                id: 1,
                name: "测试项目".to_string(),
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
            }],
            overview: AdOverviewResponse {
                project_id: 1,
                country: "US".to_string(),
                metrics: vec![AdMetricCard {
                    label: "花费".to_string(),
                    value: 122.4,
                    display_value: "$122.40".to_string(),
                    helper: Some("近 7 天".to_string()),
                }],
                issue_cards: Vec::new(),
                narrative_sections: Vec::new(),
                comparison: None,
                top_campaigns: vec![AdTopCampaignRow {
                    campaign_name: Some("活动 A".to_string()),
                    spend: 80.0,
                    sales_7d: 1200.0,
                    orders_7d: 8,
                    acos: 0.0667,
                }],
                top_products: Vec::new(),
                top_waste_terms: Vec::new(),
                trend_summary: vec![AdTrendRow {
                    report_date: Some("2026-08-13".to_string()),
                    spend: 18.0,
                    clicks: 35,
                    cpc: 0.51,
                    spend_change_ratio: Some(0.12),
                }],
            },
            date_from: NaiveDate::from_ymd_opt(2026, 8, 7).unwrap(),
            date_to: NaiveDate::from_ymd_opt(2026, 8, 13).unwrap(),
        }
    }

    #[test]
    fn from_fetch_result_maps_to_loaded_empty_error() {
        let data = sample_data();
        assert_eq!(
            AdAnalysisState::from_fetch_result(Ok(data.clone())),
            AdAnalysisState::Loaded(data)
        );

        let mut empty = sample_data();
        empty.overview.metrics.clear();
        empty.overview.trend_summary.clear();
        empty.overview.top_campaigns.clear();
        assert_eq!(
            AdAnalysisState::from_fetch_result(Ok(empty)),
            AdAnalysisState::Empty
        );
        assert_eq!(
            AdAnalysisState::from_fetch_result(Err("接口 500".to_string())),
            AdAnalysisState::Error("接口 500".to_string())
        );
    }

    /// BLF-799：Tab 清单 = 总览 + 9 明细 Tab，顺序对齐 frontend AD_ANALYSIS_TABS
    #[test]
    fn tab_items_cover_ten_tabs_in_frontend_order() {
        let items = ad_tab_items();
        let keys: Vec<&str> = items.iter().map(|t| t.key).collect();
        assert_eq!(
            keys,
            vec![
                "overview",
                "time-trend",
                "campaigns",
                "products",
                "purchased-products",
                "search-terms",
                "targets",
                "placements",
                "budget",
                "traffic-quality",
            ]
        );
        assert_eq!(items[0].label, "总览");
    }

    /// BLF-799：列配置派生——数值列 mono + 右对齐 + 可排序（dyn 排序键），
    /// 文本列不可排序、弹性宽。
    #[test]
    fn value_columns_derive_numeric_and_sortable_flags() {
        let def = ad_analysis_tab("campaigns").expect("活动 Tab 配置存在");
        let cols = value_columns(&def);
        assert_eq!(cols.len(), def.columns.len());
        for (col, src) in cols.iter().zip(&def.columns) {
            if is_numeric_format(src.format) {
                assert!(col.numeric && col.sortable && col.align == CellAlign::Right);
                assert!(col.sort_value_dyn.is_some() || col.sort_value.is_some());
            } else {
                assert!(!col.numeric && !col.sortable);
            }
        }
        // 动态排序键真的按 key 取到数（缺字段 → NaN 沉底）
        let spend_col = cols
            .iter()
            .find(|c| c.id == "spend")
            .expect("活动表必有 spend 列");
        let sorter = spend_col.sort_value_dyn.as_ref().expect("数值列必有 dyn 键");
        let row = serde_json::json!({"spend": 30.5});
        assert_eq!(sorter(&row), 30.5);
        let missing = sorter(&serde_json::json!({}));
        assert!(missing.is_nan());
    }

    #[test]
    fn tab_aggregates_sum_known_keys_and_count_rows() {
        let rows = vec![
            serde_json::json!({"campaign_name": "A", "spend": 10.5, "sales_7d": 200.0, "orders_7d": 3}),
            serde_json::json!({"campaign_name": "B", "spend": 1.5}),
        ];
        let aggs = tab_aggregates(&rows);
        assert_eq!(aggs.len(), 4);
        assert_eq!(aggs[0].value, "2");
        assert_eq!(aggs[1].value, "$12.00");
        assert_eq!(aggs[2].value, "$200.00");
        assert_eq!(aggs[3].value, "3");
        // 空行集 → 全零聚合，不 panic
        let empty = tab_aggregates(&[]);
        assert_eq!(empty[0].value, "0");
    }

    #[test]
    fn short_date_label_converts_iso_to_md() {
        assert_eq!(short_date_label("2026-08-13"), "8/13");
        assert_eq!(short_date_label("2026-01-05"), "1/5");
        assert_eq!(short_date_label("—"), "—");
    }

    #[test]
    fn spend_trend_points_map_trend_rows_in_order() {
        let points = spend_trend_points(&sample_data().overview.trend_summary);
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].label, "8/13");
        assert_eq!(points[0].value, 18.0);
        // 缺日期行 → 占位标签不 panic
        let points = spend_trend_points(&[AdTrendRow {
            report_date: None,
            spend: 0.0,
            clicks: 0,
            cpc: 0.0,
            spend_change_ratio: None,
        }]);
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].label, "—");
    }

    #[test]
    fn campaign_spend_shares_take_top_campaigns_with_fallback_names() {
        let shares = campaign_spend_shares(&sample_data().overview);
        assert_eq!(shares.len(), 1);
        assert_eq!(shares[0].name, "活动 A");
        assert_eq!(shares[0].sales, 80.0);
    }

    // ---------- 视图级状态转移（TestAppContext，无真实网络） ----------

    fn create_view(cx: &mut gpui::TestAppContext, ratio: Option<u16>) -> Entity<AdAnalysisView> {
        cx.update(|cx| {
            let client = Client::new("http://127.0.0.1:1");
            cx.new(|cx| AdAnalysisView::new(cx, client, ratio))
        })
    }

    #[gpui::test]
    async fn initial_state_is_loading_with_restored_ratio(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx, Some(420));
        cx.read(|app| {
            let view = view.read(app);
            assert_eq!(view.current_state(app), AdAnalysisState::Loading);
            assert!((view.chart_ratio() - 0.42).abs() < 1e-6, "比例应自偏好恢复");
            // 越界偏好回落默认
        });
        let view = create_view(cx, Some(900));
        cx.read(|app| {
            assert!((view.read(app).chart_ratio() - crate::widgets::pattern_b::DEFAULT_CHART_RATIO).abs() < 1e-6);
        });
    }

    #[gpui::test]
    async fn set_chart_ratio_clamps_into_spec_band(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx, None);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.set_chart_ratio(0.9, cx);
                assert!((this.chart_ratio() - crate::widgets::pattern_b::MAX_CHART_RATIO).abs() < 1e-6);
                this.set_chart_ratio(0.1, cx);
                assert!((this.chart_ratio() - crate::widgets::pattern_b::MIN_CHART_RATIO).abs() < 1e-6);
                this.set_chart_ratio(0.47, cx);
                assert!((this.chart_ratio() - 0.47).abs() < 1e-6);
            });
        });
    }

    #[gpui::test]
    async fn commit_chart_ratio_emits_per_mille_event(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx, None);
        let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::<u16>::new()));
        let sink = events.clone();
        cx.update(|cx| {
            cx.subscribe(&view, move |_v, event: &AdAnalysisEvent, _cx| match event {
                AdAnalysisEvent::ChartRatioCommitted(per_mille) => {
                    sink.borrow_mut().push(*per_mille);
                }
            })
            .detach();
            view.update(cx, |this, cx| {
                this.set_chart_ratio(0.43, cx);
                this.commit_chart_ratio(cx);
            });
        });
        cx.run_until_parked();
        assert_eq!(events.borrow().as_slice(), &[430]);
    }

    #[gpui::test]
    async fn activate_tab_without_project_stays_unfetched(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx, None);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.activate_tab(1, cx); // 趋势 Tab；未选项目 → 不建槽位不发请求
                assert_eq!(this.active_tab_ix(), 1);
                assert!(this.tabs[1].is_none(), "未选项目不应创建槽位/发请求");
                this.activate_tab(99, cx); // 越界 no-op
                assert_eq!(this.active_tab_ix(), 1);
            });
        });
    }

    #[gpui::test]
    async fn activate_same_tab_twice_keeps_single_fetch_intent(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx, None);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.selected_project_id = Some(7);
                this.activate_tab(2, cx); // 首次激活 → 建槽位 Loading（请求发往不可达地址）
                let first_request = this.tabs[2].as_ref().unwrap().request_id;
                assert_eq!(this.tabs[2].as_ref().unwrap().status, AdTabStatus::Loading);
                this.activate_tab(2, cx); // 同 Tab no-op：request id 不再递增
                assert_eq!(this.tabs[2].as_ref().unwrap().request_id, first_request);
            });
        });
    }

    /// BLF-799：懒加载守卫——已加载且参数未变的 Tab，ensure 零请求；
    /// 参数过期 / 错误态才重拉（「Tab 切换不重复拉取」的机制断言）。
    #[gpui::test]
    async fn needs_fetch_guard_skips_loaded_tabs_with_same_params(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx, None);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.selected_project_id = Some(7);
                let def = this.tab_defs[3].clone().expect("明细配置");
                let params = this.fetch_params();
                let mut slot = AdTabSlot::new(&def, cx);
                slot.loaded_params = params;
                slot.status = AdTabStatus::Loaded;
                this.tabs[3] = Some(slot);
            });
            // 参数未变 → 不重拉（request id 与状态都不动）
            view.update(cx, |this, cx| {
                let before = this.tabs[3].as_ref().unwrap().request_id;
                this.ensure_tab_loaded(3, cx);
                let slot = this.tabs[3].as_ref().unwrap();
                assert_eq!(slot.request_id, before);
                assert_eq!(slot.status, AdTabStatus::Loaded);
            });
            // 筛选变化 → 失效重拉（reload 清快照 + 活跃 Tab 立即重拉）
            view.update(cx, |this, cx| {
                this.active_tab = 3;
                this.select_country("DE", cx);
                let slot = this.tabs[3].as_ref().unwrap();
                assert_eq!(slot.status, AdTabStatus::Loading);
                assert!(slot.loaded_params.is_some(), "活跃 Tab 重拉时已写入新参数快照");
            });
        });
    }

    /// apply_tab_result：竞态过期响应丢弃；正常响应注入行 + 聚合 + 三态落点。
    #[gpui::test]
    async fn apply_tab_result_applies_only_latest_and_fills_grid(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx, None);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.selected_project_id = Some(7);
                this.activate_tab(1, cx);
                assert_eq!(this.tabs[1].as_ref().unwrap().status, AdTabStatus::Loading);
            });
        });
        cx.run_until_parked(); // 不可达地址的请求失败落地 → Error 态
        cx.update(|cx| {
            view.update(cx, |this, _cx| {
                assert!(matches!(
                    this.tabs[1].as_ref().unwrap().status,
                    AdTabStatus::Error(_)
                ));
            });
        });

        // 注入成功响应（走 apply_tab_result 公共路径）
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.selected_project_id = Some(7);
                let def = this.tab_defs[1].clone().expect("明细配置");
                let slot = this.tabs[1].insert(AdTabSlot::new(&def, cx));
                slot.request_id += 1;
                let request_id = slot.request_id;
                let resp: AdAnalysisTabResponse = serde_json::from_str(
                    r#"{"project_id":7,"country":"US","summary_cards":[{"label":"活动数","value":"2","helper":null}],"items":[{"clicks":35,"spend":18.0}]}"#,
                )
                .expect("样例响应应可解析");
                this.apply_tab_result("time-trend", request_id, Ok(resp), cx);
                let slot = this.tabs[1].as_ref().unwrap();
                assert_eq!(slot.status, AdTabStatus::Loaded);
                assert_eq!(slot.aggregates[0].value, "1");
                assert_eq!(slot.summary_cards.len(), 1);
            });
            // 过期 request id → 丢弃
            view.update(cx, |this, cx| {
                let stale = this.tabs[1].as_ref().unwrap().request_id - 1;
                let resp: AdAnalysisTabResponse = serde_json::from_str(
                    r#"{"project_id":7,"country":"US","items":[]}"#,
                )
                .expect("样例响应应可解析");
                this.apply_tab_result("time-trend", stale, Ok(resp), cx);
                assert_eq!(this.tabs[1].as_ref().unwrap().status, AdTabStatus::Loaded);
            });
        });
    }

    // ---------- 渲染冒烟（对齐 daily_analysis 的窗口宿主惯例） ----------

    struct Host {
        view: Entity<AdAnalysisView>,
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

    #[gpui::test]
    async fn loading_state_renders(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let view = create_view(cx, None);
        let (_host, _cx2) = cx.add_window_view(|_window, _cx| Host { view });
    }

    #[gpui::test]
    async fn empty_state_renders(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let view = create_view(cx, None);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Err("项目必填".to_string()), cx);
            });
        });
        let (_host, _cx2) = cx.add_window_view(move |_window, _cx| Host { view });
    }

    #[gpui::test]
    async fn loaded_canvas_renders_in_dark_mode(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        cx.update(|cx| {
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let view = create_view(cx, None);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Ok(sample_data()), cx);
            });
        });
        // Pattern B 整页首帧：图表区两卡 + Tab 条 + 总览内容
        // （指标卡 / 周期对比 / 三张 Top 表）+ 分割条全路径渲染
        let (_host, cx2) = cx.add_window_view(|_window, _cx| Host { view });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    /// 全部 10 个子 Tab 逐个切换渲染不 panic（无项目 → 明细 Tab 显示引导文案；
    /// 有项目但数据未回 → Loading 提示）。覆盖 Tab 条与内容分派的全部分支。
    #[gpui::test]
    async fn loaded_canvas_switches_all_ten_tabs_without_panic(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let view = create_view(cx, None);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Ok(sample_data()), cx);
            });
        });
        let host_view = view.clone();
        let (_host, _cx2) = cx.add_window_view(move |_window, _cx| Host { view: host_view });
        for ix in 1..10usize {
            cx.update(|cx| {
                view.update(cx, |this, cx| this.activate_tab(ix, cx));
            });
        }
        cx.read(|app| assert_eq!(view.read(app).active_tab_ix(), 9));
    }
}
