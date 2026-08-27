//! 运营 → 补货分析视图（P5-2，BLF-721）
//!
//! frontend `app/dashboard/operations/inventory-replenishment/` 的 GPUI 等价
//! （按 issue 允许的 macOS 习惯简化）：项目 × 国家筛选 + 4 张补货统计卡
//! （SKU 总数 / 断货风险 / 可售库存 / 在途数量）+ 补货明细表（DMS 窗口 /
//! 可售天数 / 售卖截止 / 补货指令 + 三段式状态/行动/风险 pill）+ 客户端分页。
//!
//! 架构（复用 Phase 3/4/5 基建）：
//! - **四态状态机**：`Loading / Loaded / Empty / Error` + `latest_request_id`
//!   竞态保护（沿用 inventory_analysis.rs / inventory_ledger.rs 模式）；
//! - **数据管线**：`list_managed_projects`（`GET /projects/manage`）→
//!   `resolve_project_id` 自动选中第一个项目 → `replenishment_analysis`
//!   （`GET /api/v1/inventory-replenishment-analysis`，一次拉 page_size=200
//!   上限内全量行，客户端筛选/排序/分页——对齐 ledger「原始行唯一真相源」）；
//! - **表格**：P5-0 公共 `DataTable`——固定 18 列（SKU/品名/库存/在途/4 DMS
//!   窗口/加权DMS/可售天数/售卖截止/含在途截止/生产交货/运输时间/预计数量/
//!   状态/行动/风险状态）；状态/行动/风险三列走 `render_element` pill；
//! - **筛选**：P5-0 `filter_bar`（项目单选 / 国家 US·DE·UK——backend
//!   `normalize_country` 只认三站，无 ALL / 风险状态客户端过滤下拉 + 刷新）；
//! - **分页**：客户端分页（每页 50，对齐 web PAGE_SIZE；`pagination_bar`）；
//! - **动效**：Phase 4 `enter_fade_in` + `reduce_motion` 尊重。
//!
//! 与 frontend 的已知差异（有意保留，issue BLF-721 简化授权）：
//! - **快照模式 / 日历视图 / 决策驾驶舱 tab 未迁移**（web 三视图 2000+ 行；
//!   GUI 首版只做实时分析主表，后续迭代按需补）；
//! - **内联参数编辑（生产交货/运输时间/安全系数/目标天数 PUT）未接入**
//!   （web 行内编辑 + 发货明细抽屉；GUI 首版只读，后续迭代补编辑面板）；
//! - **Excel 导出未接入**（对齐既有 GUI 视图范围边界）；
//! - **风险状态过滤走客户端**（web 是服务端 `risk_status` 参数；GUI 一次拉
//!   全量行后本地过滤，交互零延迟，口径一致）；
//! - **合计行 → 表下方合计条**（DataTable 无 footer 支持，对齐
//!   inventory_analysis.rs 合计条模式）。

use gpui::{
    div, prelude::*, px, AnyElement, App, AsyncApp, Context, Entity, FontWeight, Render,
    SharedString, WeakEntity, Window,
};
use gpui_component::{
    button::Button, h_flex, menu::PopupMenuItem, skeleton::Skeleton, v_flex, Icon, IconName,
    Sizable,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::operations::replenishment::{
    action_label, risk_label, state_label, ReplenishmentItem, ReplenishmentResponse,
    ReplenishmentSummary,
};

use crate::theme::AppTheme;
use crate::widgets::data_table::{CellAlign, ColumnDef, DataTable};
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::pagination::{self, PageState};
use crate::widgets::top_projects::fmt_num_precise;
use crate::widgets::{filter_bar, state_views};

/// 本页在侧栏中的 URL（root.rs 据此路由到本视图；与 gui-domain::sidebar 的
/// 补货分析条目一致）
pub const REPLENISHMENT_URL: &str = "/dashboard/operations/inventory-replenishment";

/// 站点选项（backend `normalize_country` 只认 US/DE/UK——补货端点不支持 ALL，
/// 与 inventory_analysis 的 4 选项不同）
const COUNTRY_OPTIONS: [(&str, &str); 3] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
];

/// 默认站点（对齐 frontend `searchParams.get('country') || 'US'`）
const DEFAULT_COUNTRY: &str = "US";

/// 客户端分页每页行数（对齐 frontend `PAGE_SIZE = 50`）
const PAGE_SIZE: usize = 50;

/// 一次拉取的服务端分页上限（backend `page_size ≤ 200`；GUI 首版一次拉满
/// 做客户端筛选/排序/分页，超出由 `has_next` 提示）
const FETCH_PAGE_SIZE: i64 = 200;

/// 风险状态过滤选项（对齐 web 风险状态下拉；「全部状态」= None）
const RISK_OPTIONS: [&str; 7] = [
    "长期断货",
    "短期断货",
    "断货风险",
    "健康库存",
    "滞销",
    "严重滞销",
    "待补数据",
];

/// 站点展示名（未知值原样返回）
pub fn country_label(country: &str) -> String {
    COUNTRY_OPTIONS
        .iter()
        .find(|(value, _)| *value == country)
        .map_or_else(|| country.to_string(), |(_, label)| label.to_string())
}

