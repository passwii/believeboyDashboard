//! 报表中心 → 财务月报视图（P3-4，BLF-704）
//!
//! frontend `app/dashboard/reports/monthly-report/display/display-client.tsx` 的
//! GPUI 等价：项目/站点/月份筛选 + 汇总指标 + 月度趋势 + 月度明细表。
//!
//! 架构（沿用 Phase 1/2/3 基建）：
//! - **四态状态机**：`Loading / Loaded / Empty / Error`（沿用 `dashboard.rs` 模式），
//!   `latest_request_id` 竞态保护——只有最新请求的响应才会落点；
//! - **数据管线**：`list_managed_projects` → 默认选中第一个项目（对齐 frontend
//!   `useAutoSelectFirstProject`）→ `monthly_financial_series`（项目 × 站点 × 月份窗口）；
//! - **汇总指标**：从 `trend` 聚合（收入合计 / 支出合计 / 亚马逊回款 / 净额）；
//! - **月度趋势**：gpui-component `AreaChart` 双序列（销售额 vs 退款，对齐 frontend
//!   图表配置 income_sales/income_refund）；
//! - **月度明细表**：gpui-component `Table`（沿用 `daily_analysis.rs` 的
//!   TableDelegate 范式，懒建 TableState）。
//!
//! 已知差异（有意保留，GPUI 0.2 能力边界 / P3-4 范围）：
//! - 月份选择用「预设窗口」（近 3/6/12 个月，默认近 12 个月截至上月），不做
//!   日历组件（frontend 有 MonthPicker）；
//! - 明细表列取核心字段（收入 4 项 / 支出 6 项 / 合计 / 回款 / 信用卡扣款 /
//!   源报表标记），不含需汇率的净利/占比列与 admin 专属列（测评费/佣金/汇率）；
//! - 重算 / 导出 Excel 未接入（frontend 有，P3-4 不做）。

use chrono::{Datelike, Local};
use gpui::{
    div, prelude::*, px, App, AsyncApp, Context, Entity, FontWeight, Render, SharedString,
    WeakEntity, Window,
};
use gpui_component::{
    button::Button,
    chart::AreaChart,
    h_flex,
    menu::{DropdownMenu, PopupMenuItem},
    table::{Column, Table, TableDelegate, TableState},
    v_flex, Icon, IconName, Sizable,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::reports::{FinancialSeriesResponse, FinancialSeriesRow};

use crate::theme::AppTheme;
use crate::widgets::page_header::PageHeader;
use crate::widgets::pattern_b::{pattern_b_shell, tab_bar, tabs_zone, TabItem};
use crate::widgets::pattern_d::{SheetCellData, SheetColumn};
use crate::widgets::state_views::{self, SkeletonBlock};
use crate::widgets::top_projects::fmt_money_precise;

/// 本页在侧栏中的 URL（root.rs 据此路由到本视图；与 gui-domain::sidebar 的财务月报条目一致）
pub const MONTHLY_REPORT_URL: &str = "/dashboard/reports/monthly-report/display";

/// 站点选项（对齐 frontend display-client `ReportUploadCountry`：US / DE / UK）
const COUNTRY_OPTIONS: [(&str, &str); 3] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
];

/// 默认站点（对齐 frontend `useUrlParam('country', 'US')`）
const DEFAULT_COUNTRY: &str = "US";

/// VAT 国家（DE/UK 启用 VAT 列；US 无 VAT 数据；对齐 frontend `VAT_COUNTRIES`）
#[allow(dead_code)] // 展示 Tab 当前站点由筛选栏承载，VAT 列提示留后续批次恢复
const VAT_COUNTRIES: [&str; 2] = ["DE", "UK"];

/// 月份窗口预设（label, 月数）；默认近 12 个月（对齐 frontend 滚动默认窗口）
const MONTH_RANGE_OPTIONS: [(&str, u32); 3] = [
    ("近 3 个月", 3),
    ("近 6 个月", 6),
    ("近 12 个月", 12),
];
const DEFAULT_MONTHS_BACK: u32 = 12;

/// 站点展示名（未知值原样返回）
pub fn country_label(country: &str) -> String {
    COUNTRY_OPTIONS
        .iter()
        .find(|(value, _)| *value == country)
        .map_or_else(|| country.to_string(), |(_, label)| label.to_string())
}

/// 货币符号（对齐 frontend `CURRENCY_SYMBOLS`）
pub fn currency_symbol(country: &str) -> &'static str {
    match country {
        "DE" => "€",
        "UK" => "£",
        _ => "$",
    }
}

/// `YYYY-MM` 月份显示名（frontend `formatMonth`：2025-08 → 2025年8月）
pub fn format_month(month: &str) -> String {
    let mut parts = month.split('-');
    match (parts.next(), parts.next()) {
        (Some(year), Some(mon)) if mon.parse::<u32>().is_ok() => {
            format!("{year}年{}月", mon.parse::<u32>().unwrap())
        }
        _ => month.to_string(),
    }
}

/// 截至上月的 N 个月窗口（对齐 frontend `getBrowserDefaultMonthRange`：
/// start = 12 个月前的上月，end = 上月）
pub fn month_window(months_back: u32) -> (String, String) {
    let now = Local::now();
    // end = 上月（当前月 - 1）
    let end = shift_month(now.year(), now.month(), -(1_i32));
    // start = end 再往前 (months_back - 1) 个月
    let start = shift_month(end.0, end.1, -(months_back as i32 - 1));
    (format!("{:04}-{:02}", start.0, start.1), format!("{:04}-{:02}", end.0, end.1))
}

/// 月份平移（纯函数；delta 可为负）
fn shift_month(year: i32, month: u32, delta: i32) -> (i32, u32) {
    let total = (year as i64 * 12 + (month as i64 - 1)) + delta as i64;
    let y = total.div_euclid(12);
    let m = total.rem_euclid(12) + 1;
    (y as i32, m as u32)
}

/// 销售额展示口径（对齐 frontend `resolveDisplaySales`：US/DE/UK 都返回
/// `income_sales_with_tax`，兜底 `income_sales`）
pub fn resolve_display_sales(row: &FinancialSeriesRow) -> f64 {
    if row.income_sales_with_tax != 0.0 {
        row.income_sales_with_tax
    } else {
        row.income_sales
    }
}

