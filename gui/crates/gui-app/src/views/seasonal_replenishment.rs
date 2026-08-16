//! 运营 → 季节性补货分析视图（P5-2，BLF-722）
//!
//! frontend `app/dashboard/operations/seasonal-replenishment/` 的 GPUI 等价：
//! 项目 × 国家 × 历史日期区间 × 去年同期开关 × SKU/ASIN 关键字筛选 +
//! 5 张统计卡（SKU 总数 / 总店铺库存 / 总在途库存 / 有销量 SKU / 待补数据）+
//! 季节性补货主表（4 窗口 DMS + 可选同比列 + 加权 DMS / 可售天数 / 售卖截止 /
//! 预计补货数量）+ 合计条 + 口径说明卡。
//!
//! 架构（复用 Phase 3/4/5 基建）：
//! - **四态状态机**：`Loading / Loaded / Empty / Error`（沿用 dashboard.rs /
//!   inventory_analysis.rs 模式），`latest_request_id` 竞态保护——只有最新请求的
//!   响应才会落点；
//! - **数据管线**：`list_managed_projects`（`GET /projects/manage`，按 X-Operator
//!   过滤可见项目）→ `resolve_project_id` 自动选中第一个项目（web
//!   `useAutoSelectFirstProject` 语义）→ `seasonal_replenishment_analysis`
//!   （`GET /api/v1/seasonal-replenishment-analysis`，web 口径固定
//!   `page=1&page_size=200` 一次拉全量）；
//! - **表格**：P5-0 公共 `DataTable`——基础 14 列 + 开启「去年同期」时插入
//!   4 个同比列（列签名变化时重建表格，否则 `set_rows_if_changed` 幂等注入）；
//!   同比单元格走 `render_element` 自定义单元格（当前 < 去年 → 红 / 当前 > 去年
//!   → 绿，对齐 web `yoyDeltaClass`）；
//! - **筛选**：P5-0 `filter_bar`（项目单选 / 国家 US·DE·UK——backend
//!   `normalize_country` 严格模式不支持 ALL）+ `DateRangePickerState`
//!   （默认近 90 天，对齐 web `[today-89, today]`）+ 关键字输入（回车应用）+
//!   「去年同期」开关按钮 + 刷新重算；
//! - **动效**：Phase 4 `enter_fade_in` + `reduce_motion` 尊重。
//!
//! 与 frontend 的已知差异（有意保留，GPUI 能力边界 / 范围）：
//! - **Excel 导出未接入**（web 有 exportToExcel；对齐既有 GUI 视图范围边界，
//!   后续统一补导出能力）；
//! - **关键字搜索为回车应用**（web 是 `useDeferredValue` 输入即搜；GUI 无
//!   debounce 基建，回车触发 reload 语义更明确）；
//! - **合计行 → 表下方合计条**（DataTable 无 footer 支持，对齐
//!   inventory_analysis.rs 的合计条口径）；
//! - **口径说明卡精简为单段文案**（web 是 4 张说明卡；GUI 保留核心口径：
//!   窗口回溯 / 权重 / 同比 / 不判定风险状态）；
//! - **空态语义**：项目列表为空 → 页面级空态（「暂无可用项目」）；有项目但
//!   该筛选无明细 → 表格内空态（对齐 web「当前筛选条件下没有可分析的 SKU」）。

use chrono::NaiveDate;
use gpui::{
    div, prelude::*, px, AnyElement, App, AsyncApp, Context, Entity, FontWeight, Render,
    SharedString, WeakEntity, Window,
};
use gpui_component::{
    button::Button,
    h_flex,
    input::{Input, InputEvent, InputState},
    menu::PopupMenuItem,
    skeleton::Skeleton,
    v_flex, Icon, IconName, Selectable, Sizable,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::operations::seasonal_replenishment::{
    SeasonalReplenishmentItem, SeasonalReplenishmentResponse, SeasonalReplenishmentSummary,
};

use crate::theme::AppTheme;
use crate::widgets::data_table::{CellAlign, ColumnDef, DataTable};
use crate::widgets::date_range::{DateRange, DateRangeEvent, DateRangePickerState};
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::{filter_bar, state_views};
use crate::widgets::top_projects::fmt_num_precise;

/// 本页在侧栏中的 URL（root.rs 据此路由到本视图；与 gui-domain::sidebar 的
/// 季节性补货分析条目一致）
pub const SEASONAL_REPLENISHMENT_URL: &str = "/dashboard/operations/seasonal-replenishment";

/// 站点选项（backend `normalize_country` 严格模式只认 US/DE/UK，**无 ALL**——
/// 与常规补货分析端点一致；web 端 CountrySelect 虽列 ALL 但后端会 422）
const COUNTRY_OPTIONS: [(&str, &str); 3] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
];

/// 默认站点（对齐 frontend `useUrlParam('country', 'US')`）
const DEFAULT_COUNTRY: &str = "US";

/// 默认历史窗口天数（对齐 web B1 决定：`[today-89, today]` = 近 90 天）
const DEFAULT_WINDOW_DAYS: u64 = 90;

/// 一次拉取的行数上限（对齐 web `page_size: '200'`；backend 上限同为 200）
const FETCH_PAGE_SIZE: i64 = 200;

/// 站点展示名（未知值原样返回）
pub fn country_label(country: &str) -> String {
    COUNTRY_OPTIONS
        .iter()
        .find(|(value, _)| *value == country)
        .map_or_else(|| country.to_string(), |(_, label)| label.to_string())
}

/// 数值格式化（对齐 web `formatNumber`：`None` → `--`，保留 2 位小数）
pub fn fmt_opt_num(value: Option<f64>) -> String {
    value.map_or_else(|| "--".to_string(), |v| format!("{v:.2}"))
}

