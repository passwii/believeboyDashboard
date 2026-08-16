//! 运营 → 按周产品分析视图（P5-2，BLF-723）
//!
//! frontend `app/dashboard/operations/weekly-product-analysis/`（约 2707 行）
//! 的 GPUI 等价：项目 × 国家 × 起止日期筛选 + 周度趋势图（7 指标切换）+
//! 3 张合计统计卡（环比）+ 双 tab 明细卡（周汇总 39 列宽表 / 单周 SKU 明细
//! 动态列 + 库存合并 + 合计条）+ 历史周报重算。
//!
//! 架构（复用 Phase 3/4/5 基建）：
//! - **四态状态机**：`Loading / Loaded / Empty / Error`（周汇总主数据；
//!   SKU 明细为 tab 内独立 loading/error/rows 三态），`latest_request_id` /
//!   `latest_details_request_id` 双竞态保护——只有最新请求的响应才会落点；
//! - **数据管线**：`list_managed_projects`（`GET /projects/manage`，按
//!   X-Operator 过滤可见项目）→ `resolve_project_id` 自动选中第一个项目
//!   （web `useAutoSelectFirstProject` 语义）→ `weekly_product_analysis`
//!   （`GET /api/v1/product-analysis/weekly`）；SKU 明细 =
//!   `pt1_details`（`page_size=1000` 循环翻页拉全量）+
//!   `inventory_current_snapshot`（可选；按 SKU 合并「库存」列，无快照置 0）；
//! - **表格**：P5-0 公共 `DataTable`——周汇总表固定 39 列（周次 + 38 指标，
//!   中文键 `summary_row` 按 web `formatSummaryCell` 口径格式化）；SKU 明细表
//!   基础 41 列（日期/SKU + 6 组指标）+ 数据驱动的额外列（列签名变化时重建
//!   表格，否则 `set_rows_if_changed` 幂等注入）；宽表外包横向滚动；
//! - **筛选**：P5-0 `filter_bar`（项目单选 / 国家 US·DE·UK——backend
//!   `_normalize_country` 严格模式）+ `DateRangePickerState`（默认「8 周前的
//!   周一 ~ 上周日」，对齐 web `eightWeeksAgoMonday ~ lastSunday`）；
//! - **动效**：Phase 4 `enter_fade_in` + `reduce_motion` 尊重。
//!
//! 与 frontend 的已知差异（有意保留，GPUI 能力边界 / 范围）：
//! - **趋势图**：web 是 ComposedChart 双 Y 轴 + 7 序列开关（Bar+Line 混合）；
//!   gpui-component chart 无双轴 / 混合图型，改为**单指标下拉切换**的
//!   面积图（7 指标全量保留，对齐 portfolio_overview 的指标选择模式）；
//! - **Excel 导出未接入**（对齐既有 GUI 视图范围边界，后续统一补导出能力）；
//! - **周汇总宽表**：web 有分组表头（销售/推广流量/…）双行表头 + 冻结周次列；
//!   DataTable 为单行表头，分组信息以口径说明卡文案承载；
//! - **合计行 → 表下方合计条**（DataTable 无 footer 支持，对齐
//!   seasonal_replenishment.rs 的合计条口径）；
//! - **重算成功反馈**：web 用 toast；GUI 无全局 toast 基建，成功后直接强制
//!   刷新周汇总（可见反馈），失败在筛选栏下方显示内联错误横幅；
//! - **空态语义**：项目列表为空 → 页面级空态（「暂无可用项目」）；有项目但
//!   该筛选无周数据 → 表格 / 图表内空态（对齐 web「暂无产品分析周汇总数据」）。

use std::collections::HashMap;

use chrono::{Datelike, IsoWeek, NaiveDate};
use gpui::{
    div, prelude::*, px, AnyElement, App, AsyncApp, Context, Entity, FontWeight, Render,
    SharedString, WeakEntity, Window,
};
use gpui_component::{
    button::Button,
    chart::AreaChart,
    h_flex,
    menu::PopupMenuItem,
    skeleton::Skeleton,
    v_flex, Disableable, Icon, IconName, Selectable, Sizable,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::operations::weekly_product_analysis::{
    Pt1DetailRow, WeeklyProductRow,
};

use crate::theme::AppTheme;
use crate::widgets::chart_primitives::chart_area;
use crate::widgets::data_table::{CellAlign, ColumnDef, DataTable};
use crate::widgets::date_range::{DateRange, DateRangeEvent, DateRangePickerState};
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::{filter_bar, state_views};

/// 本页在侧栏中的 URL（root.rs 据此路由到本视图；与 gui-domain::sidebar 的
/// 按周产品分析条目一致）
pub const WEEKLY_PRODUCT_URL: &str = "/dashboard/operations/weekly-product-analysis";

/// 站点选项（backend `_normalize_country` 严格模式只认 US/DE/UK）
const COUNTRY_OPTIONS: [(&str, &str); 3] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
];

/// 默认站点（对齐 frontend `useUrlParam('country', 'US')`）
const DEFAULT_COUNTRY: &str = "US";

/// SKU 明细单页行数（对齐 web `page_size: '1000'`；backend 上限同为 1000）
const DETAILS_PAGE_SIZE: i64 = 1000;

/// 站点展示名（未知值原样返回）
pub fn country_label(country: &str) -> String {
    COUNTRY_OPTIONS
        .iter()
        .find(|(value, _)| *value == country)
        .map_or_else(|| country.to_string(), |(_, label)| label.to_string())
}

/// 币种符号（对齐 web `CURRENCY_SYMBOLS`：US=$ / DE=€ / UK=£，未知 → $）
pub fn currency_symbol(country: &str) -> &'static str {
    match country {
        "DE" => "€",
        "UK" => "£",
        _ => "$",
    }
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
// 周次 / 默认区间（对齐 web getISOWeek / eightWeeksAgoMonday / lastSunday）
// ---------------------------------------------------------------------------

/// ISO 周次标签（对齐 web `getISOWeek`：`YYYY-Www`，如 `2026-W32`）
pub fn iso_week_label(date: NaiveDate) -> String {
    let week: IsoWeek = date.iso_week();
    format!("{}-W{:02}", week.year(), week.week())
}

/// 默认日期区间（对齐 web 挂载时快照：`eightWeeksAgoMonday ~ lastSunday`，
/// 即本周一向前 8 周的周一 ~ 上一个周日）
pub fn default_week_range(today: NaiveDate) -> DateRange {
    let days_since_monday = today.weekday().num_days_from_monday() as i64;
    let this_monday = today
        .checked_sub_days(chrono::Days::new(days_since_monday as u64))
        .expect("日期回退合法");
    let from = this_monday
        .checked_sub_days(chrono::Days::new(56))
        .expect("日期回退合法");
    let to = this_monday
        .checked_sub_days(chrono::Days::new(1))
        .expect("日期回退合法");
    DateRange::new(Some(from), Some(to))
}

// ---------------------------------------------------------------------------
// 中文键指标字典取数 / 格式化（对齐 web toNumber / safeDiv / formatSummaryCell）
// ---------------------------------------------------------------------------

/// 任意 JSON 值 → 数字（对齐 web `toNumber`：数字取有限值，字符串去逗号解析，
/// 其余 → 0）
pub fn to_number(value: Option<&serde_json::Value>) -> f64 {
    match value {
        Some(serde_json::Value::Number(n)) => n.as_f64().filter(|v| v.is_finite()).unwrap_or(0.0),
        Some(serde_json::Value::String(s)) => {
            let normalized: String = s.trim().chars().filter(|c| *c != ',').collect();
            if normalized.is_empty() {
                0.0
            } else {
                match normalized.parse::<f64>() {
                    Ok(v) if v.is_finite() => v,
                    _ => 0.0,
                }
            }
        }
        _ => 0.0,
    }
}

/// 安全除法（对齐 web `safeDiv`：分母为 0 → 0）
pub fn safe_div(numerator: f64, denominator: f64) -> f64 {
    if denominator == 0.0 {
        0.0
    } else {
        numerator / denominator
    }
}

/// 值是否存在（对齐 web `hasValue`：null/undefined/空串 → false）
pub fn has_value(value: Option<&serde_json::Value>) -> bool {
    match value {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::String(s)) => !s.trim().is_empty(),
        Some(_) => true,
    }
}

