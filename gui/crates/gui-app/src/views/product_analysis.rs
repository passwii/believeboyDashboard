//! 报表中心 → 产品分析视图（P5-4，BLF-727）
//!
//! frontend `app/dashboard/reports/product-analysis/`（约 3272 行，3 tab）
//! 的 GPUI 等价——本期只接最常用、零上传的「产品分析核算」tab
//! （`product-analysis-panel.tsx` 约 1109 行）：项目 × 站点 × 起止日期筛选 →
//! 「检查数据」（`calculation/check`）展示可用性栅格 → 「执行核算」
//! （`calculation/run`）展示周期汇总 + 单周期 SKU 明细。
//!
//! 架构（复用 Phase 3/4/5 基建）：
//! - **主状态机四态**：`Loading / Loaded / Empty / Error`（项目列表主数据；
//!   check / run 为筛选栏按钮触发的两个**独立子相位**，各自带竞态保护
//!   `latest_check_request_id` / `latest_run_request_id`）；
//! - **数据管线**：`list_managed_projects`（`GET /projects/manage`，按
//!   X-Operator 过滤可见项目）→ `resolve_project_id` 自动选中第一个项目
//!   （web `useAutoSelectFirstProject` 语义）→ 用户点「检查数据」/「执行核算」
//!   手动触发 POST（对齐 web `handleCheck` / `handleRun`——核算为显式动作，
//!   不随筛选自动执行）；
//! - **筛选语义**：项目 / 站点 / 日期区间变化 → check / run 结果作废回 Idle
//!   （结果与筛选绑定，避免旧筛选的结果误导；web 同款语义靠重新点击检查实现，
//!   GUI 显式作废更直白）；日期区间双端必填（backend 请求模型无默认值，
//!   开区间时两按钮禁用）；
//! - **表格**：P5-0 公共 `DataTable`——按周可用性栅格表（周次 + 业务 / 广告 /
//!   回款覆盖 + 可核算判定）、周期汇总表（周期 + 状态 + 总销售额 / 利润 /
//!   利润率 / ACOS 四指标）、单周期 SKU 明细表（9 列对齐 web
//!   `DETAIL_DISPLAY_COLUMNS`）；
//! - **动效**：Phase 4 `enter_fade_in` + `reduce_motion` 尊重。
//!
//! 与 frontend 的已知差异（有意保留，GPUI 能力边界 / 范围）：
//! - **可用性栅格**：web 是「日期 × 报表类型」的逐日格子矩阵（含周期性兜底
//!   标记）；GUI 改为**按周可用性表**（backend `weekly_availability` 直给）+
//!   三类报表缺失天数汇总行（逐日格子在 GPUI 下信息密度过低）；
//! - **周期明细展开**：web 是点击周期行内联展开明细表；GUI 为周期下拉选择 +
//!   明细表常驻下方（DataTable 无行内展开，对齐 weekly 视图周次选择模式）；
//! - **Excel 导出未接入**（对齐既有 GUI 视图范围边界，后续统一补导出能力）；
//! - **手动核算 / 月度 SKU 分析两 tab**：依赖文件上传 + 识别 + preview，
//!   GPUI 暂无上传基建，拆后续 issue（对齐 research_analysis 导入取舍）；
//! - **空态语义**：项目列表为空 → 页面级空态（「暂无可用项目」）；有项目但
//!   未执行检查 / 核算 → 对应区块不渲染（按钮引导）。

use chrono::{Datelike, NaiveDate};
use gpui::{
    div, prelude::*, px, AnyElement, App, AsyncApp, Context, Entity, FontWeight, Render,
    SharedString, WeakEntity, Window,
};
use gpui_component::{
    button::Button, h_flex, menu::PopupMenuItem, skeleton::Skeleton, v_flex, Disableable, Icon,
    IconName, Sizable,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::operations::product_analysis::{
    CalculationPeriodItem, ProductAnalysisCheckResponse, ProductAnalysisRunResponse,
    WeeklyAvailabilityItem,
};

use crate::theme::AppTheme;
use crate::views::weekly_product_analysis::{
    country_label, format_summary_cell, iso_week_label, resolve_project_id,
};
use crate::widgets::data_table::{CellAlign, ColumnDef, DataTable};
use crate::widgets::date_range::{DateRange, DateRangeEvent, DateRangePickerState};
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::{filter_bar, state_views};

/// 本页在侧栏中的 URL（root.rs 据此路由到本视图；与 gui-domain::sidebar 的
/// 产品分析条目一致）
pub const PRODUCT_ANALYSIS_URL: &str = "/dashboard/reports/product-analysis";

/// 站点选项（backend `_normalize_country` 严格模式只认 US/DE/UK）
const COUNTRY_OPTIONS: [(&str, &str); 3] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
];

/// 默认站点（对齐 frontend `useState<CountryOption>('US')`）
const DEFAULT_COUNTRY: &str = "US";

/// SKU 明细展示列（对齐 web `DETAIL_DISPLAY_COLUMNS`：SKU / ASIN +
/// 7 指标列；格式化走 weekly 视图 `format_summary_cell` 同一口径）
pub const DETAIL_DISPLAY_COLUMNS: [&str; 9] = [
    "SKU", "ASIN", "总销量", "总销售额", "广告花费", "广告销售额", "ACOS", "利润", "利润率",
];

/// 周期汇总展示指标列（对齐 web 周期摘要行 `renderCell(period.summary[...])`
/// 的 4 项：总销售额 / 利润 / 利润率 / ACOS）
pub const PERIOD_SUMMARY_METRIC_COLUMNS: [&str; 4] = ["总销售额", "利润", "利润率", "ACOS"];

// ---------------------------------------------------------------------------
// 默认区间（对齐 web getLastWeekRange）
// ---------------------------------------------------------------------------

/// 默认日期区间（对齐 web `getLastWeekRange`：上一个完整周的周一 ~ 周日，
/// 即本周一向前 7 天 ~ 本周一向前 1 天）
pub fn default_last_week_range(today: NaiveDate) -> DateRange {
    let days_since_monday = today.weekday().num_days_from_monday() as i64;
    let this_monday = today
        .checked_sub_days(chrono::Days::new(days_since_monday as u64))
        .expect("日期回退合法");
    let from = this_monday
        .checked_sub_days(chrono::Days::new(7))
        .expect("日期回退合法");
    let to = this_monday
        .checked_sub_days(chrono::Days::new(1))
        .expect("日期回退合法");
    DateRange::new(Some(from), Some(to))
}

// ---------------------------------------------------------------------------
// 展示文案（缺失汇总 / 周期状态；纯函数便于单测）
// ---------------------------------------------------------------------------

/// 报表缺失汇总行（对齐 web `REPORT_ROWS` 三类报表缺失展示）：
/// 无缺失 → 「{label}：无缺失」；有缺失 → 「{label}：缺失 N 天（日期列表）」，
/// 日期最多列 7 个，超出省略（宽窗可读性）。
pub fn missing_summary_line(label: &str, dates: &[String]) -> String {
    if dates.is_empty() {
        return format!("{label}：无缺失");
    }
    let shown: Vec<&str> = dates.iter().take(7).map(String::as_str).collect();
    let more = dates.len().saturating_sub(7);
    if more > 0 {
        format!("{}：缺失 {} 天（{} 等 {} 天）", label, dates.len(), shown.join("、"), more)
    } else {
        format!("{}：缺失 {} 天（{}）", label, dates.len(), shown.join("、"))
    }
}

/// 周期状态标签（对齐 web 周期摘要行的「已写入PT1」徽章 + `is_partial`
/// 完整性徽章语义）
pub fn period_status_label(period: &CalculationPeriodItem) -> String {
    let mut parts: Vec<String> = Vec::new();
    if period.persisted {
        parts.push("已写入PT1".to_string());
    }
    if period.is_partial {
        let partial = match &period.completeness {
            Some(c) => format!("部分 {}/{}天", c.available_business_days, c.total_days),
            None => "部分".to_string(),
        };
        parts.push(partial);
    }
    if parts.is_empty() {
        "—".to_string()
    } else {
        parts.join(" · ")
    }
}

/// 按周可用性行的周次标签（backend 给 `week_start_date` 字符串；解析成功
/// 补 ISO 周次前缀，失败原样返回——容忍契约漂移）
pub fn availability_week_label(item: &WeeklyAvailabilityItem) -> String {
    match NaiveDate::parse_from_str(&item.week_start_date, "%Y-%m-%d") {
        Ok(start) => format!(
            "{} · {} ~ {}",
            iso_week_label(start),
            item.week_start_date,
            item.week_end_date
        ),
        Err(_) => format!("{} ~ {}", item.week_start_date, item.week_end_date),
    }
}

