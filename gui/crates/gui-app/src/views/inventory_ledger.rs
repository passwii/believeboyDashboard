//! 运营 → 库存分类账视图（P5-2，BLF-720）
//!
//! frontend `app/dashboard/operations/inventory-ledger/` 的 GPUI 等价：
//! 项目 × 月份筛选 + 四维全局筛选（SKU / 仓库 / 处置状态 / 事件类型）+
//! 数据健康徽章（跨月连续性 / 双表对账）+ 4 KPI 卡 + 趋势 / 事件构成 /
//! Disposition 构成 / Top 仓库总览 + 汇总 / 明细 / 上传批次三 tab。
//!
//! 架构（复用 Phase 3/4/5 基建）：
//! - **四态状态机**：`Loading / Loaded / Empty / Error`，`latest_request_id`
//!   竞态保护——只有最新请求的响应才会落点；
//! - **数据管线**（对齐 web 设计决策 D6 + BEL-417 健壮性契约）：
//!   `list_managed_projects` → `resolve_project_id` 自动选第一个项目 →
//!   `ledger_months` 取可用月份（自动选第一个月）→ 并行拉取 6 端点
//!   （snapshot / trend / summary / detail / batches / consistency）；
//!   **部分端点失败不拖垮整体**（web `Promise.allSettled` 语义）——失败端点
//!   数据置空 + 横幅提示真实错误；6 端点全失败才进 Error 态；
//! - **筛选**：Summary + Detail 原始行是唯一真相源，四维筛选纯客户端过滤
//!   （总览 KPI / 构成 / 表格全部响应筛选，对齐 web `ledger-derive.ts`）；
//!   项目 / 月份切换重置维度筛选（web `prevScope` 语义）；
//! - **表格**：P5-0 `DataTable` + 客户端分页（每页 50，对齐 web PAGE_SIZE）；
//! - **动效**：Phase 4 `enter_fade_in` + `reduce_motion` 尊重。
//!
//! 与 frontend 的已知差异（有意保留，GPUI 能力边界 / 范围）：
//! - **CSV 导出未接入**（对齐既有 GUI 视图范围边界，后续统一补导出能力）；
//! - **趋势图为单序列期末库存**（web 是库存 + 损坏率双 Y 轴；gpui-component
//!   chart 无双 Y 轴，损坏占比已在 KPI 卡呈现）；
//! - **每 SKU 水位线缺失日期前向填充**（web recharts 断点留空；gpui chart
//!   无缺失语义，期末水位为存量指标，沿用前值语义合理）；
//! - **汇总表固定 12 主列**（web 另有 8 次级列可展开；GUI 横向空间有限，
//!   次级列经 CSV（web）可查，后续按需补列开关）；
//! - **空态语义**：项目列表为空 → 页面级空态；有项目但该月无数据 →
//!   Loaded 内「暂无库存分类账数据」提示卡（对齐 web empty state 文案）。

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use chrono::NaiveDate;
use gpui::{
    div, prelude::*, px, AnyElement, App, AsyncApp, Context, CursorStyle, Entity, FontWeight,
    Render, SharedString, WeakEntity, Window,
};
use gpui_component::{
    button::Button,
    chart::{AreaChart, BarChart},
    h_flex,
    menu::PopupMenuItem,
    skeleton::Skeleton,
    v_flex, Icon, IconName, Sizable,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::operations::inventory_ledger::{
    disposition_label, event_type_label, LedgerConsistencyResult, LedgerDetailRow,
    LedgerIngestBatchInfo, LedgerMonthsResponse, LedgerSkuMonthEom, LedgerSnapshotResponse,
    LedgerSummaryRow, LedgerTrendResponse,
};

use crate::theme::AppTheme;
use crate::widgets::chart_primitives::{chart_area, chart_empty, TrendPoint};
use crate::widgets::data_table::{CellAlign, ColumnDef, DataTable};
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::top_projects::fmt_num_precise;
use crate::widgets::{filter_bar, pagination, state_views};

/// 本页在侧栏中的 URL（root.rs 据此路由到本视图；与 gui-domain::sidebar 的
/// 库存分类账条目一致）
pub const INVENTORY_LEDGER_URL: &str = "/dashboard/operations/inventory-ledger";

/// 维度筛选「不过滤」值（对齐 frontend `ALL = 'all'`）
pub const FILTER_ALL: &str = "all";

/// 客户端分页每页行数（对齐 frontend `PAGE_SIZE = 50`）
const PAGE_SIZE: usize = 50;

/// 水位线 / 图例最多展示的 SKU 数（对齐 web `SKU_LINE_COLORS` 6 色）
const MAX_WATER_SKUS: usize = 6;

// ---------------------------------------------------------------------------
// 全局筛选（唯一筛选真相源，对齐 frontend LedgerFilters）
// ---------------------------------------------------------------------------

/// 四维全局筛选（`FILTER_ALL` = 不过滤；其余为具体维度值）
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LedgerFilters {
    pub msku: String,
    pub location: String,
    pub disposition: String,
    pub event_type: String,
}

impl LedgerFilters {
    /// 全部不过滤
    pub fn all() -> Self {
        Self {
            msku: FILTER_ALL.to_string(),
            location: FILTER_ALL.to_string(),
            disposition: FILTER_ALL.to_string(),
            event_type: FILTER_ALL.to_string(),
        }
    }

    /// 生效中的筛选个数（「清除筛选（N）」按钮口径）
    pub fn active_count(&self) -> usize {
        [
            &self.msku,
            &self.location,
            &self.disposition,
            &self.event_type,
        ]
        .iter()
        .filter(|v| v.as_str() != FILTER_ALL)
        .count()
    }
}

/// 筛选维度（下拉菜单回调用；Copy 便于闭包捕获）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterDim {
    Msku,
    Location,
    Disposition,
    EventType,
}

// ---------------------------------------------------------------------------
// 纯派生逻辑（对齐 frontend ledger-derive.ts；单测锁定）
// ---------------------------------------------------------------------------

/// Summary 行是否命中筛选（eventType 不参与 Summary 过滤，对齐 web）
pub fn summary_row_matches(row: &LedgerSummaryRow, f: &LedgerFilters) -> bool {
    if f.msku != FILTER_ALL && row.msku != f.msku {
        return false;
    }
    if f.location != FILTER_ALL && row.location != f.location {
        return false;
    }
    if f.disposition != FILTER_ALL && row.disposition != f.disposition {
        return false;
    }
    true
}

/// Detail 行是否命中筛选（四维全参与）
pub fn detail_row_matches(row: &LedgerDetailRow, f: &LedgerFilters) -> bool {
    if f.msku != FILTER_ALL && row.msku != f.msku {
        return false;
    }
    if f.location != FILTER_ALL && row.fulfillment_center != f.location {
        return false;
    }
    if f.disposition != FILTER_ALL && row.disposition != f.disposition {
        return false;
    }
    if f.event_type != FILTER_ALL && row.event_type != f.event_type {
        return false;
    }
    true
}

/// 应用全局筛选（Summary）
pub fn filter_summary_rows(rows: &[LedgerSummaryRow], f: &LedgerFilters) -> Vec<LedgerSummaryRow> {
    rows.iter()
        .filter(|r| summary_row_matches(r, f))
        .cloned()
        .collect()
}

/// 应用全局筛选（Detail）
pub fn filter_detail_rows(rows: &[LedgerDetailRow], f: &LedgerFilters) -> Vec<LedgerDetailRow> {
    rows.iter()
        .filter(|r| detail_row_matches(r, f))
        .cloned()
        .collect()
}

/// 期末口径：API 返回按 date desc 排序，对每个 (msku × location × disposition)
/// 分组取第一次出现的行（即该组合的最新水位）。对齐 web `latestEndingByGroup`。
pub fn latest_ending_by_group(rows: &[LedgerSummaryRow]) -> HashMap<String, LedgerSummaryRow> {
    let mut latest: HashMap<String, LedgerSummaryRow> = HashMap::new();
    for r in rows {
        let key = format!("{}|{}|{}", r.msku, r.location, r.disposition);
        latest.entry(key).or_insert_with(|| r.clone());
    }
    latest
}

/// 总览 KPI（对齐 web `computeKpis`）
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LedgerKpis {
    /// 筛选范围内期末总库存（每组合取末日 ending 求和）
    pub ending_total: i64,
    /// 其中非 SELLABLE 的期末库存
    pub damaged_qty: i64,
    /// damaged / ending（0 库存时 0.0）
    pub damaged_pct: f64,
    /// 筛选范围内事件净变动 sum(quantity)
    pub net_change: i64,
    /// 筛选范围内事件条数
    pub event_count: usize,
}

/// 从筛选后的原始行派生 KPI（设计决策 D6：原始行是唯一真相源）
pub fn compute_kpis(summary_rows: &[LedgerSummaryRow], detail_rows: &[LedgerDetailRow]) -> LedgerKpis {
    let mut ending_total = 0i64;
    let mut damaged_qty = 0i64;
    for r in latest_ending_by_group(summary_rows).values() {
        ending_total += r.ending_balance;
        if r.disposition != "SELLABLE" {
            damaged_qty += r.ending_balance;
        }
    }
    let net_change = detail_rows.iter().map(|r| r.quantity).sum();
    LedgerKpis {
        ending_total,
        damaged_qty,
        damaged_pct: if ending_total > 0 {
            damaged_qty as f64 / ending_total as f64 * 100.0
        } else {
            0.0
        },
        net_change,
        event_count: detail_rows.len(),
    }
}

/// 环比变动：来自 /snapshot 的 per-SKU change（月份级口径；SKU 筛选生效时
/// 只累加该 SKU，其余维度筛选不参与——snapshot 聚合没有这些维度）。
/// 全部 SKU 都无上月数据时返回 None。对齐 web `computeMomChange`。
pub fn compute_mom_change(skus: &[LedgerSkuMonthEom], msku_filter: &str) -> Option<i64> {
    let scoped: Vec<&LedgerSkuMonthEom> = if msku_filter == FILTER_ALL {
        skus.iter().collect()
    } else {
        skus.iter().filter(|s| s.msku == msku_filter).collect()
    };
    let with_change: Vec<i64> = scoped.iter().filter_map(|s| s.change).collect();
    if with_change.is_empty() {
        None
    } else {
        Some(with_change.iter().sum())
    }
}

/// 事件类型分组（count 降序；对齐 web `groupDetailByEventType`）
#[derive(Debug, Clone, PartialEq)]
pub struct EventTypeGroup {
    pub event_type: String,
    pub count: i64,
    pub net_qty: i64,
}

/// 按事件类型分组（总览「事件构成」图数据源）
pub fn group_detail_by_event_type(rows: &[LedgerDetailRow]) -> Vec<EventTypeGroup> {
    let mut map: HashMap<String, EventTypeGroup> = HashMap::new();
    for r in rows {
        let g = map.entry(r.event_type.clone()).or_insert_with(|| EventTypeGroup {
            event_type: r.event_type.clone(),
            count: 0,
            net_qty: 0,
        });
        g.count += 1;
        g.net_qty += r.quantity;
    }
    let mut groups: Vec<EventTypeGroup> = map.into_values().collect();
    groups.sort_by_key(|g| std::cmp::Reverse(g.count));
    groups
}

/// 期末 Disposition 构成行（qty 降序；对齐 web `dispositionBreakdown`）
#[derive(Debug, Clone, PartialEq)]
pub struct DispositionSlice {
    pub disposition: String,
    pub qty: i64,
    pub pct: f64,
}

/// 期末 Disposition 构成（总览「可售 vs 损坏」数据源）
pub fn disposition_breakdown(rows: &[LedgerSummaryRow]) -> Vec<DispositionSlice> {
    let mut totals: HashMap<String, i64> = HashMap::new();
    let mut grand = 0i64;
    for r in latest_ending_by_group(rows).values() {
        *totals.entry(r.disposition.clone()).or_insert(0) += r.ending_balance;
        grand += r.ending_balance;
    }
    let mut slices: Vec<DispositionSlice> = totals
        .into_iter()
        .map(|(disposition, qty)| DispositionSlice {
            disposition,
            qty,
            pct: if grand > 0 {
                qty as f64 / grand as f64 * 100.0
            } else {
                0.0
            },
        })
        .collect();
    slices.sort_by_key(|s| std::cmp::Reverse(s.qty));
    slices
}

/// 期末仓库分布行（qty 降序；对齐 web `topLocations`）
#[derive(Debug, Clone, PartialEq)]
pub struct LocationSlice {
    pub location: String,
    pub qty: i64,
}

