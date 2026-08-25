//! 报表中心 → 报表自动化视图（P5-4，BLF-730）
//!
//! frontend `app/dashboard/reports/auto-upload/page.tsx` 的 GPUI 等价（只读查看）。
//! 该 web 页含两块：① RPA 报表状态矩阵（项目 × 报表类型上传状态，本视图接入）；
//! ② 自动上传队列（recognize / commit 写操作，**不在 GUI 范围**，P5-4 范围边界，
//! 对齐 scheduled_reports「仅查看」约定）。
//!
//! 数据源：`GET /api/v1/rpa-reports/status?report_date=YYYY-MM-DD&country=US`
//! （backend `app/api/v1/endpoints/rpa_reports.py`；web 端 `loadStatus` 同口径）。
//!
//! 架构（复用 Phase 基建，对齐 P3-1 daily_analysis / P3-5 scheduled_reports 范式）：
//! - **四态状态机**：`Loading / Loaded / Empty / Error`，`latest_request_id`
//!   竞态保护（只有最新请求的响应才落点）；
//! - **筛选**：站点（US/DE/UK）+ 日期（前/后一天 + 今天）+ 项目（多选下拉，客户端过滤）；
//! - **矩阵**：行 = 项目，列 = 报表类型（与 backend `report_type` 对齐），单元格按
//!   `is_uploaded` 着色（已上传 = 成功色 ✓ / 未上传 = 危险色 ✗）；
//! - 动效沿用 Phase 4（`enter_fade_in` + `reduce_motion` 尊重）。
//!
//! 已知差异（有意保留，GPUI 0.2 能力边界 / P5-4 范围）：
//! - recognize / commit 等写操作不接入（只读）；
//! - 日期用「前一天 / 今天 / 后一天」按钮导航，不引入日历弹层（macOS 原生习惯精简）；
//! - 矩阵首列（项目名）在横向滚动时不固定（GPUI 0.2 无 sticky 定位）。

use chrono::{Local, NaiveDate};
use gpui::{
    div, prelude::*, px, rgb, AsyncApp, Context, Entity, FontWeight, Render, SharedString,
    WeakEntity, Window,
};
use gpui_component::{
    button::Button,
    h_flex,
    menu::{DropdownMenu, PopupMenuItem},
    v_flex, Icon, IconName, Sizable,
};
use gui_api_client::Client;
use gui_domain::auto_upload::{ProjectReportStatus, ReportTypeStatus, RpaReportStatusResponse};
use gui_domain::common::ManagedProject;

use crate::theme::AppTheme;
use crate::widgets::page_header::PageHeader;
use crate::widgets::pattern_b::{pattern_b_shell, tabs_zone};
use crate::widgets::state_views::{self, EmptyIcon, SkeletonBlock};

/// 本页在侧栏中的 URL（root.rs 据此路由到本视图；与 gui-domain::sidebar 的报表自动化条目一致）
pub const AUTO_UPLOAD_URL: &str = "/dashboard/reports/auto-upload";

/// 站点选项（value = 后端 country 入参；label = 展示名）
const COUNTRY_OPTIONS: [(&str, &str); 3] = [("US", "美国站"), ("DE", "德国站"), ("UK", "英国站")];

/// 报表类型矩阵列定义（key 与 backend `report_type` 对齐；label 为列头短名，
/// 对齐 frontend `REPORT_TYPES`：5 个标准报表 + 10 个广告报表，顺序一致）。
const REPORT_COLUMNS: &[(&str, &str)] = &[
    ("inventory_report", "库存"),
    ("business_report", "业务"),
    ("sales_report", "销售"),
    ("payment_report", "付款"),
    ("return_report", "退货"),
    ("ad_search_term_share_report", "广告-词份额"),
    ("ad_budget_report", "广告-预算"),
    ("ad_campaign_report", "广告-活动"),
    ("ad_purchased_product_report", "广告-已购"),
    ("ad_promoted_product_report", "广告-推广"),
    ("ad_invalid_traffic_report", "广告-无效"),
    ("ad_placement_report", "广告-广告位"),
    ("ad_target_report", "广告-投放"),
    ("ad_search_term_report", "广告-搜索词"),
    ("ad_time_trend_report", "广告-时间"),
];

