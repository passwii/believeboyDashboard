//! 财务资金 → 佣金管理（P5-5，BLF-734）
//!
//! 对齐 web 端 `app/dashboard/finance/commission-management`（约 1935 行，
//! 4 Tab + 规则卡）的**读取主面**：总览（项目 × 站点月度佣金）+ 年-月汇总 +
//! 项目汇总矩阵 + 月度回款矩阵 + 工厂佣金结算规则卡。
//!
//! ## 与 web 端的取舍（issue 允许按 macOS 原生习惯精简并说明）
//!
//! - **保留**：四态状态机、4 Tab（总览/年-月汇总/项目汇总/月度回款）、
//!   月份 / 年份 / 站点筛选（默认上月 / 当前年 / 全部站点，对齐 web
//!   `lastMonthString` / `getCurrentYear`）、总览 7 列（项目/站点/销售收入/
//!   佣金比例/工厂佣金/已回款/回款状态，佣金比例标签对齐 web
//!   `getCommissionRatioLabel` 的阶梯优先级）、年-月汇总 6 列、项目汇总与
//!   月度回款的 项目 × 12 月矩阵、回款率四档色块（≥100%/≥50%/≥20%/<20%，
//!   对齐 web `getReceiveRateColor` 阈值 + 1e-9 容差）、规则卡两规则；
//! - **精简**：
//!   - 写入链路走 web 端（对齐 BLF-726 发货管理 / BLF-731 订单信息 /
//!     BLF-732 汇率信息 / BLF-733 VAT 发票取舍）：回款状态切换、已回款金额
//!     编辑（`PATCH …/project-months/{id}/payment`）与「核算」
//!     （`POST …/recompute`）不接 GUI——已回款列与回款状态列只读展示；
//!   - web 总览按项目 rowSpan 合并项目名单元格；GPUI DataTable 无合并单元格，
//!     逐行显示项目名；
//!   - web 年-月汇总 / 项目汇总表尾「合计」行（BLF-504）：GUI 以统计数字带
//!     承载年度合计（年度销售 / 年度工厂佣金 / 年度回款）；项目汇总表尾的
//!     逐月合计行不移植；
//!   - 月度回款图例文案按代码实际阈值标注（web 图例「50%~70%」为陈旧文案，
//!     代码阈值为 ≥50%）；
//!   - web 总览拉取的 `exchangeRates` 未参与任何渲染（web 侧死数据），GUI
//!     不拉取（api-client 模块头有说明）；
//!   - 数据加载：web 在切到汇总 Tab 时才拉汇总；GUI 每次 reload 并行拉取
//!     月份明细 + 年度两汇总（切 Tab 零等待，代价为每次多两个轻量请求）；
//!   - 手机端布局不移植（GUI 桌面端单布局）。
//!
//! ## 状态机
//!
//! `Loading`（首屏 / 筛选切换）→ `Loaded`（任一数据集非空）/ `Empty`（三个
//! 数据集全空）/ `Error`（请求失败）。各表内空态由 DataTable `empty_text`
//! 承载（对齐 web 各 Tab 独立空态文案）。

use gpui::prelude::*;
use gpui::{
    div, px, App, AsyncApp, Context, Entity, FontWeight, Hsla, IntoElement, Render, SharedString,
    WeakEntity, Window,
};
use gpui_component::button::Button;
use gpui_component::menu::PopupMenuItem;
use gpui_component::{h_flex, v_flex, Sizable, StyledExt};
use gui_api_client::commission::{CommissionMonthFilter, CommissionYearFilter};
use gui_api_client::Client;
use gui_domain::commission::{
    commission_ratio_label, payment_status_label, receive_rate_level, site_currency,
    site_currency_symbol, CommissionProjectMonthItem, CommissionProjectYearlySummaryItem,
    CommissionYearlyMonthlySummaryItem, ReceiveRateLevel, PAYMENT_STATUS_PAID,
    PAYMENT_STATUS_PARTIAL, PAYMENT_STATUS_UNPAID, SITE_ORDER,
};
use gui_domain::common::ManagedProject;

use crate::theme::AppTheme;
use crate::widgets::data_table::{CellAlign, ColumnDef, DataTable};
use crate::widgets::filter_bar;
use crate::widgets::page_header::PageHeader;
use crate::widgets::pattern_b::{pattern_b_shell, tab_bar, tabs_zone, TabItem};
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「财务资金 → 佣金管理」URL（数据权威 gui-domain::sidebar）
pub const COMMISSION_URL: &str = "/dashboard/finance/commission-management";

/// 页面 Tab（对齐 web `CommissionViewTab`；顺序即展示顺序）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommissionTab {
    /// 总览（项目 × 站点月度佣金）
    Detail,
    /// 年-月汇总
    MonthlySummary,
    /// 项目汇总（项目 × 12 月佣金矩阵）
    ProjectSummary,
    /// 月度回款（项目 × 12 月回款率色块矩阵）
    MonthlyCollection,
}

impl CommissionTab {
    /// 全部 Tab（对齐 web TabsList 顺序）
    pub const ALL: [Self; 4] = [
        Self::Detail,
        Self::MonthlySummary,
        Self::ProjectSummary,
        Self::MonthlyCollection,
    ];

    /// 展示标签（对齐 web TabsTrigger 文案）
    pub fn label(self) -> &'static str {
        match self {
            Self::Detail => "总览",
            Self::MonthlySummary => "年-月汇总",
            Self::ProjectSummary => "项目汇总",
            Self::MonthlyCollection => "月度回款",
        }
    }

    /// element id 后缀
    fn id(self) -> &'static str {
        match self {
            Self::Detail => "detail",
            Self::MonthlySummary => "monthly-summary",
            Self::ProjectSummary => "project-summary",
            Self::MonthlyCollection => "monthly-collection",
        }
    }
}

// ---------------------------------------------------------------------------
// 格式化 / 派生辅助
// ---------------------------------------------------------------------------

/// 金额 → 千分位 + 两位小数（绝对值；符号由调用方处理）
fn fmt_money(value: f64) -> String {
    let text = format!("{:.2}", value.abs());
    let (int_part, dec_part) = text.split_once('.').unwrap_or((text.as_str(), ""));
    let mut out = String::with_capacity(int_part.len() + int_part.len() / 3 + 4);
    for (i, ch) in int_part.chars().enumerate() {
        if i > 0 && (int_part.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    if !dec_part.is_empty() {
        out.push('.');
        out.push_str(dec_part);
    }
    out
}

/// USD 金额（对齐 web `formatUsd`：负号在 `$` 前）
fn format_usd(value: f64) -> String {
    format!(
        "{}${}",
        if value < 0.0 { "-" } else { "" },
        fmt_money(value)
    )
}

/// RMB 金额（对齐 web `formatRmb`：负号在 `¥` 前）
fn format_rmb(value: f64) -> String {
    format!(
        "{}¥{}",
        if value < 0.0 { "-" } else { "" },
        fmt_money(value)
    )
}

/// 销售收入本地货币文本（对齐 web `formatIncomeWithCurrency`：`$1,234.56 USD`）
fn format_income_with_currency(amount: f64, country: &str) -> String {
    let symbol = site_currency_symbol(country);
    let currency = site_currency(country);
    let sign = if amount < 0.0 { "-" } else { "" };
    if currency.is_empty() {
        return format!("{sign}{}", fmt_money(amount));
    }
    format!("{sign}{symbol}{} {currency}", fmt_money(amount))
}

/// 站点圆点色（对齐 web `SITE_INFO.dotClass`：US 蓝 / DE 紫 / UK 绿；
/// 未知站点 slate-400 兜底）
fn site_dot_color(country: &str) -> Hsla {
    match country.trim().to_ascii_uppercase().as_str() {
        "US" => gpui::rgb(0x3B82F6).into(),
        "DE" => gpui::rgb(0xA855F7).into(),
        "UK" => gpui::rgb(0x22C55E).into(),
        _ => gpui::rgb(0x94A3B8).into(),
    }
}

/// 回款状态徽标（paid = 成功 / partial = 警告 / unpaid = 危险；web 为下拉
/// 写入口，GUI 只读 → 徽标展示，配色沿用 vat_invoice `status_pill` 观感）
fn payment_pill_colors(status: &str, theme: &AppTheme) -> (Hsla, Hsla) {
    match status {
        PAYMENT_STATUS_PAID => (theme.success_soft, theme.success),
        PAYMENT_STATUS_PARTIAL => (theme.warning.opacity(0.16), theme.warning),
        PAYMENT_STATUS_UNPAID => (theme.danger_soft, theme.danger),
        _ => (theme.muted_fill, theme.text_secondary),
    }
}

/// 回款状态徽标单元格
fn payment_pill(status: &str, theme: &AppTheme) -> gpui::AnyElement {
    let (bg, fg) = payment_pill_colors(status, theme);
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
                .child(payment_status_label(status)),
        )
        .into_any_element()
}

/// 回款率分档配色（对齐 web `getReceiveRateColor`：≥100% 绿 / ≥50% 橙 /
/// ≥20% 黄 / <20% 红；黄档 web 为 yellow 硬编码 + dark 变体，GUI 统一用
/// yellow-500 低透明度底 + 同色文字，亮暗两态均可读）
fn rate_pill_colors(level: ReceiveRateLevel, theme: &AppTheme) -> (Hsla, Hsla) {
    match level {
        ReceiveRateLevel::Positive => (theme.success.opacity(0.14), theme.success),
        ReceiveRateLevel::Warning => (theme.warning.opacity(0.16), theme.warning),
        ReceiveRateLevel::Yellow => {
            let yellow: Hsla = gpui::rgb(0xEAB308).into();
            (yellow.opacity(0.18), yellow)
        }
        ReceiveRateLevel::Negative => (theme.danger.opacity(0.12), theme.danger),
    }
}

/// 回款率色块单元格（对齐 web 月度回款矩阵的 inline-block 色块）
fn rate_pill(rate: f64, theme: &AppTheme) -> gpui::AnyElement {
    let (bg, fg) = rate_pill_colors(receive_rate_level(rate), theme);
    div()
        .min_w(px(56.0))
        .text_center()
        .rounded(px(theme.radius))
        .bg(bg)
        .px_1p5()
        .py_1()
        .text_xs()
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg)
        .child(gui_domain::commission::format_percent(rate))
        .into_any_element()
}

