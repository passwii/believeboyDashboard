//! 财务资金 → 平台回款视图（P3-4，BLF-704）
//!
//! frontend `app/dashboard/finance/platform-revenue/page.tsx` 的 GPUI 等价：
//! 项目/年份/月份/币种筛选 + 回款列表 + 合计行 + 分页。
//!
//! 架构（沿用 Phase 1/2/3 基建）：
//! - **四态状态机**：`Loading / Loaded / Empty / Error`（沿用 `dashboard.rs` 模式），
//!   `latest_request_id` 竞态保护；
//! - **数据管线**：`list_managed_projects` → `list_platform_revenues`（分页 + 筛选）；
//! - **合计行**：按币种分组求和（对齐 frontend `calculateTotals` / `formatTotals`）；
//! - **分页**：上一页 / 下一页 + 每页条数（对齐 frontend pagination 语义）。
//!
//! 已知差异（有意保留，GPUI 0.2 能力边界 / P3-4 范围）：
//! - 只读视图：新增 / 编辑 / 删除 / 导出 / 附件预览不接入（frontend 有，P3-4 不做）；
//! - `revenue_type` 筛选前端传入但 backend list 端点未消费，GUI 侧对齐后端契约省略
//!   （回款类型仅作列表展示列）；
//! - 币种 Badge / 站点 Badge 的渐变配色简化为语义色块（亮暗自适应）。

use chrono::Datelike;
use gpui::{
    div, prelude::*, px, App, AsyncApp, Context, Entity, FontWeight, Render, SharedString,
    WeakEntity, Window,
};
use gpui_component::{
    button::Button,
    h_flex,
    menu::{DropdownMenu, PopupMenuItem},
    table::{Column, Table, TableDelegate, TableState},
    v_flex, Icon, IconName, Sizable,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::finance::PlatformRevenueItem;

use crate::theme::AppTheme;
use crate::widgets::layout::content_guard;
use crate::widgets::state_views::{self, SkeletonBlock};
use crate::widgets::page_header::PageHeader;

/// 本页在侧栏中的 URL（root.rs 据此路由到本视图；与 gui-domain::sidebar 的平台回款条目一致）
pub const PLATFORM_REVENUE_URL: &str = "/dashboard/finance/platform-revenue";

/// 币种选项（对齐 frontend `CURRENCY_OPTIONS`：USD / GBP / EUR）
const CURRENCY_OPTIONS: [(&str, &str); 3] = [
    ("USD", "USD - 美元"),
    ("GBP", "GBP - 英镑"),
    ("EUR", "EUR - 欧元"),
];

/// 币种符号（对齐 frontend `getCurrencyBadgeMeta`）
pub fn currency_symbol(currency: &str) -> &'static str {
    match currency {
        "GBP" => "£",
        "EUR" => "€",
        _ => "$",
    }
}

/// 币种展示名
pub fn currency_label(currency: &str) -> String {
    CURRENCY_OPTIONS
        .iter()
        .find(|(value, _)| *value == currency)
        .map_or_else(|| currency.to_string(), |(_, label)| label.to_string())
}

/// 站点展示名（对齐 frontend `getCountryBadgeMeta` 的 accent）
pub fn country_label(country: &str) -> String {
    match country {
        "US" => "美国".to_string(),
        "UK" => "英国".to_string(),
        "DE" => "德国".to_string(),
        "CA" => "加拿大".to_string(),
        "JP" => "日本".to_string(),
        "AU" => "澳大利亚".to_string(),
        "MX" => "墨西哥".to_string(),
        "BR" => "巴西".to_string(),
        _ => country.to_string(),
    }
}

/// 年份选项（当前年 -2 ~ 当前年 +2，对齐 frontend `getYearOptions`）
pub fn year_options() -> Vec<(i64, String)> {
    let current = chrono::Local::now().year() as i64;
    (current - 2..=current + 2)
        .map(|y| (y, format!("{y}年")))
        .collect()
}

/// 月份选项（1~12 月，对齐 frontend `MONTH_OPTIONS`）
pub const MONTH_OPTIONS: [(i64, &str); 12] = [
    (1, "1月"),
    (2, "2月"),
    (3, "3月"),
    (4, "4月"),
    (5, "5月"),
    (6, "6月"),
    (7, "7月"),
    (8, "8月"),
    (9, "9月"),
    (10, "10月"),
    (11, "11月"),
    (12, "12月"),
];

/// 每页条数选项
const PAGE_SIZE_OPTIONS: [i64; 4] = [20, 50, 100, 200];

/// 默认每页条数（对齐 frontend page_size=20）
const DEFAULT_PAGE_SIZE: i64 = 20;

/// 金额解析（Decimal 字符串 → f64；对齐 frontend `parseFloat`）
pub fn parse_amount(raw: &str) -> f64 {
    raw.parse::<f64>().unwrap_or(0.0)
}