/// 趋势图数据点（X 轴 = 月份显示名；退款统一按正值展示，对齐 frontend trendPoints）
#[derive(Debug, Clone, PartialEq)]
pub struct TrendPoint {
    pub label: String,
    pub income_sales: f64,
    pub income_refund: f64,
}

/// 由月度行派生趋势点（frontend `trendPoints` 等价：rows → 销售额/退款序列）
pub fn trend_points(rows: &[FinancialSeriesRow]) -> Vec<TrendPoint> {
    rows.iter()
        .map(|row| TrendPoint {
            label: format_month(&row.report_month),
            income_sales: resolve_display_sales(row),
            income_refund: row.income_refund.abs(),
        })
        .collect()
}

/// 明细行展示派生（净回款 = 亚马逊回款 - 信用卡扣款；RMB 成本原样展示）
#[derive(Debug, Clone, PartialEq)]
pub struct FinancialRowView {
    pub report_month: String,
    pub display_sales: f64,
    pub income_refund: f64,
    pub income_adjustment: f64,
    pub income_other: f64,
    pub expense_selling_fee: f64,
    pub expense_fba_fee: f64,
    pub expense_inventory_fee: f64,
    pub expense_service_fee: f64,
    pub expense_advertising: f64,
    pub expense_other_fees: f64,
    pub income_total: f64,
    pub expense_total: f64,
    pub amazon_pay_back: f64,
    pub credit_card_deduction_usd: f64,
    pub fob_cost_rmb: f64,
    pub first_leg_cost_rmb: f64,
    pub has_source_report: bool,
}

impl FinancialRowView {
    pub fn from_row(row: &FinancialSeriesRow) -> Self {
        Self {
            report_month: row.report_month.clone(),
            display_sales: resolve_display_sales(row),
            income_refund: row.income_refund,
            income_adjustment: row.income_adjustment,
            income_other: row.income_other,
            expense_selling_fee: row.expense_selling_fee,
            expense_fba_fee: row.expense_fba_fee,
            expense_inventory_fee: row.expense_inventory_fee,
            expense_service_fee: row.expense_service_fee,
            expense_advertising: row.expense_advertising,
            expense_other_fees: row.expense_other_fees,
            income_total: row.income_total,
            expense_total: row.expense_total,
            amazon_pay_back: row.amazon_pay_back,
            credit_card_deduction_usd: row.credit_card_deduction_usd,
            fob_cost_rmb: row.fob_cost_rmb,
            first_leg_cost_rmb: row.first_leg_cost_rmb,
            has_source_report: row.has_source_report,
        }
    }
}

/// 财务月报数据（Loaded 态载荷）
#[derive(Debug, Clone, PartialEq)]
pub struct MonthlyReportData {
    pub projects: Vec<ManagedProject>,
    pub response: FinancialSeriesResponse,
    pub start_month: String,
    pub end_month: String,
}

impl MonthlyReportData {
    /// 空态判定（对齐 frontend：无项目，或无任何行）
    pub fn is_empty(&self) -> bool {
        self.projects.is_empty() || self.response.rows.is_empty()
    }
}

/// 财务月报状态机（四态；沿用 dashboard.rs / daily_analysis.rs）
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum MonthlyReportState {
    Loading,
    Loaded(MonthlyReportData),
    Empty,
    Error(String),
}

impl MonthlyReportState {
    /// 拉取结果 → 落点状态（唯一合法的「拉取完成」转移）
    pub fn from_fetch_result(result: Result<MonthlyReportData, String>) -> Self {
        match result {
            Ok(data) if data.is_empty() => Self::Empty,
            Ok(data) => Self::Loaded(data),
            Err(msg) => Self::Error(msg),
        }
    }
}

/// 财务月报视图（状态机 + 项目/站点/月份筛选 + 竞态保护）
pub struct MonthlyReportView {
    state: Entity<MonthlyReportState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表（reload 刷新；筛选菜单数据源）
    projects: Vec<ManagedProject>,
    /// 当前选中项目（必选；默认第一个）
    selected_project_id: Option<i64>,
    /// 当前站点（"US" / "DE" / "UK"）
    country: &'static str,
    /// 月份窗口预设（月数；默认 12）
    months_back: u32,
    /// 请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,
    /// 月度明细表（懒建 TableState）
    detail_table: Entity<MonthlyDetailTable>,
    /// BLF-803 Pattern D 只读形态子 Tab（0=展示 Excel 风报表 / 1=生成 / 2=对账）
    active_tab: usize,
}

impl MonthlyReportView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| MonthlyReportState::Loading);
        let detail_table = cx.new(|_| MonthlyDetailTable::new());
        Self {
            state,
            client,
            projects: Vec::new(),
            selected_project_id: None,
            country: DEFAULT_COUNTRY,
            months_back: DEFAULT_MONTHS_BACK,
            latest_request_id: 0,
            detail_table,
            active_tab: 0,
        }
    }

    /// 切换子 Tab（展示 / 生成 / 对账；BLF-803）
    pub fn select_tab(&mut self, ix: usize, cx: &mut Context<Self>) {
        self.active_tab = ix;
        cx.notify();
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)] // 视图级测试消费（对齐 daily_analysis current_state 用法）
    pub fn current_state(&self, cx: &App) -> MonthlyReportState {
        self.state.read(cx).clone()
    }

    /// 重新拉取数据：项目/站点/月份切换、错误重试、空态刷新共用入口。
    ///
    /// 每次调用递增 `latest_request_id` 并进入 Loading；响应回来时
    /// `apply_result` 只应用最新一次（竞态保护，对齐 dashboard.rs）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let selected = self.selected_project_id;
        let country = self.country;
        let months_back = self.months_back;

        self.state.update(cx, |state, cx| {
            *state = MonthlyReportState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(load_monthly_report(&client, selected, country, months_back))
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
        // 明细表币种符号跟随站点（行数据不变，仅符号变化）
        self.detail_table
            .update(cx, |widget, cx| widget.set_country(country, cx));
        self.reload(cx);
    }

    /// 切换月份窗口 → reload（同一窗口为 no-op）
    pub fn select_months_back(&mut self, months_back: u32, cx: &mut Context<Self>) {
        if months_back == self.months_back {
            return;
        }
        self.months_back = months_back;
        self.reload(cx);
    }

    /// BLF-795：Console Bar 筛选一键应用（项目 + 站点两维；月粒度窗口仍归页内
    /// 月份选择器）——只对变化维度落值，任一变化仅触发一次 reload。
    pub fn apply_console_filter(
        &mut self,
        project_id: Option<i64>,
        country: &'static str,
        cx: &mut Context<Self>,
    ) -> bool {
        let project_changed = project_id != self.selected_project_id;
        let country_changed = country != self.country;
        if !project_changed && !country_changed {
            return false;
        }
        if project_changed {
            self.selected_project_id = project_id;
        }
        if country_changed {
            self.country = country;
            // 明细表币种符号跟随站点（行数据不变，仅符号变化）
            self.detail_table
                .update(cx, |widget, cx| widget.set_country(country, cx));
        }
        self.reload(cx);
        true
    }

    /// 应用拉取结果：竞态保护（过期响应丢弃）+ Loaded 落点前把明细行喂给表格组件。
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<MonthlyReportData, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok(data) = &result {
            if !data.is_empty() {
                self.projects = data.projects.clone();
                let rows: Vec<FinancialRowView> =
                    data.response.rows.iter().map(FinancialRowView::from_row).collect();
                let rows = rows.clone();
                self.detail_table
                    .update(cx, |widget, cx| widget.set_data(rows, cx));
            }
        }
        self.state.update(cx, |state, cx| {
            *state = MonthlyReportState::from_fetch_result(result);
            cx.notify();
        });
    }
}

