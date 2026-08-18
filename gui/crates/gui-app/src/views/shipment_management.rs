//! 运营 → 发货管理（P5-3，BLF-726）
//!
//! 对齐 web 端 `app/dashboard/operations/shipment-management`（约 4508 行）的
//! 读取主面：发货费用汇总 KPI + 项目/国家/状态/发货日期筛选 + 发货计划分页列表
//! + 单票详情（元信息 + SKU 明细表）。
//!
//! ## 与 web 端的取舍（issue 允许精简：筛选 + 发货列表 + 状态流转展示）
//!
//! - **保留**：四态状态机、筛选（项目/国家/状态/发货日期区间）、分页列表、
//!   状态徽标（draft/in_transit/completed 三态展示 + 状态筛选即状态流转视图）、
//!   单票详情（含 SKU 明细 + 物流费汇总）；
//! - **精简**：新建 / 编辑 / 状态变更 / CSV 导入 / 费用试算（写入链路）走 web 端；
//!   FBA 箱单明细 tab（依赖 R2 图片 / FNSKU 标签下载，打印贴标操作面）走 web 端；
//!   SKU 汇总 tab 与货件编号多选筛选暂不接入（后续按需）；
//! - **详情交互**：web 端为抽屉 + 行点击；GUI 用列表下方详情卡 + 货件下拉切换
//!   （列表加载后默认选中首票，对齐 web `setSelectedId` 默认值语义）。
//!
//! ## 状态机
//!
//! `Loading`（首屏 / 筛选切换 / 换页）→ `Loaded`（有数据）/ `Empty`（列表空）
//! / `Error`（任一请求失败）。详情独立加载相位（`detail_loading` /
//! `detail_error`），不阻塞列表态。

use gpui::prelude::*;
use gpui::{
    div, px, App, AsyncApp, Context, Entity, FontWeight, IntoElement, Render, SharedString,
    WeakEntity, Window,
};
use gpui_component::button::Button;
use gpui_component::menu::PopupMenuItem;
use gpui_component::{h_flex, v_flex, Icon, Sizable};
use gui_api_client::shipment_schedules::ShipmentScheduleFilter;
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::operations::shipment_schedules::{
    method_label, status_label, ShipmentScheduleCostSummary, ShipmentScheduleDetail,
    ShipmentScheduleItemRow, ShipmentScheduleListItem, ShipmentScheduleListResponse,
    STATUS_COMPLETED, STATUS_DRAFT, STATUS_IN_TRANSIT,
};

use crate::theme::AppTheme;
use crate::widgets::data_table::{CellAlign, ColumnDef, DataTable};
use crate::widgets::date_range::{DateRange, DateRangeEvent, DateRangePickerState};
use crate::widgets::filter_bar;
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::pagination::{self, PageState};
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「运营 → 发货管理」URL（数据权威 gui-domain::sidebar）
pub const SHIPMENT_MANAGEMENT_URL: &str = "/dashboard/operations/shipment-management";

/// 默认每页行数（对齐 web `pageSize` useState(20)）
const DEFAULT_PAGE_SIZE: usize = 20;

/// 每页行数下拉选项
const PAGE_SIZE_OPTIONS: &[usize] = &[20, 50, 100];

/// 国家筛选选项（对齐 web `COUNTRY_OPTIONS`：US / UK / DE）
const COUNTRY_OPTIONS: [(&str, &str); 3] = [("US", "US"), ("UK", "UK"), ("DE", "DE")];

/// 状态筛选选项（对齐 web `STATUS_OPTIONS`）
const STATUS_OPTIONS: [(&str, &str); 3] = [
    (STATUS_DRAFT, "草稿"),
    (STATUS_IN_TRANSIT, "在途"),
    (STATUS_COMPLETED, "已完成"),
];

// ---------------------------------------------------------------------------
// 格式化 / 派生辅助
// ---------------------------------------------------------------------------

/// 千分位整数
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

/// 货币（¥ + 千分位 + 2 位小数；物流费为人民币口径）
fn fmt_money_cny(value: f64) -> String {
    format!("¥{}", fmt_fixed(value, 2))
}

/// 日期兜底显示（None / 空串 → 「—」）
fn date_or_dash(value: &Option<String>) -> String {
    value
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "—".to_string())
}

/// 选区落点（对齐 web `setSelectedId` 语义：当前选中仍在列表 → 保留；
/// 否则取首票；空列表 → None）
fn resolve_selection(current: Option<i64>, items: &[ShipmentScheduleListItem]) -> Option<i64> {
    if items.is_empty() {
        return None;
    }
    if let Some(id) = current {
        if items.iter().any(|item| item.id == id) {
            return Some(id);
        }
    }
    Some(items[0].id)
}

/// 状态徽标配色（draft = 中性 / in_transit = 强调 / completed = 成功）
fn status_pill_colors(status: &str, theme: &AppTheme) -> (gpui::Hsla, gpui::Hsla) {
    match status {
        STATUS_IN_TRANSIT => (theme.accent_soft, theme.accent),
        STATUS_COMPLETED => (theme.success_soft, theme.success),
        _ => (theme.muted_fill, theme.text_secondary),
    }
}

/// 状态徽标单元格（对齐 inventory_analysis `status_pill` 观感：软底 + 描边）
fn status_pill(status: &str, theme: &AppTheme) -> gpui::AnyElement {
    let (bg, fg) = status_pill_colors(status, theme);
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
                .child(status_label(status)),
        )
        .into_any_element()
}

// ---------------------------------------------------------------------------
// 载荷 / 状态机
// ---------------------------------------------------------------------------

/// 发货管理载荷（Loaded 持有）
#[derive(Debug, Clone, PartialEq)]
pub struct ShipmentManagementData {
    /// 项目列表（项目筛选下拉数据源；reload 间缓存）
    pub projects: Vec<ManagedProject>,
    /// 当前筛选 + 分页下的发货计划列表
    pub list: ShipmentScheduleListResponse,
    /// 当前筛选下的发货费用汇总（KPI 带）
    pub cost_summary: ShipmentScheduleCostSummary,
}

impl ShipmentManagementData {
    /// 空态判定：列表为空
    pub fn is_empty(&self) -> bool {
        self.list.items.is_empty()
    }
}

/// 发货管理状态机（四态；沿用既有 view 模式）
#[derive(Debug, Clone, PartialEq)]
pub enum ShipmentManagementState {
    Loading,
    Loaded(Box<ShipmentManagementData>),
    Empty,
    Error(String),
}

