//! 运营 → 库存分析视图（P5-2，BLF-719）
//!
//! frontend `app/dashboard/operations/inventory-analysis/page.tsx` 的 GPUI 等价：
//! 项目 × 国家 × 业务日期筛选 + 4 张库存统计卡（SKU 总数 / 可售库存总量 /
//! 缺货 SKU / 365+ 库龄库存）+ 库存明细表（库龄分桶 + 建议操作 + 状态 pill +
//! 在途 shipment 动态列）+ 合计条。
//!
//! 架构（复用 Phase 3/4/5 基建）：
//! - **四态状态机**：`Loading / Loaded / Empty / Error`（沿用 dashboard.rs /
//!   daily_analysis.rs 模式），`latest_request_id` 竞态保护——只有最新请求的
//!   响应才会落点；
//! - **数据管线**：`list_managed_projects`（`GET /projects/manage`，按 X-Operator
//!   过滤可见项目）→ `resolve_project_id` 自动选中第一个项目（web
//!   `useAutoSelectFirstProject` 语义）→ `tokio::join!` 并行拉取
//!   `inventory_analysis`（`GET /api/v1/inventory-analysis`）与
//!   `inventory_snapshot_options`（`GET /api/v1/inventory-snapshot-options`）；
//! - **表格**（BLF-802 Stage11 套版）：Pattern A 虚拟化大表 [`DataGrid`]——
//!   固定 12 列（SKU/ASIN/品名/6 库龄分桶/建议操作/库存状态/库龄状态）+
//!   响应驱动的在途 shipment 动态列（列签名变化时重建网格，否则
//!   `set_rows_if_changed` 幂等注入）；状态 pill 走 `render_element`
//!   自定义单元格（动态列需捕获 shipment_no，故用闭包而非 fn 指针）；
//!   底部 pinned [`aggregate_strip`] 承载合计口径（原合计条数值同源）；
//! - **筛选**：Pattern A 工具栏行（项目单选 / 国家 US·DE·UK·ALL / 业务日期
//!   快照下拉 + 刷新）；项目 / 站点由 Stage4 Console Bar 唯一权威承载
//!   （BLF-795，BLF-802 接线），页内下拉保留快照维度；
//! - **动效**：Phase 4 `enter_fade_in` + `reduce_motion` 尊重。
//!
//! 与 frontend 的已知差异（有意保留，GPUI 能力边界 / 范围）：
//! - **Excel 导出未接入**（web 有 exportToExcel；对齐 daily_analysis 等既有
//!   GUI 视图范围边界，后续统一补导出能力）；
//! - **业务日期快照选项随主数据并行拉取**（web 是 BEL-423 下拉懒加载；
//!   backend 该端点有 10min Redis 缓存，GUI 简化为先取数，下拉始终可开）；
//! - **合计行 → 表下方合计条**（DataTable 无 footer 支持，改为卡片底部
//!   「合计 + 各分桶/在途数量」紧凑条，对齐 web 合计行的数值口径）；
//! - **空态语义**：项目列表为空 → 页面级空态（「暂无可用项目」）；有项目但
//!   该筛选无快照明细 → 表格内空态（对齐 web `EmptyTableState`，筛选栏与
//!   统计卡保持可见）。
//!
//! P5-0 增强（BLF-719 引入，随本棒合并）：`ColumnDef.id` / `ColumnDef.title`
//! 从 `&'static str` 放宽为 `String` / `SharedString`——在途 shipment 列是
//! 响应驱动的动态列，id 需含 shipment_no 去重、标题取响应 label（见
//! `widgets/data_table.rs`）。

use chrono::NaiveDate;
use gpui::{
    div, prelude::*, px, AnyElement, App, AsyncApp, Context, Entity, FontWeight, Render,
    SharedString, WeakEntity, Window,
};
use gpui_component::{
    button::Button,
    h_flex,
    menu::PopupMenuItem,
    v_flex, Icon, IconName, Sizable,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::operations::inventory::{
    InventoryAnalysisItem, InventoryAnalysisResponse, InventoryAnalysisSummary,
    InventorySnapshotOption, ShipmentColumn,
};

use crate::theme::AppTheme;
use crate::widgets::data_grid::{
    aggregate_strip, pattern_a_shell, AggregateItem, DataGrid,
};
use crate::widgets::data_table::{CellAlign, ColumnDef};
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};
use crate::widgets::{filter_bar};
use crate::widgets::top_projects::fmt_num_precise;

/// 本页在侧栏中的 URL（root.rs 据此路由到本视图；与 gui-domain::sidebar 的
/// 库存分析条目一致）
pub const INVENTORY_ANALYSIS_URL: &str = "/dashboard/operations/inventory-analysis";

/// 站点选项（对齐 frontend `CountrySelect`：`ALL` = 全部站点）
const COUNTRY_OPTIONS: [(&str, &str); 4] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
    ("ALL", "全部站点"),
];

/// 默认站点（对齐 frontend `useUrlParam('country', 'US')`）
const DEFAULT_COUNTRY: &str = "US";

/// 「最新业务日期」快照值（对齐 frontend `useUrlParam('snapshot', 'current')`）
const SNAPSHOT_CURRENT: &str = "current";