/// 默认总览月份 = 上个月（对齐 web `lastMonthString`；取本月 1 号减一天 =
/// 上月末，规避月末天数差）
fn default_report_month() -> String {
    use chrono::Datelike;
    let today = chrono::Local::now().date_naive();
    let first_of_this_month = today.with_day(1).unwrap_or(today);
    let last_of_prev = first_of_this_month - chrono::Duration::days(1);
    format!("{:04}-{:02}", last_of_prev.year(), last_of_prev.month())
}

/// 默认汇总年份 = 当前年（对齐 web `getCurrentYear`）
fn default_summary_year() -> String {
    use chrono::Datelike;
    chrono::Local::now().year().to_string()
}

/// 年份下拉选项（当前年起往前 5 年）
fn year_options() -> Vec<i64> {
    use chrono::Datelike;
    let current = chrono::Local::now().year();
    ((current - 4)..=current).map(i64::from).collect()
}

/// `YYYY-MM` → 月份部分（1-12；解析失败回退 1）
fn month_part(report_month: &str) -> u32 {
    report_month
        .split('-')
        .nth(1)
        .and_then(|m| m.parse::<u32>().ok())
        .filter(|m| (1..=12).contains(m))
        .unwrap_or(1)
}

/// `YYYY-MM` → 年份部分（解析失败回退当前年）
fn year_part(report_month: &str) -> i64 {
    use chrono::Datelike;
    report_month
        .split('-')
        .next()
        .and_then(|y| y.parse::<i64>().ok())
        .unwrap_or_else(|| i64::from(chrono::Local::now().year()))
}

/// 某年的 12 个月键（`YYYY-MM`；下标 0 = 1 月）
fn year_month_keys(year: &str) -> [String; 12] {
    core::array::from_fn(|i| format!("{year}-{:02}", i + 1))
}

// ---------------------------------------------------------------------------
// 行类型（DataTable 行；渲染收 fn pointer，派生值在数据落点时预算进行内）
// ---------------------------------------------------------------------------

/// 总览行（站点圆点 / 佣金比例标签 / 状态徽标均在落点期解析）
#[derive(Debug, Clone, PartialEq)]
pub struct DetailRow {
    pub id: i64,
    pub project_id: i64,
    pub project_name: String,
    pub country: String,
    /// 销售收入文本（本地货币，落点期格式化）
    pub income_text: String,
    /// 佣金比例标签（阶梯 / 元数据比例 / 行比例，落点期解析）
    pub ratio_label: String,
    pub factory_commission_rmb: f64,
    pub received_rmb: f64,
    pub payment_status: String,
}

/// 项目年度汇总矩阵行（项目汇总 / 月度回款两表共用）
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectSummaryRow {
    pub project_id: i64,
    pub project_name: String,
    /// 12 个月工厂佣金(RMB)（下标 0 = 1 月；`None` = 该月无数据）
    pub month_commission: [Option<f64>; 12],
    /// 12 个月回款率（下标 0 = 1 月；`None` = 该月无数据）
    pub month_rates: [Option<f64>; 12],
    pub total_income_usd: f64,
    pub total_commission_rmb: f64,
    pub total_received_rmb: f64,
    pub receive_rate: f64,
}

impl ProjectSummaryRow {
    /// 后端项目年度汇总行 → 矩阵行（按 `year` 的 12 个月键取格数据）
    pub fn from_item(item: &CommissionProjectYearlySummaryItem, year: &str) -> Self {
        let keys = year_month_keys(year);
        let mut month_commission: [Option<f64>; 12] = [None; 12];
        let mut month_rates: [Option<f64>; 12] = [None; 12];
        for (ix, key) in keys.iter().enumerate() {
            if let Some(cell) = item.month(key) {
                month_commission[ix] = Some(cell.factory_commission_rmb);
                month_rates[ix] = Some(cell.receive_rate);
            }
        }
        Self {
            project_id: item.project_id,
            project_name: item.project_name.clone(),
            month_commission,
            month_rates,
            total_income_usd: item.total_income_usd,
            total_commission_rmb: item.total_commission_rmb,
            total_received_rmb: item.total_received_rmb,
            receive_rate: item.receive_rate,
        }
    }
}