impl ShipmentManagementState {
    /// 拉取结果 → 落点状态
    pub fn from_fetch_result(result: Result<ShipmentManagementData, String>) -> Self {
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

/// 发货管理视图（四态状态机 + 筛选 + 分页 + 单票详情 + 竞态保护）
pub struct ShipmentManagementView {
    state: Entity<ShipmentManagementState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表缓存（项目筛选下拉数据源；首次 reload 拉取后复用）
    projects: Vec<ManagedProject>,
    /// 项目筛选（None = 全部项目）
    project_filter: Option<i64>,
    /// 国家筛选（None = 全部国家）
    country_filter: Option<String>,
    /// 状态筛选（None = 全部状态）
    status_filter: Option<&'static str>,
    /// 发货日期区间（created_date_from/to；默认全部）
    date_range: DateRange,
    /// 日期区间选择器（Stage 0 公共组件）
    date_picker: Entity<DateRangePickerState>,
    /// 订阅持有（drop 即断）
    _subscriptions: Vec<gpui::Subscription>,
    /// 当前页（1 起）
    page: usize,
    /// 每页行数
    page_size: usize,
    /// 选中货件 id（详情加载入口；列表加载后按 [`resolve_selection`] 落点）
    selected_id: Option<i64>,
    /// 详情载荷
    detail: Option<ShipmentScheduleDetail>,
    /// 详情加载态
    detail_loading: bool,
    /// 详情错误
    detail_error: Option<String>,
    /// 详情竞态保护
    latest_detail_request_id: u64,
    /// 发货列表表（Stage 0 DataTable，总存在）
    list_table: Entity<DataTable<ShipmentScheduleListItem>>,
    /// 详情 SKU 明细表（Stage 0 DataTable，总存在）
    items_table: Entity<DataTable<ShipmentScheduleItemRow>>,
    /// 主请求竞态保护
    latest_request_id: u64,
}

impl ShipmentManagementView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| ShipmentManagementState::Loading);
        let list_table = cx.new(|_| {
            DataTable::new("shipment-management-list", list_columns())
                .striped(true)
                .empty_text("当前筛选条件下暂无发货计划")
        });
        let items_table = cx.new(|_| {
            DataTable::new("shipment-management-items", item_columns())
                .striped(true)
                .empty_text("该货件暂无 SKU 明细")
        });
        let date_picker = cx.new(DateRangePickerState::new);
        let picker_sub = cx.subscribe(&date_picker, |this, _entity, ev, cx| {
            let DateRangeEvent::Change(range) = ev;
            this.apply_date_range(*range, cx);
        });
        Self {
            state,
            client,
            projects: Vec::new(),
            project_filter: None,
            country_filter: None,
            status_filter: None,
            date_range: DateRange::all(),
            date_picker,
            _subscriptions: vec![picker_sub],
            page: 1,
            page_size: DEFAULT_PAGE_SIZE,
            selected_id: None,
            detail: None,
            detail_loading: false,
            detail_error: None,
            latest_detail_request_id: 0,
            list_table,
            items_table,
            latest_request_id: 0,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> ShipmentManagementState {
        self.state.read(cx).clone()
    }

    /// 组装当前筛选（列表 / cost-summary 同口径）
    fn build_filter(&self) -> ShipmentScheduleFilter {
        ShipmentScheduleFilter {
            project_id: self.project_filter,
            country: self.country_filter.clone(),
            shipment_status: self.status_filter.map(|s| s.to_string()),
            shipment_nos: Vec::new(),
            created_date_from: self.date_range.from,
            created_date_to: self.date_range.to,
        }
    }

    /// 重新拉取：首屏 / 筛选切换 / 换页 / 错误重试 / 空态刷新共用入口
    /// （竞态保护；每次调用递增 `latest_request_id` 并进入 Loading）。
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

        // 筛选 / 换页后详情缓存失效（落点后按新列表重建）
        self.detail = None;
        self.detail_error = None;
        self.detail_loading = false;

        self.state.update(cx, |state, cx| {
            *state = ShipmentManagementState::Loading;
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

    /// 应用主数据拉取结果（竞态保护）：落点项目缓存 + 列表表格 + 选区，
    /// 随后按选区触发详情拉取。
    fn apply_main_result(
        &mut self,
        request_id: u64,
        result: Result<ShipmentManagementData, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        let next = ShipmentManagementState::from_fetch_result(result);
        if let ShipmentManagementState::Loaded(data) = &next {
            self.projects = data.projects.clone();
            self.list_table.update(cx, |t, cx| {
                t.set_rows(data.list.items.clone(), cx);
            });
            let selection = resolve_selection(self.selected_id, &data.list.items);
            self.selected_id = selection;
            self.page = data.list.page.max(1) as usize;
        } else {
            self.selected_id = None;
            self.list_table
                .update(cx, |t, cx| t.set_rows(Vec::new(), cx));
        }
        self.state.update(cx, |state, cx| {
            *state = next;
            cx.notify();
        });
        // 有选区 → 拉详情；无选区 → 详情相位保持清空
        if self.selected_id.is_some() {
            self.load_detail(cx);
        }
    }

    /// 切换项目筛选（同一项目为 no-op；`None` = 全部项目）
    pub fn select_project(&mut self, project_id: Option<i64>, cx: &mut Context<Self>) {
        if project_id == self.project_filter {
            return;
        }
        self.project_filter = project_id;
        self.page = 1;
        self.reload(cx);
    }

    /// 切换国家筛选（同一国家为 no-op；`None` = 全部国家）
    pub fn select_country(&mut self, country: Option<&'static str>, cx: &mut Context<Self>) {
        let next = country.map(|c| c.to_string());
        if next == self.country_filter {
            return;
        }
        self.country_filter = next;
        self.page = 1;
        self.reload(cx);
    }

    /// 切换状态筛选（同一状态为 no-op；`None` = 全部状态）
    pub fn select_status(&mut self, status: Option<&'static str>, cx: &mut Context<Self>) {
        if status == self.status_filter {
            return;
        }
        self.status_filter = status;
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

    /// 跳到指定页（同一页 / 0 页为 no-op）
    pub fn go_to_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if page == self.page || page == 0 {
            return;
        }
        self.page = page;
        self.reload(cx);
    }

    /// 切换每页行数（重置到第 1 页；同一行数 / 0 为 no-op）
    pub fn set_page_size(&mut self, size: usize, cx: &mut Context<Self>) {
        if size == self.page_size || size == 0 {
            return;
        }
        self.page_size = size;
        self.page = 1;
        self.reload(cx);
    }

    /// 切换选中货件（详情下拉；同一货件为 no-op）
    pub fn select_shipment(&mut self, shipment_id: i64, cx: &mut Context<Self>) {
        if Some(shipment_id) == self.selected_id {
            return;
        }
        self.selected_id = Some(shipment_id);
        self.load_detail(cx);
    }

    /// 拉取选中货件详情（竞态保护）
    pub fn load_detail(&mut self, cx: &mut Context<Self>) {
        let Some(shipment_id) = self.selected_id else {
            self.detail = None;
            self.detail_error = None;
            self.detail_loading = false;
            return;
        };
        self.latest_detail_request_id = self.latest_detail_request_id.wrapping_add(1);
        let request_id = self.latest_detail_request_id;

        self.detail_loading = true;
        self.detail_error = None;
        cx.notify();

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(async move {
                        client
                            .shipment_schedule_detail(shipment_id)
                            .await
                            .map_err(|e| e.user_message())
                    })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_detail_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 应用详情拉取结果（竞态保护）
    fn apply_detail_result(
        &mut self,
        request_id: u64,
        result: Result<ShipmentScheduleDetail, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_detail_request_id {
            return;
        }
        self.detail_loading = false;
        match result {
            Ok(detail) => {
                self.items_table.update(cx, |t, cx| {
                    t.set_rows(detail.items.clone(), cx);
                });
                self.detail = Some(detail);
            }
            Err(msg) => {
                self.detail = None;
                self.detail_error = Some(msg);
            }
        }
        cx.notify();
    }
}

// ---------------------------------------------------------------------------
// 数据加载辅助函数
// ---------------------------------------------------------------------------

/// 主数据加载：项目列表（缓存缺省时拉取）→ 列表 + 费用汇总并行
async fn load_main(
    client: &Client,
    projects_cache: Option<Vec<ManagedProject>>,
    filter: ShipmentScheduleFilter,
    page: i64,
    page_size: i64,
) -> Result<ShipmentManagementData, String> {
    let projects = match projects_cache {
        Some(projects) => projects,
        None => client
            .list_managed_projects()
            .await
            .map_err(|e| e.user_message())?,
    };

    let list_fut = client.shipment_schedule_list(&filter, page, page_size, true);
    let cost_fut = client.shipment_schedule_cost_summary(&filter);
    let (list_res, cost_res) = tokio::join!(
        async { list_fut.await.map_err(|e| e.user_message()) },
        async { cost_fut.await.map_err(|e| e.user_message()) }
    );
    let list = list_res?;
    let cost_summary = cost_res?;

    Ok(ShipmentManagementData {
        projects,
        list,
        cost_summary,
    })
}

// ---------------------------------------------------------------------------
// 列定义
// ---------------------------------------------------------------------------

/// 发货列表 14 列（对齐 web 总览表：项目/国家/发货时间/货件编号/状态/货代/仓库
/// /ETD/ETA/SKU/数量 + 运输方式/计费重量/物流总价）
fn list_columns() -> Vec<ColumnDef<ShipmentScheduleListItem>> {
    vec![
        ColumnDef::text("project", "项目", |r: &ShipmentScheduleListItem, _| {
            SharedString::from(r.project_name.clone())
        })
        .width(120.0),
        ColumnDef::text("country", "国家", |r: &ShipmentScheduleListItem, _| {
            SharedString::from(r.country.clone())
        })
        .width(56.0),
        ColumnDef::text(
            "created",
            "发货时间",
            |r: &ShipmentScheduleListItem, _| SharedString::from(date_or_dash(&r.created_date)),
        )
        .width(96.0),
        ColumnDef::text(
            "shipment-no",
            "货件编号",
            |r: &ShipmentScheduleListItem, _| SharedString::from(r.shipment_no.clone()),
        )
        .width(140.0),
        ColumnDef::text("status", "状态", |r: &ShipmentScheduleListItem, _| {
            SharedString::from(status_label(&r.shipment_status))
        })
        .with_render_element(|r: &ShipmentScheduleListItem, theme: &AppTheme| {
            status_pill(&r.shipment_status, theme)
        })
        .width(72.0),
        ColumnDef::text(
            "method",
            "运输方式",
            |r: &ShipmentScheduleListItem, _| SharedString::from(method_label(&r.shipping_method)),
        )
        .width(84.0),
        ColumnDef::text("forwarder", "货代", |r: &ShipmentScheduleListItem, _| {
            SharedString::from(
                r.forwarder_name
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "—".to_string()),
            )
        })
        .width(96.0),
        ColumnDef::text("warehouse", "仓库", |r: &ShipmentScheduleListItem, _| {
            SharedString::from(
                r.warehouse_code
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "—".to_string()),
            )
        })
        .width(72.0),
        ColumnDef::text("etd", "ETD", |r: &ShipmentScheduleListItem, _| {
            SharedString::from(date_or_dash(&r.etd_date))
        })
        .width(96.0),
        ColumnDef::text("eta", "ETA", |r: &ShipmentScheduleListItem, _| {
            SharedString::from(date_or_dash(&r.eta_date))
        })
        .width(96.0),
        ColumnDef::number(
            "sku-count",
            "SKU",
            |r: &ShipmentScheduleListItem| r.sku_count as f64,
            |r: &ShipmentScheduleListItem, _| SharedString::from(fmt_int(r.sku_count)),
        )
        .width(64.0),
        ColumnDef::number(
            "quantity",
            "数量",
            |r: &ShipmentScheduleListItem| r.total_quantity as f64,
            |r: &ShipmentScheduleListItem, _| SharedString::from(fmt_int(r.total_quantity)),
        )
        .width(72.0),
        ColumnDef::number(
            "chargeable-weight",
            "计费重量(kg)",
            |r: &ShipmentScheduleListItem| r.total_chargeable_weight_kg,
            |r: &ShipmentScheduleListItem, _| {
                SharedString::from(fmt_fixed(r.total_chargeable_weight_kg, 1))
            },
        )
        .width(104.0),
        ColumnDef::number(
            "logistics-total",
            "物流总价",
            |r: &ShipmentScheduleListItem| r.logistics_total_price,
            |r: &ShipmentScheduleListItem, _| {
                SharedString::from(fmt_money_cny(r.logistics_total_price))
            },
        )
        .width(104.0),
    ]
}

/// 详情 SKU 明细 10 列（对齐 web 详情抽屉明细表核心列）
fn item_columns() -> Vec<ColumnDef<ShipmentScheduleItemRow>> {
    vec![
        ColumnDef::text("item-sku", "SKU", |r: &ShipmentScheduleItemRow, _| {
            SharedString::from(r.sku.clone())
        })
        .width(160.0),
        ColumnDef::text("item-date", "日期", |r: &ShipmentScheduleItemRow, _| {
            SharedString::from(date_or_dash(&r.item_date))
        })
        .width(96.0),
        ColumnDef::number(
            "item-quantity",
            "数量",
            |r: &ShipmentScheduleItemRow| r.quantity as f64,
            |r: &ShipmentScheduleItemRow, _| SharedString::from(fmt_int(r.quantity)),
        )
        .width(72.0),
        ColumnDef::number(
            "item-carton",
            "箱数",
            |r: &ShipmentScheduleItemRow| r.carton_count.unwrap_or(0) as f64,
            |r: &ShipmentScheduleItemRow, _| {
                SharedString::from(
                    r.carton_count
                        .map(fmt_int)
                        .unwrap_or_else(|| "—".to_string()),
                )
            },
        )
        .width(64.0),
        ColumnDef::number(
            "item-volume",
            "体积(m³)",
            |r: &ShipmentScheduleItemRow| r.volume_m3,
            |r: &ShipmentScheduleItemRow, _| SharedString::from(fmt_fixed(r.volume_m3, 3)),
        )
        .width(88.0),
        ColumnDef::number(
            "item-actual-weight",
            "实重(kg)",
            |r: &ShipmentScheduleItemRow| r.actual_weight_kg,
            |r: &ShipmentScheduleItemRow, _| SharedString::from(fmt_fixed(r.actual_weight_kg, 1)),
        )
        .width(84.0),
        ColumnDef::number(
            "item-volumetric",
            "体积重(kg)",
            |r: &ShipmentScheduleItemRow| r.volumetric_weight_kg,
            |r: &ShipmentScheduleItemRow, _| {
                SharedString::from(fmt_fixed(r.volumetric_weight_kg, 1))
            },
        )
        .width(88.0),
        ColumnDef::number(
            "item-chargeable",
            "计费重(kg)",
            |r: &ShipmentScheduleItemRow| r.chargeable_weight_kg,
            |r: &ShipmentScheduleItemRow, _| {
                SharedString::from(fmt_fixed(r.chargeable_weight_kg, 1))
            },
        )
        .width(88.0),
        ColumnDef::number(
            "item-cost",
            "预估运费",
            |r: &ShipmentScheduleItemRow| r.estimated_logistics_cost,
            |r: &ShipmentScheduleItemRow, _| {
                SharedString::from(fmt_money_cny(r.estimated_logistics_cost))
            },
        )
        .width(96.0),
        ColumnDef::number(
            "item-unit-price",
            "单价(¥/kg)",
            |r: &ShipmentScheduleItemRow| r.average_logistics_unit_price,
            |r: &ShipmentScheduleItemRow, _| {
                SharedString::from(fmt_fixed(r.average_logistics_unit_price, 2))
            },
        )
        .align(CellAlign::Right)
        .width(88.0),
    ]
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for ShipmentManagementView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let view = cx.entity();
        let subtitle = match &state {
            ShipmentManagementState::Loaded(data) => format!(
                "{} 票在管 · 累计物流费 {}",
                fmt_int(data.cost_summary.shipment_count),
                fmt_money_cny(data.cost_summary.total_logistics_cost),
            ),
            _ => "发货计划与物流跟踪".to_string(),
        };

        v_flex()
            .id("shipment-management")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            .child(PageHeader::new("发货管理").subtitle(subtitle))
            .child(content_guard().child(render_filter_bar(
                &view,
                &app_theme,
                &self.projects,
                self.project_filter,
                self.country_filter.clone(),
                self.status_filter,
                self.date_picker.clone(),
            )))
            .child(match state {
                ShipmentManagementState::Loading => render_loading(&app_theme).into_any_element(),
                ShipmentManagementState::Error(msg) => state_views::error_state(
                    &view,
                    &app_theme,
                    "shipment-management-error",
                    "发货管理加载失败",
                    msg,
                    |this, cx| this.reload(cx),
                )
                .into_any_element(),
                ShipmentManagementState::Empty => state_views::empty_state_with_action_desc(
                    &view,
                    &app_theme,
                    "shipment-management-empty",
                    "icons/truck.svg",
                    "当前筛选条件下暂无发货计划".to_string(),
                    Some("调整筛选条件或点击刷新；新建发货计划请在 web 端操作".to_string()),
                    "刷新",
                    |this, cx| this.reload(cx),
                )
                .into_any_element(),
                ShipmentManagementState::Loaded(data) => render_loaded(
                    &view,
                    cx,
                    &app_theme,
                    &data,
                    self.page,
                    self.page_size,
                    self.selected_id,
                    self.detail.clone(),
                    self.detail_loading,
                    self.detail_error.clone(),
                    self.list_table.clone(),
                    self.items_table.clone(),
                )
                .into_any_element(),
            })
    }
}

// ---------------------------------------------------------------------------
// 筛选栏
// ---------------------------------------------------------------------------

fn render_filter_bar(
    view: &Entity<ShipmentManagementView>,
    theme: &AppTheme,
    projects: &[ManagedProject],
    project_filter: Option<i64>,
    country_filter: Option<String>,
    status_filter: Option<&'static str>,
    date_picker: Entity<DateRangePickerState>,
) -> impl IntoElement {
    let projects_owned = projects.to_vec();
    let project_label: SharedString = match project_filter {
        Some(id) => projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| SharedString::from(p.name.clone()))
            .unwrap_or_else(|| SharedString::from("全部项目")),
        None => SharedString::from("全部项目"),
    };
    let country_label: SharedString = SharedString::from(
        country_filter
            .as_deref()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "全部国家".to_string()),
    );
    let status_label_text: SharedString = SharedString::from(
        status_filter
            .and_then(|value| {
                STATUS_OPTIONS
                    .iter()
                    .find(|(v, _)| *v == value)
                    .map(|(_, label)| label.to_string())
            })
            .unwrap_or_else(|| "全部状态".to_string()),
    );

    let view_for_project = view.clone();
    let view_for_country = view.clone();
    let view_for_status = view.clone();
    let view_for_refresh = view.clone();

    filter_bar::filter_bar_layout(theme)
        .id("shipment-management-filters")
        .child(filter_bar::filter_select(
            theme,
            "项目",
            project_label,
            "shipment-management-project-filter",
            move |menu, _window, _cx| {
                let mut menu = menu;
                let view_all = view_for_project.clone();
                menu = menu.item(
                    PopupMenuItem::new("全部项目")
                        .checked(project_filter.is_none())
                        .on_click(move |_ev, _w, cx| {
                            view_all.update(cx, |this, cx| this.select_project(None, cx));
                        }),
                );
                for project in &projects_owned {
                    let view = view_for_project.clone();
                    let id = project.id;
                    let checked = project_filter == Some(id);
                    menu = menu.item(
                        PopupMenuItem::new(project.name.clone())
                            .checked(checked)
                            .on_click(move |_ev, _w, cx| {
                                view.update(cx, |this, cx| this.select_project(Some(id), cx));
                            }),
                    );
                }
                menu
            },
        ))
        .child(filter_bar::filter_select(
            theme,
            "国家",
            country_label,
            "shipment-management-country-filter",
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
                for (value, label) in COUNTRY_OPTIONS.iter() {
                    let view = view_for_country.clone();
                    let value: &'static str = value;
                    let checked = country_filter.as_deref() == Some(value);
                    menu = menu.item(
                        PopupMenuItem::new(label.to_string())
                            .checked(checked)
                            .on_click(move |_ev, _w, cx| {
                                view.update(cx, |this, cx| this.select_country(Some(value), cx));
                            }),
                    );
                }
                menu
            },
        ))
        .child(filter_bar::filter_select(
            theme,
            "状态",
            status_label_text,
            "shipment-management-status-filter",
            move |menu, _window, _cx| {
                let mut menu = menu;
                let view_all = view_for_status.clone();
                menu = menu.item(
                    PopupMenuItem::new("全部状态")
                        .checked(status_filter.is_none())
                        .on_click(move |_ev, _w, cx| {
                            view_all.update(cx, |this, cx| this.select_status(None, cx));
                        }),
                );
                for (value, label) in STATUS_OPTIONS.iter() {
                    let view = view_for_status.clone();
                    let value: &'static str = value;
                    let checked = status_filter == Some(value);
                    menu = menu.item(
                        PopupMenuItem::new(label.to_string())
                            .checked(checked)
                            .on_click(move |_ev, _w, cx| {
                                view.update(cx, |this, cx| this.select_status(Some(value), cx));
                            }),
                    );
                }
                menu
            },
        ))
        // 发货日期区间（DateRangePicker 公共组件；变更经订阅回连 reload）
        .child(date_picker)
        .child(div().flex_1())
        .child(
            Button::new("shipment-management-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_ev, _w, cx| {
                    view_for_refresh.update(cx, |this, cx| this.reload(cx));
                }),
        )
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