/// 拉取财务月报（项目列表 + 财务序列），与视图解耦便于测试。
///
/// 对齐 frontend display-client：
/// - 项目列表为空 → 返回空载荷（`rows` 空），由 `is_empty` 归入 Empty 态；
/// - 项目必选：默认取第一个项目（对齐 `useAutoSelectFirstProject`）；
/// - 月份窗口：近 N 个月截至上月（对齐滚动默认窗口）。
async fn load_monthly_report(
    client: &Client,
    selected_project_id: Option<i64>,
    country: &str,
    months_back: u32,
) -> Result<MonthlyReportData, String> {
    let projects = client
        .list_managed_projects()
        .await
        .map_err(|e| e.user_message())?;
    let project_id = selected_project_id.or_else(|| projects.first().map(|p| p.id));
    let Some(project_id) = project_id else {
        return Ok(MonthlyReportData {
            projects,
            response: empty_series(),
            start_month: String::new(),
            end_month: String::new(),
        });
    };

    let (start_month, end_month) = month_window(months_back);
    let response = client
        .monthly_financial_series(
            project_id,
            country,
            Some(&start_month),
            Some(&end_month),
            true,
        )
        .await
        .map_err(|e| e.user_message())?;

    Ok(MonthlyReportData {
        projects,
        response,
        start_month,
        end_month,
    })
}

/// 空序列响应（项目列表为空时的占位载荷）
fn empty_series() -> FinancialSeriesResponse {
    FinancialSeriesResponse {
        project_id: 0,
        project_name: String::new(),
        start_month: String::new(),
        end_month: String::new(),
        rows: Vec::new(),
        trend: gui_domain::reports::FinancialTrend {
            income_total_sum: 0.0,
            expense_total_sum: 0.0,
            amazon_pay_back_sum: 0.0,
            net_amount_sum: 0.0,
            points: Vec::new(),
        },
    }
}

impl Render for MonthlyReportView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let view = cx.entity();

        // Pattern B 壳 + 子 Tab（展示 / 生成 / 对账）；展示 Tab 为 Pattern D
        // Excel 风只读报表形态。生成 / 对账写链路走 web 端（既有取舍）。
        let tab_items = [
            TabItem::new("display", "展示"),
            TabItem::new("generate", "生成"),
            TabItem::new("reconcile", "对账"),
        ];
        let strip = tab_bar(&view, &app_theme, "monthly-report", &tab_items, self.active_tab, |this, ix, cx| {
            this.select_tab(ix, cx);
        });

        let header;
        let toolbar;
        let content: gpui::AnyElement = match &state {
            MonthlyReportState::Loading => {
                header = PageHeader::new("财务月报");
                toolbar = div();
                render_loading(&app_theme).into_any_element()
            }
            MonthlyReportState::Error(msg) => {
                header = PageHeader::new("财务月报");
                toolbar = div();
                render_error(cx, &app_theme, msg).into_any_element()
            }
            MonthlyReportState::Empty => {
                header = PageHeader::new("财务月报");
                toolbar = div();
                render_empty(cx, &app_theme).into_any_element()
            }
            MonthlyReportState::Loaded(data) => {
                header = PageHeader::new("财务月报").subtitle(format!(
                    "{} · {} · {} 至 {} · {} 个月",
                    data.response.project_name,
                    country_label(self.country),
                    format_month(&data.response.start_month),
                    format_month(&data.response.end_month),
                    self.months_back
                ));
                match self.active_tab {
                    1 => {
                        // 生成：写操作走 web 端，GUI 提供引导说明卡
                        toolbar = div();
                        state_views::empty_state_with_action_desc(
                            &view,
                            &app_theme,
                            "monthly-report-generate",
                            "icons/file-bar-chart.svg",
                            "财务月报生成需上传支付报表 CSV / 汇总 PDF",
                            Some("请在 web 端「报表中心 → 财务月报 → 生成」页操作；生成结果在此页展示 Tab 查看".to_string()),
                            "查看展示",
                            |this, _cx| this.select_tab(0, _cx),
                        )
                        .into_any_element()
                    }
                    2 => {
                        // 对账：自动/手工对账与 PDF/CSV 上传走 web 端
                        toolbar = div();
                        state_views::empty_state_with_action_desc(
                            &view,
                            &app_theme,
                            "monthly-report-reconcile",
                            "icons/check-square.svg",
                            "对账需上传银行回单或执行自动对账",
                            Some("请在 web 端「报表中心 → 财务月报 → 对账」页操作".to_string()),
                            "查看展示",
                            |this, _cx| this.select_tab(0, _cx),
                        )
                        .into_any_element()
                    }
                    _ => {
                        // 展示：Pattern D Excel 风只读报表矩阵
                        toolbar = h_flex()
                            .gap_2()
                            .items_center()
                            .child(render_filter_bar(
                                &view,
                                &app_theme,
                                &self.projects.clone(),
                                self.selected_project_id,
                                self.country,
                                self.months_back,
                            ))
                            .child(div().flex_1());
                        let detail_table = self.detail_table.clone();
                        render_loaded(cx, &app_theme, data, detail_table).into_any_element()
                    }
                }
            }
        };
        let tabs = tabs_zone(strip, content);
        pattern_b_shell(&app_theme, "monthly-report", header, toolbar, 0.0, div(), div(), tabs)
            .into_any_element()
    }
}