/// 站点展示名（`ALL` → 「全部站点」，未知值原样返回）
pub fn country_label(country: &str) -> String {
    COUNTRY_OPTIONS
        .iter()
        .find(|(value, _)| *value == country)
        .map_or_else(|| country.to_string(), |(_, label)| label.to_string())
}

/// 业务日期展示（`YYYY-MM-DD` → `2026年08月15日`；`None` → 「暂无快照」，
/// 对齐 frontend `formatBusinessDate`）
pub fn format_business_date(date: Option<NaiveDate>) -> String {
    date.map_or_else(
        || "暂无快照".to_string(),
        |d| d.format("%Y年%m月%d日").to_string(),
    )
}

/// 库存状态 pill 文案（对齐 frontend `stockStatusLabel`）
pub fn stock_status_label(status: &str) -> &'static str {
    if status == "out_of_stock" {
        "缺货"
    } else {
        "有货"
    }
}

/// 库龄状态 pill 文案（对齐 frontend `agingStatusLabel`）
pub fn aging_status_label(status: &str) -> &'static str {
    match status {
        "over_aged" => "超龄",
        "aging" => "偏高",
        _ => "正常",
    }
}

/// 解析当前项目 id：显式选中优先（失效时回退），否则取第一个项目——
/// 对齐 frontend `useAutoSelectFirstProject`（进入页面默认选中第一个真实项目，
/// 跳过 all / 空白意图；项目列表为空返回 None）。
pub fn resolve_project_id(selected: Option<i64>, projects: &[ManagedProject]) -> Option<i64> {
    if let Some(id) = selected {
        if projects.iter().any(|p| p.id == id) {
            return Some(id);
        }
    }
    projects.first().map(|p| p.id)
}

// ---------------------------------------------------------------------------
// 载荷 + 状态机
// ---------------------------------------------------------------------------

/// 一次拉取的完整载荷（数据 + 筛选菜单数据源；apply_result 原子落点）
#[derive(Debug, Clone, PartialEq)]
pub struct InventoryPayload {
    /// 可见项目列表（筛选菜单数据源）
    pub projects: Vec<ManagedProject>,
    /// 库存分析响应（汇总 + 明细 + shipment 动态列）
    pub response: InventoryAnalysisResponse,
    /// 业务日期快照选项（随主数据并行拉取）
    pub snapshot_options: Vec<InventorySnapshotOption>,
}

/// 库存分析状态机（四态；Empty = 项目列表为空，Loaded 内表格另有空态文案）
///
/// `Loaded` 载荷装箱（`Box`）避免 enum 变体体积差过大（large_enum_variant）。
#[derive(Debug, Clone, PartialEq)]
pub enum InventoryState {
    Loading,
    Loaded(Box<InventoryPayload>),
    Empty,
    Error(String),
}

impl InventoryState {
    /// 拉取结果 → 落点状态（唯一合法的「拉取完成」转移）
    pub fn from_fetch_result(result: Result<InventoryPayload, String>) -> Self {
        match result {
            Ok(payload) if payload.projects.is_empty() => Self::Empty,
            Ok(payload) => Self::Loaded(Box::new(payload)),
            Err(msg) => Self::Error(msg),
        }
    }
}

/// 库存分析视图（四态状态机 + 项目/国家/业务日期筛选 + 竞态保护）
pub struct InventoryAnalysisView {
    state: Entity<InventoryState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表（reload 刷新；筛选菜单数据源）
    projects: Vec<ManagedProject>,
    /// 当前选中项目（web 进入页面自动选第一个）
    selected_project_id: Option<i64>,
    /// 当前站点（"US" / "DE" / "UK" / "ALL"）
    country: &'static str,
    /// 业务日期快照选择（`"current"` = 最新业务日期；否则 `YYYY-MM-DD`）
    selected_snapshot: SharedString,
    /// 业务日期快照选项（项目 × 站点维度；reload 并行拉取）
    snapshot_options: Vec<InventorySnapshotOption>,
    /// 请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,
    /// 库存明细大表（BLF-802 Pattern A 套版；shipment 动态列 → 列签名变化时重建）
    grid: Option<Entity<DataGrid<InventoryAnalysisItem>>>,
    /// 当前表格的 shipment 列签名（shipment_no 序列；用于判断是否需重建网格）
    shipment_sig: Vec<String>,
}

