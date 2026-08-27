//! 报表中心 → 订单信息（P5-4，BLF-731）
//!
//! 对齐 web 端 `app/dashboard/reports/order-info`（约 1451 行）的读取主面：
//! 筛选（店铺/订单类型/订单状态/国家/币种/订单号/日期区间/SKU/ASIN）+
//! 统计带（订单数/总数量/总金额/FBA/FBM 行数）+ 订单分页列表（单请求
//! `/overview` 一次拿列表+统计，对齐 web BEL-422 后口径）。
//!
//! ## 与 web 端的取舍（issue 允许按 macOS 原生习惯精简并说明）
//!
//! - **保留**：九项筛选、统计带、11 列表格（下单时间北京时间+PT、订单号+复制、
//!   SKU/ASIN、产品、数量、金额、收货地、店铺、类型徽标、状态徽标、FBM 物流）、
//!   分页（50/页，对齐 web `PAGE_SIZE`）、默认近 7 天（PT）、首屏自动选中第一个店铺
//!   （对齐 web `initialProjectAutoselected`，避免默认全店铺慢查询）；
//! - **精简**：
//!   - FBM 补录编辑（PATCH 写入链路）与 CSV 导出走 web 端
//!     （对齐 BLF-726 发货管理「写入走 web 端」取舍；api-client 侧
//!     `order_info_update` / `order_info_export` 方法已就绪）；
//!   - 订单类型/状态/国家/币种多选（MultiSelect）→ 单选下拉（P5-0 filter_select
//!     能力边界）；关键字 250ms debounce → 回车/「搜索」按钮提交（对齐
//!     new_product_calculation 搜索交互）；
//!   - 数量/金额排序用 DataTable 客户端排序（当前页内）；服务端排序保持
//!     `purchase_at_pt desc` 默认（api-client 锁定，与 web 默认一致）；
//!   - 筛选选项（状态/币种）首屏后台并行拉取不阻塞列表（对齐 web BEL-422
//!     「按需加载不阻塞首屏」语义；失败静默降级为仅「全部」选项）。
//!
//! ## 状态机
//!
//! `Loading`（首屏 / 筛选切换 / 换页）→ `Loaded`（有数据）/ `Empty`（列表空，
//! 三档提示：无可见店铺 / 筛选无结果 / 暂无数据）/ `Error`（请求失败）。

use gpui::prelude::*;
use gpui::{
    div, px, App, AsyncApp, ClipboardItem, Context, Entity, FontWeight, IntoElement, Render,
    SharedString, WeakEntity, Window,
};
use gpui_component::button::Button;
use gpui_component::input::{Input, InputEvent, InputState};
use gpui_component::menu::PopupMenuItem;
use gpui_component::{h_flex, v_flex, Icon, Sizable};
use gui_api_client::order_info::OrderInfoFilter;
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::order_info::{
    country_label, order_status_label, OrderInfoFilterOptions, OrderInfoItem, OrderInfoOverview,
    COUNTRY_FILTER_OPTIONS,
};

use crate::theme::AppTheme;
use crate::widgets::data_grid::{grid_footer_bar, pattern_a_shell, AggregateItem};

use crate::widgets::data_table::{ColumnDef, DataTable};
use crate::widgets::date_range::{DateRange, DateRangeEvent, DateRangePickerState};
use crate::widgets::filter_bar;
use crate::widgets::filter_bar::toolbar_spacer;
use crate::widgets::page_header::PageHeader;
use crate::widgets::pagination::PageState;
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「报表中心 → 订单信息」URL（数据权威 gui-domain::sidebar）
pub const ORDER_INFO_URL: &str = "/dashboard/reports/order-info";

/// 默认每页行数（对齐 web `PAGE_SIZE = 50`）
const DEFAULT_PAGE_SIZE: usize = 50;

/// 默认日期窗口：近 7 天（含今天，PT 口径；对齐 web `defaultLast7Days`）
const DEFAULT_DATE_DAYS: u64 = 7;

/// 订单类型筛选选项（Amazon 原始值 → 展示标签；对齐 web fulfillment_channel）
const FULFILLMENT_OPTIONS: [(&str, &str); 2] = [
    ("Amazon", "FBA（亚马逊配送）"),
    ("Merchant", "FBM（自发货配送）"),
];

// ---------------------------------------------------------------------------
// 格式化 / 派生辅助
// ---------------------------------------------------------------------------

/// 千分位整数（与 shipment_management 同款实现）
fn fmt_int(value: i64) -> String {
    let negative = value < 0;
    let int_str = value.unsigned_abs().to_string();
    let mut out = String::with_capacity(int_str.len() + int_str.len() / 3 + 1);
    for (i, ch) in int_str.chars().enumerate() {
        if i > 0 && (int_str.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    if negative {
        out.insert(0, '-');
    }
    out
}

/// 千分位小数（固定位数；负数保留符号）
fn fmt_fixed(value: f64, decimals: u32) -> String {
    let factor = 10f64.powi(decimals as i32);
    let negative = value < 0.0;
    let scaled = (value.abs() * factor).round() as u64;
    let int_part = scaled / (factor as u64);
    let frac_part = scaled % (factor as u64);
    if decimals == 0 {
        let mut out = fmt_int(int_part as i64);
        if negative {
            out.insert(0, '-');
        }
        return out;
    }
    let int_str = fmt_int(int_part as i64);
    format!(
        "{}{}.{:0width$}",
        if negative { "-" } else { "" },
        int_str,
        frac_part,
        width = decimals as usize
    )
}

/// UTC ISO8601 → 北京时间（+08:00）`YYYY-MM-DD HH:MM`（对齐 web `formatBeijingTime`；
/// 解析失败 / 空 → 「—」）
fn beijing_time(iso_utc: &str) -> String {
    if iso_utc.trim().is_empty() {
        return "—".to_string();
    }
    chrono::DateTime::parse_from_rfc3339(iso_utc)
        .map(|dt| {
            let beijing =
                dt.with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).expect("固定偏移"));
            beijing.format("%Y-%m-%d %H:%M").to_string()
        })
        .unwrap_or_else(|_| "—".to_string())
}

/// PT naive datetime ISO → `YYYY-MM-DD`（对齐 web `formatLocalDate`：仅取日期段，
/// 不做时区换算；空 → 「—」）
fn pt_date(iso_pt: &str) -> String {
    let date = iso_pt.split('T').next().unwrap_or("").trim();
    if date.is_empty() {
        "—".to_string()
    } else {
        date.to_string()
    }
}

/// 收货地址串（city, state, postal_code, 中文站点名；对齐 web `fullAddress`）
fn full_address(item: &OrderInfoItem) -> String {
    let parts = [
        item.city.as_deref().filter(|s| !s.trim().is_empty()),
        item.state.as_deref().filter(|s| !s.trim().is_empty()),
        item.postal_code.as_deref().filter(|s| !s.trim().is_empty()),
    ];
    let mut out = parts.into_iter().flatten().collect::<Vec<_>>().join(", ");
    let country = country_label(&item.country);
    if !out.is_empty() {
        out.push_str(", ");
    }
    out.push_str(&country);
    out
}

/// 可空文本兜底（None / 空白 → 「—」）
fn text_or_dash(value: &Option<String>) -> String {
    value
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "—".to_string())
}

/// 状态徽标配色（Shipped/Shipping = 强调 / Cancelled = 危险 / 其余中性；
/// 对齐 web `statusVariant` 语义）
fn status_pill_colors(status: &str, theme: &AppTheme) -> (gpui::Hsla, gpui::Hsla) {
    let s = status.to_ascii_lowercase();
    if s.contains("cancel") {
        (theme.danger_soft, theme.danger)
    } else if s.contains("shipp") {
        (theme.accent_soft, theme.accent)
    } else {
        (theme.muted_fill, theme.text_secondary)
    }
}