#[allow(clippy::too_many_arguments)]
fn render_loaded(
    view: &Entity<ShipmentManagementView>,
    cx: &mut Context<ShipmentManagementView>,
    theme: &AppTheme,
    data: &ShipmentManagementData,
    page: usize,
    page_size: usize,
    selected_id: Option<i64>,
    detail: Option<ShipmentScheduleDetail>,
    detail_loading: bool,
    detail_error: Option<String>,
    list_table: Entity<DataTable<ShipmentScheduleListItem>>,
    items_table: Entity<DataTable<ShipmentScheduleItemRow>>,
) -> impl IntoElement {
    let reduce = crate::motion::reduce_motion(cx);
    let total = data.list.total.unwrap_or(data.list.items.len() as i64) as usize;
    let page_state = PageState::new(page, page_size.max(1), total);

    crate::motion::enter_fade_in(
        SharedString::from("shipment-management-loaded-fade"),
        v_flex()
            .id("shipment-management-loaded")
            .gap_4()
            // 发货费用汇总 KPI 带（对齐 web「发货费用」tab 的 5 项 KPI）
            .child(content_guard().child(kpi_cards(&data.cost_summary, theme)))
            // 发货计划列表 + 分页
            .child(content_guard().child(list_section(view, theme, list_table, &page_state)))
            // 单票详情（元信息 + SKU 明细）
            .child(content_guard().child(detail_section(
                view,
                theme,
                &data.list.items,
                selected_id,
                detail,
                detail_loading,
                detail_error,
                items_table,
            ))),
        reduce,
    )
    .into_any_element()
}