/// 期末 Top 仓库分布（总览数据源）
pub fn top_locations(rows: &[LedgerSummaryRow], top_n: usize) -> Vec<LocationSlice> {
    let mut totals: HashMap<String, i64> = HashMap::new();
    for r in latest_ending_by_group(rows).values() {
        *totals.entry(r.location.clone()).or_insert(0) += r.ending_balance;
    }
    let mut slices: Vec<LocationSlice> = totals
        .into_iter()
        .map(|(location, qty)| LocationSlice { location, qty })
        .collect();
    slices.sort_by_key(|s| std::cmp::Reverse(s.qty));
    slices.truncate(top_n);
    slices
}

/// 水位线数据点（X 标签 = 日期；values 与 mskus 同序）
#[derive(Debug, Clone, PartialEq)]
pub struct WaterDatum {
    pub label: String,
    pub values: Vec<f64>,
}

/// 每 SKU 每日期末水位（跨 location/disposition 求和），日期升序；
/// 缺失日期前向填充（期末水位为存量指标，沿用前值；GPUI chart 无缺失语义，
/// 见模块头差异说明）。对齐 web `waterLevelSeries` 的聚合口径。
pub fn water_level_series(rows: &[LedgerSummaryRow]) -> (Vec<String>, Vec<WaterDatum>) {
    let mut seen: HashSet<(String, String, String, NaiveDate)> = HashSet::new();
    let mut per_sku: BTreeMap<String, BTreeMap<NaiveDate, i64>> = BTreeMap::new();
    for r in rows {
        let dedupe = (
            r.msku.clone(),
            r.location.clone(),
            r.disposition.clone(),
            r.date,
        );
        if !seen.insert(dedupe) {
            continue;
        }
        *per_sku
            .entry(r.msku.clone())
            .or_default()
            .entry(r.date)
            .or_insert(0) += r.ending_balance;
    }

    let mut dates: BTreeSet<NaiveDate> = BTreeSet::new();
    for date_map in per_sku.values() {
        dates.extend(date_map.keys().copied());
    }
    let mskus: Vec<String> = per_sku.keys().cloned().collect();

    let mut last: Vec<Option<i64>> = vec![None; mskus.len()];
    let data: Vec<WaterDatum> = dates
        .iter()
        .map(|date| {
            let mut values = Vec::with_capacity(mskus.len());
            for (ix, msku) in mskus.iter().enumerate() {
                if let Some(v) = per_sku.get(msku).and_then(|m| m.get(date)) {
                    last[ix] = Some(*v);
                }
                values.push(last[ix].unwrap_or(0) as f64);
            }
            WaterDatum {
                label: date.format("%m-%d").to_string(),
                values,
            }
        })
        .collect();
    (mskus, data)
}

/// 月份展示（`2026-07-01` → `2026-07`；period 参数仍用完整日期）
pub fn month_label(month: NaiveDate) -> String {
    month.format("%Y-%m").to_string()
}

/// datetime 展示（对齐 web `loaded_at.slice(0, 16).replace('T', ' ')`）
pub fn fmt_datetime(value: &str) -> String {
    value.chars().take(16).collect::<String>().replace('T', " ")
}

/// 解析当前项目 id：显式选中优先（失效时回退），否则取第一个项目——
/// 对齐 frontend `useAutoSelectFirstProject`。
pub fn resolve_project_id(selected: Option<i64>, projects: &[ManagedProject]) -> Option<i64> {
    if let Some(id) = selected {
        if projects.iter().any(|p| p.id == id) {
            return Some(id);
        }
    }
    projects.first().map(|p| p.id)
}

// ---------------------------------------------------------------------------
// tab（对齐 frontend Tabs：汇总视图 / 明细视图 / 上传批次）
// ---------------------------------------------------------------------------

/// 页面 tab（顺序即展示顺序）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LedgerTab {
    Summary,
    Detail,
    Batches,
}

impl LedgerTab {
    /// 全部 tab
    pub const ALL: [Self; 3] = [Self::Summary, Self::Detail, Self::Batches];

    /// element id 片段
    pub fn id(self) -> &'static str {
        match self {
            Self::Summary => "summary",
            Self::Detail => "detail",
            Self::Batches => "batches",
        }
    }

    /// 展示文案（对齐 web TabsTrigger）
    pub fn label(self) -> &'static str {
        match self {
            Self::Summary => "汇总视图 Summary",
            Self::Detail => "明细视图 Detail",
            Self::Batches => "上传批次",
        }
    }
}

// ---------------------------------------------------------------------------
// 载荷 + 状态机
// ---------------------------------------------------------------------------

/// 一次拉取的完整载荷（6 端点数据 + 筛选菜单数据源；apply_result 原子落点）
///
/// BEL-417 allSettled 语义：单端点失败 → 对应字段置空 + `partial_error`
/// 记录首个错误（横幅提示）；6 端点全失败在 `load_ledger` 层转 Err。
#[derive(Debug, Clone, PartialEq)]
pub struct LedgerPayload {
    /// 可见项目列表（项目筛选菜单数据源）
    pub projects: Vec<ManagedProject>,
    /// 当前数据所属项目（响应回显 / 自动选中落点）
    pub project_id: i64,
    /// 可用月份列表（月份筛选菜单数据源）
    pub months: Vec<NaiveDate>,
    /// 当前数据所属月份（`None` = 该项目无任何分类账数据）
    pub month: Option<NaiveDate>,
    /// 月度快照（环比口径 + 跨月连续性校验）
    pub snapshot: Option<LedgerSnapshotResponse>,
    /// 近 N 月趋势（项目级，不参与维度筛选）
    pub trend: Option<LedgerTrendResponse>,
    /// Summary 日水位行（原始真相源）
    pub summary: Vec<LedgerSummaryRow>,
    /// Detail 事件行（原始真相源）
    pub detail: Vec<LedgerDetailRow>,
    /// CSV 上传批次（追溯）
    pub batches: Vec<LedgerIngestBatchInfo>,
    /// 双表对账结果
    pub consistency: Option<LedgerConsistencyResult>,
    /// 部分端点失败提示（None = 全部成功）
    pub partial_error: Option<String>,
}

impl LedgerPayload {
    /// 是否有任何数据（对齐 web `hasAnyData`）
    pub fn has_any_data(&self) -> bool {
        !self.summary.is_empty() || !self.detail.is_empty() || self.snapshot.is_some()
    }
}

/// 库存分类账状态机（四态；Empty = 项目列表为空，Loaded 内另有「该月无数据」
/// 提示卡路径）
///
/// `Loaded` 载荷装箱（`Box`）避免 enum 变体体积差过大（large_enum_variant）。
#[derive(Debug, Clone, PartialEq)]
pub enum LedgerState {
    Loading,
    Loaded(Box<LedgerPayload>),
    Empty,
    Error(String),
}

impl LedgerState {
    /// 拉取结果 → 落点状态（唯一合法的「拉取完成」转移）
    pub fn from_fetch_result(result: Result<LedgerPayload, String>) -> Self {
        match result {
            Ok(payload) if payload.projects.is_empty() => Self::Empty,
            Ok(payload) => Self::Loaded(Box::new(payload)),
            Err(msg) => Self::Error(msg),
        }
    }
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// 库存分类账视图（四态状态机 + 项目/月份/四维筛选 + 三 tab + 竞态保护）
pub struct InventoryLedgerView {
    state: Entity<LedgerState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表（reload 刷新；筛选菜单数据源）
    projects: Vec<ManagedProject>,
    /// 当前选中项目（web 进入页面自动选第一个）
    selected_project_id: Option<i64>,
    /// 当前选中月份（`YYYY-MM-DD` 每月 1 号；web 自动选第一个月）
    selected_month: Option<NaiveDate>,
    /// 四维全局筛选（唯一筛选真相源；项目/月份切换时重置）
    filters: LedgerFilters,
    /// 当前 tab
    active_tab: LedgerTab,
    /// 汇总表分页（1-based）
    summary_page: usize,
    /// 明细表分页（1-based）
    detail_page: usize,
    /// 汇总表（P5-0 DataTable；筛选后行注入）
    summary_table: Option<Entity<DataTable<LedgerSummaryRow>>>,
    /// 明细表
    detail_table: Option<Entity<DataTable<LedgerDetailRow>>>,
    /// 上传批次表
    batches_table: Option<Entity<DataTable<LedgerIngestBatchInfo>>>,
    /// 请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,
}

impl InventoryLedgerView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| LedgerState::Loading);
        Self {
            state,
            client,
            projects: Vec::new(),
            selected_project_id: None,
            selected_month: None,
            filters: LedgerFilters::all(),
            active_tab: LedgerTab::Summary,
            summary_page: 1,
            detail_page: 1,
            summary_table: None,
            detail_table: None,
            batches_table: None,
            latest_request_id: 0,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)] // 视图级测试消费（对齐 inventory_analysis.rs current_state 用法）
    pub fn current_state(&self, cx: &App) -> LedgerState {
        self.state.read(cx).clone()
    }

    /// 重新拉取数据：项目/月份切换、错误重试、空态刷新共用入口
    /// （竞态保护；每次调用递增 `latest_request_id` 并进入 Loading）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let selected = self.selected_project_id;
        let month = self.selected_month;

        self.state.update(cx, |state, cx| {
            *state = LedgerState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(load_ledger(&client, selected, month))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 切换选中项目 → 重置维度筛选 + reload（同一项目为 no-op）
    pub fn select_project(&mut self, project_id: Option<i64>, cx: &mut Context<Self>) {
        if project_id == self.selected_project_id {
            return;
        }
        self.selected_project_id = project_id;
        self.selected_month = None; // 换项目 → 月份重新自动选第一个
        self.filters = LedgerFilters::all();
        self.reload(cx);
    }

    /// 切换月份 → 重置维度筛选 + reload（同一月份为 no-op）
    pub fn select_month(&mut self, month: NaiveDate, cx: &mut Context<Self>) {
        if Some(month) == self.selected_month {
            return;
        }
        self.selected_month = Some(month);
        self.filters = LedgerFilters::all();
        self.reload(cx);
    }

    /// 设置单个维度筛选 → 分页回第一页 + 重新注入表格行（同一值为 no-op；
    /// 不触发网络请求——筛选纯客户端，从原始行重新派生）
    pub fn set_filter(&mut self, dim: FilterDim, value: String, cx: &mut Context<Self>) {
        let slot = match dim {
            FilterDim::Msku => &mut self.filters.msku,
            FilterDim::Location => &mut self.filters.location,
            FilterDim::Disposition => &mut self.filters.disposition,
            FilterDim::EventType => &mut self.filters.event_type,
        };
        if *slot == value {
            return;
        }
        *slot = value;
        self.summary_page = 1;
        self.detail_page = 1;
        self.sync_table_rows(cx);
        cx.notify();
    }

    /// 清除全部维度筛选（「清除筛选（N）」按钮）
    pub fn clear_filters(&mut self, cx: &mut Context<Self>) {
        if self.filters == LedgerFilters::all() {
            return;
        }
        self.filters = LedgerFilters::all();
        self.summary_page = 1;
        self.detail_page = 1;
        self.sync_table_rows(cx);
        cx.notify();
    }

    /// 切换 tab（同一 tab 为 no-op）
    pub fn select_tab(&mut self, tab: LedgerTab, cx: &mut Context<Self>) {
        if tab == self.active_tab {
            return;
        }
        self.active_tab = tab;
        cx.notify();
    }

    /// 汇总表翻页 → 重新注入当前页切片
    pub fn set_summary_page(&mut self, page: usize, cx: &mut Context<Self>) {
        let page = page.max(1);
        if page == self.summary_page {
            return;
        }
        self.summary_page = page;
        self.sync_table_rows(cx);
        cx.notify();
    }

    /// 明细表翻页 → 重新注入当前页切片
    pub fn set_detail_page(&mut self, page: usize, cx: &mut Context<Self>) {
        let page = page.max(1);
        if page == self.detail_page {
            return;
        }
        self.detail_page = page;
        self.sync_table_rows(cx);
        cx.notify();
    }

    /// 应用拉取结果：竞态保护（过期响应丢弃）+ Loaded 落点后注入表格行
    /// （筛选已在切换时重置为 all，页码回 1）。
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<LedgerPayload, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok(payload) = &result {
            self.projects = payload.projects.clone();
            self.selected_project_id = Some(payload.project_id);
            self.selected_month = payload.month;
            self.summary_page = 1;
            self.detail_page = 1;
        }
        self.state.update(cx, |state, cx| {
            *state = LedgerState::from_fetch_result(result);
            cx.notify();
        });
        // 表格行注入（懒建 + 首页切片；读已落点的 state）
        self.sync_table_rows(cx);
    }

    /// 把「筛选后 + 当前页切片」的行喂进三张 DataTable（懒建 + 幂等注入）。
    ///
    /// 调用时机：`apply_result`（载荷落点）/ `set_filter` / `clear_filters` /
    /// 翻页——即一切改变表格行集合的状态变化；render 期不注入（避免渲染期
    /// notify）。batches 不受筛选/分页影响，直接全量注入。
    fn sync_table_rows(&mut self, cx: &mut Context<Self>) {
        let payload = match self.state.read(cx) {
            LedgerState::Loaded(payload) => payload.clone(),
            _ => return,
        };

        let filtered_summary = filter_summary_rows(&payload.summary, &self.filters);
        let summary_slice = page_slice(&filtered_summary, self.summary_page);
        let summary = self.summary_table.get_or_insert_with(|| {
            cx.new(|_| {
                DataTable::new("ledger-summary-table", summary_columns())
                    .striped(true)
                    .empty_text("无汇总水位数据")
                    .max_height(520.0)
            })
        });
        summary.update(cx, |t, cx| t.set_rows_if_changed(&summary_slice, cx));

        let filtered_detail = filter_detail_rows(&payload.detail, &self.filters);
        let detail_slice = page_slice(&filtered_detail, self.detail_page);
        let detail = self.detail_table.get_or_insert_with(|| {
            cx.new(|_| {
                DataTable::new("ledger-detail-table", detail_columns())
                    .striped(true)
                    .empty_text("无事件明细")
                    .max_height(520.0)
            })
        });
        detail.update(cx, |t, cx| t.set_rows_if_changed(&detail_slice, cx));

        let batches = self.batches_table.get_or_insert_with(|| {
            cx.new(|_| {
                DataTable::new("ledger-batches-table", batch_columns())
                    .striped(true)
                    .empty_text("暂无上传记录")
                    .max_height(520.0)
            })
        });
        batches.update(cx, |t, cx| t.set_rows_if_changed(&payload.batches, cx));
    }
}