// ---------------------------------------------------------------------------
// SKU 明细行（details 字典列表展平）
// ---------------------------------------------------------------------------

/// SKU 明细表行（对齐 web `DETAIL_DISPLAY_COLUMNS` 从 `period.details`
/// 字典取数的形态：中文键原始字典 + 派生的 SKU / ASIN 展示字段）
#[derive(Debug, Clone, PartialEq)]
pub struct PeriodDetailRow {
    /// 「SKU」列展示值（details 条目 `SKU` 键；缺失 → 空）
    pub sku: String,
    /// 「ASIN」列展示值（details 条目 `ASIN` 键；缺失 → 空）
    pub asin: String,
    /// 中文键原始字典（7 个指标列按列名取数）
    pub raw: serde_json::Map<String, serde_json::Value>,
}

/// 由 backend 明细字典构建表行（非对象值 → 空行，容忍脏数据）
pub fn build_period_detail_row(value: &serde_json::Value) -> PeriodDetailRow {
    let raw = value.as_object().cloned().unwrap_or_default();
    let sku = raw
        .get("SKU")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let asin = raw
        .get("ASIN")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    PeriodDetailRow { sku, asin, raw }
}

// ---------------------------------------------------------------------------
// 载荷 + 状态机
// ---------------------------------------------------------------------------

/// 一次项目拉取的载荷（apply_result 原子落点）
#[derive(Debug, Clone, PartialEq)]
pub struct ProductAnalysisPayload {
    /// 可见项目列表（筛选菜单数据源）
    pub projects: Vec<ManagedProject>,
    /// 本次实际使用的项目 id（自动选中落点写回用）
    pub resolved_project_id: i64,
}

/// 产品分析主状态机（四态；Empty = 项目列表为空）
///
/// `Loaded` 载荷装箱（`Box`）避免 enum 变体体积差过大（large_enum_variant）。
#[derive(Debug, Clone, PartialEq)]
pub enum ProductAnalysisState {
    Loading,
    Loaded(Box<ProductAnalysisPayload>),
    Empty,
    Error(String),
}

impl ProductAnalysisState {
    /// 拉取结果 → 落点状态（唯一合法的「拉取完成」转移）
    pub fn from_fetch_result(result: Result<ProductAnalysisPayload, String>) -> Self {
        match result {
            Ok(payload) if payload.projects.is_empty() => Self::Empty,
            Ok(payload) => Self::Loaded(Box::new(payload)),
            Err(msg) => Self::Error(msg),
        }
    }
}

/// 检查数据子相位（筛选栏「检查数据」按钮触发）
#[derive(Debug, Clone, PartialEq)]
pub enum CheckPhase {
    /// 未执行（初始 / 筛选变化作废后）
    Idle,
    /// 请求中
    Checking,
    /// 成功（可用性载荷）
    Done(Box<ProductAnalysisCheckResponse>),
    /// 失败（错误文案内联横幅展示）
    Failed(String),
}

/// 执行核算子相位（筛选栏「执行核算」按钮触发）
#[derive(Debug, Clone, PartialEq)]
pub enum RunPhase {
    /// 未执行（初始 / 筛选变化作废后）
    Idle,
    /// 请求中
    Running,
    /// 成功（周期结果载荷）
    Done(Box<ProductAnalysisRunResponse>),
    /// 失败（错误文案内联横幅展示）
    Failed(String),
}

/// 产品分析视图（主四态 + check / run 双子相位 + 竞态保护）
pub struct ProductAnalysisView {
    state: Entity<ProductAnalysisState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表（reload 刷新；筛选菜单数据源）
    projects: Vec<ManagedProject>,
    /// 当前选中项目（web 进入页面自动选第一个）
    selected_project_id: Option<i64>,
    /// 当前站点（"US" / "DE" / "UK"）
    country: &'static str,
    /// 起止日期区间（默认上一个完整周；check / run 双端必填）
    date_range: DateRange,
    /// 日期区间选择器（订阅 Change → 作废结果）
    date_picker: Entity<DateRangePickerState>,
    /// 检查数据子相位
    check_phase: CheckPhase,
    /// 执行核算子相位
    run_phase: RunPhase,
    /// 当前展示明细的周期下标（run Done 后默认 0；对齐 web expandedIndex 语义）
    selected_period_ix: Option<usize>,
    /// 按周可用性表（P5-0 DataTable；check Done 落点时构建）
    availability_table: Option<Entity<DataTable<WeeklyAvailabilityItem>>>,
    /// 周期汇总表（run Done 落点时构建）
    period_table: Option<Entity<DataTable<CalculationPeriodItem>>>,
    /// SKU 明细表（选中周期变化时重建）
    details_table: Option<Entity<DataTable<PeriodDetailRow>>>,
    /// 日期区间选择器事件订阅（必须持有，否则变更不送达）
    _subscriptions: Vec<gpui::Subscription>,
    /// 项目拉取竞态保护
    latest_request_id: u64,
    /// check 请求竞态保护
    latest_check_request_id: u64,
    /// run 请求竞态保护
    latest_run_request_id: u64,
}