/// 项目名列宽 / 报表类型列宽（px，对齐 web 矩阵 160 / 96）
const PROJECT_COL_W: f32 = 160.0;
const REPORT_COL_W: f32 = 96.0;
/// 单元格高度（px）
const CELL_H: f32 = 34.0;

/// 站点展示名（value → label）
pub fn country_label(country: &str) -> &'static str {
    COUNTRY_OPTIONS
        .iter()
        .find(|(value, _)| *value == country)
        .map(|(_, label)| *label)
        .unwrap_or("美国站")
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/// 报表自动化状态机（四态）
#[derive(Debug, Clone, PartialEq)]
pub enum AutoUploadState {
    Loading,
    Loaded(RpaReportStatusResponse),
    Empty,
    Error(String),
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// 报表自动化视图（四态 + 竞态保护 + 懒创建首屏拉取）
pub struct AutoUploadView {
    /// 带会话的 API client
    client: Client,
    /// 状态机实体
    state: Entity<AutoUploadState>,
    /// 项目列表（项目筛选下拉 + 解析行归属；与状态并行拉取）
    projects: Vec<ManagedProject>,
    /// 当前站点（US/DE/UK）
    country: &'static str,
    /// 当前查询日期（报表业务日期）
    report_date: NaiveDate,
    /// 项目筛选（多选；空 = 全部项目；客户端过滤）
    selected_projects: Vec<String>,
    /// 请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,
    /// 是否已触发过首拉（懒加载）
    loaded: bool,
}

impl AutoUploadView {
    /// 新建视图：初始 Loading 待拉数；root.rs 懒创建后调用 `reload` 触发首屏拉取。
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| AutoUploadState::Loading);
        Self {
            client,
            state,
            projects: Vec::new(),
            country: "US",
            report_date: Local::now().date_naive(),
            selected_projects: Vec::new(),
            latest_request_id: 0,
            loaded: false,
        }
    }

    /// 首屏拉取（root.rs 懒创建后调用）
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.loaded = true;
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let country = self.country.to_string();
        let date = self.report_date;
        self.state.update(cx, |s, cx| {
            *s = AutoUploadState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(load_status(&client, date, &country))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 切换站点 → 重拉
    pub fn select_country(&mut self, country: &'static str, cx: &mut Context<Self>) {
        if country == self.country {
            return;
        }
        self.country = country;
        self.reload(cx);
    }

    /// 日期 ±N 天 → 重拉
    pub fn shift_date(&mut self, offset_days: i64, cx: &mut Context<Self>) {
        self.report_date = shift_naive_date(self.report_date, offset_days);
        self.reload(cx);
    }

    /// 回到今天 → 重拉
    pub fn select_today(&mut self, cx: &mut Context<Self>) {
        let today = Local::now().date_naive();
        if today == self.report_date {
            return;
        }
        self.report_date = today;
        self.reload(cx);
    }

    /// 项目筛选：切换某项目选中（客户端过滤，不重拉）
    pub fn toggle_project(&mut self, name: String, cx: &mut Context<Self>) {
        if let Some(pos) = self.selected_projects.iter().position(|p| *p == name) {
            self.selected_projects.remove(pos);
        } else {
            self.selected_projects.push(name);
        }
        cx.notify();
    }

    /// 清空项目筛选（回到全部项目）
    pub fn clear_project_filter(&mut self, cx: &mut Context<Self>) {
        if self.selected_projects.is_empty() {
            return;
        }
        self.selected_projects.clear();
        cx.notify();
    }

    /// 应用拉取结果（竞态保护；Loaded 落点前记录项目列表）
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<(RpaReportStatusResponse, Vec<ManagedProject>), String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok((_, projects)) = &result {
            self.projects = projects.clone();
        }
        let state = match result {
            Ok((resp, _)) if resp.items.is_empty() => AutoUploadState::Empty,
            Ok((resp, _)) => AutoUploadState::Loaded(resp),
            Err(msg) => AutoUploadState::Error(msg),
        };
        self.state.update(cx, |cur, cx| {
            *cur = state;
            cx.notify();
        });
    }
}