/// 整数格式化（对齐 web `formatInt`：`None` → `--`，千分位）
pub fn fmt_opt_int(value: Option<i64>) -> String {
    value.map_or_else(|| "--".to_string(), fmt_num_precise)
}

/// 日期字符串展示（对齐 web `formatDate`：空 → `--`）
pub fn fmt_opt_date(value: Option<&str>) -> String {
    value.filter(|v| !v.is_empty()).map_or_else(|| "--".to_string(), str::to_string)
}

/// 同比方向（对齐 web `yoyDeltaClass`：当前 < 去年 → 下滑预警；当前 > 去年 →
/// 爬坡预警；缺失 / 相等 → 中性）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum YoyDirection {
    Down,
    Up,
    Neutral,
}

/// 同比方向判定（`current` / `yoy` 任一缺失或去年为 0 → 中性）
pub fn yoy_direction(current: Option<f64>, yoy: Option<f64>) -> YoyDirection {
    match (current, yoy) {
        (Some(c), Some(y)) if y != 0.0 && c < y => YoyDirection::Down,
        (Some(c), Some(y)) if y != 0.0 && c > y => YoyDirection::Up,
        _ => YoyDirection::Neutral,
    }
}

/// 解析当前项目 id：显式选中优先（失效时回退），否则取第一个项目——
/// 对齐 frontend `useAutoSelectFirstProject`（进入页面默认选中第一个真实项目；
/// 项目列表为空返回 None）。
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
pub struct SeasonalPayload {
    /// 可见项目列表（筛选菜单数据源）
    pub projects: Vec<ManagedProject>,
    /// 季节性补货分析响应（汇总 + 明细 + 窗口回显）
    pub response: SeasonalReplenishmentResponse,
}

/// 季节性补货分析状态机（四态；Empty = 项目列表为空，Loaded 内表格另有空态文案）
///
/// `Loaded` 载荷装箱（`Box`）避免 enum 变体体积差过大（large_enum_variant）。
#[derive(Debug, Clone, PartialEq)]
pub enum SeasonalState {
    Loading,
    Loaded(Box<SeasonalPayload>),
    Empty,
    Error(String),
}

impl SeasonalState {
    /// 拉取结果 → 落点状态（唯一合法的「拉取完成」转移）
    pub fn from_fetch_result(result: Result<SeasonalPayload, String>) -> Self {
        match result {
            Ok(payload) if payload.projects.is_empty() => Self::Empty,
            Ok(payload) => Self::Loaded(Box::new(payload)),
            Err(msg) => Self::Error(msg),
        }
    }
}

/// 季节性补货分析视图（四态状态机 + 项目/国家/日期区间/同比/关键字筛选 + 竞态保护）
pub struct SeasonalReplenishmentView {
    state: Entity<SeasonalState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表（reload 刷新；筛选菜单数据源）
    projects: Vec<ManagedProject>,
    /// 当前选中项目（web 进入页面自动选第一个）
    selected_project_id: Option<i64>,
    /// 当前站点（"US" / "DE" / "UK"）
    country: &'static str,
    /// 历史回看窗口（默认近 90 天；backend 要求跨度 ≥ 7 天）
    date_range: DateRange,
    /// 日期区间选择器（订阅 Change → reload）
    date_picker: Entity<DateRangePickerState>,
    /// 「去年同期」开关（对齐 web compareYear；true → compare_year_offset=1）
    compare_year: bool,
    /// 已应用的关键字（回车 / 搜索按钮触发 reload；空 = 不过滤）
    applied_keyword: String,
    /// 关键字输入框（首个渲染时惰性创建，需要 Window）
    keyword_input: Option<Entity<InputState>>,
    /// 主表（P5-0 DataTable；同比列开关 → 列签名变化时重建）
    table: Option<Entity<DataTable<SeasonalReplenishmentItem>>>,
    /// 当前表格是否含同比列（用于判断是否需重建表格）
    table_has_yoy: bool,
    /// 日期区间选择器 / 输入框事件订阅（必须持有，否则变更不送达）
    _subscriptions: Vec<gpui::Subscription>,
    /// 请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,
}