/// 客户端分页切片（page 为 1-based；越界收敛到末页，对齐 PageState 语义）
fn page_slice<T: Clone>(rows: &[T], page: usize) -> Vec<T> {
    let page_count = rows.len().div_ceil(PAGE_SIZE).max(1);
    let page = page.clamp(1, page_count);
    let start = (page - 1) * PAGE_SIZE;
    rows.iter().skip(start).take(PAGE_SIZE).cloned().collect()
}

/// 拉取库存分类账数据（项目列表 + 月份 + 6 端点），与视图解耦便于测试。
///
/// 对齐 web `loadData`（BEL-417 allSettled 语义）：
/// - 项目列表为空 → Err（「暂无可用项目」，页面空态由 `from_fetch_result` 判定）；
/// - 未显式选项目 → 自动选第一个（`resolve_project_id`）；
/// - 月份列表失败 → Err（月份是其余端点的前置依赖，无法降级）；
/// - 未显式选月份 → 自动选第一个月；无任何月份 → Loaded 空数据载荷
///   （页面显示「暂无库存分类账数据」提示卡，对齐 web empty state）；
/// - 6 端点各自独立失败降级为空 + `partial_error`；全失败 → Err（首个错误）。
async fn load_ledger(
    client: &Client,
    selected_project_id: Option<i64>,
    selected_month: Option<NaiveDate>,
) -> Result<LedgerPayload, String> {
    let projects = client
        .list_managed_projects()
        .await
        .map_err(|e| e.user_message())?;
    let project_id = resolve_project_id(selected_project_id, &projects)
        .ok_or_else(|| "暂无可用项目，请先在系统中配置项目。".to_string())?;

    let months_resp: LedgerMonthsResponse = client
        .ledger_months(project_id)
        .await
        .map_err(|e| e.user_message())?;
    let months = months_resp.months;

    // 未显式选月份（或所选月份已不存在）→ 自动选第一个月
    let month = match selected_month {
        Some(m) if months.contains(&m) => Some(m),
        _ => months.first().copied(),
    };

    let Some(month) = month else {
        // 项目无任何分类账数据：Loaded 空载荷（页面级「暂无数据」提示卡）
        return Ok(LedgerPayload {
            projects,
            project_id,
            months,
            month: None,
            snapshot: None,
            trend: None,
            summary: Vec::new(),
            detail: Vec::new(),
            batches: Vec::new(),
            consistency: None,
            partial_error: None,
        });
    };

    let period = month.to_string();
    let (snap_res, trend_res, summary_res, detail_res, batches_res, cons_res) = tokio::join!(
        client.ledger_snapshot(project_id, &period),
        client.ledger_trend(project_id, gui_api_client::inventory_ledger::LEDGER_TREND_MONTHS),
        client.ledger_summary(project_id, &period),
        client.ledger_detail(project_id, &period),
        client.ledger_batches(project_id),
        client.ledger_consistency(project_id, &period),
    );

    let mut failures: Vec<String> = Vec::new();
    let snapshot = snap_res.map_err(|e| failures.push(e.user_message())).ok();
    let trend = trend_res.map_err(|e| failures.push(e.user_message())).ok();
    let summary = summary_res
        .map(|r| r.rows)
        .map_err(|e| failures.push(e.user_message()))
        .unwrap_or_default();
    let detail = detail_res
        .map(|r| r.rows)
        .map_err(|e| failures.push(e.user_message()))
        .unwrap_or_default();
    let batches = batches_res
        .map(|r| r.batches)
        .map_err(|e| failures.push(e.user_message()))
        .unwrap_or_default();
    let consistency = cons_res.map_err(|e| failures.push(e.user_message())).ok();

    // 6 端点全失败 → Error 态（对齐 web `failures.length === 6` 分支）
    if failures.len() == 6 {
        return Err(failures.remove(0));
    }

    let partial_error = if failures.is_empty() {
        None
    } else {
        Some(format!("部分数据加载失败：{}", failures.remove(0)))
    };

    Ok(LedgerPayload {
        projects,
        project_id,
        months,
        month: Some(month),
        snapshot,
        trend,
        summary,
        detail,
        batches,
        consistency,
        partial_error,
    })
}

impl Render for InventoryLedgerView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        match state {
            LedgerState::Loading => render_loading(&app_theme).into_any_element(),
            LedgerState::Error(msg) => render_error(cx, &app_theme, &msg).into_any_element(),
            LedgerState::Empty => render_empty(cx, &app_theme).into_any_element(),
            LedgerState::Loaded(payload) => {
                let view = cx.entity();
                let reduce = crate::motion::reduce_motion(cx);
                render_loaded(
                    &view,
                    &app_theme,
                    &payload,
                    self.filters.clone(),
                    self.active_tab,
                    self.summary_page,
                    self.detail_page,
                    self.summary_table.clone(),
                    self.detail_table.clone(),
                    self.batches_table.clone(),
                    reduce,
                )
                .into_any_element()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 四态渲染
// ---------------------------------------------------------------------------

/// Loading：Spinner + 筛选骨架 + KPI 卡骨架 + 表格骨架（与正式布局同构）
fn render_loading(app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("inventory-ledger-loading")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::loading_state(app_theme, "加载中…"))
        .child(
            h_flex()
                .gap_3()
                .children((0..3).map(|_| div().w(px(140.)).h_8().child(Skeleton::new()))),
        )
        .child(
            h_flex()
                .gap_3()
                .children((0..4).map(|_| {
                    v_flex()
                        .flex_1()
                        .gap_2()
                        .p_4()
                        .rounded(px(app_theme.radius_lg))
                        .bg(app_theme.card_bg)
                        .child(div().w_6().h_4().child(Skeleton::new()))
                        .child(div().w_16().h_7().child(Skeleton::new()))
                        .child(div().w_20().child(Skeleton::new()))
                })),
        )
        .child(div().w_full().h_80().child(Skeleton::new()))
}

/// Error：内联 Alert + 重试按钮（Stage 0 `state_views::error_state`）
fn render_error(
    cx: &mut Context<InventoryLedgerView>,
    app_theme: &AppTheme,
    msg: &str,
) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("inventory-ledger-error")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::error_state(
            &view,
            app_theme,
            "inventory-ledger-error",
            "库存分类账加载失败",
            msg.to_string(),
            |this, cx| this.reload(cx),
        ))
}

/// Empty（项目列表为空）：Icon + 文案 + 刷新按钮（Stage 0
/// `empty_state_with_action`）
fn render_empty(cx: &mut Context<InventoryLedgerView>, app_theme: &AppTheme) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("inventory-ledger-empty")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::empty_state_with_action(
            &view,
            app_theme,
            "inventory-ledger-empty",
            "icons/package.svg",
            "暂无可用项目，请先在系统中配置项目",
            "刷新",
            |this, cx| this.reload(cx),
        ))
}

/// Loaded：页面头 + 部分失败横幅 + 筛选栏 + 数据健康徽章 + KPI + 总览图表 +
/// 三 tab（有数据时）；该月无数据时显示「暂无库存分类账数据」提示卡。
///
/// 表格行由 `sync_table_rows` 在状态变化时注入（筛选后 + 当前页切片），
/// render 期只读。
#[allow(clippy::too_many_arguments)]
fn render_loaded(
    view: &Entity<InventoryLedgerView>,
    app_theme: &AppTheme,
    payload: &LedgerPayload,
    filters: LedgerFilters,
    active_tab: LedgerTab,
    summary_page: usize,
    detail_page: usize,
    summary_table: Option<Entity<DataTable<LedgerSummaryRow>>>,
    detail_table: Option<Entity<DataTable<LedgerDetailRow>>>,
    batches_table: Option<Entity<DataTable<LedgerIngestBatchInfo>>>,
    reduce: bool,
) -> impl IntoElement {
    let filtered_summary = filter_summary_rows(&payload.summary, &filters);
    let filtered_detail = filter_detail_rows(&payload.detail, &filters);
    let has_any_data = payload.has_any_data();

    let mut body = v_flex()
        .id("inventory-ledger-loaded")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(PageHeader::new("库存分类账").subtitle(format!(
            "按月对账 Amazon Inventory Ledger · {}",
            payload
                .month
                .map_or_else(|| "暂无数据".to_string(), month_label)
        )))
        .child(content_guard().child(render_filter_bar(view, app_theme, payload, &filters)));

    // BEL-417：部分端点失败 → 真实错误横幅（不静默假空态）
    if let Some(err) = &payload.partial_error {
        body = body.child(content_guard().child(partial_error_banner(app_theme, err)));
    }

    if !has_any_data {
        // 有项目但该月无任何分类账数据（对齐 web empty state 文案）
        body = body.child(content_guard().child(no_data_card(app_theme)));
    } else {
        body = body
            .child(content_guard().child(health_badges(app_theme, payload)))
            .child(content_guard().child(kpi_band(
                app_theme,
                &filtered_summary,
                &filtered_detail,
                payload,
                &filters,
            )))
            .child(content_guard().child(overview_grid(
                app_theme,
                payload,
                &filtered_summary,
                &filtered_detail,
            )))
            .child(content_guard().child(render_tab_bar(view, active_tab, app_theme)))
            .child(match active_tab {
                LedgerTab::Summary => render_summary_tab(
                    view,
                    app_theme,
                    &filtered_summary,
                    summary_page,
                    summary_table,
                )
                .into_any_element(),
                LedgerTab::Detail => render_detail_tab(
                    view,
                    app_theme,
                    &filtered_detail,
                    detail_page,
                    detail_table,
                )
                .into_any_element(),
                LedgerTab::Batches => {
                    render_batches_tab(app_theme, payload, batches_table).into_any_element()
                }
            });
    }

    crate::motion::enter_fade_in(SharedString::from("inventory-ledger-loaded-fade"), body, reduce)
}

/// 部分端点失败横幅（destructive 语义：danger 浅底 + 描边）
fn partial_error_banner(app_theme: &AppTheme, msg: &str) -> impl IntoElement {
    h_flex()
        .id("inventory-ledger-partial-error")
        .w_full()
        .items_center()
        .gap_2()
        .px_4()
        .py_3()
        .rounded(px(app_theme.radius))
        .border_1()
        .border_color(app_theme.danger.opacity(0.4))
        .bg(app_theme.danger.opacity(0.08))
        .child(
            Icon::new(IconName::TriangleAlert)
                .with_size(px(14.))
                .text_color(app_theme.danger),
        )
        .child(
            div()
                .text_sm()
                .text_color(app_theme.danger)
                .child(msg.to_string()),
        )
}