// ---------------------------------------------------------------------------
// KPI 带（发货费用汇总）
// ---------------------------------------------------------------------------

fn kpi_cards(summary: &ShipmentScheduleCostSummary, theme: &AppTheme) -> impl IntoElement {
    h_flex()
        .id("shipment-management-kpi-cards")
        .gap_3()
        .flex_wrap()
        .children([
            kpi_card(
                theme,
                "icons/truck.svg",
                "发货票数",
                fmt_int(summary.shipment_count),
                "票".to_string(),
            ),
            kpi_card(
                theme,
                "icons/layers.svg",
                "SKU 数",
                fmt_int(summary.total_sku),
                "个".to_string(),
            ),
            kpi_card(
                theme,
                "icons/package.svg",
                "发货总数量",
                fmt_int(summary.total_quantity),
                "件".to_string(),
            ),
            kpi_card(
                theme,
                "icons/warehouse.svg",
                "计费总重量",
                fmt_fixed(summary.total_chargeable_weight_kg, 1),
                "kg".to_string(),
            ),
            kpi_card(
                theme,
                "icons/coins.svg",
                "物流总费用",
                fmt_money_cny(summary.total_logistics_cost),
                "CNY".to_string(),
            ),
        ])
}

fn kpi_card(
    theme: &AppTheme,
    icon_path: &'static str,
    label: &'static str,
    value: String,
    unit: String,
) -> impl IntoElement {
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
        .id(SharedString::from(format!("sm-kpi-{label}")))
        .flex_1()
        .min_w(px(170.0))
        .gap_1()
        .px_4()
        .py_3()
        .rounded(px(theme.radius_lg))
        .border_1()
        .border_color(theme.separator)
        .bg(theme.card_bg)
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    h_flex()
                        .size_6()
                        .flex_shrink_0()
                        .items_center()
                        .justify_center()
                        .rounded_md()
                        .bg(chip_bg)
                        .child(
                            Icon::empty()
                                .path(icon_path)
                                .with_size(px(12.))
                                .text_color(chip_icon),
                        ),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(SharedString::from(label)),
                ),
        )
        .child(
            h_flex()
                .gap_2()
                .items_baseline()
                .child(
                    div()
                        .text_2xl()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_primary)
                        .child(value),
                )
                .child(div().text_xs().text_color(theme.text_muted).child(unit)),
        )
}

