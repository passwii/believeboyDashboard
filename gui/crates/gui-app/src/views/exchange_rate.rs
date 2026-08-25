//! 财务资金 → 汇率信息（P5-5，BLF-732）
//!
//! 对齐 web 端 `app/dashboard/finance/exchange-rate`（约 1101 行）的读取主面：
//! 筛选（货币 / 年份 / 月份）+ 汇率分页列表（月度汇率，每货币每月一条，
//! 后端按 `year_month desc, currency asc` 排序）。
//!
//! ## 与 web 端的取舍（issue 允许按 macOS 原生习惯精简并说明）
//!
//! - **保留**：三项筛选（货币 10 币种静态选项 / 年份当前 ±5 / 月份 1-12，
//!   对齐 web `CURRENCY_OPTIONS` / `getYearOptions` / `MONTH_OPTIONS`）、
//!   7 列表格（货币徽标、货币名称、年份、月份、汇率值 6 位小数右对齐、
//!   备注文本 + 备注图张数、更新时间北京时间）、分页（12/页，对齐 web
//!   `pageSize: 12`）、`year_month` 仅在年 + 月同时指定时携带（对齐 web
//!   代理层 `app/api/exchange-rates/route.ts` 的参数映射——后端为精确匹配）；
//! - **精简**：
//!   - 新增 / 编辑 / 删除（写入链路）与备注图上传 / 预览走 web 端
//!     （对齐 BLF-726 发货管理 / BLF-731 订单信息「写入走 web 端」取舍；
//!     api-client 侧 `exchange_rate_create` / `exchange_rate_update` /
//!     `exchange_rate_delete` 已就绪，备注图上传因 reqwest 未启用
//!     multipart 不接入，见 research_analysis 导入端点先例）；
//!   - 手机端卡片布局不移植（GUI 桌面端单布局）；
//!   - 货币徽标配色收敛到主题 token（USD = success / EUR = accent /
//!     其余中性，对齐 web 三档语义）。
//!
//! ## 状态机
//!
//! `Loading`（首屏 / 筛选切换 / 换页）→ `Loaded`（有数据）/ `Empty`（列表空，
//! 两档提示：筛选无结果 / 暂无数据）/ `Error`（请求失败）。

use gpui::prelude::*;
use gpui::{
    div, App, AsyncApp, Context, Entity, FontWeight, IntoElement, Render, SharedString,
    WeakEntity, Window,
};
use chrono::Datelike;
use gpui_component::button::Button;
use gpui_component::menu::PopupMenuItem;
use gpui_component::{h_flex, v_flex, Sizable};
use gui_api_client::exchange_rate::ExchangeRateFilter;
use gui_api_client::Client;
use gui_domain::exchange_rate::{
    currency_symbol, ExchangeRateItem, ExchangeRateListResponse, CURRENCY_OPTIONS,
};

use crate::theme::AppTheme;
use crate::widgets::data_grid::{grid_footer_bar, pattern_a_shell, AggregateItem};
use crate::widgets::data_table::{ColumnDef, DataTable};
use crate::widgets::filter_bar;
use crate::widgets::page_header::PageHeader;
use crate::widgets::pagination::PageState;
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「财务资金 → 汇率信息」URL（数据权威 gui-domain::sidebar）
pub const EXCHANGE_RATE_URL: &str = "/dashboard/finance/exchange-rate";

/// 默认每页行数（对齐 web `pageSize: 12`）
const DEFAULT_PAGE_SIZE: usize = 12;

/// 年份选项跨度（当前年份前后各 5 年，对齐 web `getYearOptions`）
const YEAR_SPAN: i64 = 5;

// ---------------------------------------------------------------------------
// 格式化 / 派生辅助
// ---------------------------------------------------------------------------

/// 千分位整数（与 order_info 同款实现）
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