/// 状态徽标单元格（软底 + 描边，对齐 shipment_management `status_pill` 观感）
fn status_pill(item: &OrderInfoItem, theme: &AppTheme) -> gpui::AnyElement {
    let (bg, fg) = status_pill_colors(&item.order_status, theme);
    h_flex()
        .items_center()
        .gap_1()
        .rounded_full()
        .border_1()
        .border_color(fg.opacity(0.35))
        .bg(bg)
        .px_2()
        .py_0p5()
        .child(
            div()
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                // 转 owned：AnyElement 要求 'static，标签借用不能逃逸
                .child(order_status_label(&item.order_status).to_string()),
        )
        .into_any_element()
}

/// 订单类型徽标（FBA = 强调 / FBM = 中性；对齐 web `fulfillmentVariant`）
fn fulfillment_pill(item: &OrderInfoItem, theme: &AppTheme) -> gpui::AnyElement {
    let (bg, fg) = if item.is_fbm() {
        (theme.muted_fill, theme.text_secondary)
    } else {
        (theme.accent_soft, theme.accent)
    };
    h_flex()
        .items_center()
        .rounded_full()
        .border_1()
        .border_color(fg.opacity(0.35))
        .bg(bg)
        .px_2()
        .py_0p5()
        .child(
            div()
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                .child(item.fulfillment_label.clone()),
        )
        .into_any_element()
}

// ---------------------------------------------------------------------------
// 载荷 / 状态机
// ---------------------------------------------------------------------------

/// 订单信息载荷（Loaded 持有）
#[derive(Debug, Clone, PartialEq)]
pub struct OrderInfoData {
    /// 项目列表（店铺筛选下拉数据源；reload 间缓存）
    pub projects: Vec<ManagedProject>,
    /// 当前筛选 + 分页下的列表 + 统计（单请求 `/overview`）
    pub overview: OrderInfoOverview,
    /// 首屏自动选中的店铺（仅首次拉取项目列表时产生；`None` = 未触发）
    pub autoselected_project: Option<i64>,
}

impl OrderInfoData {
    /// 空态判定：列表为空
    pub fn is_empty(&self) -> bool {
        self.overview.items.is_empty()
    }
}

/// 订单信息状态机（四态；沿用既有 view 模式）
#[derive(Debug, Clone, PartialEq)]
pub enum OrderInfoState {
    Loading,
    Loaded(Box<OrderInfoData>),
    Empty,
    Error(String),
}