impl InventoryAnalysisView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| InventoryState::Loading);
        Self {
            state,
            client,
            projects: Vec::new(),
            selected_project_id: None,
            country: DEFAULT_COUNTRY,
            selected_snapshot: SharedString::from(SNAPSHOT_CURRENT),
            snapshot_options: Vec::new(),
            latest_request_id: 0,
            grid: None,
            shipment_sig: Vec::new(),
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)] // 视图级测试消费（对齐 dashboard.rs current_state 用法）
    pub fn current_state(&self, cx: &App) -> InventoryState {
        self.state.read(cx).clone()
    }

    /// 重新拉取数据：项目/国家/业务日期切换、错误重试、空态刷新共用入口
    /// （竞态保护；每次调用递增 `latest_request_id` 并进入 Loading）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let selected = self.selected_project_id;
        let country = self.country;
        let snapshot = self.selected_snapshot.clone();

        self.state.update(cx, |state, cx| {
            *state = InventoryState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(load_inventory(&client, selected, country, &snapshot))
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

    /// 切换业务日期快照 → reload（`"current"` = 最新业务日期；同一值为 no-op）
    pub fn select_snapshot(&mut self, snapshot: SharedString, cx: &mut Context<Self>) {
        if snapshot == self.selected_snapshot {
            return;
        }
        self.selected_snapshot = snapshot;
        self.reload(cx);
    }

    /// 应用拉取结果：竞态保护（过期响应丢弃）+ Loaded 落点前同步筛选数据源
    /// 与表格（shipment 列签名变化时重建 DataTable）。
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<InventoryPayload, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok(payload) = &result {
            self.projects = payload.projects.clone();
            // 响应回显 project_id：自动选中首个项目时把选择写回（web
            // useAutoSelectFirstProject 的「URL 没指定 → 选第一个」落点）
            self.selected_project_id = Some(payload.response.project_id);
            self.snapshot_options = payload.snapshot_options.clone();
            self.sync_grid(&payload.response, cx);
        }
        self.state.update(cx, |state, cx| {
            *state = InventoryState::from_fetch_result(result);
            cx.notify();
        });
    }

    /// 幂等注入明细大表：shipment 列签名变化（或首建）→ 重建 DataGrid；
    /// 否则 `set_rows_if_changed` 只注入行（render 期重复调用不触发多余重绘）。
    fn sync_grid(&mut self, resp: &InventoryAnalysisResponse, cx: &mut Context<Self>) {
        let sig: Vec<String> = resp
            .shipment_columns
            .iter()
            .map(|c| c.shipment_no.clone())
            .collect();
        if self.shipment_sig == sig && self.grid.is_some() {
            if let Some(grid) = &self.grid {
                let items = resp.items.clone();
                grid.update(cx, |g, cx| g.set_rows_if_changed(&items, cx));
            }
            return;
        }
        let columns = inventory_columns(&resp.shipment_columns);
        let items = resp.items.clone();
        let grid = cx.new(|_| {
            DataGrid::new("inventory-analysis-grid", columns)
                .striped(true)
                .empty_text("当前筛选下暂无库存快照数据")
        });
        grid.update(cx, |g, cx| g.set_rows(items, cx));
        self.grid = Some(grid);
        self.shipment_sig = sig;
    }
}

/// 拉取库存数据（项目列表 + 库存分析 + 业务日期快照选项），与视图解耦便于测试。
///
/// 对齐 frontend `loadData` / BEL-423：
/// - 项目列表为空 → Err（「暂无可用项目」，页面空态由 `from_fetch_result` 判定）；
/// - 未显式选项目 → 自动选第一个（`resolve_project_id`）；
/// - 快照选项失败不阻塞主数据（web 下拉懒加载时 catch 静默，等价降级为空列表）。
async fn load_inventory(
    client: &Client,
    selected_project_id: Option<i64>,
    country: &str,
    selected_snapshot: &str,
) -> Result<InventoryPayload, String> {
    let projects = client
        .list_managed_projects()
        .await
        .map_err(|e| e.user_message())?;
    let project_id = resolve_project_id(selected_project_id, &projects)
        .ok_or_else(|| "暂无可用项目，请先在系统中配置项目。".to_string())?;
    let report_date = if selected_snapshot == SNAPSHOT_CURRENT {
        None
    } else {
        NaiveDate::parse_from_str(selected_snapshot, "%Y-%m-%d").ok()
    };
    let (analysis, options) = tokio::join!(
        client.inventory_analysis(project_id, country, report_date),
        client.inventory_snapshot_options(project_id, country),
    );
    let response = analysis.map_err(|e| e.user_message())?;
    let snapshot_options = options.unwrap_or_default();
    Ok(InventoryPayload {
        projects,
        response,
        snapshot_options,
    })
}

impl Render for InventoryAnalysisView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let grid = self.grid.clone();
        match state {
            InventoryState::Loading => render_loading(&app_theme).into_any_element(),
            InventoryState::Error(msg) => {
                render_error(cx, &app_theme, &msg).into_any_element()
            }
            InventoryState::Empty => render_empty(cx, &app_theme).into_any_element(),
            InventoryState::Loaded(payload) => {
                let view = cx.entity();
                render_loaded(
                    &view,
                    cx,
                    &app_theme,
                    &payload,
                    self.selected_project_id,
                    self.country,
                    &self.selected_snapshot,
                    grid,
                )
                .into_any_element()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 四态渲染
// ---------------------------------------------------------------------------

/// Loading：Spinner + 声明式骨架块（标题 / 筛选 / 统计卡 / 表格）
///
/// P4-6：骨架块统一走 `state_views::skeleton_loading` 声明式组合。
fn render_loading(app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("inventory-analysis-loading")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::skeleton_loading(
            app_theme,
            &[
                SkeletonBlock::Title,
                SkeletonBlock::Filter(3),
                SkeletonBlock::Kpi(4),
                SkeletonBlock::Table(320.0),
            ],
        ))
}

/// Error：内联 Alert + 重试按钮（Stage 0 `state_views::error_state`）
fn render_error(
    cx: &mut Context<InventoryAnalysisView>,
    app_theme: &AppTheme,
    msg: &str,
) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("inventory-analysis-error")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::error_state(
            &view,
            app_theme,
            "inventory-analysis-error",
            "库存分析加载失败",
            msg.to_string(),
            |this, cx| this.reload(cx),
        ))
}