/// 可选浮点展示（`None` → "--"；对齐 web `formatNumber` 的缺省占位）
fn fmt_opt_num(v: Option<f64>) -> String {
    v.map_or_else(|| "--".to_string(), |n| format!("{n:.1}"))
}

/// 可选日期展示（`None` → "--"；对齐 web `formatDate`）
fn fmt_opt_date(v: &Option<String>) -> String {
    v.clone().unwrap_or_else(|| "--".to_string())
}

/// 解析当前项目 id：显式选中优先（失效时回退），否则取第一个项目——
/// 对齐 frontend `useAutoSelectFirstProject`（与 inventory_analysis.rs 同款）
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
pub struct ReplenishmentPayload {
    /// 可见项目列表（筛选菜单数据源）
    pub projects: Vec<ManagedProject>,
    /// 补货分析响应（items + summary + 分页元数据）
    pub response: ReplenishmentResponse,
    /// 当前数据所属项目（自动选中落点回写用；响应行内 project_id 回显）
    pub project_id: i64,
}

/// 补货分析状态机（四态；Empty = 项目列表为空，Loaded 内表格另有空态文案）
///
/// `Loaded` 载荷装箱（`Box`）避免 enum 变体体积差过大（large_enum_variant）。
#[derive(Debug, Clone, PartialEq)]
pub enum ReplenishmentState {
    Loading,
    Loaded(Box<ReplenishmentPayload>),
    Empty,
    Error(String),
}

impl ReplenishmentState {
    /// 拉取结果 → 落点状态（唯一合法的「拉取完成」转移）
    pub fn from_fetch_result(result: Result<ReplenishmentPayload, String>) -> Self {
        match result {
            Ok(payload) if payload.projects.is_empty() => Self::Empty,
            Ok(payload) => Self::Loaded(Box::new(payload)),
            Err(msg) => Self::Error(msg),
        }
    }
}

/// 补货分析视图（四态状态机 + 项目/国家/风险筛选 + 客户端分页 + 竞态保护）
pub struct ReplenishmentView {
    state: Entity<ReplenishmentState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表（reload 刷新；筛选菜单数据源）
    projects: Vec<ManagedProject>,
    /// 当前选中项目（web 进入页面自动选第一个）
    selected_project_id: Option<i64>,
    /// 当前站点（"US" / "DE" / "UK"）
    country: &'static str,
    /// 风险状态客户端过滤（None = 全部状态；切换时重置分页）
    risk_filter: Option<String>,
    /// 当前页（1-based；客户端分页）
    page: usize,
    /// 补货明细表（P5-0 DataTable；筛选/分页后行注入）
    table: Option<Entity<DataTable<ReplenishmentItem>>>,
    /// 请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,
}

impl ReplenishmentView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| ReplenishmentState::Loading);
        Self {
            state,
            client,
            projects: Vec::new(),
            selected_project_id: None,
            country: DEFAULT_COUNTRY,
            risk_filter: None,
            page: 1,
            table: None,
            latest_request_id: 0,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)] // 视图级测试消费（对齐 inventory_analysis.rs current_state 用法）
    pub fn current_state(&self, cx: &App) -> ReplenishmentState {
        self.state.read(cx).clone()
    }

    /// 重新拉取数据：项目/国家切换、错误重试、空态刷新共用入口
    /// （竞态保护；每次调用递增 `latest_request_id` 并进入 Loading）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let selected = self.selected_project_id;
        let country = self.country;

        self.state.update(cx, |state, cx| {
            *state = ReplenishmentState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(load_replenishment(&client, selected, country))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 切换选中项目 → 重置风险筛选 + reload（同一项目为 no-op）
    pub fn select_project(&mut self, project_id: Option<i64>, cx: &mut Context<Self>) {
        if project_id == self.selected_project_id {
            return;
        }
        self.selected_project_id = project_id;
        self.risk_filter = None;
        self.reload(cx);
    }

    /// 切换站点 → 重置风险筛选 + reload（同一站点为 no-op）
    pub fn select_country(&mut self, country: &'static str, cx: &mut Context<Self>) {
        if country == self.country {
            return;
        }
        self.country = country;
        self.risk_filter = None;
        self.reload(cx);
    }

    /// 设置风险状态过滤（`None` = 全部状态）→ 分页回第一页 + 重新注入表格行
    /// （同一值为 no-op；纯客户端过滤，不触发网络请求）
    pub fn set_risk_filter(&mut self, risk: Option<String>, cx: &mut Context<Self>) {
        if self.risk_filter == risk {
            return;
        }
        self.risk_filter = risk;
        self.page = 1;
        self.sync_table_rows(cx);
        cx.notify();
    }

    /// 翻页（客户端分页；同一页为 no-op）
    pub fn set_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if page == self.page {
            return;
        }
        self.page = page;
        self.sync_table_rows(cx);
        cx.notify();
    }

    /// 应用拉取结果：竞态保护（过期响应丢弃）+ Loaded 落点前同步筛选数据源与表格
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<ReplenishmentPayload, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok(payload) = &result {
            self.projects = payload.projects.clone();
            // 自动选中首个项目时把选择写回（web useAutoSelectFirstProject 落点）
            self.selected_project_id = Some(payload.project_id);
            self.page = 1;
            self.sync_table_rows_from(payload, cx);
        }
        self.state.update(cx, |state, cx| {
            *state = ReplenishmentState::from_fetch_result(result);
            cx.notify();
        });
    }

    /// 把「风险筛选后 + 当前页切片」的行喂进 DataTable（懒建 + 幂等注入）。
    /// 调用时机：`apply_result` / `set_risk_filter` / 翻页。
    fn sync_table_rows(&mut self, cx: &mut Context<Self>) {
        let payload = match self.state.read(cx) {
            ReplenishmentState::Loaded(payload) => payload.clone(),
            _ => return,
        };
        self.sync_table_rows_from(&payload, cx);
    }

    /// `sync_table_rows` 的载荷参数版（apply_result 落点前 state 还是 Loading，
    /// 需直接从新载荷注入）
    fn sync_table_rows_from(&mut self, payload: &ReplenishmentPayload, cx: &mut Context<Self>) {
        let filtered = filter_rows(&payload.response.items, self.risk_filter.as_deref());
        let slice = page_slice(&filtered, self.page);
        let table = self.table.get_or_insert_with(|| {
            cx.new(|_| {
                DataTable::new("replenishment-table", replenishment_columns())
                    .striped(true)
                    .empty_text("当前筛选下暂无补货分析数据")
                    .max_height(560.0)
            })
        });
        table.update(cx, |t, cx| t.set_rows_if_changed(&slice, cx));
    }
}