/// 金额格式化（千分位 + 货币符号；对齐 frontend `formatCurrency`）
pub fn format_amount(amount: f64, currency: &str) -> String {
    let symbol = currency_symbol(currency);
    let abs = amount.abs();
    let int_part = abs.trunc() as i64;
    let frac = ((abs - int_part as f64) * 100.0).round() as i64;
    let int_str = int_part.to_string();
    let mut out = String::with_capacity(int_str.len() + int_str.len() / 3 + 6);
    for (i, ch) in int_str.chars().enumerate() {
        if i > 0 && (int_str.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    let sign = if amount < 0.0 { "-" } else { "" };
    format!("{sign}{symbol}{out}.{frac:02}")
}

/// 合计行条目（按币种分组合计；对齐 frontend `calculateTotals` / `formatTotals`）
#[derive(Debug, Clone, PartialEq)]
pub struct TotalsEntry {
    pub currency: String,
    pub total: f64,
}

/// 按币种分组求和（frontend `calculateTotals` 等价；按币种选项顺序排列）
pub fn calculate_totals(items: &[PlatformRevenueItem]) -> Vec<TotalsEntry> {
    let mut entries: Vec<TotalsEntry> = Vec::new();
    for item in items {
        let currency = if item.currency.is_empty() {
            "USD"
        } else {
            &item.currency
        };
        let amount = parse_amount(&item.amount);
        match entries.iter_mut().find(|e| e.currency == currency) {
            Some(entry) => entry.total += amount,
            None => entries.push(TotalsEntry {
                currency: currency.to_string(),
                total: amount,
            }),
        }
    }
    // 固定顺序：USD → GBP → EUR → 其他（对齐 frontend 币种选项顺序）
    let mut ordered: Vec<TotalsEntry> = CURRENCY_OPTIONS
        .iter()
        .filter_map(|(code, _)| {
            entries
                .iter()
                .find(|e| e.currency == *code)
                .cloned()
        })
        .collect();
    for e in entries.iter() {
        if !CURRENCY_OPTIONS.iter().any(|(code, _)| code == &e.currency) {
            ordered.push(e.clone());
        }
    }
    ordered
}

/// 合计行文本（frontend `formatTotals` 等价："$X.XX | £Y.YY"）
pub fn format_totals(entries: &[TotalsEntry]) -> String {
    entries
        .iter()
        .map(|e| format_amount(e.total, &e.currency))
        .collect::<Vec<_>>()
        .join("  |  ")
}

/// 回款日期展示（YYYY-MM-DD → YYYY年M月D日）
pub fn format_date(date: &chrono::NaiveDate) -> String {
    format!("{}年{}月{}日", date.year(), date.month(), date.day())
}

/// 平台回款数据（Loaded 态载荷）
#[derive(Debug, Clone, PartialEq)]
pub struct PlatformRevenueData {
    pub projects: Vec<ManagedProject>,
    pub items: Vec<PlatformRevenueItem>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub total_pages: i64,
    /// 筛选状态（渲染 + reload 用）
    pub filters: Filters,
}

impl PlatformRevenueData {
    /// 空态判定（无项目，或没有任何回款条目）
    pub fn is_empty(&self) -> bool {
        self.projects.is_empty() || self.items.is_empty()
    }
}

/// 筛选条件（对齐 frontend `Filters`；`revenue_type` 因后端不消费而省略）
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Filters {
    pub project_id: Option<i64>,
    pub year: Option<i64>,
    pub month: Option<i64>,
    pub currency: Option<String>,
}

/// 平台回款状态机（四态）
#[derive(Debug, Clone, PartialEq)]
pub enum PlatformRevenueState {
    Loading,
    Loaded(PlatformRevenueData),
    Empty,
    Error(String),
}

impl PlatformRevenueState {
    /// 拉取结果 → 落点状态（唯一合法的「拉取完成」转移）
    pub fn from_fetch_result(result: Result<PlatformRevenueData, String>) -> Self {
        match result {
            Ok(data) if data.is_empty() => Self::Empty,
            Ok(data) => Self::Loaded(data),
            Err(msg) => Self::Error(msg),
        }
    }

    /// 当前态 total_pages（分页边界判断用；非 Loaded 视为 1）
    pub fn total_pages(&self) -> i64 {
        match self {
            PlatformRevenueState::Loaded(data) => data.total_pages.max(1),
            _ => 1,
        }
    }
}

/// 平台回款视图（状态机 + 筛选 + 分页 + 竞态保护）
pub struct PlatformRevenueView {
    state: Entity<PlatformRevenueState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表（reload 刷新；筛选菜单数据源）
    projects: Vec<ManagedProject>,
    /// 当前筛选
    filters: Filters,
    /// 当前页码
    page: i64,
    /// 每页条数
    page_size: i64,
    /// 请求竞态保护
    latest_request_id: u64,
    /// 回款列表表（懒建 TableState）
    table: Entity<RevenueTable>,
}

/// 筛选键（set_filter 分派）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterKey {
    Project,
    Year,
    Month,
    Currency,
}

impl PlatformRevenueView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| PlatformRevenueState::Loading);
        let table = cx.new(|_| RevenueTable::new());
        Self {
            state,
            client,
            projects: Vec::new(),
            filters: Filters::default(),
            page: 1,
            page_size: DEFAULT_PAGE_SIZE,
            latest_request_id: 0,
            table,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> PlatformRevenueState {
        self.state.read(cx).clone()
    }

    /// 重新拉取数据：筛选/分页切换、错误重试、空态刷新共用入口（竞态保护）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let page = self.page;
        let page_size = self.page_size;
        let filters = self.filters.clone();

        self.state.update(cx, |state, cx| {
            *state = PlatformRevenueState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(load_platform_revenues(&client, page, page_size, &filters))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 设置筛选并回到第 1 页 → reload
    pub fn set_filter(&mut self, filter: FilterKey, value: Option<&str>, cx: &mut Context<Self>) {
        let changed = match filter {
            FilterKey::Project => {
                let parsed = value.and_then(|v| v.parse::<i64>().ok());
                if parsed != self.filters.project_id {
                    self.filters.project_id = parsed;
                    true
                } else {
                    false
                }
            }
            FilterKey::Year => {
                let parsed = value.and_then(|v| v.parse::<i64>().ok());
                if parsed != self.filters.year {
                    self.filters.year = parsed;
                    true
                } else {
                    false
                }
            }
            FilterKey::Month => {
                let parsed = value.and_then(|v| v.parse::<i64>().ok());
                if parsed != self.filters.month {
                    self.filters.month = parsed;
                    true
                } else {
                    false
                }
            }
            FilterKey::Currency => {
                let parsed = value.map(|v| v.to_string());
                if parsed != self.filters.currency {
                    self.filters.currency = parsed;
                    true
                } else {
                    false
                }
            }
        };
        if !changed {
            return;
        }
        self.page = 1;
        self.reload(cx);
    }

    /// 重置全部筛选（对齐 frontend `resetFilters`：全部回到空 + 第 1 页）
    pub fn reset_filters(&mut self, cx: &mut Context<Self>) {
        let empty = Filters::default();
        if empty == self.filters {
            return;
        }
        self.filters = empty;
        self.page = 1;
        self.reload(cx);
    }

    /// 上一页
    pub fn previous_page(&mut self, cx: &mut Context<Self>) {
        if self.page <= 1 {
            return;
        }
        self.page -= 1;
        self.reload(cx);
    }

    /// 下一页（边界判断：当前态 total_pages）
    pub fn next_page(&mut self, cx: &mut Context<Self>) {
        let total_pages = self.state.read(cx).total_pages();
        if self.page >= total_pages {
            return;
        }
        self.page += 1;
        self.reload(cx);
    }

    /// 每页条数切换（回到第 1 页）
    pub fn set_page_size(&mut self, page_size: i64, cx: &mut Context<Self>) {
        if page_size == self.page_size {
            return;
        }
        self.page_size = page_size;
        self.page = 1;
        self.reload(cx);
    }

    /// 应用拉取结果：竞态保护（过期响应丢弃）+ Loaded 落点前把行喂给表格组件。
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<PlatformRevenueData, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok(data) = &result {
            if !data.is_empty() {
                self.projects = data.projects.clone();
                let rows = data.items.clone();
                self.table
                    .update(cx, |widget, cx| widget.set_data(rows, cx));
            }
        }
        self.state.update(cx, |state, cx| {
            *state = PlatformRevenueState::from_fetch_result(result);
            cx.notify();
        });
    }
}

/// 拉取平台回款（项目列表 + 分页列表），与视图解耦便于测试。
async fn load_platform_revenues(
    client: &Client,
    page: i64,
    page_size: i64,
    filters: &Filters,
) -> Result<PlatformRevenueData, String> {
    let projects = client
        .list_managed_projects()
        .await
        .map_err(|e| e.user_message())?;

    let resp = client
        .list_platform_revenues(
            page,
            page_size,
            filters.project_id,
            filters.year,
            filters.month,
            None,
            filters.currency.as_deref(),
        )
        .await
        .map_err(|e| e.user_message())?;

    Ok(PlatformRevenueData {
        projects,
        items: resp.items,
        total: resp.total,
        page: resp.page,
        page_size: resp.page_size,
        total_pages: resp.total_pages,
        filters: filters.clone(),
    })
}

impl Render for PlatformRevenueView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let table = self.table.clone();
        let filters = self.filters.clone();
        match state {
            PlatformRevenueState::Loading => render_loading(&app_theme).into_any_element(),
            PlatformRevenueState::Error(msg) => {
                render_error(cx, &app_theme, &msg).into_any_element()
            }
            PlatformRevenueState::Empty => render_empty(cx, &app_theme).into_any_element(),
            PlatformRevenueState::Loaded(data) => render_loaded(
                cx,
                &app_theme,
                &data,
                self.projects.clone(),
                filters,
                self.page,
                self.page_size,
                table,
            )
            .into_any_element(),
        }
    }
}