/// 总览行构造（佣金比例标签按项目元数据解析——对齐 web
/// `getCommissionRatioLabel`）
fn build_detail_rows(
    items: &[CommissionProjectMonthItem],
    projects: &[ManagedProject],
) -> Vec<DetailRow> {
    items
        .iter()
        .map(|item| {
            let meta = projects.iter().find(|p| p.id == item.project_id);
            DetailRow {
                id: item.id,
                project_id: item.project_id,
                project_name: item.project_name.clone(),
                country: item.country.clone(),
                income_text: format_income_with_currency(item.income_total_usd, &item.country),
                ratio_label: commission_ratio_label(
                    item.factory_commission_rate,
                    meta.and_then(|p| p.commission_basis.as_deref()),
                    meta.and_then(|p| p.commission_rate),
                ),
                factory_commission_rmb: item.factory_commission_rmb,
                received_rmb: item.received_rmb,
                payment_status: item.payment_status.clone(),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 载荷 / 状态机
// ---------------------------------------------------------------------------

/// 佣金管理载荷（Loaded 持有）
#[derive(Debug, Clone, PartialEq)]
pub struct CommissionData {
    /// 项目列表（佣金比例标签的元数据源；reload 间缓存）
    pub projects: Vec<ManagedProject>,
    /// 实际拉取的总览月份（`YYYY-MM`，回显后端归一值）
    pub detail_month: String,
    /// 总览行（项目月度佣金）
    pub detail_rows: Vec<CommissionProjectMonthItem>,
    /// 实际拉取的汇总年份
    pub summary_year: String,
    /// 年-月汇总
    pub monthly_summary: Vec<CommissionYearlyMonthlySummaryItem>,
    /// 项目年度汇总
    pub project_summary: Vec<CommissionProjectYearlySummaryItem>,
}

impl CommissionData {
    /// 空态判定：三个数据集全空
    pub fn is_empty(&self) -> bool {
        self.detail_rows.is_empty()
            && self.monthly_summary.is_empty()
            && self.project_summary.is_empty()
    }
}

/// 佣金管理状态机（四态；沿用既有 view 模式）
#[derive(Debug, Clone, PartialEq)]
pub enum CommissionState {
    Loading,
    Loaded(Box<CommissionData>),
    Empty,
    Error(String),
}

impl CommissionState {
    /// 拉取结果 → 落点状态
    pub fn from_fetch_result(result: Result<CommissionData, String>) -> Self {
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

/// 佣金管理视图（四态状态机 + 4 Tab + 月份/年份/站点筛选 + 竞态保护）
pub struct CommissionView {
    state: Entity<CommissionState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表缓存（佣金比例标签元数据源；首次 reload 拉取后复用）
    projects: Vec<ManagedProject>,
    /// 总览月份 `YYYY-MM`（默认上个月）
    report_month: String,
    /// 汇总年份 `YYYY`（默认当前年）
    summary_year: String,
    /// 站点筛选（`None` = 全部站点）
    country: Option<&'static str>,
    /// 当前 Tab
    active_tab: CommissionTab,
    /// 总览表（Stage 0 DataTable，总存在）
    detail_table: Entity<DataTable<DetailRow>>,
    /// 年-月汇总表（Stage 0 DataTable，总存在）
    monthly_table: Entity<DataTable<CommissionYearlyMonthlySummaryItem>>,
    /// 项目汇总矩阵表（Stage 0 DataTable，总存在）
    project_table: Entity<DataTable<ProjectSummaryRow>>,
    /// 月度回款矩阵表（Stage 0 DataTable，总存在）
    collection_table: Entity<DataTable<ProjectSummaryRow>>,
    /// 主请求竞态保护
    latest_request_id: u64,
}

impl CommissionView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| CommissionState::Loading);
        let detail_table = cx.new(|_| {
            DataTable::new("commission-detail-table", detail_columns())
                .striped(true)
                .empty_text("当前月份暂无数据，请先在 web 端刷新核算")
        });
        let monthly_table = cx.new(|_| {
            DataTable::new("commission-monthly-table", monthly_columns())
                .striped(true)
                .empty_text("该年份暂无数据")
        });
        let project_table = cx.new(|_| {
            DataTable::new("commission-project-table", project_summary_columns())
                .striped(true)
                .empty_text("该年份暂无数据")
        });
        let collection_table = cx.new(|_| {
            DataTable::new("commission-collection-table", collection_columns())
                .striped(true)
                .empty_text("该年份暂无数据")
        });
        Self {
            state,
            client,
            projects: Vec::new(),
            report_month: default_report_month(),
            summary_year: default_summary_year(),
            country: None,
            active_tab: CommissionTab::Detail,
            detail_table,
            monthly_table,
            project_table,
            collection_table,
            latest_request_id: 0,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> CommissionState {
        self.state.read(cx).clone()
    }

    /// 重新拉取：首屏 / 筛选切换 / 错误重试 / 空态刷新共用入口（竞态保护；
    /// 每次调用递增 `latest_request_id` 并进入 Loading）。月份明细 + 年度两
    /// 汇总一次拉全（切 Tab 零等待；取舍见模块头）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let month_filter = CommissionMonthFilter {
            report_month: self.report_month.clone(),
            country: self.country.map(str::to_string),
        };
        let year_filter = CommissionYearFilter {
            year: self.summary_year.clone(),
            country: self.country.map(str::to_string),
        };
        let projects_cache = if self.projects.is_empty() {
            None
        } else {
            Some(self.projects.clone())
        };

        self.state.update(cx, |state, cx| {
            *state = CommissionState::Loading;
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
                        month_filter,
                        year_filter,
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

    /// 应用主数据拉取结果（竞态保护）：落点项目缓存 + 各表行 + 状态机
    fn apply_main_result(
        &mut self,
        request_id: u64,
        result: Result<CommissionData, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        let next = CommissionState::from_fetch_result(result);
        if let CommissionState::Loaded(data) = &next {
            self.projects = data.projects.clone();
            let year = data.summary_year.clone();
            let detail_rows = build_detail_rows(&data.detail_rows, &data.projects);
            let project_rows: Vec<ProjectSummaryRow> = data
                .project_summary
                .iter()
                .map(|item| ProjectSummaryRow::from_item(item, &year))
                .collect();
            self.detail_table.update(cx, |t, cx| {
                t.set_rows(detail_rows, cx);
            });
            self.monthly_table.update(cx, |t, cx| {
                t.set_rows(data.monthly_summary.clone(), cx);
            });
            self.project_table.update(cx, |t, cx| {
                t.set_rows(project_rows.clone(), cx);
            });
            self.collection_table.update(cx, |t, cx| {
                t.set_rows(project_rows, cx);
            });
        } else {
            self.detail_table
                .update(cx, |t, cx| t.set_rows(Vec::new(), cx));
            self.monthly_table
                .update(cx, |t, cx| t.set_rows(Vec::new(), cx));
            self.project_table
                .update(cx, |t, cx| t.set_rows(Vec::new(), cx));
            self.collection_table
                .update(cx, |t, cx| t.set_rows(Vec::new(), cx));
        }
        self.state.update(cx, |state, cx| {
            *state = next;
            cx.notify();
        });
    }

    /// 切换总览年份（同一组合为 no-op）
    pub fn select_detail_year(&mut self, year: i64, cx: &mut Context<Self>) {
        self.set_report_month(year, month_part(&self.report_month), cx);
    }

    /// 切换总览月份（同一组合为 no-op）
    pub fn select_detail_month(&mut self, month: u32, cx: &mut Context<Self>) {
        self.set_report_month(year_part(&self.report_month), month, cx);
    }

    /// 落点总览月份（`YYYY-MM` 归一两位月；变化才重拉）
    fn set_report_month(&mut self, year: i64, month: u32, cx: &mut Context<Self>) {
        let next = format!("{year:04}-{month:02}");
        if next == self.report_month {
            return;
        }
        self.report_month = next;
        self.reload(cx);
    }

    /// 切换汇总年份（同一年为 no-op）
    pub fn select_summary_year(&mut self, year: i64, cx: &mut Context<Self>) {
        let next = year.to_string();
        if next == self.summary_year {
            return;
        }
        self.summary_year = next;
        self.reload(cx);
    }

    /// 切换站点筛选（同一站点为 no-op；`None` = 全部站点）
    pub fn select_country(&mut self, country: Option<&'static str>, cx: &mut Context<Self>) {
        if country == self.country {
            return;
        }
        self.country = country;
        self.reload(cx);
    }

    /// 切换 Tab（同一 Tab 为 no-op；数据已全量拉取，切换零请求）
    pub fn select_tab(&mut self, tab: CommissionTab, cx: &mut Context<Self>) {
        if tab == self.active_tab {
            return;
        }
        self.active_tab = tab;
        cx.notify();
    }
}

// ---------------------------------------------------------------------------
// 数据加载辅助函数
// ---------------------------------------------------------------------------

/// 主数据加载：项目列表（缓存缺省时拉取）→ 月份明细 → 年度两汇总
/// （顺序拉取；任一失败整体报错——与 web 任一请求失败 notify error 同口径）
async fn load_main(
    client: &Client,
    projects_cache: Option<Vec<ManagedProject>>,
    month_filter: CommissionMonthFilter,
    year_filter: CommissionYearFilter,
) -> Result<CommissionData, String> {
    let projects = match projects_cache {
        Some(projects) => projects,
        None => client
            .list_managed_projects()
            .await
            .map_err(|e| e.user_message())?,
    };
    let detail = client
        .commission_project_months(&month_filter)
        .await
        .map_err(|e| e.user_message())?;
    let monthly = client
        .commission_summary_monthly(&year_filter)
        .await
        .map_err(|e| e.user_message())?;
    let project = client
        .commission_summary_project(&year_filter)
        .await
        .map_err(|e| e.user_message())?;
    Ok(CommissionData {
        projects,
        detail_month: detail.report_month,
        detail_rows: detail.items,
        summary_year: year_filter.year,
        monthly_summary: monthly.items,
        project_summary: project.items,
    })
}

// ---------------------------------------------------------------------------
// 列定义
// ---------------------------------------------------------------------------

/// 总览 7 列（对齐 web DetailTab：项目/站点/销售收入/佣金比例/工厂佣金(RMB)
/// /已回款(RMB)/回款状态；已回款与回款状态只读——写入走 web 端）
fn detail_columns() -> Vec<ColumnDef<DetailRow>> {
    vec![
        ColumnDef::text("project", "项目", |r: &DetailRow, _| {
            SharedString::from(r.project_name.clone())
        })
        .width(140.0),
        ColumnDef::text("site", "站点", |r: &DetailRow, _| {
            SharedString::from(r.country.clone())
        })
        .with_render_element(|r: &DetailRow, theme| {
            h_flex()
                .items_center()
                .gap_1p5()
                .child(div().size_2().rounded_full().bg(site_dot_color(&r.country)))
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_secondary)
                        .child(SharedString::from(r.country.clone())),
                )
                .into_any_element()
        })
        .width(72.0),
        ColumnDef::text("income", "销售收入", |r: &DetailRow, _| {
            SharedString::from(r.income_text.clone())
        })
        .align(CellAlign::Right)
        .width(140.0),
        ColumnDef::text("ratio", "佣金比例", |r: &DetailRow, _| {
            SharedString::from(r.ratio_label.clone())
        })
        .align(CellAlign::Right)
        .width(120.0),
        ColumnDef::number(
            "commission",
            "工厂佣金(RMB)",
            |r: &DetailRow| r.factory_commission_rmb,
            |r: &DetailRow, _| SharedString::from(format_rmb(r.factory_commission_rmb)),
        )
        .width(120.0),
        ColumnDef::number(
            "received",
            "已回款(RMB)",
            |r: &DetailRow| r.received_rmb,
            |r: &DetailRow, _| SharedString::from(format_rmb(r.received_rmb)),
        )
        .width(120.0),
        ColumnDef::text("status", "回款状态", |r: &DetailRow, _| {
            SharedString::from(payment_status_label(&r.payment_status))
        })
        .with_render_element(|r: &DetailRow, theme| payment_pill(&r.payment_status, theme))
        .width(92.0),
    ]
}

/// 年-月汇总 6 列（对齐 web MonthlySummaryTab：月份/销售收入(USD)/工厂佣金
/// (USD)/工厂佣金(RMB)/已回款(RMB)/回款率）
fn monthly_columns() -> Vec<ColumnDef<CommissionYearlyMonthlySummaryItem>> {
    vec![
        ColumnDef::text(
            "month",
            "月份",
            |r: &CommissionYearlyMonthlySummaryItem, _| SharedString::from(r.report_month.clone()),
        )
        .width(96.0),
        ColumnDef::number(
            "income",
            "销售收入(USD)",
            |r: &CommissionYearlyMonthlySummaryItem| r.income_total_usd,
            |r: &CommissionYearlyMonthlySummaryItem, _| {
                SharedString::from(format_usd(r.income_total_usd))
            },
        )
        .width(130.0),
        ColumnDef::number(
            "commission-usd",
            "工厂佣金(USD)",
            |r: &CommissionYearlyMonthlySummaryItem| r.factory_commission_usd,
            |r: &CommissionYearlyMonthlySummaryItem, _| {
                SharedString::from(format_usd(r.factory_commission_usd))
            },
        )
        .width(130.0),
        ColumnDef::number(
            "commission-rmb",
            "工厂佣金(RMB)",
            |r: &CommissionYearlyMonthlySummaryItem| r.factory_commission_rmb,
            |r: &CommissionYearlyMonthlySummaryItem, _| {
                SharedString::from(format_rmb(r.factory_commission_rmb))
            },
        )
        .width(130.0),
        ColumnDef::number(
            "received",
            "已回款(RMB)",
            |r: &CommissionYearlyMonthlySummaryItem| r.received_rmb,
            |r: &CommissionYearlyMonthlySummaryItem, _| {
                SharedString::from(format_rmb(r.received_rmb))
            },
        )
        .width(120.0),
        ColumnDef::number(
            "rate",
            "回款率",
            |r: &CommissionYearlyMonthlySummaryItem| r.receive_rate,
            |r: &CommissionYearlyMonthlySummaryItem, _| {
                SharedString::from(gui_domain::commission::format_percent(r.receive_rate))
            },
        )
        .width(96.0),
    ]
}

/// 项目汇总矩阵列：项目名称 + 12 个月佣金 + 年度佣金合计 + 年度回款 + 回款率
/// （对齐 web ProjectSummaryTab；月度格为只读金额文本，无数据 → 「-」）
fn project_summary_columns() -> Vec<ColumnDef<ProjectSummaryRow>> {
    let mut columns =
        vec![
            ColumnDef::text("project", "项目名称", |r: &ProjectSummaryRow, _| {
                SharedString::from(r.project_name.clone())
            })
            .width(140.0),
        ];
    for (ix, label) in month_labels().into_iter().enumerate() {
        columns.push(
            ColumnDef::text(
                SharedString::from(format!("commission-m{}", ix + 1)),
                label,
                |_r: &ProjectSummaryRow, _| SharedString::from("-"),
            )
            .with_render_element(move |r: &ProjectSummaryRow, _theme| {
                div()
                    .child(SharedString::from(
                        r.month_commission[ix]
                            .map(format_rmb)
                            .unwrap_or_else(|| "-".to_string()),
                    ))
                    .into_any_element()
            })
            .align(CellAlign::Right)
            .width(76.0),
        );
    }
    columns.push(
        ColumnDef::number(
            "total-commission",
            "年度佣金合计",
            |r: &ProjectSummaryRow| r.total_commission_rmb,
            |r: &ProjectSummaryRow, _| SharedString::from(format_rmb(r.total_commission_rmb)),
        )
        .width(110.0),
    );
    columns.push(
        ColumnDef::number(
            "total-received",
            "年度回款",
            |r: &ProjectSummaryRow| r.total_received_rmb,
            |r: &ProjectSummaryRow, _| SharedString::from(format_rmb(r.total_received_rmb)),
        )
        .width(110.0),
    );
    columns.push(
        ColumnDef::number(
            "rate",
            "回款率",
            |r: &ProjectSummaryRow| r.receive_rate,
            |r: &ProjectSummaryRow, _| {
                SharedString::from(gui_domain::commission::format_percent(r.receive_rate))
            },
        )
        .width(88.0),
    );
    columns
}

/// 月度回款矩阵列：项目名称 + 12 个月回款率色块 + 年度汇总
/// （对齐 web MonthlyCollectionTab；无数据 → 灰「-」）
fn collection_columns() -> Vec<ColumnDef<ProjectSummaryRow>> {
    let mut columns =
        vec![
            ColumnDef::text("project", "项目名称", |r: &ProjectSummaryRow, _| {
                SharedString::from(r.project_name.clone())
            })
            .width(140.0),
        ];
    for (ix, label) in month_labels().into_iter().enumerate() {
        columns.push(
            ColumnDef::text(
                SharedString::from(format!("rate-m{}", ix + 1)),
                label,
                |_r: &ProjectSummaryRow, _| SharedString::from("-"),
            )
            .with_render_element(
                move |r: &ProjectSummaryRow, theme| match r.month_rates[ix] {
                    Some(rate) => rate_pill(rate, theme),
                    None => div()
                        .min_w(px(48.0))
                        .text_center()
                        .rounded(px(theme.radius))
                        .bg(theme.muted_fill)
                        .px_1p5()
                        .py_1()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child("-")
                        .into_any_element(),
                },
            )
            .align(CellAlign::Center)
            .width(72.0),
        );
    }
    columns.push(
        ColumnDef::text("total-rate", "年度汇总", |r: &ProjectSummaryRow, _| {
            SharedString::from(gui_domain::commission::format_percent(r.receive_rate))
        })
        .with_render_element(|r: &ProjectSummaryRow, theme| {
            if r.receive_rate > 0.0 {
                rate_pill(r.receive_rate, theme)
            } else {
                div()
                    .min_w(px(56.0))
                    .text_center()
                    .rounded(px(theme.radius))
                    .bg(theme.muted_fill)
                    .px_1p5()
                    .py_1()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child("-")
                    .into_any_element()
            }
        })
        .align(CellAlign::Center)
        .width(84.0),
    );
    columns
}

/// 1-12 月表头标签
fn month_labels() -> [String; 12] {
    core::array::from_fn(|i| format!("{}月", i + 1))
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for CommissionView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let view = cx.entity();
        // Pattern B 下半区机制：Tab 条进 36px 工具栏行，内容区占满剩余高度；
        // 规则卡随 Tab 内容尾部渲染（总览 / 月度回款可见，对齐 web 布局位置）
        match state {
            CommissionState::Loading => pattern_b_shell(
                &app_theme,
                "commission",
                PageHeader::new("佣金管理").subtitle("项目佣金月度核算与回款跟踪"),
                div(),
                0.0,
                div(),
                div(),
                render_loading(&app_theme),
            )
            .into_any_element(),
            CommissionState::Error(msg) => pattern_b_shell(
                &app_theme,
                "commission",
                PageHeader::new("佣金管理").subtitle("项目佣金月度核算与回款跟踪"),
                div(),
                0.0,
                div(),
                div(),
                state_views::error_state(
                    &view,
                    &app_theme,
                    "commission-error",
                    "佣金数据加载失败",
                    msg,
                    |this, cx| this.reload(cx),
                ),
            )
            .into_any_element(),
            CommissionState::Empty => pattern_b_shell(
                &app_theme,
                "commission",
                PageHeader::new("佣金管理").subtitle("项目佣金月度核算与回款跟踪"),
                div(),
                0.0,
                div(),
                div(),
                state_views::empty_state_with_action_desc(
                    &view,
                    &app_theme,
                    "commission-empty",
                    "icons/coins.svg",
                    "当前筛选条件下暂无佣金数据",
                    Some("请确认月份 / 年份 / 站点筛选，或在 web 端先执行核算".to_string()),
                    "刷新",
                    |this, cx| this.reload(cx),
                ),
            )
            .into_any_element(),
            CommissionState::Loaded(data) => {
                let subtitle =
                    "项目佣金月度核算与回款跟踪；回款状态更新与「核算」请在 web 端操作".to_string();
                let header = PageHeader::new("佣金管理").subtitle(subtitle);
                // 工具栏行 = 子 Tab 条（Pattern B 下半区机制）
                let tab_items: Vec<TabItem> = CommissionTab::ALL
                    .iter()
                    .map(|t| TabItem::new(t.id(), t.label()))
                    .collect();
                let active_ix = CommissionTab::ALL
                    .iter()
                    .position(|t| *t == self.active_tab)
                    .unwrap_or(0);
                let strip = tab_bar(
                    &view,
                    &app_theme,
                    "commission",
                    &tab_items,
                    active_ix,
                    |this, ix, cx| {
                        this.select_tab(CommissionTab::ALL[ix], cx);
                    },
                );
                // 筛选控件行（Tab 相关的年/月/站点下拉）
                let filter_row = h_flex()
                    .gap_2()
                    .items_center()
                    .px_2()
                    .py_1p5()
                    .child(render_filter_card(
                        &view,
                        self.active_tab,
                        &self.report_month,
                        &self.summary_year,
                        self.country,
                        &app_theme,
                    ))
                    .child(div().flex_1());
                let content = crate::motion::enter_fade_in(
                    SharedString::from("commission-loaded-fade"),
                    v_flex()
                        .id("commission-loaded")
                        .size_full()
                        .min_h_0()
                        .overflow_y_scroll()
                        .child(render_loaded(
                            cx,
                            &app_theme,
                            &data,
                            self.active_tab,
                            self.detail_table.clone(),
                            self.monthly_table.clone(),
                            self.project_table.clone(),
                            self.collection_table.clone(),
                        ))
                        .when(
                            matches!(
                                self.active_tab,
                                CommissionTab::Detail | CommissionTab::MonthlyCollection
                            ),
                            |this| this.child(content_rules_footer(&app_theme)),
                        )
                        .when(data.is_empty(), |this| {
                            this.child(
                                div()
                                    .text_sm()
                                    .text_color(app_theme.text_muted)
                                    .child("当前筛选条件下暂无佣金数据"),
                            )
                        }),
                    crate::motion::reduce_motion(cx),
                );
                let tabs = tabs_zone(strip, content);
                pattern_b_shell(
                    &app_theme,
                    "commission",
                    header,
                    filter_row,
                    0.0,
                    div(),
                    div(),
                    tabs,
                )
                .into_any_element()
            }
        }
    }
}

/// 规则卡（只读说明；从主体抽离为 Tab 内容尾注）
fn content_rules_footer(theme: &AppTheme) -> gpui::AnyElement {
    render_rules_card(theme)
}

/// 筛选卡（总览：年 + 月下拉；汇总：年下拉；均含站点下拉 + 刷新）
fn render_filter_card(
    view: &Entity<CommissionView>,
    active_tab: CommissionTab,
    report_month: &str,
    summary_year: &str,
    country: Option<&'static str>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let view_for_year = view.clone();
    let view_for_month = view.clone();
    let view_for_summary_year = view.clone();
    let view_for_country = view.clone();
    let view_for_refresh = view.clone();

    let detail_year = year_part(report_month);
    let detail_year_label: SharedString = SharedString::from(format!("{detail_year}年"));
    let detail_month_label: SharedString =
        SharedString::from(format!("{}月", month_part(report_month)));
    let summary_year_label: SharedString = SharedString::from(format!("{summary_year}年"));
    let country_label: SharedString = SharedString::from(country.unwrap_or("全部站点"));

    filter_bar::filter_bar_layout(theme)
        .id("commission-filters")
        // 总览年（detail tab 专属）
        .when(active_tab == CommissionTab::Detail, |this| {
            this.child(filter_bar::filter_select(
                theme,
                "年",
                detail_year_label,
                "commission-detail-year-filter",
                move |menu, _window, _cx| {
                    let mut menu = menu;
                    for year in year_options() {
                        let view = view_for_year.clone();
                        let checked = year == detail_year;
                        menu = menu.item(
                            PopupMenuItem::new(format!("{year}年"))
                                .checked(checked)
                                .on_click(move |_ev, _w, cx| {
                                    view.update(cx, |this, cx| this.select_detail_year(year, cx));
                                }),
                        );
                    }
                    menu
                },
            ))
        })
        // 总览月（detail tab 专属）
        .when(active_tab == CommissionTab::Detail, |this| {
            this.child(filter_bar::filter_select(
                theme,
                "月",
                detail_month_label,
                "commission-detail-month-filter",
                move |menu, _window, _cx| {
                    let mut menu = menu;
                    for month in 1u32..=12 {
                        let view = view_for_month.clone();
                        menu = menu.item(PopupMenuItem::new(format!("{month}月")).on_click(
                            move |_ev, _w, cx| {
                                view.update(cx, |this, cx| this.select_detail_month(month, cx));
                            },
                        ));
                    }
                    menu
                },
            ))
        })
        // 汇总年（三个汇总 tab 共用）
        .when(active_tab != CommissionTab::Detail, |this| {
            this.child(filter_bar::filter_select(
                theme,
                "年",
                summary_year_label,
                "commission-summary-year-filter",
                move |menu, _window, _cx| {
                    let mut menu = menu;
                    for year in year_options() {
                        let view = view_for_summary_year.clone();
                        menu = menu.item(PopupMenuItem::new(format!("{year}年")).on_click(
                            move |_ev, _w, cx| {
                                view.update(cx, |this, cx| this.select_summary_year(year, cx));
                            },
                        ));
                    }
                    menu
                },
            ))
        })
        // 站点（全部 tab 共用）
        .child(filter_bar::filter_select(
            theme,
            "站点",
            country_label,
            "commission-country-filter",
            move |menu, _window, _cx| {
                let mut menu = menu;
                let view_all = view_for_country.clone();
                menu = menu.item(
                    PopupMenuItem::new("全部站点")
                        .checked(country.is_none())
                        .on_click(move |_ev, _w, cx| {
                            view_all.update(cx, |this, cx| this.select_country(None, cx));
                        }),
                );
                for site in SITE_ORDER {
                    let view = view_for_country.clone();
                    let checked = country == Some(site);
                    menu = menu.item(PopupMenuItem::new(site).checked(checked).on_click(
                        move |_ev, _w, cx| {
                            view.update(cx, |this, cx| this.select_country(Some(site), cx));
                        },
                    ));
                }
                menu
            },
        ))
        .child(div().flex_1())
        .child(
            Button::new("commission-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_ev, _w, cx| {
                    view_for_refresh.update(cx, |this, cx| this.reload(cx));
                }),
        )
        .into_any_element()
}

/// 空态文案（对齐 web 各 Tab 空态：总览按月份、汇总按年份）
fn empty_message(active_tab: CommissionTab, report_month: &str, summary_year: &str) -> String {
    match active_tab {
        CommissionTab::Detail => format!("{report_month} 暂无佣金数据，请先在 web 端刷新核算"),
        _ => format!("{summary_year} 年暂无佣金数据"),
    }
}

/// Loading 骨架
fn render_loading(theme: &AppTheme) -> impl IntoElement {
    state_views::skeleton_loading(
        theme,
        &[
            SkeletonBlock::Kpi(2),
            SkeletonBlock::Table(320.0),
            SkeletonBlock::Table(200.0),
        ],
    )
}

/// Loaded：统计数字带 + 当前 Tab 内容
#[allow(clippy::too_many_arguments)]
fn render_loaded(
    cx: &mut Context<CommissionView>,
    theme: &AppTheme,
    data: &CommissionData,
    active_tab: CommissionTab,
    detail_table: Entity<DataTable<DetailRow>>,
    monthly_table: Entity<DataTable<CommissionYearlyMonthlySummaryItem>>,
    project_table: Entity<DataTable<ProjectSummaryRow>>,
    collection_table: Entity<DataTable<ProjectSummaryRow>>,
) -> gpui::AnyElement {
    let reduce = crate::motion::reduce_motion(cx);
    let empty_text = empty_message(active_tab, &data.detail_month, &data.summary_year);

    let content: gpui::AnyElement = match active_tab {
        CommissionTab::Detail => {
            let (commission_total, received_total) = detail_totals(&data.detail_rows);
            v_flex()
                .gap_4()
                .child(stat_cards(
                    vec![
                        ("工厂佣金合计", format_rmb(commission_total), None),
                        ("已回款", format_rmb(received_total), None),
                    ],
                    theme,
                ))
                .child(table_card(
                    "commission-detail-card",
                    "项目月度佣金",
                    &format!("{} · 共 {} 行", data.detail_month, data.detail_rows.len()),
                    theme,
                    detail_table,
                    None,
                ))
                .into_any_element()
        }
        CommissionTab::MonthlySummary => {
            let totals = monthly_totals(&data.monthly_summary);
            let rate = if totals.2 > 0.0 {
                totals.3 / totals.2
            } else {
                0.0
            };
            v_flex()
                .gap_4()
                .child(stat_cards(
                    vec![
                        ("年度销售", format_usd(totals.0), None),
                        ("年度工厂佣金", format_rmb(totals.2), None),
                        ("年度回款", format_rmb(totals.3), None),
                        (
                            "年度回款率",
                            gui_domain::commission::format_percent(rate),
                            Some(rate_pill_colors(receive_rate_level(rate), theme).1),
                        ),
                    ],
                    theme,
                ))
                .child(table_card(
                    "commission-monthly-card",
                    "年-月汇总",
                    &format!(
                        "{} 年 · 共 {} 个月",
                        data.summary_year,
                        data.monthly_summary.len()
                    ),
                    theme,
                    monthly_table,
                    None,
                ))
                .into_any_element()
        }
        CommissionTab::ProjectSummary => {
            let totals = project_totals(&data.project_summary);
            let rate = if totals.0 > 0.0 {
                totals.1 / totals.0
            } else {
                0.0
            };
            v_flex()
                .gap_4()
                .child(stat_cards(
                    vec![
                        ("年度销售", format_usd(totals.2), None),
                        ("年度工厂佣金", format_rmb(totals.0), None),
                        ("年度回款", format_rmb(totals.1), None),
                        (
                            "年度回款率",
                            gui_domain::commission::format_percent(rate),
                            Some(rate_pill_colors(receive_rate_level(rate), theme).1),
                        ),
                    ],
                    theme,
                ))
                .child(table_card(
                    "commission-project-card",
                    "项目汇总",
                    &format!(
                        "{} 年 · 共 {} 个项目",
                        data.summary_year,
                        data.project_summary.len()
                    ),
                    theme,
                    project_table,
                    // 16 列约 1244px，超出窗口宽度时横向滚动
                    Some(1244.0),
                ))
                .into_any_element()
        }
        CommissionTab::MonthlyCollection => v_flex()
            .gap_4()
            .child(table_card(
                "commission-collection-card",
                "月度回款",
                &format!(
                    "{} 年 · 共 {} 个项目",
                    data.summary_year,
                    data.project_summary.len()
                ),
                theme,
                collection_table,
                // 14 列约 1120px，超出窗口宽度时横向滚动
                Some(1120.0),
            ))
            .child(collection_legend(theme))
            .into_any_element(),
    };

    crate::motion::enter_fade_in(
        SharedString::from("commission-loaded-fade"),
        v_flex()
            .id("commission-loaded")
            .gap_4()
            // 空数据集时表格自带空态文案；这里补一条页面级提示（对齐 web 各
            // Tab 独立空态）
            .child(content)
            .when(data.is_empty(), |this| {
                this.child(
                    div()
                        .text_sm()
                        .text_color(theme.text_muted)
                        .child(SharedString::from(empty_text)),
                )
            }),
        reduce,
    )
    .into_any_element()
}

/// 统计数字带（label + value 卡片；对齐 web「本月统计 / 年度统计」栅格）
fn stat_cards(
    cards: Vec<(&'static str, String, Option<Hsla>)>,
    theme: &AppTheme,
) -> impl IntoElement {
    h_flex()
        .id("commission-stats")
        .gap_3()
        .flex_wrap()
        .children(cards.into_iter().map(|(label, value, color)| {
            v_flex()
                .id(SharedString::from(format!("commission-stat-{label}")))
                .flex_1()
                .min_w_40()
                .gap_1p5()
                .p_3()
                .rounded(px(theme.radius_lg))
                .bg(theme.card_bg)
                .shadow(vec![theme.card_shadow_box()])
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(label.to_string()),
                )
                .child(
                    div()
                        .text_lg()
                        .font_semibold()
                        .text_color(color.unwrap_or(theme.text_primary))
                        .truncate()
                        .child(value),
                )
        }))
}

/// 表格卡（标题 + 副标题 + 可选横向滚动容器 + 可选脚注）
fn table_card<T: Clone + PartialEq + 'static>(
    id: &'static str,
    title: &'static str,
    subtitle: &str,
    theme: &AppTheme,
    table: Entity<DataTable<T>>,
    min_width: Option<f32>,
) -> impl IntoElement {
    let body = match min_width {
        Some(w) => div()
            .id(SharedString::from(format!("{id}-scroll")))
            .w_full()
            .overflow_x_scroll()
            .child(div().min_w(px(w)).child(table))
            .into_any_element(),
        None => div().w_full().child(table).into_any_element(),
    };
    v_flex()
        .id(id)
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
                        .child(title.to_string()),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(subtitle.to_string()),
                ),
        )
        .child(div().w_full().px_4().py_2().child(body))
}