/// 时间戳 → 北京时间（+08:00）`YYYY-MM-DD HH:MM`（对齐 web
/// `toLocaleString('zh-CN')` 语义；后端 `isoformat()` 可能带偏移或不带——
/// 带偏移按 rfc3339 解析，naive 按 UTC 解释；解析失败 / 空 → 「—」）
fn beijing_time(iso: &str) -> String {
    let trimmed = iso.trim();
    if trimmed.is_empty() {
        return "—".to_string();
    }
    let beijing = chrono::FixedOffset::east_opt(8 * 3600).expect("固定偏移");
    let parsed = chrono::DateTime::parse_from_rfc3339(trimmed)
        .map(|dt| dt.with_timezone(&beijing))
        .or_else(|_| {
            chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S%.f")
                .map(|naive| {
                    use chrono::TimeZone;
                    chrono::Utc
                        .from_utc_datetime(&naive)
                        .with_timezone(&beijing)
                })
        });
    parsed
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|_| "—".to_string())
}

/// 汇率值展示（对齐 web `Number(rate.rate).toFixed(6)`：固定 6 位小数、
/// 无千分位）
fn fmt_rate(value: f64) -> String {
    format!("{value:.6}")
}

/// 年份选项（当前年份前后各 5 年，升序；对齐 web `getYearOptions`）
fn year_options(current_year: i64) -> Vec<i64> {
    (current_year - YEAR_SPAN..=current_year + YEAR_SPAN).collect()
}

/// 货币徽标配色（USD = 成功色 / EUR = 强调色 / 其余中性；对齐 web
/// `getCurrencyBadgeMeta` 三档语义）
fn currency_pill_colors(currency: &str, theme: &AppTheme) -> (gpui::Hsla, gpui::Hsla) {
    match currency.trim().to_ascii_uppercase().as_str() {
        "USD" => (theme.success_soft, theme.success),
        "EUR" => (theme.accent_soft, theme.accent),
        _ => (theme.muted_fill, theme.text_secondary),
    }
}

/// 货币徽标单元格（圆角胶囊 + 符号 + 代码，对齐 web Badge 观感）
fn currency_pill(item: &ExchangeRateItem, theme: &AppTheme) -> gpui::AnyElement {
    let (bg, fg) = currency_pill_colors(&item.currency, theme);
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
                .text_sm()
                .child(SharedString::from(
                    currency_symbol(&item.currency).to_string(),
                )),
        )
        .child(
            div()
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .child(SharedString::from(item.currency.clone())),
        )
        .into_any_element()
}

// ---------------------------------------------------------------------------
// 载荷 / 状态机
// ---------------------------------------------------------------------------

/// 汇率信息载荷（Loaded 持有）
#[derive(Debug, Clone, PartialEq)]
pub struct ExchangeRateData {
    /// 当前筛选 + 分页下的列表
    pub list: ExchangeRateListResponse,
}

impl ExchangeRateData {
    /// 空态判定：列表为空
    pub fn is_empty(&self) -> bool {
        self.list.items.is_empty()
    }
}

/// 汇率信息状态机（四态；沿用既有 view 模式）
#[derive(Debug, Clone, PartialEq)]
pub enum ExchangeRateState {
    Loading,
    Loaded(Box<ExchangeRateData>),
    Empty,
    Error(String),
}