impl ProductAnalysisView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| ProductAnalysisState::Loading);
        // 默认上一个完整周（对齐 web 挂载时快照）；订阅日期区间变更
        let today = chrono::Local::now().date_naive();
        let date_range = default_last_week_range(today);
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
            check_phase: CheckPhase::Idle,
            run_phase: RunPhase::Idle,
            selected_period_ix: None,
            availability_table: None,
            period_table: None,
            details_table: None,
            _subscriptions: vec![picker_sub],
            latest_request_id: 0,
            latest_check_request_id: 0,
            latest_run_request_id: 0,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)] // 视图级测试消费（对齐 weekly 视图 current_state 用法）
    pub fn current_state(&self, cx: &App) -> ProductAnalysisState {
        self.state.read(cx).clone()
    }

    /// 重新拉取项目列表：错误重试 / 空态刷新共用入口（竞态保护）。
    /// check / run 结果随之作废（项目集合可能变化）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        self.invalidate_calc_results();

        self.state.update(cx, |state, cx| {
            *state = ProductAnalysisState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(load_projects(&client))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 切换选中项目（同一项目为 no-op）→ 作废 check / run 结果
    pub fn select_project(&mut self, project_id: Option<i64>, cx: &mut Context<Self>) {
        if project_id == self.selected_project_id {
            return;
        }
        self.selected_project_id = project_id;
        self.invalidate_calc_results();
        cx.notify();
    }

    /// 切换站点（同一站点为 no-op）→ 作废 check / run 结果
    pub fn select_country(&mut self, country: &'static str, cx: &mut Context<Self>) {
        if country == self.country {
            return;
        }
        self.country = country;
        self.invalidate_calc_results();
        cx.notify();
    }

    /// 应用日期区间（同一区间 no-op）→ 作废 check / run 结果
    pub fn apply_date_range(&mut self, range: DateRange, cx: &mut Context<Self>) {
        if self.date_range == range {
            return;
        }
        self.date_range = range;
        self.invalidate_calc_results();
        cx.notify();
    }

    /// 作废 check / run 结果（筛选变化后旧结果不再可信；表格实体一并清空，
    /// 下次落点按新 country 重建——货币列币种闭包随 country 变化）
    fn invalidate_calc_results(&mut self) {
        self.check_phase = CheckPhase::Idle;
        self.run_phase = RunPhase::Idle;
        self.selected_period_ix = None;
        self.availability_table = None;
        self.period_table = None;
        self.details_table = None;
    }

    /// 日期区间是否满足 check / run 的双端必填约束（backend 请求模型
    /// `start_date` / `end_date` 无默认值；开区间 → 按钮禁用）
    fn date_range_valid(&self) -> bool {
        match (self.date_range.from, self.date_range.to) {
            (Some(from), Some(to)) => from <= to,
            _ => false,
        }
    }

    /// 检查数据（对齐 web `handleCheck`：check 触发时 run 结果作废）。
    /// 无项目 / 日期非法 → no-op（按钮同条件禁用）。
    pub fn check_data(&mut self, cx: &mut Context<Self>) {
        let Some(project_id) = self.selected_project_id else {
            return;
        };
        if !self.date_range_valid() || matches!(self.check_phase, CheckPhase::Checking) {
            return;
        }
        let (start_date, end_date) = (
            self.date_range.from.expect("date_range_valid 已校验"),
            self.date_range.to.expect("date_range_valid 已校验"),
        );
        let country = self.country;

        self.latest_check_request_id = self.latest_check_request_id.wrapping_add(1);
        let request_id = self.latest_check_request_id;
        self.check_phase = CheckPhase::Checking;
        // web 同口径：新检查前清空核算结果
        self.run_phase = RunPhase::Idle;
        self.selected_period_ix = None;
        self.period_table = None;
        self.details_table = None;
        cx.notify();

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(async move {
                        client
                            .product_analysis_check(project_id, country, start_date, end_date)
                            .await
                            .map_err(|e| e.user_message())
                    })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_check_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 执行核算（对齐 web `handleRun`：`current_only=true`）。
    /// 无项目 / 日期非法 / 核算中 → no-op（按钮同条件禁用）。
    pub fn run_calculation(&mut self, cx: &mut Context<Self>) {
        let Some(project_id) = self.selected_project_id else {
            return;
        };
        if !self.date_range_valid() || matches!(self.run_phase, RunPhase::Running) {
            return;
        }
        let (start_date, end_date) = (
            self.date_range.from.expect("date_range_valid 已校验"),
            self.date_range.to.expect("date_range_valid 已校验"),
        );
        let country = self.country;

        self.latest_run_request_id = self.latest_run_request_id.wrapping_add(1);
        let request_id = self.latest_run_request_id;
        self.run_phase = RunPhase::Running;
        self.selected_period_ix = None;
        self.details_table = None;
        cx.notify();

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(async move {
                        client
                            .product_analysis_run(
                                project_id, country, start_date, end_date, true,
                            )
                            .await
                            .map_err(|e| e.user_message())
                    })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_run_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 切换展示明细的周期（同一下标为 no-op）
    pub fn select_period(&mut self, ix: usize, cx: &mut Context<Self>) {
        if Some(ix) == self.selected_period_ix {
            return;
        }
        self.selected_period_ix = Some(ix);
        self.sync_details_table(cx);
        cx.notify();
    }

    /// 应用项目拉取结果：竞态保护（过期响应丢弃）+ 自动选中落点写回
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<ProductAnalysisPayload, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok(payload) = &result {
            self.projects = payload.projects.clone();
            // 自动选中首个项目的落点写回（web useAutoSelectFirstProject 语义）
            self.selected_project_id = Some(payload.resolved_project_id);
        }
        self.state.update(cx, |state, cx| {
            *state = ProductAnalysisState::from_fetch_result(result);
            cx.notify();
        });
    }

    /// 应用 check 结果：竞态保护 + 按周可用性表构建（有栅格数据时）
    fn apply_check_result(
        &mut self,
        request_id: u64,
        result: Result<ProductAnalysisCheckResponse, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_check_request_id {
            return; // 过期响应，丢弃
        }
        match result {
            Ok(resp) => {
                self.sync_availability_table(&resp, cx);
                self.check_phase = CheckPhase::Done(Box::new(resp));
            }
            Err(msg) => {
                self.availability_table = None;
                self.check_phase = CheckPhase::Failed(msg);
            }
        }
        cx.notify();
    }

    /// 应用 run 结果：竞态保护 + 周期汇总表构建 + 默认选中首周期明细
    fn apply_run_result(
        &mut self,
        request_id: u64,
        result: Result<ProductAnalysisRunResponse, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_run_request_id {
            return; // 过期响应，丢弃
        }
        match result {
            Ok(resp) => {
                self.sync_period_table(&resp, cx);
                // 默认展开第一个周期（对齐 web expandedIndex 初始 null → 用户
                // 点击展开；GUI 明细表常驻，默认选中首周期减少一步操作）
                self.selected_period_ix = if resp.periods.is_empty() { None } else { Some(0) };
                self.run_phase = RunPhase::Done(Box::new(resp));
                self.sync_details_table(cx);
            }
            Err(msg) => {
                self.period_table = None;
                self.details_table = None;
                self.run_phase = RunPhase::Failed(msg);
            }
        }
        cx.notify();
    }

    /// 构建 / 刷新按周可用性表（weekly_availability 为空 → 表置 None，
    /// 视图层走「无按周栅格」兜底文案）
    fn sync_availability_table(
        &mut self,
        resp: &ProductAnalysisCheckResponse,
        cx: &mut Context<Self>,
    ) {
        if resp.weekly_availability.is_empty() {
            self.availability_table = None;
            return;
        }
        let rows = resp.weekly_availability.clone();
        let table = cx.new(|_| {
            DataTable::new("product-analysis-availability-table", availability_columns())
                .striped(true)
                .max_height(320.0)
        });
        table.update(cx, |t, cx| t.set_rows(rows, cx));
        self.availability_table = Some(table);
    }

    /// 构建 / 刷新周期汇总表（country 变化后旧表已随作废清空，此处总是重建）
    fn sync_period_table(
        &mut self,
        resp: &ProductAnalysisRunResponse,
        cx: &mut Context<Self>,
    ) {
        if resp.periods.is_empty() {
            self.period_table = None;
            return;
        }
        let rows = resp.periods.clone();
        let country = self.country;
        let table = cx.new(|_| {
            DataTable::new(
                "product-analysis-period-table",
                period_summary_columns(country),
            )
            .striped(true)
            .max_height(320.0)
        });
        table.update(cx, |t, cx| t.set_rows(rows, cx));
        self.period_table = Some(table);
    }

    /// 构建 / 刷新选中周期的 SKU 明细表（无选中 / 周期无明细 → 表置 None，
    /// 视图层走「无 SKU 明细」兜底文案）
    fn sync_details_table(&mut self, cx: &mut Context<Self>) {
        let period = match &self.run_phase {
            RunPhase::Done(resp) => self
                .selected_period_ix
                .and_then(|ix| resp.periods.get(ix)),
            _ => None,
        };
        let Some(period) = period else {
            self.details_table = None;
            return;
        };
        if period.details.is_empty() {
            self.details_table = None;
            return;
        }
        let rows: Vec<PeriodDetailRow> =
            period.details.iter().map(build_period_detail_row).collect();
        let country = self.country;
        let table = cx.new(|_| {
            DataTable::new("product-analysis-details-table", period_detail_columns(country))
                .striped(true)
                .empty_text("当前周期暂无 SKU 明细")
                .max_height(420.0)
        });
        table.update(cx, |t, cx| t.set_rows(rows, cx));
        self.details_table = Some(table);
    }
}

/// 拉取项目列表（与视图解耦便于测试）。项目列表为空 → 页面级空态由
/// `from_fetch_result` 判定。
async fn load_projects(client: &Client) -> Result<ProductAnalysisPayload, String> {
    let projects = client
        .list_managed_projects()
        .await
        .map_err(|e| e.user_message())?;
    let project_id = resolve_project_id(None, &projects)
        .ok_or_else(|| "暂无可用项目，请先在系统中配置项目。".to_string())?;
    Ok(ProductAnalysisPayload {
        projects,
        resolved_project_id: project_id,
    })
}

impl Render for ProductAnalysisView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        match state {
            ProductAnalysisState::Loading => render_loading(&app_theme).into_any_element(),
            ProductAnalysisState::Error(msg) => {
                render_error(cx, &app_theme, &msg).into_any_element()
            }
            ProductAnalysisState::Empty => render_empty(cx, &app_theme).into_any_element(),
            ProductAnalysisState::Loaded(payload) => {
                let view = cx.entity();
                render_loaded(
                    &view,
                    cx,
                    &app_theme,
                    &payload,
                    self.selected_project_id,
                    self.country,
                    self.date_range,
                    self.date_picker.clone(),
                    self.check_phase.clone(),
                    self.run_phase.clone(),
                    self.selected_period_ix,
                    self.availability_table.clone(),
                    self.period_table.clone(),
                    self.details_table.clone(),
                )
                .into_any_element()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 四态渲染
// ---------------------------------------------------------------------------

/// Loading：Spinner + 筛选骨架 + 卡片骨架（与正式布局同构）
fn render_loading(app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("product-analysis-loading")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::loading_state(app_theme, "加载中…"))
        .child(
            h_flex()
                .gap_3()
                .children((0..4).map(|_| div().w(px(140.)).h_8().child(Skeleton::new()))),
        )
        .child(div().w_full().h_40().child(Skeleton::new()))
}

/// Error：内联 Alert + 重试按钮（Stage 0 `state_views::error_state`）
fn render_error(
    cx: &mut Context<ProductAnalysisView>,
    app_theme: &AppTheme,
    msg: &str,
) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("product-analysis-error")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::error_state(
            &view,
            app_theme,
            "product-analysis-error",
            "产品分析加载失败",
            msg.to_string(),
            |this, cx| this.reload(cx),
        ))
}

/// Empty（项目列表为空）：Icon + 文案 + 刷新按钮（Stage 0
/// `empty_state_with_action`）
fn render_empty(
    cx: &mut Context<ProductAnalysisView>,
    app_theme: &AppTheme,
) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("product-analysis-empty")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::empty_state_with_action(
            &view,
            app_theme,
            "product-analysis-empty",
            "icons/package.svg",
            "暂无可用项目，请先在系统中配置项目",
            "刷新",
            |this, cx| this.reload(cx),
        ))
}