/// 风险状态客户端过滤（`None` = 全部；对齐 web 风险状态下拉的展示口径）
fn filter_rows(rows: &[ReplenishmentItem], risk: Option<&str>) -> Vec<ReplenishmentItem> {
    match risk {
        None => rows.to_vec(),
        Some(r) => rows
            .iter()
            .filter(|item| item.risk_status == r)
            .cloned()
            .collect(),
    }
}

/// 客户端分页切片（page 为 1-based；越界收敛到末页，对齐 ledger page_slice）
fn page_slice<T: Clone>(rows: &[T], page: usize) -> Vec<T> {
    let page_count = rows.len().div_ceil(PAGE_SIZE).max(1);
    let page = page.clamp(1, page_count);
    let start = (page - 1) * PAGE_SIZE;
    rows.iter().skip(start).take(PAGE_SIZE).cloned().collect()
}

/// 拉取补货数据（项目列表 + 补货分析），与视图解耦便于测试。
///
/// 对齐 frontend `loadData`：
/// - 项目列表为空 → Err（「暂无可用项目」，页面空态由 `from_fetch_result` 判定）；
/// - 未显式选项目 → 自动选第一个（`resolve_project_id`）；
/// - 一次拉 `FETCH_PAGE_SIZE`（200）上限内全量行做客户端筛选/排序/分页。
async fn load_replenishment(
    client: &Client,
    selected_project_id: Option<i64>,
    country: &str,
) -> Result<ReplenishmentPayload, String> {
    let projects = client
        .list_managed_projects()
        .await
        .map_err(|e| e.user_message())?;
    let project_id = resolve_project_id(selected_project_id, &projects)
        .ok_or_else(|| "暂无可用项目，请先在系统中配置项目。".to_string())?;
    let response = client
        .replenishment_analysis(project_id, country, 1, FETCH_PAGE_SIZE)
        .await
        .map_err(|e| e.user_message())?;
    Ok(ReplenishmentPayload {
        projects,
        response,
        project_id,
    })
}

impl Render for ReplenishmentView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let table = self.table.clone();
        match state {
            ReplenishmentState::Loading => render_loading(&app_theme).into_any_element(),
            ReplenishmentState::Error(msg) => render_error(cx, &app_theme, &msg).into_any_element(),
            ReplenishmentState::Empty => render_empty(cx, &app_theme).into_any_element(),
            ReplenishmentState::Loaded(payload) => {
                let view = cx.entity();
                render_loaded(
                    &view,
                    cx,
                    &app_theme,
                    &payload,
                    self.selected_project_id,
                    self.country,
                    self.risk_filter.clone(),
                    self.page,
                    table,
                )
                .into_any_element()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 四态渲染
// ---------------------------------------------------------------------------

/// Loading：Spinner + 筛选骨架 + 统计卡骨架 + 表格骨架（与正式布局同构）
fn render_loading(app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("replenishment-loading")
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
        .child(h_flex().gap_3().children((0..4).map(|_| {
            v_flex()
                .flex_1()
                .gap_2()
                .p_4()
                .rounded(px(app_theme.radius_lg))
                .bg(app_theme.card_bg)
                .child(div().w_6().h_4().child(Skeleton::new()))
                .child(div().w_16().h_7().child(Skeleton::new()))
                .child(div().w_20().child(Skeleton::new()))
        })))
        .child(div().w_full().h_80().child(Skeleton::new()))
}

/// Error：内联 Alert + 重试按钮（Stage 0 `state_views::error_state`）
fn render_error(
    cx: &mut Context<ReplenishmentView>,
    app_theme: &AppTheme,
    msg: &str,
) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("replenishment-error")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::error_state(
            &view,
            app_theme,
            "replenishment-error",
            "补货分析加载失败",
            msg.to_string(),
            |this, cx| this.reload(cx),
        ))
}