// ---------------------------------------------------------------------------
// 列表卡（表格 + 分页条）
// ---------------------------------------------------------------------------

fn list_section(
    view: &Entity<ShipmentManagementView>,
    theme: &AppTheme,
    list_table: Entity<DataTable<ShipmentScheduleListItem>>,
    page_state: &PageState,
) -> impl IntoElement {
    v_flex()
        .id("shipment-management-list-card")
        .w_full()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
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
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_primary)
                        .child("发货计划列表"),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child("backend 默认按发货时间倒序；点击表头可排序"),
                ),
        )
        .child(div().w_full().px_4().py_2().child(list_table))
        .child(
            div()
                .w_full()
                .px_4()
                .py_2()
                .child(pagination::pagination_bar(
                    view,
                    theme,
                    "shipment-management-pagination",
                    page_state,
                    PAGE_SIZE_OPTIONS,
                    |this, page, cx| this.go_to_page(page, cx),
                    |this, size, cx| this.set_page_size(size, cx),
                )),
        )
}

// ---------------------------------------------------------------------------
// 详情卡（元信息 + SKU 明细）
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn detail_section(
    view: &Entity<ShipmentManagementView>,
    theme: &AppTheme,
    items: &[ShipmentScheduleListItem],
    selected_id: Option<i64>,
    detail: Option<ShipmentScheduleDetail>,
    detail_loading: bool,
    detail_error: Option<String>,
    items_table: Entity<DataTable<ShipmentScheduleItemRow>>,
) -> impl IntoElement {
    let selected_label: SharedString = selected_id
        .and_then(|id| items.iter().find(|item| item.id == id))
        .map(|item| SharedString::from(item.shipment_no.clone()))
        .unwrap_or_else(|| SharedString::from("请选择货件"));

    let items_owned = items.to_vec();
    let view_for_select = view.clone();
    let view_for_retry = view.clone();

    let header = h_flex()
        .gap_3()
        .items_center()
        .flex_wrap()
        .child(
            div()
                .text_base()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_primary)
                .child("货件详情"),
        )
        .child(filter_bar::filter_select(
            theme,
            "货件",
            selected_label,
            "shipment-management-detail-select",
            move |menu, _window, _cx| {
                let mut menu = menu;
                for item in &items_owned {
                    let view = view_for_select.clone();
                    let id = item.id;
                    let checked = Some(id) == selected_id;
                    let label = format!("{} · {}", item.shipment_no, item.project_name);
                    menu = menu.item(PopupMenuItem::new(label).checked(checked).on_click(
                        move |_ev, _w, cx| {
                            view.update(cx, |this, cx| this.select_shipment(id, cx));
                        },
                    ));
                }
                menu
            },
        ));

    let body: gpui::AnyElement = match (detail_loading, &detail_error, &detail) {
        (true, _, _) => state_views::loading_state(theme, "加载货件详情中…").into_any_element(),
        (false, Some(msg), _) => v_flex()
            .id("shipment-management-detail-error")
            .gap_2()
            .items_start()
            .p_3()
            .rounded(px(theme.radius))
            .bg(theme.danger_soft)
            .child(
                div()
                    .text_sm()
                    .text_color(theme.danger)
                    .child(format!("详情加载失败：{msg}")),
            )
            .child(
                Button::new("shipment-management-detail-retry")
                    .outline()
                    .small()
                    .label("重试")
                    .on_click(move |_ev, _w, cx| {
                        view_for_retry.update(cx, |this, cx| this.load_detail(cx));
                    }),
            )
            .into_any_element(),
        (false, None, None) => state_views::empty_state(
            theme,
            "shipment-management-detail-empty",
            "icons/package.svg",
            "选择货件后自动加载详情".to_string(),
        )
        .into_any_element(),
        (false, None, Some(detail)) => v_flex()
            .gap_3()
            .child(detail_meta_grid(theme, detail))
            .child(div().w_full().child(items_table))
            .child(detail_totals_row(theme, detail))
            .into_any_element(),
    };

    v_flex()
        .id("shipment-management-detail-card")
        .w_full()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(
            v_flex()
                .gap_1()
                .px_4()
                .py_3()
                .border_b_1()
                .border_color(theme.separator)
                .child(header),
        )
        .child(div().w_full().px_4().py_3().child(body))
}