/// 月度回款图例（对齐 web 图例行；文案按代码实际阈值标注）
fn collection_legend(theme: &AppTheme) -> impl IntoElement {
    let entries: Vec<(Hsla, &'static str)> = vec![
        (
            rate_pill_colors(ReceiveRateLevel::Positive, theme).1,
            "≥100%",
        ),
        (
            rate_pill_colors(ReceiveRateLevel::Warning, theme).1,
            "50%~100%",
        ),
        (
            rate_pill_colors(ReceiveRateLevel::Yellow, theme).1,
            "20%~50%",
        ),
        (
            rate_pill_colors(ReceiveRateLevel::Negative, theme).1,
            "<20%",
        ),
    ];
    h_flex()
        .id("commission-collection-legend")
        .flex_wrap()
        .items_center()
        .justify_center()
        .gap_4()
        .px_4()
        .py_3()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .border_1()
        .border_color(theme.separator)
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .child("回款率色块："),
        )
        .children(entries.into_iter().map(|(color, label)| {
            h_flex()
                .items_center()
                .gap_1p5()
                .child(div().h_4().w_12().rounded(px(theme.radius)).bg(color))
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_secondary)
                        .child(label.to_string()),
                )
        }))
}

/// 工厂佣金结算规则卡（静态；对齐 web CommissionRulesCard 两规则）
fn render_rules_card(theme: &AppTheme) -> gpui::AnyElement {
    let tiers = [
        "40% - 50% → 7%",
        "50% - 60% → 10%",
        "60% - 70% → 13%",
        "70% 以上 → 15%",
    ];
    v_flex()
        .id("commission-rules")
        .w_full()
        .gap_3()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .p_5()
        .child(
            v_flex()
                .gap_1()
                .child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_muted)
                        .child("PROJECT COMMISSION"),
                )
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_primary)
                        .child("工厂佣金结算规则"),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.text_secondary)
                        .child(
                            "项目与工厂之间的佣金结算口径：按销售额或按回款率阶梯核算；完整维护请在 web 端操作",
                        ),
                ),
        )
        .child(
            h_flex()
                .flex_wrap()
                .gap_3()
                .child(rule_item(
                    "commission-rule-sales",
                    "Rule 01 · 销售额佣金计算",
                    "按月销售收入与项目佣金点数核算",
                    &[],
                    theme,
                ))
                .child(rule_item(
                    "commission-rule-cash",
                    "Rule 02 · 回款佣金核算",
                    "按回款率阶梯自动核算项目佣金",
                    &tiers,
                    theme,
                )),
        )
        .into_any_element()
}

