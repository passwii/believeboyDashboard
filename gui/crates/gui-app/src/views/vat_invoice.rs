//! 财务资金 → VAT 发票（P5-5，BLF-733）
//!
//! 对齐 web 端 `app/dashboard/finance/vat-invoice`（约 2200 行，双 Tab）的
//! **发票历史读取主面**：筛选（店铺 / 状态 / 关键字）+ 发票列表 + 单票详情
//! （元信息 + 买方 + 明细行 + 按 VAT 率汇总 + PDF 直达）。
//!
//! ## 与 web 端的取舍（issue 允许按 macOS 原生习惯精简并说明）
//!
//! - **保留**：四态状态机、三项筛选（店铺 = `vat_enabled` 项目，对齐 web
//!   历史面板 `all.filter(p => p.vat_enabled)`；状态 = 草稿/已签发/已作废，
//!   对齐 web `STATUS_OPTIONS`；关键字匹配发票号/订单号，后端 `q` LIKE）、
//!   7 列列表（发票号/店铺/买方/货币/日期/总额含税/状态徽标，对齐 web
//!   `InvoiceHistoryTable`）、单票详情（元信息 + 买方 + 明细行 + 按 VAT 率
//!   汇总 + 合计，对齐 web `InvoiceDetailDialog`）；
//! - **精简**：
//!   - 新建发票全流程（Seller 选择 / 表单 / 明细编辑 / 实时汇总 / 预览 /
//!     PDF 生成签发）与作废、CSV 导出走 web 端——签发依赖客户端 PDF 生成
//!     （web 用 jsPDF），GPUI 无等价物；写入链路对齐 BLF-726 发货管理 /
//!     BLF-731 订单信息 / BLF-732 汇率信息「写入走 web 端」取舍；
//!   - PDF 下载不经过需鉴权头的 `GET /vat-invoices/{id}/pdf` 302 端点，
//!     详情侧直接 `App::open_url(detail.r2_url)` 打开系统浏览器预览
//!     （GUI-12 站点导航直达范式，对齐 scheduled_reports「查看截图」）；
//!   - web 端详情为弹窗；GUI 用列表下方详情卡 + 发票下拉切换（列表加载后
//!     默认选中首票，对齐 BLF-726 发货管理详情交互）；
//!   - 列表无分页 UI（后端裸数组默认 `limit=100`，web 历史面板同样一次
//!     拉取不翻页）；
//!   - 手机端布局不移植（GUI 桌面端单布局）。
//!
//! ## 状态机
//!
//! `Loading`（首屏 / 筛选切换）→ `Loaded`（有数据）/ `Empty`（列表空，两档
//! 提示：筛选无结果 / 暂无数据）/ `Error`（请求失败）。详情独立加载相位
//! （`detail_loading` / `detail_error`），不阻塞列表态。

use gpui::prelude::*;
use gpui::{div, px, App, AsyncApp, Context, Entity, FontWeight, IntoElement, Render, SharedString, WeakEntity, Window};
use gpui_component::button::Button;
use gpui_component::input::{Input, InputEvent, InputState};
use gpui_component::menu::PopupMenuItem;
use gpui_component::{h_flex, v_flex, Sizable};
use gui_api_client::vat_invoice::VatInvoiceFilter;
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::vat_invoice::{
    status_label, summary_row_text, currency_symbol, VatInvoiceDetail, VatInvoiceListItem,
    STATUS_ISSUED, STATUS_OPTIONS, STATUS_VOIDED,
};

use crate::theme::AppTheme;
use crate::widgets::data_table::{CellAlign, ColumnDef, DataTable};
use crate::widgets::filter_bar;
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「财务资金 → VAT 发票」URL（数据权威 gui-domain::sidebar）
pub const VAT_INVOICE_URL: &str = "/dashboard/finance/vat-invoice";

/// 状态筛选选项（含「全部」语义由 `None` 承载）
const STATUS_FILTER_OPTIONS: [(&str, &str); 3] = STATUS_OPTIONS;

// ---------------------------------------------------------------------------
// 格式化 / 派生辅助
// ---------------------------------------------------------------------------

/// Decimal 字符串 → f64（解析失败 → 0.0；数值列排序用）
fn dec_f64(value: &str) -> f64 {
    value.trim().parse::<f64>().unwrap_or(0.0)
}

/// 千分位整数（与 exchange_rate 同款实现）
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

/// 文本兜底（空 / 空白 → 「—」）
fn text_or_dash(value: &str) -> String {
    if value.trim().is_empty() {
        "—".to_string()
    } else {
        value.to_string()
    }
}

/// 买方地址一行拼接（对齐 web `[address, postal, city, country].filter(Boolean).join(' ')`）
fn buyer_address_line(buyer: &gui_domain::vat_invoice::VatBuyer) -> String {
    let parts = [
        buyer.address_line.trim(),
        buyer.postal_code.trim(),
        buyer.city.trim(),
        buyer.country.trim(),
    ];
    parts
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// 状态徽标配色（draft = 中性 / issued = 成功 / voided = 危险；对齐 web
/// `STATUS_PILL`：neutral / success / negative）
fn status_pill_colors(status: &str, theme: &AppTheme) -> (gpui::Hsla, gpui::Hsla) {
    match status {
        STATUS_ISSUED => (theme.success_soft, theme.success),
        STATUS_VOIDED => (theme.danger_soft, theme.danger),
        _ => (theme.muted_fill, theme.text_secondary),
    }
}

/// 状态徽标单元格（对齐 shipment_management `status_pill` 观感：软底 + 描边）
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

/// VAT 发票载荷（Loaded 持有）
#[derive(Debug, Clone, PartialEq)]
pub struct VatInvoiceData {
    /// VAT 店铺列表（筛选下拉数据源；reload 间缓存）
    pub projects: Vec<ManagedProject>,
    /// 当前筛选下的发票列表（后端裸数组，默认最多 100 条）
    pub list: Vec<VatInvoiceListItem>,
}

impl VatInvoiceData {
    /// 空态判定：列表为空
    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }
}

