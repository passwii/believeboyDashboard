//! 运营 → 项目目标（P5-1，BLF-716）
//!
//! frontend `app/dashboard/operations/project-goals/page.tsx` 的 GPUI 等价数据层：
//! 月度/年度销售目标设定与进度展示。端点对齐 backend
//! `backend/app/api/v1/endpoints/project_goals.py`（/api/v1/project-goals 系列）。
//!
//! 数据形状约定（与 backend `app/schemas/project_goal.py` 1:1）：
//! - `ProjectGoalProgressResponse`：进度概览（12 个月进度 + 年度进度）；
//! - `ProjectGoalListResponse`：目标列表（goal_type 区分 monthly / annual）；
//! - 进度值均为小数（0.86 = 86%，可 >1 表示超额），展示层封顶 + 文案提示。
//!
//! 纯函数（可单测）：
//! - [`month_status`]：月份状态（过去 / 当前 / 未来）——状态徽章与进度条配色依据；
//! - [`projected_monthly_rate`]：预估月度完成率（线性外推，对齐 frontend
//!   `projectedMonthlyRate`）；
//! - [`format_money`] / [`format_percent`] / [`currency_symbol`]：金额 / 百分比 /
//!   货币符号格式化（对齐 frontend `formatMoney` / `formatPercent` /
//!   `CURRENCY_SYMBOL`）。

use serde::{Deserialize, Serialize};

/// 站点选项（对齐 frontend `COUNTRY_OPTIONS`；value = backend 入参，label = 展示名）
pub const COUNTRY_OPTIONS: [(&str, &str); 3] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
];

/// 月份展示名（1-12 → "1月"…"12月"，对齐 frontend `MONTH_NAMES`）
pub const MONTH_NAMES: [&str; 12] = [
    "1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月",
];

/// 单条目标记录（backend `ProjectGoalItem`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectGoalItem {
    pub id: i64,
    pub project_id: i64,
    pub country: String,
    /// 'monthly' | 'annual'
    pub goal_type: String,
    /// 'sales_amount' | …（未来扩展）
    pub metric_type: String,
    pub period_year: i32,
    /// 1-12，仅月度目标有值
    pub period_month: Option<i32>,
    pub target_amount: f64,
    /// 'USD' | 'EUR' | 'GBP'
    pub currency: String,
    pub created_at: String,
    pub updated_at: String,
}

impl ProjectGoalItem {
    /// 是否年度目标
    pub fn is_annual(&self) -> bool {
        self.goal_type == "annual"
    }

    /// 展示标题（对齐 frontend 删除确认的「X月目标 / 年度目标」）
    pub fn display_name(&self) -> String {
        if self.is_annual() {
            format!("{}年度目标", self.period_year)
        } else {
            format!(
                "{}月目标",
                self.period_month.unwrap_or(0)
            )
        }
    }
}

/// 月度完成进度项（backend `MonthlyProgressItem`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MonthlyProgressItem {
    pub year: i32,
    /// 1-12
    pub month: i32,
    /// 如 "2026年8月"
    pub month_label: String,
    pub target_amount: f64,
    pub achieved_amount: f64,
    /// 0.0 - 1.0+
    pub completion_rate: f64,
    pub days_in_month: i32,
    /// 截止今天的日序
    pub today_day: i32,
    /// 每日目标（target / days_in_month）
    pub daily_target: f64,
    /// 截止今天的累计目标
    pub cumulative_daily_target: f64,
    /// 实际完成 vs 累计目标（0.0 - 1.0+）
    pub completion_vs_daily: f64,
    /// 实际完成 vs 月度目标（0.0 - 1.0+）
    pub completion_vs_monthly: f64,
    pub currency: String,
}

/// 年度完成进度项（backend `AnnualProgressItem`；无年度目标时为 None）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnnualProgressItem {
    pub year: i32,
    pub target_amount: f64,
    pub achieved_amount: f64,
    pub completion_rate: f64,
    pub currency: String,
}