/// 详情元信息栅格（状态徽标 + 物流要素 + 日期链 + 备注）
fn detail_meta_grid(theme: &AppTheme, detail: &ShipmentScheduleDetail) -> impl IntoElement {
    fn dash_if_blank(value: &Option<String>) -> String {
        value
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "—".to_string())
    }

    let cells: Vec<(&'static str, String)> = vec![
        ("项目", detail.project_name.clone()),
        ("国家", detail.country.clone()),
        ("运输方式", method_label(&detail.shipping_method)),
        ("货代", dash_if_blank(&detail.forwarder_name)),
        ("仓库", dash_if_blank(&detail.warehouse_code)),
        ("运单号", dash_if_blank(&detail.tracking_no)),
        ("发货日期", date_or_dash(&detail.created_date)),
        ("ETD", date_or_dash(&detail.etd_date)),
        ("ETA", date_or_dash(&detail.eta_date)),
        ("实际入仓", date_or_dash(&detail.actual_inbound_date)),
        ("导入批次", dash_if_blank(&detail.shipment_batch)),
        ("备注", dash_if_blank(&detail.remark)),
    ];

    div()
        .id("shipment-management-detail-meta")
        .grid()
        .grid_cols(4)
        .gap_3()
        // 状态单独用徽标渲染（首格）
        .child(
            v_flex()
                .gap_1()
                .child(div().text_xs().text_color(theme.text_muted).child("状态"))
                .child(status_pill(&detail.shipment_status, theme)),
        )
        .children(cells.into_iter().map(|(label, value)| {
            v_flex()
                .gap_1()
                .child(div().text_xs().text_color(theme.text_muted).child(label))
                .child(div().text_sm().text_color(theme.text_primary).child(value))
        }))
}