/// 单条规则卡（标题 + 口径说明 + 可选阶梯档位）
fn rule_item(
    id: &'static str,
    title: &'static str,
    description: &str,
    tiers: &[&'static str],
    theme: &AppTheme,
) -> gpui::AnyElement {
    v_flex()
        .id(id)
        .flex_1()
        .min_w_64()
        .gap_2()
        .p_4()
        .rounded(px(theme.radius))
        .bg(theme.muted_fill)
        .child(
            div()
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text_primary)
                .child(title.to_string()),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.text_secondary)
                .child(description.to_string()),
        )
        .when(!tiers.is_empty(), |this| {
            this.child(
                h_flex()
                    .flex_wrap()
                    .gap_2()
                    .children(tiers.iter().map(|tier| {
                        div()
                            .rounded(px(theme.radius))
                            .border_1()
                            .border_color(theme.success.opacity(0.25))
                            .bg(theme.success.opacity(0.1))
                            .px_2()
                            .py_1()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.success)
                            .child(tier.to_string())
                    })),
            )
        })
        .into_any_element()
}

// ---------------------------------------------------------------------------
// 合计辅助
// ---------------------------------------------------------------------------

/// 总览合计（工厂佣金合计, 已回款合计；对齐 web 本月统计）
fn detail_totals(rows: &[CommissionProjectMonthItem]) -> (f64, f64) {
    rows.iter().fold((0.0, 0.0), |(commission, received), row| {
        (
            commission + row.factory_commission_rmb,
            received + row.received_rmb,
        )
    })
}