/// Empty（项目列表为空）：Icon + 文案 + 刷新按钮（Stage 0
/// `empty_state_with_action`）
fn render_empty(cx: &mut Context<InventoryAnalysisView>, app_theme: &AppTheme) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("inventory-analysis-empty")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::empty_state_with_action(
            &view,
            app_theme,
            "inventory-analysis-empty",
            "icons/package.svg",
            "暂无可用项目，请先在系统中配置项目",
            "刷新",
            |this, cx| this.reload(cx),
        ))
}

/// Loaded：页面头 + 筛选栏 + 统计卡 + 明细表卡（含合计条）
#[allow(clippy::too_many_arguments)]
fn render_loaded(
    view: &Entity<InventoryAnalysisView>,
    cx: &mut Context<InventoryAnalysisView>,
    app_theme: &AppTheme,
    payload: &InventoryPayload,
    selected_project_id: Option<i64>,
    country: &'static str,
    selected_snapshot: &str,
    grid: Option<Entity<DataGrid<InventoryAnalysisItem>>>,
) -> impl IntoElement {
    let resp = &payload.response;
    let reduce = crate::motion::reduce_motion(cx);

    let header = PageHeader::new("库存分析").subtitle(format!(
        "{} · {} · 业务日期 {}",
        resp.project_name,
        country_label(&resp.country),
        format_business_date(resp.report_date)
    ));
    // Pattern A 工具栏行（36px）：项目 / 站点 / 快照 / 刷新
    let toolbar = render_filter_bar(
        view,
        app_theme,
        &payload.projects,
        selected_project_id,
        country,
        selected_snapshot,
        &payload.snapshot_options,
        resp.report_date,
    );
    // pinned 底部聚合条：合计口径（原合计条数值同源；数字 mono）
    let footer = aggregate_strip(
        app_theme,
        "inventory-analysis",
        &inventory_totals(resp),
    );
    // 统计卡带（4 张库存统计卡）置于网格上方
    let body = v_flex()
        .id("inventory-analysis-body")
        .size_full()
        .min_h_0()
        .child(
            div()
                .w_full()
                .flex_none()
                .px_2()
                .pt_2()
                .pb_1()
                .child(stat_band(app_theme, &resp.summary)),
        )
        .child(match grid {
            Some(grid) => grid.into_any_element(),
            None => state_views::skeleton_loading(app_theme, &[SkeletonBlock::BarRow(6, 320.0)])
                .into_any_element(),
        });

    crate::motion::enter_fade_in(
        SharedString::from("inventory-analysis-loaded-fade"),
        pattern_a_shell(app_theme, "inventory-analysis", header, toolbar, body, footer),
        reduce,
    )
}

/// 底部聚合条目：合计口径与旧合计行一致——可售 + 6 库龄分桶 + 各在途 shipment。
fn inventory_totals(resp: &InventoryAnalysisResponse) -> Vec<AggregateItem> {
    let summary = &resp.summary;
    let mut items = vec![
        AggregateItem::new("可售库存", fmt_num_precise(summary.total_available_qty)),
        AggregateItem::new("0-90天", fmt_num_precise(summary.total_age_0_90_qty)),
        AggregateItem::new("91-180天", fmt_num_precise(summary.total_age_91_180_qty)),
        AggregateItem::new("181-270天", fmt_num_precise(summary.total_age_181_270_qty)),
        AggregateItem::new("271-365天", fmt_num_precise(summary.total_age_271_365_qty)),
        AggregateItem::new("超过365天", fmt_num_precise(summary.total_age_365_plus_qty)),
    ];
    for col in &resp.shipment_columns {
        let qty = resp
            .shipment_column_totals
            .get(&col.shipment_no)
            .copied()
            .unwrap_or_default();
        items.push(AggregateItem::new(col.label.clone(), fmt_num_precise(qty)));
    }
    items
}

// ---------------------------------------------------------------------------
// 筛选栏（项目 / 国家 / 业务日期 / 刷新）
// ---------------------------------------------------------------------------