impl OrderInfoState {
    /// 拉取结果 → 落点状态
    pub fn from_fetch_result(result: Result<OrderInfoData, String>) -> Self {
        match result {
            Ok(data) if data.is_empty() => Self::Empty,
            Ok(data) => Self::Loaded(Box::new(data)),
            Err(msg) => Self::Error(msg),
        }
    }
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// 订单信息视图（四态状态机 + 九项筛选 + 统计带 + 分页 + 竞态保护）
pub struct OrderInfoView {
    state: Entity<OrderInfoState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表缓存（店铺筛选下拉数据源；首次 reload 拉取后复用）
    projects: Vec<ManagedProject>,
    /// 店铺筛选（`None` = 全部店铺）
    project_filter: Option<i64>,
    /// 订单类型筛选（`None` = 全部；`Amazon` / `Merchant`）
    fulfillment_filter: Option<&'static str>,
    /// 订单状态筛选（`None` = 全部；选项来自 filter-options）
    status_filter: Option<String>,
    /// 国家筛选（`None` = 全部）
    country_filter: Option<&'static str>,
    /// 币种筛选（`None` = 全部；选项来自 filter-options）
    currency_filter: Option<String>,
    /// 日期区间（purchase_date_pt，PT 口径；默认近 7 天）
    date_range: DateRange,
    /// 日期区间选择器（Stage 0 公共组件）
    date_picker: Entity<DateRangePickerState>,
    /// 订单号 / SKU / ASIN 关键字输入（懒建；`InputState::new` 需要 window）
    order_id_input: Option<Entity<InputState>>,
    sku_input: Option<Entity<InputState>>,
    asin_input: Option<Entity<InputState>>,
    /// 已提交关键字（回车 / 「搜索」按钮落定；与输入框值解耦）
    committed_order_id: String,
    committed_sku: String,
    committed_asin: String,
    /// 「清空筛选」后待回填的输入清空动作（set_value 需要 window，render 期应用）
    pending_inputs_reset: bool,
    /// 筛选选项（状态 / 币种下拉数据源；首屏后台拉取，失败静默降级）
    filter_options: Option<OrderInfoFilterOptions>,
    filter_options_loading: bool,
    /// 筛选选项请求竞态保护
    latest_filter_options_request: u64,
    /// 首屏自动选中第一个店铺（对齐 web `initialProjectAutoselected`，仅一次）
    auto_select_done: bool,
    /// 当前页（1 起）
    page: usize,
    /// 每页行数（固定 50，对齐 web）
    page_size: usize,
    /// 主请求竞态保护
    latest_request_id: u64,
    /// 订单表（Stage 0 DataTable，总存在）
    table: Entity<DataTable<OrderInfoItem>>,
    /// 订阅持有（drop 即断）
    _subscriptions: Vec<gpui::Subscription>,
}

impl OrderInfoView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| OrderInfoState::Loading);
        let table = cx.new(|_| {
            DataTable::new("order-info-table", order_columns())
                .striped(true)
                .empty_text("当前筛选条件下暂无订单")
        });
        // 默认近 7 天（PT 口径；对齐 web `defaultLast7Days`）
        let today = chrono::Utc::now().date_naive();
        let date_range = DateRange::last_days(DEFAULT_DATE_DAYS, today);
        let date_picker = cx.new(|cx| {
            let mut picker = DateRangePickerState::new(cx);
            picker.set_range(date_range);
            picker
        });
        let picker_sub = cx.subscribe(&date_picker, |this, _entity, ev, cx| {
            let DateRangeEvent::Change(range) = ev;
            this.apply_date_range(*range, cx);
        });
        Self {
            state,
            client,
            projects: Vec::new(),
            project_filter: None,
            fulfillment_filter: None,
            status_filter: None,
            country_filter: None,
            currency_filter: None,
            date_range,
            date_picker,
            order_id_input: None,
            sku_input: None,
            asin_input: None,
            committed_order_id: String::new(),
            committed_sku: String::new(),
            committed_asin: String::new(),
            pending_inputs_reset: false,
            filter_options: None,
            filter_options_loading: false,
            latest_filter_options_request: 0,
            auto_select_done: false,
            page: 1,
            page_size: DEFAULT_PAGE_SIZE,
            latest_request_id: 0,
            table,
            _subscriptions: vec![picker_sub],
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> OrderInfoState {
        self.state.read(cx).clone()
    }

    /// 组装当前筛选（overview 口径；关键字取已提交值）
    fn build_filter(&self) -> OrderInfoFilter {
        OrderInfoFilter {
            project_ids: self.project_filter.map(|id| vec![id]).unwrap_or_default(),
            fulfillment_channels: self
                .fulfillment_filter
                .map(|c| vec![c.to_string()])
                .unwrap_or_default(),
            order_statuses: self
                .status_filter
                .clone()
                .filter(|s| !s.is_empty())
                .map(|s| vec![s])
                .unwrap_or_default(),
            countries: self
                .country_filter
                .map(|c| vec![c.to_string()])
                .unwrap_or_default(),
            currencies: self
                .currency_filter
                .clone()
                .filter(|c| !c.is_empty())
                .map(|c| vec![c])
                .unwrap_or_default(),
            sku_keyword: Some(self.committed_sku.clone()).filter(|s| !s.is_empty()),
            order_id_keyword: Some(self.committed_order_id.clone()).filter(|s| !s.is_empty()),
            asin_keyword: Some(self.committed_asin.clone()).filter(|s| !s.is_empty()),
            date_from: self.date_range.from,
            date_to: self.date_range.to,
        }
    }

    /// 是否有任何筛选生效（空态三档提示用；对齐 web 判定口径）
    fn has_active_filters(&self) -> bool {
        self.project_filter.is_some()
            || self.fulfillment_filter.is_some()
            || self.status_filter.is_some()
            || self.country_filter.is_some()
            || self.currency_filter.is_some()
            || !self.committed_order_id.is_empty()
            || !self.committed_sku.is_empty()
            || !self.committed_asin.is_empty()
            || self.date_range.from.is_some()
            || self.date_range.to.is_some()
    }

    /// 重新拉取：首屏 / 筛选切换 / 换页 / 错误重试 / 空态刷新共用入口
    /// （竞态保护；每次调用递增 `latest_request_id` 并进入 Loading）。
    /// 筛选选项（状态 / 币种下拉）缺省时顺带后台拉取，不阻塞列表。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let filter = self.build_filter();
        let page = self.page as i64;
        let page_size = self.page_size as i64;
        let projects_cache = if self.projects.is_empty() {
            None
        } else {
            Some(self.projects.clone())
        };
        let auto_select = !self.auto_select_done;

        if self.filter_options.is_none() && !self.filter_options_loading {
            self.load_filter_options(cx);
        }

        self.state.update(cx, |state, cx| {
            *state = OrderInfoState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(load_main(
                        &client,
                        projects_cache,
                        filter,
                        page,
                        page_size,
                        auto_select,
                    ))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_main_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 应用主数据拉取结果（竞态保护）：落点项目缓存 + 首屏自动选中 + 表格行
    fn apply_main_result(
        &mut self,
        request_id: u64,
        result: Result<OrderInfoData, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        // 首屏自动选中只发生一次（成功失败都算完成，对齐 web 放行语义）
        self.auto_select_done = true;
        let next = OrderInfoState::from_fetch_result(result);
        if let OrderInfoState::Loaded(data) = &next {
            self.projects = data.projects.clone();
            if let Some(project_id) = data.autoselected_project {
                self.project_filter = Some(project_id);
            }
            self.table.update(cx, |t, cx| {
                t.set_rows(data.overview.items.clone(), cx);
            });
            self.page = data.overview.page.max(1) as usize;
        } else {
            self.table.update(cx, |t, cx| t.set_rows(Vec::new(), cx));
        }
        self.state.update(cx, |state, cx| {
            *state = next;
            cx.notify();
        });
    }

    /// 后台拉取筛选下拉选项（状态 / 币种；失败静默降级为仅「全部」，
    /// 对齐 web `ensureFilterOptions` 失败分支不弹错）
    fn load_filter_options(&mut self, cx: &mut Context<Self>) {
        self.latest_filter_options_request = self.latest_filter_options_request.wrapping_add(1);
        let request_id = self.latest_filter_options_request;
        self.filter_options_loading = true;

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(async { client.order_info_filter_options().await })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_filter_options(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 应用筛选选项拉取结果（竞态保护；失败静默——下拉仅保留「全部」）
    fn apply_filter_options(
        &mut self,
        request_id: u64,
        result: Result<OrderInfoFilterOptions, gui_api_client::error::ApiError>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_filter_options_request {
            return;
        }
        self.filter_options_loading = false;
        if let Ok(options) = result {
            self.filter_options = Some(options);
            cx.notify();
        }
    }

    /// 切换店铺筛选（同一店铺为 no-op；`None` = 全部店铺）
    pub fn select_project(&mut self, project_id: Option<i64>, cx: &mut Context<Self>) {
        if project_id == self.project_filter {
            return;
        }
        self.project_filter = project_id;
        self.page = 1;
        self.reload(cx);
    }

    /// 切换订单类型筛选（同一类型为 no-op；`None` = 全部）
    pub fn select_fulfillment(&mut self, channel: Option<&'static str>, cx: &mut Context<Self>) {
        if channel == self.fulfillment_filter {
            return;
        }
        self.fulfillment_filter = channel;
        self.page = 1;
        self.reload(cx);
    }

    /// 切换订单状态筛选（同一状态为 no-op；`None` = 全部）
    pub fn select_status(&mut self, status: Option<String>, cx: &mut Context<Self>) {
        if status == self.status_filter {
            return;
        }
        self.status_filter = status;
        self.page = 1;
        self.reload(cx);
    }

    /// 切换国家筛选（同一国家为 no-op；`None` = 全部）
    pub fn select_country(&mut self, country: Option<&'static str>, cx: &mut Context<Self>) {
        if country == self.country_filter {
            return;
        }
        self.country_filter = country;
        self.page = 1;
        self.reload(cx);
    }

    /// 切换币种筛选（同一币种为 no-op；`None` = 全部）
    pub fn select_currency(&mut self, currency: Option<String>, cx: &mut Context<Self>) {
        if currency == self.currency_filter {
            return;
        }
        self.currency_filter = currency;
        self.page = 1;
        self.reload(cx);
    }

    /// 应用日期区间（DateRangePicker 订阅回连；同一区间为 no-op）
    pub fn apply_date_range(&mut self, range: DateRange, cx: &mut Context<Self>) {
        if range == self.date_range {
            return;
        }
        self.date_range = range;
        self.page = 1;
        self.reload(cx);
    }

    /// 提交关键字（回车 / 「搜索」按钮）：读三个输入框当前值（trim），
    /// 任一变化才重拉（对齐 web committed 关键字语义）
    pub fn apply_keywords(&mut self, cx: &mut Context<Self>) {
        let read = |input: &Option<Entity<InputState>>, cx: &App| -> String {
            input
                .as_ref()
                .map(|input| input.read(cx).value().trim().to_string())
                .unwrap_or_default()
        };
        let order_id = read(&self.order_id_input, cx);
        let sku = read(&self.sku_input, cx);
        let asin = read(&self.asin_input, cx);
        if order_id == self.committed_order_id
            && sku == self.committed_sku
            && asin == self.committed_asin
        {
            return;
        }
        self.committed_order_id = order_id;
        self.committed_sku = sku;
        self.committed_asin = asin;
        self.page = 1;
        self.reload(cx);
    }

    /// 清空筛选（对齐 web `handleResetFilters`：全部条件复位，日期回默认近 7 天）
    pub fn clear_filters(&mut self, cx: &mut Context<Self>) {
        self.project_filter = None;
        self.fulfillment_filter = None;
        self.status_filter = None;
        self.country_filter = None;
        self.currency_filter = None;
        self.committed_order_id = String::new();
        self.committed_sku = String::new();
        self.committed_asin = String::new();
        let today = chrono::Utc::now().date_naive();
        self.date_range = DateRange::last_days(DEFAULT_DATE_DAYS, today);
        self.date_picker.update(cx, |picker, _cx| {
            picker.set_range(self.date_range);
        });
        self.pending_inputs_reset = true;
        self.page = 1;
        self.reload(cx);
    }

    /// 跳到指定页（同一页 / 0 页为 no-op）
    pub fn go_to_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if page == self.page || page == 0 {
            return;
        }
        self.page = page;
        self.reload(cx);
    }

    /// 切换每页行数（固定 50，守卫同值 no-op；保留入口对齐分页条契约）
    pub fn set_page_size(&mut self, size: usize, cx: &mut Context<Self>) {
        if size == self.page_size || size == 0 {
            return;
        }
        self.page_size = size;
        self.page = 1;
        self.reload(cx);
    }

    /// 懒建关键字输入（首帧；`InputState::new` 需要 window）+ 回车订阅
    fn ensure_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.order_id_input.is_none() {
            let input = cx.new(|cx| InputState::new(window, cx).placeholder("例如 111-3084457-…"));
            let sub = cx.subscribe(&input, |this, _entity, event: &InputEvent, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    this.apply_keywords(cx);
                }
            });
            self.order_id_input = Some(input);
            self._subscriptions.push(sub);
        }
        if self.sku_input.is_none() {
            let input = cx.new(|cx| InputState::new(window, cx).placeholder("例如 JDB-4341-29PCS"));
            let sub = cx.subscribe(&input, |this, _entity, event: &InputEvent, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    this.apply_keywords(cx);
                }
            });
            self.sku_input = Some(input);
            self._subscriptions.push(sub);
        }
        if self.asin_input.is_none() {
            let input = cx.new(|cx| InputState::new(window, cx).placeholder("例如 B0C12345"));
            let sub = cx.subscribe(&input, |this, _entity, event: &InputEvent, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    this.apply_keywords(cx);
                }
            });
            self.asin_input = Some(input);
            self._subscriptions.push(sub);
        }
        // 「清空筛选」的输入回填（set_value 需要 window，render 期应用）
        if self.pending_inputs_reset {
            self.pending_inputs_reset = false;
            for input in [&self.order_id_input, &self.sku_input, &self.asin_input]
                .into_iter()
                .flatten()
            {
                input.update(cx, |state, cx| state.set_value("", window, cx));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 数据加载辅助函数
// ---------------------------------------------------------------------------

/// 首屏自动选中决策（纯函数，便于单测）：仅当「首次拉取 + 筛选未指定店铺」时
/// 选中第一个店铺，避免默认「全部店铺」拉全量数据慢查询
/// （对齐 web `initialProjectAutoselected`；空列表放行）
fn resolve_autoselect(
    auto_select: bool,
    filter_has_project: bool,
    projects: &[ManagedProject],
) -> Option<i64> {
    if auto_select && !filter_has_project {
        projects.first().map(|p| p.id)
    } else {
        None
    }
}

/// 主数据加载：项目列表（缓存缺省时拉取 + 首屏自动选中第一个店铺）→ overview
async fn load_main(
    client: &Client,
    projects_cache: Option<Vec<ManagedProject>>,
    filter: OrderInfoFilter,
    page: i64,
    page_size: i64,
    auto_select: bool,
) -> Result<OrderInfoData, String> {
    let projects = match projects_cache {
        Some(projects) => projects,
        None => client
            .list_managed_projects()
            .await
            .map_err(|e| e.user_message())?,
    };

    let autoselected_project =
        resolve_autoselect(auto_select, !filter.project_ids.is_empty(), &projects);
    let effective_filter = if let Some(project_id) = autoselected_project {
        let mut f = filter.clone();
        f.project_ids = vec![project_id];
        f
    } else {
        filter
    };

    let overview = client
        .order_info_overview(&effective_filter, page, page_size)
        .await
        .map_err(|e| e.user_message())?;

    Ok(OrderInfoData {
        projects,
        overview,
        autoselected_project,
    })
}

// ---------------------------------------------------------------------------
// 列定义
// ---------------------------------------------------------------------------

/// 订单表 11 列（对齐 web 12 列主表；「操作」列随 FBM 编辑精简移除）
fn order_columns() -> Vec<ColumnDef<OrderInfoItem>> {
    vec![
        ColumnDef::text("purchase", "下单时间", |_r: &OrderInfoItem, _theme| {
            SharedString::from("")
        })
        .with_render_element(|r: &OrderInfoItem, theme| {
            v_flex()
                .gap_0p5()
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .child(beijing_time(&r.purchase_at_utc)),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(SharedString::from(format!(
                            "PT {}",
                            pt_date(&r.purchase_at_pt)
                        ))),
                )
                .into_any_element()
        })
        .width(128.0),
        ColumnDef::text("order-id", "订单号", |_r: &OrderInfoItem, _theme| {
            SharedString::from("")
        })
        .with_render_element(|r: &OrderInfoItem, theme| {
            let order_id_for_copy = r.amazon_order_id.clone();
            h_flex()
                .gap_1()
                .items_center()
                .child(
                    div()
                        .text_xs()
                        .child(SharedString::from(r.amazon_order_id.clone())),
                )
                .child(
                    div()
                        .id(SharedString::from(format!("order-copy-{}", r.id)))
                        .cursor_pointer()
                        .p_1()
                        .rounded(px(theme.radius))
                        .hover(|s| s.bg(theme.muted_fill))
                        .on_click(move |_ev, _window, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(
                                order_id_for_copy.clone(),
                            ));
                        })
                        .child(
                            Icon::empty()
                                .path("icons/clipboard-check.svg")
                                .with_size(px(12.))
                                .text_color(theme.text_muted),
                        ),
                )
                .into_any_element()
        })
        .width(158.0),
        ColumnDef::text("sku-asin", "SKU / ASIN", |_r: &OrderInfoItem, _theme| {
            SharedString::from("")
        })
        .with_render_element(|r: &OrderInfoItem, theme| {
            v_flex()
                .gap_0p5()
                .child(div().text_xs().child(text_or_dash(&r.sku)))
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(SharedString::from(format!(
                            "ASIN {}",
                            text_or_dash(&r.asin)
                        ))),
                )
                .into_any_element()
        })
        .width(140.0),
        ColumnDef::text("product", "产品", |r: &OrderInfoItem, _| {
            SharedString::from(text_or_dash(&r.product_name))
        })
        .width(180.0),
        ColumnDef::number(
            "quantity",
            "数量",
            |r: &OrderInfoItem| r.quantity as f64,
            |r: &OrderInfoItem, _| SharedString::from(fmt_int(r.quantity)),
        )
        .width(64.0),
        ColumnDef::number(
            "amount",
            "金额",
            |r: &OrderInfoItem| r.item_price,
            |r: &OrderInfoItem, _| {
                SharedString::from(
                    format!(
                        "{} {}",
                        fmt_fixed(r.item_price, 2),
                        r.currency.as_deref().unwrap_or("")
                    )
                    .trim_end()
                    .to_string(),
                )
            },
        )
        .width(104.0),
        ColumnDef::text("address", "收货地", |r: &OrderInfoItem, _| {
            SharedString::from(full_address(r))
        })
        .width(150.0),
        ColumnDef::text("project", "店铺", |_r: &OrderInfoItem, _theme| {
            SharedString::from("")
        })
        .with_render_element(|r: &OrderInfoItem, theme| {
            v_flex()
                .gap_0p5()
                .child(div().text_sm().child(r.project_name.clone()))
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(text_or_dash(&r.brand_name)),
                )
                .into_any_element()
        })
        .width(110.0),
        ColumnDef::text("fulfillment", "类型", |_r: &OrderInfoItem, _theme| {
            SharedString::from("")
        })
        .with_render_element(fulfillment_pill)
        .width(120.0),
        ColumnDef::text("status", "状态", |_r: &OrderInfoItem, _theme| {
            SharedString::from("")
        })
        .with_render_element(status_pill)
        .width(80.0),
        ColumnDef::text("logistics", "物流", |_r: &OrderInfoItem, _theme| {
            SharedString::from("")
        })
        .with_render_element(|r: &OrderInfoItem, theme| {
            if !r.is_fbm() {
                return div()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child("—")
                    .into_any_element();
            }
            let has_any = r.carrier.is_some() || r.tracking_no.is_some() || r.shipped_at.is_some();
            if !has_any {
                return div()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child("未填写")
                    .into_any_element();
            }
            v_flex()
                .gap_0p5()
                .when_some(r.carrier.clone(), |this, carrier| {
                    this.child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .child(carrier),
                    )
                })
                .when_some(r.tracking_no.clone(), |this, tracking| {
                    let display = if tracking.chars().count() > 14 {
                        format!("{}…", tracking.chars().take(14).collect::<String>())
                    } else {
                        tracking
                    };
                    this.child(div().text_xs().text_color(theme.text_muted).child(display))
                })
                .when_some(r.shipped_at.clone(), |this, shipped| {
                    this.child(
                        div()
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child(SharedString::from(format!("发货 {}", pt_date(&shipped)))),
                    )
                })
                .into_any_element()
        })
        .width(130.0),
    ]
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for OrderInfoView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // 懒建关键字输入 + 应用待回填（需要 window）
        self.ensure_inputs(window, cx);

        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let view = cx.entity();
        match &state {
            OrderInfoState::Loading => pattern_a_shell(
                &app_theme,
                "order-info",
                PageHeader::new("订单信息"),
                div(),
                render_loading(&app_theme),
                div(),
            )
            .into_any_element(),
            OrderInfoState::Error(msg) => pattern_a_shell(
                &app_theme,
                "order-info",
                PageHeader::new("订单信息"),
                div(),
                state_views::error_state(
                    &view,
                    &app_theme,
                    "order-info-error",
                    "订单信息加载失败",
                    msg,
                    |this, cx| this.reload(cx),
                ),
                div(),
            )
            .into_any_element(),
            OrderInfoState::Empty => {
                let message = empty_message(self);
                pattern_a_shell(
                    &app_theme,
                    "order-info",
                    PageHeader::new("订单信息"),
                    div(),
                    state_views::empty_state_with_action_desc(
                        &view,
                        &app_theme,
                        "order-info-empty",
                        "icons/shopping-bag.svg",
                        message,
                        Some(
                            "调整筛选条件或点击刷新；CSV 导出与 FBM 补录请在 web 端操作"
                                .to_string(),
                        ),
                        "刷新",
                        |this, cx| this.reload(cx),
                    ),
                    div(),
                )
                .into_any_element()
            }
            OrderInfoState::Loaded(data) => {
                let subtitle = {
                    let stats = &data.overview.stats;
                    format!(
                        "订单 {} · 总数量 {} · 主导币种 {}",
                        fmt_int(stats.total_orders),
                        fmt_int(stats.total_quantity),
                        stats.currency.clone().unwrap_or_else(|| "—".into()),
                    )
                };
                let header = PageHeader::new("订单信息").subtitle(subtitle);

                // Pattern A 工具栏行：筛选下拉 + 关键字/日期 + 操作按钮
                let toolbar = h_flex()
                    .gap_2()
                    .items_center()
                    .flex_wrap()
                    .child(render_filter_card(self, view.clone(), &app_theme))
                    .child(toolbar_spacer());

                let page_state = PageState::new(
                    self.page,
                    self.page_size.max(1),
                    data.overview.total.max(0) as usize,
                );
                let footer = grid_footer_bar(
                    &view,
                    &app_theme,
                    "order-info",
                    &order_stat_aggregates(&data.overview),
                    &page_state,
                    &[DEFAULT_PAGE_SIZE],
                    |this, page, cx| this.go_to_page(page, cx),
                    |this, size, cx| this.set_page_size(size, cx),
                );

                crate::motion::enter_fade_in(
                    SharedString::from("order-info-loaded-fade"),
                    pattern_a_shell(
                        &app_theme,
                        "order-info",
                        header,
                        toolbar,
                        list_section(view, &app_theme, self.table.clone()),
                        footer,
                    ),
                    crate::motion::reduce_motion(cx),
                )
                .into_any_element()
            }
        }
    }
}