// ---------------------------------------------------------------------------
// 四态渲染
// ---------------------------------------------------------------------------

/// Loading：筛选骨架 + 汇总条 + 趋势/明细表骨架
///
/// P4-6：骨架块统一走 `state_views::skeleton_loading` 声明式组合，
/// 汇总用 `BarRow(4, 88)`（对齐原 4 张等高汇总卡）。
fn render_loading(app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("monthly-report-loading")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::skeleton_loading(
            app_theme,
            &[
                SkeletonBlock::Filter(4),
                SkeletonBlock::BarRow(4, 88.0),
                SkeletonBlock::Chart(280.0),
                SkeletonBlock::Table(320.0),
            ],
        ))
}

/// Error：卡片内 Alert + 重试按钮（State 0 公共组件 `state_views::error_state`）
fn render_error(
    cx: &mut Context<MonthlyReportView>,
    app_theme: &AppTheme,
    msg: &str,
) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("monthly-report-error")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::error_state(
            &view,
            app_theme,
            "monthly-report-error",
            "财务数据加载失败",
            msg.to_string(),
            |this, cx| this.reload(cx),
        ))
}

/// Empty：Icon + 文案 + 刷新按钮（State 0 公共组件 `empty_state_with_action`）
fn render_empty(cx: &mut Context<MonthlyReportView>, app_theme: &AppTheme) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("monthly-report-empty")
        .size_full()
        .items_center()
        .justify_center()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::empty_state_with_action(
            &view,
            app_theme,
            "monthly-report-empty",
            "icons/file-bar-chart.svg",
            "暂无财务数据",
            "刷新",
            |this, cx| this.reload(cx),
        ))
}

/// Loaded（展示 Tab）：汇总指标 + 月度趋势 + Excel 风只读报表矩阵
/// （Pattern D 只读形态：sheet_matrix 承载月度收支，数字 mono）
#[allow(clippy::too_many_arguments)]
fn render_loaded(
    cx: &mut Context<MonthlyReportView>,
    app_theme: &AppTheme,
    data: &MonthlyReportData,
    detail_table: Entity<MonthlyDetailTable>,
) -> gpui::AnyElement {
    let _ = cx;
    let resp = &data.response;
    let trend = &resp.trend;
    let reduce = crate::motion::reduce_motion(cx);

    // Excel 风只读矩阵：行 = 月份，列 = 收支科目；末列源报表标记
    let cols = sheet_columns();
    let mut rows: Vec<Vec<SheetCellData>> = Vec::with_capacity(resp.rows.len() + 1);
    for row in &resp.rows {
        rows.push(vec![
            SheetCellData::text(format_month(&row.report_month)),
            SheetCellData::number(fmt_money(resolve_display_sales(row))),
            SheetCellData::number(fmt_money(row.income_refund.abs())),
            SheetCellData::number(fmt_money(row.income_adjustment)),
            SheetCellData::number(fmt_money(row.income_other)),
            SheetCellData::number(fmt_money(row.expense_selling_fee)),
            SheetCellData::number(fmt_money(row.expense_fba_fee)),
            SheetCellData::number(fmt_money(row.expense_inventory_fee)),
            SheetCellData::number(fmt_money(row.expense_service_fee)),
            SheetCellData::number(fmt_money(row.expense_advertising)),
            SheetCellData::number(fmt_money(row.expense_other_fees)),
            SheetCellData::computed(fmt_money(row.income_total)),
            SheetCellData::computed(fmt_money(row.expense_total)),
            SheetCellData::computed(fmt_money(row.amazon_pay_back - row.credit_card_deduction_usd)),
            SheetCellData::number(fmt_money(row.amazon_pay_back)),
            SheetCellData::number(fmt_money(row.credit_card_deduction_usd)),
            SheetCellData::number(fmt_money(row.fob_cost_rmb)),
            SheetCellData::number(fmt_money(row.first_leg_cost_rmb)),
            SheetCellData::text(if row.has_source_report { "\u{2713}" } else { "—" }),
        ]);
    }
    // 合计行（口径与 trend 汇总一致）
    rows.push(vec![
        SheetCellData::text("合计"),
        SheetCellData::computed(fmt_money(trend.income_total_sum)),
        SheetCellData::computed("—"),
        SheetCellData::computed("—"),
        SheetCellData::computed("—"),
        SheetCellData::computed(fmt_money(trend.expense_total_sum)),
        SheetCellData::computed("—"),
        SheetCellData::computed("—"),
        SheetCellData::computed("—"),
        SheetCellData::computed("—"),
        SheetCellData::computed("—"),
        SheetCellData::computed(fmt_money(trend.income_total_sum)),
        SheetCellData::computed(fmt_money(trend.expense_total_sum)),
        SheetCellData::computed(fmt_money(trend.net_amount_sum)),
        SheetCellData::computed(fmt_money(trend.amazon_pay_back_sum)),
        SheetCellData::computed("—"),
        SheetCellData::computed("—"),
        SheetCellData::computed("—"),
    ]);

    crate::motion::enter_fade_in(
        gpui::SharedString::from("monthly-report-loaded-fade"),
        v_flex()
            .id("monthly-report-loaded")
            .size_full()
            .min_h_0()
            .overflow_y_scroll()
            .p_2()
            .gap_3()
            .child(summary_cards(trend, self_country(), app_theme))
            .child(trend_card(&resp.rows, self_country(), app_theme))
            .child(crate::widgets::pattern_d::sheet_matrix(
                app_theme,
                "monthly-report-sheet",
                &cols,
                &rows,
                None,
            ))
            .child(div().w_full().px_2().py_2().child(detail_table)),
        reduce,
    )
    .into_any_element()
}

/// 展示 Tab 当前站点（渲染期从默认常量读取——站点维度由筛选栏承载）
fn self_country() -> &'static str {
    DEFAULT_COUNTRY
}