/// 筛选栏：项目单选 + 国家站点 + 业务日期快照下拉 + 业务日期 chip + 刷新。
///
/// 菜单 builder 是 `Fn + 'static`（每次打开菜单重新执行）→ 项目 / 快照选项
/// 必须转 owned 才能被 move 捕获；选中项 label 在 builder 外算一次。
#[allow(clippy::too_many_arguments)]
fn render_filter_bar(
    view: &Entity<InventoryAnalysisView>,
    app_theme: &AppTheme,
    projects: &[ManagedProject],
    selected_project_id: Option<i64>,
    country: &'static str,
    selected_snapshot: &str,
    snapshot_options: &[InventorySnapshotOption],
    report_date: Option<NaiveDate>,
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
    let snapshot_label: SharedString = if selected_snapshot == SNAPSHOT_CURRENT {
        SharedString::from("最新业务日期")
    } else {
        SharedString::from(format_business_date(
            NaiveDate::parse_from_str(selected_snapshot, "%Y-%m-%d").ok(),
        ))
    };
    let snapshot_owned = selected_snapshot.to_string();
    let options_owned = snapshot_options.to_vec();
    let view_for_project = view.clone();
    let view_for_country = view.clone();
    let view_for_snapshot = view.clone();
    let view_for_refresh = view.clone();

    filter_bar::filter_bar_layout(app_theme)
        .id("inventory-analysis-filters")
        .child(filter_bar::filter_select(
            app_theme,
            "项目",
            project_label,
            "inventory-analysis-project-filter",
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
            "inventory-analysis-country-filter",
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
        ))
        .child(filter_bar::filter_select(
            app_theme,
            "业务日期",
            snapshot_label,
            "inventory-analysis-snapshot-filter",
            move |menu, _window, _cx| {
                let mut menu = menu.item(
                    PopupMenuItem::new("最新业务日期")
                        .checked(snapshot_owned == SNAPSHOT_CURRENT)
                        .on_click({
                            let view = view_for_snapshot.clone();
                            move |_, _window, cx| {
                                view.update(cx, |this, cx| {
                                    this.select_snapshot(SharedString::from(SNAPSHOT_CURRENT), cx)
                                });
                            }
                        }),
                );
                for opt in &options_owned {
                    let value = opt.report_date.to_string();
                    let mut label = format_business_date(Some(opt.report_date));
                    if opt.is_current {
                        label.push_str(" (当前)");
                    }
                    let checked = snapshot_owned == value;
                    let view = view_for_snapshot.clone();
                    menu = menu.item(
                        PopupMenuItem::new(label).checked(checked).on_click(move |_, _window, cx| {
                            let value = value.clone();
                            view.update(cx, |this, cx| {
                                this.select_snapshot(SharedString::from(value), cx);
                            });
                        }),
                    );
                }
                menu
            },
        ))
        .child(div().flex_1())
        .child(business_date_chip(app_theme, report_date))
        .child(
            Button::new("inventory-analysis-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_, _window, cx| {
                    view_for_refresh.update(cx, |this, cx| this.reload(cx));
                }),
        )
}

/// 「业务日期」chip：显示数据是几号的（后端响应回带；`None` = 暂无快照）
fn business_date_chip(
    app_theme: &AppTheme,
    report_date: Option<NaiveDate>,
) -> impl IntoElement {
    h_flex()
        .id("inventory-analysis-business-date")
        .gap_2()
        .items_center()
        .px_3()
        .py_1p5()
        .rounded(px(app_theme.radius))
        .border_1()
        .border_color(app_theme.separator)
        .bg(app_theme.muted_fill)
        .child(
            Icon::new(IconName::Calendar)
                .with_size(px(13.))
                .text_color(app_theme.text_muted),
        )
        .child(
            div()
                .text_xs()
                .text_color(app_theme.text_muted)
                .child("业务日期"),
        )
        .child(
            div()
                .text_sm()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(app_theme.text_primary)
                .child(format_business_date(report_date)),
        )
}

// ---------------------------------------------------------------------------
// 统计卡（SKU 总数 / 可售库存总量 / 缺货 SKU / 365+ 库龄库存）
// ---------------------------------------------------------------------------

/// 4 张统计卡（对齐 web 统计条；缺货 / 365+ 有量时数值标红）
fn stat_band(app_theme: &AppTheme, summary: &InventoryAnalysisSummary) -> impl IntoElement {
    let out_of_stock_color = if summary.out_of_stock_count > 0 {
        Some(app_theme.danger)
    } else {
        None
    };
    let aged_color = if summary.total_age_365_plus_qty > 0 {
        Some(app_theme.danger)
    } else {
        None
    };

    h_flex()
        .id("inventory-analysis-stats")
        .gap_3()
        .children(vec![
            stat_card(
                app_theme,
                Icon::empty().path("icons/package.svg"),
                "SKU 总数",
                fmt_num_precise(summary.sku_count),
                None,
            ),
            stat_card(
                app_theme,
                Icon::empty().path("icons/shopping-bag.svg"),
                "可售库存总量",
                fmt_num_precise(summary.total_available_qty),
                None,
            ),
            stat_card(
                app_theme,
                Icon::new(IconName::TriangleAlert),
                "缺货 SKU",
                fmt_num_precise(summary.out_of_stock_count),
                out_of_stock_color,
            ),
            stat_card(
                app_theme,
                Icon::new(IconName::Calendar),
                "365+ 库龄库存",
                fmt_num_precise(summary.total_age_365_plus_qty),
                aged_color,
            ),
        ])
}