/// 空态三档提示（对齐 web 优先级：无可见店铺 > 筛选无结果 > 暂无数据）
fn empty_message(view: &OrderInfoView) -> String {
    // 项目列表已拉取且为空（首屏自动选中已落定）→ 权限投影层 = 0
    if view.auto_select_done && view.projects.is_empty() {
        return "当前账号未关联任何店铺 — 请联系管理员把你的名字补录到目标店铺的「主运营」或「运营助理」字段".to_string();
    }
    if view.has_active_filters() {
        "当前筛选条件下无订单 — 可调整筛选条件或点击「清空筛选」重置".to_string()
    } else {
        "暂无订单数据 — 等待新的销售报告上传后重试".to_string()
    }
}

/// 筛选控件组（Pattern A 工具栏内容：五个下拉 + 关键字输入 / 日期 / 操作按钮）
fn render_filter_card(
    view: &OrderInfoView,
    view_entity: Entity<OrderInfoView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let project_label: SharedString = match view.project_filter {
        Some(id) => view
            .projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| SharedString::from(p.name.clone()))
            .unwrap_or_else(|| SharedString::from(format!("店铺 {id}"))),
        None => SharedString::from("全部店铺"),
    };
    let fulfillment_label: SharedString = SharedString::from(
        view.fulfillment_filter
            .and_then(|value| {
                FULFILLMENT_OPTIONS
                    .iter()
                    .find(|(v, _)| *v == value)
                    .map(|(_, label)| label.to_string())
            })
            .unwrap_or_else(|| "全部类型".to_string()),
    );
    let status_label_text: SharedString = SharedString::from(
        view.status_filter
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "全部状态".to_string()),
    );
    let country_label_text: SharedString = SharedString::from(
        view.country_filter
            .and_then(|value| {
                COUNTRY_FILTER_OPTIONS
                    .iter()
                    .find(|(v, _)| *v == value)
                    .map(|(_, label)| label.to_string())
            })
            .unwrap_or_else(|| "全部国家".to_string()),
    );
    let currency_label: SharedString = SharedString::from(
        view.currency_filter
            .clone()
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| "全部币种".to_string()),
    );
    let options_loading = view.filter_options_loading;

    let view_for_project = view_entity.clone();
    let view_for_fulfillment = view_entity.clone();
    let view_for_status = view_entity.clone();
    let view_for_country = view_entity.clone();
    let view_for_currency = view_entity.clone();
    let view_for_search = view_entity.clone();
    let view_for_clear = view_entity.clone();
    let view_for_refresh = view_entity.clone();

    let projects = view.projects.clone();
    let statuses = view
        .filter_options
        .as_ref()
        .map(|o| o.order_statuses.clone())
        .unwrap_or_default();
    let currencies = view
        .filter_options
        .as_ref()
        .map(|o| o.currencies.clone())
        .unwrap_or_default();
    let project_filter = view.project_filter;
    let fulfillment_filter = view.fulfillment_filter;
    let status_filter = view.status_filter.clone();
    let country_filter = view.country_filter;
    let currency_filter = view.currency_filter.clone();

    // Pattern A 工具栏内容：两行筛选控件纵向叠放（壳负责行容器 chrome）
    v_flex()
        .id("order-info-filters")
        .gap_2()
        .child(
            filter_bar::filter_bar_layout(theme)
                .child(filter_bar::filter_select(
                    theme,
                    "店铺",
                    project_label,
                    "order-info-project-filter",
                    move |menu, _window, _cx| {
                        let mut menu = menu;
                        let view_all = view_for_project.clone();
                        menu = menu.item(
                            PopupMenuItem::new("全部店铺")
                                .checked(project_filter.is_none())
                                .on_click(move |_ev, _w, cx| {
                                    view_all.update(cx, |this, cx| this.select_project(None, cx));
                                }),
                        );
                        for project in &projects {
                            let view = view_for_project.clone();
                            let id = project.id;
                            let checked = project_filter == Some(id);
                            menu = menu.item(
                                PopupMenuItem::new(project.name.clone())
                                    .checked(checked)
                                    .on_click(move |_ev, _w, cx| {
                                        view.update(cx, |this, cx| {
                                            this.select_project(Some(id), cx)
                                        });
                                    }),
                            );
                        }
                        menu
                    },
                ))
                .child(filter_bar::filter_select(
                    theme,
                    "订单类型",
                    fulfillment_label,
                    "order-info-fulfillment-filter",
                    move |menu, _window, _cx| {
                        let mut menu = menu;
                        let view_all = view_for_fulfillment.clone();
                        menu = menu.item(
                            PopupMenuItem::new("全部类型")
                                .checked(fulfillment_filter.is_none())
                                .on_click(move |_ev, _w, cx| {
                                    view_all
                                        .update(cx, |this, cx| this.select_fulfillment(None, cx));
                                }),
                        );
                        for (value, label) in FULFILLMENT_OPTIONS.iter() {
                            let view = view_for_fulfillment.clone();
                            let value: &'static str = value;
                            let checked = fulfillment_filter == Some(value);
                            menu = menu.item(
                                PopupMenuItem::new(label.to_string())
                                    .checked(checked)
                                    .on_click(move |_ev, _w, cx| {
                                        view.update(cx, |this, cx| {
                                            this.select_fulfillment(Some(value), cx)
                                        });
                                    }),
                            );
                        }
                        menu
                    },
                ))
                .child(filter_bar::filter_select(
                    theme,
                    "订单状态",
                    status_label_text,
                    "order-info-status-filter",
                    move |menu, _window, _cx| {
                        let mut menu = menu;
                        let view_all = view_for_status.clone();
                        menu = menu.item(
                            PopupMenuItem::new(if options_loading {
                                "全部状态（加载中…）"
                            } else {
                                "全部状态"
                            })
                            .checked(status_filter.is_none())
                            .on_click(move |_ev, _w, cx| {
                                view_all.update(cx, |this, cx| this.select_status(None, cx));
                            }),
                        );
                        for option in &statuses {
                            let view = view_for_status.clone();
                            let value = option.value.clone();
                            let checked = status_filter.as_deref() == Some(option.value.as_str());
                            let label = option.label.clone();
                            menu = menu.item(PopupMenuItem::new(label).checked(checked).on_click(
                                move |_ev, _w, cx| {
                                    let value = value.clone();
                                    view.update(cx, |this, cx| this.select_status(Some(value), cx));
                                },
                            ));
                        }
                        menu
                    },
                ))
                .child(filter_bar::filter_select(
                    theme,
                    "国家",
                    country_label_text,
                    "order-info-country-filter",
                    move |menu, _window, _cx| {
                        let mut menu = menu;
                        let view_all = view_for_country.clone();
                        menu = menu.item(
                            PopupMenuItem::new("全部国家")
                                .checked(country_filter.is_none())
                                .on_click(move |_ev, _w, cx| {
                                    view_all.update(cx, |this, cx| this.select_country(None, cx));
                                }),
                        );
                        for (value, label) in COUNTRY_FILTER_OPTIONS.iter() {
                            let view = view_for_country.clone();
                            let value: &'static str = value;
                            let checked = country_filter == Some(value);
                            menu = menu.item(
                                PopupMenuItem::new(label.to_string())
                                    .checked(checked)
                                    .on_click(move |_ev, _w, cx| {
                                        view.update(cx, |this, cx| {
                                            this.select_country(Some(value), cx)
                                        });
                                    }),
                            );
                        }
                        menu
                    },
                ))
                .child(filter_bar::filter_select(
                    theme,
                    "币种",
                    currency_label,
                    "order-info-currency-filter",
                    move |menu, _window, _cx| {
                        let mut menu = menu;
                        let view_all = view_for_currency.clone();
                        menu = menu.item(
                            PopupMenuItem::new(if options_loading {
                                "全部币种（加载中…）"
                            } else {
                                "全部币种"
                            })
                            .checked(currency_filter.is_none())
                            .on_click(move |_ev, _w, cx| {
                                view_all.update(cx, |this, cx| this.select_currency(None, cx));
                            }),
                        );
                        for option in &currencies {
                            let view = view_for_currency.clone();
                            let value = option.value.clone();
                            let checked = currency_filter.as_deref() == Some(option.value.as_str());
                            let label = option.label.clone();
                            menu = menu.item(PopupMenuItem::new(label).checked(checked).on_click(
                                move |_ev, _w, cx| {
                                    let value = value.clone();
                                    view.update(cx, |this, cx| {
                                        this.select_currency(Some(value), cx)
                                    });
                                },
                            ));
                        }
                        menu
                    },
                )),
        )
        .child(
            filter_bar::filter_bar_layout(theme)
                .child(keyword_input(theme, "订单号", view.order_id_input.clone()))
                .child(keyword_input(theme, "SKU", view.sku_input.clone()))
                .child(keyword_input(theme, "ASIN", view.asin_input.clone()))
                .child(view.date_picker.clone())
                .child(div().flex_1())
                .child(
                    Button::new("order-info-search")
                        .outline()
                        .small()
                        .label("搜索")
                        .on_click(move |_ev, _w, cx| {
                            view_for_search.update(cx, |this, cx| this.apply_keywords(cx));
                        }),
                )
                .child(
                    Button::new("order-info-clear-filters")
                        .outline()
                        .small()
                        .label("清空筛选")
                        .on_click(move |_ev, _w, cx| {
                            view_for_clear.update(cx, |this, cx| this.clear_filters(cx));
                        }),
                )
                .child(
                    Button::new("order-info-refresh")
                        .outline()
                        .small()
                        .label("刷新")
                        .on_click(move |_ev, _w, cx| {
                            view_for_refresh.update(cx, |this, cx| this.reload(cx));
                        }),
                ),
        )
        .into_any_element()
}