/// 千分位整数（对齐 web `Math.round(n).toLocaleString('en-US')`）
pub fn fmt_int_thousands(value: f64) -> String {
    let rounded = value.round();
    let negative = rounded < 0.0;
    let int_str = (rounded.abs() as u64).to_string();
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

/// 金额（对齐 web `formatCurrency`：币种符号 + 2 位小数 + 千分位）
pub fn fmt_currency(value: f64, country: &str) -> String {
    let symbol = currency_symbol(country);
    let negative = value < 0.0;
    let abs = value.abs();
    let scaled = (abs * 100.0).round() as u64;
    let int_part = scaled / 100;
    let frac_part = scaled % 100;
    let int_str = int_part.to_string();
    let mut out = String::with_capacity(int_str.len() + int_str.len() / 3 + 4);
    for (i, ch) in int_str.chars().enumerate() {
        if i > 0 && (int_str.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    format!(
        "{}{}{}.{:02}",
        if negative { "-" } else { "" },
        symbol,
        out,
        frac_part
    )
}

/// 通用数字（对齐 web `toLocaleString('en-US', { maximumFractionDigits: 4 })`：
/// 最多 4 位小数，去尾零，千分位）
pub fn fmt_general(value: f64) -> String {
    let scaled = (value.abs() * 10000.0).round() as u64;
    let int_part = scaled / 10000;
    let mut frac_part = scaled % 10000;
    let int_str = fmt_int_thousands(int_part as f64);
    if frac_part == 0 {
        return format!("{}{}", if value < 0.0 { "-" } else { "" }, int_str);
    }
    // 去尾零（如 0.5000 → 0.5）
    let mut width = 4;
    while width > 1 && frac_part.is_multiple_of(10) {
        frac_part /= 10;
        width -= 1;
    }
    format!(
        "{}{}.{:0width$}",
        if value < 0.0 { "-" } else { "" },
        int_str,
        frac_part,
        width = width
    )
}

/// 汇总列格式化（对齐 web `formatSummaryCell`：缺失 → `-`；非数字原样；
/// 百分比列 ×100 + `%`；整数列千分位；货币列币种符号；其余最多 4 位小数）
pub fn format_summary_cell(column: &str, value: Option<&serde_json::Value>, country: &str) -> String {
    if !has_value(value) {
        return "-".to_string();
    }
    let Some(value) = value else {
        return "-".to_string();
    };
    if let serde_json::Value::String(s) = value {
        let normalized: String = s.trim().chars().filter(|c| *c != ',').collect();
        if normalized.parse::<f64>().is_err() {
            return s.clone();
        }
    }
    let numeric = to_number(Some(value));
    if SUMMARY_PERCENT_COLUMNS.contains(&column) {
        return format!("{:.2}%", numeric * 100.0);
    }
    if SUMMARY_INTEGER_COLUMNS.contains(&column) {
        return fmt_int_thousands(numeric);
    }
    if SUMMARY_CURRENCY_COLUMNS.contains(&column) {
        return fmt_currency(numeric, country);
    }
    fmt_general(numeric)
}

// ---------------------------------------------------------------------------
// 列分组 / 列集合（对齐 web SUMMARY_COLUMN_GROUPS / DETAIL_COLUMN_GROUPS）
// ---------------------------------------------------------------------------

/// 周汇总指标分组（5 组 38 列；对齐 web `SUMMARY_COLUMN_GROUPS` 顺序）
pub const SUMMARY_COLUMN_GROUPS: [(&str, &[&str]); 5] = [
    ("销售", &["总销量", "总销售额", "页面浏览量", "总访客", "总转化"]),
    (
        "推广流量",
        &[
            "广告展示量", "广告点击量", "广告点击率", "广告订单量", "广告单占比",
            "广告转化率", "广告花费", "广告销售额", "CPC", "ACOS", "SP占比",
        ],
    ),
    ("自然流量", &["自然流量", "自然流量占比", "自然单", "自然单转化"]),
    (
        "费用占比",
        &[
            "产品FOB", "成本占比", "销售头程", "头程占比", "FBA配送费",
            "配送费占比", "平台佣金", "佣金占比", "总成本", "总成本占比",
        ],
    ),
    (
        "财务结算",
        &[
            "实际销售额", "实际销售量", "实际退款额", "实际退款量",
            "平均售价", "退款率", "利润", "利润率",
        ],
    ),
];

/// 周汇总全部指标列（38 列，展平顺序与 web 一致）
pub fn summary_columns() -> Vec<&'static str> {
    SUMMARY_COLUMN_GROUPS
        .iter()
        .flat_map(|(_, columns)| columns.iter().copied())
        .collect()
}

/// SKU 明细核心列（对齐 web `DETAIL_CORE_COLUMNS`）
pub const DETAIL_CORE_COLUMNS: [&str; 2] = ["日期", "SKU"];

/// SKU 明细指标分组（6 组；对齐 web `DETAIL_COLUMN_GROUPS`：比汇总多「库存」组）
pub const DETAIL_COLUMN_GROUPS: [(&str, &[&str]); 6] = [
    ("销售", &["总销量", "总销售额", "页面浏览量", "总访客", "总转化"]),
    ("库存", &["库存"]),
    (
        "推广流量",
        &[
            "广告展示量", "广告点击量", "广告点击率", "广告订单量", "广告单占比",
            "广告转化率", "广告花费", "广告销售额", "CPC", "ACOS", "SP占比",
        ],
    ),
    ("自然流量", &["自然流量", "自然流量占比", "自然单", "自然单转化"]),
    (
        "费用占比",
        &[
            "产品FOB", "成本占比", "销售头程", "头程占比", "FBA配送费",
            "配送费占比", "平台佣金", "佣金占比", "总成本", "总成本占比",
        ],
    ),
    (
        "财务结算",
        &[
            "实际销售额", "实际销售量", "实际退款额", "实际退款量",
            "平均售价", "退款率", "利润", "利润率",
        ],
    ),
];

/// SKU 明细基础列（核心 2 + 分组 40 = 42；对齐 web `DETAIL_BASE_COLUMNS`）
pub fn detail_base_columns() -> Vec<&'static str> {
    let mut columns: Vec<&'static str> = DETAIL_CORE_COLUMNS.to_vec();
    for (_, group) in DETAIL_COLUMN_GROUPS {
        columns.extend(group.iter().copied());
    }
    columns
}

/// 百分比列（×100 + `%`；对齐 web `SUMMARY_PERCENT_COLUMNS`）
pub const SUMMARY_PERCENT_COLUMNS: [&str; 15] = [
    "总转化", "广告点击率", "广告单占比", "广告转化率", "ACOS", "SP占比",
    "自然流量占比", "自然单转化", "成本占比", "头程占比", "配送费占比",
    "佣金占比", "总成本占比", "利润率", "退款率",
];

/// 货币列（币种符号 + 2 位小数；对齐 web `SUMMARY_CURRENCY_COLUMNS`）
pub const SUMMARY_CURRENCY_COLUMNS: [&str; 13] = [
    "总销售额", "广告花费", "广告销售额", "CPC", "产品FOB", "销售头程",
    "FBA配送费", "平台佣金", "总成本", "利润", "实际销售额", "实际退款额", "平均售价",
];

/// 整数列（千分位取整；对齐 web `SUMMARY_INTEGER_COLUMNS`）
pub const SUMMARY_INTEGER_COLUMNS: [&str; 10] = [
    "总销量", "页面浏览量", "总访客", "广告展示量", "广告点击量", "广告订单量",
    "自然流量", "自然单", "实际销售量", "实际退款量",
];

// ---------------------------------------------------------------------------
// 汇总字典构建（对齐 web buildSummaryForRow / buildSummaryTotals）
// ---------------------------------------------------------------------------

/// 单周汇总字典（对齐 web `buildSummaryForRow`：原始 summary_row 上补齐
/// 5 个回退字段——总销量/总销售额/广告花费/实际销售额/实际销售量）
pub fn build_summary_for_row(row: &WeeklyProductRow) -> serde_json::Map<String, serde_json::Value> {
    let mut summary = row
        .summary_row
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let fallbacks: [(&str, serde_json::Value); 5] = [
        ("总销量", serde_json::json!(row.total_units)),
        ("总销售额", serde_json::json!(row.total_sales)),
        ("广告花费", serde_json::json!(row.total_ad_spend)),
        ("实际销售额", serde_json::json!(row.total_sales)),
        ("实际销售量", serde_json::json!(row.total_units)),
    ];
    for (key, value) in fallbacks {
        if !has_value(summary.get(key)) {
            summary.insert(key.to_string(), value);
        }
    }
    summary
}

/// 多周合计字典（对齐 web `buildSummaryTotals`：38 列求和后按口径重算
/// 17 个比率 / 均值列）
pub fn build_summary_totals(
    rows: &[serde_json::Map<String, serde_json::Value>],
) -> serde_json::Map<String, serde_json::Value> {
    let mut totals: HashMap<&str, f64> = HashMap::new();
    for column in summary_columns() {
        let sum: f64 = rows
            .iter()
            .map(|row| to_number(row.get(column)))
            .sum();
        totals.insert(column, sum);
    }
    let get = |key: &str| totals.get(key).copied().unwrap_or(0.0);
    let ratios: [(&str, f64); 17] = [
        ("总转化", safe_div(get("总销量"), get("页面浏览量"))),
        ("广告点击率", safe_div(get("广告点击量"), get("广告展示量"))),
        ("广告单占比", safe_div(get("广告订单量"), get("总销量"))),
        ("广告转化率", safe_div(get("广告订单量"), get("广告点击量"))),
        ("CPC", safe_div(get("广告花费"), get("广告点击量"))),
        ("ACOS", safe_div(get("广告花费"), get("广告销售额"))),
        ("SP占比", safe_div(get("广告花费"), get("总销售额"))),
        ("自然流量占比", safe_div(get("自然流量"), get("页面浏览量"))),
        ("自然单转化", safe_div(get("自然单"), get("自然流量"))),
        ("成本占比", safe_div(get("产品FOB"), get("实际销售额"))),
        ("头程占比", safe_div(get("销售头程"), get("实际销售额"))),
        ("配送费占比", safe_div(get("FBA配送费"), get("实际销售额"))),
        ("佣金占比", safe_div(get("平台佣金"), get("实际销售额"))),
        ("总成本占比", safe_div(get("总成本"), get("实际销售额"))),
        ("利润率", safe_div(get("利润"), get("实际销售额"))),
        ("平均售价", safe_div(get("实际销售额"), get("实际销售量"))),
        ("退款率", safe_div(get("实际退款额"), get("实际销售额"))),
    ];
    for (key, value) in ratios {
        totals.insert(key, value);
    }
    totals
        .into_iter()
        .map(|(k, v)| (k.to_string(), serde_json::json!(v)))
        .collect()
}

/// 数据不完整标记（对齐 web `extractCompleteness`：summary_row._is_partial）
pub fn is_partial_row(row: &WeeklyProductRow) -> bool {
    row.summary_row
        .as_ref()
        .and_then(|v| v.get("_is_partial"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// 趋势点 / 环比（对齐 web trendPoints / totals / trends）
// ---------------------------------------------------------------------------

/// 周度趋势点（对齐 web `trendPoints` 的 7 个序列值）
#[derive(Debug, Clone, PartialEq)]
pub struct WeeklyTrendPoint {
    /// ISO 周次标签（X 轴）
    pub label: String,
    pub sales_amount: f64,
    pub units_sold: f64,
    pub ad_spend: f64,
    pub ad_clicks: f64,
    pub organic_traffic: f64,
    /// ACOS（%；广告花费 / 广告销售额，分母缺失按 1 兜底——对齐 web）
    pub acos: f64,
    /// 广告点击率（%；点击 / 展示，分母缺失按 1 兜底——对齐 web）
    pub ctr: f64,
}

/// 趋势指标（对齐 web `chartConfig` 的 7 项）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WeeklyTrendMetric {
    SalesAmount,
    UnitsSold,
    AdSpend,
    AdClicks,
    OrganicTraffic,
    Acos,
    Ctr,
}

impl WeeklyTrendMetric {
    /// 全量指标（下拉菜单顺序 = web chartConfig 顺序）
    pub const ALL: [(WeeklyTrendMetric, &'static str); 7] = [
        (WeeklyTrendMetric::SalesAmount, "销售额"),
        (WeeklyTrendMetric::UnitsSold, "销量"),
        (WeeklyTrendMetric::AdSpend, "广告花费"),
        (WeeklyTrendMetric::AdClicks, "广告点击量"),
        (WeeklyTrendMetric::OrganicTraffic, "自然流量"),
        (WeeklyTrendMetric::Acos, "ACOS"),
        (WeeklyTrendMetric::Ctr, "广告点击率"),
    ];

    /// 取点上的序列值
    pub fn value(self, point: &WeeklyTrendPoint) -> f64 {
        match self {
            Self::SalesAmount => point.sales_amount,
            Self::UnitsSold => point.units_sold,
            Self::AdSpend => point.ad_spend,
            Self::AdClicks => point.ad_clicks,
            Self::OrganicTraffic => point.organic_traffic,
            Self::Acos => point.acos,
            Self::Ctr => point.ctr,
        }
    }

    /// 展示格式化（金额 / 百分比 / 整数；对齐 web tooltip formatter 分档）
    pub fn format(self, value: f64, country: &str) -> String {
        match self {
            Self::SalesAmount | Self::AdSpend => fmt_currency(value, country),
            Self::Acos | Self::Ctr => format!("{value:.2}%"),
            _ => fmt_int_thousands(value),
        }
    }
}

/// 周行排序（对齐 web `trendRows`：report_start_date 升序，同日期按 id）
pub fn sort_week_rows(rows: &[WeeklyProductRow]) -> Vec<WeeklyProductRow> {
    let mut sorted = rows.to_vec();
    sorted.sort_by(|a, b| {
        a.report_start_date
            .cmp(&b.report_start_date)
            .then(a.id.cmp(&b.id))
    });
    sorted
}

/// 趋势点序列（对齐 web `trendPoints`：按周排序后逐行取数 / 计算比率）
pub fn trend_points(rows: &[WeeklyProductRow]) -> Vec<WeeklyTrendPoint> {
    sort_week_rows(rows)
        .iter()
        .map(|row| {
            let summary = build_summary_for_row(row);
            let get = |key: &str| to_number(summary.get(key));
            let ad_impressions = {
                let v = get("广告展示量");
                if v == 0.0 { 1.0 } else { v }
            };
            let ad_clicks = get("广告点击量");
            let ad_spend = get("广告花费");
            let ad_sales = {
                let v = get("广告销售额");
                if v == 0.0 { 1.0 } else { v }
            };
            WeeklyTrendPoint {
                label: iso_week_label(row.report_start_date),
                sales_amount: row.total_sales,
                units_sold: row.total_units as f64,
                ad_spend: row.total_ad_spend,
                ad_clicks,
                organic_traffic: get("自然流量"),
                acos: safe_div(ad_spend, ad_sales) * 100.0,
                ctr: safe_div(ad_clicks, ad_impressions) * 100.0,
            }
        })
        .collect()
}

/// 区间合计（对齐 web `totals`：销售额 / 销量 / 广告花费）
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct WeeklyTotals {
    pub sales_amount: f64,
    pub units_sold: i64,
    pub ad_spend: f64,
}

/// 区间合计计算
pub fn weekly_totals(rows: &[WeeklyProductRow]) -> WeeklyTotals {
    rows.iter().fold(WeeklyTotals::default(), |acc, row| WeeklyTotals {
        sales_amount: acc.sales_amount + row.total_sales,
        units_sold: acc.units_sold + row.total_units,
        ad_spend: acc.ad_spend + row.total_ad_spend,
    })
}

/// 环比（对齐 web `trends`：最后一周 vs 上一周的百分比变化；上一周为 0 → 0）
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct WeeklyWoW {
    pub sales: f64,
    pub units: f64,
    pub ad: f64,
}

/// 环比计算（不足 2 周 → 全 0）
pub fn weekly_wow(rows: &[WeeklyProductRow]) -> WeeklyWoW {
    let sorted = sort_week_rows(rows);
    if sorted.len() < 2 {
        return WeeklyWoW::default();
    }
    let last = &sorted[sorted.len() - 1];
    let prev = &sorted[sorted.len() - 2];
    let pct = |cur: f64, pre: f64| if pre != 0.0 { (cur - pre) / pre.abs() * 100.0 } else { 0.0 };
    WeeklyWoW {
        sales: pct(last.total_sales, prev.total_sales),
        units: pct(last.total_units as f64, prev.total_units as f64),
        ad: pct(last.total_ad_spend, prev.total_ad_spend),
    }
}

// ---------------------------------------------------------------------------
// SKU 明细行（raw_row 展平 + 库存合并产物）
// ---------------------------------------------------------------------------

/// SKU 明细表行（对齐 web `buildDetailRow` + 库存合并后的形态：
/// 中文键原始字典 + 派生的日期 / SKU 展示字段）
#[derive(Debug, Clone, PartialEq)]
pub struct DetailTableRow {
    /// 「日期」列展示值（raw_row.日期；缺失 → 空）
    pub date: String,
    /// 「SKU」列展示值（raw_row.SKU；缺失 → 空）
    pub sku: String,
    /// 中文键原始行（含合并后的「库存」）
    pub raw: serde_json::Map<String, serde_json::Value>,
}

/// 由 backend 明细行构建表行（对齐 web `buildDetailRow(raw_row)`）
pub fn build_detail_row(row: &Pt1DetailRow) -> DetailTableRow {
    let raw = row
        .raw_row
        .as_ref()
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let date = raw
        .get("日期")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let sku = raw
        .get("SKU")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    DetailTableRow { date, sku, raw }
}

/// SKU 明细载荷（行 + 库存快照覆盖情况；副标题展示用）
#[derive(Debug, Clone, PartialEq)]
pub struct DetailsPayload {
    pub rows: Vec<DetailTableRow>,
    /// 区间内是否找到库存快照（false → 库存列全 0，对齐 web）
    pub inventory_covered: bool,
}

// ---------------------------------------------------------------------------
// 载荷 + 状态机
// ---------------------------------------------------------------------------

/// 一次拉取的完整载荷（周汇总行 + 筛选菜单数据源；apply_result 原子落点）
#[derive(Debug, Clone, PartialEq)]
pub struct WeeklyPayload {
    /// 可见项目列表（筛选菜单数据源）
    pub projects: Vec<ManagedProject>,
    /// 周度汇总行（backend 原样返回，未排序）
    pub rows: Vec<WeeklyProductRow>,
    /// 本次实际使用的项目 id（自动选中落点写回用）
    pub resolved_project_id: i64,
}

/// 按周产品分析状态机（四态；Empty = 项目列表为空，Loaded 内表格另有空态文案）
///
/// `Loaded` 载荷装箱（`Box`）避免 enum 变体体积差过大（large_enum_variant）。
#[derive(Debug, Clone, PartialEq)]
pub enum WeeklyState {
    Loading,
    Loaded(Box<WeeklyPayload>),
    Empty,
    Error(String),
}

impl WeeklyState {
    /// 拉取结果 → 落点状态（唯一合法的「拉取完成」转移）
    pub fn from_fetch_result(result: Result<WeeklyPayload, String>) -> Self {
        match result {
            Ok(payload) if payload.projects.is_empty() => Self::Empty,
            Ok(payload) => Self::Loaded(Box::new(payload)),
            Err(msg) => Self::Error(msg),
        }
    }
}

/// 明细 tab 页签（对齐 web `WeeklyViewTab`）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WeeklyTab {
    Summary,
    Details,
}

/// 按周产品分析视图（四态状态机 + 项目/国家/日期筛选 + 双 tab + 竞态保护）
pub struct WeeklyProductAnalysisView {
    state: Entity<WeeklyState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表（reload 刷新；筛选菜单数据源）
    projects: Vec<ManagedProject>,
    /// 当前选中项目（web 进入页面自动选第一个）
    selected_project_id: Option<i64>,
    /// 当前站点（"US" / "DE" / "UK"）
    country: &'static str,
    /// 起止日期区间（默认「8 周前的周一 ~ 上周日」）
    date_range: DateRange,
    /// 日期区间选择器（订阅 Change → reload）
    date_picker: Entity<DateRangePickerState>,
    /// 当前 tab（周汇总 / SKU明细）
    active_tab: WeeklyTab,
    /// 趋势图当前指标（web 是 7 序列开关；GUI 为单指标下拉，见模块头差异说明）
    trend_metric: WeeklyTrendMetric,
    /// SKU 明细：选中周次 id（默认最新周；对齐 web selectedWeekId 落点）
    selected_week_id: Option<i64>,
    /// SKU 明细加载态
    details_loading: bool,
    /// SKU 明细错误（None = 无错误）
    details_error: Option<String>,
    /// SKU 明细载荷（行 + 库存覆盖情况）
    details: Option<DetailsPayload>,
    /// 明细表（P5-0 DataTable；额外列签名变化时重建）
    details_table: Option<Entity<DataTable<DetailTableRow>>>,
    /// 当前明细表额外列签名（判断是否需重建表格）
    details_extra_signature: Vec<String>,
    /// 周汇总宽表（P5-0 DataTable；固定 39 列，国家变化时重建——币种格式）
    summary_table: Option<Entity<DataTable<WeeklyProductRow>>>,
    /// 当前周汇总表对应的国家（判断是否需重建）
    summary_table_country: &'static str,
    /// 重算进行中（按钮禁用态）
    recomputing: bool,
    /// 重算失败提示（筛选栏下方内联横幅；成功走强制刷新，无 toast 基建）
    recompute_error: Option<String>,
    /// 日期区间选择器事件订阅（必须持有，否则变更不送达）
    _subscriptions: Vec<gpui::Subscription>,
    /// 周汇总请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,
    /// SKU 明细请求竞态保护（独立于周汇总）
    latest_details_request_id: u64,
}

impl WeeklyProductAnalysisView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| WeeklyState::Loading);
        // 默认「8 周前的周一 ~ 上周日」（对齐 web 挂载时快照）；订阅日期区间变更
        let today = chrono::Local::now().date_naive();
        let date_range = default_week_range(today);
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
            active_tab: WeeklyTab::Summary,
            trend_metric: WeeklyTrendMetric::SalesAmount,
            selected_week_id: None,
            details_loading: false,
            details_error: None,
            details: None,
            details_table: None,
            details_extra_signature: Vec::new(),
            summary_table: None,
            summary_table_country: DEFAULT_COUNTRY,
            recomputing: false,
            recompute_error: None,
            _subscriptions: vec![picker_sub],
            latest_request_id: 0,
            latest_details_request_id: 0,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)] // 视图级测试消费（对齐 dashboard.rs current_state 用法）
    pub fn current_state(&self, cx: &App) -> WeeklyState {
        self.state.read(cx).clone()
    }

    /// 重新拉取周汇总：项目/国家/日期切换、错误重试、空态刷新共用入口
    /// （竞态保护；每次调用递增 `latest_request_id` 并进入 Loading）。
    /// 明细缓存随之失效（周次集合变化后旧明细不再可信）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let selected = self.selected_project_id;
        let country = self.country;
        let (start_date, end_date) = (self.date_range.from, self.date_range.to);
        self.recompute_error = None;
        // 明细缓存失效（新周汇总落点前保留旧展示，避免闪烁；落点后按新周次重置）
        self.details = None;
        self.details_error = None;

        self.state.update(cx, |state, cx| {
            *state = WeeklyState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(load_weekly(
                        &client,
                        selected,
                        country,
                        start_date,
                        end_date,
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

    /// 切换 tab（同一 tab 为 no-op）；切到 SKU 明细且无缓存 → 触发拉取
    pub fn switch_tab(&mut self, tab: WeeklyTab, cx: &mut Context<Self>) {
        if tab == self.active_tab {
            return;
        }
        self.active_tab = tab;
        if tab == WeeklyTab::Details && self.details.is_none() && self.details_error.is_none() {
            self.load_details(cx);
        }
        cx.notify();
    }

    /// 切换趋势指标（同一指标为 no-op；纯前端重绘，不拉数据）
    pub fn select_trend_metric(&mut self, metric: WeeklyTrendMetric, cx: &mut Context<Self>) {
        if metric == self.trend_metric {
            return;
        }
        self.trend_metric = metric;
        cx.notify();
    }

    /// 切换选中周次 → 重新拉取该周 SKU 明细（同一周次为 no-op）
    pub fn select_week(&mut self, week_id: i64, cx: &mut Context<Self>) {
        if Some(week_id) == self.selected_week_id {
            return;
        }
        self.selected_week_id = Some(week_id);
        self.load_details(cx);
    }

    /// 拉取 SKU 明细（选中周次；未选时取最新周）。竞态保护独立于周汇总。
    pub fn load_details(&mut self, cx: &mut Context<Self>) {
        let Some(project_id) = self.selected_project_id else {
            return;
        };
        let Some(week_id) = self.effective_week_id(cx) else {
            return;
        };
        self.selected_week_id = Some(week_id);
        self.latest_details_request_id = self.latest_details_request_id.wrapping_add(1);
        let request_id = self.latest_details_request_id;
        let country = self.country;

        self.details_loading = true;
        self.details_error = None;
        cx.notify();

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(load_details(
                        &client, project_id, country, week_id,
                    ))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_details_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 历史周报重算（对齐 web `handleRecomputeHistory`：POST → 成功后强制
    /// 刷新周汇总；失败在筛选栏下方显示内联错误横幅）
    pub fn recompute_history(&mut self, cx: &mut Context<Self>) {
        if self.recomputing {
            return;
        }
        let Some(project_id) = self.selected_project_id else {
            return;
        };
        let country = self.country;
        let (start_date, end_date) = (self.date_range.from, self.date_range.to);
        self.recomputing = true;
        self.recompute_error = None;
        cx.notify();

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(async move {
                        client
                            .weekly_recompute(project_id, country, start_date, end_date)
                            .await
                            .map_err(|e| e.user_message())
                    })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.recomputing = false;
                match result {
                    Ok(_) => {
                        // 成功：强制刷新周汇总（web 同口径：清缓存 + force reload）
                        this.reload(cx);
                    }
                    Err(msg) => {
                        this.recompute_error = Some(msg);
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    /// 当前有效周次 id：显式选中（仍在周集合内）优先，否则最新周
    /// （对齐 web selectedWeekId 的 useEffect 落点语义）
    fn effective_week_id(&self, cx: &App) -> Option<i64> {
        let rows = self.current_week_rows(cx);
        if rows.is_empty() {
            return None;
        }
        if let Some(id) = self.selected_week_id {
            if rows.iter().any(|r| r.id == id) {
                return Some(id);
            }
        }
        rows.last().map(|r| r.id)
    }

    /// 当前 Loaded 态的周行（排序后；非 Loaded → 空）
    fn current_week_rows(&self, cx: &App) -> Vec<WeeklyProductRow> {
        match self.state.read(cx) {
            WeeklyState::Loaded(payload) => sort_week_rows(&payload.rows),
            _ => Vec::new(),
        }
    }

    /// 应用周汇总拉取结果：竞态保护（过期响应丢弃）+ Loaded 落点前同步
    /// 筛选数据源与选中周次（周集合变化 → 明细缓存失效重置到最新周）。
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<WeeklyPayload, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok(payload) = &result {
            self.projects = payload.projects.clone();
            // 自动选中首个项目的落点写回（web useAutoSelectFirstProject 语义）
            self.selected_project_id = Some(payload.resolved_project_id);
            // 选中周次对齐新周集合：旧选中仍在 → 保留；否则最新周
            let sorted = sort_week_rows(&payload.rows);
            let still_valid = self
                .selected_week_id
                .is_some_and(|id| sorted.iter().any(|r| r.id == id));
            if !still_valid {
                self.selected_week_id = sorted.last().map(|r| r.id);
            }
            // 明细缓存失效（周集合 / 筛选已变化）
            self.details = None;
            self.details_error = None;
            self.details_table = None;
            self.details_extra_signature.clear();
            // 周汇总宽表幂等同步（国家变化 → 重建；否则只注入行）
            self.sync_summary_table(&sorted, cx);
            // 明细 tab 激活时立即拉取新周次明细（对齐 web useEffect）；
            // 先落点状态再拉取（load_details 内部读取 Loaded 态的周集合）
            let need_details =
                self.active_tab == WeeklyTab::Details && self.selected_week_id.is_some();
            self.state.update(cx, |state, cx| {
                *state = WeeklyState::from_fetch_result(result.clone());
                cx.notify();
            });
            if need_details {
                self.load_details(cx);
            }
            return;
        }
        self.state.update(cx, |state, cx| {
            *state = WeeklyState::from_fetch_result(result);
            cx.notify();
        });
    }

    /// 应用 SKU 明细拉取结果：竞态保护 + 幂等注入明细表（额外列签名变化 → 重建）
    fn apply_details_result(
        &mut self,
        request_id: u64,
        result: Result<DetailsPayload, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_details_request_id {
            return; // 过期响应，丢弃
        }
        self.details_loading = false;
        match result {
            Ok(payload) => {
                self.sync_details_table(&payload, cx);
                self.details = Some(payload);
                self.details_error = None;
            }
            Err(msg) => {
                self.details_error = Some(msg);
            }
        }
        cx.notify();
    }

    /// 幂等注入周汇总宽表：国家变化（币种格式）或首建 → 重建 DataTable；
    /// 否则 `set_rows_if_changed` 只注入行（最新周在最上，倒序展示）。
    fn sync_summary_table(&mut self, sorted_rows: &[WeeklyProductRow], cx: &mut Context<Self>) {
        let mut rows = sorted_rows.to_vec();
        rows.reverse();
        if self.summary_table.is_some() && self.summary_table_country == self.country {
            if let Some(table) = &self.summary_table {
                table.update(cx, |t, cx| t.set_rows_if_changed(&rows, cx));
            }
            return;
        }
        let columns = summary_table_columns(self.country);
        let table = cx.new(|_| {
            DataTable::new("weekly-product-summary-table", columns)
                .striped(true)
                .max_height(460.0)
        });
        table.update(cx, |t, cx| t.set_rows(rows, cx));
        self.summary_table = Some(table);
        self.summary_table_country = self.country;
    }

    /// 幂等注入明细表：额外列签名变化（或首建）→ 重建 DataTable；
    /// 否则 `set_rows_if_changed` 只注入行。
    fn sync_details_table(&mut self, payload: &DetailsPayload, cx: &mut Context<Self>) {
        let extra = detail_extra_columns(&payload.rows);
        if self.details_extra_signature == extra && self.details_table.is_some() {
            if let Some(table) = &self.details_table {
                let rows = payload.rows.clone();
                table.update(cx, |t, cx| t.set_rows_if_changed(&rows, cx));
            }
            return;
        }
        let columns = detail_columns(self.country, &extra);
        let rows = payload.rows.clone();
        let table = cx.new(|_| {
            DataTable::new("weekly-product-details-table", columns)
                .striped(true)
                .empty_text("当前周次暂无 SKU明细 数据")
                .max_height(520.0)
        });
        table.update(cx, |t, cx| t.set_rows(rows, cx));
        self.details_table = Some(table);
        self.details_extra_signature = extra;
    }
}

/// 拉取周汇总数据（项目列表 + 周度分析），与视图解耦便于测试。
///
/// 对齐 frontend `loadWeeklyData`：
/// - 项目列表为空 → Err（「暂无可用项目」，页面空态由 `from_fetch_result` 判定）；
/// - 未显式选项目 → 自动选第一个（`resolve_project_id`）；
/// - 日期区间双端可选（None = 不携带，backend 不过滤）。
async fn load_weekly(
    client: &Client,
    selected_project_id: Option<i64>,
    country: &str,
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
) -> Result<WeeklyPayload, String> {
    let projects = client
        .list_managed_projects()
        .await
        .map_err(|e| e.user_message())?;
    let project_id = resolve_project_id(selected_project_id, &projects)
        .ok_or_else(|| "暂无可用项目，请先在系统中配置项目。".to_string())?;
    let rows = client
        .weekly_product_analysis(project_id, country, start_date, end_date)
        .await
        .map_err(|e| e.user_message())?;
    Ok(WeeklyPayload {
        projects,
        rows,
        resolved_project_id: project_id,
    })
}

/// 拉取单周 SKU 明细（`page_size=1000` 循环翻页拉全量）+ 可选库存快照合并。
///
/// 对齐 frontend `loadWeeklyDetails`：
/// - 翻页直到 `has_next=false`（backend 上限 1000/页）；
/// - 首页回显 `report_start_date` / `report_end_date` 作为库存快照查询窗口；
/// - 库存快照可选：请求失败 / 无快照 → 「库存」列全 0（web 同口径）；
///   有快照 → 按 SKU（小写）合并 `available_qty`。
async fn load_details(
    client: &Client,
    project_id: i64,
    country: &str,
    week_id: i64,
) -> Result<DetailsPayload, String> {
    let mut merged: Vec<DetailTableRow> = Vec::new();
    let mut period_start: Option<NaiveDate> = None;
    let mut period_end: Option<NaiveDate> = None;
    let mut page = 1i64;
    loop {
        let resp = client
            .pt1_details(week_id, country, page, DETAILS_PAGE_SIZE)
            .await
            .map_err(|e| e.user_message())?;
        if page == 1 {
            period_start = Some(resp.report_start_date);
            period_end = Some(resp.report_end_date);
        }
        merged.extend(resp.rows.iter().map(build_detail_row));
        if !resp.has_next {
            break;
        }
        page += 1;
    }

    // 库存快照合并（可选；失败 / 无快照 → 库存列全 0）
    let mut inventory_covered = false;
    if let (Some(start), Some(end)) = (period_start, period_end) {
        if let Ok(snapshot) = client
            .inventory_current_snapshot(project_id, country, start, end)
            .await
        {
            if !snapshot.rows.is_empty() {
                inventory_covered = true;
            }
            let mut sku_map: HashMap<String, f64> = HashMap::new();
            for inv in &snapshot.rows {
                if let Some(sku) = inv.sku.as_deref() {
                    if !sku.is_empty() {
                        sku_map.insert(sku.to_lowercase(), inv.available_qty.unwrap_or(0.0));
                    }
                }
            }
            for row in &mut merged {
                let qty = sku_map.get(&row.sku.to_lowercase()).copied().unwrap_or(0.0);
                row.raw.insert("库存".to_string(), serde_json::json!(qty));
            }
        }
    }
    if !inventory_covered {
        for row in &mut merged {
            row.raw.insert("库存".to_string(), serde_json::json!(0));
        }
    }

    Ok(DetailsPayload {
        rows: merged,
        inventory_covered,
    })
}

/// 明细表额外列（对齐 web `detailColumns`：raw_row 中基础列之外、非 ASIN 的
/// 键，按首次出现顺序；列签名 = 额外列名序列）
pub fn detail_extra_columns(rows: &[DetailTableRow]) -> Vec<String> {
    let base: std::collections::HashSet<&str> =
        detail_base_columns().into_iter().collect();
    let mut extra: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in rows {
        for key in row.raw.keys() {
            if key == "ASIN" || base.contains(key.as_str()) || seen.contains(key) {
                continue;
            }
            seen.insert(key.clone());
            extra.push(key.clone());
        }
    }
    extra
}

impl Render for WeeklyProductAnalysisView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        match state {
            WeeklyState::Loading => render_loading(&app_theme).into_any_element(),
            WeeklyState::Error(msg) => render_error(cx, &app_theme, &msg).into_any_element(),
            WeeklyState::Empty => render_empty(cx, &app_theme).into_any_element(),
            WeeklyState::Loaded(payload) => {
                let view = cx.entity();
                render_loaded(
                    &view,
                    cx,
                    &app_theme,
                    &payload,
                    self.selected_project_id,
                    self.country,
                    self.date_picker.clone(),
                    self.active_tab,
                    self.trend_metric,
                    self.selected_week_id,
                    self.details_loading,
                    self.details_error.clone(),
                    self.details.clone(),
                    self.details_table.clone(),
                    self.summary_table.clone(),
                    self.recomputing,
                    self.recompute_error.clone(),
                )
                .into_any_element()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 四态渲染
// ---------------------------------------------------------------------------

/// Loading：Spinner + 筛选骨架 + 统计卡骨架 + 图表/表格骨架（与正式布局同构）
fn render_loading(app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("weekly-product-loading")
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
        .child(
            h_flex()
                .gap_3()
                .children((0..3).map(|_| {
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
    cx: &mut Context<WeeklyProductAnalysisView>,
    app_theme: &AppTheme,
    msg: &str,
) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("weekly-product-error")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::error_state(
            &view,
            app_theme,
            "weekly-product-error",
            "按周产品分析加载失败",
            msg.to_string(),
            |this, cx| this.reload(cx),
        ))
}

/// Empty（项目列表为空）：Icon + 文案 + 刷新按钮（Stage 0
/// `empty_state_with_action`）
fn render_empty(
    cx: &mut Context<WeeklyProductAnalysisView>,
    app_theme: &AppTheme,
) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("weekly-product-empty")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::empty_state_with_action(
            &view,
            app_theme,
            "weekly-product-empty",
            "icons/package.svg",
            "暂无可用项目，请先在系统中配置项目",
            "刷新",
            |this, cx| this.reload(cx),
        ))
}

/// Loaded：页面头 + 筛选栏（含重算错误横幅）+ 统计卡 + 趋势卡 + 明细卡（双 tab）
#[allow(clippy::too_many_arguments)]
fn render_loaded(
    view: &Entity<WeeklyProductAnalysisView>,
    cx: &mut Context<WeeklyProductAnalysisView>,
    app_theme: &AppTheme,
    payload: &WeeklyPayload,
    selected_project_id: Option<i64>,
    country: &'static str,
    date_picker: Entity<DateRangePickerState>,
    active_tab: WeeklyTab,
    trend_metric: WeeklyTrendMetric,
    selected_week_id: Option<i64>,
    details_loading: bool,
    details_error: Option<String>,
    details: Option<DetailsPayload>,
    details_table: Option<Entity<DataTable<DetailTableRow>>>,
    summary_table: Option<Entity<DataTable<WeeklyProductRow>>>,
    recomputing: bool,
    recompute_error: Option<String>,
) -> impl IntoElement {
    let reduce = crate::motion::reduce_motion(cx);
    let project_name = payload
        .projects
        .iter()
        .find(|p| Some(p.id) == selected_project_id)
        .map(|p| p.name.clone())
        .unwrap_or_else(|| "--".to_string());
    let sorted_rows = sort_week_rows(&payload.rows);
    let totals = weekly_totals(&payload.rows);
    let wow = weekly_wow(&payload.rows);
    let range_label = format_range_label(&sorted_rows);

    crate::motion::enter_fade_in(
        SharedString::from("weekly-product-loaded-fade"),
        v_flex()
            .id("weekly-product-loaded")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            .child(PageHeader::new("按周产品分析").subtitle(format!(
                "{} · {} · {} · 按周聚合销售 / 广告 / 库存表现",
                project_name,
                country_label(country),
                range_label
            )))
            .child(content_guard().child(render_filter_bar(
                view,
                app_theme,
                &payload.projects,
                selected_project_id,
                country,
                date_picker,
                recomputing,
            )))
            .when_some(recompute_error, |this, msg| {
                this.child(content_guard().child(recompute_banner(app_theme, &msg)))
            })
            .child(content_guard().child(stat_band(app_theme, country, &totals, &wow)))
            .child(trend_card(
                view,
                app_theme,
                country,
                &sorted_rows,
                trend_metric,
            ))
            .child(details_card(
                view,
                app_theme,
                country,
                &sorted_rows,
                active_tab,
                selected_week_id,
                details_loading,
                details_error,
                details,
                details_table,
                summary_table,
            )),
        reduce,
    )
}

/// 区间展示文案（有数据 → 首周起 ~ 末周止；无数据 → 占位）
fn format_range_label(sorted_rows: &[WeeklyProductRow]) -> String {
    match (sorted_rows.first(), sorted_rows.last()) {
        (Some(first), Some(last)) => {
            format!("{} ~ {}", first.report_start_date, last.report_end_date)
        }
        _ => "暂无周数据".to_string(),
    }
}

/// 重算失败内联横幅（无全局 toast 基建；成功走强制刷新）
fn recompute_banner(app_theme: &AppTheme, msg: &str) -> impl IntoElement {
    h_flex()
        .id("weekly-product-recompute-error")
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
                .child(format!("历史周报重算失败：{msg}")),
        )
}

// ---------------------------------------------------------------------------
// 筛选栏（项目 / 国家 / 日期区间 / 刷新 / 重新核算）
// ---------------------------------------------------------------------------

/// 筛选栏：项目单选 + 国家站点 + 日期区间选择器 + 刷新 + 重新核算。
///
/// 菜单 builder 是 `Fn + 'static`（每次打开菜单重新执行）→ 项目选项必须转
/// owned 才能被 move 捕获；选中项 label 在 builder 外算一次。
fn render_filter_bar(
    view: &Entity<WeeklyProductAnalysisView>,
    app_theme: &AppTheme,
    projects: &[ManagedProject],
    selected_project_id: Option<i64>,
    country: &'static str,
    date_picker: Entity<DateRangePickerState>,
    recomputing: bool,
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
    let view_for_refresh = view.clone();
    let view_for_recompute = view.clone();

    filter_bar::filter_bar_layout(app_theme)
        .id("weekly-product-filters")
        .child(filter_bar::filter_select(
            app_theme,
            "项目",
            project_label,
            "weekly-product-project-filter",
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
            "weekly-product-country-filter",
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
        .child(div().flex_1())
        .child(
            Button::new("weekly-product-recompute")
                .outline()
                .small()
                .disabled(recomputing)
                .label(if recomputing { "重新核算中…" } else { "重新核算" })
                .on_click(move |_, _window, cx| {
                    view_for_recompute.update(cx, |this, cx| this.recompute_history(cx));
                }),
        )
        .child(
            Button::new("weekly-product-refresh")
                .outline()
                .small()
                .label("刷新数据")
                .on_click(move |_, _window, cx| {
                    view_for_refresh.update(cx, |this, cx| this.reload(cx));
                }),
        )
}

// ---------------------------------------------------------------------------
// 统计卡（销售额合计 / 销量合计 / 广告花费合计 + 环比）
// ---------------------------------------------------------------------------

/// 3 张统计卡（对齐 web `DataTableCardStatBar` 的 3 项合计；环比对齐
/// `trends`：最后一周 vs 上一周）
fn stat_band(
    app_theme: &AppTheme,
    country: &str,
    totals: &WeeklyTotals,
    wow: &WeeklyWoW,
) -> impl IntoElement {
    h_flex()
        .id("weekly-product-stats")
        .gap_3()
        .children(vec![
            stat_card(
                app_theme,
                Icon::empty().path("icons/bar-chart-3.svg"),
                "销售额合计",
                fmt_currency(totals.sales_amount, country),
                wow.sales,
            ),
            stat_card(
                app_theme,
                Icon::new(IconName::CircleCheck),
                "销量合计",
                fmt_int_thousands(totals.units_sold as f64),
                wow.units,
            ),
            stat_card(
                app_theme,
                Icon::empty().path("icons/coins.svg"),
                "广告花费合计",
                fmt_currency(totals.ad_spend, country),
                wow.ad,
            ),
        ])
}

/// 单张统计卡：图标 + 数值 + 标签 + 环比徽章（不足 2 周时环比为 0，中性展示）
fn stat_card(
    app_theme: &AppTheme,
    icon: Icon,
    label: &'static str,
    value: String,
    wow_pct: f64,
) -> impl IntoElement {
    let (delta_text, delta_color) = if wow_pct > 0.0 {
        (format!("↑ {wow_pct:.1}%"), app_theme.success)
    } else if wow_pct < 0.0 {
        (format!("↓ {:.1}%", wow_pct.abs()), app_theme.danger)
    } else {
        ("— 0.0%".to_string(), app_theme.text_muted)
    };
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
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    icon.with_size(px(14.))
                        .text_color(app_theme.accent.opacity(0.85)),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(app_theme.text_muted)
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
                        .text_color(app_theme.text_primary)
                        .child(value),
                )
                .child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(delta_color)
                        .child(delta_text),
                ),
        )
        .child(
            div()
                .text_xs()
                .text_color(app_theme.text_muted.opacity(0.8))
                .child("环比上一周"),
        )
}

// ---------------------------------------------------------------------------
// 周度趋势卡（指标下拉 + 面积图 + 图例）
// ---------------------------------------------------------------------------

/// 趋势卡：指标下拉（7 指标单选，替代 web 的 7 序列开关——gpui-component
/// chart 无双轴混合图，见模块头差异说明）+ 单序列面积图 + 合计图例
fn trend_card(
    view: &Entity<WeeklyProductAnalysisView>,
    app_theme: &AppTheme,
    country: &str,
    sorted_rows: &[WeeklyProductRow],
    metric: WeeklyTrendMetric,
) -> impl IntoElement {
    let points = trend_points(sorted_rows);
    let totals = weekly_totals(sorted_rows);
    let metric_label = WeeklyTrendMetric::ALL
        .iter()
        .find(|(m, _)| *m == metric)
        .map(|(_, label)| SharedString::from(*label))
        .unwrap_or_else(|| SharedString::from("销售额"));
    let view_for_metric = view.clone();
    let palette = app_theme.chart_palette();
    let metric_ix = WeeklyTrendMetric::ALL
        .iter()
        .position(|(m, _)| *m == metric)
        .unwrap_or(0);
    let color = palette[metric_ix % palette.len()];

    let body = if points.is_empty() {
        div()
            .w_full()
            .h(px(300.))
            .flex()
            .items_center()
            .justify_center()
            .text_size(px(13.))
            .text_color(app_theme.text_muted)
            .child("暂无趋势数据")
            .into_any_element()
    } else {
        let chart_points: Vec<crate::widgets::chart_primitives::TrendPoint> = points
            .iter()
            .map(|p| crate::widgets::chart_primitives::TrendPoint {
                label: p.label.clone(),
                value: metric.value(p),
            })
            .collect();
        let chart = AreaChart::new(chart_points)
            .x(|p: &crate::widgets::chart_primitives::TrendPoint| p.label.clone())
            .y(|p: &crate::widgets::chart_primitives::TrendPoint| p.value)
            .stroke(color)
            .fill(color.opacity(0.18))
            .natural()
            .tick_margin(1);
        div()
            .w_full()
            .gap_3()
            .child(chart_area(300.0, chart))
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .child(
                        div()
                            .size_2()
                            .rounded_full()
                            .bg(color),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(app_theme.text_muted)
                            .child(format!(
                                "{} · {} 周 · 区间合计 {}",
                                metric_label,
                                points.len(),
                                metric.format(
                                    match metric {
                                        WeeklyTrendMetric::SalesAmount => totals.sales_amount,
                                        WeeklyTrendMetric::UnitsSold => totals.units_sold as f64,
                                        WeeklyTrendMetric::AdSpend => totals.ad_spend,
                                        _ => points.iter().map(|p| metric.value(p)).sum(),
                                    },
                                    country
                                )
                            )),
                    ),
            )
            .into_any_element()
    };

    v_flex()
        .id("weekly-product-trend")
        .w_full()
        .gap_3()
        .p_4()
        .rounded(px(app_theme.radius_lg))
        .bg(app_theme.card_bg)
        .shadow(vec![app_theme.card_shadow_box()])
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(app_theme.text_primary)
                        .child("周度趋势"),
                )
                .child(filter_bar::filter_select(
                    app_theme,
                    "指标",
                    metric_label,
                    "weekly-product-trend-metric",
                    move |menu, _window, _cx| {
                        let mut menu = menu;
                        for (m, label) in WeeklyTrendMetric::ALL {
                            let checked = m == metric;
                            let view_m = view_for_metric.clone();
                            menu = menu.item(
                                PopupMenuItem::new(label).checked(checked).on_click(
                                    move |_, _window, cx| {
                                        view_m.update(cx, |this, cx| {
                                            this.select_trend_metric(m, cx)
                                        });
                                    },
                                ),
                            );
                        }
                        menu
                    },
                )),
        )
        .child(body)
}

// ---------------------------------------------------------------------------
// 每周分析明细卡（双 tab：周汇总宽表 / SKU 明细）
// ---------------------------------------------------------------------------

/// 明细卡：标题 + tab 切换（周汇总 / SKU明细）+ 周次选择（明细 tab）+
/// 表格区（周汇总宽表 or SKU 明细表）+ 合计条
#[allow(clippy::too_many_arguments)]
fn details_card(
    view: &Entity<WeeklyProductAnalysisView>,
    app_theme: &AppTheme,
    country: &str,
    sorted_rows: &[WeeklyProductRow],
    active_tab: WeeklyTab,
    selected_week_id: Option<i64>,
    details_loading: bool,
    details_error: Option<String>,
    details: Option<DetailsPayload>,
    details_table: Option<Entity<DataTable<DetailTableRow>>>,
    summary_table: Option<Entity<DataTable<WeeklyProductRow>>>,
) -> impl IntoElement {
    let view_for_summary_tab = view.clone();
    let view_for_details_tab = view.clone();
    let view_for_week = view.clone();
    let view_for_details_refresh = view.clone();

    v_flex()
        .id("weekly-product-details-card")
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
                    div()
                        .text_base()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(app_theme.text_primary)
                        .child("每周分析明细"),
                )
                .child(
                    h_flex()
                        .gap_2()
                        .items_center()
                        .flex_wrap()
                        // 周次选择（仅明细 tab；对齐 web selectedWeekId 下拉）
                        .when(active_tab == WeeklyTab::Details, |this| {
                            let week_label: SharedString = selected_week_id
                                .and_then(|id| sorted_rows.iter().find(|r| r.id == id))
                                .map(|r| {
                                    SharedString::from(format!(
                                        "{} · {} 至 {}",
                                        iso_week_label(r.report_start_date),
                                        r.report_start_date,
                                        r.report_end_date
                                    ))
                                })
                                .unwrap_or_else(|| SharedString::from("选择周次"));
                            let rows_owned = sorted_rows.to_vec();
                            this.child(filter_bar::filter_select(
                                app_theme,
                                "周次",
                                week_label,
                                "weekly-product-week-filter",
                                move |menu, _window, _cx| {
                                    let mut menu = menu;
                                    // 倒序（最新周在前，对齐 web 下拉习惯）
                                    for row in rows_owned.iter().rev() {
                                        let checked = Some(row.id) == selected_week_id;
                                        let id = row.id;
                                        let label = format!(
                                            "{} · {} 至 {}{}",
                                            iso_week_label(row.report_start_date),
                                            row.report_start_date,
                                            row.report_end_date,
                                            if is_partial_row(row) { " · 数据不完整" } else { "" }
                                        );
                                        let view_w = view_for_week.clone();
                                        menu = menu.item(
                                            PopupMenuItem::new(label)
                                                .checked(checked)
                                                .on_click(move |_, _window, cx| {
                                                    view_w.update(cx, |this, cx| {
                                                        this.select_week(id, cx)
                                                    });
                                                }),
                                        );
                                    }
                                    menu
                                },
                            ))
                            .child(
                                Button::new("weekly-product-details-refresh")
                                    .outline()
                                    .small()
                                    .disabled(details_loading)
                                    .label(if details_loading { "加载中…" } else { "刷新 SKU明细" })
                                    .on_click(move |_, _window, cx| {
                                        view_for_details_refresh
                                            .update(cx, |this, cx| this.load_details(cx));
                                    }),
                            )
                        })
                        // tab 切换（对齐 web 周汇总 / SKU明细 分段按钮）
                        .child(tab_button(
                            app_theme,
                            "weekly-product-tab-summary",
                            "周汇总",
                            active_tab == WeeklyTab::Summary,
                            move |_, _window, cx| {
                                view_for_summary_tab.update(cx, |this, cx| {
                                    this.switch_tab(WeeklyTab::Summary, cx)
                                });
                            },
                        ))
                        .child(tab_button(
                            app_theme,
                            "weekly-product-tab-details",
                            "SKU明细",
                            active_tab == WeeklyTab::Details,
                            move |_, _window, cx| {
                                view_for_details_tab.update(cx, |this, cx| {
                                    this.switch_tab(WeeklyTab::Details, cx)
                                });
                            },
                        )),
                ),
        )
        .child(match active_tab {
            WeeklyTab::Summary => summary_tab_body(app_theme, country, sorted_rows, summary_table),
            WeeklyTab::Details => details_tab_body(
                app_theme,
                country,
                details_loading,
                details_error,
                details,
                details_table,
            ),
        })
}

/// tab 分段按钮（选中 = 卡片底 + 主文字；未选 = 次级文字）
fn tab_button(
    app_theme: &AppTheme,
    id: &'static str,
    label: &'static str,
    active: bool,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    Button::new(id)
        .small()
        .selected(active)
        .label(label)
        .on_click(on_click)
        .when(!active, |this| this.text_color(app_theme.text_muted))
}

/// 周汇总 tab：宽表（周次 + 38 指标列）外包横向滚动 + 合计条
fn summary_tab_body(
    app_theme: &AppTheme,
    country: &str,
    sorted_rows: &[WeeklyProductRow],
    summary_table: Option<Entity<DataTable<WeeklyProductRow>>>,
) -> AnyElement {
    if sorted_rows.is_empty() {
        return div()
            .id("weekly-product-summary-empty")
            .w_full()
            .flex()
            .items_center()
            .justify_center()
            .py_10()
            .text_size(px(13.))
            .text_color(app_theme.text_muted)
            .child("当前筛选条件暂无产品分析周汇总数据")
            .into_any_element();
    }
    let summaries: Vec<serde_json::Map<String, serde_json::Value>> =
        sorted_rows.iter().map(build_summary_for_row).collect();
    let totals = build_summary_totals(&summaries);

    v_flex()
        .id("weekly-product-summary-body")
        .w_full()
        .child(
            div()
                .id("weekly-product-summary-scroll")
                .w_full()
                .overflow_x_scroll()
                .child(
                    v_flex()
                        .min_w(px(2800.))
                        .when_some(summary_table, |this, table| this.child(table)),
                ),
        )
        .child(summary_totals_footer(app_theme, country, &totals))
        .into_any_element()
}

/// SKU 明细 tab：加载骨架 / 错误提示 / 明细表（含库存覆盖副标题）+ 合计条。
/// `country` 透传到明细合计条的货币列格式化（US=$ / DE=€ / UK=£，
/// 与明细表列同口径；BLF-723 review P0 同类修复）
fn details_tab_body(
    app_theme: &AppTheme,
    country: &str,
    details_loading: bool,
    details_error: Option<String>,
    details: Option<DetailsPayload>,
    details_table: Option<Entity<DataTable<DetailTableRow>>>,
) -> AnyElement {
    if let Some(msg) = details_error {
        return v_flex()
            .id("weekly-product-details-error")
            .w_full()
            .gap_2()
            .items_center()
            .py_8()
            .child(
                Icon::new(IconName::TriangleAlert)
                    .with_size(px(20.))
                    .text_color(app_theme.danger),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(app_theme.danger)
                    .child(format!("SKU明细 加载失败：{msg}")),
            )
            .into_any_element();
    }
    let Some(payload) = details else {
        return v_flex()
            .id("weekly-product-details-loading")
            .w_full()
            .gap_3()
            .p_4()
            .child(
                div()
                    .text_xs()
                    .text_color(app_theme.text_muted)
                    .child(if details_loading {
                        "SKU 明细更新中…"
                    } else {
                        "选择周次后加载 SKU 明细"
                    }),
            )
            .child(div().w_full().h_64().child(Skeleton::new()))
            .into_any_element();
    };

    let summaries: Vec<serde_json::Map<String, serde_json::Value>> = payload
        .rows
        .iter()
        .map(|row| row.raw.clone())
        .collect();
    let totals = build_summary_totals(&summaries);

    v_flex()
        .id("weekly-product-details-body")
        .w_full()
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .px_4()
                .pt_2()
                .child(
                    div()
                        .text_xs()
                        .text_color(app_theme.text_muted)
                        .child(format!(
                            "{} 行 · 库存快照：{}",
                            payload.rows.len(),
                            if payload.inventory_covered { "已合并" } else { "无（库存列计 0）" }
                        )),
                )
                .when(details_loading, |this| {
                    this.child(
                        div()
                            .text_xs()
                            .text_color(app_theme.text_muted)
                            .child("SKU 明细更新中…"),
                    )
                }),
        )
        .child(
            div()
                .id("weekly-product-details-scroll")
                .w_full()
                .overflow_x_scroll()
                .child(
                    v_flex()
                        .min_w(px(2800.))
                        .when_some(details_table, |this, table| this.child(table)),
                ),
        )
        .child(detail_totals_footer(app_theme, country, &totals))
        .into_any_element()
}