/// 单张统计卡：图标 + 数值 + 标签（数值可带强调色）
fn stat_card(
    app_theme: &AppTheme,
    icon: Icon,
    label: &'static str,
    value: String,
    value_color: Option<gpui::Hsla>,
) -> impl IntoElement {
    let color = value_color.unwrap_or(app_theme.text_primary);
    v_flex()
        .flex_1()
        .items_center()
        .gap_1()
        .px_3()
        .py_3()
        .rounded(px(app_theme.radius_lg))
        .border_1()
        .border_color(app_theme.separator)
        .bg(app_theme.card_bg)
        .child(
            icon.with_size(px(16.))
                .text_color(app_theme.accent.opacity(0.85)),
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
                .child(SharedString::from(label)),
        )
}

// ---------------------------------------------------------------------------
// 库存明细大表列定义（Pattern A DataGrid；固定 12 列 + shipment 动态列）
// ---------------------------------------------------------------------------

/// 状态 pill（圆角胶囊：浅底 + 描边 + 强调色文字）
fn status_pill(label: &'static str, color: gpui::Hsla) -> AnyElement {
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
                .child(SharedString::from(label)),
        )
        .into_any_element()
}

/// 库存状态 pill（缺货 → danger；有货 → success）
fn stock_pill(row: &InventoryAnalysisItem, theme: &AppTheme) -> AnyElement {
    let (label, color) = if row.stock_status == "out_of_stock" {
        (stock_status_label(&row.stock_status), theme.danger)
    } else {
        (stock_status_label(&row.stock_status), theme.success)
    };
    status_pill(label, color)
}

/// 库龄状态 pill（超龄 → danger；偏高 → warning；正常 → accent）
fn aging_pill(row: &InventoryAnalysisItem, theme: &AppTheme) -> AnyElement {
    let (label, color) = match row.aging_status.as_str() {
        "over_aged" => (aging_status_label("over_aged"), theme.danger),
        "aging" => (aging_status_label("aging"), theme.warning),
        _ => (aging_status_label("normal"), theme.accent),
    };
    status_pill(label, color)
}