/// `NaiveDate` 偏移 N 天（N 可负）
fn shift_naive_date(date: NaiveDate, offset_days: i64) -> NaiveDate {
    if offset_days >= 0 {
        date + chrono::Days::new(offset_days as u64)
    } else {
        date - chrono::Days::new((-offset_days) as u64)
    }
}

/// 拉取状态矩阵 + 项目列表（并行；项目列表失败不阻塞矩阵展示，回退空列表）。
///
/// 对齐 frontend `loadStatus` + `ensureProjects`：`Promise.all` 等价。
/// 矩阵失败 → Err；项目失败 → 空项目（项目名回退 raw name）。
async fn load_status(
    client: &Client,
    date: NaiveDate,
    country: &str,
) -> Result<(RpaReportStatusResponse, Vec<ManagedProject>), String> {
    let (status, projects) = tokio::join!(
        client.list_rpa_report_status(date, country),
        client.list_managed_projects(),
    );
    let status = status.map_err(|e| e.user_message())?;
    let projects = projects.unwrap_or_default();
    Ok((status, projects))
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for AutoUploadView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let country = self.country;
        let date_str = self.report_date.format("%Y-%m-%d").to_string();
        let projects = self.projects.clone();
        let selected = self.selected_projects.clone();
        let reduce = crate::motion::reduce_motion(cx);
        let view = cx.entity();

        // BLF-803 套版：pattern_b_shell 骨架（页头 + 工具栏行 + 状态矩阵主体；
        // 本页无图表区/子 Tab，占比传 0 关闭上半区）
        let header = PageHeader::new("报表自动化")
            .subtitle("RPA 自动上传状态 · 项目 × 报表类型矩阵（只读）");
        let toolbar = h_flex()
            .gap_2()
            .items_center()
            .px_2()
            .child(render_filter_bar(
                &view,
                &theme,
                country,
                &date_str,
                projects,
                selected.clone(),
            ))
            .child(div().flex_1());
        let body: gpui::AnyElement = match state {
            AutoUploadState::Loading => render_loading(&theme).into_any_element(),
            AutoUploadState::Error(msg) => render_error(&view, &theme, &msg).into_any_element(),
            AutoUploadState::Empty => render_empty(&view, &theme, &date_str).into_any_element(),
            AutoUploadState::Loaded(resp) => {
                render_loaded(&theme, &resp, &selected, reduce).into_any_element()
            }
        };
        let tabs = tabs_zone(div(), body);
        pattern_b_shell(
            &theme,
            "auto-upload",
            header,
            toolbar,
            0.0,
            div(),
            div(),
            tabs,
        )
    }
}