/// 周汇总合计条（对齐 web 合计行：38 列按 `buildSummaryTotals` 口径，
/// 按分组顺序展示有值列；比率列按百分比口径格式化）
fn summary_totals_footer(
    app_theme: &AppTheme,
    country: &str,
    totals: &serde_json::Map<String, serde_json::Value>,
) -> impl IntoElement {
    totals_footer_common(app_theme, "weekly-product-summary-totals", totals, country)
}

/// SKU 明细合计条（同口径；「库存」列也参与求和——web sumAnyNumericColumn）。
/// `country` 透传货币列币种符号——原实现硬编码 `"US"`，DE/UK 下合计条
/// 会错显 `$`（BLF-723 review P0 同类问题，与明细表列一并修复）。
fn detail_totals_footer(
    app_theme: &AppTheme,
    country: &str,
    totals: &serde_json::Map<String, serde_json::Value>,
) -> impl IntoElement {
    totals_footer_common(app_theme, "weekly-product-details-totals", totals, country)
}

/// 合计条条目序列（列名 + 格式化值；周汇总 / 明细合计条共用，
/// 单独暴露便于单测断言货币列按 country 透传币种符号的口径）
fn totals_footer_items(
    totals: &serde_json::Map<String, serde_json::Value>,
    country: &str,
) -> Vec<(String, String)> {
    summary_columns()
        .into_iter()
        .map(|column| {
            let value = totals.get(column);
            (column.to_string(), format_summary_cell(column, value, country))
        })
        .collect()
}