/// 月度收支只读矩阵列定义（Pattern D SheetColumn）
fn sheet_columns() -> Vec<SheetColumn> {
    vec![
        SheetColumn::new("month", "年月", false).fixed(88.0),
        SheetColumn::new("sales", "销售额", true),
        SheetColumn::new("refund", "退款", true),
        SheetColumn::new("adjust", "赔偿", true),
        SheetColumn::new("other_income", "其他收入", true),
        SheetColumn::new("selling", "平台费", true),
        SheetColumn::new("fba", "配送费", true),
        SheetColumn::new("inventory", "仓储费", true),
        SheetColumn::new("service", "服务费", true),
        SheetColumn::new("ad", "广告费", true),
        SheetColumn::new("other_expense", "其他费用", true),
        SheetColumn::new("income_total", "收入合计", true),
        SheetColumn::new("expense_total", "支出合计", true),
        SheetColumn::new("net_payback", "净回款", true),
        SheetColumn::new("payback", "亚马逊回款", true),
        SheetColumn::new("credit_card", "信用卡扣款", true),
        SheetColumn::new("fob", "FOB成本RMB", true),
        SheetColumn::new("first_leg", "头程成本RMB", true),
        SheetColumn::new("source", "源报表", false),
    ]
}

/// 金额展示格式化（千分位两位小数；mono 由单元格 numeric 语义承载）
fn fmt_money(v: f64) -> String {
    let neg = v < 0.0;
    let abs = v.abs();
    let int_part = abs.trunc() as i64;
    let frac = ((abs - abs.trunc()) * 100.0).round() as i64;
    let (int_part, frac) = if frac >= 100 { (int_part + 1, 0) } else { (int_part, frac) };
    let digits = int_part.to_string();
    let mut grouped = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(ch);
    }
    format!("{}{grouped}.{:02}", if neg { "-" } else { "" }, frac)
}

// ---------------------------------------------------------------------------
// 筛选栏（项目 / 站点 / 月份窗口 / 刷新）
// ---------------------------------------------------------------------------

/// 筛选栏：项目 + 站点 + 月份窗口（DropdownMenu）+ 刷新按钮。
#[allow(clippy::too_many_arguments)]
fn render_filter_bar(
    view: &Entity<MonthlyReportView>,
    app_theme: &AppTheme,
    projects: &[ManagedProject],
    selected_project_id: Option<i64>,
    country: &'static str,
    months_back: u32,
) -> impl IntoElement {
    let projects_owned = projects.to_vec();
    let project_label: SharedString = match selected_project_id {
        Some(id) => projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| SharedString::from(p.name.clone()))
            .unwrap_or_else(|| SharedString::from("选择项目")),
        None => SharedString::from("选择项目"),
    };
    let month_label: SharedString = MONTH_RANGE_OPTIONS
        .iter()
        .find(|(_, m)| *m == months_back)
        .map(|(label, _)| SharedString::from(*label))
        .unwrap_or_else(|| SharedString::from("近 12 个月"));
    let view_for_project = view.clone();
    let view_for_country = view.clone();
    let view_for_month = view.clone();
    let view_for_refresh = view.clone();

    h_flex()
        .id("monthly-report-filters")
        .gap_3()
        .items_center()
        .flex_wrap()
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .text_sm()
                        .text_color(app_theme.text_muted)
                        .child("项目"),
                )
                .child(
                    Button::new("monthly-report-project-filter")
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
                ),
        )
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .text_sm()
                        .text_color(app_theme.text_muted)
                        .child("站点"),
                )
                .child(
                    Button::new("monthly-report-country-filter")
                        .outline()
                        .small()
                        .label(country_label(country))
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
                                                view.update(cx, |this, cx| {
                                                    this.select_country(value, cx)
                                                });
                                            },
                                        ),
                                    );
                                }
                                menu
                            },
                        ),
                ),
        )
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .text_sm()
                        .text_color(app_theme.text_muted)
                        .child("月份"),
                )
                .child(
                    Button::new("monthly-report-month-filter")
                        .outline()
                        .small()
                        .label(month_label)
                        .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                        .dropdown_menu_with_anchor(
                            gpui::Corner::BottomLeft,
                            move |menu, _window, _cx| {
                                let mut menu = menu;
                                for (label, months) in MONTH_RANGE_OPTIONS {
                                    let checked = months == months_back;
                                    let view = view_for_month.clone();
                                    menu = menu.item(
                                        PopupMenuItem::new(label).checked(checked).on_click(
                                            move |_, _window, cx| {
                                                view.update(cx, |this, cx| {
                                                    this.select_months_back(months, cx)
                                                });
                                            },
                                        ),
                                    );
                                }
                                menu
                            },
                        ),
                ),
        )
        .child(
            div().flex_1(), // spacer
        )
        .child(
            Button::new("monthly-report-refresh")
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
// 汇总指标卡
// ---------------------------------------------------------------------------

/// 汇总指标卡（trend 聚合；对齐 frontend DataTableCardStatBar 的 3 项 + 净额）
fn summary_cards(
    trend: &gui_domain::reports::FinancialTrend,
    country: &str,
    theme: &AppTheme,
) -> impl IntoElement {
    let symbol = currency_symbol(country);
    let items: [(&str, String, bool); 4] = [
        (
            "收入合计",
            format_money(trend.income_total_sum, symbol),
            true,
        ),
        (
            "支出合计",
            format_money(trend.expense_total_sum, symbol),
            false,
        ),
        (
            "亚马逊回款",
            format_money(trend.amazon_pay_back_sum, symbol),
            false,
        ),
        (
            "净额",
            format_money(trend.net_amount_sum, symbol),
            false,
        ),
    ];
    div()
        .id("monthly-report-summary")
        .grid()
        .grid_cols(4)
        .gap_2()
        .children(items.iter().map(|(label, value, highlight)| {
            v_flex()
                .gap_1()
                .p_4()
                .rounded(px(theme.radius_lg))
                .bg(theme.card_bg)
                .shadow(vec![theme.card_shadow_box()])
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(SharedString::from(*label)),
                )
                .child(
                    div()
                        .text_lg()
                        .font_weight(if *highlight {
                            FontWeight::SEMIBOLD
                        } else {
                            FontWeight::MEDIUM
                        })
                        .text_color(if *highlight { theme.accent } else { theme.text_primary })
                        .child(value.clone()),
                )
        }))
}