impl ExchangeRateState {
    /// 拉取结果 → 落点状态
    pub fn from_fetch_result(result: Result<ExchangeRateData, String>) -> Self {
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

/// 汇率信息视图（四态状态机 + 三项筛选 + 分页 + 竞态保护）
pub struct ExchangeRateView {
    state: Entity<ExchangeRateState>,
    /// 带会话的 API client
    client: Client,
    /// 货币筛选（`None` = 全部货币）
    currency_filter: Option<String>,
    /// 年份筛选（`None` = 全部年份；与月份同时指定才携带 `year_month`）
    year_filter: Option<i64>,
    /// 月份筛选（`None` = 全部月份；与年份同时指定才携带 `year_month`）
    month_filter: Option<u32>,
    /// 当前页（1 起）
    page: usize,
    /// 每页行数（固定 12，对齐 web）
    page_size: usize,
    /// 主请求竞态保护
    latest_request_id: u64,
    /// 汇率表（Stage 0 DataTable，总存在）
    table: Entity<DataTable<ExchangeRateItem>>,
}

impl ExchangeRateView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| ExchangeRateState::Loading);
        let table = cx.new(|_| {
            DataTable::new("exchange-rate-table", rate_columns())
                .striped(true)
                .empty_text("当前筛选条件下暂无汇率数据")
        });
        Self {
            state,
            client,
            currency_filter: None,
            year_filter: None,
            month_filter: None,
            page: 1,
            page_size: DEFAULT_PAGE_SIZE,
            latest_request_id: 0,
            table,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> ExchangeRateState {
        self.state.read(cx).clone()
    }

    /// 组装当前筛选（列表口径；`year_month` 仅年 + 月同时指定时携带）
    fn build_filter(&self) -> ExchangeRateFilter {
        ExchangeRateFilter {
            currency: self.currency_filter.clone().filter(|c| !c.is_empty()),
            year: self.year_filter,
            month: self.month_filter,
        }
    }

    /// 是否有任何筛选生效（空态两档提示用）
    fn has_active_filters(&self) -> bool {
        self.currency_filter.is_some()
            || self.year_filter.is_some()
            || self.month_filter.is_some()
    }

    /// 重新拉取：首屏 / 筛选切换 / 换页 / 错误重试 / 空态刷新共用入口
    /// （竞态保护；每次调用递增 `latest_request_id` 并进入 Loading）
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let filter = self.build_filter();
        let page = self.page as i64;
        let page_size = self.page_size as i64;

        self.state.update(cx, |state, cx| {
            *state = ExchangeRateState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(async { client.exchange_rate_list(&filter, page, page_size).await })
                })
                .await;
            let result = match result {
                Ok(list) => Ok(ExchangeRateData { list }),
                Err(e) => Err(e.user_message()),
            };
            this.update(&mut *cx, |this, cx| {
                this.apply_main_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 应用主数据拉取结果（竞态保护）：落点表格行 + 状态
    fn apply_main_result(
        &mut self,
        request_id: u64,
        result: Result<ExchangeRateData, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        let next = ExchangeRateState::from_fetch_result(result);
        if let ExchangeRateState::Loaded(data) = &next {
            self.table.update(cx, |t, cx| {
                t.set_rows(data.list.items.clone(), cx);
            });
            self.page = data.list.page.max(1) as usize;
        } else {
            self.table.update(cx, |t, cx| t.set_rows(Vec::new(), cx));
        }
        self.state.update(cx, |state, cx| {
            *state = next;
            cx.notify();
        });
    }

    /// 切换货币筛选（同一货币为 no-op；`None` = 全部货币）
    pub fn select_currency(&mut self, currency: Option<String>, cx: &mut Context<Self>) {
        if currency == self.currency_filter {
            return;
        }
        self.currency_filter = currency;
        self.page = 1;
        self.reload(cx);
    }

    /// 切换年份筛选（同一年份为 no-op；`None` = 全部年份）
    pub fn select_year(&mut self, year: Option<i64>, cx: &mut Context<Self>) {
        if year == self.year_filter {
            return;
        }
        self.year_filter = year;
        self.page = 1;
        self.reload(cx);
    }

    /// 切换月份筛选（同一月份为 no-op；`None` = 全部月份）
    pub fn select_month(&mut self, month: Option<u32>, cx: &mut Context<Self>) {
        if month == self.month_filter {
            return;
        }
        self.month_filter = month;
        self.page = 1;
        self.reload(cx);
    }

    /// 重置筛选（对齐 web `resetFilters`：全部条件复位）
    pub fn clear_filters(&mut self, cx: &mut Context<Self>) {
        self.currency_filter = None;
        self.year_filter = None;
        self.month_filter = None;
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

    /// 切换每页行数（固定 12，守卫同值 no-op；保留入口对齐分页条契约）
    pub fn set_page_size(&mut self, size: usize, cx: &mut Context<Self>) {
        if size == self.page_size || size == 0 {
            return;
        }
        self.page_size = size;
        self.page = 1;
        self.reload(cx);
    }
}

// ---------------------------------------------------------------------------
// 列定义
// ---------------------------------------------------------------------------

/// 汇率表 7 列（对齐 web 桌面端表格；「操作」列随写入走 web 端精简移除）
fn rate_columns() -> Vec<ColumnDef<ExchangeRateItem>> {
    vec![
        ColumnDef::text("currency", "货币代码", |_r: &ExchangeRateItem, _theme| {
            SharedString::from("")
        })
        .with_render_element(currency_pill)
        .width(110.0),
        ColumnDef::text("currency-name", "货币名称", |r: &ExchangeRateItem, _| {
            SharedString::from(r.display_name().to_string())
        })
        .width(110.0),
        ColumnDef::text("year", "年份", |r: &ExchangeRateItem, _| {
            SharedString::from(
                r.year()
                    .map(|y| y.to_string())
                    .unwrap_or_else(|| "—".to_string()),
            )
        })
        .width(72.0),
        ColumnDef::text("month", "月份", |r: &ExchangeRateItem, _| {
            SharedString::from(
                r.month()
                    .map(|m| format!("{m}月"))
                    .unwrap_or_else(|| "—".to_string()),
            )
        })
        .width(64.0),
        ColumnDef::number(
            "rate",
            "汇率值",
            |r: &ExchangeRateItem| r.rate,
            |r: &ExchangeRateItem, _| SharedString::from(fmt_rate(r.rate)),
        )
        .width(104.0),
        ColumnDef::text("description", "备注", |_r: &ExchangeRateItem, _theme| {
            SharedString::from("")
        })
        .with_render_element(|r: &ExchangeRateItem, theme| {
            let image_count = r.note_images.len();
            v_flex()
                .gap_0p5()
                .child(
                    div()
                        .text_sm()
                        .child(SharedString::from(
                            r.description
                                .as_deref()
                                .filter(|s| !s.trim().is_empty())
                                .unwrap_or("—")
                                .to_string(),
                        )),
                )
                .when(image_count > 0, |this| {
                    this.child(
                        div()
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child(SharedString::from(format!("{image_count} 张备注图"))),
                    )
                })
                .into_any_element()
        })
        .width(200.0),
        ColumnDef::text("updated", "更新时间", |r: &ExchangeRateItem, _| {
            SharedString::from(beijing_time(&r.updated_at))
        })
        .width(140.0),
    ]
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for ExchangeRateView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let view = cx.entity();
        match &state {
            ExchangeRateState::Loaded(data) => {
                let subtitle = format!(
                    "共 {} 条月度汇率 · 新增 / 编辑 / 删除请在 web 端操作",
                    data.list.total
                );
                let header = PageHeader::new("汇率信息").subtitle(subtitle);
                let toolbar = h_flex()
                    .gap_2()
                    .items_center()
                    .child(render_filter_card(self, view.clone(), &app_theme))
                    .child(div().flex_1());
                let total = data.list.total.max(0) as usize;
                let page_state = PageState::new(self.page, self.page_size.max(1), total);
                let footer = grid_footer_bar(
                    &view,
                    &app_theme,
                    "exchange-rate",
                    &[AggregateItem::new(
                        "总条数",
                        fmt_int(total as i64),
                    )],
                    &page_state,
                    &[DEFAULT_PAGE_SIZE],
                    |this, page, cx| this.go_to_page(page, cx),
                    |this, size, cx| this.set_page_size(size, cx),
                );
                crate::motion::enter_fade_in(
                    SharedString::from("exchange-rate-loaded-fade"),
                    pattern_a_shell(
                        &app_theme,
                        "exchange-rate",
                        header,
                        toolbar,
                        list_section(view, &app_theme, data.list.items.len(), self.table.clone()),
                        footer,
                    ),
                    crate::motion::reduce_motion(cx),
                )
                .into_any_element()
            }
            _ => {
                let subtitle =
                    "月度汇率维护（每货币每月一条）；SKU 成本按站点和月份自动换算".to_string();
                let header = PageHeader::new("汇率信息").subtitle(subtitle);
                let body: gpui::AnyElement = match state {
                    ExchangeRateState::Loading => render_loading(&app_theme).into_any_element(),
                    ExchangeRateState::Error(msg) => state_views::error_state(
                        &view,
                        &app_theme,
                        "exchange-rate-error",
                        "汇率信息加载失败",
                        msg,
                        |this, cx| this.reload(cx),
                    )
                    .into_any_element(),
                    ExchangeRateState::Empty => {
                        let message = empty_message(self);
                        state_views::empty_state_with_action_desc(
                            &view,
                            &app_theme,
                            "exchange-rate-empty",
                            "icons/coins.svg",
                            message,
                            Some("新增 / 编辑 / 删除与备注图上传请在 web 端操作".to_string()),
                            "刷新",
                            |this, cx| this.reload(cx),
                        )
                        .into_any_element()
                    }
                    ExchangeRateState::Loaded(_) => unreachable!("Loaded 分支已在上层处理"),
                };
                pattern_a_shell(&app_theme, "exchange-rate", header, div(), body, div())
                    .into_any_element()
            }
        }
    }
}

/// 空态两档提示（筛选无结果 > 暂无数据）
fn empty_message(view: &ExchangeRateView) -> String {
    if view.has_active_filters() {
        "当前筛选条件下无汇率数据 — 可调整筛选条件或点击「重置」".to_string()
    } else {
        "暂无汇率数据 — 请管理员在 web 端录入月度汇率".to_string()
    }
}

/// 筛选卡（一行：货币 / 年份 / 月份三个下拉 + 重置 / 刷新）
fn render_filter_card(
    view: &ExchangeRateView,
    view_entity: Entity<ExchangeRateView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let currency_label: SharedString = SharedString::from(
        view.currency_filter
            .as_deref()
            .and_then(|value| {
                CURRENCY_OPTIONS
                    .iter()
                    .find(|(v, _)| *v == value)
                    .map(|(_, label)| label.to_string())
            })
            .unwrap_or_else(|| "全部货币".to_string()),
    );
    let year_label: SharedString = SharedString::from(
        view.year_filter
            .map(|y| format!("{y}年"))
            .unwrap_or_else(|| "全部年份".to_string()),
    );
    let month_label: SharedString = SharedString::from(
        view.month_filter
            .map(|m| format!("{m}月"))
            .unwrap_or_else(|| "全部月份".to_string()),
    );

    let view_for_currency = view_entity.clone();
    let view_for_year = view_entity.clone();
    let view_for_month = view_entity.clone();
    let view_for_reset = view_entity.clone();
    let view_for_refresh = view_entity.clone();

    let currency_filter = view.currency_filter.clone();
    let year_filter = view.year_filter;
    let month_filter = view.month_filter;
    let years = year_options(chrono::Utc::now().year() as i64);

    v_flex()
        .id("exchange-rate-filters")
        .gap_3()
        .child(
            filter_bar::filter_bar_layout(theme)
                .child(filter_bar::filter_select(
                    theme,
                    "货币",
                    currency_label,
                    "exchange-rate-currency-filter",
                    move |menu, _window, _cx| {
                        let mut menu = menu;
                        let view_all = view_for_currency.clone();
                        menu = menu.item(
                            PopupMenuItem::new("全部货币")
                                .checked(currency_filter.is_none())
                                .on_click(move |_ev, _w, cx| {
                                    view_all.update(cx, |this, cx| {
                                        this.select_currency(None, cx)
                                    });
                                }),
                        );
                        for (value, label) in CURRENCY_OPTIONS.iter() {
                            let view = view_for_currency.clone();
                            let value = value.to_string();
                            let checked = currency_filter.as_deref() == Some(value.as_str());
                            let label = label.to_string();
                            menu = menu.item(
                                PopupMenuItem::new(label)
                                    .checked(checked)
                                    .on_click(move |_ev, _w, cx| {
                                        let value = value.clone();
                                        view.update(cx, |this, cx| {
                                            this.select_currency(Some(value), cx)
                                        });
                                    }),
                            );
                        }
                        menu
                    },
                ))
                .child(filter_bar::filter_select(
                    theme,
                    "年份",
                    year_label,
                    "exchange-rate-year-filter",
                    move |menu, _window, _cx| {
                        let mut menu = menu;
                        let view_all = view_for_year.clone();
                        menu = menu.item(
                            PopupMenuItem::new("全部年份")
                                .checked(year_filter.is_none())
                                .on_click(move |_ev, _w, cx| {
                                    view_all.update(cx, |this, cx| this.select_year(None, cx));
                                }),
                        );
                        for year in &years {
                            let view = view_for_year.clone();
                            let year = *year;
                            let checked = year_filter == Some(year);
                            menu = menu.item(
                                PopupMenuItem::new(format!("{year}年"))
                                    .checked(checked)
                                    .on_click(move |_ev, _w, cx| {
                                        view.update(cx, |this, cx| {
                                            this.select_year(Some(year), cx)
                                        });
                                    }),
                            );
                        }
                        menu
                    },
                ))
                .child(filter_bar::filter_select(
                    theme,
                    "月份",
                    month_label,
                    "exchange-rate-month-filter",
                    move |menu, _window, _cx| {
                        let mut menu = menu;
                        let view_all = view_for_month.clone();
                        menu = menu.item(
                            PopupMenuItem::new("全部月份")
                                .checked(month_filter.is_none())
                                .on_click(move |_ev, _w, cx| {
                                    view_all.update(cx, |this, cx| this.select_month(None, cx));
                                }),
                        );
                        for month in 1u32..=12 {
                            let view = view_for_month.clone();
                            let checked = month_filter == Some(month);
                            menu = menu.item(
                                PopupMenuItem::new(format!("{month}月"))
                                    .checked(checked)
                                    .on_click(move |_ev, _w, cx| {
                                        view.update(cx, |this, cx| {
                                            this.select_month(Some(month), cx)
                                        });
                                    }),
                            );
                        }
                        menu
                    },
                ))
                .child(
                    Button::new("exchange-rate-reset")
                        .outline()
                        .small()
                        .label("重置")
                        .on_click(move |_ev, _w, cx| {
                            view_for_reset.update(cx, |this, cx| this.clear_filters(cx));
                        }),
                )
                .child(
                    Button::new("exchange-rate-refresh")
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

// ---------------------------------------------------------------------------
// 四态渲染
// ---------------------------------------------------------------------------

fn render_loading(theme: &AppTheme) -> impl IntoElement {
    state_views::skeleton_loading(
        theme,
        &[
            SkeletonBlock::Kpi(3),
            SkeletonBlock::Table(320.0),
            SkeletonBlock::Table(200.0),
        ],
    )
}

fn list_section(
    view: Entity<ExchangeRateView>,
    theme: &AppTheme,
    total: usize,
    table: Entity<DataTable<ExchangeRateItem>>,
) -> gpui::AnyElement {
    let _ = view;
    v_flex()
        .id("exchange-rate-list")
        .size_full()
        .min_h_0()
        .child(
            div()
                .px_2()
                .pt_2()
                .text_xs()
                .text_color(theme.text_muted)
                .child("后端按年月倒序 + 货币正序排列；每货币每月仅一条"),
        )
        .child(div().id("exchange-rate-table").flex_1().min_h_0().px_2().pb_2().overflow_y_scroll().child(table))
        .when(total == 0, |this| this.child(div()))
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
        assert_eq!(EXCHANGE_RATE_URL, "/dashboard/finance/exchange-rate");
    }

    #[test]
    fn page_size_aligns_with_web() {
        assert_eq!(DEFAULT_PAGE_SIZE, 12);
    }

    #[test]
    fn fmt_int_handles_thousands_and_negative() {
        assert_eq!(fmt_int(0), "0");
        assert_eq!(fmt_int(999), "999");
        assert_eq!(fmt_int(1_234_567), "1,234,567");
        assert_eq!(fmt_int(-4200), "-4,200");
    }

    #[test]
    fn fmt_rate_fixed_six_decimals() {
        assert_eq!(fmt_rate(7.2345), "7.234500");
        assert_eq!(fmt_rate(0.048), "0.048000");
        assert_eq!(fmt_rate(1.0), "1.000000");
    }

    #[test]
    fn beijing_time_handles_offset_and_naive_utc() {
        // 带偏移（rfc3339）：2026-08-20T06:23:00Z → 北京时间 14:23 同日
        assert_eq!(
            beijing_time("2026-08-20T06:23:00+00:00"),
            "2026-08-20 14:23"
        );
        // 跨日界：20:00Z → 次日 04:00
        assert_eq!(beijing_time("2026-08-20T20:00:00Z"), "2026-08-21 04:00");
        // naive isoformat（无偏移）按 UTC 解释
        assert_eq!(beijing_time("2026-08-20T06:23:00"), "2026-08-20 14:23");
        // 带小数秒的 isoformat
        assert_eq!(
            beijing_time("2026-08-20T06:23:00.123456"),
            "2026-08-20 14:23"
        );
        assert_eq!(beijing_time(""), "—");
        assert_eq!(beijing_time("not-a-date"), "—");
    }

    #[test]
    fn year_options_spans_current_plus_minus_five() {
        let options = year_options(2026);
        assert_eq!(options.len(), 11);
        assert_eq!(options[0], 2021);
        assert_eq!(options[10], 2031);
        assert!(options.contains(&2026));
    }

    #[test]
    fn currency_pill_colors_follow_web_meta_semantics() {
        let theme = AppTheme::light();
        // USD → 成功色；EUR → 强调色；其余中性
        let (usd_bg, _) = currency_pill_colors("USD", &theme);
        let (eur_bg, _) = currency_pill_colors("EUR", &theme);
        let (other_bg, _) = currency_pill_colors("JPY", &theme);
        assert_eq!(usd_bg, theme.success_soft);
        assert_eq!(eur_bg, theme.accent_soft);
        assert_eq!(other_bg, theme.muted_fill);
        // 大小写不敏感
        let (usd_bg2, _) = currency_pill_colors("usd", &theme);
        assert_eq!(usd_bg2, theme.success_soft);
    }

    // ---------- 样本构造 ----------

    fn sample_item(id: i64) -> ExchangeRateItem {
        ExchangeRateItem {
            id,
            currency: "USD".into(),
            currency_name: Some("美元".into()),
            year_month: "2026-08".into(),
            rate: 7.2345,
            description: Some("月初锁汇".into()),
            note_images: Vec::new(),
            created_at: "2026-08-01T00:00:00+00:00".into(),
            updated_at: "2026-08-20T06:23:00+00:00".into(),
        }
    }

    fn sample_list(items: Vec<ExchangeRateItem>) -> ExchangeRateListResponse {
        ExchangeRateListResponse {
            total: items.len() as i64,
            page: 1,
            page_size: DEFAULT_PAGE_SIZE as i64,
            items,
        }
    }

    fn sample_data() -> ExchangeRateData {
        ExchangeRateData {
            list: sample_list(vec![sample_item(1), sample_item(2)]),
        }
    }

    /// 构造一个 dummy client（无有效 base_url；仅用于构造视图；不实际发请求）
    fn dummy_client() -> Client {
        Client::new("http://127.0.0.1:1")
    }

    // ---------- 状态机 ----------

    #[test]
    fn state_from_result_maps_correctly() {
        let empty_data = ExchangeRateData {
            list: sample_list(Vec::new()),
        };
        assert_eq!(
            ExchangeRateState::from_fetch_result(Ok(empty_data)),
            ExchangeRateState::Empty
        );
        assert!(matches!(
            ExchangeRateState::from_fetch_result(Ok(sample_data())),
            ExchangeRateState::Loaded(_)
        ));
        assert_eq!(
            ExchangeRateState::from_fetch_result(Err("boom".into())),
            ExchangeRateState::Error("boom".into())
        );
    }

    #[test]
    fn build_filter_reflects_selection() {
        // 空筛选 → 全空（year_month 不携带）
        assert_eq!(ExchangeRateFilter::default(), ExchangeRateFilter {
            currency: None,
            year: None,
            month: None,
        });

        // 年 + 月同时指定 → year_month 归一（api-client 契约在视图侧的镜像断言）
        let filter = ExchangeRateFilter {
            currency: Some("USD".into()),
            year: Some(2026),
            month: Some(8),
        };
        assert_eq!(filter.year_month().as_deref(), Some("2026-08"));
        // 仅年 → 不携带 year_month（对齐 web 代理层口径）
        let year_only = ExchangeRateFilter {
            year: Some(2026),
            ..ExchangeRateFilter::default()
        };
        assert_eq!(year_only.year_month(), None);
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
                cx.add_window_view(|_window, cx| ExchangeRateView::new(cx, dummy_client()));
        }
    }

    #[gpui::test]
    async fn renders_loaded_in_light_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let (view, cx2) =
            cx.add_window_view(|_window, cx| ExchangeRateView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            let data = sample_data();
            this.table.update(cx, |t, cx| {
                t.set_rows(data.list.items.clone(), cx);
            });
            this.state.update(cx, |state, _| {
                *state = ExchangeRateState::Loaded(Box::new(data));
            });
        });
        cx2.read(|app| assert!(!crate::theme::AppTheme::current(app).is_dark()));
    }

    #[gpui::test]
    async fn renders_loaded_with_note_images_in_dark_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (view, cx2) =
            cx.add_window_view(|_window, cx| ExchangeRateView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            let mut with_images = sample_item(3);
            with_images.currency = "EUR".into();
            with_images.currency_name = Some("欧元".into());
            with_images.year_month = "2026-07".into();
            with_images.rate = 7.85;
            with_images.description = None;
            with_images.note_images = vec![gui_domain::exchange_rate::ExchangeRateNoteImage {
                id: "abc".into(),
                url: "https://r2/img.webp".into(),
                thumbnail_url: None,
                r2_key: None,
                thumbnail_key: None,
                filename: "note.webp".into(),
                content_type: "image/webp".into(),
                size: 1024,
                uploaded_at: "2026-08-01T00:00:00+00:00".into(),
            }];
            let data = ExchangeRateData {
                list: sample_list(vec![sample_item(1), with_images]),
            };
            this.table.update(cx, |t, cx| {
                t.set_rows(data.list.items.clone(), cx);
            });
            this.state.update(cx, |state, _| {
                *state = ExchangeRateState::Loaded(Box::new(data));
            });
        });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    #[gpui::test]
    async fn renders_error_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| ExchangeRateView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = ExchangeRateState::Error("服务不可用".into());
            });
        });
    }

    #[gpui::test]
    async fn renders_empty_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| ExchangeRateView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = ExchangeRateState::Empty;
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
            cx.add_window_view(|_window, cx| ExchangeRateView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            let data = sample_data();
            this.table.update(cx, |t, cx| {
                t.set_rows(data.list.items.clone(), cx);
            });
            this.state.update(cx, |state, _| {
                *state = ExchangeRateState::Loaded(Box::new(data));
            });
        });
    }

    // ---------- 状态机动作 ----------

    /// 筛选动作：货币 / 年份 / 月份切换重置页码（同值 no-op）；
    /// 换页 / 行数 / 重置同款守卫
    #[gpui::test]
    async fn filter_actions_reset_page_and_noop_on_same_value(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| ExchangeRateView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            // 预置非首页 + 已选货币
            this.page = 3;
            this.currency_filter = Some("USD".into());

            // 同值 no-op（页码不动）
            let before = this.latest_request_id;
            this.select_currency(Some("USD".into()), cx);
            assert_eq!(this.page, 3);
            assert_eq!(this.latest_request_id, before);

            // 切换货币 → 页码重置 + 重拉
            this.select_currency(Some("EUR".into()), cx);
            assert_eq!(this.page, 1);
            assert_eq!(this.currency_filter.as_deref(), Some("EUR"));

            // 年份 / 月份 → 页码重置
            this.page = 2;
            this.select_year(Some(2026), cx);
            assert_eq!(this.page, 1);
            assert_eq!(this.year_filter, Some(2026));
            this.page = 2;
            this.select_month(Some(8), cx);
            assert_eq!(this.page, 1);
            assert_eq!(this.month_filter, Some(8));

            // 清空各筛选（None）→ 页码重置
            this.page = 2;
            this.select_year(None, cx);
            assert_eq!(this.page, 1);
            assert_eq!(this.year_filter, None);

            // 重置：全部条件复位 + 页码重置 + 重拉
            this.page = 4;
            this.clear_filters(cx);
            assert_eq!(this.currency_filter, None);
            assert_eq!(this.year_filter, None);
            assert_eq!(this.month_filter, None);
            assert_eq!(this.page, 1);
            // 累计重拉：EUR / 2026 / 8月 / 年份清空 / 重置 = 5 次
            assert_eq!(this.latest_request_id, 5);

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

    /// 空态两档提示：筛选无结果 > 暂无数据（gpui 实体上下文内构造）
    #[gpui::test]
    async fn empty_message_follows_two_tiers(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| ExchangeRateView::new(cx, dummy_client()));
        view.update(cx2, |view, _| {
            // 第一档：有筛选条件 → 筛选无结果提示
            view.currency_filter = Some("USD".into());
            assert!(empty_message(view).contains("当前筛选条件下无汇率数据"));

            // 第二档：无筛选 → 暂无数据提示
            view.currency_filter = None;
            assert!(empty_message(view).contains("暂无汇率数据"));
        });
    }
}