/// 该月无任何数据提示卡（对齐 web empty state：图标 + 主文案 + 上传指引）
fn no_data_card(app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("inventory-ledger-no-data")
        .w_full()
        .items_center()
        .justify_center()
        .gap_3()
        .px_8()
        .py_10()
        .rounded(px(app_theme.radius_lg))
        .bg(app_theme.card_bg)
        .shadow(vec![app_theme.card_shadow_box()])
        .child(
            Icon::empty()
                .path("icons/package.svg")
                .with_size(px(40.))
                .text_color(app_theme.text_muted.opacity(0.7)),
        )
        .child(
            div()
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .text_color(app_theme.text_secondary)
                .child("暂无库存分类账数据"),
        )
        .child(
            div()
                .text_xs()
                .text_color(app_theme.text_muted)
                .child("请通过「报表上传」页面上传 Amazon Inventory Ledger CSV（Summary / Detailed 视图均可自动识别）"),
        )
}

// ---------------------------------------------------------------------------
// 数据健康徽章（跨月连续性 / 双表对账，对齐 web IntegrityBadge / ConsistencyBadge）
// ---------------------------------------------------------------------------

/// 状态徽章胶囊（浅底 + 描边 + 强调色文字）
fn badge_pill(label: String, color: gpui::Hsla) -> AnyElement {
    h_flex()
        .items_center()
        .gap_1()
        .rounded_full()
        .border_1()
        .border_color(color.opacity(0.35))
        .bg(color.opacity(0.10))
        .px_2()
        .py_0p5()
        .child(
            div()
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .text_color(color)
                .child(label),
        )
        .into_any_element()
}

/// 数据健康徽章行（integrity / consistency 任一存在即渲染）
fn health_badges(app_theme: &AppTheme, payload: &LedgerPayload) -> impl IntoElement {
    let mut badges: Vec<AnyElement> = Vec::new();
    if let Some(integrity) = payload.snapshot.as_ref().and_then(|s| s.integrity.as_ref()) {
        let (label, color) = match integrity.status.as_str() {
            "OK" => ("跨月连续性校验通过".to_string(), app_theme.success),
            "PENDING" => ("无上月数据，暂无法校验".to_string(), app_theme.warning),
            _ => (
                format!("跨月连续性异常（{} 项）", integrity.mismatch_count),
                app_theme.danger,
            ),
        };
        badges.push(badge_pill(label, color));
    }
    if let Some(consistency) = &payload.consistency {
        let (label, color) = match consistency.status.as_str() {
            "OK" => (
                "双表对账通过（明细累加 = 汇总水位变动）".to_string(),
                app_theme.success,
            ),
            "PENDING" => ("本月无数据，暂无法对账".to_string(), app_theme.warning),
            _ => (
                format!("双表对账异常（{} 项）", consistency.mismatch_count),
                app_theme.danger,
            ),
        };
        badges.push(badge_pill(label, color));
    }
    h_flex()
        .id("inventory-ledger-health-badges")
        .w_full()
        .gap_2()
        .flex_wrap()
        .children(badges)
}

// ---------------------------------------------------------------------------
// KPI 卡（期末总库存 / 环比变动 / 损坏占比 / 事件净变动）
// ---------------------------------------------------------------------------

/// 4 张 KPI 卡（对齐 web `computeKpis` + `computeMomChange` 口径）
fn kpi_band(
    app_theme: &AppTheme,
    filtered_summary: &[LedgerSummaryRow],
    filtered_detail: &[LedgerDetailRow],
    payload: &LedgerPayload,
    filters: &LedgerFilters,
) -> impl IntoElement {
    let kpis = compute_kpis(filtered_summary, filtered_detail);
    let mom_change = payload
        .snapshot
        .as_ref()
        .and_then(|s| compute_mom_change(&s.skus, &filters.msku));
    let has_data = !filtered_summary.is_empty() || !filtered_detail.is_empty();

    let mom_value = mom_change.map_or_else(|| "—".to_string(), format_signed);
    let mom_color = match mom_change {
        Some(v) if v > 0 => Some(app_theme.success),
        Some(v) if v < 0 => Some(app_theme.danger),
        _ => None,
    };
    let net_color = if kpis.net_change > 0 {
        Some(app_theme.success)
    } else if kpis.net_change < 0 {
        Some(app_theme.danger)
    } else {
        None
    };

    h_flex()
        .id("inventory-ledger-kpis")
        .gap_3()
        .children(vec![
            kpi_card(
                app_theme,
                "期末总库存",
                if has_data {
                    fmt_num_precise(kpis.ending_total)
                } else {
                    "—".to_string()
                },
                "筛选范围内期末水位合计",
                None,
            ),
            kpi_card(
                app_theme,
                "环比变动",
                mom_value,
                "较上月期末（SKU 筛选口径）",
                mom_color,
            ),
            kpi_card(
                app_theme,
                "损坏占比",
                if has_data {
                    format!("{:.1}%", kpis.damaged_pct)
                } else {
                    "—".to_string()
                },
                &format!("非可售期末 {} 件", fmt_num_precise(kpis.damaged_qty)),
                if kpis.damaged_pct > 5.0 {
                    Some(app_theme.warning)
                } else {
                    None
                },
            ),
            kpi_card(
                app_theme,
                "事件净变动",
                if has_data {
                    format_signed(kpis.net_change)
                } else {
                    "—".to_string()
                },
                &format!("{} 条事件", fmt_num_precise(kpis.event_count as i64)),
                net_color,
            ),
        ])
}

/// 单张 KPI 卡：标签 + 数值 + 提示（数值可带强调色）
fn kpi_card(
    app_theme: &AppTheme,
    label: &'static str,
    value: String,
    hint: &str,
    value_color: Option<gpui::Hsla>,
) -> impl IntoElement {
    let color = value_color.unwrap_or(app_theme.text_primary);
    v_flex()
        .flex_1()
        .gap_1()
        .px_4()
        .py_3()
        .rounded(px(app_theme.radius_lg))
        .border_1()
        .border_color(app_theme.separator)
        .bg(app_theme.card_bg)
        .child(
            div()
                .text_xs()
                .text_color(app_theme.text_muted)
                .child(SharedString::from(label)),
        )
        .child(
            div()
                .text_2xl()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(color)
                .child(value),
        )
        .child(
            div()
                .text_xs()
                .text_color(app_theme.text_muted)
                .child(hint.to_string()),
        )
}

/// 带符号数值格式化（正数加 `+`，对齐 web `+${v}` 口径）
fn format_signed(v: i64) -> String {
    if v > 0 {
        format!("+{v}")
    } else {
        v.to_string()
    }
}

// ---------------------------------------------------------------------------
// 总览图表区（趋势 / 事件构成 / Disposition 构成 / Top 仓库，2×2 网格）
// ---------------------------------------------------------------------------

/// 总览区：近 N 月趋势 + 事件构成 + Disposition 构成 + Top 仓库
fn overview_grid(
    app_theme: &AppTheme,
    payload: &LedgerPayload,
    filtered_summary: &[LedgerSummaryRow],
    filtered_detail: &[LedgerDetailRow],
) -> impl IntoElement {
    // 趋势（项目级，不参与维度筛选）
    let trend_points: Vec<TrendPoint> = payload
        .trend
        .as_ref()
        .map(|t| {
            t.months
                .iter()
                .map(|m| TrendPoint {
                    label: m.report_month.clone(),
                    value: m.total_qty_eom as f64,
                })
                .collect()
        })
        .unwrap_or_default();
    let trend_body = if trend_points.is_empty() {
        chart_empty("暂无趋势数据", 200.0, app_theme).into_any_element()
    } else {
        chart_area(
            200.0,
            AreaChart::new(trend_points.clone())
                .x(|p: &TrendPoint| p.label.clone())
                .y(|p: &TrendPoint| p.value)
                .stroke(app_theme.chart_primary)
                .fill(app_theme.chart_primary.opacity(0.18))
                .natural()
                .tick_margin(1),
        )
        .into_any_element()
    };

    // 事件构成（筛选范围内各事件类型条数）
    let event_groups = group_detail_by_event_type(filtered_detail);
    let event_body = if event_groups.is_empty() {
        chart_empty("暂无事件数据", 200.0, app_theme).into_any_element()
    } else {
        let palette = app_theme.chart_palette();
        let bars: Vec<(String, f64)> = event_groups
            .iter()
            .map(|g| (event_type_label(&g.event_type), g.count as f64))
            .collect();
        chart_area(
            200.0,
            BarChart::new(bars)
                .x(|(label, _): &(String, f64)| label.clone())
                .y(|(_, count): &(String, f64)| *count)
                .fill(move |_| palette[0])
                .tick_margin(1),
        )
        .into_any_element()
    };

    // Disposition 构成（横向占比条）
    let dispositions = disposition_breakdown(filtered_summary);
    let disposition_body = if dispositions.is_empty() {
        chart_empty("暂无水位数据", 200.0, app_theme).into_any_element()
    } else {
        let items: Vec<(String, i64, f64)> = dispositions
            .iter()
            .map(|d| (disposition_label(&d.disposition), d.qty, d.pct))
            .collect();
        h_bar_list(&items, app_theme).into_any_element()
    };

    // Top 仓库分布（横向占比条）
    let locations = top_locations(filtered_summary, 5);
    let location_body = if locations.is_empty() {
        chart_empty("暂无水位数据", 200.0, app_theme).into_any_element()
    } else {
        let items: Vec<(String, i64, f64)> = locations
            .iter()
            .map(|l| (l.location.clone(), l.qty, 0.0))
            .collect();
        h_bar_list(&items, app_theme).into_any_element()
    };

    div()
        .id("inventory-ledger-overview")
        .w_full()
        .grid()
        .grid_cols(2)
        .gap_3()
        .child(overview_card(
            "inventory-ledger-trend-card",
            &format!("近 {} 月库存趋势", trend_points.len()),
            "项目级期末库存（不受维度筛选影响）",
            app_theme,
            trend_body,
        ))
        .child(overview_card(
            "inventory-ledger-event-card",
            "事件构成",
            "筛选范围内各事件类型条数",
            app_theme,
            event_body,
        ))
        .child(overview_card(
            "inventory-ledger-disposition-card",
            "期末 Disposition 构成",
            "筛选范围内期末库存按状态拆分",
            app_theme,
            disposition_body,
        ))
        .child(overview_card(
            "inventory-ledger-location-card",
            "Top 仓库分布",
            "筛选范围内期末库存最多的仓库",
            app_theme,
            location_body,
        ))
}

/// 总览卡外壳（标题 + 描述 + 内容区）
fn overview_card(
    id: &'static str,
    title: &str,
    description: &str,
    app_theme: &AppTheme,
    body: AnyElement,
) -> impl IntoElement {
    v_flex()
        .id(id)
        .w_full()
        .gap_2()
        .p_4()
        .rounded(px(app_theme.radius_lg))
        .bg(app_theme.card_bg)
        .shadow(vec![app_theme.card_shadow_box()])
        .child(
            div()
                .text_sm()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(app_theme.text_primary)
                .child(title.to_string()),
        )
        .child(
            div()
                .text_xs()
                .text_color(app_theme.text_muted)
                .child(description.to_string()),
        )
        .child(body)
}

/// 横向占比条列表（label + 数值 + 占比 + 比例条；对齐 web `HBarList`）
fn h_bar_list(items: &[(String, i64, f64)], app_theme: &AppTheme) -> impl IntoElement {
    let max = items.iter().map(|(_, v, _)| *v).max().unwrap_or(0).max(1) as f64;
    v_flex()
        .w_full()
        .gap_2p5()
        .children(items.iter().map(|(label, value, pct)| {
            let ratio = (*value as f64 / max * 100.0).max(0.0);
            let value_text = if *pct > 0.0 {
                format!("{} · {:.1}%", fmt_num_precise(*value), pct)
            } else {
                fmt_num_precise(*value)
            };
            v_flex()
                .w_full()
                .gap_1()
                .child(
                    h_flex()
                        .w_full()
                        .items_baseline()
                        .justify_between()
                        .child(
                            div()
                                .text_xs()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(app_theme.text_primary)
                                .child(label.clone()),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(app_theme.text_muted)
                                .child(value_text),
                        ),
                )
                .child(
                    div()
                        .w_full()
                        .h(px(6.))
                        .rounded_full()
                        .bg(app_theme.muted_fill)
                        .child(
                            div()
                                .h_full()
                                .rounded_full()
                                .bg(app_theme.accent.opacity(0.7))
                                .w(gpui::relative((ratio / 100.0) as f32)),
                        ),
                )
        }))
}