/// VAT 发票状态机（四态；沿用既有 view 模式）
#[derive(Debug, Clone, PartialEq)]
pub enum VatInvoiceState {
    Loading,
    Loaded(Box<VatInvoiceData>),
    Empty,
    Error(String),
}

impl VatInvoiceState {
    /// 拉取结果 → 落点状态
    pub fn from_fetch_result(result: Result<VatInvoiceData, String>) -> Self {
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

/// VAT 发票视图（四态状态机 + 三项筛选 + 单票详情 + 竞态保护）
pub struct VatInvoiceView {
    state: Entity<VatInvoiceState>,
    /// 带会话的 API client
    client: Client,
    /// VAT 店铺缓存（筛选下拉数据源；首次 reload 拉取后复用）
    projects: Vec<ManagedProject>,
    /// 店铺筛选（`None` = 全部 VAT 店铺）
    project_filter: Option<i64>,
    /// 状态筛选（`None` = 全部状态）
    status_filter: Option<&'static str>,
    /// 已提交关键字（回车 / 「搜索」提交；对齐 web `q` 即时生效语义收敛为
    /// 显式提交——避免逐击键请求）
    committed_keyword: String,
    /// 关键字输入（懒建；`InputState::new` 需要 window）
    keyword_input: Option<Entity<InputState>>,
    /// 订阅持有（drop 即断）
    _subscriptions: Vec<gpui::Subscription>,
    /// 「清空筛选」的输入回填（`set_value` 需要 window，render 期应用）
    pending_inputs_reset: bool,
    /// 选中发票 id（详情加载入口；列表加载后按 [`resolve_selection`] 落点）
    selected_id: Option<i64>,
    /// 详情载荷
    detail: Option<VatInvoiceDetail>,
    /// 详情加载态
    detail_loading: bool,
    /// 详情错误
    detail_error: Option<String>,
    /// 详情竞态保护
    latest_detail_request_id: u64,
    /// 发票列表表（Stage 0 DataTable，总存在）
    list_table: Entity<DataTable<VatInvoiceListItem>>,
    /// 明细行表（Stage 0 DataTable，总存在）
    lines_table: Entity<DataTable<gui_domain::vat_invoice::VatInvoiceLine>>,
    /// 按 VAT 率汇总表（Stage 0 DataTable，总存在；行 = `serde_json::Value`）
    summary_table: Entity<DataTable<serde_json::Value>>,
    /// 主请求竞态保护
    latest_request_id: u64,
}

impl VatInvoiceView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| VatInvoiceState::Loading);
        let list_table = cx.new(|_| {
            DataTable::new("vat-invoice-list", list_columns())
                .striped(true)
                .empty_text("当前筛选条件下暂无发票")
        });
        let lines_table = cx.new(|_| {
            DataTable::new("vat-invoice-lines", line_columns())
                .striped(true)
                .empty_text("该发票暂无明细行")
        });
        let summary_table = cx.new(|_| {
            DataTable::new("vat-invoice-summary", summary_columns())
                .striped(true)
                .empty_text("暂无汇总数据")
        });
        Self {
            state,
            client,
            projects: Vec::new(),
            project_filter: None,
            status_filter: None,
            committed_keyword: String::new(),
            keyword_input: None,
            _subscriptions: Vec::new(),
            pending_inputs_reset: false,
            selected_id: None,
            detail: None,
            detail_loading: false,
            detail_error: None,
            latest_detail_request_id: 0,
            list_table,
            lines_table,
            summary_table,
            latest_request_id: 0,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> VatInvoiceState {
        self.state.read(cx).clone()
    }

    /// 组装当前筛选（列表口径；`q` 空白串不携带）
    fn build_filter(&self) -> VatInvoiceFilter {
        VatInvoiceFilter {
            project_id: self.project_filter,
            status: self.status_filter.map(str::to_string),
            q: Some(self.committed_keyword.clone()).filter(|s| !s.is_empty()),
        }
    }

    /// 是否有任何筛选生效（空态两档提示用）
    fn has_active_filters(&self) -> bool {
        self.project_filter.is_some() || self.status_filter.is_some() || !self.committed_keyword.is_empty()
    }

    /// 重新拉取：首屏 / 筛选切换 / 错误重试 / 空态刷新共用入口（竞态保护；
    /// 每次调用递增 `latest_request_id` 并进入 Loading）。筛选切换后详情缓存
    /// 失效（落点后按新列表重建）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let filter = self.build_filter();
        let projects_cache = if self.projects.is_empty() {
            None
        } else {
            Some(self.projects.clone())
        };

        self.detail = None;
        self.detail_error = None;
        self.detail_loading = false;

        self.state.update(cx, |state, cx| {
            *state = VatInvoiceState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(load_main(&client, projects_cache, filter))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_main_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 应用主数据拉取结果（竞态保护）：落点店铺缓存 + 列表表格 + 选区，
    /// 随后按选区触发详情拉取。
    fn apply_main_result(
        &mut self,
        request_id: u64,
        result: Result<VatInvoiceData, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        let next = VatInvoiceState::from_fetch_result(result);
        if let VatInvoiceState::Loaded(data) = &next {
            self.projects = data.projects.clone();
            self.list_table.update(cx, |t, cx| {
                t.set_rows(data.list.clone(), cx);
            });
            let selection = resolve_selection(self.selected_id, &data.list);
            self.selected_id = selection;
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

    /// 切换店铺筛选（同一店铺为 no-op；`None` = 全部 VAT 店铺）
    pub fn select_project(&mut self, project_id: Option<i64>, cx: &mut Context<Self>) {
        if project_id == self.project_filter {
            return;
        }
        self.project_filter = project_id;
        self.reload(cx);
    }

    /// 切换状态筛选（同一状态为 no-op；`None` = 全部状态）
    pub fn select_status(&mut self, status: Option<&'static str>, cx: &mut Context<Self>) {
        if status == self.status_filter {
            return;
        }
        self.status_filter = status;
        self.reload(cx);
    }

    /// 提交关键字（回车 / 「搜索」按钮）：读输入框当前值（trim），
    /// 变化才重拉（对齐 order_info committed 关键字语义）
    pub fn apply_keyword(&mut self, cx: &mut Context<Self>) {
        let keyword = self
            .keyword_input
            .as_ref()
            .map(|input| input.read(cx).value().trim().to_string())
            .unwrap_or_default();
        if keyword == self.committed_keyword {
            return;
        }
        self.committed_keyword = keyword;
        self.reload(cx);
    }

    /// 清空筛选（全部条件复位 + 输入框回填）
    pub fn clear_filters(&mut self, cx: &mut Context<Self>) {
        self.project_filter = None;
        self.status_filter = None;
        self.committed_keyword = String::new();
        self.pending_inputs_reset = true;
        self.reload(cx);
    }

    /// 切换选中发票（详情下拉；同一发票为 no-op）
    pub fn select_invoice(&mut self, invoice_id: i64, cx: &mut Context<Self>) {
        if Some(invoice_id) == self.selected_id {
            return;
        }
        self.selected_id = Some(invoice_id);
        self.load_detail(cx);
    }

    /// 拉取选中发票详情（竞态保护）
    pub fn load_detail(&mut self, cx: &mut Context<Self>) {
        let Some(invoice_id) = self.selected_id else {
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
                            .vat_invoice_detail(invoice_id)
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
        result: Result<VatInvoiceDetail, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_detail_request_id {
            return;
        }
        self.detail_loading = false;
        match result {
            Ok(detail) => {
                self.lines_table.update(cx, |t, cx| {
                    t.set_rows(detail.lines.clone(), cx);
                });
                self.summary_table.update(cx, |t, cx| {
                    t.set_rows(detail.summary_by_rate.clone(), cx);
                });
                self.detail = Some(detail);
            }
            Err(msg) => {
                self.detail = None;
                self.lines_table
                    .update(cx, |t, cx| t.set_rows(Vec::new(), cx));
                self.summary_table
                    .update(cx, |t, cx| t.set_rows(Vec::new(), cx));
                self.detail_error = Some(msg);
            }
        }
        cx.notify();
    }

    /// 懒建关键字输入（首帧；`InputState::new` 需要 window）+ 回车订阅
    fn ensure_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.keyword_input.is_none() {
            let input =
                cx.new(|cx| InputState::new(window, cx).placeholder("INV-… 或 ORDER-…"));
            let sub = cx.subscribe(&input, |this, _entity, event: &InputEvent, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    this.apply_keyword(cx);
                }
            });
            self.keyword_input = Some(input);
            self._subscriptions.push(sub);
        }
        // 「清空筛选」的输入回填（set_value 需要 window，render 期应用）
        if self.pending_inputs_reset {
            self.pending_inputs_reset = false;
            if let Some(input) = &self.keyword_input {
                input.update(cx, |state, cx| state.set_value("", window, cx));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 数据加载辅助函数
// ---------------------------------------------------------------------------

/// 主数据加载：店铺列表（缓存缺省时拉取，仅保留 `vat_enabled`——对齐 web
/// 历史面板 `all.filter(p => p.vat_enabled)`）→ 发票列表
async fn load_main(
    client: &Client,
    projects_cache: Option<Vec<ManagedProject>>,
    filter: VatInvoiceFilter,
) -> Result<VatInvoiceData, String> {
    let projects = match projects_cache {
        Some(projects) => projects,
        None => client
            .list_managed_projects()
            .await
            .map_err(|e| e.user_message())?
            .into_iter()
            .filter(|p| p.vat_enabled)
            .collect(),
    };
    let list = client
        .vat_invoice_list(&filter)
        .await
        .map_err(|e| e.user_message())?;
    Ok(VatInvoiceData { projects, list })
}

/// 选区落点（对齐 web `setSelectedId` 语义：当前选中仍在列表 → 保留；
/// 否则取首张；空列表 → `None`）
fn resolve_selection(current: Option<i64>, items: &[VatInvoiceListItem]) -> Option<i64> {
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

// ---------------------------------------------------------------------------
// 列定义
// ---------------------------------------------------------------------------

/// 发票列表 7 列（对齐 web `InvoiceHistoryTable`：发票号/店铺/买方/货币/日期
/// /总额含税/状态；「操作」列随详情卡 + 写入走 web 端精简移除）
fn list_columns() -> Vec<ColumnDef<VatInvoiceListItem>> {
    vec![
        ColumnDef::text("invoice-no", "发票号", |r: &VatInvoiceListItem, _| {
            SharedString::from(r.invoice_no.clone())
        })
        .width(130.0),
        ColumnDef::text("project", "店铺", |r: &VatInvoiceListItem, _| {
            SharedString::from(text_or_dash(&r.project_name))
        })
        .width(120.0),
        ColumnDef::text("buyer", "买方", |r: &VatInvoiceListItem, _| {
            SharedString::from(text_or_dash(&r.buyer_name))
        })
        .width(150.0),
        ColumnDef::text("currency", "货币", |r: &VatInvoiceListItem, _| {
            SharedString::from(r.currency.clone())
        })
        .width(64.0),
        ColumnDef::text("date", "日期", |r: &VatInvoiceListItem, _| {
            SharedString::from(text_or_dash(&r.invoice_date))
        })
        .width(100.0),
        ColumnDef::number(
            "total-incl",
            "总额（含税）",
            |r: &VatInvoiceListItem| r.total_incl_f64(),
            |r: &VatInvoiceListItem, _| SharedString::from(text_or_dash(&r.total_incl)),
        )
        .width(110.0),
        ColumnDef::text("status", "状态", |r: &VatInvoiceListItem, _| {
            SharedString::from(status_label(&r.status))
        })
        .with_render_element(|r: &VatInvoiceListItem, theme: &AppTheme| {
            status_pill(&r.status, theme)
        })
        .width(84.0),
    ]
}

/// 明细行 7 列（对齐 web 详情弹窗明细表：#/描述/ASIN/数量/含税单价/VAT%/小计）
fn line_columns() -> Vec<ColumnDef<gui_domain::vat_invoice::VatInvoiceLine>> {
    vec![
        ColumnDef::number(
            "line-no",
            "#",
            |r: &gui_domain::vat_invoice::VatInvoiceLine| r.line_no as f64,
            |r: &gui_domain::vat_invoice::VatInvoiceLine, _| {
                SharedString::from(r.line_no.to_string())
            },
        )
        .width(44.0),
        ColumnDef::text(
            "line-desc",
            "描述",
            |r: &gui_domain::vat_invoice::VatInvoiceLine, _| {
                SharedString::from(text_or_dash(&r.description))
            },
        )
        .width(220.0),
        ColumnDef::text(
            "line-asin",
            "ASIN",
            |r: &gui_domain::vat_invoice::VatInvoiceLine, _| {
                SharedString::from(text_or_dash(&r.asin))
            },
        )
        .width(110.0),
        ColumnDef::number(
            "line-qty",
            "数量",
            |r: &gui_domain::vat_invoice::VatInvoiceLine| r.qty as f64,
            |r: &gui_domain::vat_invoice::VatInvoiceLine, _| {
                SharedString::from(r.qty.to_string())
            },
        )
        .width(64.0),
        ColumnDef::number(
            "line-unit-price",
            "含税单价",
            |r: &gui_domain::vat_invoice::VatInvoiceLine| {
                dec_f64(&r.unit_price_incl_vat)
            },
            |r: &gui_domain::vat_invoice::VatInvoiceLine, _| {
                SharedString::from(text_or_dash(&r.unit_price_incl_vat))
            },
        )
        .width(100.0),
        ColumnDef::number(
            "line-vat-rate",
            "VAT%",
            |r: &gui_domain::vat_invoice::VatInvoiceLine| dec_f64(&r.vat_rate),
            |r: &gui_domain::vat_invoice::VatInvoiceLine, _| {
                SharedString::from(text_or_dash(&r.vat_rate))
            },
        )
        .width(64.0),
        ColumnDef::number(
            "line-incl",
            "小计",
            |r: &gui_domain::vat_invoice::VatInvoiceLine| dec_f64(&r.line_incl),
            |r: &gui_domain::vat_invoice::VatInvoiceLine, _| {
                SharedString::from(text_or_dash(&r.line_incl))
            },
        )
        .width(100.0),
    ]
}

/// 按 VAT 率汇总 6 列（对齐 web 详情弹窗汇总表；行字段经
/// [`summary_row_text`] 防御式读取——无捕获闭包即 fn pointer，逐列内联）
fn summary_columns() -> Vec<ColumnDef<serde_json::Value>> {
    vec![
        ColumnDef::text("sum-rate", "VAT%", |row: &serde_json::Value, _| {
            SharedString::from(summary_row_text(row, "rate"))
        })
        .width(64.0),
        ColumnDef::text("sum-item-excl", "商品不含税", |row: &serde_json::Value, _| {
            SharedString::from(summary_row_text(row, "item_excl"))
        })
        .align(CellAlign::Right)
        .width(100.0),
        ColumnDef::text("sum-item-vat", "商品 VAT", |row: &serde_json::Value, _| {
            SharedString::from(summary_row_text(row, "item_vat"))
        })
        .align(CellAlign::Right)
        .width(96.0),
        ColumnDef::text("sum-ship-excl", "运费不含税", |row: &serde_json::Value, _| {
            SharedString::from(summary_row_text(row, "shipping_excl"))
        })
        .align(CellAlign::Right)
        .width(100.0),
        ColumnDef::text("sum-ship-vat", "运费 VAT", |row: &serde_json::Value, _| {
            SharedString::from(summary_row_text(row, "shipping_vat"))
        })
        .align(CellAlign::Right)
        .width(96.0),
        ColumnDef::text("sum-total", "合计", |row: &serde_json::Value, _| {
            SharedString::from(summary_row_text(row, "total"))
        })
        .align(CellAlign::Right)
        .width(100.0),
    ]
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for VatInvoiceView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let view = cx.entity();
        self.ensure_inputs(window, cx);
        let subtitle = match &state {
            VatInvoiceState::Loaded(data) => format!(
                "共 {} 张发票 · 新建 / 作废 / CSV 导出请在 web 端操作",
                fmt_int(data.list.len() as i64)
            ),
            _ => "欧洲订单 VAT 发票签发与历史管理；新建发票请在 web 端操作".to_string(),
        };

        // Pattern D 套版：页头 + 筛选工具栏带 + 主体（无站点卡，VAT 发票为
        // 多币种历史读取面——站点选择器关闭，币种语义由数据行自带）
        crate::widgets::pattern_d::pattern_d_shell(
            &app_theme,
            "vat-invoice",
            PageHeader::new("VAT 发票").subtitle(subtitle),
            content_guard().child(render_filter_card(self, view.clone(), &app_theme)),
            false,
            div(),
            v_flex()
                .id("vat-invoice-body")
                .size_full()
                .gap_4()
                .p_4()
                .overflow_y_scroll()
            .child(match state {
                VatInvoiceState::Loading => render_loading(&app_theme).into_any_element(),
                VatInvoiceState::Error(msg) => state_views::error_state(
                    &view,
                    &app_theme,
                    "vat-invoice-error",
                    "VAT 发票加载失败",
                    msg,
                    |this, cx| this.reload(cx),
                )
                .into_any_element(),
                VatInvoiceState::Empty => {
                    let message = empty_message(self);
                    state_views::empty_state_with_action_desc(
                        &view,
                        &app_theme,
                        "vat-invoice-empty",
                        "icons/receipt.svg",
                        message,
                        Some("新建发票、作废与 CSV 导出请在 web 端操作".to_string()),
                        "刷新",
                        |this, cx| this.reload(cx),
                    )
                    .into_any_element()
                }
                VatInvoiceState::Loaded(data) => render_loaded(
                    &view,
                    cx,
                    &app_theme,
                    &data,
                    self.selected_id,
                    self.detail.clone(),
                    self.detail_loading,
                    self.detail_error.clone(),
                    self.list_table.clone(),
                    self.lines_table.clone(),
                    self.summary_table.clone(),
                )
                .into_any_element(),
            }),
        )
    }
}

/// 空态两档提示（筛选无结果 > 暂无数据）
fn empty_message(view: &VatInvoiceView) -> String {
    if view.has_active_filters() {
        "当前筛选条件下无发票 — 可调整筛选条件或点击「重置」".to_string()
    } else {
        "暂无 VAT 发票 — 新建发票请在 web 端操作".to_string()
    }
}

/// 筛选卡（一行：店铺 / 状态下拉 + 关键字输入 + 搜索 / 重置 / 刷新）
fn render_filter_card(
    view: &VatInvoiceView,
    view_entity: Entity<VatInvoiceView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let project_label: SharedString = match view.project_filter {
        Some(id) => view
            .projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| SharedString::from(p.name.clone()))
            .unwrap_or_else(|| SharedString::from("全部店铺")),
        None => SharedString::from("全部店铺"),
    };
    let status_label_text: SharedString = SharedString::from(
        view.status_filter
            .and_then(|value| {
                STATUS_FILTER_OPTIONS
                    .iter()
                    .find(|(v, _)| *v == value)
                    .map(|(_, label)| label.to_string())
            })
            .unwrap_or_else(|| "全部状态".to_string()),
    );

    let projects_owned = view.projects.clone();
    let status_filter = view.status_filter;
    let project_filter = view.project_filter;
    let keyword_input = view.keyword_input.clone();

    let view_for_project = view_entity.clone();
    let view_for_status = view_entity.clone();
    let view_for_search = view_entity.clone();
    let view_for_reset = view_entity.clone();
    let view_for_refresh = view_entity.clone();

    filter_bar::filter_bar_layout(theme)
        .id("vat-invoice-filters")
        .child(filter_bar::filter_select(
            theme,
            "店铺",
            project_label,
            "vat-invoice-project-filter",
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
            "状态",
            status_label_text,
            "vat-invoice-status-filter",
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
                for (value, label) in STATUS_FILTER_OPTIONS.iter() {
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
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.text_secondary)
                        .child("关键字"),
                )
                .when_some(keyword_input, |this, input| {
                    this.child(div().w(px(180.)).child(Input::new(&input)))
                }),
        )
        .child(
            Button::new("vat-invoice-search")
                .outline()
                .small()
                .label("搜索")
                .on_click(move |_ev, _w, cx| {
                    view_for_search.update(cx, |this, cx| this.apply_keyword(cx));
                }),
        )
        .child(
            Button::new("vat-invoice-reset")
                .outline()
                .small()
                .label("重置")
                .on_click(move |_ev, _w, cx| {
                    view_for_reset.update(cx, |this, cx| this.clear_filters(cx));
                }),
        )
        .child(div().flex_1())
        .child(
            Button::new("vat-invoice-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_ev, _w, cx| {
                    view_for_refresh.update(cx, |this, cx| this.reload(cx));
                }),
        )
        .into_any_element()
}

// ---------------------------------------------------------------------------
// 四态渲染
// ---------------------------------------------------------------------------

fn render_loading(theme: &AppTheme) -> impl IntoElement {
    state_views::skeleton_loading(
        theme,
        &[
            SkeletonBlock::Table(320.0),
            SkeletonBlock::Table(200.0),
        ],
    )
}

#[allow(clippy::too_many_arguments)]
fn render_loaded(
    view: &Entity<VatInvoiceView>,
    cx: &mut Context<VatInvoiceView>,
    theme: &AppTheme,
    data: &VatInvoiceData,
    selected_id: Option<i64>,
    detail: Option<VatInvoiceDetail>,
    detail_loading: bool,
    detail_error: Option<String>,
    list_table: Entity<DataTable<VatInvoiceListItem>>,
    lines_table: Entity<DataTable<gui_domain::vat_invoice::VatInvoiceLine>>,
    summary_table: Entity<DataTable<serde_json::Value>>,
) -> gpui::AnyElement {
    let reduce = crate::motion::reduce_motion(cx);

    crate::motion::enter_fade_in(
        SharedString::from("vat-invoice-loaded-fade"),
        v_flex()
            .id("vat-invoice-loaded")
            .gap_4()
            // 发票列表
            .child(content_guard().child(list_section(theme, data, list_table)))
            // 单票详情（元信息 + 明细行 + 汇总）
            .child(content_guard().child(detail_section(
                view,
                theme,
                &data.list,
                selected_id,
                detail,
                detail_loading,
                detail_error,
                lines_table,
                summary_table,
            ))),
        reduce,
    )
    .into_any_element()
}

/// 列表卡（表格 + 条数脚注；后端裸数组默认最多 100 条，对齐 web 不翻页）
fn list_section(
    theme: &AppTheme,
    data: &VatInvoiceData,
    list_table: Entity<DataTable<VatInvoiceListItem>>,
) -> impl IntoElement {
    v_flex()
        .id("vat-invoice-list-card")
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
                        .child("发票历史"),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child("已签发 / 草稿 / 作废发票；点击表头可排序"),
                ),
        )
        .child(div().w_full().px_4().py_2().child(list_table))
        .child(
            div()
                .px_4()
                .pb_2()
                .text_xs()
                .text_color(theme.text_muted)
                .child(SharedString::from(format!(
                    "共 {} 张发票（单次最多返回 100 条）",
                    fmt_int(data.list.len() as i64)
                ))),
        )
}

// ---------------------------------------------------------------------------
// 详情卡（元信息 + 明细行 + 汇总）
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn detail_section(
    view: &Entity<VatInvoiceView>,
    theme: &AppTheme,
    items: &[VatInvoiceListItem],
    selected_id: Option<i64>,
    detail: Option<VatInvoiceDetail>,
    detail_loading: bool,
    detail_error: Option<String>,
    lines_table: Entity<DataTable<gui_domain::vat_invoice::VatInvoiceLine>>,
    summary_table: Entity<DataTable<serde_json::Value>>,
) -> impl IntoElement {
    let selected = selected_id.and_then(|id| items.iter().find(|item| item.id == id));
    let selected_label: SharedString = selected
        .map(|item| SharedString::from(item.invoice_no.clone()))
        .unwrap_or_else(|| SharedString::from("请选择发票"));

    let items_owned = items.to_vec();
    let view_for_select = view.clone();
    let view_for_retry = view.clone();

    let mut header = h_flex()
        .gap_3()
        .items_center()
        .flex_wrap()
        .child(
            div()
                .text_base()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_primary)
                .child("发票详情"),
        )
        .child(filter_bar::filter_select(
            theme,
            "发票",
            selected_label,
            "vat-invoice-detail-select",
            move |menu, _window, _cx| {
                let mut menu = menu;
                for item in &items_owned {
                    let view = view_for_select.clone();
                    let id = item.id;
                    let checked = Some(id) == selected_id;
                    let label = format!("{} · {}", item.invoice_no, item.project_name);
                    menu = menu.item(PopupMenuItem::new(label).checked(checked).on_click(
                        move |_ev, _w, cx| {
                            view.update(cx, |this, cx| this.select_invoice(id, cx));
                        },
                    ));
                }
                menu
            },
        ));

    // 查看 PDF（详情携带 R2 公共 URL 时展示；系统默认浏览器打开）
    if let Some(url) = detail
        .as_ref()
        .and_then(|d| d.r2_url.clone())
        .filter(|s| !s.trim().is_empty())
    {
        header = header.child(
            Button::new("vat-invoice-detail-pdf")
                .outline()
                .small()
                .label("查看 PDF")
                .on_click(move |_, _window, cx| {
                    cx.open_url(&url);
                }),
        );
    }

    let body: gpui::AnyElement = match (detail_loading, &detail_error, &detail) {
        (true, _, _) => state_views::loading_state(theme, "加载发票详情中…").into_any_element(),
        (false, Some(msg), _) => v_flex()
            .id("vat-invoice-detail-error")
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
                Button::new("vat-invoice-detail-retry")
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
            "vat-invoice-detail-empty",
            "icons/receipt.svg",
            "选择发票后自动加载详情".to_string(),
        )
        .into_any_element(),
        (false, None, Some(detail)) => v_flex()
            .gap_3()
            .child(detail_meta_grid(theme, detail, selected))
            .child(
                v_flex()
                    .gap_1()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text_primary)
                            .child("明细行"),
                    )
                    .child(div().w_full().child(lines_table)),
            )
            .child(
                v_flex()
                    .gap_1()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text_primary)
                            .child("按 VAT 率汇总"),
                    )
                    .child(div().w_full().child(summary_table))
                    .child(detail_totals_row(theme, detail)),
            )
            .into_any_element(),
    };

    v_flex()
        .id("vat-invoice-detail-card")
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