/// 目标进度响应（backend `ProjectGoalProgressResponse`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectGoalProgressResponse {
    pub project_id: i64,
    pub country: String,
    pub year: i32,
    /// 'USD' | 'EUR' | 'GBP'
    pub currency: String,
    pub monthly_progress: Vec<MonthlyProgressItem>,
    pub annual_progress: Option<AnnualProgressItem>,
}

/// 目标列表响应（backend `ProjectGoalListResponse`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectGoalListResponse {
    pub goals: Vec<ProjectGoalItem>,
    pub total: i64,
}

/// 创建目标请求体（backend `ProjectGoalCreate`）
#[derive(Debug, Clone, Serialize)]
pub struct ProjectGoalCreateBody {
    pub project_id: i64,
    pub country: String,
    /// 'monthly' | 'annual'
    pub goal_type: String,
    /// 'sales_amount'
    pub metric_type: String,
    pub period_year: i32,
    /// 1-12，仅月度目标
    pub period_month: Option<i32>,
    pub target_amount: f64,
}

/// 更新目标请求体（backend `ProjectGoalUpdate`）
#[derive(Debug, Clone, Serialize)]
pub struct ProjectGoalUpdateBody {
    pub target_amount: f64,
}

/// 月份状态（对齐 frontend `monthStatus`：与当前年月的相对关系）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonthStatus {
    /// 过去月份（用于「未达标」橙条判定）
    Past,
    /// 当前月份（蓝色高亮「本月」）
    Current,
    /// 未来月份（「未开始」灰态）
    Future,
}

/// 由「选中年月」与「当前年月」推导月份状态。
///
/// 对齐 frontend `monthStatus` 的嵌套三元逻辑：先比年份再比月份。
pub fn month_status(
    selected_year: i32,
    selected_month: i32,
    current_year: i32,
    current_month: i32,
) -> MonthStatus {
    if selected_year < current_year
        || (selected_year == current_year && selected_month < current_month)
    {
        MonthStatus::Past
    } else if selected_year == current_year && selected_month == current_month {
        MonthStatus::Current
    } else {
        MonthStatus::Future
    }
}

/// 预估月度完成率（线性外推 run-rate，对齐 frontend `projectedMonthlyRate`）：
/// 实际月度进度 × (整月天数 ÷ 今日日序)。例如 15 号已完成整月目标 40% →
/// 40% × 30/15 = 80%。`today_day <= 0`（非当前月）不具备口径，返回 0。
pub fn projected_monthly_rate(
    completion_vs_monthly: f64,
    days_in_month: i32,
    today_day: i32,
) -> f64 {
    if !completion_vs_monthly.is_finite() || today_day <= 0 || days_in_month <= 0 {
        return 0.0;
    }
    completion_vs_monthly * (days_in_month as f64 / today_day as f64)
}

/// 货币符号（对齐 frontend `CURRENCY_SYMBOL`；未知货币回退 `$`）
pub fn currency_symbol(currency: &str) -> &'static str {
    match currency {
        "US" | "USD" => "$",
        "DE" | "EUR" => "€",
        "UK" | "GBP" => "£",
        _ => "$",
    }
}

/// 百分比显示（0.86 → "86.0%"；对齐 frontend `formatPercent`）
pub fn format_percent(rate: f64) -> String {
    format!("{:.1}%", rate * 100.0)
}