/// Empty（项目列表为空）：Icon + 文案 + 刷新按钮（Stage 0
/// `empty_state_with_action`）
fn render_empty(cx: &mut Context<ReplenishmentView>, app_theme: &AppTheme) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("replenishment-empty")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::empty_state_with_action(
            &view,
            app_theme,
            "replenishment-empty",
            "icons/repeat-2.svg",
            "暂无可用项目，请先在系统中配置项目",
            "刷新",
            |this, cx| this.reload(cx),
        ))
}

/// Loaded：页面头 + 筛选栏 + 统计卡 + 明细表卡（含合计条 + 分页栏）
#[allow(clippy::too_many_arguments)]
fn render_loaded(
    view: &Entity<ReplenishmentView>,
    cx: &mut Context<ReplenishmentView>,
    app_theme: &AppTheme,
    payload: &ReplenishmentPayload,
    selected_project_id: Option<i64>,
    country: &'static str,
    risk_filter: Option<String>,
    page: usize,
    table: Option<Entity<DataTable<ReplenishmentItem>>>,
) -> impl IntoElement {
    let resp = &payload.response;
    let reduce = crate::motion::reduce_motion(cx);
    let filtered = filter_rows(&resp.items, risk_filter.as_deref());
    let page_state = PageState::new(page, PAGE_SIZE, filtered.len());
    let project_name = payload
        .projects
        .iter()
        .find(|p| Some(p.id) == selected_project_id)
        .map(|p| p.name.clone())
        .unwrap_or_else(|| "--".to_string());

    crate::motion::enter_fade_in(
        SharedString::from("replenishment-loaded-fade"),
        v_flex()
            .id("replenishment-loaded")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            .child(PageHeader::new("补货分析").subtitle(format!(
                "{} · {} · 实时补货决策（DMS 加权 + 三段式状态/行动）",
                project_name,
                country_label(country)
            )))
            // 筛选栏 + 统计卡：宽窗受内容上限约束；主表保留全宽
            .child(content_guard().child(render_filter_bar(
                view,
                app_theme,
                &payload.projects,
                selected_project_id,
                country,
                risk_filter,
            )))
            .child(content_guard().child(stat_band(app_theme, &resp.summary)))
            .child(table_card(view, app_theme, table, resp, &page_state)),
        reduce,
    )
}

// ---------------------------------------------------------------------------
// 筛选栏（项目 / 国家 / 风险状态 / 刷新）
// ---------------------------------------------------------------------------

/// 筛选栏：项目单选 + 国家站点 + 风险状态下拉 + 刷新。
///
/// 菜单 builder 是 `Fn + 'static`（每次打开菜单重新执行）→ 项目选项必须转
/// owned 才能被 move 捕获；选中项 label 在 builder 外算一次。
fn render_filter_bar(
    view: &Entity<ReplenishmentView>,
    app_theme: &AppTheme,
    projects: &[ManagedProject],
    selected_project_id: Option<i64>,
    country: &'static str,
    risk_filter: Option<String>,
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
    let risk_label: SharedString = risk_filter.as_deref().map_or_else(
        || SharedString::from("全部状态"),
        |r| SharedString::from(risk_label(r).to_string()),
    );
    let risk_owned = risk_filter.clone();
    let view_for_project = view.clone();
    let view_for_country = view.clone();
    let view_for_risk = view.clone();
    let view_for_refresh = view.clone();

    filter_bar::filter_bar_layout(app_theme)
        .id("replenishment-filters")
        .child(filter_bar::filter_select(
            app_theme,
            "项目",
            project_label,
            "replenishment-project-filter",
            move |menu, _window, _cx| {
                let mut menu = menu;
                for project in &projects_owned {
                    let checked = selected_project_id == Some(project.id);
                    let id = project.id;
                    let name = project.name.clone();
                    let view = view_for_project.clone();
                    menu = menu.item(PopupMenuItem::new(name).checked(checked).on_click(
                        move |_, _window, cx| {
                            view.update(cx, |this, cx| this.select_project(Some(id), cx));
                        },
                    ));
                }
                menu
            },
        ))
        .child(filter_bar::filter_select(
            app_theme,
            "国家",
            country_label(country).into(),
            "replenishment-country-filter",
            move |menu, _window, _cx| {
                let mut menu = menu;
                for (value, label) in COUNTRY_OPTIONS {
                    let checked = country == value;
                    let view = view_for_country.clone();
                    menu = menu.item(PopupMenuItem::new(label).checked(checked).on_click(
                        move |_, _window, cx| {
                            view.update(cx, |this, cx| this.select_country(value, cx));
                        },
                    ));
                }
                menu
            },
        ))
        .child(filter_bar::filter_select(
            app_theme,
            "风险状态",
            risk_label,
            "replenishment-risk-filter",
            move |menu, _window, _cx| {
                let mut menu = menu.item(
                    PopupMenuItem::new("全部状态")
                        .checked(risk_owned.is_none())
                        .on_click({
                            let view = view_for_risk.clone();
                            move |_, _window, cx| {
                                view.update(cx, |this, cx| this.set_risk_filter(None, cx));
                            }
                        }),
                );
                for risk in RISK_OPTIONS {
                    let checked = risk_owned.as_deref() == Some(risk);
                    let view = view_for_risk.clone();
                    menu = menu.item(PopupMenuItem::new(risk).checked(checked).on_click(
                        move |_, _window, cx| {
                            view.update(cx, |this, cx| {
                                this.set_risk_filter(Some(risk.to_string()), cx)
                            });
                        },
                    ));
                }
                menu
            },
        ))
        .child(div().flex_1())
        .child(
            Button::new("replenishment-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_, _window, cx| {
                    view_for_refresh.update(cx, |this, cx| this.reload(cx));
                }),
        )
}