// ---------------------------------------------------------------------------
// 筛选栏（项目 / 月份 / SKU / 仓库 / 处置状态 / 事件类型 / 清除 / 刷新）
// ---------------------------------------------------------------------------

/// 筛选栏：项目 + 月份（触发 reload）+ 四维客户端筛选 + 清除筛选 + 刷新。
///
/// 菜单 builder 是 `Fn + 'static`（每次打开菜单重新执行）→ 选项必须转 owned
/// 才能被 move 捕获；选中项 label 在 builder 外算一次。
fn render_filter_bar(
    view: &Entity<InventoryLedgerView>,
    app_theme: &AppTheme,
    payload: &LedgerPayload,
    filters: &LedgerFilters,
) -> impl IntoElement {
    let projects_owned = payload.projects.clone();
    let selected_project_id = payload.project_id;
    let project_label: SharedString = payload
        .projects
        .iter()
        .find(|p| p.id == payload.project_id)
        .map_or_else(
            || SharedString::from("请选择项目"),
            |p| SharedString::from(p.name.clone()),
        );

    let months_owned = payload.months.clone();
    let selected_month = payload.month;
    let month_button_label: SharedString = payload.month.map_or_else(
        || SharedString::from("选择月份"),
        |m| SharedString::from(month_label(m)),
    );

    // 四维筛选选项（从原始行派生，对齐 web filterOptions）
    let options = filter_options(&payload.summary, &payload.detail);
    let msku_label = filter_current_label("全部 SKU", &filters.msku);
    let location_label = filter_current_label("全部仓库", &filters.location);
    let disposition_label_text = if filters.disposition == FILTER_ALL {
        SharedString::from("全部状态")
    } else {
        SharedString::from(disposition_label(&filters.disposition))
    };
    let event_label = if filters.event_type == FILTER_ALL {
        SharedString::from("全部事件类型")
    } else {
        SharedString::from(event_type_label(&filters.event_type))
    };

    let view_for_project = view.clone();
    let view_for_month = view.clone();
    let view_for_msku = view.clone();
    let view_for_location = view.clone();
    let view_for_disposition = view.clone();
    let view_for_event = view.clone();
    let view_for_clear = view.clone();
    let view_for_refresh = view.clone();

    let active_count = filters.active_count();

    filter_bar::filter_bar_layout(app_theme)
        .id("inventory-ledger-filters")
        .child(filter_bar::filter_select(
            app_theme,
            "项目",
            project_label,
            "inventory-ledger-project-filter",
            move |menu, _window, _cx| {
                let mut menu = menu;
                for project in &projects_owned {
                    let checked = selected_project_id == project.id;
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
            "月份",
            month_button_label,
            "inventory-ledger-month-filter",
            move |menu, _window, _cx| {
                let mut menu = menu;
                for month in &months_owned {
                    let checked = Some(*month) == selected_month;
                    let value = *month;
                    let label = month_label(value);
                    let view = view_for_month.clone();
                    menu = menu.item(
                        PopupMenuItem::new(label)
                            .checked(checked)
                            .on_click(move |_, _window, cx| {
                                view.update(cx, |this, cx| this.select_month(value, cx));
                            }),
                    );
                }
                menu
            },
        ))
        .child(filter_bar::filter_select(
            app_theme,
            "SKU",
            msku_label,
            "inventory-ledger-msku-filter",
            move |menu, _window, _cx| {
                let mut menu =
                    menu.item(all_item("全部 SKU", view_for_msku.clone(), FilterDim::Msku));
                for value in &options.mskus {
                    let value = value.clone();
                    let view = view_for_msku.clone();
                    menu = menu.item(
                        PopupMenuItem::new(value.clone()).on_click(move |_, _window, cx| {
                            let value = value.clone();
                            view.update(cx, |this, cx| this.set_filter(FilterDim::Msku, value, cx));
                        }),
                    );
                }
                menu
            },
        ))
        .child(filter_bar::filter_select(
            app_theme,
            "仓库",
            location_label,
            "inventory-ledger-location-filter",
            move |menu, _window, _cx| {
                let mut menu = menu.item(all_item(
                    "全部仓库",
                    view_for_location.clone(),
                    FilterDim::Location,
                ));
                for value in &options.locations {
                    let value = value.clone();
                    let view = view_for_location.clone();
                    menu = menu.item(
                        PopupMenuItem::new(value.clone()).on_click(move |_, _window, cx| {
                            let value = value.clone();
                            view.update(cx, |this, cx| {
                                this.set_filter(FilterDim::Location, value, cx)
                            });
                        }),
                    );
                }
                menu
            },
        ))
        .child(filter_bar::filter_select(
            app_theme,
            "状态",
            disposition_label_text,
            "inventory-ledger-disposition-filter",
            move |menu, _window, _cx| {
                let mut menu = menu.item(all_item(
                    "全部状态",
                    view_for_disposition.clone(),
                    FilterDim::Disposition,
                ));
                for value in &options.dispositions {
                    let value = value.clone();
                    let label = disposition_label(&value);
                    let view = view_for_disposition.clone();
                    menu = menu.item(
                        PopupMenuItem::new(label).on_click(move |_, _window, cx| {
                            let value = value.clone();
                            view.update(cx, |this, cx| {
                                this.set_filter(FilterDim::Disposition, value, cx)
                            });
                        }),
                    );
                }
                menu
            },
        ))
        .child(filter_bar::filter_select(
            app_theme,
            "事件类型",
            event_label,
            "inventory-ledger-event-filter",
            move |menu, _window, _cx| {
                let mut menu = menu.item(all_item(
                    "全部事件类型",
                    view_for_event.clone(),
                    FilterDim::EventType,
                ));
                for value in &options.event_types {
                    let value = value.clone();
                    let label = event_type_label(&value);
                    let view = view_for_event.clone();
                    menu = menu.item(
                        PopupMenuItem::new(label).on_click(move |_, _window, cx| {
                            let value = value.clone();
                            view.update(cx, |this, cx| {
                                this.set_filter(FilterDim::EventType, value, cx)
                            });
                        }),
                    );
                }
                menu
            },
        ))
        .when(active_count > 0, |bar| {
            bar.child(
                Button::new("inventory-ledger-clear-filters")
                    .outline()
                    .small()
                    .label(SharedString::from(format!("清除筛选（{active_count}）")))
                    .on_click(move |_, _window, cx| {
                        view_for_clear.update(cx, |this, cx| this.clear_filters(cx));
                    }),
            )
        })
        .child(div().flex_1())
        .child(
            Button::new("inventory-ledger-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_, _window, cx| {
                    view_for_refresh.update(cx, |this, cx| this.reload(cx));
                }),
        )
}

/// 四维筛选当前值按钮文案（`FILTER_ALL` → 占位文案；否则原值）
fn filter_current_label(all_text: &str, value: &str) -> SharedString {
    if value == FILTER_ALL {
        SharedString::from(all_text.to_string())
    } else {
        SharedString::from(value.to_string())
    }
}

/// 「全部 X」菜单项（点击 = 清除该维度筛选）
fn all_item(
    label: &'static str,
    view: Entity<InventoryLedgerView>,
    dim: FilterDim,
) -> PopupMenuItem {
    PopupMenuItem::new(label).on_click(move |_, _window, cx| {
        view.update(cx, |this, cx| {
            this.set_filter(dim, FILTER_ALL.to_string(), cx)
        });
    })
}

/// 四维筛选选项（从原始行派生，对齐 web `filterOptions`：SKU / 仓库取
/// summary.location + detail.fulfillment_center 并集，排序稳定）
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LedgerFilterOptions {
    pub mskus: Vec<String>,
    pub locations: Vec<String>,
    pub dispositions: Vec<String>,
    pub event_types: Vec<String>,
}

/// 从原始行派生筛选选项
pub fn filter_options(
    summary: &[LedgerSummaryRow],
    detail: &[LedgerDetailRow],
) -> LedgerFilterOptions {
    let mut mskus: BTreeSet<String> = BTreeSet::new();
    let mut locations: BTreeSet<String> = BTreeSet::new();
    let mut dispositions: BTreeSet<String> = BTreeSet::new();
    let mut event_types: BTreeSet<String> = BTreeSet::new();
    for r in summary {
        mskus.insert(r.msku.clone());
        locations.insert(r.location.clone());
        dispositions.insert(r.disposition.clone());
    }
    for r in detail {
        mskus.insert(r.msku.clone());
        locations.insert(r.fulfillment_center.clone());
        dispositions.insert(r.disposition.clone());
        event_types.insert(r.event_type.clone());
    }
    LedgerFilterOptions {
        mskus: mskus.into_iter().collect(),
        locations: locations.into_iter().collect(),
        dispositions: dispositions.into_iter().collect(),
        event_types: event_types.into_iter().collect(),
    }
}

// ---------------------------------------------------------------------------
// tab 栏
// ---------------------------------------------------------------------------

/// 顶部 tab 栏（对齐 frontend Tabs 的 3 项；gpui 无滑动指示器动画，
/// 用「选中强调底 + 文本色」区分，hover 反馈）
fn render_tab_bar(
    view: &Entity<InventoryLedgerView>,
    active: LedgerTab,
    theme: &AppTheme,
) -> impl IntoElement {
    h_flex()
        .id("inventory-ledger-tabs")
        .w_full()
        .p_1()
        .gap_1()
        .rounded(px(theme.radius_lg))
        .bg(theme.muted_fill)
        .children(LedgerTab::ALL.into_iter().map(|tab| {
            let view = view.clone();
            let selected = active == tab;
            div()
                .id(SharedString::from(format!(
                    "inventory-ledger-tab-{}",
                    tab.id()
                )))
                .flex_1()
                .py_1p5()
                .px_2()
                .text_center()
                .text_xs()
                .rounded(px(theme.radius))
                .cursor(CursorStyle::PointingHand)
                .when(selected, |this| {
                    this.bg(theme.card_bg)
                        .text_color(theme.accent)
                        .font_weight(FontWeight::MEDIUM)
                })
                .when(!selected, |this| {
                    this.text_color(theme.text_secondary).hover(|this| {
                        this.bg(theme.card_bg.opacity(0.5))
                            .text_color(theme.text_primary)
                    })
                })
                .child(tab.label().to_string())
                .on_mouse_up(gpui::MouseButton::Left, move |_, _window, cx| {
                    view.update(cx, |this, cx| this.select_tab(tab, cx));
                })
        }))
}

// ---------------------------------------------------------------------------
// 汇总视图 tab（水位线图 + 分页表）
// ---------------------------------------------------------------------------

/// 汇总视图 tab：每 SKU 期末水位线（前 6 SKU）+ 每日水位明细表（分页）
fn render_summary_tab(
    view: &Entity<InventoryLedgerView>,
    app_theme: &AppTheme,
    filtered_summary: &[LedgerSummaryRow],
    page: usize,
    table: Option<Entity<DataTable<LedgerSummaryRow>>>,
) -> impl IntoElement {
    let (mskus, data) = water_level_series(filtered_summary);
    let chart_msku_count = mskus.len().min(MAX_WATER_SKUS);

    let water_body = if data.is_empty() {
        chart_empty("暂无水位数据", 220.0, app_theme).into_any_element()
    } else {
        let palette = app_theme.chart_palette();
        let mut chart = AreaChart::new(data).x(|p: &WaterDatum| p.label.clone());
        for ix in 0..chart_msku_count {
            let color = palette[ix % palette.len()];
            chart = chart
                .y(move |p: &WaterDatum| p.values[ix])
                .stroke(color)
                .fill(color.opacity(0.0));
        }
        v_flex()
            .w_full()
            .gap_2()
            .child(chart_area(220.0, chart))
            .child(series_legend(&mskus, chart_msku_count, app_theme))
            .into_any_element()
    };

    let total = filtered_summary.len();
    let page_state = pagination::PageState::new(page, PAGE_SIZE, total);

    v_flex()
        .id("inventory-ledger-summary-tab")
        .w_full()
        .gap_4()
        .child(overview_card(
            "inventory-ledger-water-card",
            "每 SKU 期末水位",
            &format!(
                "按日期汇总各 MSKU 期末库存（跨仓库/状态）{}",
                if mskus.len() > MAX_WATER_SKUS {
                    format!(" · 仅显示前 {MAX_WATER_SKUS} 个 SKU")
                } else {
                    String::new()
                }
            ),
            app_theme,
            water_body,
        ))
        .child(
            v_flex()
                .id("inventory-ledger-summary-table-card")
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
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(app_theme.text_primary)
                                .child("每日水位明细"),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(app_theme.text_muted)
                                .child(format!(
                                    "{} 行 · 每行 = 1 个 MSKU × 仓库 × 状态 × 日期的水位快照",
                                    fmt_num_precise(total as i64)
                                )),
                        ),
                )
                .when_some(table, |this, table| this.child(table))
                .child(
                    div().w_full().px_4().py_2().child(pagination::pagination_bar(
                        view,
                        app_theme,
                        "inventory-ledger-summary-pagination",
                        &page_state,
                        &[PAGE_SIZE],
                        |this, page, cx| this.set_summary_page(page, cx),
                        |_, _, _| {},
                    )),
                ),
        )
}

