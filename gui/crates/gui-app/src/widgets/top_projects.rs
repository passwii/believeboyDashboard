//! Top 项目列表（GUI-9 / 1.0-d）
//!
//! frontend `components/dashboard-v2/v2-top-projects.tsx` 的 GPUI 等价：
//!
//! - 表格：项目 / 销售额 / 广告花费 / 订单量 / 环比，默认按销售额降序取 Top 6；
//! - 列排序：点击表头（或表头排序图标）切换升 / 降序，再次点击回到默认排序；
//! - 行高亮：hover 状态由 gpui-component `Table` 内建（`table_hover` 语义色）；
//! - 组件：`gpui_component::table::Table`（虚拟滚动 + 列排序 + 列管理），
//!   不手写轮子（用户 2026-08-14 组件库原则）。
//!
//! 数据流：`DashboardData::top_projects()`（views/dashboard.rs）先做纯函数聚合
//! （`compute_top_projects`，对齐 frontend 同名函数），再把行喂给本 Widget；
//! Widget 持有 `TableState`，排序状态留在 delegate 内，数据刷新时保留当前排序。
//!
//! 环比口径：`change = (本期销售额 - 对比期销售额) / 对比期销售额 × 100`，
//! 对比期销售额为 0（或缺失）时显示「—」（对齐 frontend `renderChangeIndicator`）。

use std::collections::HashMap;

use gpui::{prelude::*, App, Context, CursorStyle, Entity, FontWeight, Render, Window, div, px};
use gpui_component::{
    ActiveTheme, Icon, IconName, Sizable, Theme,
    h_flex, table::{Column, ColumnSort, Table, TableDelegate, TableState}, v_flex,
};
use gui_domain::common::ManagedProject;
use gui_domain::dashboard::ProjectBreakdownEntry;

/// Top N 行数（对齐 frontend `v2-top-projects.tsx` 的 `MAX_ROWS = 6`）
pub const MAX_ROWS: usize = 6;

// 列索引（与 columns() 顺序一致）
const COL_PROJECT: usize = 0;
const COL_SALES: usize = 1;
const COL_AD_SPEND: usize = 2;
const COL_ORDERS: usize = 3;
const COL_CHANGE: usize = 4;

/// 聚合行（对齐 frontend `V2TopProjectAggRow`）
#[derive(Debug, Clone, PartialEq)]
pub struct TopProjectRow {
    pub project_id: i64,
    pub project_name: String,
    pub total_sales: f64,
    pub total_ad_spend: f64,
    pub total_orders: i64,
    /// 销售额环比（%）；对比期缺失 / 为 0 时为 `None`（显示「—」）
    pub change: Option<f64>,
}

/// 汇总 `project_breakdown`（+ 对比期）并按销售额降序取 Top N（纯函数，供测试）。
///
/// 对齐 frontend `computeTopProjects`（v2-top-projects.tsx）：
/// - 只统计 `projects` 里能取到 `project_breakdown` 且 `summary_rows` 非空的项目；
/// - 项目名优先取 breakdown 的 `project_name`，为空时回退到项目列表的 name；
/// - 环比 = (本期销售额 - 对比期销售额) / 对比期销售额 × 100；
///   对比期销售额 ≤ 0 → `None`。
pub fn compute_top_projects(
    project_breakdown: &HashMap<i64, ProjectBreakdownEntry>,
    compare_breakdown: Option<&HashMap<i64, ProjectBreakdownEntry>>,
    projects: &[ManagedProject],
) -> Vec<TopProjectRow> {
    let mut rows: Vec<TopProjectRow> = Vec::new();
    for project in projects {
        let Some(entry) = project_breakdown.get(&project.id) else {
            continue;
        };
        if entry.summary_rows.is_empty() {
            continue;
        }
        let mut total_sales = 0.0f64;
        let mut total_ad_spend = 0.0f64;
        let mut total_orders = 0i64;
        for r in &entry.summary_rows {
            total_sales += r.sales_amount;
            total_ad_spend += r.ad_spend;
            total_orders += r.order_qty;
        }
        let prev_sales: f64 = compare_breakdown
            .and_then(|map| map.get(&project.id))
            .map(|e| e.summary_rows.iter().map(|r| r.sales_amount).sum())
            .unwrap_or(0.0);
        let change = if prev_sales > 0.0 {
            Some((total_sales - prev_sales) / prev_sales * 100.0)
        } else {
            None
        };
        rows.push(TopProjectRow {
            project_id: project.id,
            project_name: if entry.project_name.is_empty() {
                project.name.clone()
            } else {
                entry.project_name.clone()
            },
            total_sales,
            total_ad_spend,
            total_orders,
            change,
        });
    }
    rows.sort_by(|a, b| b.total_sales.total_cmp(&a.total_sales));
    rows.truncate(MAX_ROWS);
    rows
}