// ---------------------------------------------------------------------------
// 统计卡（SKU 总数 / 断货风险 / 可售库存 / 在途数量）
// ---------------------------------------------------------------------------

/// 4 张统计卡（对齐 web 汇总口径；断货风险有量时数值标红）
fn stat_band(app_theme: &AppTheme, summary: &ReplenishmentSummary) -> impl IntoElement {
    let risk_color = if summary.out_of_stock_risk_count > 0 {
        Some(app_theme.danger)
    } else {
        None
    };

    h_flex().id("replenishment-stats").gap_3().children(vec![
        stat_card(
            app_theme,
            Icon::empty().path("icons/package.svg"),
            "SKU 总数",
            fmt_num_precise(summary.sku_count),
            None,
        ),
        stat_card(
            app_theme,
            Icon::new(IconName::TriangleAlert),
            "断货风险",
            fmt_num_precise(summary.out_of_stock_risk_count),
            risk_color,
        ),
        stat_card(
            app_theme,
            Icon::empty().path("icons/shopping-bag.svg"),
            "可售库存",
            fmt_num_precise(summary.total_available_inventory),
            None,
        ),
        stat_card(
            app_theme,
            Icon::empty().path("icons/repeat-2.svg"),
            "在途数量",
            fmt_num_precise(summary.total_in_transit_quantity),
            None,
        ),
    ])
}

/// 单张统计卡：图标 + 数值 + 标签（数值可带强调色；对齐 inventory_analysis stat_card）
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
// 补货明细表卡（P5-0 DataTable + 合计条 + 分页栏）
// ---------------------------------------------------------------------------

/// 明细表卡：标题（补货决策 · 补货明细表）+ 表格 + 合计条 + 分页栏
fn table_card(
    view: &Entity<ReplenishmentView>,
    app_theme: &AppTheme,
    table: Option<Entity<DataTable<ReplenishmentItem>>>,
    resp: &ReplenishmentResponse,
    page_state: &PageState,
) -> impl IntoElement {
    v_flex()
        .id("replenishment-table-card")
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
                        .text_xs()
                        .text_color(app_theme.text_muted)
                        .child("补货决策"),
                )
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(app_theme.text_primary)
                        .child("补货明细表"),
                ),
        )
        .when_some(table, |this, table| this.child(table))
        .child(totals_footer(app_theme, &resp.summary))
        .child(
            div()
                .w_full()
                .px_4()
                .py_2()
                .child(pagination::pagination_bar(
                    view,
                    app_theme,
                    "replenishment-pagination",
                    page_state,
                    &[PAGE_SIZE],
                    |this, page, cx| this.set_page(page, cx),
                    |_, _, _| {},
                )),
        )
}

/// 合计条（对齐 web 合计行数值口径：SKU + 可售库存 + 在途 + 断货风险）
fn totals_footer(app_theme: &AppTheme, summary: &ReplenishmentSummary) -> impl IntoElement {
    let totals: Vec<(String, String)> = vec![
        ("SKU".to_string(), fmt_num_precise(summary.sku_count)),
        (
            "可售库存".to_string(),
            fmt_num_precise(summary.total_available_inventory),
        ),
        (
            "在途".to_string(),
            fmt_num_precise(summary.total_in_transit_quantity),
        ),
        (
            "断货风险".to_string(),
            fmt_num_precise(summary.out_of_stock_risk_count),
        ),
        ("健康".to_string(), fmt_num_precise(summary.healthy_count)),
        (
            "滞销".to_string(),
            fmt_num_precise(summary.slow_moving_count),
        ),
    ];

    h_flex()
        .id("replenishment-totals")
        .gap_3()
        .items_center()
        .flex_wrap()
        .px_4()
        .py_2()
        .border_t_1()
        .border_color(app_theme.separator)
        .child(
            div()
                .text_sm()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(app_theme.text_primary)
                .child("合计"),
        )
        .children(totals.into_iter().map(|(label, value)| {
            h_flex()
                .gap_1()
                .items_center()
                .child(
                    div()
                        .text_xs()
                        .text_color(app_theme.text_muted)
                        .child(label),
                )
                .child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(app_theme.text_secondary)
                        .child(value),
                )
        }))
}