/// 水位线图例（色点 + MSKU 名）
fn series_legend(mskus: &[String], count: usize, app_theme: &AppTheme) -> impl IntoElement {
    let palette = app_theme.chart_palette();
    h_flex()
        .w_full()
        .gap_3()
        .flex_wrap()
        .children(mskus.iter().take(count).enumerate().map(|(ix, msku)| {
            h_flex()
                .gap_1p5()
                .items_center()
                .child(
                    div()
                        .size_2p5()
                        .rounded_full()
                        .bg(palette[ix % palette.len()]),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(app_theme.text_secondary)
                        .child(msku.clone()),
                )
        }))
}

// ---------------------------------------------------------------------------
// 明细视图 tab（事件明细表 + 分页）
// ---------------------------------------------------------------------------

/// 明细视图 tab：事件明细表（分页）+ 头部净数量摘要
fn render_detail_tab(
    view: &Entity<InventoryLedgerView>,
    app_theme: &AppTheme,
    filtered_detail: &[LedgerDetailRow],
    page: usize,
    table: Option<Entity<DataTable<LedgerDetailRow>>>,
) -> impl IntoElement {
    let total = filtered_detail.len();
    let net_qty: i64 = filtered_detail.iter().map(|r| r.quantity).sum();
    let page_state = pagination::PageState::new(page, PAGE_SIZE, total);

    v_flex()
        .id("inventory-ledger-detail-tab")
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
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(app_theme.text_primary)
                        .child("事件明细"),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(app_theme.text_muted)
                        .child(format!(
                            "{} 条事件 · 净数量 {}",
                            fmt_num_precise(total as i64),
                            format_signed(net_qty)
                        )),
                ),
        )
        .when_some(table, |this, table| this.child(table))
        .child(
            div().w_full().px_4().py_2().child(pagination::pagination_bar(
                view,
                app_theme,
                "inventory-ledger-detail-pagination",
                &page_state,
                &[PAGE_SIZE],
                |this, page, cx| this.set_detail_page(page, cx),
                |_, _, _| {},
            )),
        )
}

// ---------------------------------------------------------------------------
// 上传批次 tab
// ---------------------------------------------------------------------------

/// 上传批次 tab：CSV 上传留档表（文件指纹 / 行数 / 状态 / 对账结果）
fn render_batches_tab(
    app_theme: &AppTheme,
    payload: &LedgerPayload,
    table: Option<Entity<DataTable<LedgerIngestBatchInfo>>>,
) -> impl IntoElement {
    v_flex()
        .id("inventory-ledger-batches-tab")
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
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(app_theme.text_primary)
                        .child("上传批次"),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(app_theme.text_muted)
                        .child("每次 CSV 上传留档：文件指纹 / 行数 / 状态 / 对账结果，用于排查数据版本"),
                ),
        )
        .when_some(table, |this, table| {
            let _ = payload; // 行已在 sync_table_rows 注入；payload 仅保留签名对称
            this.child(table)
        })
}

// ---------------------------------------------------------------------------
// 表格列定义
// ---------------------------------------------------------------------------

/// 数值单元格强调色（正数 success / 负数 danger / 零默认，对齐 web `num()`）
fn num_cell(value: i64, theme: &AppTheme) -> AnyElement {
    let color = if value > 0 {
        theme.success
    } else if value < 0 {
        theme.danger
    } else {
        theme.text_secondary
    };
    div()
        .text_right()
        .text_color(color)
        .child(fmt_num_precise(value))
        .into_any_element()
}

/// Disposition pill（SELLABLE → success；其余 → warning，对齐 web DispositionBadge）
fn disposition_pill(disposition: &str, theme: &AppTheme) -> AnyElement {
    let color = if disposition == "SELLABLE" {
        theme.success
    } else {
        theme.warning
    };
    h_flex()
        .items_center()
        .rounded_full()
        .border_1()
        .border_color(color.opacity(0.35))
        .bg(color.opacity(0.10))
        .px_2()
        .py_0p5()
        .child(
            div()
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .text_color(color)
                .child(disposition_label(disposition)),
        )
        .into_any_element()
}

/// 汇总表列定义（12 主列，对齐 web PRIMARY_COLUMNS；次级列差异见模块头）
pub fn summary_columns() -> Vec<ColumnDef<LedgerSummaryRow>> {
    vec![
        ColumnDef::text("ledger-date", "日期", |r: &LedgerSummaryRow, _| {
            SharedString::from(r.date.to_string())
        })
        .width(96.0),
        ColumnDef::text("ledger-msku", "MSKU", |r: &LedgerSummaryRow, _| {
            SharedString::from(r.msku.clone())
        })
        .width(120.0),
        ColumnDef::text("ledger-title", "品名", |r: &LedgerSummaryRow, _| {
            SharedString::from(r.title.clone().unwrap_or_else(|| "--".to_string()))
        }),
        ColumnDef::text("ledger-location", "仓库", |r: &LedgerSummaryRow, _| {
            SharedString::from(r.location.clone())
        })
        .width(80.0),
        ColumnDef::text("ledger-disposition", "处置状态", |_: &LedgerSummaryRow, _| {
            SharedString::from("")
        })
        .width(96.0)
        .with_render_element(|r: &LedgerSummaryRow, theme: &AppTheme| {
            disposition_pill(&r.disposition, theme)
        }),
        ColumnDef::number(
            "ledger-starting",
            "期初库存",
            |r: &LedgerSummaryRow| r.starting_balance as f64,
            |r: &LedgerSummaryRow, _| fmt_num_precise(r.starting_balance).into(),
        )
        .width(84.0),
        ColumnDef::number(
            "ledger-receipts",
            "入库",
            |r: &LedgerSummaryRow| r.receipts as f64,
            |_: &LedgerSummaryRow, _| SharedString::from(""),
        )
        .width(72.0)
        .with_render_element(|r: &LedgerSummaryRow, theme: &AppTheme| num_cell(r.receipts, theme)),
        ColumnDef::number(
            "ledger-shipments",
            "客户发货",
            |r: &LedgerSummaryRow| r.customer_shipments as f64,
            |_: &LedgerSummaryRow, _| SharedString::from(""),
        )
        .width(84.0)
        .with_render_element(|r: &LedgerSummaryRow, theme: &AppTheme| {
            num_cell(r.customer_shipments, theme)
        }),
        ColumnDef::number(
            "ledger-returns",
            "客户退货",
            |r: &LedgerSummaryRow| r.customer_returns as f64,
            |_: &LedgerSummaryRow, _| SharedString::from(""),
        )
        .width(84.0)
        .with_render_element(|r: &LedgerSummaryRow, theme: &AppTheme| {
            num_cell(r.customer_returns, theme)
        }),
        ColumnDef::number(
            "ledger-damaged",
            "损坏",
            |r: &LedgerSummaryRow| r.damaged as f64,
            |_: &LedgerSummaryRow, _| SharedString::from(""),
        )
        .width(72.0)
        .with_render_element(|r: &LedgerSummaryRow, theme: &AppTheme| num_cell(r.damaged, theme)),
        ColumnDef::number(
            "ledger-ending",
            "期末库存",
            |r: &LedgerSummaryRow| r.ending_balance as f64,
            |r: &LedgerSummaryRow, _| fmt_num_precise(r.ending_balance).into(),
        )
        .width(88.0),
        ColumnDef::text("ledger-store", "店铺", |r: &LedgerSummaryRow, _| {
            SharedString::from(r.store.clone().unwrap_or_else(|| "--".to_string()))
        })
        .width(96.0),
    ]
}

/// 明细表列定义（8 列，对齐 web DETAIL_HEADERS）
pub fn detail_columns() -> Vec<ColumnDef<LedgerDetailRow>> {
    vec![
        ColumnDef::text("ledger-detail-date", "日期", |r: &LedgerDetailRow, _| {
            SharedString::from(r.date.to_string())
        })
        .width(96.0),
        ColumnDef::text("ledger-detail-msku", "MSKU", |r: &LedgerDetailRow, _| {
            SharedString::from(r.msku.clone())
        })
        .width(120.0),
        ColumnDef::text("ledger-detail-event", "事件类型", |r: &LedgerDetailRow, _| {
            SharedString::from(event_type_label(&r.event_type))
        })
        .width(96.0),
        ColumnDef::number(
            "ledger-detail-qty",
            "数量",
            |r: &LedgerDetailRow| r.quantity as f64,
            |_: &LedgerDetailRow, _| SharedString::from(""),
        )
        .width(80.0)
        .with_render_element(|r: &LedgerDetailRow, theme: &AppTheme| {
            let color = if r.quantity > 0 {
                theme.success
            } else if r.quantity < 0 {
                theme.danger
            } else {
                theme.text_secondary
            };
            div()
                .text_right()
                .text_color(color)
                .child(format_signed(r.quantity))
                .into_any_element()
        }),
        ColumnDef::text(
            "ledger-detail-fc",
            "履约中心",
            |r: &LedgerDetailRow, _| SharedString::from(r.fulfillment_center.clone()),
        )
        .width(88.0),
        ColumnDef::text(
            "ledger-detail-disposition",
            "处置状态",
            |_: &LedgerDetailRow, _| SharedString::from(""),
        )
        .width(96.0)
        .with_render_element(|r: &LedgerDetailRow, theme: &AppTheme| {
            disposition_pill(&r.disposition, theme)
        }),
        ColumnDef::text(
            "ledger-detail-ref",
            "参考编号",
            |r: &LedgerDetailRow, _| {
                SharedString::from(r.reference_id.clone().unwrap_or_else(|| "--".to_string()))
            },
        ),
        ColumnDef::text(
            "ledger-detail-batch",
            "上传批次 ID",
            |r: &LedgerDetailRow, _| {
                SharedString::from(
                    r.batch_id
                        .map(|b| b.to_string())
                        .unwrap_or_else(|| "--".to_string()),
                )
            },
        )
        .width(96.0)
        .align(CellAlign::Right),
    ]
}

/// 批次状态 pill 文案 + 色（对齐 web BATCH_STATUS_LABELS）
fn batch_status_pill(status: &str, theme: &AppTheme) -> AnyElement {
    let (label, color) = match status {
        "success" => ("成功", theme.success),
        "failed" => ("失败", theme.danger),
        "running" => ("处理中", theme.accent),
        "pending" => ("等待中", theme.warning),
        "partial" => ("部分成功", theme.warning),
        _ => (status, theme.text_muted),
    };
    h_flex()
        .items_center()
        .rounded_full()
        .border_1()
        .border_color(color.opacity(0.35))
        .bg(color.opacity(0.10))
        .px_2()
        .py_0p5()
        .child(
            div()
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .text_color(color)
                .child(label.to_string()),
        )
        .into_any_element()
}

/// 对账结果 pill（ok → 绿 / mismatch → 红 + 数量 / 其余弱化）
fn batch_consistency_pill(batch: &LedgerIngestBatchInfo, theme: &AppTheme) -> AnyElement {
    match batch.consistency_check.as_deref() {
        Some("ok") => badge_pill("OK".to_string(), theme.success),
        Some("mismatch") => badge_pill(
            format!("异常（{}）", batch.consistency_mismatch_count),
            theme.danger,
        ),
        Some(other) => div()
            .text_xs()
            .text_color(theme.text_muted)
            .child(other.to_string())
            .into_any_element(),
        None => div()
            .text_xs()
            .text_color(theme.text_muted)
            .child("--")
            .into_any_element(),
    }
}