impl SeasonalReplenishmentView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| SeasonalState::Loading);
        // 默认近 90 天（对齐 web B1 决定 [today-89, today]）；订阅日期区间变更
        let today = chrono::Local::now().date_naive();
        let date_range = DateRange::last_days(DEFAULT_WINDOW_DAYS, today);
        let date_picker = cx.new(|cx| {
            let mut p = DateRangePickerState::new(cx);
            p.set_range(date_range);
            p
        });
        let picker_sub = cx.subscribe(&date_picker, |this, _entity, ev, cx| {
            let DateRangeEvent::Change(range) = ev;
            this.apply_date_range(*range, cx);
        });
        Self {
            state,
            client,
            projects: Vec::new(),
            selected_project_id: None,
            country: DEFAULT_COUNTRY,
            date_range,
            date_picker,
            compare_year: false,
            applied_keyword: String::new(),
            keyword_input: None,
            table: None,
            table_has_yoy: false,
            _subscriptions: vec![picker_sub],
            latest_request_id: 0,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)] // 视图级测试消费（对齐 dashboard.rs current_state 用法）
    pub fn current_state(&self, cx: &App) -> SeasonalState {
        self.state.read(cx).clone()
    }

    /// 首个渲染时创建关键字输入框（需要 `&mut Window` 才能建 InputState）：
    /// 回车 = 应用关键字并 reload（对齐 web 关键字筛选语义，GUI 用回车代替即搜）。
    fn ensure_keyword_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.keyword_input.is_some() {
            return;
        }
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("搜索 SKU / ASIN"));
        let sub = cx.subscribe(&input, |this, entity, event: &InputEvent, cx| {
            if matches!(event, InputEvent::PressEnter { .. }) {
                let value = entity.read(cx).value().trim().to_string();
                this.apply_keyword(value, cx);
            }
        });
        self._subscriptions.push(sub);
        self.keyword_input = Some(input);
    }

    /// 重新拉取数据：项目/国家/日期/同比/关键字切换、错误重试、空态刷新共用入口
    /// （竞态保护；每次调用递增 `latest_request_id` 并进入 Loading）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let selected = self.selected_project_id;
        let country = self.country;
        let compare_year = self.compare_year;
        let keyword = self.applied_keyword.clone();
        // 未设置区间时回退近 90 天（防御：外部 set_range 清空等）
        let (from, to) = match (self.date_range.from, self.date_range.to) {
            (Some(f), Some(t)) => (f, t),
            _ => {
                let today = chrono::Local::now().date_naive();
                let range = DateRange::last_days(DEFAULT_WINDOW_DAYS, today);
                (range.from.expect("近 90 天有起点"), range.to.expect("近 90 天有终点"))
            }
        };

        self.state.update(cx, |state, cx| {
            *state = SeasonalState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(load_seasonal(
                        &client, selected, country, from, to, compare_year, &keyword,
                    ))
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

    /// 应用日期区间（同一区间 no-op）→ reload
    pub fn apply_date_range(&mut self, range: DateRange, cx: &mut Context<Self>) {
        if self.date_range == range {
            return;
        }
        self.date_range = range;
        self.reload(cx);
    }

    /// 切换「去年同期」开关 → reload（同一状态为 no-op）
    pub fn toggle_compare_year(&mut self, cx: &mut Context<Self>) {
        self.compare_year = !self.compare_year;
        self.reload(cx);
    }

    /// 应用关键字（同一关键字 no-op）→ reload（空串 = 清除过滤）
    pub fn apply_keyword(&mut self, keyword: String, cx: &mut Context<Self>) {
        if keyword == self.applied_keyword {
            return;
        }
        self.applied_keyword = keyword;
        self.reload(cx);
    }

    /// 应用拉取结果：竞态保护（过期响应丢弃）+ Loaded 落点前同步筛选数据源
    /// 与表格（同比列开关变化时重建 DataTable）。
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<SeasonalPayload, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok(payload) = &result {
            self.projects = payload.projects.clone();
            // 响应回显 project_id：自动选中首个项目时把选择写回（web
            // useAutoSelectFirstProject 的「URL 没指定 → 选第一个」落点）
            if let Some(first) = payload.response.items.first() {
                self.selected_project_id = Some(first.project_id);
            } else if self.selected_project_id.is_none() {
                self.selected_project_id = payload.projects.first().map(|p| p.id);
            }
            self.sync_table(&payload.response, cx);
        }
        self.state.update(cx, |state, cx| {
            *state = SeasonalState::from_fetch_result(result);
            cx.notify();
        });
    }

    /// 幂等注入主表：同比列开关变化（或首建）→ 重建 DataTable；
    /// 否则 `set_rows_if_changed` 只注入行（render 期重复调用不触发多余重绘）。
    fn sync_table(&mut self, resp: &SeasonalReplenishmentResponse, cx: &mut Context<Self>) {
        let has_yoy = resp.compare_year_offset > 0;
        if self.table_has_yoy == has_yoy && self.table.is_some() {
            if let Some(table) = &self.table {
                let items = resp.items.clone();
                table.update(cx, |t, cx| t.set_rows_if_changed(&items, cx));
            }
            return;
        }
        let columns = seasonal_columns(has_yoy);
        let items = resp.items.clone();
        let table = cx.new(|_| {
            DataTable::new("seasonal-replenishment-table", columns)
                .striped(true)
                .empty_text("当前筛选条件下没有可分析的 SKU")
                .max_height(520.0)
        });
        table.update(cx, |t, cx| t.set_rows(items, cx));
        self.table = Some(table);
        self.table_has_yoy = has_yoy;
    }
}

/// 拉取季节性补货数据（项目列表 + 季节性分析），与视图解耦便于测试。
///
/// 对齐 frontend `loadAnalysis`：
/// - 项目列表为空 → Err（「暂无可用项目」，页面空态由 `from_fetch_result` 判定）；
/// - 未显式选项目 → 自动选第一个（`resolve_project_id`）；
/// - web 口径固定 `page=1&page_size=200` 一次拉全量（backend 上限同为 200）。
async fn load_seasonal(
    client: &Client,
    selected_project_id: Option<i64>,
    country: &str,
    from_date: NaiveDate,
    to_date: NaiveDate,
    compare_year: bool,
    keyword: &str,
) -> Result<SeasonalPayload, String> {
    let projects = client
        .list_managed_projects()
        .await
        .map_err(|e| e.user_message())?;
    let project_id = resolve_project_id(selected_project_id, &projects)
        .ok_or_else(|| "暂无可用项目，请先在系统中配置项目。".to_string())?;
    let keyword_opt = if keyword.trim().is_empty() {
        None
    } else {
        Some(keyword.trim())
    };
    let response = client
        .seasonal_replenishment_analysis(
            project_id,
            country,
            from_date,
            to_date,
            i64::from(compare_year),
            keyword_opt,
            1,
            FETCH_PAGE_SIZE,
        )
        .await
        .map_err(|e| e.user_message())?;
    Ok(SeasonalPayload { projects, response })
}