// ---------------------------------------------------------------------------
// 四态渲染
// ---------------------------------------------------------------------------

/// Loading：筛选骨架 + 表格骨架
///
/// P4-6：骨架块统一走 `state_views::skeleton_loading` 声明式组合。
fn render_loading(app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("platform-revenue-loading")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::skeleton_loading(
            app_theme,
            &[
                SkeletonBlock::Filter(5),
                SkeletonBlock::Table(360.0),
            ],
        ))
}

/// Error：卡片内 Alert + 重试按钮（State 0 公共组件 `state_views::error_state`）
fn render_error(
    cx: &mut Context<PlatformRevenueView>,
    app_theme: &AppTheme,
    msg: &str,
) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("platform-revenue-error")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::error_state(
            &view,
            app_theme,
            "platform-revenue-error",
            "回款数据加载失败",
            msg.to_string(),
            |this, cx| this.reload(cx),
        ))
}

/// Empty：Icon + 文案 + 刷新按钮（State 0 公共组件 `empty_state_with_action`）
fn render_empty(cx: &mut Context<PlatformRevenueView>, app_theme: &AppTheme) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("platform-revenue-empty")
        .size_full()
        .items_center()
        .justify_center()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::empty_state_with_action(
            &view,
            app_theme,
            "platform-revenue-empty",
            "icons/banknote.svg",
            "暂无回款数据",
            "刷新",
            |this, cx| this.reload(cx),
        ))
}