/// 上传批次表列定义（10 列，对齐 web LedgerBatchesTab 表头）
pub fn batch_columns() -> Vec<ColumnDef<LedgerIngestBatchInfo>> {
    vec![
        ColumnDef::number(
            "ledger-batch-id",
            "批次 ID",
            |r: &LedgerIngestBatchInfo| r.id as f64,
            |r: &LedgerIngestBatchInfo, _| r.id.to_string().into(),
        )
        .width(72.0),
        ColumnDef::text("ledger-batch-month", "报表月", |r: &LedgerIngestBatchInfo, _| {
            SharedString::from(month_label(r.report_month))
        })
        .width(84.0),
        ColumnDef::text("ledger-batch-kind", "类型", |r: &LedgerIngestBatchInfo, _| {
            SharedString::from(match r.file_kind.as_str() {
                "summary" => "汇总".to_string(),
                "detail" => "明细".to_string(),
                other => other.to_string(),
            })
        })
        .width(64.0),
        ColumnDef::text(
            "ledger-batch-file",
            "文件名",
            |r: &LedgerIngestBatchInfo, _| SharedString::from(r.source_filename.clone()),
        ),
        ColumnDef::number(
            "ledger-batch-parsed",
            "解析行",
            |r: &LedgerIngestBatchInfo| r.rows_parsed as f64,
            |r: &LedgerIngestBatchInfo, _| fmt_num_precise(r.rows_parsed).into(),
        )
        .width(76.0),
        ColumnDef::number(
            "ledger-batch-summary-rows",
            "汇总行",
            |r: &LedgerIngestBatchInfo| r.rows_written_summary as f64,
            |r: &LedgerIngestBatchInfo, _| fmt_num_precise(r.rows_written_summary).into(),
        )
        .width(76.0),
        ColumnDef::number(
            "ledger-batch-detail-rows",
            "明细行",
            |r: &LedgerIngestBatchInfo| r.rows_written_detail as f64,
            |r: &LedgerIngestBatchInfo, _| fmt_num_precise(r.rows_written_detail).into(),
        )
        .width(76.0),
        ColumnDef::text("ledger-batch-status", "状态", |_: &LedgerIngestBatchInfo, _| {
            SharedString::from("")
        })
        .width(88.0)
        .with_render_element(|r: &LedgerIngestBatchInfo, theme: &AppTheme| {
            batch_status_pill(&r.status, theme)
        }),
        ColumnDef::text("ledger-batch-consistency", "对账", |_: &LedgerIngestBatchInfo, _| {
            SharedString::from("")
        })
        .width(96.0)
        .with_render_element(|r: &LedgerIngestBatchInfo, theme: &AppTheme| {
            batch_consistency_pill(r, theme)
        }),
        ColumnDef::text("ledger-batch-loaded-at", "上传时间", |r: &LedgerIngestBatchInfo, _| {
            SharedString::from(fmt_datetime(&r.loaded_at))
        })
        .width(130.0),
    ]
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use gui_domain::operations::inventory_ledger::{
        LedgerConsistencyResult, LedgerIntegrityCheck, LedgerSkuMonthEom,
        LedgerSnapshotResponse, LedgerTrendMonthItem, LedgerTrendResponse,
    };

    // ---------- 测试数据 ----------

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).expect("合法日期")
    }

    fn project(id: i64, name: &str) -> ManagedProject {
        ManagedProject {
            id,
            name: name.into(),
            brand_name: None,
            store_address: None,
            project_operator: None,
            assistant_operator: None,
            commission_basis: None,
            commission_rate: None,
            sort_order: id,
            is_active: true,
            source_file: None,
            has_context: false,
            project_tier: None,
            vat_enabled: false,
        }
    }

    fn sample_projects() -> Vec<ManagedProject> {
        vec![project(1, "测试项目 A"), project(2, "测试项目 B")]
    }

    /// Summary 行：SKU-A 在 US-EAST 两天（SELLABLE），SKU-B 一天（DAMAGED）。
    /// 按 API 契约 date desc 排序（`latest_ending_by_group` 取首次出现 = 最新水位）
    fn sample_summary_rows() -> Vec<LedgerSummaryRow> {
        vec![
            LedgerSummaryRow {
                id: 2,
                date: date(2026, 7, 2),
                fnsku: None,
                asin: None,
                msku: "SKU-A".into(),
                title: Some("产品甲".into()),
                disposition: "SELLABLE".into(),
                location: "US-EAST".into(),
                starting_balance: 100,
                in_transit_between: 0,
                receipts: 0,
                customer_shipments: -20,
                customer_returns: 5,
                vendor_returns: 0,
                warehouse_transfer_io: 0,
                found: 0,
                lost: 0,
                damaged: 0,
                disposed: 0,
                other_events: 0,
                ending_balance: 85,
                unknown_events: 0,
                store: Some("店铺甲".into()),
                batch_id: Some(1),
            },
            LedgerSummaryRow {
                id: 3,
                date: date(2026, 7, 2),
                fnsku: None,
                asin: None,
                msku: "SKU-B".into(),
                title: None,
                disposition: "DAMAGED".into(),
                location: "US-WEST".into(),
                starting_balance: 10,
                in_transit_between: 0,
                receipts: 0,
                customer_shipments: 0,
                customer_returns: 0,
                vendor_returns: 0,
                warehouse_transfer_io: 0,
                found: 0,
                lost: 0,
                damaged: 5,
                disposed: 0,
                other_events: 0,
                ending_balance: 15,
                unknown_events: 0,
                store: None,
                batch_id: Some(2),
            },
            LedgerSummaryRow {
                id: 1,
                date: date(2026, 7, 1),
                fnsku: None,
                asin: None,
                msku: "SKU-A".into(),
                title: Some("产品甲".into()),
                disposition: "SELLABLE".into(),
                location: "US-EAST".into(),
                starting_balance: 90,
                in_transit_between: 0,
                receipts: 20,
                customer_shipments: -10,
                customer_returns: 0,
                vendor_returns: 0,
                warehouse_transfer_io: 0,
                found: 0,
                lost: 0,
                damaged: 0,
                disposed: 0,
                other_events: 0,
                ending_balance: 100,
                unknown_events: 0,
                store: Some("店铺甲".into()),
                batch_id: Some(1),
            },
        ]
    }

    /// Detail 行：3 条事件（收货 +20 / 发货 -10 / 损坏 -5）
    fn sample_detail_rows() -> Vec<LedgerDetailRow> {
        vec![
            LedgerDetailRow {
                id: 1,
                date: date(2026, 7, 1),
                fnsku: None,
                asin: None,
                msku: "SKU-A".into(),
                title: None,
                event_type: "RECEIPTS".into(),
                reference_id: Some("PO-1".into()),
                quantity: 20,
                fulfillment_center: "US-EAST".into(),
                disposition: "SELLABLE".into(),
                reason: None,
                country: None,
                reconciled_quantity: None,
                unreconciled_quantity: None,
                date_and_time: None,
                store: None,
                batch_id: Some(1),
            },
            LedgerDetailRow {
                id: 2,
                date: date(2026, 7, 1),
                fnsku: None,
                asin: None,
                msku: "SKU-A".into(),
                title: None,
                event_type: "CUSTOMER_SHIPMENTS".into(),
                reference_id: None,
                quantity: -10,
                fulfillment_center: "US-EAST".into(),
                disposition: "SELLABLE".into(),
                reason: None,
                country: None,
                reconciled_quantity: None,
                unreconciled_quantity: None,
                date_and_time: None,
                store: None,
                batch_id: Some(1),
            },
            LedgerDetailRow {
                id: 3,
                date: date(2026, 7, 2),
                fnsku: None,
                asin: None,
                msku: "SKU-B".into(),
                title: None,
                event_type: "DAMAGED".into(),
                reference_id: None,
                quantity: -5,
                fulfillment_center: "US-WEST".into(),
                disposition: "DAMAGED".into(),
                reason: None,
                country: None,
                reconciled_quantity: None,
                unreconciled_quantity: None,
                date_and_time: None,
                store: None,
                batch_id: Some(2),
            },
        ]
    }

    fn sample_batches() -> Vec<LedgerIngestBatchInfo> {
        vec![LedgerIngestBatchInfo {
            id: 1,
            project_id: 1,
            report_month: date(2026, 7, 1),
            source_filename: "ledger-2026-07.csv".into(),
            file_hash: "abc123".into(),
            file_size_bytes: 1024,
            file_kind: "summary".into(),
            loaded_by: None,
            loaded_at: "2026-07-05T10:30:00".into(),
            completed_at: None,
            status: "success".into(),
            rows_parsed: 3,
            rows_written_summary: 3,
            rows_written_detail: 0,
            rows_skipped_duplicate: 0,
            rows_failed_validation: 0,
            error_message: None,
            consistency_check: Some("ok".into()),
            consistency_mismatch_count: 0,
        }]
    }

    fn sample_snapshot() -> LedgerSnapshotResponse {
        LedgerSnapshotResponse {
            report_month: date(2026, 7, 1),
            sku_count: 2,
            total_qty: 100,
            disposition_summary: Vec::new(),
            skus: vec![
                LedgerSkuMonthEom {
                    msku: "SKU-A".into(),
                    title: None,
                    qty_eom: 85,
                    sellable_qty: 85,
                    damaged_qty: 0,
                    prev_qty_eom: Some(80),
                    change: Some(5),
                },
                LedgerSkuMonthEom {
                    msku: "SKU-B".into(),
                    title: None,
                    qty_eom: 15,
                    sellable_qty: 0,
                    damaged_qty: 15,
                    prev_qty_eom: None,
                    change: None,
                },
            ],
            integrity: Some(LedgerIntegrityCheck {
                report_month: date(2026, 7, 1),
                status: "OK".into(),
                mismatch_count: 0,
                mismatches: Vec::new(),
                checked_at: "2026-07-05T10:30:00".into(),
            }),
        }
    }

    fn sample_trend() -> LedgerTrendResponse {
        LedgerTrendResponse {
            project_id: 1,
            months: vec![
                LedgerTrendMonthItem {
                    report_month: "2026-06".into(),
                    sku_count: 2,
                    total_qty_eom: 80,
                    total_receipts: 30,
                    total_shipments: -20,
                    total_returns: 5,
                    total_damaged: 0,
                    total_lost: 0,
                    total_disposed: 0,
                    damaged_pct: 0.0,
                },
                LedgerTrendMonthItem {
                    report_month: "2026-07".into(),
                    sku_count: 2,
                    total_qty_eom: 100,
                    total_receipts: 20,
                    total_shipments: -30,
                    total_returns: 5,
                    total_damaged: 5,
                    total_lost: 0,
                    total_disposed: 0,
                    damaged_pct: 15.0,
                },
            ],
        }
    }

    fn sample_payload() -> LedgerPayload {
        LedgerPayload {
            projects: sample_projects(),
            project_id: 1,
            months: vec![date(2026, 7, 1), date(2026, 6, 1)],
            month: Some(date(2026, 7, 1)),
            snapshot: Some(sample_snapshot()),
            trend: Some(sample_trend()),
            summary: sample_summary_rows(),
            detail: sample_detail_rows(),
            batches: sample_batches(),
            consistency: Some(LedgerConsistencyResult {
                report_month: date(2026, 7, 1),
                status: "OK".into(),
                mismatch_count: 0,
                mismatches: Vec::new(),
                checked_at: "2026-07-05T10:30:00".into(),
            }),
            partial_error: None,
        }
    }

    // ---------- 纯函数契约 ----------

    /// 月份展示（对齐 web `monthLabel`：`2026-07-01` → `2026-07`）
    #[test]
    fn month_label_matches_frontend() {
        assert_eq!(month_label(date(2026, 7, 1)), "2026-07");
        assert_eq!(month_label(date(2025, 12, 1)), "2025-12");
    }

    /// 自动选项目：未选 → 第一个；显式有效 → 保持；失效 → 回退第一个；空 → None
    #[test]
    fn resolve_project_id_falls_back_to_first() {
        let projects = sample_projects();
        assert_eq!(resolve_project_id(None, &projects), Some(1));
        assert_eq!(resolve_project_id(Some(2), &projects), Some(2));
        assert_eq!(resolve_project_id(Some(99), &projects), Some(1));
        assert_eq!(resolve_project_id(None, &[]), None);
    }

    /// 状态转移：项目空 → Empty；有数据 → Loaded；错误 → Error
    #[test]
    fn state_transitions_from_fetch_result() {
        let mut no_projects = sample_payload();
        no_projects.projects = Vec::new();
        assert_eq!(
            LedgerState::from_fetch_result(Ok(no_projects)),
            LedgerState::Empty
        );
        assert_eq!(
            LedgerState::from_fetch_result(Ok(sample_payload())),
            LedgerState::Loaded(Box::new(sample_payload()))
        );
        assert_eq!(
            LedgerState::from_fetch_result(Err("boom".into())),
            LedgerState::Error("boom".into())
        );
    }

    /// 四维筛选匹配（对齐 web `ledger-derive.ts` 过滤口径）
    #[test]
    fn filters_match_rows() {
        let rows = sample_summary_rows();
        let all = LedgerFilters::all();
        assert_eq!(filter_summary_rows(&rows, &all).len(), 3);

        let mut f = LedgerFilters::all();
        f.msku = "SKU-A".into();
        assert_eq!(filter_summary_rows(&rows, &f).len(), 2);

        f = LedgerFilters::all();
        f.disposition = "DAMAGED".into();
        assert_eq!(filter_summary_rows(&rows, &f).len(), 1);

        f = LedgerFilters::all();
        f.location = "US-WEST".into();
        assert_eq!(filter_summary_rows(&rows, &f).len(), 1);

        // detail 行：event_type 维度仅对 detail 生效
        let detail = sample_detail_rows();
        f = LedgerFilters::all();
        f.event_type = "RECEIPTS".into();
        assert_eq!(filter_detail_rows(&detail, &f).len(), 1);
        f = LedgerFilters::all();
        f.msku = "SKU-B".into();
        assert_eq!(filter_detail_rows(&detail, &f).len(), 1);
    }

    /// 筛选选项派生（SKU / 仓库取 summary + detail 并集，排序稳定）
    #[test]
    fn filter_options_union_and_sorted() {
        let options = filter_options(&sample_summary_rows(), &sample_detail_rows());
        assert_eq!(options.mskus, vec!["SKU-A", "SKU-B"]);
        assert_eq!(options.locations, vec!["US-EAST", "US-WEST"]);
        assert_eq!(options.dispositions, vec!["DAMAGED", "SELLABLE"]);
        assert_eq!(options.event_types, vec!["CUSTOMER_SHIPMENTS", "DAMAGED", "RECEIPTS"]);
    }

    /// KPI 派生（期末总库存 = 每组合末日 ending 求和；损坏占比；事件净变动）
    #[test]
    fn compute_kpis_matches_web_semantics() {
        let kpis = compute_kpis(&sample_summary_rows(), &sample_detail_rows());
        // SKU-A@US-EAST@SELLABLE 末日(7-2) ending=85；SKU-B@US-WEST@DAMAGED 末日(7-2) ending=15
        assert_eq!(kpis.ending_total, 100);
        assert_eq!(kpis.damaged_qty, 15);
        assert!((kpis.damaged_pct - 15.0).abs() < 1e-9);
        assert_eq!(kpis.net_change, 5); // 20 - 10 - 5
        assert_eq!(kpis.event_count, 3);

        // 空行 → 全零
        let empty = compute_kpis(&[], &[]);
        assert_eq!(empty.ending_total, 0);
        assert_eq!(empty.damaged_pct, 0.0);
    }

    /// 环比变动（SKU 筛选口径；全部无上月数据 → None）
    #[test]
    fn compute_mom_change_scoping() {
        let skus = sample_snapshot().skus;
        assert_eq!(compute_mom_change(&skus, FILTER_ALL), Some(5));
        assert_eq!(compute_mom_change(&skus, "SKU-A"), Some(5));
        assert_eq!(compute_mom_change(&skus, "SKU-B"), None); // 无上月数据
        assert_eq!(compute_mom_change(&[], FILTER_ALL), None);
    }

    /// 事件类型分组（count 降序）
    #[test]
    fn group_detail_by_event_type_desc() {
        let groups = group_detail_by_event_type(&sample_detail_rows());
        assert_eq!(groups.len(), 3);
        assert!(groups.windows(2).all(|w| w[0].count >= w[1].count));
        assert_eq!(groups.iter().map(|g| g.count).sum::<i64>(), 3);
    }

    /// Disposition 构成（qty 降序 + 占比）
    #[test]
    fn disposition_breakdown_pct() {
        let slices = disposition_breakdown(&sample_summary_rows());
        assert_eq!(slices.len(), 2);
        assert_eq!(slices[0].disposition, "SELLABLE");
        assert_eq!(slices[0].qty, 85);
        assert!((slices[0].pct - 85.0).abs() < 1e-9);
        assert_eq!(slices[1].disposition, "DAMAGED");
        assert!((slices[1].pct - 15.0).abs() < 1e-9);
    }

    /// Top 仓库分布（qty 降序 + 截断）
    #[test]
    fn top_locations_sorted_and_truncated() {
        let slices = top_locations(&sample_summary_rows(), 5);
        assert_eq!(slices.len(), 2);
        assert_eq!(slices[0].location, "US-EAST");
        assert_eq!(slices[0].qty, 85);
        assert_eq!(top_locations(&sample_summary_rows(), 1).len(), 1);
    }

    /// 每 SKU 水位线（跨 location/disposition 求和；缺失日期前向填充；日期升序）
    #[test]
    fn water_level_series_forward_fills() {
        let (mskus, data) = water_level_series(&sample_summary_rows());
        assert_eq!(mskus, vec!["SKU-A", "SKU-B"]);
        assert_eq!(data.len(), 2); // 7-1 / 7-2
        assert_eq!(data[0].label, "07-01");
        // 7-1：SKU-A=100，SKU-B 无数据 → 前向填充起点 0
        assert_eq!(data[0].values, vec![100.0, 0.0]);
        // 7-2：SKU-A=85，SKU-B=15
        assert_eq!(data[1].values, vec![85.0, 15.0]);
    }

    /// 客户端分页切片（1-based；越界收敛末页）
    #[test]
    fn page_slice_bounds() {
        let rows: Vec<i32> = (0..120).collect();
        assert_eq!(page_slice(&rows, 1).len(), PAGE_SIZE);
        assert_eq!(page_slice(&rows, 2).len(), PAGE_SIZE);
        assert_eq!(page_slice(&rows, 3).len(), 20);
        // 越界 → 收敛末页
        assert_eq!(page_slice(&rows, 99), page_slice(&rows, 3));
        assert_eq!(page_slice::<i32>(&[], 1).len(), 0);
    }

    /// 列定义契约：汇总 12 列 / 明细 8 列 / 批次 10 列；id 唯一
    #[test]
    fn column_definitions_are_stable() {
        let summary = summary_columns();
        assert_eq!(summary.len(), 12);
        let detail = detail_columns();
        assert_eq!(detail.len(), 8);
        let batches = batch_columns();
        assert_eq!(batches.len(), 10);
        for cols in [
            summary.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            detail.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            batches.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ] {
            let mut uniq = cols.clone();
            uniq.sort();
            uniq.dedup();
            assert_eq!(cols.len(), uniq.len(), "列 id 必须唯一（gpui element id）");
        }
    }

    /// 有数据判定（summary / detail / snapshot 任一非空）
    #[test]
    fn has_any_data_semantics() {
        let mut payload = sample_payload();
        assert!(payload.has_any_data());
        payload.summary = Vec::new();
        payload.detail = Vec::new();
        assert!(payload.has_any_data()); // snapshot 仍在
        payload.snapshot = None;
        assert!(!payload.has_any_data());
    }

    // ---------- 渲染冒烟 ----------

    /// 渲染冒烟：亮色主题（client 指向 127.0.0.1:1，首屏拉取快速失败 → 错误态）
    #[gpui::test]
    async fn view_renders_loading_then_error_in_light_mode(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let (_view, _cx) = cx.add_window_view(|_window, cx| {
            let mut view = InventoryLedgerView::new(cx, Client::new("http://127.0.0.1:1"));
            view.reload(cx);
            view
        });
    }

    /// 渲染冒烟：深色主题 + Loaded 态（注入载荷 + 表格，覆盖筛选栏 / KPI /
    /// 总览图表 / 三 tab / 分页）
    #[gpui::test]
    async fn view_renders_loaded_in_dark_mode(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            InventoryLedgerView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let payload = sample_payload();
            this.state.update(cx, |state, _| {
                *state = LedgerState::Loaded(Box::new(payload));
            });
            this.sync_table_rows(cx);
        });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    /// 渲染冒烟：减弱动态偏好下 Loaded 态可渲染（无动画路径）
    #[gpui::test]
    async fn view_renders_loaded_with_reduce_motion(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            cx.set_global(crate::motion::MotionPref(true));
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            InventoryLedgerView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let payload = sample_payload();
            this.state.update(cx, |state, _| {
                *state = LedgerState::Loaded(Box::new(payload));
            });
            this.sync_table_rows(cx);
        });
    }

    /// 渲染冒烟：空态（无项目 → 「暂无可用项目」+ 刷新按钮）可渲染
    #[gpui::test]
    async fn view_renders_empty_state(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            InventoryLedgerView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = LedgerState::Empty;
            });
        });
    }

    /// 渲染冒烟：有项目但该月无数据 → Loaded 内「暂无库存分类账数据」提示卡路径
    #[gpui::test]
    async fn view_renders_loaded_with_no_month_data(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            InventoryLedgerView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let mut payload = sample_payload();
            payload.summary = Vec::new();
            payload.detail = Vec::new();
            payload.snapshot = None;
            payload.trend = None;
            payload.month = None;
            this.state.update(cx, |state, _| {
                *state = LedgerState::Loaded(Box::new(payload));
            });
            this.sync_table_rows(cx);
        });
    }

    /// 渲染冒烟：部分端点失败 → 错误横幅路径可渲染
    #[gpui::test]
    async fn view_renders_partial_error_banner(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            InventoryLedgerView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let mut payload = sample_payload();
            payload.partial_error = Some("趋势端点失败：connection refused".into());
            this.state.update(cx, |state, _| {
                *state = LedgerState::Loaded(Box::new(payload));
            });
            this.sync_table_rows(cx);
        });
    }

    // ---------- 交互行为 ----------

    /// 筛选 → 表格行注入过滤 + 分页回第一页；清除筛选 → 恢复全量
    #[gpui::test]
    async fn set_filter_filters_table_rows(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            InventoryLedgerView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let payload = sample_payload();
            this.state.update(cx, |state, _| {
                *state = LedgerState::Loaded(Box::new(payload));
            });
            this.sync_table_rows(cx);
        });
        // 初始：3 行 summary
        view.read_with(cx2, |this, cx| {
            let table = this.summary_table.as_ref().expect("表格已懒建");
            assert_eq!(table.read(cx).rows().len(), 3);
        });
        // 筛选 SKU-A → 2 行
        view.update(cx2, |this, cx| {
            this.set_filter(FilterDim::Msku, "SKU-A".into(), cx);
        });
        view.read_with(cx2, |this, cx| {
            assert_eq!(this.filters.msku, "SKU-A");
            assert_eq!(this.summary_page, 1);
            let table = this.summary_table.as_ref().expect("表格已懒建");
            assert_eq!(table.read(cx).rows().len(), 2);
        });
        // 清除筛选 → 3 行
        view.update(cx2, |this, cx| {
            this.clear_filters(cx);
        });
        view.read_with(cx2, |this, cx| {
            assert_eq!(this.filters, LedgerFilters::all());
            let table = this.summary_table.as_ref().expect("表格已懒建");
            assert_eq!(table.read(cx).rows().len(), 3);
        });
    }

    /// tab 切换（同一 tab no-op；切换后 active_tab 落点）
    #[gpui::test]
    async fn select_tab_switches(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            InventoryLedgerView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            assert_eq!(this.active_tab, LedgerTab::Summary);
            this.select_tab(LedgerTab::Batches, cx);
            assert_eq!(this.active_tab, LedgerTab::Batches);
            this.select_tab(LedgerTab::Detail, cx);
            assert_eq!(this.active_tab, LedgerTab::Detail);
        });
    }

    /// 翻页 → 表格切片变化（120 行 → 第 3 页 20 行）
    #[gpui::test]
    async fn paging_slices_table_rows(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            InventoryLedgerView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let mut payload = sample_payload();
            // 造 120 行 summary（同 SKU/仓库/状态不同日期，避免水位聚合干扰）
            payload.summary = (0..120)
                .map(|i| {
                    let mut row = sample_summary_rows()[0].clone();
                    row.id = i as i64 + 100;
                    row.date = date(2026, 7, 1) + chrono::Duration::days(i as i64);
                    row
                })
                .collect();
            this.state.update(cx, |state, _| {
                *state = LedgerState::Loaded(Box::new(payload));
            });
            this.sync_table_rows(cx);
        });
        view.read_with(cx2, |this, cx| {
            let table = this.summary_table.as_ref().expect("表格已懒建");
            assert_eq!(table.read(cx).rows().len(), PAGE_SIZE);
        });
        view.update(cx2, |this, cx| {
            this.set_summary_page(3, cx);
        });
        view.read_with(cx2, |this, cx| {
            assert_eq!(this.summary_page, 3);
            let table = this.summary_table.as_ref().expect("表格已懒建");
            assert_eq!(table.read(cx).rows().len(), 20);
        });
    }
}