/// 过滤栏：站点 + 日期导航 + 项目筛选 + 刷新
#[allow(clippy::too_many_arguments)]
fn render_filter_bar(
    view: &Entity<AutoUploadView>,
    theme: &AppTheme,
    country: &'static str,
    date_str: &str,
    projects: Vec<ManagedProject>,
    selected: Vec<String>,
) -> impl IntoElement {
    let country_label = country_label(country);
    let project_label = if selected.is_empty() {
        "全部项目".to_string()
    } else if selected.len() == 1 {
        selected[0].clone()
    } else {
        format!("已选 {} 个项目", selected.len())
    };
    let menu_selected = selected.clone();

    let view_for_country = view.clone();
    let view_for_prev = view.clone();
    let view_for_next = view.clone();
    let view_for_today = view.clone();
    let view_for_project = view.clone();
    let view_for_refresh = view.clone();

    h_flex()
        .id("auto-upload-filters")
        .gap_3()
        .items_center()
        .flex_wrap()
        // 站点
        .child(
            Button::new("auto-upload-country-filter")
                .outline()
                .small()
                .label(country_label)
                .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                .dropdown_menu_with_anchor(gpui::Corner::BottomLeft, move |menu, _window, _cx| {
                    let mut menu = menu;
                    for (value, label) in COUNTRY_OPTIONS {
                        let checked = country == value;
                        let view = view_for_country.clone();
                        menu = menu.item(PopupMenuItem::new(label).checked(checked).on_click(
                            move |_, _window, cx| {
                                view.update(cx, |this, cx| this.select_country(value, cx));
                            },
                        ));
                    }
                    menu
                }),
        )
        // 日期导航
        .child(
            h_flex()
                .gap_1()
                .items_center()
                .child(
                    Button::new("auto-upload-date-prev")
                        .outline()
                        .small()
                        .icon(Icon::new(IconName::ChevronLeft).with_size(px(14.)))
                        .on_click(move |_, _window, cx| {
                            view_for_prev.update(cx, |this, cx| this.shift_date(-1, cx));
                        }),
                )
                .child(
                    div()
                        .min_w(px(96.))
                        .text_center()
                        .text_sm()
                        .text_color(theme.text_secondary)
                        .child(date_str.to_string()),
                )
                .child(
                    Button::new("auto-upload-date-next")
                        .outline()
                        .small()
                        .icon(Icon::new(IconName::ChevronRight).with_size(px(14.)))
                        .on_click(move |_, _window, cx| {
                            view_for_next.update(cx, |this, cx| this.shift_date(1, cx));
                        }),
                )
                .child(
                    Button::new("auto-upload-date-today")
                        .outline()
                        .small()
                        .label("今天")
                        .on_click(move |_, _window, cx| {
                            view_for_today.update(cx, |this, cx| this.select_today(cx));
                        }),
                ),
        )
        // 项目筛选（多选）
        .child(
            Button::new("auto-upload-project-filter")
                .outline()
                .small()
                .label(project_label)
                .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                .dropdown_menu_with_anchor(gpui::Corner::BottomLeft, move |menu, _window, _cx| {
                    let mut menu = menu;
                    // 全部项目
                    let all_checked = menu_selected.is_empty();
                    let view_all = view_for_project.clone();
                    menu = menu.item(
                        PopupMenuItem::new("全部项目")
                            .checked(all_checked)
                            .on_click(move |_, _window, cx| {
                                view_all.update(cx, |this, cx| this.clear_project_filter(cx));
                            }),
                    );
                    for p in &projects {
                        let checked = menu_selected.contains(&p.name);
                        let name = p.name.clone();
                        let view = view_for_project.clone();
                        menu = menu.item(
                            PopupMenuItem::new(p.name.clone())
                                .checked(checked)
                                .on_click(move |_, _window, cx| {
                                    view.update(cx, |this, cx| {
                                        this.toggle_project(name.clone(), cx)
                                    });
                                }),
                        );
                    }
                    menu
                }),
        )
        .child(div().flex_1())
        .child(
            Button::new("auto-upload-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_, _window, cx| {
                    view_for_refresh.update(cx, |this, cx| this.reload(cx));
                }),
        )
}

/// Loading：骨架（标题 + 筛选条 + 表格）
fn render_loading(theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("auto-upload-loading")
        .w_full()
        .gap_3()
        .child(state_views::skeleton_loading(
            theme,
            &[
                SkeletonBlock::Title,
                SkeletonBlock::Filter(3),
                SkeletonBlock::Table(320.0),
            ],
        ))
}

/// Error：卡片内 Alert + 重试按钮
fn render_error(view: &Entity<AutoUploadView>, theme: &AppTheme, msg: &str) -> impl IntoElement {
    state_views::error_state(
        view,
        theme,
        "auto-upload-error",
        "报表状态加载失败",
        msg.to_string(),
        |this, cx| this.reload(cx),
    )
}

/// Empty：Icon + 文案 + 说明 + 刷新
fn render_empty(
    view: &Entity<AutoUploadView>,
    theme: &AppTheme,
    date_str: &str,
) -> impl IntoElement {
    let desc = format!(
        "{} 暂时没有可展示的报表状态，切换日期或检查 RPA 是否已接入该日期数据",
        date_str
    );
    state_views::empty_state_with_action_desc(
        view,
        theme,
        "auto-upload-empty",
        EmptyIcon::Name(IconName::Inbox),
        "暂无报表状态",
        Some(desc),
        "刷新",
        |this, cx| this.reload(cx),
    )
}