/// 金额格式化（千分位 + 货币符号前缀；对齐 frontend `formatCurrency`：
/// 负号在符号前，如 `-$5,210.00`）
fn format_money(value: f64, symbol: &str) -> String {
    let abs = value.abs();
    let text = fmt_money_precise(abs).replacen('$', symbol, 1);
    if value < 0.0 {
        format!("-{text}")
    } else {
        text
    }
}

// ---------------------------------------------------------------------------
// 月度趋势卡
// ---------------------------------------------------------------------------

/// 月度趋势卡：标题 + 说明 + AreaChart（销售额 vs 退款；对齐 frontend 图表配置）
fn trend_card(rows: &[FinancialSeriesRow], country: &str, theme: &AppTheme) -> impl IntoElement {
    let points = trend_points(rows);
    let symbol = currency_symbol(country);
    v_flex()
        .id("monthly-report-trend")
        .w_full()
        .gap_3()
        .p_4()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(
            v_flex()
                .gap_1()
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_primary)
                        .child("月度趋势"),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.text_muted)
                        .child(format!(
                            "销售额 vs 退款（{} 计）",
                            match country {
                                "DE" => "欧元",
                                "UK" => "英镑",
                                _ => "美元",
                            }
                        )),
                ),
        )
        .child(
            if points.is_empty() {
                div()
                    .w_full()
                    .h(px(260.))
                    .rounded(px(theme.radius))
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_sm()
                    .text_color(theme.text_muted)
                    .child("暂无趋势数据")
            } else {
                // 图例（颜色点 + 名称）
                let legend = h_flex()
                    .gap_4()
                    .child(
                        h_flex()
                            .gap_1p5()
                            .items_center()
                            .child(div().size_2p5().rounded_full().bg(theme.chart_primary))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.text_secondary)
                                    .child("销售额"),
                            ),
                    )
                    .child(
                        h_flex()
                            .gap_1p5()
                            .items_center()
                            .child(div().size_2p5().rounded_full().bg(theme.danger))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.text_secondary)
                                    .child("退款"),
                            ),
                    );
                v_flex()
                    .gap_2()
                    .child(legend)
                    .child(
                        div().w_full().h(px(260.)).child(
                            AreaChart::new(points.clone())
                                .x(|p| p.label.clone())
                                .y(|p| p.income_sales)
                                .y(|p| p.income_refund)
                                .stroke(theme.chart_primary)
                                .stroke(theme.danger)
                                .fill(theme.chart_primary.opacity(0.18))
                                .fill(theme.danger.opacity(0.10))
                                .linear()
                                .linear()
                                .tick_margin(1),
                        ),
                    )
            },
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .child(format!(
                    "最新月份：{}",
                    points
                        .last()
                        .map(|p| format!("{} 销售额 {}", p.label, format_money(p.income_sales, symbol)))
                        .unwrap_or_else(|| "—".to_string())
                )),
        )
}

// ---------------------------------------------------------------------------
// 月度明细表（gpui-component Table）
// ---------------------------------------------------------------------------

/// 列索引（与 `MonthlyTableDelegate::columns()` 顺序一致）
const COL_MONTH: usize = 0;
const COL_SALES: usize = 1;
const COL_REFUND: usize = 2;
const COL_ADJUST: usize = 3;
const COL_OTHER_INCOME: usize = 4;
const COL_SELLING: usize = 5;
const COL_FBA: usize = 6;
const COL_INVENTORY: usize = 7;
const COL_SERVICE: usize = 8;
const COL_AD: usize = 9;
const COL_OTHER_EXPENSE: usize = 10;
const COL_INCOME_TOTAL: usize = 11;
const COL_EXPENSE_TOTAL: usize = 12;
const COL_PAYBACK: usize = 13;
const COL_CREDIT_CARD: usize = 14;
const COL_FOB: usize = 15;
const COL_FIRST_LEG: usize = 16;
const COL_SOURCE: usize = 17;

/// 月度明细数据委托（非排序；月份升序已在上游排好）
struct MonthlyTableDelegate {
    rows: Vec<FinancialRowView>,
    columns: Vec<Column>,
    country: &'static str,
}

impl MonthlyTableDelegate {
    fn new(rows: Vec<FinancialRowView>, country: &'static str) -> Self {
        Self {
            rows,
            columns: Self::columns(),
            country,
        }
    }

    fn columns() -> Vec<Column> {
        vec![
            Column::new("month", "年月").width(px(96.)).selectable(false),
            Column::new("sales", "销售额").width(px(96.)).text_right(),
            Column::new("refund", "退款").width(px(80.)).text_right(),
            Column::new("adjust", "赔偿").width(px(80.)).text_right(),
            Column::new("other_income", "其他收入").width(px(88.)).text_right(),
            Column::new("selling", "平台费").width(px(80.)).text_right(),
            Column::new("fba", "配送费").width(px(80.)).text_right(),
            Column::new("inventory", "仓储费").width(px(80.)).text_right(),
            Column::new("service", "服务费").width(px(80.)).text_right(),
            Column::new("ad", "广告费").width(px(80.)).text_right(),
            Column::new("other_expense", "其他费用").width(px(88.)).text_right(),
            Column::new("income_total", "收入合计").width(px(92.)).text_right(),
            Column::new("expense_total", "支出合计").width(px(92.)).text_right(),
            Column::new("payback", "亚马逊回款").width(px(96.)).text_right(),
            Column::new("credit_card", "信用卡扣款").width(px(92.)).text_right(),
            Column::new("fob", "FOB成本RMB").width(px(96.)).text_right(),
            Column::new("first_leg", "头程成本RMB").width(px(104.)).text_right(),
            Column::new("source", "源报表").width(px(72.)),
        ]
    }

    fn set_rows(&mut self, rows: Vec<FinancialRowView>) {
        self.rows = rows;
    }
}

impl TableDelegate for MonthlyTableDelegate {
    fn columns_count(&self, _: &App) -> usize {
        self.columns.len()
    }

    fn rows_count(&self, _: &App) -> usize {
        self.rows.len()
    }

    fn column(&self, col_ix: usize, _: &App) -> &Column {
        &self.columns[col_ix]
    }