/// Loaded：页面头部 + 筛选栏 + 回款列表表（合计行 + 分页）
#[allow(clippy::too_many_arguments)]
fn render_loaded(
    cx: &mut Context<PlatformRevenueView>,
    app_theme: &AppTheme,
    data: &PlatformRevenueData,
    projects: Vec<ManagedProject>,
    filters: Filters,
    page: i64,
    page_size: i64,
    table: Entity<RevenueTable>,
) -> impl IntoElement {
    let view = cx.entity();
    let totals = calculate_totals(&data.items);
    let totals_text = format_totals(&totals);
    let reduce = crate::motion::reduce_motion(cx);

    // P4-2：页面 enter 轻量 fade-in（一次性；减弱动态时瞬时）
    crate::motion::enter_fade_in(
        gpui::SharedString::from("platform-revenue-loaded-fade"),
        v_flex()
            .id("platform-revenue-loaded")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            // 页面头部（P4-5：共享 PageHeader）
            .child(PageHeader::new("平台回款").subtitle(format!(
                "共 {} 条 · 第 {} / {} 页 · 合计 {}",
                data.total,
                data.page,
                data.total_pages,
                if totals_text.is_empty() {
                    "—".to_string()
                } else {
                    totals_text
                }
            )))
            // 筛选栏（宽窗受内容上限约束）
            .child(content_guard().child(render_filter_bar(
                &view,
                app_theme,
                &projects,
                &filters,
            )))
            // 回款列表表（含合计行；P4-5：数据表格保留全宽）
            .child(table)
            // 分页条
            .child(pagination_bar(
                &view,
                app_theme,
                page,
                data.total_pages,
                page_size,
            )),
        reduce,
    )
}

// ---------------------------------------------------------------------------
// 筛选栏（项目 / 年份 / 月份 / 币种 / 重置）
// ---------------------------------------------------------------------------