/// Loaded：矩阵 + 计数行
fn render_loaded(
    theme: &AppTheme,
    resp: &RpaReportStatusResponse,
    selected: &[String],
    reduce: bool,
) -> impl IntoElement {
    let rows: Vec<&ProjectReportStatus> = if selected.is_empty() {
        resp.items.iter().collect()
    } else {
        resp.items
            .iter()
            .filter(|row| selected.contains(&row.project_name))
            .collect()
    };
    let total = resp.items.len();

    // P4-2：矩阵 enter 轻量 fade-in（一次性；减弱动态时瞬时）
    crate::motion::enter_fade_in(
        gpui::SharedString::from("auto-upload-loaded-fade"),
        v_flex()
            .id("auto-upload-loaded")
            .w_full()
            .gap_3()
            .child(render_grid(theme, &rows))
            .child(
                div()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child(if selected.is_empty() {
                        format!("共 {} 个项目 · {} 种报表类型", total, REPORT_COLUMNS.len())
                    } else {
                        format!(
                            "已显示 {} / 共 {} 个项目 · {} 种报表类型",
                            rows.len(),
                            total,
                            REPORT_COLUMNS.len()
                        )
                    }),
            ),
        reduce,
    )
}

/// 状态矩阵卡片（首列项目名 + 每报表类型列；单元格按 is_uploaded 着色）
fn render_grid(theme: &AppTheme, rows: &[&ProjectReportStatus]) -> impl IntoElement {
    let total_w = PROJECT_COL_W + REPORT_COLUMNS.len() as f32 * REPORT_COL_W;
    v_flex()
        .id("auto-upload-grid")
        .w_full()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(
            div()
                .id("auto-upload-grid-scroll")
                .overflow_x_scroll()
                .child(
                    v_flex()
                        .min_w(px(total_w))
                        .child(render_grid_header(theme))
                        .children(
                            rows.iter()
                                .enumerate()
                                .map(|(ix, row)| render_grid_row(row, ix, theme)),
                        )
                        .when(rows.is_empty(), |this| {
                            this.child(
                                div()
                                    .px_4()
                                    .py_8()
                                    .text_center()
                                    .text_sm()
                                    .text_color(theme.text_muted)
                                    .child("没有符合筛选条件的项目"),
                            )
                        }),
                ),
        )
}

/// 矩阵表头（项目 + 报表类型列）
fn render_grid_header(theme: &AppTheme) -> impl IntoElement {
    h_flex()
        .id("auto-upload-grid-header")
        .border_b_1()
        .border_color(theme.separator)
        .bg(theme.muted_fill)
        .child(
            div()
                .w(px(PROJECT_COL_W))
                .px_3()
                .py_2()
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text_muted)
                .child("项目"),
        )
        .children(REPORT_COLUMNS.iter().map(|(_, label)| {
            div()
                .w(px(REPORT_COL_W))
                .px_1()
                .py_2()
                .flex()
                .items_center()
                .justify_center()
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text_muted)
                .child(*label)
        }))
}

/// 矩阵单行（项目名 + 每报表类型单元格）
fn render_grid_row(row: &ProjectReportStatus, ix: usize, theme: &AppTheme) -> impl IntoElement {
    let bg = if ix % 2 == 1 {
        theme.muted_fill.opacity(0.4)
    } else {
        theme.card_bg
    };
    h_flex()
        .id(SharedString::from(format!(
            "auto-upload-row-{}",
            row.project_id
        )))
        .border_b_1()
        .border_color(theme.separator)
        .bg(bg)
        .child(
            div()
                .w(px(PROJECT_COL_W))
                .px_3()
                .py_2()
                .text_sm()
                .text_color(theme.text_primary)
                .child(row.project_name.clone()),
        )
        .children(
            REPORT_COLUMNS
                .iter()
                .map(|(key, _)| render_cell(theme, cell_for(row, key))),
        )
}