/// 详情合计行（SKU / 数量 / 体积 / 计费重 / 单价 / 总价）
fn detail_totals_row(theme: &AppTheme, detail: &ShipmentScheduleDetail) -> impl IntoElement {
    h_flex()
        .id("shipment-management-detail-totals")
        .gap_4()
        .items_center()
        .flex_wrap()
        .px_3()
        .py_2()
        .rounded(px(theme.radius))
        .bg(theme.muted_fill)
        .text_xs()
        .text_color(theme.text_secondary)
        .child(SharedString::from(format!(
            "SKU {} 个",
            fmt_int(detail.sku_count)
        )))
        .child(SharedString::from(format!(
            "总数量 {}",
            fmt_int(detail.total_quantity)
        )))
        .child(SharedString::from(format!(
            "总体积 {} m³",
            fmt_fixed(detail.total_volume_m3, 3)
        )))
        .child(SharedString::from(format!(
            "计费重量 {} kg",
            fmt_fixed(detail.total_chargeable_weight_kg, 1)
        )))
        .child(SharedString::from(format!(
            "物流单价 {} /kg",
            fmt_money_cny(detail.logistics_unit_price)
        )))
        .child(
            div()
                .text_sm()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_primary)
                .child(SharedString::from(format!(
                    "物流总价 {}",
                    fmt_money_cny(detail.logistics_total_price)
                ))),
        )
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- 派生函数契约 ----------

    #[test]
    fn url_constant_matches_sidebar() {
        assert_eq!(
            SHIPMENT_MANAGEMENT_URL,
            "/dashboard/operations/shipment-management"
        );
    }

    #[test]
    fn fmt_int_handles_thousands_and_negative() {
        assert_eq!(fmt_int(0), "0");
        assert_eq!(fmt_int(999), "999");
        assert_eq!(fmt_int(12345), "12,345");
        assert_eq!(fmt_int(1_234_567), "1,234,567");
        assert_eq!(fmt_int(-4200), "-4,200");
    }

    #[test]
    fn fmt_fixed_handles_decimals_and_rounding() {
        assert_eq!(fmt_fixed(1234.5, 1), "1,234.5");
        assert_eq!(fmt_fixed(1234.567, 2), "1,234.57");
        assert_eq!(fmt_fixed(0.0, 2), "0.00");
        assert_eq!(fmt_fixed(-12.345, 2), "-12.35");
        assert_eq!(fmt_fixed(96.0, 0), "96");
    }

    #[test]
    fn fmt_money_cny_prefixes_currency() {
        assert_eq!(fmt_money_cny(3040.0), "¥3,040.00");
        assert_eq!(fmt_money_cny(0.5), "¥0.50");
    }

    #[test]
    fn date_or_dash_falls_back_on_none_and_blank() {
        assert_eq!(date_or_dash(&None), "—");
        assert_eq!(date_or_dash(&Some(String::new())), "—");
        assert_eq!(date_or_dash(&Some("  ".to_string())), "—");
        assert_eq!(date_or_dash(&Some("2026-08-01".to_string())), "2026-08-01");
    }

    fn make_item(id: i64, shipment_no: &str) -> ShipmentScheduleListItem {
        ShipmentScheduleListItem {
            id,
            project_id: 1,
            project_name: "测试项目".into(),
            country: "US".into(),
            shipment_no: shipment_no.into(),
            tracking_no: None,
            warehouse_code: None,
            forwarder_name: None,
            shipping_method: "sea".into(),
            created_date: Some("2026-08-01".into()),
            etd_date: None,
            eta_date: None,
            actual_inbound_date: None,
            shipment_status: STATUS_DRAFT.into(),
            remark: None,
            sku_count: 1,
            total_quantity: 10,
            logistics_unit_price: 0.0,
            total_volume_m3: 0.0,
            total_chargeable_weight_kg: 0.0,
            logistics_total_price: 0.0,
            include_in_history_shipping_calc: true,
            updated_at: "2026-08-01T00:00:00".into(),
            shipment_batch: None,
        }
    }

    #[test]
    fn resolve_selection_keeps_existing_picks_first_or_none() {
        let items = vec![make_item(1, "FBA1"), make_item(2, "FBA2")];
        // 仍在列表 → 保留
        assert_eq!(resolve_selection(Some(2), &items), Some(2));
        // 不在列表 → 首票
        assert_eq!(resolve_selection(Some(99), &items), Some(1));
        // 未选中 → 首票
        assert_eq!(resolve_selection(None, &items), Some(1));
        // 空列表 → None
        assert_eq!(resolve_selection(Some(1), &[]), None);
    }

    #[test]
    fn state_from_result_maps_correctly() {
        let empty_data = ShipmentManagementData {
            projects: Vec::new(),
            list: ShipmentScheduleListResponse {
                items: Vec::new(),
                page: 1,
                page_size: 20,
                total: Some(0),
                has_next: false,
            },
            cost_summary: ShipmentScheduleCostSummary::default(),
        };
        assert_eq!(
            ShipmentManagementState::from_fetch_result(Ok(empty_data)),
            ShipmentManagementState::Empty
        );

        let loaded_data = ShipmentManagementData {
            projects: Vec::new(),
            list: ShipmentScheduleListResponse {
                items: vec![make_item(1, "FBA1")],
                page: 1,
                page_size: 20,
                total: Some(1),
                has_next: false,
            },
            cost_summary: ShipmentScheduleCostSummary::default(),
        };
        assert!(matches!(
            ShipmentManagementState::from_fetch_result(Ok(loaded_data)),
            ShipmentManagementState::Loaded(_)
        ));

        assert_eq!(
            ShipmentManagementState::from_fetch_result(Err("boom".into())),
            ShipmentManagementState::Error("boom".into())
        );
    }

    // ---------- 渲染冒烟（亮 / 暗 × 四态） ----------

    /// 构造一个 dummy client（无有效 base_url；仅用于构造视图；不实际发请求）
    fn dummy_client() -> Client {
        Client::new("http://127.0.0.1:1")
    }

    fn sample_project() -> ManagedProject {
        ManagedProject {
            id: 1,
            name: "测试项目".into(),
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

    fn sample_data() -> ShipmentManagementData {
        ShipmentManagementData {
            projects: vec![sample_project()],
            list: ShipmentScheduleListResponse {
                items: vec![
                    make_item(1, "FBA-TEST-001"),
                    ShipmentScheduleListItem {
                        shipment_status: STATUS_IN_TRANSIT.into(),
                        shipping_method: "air".into(),
                        ..make_item(2, "FBA-TEST-002")
                    },
                ],
                page: 1,
                page_size: 20,
                total: Some(2),
                has_next: false,
            },
            cost_summary: ShipmentScheduleCostSummary {
                shipment_count: 2,
                total_sku: 3,
                total_quantity: 120,
                total_chargeable_weight_kg: 480.5,
                total_logistics_cost: 4564.75,
            },
        }
    }

    fn sample_detail() -> ShipmentScheduleDetail {
        ShipmentScheduleDetail {
            id: 1,
            project_id: 1,
            project_name: "测试项目".into(),
            country: "US".into(),
            shipment_no: "FBA-TEST-001".into(),
            tracking_no: Some("T-1".into()),
            warehouse_code: Some("ONT8".into()),
            forwarder_name: Some("递四方".into()),
            shipping_method: "sea".into(),
            created_date: Some("2026-08-01".into()),
            etd_date: Some("2026-08-03".into()),
            eta_date: Some("2026-09-01".into()),
            actual_inbound_date: None,
            remark: None,
            shipment_status: STATUS_IN_TRANSIT.into(),
            sku_count: 1,
            total_quantity: 10,
            logistics_unit_price: 9.5,
            total_volume_m3: 1.2,
            total_chargeable_weight_kg: 320.0,
            logistics_total_price: 3040.0,
            include_in_history_shipping_calc: true,
            items: vec![ShipmentScheduleItemRow {
                id: 11,
                item_date: Some("2026-08-01".into()),
                sku: "SKU-A".into(),
                quantity: 10,
                carton_count: Some(2),
                remark: None,
                volume_m3: 1.2,
                actual_weight_kg: 300.0,
                volumetric_weight_kg: 200.0,
                chargeable_weight_kg: 300.0,
                estimated_logistics_cost: 2850.0,
                average_logistics_unit_price: 9.5,
            }],
            updated_at: "2026-08-01T00:00:00".into(),
            shipment_batch: None,
        }
    }

    /// 渲染冒烟：Loading 态（亮 / 暗主题）
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
                cx.add_window_view(|_window, cx| ShipmentManagementView::new(cx, dummy_client()));
        }
    }

    /// 渲染冒烟：Loaded 态（亮色）+ 详情就绪（KPI 带 / 列表 / 分页 / 详情卡全覆盖）
    #[gpui::test]
    async fn renders_loaded_with_detail_in_light_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let (view, cx2) =
            cx.add_window_view(|_window, cx| ShipmentManagementView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            let data = sample_data();
            this.projects = data.projects.clone();
            this.list_table.update(cx, |t, cx| {
                t.set_rows(data.list.items.clone(), cx);
            });
            this.selected_id = Some(1);
            let detail = sample_detail();
            this.items_table.update(cx, |t, cx| {
                t.set_rows(detail.items.clone(), cx);
            });
            this.detail = Some(detail);
            this.state.update(cx, |state, _| {
                *state = ShipmentManagementState::Loaded(Box::new(data));
            });
        });
        cx2.read(|app| assert!(!crate::theme::AppTheme::current(app).is_dark()));
    }

    /// 渲染冒烟：Loaded 态（暗色）+ 详情加载中 / 错误 / 空三分支
    #[gpui::test]
    async fn renders_loaded_detail_phases_in_dark_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (view, cx2) =
            cx.add_window_view(|_window, cx| ShipmentManagementView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            let data = sample_data();
            this.list_table.update(cx, |t, cx| {
                t.set_rows(data.list.items.clone(), cx);
            });
            this.selected_id = Some(1);
            this.state.update(cx, |state, _| {
                *state = ShipmentManagementState::Loaded(Box::new(data));
            });
        });
        // 详情加载中
        view.update(cx2, |this, _| this.detail_loading = true);
        // 详情错误
        view.update(cx2, |this, _| {
            this.detail_loading = false;
            this.detail_error = Some("货件不存在".into());
        });
        // 详情空（无选区）
        view.update(cx2, |this, _| {
            this.detail_error = None;
            this.selected_id = None;
        });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    /// 渲染冒烟：Error 态可渲染（含重试按钮）
    #[gpui::test]
    async fn renders_error_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| ShipmentManagementView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = ShipmentManagementState::Error("服务不可用".into());
            });
        });
    }

    /// 渲染冒烟：Empty 态可渲染（含刷新按钮 + 次级说明）
    #[gpui::test]
    async fn renders_empty_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| ShipmentManagementView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = ShipmentManagementState::Empty;
            });
        });
    }

    /// 渲染冒烟：减弱动态偏好下 Loaded 态可渲染（无动画路径）
    #[gpui::test]
    async fn renders_loaded_with_reduce_motion(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            cx.set_global(crate::motion::MotionPref(true));
        });
        let (view, cx2) =
            cx.add_window_view(|_window, cx| ShipmentManagementView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            let data = sample_data();
            this.list_table.update(cx, |t, cx| {
                t.set_rows(data.list.items.clone(), cx);
            });
            this.selected_id = Some(1);
            let detail = sample_detail();
            this.items_table.update(cx, |t, cx| {
                t.set_rows(detail.items.clone(), cx);
            });
            this.detail = Some(detail);
            this.state.update(cx, |state, _| {
                *state = ShipmentManagementState::Loaded(Box::new(data));
            });
        });
    }

    // ---------- 状态机动作 ----------

    /// 筛选动作：项目 / 国家 / 状态切换重置页码（同值 no-op）；换页 / 行数同款守卫
    #[gpui::test]
    async fn filter_actions_reset_page_and_noop_on_same_value(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| ShipmentManagementView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            // 预置非首页 + 已选项目
            this.page = 3;
            this.project_filter = Some(1);
            this.status_filter = Some(STATUS_IN_TRANSIT);

            // 同值 no-op（页码不动）
            this.select_project(Some(1), cx);
            assert_eq!(this.page, 3);
            this.select_status(Some(STATUS_IN_TRANSIT), cx);
            assert_eq!(this.page, 3);

            // 切换状态 → 页码重置
            this.select_status(Some(STATUS_COMPLETED), cx);
            assert_eq!(this.page, 1);
            assert_eq!(this.status_filter, Some(STATUS_COMPLETED));

            // 切换国家 / 清空项目 → 页码重置
            this.page = 2;
            this.select_country(Some("DE"), cx);
            assert_eq!(this.page, 1);
            assert_eq!(this.country_filter.as_deref(), Some("DE"));
            this.page = 2;
            this.select_project(None, cx);
            assert_eq!(this.page, 1);
            assert_eq!(this.project_filter, None);

            // 日期区间：同区间 no-op，新区间重置页码
            this.page = 2;
            this.apply_date_range(DateRange::all(), cx);
            assert_eq!(this.page, 2);
            let range = DateRange::new(
                chrono::NaiveDate::from_ymd_opt(2026, 7, 1),
                chrono::NaiveDate::from_ymd_opt(2026, 7, 31),
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

            // 行数守卫：同行数 / 0 no-op；新行数重置页码
            this.page = 3;
            this.set_page_size(DEFAULT_PAGE_SIZE, cx);
            assert_eq!(this.page, 3);
            this.set_page_size(50, cx);
            assert_eq!(this.page, 1);
            assert_eq!(this.page_size, 50);
        });
    }

    /// 货件选择：同一货件 no-op；切换货件进入详情加载相位
    #[gpui::test]
    async fn select_shipment_guards_and_loads_detail(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| ShipmentManagementView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.selected_id = Some(1);
            let before = this.latest_detail_request_id;
            // 同一货件 no-op
            this.select_shipment(1, cx);
            assert_eq!(this.latest_detail_request_id, before);
            // 切换货件 → 详情相位进入加载
            this.select_shipment(2, cx);
            assert_eq!(this.selected_id, Some(2));
            assert!(this.detail_loading);
            assert!(this.latest_detail_request_id > before);
            // 无选区 → load_detail 清空相位（不 panic）
            this.selected_id = None;
            this.load_detail(cx);
            assert!(!this.detail_loading);
            assert!(this.detail.is_none());
        });
    }
}