/// Loaded：页面头 + 筛选栏（项目 / 站点 / 日期 / 检查数据 / 执行核算）+
/// 检查失败横幅 + 数据可用性卡 + 核算失败横幅 + 核算结果卡
#[allow(clippy::too_many_arguments)]
fn render_loaded(
    view: &Entity<ProductAnalysisView>,
    cx: &mut Context<ProductAnalysisView>,
    app_theme: &AppTheme,
    payload: &ProductAnalysisPayload,
    selected_project_id: Option<i64>,
    country: &'static str,
    date_range: DateRange,
    date_picker: Entity<DateRangePickerState>,
    check_phase: CheckPhase,
    run_phase: RunPhase,
    selected_period_ix: Option<usize>,
    availability_table: Option<Entity<DataTable<WeeklyAvailabilityItem>>>,
    period_table: Option<Entity<DataTable<CalculationPeriodItem>>>,
    details_table: Option<Entity<DataTable<PeriodDetailRow>>>,
) -> impl IntoElement {
    let reduce = crate::motion::reduce_motion(cx);
    let project_name = payload
        .projects
        .iter()
        .find(|p| Some(p.id) == selected_project_id)
        .map(|p| p.name.clone())
        .unwrap_or_else(|| "--".to_string());
    let range_label = match (date_range.from, date_range.to) {
        (Some(from), Some(to)) => format!("{from} ~ {to}"),
        _ => "未选择日期区间".to_string(),
    };

    crate::motion::enter_fade_in(
        SharedString::from("product-analysis-loaded-fade"),
        v_flex()
            .id("product-analysis-loaded")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            .child(PageHeader::new("产品分析").subtitle(format!(
                "{project_name} · {} · {range_label} · 检查数据可用性并执行核算",
                country_label(country)
            )))
            .child(content_guard().child(render_filter_bar(
                view,
                app_theme,
                &payload.projects,
                selected_project_id,
                country,
                date_picker,
                &check_phase,
                &run_phase,
                date_range,
            )))
            .when(
                matches!(&check_phase, CheckPhase::Failed(_)),
                |this| {
                    let CheckPhase::Failed(msg) = &check_phase else {
                        return this;
                    };
                    this.child(content_guard().child(phase_banner(
                        app_theme,
                        "product-analysis-check-error",
                        &format!("检查数据失败：{msg}"),
                    )))
                },
            )
            .when(matches!(&check_phase, CheckPhase::Done(_)), |this| {
                let CheckPhase::Done(resp) = &check_phase else {
                    return this;
                };
                this.child(content_guard().child(availability_card(
                    app_theme,
                    resp,
                    availability_table,
                )))
            })
            .when(matches!(&run_phase, RunPhase::Failed(_)), |this| {
                let RunPhase::Failed(msg) = &run_phase else {
                    return this;
                };
                this.child(content_guard().child(phase_banner(
                    app_theme,
                    "product-analysis-run-error",
                    &format!("执行核算失败：{msg}"),
                )))
            })
            .when(matches!(&run_phase, RunPhase::Done(_)), |this| {
                let RunPhase::Done(resp) = &run_phase else {
                    return this;
                };
                this.child(results_card(
                    view,
                    app_theme,
                    resp,
                    selected_period_ix,
                    period_table,
                    details_table,
                ))
            }),
        reduce,
    )
}

// ---------------------------------------------------------------------------
// 筛选栏（项目 / 站点 / 日期区间 / 检查数据 / 执行核算）
// ---------------------------------------------------------------------------