/// 详情元信息栅格（状态徽标 + 发票号/店铺/货币/订单号/日期/运费 + 买方 +
/// 作废原因）
fn detail_meta_grid(
    theme: &AppTheme,
    detail: &VatInvoiceDetail,
    selected: Option<&VatInvoiceListItem>,
) -> impl IntoElement {
    let cells: Vec<(&'static str, String)> = vec![
        ("发票号", detail.invoice_no.clone()),
        (
            "店铺",
            selected
                .map(|item| item.project_name.clone())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| detail.project_id.to_string()),
        ),
        (
            "货币",
            format!("{} {}", detail.currency, currency_symbol(&detail.currency)).trim().to_string(),
        ),
        ("订单号", text_or_dash(&detail.order_id)),
        ("开票日期", text_or_dash(&detail.invoice_date)),
        ("运费（含税）", text_or_dash(&detail.shipping_incl_vat)),
    ];

    let address = buyer_address_line(&detail.buyer);

    let mut grid = div()
        .id("vat-invoice-detail-meta")
        .grid()
        .grid_cols(4)
        .gap_3()
        // 状态单独用徽标渲染（首格）
        .child(
            v_flex()
                .gap_1()
                .child(div().text_xs().text_color(theme.text_muted).child("状态"))
                .child(status_pill(&detail.status, theme)),
        )
        .children(cells.into_iter().map(|(label, value)| {
            v_flex()
                .gap_1()
                .child(div().text_xs().text_color(theme.text_muted).child(label))
                .child(div().text_sm().text_color(theme.text_primary).child(value))
        }));

    // 买方块（对齐 web 详情弹窗「买方」section）
    if !detail.buyer.name.trim().is_empty() || !address.is_empty() {
        let buyer_text = if address.is_empty() {
            detail.buyer.name.clone()
        } else if detail.buyer.name.trim().is_empty() {
            address
        } else {
            format!("{}\n{address}", detail.buyer.name)
        };
        grid = grid.child(
            v_flex()
                .gap_1()
                .col_span(2)
                .child(div().text_xs().text_color(theme.text_muted).child("买方"))
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.text_primary)
                        .child(SharedString::from(buyer_text)),
                ),
        );
    }

    // 作废原因（对齐 web 详情弹窗 destructive 提示）
    if let Some(reason) = detail
        .void_reason
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        grid = grid.child(
            v_flex()
                .gap_1()
                .col_span(4)
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.danger)
                        .child(SharedString::from(format!("作废原因：{reason}"))),
                ),
        );
    }

    grid
}