impl Render for SeasonalReplenishmentView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.ensure_keyword_input(window, cx);
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let table = self.table.clone();
        match state {
            SeasonalState::Loading => render_loading(&app_theme).into_any_element(),
            SeasonalState::Error(msg) => render_error(cx, &app_theme, &msg).into_any_element(),
            SeasonalState::Empty => render_empty(cx, &app_theme).into_any_element(),
            SeasonalState::Loaded(payload) => {
                let view = cx.entity();
                render_loaded(
                    &view,
                    cx,
                    &app_theme,
                    &payload,
                    self.selected_project_id,
                    self.country,
                    self.compare_year,
                    self.date_picker.clone(),
                    self.keyword_input.clone(),
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
        .id("seasonal-replenishment-loading")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::loading_state(app_theme, "加载中…"))
        .child(
            h_flex()
                .gap_3()
                .children((0..4).map(|_| {
                    div().w(px(140.)).h_8().child(Skeleton::new())
                })),
        )
        .child(
            h_flex()
                .gap_3()
                .children((0..5).map(|_| {
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
    cx: &mut Context<SeasonalReplenishmentView>,
    app_theme: &AppTheme,
    msg: &str,
) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("seasonal-replenishment-error")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::error_state(
            &view,
            app_theme,
            "seasonal-replenishment-error",
            "季节性补货分析加载失败",
            msg.to_string(),
            |this, cx| this.reload(cx),
        ))
}

/// Empty（项目列表为空）：Icon + 文案 + 刷新按钮（Stage 0
/// `empty_state_with_action`）
fn render_empty(
    cx: &mut Context<SeasonalReplenishmentView>,
    app_theme: &AppTheme,
) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("seasonal-replenishment-empty")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::empty_state_with_action(
            &view,
            app_theme,
            "seasonal-replenishment-empty",
            "icons/package.svg",
            "暂无可用项目，请先在系统中配置项目",
            "刷新",
            |this, cx| this.reload(cx),
        ))
}

/// Loaded：页面头 + 筛选栏 + 统计卡 + 主表卡（含合计条）+ 口径说明卡
#[allow(clippy::too_many_arguments)]
fn render_loaded(
    view: &Entity<SeasonalReplenishmentView>,
    cx: &mut Context<SeasonalReplenishmentView>,
    app_theme: &AppTheme,
    payload: &SeasonalPayload,
    selected_project_id: Option<i64>,
    country: &'static str,
    compare_year: bool,
    date_picker: Entity<DateRangePickerState>,
    keyword_input: Option<Entity<InputState>>,
    table: Option<Entity<DataTable<SeasonalReplenishmentItem>>>,
) -> impl IntoElement {
    let resp = &payload.response;
    let reduce = crate::motion::reduce_motion(cx);
    let project_name = payload
        .projects
        .iter()
        .find(|p| Some(p.id) == selected_project_id)
        .map(|p| p.name.clone())
        .unwrap_or_else(|| "--".to_string());

    crate::motion::enter_fade_in(
        SharedString::from("seasonal-replenishment-loaded-fade"),
        v_flex()
            .id("seasonal-replenishment-loaded")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            .child(PageHeader::new("季节性补货分析").subtitle(format!(
                "{} · {} · {} ~ {} · 权重 90D×40% + 30D×30% + 14D×20% + 7D×10%",
                project_name,
                country_label(resp.items.first().map(|r| r.country.as_str()).unwrap_or(country)),
                resp.from_date,
                resp.to_date
            )))
            // 筛选栏 + 统计卡：宽窗受内容上限约束；主表保留全宽
            .child(content_guard().child(render_filter_bar(
                view,
                app_theme,
                &payload.projects,
                selected_project_id,
                country,
                compare_year,
                date_picker,
                keyword_input,
            )))
            .child(content_guard().child(stat_band(app_theme, &resp.summary)))
            .child(table_card(app_theme, table, resp, compare_year))
            .child(caliber_note(app_theme)),
        reduce,
    )
}

// ---------------------------------------------------------------------------
// 筛选栏（项目 / 国家 / 日期区间 / 关键字 / 去年同期 / 刷新重算）
// ---------------------------------------------------------------------------

/// 筛选栏：项目单选 + 国家站点 + 日期区间选择器 + 关键字输入 + 「去年同期」
/// 开关 + 刷新重算。
///
/// 菜单 builder 是 `Fn + 'static`（每次打开菜单重新执行）→ 项目选项必须转
/// owned 才能被 move 捕获；选中项 label 在 builder 外算一次。
#[allow(clippy::too_many_arguments)]
fn render_filter_bar(
    view: &Entity<SeasonalReplenishmentView>,
    app_theme: &AppTheme,
    projects: &[ManagedProject],
    selected_project_id: Option<i64>,
    country: &'static str,
    compare_year: bool,
    date_picker: Entity<DateRangePickerState>,
    keyword_input: Option<Entity<InputState>>,
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
    let view_for_country = view.clone();
    let view_for_compare = view.clone();
    let view_for_search = view.clone();
    let view_for_refresh = view.clone();
    let keyword_entity = keyword_input.clone();

    filter_bar::filter_bar_layout(app_theme)
        .id("seasonal-replenishment-filters")
        .child(filter_bar::filter_select(
            app_theme,
            "项目",
            project_label,
            "seasonal-replenishment-project-filter",
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
            "seasonal-replenishment-country-filter",
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
        // 日期区间（DateRangePicker 公共组件；变更经订阅回连 reload）
        .child(date_picker)
        // 关键字输入（回车应用；对齐 web「搜索 SKU / ASIN」）
        .when_some(keyword_input, |this, input| {
            this.child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(Input::new(&input).w(px(180.)).h(px(28.)))
                    .child(
                        Button::new("seasonal-replenishment-search")
                            .outline()
                            .small()
                            .label("搜索")
                            .on_click(move |_, _window, cx| {
                                let Some(entity) = keyword_entity.clone() else {
                                    return;
                                };
                                view_for_search.update(cx, |this, cx| {
                                    let value = entity.read(cx).value().trim().to_string();
                                    this.apply_keyword(value, cx);
                                });
                            }),
                    ),
            )
        })
        // 「去年同期」开关（对齐 web Switch + 「去年」label）
        .child(
            Button::new("seasonal-replenishment-compare")
                .outline()
                .small()
                .selected(compare_year)
                .label(if compare_year { "去年同期：开" } else { "去年同期：关" })
                .on_click(move |_, _window, cx| {
                    view_for_compare.update(cx, |this, cx| this.toggle_compare_year(cx));
                }),
        )
        .child(div().flex_1())
        .child(
            Button::new("seasonal-replenishment-refresh")
                .outline()
                .small()
                .label("刷新重算")
                .on_click(move |_, _window, cx| {
                    view_for_refresh.update(cx, |this, cx| this.reload(cx));
                }),
        )
}

// ---------------------------------------------------------------------------
// 统计卡（SKU 总数 / 总店铺库存 / 总在途库存 / 有销量 SKU / 待补数据）
// ---------------------------------------------------------------------------

/// 5 张统计卡（对齐 web `statBarItems`；待补数据有量时数值标红）
fn stat_band(app_theme: &AppTheme, summary: &SeasonalReplenishmentSummary) -> impl IntoElement {
    let pending_color = if summary.pending_data_count > 0 {
        Some(app_theme.danger)
    } else {
        None
    };

    h_flex()
        .id("seasonal-replenishment-stats")
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
                "总店铺库存",
                fmt_num_precise(summary.total_available_inventory),
                None,
            ),
            stat_card(
                app_theme,
                Icon::empty().path("icons/truck.svg"),
                "总在途库存",
                fmt_num_precise(summary.total_in_transit_quantity),
                None,
            ),
            stat_card(
                app_theme,
                Icon::new(IconName::CircleCheck),
                "有销量 SKU",
                fmt_num_precise(summary.healthy_count),
                None,
            ),
            stat_card(
                app_theme,
                Icon::new(IconName::TriangleAlert),
                "待补数据",
                fmt_num_precise(summary.pending_data_count),
                pending_color,
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
// 季节性补货主表卡（P5-0 DataTable + 合计条）
// ---------------------------------------------------------------------------

/// 主表卡：标题（季节性补货主表 + 窗口副标题）+ 表格 + 合计条
fn table_card(
    app_theme: &AppTheme,
    table: Option<Entity<DataTable<SeasonalReplenishmentItem>>>,
    resp: &SeasonalReplenishmentResponse,
    compare_year: bool,
) -> impl IntoElement {
    v_flex()
        .id("seasonal-replenishment-table-card")
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
                        .child("季节性补货主表"),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(app_theme.text_muted)
                        .child(format!(
                            "{} ~ {} · {} 个 SKU{} · 主窗口右端 = to_date，4 个窗口向左回溯",
                            resp.from_date,
                            resp.to_date,
                            fmt_num_precise(resp.total),
                            if compare_year { " · 含去年同期" } else { "" }
                        )),
                ),
        )
        .when_some(table, |this, table| this.child(table))
        .child(totals_footer(app_theme, &resp.items, compare_year))
}

/// 合计条（对齐 web 合计行数值口径：当前页可见行的店铺库存 / 在途 / 各窗口
/// DMS / 加权 DMS / 预计数量求和；可售天数与售卖截止不合计）
fn totals_footer(
    app_theme: &AppTheme,
    rows: &[SeasonalReplenishmentItem],
    compare_year: bool,
) -> impl IntoElement {
    let sum_int = |f: fn(&SeasonalReplenishmentItem) -> i64| -> i64 { rows.iter().map(f).sum() };
    let sum_opt = |f: fn(&SeasonalReplenishmentItem) -> Option<f64>| -> f64 {
        rows.iter().filter_map(f).sum()
    };

    let mut totals: Vec<(String, String)> = vec![
        (
            "店铺库存".to_string(),
            fmt_num_precise(sum_int(|r| r.available_inventory)),
        ),
        (
            "在途".to_string(),
            fmt_num_precise(sum_int(|r| r.in_transit_quantity)),
        ),
        ("90D".to_string(), format!("{:.4}", sum_opt(|r| r.dms_90))),
        ("30D".to_string(), format!("{:.4}", sum_opt(|r| r.dms_30))),
        ("14D".to_string(), format!("{:.4}", sum_opt(|r| r.dms_14))),
        ("7D".to_string(), format!("{:.4}", sum_opt(|r| r.dms_7))),
    ];
    if compare_year {
        totals.push((
            "90D 同比".to_string(),
            format!("{:.4}", sum_opt(|r| r.dms_90_yoy)),
        ));
        totals.push((
            "30D 同比".to_string(),
            format!("{:.4}", sum_opt(|r| r.dms_30_yoy)),
        ));
        totals.push((
            "14D 同比".to_string(),
            format!("{:.4}", sum_opt(|r| r.dms_14_yoy)),
        ));
        totals.push((
            "7D 同比".to_string(),
            format!("{:.4}", sum_opt(|r| r.dms_7_yoy)),
        ));
    }
    totals.push(("DMS".to_string(), format!("{:.4}", sum_opt(|r| r.base_dms))));
    totals.push((
        "加权DMS".to_string(),
        format!("{:.2}", sum_opt(|r| r.weighted_dms)),
    ));
    totals.push((
        "预计数量".to_string(),
        fmt_num_precise(sum_int(|r| r.estimated_replenishment_quantity.unwrap_or(0))),
    ));

    h_flex()
        .id("seasonal-replenishment-totals")
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

/// 口径说明卡（对齐 web「口径说明」区块的精简版：窗口 / 权重 / 同比 / 风险状态）
fn caliber_note(app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("seasonal-replenishment-caliber")
        .w_full()
        .gap_2()
        .px_4()
        .py_3()
        .rounded(px(app_theme.radius_lg))
        .border_1()
        .border_color(app_theme.separator)
        .bg(app_theme.muted_fill)
        .child(
            div()
                .text_sm()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(app_theme.text_primary)
                .child("口径说明"),
        )
        .child(
            div()
                .text_xs()
                .text_color(app_theme.text_secondary)
                .child(
                    "选定的日期区间是历史回看窗口：主窗口右端 = to_date，4 个 DMS 分别向前回溯 \
                     90/30/14/7 天（双闭区间）；加权 DMS = 90D×40% + 30D×30% + 14D×20% + \
                     7D×10%（长周期高权重，任一窗口缺失按可用窗口重新归一化）。",
                ),
        )
        .child(
            div()
                .text_xs()
                .text_color(app_theme.text_secondary)
                .child(
                    "开启「去年同期」后额外计算去年同期窗口（右端 = to_date - 365）：同比单元格 \
                     当前 < 去年 → 红（下滑预警），当前 > 去年 → 绿（爬坡预警）。季节性页面不判定 \
                     风险状态，请基于售卖截止 / 含在途截止 / 预计补货数量自行决策。",
                ),
        )
}

// ---------------------------------------------------------------------------
// 表格列定义（基础 14 列 + 可选 4 同比列）
// ---------------------------------------------------------------------------

/// 同比单元格（数值 + 方向色：下滑 → danger / 爬坡 → success / 中性 → 次级文字）
fn yoy_cell(current: Option<f64>, yoy: Option<f64>, theme: &AppTheme) -> AnyElement {
    let color = match yoy_direction(current, yoy) {
        YoyDirection::Down => theme.danger,
        YoyDirection::Up => theme.success,
        YoyDirection::Neutral => theme.text_secondary,
    };
    div()
        .text_right()
        .text_color(color)
        .child(fmt_opt_num(yoy))
        .into_any_element()
}

/// 基础 14 列 + 可选 4 同比列的列定义（对齐 web 表头顺序：SKU / 产品名称 /
/// 店铺库存 / 在途 / 90D / 30D / 14D / 7D / [同比×4] / DMS / 加权DMS /
/// 可售天数 / 售卖截止 / 含在途截止 / 预计数量）。
pub fn seasonal_columns(has_yoy: bool) -> Vec<ColumnDef<SeasonalReplenishmentItem>> {
    let mut columns = vec![
        ColumnDef::text(
            "seasonal-sku",
            "SKU",
            |r: &SeasonalReplenishmentItem, _| SharedString::from(r.sku.clone()),
        )
        .width(140.0),
        ColumnDef::text(
            "seasonal-product",
            "产品名称",
            |r: &SeasonalReplenishmentItem, _| {
                SharedString::from(r.product_name.clone().unwrap_or_else(|| "--".to_string()))
            },
        )
        .width(200.0),
        ColumnDef::number(
            "seasonal-available",
            "店铺库存",
            |r: &SeasonalReplenishmentItem| r.available_inventory as f64,
            |r: &SeasonalReplenishmentItem, _| fmt_num_precise(r.available_inventory).into(),
        )
        .width(92.0),
        ColumnDef::number(
            "seasonal-in-transit",
            "在途",
            |r: &SeasonalReplenishmentItem| r.in_transit_quantity as f64,
            |r: &SeasonalReplenishmentItem, _| fmt_num_precise(r.in_transit_quantity).into(),
        )
        .width(80.0),
        ColumnDef::number(
            "seasonal-dms-90",
            "90D",
            |r: &SeasonalReplenishmentItem| r.dms_90.unwrap_or(0.0),
            |r: &SeasonalReplenishmentItem, _| fmt_opt_num(r.dms_90).into(),
        )
        .width(72.0),
        ColumnDef::number(
            "seasonal-dms-30",
            "30D",
            |r: &SeasonalReplenishmentItem| r.dms_30.unwrap_or(0.0),
            |r: &SeasonalReplenishmentItem, _| fmt_opt_num(r.dms_30).into(),
        )
        .width(72.0),
        ColumnDef::number(
            "seasonal-dms-14",
            "14D",
            |r: &SeasonalReplenishmentItem| r.dms_14.unwrap_or(0.0),
            |r: &SeasonalReplenishmentItem, _| fmt_opt_num(r.dms_14).into(),
        )
        .width(72.0),
        ColumnDef::number(
            "seasonal-dms-7",
            "7D",
            |r: &SeasonalReplenishmentItem| r.dms_7.unwrap_or(0.0),
            |r: &SeasonalReplenishmentItem, _| fmt_opt_num(r.dms_7).into(),
        )
        .width(72.0),
    ];

    if has_yoy {
        columns.push(
            ColumnDef::text(
                "seasonal-dms-90-yoy",
                "90D 同比",
                |_: &SeasonalReplenishmentItem, _| SharedString::from(""),
            )
            .align(CellAlign::Right)
            .width(88.0)
            .with_render_element(|r: &SeasonalReplenishmentItem, theme: &AppTheme| {
                yoy_cell(r.dms_90, r.dms_90_yoy, theme)
            }),
        );
        columns.push(
            ColumnDef::text(
                "seasonal-dms-30-yoy",
                "30D 同比",
                |_: &SeasonalReplenishmentItem, _| SharedString::from(""),
            )
            .align(CellAlign::Right)
            .width(88.0)
            .with_render_element(|r: &SeasonalReplenishmentItem, theme: &AppTheme| {
                yoy_cell(r.dms_30, r.dms_30_yoy, theme)
            }),
        );
        columns.push(
            ColumnDef::text(
                "seasonal-dms-14-yoy",
                "14D 同比",
                |_: &SeasonalReplenishmentItem, _| SharedString::from(""),
            )
            .align(CellAlign::Right)
            .width(88.0)
            .with_render_element(|r: &SeasonalReplenishmentItem, theme: &AppTheme| {
                yoy_cell(r.dms_14, r.dms_14_yoy, theme)
            }),
        );
        columns.push(
            ColumnDef::text(
                "seasonal-dms-7-yoy",
                "7D 同比",
                |_: &SeasonalReplenishmentItem, _| SharedString::from(""),
            )
            .align(CellAlign::Right)
            .width(88.0)
            .with_render_element(|r: &SeasonalReplenishmentItem, theme: &AppTheme| {
                yoy_cell(r.dms_7, r.dms_7_yoy, theme)
            }),
        );
    }

    columns.push(
        ColumnDef::number(
            "seasonal-base-dms",
            "DMS",
            |r: &SeasonalReplenishmentItem| r.base_dms.unwrap_or(0.0),
            |r: &SeasonalReplenishmentItem, _| fmt_opt_num(r.base_dms).into(),
        )
        .width(80.0),
    );
    columns.push(
        ColumnDef::number(
            "seasonal-weighted-dms",
            "加权DMS",
            |r: &SeasonalReplenishmentItem| r.weighted_dms.unwrap_or(0.0),
            |r: &SeasonalReplenishmentItem, _| fmt_opt_num(r.weighted_dms).into(),
        )
        .width(88.0),
    );
    columns.push(
        ColumnDef::number(
            "seasonal-sellable-days",
            "可售天数",
            |r: &SeasonalReplenishmentItem| r.sellable_days.unwrap_or(0.0),
            |r: &SeasonalReplenishmentItem, _| fmt_opt_num(r.sellable_days).into(),
        )
        .width(88.0),
    );
    columns.push(
        ColumnDef::text(
            "seasonal-sellout-date",
            "售卖截止",
            |r: &SeasonalReplenishmentItem, _| {
                SharedString::from(fmt_opt_date(r.sellout_date.as_deref()))
            },
        )
        .width(104.0),
    );
    columns.push(
        ColumnDef::text(
            "seasonal-sellout-transit",
            "含在途截止",
            |r: &SeasonalReplenishmentItem, _| {
                SharedString::from(fmt_opt_date(r.sellout_date_with_transit.as_deref()))
            },
        )
        .width(104.0),
    );
    columns.push(
        ColumnDef::number(
            "seasonal-est-qty",
            "预计数量",
            |r: &SeasonalReplenishmentItem| r.estimated_replenishment_quantity.unwrap_or(0) as f64,
            |r: &SeasonalReplenishmentItem, _| {
                fmt_opt_int(r.estimated_replenishment_quantity).into()
            },
        )
        .width(92.0),
    );
    columns
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

    fn sample_summary() -> SeasonalReplenishmentSummary {
        SeasonalReplenishmentSummary {
            sku_count: 2,
            out_of_stock_risk_count: 0,
            healthy_count: 1,
            slow_moving_count: 0,
            pending_data_count: 1,
            total_available_inventory: 100,
            total_in_transit_quantity: 50,
        }
    }

    fn sample_item(sku: &str) -> SeasonalReplenishmentItem {
        SeasonalReplenishmentItem {
            project_id: 1,
            project_name: "测试项目 A".into(),
            sku: sku.into(),
            country: "US".into(),
            asin: Some("B0TEST".into()),
            product_name: Some("测试产品".into()),
            available_inventory: 100,
            in_transit_quantity: 50,
            dms_90: Some(1.5),
            dms_30: Some(2.0),
            dms_14: Some(2.5),
            dms_7: Some(3.0),
            dms_90_yoy: Some(1.2),
            dms_30_yoy: Some(2.4),
            dms_14_yoy: None,
            dms_7_yoy: Some(3.0),
            base_dms: Some(1.85),
            weighted_dms: Some(2.4),
            sellable_days: Some(41.67),
            sellout_date: Some("2026-09-26".into()),
            sellout_date_with_transit: Some("2026-10-17".into()),
            production_lead_days: 30,
            shipping_days: 35,
            estimated_replenishment_quantity: Some(156),
        }
    }

    fn sample_response(compare_year_offset: i64) -> SeasonalReplenishmentResponse {
        SeasonalReplenishmentResponse {
            items: vec![sample_item("SKU-A"), sample_item("SKU-B")],
            summary: sample_summary(),
            page: 1,
            page_size: 200,
            total: 2,
            has_next: false,
            from_date: NaiveDate::from_ymd_opt(2026, 5, 18).expect("合法日期"),
            to_date: NaiveDate::from_ymd_opt(2026, 8, 15).expect("合法日期"),
            compare_year_offset,
        }
    }

    fn sample_payload(compare_year_offset: i64) -> SeasonalPayload {
        SeasonalPayload {
            projects: sample_projects(),
            response: sample_response(compare_year_offset),
        }
    }

    // ---------- 纯函数契约 ----------

    /// 站点 label（backend 严格模式无 ALL）
    #[test]
    fn country_label_matches_frontend() {
        assert_eq!(country_label("US"), "美国站 (US)");
        assert_eq!(country_label("DE"), "德国站 (DE)");
        assert_eq!(country_label("UK"), "英国站 (UK)");
        assert_eq!(country_label("XX"), "XX");
    }

    /// 数值 / 整数 / 日期格式化（对齐 web formatNumber / formatInt / formatDate）
    #[test]
    fn formatters_match_frontend() {
        assert_eq!(fmt_opt_num(Some(1.5)), "1.50");
        assert_eq!(fmt_opt_num(None), "--");
        assert_eq!(fmt_opt_int(Some(1234)), "1,234");
        assert_eq!(fmt_opt_int(None), "--");
        assert_eq!(fmt_opt_date(Some("2026-09-26")), "2026-09-26");
        assert_eq!(fmt_opt_date(None), "--");
        assert_eq!(fmt_opt_date(Some("")), "--");
    }

    /// 同比方向判定（对齐 web yoyDeltaClass：下滑红 / 爬坡绿 / 缺失或相等中性）
    #[test]
    fn yoy_direction_matches_frontend() {
        assert_eq!(
            yoy_direction(Some(1.0), Some(2.0)),
            YoyDirection::Down,
            "当前 < 去年 → 下滑"
        );
        assert_eq!(
            yoy_direction(Some(3.0), Some(2.0)),
            YoyDirection::Up,
            "当前 > 去年 → 爬坡"
        );
        assert_eq!(yoy_direction(Some(2.0), Some(2.0)), YoyDirection::Neutral);
        assert_eq!(yoy_direction(Some(2.0), Some(0.0)), YoyDirection::Neutral);
        assert_eq!(yoy_direction(None, Some(2.0)), YoyDirection::Neutral);
        assert_eq!(yoy_direction(Some(2.0), None), YoyDirection::Neutral);
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
        let mut no_projects = sample_payload(0);
        no_projects.projects = Vec::new();
        assert_eq!(
            SeasonalState::from_fetch_result(Ok(no_projects)),
            SeasonalState::Empty
        );
        assert_eq!(
            SeasonalState::from_fetch_result(Ok(sample_payload(0))),
            SeasonalState::Loaded(Box::new(sample_payload(0)))
        );
        assert_eq!(
            SeasonalState::from_fetch_result(Err("boom".into())),
            SeasonalState::Error("boom".into())
        );
    }

    /// 列定义契约：基础 14 列；开启同比 → 18 列（4 同比列插在 7D 之后）；id 唯一
    #[test]
    fn seasonal_columns_base_and_yoy() {
        let base = seasonal_columns(false);
        assert_eq!(base.len(), 14);
        let with_yoy = seasonal_columns(true);
        assert_eq!(with_yoy.len(), 18);
        // 同比列位置：90D/30D/14D/7D 之后（索引 8..12），DMS 之前
        assert_eq!(with_yoy[8].id, "seasonal-dms-90-yoy");
        assert_eq!(with_yoy[11].id, "seasonal-dms-7-yoy");
        assert_eq!(with_yoy[12].id, "seasonal-base-dms");
        // id 唯一（gpui element id 要求）
        let ids: Vec<&str> = with_yoy.iter().map(|c| c.id.as_str()).collect();
        let mut uniq = ids.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(ids.len(), uniq.len(), "列 id 必须唯一");
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
                SeasonalReplenishmentView::new(cx, Client::new("http://127.0.0.1:1"));
            view.reload(cx);
            view
        });
    }

    /// 渲染冒烟：深色主题 + Loaded 态（直接注入载荷 + 表格，覆盖筛选栏 / 统计卡 /
    /// 主表 / 合计条 / 口径说明）
    #[gpui::test]
    async fn view_renders_loaded_in_dark_mode(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            SeasonalReplenishmentView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let payload = sample_payload(0);
            this.sync_table(&payload.response, cx);
            this.state.update(cx, |state, _| {
                *state = SeasonalState::Loaded(Box::new(payload));
            });
        });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    /// 渲染冒烟：Loaded 态 + 同比列（compare_year_offset=1 → 18 列表格可渲染）
    #[gpui::test]
    async fn view_renders_loaded_with_yoy_columns(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            SeasonalReplenishmentView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let payload = sample_payload(1);
            this.compare_year = true;
            this.sync_table(&payload.response, cx);
            this.state.update(cx, |state, _| {
                *state = SeasonalState::Loaded(Box::new(payload));
            });
            assert!(this.table_has_yoy);
        });
    }

    /// 渲染冒烟：减弱动态偏好下 Loaded 态可渲染（无动画路径）
    #[gpui::test]
    async fn view_renders_loaded_with_reduce_motion(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            cx.set_global(crate::motion::MotionPref(true));
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            SeasonalReplenishmentView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let payload = sample_payload(0);
            this.sync_table(&payload.response, cx);
            this.state.update(cx, |state, _| {
                *state = SeasonalState::Loaded(Box::new(payload));
            });
        });
    }

    /// 渲染冒烟：空态（无项目 → 「暂无可用项目」+ 刷新按钮）可渲染
    #[gpui::test]
    async fn view_renders_empty_state(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            SeasonalReplenishmentView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = SeasonalState::Empty;
            });
        });
    }

    /// 渲染冒烟：有项目但明细为空 → Loaded（表格内空态文案兜底，筛选栏可见）
    #[gpui::test]
    async fn view_renders_loaded_with_empty_items(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            SeasonalReplenishmentView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let mut payload = sample_payload(0);
            payload.response.items = Vec::new();
            this.sync_table(&payload.response, cx);
            this.state.update(cx, |state, _| {
                *state = SeasonalState::Loaded(Box::new(payload));
            });
        });
    }

    /// 筛选动作：同比开关翻转 + 关键字应用（no-op 语义 + 状态落点）
    #[gpui::test]
    async fn filter_actions_update_state(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            SeasonalReplenishmentView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            assert!(!this.compare_year);
            this.toggle_compare_year(cx);
            assert!(this.compare_year);
            this.apply_keyword("SKU-A".into(), cx);
            assert_eq!(this.applied_keyword, "SKU-A");
            // 同一关键字 no-op（request_id 不再递增）
            let before = this.latest_request_id;
            this.apply_keyword("SKU-A".into(), cx);
            assert_eq!(this.latest_request_id, before);
        });
    }
}