// ---------------------------------------------------------------------------
// 表格列定义（固定 16 列 + 三段式 pill）
// ---------------------------------------------------------------------------

/// 状态 pill（圆角胶囊：浅底 + 描边 + 强调色文字；对齐 inventory_analysis status_pill）
fn status_pill(label: &str, color: gpui::Hsla) -> AnyElement {
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
                .child(SharedString::from(label.to_string())),
        )
        .into_any_element()
}

/// 风险状态 pill 颜色（对齐 web riskMeta 的色相分级：断货系 → danger /
/// 健康 → success / 滞销系 → warning / 中性 → text_muted）
fn risk_color(risk_status: &str, theme: &AppTheme) -> gpui::Hsla {
    match risk_status {
        "长期断货" | "断货风险" => theme.danger,
        "短期断货" => theme.warning,
        "健康库存" => theme.success,
        "滞销" | "严重滞销" => theme.warning,
        _ => theme.text_muted,
    }
}

/// 三段式 state pill 颜色（对齐 web stateMeta：critical → danger /
/// deteriorating → warning / watch → warning / healthy → success / unknown → muted）
fn state_color(state: &str, theme: &AppTheme) -> gpui::Hsla {
    match state {
        "critical" => theme.danger,
        "deteriorating" | "watch" => theme.warning,
        "healthy" => theme.success,
        _ => theme.text_muted,
    }
}

/// 行动 pill 颜色（对齐 web actionMeta：REPLENISH_NOW → danger /
/// REPLENISH_NORMAL → accent / HOLD·REDUCE_PRICE → warning / REMOVE → danger /
/// NO_ACTION → muted）
fn action_color(action: &str, theme: &AppTheme) -> gpui::Hsla {
    match action {
        "REPLENISH_NOW" | "REMOVE" => theme.danger,
        "REPLENISH_NORMAL" => theme.accent,
        "HOLD" | "REDUCE_PRICE" => theme.warning,
        _ => theme.text_muted,
    }
}