/// 固定 12 列 + shipment 动态列的列定义。
///
/// shipment 列 id 含 `shipment_no`（唯一性要求，见 `ColumnDef.id: String`），
/// 标题取响应 label；数量取值需捕获 shipment_no → 用 `render_element` 闭包
/// （`render` 位置放占位 fn，被覆盖）。
pub fn inventory_columns(shipments: &[ShipmentColumn]) -> Vec<ColumnDef<InventoryAnalysisItem>> {
    let mut columns = vec![
        ColumnDef::text(
            "inventory-sku",
            "SKU",
            |r: &InventoryAnalysisItem, _| SharedString::from(r.sku.clone()),
        )
        .width(150.0),
        ColumnDef::text(
            "inventory-asin",
            "ASIN",
            |r: &InventoryAnalysisItem, _| {
                SharedString::from(r.asin.clone().unwrap_or_else(|| "--".to_string()))
            },
        )
        .width(110.0),
        ColumnDef::text(
            "inventory-product",
            "品名",
            |r: &InventoryAnalysisItem, _| {
                SharedString::from(r.product_name.clone().unwrap_or_else(|| "--".to_string()))
            },
        ),
        ColumnDef::number(
            "inventory-available",
            "库存",
            |r: &InventoryAnalysisItem| r.available_qty as f64,
            |r: &InventoryAnalysisItem, _| fmt_num_precise(r.available_qty).into(),
        )
        .width(88.0),
        ColumnDef::number(
            "inventory-age-0-90",
            "0-90天",
            |r: &InventoryAnalysisItem| r.age_0_90_qty as f64,
            |r: &InventoryAnalysisItem, _| fmt_num_precise(r.age_0_90_qty).into(),
        )
        .width(80.0),
        ColumnDef::number(
            "inventory-age-91-180",
            "91-180天",
            |r: &InventoryAnalysisItem| r.age_91_180_qty as f64,
            |r: &InventoryAnalysisItem, _| fmt_num_precise(r.age_91_180_qty).into(),
        )
        .width(84.0),
        ColumnDef::number(
            "inventory-age-181-270",
            "181-270天",
            |r: &InventoryAnalysisItem| r.age_181_270_qty as f64,
            |r: &InventoryAnalysisItem, _| fmt_num_precise(r.age_181_270_qty).into(),
        )
        .width(88.0),
        ColumnDef::number(
            "inventory-age-271-365",
            "271-365天",
            |r: &InventoryAnalysisItem| r.age_271_365_qty as f64,
            |r: &InventoryAnalysisItem, _| fmt_num_precise(r.age_271_365_qty).into(),
        )
        .width(88.0),
        ColumnDef::number(
            "inventory-age-365-plus",
            "超过365天",
            |r: &InventoryAnalysisItem| r.age_365_plus_qty as f64,
            |r: &InventoryAnalysisItem, _| fmt_num_precise(r.age_365_plus_qty).into(),
        )
        .width(96.0),
        ColumnDef::text(
            "inventory-action",
            "建议操作",
            |r: &InventoryAnalysisItem, _| {
                SharedString::from(
                    if r.recommended_action_label.is_empty() {
                        "--".to_string()
                    } else {
                        r.recommended_action_label.clone()
                    },
                )
            },
        )
        .width(120.0),
        ColumnDef::text(
            "inventory-stock-status",
            "库存状态",
            |_: &InventoryAnalysisItem, _| SharedString::from(""),
        )
        .width(92.0)
        .with_render_element(|r: &InventoryAnalysisItem, theme: &AppTheme| stock_pill(r, theme)),
        ColumnDef::text(
            "inventory-aging-status",
            "库龄状态",
            |_: &InventoryAnalysisItem, _| SharedString::from(""),
        )
        .width(92.0)
        .with_render_element(|r: &InventoryAnalysisItem, theme: &AppTheme| aging_pill(r, theme)),
    ];

    for col in shipments {
        let no = col.shipment_no.clone();
        let label = col.label.clone();
        columns.push(
            ColumnDef::text(
                format!("inventory-ship-{no}"),
                label,
                |_: &InventoryAnalysisItem, _| SharedString::from("--"),
            )
            .align(CellAlign::Right)
            .width(96.0)
            .with_render_element(
                move |r: &InventoryAnalysisItem, theme: &AppTheme| {
                    let qty = r
                        .shipment_quantities
                        .get(&no)
                        .copied()
                        .unwrap_or_default();
                    div()
                        .text_right()
                        .text_color(theme.text_secondary)
                        .child(fmt_num_precise(qty))
                        .into_any_element()
                },
            ),
        );
    }
    columns
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use gui_domain::operations::inventory::{
        InventoryAnalysisSummary, ShipmentColumn,
    };
    use std::collections::HashMap;

    // ---------- 测试数据 ----------

    fn sample_projects() -> Vec<ManagedProject> {
        vec![
            project(1, "测试项目 A"),
            project(2, "测试项目 B"),
        ]
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

    fn sample_summary() -> InventoryAnalysisSummary {
        InventoryAnalysisSummary {
            sku_count: 2,
            out_of_stock_count: 1,
            aging_sku_count: 1,
            over_aged_sku_count: 1,
            total_available_qty: 150,
            total_age_0_90_qty: 100,
            total_age_91_180_qty: 30,
            total_age_181_270_qty: 10,
            total_age_271_365_qty: 5,
            total_age_365_plus_qty: 5,
            action_type_count: 3,
        }
    }

    fn sample_items() -> Vec<InventoryAnalysisItem> {
        vec![
            InventoryAnalysisItem {
                project_id: 1,
                project_name: "测试项目 A".into(),
                country: "US".into(),
                sku: "SKU-A".into(),
                asin: Some("B0TEST123".into()),
                product_name: Some("测试产品甲".into()),
                available_qty: 100,
                age_0_90_qty: 80,
                age_91_180_qty: 20,
                age_181_270_qty: 0,
                age_271_365_qty: 0,
                age_365_plus_qty: 0,
                recommended_action: Some("replenish".into()),
                recommended_action_label: "建议补货".into(),
                stock_status: "in_stock".into(),
                aging_status: "normal".into(),
                shipment_quantities: HashMap::from([("SHIP-1".into(), 50)]),
            },
            InventoryAnalysisItem {
                project_id: 1,
                project_name: "测试项目 A".into(),
                country: "US".into(),
                sku: "SKU-B".into(),
                asin: None,
                product_name: None,
                available_qty: 50,
                age_0_90_qty: 20,
                age_91_180_qty: 10,
                age_181_270_qty: 10,
                age_271_365_qty: 5,
                age_365_plus_qty: 5,
                recommended_action: None,
                recommended_action_label: "建议清货".into(),
                stock_status: "out_of_stock".into(),
                aging_status: "over_aged".into(),
                shipment_quantities: HashMap::new(),
            },
        ]
    }

    fn sample_shipment_columns() -> Vec<ShipmentColumn> {
        vec![ShipmentColumn {
            shipment_no: "SHIP-1".into(),
            label: "在途 1".into(),
            shipping_method: Some("海运".into()),
            forwarder_name: Some("货代甲".into()),
            etd_date: Some("2026-08-20".into()),
            eta_date: Some("2026-09-05".into()),
        }]
    }

    fn sample_response() -> InventoryAnalysisResponse {
        InventoryAnalysisResponse {
            project_id: 1,
            project_name: "测试项目 A".into(),
            country: "US".into(),
            report_date: Some(NaiveDate::from_ymd_opt(2026, 8, 15).expect("合法日期")),
            summary: sample_summary(),
            action_options: vec!["补货".into(), "清货".into()],
            items: sample_items(),
            shipment_columns: sample_shipment_columns(),
            shipment_column_totals: HashMap::from([("SHIP-1".into(), 50)]),
        }
    }

    fn sample_payload() -> InventoryPayload {
        InventoryPayload {
            projects: sample_projects(),
            response: sample_response(),
            snapshot_options: vec![InventorySnapshotOption {
                report_date: NaiveDate::from_ymd_opt(2026, 8, 15).expect("合法日期"),
                is_current: true,
            }],
        }
    }

    // ---------- 纯函数契约 ----------

    /// 业务日期格式化（对齐 frontend formatBusinessDate）
    #[test]
    fn format_business_date_matches_frontend() {
        assert_eq!(
            format_business_date(Some(
                NaiveDate::from_ymd_opt(2026, 8, 15).expect("合法日期"),
            )),
            "2026年08月15日"
        );
        assert_eq!(format_business_date(None), "暂无快照");
    }

    /// 站点 label（ALL → 全部站点）
    #[test]
    fn country_label_matches_frontend() {
        assert_eq!(country_label("US"), "美国站 (US)");
        assert_eq!(country_label("ALL"), "全部站点");
        assert_eq!(country_label("XX"), "XX");
    }

    /// 状态 pill 文案（对齐 frontend stockStatusLabel / agingStatusLabel）
    #[test]
    fn status_labels_match_frontend() {
        assert_eq!(stock_status_label("out_of_stock"), "缺货");
        assert_eq!(stock_status_label("in_stock"), "有货");
        assert_eq!(aging_status_label("over_aged"), "超龄");
        assert_eq!(aging_status_label("aging"), "偏高");
        assert_eq!(aging_status_label("normal"), "正常");
    }

    /// 自动选项目：未选 → 第一个；显式有效 → 保持；失效 → 回退第一个；空 → None
    #[test]
    fn resolve_project_id_falls_back_to_first() {
        let projects = sample_projects();
        assert_eq!(resolve_project_id(None, &projects), Some(1));
        assert_eq!(resolve_project_id(Some(2), &projects), Some(2));
        // URL 指定了项目但列表里找不到（权限/删除）→ 回退第一个（web 行为）
        assert_eq!(resolve_project_id(Some(99), &projects), Some(1));
        assert_eq!(resolve_project_id(None, &[]), None);
    }

    /// 状态转移：项目空 → Empty；有数据 → Loaded；错误 → Error
    #[test]
    fn state_transitions_from_fetch_result() {
        let mut no_projects = sample_payload();
        no_projects.projects = Vec::new();
        assert_eq!(
            InventoryState::from_fetch_result(Ok(no_projects)),
            InventoryState::Empty
        );
        assert_eq!(
            InventoryState::from_fetch_result(Ok(sample_payload())),
            InventoryState::Loaded(Box::new(sample_payload()))
        );
        assert_eq!(
            InventoryState::from_fetch_result(Err("boom".into())),
            InventoryState::Error("boom".into())
        );
    }

    /// 列定义契约：固定 12 列 + shipment 动态列；id 唯一（含 shipment_no）
    #[test]
    fn inventory_columns_are_fixed_plus_dynamic() {
        let cols = inventory_columns(&sample_shipment_columns());
        assert_eq!(cols.len(), 13); // 12 固定 + 1 shipment
        let ids: Vec<&str> = cols.iter().map(|c| c.id.as_str()).collect();
        let mut uniq = ids.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(ids.len(), uniq.len(), "列 id 必须唯一（gpui element id）");
        assert!(ids.contains(&"inventory-ship-SHIP-1"));
        // 无 shipment 列 → 固定 12 列
        assert_eq!(inventory_columns(&[]).len(), 12);
        // 多 shipment 列 → id 按 shipment_no 去重
        let two = inventory_columns(&[
            ShipmentColumn {
                shipment_no: "SHIP-1".into(),
                label: "在途 1".into(),
                shipping_method: None,
                forwarder_name: None,
                etd_date: None,
                eta_date: None,
            },
            ShipmentColumn {
                shipment_no: "SHIP-2".into(),
                label: "在途 2".into(),
                shipping_method: None,
                forwarder_name: None,
                etd_date: None,
                eta_date: None,
            },
        ]);
        assert_eq!(two.len(), 14);
        let ids: Vec<&str> = two.iter().map(|c| c.id.as_str()).collect();
        let mut uniq = ids.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(ids.len(), uniq.len());
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
            let mut view =
                InventoryAnalysisView::new(cx, Client::new("http://127.0.0.1:1"));
            view.reload(cx);
            view
        });
    }

    /// 渲染冒烟：深色主题 + Loaded 态（直接注入载荷 + 表格，覆盖筛选栏 / 统计卡 /
    /// 明细表 / 合计条）
    #[gpui::test]
    async fn view_renders_loaded_in_dark_mode(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            InventoryAnalysisView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let payload = sample_payload();
            this.sync_grid(&payload.response, cx);
            this.state.update(cx, |state, _| {
                *state = InventoryState::Loaded(Box::new(payload));
            });
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
            InventoryAnalysisView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let payload = sample_payload();
            this.sync_grid(&payload.response, cx);
            this.state.update(cx, |state, _| {
                *state = InventoryState::Loaded(Box::new(payload));
            });
        });
    }

    /// 渲染冒烟：空态（无项目 → 「暂无可用项目」+ 刷新按钮）可渲染
    #[gpui::test]
    async fn view_renders_empty_state(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            InventoryAnalysisView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = InventoryState::Empty;
            });
        });
    }

    /// 渲染冒烟：有项目但明细为空 → Loaded（表格内空态文案兜底，筛选栏可见）
    #[gpui::test]
    async fn view_renders_loaded_with_empty_items(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            InventoryAnalysisView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let mut payload = sample_payload();
            payload.response.items = Vec::new();
            this.sync_grid(&payload.response, cx);
            this.state.update(cx, |state, _| {
                *state = InventoryState::Loaded(Box::new(payload));
            });
        });
    }
}