    fn render_td(
        &mut self,
        row_ix: usize,
        col_ix: usize,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        let row = &self.rows[row_ix];
        let theme = AppTheme::current(cx);
        let symbol = currency_symbol(self.country);
        match col_ix {
            COL_MONTH => {
                let tinted = !row.has_source_report;
                h_flex()
                    .gap_1p5()
                    .items_center()
                    .child(
                        div()
                            .text_sm()
                            .text_color(if tinted {
                                theme.text_muted
                            } else {
                                theme.text_primary
                            })
                            .child(format_month(&row.report_month)),
                    )
                    .when(!row.has_source_report, |this| {
                        this.child(
                            div()
                                .px_1p5()
                                .py_0p5()
                                .rounded_sm()
                                .border_1()
                                .border_color(theme.warning.opacity(0.4))
                                .bg(theme.warning.opacity(0.12))
                                .text_xs()
                                .text_color(theme.warning)
                                .child("无"),
                        )
                    })
                    .into_any_element()
            }
            COL_SALES => {
                right_cell(format_money(row.display_sales, symbol), &theme).into_any_element()
            }
            COL_REFUND => {
                muted_right_cell(format_money(row.income_refund, symbol), &theme).into_any_element()
            }
            COL_ADJUST => {
                muted_right_cell(format_money(row.income_adjustment, symbol), &theme)
                    .into_any_element()
            }
            COL_OTHER_INCOME => {
                muted_right_cell(format_money(row.income_other, symbol), &theme).into_any_element()
            }
            COL_SELLING => {
                muted_right_cell(format_money(row.expense_selling_fee, symbol), &theme)
                    .into_any_element()
            }
            COL_FBA => {
                muted_right_cell(format_money(row.expense_fba_fee, symbol), &theme)
                    .into_any_element()
            }
            COL_INVENTORY => {
                muted_right_cell(format_money(row.expense_inventory_fee, symbol), &theme)
                    .into_any_element()
            }
            COL_SERVICE => {
                muted_right_cell(format_money(row.expense_service_fee, symbol), &theme)
                    .into_any_element()
            }
            COL_AD => {
                muted_right_cell(format_money(row.expense_advertising, symbol), &theme)
                    .into_any_element()
            }
            COL_OTHER_EXPENSE => {
                muted_right_cell(format_money(row.expense_other_fees, symbol), &theme)
                    .into_any_element()
            }
            COL_INCOME_TOTAL => {
                strong_right_cell(format_money(row.income_total, symbol), &theme).into_any_element()
            }
            COL_EXPENSE_TOTAL => {
                strong_right_cell(format_money(row.expense_total, symbol), &theme).into_any_element()
            }
            COL_PAYBACK => {
                strong_right_cell(format_money(row.amazon_pay_back, symbol), &theme)
                    .into_any_element()
            }
            COL_CREDIT_CARD => {
                muted_right_cell(format_money(row.credit_card_deduction_usd, symbol), &theme)
                    .into_any_element()
            }
            COL_FOB => {
                muted_right_cell(format_rmb(row.fob_cost_rmb), &theme).into_any_element()
            }
            COL_FIRST_LEG => {
                muted_right_cell(format_rmb(row.first_leg_cost_rmb), &theme).into_any_element()
            }
            COL_SOURCE => div()
                .text_xs()
                .text_color(if row.has_source_report {
                    theme.success
                } else {
                    theme.text_muted
                })
                .child(if row.has_source_report { "✓" } else { "—" })
                .into_any_element(),
            _ => div().into_any_element(),
        }
    }

    /// 空态：Inbox 图标 + 文案
    fn render_empty(
        &mut self,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap_2()
            .text_color(theme.text_muted)
            .child(Icon::new(IconName::Inbox).with_size(px(24.)))
            .child(div().text_sm().child("暂无财务明细数据"))
            .into_any_element()
    }
}

/// 右对齐数值单元格（主色）
fn right_cell(text: String, theme: &AppTheme) -> impl IntoElement {
    div()
        .text_right()
        .text_sm()
        .text_color(theme.text_secondary)
        .child(text)
}

/// 右对齐数值单元格（弱化色：退款/费用等次级指标）
fn muted_right_cell(text: String, theme: &AppTheme) -> impl IntoElement {
    div()
        .text_right()
        .text_sm()
        .text_color(theme.text_muted)
        .child(text)
}

/// 右对齐数值单元格（强调色：合计/回款）
fn strong_right_cell(text: String, theme: &AppTheme) -> impl IntoElement {
    div()
        .text_right()
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
        .text_color(theme.text_primary)
        .child(text)
}

/// RMB 金额（¥ 前缀；对齐 frontend `formatRmb`：负号在符号前）
fn format_rmb(value: f64) -> String {
    let abs = value.abs();
    let text = fmt_money_precise(abs).replacen('$', "¥", 1);
    if value < 0.0 {
        format!("-{text}")
    } else {
        text
    }
}

/// 月度明细表 Widget（懒建 TableState；`set_data` 注入行，幂等）
struct MonthlyDetailTable {
    table: Option<Entity<TableState<MonthlyTableDelegate>>>,
    rows: Vec<FinancialRowView>,
    country: &'static str,
}

impl MonthlyDetailTable {
    fn new() -> Self {
        Self {
            table: None,
            rows: Vec::new(),
            country: DEFAULT_COUNTRY,
        }
    }

    /// 注入明细行（无变化时跳过）
    fn set_data(&mut self, rows: Vec<FinancialRowView>, cx: &mut Context<Self>) {
        if rows == self.rows {
            return;
        }
        self.rows = rows;
        if let Some(table) = &self.table {
            let rows = self.rows.clone();
            table.update(cx, |state, cx| {
                state.delegate_mut().set_rows(rows);
                state.refresh(cx);
                cx.notify();
            });
        }
    }

    /// 站点变化（VAT 列宽度等由 render 重建；行数据不变）
    fn set_country(&mut self, country: &'static str, cx: &mut Context<Self>) {
        if country == self.country {
            return;
        }
        self.country = country;
        if let Some(table) = &self.table {
            let rows = self.rows.clone();
            let new_country = country;
            table.update(cx, |state, cx| {
                let delegate = state.delegate_mut();
                delegate.country = new_country;
                delegate.set_rows(rows);
                state.refresh(cx);
                cx.notify();
            });
        }
        cx.notify();
    }
}