/// 汇总合计行（不含税合计 / VAT 合计 / 含税合计；金额为后端原值字符串）
fn detail_totals_row(theme: &AppTheme, detail: &VatInvoiceDetail) -> impl IntoElement {
    h_flex()
        .id("vat-invoice-detail-totals")
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
            "不含税合计 {}",
            text_or_dash(&detail.subtotal_excl)
        )))
        .child(SharedString::from(format!(
            "VAT 合计 {}",
            text_or_dash(&detail.total_vat)
        )))
        .child(
            div()
                .text_sm()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_primary)
                .child(SharedString::from(format!(
                    "含税合计 {} {}",
                    text_or_dash(&detail.total_incl),
                    detail.currency
                ))),
        )
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
        assert_eq!(VAT_INVOICE_URL, "/dashboard/finance/vat-invoice");
    }

    #[test]
    fn status_filter_options_align_with_domain() {
        assert_eq!(STATUS_FILTER_OPTIONS.len(), 3);
        assert_eq!(STATUS_FILTER_OPTIONS[0].0, gui_domain::vat_invoice::STATUS_DRAFT);
        assert_eq!(STATUS_FILTER_OPTIONS[1].0, STATUS_ISSUED);
        assert_eq!(STATUS_FILTER_OPTIONS[2].0, STATUS_VOIDED);
    }

    #[test]
    fn status_pill_colors_follow_web_pill_semantics() {
        let theme = AppTheme::light();
        // issued → 成功色；voided → 危险色；draft（与其余）→ 中性
        let (issued_bg, _) = status_pill_colors(STATUS_ISSUED, &theme);
        let (voided_bg, _) = status_pill_colors(STATUS_VOIDED, &theme);
        let (draft_bg, _) = status_pill_colors(gui_domain::vat_invoice::STATUS_DRAFT, &theme);
        let (unknown_bg, _) = status_pill_colors("weird", &theme);
        assert_eq!(issued_bg, theme.success_soft);
        assert_eq!(voided_bg, theme.danger_soft);
        assert_eq!(draft_bg, theme.muted_fill);
        assert_eq!(unknown_bg, theme.muted_fill);
    }

    #[test]
    fn dec_f64_parses_decimal_strings_with_fallback() {
        assert_eq!(dec_f64("41.98"), 41.98);
        assert_eq!(dec_f64(" 19 "), 19.0);
        assert_eq!(dec_f64(""), 0.0);
        assert_eq!(dec_f64("n/a"), 0.0);
    }

    #[test]
    fn fmt_int_handles_thousands_and_negative() {
        assert_eq!(fmt_int(0), "0");
        assert_eq!(fmt_int(1_234_567), "1,234,567");
        assert_eq!(fmt_int(-4200), "-4,200");
    }

    #[test]
    fn text_or_dash_blanks_fall_back() {
        assert_eq!(text_or_dash("INV-5"), "INV-5");
        assert_eq!(text_or_dash(""), "—");
        assert_eq!(text_or_dash("   "), "—");
    }

    #[test]
    fn buyer_address_line_joins_non_empty_parts() {
        let mut buyer = gui_domain::vat_invoice::VatBuyer {
            name: "Hans".into(),
            address_line: "Weg 1".into(),
            postal_code: "10115".into(),
            city: "Berlin".into(),
            country: "DE".into(),
        };
        assert_eq!(buyer_address_line(&buyer), "Weg 1 10115 Berlin DE");
        buyer.address_line = String::new();
        buyer.postal_code = String::new();
        assert_eq!(buyer_address_line(&buyer), "Berlin DE");
        buyer.city = String::new();
        buyer.country = String::new();
        assert_eq!(buyer_address_line(&buyer), "");
    }

    // ---------- 样本构造 ----------

    fn sample_item(id: i64) -> VatInvoiceListItem {
        VatInvoiceListItem {
            id,
            invoice_no: format!("INV-{id}"),
            project_id: 3,
            project_name: "德国店".into(),
            currency: "EUR".into(),
            order_id: format!("111-{id:04}"),
            buyer_name: "Hans".into(),
            invoice_date: "2026-08-01".into(),
            subtotal_excl: "35.36".into(),
            total_vat: "6.62".into(),
            total_incl: "41.98".into(),
            status: gui_domain::vat_invoice::STATUS_ISSUED.into(),
            has_pdf: true,
            created_at: "2026-08-01T00:00:00+00:00".into(),
            updated_at: "2026-08-02T00:00:00+00:00".into(),
        }
    }

    fn sample_detail(id: i64) -> VatInvoiceDetail {
        VatInvoiceDetail {
            id,
            invoice_no: format!("INV-{id}"),
            project_id: 3,
            seller_entity_id: Some(2),
            seller_snapshot: serde_json::json!({"company_name": "ACME EU GmbH"}),
            buyer: gui_domain::vat_invoice::VatBuyer {
                name: "Hans".into(),
                address_line: "Weg 1".into(),
                postal_code: "10115".into(),
                city: "Berlin".into(),
                country: "DE".into(),
            },
            currency: "EUR".into(),
            order_id: "111-0001".into(),
            invoice_date: "2026-08-01".into(),
            shipping_incl_vat: "0.00".into(),
            subtotal_excl: "35.36".into(),
            total_vat: "6.62".into(),
            total_incl: "41.98".into(),
            summary_by_rate: vec![serde_json::json!({
                "rate": "19", "item_excl": "35.36", "item_vat": "6.62",
                "shipping_excl": "0.00", "shipping_vat": "0.00", "total": "41.98"
            })],
            r2_key: Some("vat-invoice/x.pdf".into()),
            r2_url: Some("https://r2/x.pdf".into()),
            status: gui_domain::vat_invoice::STATUS_ISSUED.into(),
            void_reason: None,
            created_by: None,
            created_at: "2026-08-01T00:00:00+00:00".into(),
            updated_at: "2026-08-02T00:00:00+00:00".into(),
            lines: vec![gui_domain::vat_invoice::VatInvoiceLine {
                id: 9,
                line_no: 1,
                description: "T-shirt".into(),
                asin: "B0X".into(),
                qty: 2,
                unit_price_incl_vat: "20.99".into(),
                vat_rate: "19".into(),
                line_excl: "35.28".into(),
                line_vat: "6.70".into(),
                line_incl: "41.98".into(),
            }],
        }
    }

    fn sample_data(items: Vec<VatInvoiceListItem>) -> VatInvoiceData {
        VatInvoiceData {
            projects: vec![ManagedProject {
                id: 3,
                name: "德国店".into(),
                vat_enabled: true,
                ..ManagedProject::default()
            }],
            list: items,
        }
    }

    /// 构造一个 dummy client（无有效 base_url；仅用于构造视图；不实际发请求）
    fn dummy_client() -> Client {
        Client::new("http://127.0.0.1:1")
    }

    // ---------- 状态机 ----------

    #[test]
    fn state_from_result_maps_correctly() {
        assert_eq!(
            VatInvoiceState::from_fetch_result(Ok(sample_data(Vec::new()))),
            VatInvoiceState::Empty
        );
        assert!(matches!(
            VatInvoiceState::from_fetch_result(Ok(sample_data(vec![sample_item(1)]))),
            VatInvoiceState::Loaded(_)
        ));
        assert_eq!(
            VatInvoiceState::from_fetch_result(Err("boom".into())),
            VatInvoiceState::Error("boom".into())
        );
    }

    #[test]
    fn selection_resolves_keep_or_first() {
        let items = vec![sample_item(1), sample_item(2)];
        // 选中仍在列表 → 保留
        assert_eq!(resolve_selection(Some(2), &items), Some(2));
        // 选中不在列表 → 落首张
        assert_eq!(resolve_selection(Some(99), &items), Some(1));
        // 未选中 → 首张
        assert_eq!(resolve_selection(None, &items), Some(1));
        // 空列表 → None
        assert_eq!(resolve_selection(Some(1), &[]), None);
    }

    // ---------- 渲染冒烟（亮 / 暗 × 四态 + 详情相位） ----------

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
                cx.add_window_view(|_window, cx| VatInvoiceView::new(cx, dummy_client()));
        }
    }

    #[gpui::test]
    async fn renders_loaded_in_light_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let (view, cx2) =
            cx.add_window_view(|_window, cx| VatInvoiceView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            let data = sample_data(vec![sample_item(1), sample_item(2)]);
            this.list_table.update(cx, |t, cx| {
                t.set_rows(data.list.clone(), cx);
            });
            this.selected_id = resolve_selection(None, &data.list);
            this.state.update(cx, |state, _| {
                *state = VatInvoiceState::Loaded(Box::new(data));
            });
        });
        cx2.read(|app| assert!(!crate::theme::AppTheme::current(app).is_dark()));
    }

    #[gpui::test]
    async fn renders_loaded_with_detail_in_dark_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (view, cx2) =
            cx.add_window_view(|_window, cx| VatInvoiceView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            let data = sample_data(vec![sample_item(1)]);
            this.list_table.update(cx, |t, cx| {
                t.set_rows(data.list.clone(), cx);
            });
            let detail = sample_detail(1);
            this.lines_table.update(cx, |t, cx| {
                t.set_rows(detail.lines.clone(), cx);
            });
            this.summary_table.update(cx, |t, cx| {
                t.set_rows(detail.summary_by_rate.clone(), cx);
            });
            this.detail = Some(detail);
            this.selected_id = Some(1);
            this.state.update(cx, |state, _| {
                *state = VatInvoiceState::Loaded(Box::new(data));
            });
        });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    #[gpui::test]
    async fn renders_error_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| VatInvoiceView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = VatInvoiceState::Error("服务不可用".into());
            });
        });
    }

    #[gpui::test]
    async fn renders_empty_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| VatInvoiceView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = VatInvoiceState::Empty;
            });
        });
    }

    #[gpui::test]
    async fn renders_loaded_with_reduce_motion(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            cx.set_global(crate::motion::MotionPref(true));
        });
        let (view, cx2) =
            cx.add_window_view(|_window, cx| VatInvoiceView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            let data = sample_data(vec![sample_item(1)]);
            this.list_table.update(cx, |t, cx| {
                t.set_rows(data.list.clone(), cx);
            });
            this.state.update(cx, |state, _| {
                *state = VatInvoiceState::Loaded(Box::new(data));
            });
        });
    }

    // ---------- 状态机动作 ----------

    /// 筛选动作：店铺 / 状态 / 关键字切换即重拉（同值 no-op）；重置全部复位 +
    /// 输入回填标记；详情下拉切换不触发主列表重拉
    #[gpui::test]
    async fn filter_actions_reload_and_noop_on_same_value(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| VatInvoiceView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            // 同值 no-op
            let before = this.latest_request_id;
            this.select_project(None, cx);
            this.select_status(None, cx);
            this.apply_keyword(cx);
            assert_eq!(this.latest_request_id, before);

            // 切换店铺 / 状态 → 重拉
            this.select_project(Some(3), cx);
            assert_eq!(this.project_filter, Some(3));
            this.select_status(Some(STATUS_ISSUED), cx);
            assert_eq!(this.status_filter, Some(STATUS_ISSUED));

            // 关键字提交（输入框未建 → 读空串；committed 非空时提交空串 = 变化）
            this.committed_keyword = "INV-5".into();
            this.apply_keyword(cx);
            assert_eq!(this.committed_keyword, "");

            // 重置：全部条件复位 + 输入回填标记
            this.project_filter = Some(3);
            this.committed_keyword = "ORDER-1".into();
            this.clear_filters(cx);
            assert_eq!(this.project_filter, None);
            assert_eq!(this.status_filter, None);
            assert_eq!(this.committed_keyword, "");
            assert!(this.pending_inputs_reset);

            // 详情切换：同票 no-op；换票只走详情竞态计数
            this.selected_id = Some(1);
            let before_main = this.latest_request_id;
            let before_detail = this.latest_detail_request_id;
            this.select_invoice(1, cx);
            assert_eq!(this.latest_request_id, before_main);
            this.select_invoice(2, cx);
            assert_eq!(this.selected_id, Some(2));
            assert_eq!(this.latest_detail_request_id, before_detail + 1);
        });
    }

    /// 空态两档提示：筛选无结果 > 暂无数据
    #[gpui::test]
    async fn empty_message_follows_two_tiers(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| VatInvoiceView::new(cx, dummy_client()));
        view.update(cx2, |view, _| {
            // 第一档：有筛选条件 → 筛选无结果提示
            view.project_filter = Some(3);
            assert!(empty_message(view).contains("当前筛选条件下无发票"));

            // 第二档：无筛选 → 暂无数据提示
            view.project_filter = None;
            assert!(empty_message(view).contains("暂无 VAT 发票"));
        });
    }

    /// build_filter 口径：committed 关键字空串不携带（api-client 契约在视图侧
    /// 的镜像断言）
    #[gpui::test]
    async fn build_filter_reflects_selection(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| VatInvoiceView::new(cx, dummy_client()));
        view.update(cx2, |view, _| {
            assert_eq!(view.build_filter(), VatInvoiceFilter::default());
            view.project_filter = Some(3);
            view.status_filter = Some(STATUS_VOIDED);
            view.committed_keyword = "INV".into();
            assert_eq!(
                view.build_filter(),
                VatInvoiceFilter {
                    project_id: Some(3),
                    status: Some(STATUS_VOIDED.into()),
                    q: Some("INV".into()),
                }
            );
        });
    }
}