// ----------------------------------------------------------------------------
// 数字格式化（对齐 frontend `lib/dashboard-format.tsx`）
// ----------------------------------------------------------------------------

/// 千分位 + 固定小数位（对齐 frontend `toLocaleString('zh-CN')` 展示口径）。
fn format_number(value: f64, decimals: usize) -> String {
    let negative = value < 0.0;
    let scale = 10f64.powi(decimals as i32);
    let rounded = (value.abs() * scale).round() / scale;
    let integer = rounded.trunc() as u64;
    let frac = rounded.fract();

    let int_str = integer.to_string();
    let mut out = String::with_capacity(int_str.len() + int_str.len() / 3 + decimals + 1);
    for (i, ch) in int_str.chars().enumerate() {
        if i > 0 && (int_str.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    if decimals > 0 {
        out.push('.');
        let frac_val = (frac * scale).round() as u64;
        out.push_str(&format!("{frac_val:0width$}", width = decimals));
    }
    if negative {
        out.insert(0, '-');
    }
    out
}

/// 详细金额（2 位小数，`$` 前缀 + 千分位）——对齐 frontend `fmtMoneyPrecise`
pub fn fmt_money_precise(v: f64) -> String {
    format!("${}", format_number(v, 2))
}

/// 详细数量（千分位）——对齐 frontend `fmtNumPrecise`
pub fn fmt_num_precise(v: i64) -> String {
    format_number(v as f64, 0)
}

/// 环比走势分类（对齐 frontend `renderChangeIndicator` 的阈值 ±0.5）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeTrend {
    /// 无对比数据（显示「—」）
    NoData,
    /// change > 0.5 → 绿 ↑
    Up,
    /// change < -0.5 → 红 ↓
    Down,
    /// |change| ≤ 0.5 → 灰 —
    Flat,
}

pub fn change_trend(change: Option<f64>) -> ChangeTrend {
    match change {
        None => ChangeTrend::NoData,
        Some(v) if v > 0.5 => ChangeTrend::Up,
        Some(v) if v < -0.5 => ChangeTrend::Down,
        Some(_) => ChangeTrend::Flat,
    }
}

// ----------------------------------------------------------------------------
// Table delegate
// ----------------------------------------------------------------------------

fn is_sortable_col(col_ix: usize) -> bool {
    matches!(col_ix, COL_SALES | COL_AD_SPEND | COL_ORDERS)
}

/// Top 项目表格的数据委托（gpui-component `TableDelegate`）
///
/// - 排序状态（当前列 + 方向）维护在 `columns[].sort`（表头图标反射来源）与
///   `sort_col` / `sort_dir`（数据排序依据）两处，两者始终同步；
/// - 表头点击（label 区域）与内建排序图标走同一套状态转移（`apply_sort_state`），
///   两种入口结果一致。
struct TopProjectsDelegate {
    /// 当前显示顺序（按 `sort_col` / `sort_dir` 排序后的行）
    rows: Vec<TopProjectRow>,
    /// 列定义（`sort` 字段反映当前排序状态，表头图标据此渲染）
    columns: Vec<Column>,
    /// 当前排序列；初始 = 销售额
    sort_col: usize,
    /// 当前排序方向（Ascending / Descending；Default 只作为 `columns[].sort` 反射值出现）
    sort_dir: ColumnSort,
}

impl TopProjectsDelegate {
    fn new(rows: Vec<TopProjectRow>) -> Self {
        let mut columns = Self::columns();
        // 默认排序：销售额降序（表头初始即显示降序箭头）
        columns[COL_SALES].sort = Some(ColumnSort::Descending);
        let mut this = Self {
            rows,
            columns,
            sort_col: COL_SALES,
            sort_dir: ColumnSort::Descending,
        };
        this.apply_sort();
        this
    }

    fn columns() -> Vec<Column> {
        vec![
            Column::new("project", "项目")
                .width(px(200.))
                .resizable(false)
                .movable(false)
                .selectable(false),
            Column::new("sales", "销售额").width(px(120.)).text_right().sortable(),
            Column::new("ad_spend", "广告花费")
                .width(px(120.))
                .text_right()
                .sortable(),
            Column::new("orders", "订单量").width(px(90.)).text_right().sortable(),
            Column::new("change", "环比")
                .width(px(110.))
                .text_right()
                .selectable(false),
        ]
    }

    /// 数据刷新：替换行并保留当前排序
    fn set_rows(&mut self, rows: Vec<TopProjectRow>) {
        self.rows = rows;
        self.apply_sort();
    }

    /// 按当前排序列 / 方向重排行
    fn apply_sort(&mut self) {
        match (self.sort_col, self.sort_dir) {
            (COL_SALES, ColumnSort::Ascending) => {
                self.rows.sort_by(|a, b| a.total_sales.total_cmp(&b.total_sales))
            }
            (COL_SALES, _) => self
                .rows
                .sort_by(|a, b| b.total_sales.total_cmp(&a.total_sales)),
            (COL_AD_SPEND, ColumnSort::Ascending) => self
                .rows
                .sort_by(|a, b| a.total_ad_spend.total_cmp(&b.total_ad_spend)),
            (COL_AD_SPEND, _) => self
                .rows
                .sort_by(|a, b| b.total_ad_spend.total_cmp(&a.total_ad_spend)),
            (COL_ORDERS, ColumnSort::Ascending) => {
                self.rows.sort_by_key(|r| r.total_orders)
            }
            (COL_ORDERS, _) => {
                self.rows.sort_by_key(|r| std::cmp::Reverse(r.total_orders))
            }
            _ => self
                .rows
                .sort_by(|a, b| b.total_sales.total_cmp(&a.total_sales)),
        }
    }

    /// 表头点击的排序切换：与 TableState 内建排序图标的循环一致
    /// （Ascending → Default → Descending → Ascending → …，Default 回到默认排序）。
    /// 读取的是列当前**显示**的排序状态（与 TableState 读 col_groups 一致），
    /// 保证表头点击与图标点击从任意状态出发结果都相同。
    fn toggle_sort(&mut self, col_ix: usize) {
        let current = self
            .columns
            .get(col_ix)
            .and_then(|c| c.sort)
            .unwrap_or(ColumnSort::Default);
        let next = match current {
            ColumnSort::Ascending => ColumnSort::Default,
            ColumnSort::Descending => ColumnSort::Ascending,
            ColumnSort::Default => ColumnSort::Descending,
        };
        self.apply_sort_state(col_ix, next);
    }

    /// 应用一次排序状态（TableState 内建排序图标与表头点击共用）：
    /// 同步列反射状态（`columns[].sort`）与数据排序状态（`sort_col` / `sort_dir`）。
    fn apply_sort_state(&mut self, col_ix: usize, sort: ColumnSort) {
        // 列反射：点击列取新状态，其余可排序列回到未排序（Default）；不可排序列保持 None
        for (ix, col) in self.columns.iter_mut().enumerate() {
            if is_sortable_col(ix) {
                col.sort = Some(if ix == col_ix { sort } else { ColumnSort::Default });
            }
        }
        match sort {
            ColumnSort::Default => {
                // 回到默认排序：销售额降序（数据层），列反射全部为未排序
                self.sort_col = COL_SALES;
                self.sort_dir = ColumnSort::Descending;
            }
            ColumnSort::Ascending | ColumnSort::Descending => {
                self.sort_col = col_ix;
                self.sort_dir = sort;
            }
        }
        self.apply_sort();
    }
}

impl TableDelegate for TopProjectsDelegate {
    fn columns_count(&self, _: &App) -> usize {
        self.columns.len()
    }

    fn rows_count(&self, _: &App) -> usize {
        self.rows.len()
    }

    fn column(&self, col_ix: usize, _: &App) -> &Column {
        &self.columns[col_ix]
    }

    /// 内建排序图标点击 → TableState 已更新列状态后回调本方法，保持 delegate 同步
    fn perform_sort(
        &mut self,
        col_ix: usize,
        sort: ColumnSort,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) {
        self.apply_sort_state(col_ix, sort);
        cx.notify();
    }

    /// 表头渲染：整列可点击切换排序（「表头点击切换排序」完成定义）
    fn render_th(
        &mut self,
        col_ix: usize,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        let name = self.columns[col_ix].name.clone();
        let sortable = is_sortable_col(col_ix);
        let theme = cx.theme().clone();
        h_flex()
            .id(("th", col_ix))
            .items_center()
            .gap_1()
            .text_color(theme.muted_foreground)
            .when(sortable, |this| {
                this.cursor(CursorStyle::PointingHand)
                    .text_color(theme.foreground)
                    .on_click(cx.listener(move |table, _, _, cx| {
                        table.delegate_mut().toggle_sort(col_ix);
                        // 重新读取 column() 反射出的排序状态 → 表头排序图标同步
                        table.refresh(cx);
                        cx.notify();
                    }))
            })
            .child(div().child(name))
    }

    fn render_td(
        &mut self,
        row_ix: usize,
        col_ix: usize,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        let row = &self.rows[row_ix];
        let theme = cx.theme().clone();
        match col_ix {
            COL_PROJECT => div()
                .text_size(px(14.))
                .font_weight(FontWeight::MEDIUM)
                .truncate()
                .child(row.project_name.clone())
                .into_any_element(),
            COL_SALES => div()
                .text_right()
                .text_size(px(14.))
                .child(fmt_money_precise(row.total_sales))
                .into_any_element(),
            COL_AD_SPEND => div()
                .text_right()
                .text_size(px(14.))
                .text_color(theme.muted_foreground)
                .child(fmt_money_precise(row.total_ad_spend))
                .into_any_element(),
            COL_ORDERS => div()
                .text_right()
                .text_size(px(14.))
                .text_color(theme.muted_foreground)
                .child(fmt_num_precise(row.total_orders))
                .into_any_element(),
            COL_CHANGE => render_change_cell(row.change, &theme).into_any_element(),
            _ => div().into_any_element(),
        }
    }

    /// 空态：Store 图标 + 文案（对齐 frontend「暂无项目数据」）
    fn render_empty(
        &mut self,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap_2()
            .text_color(cx.theme().muted_foreground)
            .child(Icon::new(Icon::empty()).path("icons/store.svg").with_size(px(24.)))
            .child(div().text_size(px(13.)).child("暂无项目数据"))
            .into_any_element()
    }
}

/// 环比单元格：图标 + 数值（绿 ↑ / 红 ↓ / 灰 — / 无数据 —）
fn render_change_cell(change: Option<f64>, theme: &Theme) -> impl IntoElement {
    let (icon, color, text) = match change_trend(change) {
        ChangeTrend::Up => (
            IconName::ArrowUp,
            theme.green,
            format!("{:.1}%", change.unwrap_or(0.0)),
        ),
        ChangeTrend::Down => (
            IconName::ArrowDown,
            theme.red,
            format!("{:.1}%", change.unwrap_or(0.0)),
        ),
        ChangeTrend::Flat => (
            IconName::Minus,
            theme.muted_foreground,
            format!("{:.1}%", change.unwrap_or(0.0)),
        ),
        ChangeTrend::NoData => (IconName::Minus, theme.muted_foreground, "—".to_string()),
    };
    h_flex()
        .w_full()
        .justify_end()
        .items_center()
        .gap_1()
        .text_size(px(12.))
        .text_color(color)
        .child(Icon::new(icon).with_size(px(12.)).text_color(color))
        .child(div().child(text))
}

// ----------------------------------------------------------------------------
// Widget
// ----------------------------------------------------------------------------

/// Top 项目列表 Widget：持有 `TableState`（懒创建，首个渲染帧建表），
/// 数据通过 `set_data` 注入（来自 `DashboardData::top_projects()`）。
pub struct TopProjectsWidget {
    /// gpui-component 表格状态（需要 Window 才能创建，首个渲染帧懒建）
    table: Option<Entity<TableState<TopProjectsDelegate>>>,
    /// 待建表 / 已建表共享的行数据（set_data 先落这里）
    rows: Vec<TopProjectRow>,
}

impl TopProjectsWidget {
    pub fn new() -> Self {
        Self {
            table: None,
            rows: Vec::new(),
        }
    }

    /// 注入 Top 项目行（已按销售额降序取 Top N）。无变化时跳过（幂等）。
    pub fn set_data(&mut self, rows: Vec<TopProjectRow>, cx: &mut Context<Self>) {
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

    /// 当前行数据（只读；测试 / 后续消费者用）
    /// `rows()` 仅被测试（含 views/dashboard.rs 的视图级测试）消费，主流程走 TableState，
    /// 故对非 test 构建标注 allow(dead_code)。
    #[allow(dead_code)]
    pub fn rows(&self) -> &[TopProjectRow] {
        &self.rows
    }
}

impl Default for TopProjectsWidget {
    fn default() -> Self {
        Self::new()
    }
}

impl Render for TopProjectsWidget {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let table = self.table.get_or_insert_with(|| {
            let delegate = TopProjectsDelegate::new(self.rows.clone());
            cx.new(|cx| TableState::new(delegate, window, cx))
        });
        let theme = cx.theme().clone();
        v_flex()
            .id("top-projects")
            .size_full()
            .gap_3()
            .child(
                v_flex()
                    .gap_1()
                    .pb_3()
                    .border_b_1()
                    .border_color(theme.border)
                    .child(
                        div()
                            .text_lg()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.foreground)
                            .child("项目排行"),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .child("各项目销售额与广告花费对比（近 7 天）"),
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
    use chrono::NaiveDate;
    use gui_domain::dashboard::DailyAnalysisRow;

    // ---------- 测试数据构造 ----------

    fn project(id: i64, name: &str) -> ManagedProject {
        ManagedProject {
            id,
            name: name.to_string(),
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

    fn row(date: &str, order_qty: i64, sales: f64, ad_spend: f64) -> DailyAnalysisRow {
        DailyAnalysisRow {
            date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            order_qty,
            sales_amount: sales,
            impressions: 0,
            clicks: 0,
            cpc: 0.0,
            ad_spend,
            ad_orders: 0,
            available_qty: 0,
            page_views: 0,
            units_ordered: 0,
            sessions: 0,
            ordered_sales_amount: 0.0,
            conversion_rate: 0.0,
        }
    }

    fn entry(name: &str, rows: Vec<DailyAnalysisRow>) -> ProjectBreakdownEntry {
        ProjectBreakdownEntry {
            project_name: name.to_string(),
            summary_rows: rows,
            detail_rows: Vec::new(),
        }
    }

    fn sample_rows() -> Vec<TopProjectRow> {
        vec![
            TopProjectRow {
                project_id: 1,
                project_name: "项目 A".into(),
                total_sales: 3000.0,
                total_ad_spend: 150.0,
                total_orders: 30,
                change: Some(10.5),
            },
            TopProjectRow {
                project_id: 2,
                project_name: "项目 B".into(),
                total_sales: 5000.0,
                total_ad_spend: 250.0,
                total_orders: 50,
                change: None,
            },
            TopProjectRow {
                project_id: 3,
                project_name: "项目 C".into(),
                total_sales: 1000.0,
                total_ad_spend: 60.0,
                total_orders: 10,
                change: Some(-3.2),
            },
        ]
    }

    // ---------- compute_top_projects（纯函数） ----------

    #[test]
    fn compute_aggregates_and_sorts_by_sales_desc() {
        let mut breakdown = HashMap::new();
        breakdown.insert(
            1,
            entry(
                "项目 A",
                vec![row("2026-08-12", 10, 1000.0, 50.0), row("2026-08-13", 20, 2000.0, 100.0)],
            ),
        );
        breakdown.insert(
            2,
            entry(
                "项目 B",
                vec![row("2026-08-13", 50, 5000.0, 250.0)],
            ),
        );
        let projects = vec![project(1, "A"), project(2, "B")];

        let rows = compute_top_projects(&breakdown, None, &projects);
        assert_eq!(rows.len(), 2);
        // 默认按销售额降序
        assert_eq!(rows[0].project_id, 2);
        assert_eq!(rows[0].project_name, "项目 B");
        assert_eq!(rows[0].total_sales, 5000.0);
        assert_eq!(rows[0].total_orders, 50);
        assert_eq!(rows[1].project_id, 1);
        // 跨多行聚合
        assert_eq!(rows[1].total_sales, 3000.0);
        assert_eq!(rows[1].total_ad_spend, 150.0);
        assert_eq!(rows[1].total_orders, 30);
        // 无对比期 → change 为 None
        assert_eq!(rows[0].change, None);
    }

    #[test]
    fn compute_skips_missing_and_empty_breakdown_entries() {
        let mut breakdown = HashMap::new();
        // 项目 1 有数据；项目 2 无条目；项目 3 有条目但 summary_rows 为空
        breakdown.insert(1, entry("项目 A", vec![row("2026-08-13", 5, 500.0, 0.0)]));
        breakdown.insert(3, entry("项目 C", Vec::new()));
        let projects = vec![project(1, "A"), project(2, "B"), project(3, "C")];

        let rows = compute_top_projects(&breakdown, None, &projects);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].project_id, 1);
    }

    #[test]
    fn compute_falls_back_to_project_name_when_breakdown_name_empty() {
        let mut breakdown = HashMap::new();
        breakdown.insert(1, entry("", vec![row("2026-08-13", 5, 500.0, 0.0)]));
        let projects = vec![project(1, "兜底名")];
        let rows = compute_top_projects(&breakdown, None, &projects);
        assert_eq!(rows[0].project_name, "兜底名");
    }

    #[test]
    fn compute_change_from_compare_period() {
        let mut breakdown = HashMap::new();
        breakdown.insert(1, entry("项目 A", vec![row("2026-08-13", 5, 1100.0, 0.0)]));
        let mut compare = HashMap::new();
        compare.insert(1, entry("项目 A", vec![row("2026-08-06", 5, 1000.0, 0.0)]));

        let projects = vec![project(1, "A")];
        let rows = compute_top_projects(&breakdown, Some(&compare), &projects);
        // (1100 - 1000) / 1000 × 100 = 10%
        assert_eq!(rows[0].change, Some(10.0));

        // 对比期为 0 → None
        let mut compare_zero = HashMap::new();
        compare_zero.insert(1, entry("项目 A", vec![row("2026-08-06", 0, 0.0, 0.0)]));
        let rows = compute_top_projects(&breakdown, Some(&compare_zero), &projects);
        assert_eq!(rows[0].change, None);

        // 对比期缺该项目 → None
        let rows = compute_top_projects(&breakdown, Some(&HashMap::new()), &projects);
        assert_eq!(rows[0].change, None);
    }

    #[test]
    fn compute_truncates_to_max_rows() {
        let mut breakdown = HashMap::new();
        let mut projects = Vec::new();
        for i in 1..=10 {
            breakdown.insert(
                i,
                entry(&format!("项目 {i}"), vec![row("2026-08-13", 1, i as f64 * 100.0, 0.0)]),
            );
            projects.push(project(i, &format!("项目 {i}")));
        }
        let rows = compute_top_projects(&breakdown, None, &projects);
        assert_eq!(rows.len(), MAX_ROWS);
        // Top 6 = 项目 10..5
        assert_eq!(rows[0].project_id, 10);
        assert_eq!(rows[MAX_ROWS - 1].project_id, 5);
    }

    // ---------- 数字格式化 ----------

    #[test]
    fn fmt_money_precise_matches_frontend() {
        assert_eq!(fmt_money_precise(3100.5), "$3,100.50");
        assert_eq!(fmt_money_precise(0.0), "$0.00");
        assert_eq!(fmt_money_precise(1234567.891), "$1,234,567.89");
        assert_eq!(fmt_money_precise(42.0), "$42.00");
        assert_eq!(fmt_money_precise(999.999), "$1,000.00");
        assert_eq!(fmt_money_precise(-1234.5), "$-1,234.50");
    }

    #[test]
    fn fmt_num_precise_matches_frontend() {
        assert_eq!(fmt_num_precise(1234), "1,234");
        assert_eq!(fmt_num_precise(42), "42");
        assert_eq!(fmt_num_precise(1234567), "1,234,567");
        assert_eq!(fmt_num_precise(0), "0");
    }

    #[test]
    fn change_trend_thresholds_match_frontend() {
        assert_eq!(change_trend(None), ChangeTrend::NoData);
        assert_eq!(change_trend(Some(0.6)), ChangeTrend::Up);
        assert_eq!(change_trend(Some(-0.6)), ChangeTrend::Down);
        assert_eq!(change_trend(Some(0.5)), ChangeTrend::Flat);
        assert_eq!(change_trend(Some(-0.5)), ChangeTrend::Flat);
        assert_eq!(change_trend(Some(0.0)), ChangeTrend::Flat);
    }

    // ---------- delegate 排序（不依赖网络 / 窗口） ----------

    fn delegate_with_rows() -> TopProjectsDelegate {
        TopProjectsDelegate::new(sample_rows())
    }

    fn row_ids(d: &TopProjectsDelegate) -> Vec<i64> {
        d.rows.iter().map(|r| r.project_id).collect()
    }

    #[test]
    fn delegate_default_sort_is_sales_desc() {
        let d = delegate_with_rows();
        // 初始：销售额降序（5000 → 3000 → 1000）
        assert_eq!(row_ids(&d), vec![2, 1, 3]);
        // 销售额列反映降序图标状态
        assert_eq!(d.columns[COL_SALES].sort, Some(ColumnSort::Descending));
        // 其余可排序列显示未排序状态；不可排序列无排序图标
        assert_eq!(d.columns[COL_AD_SPEND].sort, Some(ColumnSort::Default));
        assert_eq!(d.columns[COL_ORDERS].sort, Some(ColumnSort::Default));
        assert_eq!(d.columns[COL_PROJECT].sort, None);
        assert_eq!(d.columns[COL_CHANGE].sort, None);
    }

    #[test]
    fn delegate_toggle_sort_cycles_columns_and_directions() {
        let mut d = delegate_with_rows();

        // 点「广告花费」：从默认 → 降序
        d.toggle_sort(COL_AD_SPEND);
        assert_eq!(d.sort_col, COL_AD_SPEND);
        assert_eq!(d.sort_dir, ColumnSort::Descending);
        // 广告花费 250(B) > 150(A) > 60(C)
        assert_eq!(row_ids(&d), vec![2, 1, 3]);

        // 再点：升序
        d.toggle_sort(COL_AD_SPEND);
        assert_eq!(d.sort_dir, ColumnSort::Ascending);
        assert_eq!(row_ids(&d), vec![3, 1, 2]);

        // 再点：回到默认（销售额降序）
        d.toggle_sort(COL_AD_SPEND);
        assert_eq!(d.sort_col, COL_SALES);
        assert_eq!(d.sort_dir, ColumnSort::Descending);
        assert_eq!(row_ids(&d), vec![2, 1, 3]);
    }

    #[test]
    fn delegate_toggle_sort_orders_column() {
        let mut d = delegate_with_rows();
        d.toggle_sort(COL_ORDERS);
        // 订单量 50(B) > 30(A) > 10(C)
        assert_eq!(row_ids(&d), vec![2, 1, 3]);
        d.toggle_sort(COL_ORDERS);
        assert_eq!(row_ids(&d), vec![3, 1, 2]);
    }

    #[test]
    fn delegate_perform_sort_applies_given_state_like_builtin_icon() {
        let mut d = delegate_with_rows();
        // 内建排序图标路径：TableState 传过来的是下一步状态
        d.apply_sort_state(COL_ORDERS, ColumnSort::Ascending);
        assert_eq!(d.sort_col, COL_ORDERS);
        assert_eq!(row_ids(&d), vec![3, 1, 2]);
        // Default → 回到默认排序
        d.apply_sort_state(COL_ORDERS, ColumnSort::Default);
        assert_eq!(d.sort_col, COL_SALES);
        assert_eq!(row_ids(&d), vec![2, 1, 3]);
    }

    #[test]
    fn delegate_set_rows_preserves_current_sort() {
        let mut d = delegate_with_rows();
        d.toggle_sort(COL_AD_SPEND); // 广告花费降序
        d.set_rows(vec![
            TopProjectRow {
                project_id: 9,
                project_name: "新项目".into(),
                total_sales: 900.0,
                total_ad_spend: 999.0,
                total_orders: 1,
                change: None,
            },
            TopProjectRow {
                project_id: 8,
                project_name: "新项目 2".into(),
                total_sales: 800.0,
                total_ad_spend: 1.0,
                total_orders: 1,
                change: None,
            },
        ]);
        // 新数据仍按广告花费降序
        assert_eq!(row_ids(&d), vec![9, 8]);
    }

    // ---------- 渲染冒烟（TestAppContext + 真实窗口） ----------

    #[gpui::test]
    async fn widget_renders_table_with_rows_and_empty(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let rows = sample_rows();

        // 有数据：add_window_view 内部 run_until_parked 已完成首帧渲染（懒建表）
        let (view, cx) = cx.add_window_view(|_window, cx| {
            let mut widget = TopProjectsWidget::new();
            widget.set_data(rows.clone(), cx);
            widget
        });
        let count = cx.read(|app| {
            view.read(app)
                .table
                .as_ref()
                .map(|t| t.read(app).delegate().rows_count(app))
                .unwrap_or(0)
        });
        assert_eq!(count, rows.len());

        // 空数据：set_data 后表格行数为 0
        view.update(cx, |widget, cx| widget.set_data(Vec::new(), cx));
        let count = cx.read(|app| {
            view.read(app)
                .table
                .as_ref()
                .map(|t| t.read(app).delegate().rows_count(app))
                .unwrap_or(0)
        });
        assert_eq!(count, 0);
    }
}