/// 年-月合计（销售收入, 工厂佣金(USD), 工厂佣金(RMB), 已回款；对齐 web
/// BLF-504 合计行）
fn monthly_totals(items: &[CommissionYearlyMonthlySummaryItem]) -> (f64, f64, f64, f64) {
    items.iter().fold(
        (0.0, 0.0, 0.0, 0.0),
        |(income, commission_usd, commission_rmb, received), item| {
            (
                income + item.income_total_usd,
                commission_usd + item.factory_commission_usd,
                commission_rmb + item.factory_commission_rmb,
                received + item.received_rmb,
            )
        },
    )
}

/// 项目汇总合计（工厂佣金(RMB), 已回款, 销售收入(USD)；对齐 web 项目汇总
/// 合计行）
fn project_totals(items: &[CommissionProjectYearlySummaryItem]) -> (f64, f64, f64) {
    items
        .iter()
        .fold((0.0, 0.0, 0.0), |(commission, received, income), item| {
            (
                commission + item.total_commission_rmb,
                received + item.total_received_rmb,
                income + item.total_income_usd,
            )
        })
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use gui_domain::commission::{
        CommissionProjectMonthlySummaryMonthItem, PAYMENT_STATUS_PAID, PAYMENT_STATUS_PARTIAL,
        PAYMENT_STATUS_UNPAID,
    };
    use std::collections::BTreeMap;

    // ---------- 常量 / 派生函数契约 ----------

    #[test]
    fn url_constant_matches_sidebar() {
        assert_eq!(COMMISSION_URL, "/dashboard/finance/commission-management");
    }

    #[test]
    fn tab_labels_match_web_tabs() {
        assert_eq!(CommissionTab::ALL.len(), 4);
        assert_eq!(CommissionTab::Detail.label(), "总览");
        assert_eq!(CommissionTab::MonthlySummary.label(), "年-月汇总");
        assert_eq!(CommissionTab::ProjectSummary.label(), "项目汇总");
        assert_eq!(CommissionTab::MonthlyCollection.label(), "月度回款");
    }

    #[test]
    fn fmt_money_groups_thousands_with_two_decimals() {
        assert_eq!(fmt_money(0.0), "0.00");
        assert_eq!(fmt_money(1234.56), "1,234.56");
        assert_eq!(fmt_money(1_234_567.891), "1,234,567.89");
        assert_eq!(fmt_money(999.999), "1,000.00");
    }

    #[test]
    fn money_formats_match_web_sign_placement() {
        assert_eq!(format_usd(5000.0), "$5,000.00");
        assert_eq!(format_usd(-12.5), "-$12.50");
        assert_eq!(format_rmb(3615.0), "¥3,615.00");
        assert_eq!(format_rmb(-1.0), "-¥1.00");
    }

    #[test]
    fn income_text_uses_site_currency() {
        assert_eq!(format_income_with_currency(1234.56, "US"), "$1,234.56 USD");
        assert_eq!(format_income_with_currency(1234.56, "DE"), "€1,234.56 EUR");
        assert_eq!(format_income_with_currency(1234.56, "UK"), "£1,234.56 GBP");
        // 未知站点：纯数字兜底
        assert_eq!(format_income_with_currency(12.0, "JP"), "12.00");
    }

    #[test]
    fn payment_pill_colors_follow_status_semantics() {
        let theme = AppTheme::light();
        let (paid_bg, _) = payment_pill_colors(PAYMENT_STATUS_PAID, &theme);
        let (partial_bg, _) = payment_pill_colors(PAYMENT_STATUS_PARTIAL, &theme);
        let (unpaid_bg, _) = payment_pill_colors(PAYMENT_STATUS_UNPAID, &theme);
        let (unknown_bg, _) = payment_pill_colors("weird", &theme);
        assert_eq!(paid_bg, theme.success_soft);
        assert_eq!(partial_bg, theme.warning.opacity(0.16));
        assert_eq!(unpaid_bg, theme.danger_soft);
        assert_eq!(unknown_bg, theme.muted_fill);
    }

    #[test]
    fn rate_pill_colors_follow_web_tiers() {
        let theme = AppTheme::light();
        assert_eq!(
            rate_pill_colors(ReceiveRateLevel::Positive, &theme).1,
            theme.success
        );
        assert_eq!(
            rate_pill_colors(ReceiveRateLevel::Warning, &theme).1,
            theme.warning
        );
        assert_eq!(
            rate_pill_colors(ReceiveRateLevel::Yellow, &theme).1,
            gpui::rgb(0xEAB308).into()
        );
        assert_eq!(
            rate_pill_colors(ReceiveRateLevel::Negative, &theme).1,
            theme.danger
        );
    }

    #[test]
    fn site_dot_colors_match_web_dot_class() {
        assert_eq!(site_dot_color("US"), gpui::rgb(0x3B82F6).into());
        assert_eq!(site_dot_color("de"), gpui::rgb(0xA855F7).into());
        assert_eq!(site_dot_color("UK"), gpui::rgb(0x22C55E).into());
        assert_eq!(site_dot_color("JP"), gpui::rgb(0x94A3B8).into());
    }

    #[test]
    fn default_report_month_is_previous_month() {
        use chrono::Datelike;
        let month = default_report_month();
        assert_eq!(month.len(), 7);
        assert_eq!(month.as_bytes()[4], b'-');
        // 与「本月 1 号减一天」的独立推导一致
        let today = chrono::Local::now().date_naive();
        let expected = today.with_day(1).unwrap() - chrono::Duration::days(1);
        assert_eq!(
            month,
            format!("{:04}-{:02}", expected.year(), expected.month())
        );
    }

    #[test]
    fn month_year_parts_parse_and_fall_back() {
        use chrono::Datelike;
        assert_eq!(month_part("2026-07"), 7);
        assert_eq!(month_part("2026-12"), 12);
        assert_eq!(month_part("bad"), 1);
        assert_eq!(year_part("2026-07"), 2026);
        assert_eq!(year_part("bad"), i64::from(chrono::Local::now().year()));
    }

    #[test]
    fn year_options_covers_recent_five_years() {
        use chrono::Datelike;
        let current = i64::from(chrono::Local::now().year());
        let options = year_options();
        assert_eq!(options.len(), 5);
        assert_eq!(options[0], current - 4);
        assert_eq!(options[4], current);
    }

    #[test]
    fn year_month_keys_are_zero_padded() {
        let keys = year_month_keys("2026");
        assert_eq!(keys[0], "2026-01");
        assert_eq!(keys[11], "2026-12");
    }

    // ---------- 样本构造 ----------

    fn sample_month_item(id: i64, project_id: i64, country: &str) -> CommissionProjectMonthItem {
        CommissionProjectMonthItem {
            id,
            report_month: "2026-07".into(),
            country: country.into(),
            project_id,
            project_name: "德国店".into(),
            income_total_usd: 1234.56,
            factory_commission_rate: 0.1,
            usd_to_rmb_rate: 7.23,
            factory_commission_usd: 123.46,
            factory_commission_rmb: 892.61,
            payment_status: PAYMENT_STATUS_PARTIAL.into(),
            received_rmb: 400.0,
            payment_confirmed_at: None,
            payment_confirmed_by: None,
            note: None,
            computed_at: "2026-08-01T00:00:00+00:00".into(),
            updated_at: "2026-08-02T00:00:00+00:00".into(),
        }
    }

    fn sample_month_cell(month: &str, rate: f64) -> CommissionProjectMonthlySummaryMonthItem {
        CommissionProjectMonthlySummaryMonthItem {
            report_month: month.into(),
            income_total_usd: 100.0,
            factory_commission_rmb: 70.0,
            received_rmb: 70.0 * rate,
            receive_rate: rate,
        }
    }

    fn sample_project_item(project_id: i64) -> CommissionProjectYearlySummaryItem {
        let mut months = BTreeMap::new();
        months.insert("2026-01".to_string(), sample_month_cell("2026-01", 1.0));
        months.insert("2026-02".to_string(), sample_month_cell("2026-02", 0.3));
        CommissionProjectYearlySummaryItem {
            project_id,
            project_name: "德国店".into(),
            months,
            total_income_usd: 300.0,
            total_commission_rmb: 210.0,
            total_received_rmb: 91.0,
            receive_rate: 0.4333,
        }
    }

    fn sample_data() -> CommissionData {
        CommissionData {
            projects: vec![ManagedProject {
                id: 3,
                name: "德国店".into(),
                commission_basis: Some("cash_received".into()),
                commission_rate: Some(0.05),
                ..ManagedProject::default()
            }],
            detail_month: "2026-07".into(),
            detail_rows: vec![sample_month_item(12, 3, "DE")],
            summary_year: "2026".into(),
            monthly_summary: vec![CommissionYearlyMonthlySummaryItem {
                report_month: "2026-07".into(),
                income_total_usd: 5000.0,
                factory_commission_usd: 500.0,
                factory_commission_rmb: 3615.0,
                received_rmb: 1807.5,
                receive_rate: 0.5,
            }],
            project_summary: vec![sample_project_item(3)],
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
            CommissionState::from_fetch_result(Ok(CommissionData {
                projects: Vec::new(),
                detail_month: "2026-07".into(),
                detail_rows: Vec::new(),
                summary_year: "2026".into(),
                monthly_summary: Vec::new(),
                project_summary: Vec::new(),
            })),
            CommissionState::Empty
        );
        assert!(matches!(
            CommissionState::from_fetch_result(Ok(sample_data())),
            CommissionState::Loaded(_)
        ));
        assert_eq!(
            CommissionState::from_fetch_result(Err("boom".into())),
            CommissionState::Error("boom".into())
        );
    }

    // ---------- 行构造 / 合计 ----------

    #[test]
    fn detail_rows_resolve_ratio_label_from_project_meta() {
        let projects = vec![ManagedProject {
            id: 3,
            name: "德国店".into(),
            commission_basis: Some("cash_received".into()),
            commission_rate: Some(0.05),
            ..ManagedProject::default()
        }];
        let rows = build_detail_rows(&[sample_month_item(12, 3, "DE")], &projects);
        assert_eq!(rows.len(), 1);
        // 阶梯口径优先（对齐 web getCommissionRatioLabel）
        assert_eq!(rows[0].ratio_label, "阶梯(7/10/13/15%)");
        assert_eq!(rows[0].income_text, "€1,234.56 EUR");

        // 元数据缺失 → 行自带比例
        let rows_fallback = build_detail_rows(&[sample_month_item(13, 99, "US")], &projects);
        assert_eq!(rows_fallback[0].ratio_label, "10.00%");
    }

    #[test]
    fn project_summary_row_maps_months_by_key() {
        let row = ProjectSummaryRow::from_item(&sample_project_item(3), "2026");
        // 2026-01 有格（rate 1.0）、2026-02 有格（rate 0.3）、3 月无格
        assert_eq!(row.month_commission[0], Some(70.0));
        assert_eq!(row.month_rates[0], Some(1.0));
        assert_eq!(row.month_commission[1], Some(70.0));
        assert_eq!(row.month_rates[1], Some(0.3));
        assert_eq!(row.month_commission[2], None);
        assert_eq!(row.month_rates[2], None);
        assert_eq!(row.month_commission[11], None);
        assert!((row.receive_rate - 0.4333).abs() < 1e-9);
    }

    #[test]
    fn totals_match_web_summation() {
        let (commission, received) =
            detail_totals(&[sample_month_item(1, 3, "DE"), sample_month_item(2, 3, "UK")]);
        assert!((commission - 2.0 * 892.61).abs() < 1e-9);
        assert!((received - 800.0).abs() < 1e-9);

        let monthly = vec![
            CommissionYearlyMonthlySummaryItem {
                report_month: "2026-06".into(),
                income_total_usd: 1000.0,
                factory_commission_usd: 100.0,
                factory_commission_rmb: 723.0,
                received_rmb: 361.5,
                receive_rate: 0.5,
            },
            CommissionYearlyMonthlySummaryItem {
                report_month: "2026-07".into(),
                income_total_usd: 5000.0,
                factory_commission_usd: 500.0,
                factory_commission_rmb: 3615.0,
                received_rmb: 1807.5,
                receive_rate: 0.5,
            },
        ];
        let totals = monthly_totals(&monthly);
        assert!((totals.0 - 6000.0).abs() < 1e-9);
        assert!((totals.2 - 4338.0).abs() < 1e-9);
        assert!((totals.3 - 2169.0).abs() < 1e-9);

        let projects = vec![sample_project_item(3), sample_project_item(4)];
        let ptotals = project_totals(&projects);
        assert!((ptotals.0 - 420.0).abs() < 1e-9);
        assert!((ptotals.1 - 182.0).abs() < 1e-9);
    }

    #[test]
    fn empty_message_follows_tab_scope() {
        assert!(empty_message(CommissionTab::Detail, "2026-07", "2026").contains("2026-07"));
        assert!(empty_message(CommissionTab::MonthlySummary, "2026-07", "2025").contains("2025"));
    }

    // ---------- 渲染冒烟（亮 / 暗 × 四态 + Tab 切换 + 减弱动态） ----------

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
                cx.add_window_view(|_window, cx| CommissionView::new(cx, dummy_client()));
        }
    }

    #[gpui::test]
    async fn renders_loaded_in_light_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| CommissionView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            let data = sample_data();
            let detail_rows = build_detail_rows(&data.detail_rows, &data.projects);
            let project_rows: Vec<ProjectSummaryRow> = data
                .project_summary
                .iter()
                .map(|item| ProjectSummaryRow::from_item(item, &data.summary_year))
                .collect();
            this.detail_table
                .update(cx, |t, cx| t.set_rows(detail_rows, cx));
            this.monthly_table
                .update(cx, |t, cx| t.set_rows(data.monthly_summary.clone(), cx));
            this.project_table
                .update(cx, |t, cx| t.set_rows(project_rows.clone(), cx));
            this.collection_table
                .update(cx, |t, cx| t.set_rows(project_rows, cx));
            this.state.update(cx, |state, _| {
                *state = CommissionState::Loaded(Box::new(data));
            });
        });
        cx2.read(|app| assert!(!crate::theme::AppTheme::current(app).is_dark()));
    }

    #[gpui::test]
    async fn renders_loaded_tabs_in_dark_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| CommissionView::new(cx, dummy_client()));
        // 四个 Tab 各渲染一次（Loaded 态）
        for tab in CommissionTab::ALL {
            view.update(cx2, |this, cx| {
                this.active_tab = tab;
                let data = sample_data();
                let detail_rows = build_detail_rows(&data.detail_rows, &data.projects);
                let project_rows: Vec<ProjectSummaryRow> = data
                    .project_summary
                    .iter()
                    .map(|item| ProjectSummaryRow::from_item(item, &data.summary_year))
                    .collect();
                this.detail_table
                    .update(cx, |t, cx| t.set_rows(detail_rows, cx));
                this.monthly_table
                    .update(cx, |t, cx| t.set_rows(data.monthly_summary.clone(), cx));
                this.project_table
                    .update(cx, |t, cx| t.set_rows(project_rows.clone(), cx));
                this.collection_table
                    .update(cx, |t, cx| t.set_rows(project_rows, cx));
                this.state.update(cx, |state, _| {
                    *state = CommissionState::Loaded(Box::new(data));
                });
            });
        }
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    #[gpui::test]
    async fn renders_error_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| CommissionView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = CommissionState::Error("服务不可用".into());
            });
        });
    }

    #[gpui::test]
    async fn renders_empty_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| CommissionView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = CommissionState::Empty;
            });
        });
    }

    #[gpui::test]
    async fn renders_loaded_with_reduce_motion(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            cx.set_global(crate::motion::MotionPref(true));
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| CommissionView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            let data = sample_data();
            let project_rows: Vec<ProjectSummaryRow> = data
                .project_summary
                .iter()
                .map(|item| ProjectSummaryRow::from_item(item, &data.summary_year))
                .collect();
            this.project_table
                .update(cx, |t, cx| t.set_rows(project_rows, cx));
            this.state.update(cx, |state, _| {
                *state = CommissionState::Loaded(Box::new(data));
            });
        });
    }

    // ---------- 状态机动作 ----------

    /// 筛选动作：月份 / 汇总年份 / 站点切换即重拉（同值 no-op）；Tab 切换
    /// 零请求（数据全量拉取）
    #[gpui::test]
    async fn filter_actions_reload_and_noop_on_same_value(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| CommissionView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            // 同值 no-op
            let before = this.latest_request_id;
            this.select_tab(CommissionTab::Detail, cx);
            this.select_country(None, cx);
            assert_eq!(this.latest_request_id, before);

            // Tab 切换零请求
            this.select_tab(CommissionTab::MonthlySummary, cx);
            assert_eq!(this.active_tab, CommissionTab::MonthlySummary);
            assert_eq!(this.latest_request_id, before);

            // 切月 → 重拉（YYYY-MM 归一两位月）
            let year_before = year_part(&this.report_month);
            this.select_detail_month(8, cx);
            assert_eq!(this.report_month, format!("{year_before}-08"));
            assert!(this.latest_request_id > before);

            // 切汇总年 → 重拉
            let before2 = this.latest_request_id;
            this.select_summary_year(2025, cx);
            assert_eq!(this.summary_year, "2025");
            assert!(this.latest_request_id > before2);

            // 切站点 → 重拉；同站点 no-op
            let before3 = this.latest_request_id;
            this.select_country(Some("DE"), cx);
            assert_eq!(this.country, Some("DE"));
            assert!(this.latest_request_id > before3);
            let before4 = this.latest_request_id;
            this.select_country(Some("DE"), cx);
            assert_eq!(this.latest_request_id, before4);

            // 切总览年（组合不变时 no-op：同月份数字）
            this.report_month = "2025-03".into();
            let before5 = this.latest_request_id;
            this.select_detail_year(2025, cx);
            assert_eq!(this.latest_request_id, before5);
            this.select_detail_year(2024, cx);
            assert_eq!(this.report_month, "2024-03");
            assert!(this.latest_request_id > before5);
        });
    }

    /// 空态文案随 Tab 范围（月份 / 年份）切换
    #[gpui::test]
    async fn empty_message_tracks_filters(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| CommissionView::new(cx, dummy_client()));
        view.update(cx2, |view, _| {
            view.report_month = "2025-12".into();
            view.summary_year = "2024".into();
            assert!(empty_message(
                CommissionTab::Detail,
                &view.report_month,
                &view.summary_year
            )
            .starts_with("2025-12"));
            assert!(empty_message(
                CommissionTab::ProjectSummary,
                &view.report_month,
                &view.summary_year
            )
            .starts_with("2024"));
        });
    }
}