/// 带 label 的关键字输入（filter_select 同款 label 排版；宽度对齐下拉节奏）
fn keyword_input(
    theme: &AppTheme,
    label: &'static str,
    input: Option<Entity<InputState>>,
) -> gpui::AnyElement {
    h_flex()
        .gap_2()
        .items_center()
        .child(
            div()
                .text_sm()
                .text_color(theme.text_secondary)
                .child(label),
        )
        .when_some(input, |this, input| {
            this.child(div().w(px(180.)).child(Input::new(&input)))
        })
        .into_any_element()
}

// ---------------------------------------------------------------------------
// 四态渲染
// ---------------------------------------------------------------------------

fn render_loading(theme: &AppTheme) -> impl IntoElement {
    state_views::skeleton_loading(
        theme,
        &[
            SkeletonBlock::Kpi(5),
            SkeletonBlock::Table(320.0),
            SkeletonBlock::Table(200.0),
        ],
    )
}

/// 底部聚合条目（对齐原统计带 5 项；数字 mono 渲染于 grid_footer_bar）
fn order_stat_aggregates(overview: &OrderInfoOverview) -> Vec<AggregateItem> {
    let stats = &overview.stats;
    vec![
        AggregateItem::new("订单数", fmt_int(stats.total_orders)),
        AggregateItem::new("总数量", fmt_int(stats.total_quantity)),
        AggregateItem::new("总金额", fmt_fixed(stats.total_amount, 2))
            .note(stats.currency.clone().unwrap_or_else(|| "—".into())),
        AggregateItem::new("FBA 行数", fmt_int(stats.fba_count)),
        AggregateItem::new("FBM 行数", fmt_int(stats.fbm_count)),
    ]
}
/// 列表卡（表格 + 分页条 + 行数脚注）
/// 订单列表主体（表格全幅；分页 / 聚合由 pattern_a 底部 footer 条承载）
fn list_section(
    view: Entity<OrderInfoView>,
    _theme: &AppTheme,
    table: Entity<DataTable<OrderInfoItem>>,
) -> gpui::AnyElement {
    let _ = view;
    div()
        .id("order-info-list")
        .size_full()
        .min_h_0()
        .p_2()
        .child(table)
        .into_any_element()
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- 常量 / 派生函数契约 ----------

    #[test]
    fn url_constant_matches_sidebar() {
        assert_eq!(ORDER_INFO_URL, "/dashboard/reports/order-info");
    }

    #[test]
    fn fmt_int_handles_thousands_and_negative() {
        assert_eq!(fmt_int(0), "0");
        assert_eq!(fmt_int(999), "999");
        assert_eq!(fmt_int(1_234_567), "1,234,567");
        assert_eq!(fmt_int(-4200), "-4,200");
    }

    #[test]
    fn fmt_fixed_handles_decimals_and_rounding() {
        assert_eq!(fmt_fixed(1234.5, 1), "1,234.5");
        assert_eq!(fmt_fixed(25.98, 2), "25.98");
        assert_eq!(fmt_fixed(-12.345, 2), "-12.35");
        assert_eq!(fmt_fixed(567.0, 0), "567");
    }

    #[test]
    fn beijing_time_shifts_utc_by_eight_hours() {
        // 2026-08-20T06:23:00Z → 北京时间 14:23 同日
        assert_eq!(
            beijing_time("2026-08-20T06:23:00+00:00"),
            "2026-08-20 14:23"
        );
        // 跨日界：04:00Z → 12:00（同日） / 20:00Z → 次日 04:00
        assert_eq!(beijing_time("2026-08-20T20:00:00Z"), "2026-08-21 04:00");
        assert_eq!(beijing_time(""), "—");
        assert_eq!(beijing_time("not-a-date"), "—");
    }

    #[test]
    fn pt_date_takes_date_segment_only() {
        assert_eq!(pt_date("2026-08-19T23:23:00"), "2026-08-19");
        assert_eq!(pt_date("2026-08-19"), "2026-08-19");
        assert_eq!(pt_date(""), "—");
    }

    #[test]
    fn full_address_joins_parts_with_country_label() {
        let item = sample_item(1);
        assert_eq!(full_address(&item), "Los Angeles, CA, 90001, 美国站");
        // 全空地址 → 仅站点名
        let mut bare = sample_item(2);
        bare.city = None;
        bare.state = None;
        bare.postal_code = None;
        assert_eq!(full_address(&bare), "美国站");
    }

    #[test]
    fn text_or_dash_falls_back_on_none_and_blank() {
        assert_eq!(text_or_dash(&None), "—");
        assert_eq!(text_or_dash(&Some(String::new())), "—");
        assert_eq!(text_or_dash(&Some("  ".to_string())), "—");
        assert_eq!(text_or_dash(&Some("SKU-A".to_string())), "SKU-A");
    }

    #[test]
    fn status_pill_colors_follow_web_variant_semantics() {
        let theme = AppTheme::light();
        // Cancelled → 危险色；Shipped/Shipping → 强调色；其余中性
        let (danger_bg, _) = status_pill_colors("Cancelled", &theme);
        let (accent_bg, _) = status_pill_colors("Shipped", &theme);
        let (neutral_bg, _) = status_pill_colors("Pending", &theme);
        assert_eq!(danger_bg, theme.danger_soft);
        assert_eq!(accent_bg, theme.accent_soft);
        assert_eq!(neutral_bg, theme.muted_fill);
    }

    // ---------- 样本构造 ----------

    fn sample_item(id: i64) -> OrderInfoItem {
        OrderInfoItem {
            id,
            project_id: 3,
            project_name: "测试店铺".into(),
            brand_name: Some("BrandX".into()),
            source_file_id: 9,
            purchase_at_utc: "2026-08-20T06:23:00+00:00".into(),
            purchase_at_pt: "2026-08-19T23:23:00".into(),
            purchase_date_pt: "2026-08-19".into(),
            amazon_order_id: "111-3084457-2750632".into(),
            order_status: "Shipped".into(),
            fulfillment_channel: "Amazon".into(),
            fulfillment_label: "FBA（亚马逊配送）".into(),
            ship_service_level: Some("Standard".into()),
            sku: Some("JDB-4341-29PCS".into()),
            asin: Some("B0C12345".into()),
            product_name: Some("测试产品".into()),
            quantity: 2,
            item_price: 25.98,
            shipping_price: 0.0,
            currency: Some("USD".into()),
            country: "US".into(),
            state: Some("CA".into()),
            city: Some("Los Angeles".into()),
            postal_code: Some("90001".into()),
            is_counted_sales: true,
            created_at: "2026-08-21T00:00:00+00:00".into(),
            carrier: None,
            tracking_no: None,
            shipped_at: None,
            updated_by: None,
            updated_at: None,
        }
    }

    fn sample_project() -> ManagedProject {
        ManagedProject {
            id: 3,
            name: "测试店铺".into(),
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

    fn sample_overview(items: Vec<OrderInfoItem>) -> OrderInfoOverview {
        OrderInfoOverview {
            total: items.len() as i64,
            page: 1,
            page_size: DEFAULT_PAGE_SIZE as i64,
            stats: gui_domain::order_info::OrderInfoStats {
                total_orders: items.len() as i64,
                total_quantity: items.iter().map(|i| i.quantity).sum(),
                total_amount: items.iter().map(|i| i.item_price).sum(),
                currency: Some("USD".into()),
                fba_count: items.iter().filter(|i| !i.is_fbm()).count() as i64,
                fbm_count: items.iter().filter(|i| i.is_fbm()).count() as i64,
            },
            items,
        }
    }

    fn sample_data() -> OrderInfoData {
        OrderInfoData {
            projects: vec![sample_project()],
            overview: sample_overview(vec![sample_item(1), sample_item(2)]),
            autoselected_project: Some(3),
        }
    }

    /// 构造一个 dummy client（无有效 base_url；仅用于构造视图；不实际发请求）
    fn dummy_client() -> Client {
        Client::new("http://127.0.0.1:1")
    }

    // ---------- 状态机 ----------

    #[test]
    fn state_from_result_maps_correctly() {
        let empty_data = OrderInfoData {
            projects: Vec::new(),
            overview: sample_overview(Vec::new()),
            autoselected_project: None,
        };
        assert_eq!(
            OrderInfoState::from_fetch_result(Ok(empty_data)),
            OrderInfoState::Empty
        );
        assert!(matches!(
            OrderInfoState::from_fetch_result(Ok(sample_data())),
            OrderInfoState::Loaded(_)
        ));
        assert_eq!(
            OrderInfoState::from_fetch_result(Err("boom".into())),
            OrderInfoState::Error("boom".into())
        );
    }

    #[test]
    fn build_filter_reflects_committed_state() {
        let filter = OrderInfoFilter {
            project_ids: vec![3],
            fulfillment_channels: vec!["Amazon".into()],
            order_statuses: vec!["Shipped".into()],
            countries: vec!["US".into()],
            currencies: vec!["USD".into()],
            sku_keyword: Some("JDB".into()),
            order_id_keyword: Some("111-308".into()),
            asin_keyword: Some("B0C".into()),
            date_from: chrono::NaiveDate::from_ymd_opt(2026, 8, 14),
            date_to: chrono::NaiveDate::from_ymd_opt(2026, 8, 20),
        };
        assert_eq!(filter.project_ids, vec![3]);
        assert_eq!(filter.fulfillment_channels, vec!["Amazon".to_string()]);
        assert_eq!(filter.order_statuses, vec!["Shipped".to_string()]);
        assert_eq!(filter.countries, vec!["US".to_string()]);
        assert_eq!(filter.currencies, vec!["USD".to_string()]);
        assert_eq!(filter.sku_keyword.as_deref(), Some("JDB"));
        assert_eq!(filter.order_id_keyword.as_deref(), Some("111-308"));
        assert_eq!(filter.asin_keyword.as_deref(), Some("B0C"));
        // 空筛选不携带任何参数（api-client 契约在视图侧的镜像断言）
        assert!(OrderInfoFilter::default().base_query().is_empty());
    }

    // ---------- 渲染冒烟（亮 / 暗 × 四态） ----------

    #[gpui::test]
    async fn renders_loading_state_in_light_and_dark(cx: &mut gpui::TestAppContext) {
        for dark in [false, true] {
            cx.update(|cx| {
                gpui_component::init(cx);
                crate::theme::set_theme_pref(
                    if dark {
                        crate::theme::ThemePreference::Dark
                    } else {
                        crate::theme::ThemePreference::Light
                    },
                    None,
                    cx,
                );
            });
            let (_view, _cx) =
                cx.add_window_view(|_window, cx| OrderInfoView::new(cx, dummy_client()));
        }
    }

    #[gpui::test]
    async fn renders_loaded_with_stat_band_in_light_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| OrderInfoView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            let data = sample_data();
            this.projects = data.projects.clone();
            this.table.update(cx, |t, cx| {
                t.set_rows(data.overview.items.clone(), cx);
            });
            this.state.update(cx, |state, _| {
                *state = OrderInfoState::Loaded(Box::new(data));
            });
        });
        cx2.read(|app| assert!(!crate::theme::AppTheme::current(app).is_dark()));
    }

    #[gpui::test]
    async fn renders_loaded_with_fbm_rows_in_dark_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| OrderInfoView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            let mut fbm = sample_item(3);
            fbm.fulfillment_channel = "Merchant".into();
            fbm.fulfillment_label = "FBM（自发货配送）".into();
            fbm.carrier = Some("UPS".into());
            fbm.tracking_no = Some("1Z999AA10123456784".into());
            let data = OrderInfoData {
                projects: vec![sample_project()],
                overview: sample_overview(vec![sample_item(1), fbm]),
                autoselected_project: None,
            };
            this.table.update(cx, |t, cx| {
                t.set_rows(data.overview.items.clone(), cx);
            });
            this.state.update(cx, |state, _| {
                *state = OrderInfoState::Loaded(Box::new(data));
            });
        });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    #[gpui::test]
    async fn renders_error_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| OrderInfoView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = OrderInfoState::Error("服务不可用".into());
            });
        });
    }

    #[gpui::test]
    async fn renders_empty_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| OrderInfoView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = OrderInfoState::Empty;
            });
        });
    }

    #[gpui::test]
    async fn renders_loaded_with_reduce_motion(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            cx.set_global(crate::motion::MotionPref(true));
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| OrderInfoView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            let data = sample_data();
            this.table.update(cx, |t, cx| {
                t.set_rows(data.overview.items.clone(), cx);
            });
            this.state.update(cx, |state, _| {
                *state = OrderInfoState::Loaded(Box::new(data));
            });
        });
    }

    // ---------- 状态机动作 ----------

    /// 筛选动作：项目 / 类型 / 状态 / 国家 / 币种切换重置页码（同值 no-op）；
    /// 换页 / 行数同款守卫
    #[gpui::test]
    async fn filter_actions_reset_page_and_noop_on_same_value(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| OrderInfoView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            // 预置非首页 + 已选店铺
            this.page = 3;
            this.project_filter = Some(3);
            this.status_filter = Some("Shipped".into());

            // 同值 no-op（页码不动）
            this.select_project(Some(3), cx);
            assert_eq!(this.page, 3);
            this.select_status(Some("Shipped".into()), cx);
            assert_eq!(this.page, 3);

            // 切换状态 → 页码重置
            this.select_status(Some("Pending".into()), cx);
            assert_eq!(this.page, 1);
            assert_eq!(this.status_filter.as_deref(), Some("Pending"));

            // 类型 / 国家 / 币种 → 页码重置
            this.page = 2;
            this.select_fulfillment(Some("Merchant"), cx);
            assert_eq!(this.page, 1);
            assert_eq!(this.fulfillment_filter, Some("Merchant"));
            this.page = 2;
            this.select_country(Some("DE"), cx);
            assert_eq!(this.page, 1);
            assert_eq!(this.country_filter, Some("DE"));
            this.page = 2;
            this.select_currency(Some("EUR".into()), cx);
            assert_eq!(this.page, 1);
            assert_eq!(this.currency_filter.as_deref(), Some("EUR"));

            // 清空各筛选（None）→ 页码重置
            this.page = 2;
            this.select_project(None, cx);
            assert_eq!(this.page, 1);
            assert_eq!(this.project_filter, None);

            // 日期区间：初始为近 7 天，切到「全部」→ 页码重置；同区间 no-op
            this.page = 2;
            this.apply_date_range(DateRange::all(), cx);
            assert_eq!(this.page, 1);
            this.page = 2;
            this.apply_date_range(DateRange::all(), cx);
            assert_eq!(this.page, 2);
            let range = DateRange::new(
                chrono::NaiveDate::from_ymd_opt(2026, 8, 1),
                chrono::NaiveDate::from_ymd_opt(2026, 8, 13),
            );
            this.apply_date_range(range, cx);
            assert_eq!(this.page, 1);
            assert_eq!(this.date_range, range);

            // 换页守卫：同页 / 0 页 no-op
            let before = this.latest_request_id;
            this.go_to_page(this.page, cx);
            this.go_to_page(0, cx);
            assert_eq!(this.latest_request_id, before);
            this.go_to_page(5, cx);
            assert_eq!(this.page, 5);

            // 行数守卫：同行数 / 0 no-op
            let before = this.latest_request_id;
            this.set_page_size(DEFAULT_PAGE_SIZE, cx);
            this.set_page_size(0, cx);
            assert_eq!(this.latest_request_id, before);
        });
    }

    /// 关键字提交：输入未建（值空）时与 committed 一致 → no-op；
    /// committed 变化 → 页码重置 + 重拉
    #[gpui::test]
    async fn apply_keywords_guards_and_commits(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| OrderInfoView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            // 输入未懒建（值空）且 committed 为空 → no-op
            let before = this.latest_request_id;
            this.apply_keywords(cx);
            assert_eq!(this.latest_request_id, before);

            // committed 变化 → 重拉 + 页码重置
            this.committed_order_id = "111-308".into();
            this.page = 4;
            this.apply_keywords(cx);
            assert!(this.latest_request_id > before);
            assert_eq!(this.page, 1);
        });
    }

    /// 清空筛选：全部条件复位 + 日期回默认近 7 天 + 页码重置
    #[gpui::test]
    async fn clear_filters_resets_everything(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| OrderInfoView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.project_filter = Some(3);
            this.fulfillment_filter = Some("Amazon");
            this.status_filter = Some("Shipped".into());
            this.country_filter = Some("US");
            this.currency_filter = Some("USD".into());
            this.committed_order_id = "111-308".into();
            this.committed_sku = "JDB".into();
            this.committed_asin = "B0C".into();
            this.date_range = DateRange::all();
            this.page = 7;

            this.clear_filters(cx);

            assert_eq!(this.project_filter, None);
            assert_eq!(this.fulfillment_filter, None);
            assert_eq!(this.status_filter, None);
            assert_eq!(this.country_filter, None);
            assert_eq!(this.currency_filter, None);
            assert!(this.committed_order_id.is_empty());
            assert!(this.committed_sku.is_empty());
            assert!(this.committed_asin.is_empty());
            // 日期回默认近 7 天（非 all）
            assert!(this.date_range.from.is_some());
            assert!(this.date_range.to.is_some());
            // 输入框待清空（render 期应用）
            assert!(this.pending_inputs_reset);
            // 页码重置 + 已重拉
            assert_eq!(this.page, 1);
            assert_eq!(this.latest_request_id, 1);
        });
    }

    /// 空态三档提示：无可见店铺 > 筛选无结果 > 暂无数据（gpui 实体上下文内构造）
    #[gpui::test]
    async fn empty_message_follows_three_tiers(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| OrderInfoView::new(cx, dummy_client()));
        view.update(cx2, |view, _| {
            // 第一档：首屏拉取完成（auto_select_done）且项目列表为空 → 权限提示
            view.auto_select_done = true;
            assert!(empty_message(view).contains("未关联任何店铺"));

            // 第二档：有筛选条件 → 筛选无结果提示
            view.auto_select_done = false;
            view.project_filter = Some(3);
            assert!(empty_message(view).contains("当前筛选条件下无订单"));

            // 第三档：无筛选（含日期清空）→ 暂无数据提示
            view.project_filter = None;
            view.date_range = DateRange::all();
            assert!(empty_message(view).contains("暂无订单数据"));
        });
    }

    /// 首屏自动选中决策（纯函数）：首次拉取 + 筛选未指定店铺 → 选中第一个；
    /// 已指定 / 非首次 / 空列表 → 不选
    #[test]
    fn resolve_autoselect_only_on_first_load_without_project_filter() {
        let projects = vec![sample_project()];
        // 首次 + 未指定 → 选第一个
        assert_eq!(resolve_autoselect(true, false, &projects), Some(3));
        // 已指定店铺筛选 → 不选
        assert_eq!(resolve_autoselect(true, true, &projects), None);
        // 非首次 → 不选
        assert_eq!(resolve_autoselect(false, false, &projects), None);
        // 空列表 → 放行
        assert_eq!(resolve_autoselect(true, false, &[]), None);
    }
}