/// 筛选栏：项目单选 + 站点 + 日期区间选择器 + 「检查数据」/「执行核算」。
///
/// 按钮禁用口径（对齐 web `canCheck`）：无选中项目 / 日期区间非法（开区间
/// 或起 > 止）/ 对应相位请求中 → 禁用。
#[allow(clippy::too_many_arguments)]
fn render_filter_bar(
    view: &Entity<ProductAnalysisView>,
    app_theme: &AppTheme,
    projects: &[ManagedProject],
    selected_project_id: Option<i64>,
    country: &'static str,
    date_picker: Entity<DateRangePickerState>,
    check_phase: &CheckPhase,
    run_phase: &RunPhase,
    date_range: DateRange,
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
    let date_valid = match (date_range.from, date_range.to) {
        (Some(from), Some(to)) => from <= to,
        _ => false,
    };
    let checking = matches!(check_phase, CheckPhase::Checking);
    let running = matches!(run_phase, RunPhase::Running);
    let can_check = selected_project_id.is_some() && date_valid && !checking;
    let can_run = selected_project_id.is_some() && date_valid && !running;

    let view_for_project = view.clone();
    let view_for_country = view.clone();
    let view_for_check = view.clone();
    let view_for_run = view.clone();

    filter_bar::filter_bar_layout(app_theme)
        .id("product-analysis-filters")
        .child(filter_bar::filter_select(
            app_theme,
            "项目",
            project_label,
            "product-analysis-project-filter",
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
            "站点",
            country_label(country).into(),
            "product-analysis-country-filter",
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
        // 日期区间（DateRangePicker 公共组件；变更经订阅回连作废结果）
        .child(date_picker)
        .child(div().flex_1())
        .child(
            Button::new("product-analysis-check")
                .outline()
                .small()
                .disabled(!can_check)
                .label(if checking { "检查中…" } else { "检查数据" })
                .on_click(move |_, _window, cx| {
                    view_for_check.update(cx, |this, cx| this.check_data(cx));
                }),
        )
        .child(
            Button::new("product-analysis-run")
                .small()
                .disabled(!can_run)
                .label(if running { "核算中…" } else { "执行核算" })
                .on_click(move |_, _window, cx| {
                    view_for_run.update(cx, |this, cx| this.run_calculation(cx));
                }),
        )
}

/// check / run 失败内联横幅（无全局 toast 基建，对齐 weekly 视图
/// recompute_banner 形态）
fn phase_banner(app_theme: &AppTheme, id: &'static str, msg: &str) -> impl IntoElement {
    h_flex()
        .id(id)
        .w_full()
        .gap_2()
        .items_center()
        .px_3()
        .py_2()
        .rounded(px(app_theme.radius))
        .border_1()
        .border_color(app_theme.danger.opacity(0.4))
        .bg(app_theme.danger_soft)
        .child(
            Icon::new(IconName::TriangleAlert)
                .with_size(px(14.))
                .text_color(app_theme.danger),
        )
        .child(
            div()
                .text_xs()
                .text_color(app_theme.danger)
                .child(msg.to_string()),
        )
}

// ---------------------------------------------------------------------------
// 数据可用性卡（check Done）
// ---------------------------------------------------------------------------

/// 数据可用性卡：总体判定（可执行核算 / 数据不足）+ 三类报表缺失汇总 +
/// 回款覆盖情况 + 按周可用性表（对齐 web `AvailabilityGrid` + 判定行的
/// 信息集，逐日格子矩阵简化为按周表——见模块头差异说明）
fn availability_card(
    app_theme: &AppTheme,
    resp: &ProductAnalysisCheckResponse,
    availability_table: Option<Entity<DataTable<WeeklyAvailabilityItem>>>,
) -> impl IntoElement {
    let has_partial_week = resp.weekly_availability.iter().any(|w| w.is_partial);

    let (verdict_icon, verdict_text, verdict_color) = if resp.has_minimum_data {
        (
            IconName::CircleCheck,
            "可执行核算".to_string(),
            app_theme.success,
        )
    } else {
        (
            IconName::CircleX,
            "数据不足，无法执行核算（缺少核心报表数据）".to_string(),
            app_theme.danger,
        )
    };

    v_flex()
        .id("product-analysis-availability-card")
        .w_full()
        .gap_3()
        .p_4()
        .rounded(px(app_theme.radius_lg))
        .bg(app_theme.card_bg)
        .shadow(vec![app_theme.card_shadow_box()])
        .child(
            div()
                .text_base()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(app_theme.text_primary)
                .child("数据可用性"),
        )
        // 总体判定行
        .child(
            h_flex()
                .id("product-analysis-availability-verdict")
                .gap_2()
                .items_center()
                .child(
                    Icon::new(verdict_icon)
                        .with_size(px(16.))
                        .text_color(verdict_color),
                )
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(verdict_color)
                        .child(verdict_text),
                )
                .when(resp.has_minimum_data && has_partial_week, |this| {
                    this.child(
                        h_flex()
                            .gap_1()
                            .items_center()
                            .px_2()
                            .py(px(2.))
                            .rounded(px(app_theme.radius))
                            .bg(app_theme.warning.opacity(0.12))
                            .child(
                                Icon::new(IconName::TriangleAlert)
                                    .with_size(px(12.))
                                    .text_color(app_theme.warning),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(app_theme.warning)
                                    .child("部分周数据不完整"),
                            ),
                    )
                }),
        )
        // 三类报表缺失汇总（对齐 web REPORT_ROWS）
        .child(
            v_flex()
                .id("product-analysis-availability-missing")
                .gap_1()
                .children(
                    [
                        ("业务报告", &resp.business_report_missing),
                        ("广告报告", &resp.ad_report_missing),
                        ("库存报告", &resp.inventory_missing),
                    ]
                    .into_iter()
                    .map(|(label, dates)| {
                        div()
                            .text_xs()
                            .text_color(if dates.is_empty() {
                                app_theme.text_muted
                            } else {
                                app_theme.warning
                            })
                            .child(missing_summary_line(label, dates))
                    }),
                ),
        )
        // 回款覆盖情况
        .child(
            div()
                .id("product-analysis-availability-payment")
                .text_xs()
                .text_color(app_theme.text_muted)
                .child(if resp.payment_full_period_covered {
                    "回款数据：覆盖全周期".to_string()
                } else {
                    format!(
                        "回款数据：未覆盖全周期（单日覆盖 {} 天）",
                        resp.payment_daily_covered_dates.len()
                    )
                }),
        )
        // 按周可用性表（backend weekly_availability 直给）
        .when_some(availability_table, |this, table| {
            this.child(
                div()
                    .id("product-analysis-availability-table-wrap")
                    .w_full()
                    .border_1()
                    .border_color(app_theme.separator)
                    .rounded(px(app_theme.radius))
                    .child(table),
            )
        })
}

// ---------------------------------------------------------------------------
// 核算结果卡（run Done）
// ---------------------------------------------------------------------------

/// 核算结果卡：标题 + 周期数 + 周期下拉选择 + 周期汇总表 + 选中周期
/// 元信息 + SKU 明细表（对齐 web 周期摘要行 + 展开明细表的信息集；
/// 行内展开改为下拉选择——见模块头差异说明）
#[allow(clippy::too_many_arguments)]
fn results_card(
    view: &Entity<ProductAnalysisView>,
    app_theme: &AppTheme,
    resp: &ProductAnalysisRunResponse,
    selected_period_ix: Option<usize>,
    period_table: Option<Entity<DataTable<CalculationPeriodItem>>>,
    details_table: Option<Entity<DataTable<PeriodDetailRow>>>,
) -> impl IntoElement {
    let periods = &resp.periods;
    let selected_period = selected_period_ix.and_then(|ix| periods.get(ix));
    let view_for_period = view.clone();

    let header_right = if periods.len() > 1 {
        // 周期下拉（对齐 web 周期行点击选择的语义；倒序最新在前）
        let period_labels: Vec<(usize, String)> = periods
            .iter()
            .enumerate()
            .map(|(ix, p)| {
                (
                    ix,
                    format!(
                        "{} ~ {}{}",
                        p.report_start_date,
                        p.report_end_date,
                        if p.persisted { " · 已写入PT1" } else { "" }
                    ),
                )
            })
            .collect();
        let current_label: SharedString = selected_period_ix
            .and_then(|ix| period_labels.get(ix))
            .map(|(_, label)| SharedString::from(label.clone()))
            .unwrap_or_else(|| SharedString::from("选择周期"));
        Some(
            filter_bar::filter_select(
                app_theme,
                "周期",
                current_label,
                "product-analysis-period-filter",
                move |menu, _window, _cx| {
                    let mut menu = menu;
                    for (ix, label) in period_labels.iter().rev() {
                        let checked = Some(*ix) == selected_period_ix;
                        let ix = *ix;
                        let label = label.clone();
                        let view_p = view_for_period.clone();
                        menu = menu.item(
                            PopupMenuItem::new(label)
                                .checked(checked)
                                .on_click(move |_, _window, cx| {
                                    view_p.update(cx, |this, cx| this.select_period(ix, cx));
                                }),
                        );
                    }
                    menu
                },
            )
            .into_any_element(),
        )
    } else {
        None
    };

    v_flex()
        .id("product-analysis-results-card")
        .w_full()
        .rounded(px(app_theme.radius_lg))
        .bg(app_theme.card_bg)
        .shadow(vec![app_theme.card_shadow_box()])
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .gap_3()
                .flex_wrap()
                .px_4()
                .py_3()
                .border_b_1()
                .border_color(app_theme.separator)
                .child(
                    v_flex()
                        .gap(px(2.))
                        .child(
                            div()
                                .text_base()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(app_theme.text_primary)
                                .child("核算结果"),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(app_theme.text_muted)
                                .child(format!("共 {} 个周期", periods.len())),
                        ),
                )
                .when_some(header_right, |this, el| this.child(el)),
        )
        .child(match periods.is_empty() {
            true => div()
                .id("product-analysis-results-empty")
                .w_full()
                .flex()
                .items_center()
                .justify_center()
                .py_10()
                .text_sm()
                .text_color(app_theme.text_muted)
                .child("无核算数据")
                .into_any_element(),
            false => v_flex()
                .id("product-analysis-results-body")
                .w_full()
                // 周期汇总表
                .when_some(period_table, |this, table| {
                    this.child(
                        div()
                            .id("product-analysis-period-table-wrap")
                            .w_full()
                            .child(table),
                    )
                })
                // 选中周期元信息 + SKU 明细
                .when_some(selected_period, |this, period| {
                    this.child(period_detail_section(
                        app_theme,
                        period,
                        details_table,
                    ))
                })
                .into_any_element(),
        })
}

/// 选中周期区块：周期范围 + 状态徽章 + SKU 明细表（或「无 SKU 明细」兜底）
fn period_detail_section(
    app_theme: &AppTheme,
    period: &CalculationPeriodItem,
    details_table: Option<Entity<DataTable<PeriodDetailRow>>>,
) -> impl IntoElement {
    v_flex()
        .id("product-analysis-period-detail")
        .w_full()
        .gap_2()
        .border_t_1()
        .border_color(app_theme.separator)
        .px_4()
        .py_3()
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .flex_wrap()
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(app_theme.text_primary)
                        .child(format!(
                            "{} ~ {} · SKU 明细",
                            period.report_start_date, period.report_end_date
                        )),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(app_theme.text_muted)
                        .child(period_status_label(period)),
                ),
        )
        .child(match details_table {
            Some(table) => div()
                .id("product-analysis-details-table-wrap")
                .w_full()
                .child(table)
                .into_any_element(),
            None => div()
                .id("product-analysis-details-empty")
                .w_full()
                .flex()
                .items_center()
                .justify_center()
                .py_6()
                .text_xs()
                .text_color(app_theme.text_muted)
                .child("无 SKU 明细")
                .into_any_element(),
        })
}

// ---------------------------------------------------------------------------
// 表格列定义
// ---------------------------------------------------------------------------

/// 文本单元格（render_element 闭包共用）：返回裸文本元素——与 DataTable
/// 默认 render 路径同形，便于单测对闭包输出 `downcast_mut::<SharedString>`
/// 直接断言渲染文本（对齐 weekly 视图 text_cell 口径）。
fn text_cell(value: String) -> AnyElement {
    SharedString::from(value).into_any_element()
}

/// 按周可用性表列（6 列：周次 + 业务 / 广告可用天数 + 回款覆盖 +
/// 可核算判定 + 完整性）
pub fn availability_columns() -> Vec<ColumnDef<WeeklyAvailabilityItem>> {
    vec![
        ColumnDef::text(
            "pa-avail-week",
            "周次",
            |r: &WeeklyAvailabilityItem, _| SharedString::from(availability_week_label(r)),
        )
        .width(220.0),
        ColumnDef::text(
            "pa-avail-business",
            "业务报告",
            |r: &WeeklyAvailabilityItem, _| {
                SharedString::from(format!(
                    "{}/{} 天",
                    r.business_report_available_days, r.total_days
                ))
            },
        )
        .width(100.0)
        .align(CellAlign::Right),
        ColumnDef::text(
            "pa-avail-ad",
            "广告报告",
            |r: &WeeklyAvailabilityItem, _| {
                SharedString::from(format!(
                    "{}/{} 天",
                    r.ad_report_available_days, r.total_days
                ))
            },
        )
        .width(100.0)
        .align(CellAlign::Right),
        ColumnDef::text(
            "pa-avail-payment",
            "回款",
            |r: &WeeklyAvailabilityItem, _| {
                SharedString::from(if r.payment_covered { "已覆盖" } else { "未覆盖" })
            },
        )
        .width(80.0),
        ColumnDef::text(
            "pa-avail-can",
            "可核算",
            |r: &WeeklyAvailabilityItem, _| {
                SharedString::from(if r.can_calculate { "✓" } else { "✗" })
            },
        )
        .width(70.0),
        ColumnDef::text(
            "pa-avail-partial",
            "完整性",
            |r: &WeeklyAvailabilityItem, _| {
                SharedString::from(if r.is_partial { "部分缺失" } else { "完整" })
            },
        )
        .width(90.0),
    ]
}