/// 合计条公共实现：「合计」标签 + 各指标列格式化值（比率列 ×100%；
/// 货币列币种符号；整数列千分位；其余最多 4 位小数）
fn totals_footer_common(
    app_theme: &AppTheme,
    id: &'static str,
    totals: &serde_json::Map<String, serde_json::Value>,
    country: &str,
) -> impl IntoElement {
    let items = totals_footer_items(totals, country);
    h_flex()
        .id(id)
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
        .children(items.into_iter().map(|(label, value)| {
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
// 表格列定义（周汇总 39 列 / SKU 明细基础 42 列 + 额外列）
// ---------------------------------------------------------------------------

/// SKU 明细单元格文本格式化（detail_columns 闭包共用）：
/// 当前与 `format_summary_cell` 同语义（货币列币种符号按 country 透传），
/// 单独暴露以便单测断言 DE/UK 货币列渲染口径（BLF-723 review 反馈）。
pub fn format_detail_cell(
    column: &str,
    value: Option<&serde_json::Value>,
    country: &str,
) -> String {
    format_summary_cell(column, value, country)
}

/// 文本单元格（render_element 闭包共用；对齐由外层 cell div 的
/// `when_align` 控制，此处只输出文本）。
/// 返回裸文本元素——与 DataTable 默认 render 路径同形
/// （`cell.child((col.render)(row, &theme))` 直接放 `SharedString`），
/// `text_align` 经 cell div 的样式栈继承；同时便于单测对闭包输出
/// `downcast_mut::<SharedString>` 直接断言渲染文本。
fn text_cell(value: String) -> AnyElement {
    SharedString::from(value).into_any_element()
}

/// 周汇总宽表列（周次 + 38 指标列 = 39；对齐 web 表头顺序）。
/// 单元格从 `build_summary_for_row` 字典按列名取数，走
/// `format_summary_cell` 口径（百分比 / 货币 / 整数分档）；列名需被闭包
/// 捕获 → 用 `render_element`（`render` 位置放占位 fn，被覆盖）。
/// 周次列含不完整数据标记（对齐 web `_is_partial` 警示图标语义）。
pub fn summary_table_columns(country: &str) -> Vec<ColumnDef<WeeklyProductRow>> {
    let country_owned = country.to_string();
    let mut columns: Vec<ColumnDef<WeeklyProductRow>> = vec![ColumnDef::text(
        "weekly-summary-week",
        "周次",
        |r: &WeeklyProductRow, _| {
            SharedString::from(format!(
                "{}{} · {}",
                iso_week_label(r.report_start_date),
                if is_partial_row(r) { " ⚠" } else { "" },
                r.report_start_date
            ))
        },
    )
    .width(150.0)];
    for column in summary_columns() {
        let column_owned = column.to_string();
        let country_for_cell = country_owned.clone();
        columns.push(
            ColumnDef::text(
                format!("weekly-summary-{column}"),
                column,
                |_: &WeeklyProductRow, _| SharedString::default(),
            )
            .with_render_element(move |r: &WeeklyProductRow, _theme: &AppTheme| {
                let summary = build_summary_for_row(r);
                text_cell(format_summary_cell(
                    &column_owned,
                    summary.get(&column_owned),
                    &country_for_cell,
                ))
            })
            .width(96.0)
            .align(if SUMMARY_INTEGER_COLUMNS.contains(&column)
                || SUMMARY_CURRENCY_COLUMNS.contains(&column)
                || SUMMARY_PERCENT_COLUMNS.contains(&column)
            {
                CellAlign::Right
            } else {
                CellAlign::Left
            }),
        );
    }
    columns
}

/// SKU 明细表列（基础 41 列：日期 + SKU + 40 指标；+ 数据驱动额外列；
/// 对齐 web `detailColumns`）。
/// 单元格从 `raw` 字典按列名取数；「日期」/「SKU」走核心列直取；
/// 指标列名需被闭包捕获 → 用 `render_element`。
/// `country` 用于货币列渲染（US=$ / DE=€ / UK=£），与 `summary_table_columns`
/// 同模式——`country_owned.clone()` 透传到闭包，避免「写死 US」的
/// BLF-723 review 阻塞项（参见 PR #343 review 反馈）。
pub fn detail_columns(
    country: &str,
    extra: &[String],
) -> Vec<ColumnDef<DetailTableRow>> {
    let country_owned = country.to_string();
    let mut columns: Vec<ColumnDef<DetailTableRow>> = vec![
        ColumnDef::text(
            "weekly-detail-date",
            "日期",
            |r: &DetailTableRow, _| SharedString::from(r.date.clone()),
        )
        .width(110.0),
        ColumnDef::text(
            "weekly-detail-sku",
            "SKU",
            |r: &DetailTableRow, _| SharedString::from(r.sku.clone()),
        )
        .width(180.0),
    ];
    for column in detail_base_columns().into_iter().skip(2) {
        let column_owned = column.to_string();
        let country_for_cell = country_owned.clone();
        columns.push(
            ColumnDef::text(
                format!("weekly-detail-{column}"),
                column,
                |_: &DetailTableRow, _| SharedString::default(),
            )
            .with_render_element(move |r: &DetailTableRow, _theme: &AppTheme| {
                text_cell(format_detail_cell(
                    &column_owned,
                    r.raw.get(&column_owned),
                    &country_for_cell,
                ))
            })
            .width(96.0)
            .align(if SUMMARY_INTEGER_COLUMNS.contains(&column)
                || SUMMARY_CURRENCY_COLUMNS.contains(&column)
                || SUMMARY_PERCENT_COLUMNS.contains(&column)
                || column == "库存"
            {
                CellAlign::Right
            } else {
                CellAlign::Left
            }),
        );
    }
    // 额外列（raw_row 中基础列之外的键；对齐 web extras）
    for column in extra {
        let column_owned = column.clone();
        let country_for_cell = country_owned.clone();
        columns.push(
            ColumnDef::text(
                format!("weekly-detail-extra-{column}"),
                column.clone(),
                |_: &DetailTableRow, _| SharedString::default(),
            )
            .with_render_element(move |r: &DetailTableRow, _theme: &AppTheme| {
                text_cell(format_detail_cell(
                    &column_owned,
                    r.raw.get(&column_owned),
                    &country_for_cell,
                ))
            })
            .width(96.0)
            .align(CellAlign::Right),
        );
    }
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

    /// 周行（summary_row 带中文键指标；total_* 与 summary 对齐）
    fn week_row(id: i64, start: NaiveDate, sales: f64, units: i64, ad_spend: f64) -> WeeklyProductRow {
        WeeklyProductRow {
            id,
            project_id: 1,
            project_name: "测试项目 A".into(),
            country: "US".into(),
            report_start_date: start,
            report_end_date: start.checked_add_days(chrono::Days::new(6)).expect("合法日期"),
            version: 1,
            is_current: true,
            row_count: 5,
            total_sales: sales,
            total_units: units,
            total_ad_spend: ad_spend,
            summary_row: Some(serde_json::json!({
                "总销量": units,
                "总销售额": sales,
                "广告花费": ad_spend,
                "广告展示量": 1000,
                "广告点击量": 50,
                "广告销售额": sales / 2.0,
                "页面浏览量": 2000,
                "自然流量": 800,
                "实际销售额": sales,
                "实际销售量": units,
                "利润": sales * 0.2
            })),
            weekly_summary_raw: None,
        }
    }

    fn sample_payload() -> WeeklyPayload {
        WeeklyPayload {
            projects: sample_projects(),
            rows: vec![
                week_row(
                    100,
                    NaiveDate::from_ymd_opt(2026, 7, 27).expect("合法日期"),
                    10000.0,
                    300,
                    1500.0,
                ),
                week_row(
                    101,
                    NaiveDate::from_ymd_opt(2026, 8, 3).expect("合法日期"),
                    12000.0,
                    350,
                    1800.0,
                ),
            ],
            resolved_project_id: 1,
        }
    }

    // ---------- 纯函数契约 ----------

    /// ISO 周次标签（对齐 web getISOWeek：2026-08-03 是 2026-W32）
    #[test]
    fn iso_week_label_matches_frontend() {
        assert_eq!(
            iso_week_label(NaiveDate::from_ymd_opt(2026, 8, 3).expect("合法日期")),
            "2026-W32"
        );
        // 跨年周：2026-01-01（周四）属于 2026-W01
        assert_eq!(
            iso_week_label(NaiveDate::from_ymd_opt(2026, 1, 1).expect("合法日期")),
            "2026-W01"
        );
        // 2025-12-29（周一）属于 2026-W01（ISO 跨年）
        assert_eq!(
            iso_week_label(NaiveDate::from_ymd_opt(2025, 12, 29).expect("合法日期")),
            "2026-W01"
        );
    }

    /// 默认区间（对齐 web：本周一 - 56 天 ~ 本周一 - 1 天 = 上 8 周周一 ~ 上周日）
    #[test]
    fn default_week_range_matches_frontend() {
        // 2026-08-16 是周日 → 本周一 2026-08-10
        let today = NaiveDate::from_ymd_opt(2026, 8, 16).expect("合法日期");
        let range = default_week_range(today);
        assert_eq!(
            range.from,
            Some(NaiveDate::from_ymd_opt(2026, 6, 15).expect("合法日期")),
            "起点 = 本周一向前 8 周的周一"
        );
        assert_eq!(
            range.to,
            Some(NaiveDate::from_ymd_opt(2026, 8, 9).expect("合法日期")),
            "终点 = 上一个周日"
        );
        // 周一当天：本周一 = today → 终点 = 昨天（周日）
        let monday = NaiveDate::from_ymd_opt(2026, 8, 10).expect("合法日期");
        let range = default_week_range(monday);
        assert_eq!(range.to, Some(NaiveDate::from_ymd_opt(2026, 8, 9).expect("合法日期")));
    }

    /// toNumber / safeDiv / hasValue（对齐 web 同名函数）
    #[test]
    fn number_helpers_match_frontend() {
        assert_eq!(to_number(Some(&serde_json::json!(1.5))), 1.5);
        assert_eq!(to_number(Some(&serde_json::json!("1,234.5"))), 1234.5);
        assert_eq!(to_number(Some(&serde_json::json!("abc"))), 0.0);
        assert_eq!(to_number(Some(&serde_json::json!(""))), 0.0);
        assert_eq!(to_number(None), 0.0);
        assert_eq!(safe_div(10.0, 4.0), 2.5);
        assert_eq!(safe_div(10.0, 0.0), 0.0);
        assert!(has_value(Some(&serde_json::json!(0))));
        assert!(!has_value(Some(&serde_json::json!(""))));
        assert!(!has_value(Some(&serde_json::json!(null))));
        assert!(!has_value(None));
    }

    /// 格式化分档（对齐 web formatSummaryCell / formatCurrency / 千分位）
    #[test]
    fn formatters_match_frontend() {
        assert_eq!(fmt_currency(15320.5, "US"), "$15,320.50");
        assert_eq!(fmt_currency(-1234.567, "DE"), "-€1,234.57");
        assert_eq!(fmt_currency(99.0, "UK"), "£99.00");
        assert_eq!(fmt_int_thousands(1234567.0), "1,234,567");
        assert_eq!(fmt_int_thousands(1234.4), "1,234");
        assert_eq!(fmt_general(1234.5), "1,234.5");
        assert_eq!(fmt_general(1234.0), "1,234");
        assert_eq!(fmt_general(0.12345), "0.1235");
        // 百分比列 ×100 + %
        assert_eq!(
            format_summary_cell("总转化", Some(&serde_json::json!(0.15)), "US"),
            "15.00%"
        );
        // 货币列币种符号
        assert_eq!(
            format_summary_cell("总销售额", Some(&serde_json::json!(15320.5)), "US"),
            "$15,320.50"
        );
        // 整数列千分位
        assert_eq!(
            format_summary_cell("总销量", Some(&serde_json::json!(12345)), "US"),
            "12,345"
        );
        // 缺失 → "-"
        assert_eq!(format_summary_cell("总销量", None, "US"), "-");
        // 非数字字符串原样
        assert_eq!(
            format_summary_cell("备注", Some(&serde_json::json!("N/A")), "US"),
            "N/A"
        );
    }

    /// buildSummaryForRow 回退口径（缺失字段用 total_* 补齐）
    #[test]
    fn build_summary_for_row_applies_fallbacks() {
        let mut row = week_row(
            1,
            NaiveDate::from_ymd_opt(2026, 8, 3).expect("合法日期"),
            100.0,
            10,
            20.0,
        );
        row.summary_row = Some(serde_json::json!({}));
        let summary = build_summary_for_row(&row);
        assert_eq!(summary.get("总销量").and_then(|v| v.as_i64()), Some(10));
        assert_eq!(summary.get("总销售额").and_then(|v| v.as_f64()), Some(100.0));
        assert_eq!(summary.get("广告花费").and_then(|v| v.as_f64()), Some(20.0));
        assert_eq!(summary.get("实际销售额").and_then(|v| v.as_f64()), Some(100.0));
        // summary_row 为 None 也走回退
        row.summary_row = None;
        let summary = build_summary_for_row(&row);
        assert_eq!(summary.get("总销量").and_then(|v| v.as_i64()), Some(10));
    }

    /// buildSummaryTotals 比率口径（对齐 web：合计后重算 17 个比率列）
    #[test]
    fn build_summary_totals_recomputes_ratios() {
        let rows = vec![
            serde_json::json!({
                "总销量": 100, "页面浏览量": 1000,
                "广告点击量": 50, "广告展示量": 500,
                "广告花费": 100.0, "广告销售额": 500.0,
                "实际销售额": 1000.0, "实际销售量": 100,
                "利润": 200.0
            })
            .as_object()
            .expect("对象")
            .clone(),
        ];
        let totals = build_summary_totals(&rows);
        // 总转化 = 100/1000 = 0.1
        assert_eq!(totals.get("总转化").and_then(|v| v.as_f64()), Some(0.1));
        // 广告点击率 = 50/500 = 0.1
        assert_eq!(totals.get("广告点击率").and_then(|v| v.as_f64()), Some(0.1));
        // ACOS = 100/500 = 0.2
        assert_eq!(totals.get("ACOS").and_then(|v| v.as_f64()), Some(0.2));
        // 利润率 = 200/1000 = 0.2
        assert_eq!(totals.get("利润率").and_then(|v| v.as_f64()), Some(0.2));
        // 平均售价 = 1000/100 = 10
        assert_eq!(totals.get("平均售价").and_then(|v| v.as_f64()), Some(10.0));
    }

    /// 趋势点序列（排序 + 比率计算；分母缺失按 1 兜底）
    #[test]
    fn trend_points_match_frontend() {
        let payload = sample_payload();
        let points = trend_points(&payload.rows);
        assert_eq!(points.len(), 2);
        assert_eq!(points[0].label, "2026-W31");
        assert_eq!(points[1].label, "2026-W32");
        assert_eq!(points[1].sales_amount, 12000.0);
        assert_eq!(points[1].units_sold, 350.0);
        // ACOS = 1800 / 6000 * 100 = 30
        assert!((points[1].acos - 30.0).abs() < 1e-9);
        // CTR = 50 / 1000 * 100 = 5
        assert!((points[1].ctr - 5.0).abs() < 1e-9);
    }

    /// 合计 + 环比（对齐 web totals / trends：最后一周 vs 上一周）
    #[test]
    fn totals_and_wow_match_frontend() {
        let payload = sample_payload();
        let totals = weekly_totals(&payload.rows);
        assert_eq!(totals.sales_amount, 22000.0);
        assert_eq!(totals.units_sold, 650);
        assert_eq!(totals.ad_spend, 3300.0);
        let wow = weekly_wow(&payload.rows);
        // 销售额环比 = (12000-10000)/10000*100 = 20
        assert!((wow.sales - 20.0).abs() < 1e-9);
        // 不足 2 周 → 全 0
        let single = vec![payload.rows[0].clone()];
        assert_eq!(weekly_wow(&single), WeeklyWoW::default());
    }

    /// 明细额外列（raw 中基础列之外、非 ASIN 的键，按首次出现顺序）
    #[test]
    fn detail_extra_columns_match_frontend() {
        let rows = vec![
            DetailTableRow {
                date: "2026-08-03".into(),
                sku: "SKU-A".into(),
                raw: serde_json::json!({
                    "日期": "2026-08-03", "SKU": "SKU-A", "ASIN": "B0TEST",
                    "总销量": 12, "自定义列A": 1
                })
                .as_object()
                .expect("对象")
                .clone(),
            },
            DetailTableRow {
                date: "2026-08-04".into(),
                sku: "SKU-B".into(),
                raw: serde_json::json!({
                    "日期": "2026-08-04", "SKU": "SKU-B",
                    "自定义列B": 2, "自定义列A": 3
                })
                .as_object()
                .expect("对象")
                .clone(),
            },
        ];
        let extra = detail_extra_columns(&rows);
        assert_eq!(extra, vec!["自定义列A".to_string(), "自定义列B".to_string()]);
    }

    /// 列定义契约：周汇总 39 列（周次 + 38 指标）；明细基础 41 列（日期 + SKU + 40 指标）+ 额外列；id 唯一
    #[test]
    fn column_definitions_match_frontend() {
        let summary = summary_table_columns("US");
        assert_eq!(summary.len(), 39);
        assert_eq!(summary[0].id, "weekly-summary-week");
        assert_eq!(summary[1].id, "weekly-summary-总销量");

        let base = detail_columns("US", &[]);
        assert_eq!(base.len(), 41);
        assert_eq!(base[0].id, "weekly-detail-date");
        assert_eq!(base[1].id, "weekly-detail-sku");
        assert_eq!(base[2].id, "weekly-detail-总销量");

        let with_extra = detail_columns("US", &["自定义列A".to_string()]);
        assert_eq!(with_extra.len(), 42);
        assert_eq!(with_extra[41].id, "weekly-detail-extra-自定义列A");

        // id 唯一（gpui element id 要求）
        let ids: Vec<&str> = with_extra.iter().map(|c| c.id.as_str()).collect();
        let mut uniq = ids.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(ids.len(), uniq.len(), "列 id 必须唯一");
    }

    /// detail 列货币格式化按 country 透传（BLF-723 review P0 阻塞项契约）：
    /// 用户在筛选栏切到 DE/UK 时，SKU 明细表货币列（总销售额 / 利润 /
    /// 实际销售额 / 平均售价 等 13 列）必须渲染 € / £ 而非硬编码 $。
    /// 直接调用 `detail_columns` 的 `render_element` 闭包，对输出元素
    /// `downcast_mut::<SharedString>` 断言渲染文本（`text_cell` 输出裸文本
    /// 元素）——若闭包重新硬编码 `"US"`，本测试立即失败。
    #[test]
    fn detail_columns_currency_uses_country_param() {
        // 含两条货币列 + 一条非货币列；构造固定 raw dict 供断言
        let mut raw = serde_json::Map::new();
        raw.insert("总销售额".into(), serde_json::json!(-1234.567));
        raw.insert("利润".into(), serde_json::json!(500.0));
        raw.insert("总销量".into(), serde_json::json!(10));
        let row = DetailTableRow {
            date: "2026-08-01".into(),
            sku: "SKU-A".into(),
            raw: raw.clone(),
        };
        let theme = AppTheme::light();

        /// 调用指定列的 render_element 闭包并提取渲染文本
        fn render_cell(
            cols: &[ColumnDef<DetailTableRow>],
            id: &str,
            row: &DetailTableRow,
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
        let us = detail_columns("US", &[]);
        assert_eq!(
            render_cell(&us, "weekly-detail-总销售额", &row, &theme),
            "-$1,234.57"
        );
        assert_eq!(
            render_cell(&us, "weekly-detail-利润", &row, &theme),
            "$500.00"
        );
        // —— DE：闭包必须用传入的 country 而非硬编码 US ——
        let de = detail_columns("DE", &[]);
        assert_eq!(
            render_cell(&de, "weekly-detail-总销售额", &row, &theme),
            "-€1,234.57"
        );
        assert_eq!(
            render_cell(&de, "weekly-detail-利润", &row, &theme),
            "€500.00"
        );
        // —— UK ——
        let uk = detail_columns("UK", &[]);
        assert_eq!(
            render_cell(&uk, "weekly-detail-总销售额", &row, &theme),
            "-£1,234.57"
        );
        assert_eq!(
            render_cell(&uk, "weekly-detail-利润", &row, &theme),
            "£500.00"
        );

        // 非货币列（整数）不受 country 影响
        assert_eq!(render_cell(&us, "weekly-detail-总销量", &row, &theme), "10");
        assert_eq!(render_cell(&de, "weekly-detail-总销量", &row, &theme), "10");
        assert_eq!(render_cell(&uk, "weekly-detail-总销量", &row, &theme), "10");

        // 额外列同一闭包路径：渲染正常且 country 已透传（额外列为基础列
        // 之外的键，正常不会命中货币分档，按通用数字口径渲染）
        let mut raw_extra = raw.clone();
        raw_extra.insert("自定义指标".into(), serde_json::json!(1234.5678));
        let row_extra = DetailTableRow {
            date: "2026-08-01".into(),
            sku: "SKU-A".into(),
            raw: raw_extra,
        };
        let de_extra = detail_columns("DE", &["自定义指标".to_string()]);
        assert_eq!(
            render_cell(&de_extra, "weekly-detail-extra-自定义指标", &row_extra, &theme),
            "1,234.5678"
        );
    }

    /// 合计条货币列按 country 透传（BLF-723 review P0 同类修复契约）：
    /// 原 `detail_totals_footer` 硬编码 `"US"`，DE/UK 下明细合计条会错显 `$`；
    /// 现 `totals_footer_items` 接 country 参数，周汇总 / 明细合计条共用同口径
    #[test]
    fn totals_footer_items_currency_follows_country() {
        let mut totals = serde_json::Map::new();
        totals.insert("总销售额".into(), serde_json::json!(1234.5));
        totals.insert("总销量".into(), serde_json::json!(100));
        let get = |items: &[(String, String)], label: &str| -> String {
            items
                .iter()
                .find(|(l, _)| l == label)
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| panic!("{label} 列应存在"))
        };
        let us = totals_footer_items(&totals, "US");
        let de = totals_footer_items(&totals, "DE");
        let uk = totals_footer_items(&totals, "UK");
        assert_eq!(get(&us, "总销售额"), "$1,234.50");
        assert_eq!(get(&de, "总销售额"), "€1,234.50");
        assert_eq!(get(&uk, "总销售额"), "£1,234.50");
        // 整数列不受 country 影响
        assert_eq!(get(&us, "总销量"), "100");
        assert_eq!(get(&de, "总销量"), "100");
    }

    /// 状态转移：项目空 → Empty；有数据 → Loaded；错误 → Error
    #[test]
    fn state_transitions_from_fetch_result() {
        let mut no_projects = sample_payload();
        no_projects.projects = Vec::new();
        assert_eq!(
            WeeklyState::from_fetch_result(Ok(no_projects)),
            WeeklyState::Empty
        );
        assert_eq!(
            WeeklyState::from_fetch_result(Ok(sample_payload())),
            WeeklyState::Loaded(Box::new(sample_payload()))
        );
        assert_eq!(
            WeeklyState::from_fetch_result(Err("boom".into())),
            WeeklyState::Error("boom".into())
        );
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

    // ---------- 渲染冒烟 ----------

    /// 渲染冒烟：亮色主题（client 指向 127.0.0.1:1，首屏拉取快速失败 → 错误态）
    #[gpui::test]
    async fn view_renders_loading_then_error_in_light_mode(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let (_view, _cx) = cx.add_window_view(|_window, cx| {
            let mut view = WeeklyProductAnalysisView::new(cx, Client::new("http://127.0.0.1:1"));
            view.reload(cx);
            view
        });
    }

    /// 渲染冒烟：深色主题 + Loaded 态（直接注入载荷 + 周汇总表，覆盖页面头 /
    /// 筛选栏 / 统计卡 / 趋势卡 / 明细卡周汇总 tab）
    #[gpui::test]
    async fn view_renders_loaded_in_dark_mode(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            WeeklyProductAnalysisView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let payload = sample_payload();
            let sorted = sort_week_rows(&payload.rows);
            this.selected_project_id = Some(1);
            this.sync_summary_table(&sorted, cx);
            this.state.update(cx, |state, _| {
                *state = WeeklyState::Loaded(Box::new(payload));
            });
        });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    /// 渲染冒烟：Loaded 态 + SKU 明细 tab（注入明细载荷 + 明细表，覆盖
    /// 周次选择 / 明细表 / 合计条 / 库存覆盖副标题）
    #[gpui::test]
    async fn view_renders_details_tab(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            WeeklyProductAnalysisView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let payload = sample_payload();
            let sorted = sort_week_rows(&payload.rows);
            this.selected_project_id = Some(1);
            this.selected_week_id = Some(101);
            this.sync_summary_table(&sorted, cx);
            this.state.update(cx, |state, _| {
                *state = WeeklyState::Loaded(Box::new(payload));
            });
            // 注入明细载荷（含额外列，触发明细表重建路径）
            let details_payload = DetailsPayload {
                rows: vec![DetailTableRow {
                    date: "2026-08-03".into(),
                    sku: "SKU-A".into(),
                    raw: serde_json::json!({
                        "日期": "2026-08-03", "SKU": "SKU-A",
                        "总销量": 12, "库存": 100, "自定义列A": 1
                    })
                    .as_object()
                    .expect("对象")
                    .clone(),
                }],
                inventory_covered: true,
            };
            this.sync_details_table(&details_payload, cx);
            this.details = Some(details_payload);
            this.active_tab = WeeklyTab::Details;
            assert_eq!(this.details_extra_signature, vec!["自定义列A".to_string()]);
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
            WeeklyProductAnalysisView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let payload = sample_payload();
            let sorted = sort_week_rows(&payload.rows);
            this.sync_summary_table(&sorted, cx);
            this.state.update(cx, |state, _| {
                *state = WeeklyState::Loaded(Box::new(payload));
            });
        });
    }

    /// 渲染冒烟：空态（无项目 → 「暂无可用项目」+ 刷新按钮）可渲染
    #[gpui::test]
    async fn view_renders_empty_state(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            WeeklyProductAnalysisView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = WeeklyState::Empty;
            });
        });
    }

    /// 渲染冒烟：有项目但周数据为空 → Loaded（图表 / 表格内空态文案兜底）
    #[gpui::test]
    async fn view_renders_loaded_with_empty_rows(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            WeeklyProductAnalysisView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            let mut payload = sample_payload();
            payload.rows = Vec::new();
            this.sync_summary_table(&[], cx);
            this.state.update(cx, |state, _| {
                *state = WeeklyState::Loaded(Box::new(payload));
            });
        });
    }

    /// 筛选 / tab 动作：指标切换 + tab 切换 + 周次选择（no-op 语义 + 状态落点）
    #[gpui::test]
    async fn filter_actions_update_state(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            WeeklyProductAnalysisView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            // 指标切换（同一指标 no-op）
            assert_eq!(this.trend_metric, WeeklyTrendMetric::SalesAmount);
            this.select_trend_metric(WeeklyTrendMetric::Acos, cx);
            assert_eq!(this.trend_metric, WeeklyTrendMetric::Acos);
            // tab 切换（同一 tab no-op；明细 tab 无选中周次不触发拉取）
            assert_eq!(this.active_tab, WeeklyTab::Summary);
            this.switch_tab(WeeklyTab::Details, cx);
            assert_eq!(this.active_tab, WeeklyTab::Details);
            let before = this.latest_details_request_id;
            this.switch_tab(WeeklyTab::Details, cx);
            assert_eq!(this.latest_details_request_id, before);
        });
    }
}