impl Default for MonthlyDetailTable {
    fn default() -> Self {
        Self::new()
    }
}

impl Render for MonthlyDetailTable {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let table = self.table.get_or_insert_with(|| {
            let delegate = MonthlyTableDelegate::new(self.rows.clone(), self.country);
            cx.new(|cx| TableState::new(delegate, window, cx))
        });
        let theme = AppTheme::current(cx);
        v_flex()
            .id("monthly-report-detail")
            .w_full()
            .rounded(px(theme.radius_lg))
            .bg(theme.card_bg)
            .shadow(vec![theme.card_shadow_box()])
            .overflow_y_scroll()
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
                            .child("月度明细"),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.text_muted)
                            .child(format!("{} 行月度收支明细", self.rows.len())),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h(px(220.))
                    .child(Table::new(table).bordered(false).large()),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(month: &str, sales: f64, refund: f64) -> FinancialSeriesRow {
        FinancialSeriesRow {
            report_month: month.to_string(),
            income_sales: sales,
            income_refund: refund,
            income_adjustment: 0.0,
            income_other: 0.0,
            expense_selling_fee: 0.0,
            expense_fba_fee: 0.0,
            expense_inventory_fee: 0.0,
            expense_service_fee: 0.0,
            expense_advertising: 0.0,
            expense_other_fees: 0.0,
            income_total: sales,
            expense_total: -100.0,
            amazon_pay_back: sales * 0.5,
            income_vat_total: 0.0,
            income_sales_with_tax: 0.0,
            expense_vat_total: 0.0,
            credit_card_deduction_usd: 10.0,
            fob_cost_rmb: 1000.0,
            first_leg_cost_rmb: 200.0,
            has_source_report: true,
        }
    }

    #[test]
    fn format_month_formats_yyyy_mm() {
        assert_eq!(format_month("2025-08"), "2025年8月");
        assert_eq!(format_month("2026-11"), "2026年11月");
        assert_eq!(format_month("bad"), "bad");
    }

    #[test]
    fn month_window_ends_last_month() {
        // 固定「2026-08」为当前月：end = 2026-07，start = 12 个月窗口 → 2025-08
        let (start, end) = month_window_fixed(2026, 8, 12);
        assert_eq!(start, "2025-08");
        assert_eq!(end, "2026-07");
    }

    /// 固定当前年月版的 month_window（测试可确定性验证；生产走 Local::now()）
    fn month_window_fixed(year: i32, month: u32, months_back: u32) -> (String, String) {
        let end = shift_month(year, month, -1);
        let start = shift_month(end.0, end.1, -(months_back as i32 - 1));
        (
            format!("{:04}-{:02}", start.0, start.1),
            format!("{:04}-{:02}", end.0, end.1),
        )
    }

    #[test]
    fn shift_month_handles_year_boundary() {
        assert_eq!(shift_month(2026, 1, -1), (2025, 12));
        assert_eq!(shift_month(2025, 12, 1), (2026, 1));
        assert_eq!(shift_month(2026, 3, -2), (2026, 1));
    }

    #[test]
    fn resolve_display_sales_prefers_with_tax() {
        let mut r = row("2026-07", 1000.0, 20.0);
        assert_eq!(resolve_display_sales(&r), 1000.0);
        r.income_sales_with_tax = 1050.0;
        assert_eq!(resolve_display_sales(&r), 1050.0);
    }

    #[test]
    fn trend_points_use_positive_refund() {
        let rows = vec![row("2026-07", 1000.0, -50.0)];
        let points = trend_points(&rows);
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].label, "2026年7月");
        assert_eq!(points[0].income_sales, 1000.0);
        assert_eq!(points[0].income_refund, 50.0);
    }

    #[test]
    fn financial_row_view_derives_display_sales() {
        let r = row("2026-07", 1000.0, 20.0);
        let v = FinancialRowView::from_row(&r);
        assert_eq!(v.display_sales, 1000.0);
        assert_eq!(v.amazon_pay_back, 500.0);
        assert_eq!(v.fob_cost_rmb, 1000.0);
        assert!(v.has_source_report);
    }

    #[test]
    fn money_formatting() {
        assert_eq!(format_money(11693.69, "$"), "$11,693.69");
        assert_eq!(format_money(-5210.0, "$"), "-$5,210.00");
        assert_eq!(format_rmb(1200.5), "¥1,200.50");
    }

    #[test]
    fn currency_symbols() {
        assert_eq!(currency_symbol("US"), "$");
        assert_eq!(currency_symbol("DE"), "€");
        assert_eq!(currency_symbol("UK"), "£");
        assert_eq!(currency_symbol("XX"), "$");
    }

    /// 渲染冒烟（Loading 态）：完整布局可渲染不 panic
    #[gpui::test]
    async fn monthly_report_renders_loading(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let client = Client::new("http://127.0.0.1:1");
        let (view, _window_cx) = cx.add_window_view(|_window, cx| {
            MonthlyReportView::new(cx, client)
        });
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                assert_eq!(this.current_state(cx), MonthlyReportState::Loading);
            });
        });
    }

    /// P4-6（BLF-761）三态统一冒烟：Empty 态可渲染不 panic。
    #[gpui::test]
    async fn monthly_report_renders_empty(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let client = Client::new("http://127.0.0.1:1");
        let (view, _window_cx) = cx.add_window_view(|_window, cx| {
            let view = MonthlyReportView::new(cx, client);
            // 直接注入 Empty 态（不走网络）
            view.state.update(cx, |state, _| {
                *state = MonthlyReportState::Empty;
            });
            view
        });
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                assert_eq!(this.current_state(cx), MonthlyReportState::Empty);
            });
        });
    }

    /// 渲染冒烟（Error 态）：加载失败可渲染不 panic
    #[gpui::test]
    async fn monthly_report_renders_error(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let client = Client::new("http://127.0.0.1:1");
        let (view, _window_cx) = cx.add_window_view(|_window, cx| {
            let view = MonthlyReportView::new(cx, client);
            // 直接注入 Error 态（不走网络）
            view.state.update(cx, |state, _| {
                *state = MonthlyReportState::Error("测试错误".into());
            });
            view
        });
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                assert_eq!(
                    this.current_state(cx),
                    MonthlyReportState::Error("测试错误".into())
                );
            });
        });
    }
}