/// 固定 18 列的列定义（对齐 web 表格列顺序的 GUI 简化子集）。
///
/// 状态 / 行动 / 风险三列走 `render_element` pill（文案来自 gui-domain
/// `state_label` / `action_label` / `risk_label`，与 web stateMeta / actionMeta /
/// riskMeta 一致）。
pub fn replenishment_columns() -> Vec<ColumnDef<ReplenishmentItem>> {
    vec![
        ColumnDef::text("replenishment-sku", "SKU", |r: &ReplenishmentItem, _| {
            SharedString::from(r.sku.clone())
        })
        .width(140.0),
        ColumnDef::text(
            "replenishment-product",
            "产品名称",
            |r: &ReplenishmentItem, _| {
                SharedString::from(r.product_name.clone().unwrap_or_else(|| "--".to_string()))
            },
        )
        .width(180.0),
        ColumnDef::number(
            "replenishment-available",
            "店铺库存",
            |r: &ReplenishmentItem| r.available_inventory as f64,
            |r: &ReplenishmentItem, _| fmt_num_precise(r.available_inventory).into(),
        )
        .align(CellAlign::Right)
        .width(88.0),
        ColumnDef::number(
            "replenishment-transit",
            "在途",
            |r: &ReplenishmentItem| r.in_transit_quantity as f64,
            |r: &ReplenishmentItem, _| fmt_num_precise(r.in_transit_quantity).into(),
        )
        .align(CellAlign::Right)
        .width(76.0),
        ColumnDef::number(
            "replenishment-dms-30",
            "30D",
            |r: &ReplenishmentItem| r.dms_30.unwrap_or(0.0),
            |r: &ReplenishmentItem, _| fmt_opt_num(r.dms_30).into(),
        )
        .align(CellAlign::Right)
        .width(64.0),
        ColumnDef::number(
            "replenishment-dms-14",
            "14D",
            |r: &ReplenishmentItem| r.dms_14.unwrap_or(0.0),
            |r: &ReplenishmentItem, _| fmt_opt_num(r.dms_14).into(),
        )
        .align(CellAlign::Right)
        .width(64.0),
        ColumnDef::number(
            "replenishment-dms-7",
            "7D",
            |r: &ReplenishmentItem| r.dms_7.unwrap_or(0.0),
            |r: &ReplenishmentItem, _| fmt_opt_num(r.dms_7).into(),
        )
        .align(CellAlign::Right)
        .width(64.0),
        ColumnDef::number(
            "replenishment-dms-3",
            "3D",
            |r: &ReplenishmentItem| r.dms_3.unwrap_or(0.0),
            |r: &ReplenishmentItem, _| fmt_opt_num(r.dms_3).into(),
        )
        .align(CellAlign::Right)
        .width(64.0),
        ColumnDef::number(
            "replenishment-weighted-dms",
            "加权DMS",
            |r: &ReplenishmentItem| r.weighted_dms.unwrap_or(0.0),
            |r: &ReplenishmentItem, _| fmt_opt_num(r.weighted_dms).into(),
        )
        .align(CellAlign::Right)
        .width(84.0),
        ColumnDef::number(
            "replenishment-sellable-days",
            "可售天数",
            |r: &ReplenishmentItem| r.sellable_days.unwrap_or(0.0),
            |r: &ReplenishmentItem, _| fmt_opt_num(r.sellable_days).into(),
        )
        .align(CellAlign::Right)
        .width(84.0),
        ColumnDef::text(
            "replenishment-sellout",
            "售卖截止",
            |r: &ReplenishmentItem, _| SharedString::from(fmt_opt_date(&r.sellout_date)),
        )
        .width(100.0),
        ColumnDef::text(
            "replenishment-sellout-transit",
            "含在途截止",
            |r: &ReplenishmentItem, _| {
                SharedString::from(fmt_opt_date(&r.sellout_date_with_transit))
            },
        )
        .width(104.0),
        ColumnDef::number(
            "replenishment-lead-days",
            "生产交货",
            |r: &ReplenishmentItem| r.production_lead_days as f64,
            |r: &ReplenishmentItem, _| format!("{}天", r.production_lead_days).into(),
        )
        .align(CellAlign::Right)
        .width(84.0),
        ColumnDef::number(
            "replenishment-shipping-days",
            "运输时间",
            |r: &ReplenishmentItem| r.shipping_days as f64,
            |r: &ReplenishmentItem, _| format!("{}天", r.shipping_days).into(),
        )
        .align(CellAlign::Right)
        .width(84.0),
        ColumnDef::number(
            "replenishment-est-qty",
            "预计数量",
            |r: &ReplenishmentItem| r.estimated_replenishment_quantity.unwrap_or(0) as f64,
            |r: &ReplenishmentItem, _| {
                SharedString::from(
                    r.estimated_replenishment_quantity
                        .map_or_else(|| "--".to_string(), fmt_num_precise),
                )
            },
        )
        .align(CellAlign::Right)
        .width(88.0),
        ColumnDef::text(
            "replenishment-state",
            "状态",
            |_: &ReplenishmentItem, _| SharedString::from(""),
        )
        .width(88.0)
        .with_render_element(|r: &ReplenishmentItem, theme: &AppTheme| {
            status_pill(
                state_label(&r.inventory_state),
                state_color(&r.inventory_state, theme),
            )
        }),
        ColumnDef::text(
            "replenishment-action",
            "行动",
            |_: &ReplenishmentItem, _| SharedString::from(""),
        )
        .width(104.0)
        .with_render_element(|r: &ReplenishmentItem, theme: &AppTheme| {
            status_pill(
                action_label(&r.replenishment_action),
                action_color(&r.replenishment_action, theme),
            )
        }),
        ColumnDef::text(
            "replenishment-risk",
            "风险状态",
            |_: &ReplenishmentItem, _| SharedString::from(""),
        )
        .width(96.0)
        .with_render_element(|r: &ReplenishmentItem, theme: &AppTheme| {
            status_pill(
                risk_label(&r.risk_status),
                risk_color(&r.risk_status, theme),
            )
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    // ---------- 测试数据 ----------

    fn sample_projects() -> Vec<ManagedProject> {
        vec![project(1, "测试项目 A"), project(2, "测试项目 B")]
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

    fn sample_summary() -> ReplenishmentSummary {
        ReplenishmentSummary {
            sku_count: 2,
            out_of_stock_risk_count: 1,
            healthy_count: 1,
            slow_moving_count: 0,
            pending_data_count: 0,
            total_available_inventory: 150,
            total_in_transit_quantity: 50,
            critical_count: 1,
            deteriorating_count: 0,
        }
    }

    fn item(sku: &str, risk: &str, state: &str, action: &str) -> ReplenishmentItem {
        ReplenishmentItem {
            project_id: 1,
            project_name: "测试项目 A".into(),
            sku: sku.into(),
            country: "US".into(),
            asin: Some("B0TEST".into()),
            product_name: Some("测试产品".into()),
            available_inventory: 100,
            in_transit_quantity: 50,
            dms_30: Some(2.5),
            dms_14: Some(2.2),
            dms_7: Some(2.0),
            dms_3: Some(1.8),
            base_dms: Some(2.5),
            safety_factor: 1.2,
            weighted_dms: Some(2.1),
            sellable_days: Some(47.6),
            sellout_date: Some("2026-10-01".into()),
            sellout_date_with_transit: Some("2026-11-20".into()),
            production_lead_days: 30,
            shipping_days: 35,
            replenishment_order_date: None,
            warehouse_entry_date: None,
            estimated_replenishment_quantity: Some(200),
            risk_status: risk.into(),
            inventory_state: state.into(),
            replenishment_action: action.into(),
            latest_order_date: Some("2026-09-01".into()),
            target_days: 90,
        }
    }

    fn sample_items() -> Vec<ReplenishmentItem> {
        vec![
            item("SKU-A", "断货风险", "critical", "REPLENISH_NOW"),
            item("SKU-B", "健康库存", "healthy", "NO_ACTION"),
        ]
    }

    fn sample_payload() -> ReplenishmentPayload {
        ReplenishmentPayload {
            projects: sample_projects(),
            response: ReplenishmentResponse {
                items: sample_items(),
                summary: sample_summary(),
                page: 1,
                page_size: 200,
                total: 2,
                has_next: false,
            },
            project_id: 1,
        }
    }

    // ---------- 纯函数契约 ----------

    /// 站点 label（补货端点只认 US/DE/UK，无 ALL）
    #[test]
    fn country_label_matches_backend() {
        assert_eq!(country_label("US"), "美国站 (US)");
        assert_eq!(country_label("DE"), "德国站 (DE)");
        assert_eq!(country_label("UK"), "英国站 (UK)");
        assert_eq!(country_label("XX"), "XX");
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
            ReplenishmentState::from_fetch_result(Ok(no_projects)),
            ReplenishmentState::Empty
        );
        assert_eq!(
            ReplenishmentState::from_fetch_result(Ok(sample_payload())),
            ReplenishmentState::Loaded(Box::new(sample_payload()))
        );
        assert_eq!(
            ReplenishmentState::from_fetch_result(Err("boom".into())),
            ReplenishmentState::Error("boom".into())
        );
    }

    /// 风险过滤：None = 全部；Some = 精确匹配 risk_status
    #[test]
    fn filter_rows_by_risk() {
        let rows = sample_items();
        assert_eq!(filter_rows(&rows, None).len(), 2);
        let risky = filter_rows(&rows, Some("断货风险"));
        assert_eq!(risky.len(), 1);
        assert_eq!(risky[0].sku, "SKU-A");
        assert!(filter_rows(&rows, Some("待补数据")).is_empty());
    }

    /// 客户端分页切片：越界收敛到末页（对齐 ledger page_slice 语义）
    #[test]
    fn page_slice_clamps_and_slices() {
        let rows: Vec<i32> = (0..120).collect();
        assert_eq!(page_slice(&rows, 1).len(), PAGE_SIZE);
        assert_eq!(page_slice(&rows, 3).len(), 20);
        // 越界 → 末页
        assert_eq!(page_slice(&rows, 99).len(), 20);
        // 空数据 → 空页
        assert!(page_slice::<i32>(&[], 1).is_empty());
    }

    /// 列定义契约：固定 18 列；id 唯一（gpui element id 要求）
    #[test]
    fn replenishment_columns_are_fixed_and_unique() {
        let cols = replenishment_columns();
        assert_eq!(cols.len(), 18);
        let ids: Vec<&str> = cols.iter().map(|c| c.id.as_str()).collect();
        let mut uniq = ids.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(ids.len(), uniq.len(), "列 id 必须唯一（gpui element id）");
        assert!(ids.contains(&"replenishment-risk"));
        assert!(ids.contains(&"replenishment-state"));
        assert!(ids.contains(&"replenishment-action"));
    }

    /// 可选数值/日期格式化（对齐 web formatNumber / formatDate 的缺省占位）
    #[test]
    fn optional_formatting() {
        assert_eq!(fmt_opt_num(Some(2.5)), "2.5");
        assert_eq!(fmt_opt_num(None), "--");
        assert_eq!(fmt_opt_date(&Some("2026-10-01".into())), "2026-10-01");
        assert_eq!(fmt_opt_date(&None), "--");
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
            let mut view = ReplenishmentView::new(cx, Client::new("http://127.0.0.1:1"));
            view.reload(cx);
            view
        });
    }

    /// 渲染冒烟：深色主题 + Loaded 态（直接注入载荷 + 表格，覆盖筛选栏 / 统计卡 /
    /// 明细表 / 合计条 / 分页栏）
    #[gpui::test]
    async fn view_renders_loaded_in_dark_mode(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            ReplenishmentView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let payload = sample_payload();
            this.sync_table_rows_from(&payload, cx);
            this.state.update(cx, |state, _| {
                *state = ReplenishmentState::Loaded(Box::new(payload));
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
            ReplenishmentView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let payload = sample_payload();
            this.sync_table_rows_from(&payload, cx);
            this.state.update(cx, |state, _| {
                *state = ReplenishmentState::Loaded(Box::new(payload));
            });
        });
    }

    /// 渲染冒烟：空态（无项目 → 「暂无可用项目」+ 刷新按钮）可渲染
    #[gpui::test]
    async fn view_renders_empty_state(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            ReplenishmentView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = ReplenishmentState::Empty;
            });
        });
    }

    /// 渲染冒烟：有项目但明细为空 → Loaded（表格内空态文案兜底，筛选栏可见）
    #[gpui::test]
    async fn view_renders_loaded_with_empty_items(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            ReplenishmentView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let mut payload = sample_payload();
            payload.response.items = Vec::new();
            this.sync_table_rows_from(&payload, cx);
            this.state.update(cx, |state, _| {
                *state = ReplenishmentState::Loaded(Box::new(payload));
            });
        });
    }

    /// 渲染冒烟：风险筛选后 Loaded 态（过滤到单行 + 分页栏）可渲染
    #[gpui::test]
    async fn view_renders_loaded_with_risk_filter(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            ReplenishmentView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let payload = sample_payload();
            this.state.update(cx, |state, _| {
                *state = ReplenishmentState::Loaded(Box::new(payload));
            });
            this.set_risk_filter(Some("断货风险".to_string()), cx);
        });
    }
}