/// 筛选栏：项目 + 年份 + 月份 + 币种（DropdownMenu）+ 重置按钮。
fn render_filter_bar(
    view: &Entity<PlatformRevenueView>,
    app_theme: &AppTheme,
    projects: &[ManagedProject],
    filters: &Filters,
) -> impl IntoElement {
    let projects_owned = projects.to_vec();
    let project_label: SharedString = match filters.project_id {
        Some(id) => projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| SharedString::from(p.name.clone()))
            .unwrap_or_else(|| SharedString::from("全部项目")),
        None => SharedString::from("全部项目"),
    };
    let year_label: SharedString = match filters.year {
        Some(y) => SharedString::from(format!("{y}年")),
        None => SharedString::from("全部年份"),
    };
    let month_label: SharedString = match filters.month {
        Some(m) => MONTH_OPTIONS
            .iter()
            .find(|(value, _)| *value == m)
            .map(|(_, label)| SharedString::from(*label))
            .unwrap_or_else(|| SharedString::from("全部月份")),
        None => SharedString::from("全部月份"),
    };
    let currency_label: SharedString = match &filters.currency {
        Some(c) => SharedString::from(currency_label(c)),
        None => SharedString::from("全部币种"),
    };
    let view_for_project = view.clone();
    let view_for_year = view.clone();
    let view_for_month = view.clone();
    let view_for_currency = view.clone();
    let view_for_reset = view.clone();
    let filters_owned = filters.clone();

    h_flex()
        .id("platform-revenue-filters")
        .gap_3()
        .items_center()
        .flex_wrap()
        // 项目
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
                    Button::new("platform-revenue-project-filter")
                        .outline()
                        .small()
                        .label(project_label)
                        .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                        .dropdown_menu_with_anchor(
                            gpui::Corner::BottomLeft,
                            move |menu, _window, _cx| {
                                let mut menu = menu.item(
                                    PopupMenuItem::new("全部项目")
                                        .checked(filters_owned.project_id.is_none())
                                        .on_click({
                                            let view = view_for_project.clone();
                                            move |_, _window, cx| {
                                                view.update(cx, |this, cx| {
                                                    this.set_filter(FilterKey::Project, None, cx)
                                                });
                                            }
                                        }),
                                );
                                for project in &projects_owned {
                                    let checked = filters_owned.project_id == Some(project.id);
                                    let id = project.id;
                                    let name = project.name.clone();
                                    let view = view_for_project.clone();
                                    menu = menu.item(
                                        PopupMenuItem::new(name).checked(checked).on_click(
                                            move |_, _window, cx| {
                                                view.update(cx, |this, cx| {
                                                    this.set_filter(
                                                        FilterKey::Project,
                                                        Some(&id.to_string()),
                                                        cx,
                                                    )
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
        // 年份
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .text_sm()
                        .text_color(app_theme.text_muted)
                        .child("年份"),
                )
                .child(
                    Button::new("platform-revenue-year-filter")
                        .outline()
                        .small()
                        .label(year_label)
                        .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                        .dropdown_menu_with_anchor(
                            gpui::Corner::BottomLeft,
                            move |menu, _window, _cx| {
                                let mut menu = menu.item(
                                    PopupMenuItem::new("全部年份")
                                        .checked(filters_owned.year.is_none())
                                        .on_click({
                                            let view = view_for_year.clone();
                                            move |_, _window, cx| {
                                                view.update(cx, |this, cx| {
                                                    this.set_filter(FilterKey::Year, None, cx)
                                                });
                                            }
                                        }),
                                );
                                for (value, label) in year_options() {
                                    let checked = filters_owned.year == Some(value);
                                    let view = view_for_year.clone();
                                    menu = menu.item(
                                        PopupMenuItem::new(label).checked(checked).on_click(
                                            move |_, _window, cx| {
                                                view.update(cx, |this, cx| {
                                                    this.set_filter(
                                                        FilterKey::Year,
                                                        Some(&value.to_string()),
                                                        cx,
                                                    )
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
        // 月份
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
                    Button::new("platform-revenue-month-filter")
                        .outline()
                        .small()
                        .label(month_label)
                        .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                        .dropdown_menu_with_anchor(
                            gpui::Corner::BottomLeft,
                            move |menu, _window, _cx| {
                                let mut menu = menu.item(
                                    PopupMenuItem::new("全部月份")
                                        .checked(filters_owned.month.is_none())
                                        .on_click({
                                            let view = view_for_month.clone();
                                            move |_, _window, cx| {
                                                view.update(cx, |this, cx| {
                                                    this.set_filter(FilterKey::Month, None, cx)
                                                });
                                            }
                                        }),
                                );
                                for (value, label) in MONTH_OPTIONS {
                                    let checked = filters_owned.month == Some(value);
                                    let view = view_for_month.clone();
                                    menu = menu.item(
                                        PopupMenuItem::new(label).checked(checked).on_click(
                                            move |_, _window, cx| {
                                                view.update(cx, |this, cx| {
                                                    this.set_filter(
                                                        FilterKey::Month,
                                                        Some(&value.to_string()),
                                                        cx,
                                                    )
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
        // 币种
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .text_sm()
                        .text_color(app_theme.text_muted)
                        .child("币种"),
                )
                .child(
                    Button::new("platform-revenue-currency-filter")
                        .outline()
                        .small()
                        .label(currency_label)
                        .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                        .dropdown_menu_with_anchor(
                            gpui::Corner::BottomLeft,
                            move |menu, _window, _cx| {
                                let mut menu = menu.item(
                                    PopupMenuItem::new("全部币种")
                                        .checked(filters_owned.currency.is_none())
                                        .on_click({
                                            let view = view_for_currency.clone();
                                            move |_, _window, cx| {
                                                view.update(cx, |this, cx| {
                                                    this.set_filter(FilterKey::Currency, None, cx)
                                                });
                                            }
                                        }),
                                );
                                for (value, label) in CURRENCY_OPTIONS {
                                    let checked = filters_owned.currency.as_deref() == Some(value);
                                    let view = view_for_currency.clone();
                                    menu = menu.item(
                                        PopupMenuItem::new(label).checked(checked).on_click(
                                            move |_, _window, cx| {
                                                view.update(cx, |this, cx| {
                                                    this.set_filter(
                                                        FilterKey::Currency,
                                                        Some(value),
                                                        cx,
                                                    )
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
        // 重置
        .child(
            Button::new("platform-revenue-reset")
                .outline()
                .small()
                .label("重置")
                .icon(Icon::empty().path("icons/rotate-ccw.svg").with_size(px(12.)))
                .on_click(move |_, _window, cx| {
                    let view = view_for_reset.clone();
                    view.update(cx, |this, cx| this.reset_filters(cx));
                }),
        )
}

// ---------------------------------------------------------------------------
// 回款列表表（gpui-component Table + 合计行）
// ---------------------------------------------------------------------------

/// 列索引（与 `RevenueTableDelegate::columns()` 顺序一致）
const COL_DATE: usize = 0;
const COL_PROJECT: usize = 1;
const COL_COUNTRY: usize = 2;
const COL_AMOUNT: usize = 3;
const COL_CURRENCY: usize = 4;
const COL_TYPE: usize = 5;
const COL_NOTE: usize = 6;

/// 回款列表数据委托（非排序；日期倒序已由后端排好）
struct RevenueTableDelegate {
    rows: Vec<PlatformRevenueItem>,
    columns: Vec<Column>,
}

impl RevenueTableDelegate {
    fn new(rows: Vec<PlatformRevenueItem>) -> Self {
        Self {
            rows,
            columns: Self::columns(),
        }
    }

    fn columns() -> Vec<Column> {
        vec![
            Column::new("date", "回款日期").width(px(128.)).selectable(false),
            Column::new("project", "项目").width(px(160.)),
            Column::new("country", "站点").width(px(80.)),
            Column::new("amount", "金额").width(px(112.)).text_right(),
            Column::new("currency", "币种").width(px(88.)),
            Column::new("type", "回款类型").width(px(96.)),
            Column::new("note", "备注").width(px(200.)),
        ]
    }

    fn set_rows(&mut self, rows: Vec<PlatformRevenueItem>) {
        self.rows = rows;
    }
}

impl TableDelegate for RevenueTableDelegate {
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
        match col_ix {
            COL_DATE => div()
                .text_sm()
                .text_color(theme.text_primary)
                .child(format_date(&row.received_date))
                .into_any_element(),
            COL_PROJECT => div()
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .truncate()
                .child(row.project_name.clone())
                .into_any_element(),
            COL_COUNTRY => country_badge(&row.country, &theme).into_any_element(),
            COL_AMOUNT => div()
                .text_right()
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text_primary)
                .child(format_amount(parse_amount(&row.amount), &row.currency))
                .into_any_element(),
            COL_CURRENCY => currency_badge(&row.currency, &theme).into_any_element(),
            COL_TYPE => {
                let is_b2b = row.revenue_type == "B2B回款";
                let type_label = if row.revenue_type.is_empty() {
                    "订单回款".to_string()
                } else {
                    row.revenue_type.clone()
                };
                h_flex()
                    .items_center()
                    .child(
                        div()
                            .px_2()
                            .py_0p5()
                            .rounded_full()
                            .text_xs()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(if is_b2b {
                                theme.accent
                            } else {
                                theme.success
                            })
                            .bg(if is_b2b {
                                theme.accent_soft
                            } else {
                                theme.success_soft
                            })
                            .child(type_label),
                    )
                    .into_any_element()
            }
            COL_NOTE => {
                let note = row
                    .note
                    .clone()
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| "-".to_string());
                div()
                    .text_sm()
                    .text_color(theme.text_muted)
                    .truncate()
                    .child(note)
                    .into_any_element()
            }
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
            .child(div().text_sm().child("暂无回款数据"))
            .into_any_element()
    }
}

/// 站点徽标（语义色块；对齐 frontend `getCountryBadgeMeta` 的 accent 色系简化）
fn country_badge(country: &str, theme: &AppTheme) -> impl IntoElement {
    let code = if country.is_empty() { "US" } else { country };
    let accent = match code {
        "US" | "CA" => theme.success,
        "UK" => theme.accent,
        "DE" => theme.warning,
        "JP" => theme.danger,
        "AU" => theme.warning,
        "MX" | "BR" => theme.accent,
        _ => theme.text_muted,
    };
    h_flex()
        .gap_1()
        .items_center()
        .child(
            div()
                .px_2()
                .py_0p5()
                .rounded_full()
                .border_1()
                .border_color(accent.opacity(0.35))
                .bg(accent.opacity(0.12))
                .text_xs()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(accent)
                .child(code.to_string()),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .child(country_label(code)),
        )
}

/// 币种徽标（语义色块；对齐 frontend `getCurrencyBadgeMeta`）
fn currency_badge(currency: &str, theme: &AppTheme) -> impl IntoElement {
    let code = if currency.is_empty() { "USD" } else { currency };
    let accent = match code {
        "USD" => theme.success,
        "GBP" => theme.warning,
        "EUR" => theme.accent,
        _ => theme.text_muted,
    };
    h_flex()
        .gap_1()
        .items_center()
        .child(
            div()
                .px_2()
                .py_0p5()
                .rounded_full()
                .border_1()
                .border_color(accent.opacity(0.35))
                .bg(accent.opacity(0.12))
                .text_xs()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(accent)
                .child(currency_symbol(code).to_string()),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .child(code.to_string()),
        )
}

/// 回款列表表 Widget（懒建 TableState；`set_data` 注入行，幂等）。
/// 表格下方由视图层画合计行 + 分页条（分页按钮需要视图的 page 状态）。
struct RevenueTable {
    table: Option<Entity<TableState<RevenueTableDelegate>>>,
    rows: Vec<PlatformRevenueItem>,
}

impl RevenueTable {
    fn new() -> Self {
        Self {
            table: None,
            rows: Vec::new(),
        }
    }

    /// 注入行（无变化时跳过）
    fn set_data(&mut self, rows: Vec<PlatformRevenueItem>, cx: &mut Context<Self>) {
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
}

impl Default for RevenueTable {
    fn default() -> Self {
        Self::new()
    }
}

impl Render for RevenueTable {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let table = self.table.get_or_insert_with(|| {
            let delegate = RevenueTableDelegate::new(self.rows.clone());
            cx.new(|cx| TableState::new(delegate, window, cx))
        });
        let theme = AppTheme::current(cx);
        let totals = calculate_totals(&self.rows);
        let totals_text = format_totals(&totals);

        v_flex()
            .id("platform-revenue-table")
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
                            .child("回款记录"),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h(px(240.))
                    .child(Table::new(table).bordered(false).large()),
            )
            // 合计行
            .when(!self.rows.is_empty(), |this| {
                this.child(
                    h_flex()
                        .gap_2()
                        .px_4()
                        .py_2p5()
                        .border_t_1()
                        .border_color(theme.separator)
                        .items_center()
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.text_primary)
                                .child("合计"),
                        )
                        .child(
                            div()
                                .text_sm()
                                .text_color(theme.text_secondary)
                                .child(totals_text),
                        ),
                )
            })
    }
}

/// 分页条（视图层渲染；按钮直接调视图的 previous_page / next_page / set_page_size）
#[allow(clippy::too_many_arguments)]
fn pagination_bar(
    view: &Entity<PlatformRevenueView>,
    theme: &AppTheme,
    page: i64,
    total_pages: i64,
    page_size: i64,
) -> impl IntoElement {
    let view_for_prev = view.clone();
    let view_for_next = view.clone();
    let view_for_size = view.clone();
    h_flex()
        .id("platform-revenue-pagination")
        .gap_2()
        .px_4()
        .py_2p5()
        .items_center()
        .justify_between()
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(format!("第 {page} / {total_pages} 页")),
                )
                .child(
                    Button::new("platform-revenue-prev")
                        .outline()
                        .small()
                        .label("上一页")
                        .on_click(move |_, _window, cx| {
                            let view = view_for_prev.clone();
                            view.update(cx, |this, cx| this.previous_page(cx));
                        }),
                )
                .child(
                    Button::new("platform-revenue-next")
                        .outline()
                        .small()
                        .label("下一页")
                        .on_click(move |_, _window, cx| {
                            let view = view_for_next.clone();
                            view.update(cx, |this, cx| this.next_page(cx));
                        }),
                ),
        )
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child("每页"),
                )
                .child(
                    Button::new("platform-revenue-page-size")
                        .outline()
                        .small()
                        .label(page_size.to_string())
                        .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                        .dropdown_menu_with_anchor(
                            gpui::Corner::BottomRight,
                            move |menu, _window, _cx| {
                                let mut menu = menu;
                                for size in PAGE_SIZE_OPTIONS {
                                    let checked = size == page_size;
                                    let view = view_for_size.clone();
                                    menu = menu.item(
                                        PopupMenuItem::new(size.to_string())
                                            .checked(checked)
                                            .on_click(move |_, _window, cx| {
                                                view.update(cx, |this, cx| {
                                                    this.set_page_size(size, cx)
                                                });
                                            }),
                                    );
                                }
                                menu
                            },
                        ),
                ),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn item(
        id: i64,
        project_name: &str,
        country: &str,
        date: &str,
        amount: &str,
        currency: &str,
        revenue_type: &str,
    ) -> PlatformRevenueItem {
        PlatformRevenueItem {
            id,
            project_id: 1,
            project_name: project_name.to_string(),
            country: country.to_string(),
            received_date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            amount: amount.to_string(),
            currency: currency.to_string(),
            exchange_rate: None,
            revenue_type: revenue_type.to_string(),
            note: None,
            attachments: Vec::new(),
            screenshot_r2_key: None,
            screenshot_r2_url: None,
            created_by: "测试".to_string(),
            created_at: chrono::DateTime::parse_from_rfc3339("2026-08-05T10:00:00Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
            updated_at: chrono::DateTime::parse_from_rfc3339("2026-08-05T10:00:00Z")
                .unwrap()
                .with_timezone(&chrono::Utc),
        }
    }

    #[test]
    fn parse_amount_parses_decimal_string() {
        assert_eq!(parse_amount("11693.69"), 11693.69);
        assert_eq!(parse_amount("100"), 100.0);
        assert_eq!(parse_amount("abc"), 0.0);
    }

    #[test]
    fn calculate_totals_groups_by_currency_in_order() {
        let items = vec![
            item(1, "A", "US", "2026-08-01", "100.00", "USD", "订单回款"),
            item(2, "A", "UK", "2026-08-02", "50.50", "GBP", "B2B回款"),
            item(3, "A", "DE", "2026-08-03", "200.00", "USD", "订单回款"),
            item(4, "A", "US", "2026-08-04", "30.00", "EUR", "订单回款"),
        ];
        let totals = calculate_totals(&items);
        assert_eq!(totals.len(), 3);
        assert_eq!(totals[0].currency, "USD");
        assert_eq!(totals[0].total, 300.0);
        assert_eq!(totals[1].currency, "GBP");
        assert_eq!(totals[1].total, 50.5);
        assert_eq!(totals[2].currency, "EUR");
        assert_eq!(totals[2].total, 30.0);
    }

    #[test]
    fn format_totals_joins_with_symbols() {
        let totals = vec![
            TotalsEntry {
                currency: "USD".into(),
                total: 300.0,
            },
            TotalsEntry {
                currency: "GBP".into(),
                total: 50.5,
            },
        ];
        let text = format_totals(&totals);
        assert_eq!(text, "$300.00  |  £50.50");
    }

    #[test]
    fn currency_and_country_labels() {
        assert_eq!(currency_symbol("GBP"), "£");
        assert_eq!(currency_symbol("EUR"), "€");
        assert_eq!(currency_symbol(""), "$");
        assert_eq!(country_label("US"), "美国");
        assert_eq!(country_label("JP"), "日本");
        assert_eq!(country_label("XX"), "XX");
    }

    #[test]
    fn format_date_formats_zh() {
        let d = NaiveDate::parse_from_str("2026-08-05", "%Y-%m-%d").unwrap();
        assert_eq!(format_date(&d), "2026年8月5日");
    }

    /// 渲染冒烟（Loading 态）：完整布局可渲染不 panic
    #[gpui::test]
    async fn platform_revenue_renders_loading(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let client = Client::new("http://127.0.0.1:1");
        let (view, _window_cx) = cx.add_window_view(|_window, cx| {
            PlatformRevenueView::new(cx, client)
        });
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                assert_eq!(this.current_state(cx), PlatformRevenueState::Loading);
            });
        });
    }

    /// P4-6（BLF-761）三态统一冒烟：Empty 态可渲染不 panic。
    #[gpui::test]
    async fn platform_revenue_renders_empty(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let client = Client::new("http://127.0.0.1:1");
        let (view, _window_cx) = cx.add_window_view(|_window, cx| {
            let view = PlatformRevenueView::new(cx, client);
            // 直接注入 Empty 态（不走网络）
            view.state.update(cx, |state, _| {
                *state = PlatformRevenueState::Empty;
            });
            view
        });
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                assert_eq!(this.current_state(cx), PlatformRevenueState::Empty);
            });
        });
    }

    /// 渲染冒烟（Error 态）：加载失败可渲染不 panic
    #[gpui::test]
    async fn platform_revenue_renders_error(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let client = Client::new("http://127.0.0.1:1");
        let (view, _window_cx) = cx.add_window_view(|_window, cx| {
            let view = PlatformRevenueView::new(cx, client);
            // 直接注入 Error 态（不走网络）
            view.state.update(cx, |state, _| {
                *state = PlatformRevenueState::Error("测试错误".into());
            });
            view
        });
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                assert_eq!(
                    this.current_state(cx),
                    PlatformRevenueState::Error("测试错误".into())
                );
            });
        });
    }
}