/// 周期汇总表列（周期 + 状态 + 4 指标；指标列中文键取数走
/// `format_summary_cell` 口径——货币列币种符号按 country 透传，
/// 对齐 weekly 视图 BLF-723 review P0 契约）。
pub fn period_summary_columns(country: &str) -> Vec<ColumnDef<CalculationPeriodItem>> {
    let country_owned = country.to_string();
    let mut columns: Vec<ColumnDef<CalculationPeriodItem>> = vec![
        ColumnDef::text(
            "pa-period-range",
            "周期",
            |r: &CalculationPeriodItem, _| {
                SharedString::from(format!(
                    "{} ~ {}",
                    r.report_start_date, r.report_end_date
                ))
            },
        )
        .width(200.0),
        ColumnDef::text(
            "pa-period-status",
            "状态",
            |r: &CalculationPeriodItem, _| SharedString::from(period_status_label(r)),
        )
        .width(160.0),
    ];
    for column in PERIOD_SUMMARY_METRIC_COLUMNS {
        let column_owned = column.to_string();
        let country_for_cell = country_owned.clone();
        columns.push(
            ColumnDef::text(
                format!("pa-period-{column}"),
                column,
                |_: &CalculationPeriodItem, _| SharedString::default(),
            )
            .with_render_element(move |r: &CalculationPeriodItem, _theme: &AppTheme| {
                text_cell(format_summary_cell(
                    &column_owned,
                    r.summary.get(&column_owned),
                    &country_for_cell,
                ))
            })
            .width(110.0)
            .align(CellAlign::Right),
        );
    }
    columns
}