/// 单个报表类型单元格（按 is_uploaded 着色；✓ 已上传 / ✗ 未上传）
fn render_cell(theme: &AppTheme, cell: Option<&ReportTypeStatus>) -> impl IntoElement {
    let uploaded = cell.map(|c| c.is_uploaded).unwrap_or(false);
    let color = if uploaded {
        theme.success
    } else {
        theme.danger
    };
    div()
        .w(px(REPORT_COL_W))
        .h(px(CELL_H))
        .flex()
        .items_center()
        .justify_center()
        .bg(color)
        .child(
            div()
                .text_sm()
                .text_color(rgb(0xffffff))
                .child(if uploaded { "✓" } else { "✗" }),
        )
}

/// 在项目的 statuses 中按 report_type 查找单元格
fn cell_for<'a>(row: &'a ProjectReportStatus, key: &str) -> Option<&'a ReportTypeStatus> {
    row.statuses.iter().find(|s| s.report_type == key)
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    /// 测试宿主：包装 Entity，走完整渲染路径（四态 × 亮/暗）
    struct AutoUploadHost {
        view: Entity<AutoUploadView>,
    }

    impl gpui::Render for AutoUploadHost {
        fn render(
            &mut self,
            _window: &mut gpui::Window,
            _cx: &mut gpui::Context<Self>,
        ) -> impl IntoElement {
            self.view.clone().into_any_element()
        }
    }

    fn create_view(cx: &mut TestAppContext) -> Entity<AutoUploadView> {
        cx.new(|cx| AutoUploadView::new(cx, Client::new("http://127.0.0.1:1")))
    }

    fn read_state(cx: &TestAppContext, view: &Entity<AutoUploadView>) -> AutoUploadState {
        cx.read(|app| view.read(app).state.read(app).clone())
    }

    fn sample_response() -> RpaReportStatusResponse {
        RpaReportStatusResponse {
            country: "US".to_string(),
            items: vec![
                ProjectReportStatus {
                    project_id: 3,
                    project_name: "项目 A".to_string(),
                    country: "US".to_string(),
                    statuses: vec![
                        ReportTypeStatus {
                            report_type: "inventory_report".to_string(),
                            has_data: true,
                            is_uploaded: true,
                            latest_date: Some("2026-08-15".to_string()),
                            original_filename: None,
                            status_source: Some("rpa".to_string()),
                        },
                        ReportTypeStatus {
                            report_type: "sales_report".to_string(),
                            has_data: true,
                            is_uploaded: false,
                            latest_date: None,
                            original_filename: None,
                            status_source: None,
                        },
                    ],
                },
                ProjectReportStatus {
                    project_id: 7,
                    project_name: "项目 B".to_string(),
                    country: "US".to_string(),
                    statuses: vec![ReportTypeStatus {
                        report_type: "inventory_report".to_string(),
                        has_data: false,
                        is_uploaded: false,
                        latest_date: None,
                        original_filename: None,
                        status_source: None,
                    }],
                },
            ],
        }
    }

    /// 契约：初始状态为 Loading，未触发首拉
    #[gpui::test]
    async fn initial_state_is_loading(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        assert_eq!(read_state(cx, &view), AutoUploadState::Loading);
        assert!(!cx.read(|app| view.read(app).loaded));
        assert_eq!(cx.read(|app| view.read(app).country), "US");
    }

    /// 契约：apply_result 状态转换（Loaded / Empty / Error）+ 竞态保护
    #[gpui::test]
    async fn apply_result_transitions_and_stale_discarded(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);

        // 竞态保护：过期请求 1 被丢弃（当前 2）
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 2;
                this.apply_result(1, Ok((sample_response(), vec![])), cx);
            });
        });
        assert_eq!(read_state(cx, &view), AutoUploadState::Loading);

        // 最新请求 2 正常落点（Loaded，并记下项目列表）
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.apply_result(
                    2,
                    Ok((
                        sample_response(),
                        vec![ManagedProject {
                            id: 3,
                            name: "项目 A".to_string(),
                            is_active: true,
                            ..Default::default()
                        }],
                    )),
                    cx,
                );
            });
        });
        assert_eq!(
            read_state(cx, &view),
            AutoUploadState::Loaded(sample_response())
        );
        assert_eq!(cx.read(|app| view.read(app).projects.len()), 1);

        // Empty：无项目
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 3;
                this.apply_result(
                    3,
                    Ok((
                        RpaReportStatusResponse {
                            country: "US".to_string(),
                            items: vec![],
                        },
                        vec![],
                    )),
                    cx,
                );
            });
        });
        assert_eq!(read_state(cx, &view), AutoUploadState::Empty);

        // Error
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 4;
                this.apply_result(4, Err("接口 500".to_string()), cx);
            });
        });
        assert_eq!(
            read_state(cx, &view),
            AutoUploadState::Error("接口 500".to_string())
        );
    }

    /// 契约：日期偏移 ±N 天 + 今天
    #[gpui::test]
    async fn date_shift_and_today(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        let base = cx.read(|app| view.read(app).report_date);
        cx.update(|cx| {
            view.update(cx, |this, cx| this.shift_date(1, cx));
        });
        assert_eq!(
            cx.read(|app| view.read(app).report_date),
            shift_naive_date(base, 1)
        );
        cx.update(|cx| {
            view.update(cx, |this, cx| this.shift_date(-1, cx));
        });
        assert_eq!(cx.read(|app| view.read(app).report_date), base);
        // 今天
        let today = Local::now().date_naive();
        cx.update(|cx| {
            view.update(cx, |this, cx| this.select_today(cx));
        });
        assert_eq!(cx.read(|app| view.read(app).report_date), today);
    }

    /// 契约：项目多选过滤 toggle
    #[gpui::test]
    async fn project_filter_toggle(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.toggle_project("项目 A".to_string(), cx);
            });
        });
        assert_eq!(
            cx.read(|app| view.read(app).selected_projects.clone()),
            vec!["项目 A".to_string()]
        );
        // 再 toggle 同一项目 → 取消
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.toggle_project("项目 A".to_string(), cx);
            });
        });
        assert!(cx.read(|app| view.read(app).selected_projects.is_empty()));
    }

    /// 合约：站点切换更新 country（不同值触发 reload，loaded 置真）
    #[gpui::test]
    async fn country_switch_updates_value(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        assert_eq!(cx.read(|app| view.read(app).country), "US");
        cx.update(|cx| {
            view.update(cx, |this, cx| this.select_country("DE", cx));
        });
        assert_eq!(cx.read(|app| view.read(app).country), "DE");
        assert!(cx.read(|app| view.read(app).loaded));
        // 同值不触发 reload（loaded 不变，仍为真但不再 +1 request_id）
        let before = cx.read(|app| view.read(app).latest_request_id);
        cx.update(|cx| {
            view.update(cx, |this, cx| this.select_country("DE", cx));
        });
        assert_eq!(
            cx.read(|app| view.read(app).latest_request_id),
            before,
            "同值切换不应触发新的拉取"
        );
    }

    // ---------- 渲染冒烟（亮 / 暗 × 四态） ----------

    #[gpui::test]
    async fn renders_loaded_in_both_modes(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Ok((sample_response(), vec![])), cx);
            });
        });
        let (_host, cx2) = cx.add_window_view(|_window, _cx| AutoUploadHost { view: view.clone() });
        cx2.read(|app| assert!(!crate::theme::AppTheme::current(app).is_dark()));

        // 切深色重渲染不 panic
        cx2.update(|_window, app| {
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, app);
        });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    #[gpui::test]
    async fn renders_empty_and_error_and_loading(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let view = create_view(cx);
        // Empty
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(
                    1,
                    Ok((
                        RpaReportStatusResponse {
                            country: "US".to_string(),
                            items: vec![],
                        },
                        vec![],
                    )),
                    cx,
                );
            });
        });
        let (_h1, _c1) = cx.add_window_view(|_window, _cx| AutoUploadHost { view: view.clone() });

        // Error
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 2;
                this.apply_result(2, Err("网络连接失败".to_string()), cx);
            });
        });
        let (_h2, _c2) = cx.add_window_view(|_window, _cx| AutoUploadHost { view: view.clone() });

        // Loading（重置回 Loading）
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.state.update(cx, |s, cx| {
                    *s = AutoUploadState::Loading;
                    cx.notify();
                });
            });
        });
        let (_h3, _c3) = cx.add_window_view(|_window, _cx| AutoUploadHost { view: view.clone() });
    }
}