/// 金额显示（千分位 + 两位小数，不带货币符号；对齐 frontend `formatMoney`）
pub fn format_money(value: f64) -> String {
    let negative = value < 0.0;
    let abs = value.abs();
    let integer = abs.trunc() as u64;
    let frac = ((abs - abs.trunc()) * 100.0).round() as u64;
    let int_str = integer.to_string();
    let mut out = String::with_capacity(int_str.len() + int_str.len() / 3 + 3);
    if negative {
        out.push('-');
    }
    for (i, ch) in int_str.chars().enumerate() {
        if i > 0 && (int_str.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out.push('.');
    out.push_str(&format!("{frac:02}"));
    out
}

/// 年份选项（对齐 frontend `years = 当前年-2 … 当前年+2`，共 5 年）
pub fn year_options(current_year: i32) -> Vec<i32> {
    (current_year - 2..=current_year + 2).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn month_status_matches_frontend_logic() {
        let cur_y = 2026;
        let cur_m = 8;
        assert_eq!(month_status(2026, 8, cur_y, cur_m), MonthStatus::Current);
        assert_eq!(month_status(2026, 7, cur_y, cur_m), MonthStatus::Past);
        assert_eq!(month_status(2026, 9, cur_y, cur_m), MonthStatus::Future);
        // 跨年：去年任意月为 past，明年任意月为 future
        assert_eq!(month_status(2025, 12, cur_y, cur_m), MonthStatus::Past);
        assert_eq!(month_status(2027, 1, cur_y, cur_m), MonthStatus::Future);
        // 同年比月：1 月 < 8 月 → past；12 月 > 8 月 → future
        assert_eq!(month_status(2026, 1, cur_y, cur_m), MonthStatus::Past);
        assert_eq!(month_status(2026, 12, cur_y, cur_m), MonthStatus::Future);
    }

    #[test]
    fn projected_monthly_rate_linear_extrapolation() {
        // 15 号完成整月目标 40% → 40% × 30/15 = 80%
        assert!((projected_monthly_rate(0.4, 30, 15) - 0.8).abs() < 1e-9);
        // 已过天数 = 整月天数 → 等于实际进度
        assert!((projected_monthly_rate(0.4, 30, 30) - 0.4).abs() < 1e-9);
        // today_day <= 0（非当前月）→ 0
        assert_eq!(projected_monthly_rate(0.4, 30, 0), 0.0);
        assert_eq!(projected_monthly_rate(0.4, 30, -1), 0.0);
        // 非法输入 → 0
        assert_eq!(projected_monthly_rate(f64::NAN, 30, 15), 0.0);
        assert_eq!(projected_monthly_rate(0.4, 0, 15), 0.0);
    }

    #[test]
    fn currency_symbol_maps_country_and_code() {
        assert_eq!(currency_symbol("US"), "$");
        assert_eq!(currency_symbol("USD"), "$");
        assert_eq!(currency_symbol("DE"), "€");
        assert_eq!(currency_symbol("EUR"), "€");
        assert_eq!(currency_symbol("UK"), "£");
        assert_eq!(currency_symbol("GBP"), "£");
        assert_eq!(currency_symbol("JPY"), "$"); // 未知回退
    }

    #[test]
    fn format_percent_renders_one_decimal() {
        assert_eq!(format_percent(0.86), "86.0%");
        assert_eq!(format_percent(1.0), "100.0%");
        assert_eq!(format_percent(1.234), "123.4%");
        assert_eq!(format_percent(0.0), "0.0%");
    }

    #[test]
    fn format_money_uses_thousands_and_two_decimals() {
        assert_eq!(format_money(1234.5), "1,234.50");
        assert_eq!(format_money(50000.0), "50,000.00");
        assert_eq!(format_money(0.0), "0.00");
        assert_eq!(format_money(999.99), "999.99");
        assert_eq!(format_money(-123.45), "-123.45");
        assert_eq!(format_money(1_000_000.0), "1,000,000.00");
    }

    #[test]
    fn year_options_centered_on_current_year() {
        assert_eq!(year_options(2026), vec![2024, 2025, 2026, 2027, 2028]);
    }

    #[test]
    fn goal_display_name_renders_monthly_and_annual() {
        let monthly = ProjectGoalItem {
            id: 1,
            project_id: 2,
            country: "US".into(),
            goal_type: "monthly".into(),
            metric_type: "sales_amount".into(),
            period_year: 2026,
            period_month: Some(8),
            target_amount: 100.0,
            currency: "USD".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };
        assert_eq!(monthly.display_name(), "8月目标");
        assert!(!monthly.is_annual());
        let annual = ProjectGoalItem { goal_type: "annual".into(), period_month: None, ..monthly };
        assert_eq!(annual.display_name(), "2026年度目标");
        assert!(annual.is_annual());
    }
}