/// SKU 明细表列（9 列对齐 web `DETAIL_DISPLAY_COLUMNS`：SKU / ASIN 直取 +
/// 7 指标列中文键取数，格式化走 `format_summary_cell` 同一口径——
/// 货币列币种符号按 country 透传）。
pub fn period_detail_columns(country: &str) -> Vec<ColumnDef<PeriodDetailRow>> {
    let country_owned = country.to_string();
    let mut columns: Vec<ColumnDef<PeriodDetailRow>> = vec![
        ColumnDef::text(
            "pa-detail-sku",
            "SKU",
            |r: &PeriodDetailRow, _| SharedString::from(r.sku.clone()),
        )
        .width(180.0),
        ColumnDef::text(
            "pa-detail-asin",
            "ASIN",
            |r: &PeriodDetailRow, _| SharedString::from(r.asin.clone()),
        )
        .width(140.0),
    ];
    for column in DETAIL_DISPLAY_COLUMNS.iter().skip(2) {
        let column_owned = column.to_string();
        let country_for_cell = country_owned.clone();
        columns.push(
            ColumnDef::text(
                format!("pa-detail-{column}"),
                *column,
                |_: &PeriodDetailRow, _| SharedString::default(),
            )
            .with_render_element(move |r: &PeriodDetailRow, _theme: &AppTheme| {
                text_cell(format_summary_cell(
                    &column_owned,
                    r.raw.get(&column_owned),
                    &country_for_cell,
                ))
            })
            .width(100.0)
            .align(CellAlign::Right),
        );
    }
    columns
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use gui_domain::operations::product_analysis::{
        CalculationPeriodItem, PeriodCompleteness, ProductAnalysisCheckBody,
        ProductAnalysisRunBody, WeeklyAvailabilityItem,
    };

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

    fn sample_payload() -> ProductAnalysisPayload {
        ProductAnalysisPayload {
            projects: sample_projects(),
            resolved_project_id: 1,
        }
    }

    fn week_item(start: &str, end: &str, business_days: i64, can: bool, partial: bool) -> WeeklyAvailabilityItem {
        WeeklyAvailabilityItem {
            iso_year: 2026,
            iso_week: 32,
            week_start_date: start.into(),
            week_end_date: end.into(),
            total_days: 7,
            business_report_available_days: business_days,
            ad_report_available_days: 7,
            business_periodic_covered: false,
            ad_periodic_covered: false,
            payment_covered: true,
            can_calculate: can,
            is_partial: partial,
            business_missing_dates: Vec::new(),
            ad_missing_dates: Vec::new(),
            payment_objective_empty_dates: Vec::new(),
        }
    }

    fn sample_check_response() -> ProductAnalysisCheckResponse {
        ProductAnalysisCheckResponse {
            business_report_missing: vec!["2026-08-03".into()],
            ad_report_missing: Vec::new(),
            inventory_missing: Vec::new(),
            business_period_info: Vec::new(),
            ad_period_info: Vec::new(),
            business_periodic_only_missing: Vec::new(),
            ad_periodic_only_missing: Vec::new(),
            payment_periods_overlapping: Vec::new(),
            payment_full_period_covered: true,
            payment_daily_covered_dates: vec!["2026-08-03".into()],
            payment_objective_empty_dates: Vec::new(),
            has_minimum_data: true,
            weekly_availability: vec![week_item("2026-08-03", "2026-08-09", 6, true, true)],
        }
    }

    fn sample_period(persisted: bool, partial: bool) -> CalculationPeriodItem {
        CalculationPeriodItem {
            report_start_date: "2026-08-03".into(),
            report_end_date: "2026-08-09".into(),
            summary: serde_json::json!({
                "总销售额": 15320.5,
                "利润": 3064.1,
                "利润率": 0.2,
                "ACOS": 0.137
            }),
            details: vec![serde_json::json!({
                "SKU": "SKU-A",
                "ASIN": "B0TEST123",
                "总销量": 120,
                "总销售额": 4560.0,
                "广告花费": 620.5,
                "广告销售额": 2280.0,
                "ACOS": 0.272,
                "利润": 912.0,
                "利润率": 0.2
            })],
            is_partial: partial,
            completeness: if partial {
                Some(PeriodCompleteness {
                    total_days: 7,
                    available_business_days: 6,
                    available_ad_days: 7,
                    business_missing_dates: vec!["2026-08-03".into()],
                    ad_missing_dates: Vec::new(),
                    payment_covered: true,
                    payment_type: "daily".into(),
                    payment_missing: false,
                    payment_missing_dates: Vec::new(),
                    payment_objective_empty: false,
                    payment_objective_empty_dates: Vec::new(),
                })
            } else {
                None
            },
            persisted,
            pt1_id: if persisted { Some(101) } else { None },
            version: if persisted { Some(2) } else { None },
        }
    }

    fn sample_run_response() -> ProductAnalysisRunResponse {
        ProductAnalysisRunResponse {
            project_id: 1,
            project_name: "测试项目 A".into(),
            country: "US".into(),
            total_periods: 2,
            periods: vec![sample_period(true, false), sample_period(false, true)],
        }
    }

    // ---------- 纯函数契约 ----------

    /// 默认区间（对齐 web getLastWeekRange：上一个完整周的周一 ~ 周日）
    #[test]
    fn default_last_week_range_matches_frontend() {
        // 2026-08-19 是周三 → 本周一 2026-08-17 → 上周一 2026-08-10 ~ 上周日 2026-08-16
        let today = NaiveDate::from_ymd_opt(2026, 8, 19).expect("合法日期");
        let range = default_last_week_range(today);
        assert_eq!(
            range.from,
            Some(NaiveDate::from_ymd_opt(2026, 8, 10).expect("合法日期")),
            "起点 = 上周一"
        );
        assert_eq!(
            range.to,
            Some(NaiveDate::from_ymd_opt(2026, 8, 16).expect("合法日期")),
            "终点 = 上周日"
        );
        // 周日当天（JS getDay()=0 分支）：2026-08-16 → 本周一 2026-08-10 → 上周 08-03 ~ 08-09
        let sunday = NaiveDate::from_ymd_opt(2026, 8, 16).expect("合法日期");
        let range = default_last_week_range(sunday);
        assert_eq!(range.from, Some(NaiveDate::from_ymd_opt(2026, 8, 3).expect("合法日期")));
        assert_eq!(range.to, Some(NaiveDate::from_ymd_opt(2026, 8, 9).expect("合法日期")));
        // 周一当天：本周一 = today → 上周 = today-7 ~ today-1
        let monday = NaiveDate::from_ymd_opt(2026, 8, 10).expect("合法日期");
        let range = default_last_week_range(monday);
        assert_eq!(range.from, Some(NaiveDate::from_ymd_opt(2026, 8, 3).expect("合法日期")));
        assert_eq!(range.to, Some(NaiveDate::from_ymd_opt(2026, 8, 9).expect("合法日期")));
    }

    /// 缺失汇总行：无缺失 / ≤7 天全列 / >7 天省略
    #[test]
    fn missing_summary_line_formats() {
        assert_eq!(missing_summary_line("业务报告", &[]), "业务报告：无缺失");
        let two = vec!["2026-08-03".to_string(), "2026-08-04".to_string()];
        assert_eq!(
            missing_summary_line("广告报告", &two),
            "广告报告：缺失 2 天（2026-08-03、2026-08-04）"
        );
        let ten: Vec<String> = (1..=10).map(|d| format!("2026-08-{d:02}")).collect();
        let line = missing_summary_line("库存报告", &ten);
        assert!(line.contains("缺失 10 天"), "应含总天数：{line}");
        assert!(line.contains("等 3 天"), "超出 7 个日期应省略：{line}");
    }

    /// 周期状态标签：已写入PT1 / 部分（含完整性天数）/ 组合 / 空
    #[test]
    fn period_status_label_variants() {
        assert_eq!(period_status_label(&sample_period(true, false)), "已写入PT1");
        assert_eq!(
            period_status_label(&sample_period(false, true)),
            "部分 6/7天"
        );
        assert_eq!(
            period_status_label(&sample_period(true, true)),
            "已写入PT1 · 部分 6/7天"
        );
        let mut bare = sample_period(false, false);
        bare.is_partial = false;
        assert_eq!(period_status_label(&bare), "—");
        // is_partial 但无 completeness → 裸「部分」
        let mut no_completeness = sample_period(false, true);
        no_completeness.completeness = None;
        assert_eq!(period_status_label(&no_completeness), "部分");
    }

    /// 按周可用性周次标签：解析成功补 ISO 周次；失败原样兜底
    #[test]
    fn availability_week_label_formats() {
        let item = week_item("2026-08-03", "2026-08-09", 7, true, false);
        assert_eq!(
            availability_week_label(&item),
            "2026-W32 · 2026-08-03 ~ 2026-08-09"
        );
        let bad = week_item("not-a-date", "2026-08-09", 7, true, false);
        assert_eq!(availability_week_label(&bad), "not-a-date ~ 2026-08-09");
    }

    /// SKU 明细行构建：SKU / ASIN 直取 + 中文键字典保留；非对象 → 空行
    #[test]
    fn build_period_detail_row_extracts_fields() {
        let value = serde_json::json!({
            "SKU": "SKU-A", "ASIN": "B0TEST123", "总销量": 120, "利润率": 0.2
        });
        let row = build_period_detail_row(&value);
        assert_eq!(row.sku, "SKU-A");
        assert_eq!(row.asin, "B0TEST123");
        assert_eq!(row.raw.get("总销量").and_then(|v| v.as_i64()), Some(120));
        // 缺 SKU / ASIN → 空串
        let row = build_period_detail_row(&serde_json::json!({"总销量": 1}));
        assert_eq!(row.sku, "");
        assert_eq!(row.asin, "");
        // 非对象（脏数据）→ 空行不 panic
        let row = build_period_detail_row(&serde_json::json!("garbage"));
        assert_eq!(row.sku, "");
        assert!(row.raw.is_empty());
    }

    /// 列定义契约：可用性表 6 列 / 周期汇总 6 列 / 明细 9 列（对齐 web
    /// DETAIL_DISPLAY_COLUMNS）；id 唯一
    #[test]
    fn column_definitions_match_frontend() {
        let avail = availability_columns();
        assert_eq!(avail.len(), 6);
        assert_eq!(avail[0].id, "pa-avail-week");
        assert_eq!(avail[4].id, "pa-avail-can");

        let summary = period_summary_columns("US");
        assert_eq!(summary.len(), 6);
        assert_eq!(summary[0].id, "pa-period-range");
        assert_eq!(summary[1].id, "pa-period-status");
        assert_eq!(summary[2].id, "pa-period-总销售额");
        assert_eq!(summary[5].id, "pa-period-ACOS");

        let detail = period_detail_columns("US");
        assert_eq!(detail.len(), 9);
        assert_eq!(detail[0].id, "pa-detail-sku");
        assert_eq!(detail[1].id, "pa-detail-asin");
        assert_eq!(detail[2].id, "pa-detail-总销量");
        assert_eq!(detail[8].id, "pa-detail-利润率");

        // id 唯一（gpui element id 要求）
        fn assert_unique_ids<T>(cols: &[ColumnDef<T>]) {
            let ids: Vec<&str> = cols.iter().map(|c| c.id.as_str()).collect();
            let mut uniq = ids.clone();
            uniq.sort();
            uniq.dedup();
            assert_eq!(ids.len(), uniq.len(), "列 id 必须唯一");
        }
        assert_unique_ids(&avail);
        assert_unique_ids(&summary);
        assert_unique_ids(&detail);
    }

    /// 明细 / 汇总列货币格式化按 country 透传（BLF-723 review P0 同类契约）：
    /// 切到 DE/UK 时货币列（总销售额 / 利润 / 广告花费 / 广告销售额）必须
    /// 渲染 € / £ 而非硬编码 $。直接调用列的 `render_element` 闭包，对输出
    /// 元素 `downcast_mut::<SharedString>` 断言渲染文本——若闭包重新硬编码
    /// `"US"`，本测试立即失败。
    #[test]
    fn detail_columns_currency_uses_country_param() {
        let row = build_period_detail_row(&serde_json::json!({
            "SKU": "SKU-A",
            "总销售额": -1234.567,
            "利润": 500.0,
            "总销量": 10,
            "ACOS": 0.25
        }));
        let theme = AppTheme::light();

        fn render_cell(
            cols: &[ColumnDef<PeriodDetailRow>],
            id: &str,
            row: &PeriodDetailRow,
            theme: &AppTheme,
        ) -> String {
            let col = cols
                .iter()
                .find(|c| c.id == id)
                .unwrap_or_else(|| panic!("{id} 列应存在"));
            let renderer = col
                .render_element
                .as_ref()
                .expect("指标列应有 render_element 闭包");
            let mut element = renderer(row, theme);
            element
                .downcast_mut::<SharedString>()
                .map(|s| s.as_str().to_string())
                .expect("text_cell 应输出裸 SharedString 元素")
        }

        // —— US 基线 ——
        let us = period_detail_columns("US");
        assert_eq!(render_cell(&us, "pa-detail-总销售额", &row, &theme), "-$1,234.57");
        assert_eq!(render_cell(&us, "pa-detail-利润", &row, &theme), "$500.00");
        assert_eq!(render_cell(&us, "pa-detail-ACOS", &row, &theme), "25.00%");
        // —— DE：闭包必须用传入的 country 而非硬编码 US ——
        let de = period_detail_columns("DE");
        assert_eq!(render_cell(&de, "pa-detail-总销售额", &row, &theme), "-€1,234.57");
        assert_eq!(render_cell(&de, "pa-detail-利润", &row, &theme), "€500.00");
        // —— UK ——
        let uk = period_detail_columns("UK");
        assert_eq!(render_cell(&uk, "pa-detail-总销售额", &row, &theme), "-£1,234.57");
        assert_eq!(render_cell(&uk, "pa-detail-利润", &row, &theme), "£500.00");
        // 非货币列（整数 / 百分比）不受 country 影响
        assert_eq!(render_cell(&us, "pa-detail-总销量", &row, &theme), "10");
        assert_eq!(render_cell(&de, "pa-detail-总销量", &row, &theme), "10");
    }

    /// 周期汇总列同款 country 透传契约（summary 字典货币列）
    #[test]
    fn period_summary_columns_currency_uses_country_param() {
        let period = sample_period(true, false);
        let theme = AppTheme::light();

        fn render_cell(
            cols: &[ColumnDef<CalculationPeriodItem>],
            id: &str,
            row: &CalculationPeriodItem,
            theme: &AppTheme,
        ) -> String {
            let col = cols
                .iter()
                .find(|c| c.id == id)
                .unwrap_or_else(|| panic!("{id} 列应存在"));
            let renderer = col
                .render_element
                .as_ref()
                .expect("指标列应有 render_element 闭包");
            let mut element = renderer(row, theme);
            element
                .downcast_mut::<SharedString>()
                .map(|s| s.as_str().to_string())
                .expect("text_cell 应输出裸 SharedString 元素")
        }

        let us = period_summary_columns("US");
        assert_eq!(
            render_cell(&us, "pa-period-总销售额", &period, &theme),
            "$15,320.50"
        );
        let de = period_summary_columns("DE");
        assert_eq!(
            render_cell(&de, "pa-period-总销售额", &period, &theme),
            "€15,320.50"
        );
        // 百分比列不受 country 影响
        assert_eq!(render_cell(&us, "pa-period-利润率", &period, &theme), "20.00%");
        assert_eq!(render_cell(&de, "pa-period-利润率", &period, &theme), "20.00%");
    }

    /// 状态转移：项目空 → Empty；有数据 → Loaded；错误 → Error
    #[test]
    fn state_transitions_from_fetch_result() {
        let mut no_projects = sample_payload();
        no_projects.projects = Vec::new();
        assert_eq!(
            ProductAnalysisState::from_fetch_result(Ok(no_projects)),
            ProductAnalysisState::Empty
        );
        assert_eq!(
            ProductAnalysisState::from_fetch_result(Ok(sample_payload())),
            ProductAnalysisState::Loaded(Box::new(sample_payload()))
        );
        assert_eq!(
            ProductAnalysisState::from_fetch_result(Err("boom".into())),
            ProductAnalysisState::Error("boom".into())
        );
    }

    /// 请求体序列化契约：与 backend 请求模型字段名 1:1（防契约漂移）
    #[test]
    fn request_bodies_match_backend_contract() {
        let check = ProductAnalysisCheckBody {
            project_id: 3,
            country: "US".into(),
            start_date: NaiveDate::from_ymd_opt(2026, 8, 3).expect("合法日期"),
            end_date: NaiveDate::from_ymd_opt(2026, 8, 9).expect("合法日期"),
        };
        let value = serde_json::to_value(&check).expect("序列化失败");
        assert_eq!(value["project_id"], 3);
        assert_eq!(value["start_date"], "2026-08-03");

        let run = ProductAnalysisRunBody {
            project_id: 3,
            country: "US".into(),
            start_date: NaiveDate::from_ymd_opt(2026, 8, 3).expect("合法日期"),
            end_date: NaiveDate::from_ymd_opt(2026, 8, 9).expect("合法日期"),
            current_only: true,
        };
        let value = serde_json::to_value(&run).expect("序列化失败");
        assert_eq!(value["current_only"], true);
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
            let mut view = ProductAnalysisView::new(cx, Client::new("http://127.0.0.1:1"));
            view.reload(cx);
            view
        });
    }

    /// 渲染冒烟：深色主题 + Loaded 态 + check Done（注入可用性载荷 +
    /// 按周可用性表，覆盖页面头 / 筛选栏 / 判定行 / 缺失汇总 / 栅格表）
    #[gpui::test]
    async fn view_renders_check_done_in_dark_mode(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            ProductAnalysisView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let resp = sample_check_response();
            this.selected_project_id = Some(1);
            this.projects = sample_projects();
            this.sync_availability_table(&resp, cx);
            this.check_phase = CheckPhase::Done(Box::new(resp));
            this.state.update(cx, |state, _| {
                *state = ProductAnalysisState::Loaded(Box::new(sample_payload()));
            });
        });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    /// 渲染冒烟：Loaded 态 + run Done（注入周期结果 + 汇总表 + 首周期明细表，
    /// 覆盖周期下拉 / 汇总表 / 选中周期区块 / 明细表）
    #[gpui::test]
    async fn view_renders_run_done_with_details(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            ProductAnalysisView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let resp = sample_run_response();
            this.selected_project_id = Some(1);
            this.projects = sample_projects();
            this.sync_period_table(&resp, cx);
            this.selected_period_ix = Some(0);
            this.run_phase = RunPhase::Done(Box::new(resp));
            this.sync_details_table(cx);
            assert!(this.details_table.is_some(), "首周期有明细 → 明细表应构建");
            this.state.update(cx, |state, _| {
                *state = ProductAnalysisState::Loaded(Box::new(sample_payload()));
            });
        });
    }

    /// 渲染冒烟：check / run Failed 横幅可渲染
    #[gpui::test]
    async fn view_renders_failed_banners(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            ProductAnalysisView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            this.selected_project_id = Some(1);
            this.projects = sample_projects();
            this.check_phase = CheckPhase::Failed("检查超时".into());
            this.run_phase = RunPhase::Failed("核算失败".into());
            this.state.update(cx, |state, _| {
                *state = ProductAnalysisState::Loaded(Box::new(sample_payload()));
            });
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
            ProductAnalysisView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            this.selected_project_id = Some(1);
            this.projects = sample_projects();
            this.state.update(cx, |state, _| {
                *state = ProductAnalysisState::Loaded(Box::new(sample_payload()));
            });
        });
    }

    /// 渲染冒烟：空态（无项目 → 「暂无可用项目」+ 刷新按钮）可渲染
    #[gpui::test]
    async fn view_renders_empty_state(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            ProductAnalysisView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = ProductAnalysisState::Empty;
            });
        });
    }

    // ---------- 状态机动作 ----------

    /// 筛选动作：项目 / 站点 / 日期切换作废 check / run 结果（no-op 语义 +
    /// 相位落点）
    #[gpui::test]
    async fn filter_actions_invalidate_results(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            ProductAnalysisView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            // 预置 Done 相位 + 表格
            let resp = sample_run_response();
            this.selected_project_id = Some(1);
            this.projects = sample_projects();
            this.sync_period_table(&resp, cx);
            this.selected_period_ix = Some(0);
            this.run_phase = RunPhase::Done(Box::new(resp));
            this.check_phase = CheckPhase::Done(Box::new(sample_check_response()));
            this.sync_details_table(cx);
            assert!(this.period_table.is_some());
            assert!(this.details_table.is_some());

            // 站点切换 → 全部作废（同一站点为 no-op 不作废）
            this.select_country("DE", cx);
            assert_eq!(this.check_phase, CheckPhase::Idle);
            assert_eq!(this.run_phase, RunPhase::Idle);
            assert_eq!(this.selected_period_ix, None);
            assert!(this.period_table.is_none());
            assert!(this.details_table.is_none());

            // 再次预置后项目切换 / 日期切换同款作废
            this.run_phase = RunPhase::Done(Box::new(sample_run_response()));
            this.select_project(Some(2), cx);
            assert_eq!(this.run_phase, RunPhase::Idle);
            this.run_phase = RunPhase::Done(Box::new(sample_run_response()));
            this.apply_date_range(
                DateRange::new(
                    Some(NaiveDate::from_ymd_opt(2026, 7, 1).expect("合法日期")),
                    Some(NaiveDate::from_ymd_opt(2026, 7, 7).expect("合法日期")),
                ),
                cx,
            );
            assert_eq!(this.run_phase, RunPhase::Idle);
            // 同一区间 no-op
            this.run_phase = RunPhase::Done(Box::new(sample_run_response()));
            this.apply_date_range(
                DateRange::new(
                    Some(NaiveDate::from_ymd_opt(2026, 7, 1).expect("合法日期")),
                    Some(NaiveDate::from_ymd_opt(2026, 7, 7).expect("合法日期")),
                ),
                cx,
            );
            assert!(matches!(this.run_phase, RunPhase::Done(_)));
        });
    }

    /// 周期选择：同一下标 no-op；切换下标重建明细表；越界周期（无明细）→ 表置空
    #[gpui::test]
    async fn select_period_rebuilds_details_table(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            ProductAnalysisView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let mut resp = sample_run_response();
            // 第二周期清空明细（覆盖「无 SKU 明细」兜底路径）
            resp.periods[1].details = Vec::new();
            this.selected_project_id = Some(1);
            this.run_phase = RunPhase::Done(Box::new(resp));
            this.selected_period_ix = Some(0);
            this.sync_details_table(cx);
            assert!(this.details_table.is_some());

            // 同一下标 no-op
            this.select_period(0, cx);
            assert!(this.details_table.is_some());
            // 切换到无明细周期 → 表置 None
            this.select_period(1, cx);
            assert_eq!(this.selected_period_ix, Some(1));
            assert!(this.details_table.is_none());
        });
    }

    /// check / run 守卫：无选中项目 / 日期非法 → no-op（不进入请求中相位）
    #[gpui::test]
    async fn check_run_guard_no_project_or_bad_range(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            ProductAnalysisView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            // 无项目 → no-op
            this.selected_project_id = None;
            this.check_data(cx);
            this.run_calculation(cx);
            assert_eq!(this.check_phase, CheckPhase::Idle);
            assert_eq!(this.run_phase, RunPhase::Idle);

            // 日期开区间 → no-op
            this.selected_project_id = Some(1);
            this.date_range = DateRange::new(None, None);
            this.check_data(cx);
            this.run_calculation(cx);
            assert_eq!(this.check_phase, CheckPhase::Idle);
            assert_eq!(this.run_phase, RunPhase::Idle);

            // 起 > 止 → no-op
            this.date_range = DateRange::new(
                Some(NaiveDate::from_ymd_opt(2026, 8, 9).expect("合法日期")),
                Some(NaiveDate::from_ymd_opt(2026, 8, 3).expect("合法日期")),
            );
            this.check_data(cx);
            assert_eq!(this.check_phase, CheckPhase::Idle);
        });
    }
}
