//! 系统管理 → 告警中心（Stage13，BLF-804）
//!
//! 对齐 web 端 `app/dashboard/system/alerts/page.tsx` 的**只读主面**：
//! 统计卡六格（活跃/严重/警告/信息/今日已确认/今日已解决）+ 事件列表
//! （severity/status 双筛选 + 分页）。
//!
//! 数据源（gui-api-client::alerts，Stage13 只读接入）：
//! - `GET /api/v1/alerts/stats` → [`gui_domain::alerts::AlertStats`]
//! - `GET /api/v1/alerts/events` → [`gui_domain::alerts::AlertEventPage`]
//!
//! ## 与 web 端的取舍
//!
//! - **保留**：统计卡、severity × status 双筛选、事件表（级别/指标/偏差/
//!   消息/状态/触发时刻）、分页（20 行对齐 web）；
//! - **精简**：规则管理 / 通知偏好两个 Tab 的 CRUD 不移植——写链路走 web 端
//!   （模块头与 PR 说明注明）；事件「确认 / 解决」按钮同理不接。


// Stage13 视图：URL 常量与测试钩子属模块契约面，root.rs 接线前允许暂未消费。
#![allow(dead_code)] // ⚠️ 内部属性必须在文件顶部——见下方等价实现

use gpui::prelude::*;
use gpui::{
    div, px, App, AsyncApp, Context, Entity, FontWeight, IntoElement, Render, SharedString,
    WeakEntity, Window,
};
use gpui_component::button::Button;
use gpui_component::{h_flex, v_flex, Sizable};
use gui_api_client::Client;
use gui_domain::alerts::{AlertEvent, AlertEventPage, AlertStats};

use gui_domain::system_management::format_time_ago;

use crate::theme::{AppTheme, FONT_BASE};
use crate::widgets::data_table::{ColumnDef, DataTable};
use crate::widgets::filter_bar::filter_select;
use crate::widgets::page_header::PageHeader;
use crate::widgets::pagination::{pagination_bar, PageState};
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「系统管理 → 告警中心」URL（数据权威 gui-domain::sidebar）
pub const ALERTS_CENTER_URL: &str = "/dashboard/system/alerts";

/// 事件每页行数（对齐 web AlertEventsTab 默认 20）
const PAGE_SIZE: usize = 20;

// ---------------------------------------------------------------------------
// 筛选模型
// ---------------------------------------------------------------------------

/// severity 筛选（全部 / critical / warning / info）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeverityFilter {
    All,
    Critical,
    Warning,
    Info,
}

impl SeverityFilter {
    pub const ALL: [Self; 4] = [Self::All, Self::Critical, Self::Warning, Self::Info];

    pub fn label(self) -> &'static str {
        match self {
            Self::All => "全部级别",
            Self::Critical => "严重",
            Self::Warning => "警告",
            Self::Info => "信息",
        }
    }

    fn as_query(self) -> Option<&'static str> {
        match self {
            Self::All => None,
            Self::Critical => Some("critical"),
            Self::Warning => Some("warning"),
            Self::Info => Some("info"),
        }
    }
}

/// status 筛选（全部 / open / acknowledged / resolved）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventStatusFilter {
    All,
    Open,
    Acknowledged,
    Resolved,
}

impl EventStatusFilter {
    pub const ALL: [Self; 4] = [Self::All, Self::Open, Self::Acknowledged, Self::Resolved];

    pub fn label(self) -> &'static str {
        match self {
            Self::All => "全部状态",
            Self::Open => "待处理",
            Self::Acknowledged => "已确认",
            Self::Resolved => "已解决",
        }
    }

    fn as_query(self) -> Option<&'static str> {
        match self {
            Self::All => None,
            Self::Open => Some("open"),
            Self::Acknowledged => Some("acknowledged"),
            Self::Resolved => Some("resolved"),
        }
    }
}

// ---------------------------------------------------------------------------
// 状态机 / 视图
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum AlertsState {
    Loading,
    Loaded(Box<AlertsData>),
    Empty,
    Error(String),
}

/// Loaded 数据（统计 + 当前页事件）
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct AlertsData {
    stats: Option<AlertStats>,
    events: AlertEventPage,
}

/// 告警中心视图（四态 + 双筛选 + 分页 + 竞态保护）
pub struct AlertsCenterView {
    state: Entity<AlertsState>,
    client: Client,
    severity: SeverityFilter,
    status: EventStatusFilter,
    page: usize,
    latest_request_id: u64,
    table: Option<Entity<DataTable<gui_domain::alerts::AlertEvent>>>,
}

impl AlertsCenterView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| AlertsState::Loading);
        Self {
            state,
            client,
            severity: SeverityFilter::All,
            status: EventStatusFilter::All,
            page: 1,
            latest_request_id: 0,
            table: None,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub(crate) fn current_state(&self, cx: &App) -> AlertsState {
        self.state.read(cx).clone()
    }

    /// 统计卡独立刷新（轻量：不重置筛选与页码；首屏 reload 一并拉取）
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;

        self.state.update(cx, |state, cx| {
            *state = AlertsState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let severity = self.severity.as_query().map(str::to_string);
        let status = self.status.as_query().map(str::to_string);
        let page = self.page;

        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(async {
                            let stats = client.alert_stats().await;
                            let events = client
                                .alert_events(
                                    severity.as_deref(),
                                    status.as_deref(),
                                    page,
                                    PAGE_SIZE,
                                )
                                .await;
                            (stats, events)
                        })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result.0, result.1, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 应用拉取结果（竞态保护）：stats 失败仅丢统计卡，events 失败落 Error 态
    fn apply_result(
        &mut self,
        request_id: u64,
        stats: Result<AlertStats, gui_api_client::error::ApiError>,
        events: Result<AlertEventPage, gui_api_client::error::ApiError>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        let next = match events {
            Ok(page) if page.items.is_empty() => match stats {
                Ok(s) if s.total_active == 0 => AlertsState::Empty,
                _ => AlertsState::Loaded(Box::new(AlertsData {
                    stats: stats.ok(),
                    events: AlertEventPage::default(),
                })),
            },
            Ok(page) => AlertsState::Loaded(Box::new(AlertsData {
                stats: stats.ok(),
                events: page,
            })),
            Err(e) => AlertsState::Error(e.user_message()),
        };
        self.state.update(cx, |state, cx| {
            *state = next;
            cx.notify();
        });
    }

    /// 切换级别筛选（回第 1 页重拉）
    pub fn set_severity(&mut self, filter: SeverityFilter, cx: &mut Context<Self>) {
        if self.severity == filter {
            return;
        }
        self.severity = filter;
        self.page = 1;
        self.reload(cx);
    }

    /// 切换状态筛选（回第 1 页重拉）
    pub fn set_status_filter(&mut self, filter: EventStatusFilter, cx: &mut Context<Self>) {
        if self.status == filter {
            return;
        }
        self.status = filter;
        self.page = 1;
        self.reload(cx);
    }

    pub fn go_to_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if page == 0 || page == self.page {
            return;
        }
        self.page = page;
        self.reload(cx);
    }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for AlertsCenterView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let view = cx.entity();
        let state = self.state.read(cx).clone();

        let header = PageHeader::new("告警中心")
            .subtitle("异常事件跟踪 · 规则管理与通知偏好编辑走 web 端")
            .action({
                let view = view.clone();
                Button::new("alerts-center-refresh")
                    .outline()
                    .small()
                    .label("刷新")
                    .on_click(move |_ev, _w, cx| {
                        view.update(cx, |this, cx| this.reload(cx));
                    })
            });

        // 工具栏：级别 × 状态双下拉
        let toolbar = h_flex()
            .gap_2()
            .items_center()
            .child(filter_select(
                &app_theme,
                "级别",
                SharedString::from(self.severity.label()),
                "alerts-center-severity-filter",
                build_severity_menu(view.clone(), self.severity),
            ))
            .child(filter_select(
                &app_theme,
                "状态",
                SharedString::from(self.status.label()),
                "alerts-center-status-filter",
                build_status_menu(view.clone(), self.status),
            ));

        // 统计卡行（Loaded 且有 stats 时渲染在 body 首位）
        let stats_cards: Option<gpui::AnyElement> = match &state {
            AlertsState::Loaded(data) => data.stats.as_ref().map(|s| render_stats_cards(s, &app_theme)),
            _ => None,
        };

        let total = match &state {
            AlertsState::Loaded(d) => d.events.total.max(0) as usize,
            _ => 0,
        };

        let body: gpui::AnyElement = match &state {
            AlertsState::Loading => state_views::skeleton_loading(
                &app_theme,
                &[SkeletonBlock::Kpi(6), SkeletonBlock::Table(280.0)],
            )
            .into_any_element(),
            AlertsState::Error(msg) => state_views::error_state(
                &view,
                &app_theme,
                "alerts-center-error",
                "告警数据加载失败",
                msg.clone(),
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            AlertsState::Empty => state_views::empty_state_with_action_desc(
                &view,
                &app_theme,
                "alerts-center-empty",
                "icons/bell.svg",
                "暂无告警事件",
                Some("触发告警规则后事件会出现在这里".to_string()),
                "刷新",
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            AlertsState::Loaded(_) => {
                let table = self.table.get_or_insert_with(|| {
                    cx.new(|_| DataTable::new("alerts-center-table", columns()).striped(true))
                });
                if let AlertsState::Loaded(data) = &state {
                    table.update(cx, |t, cx| t.set_rows_if_changed(&data.events.items, cx));
                }
                v_flex()
                    .size_full()
                    .min_h_0()
                    .gap_2()
                    .when_some(stats_cards, |col, cards| col.child(cards))
                    .child(
                        div()
                            .flex_1()
                            .min_h_0()
                            .child(table.clone()),
                    )
                    .child(pagination_bar(
                        &view,
                        &app_theme,
                        "alerts-center-pagination",
                        &PageState::new(self.page.max(1), PAGE_SIZE, total),
                        &[20],
                        |this, page, cx| this.go_to_page(page, cx),
                        |_this, _size, _cx| {},
                    ))
                    .into_any_element()
            }
        };

        crate::motion::enter_fade_in(
            SharedString::from("alerts-center-fade"),
            crate::widgets::data_grid::pattern_a_shell(
                &app_theme,
                "alerts-center",
                header,
                toolbar,
                body,
                div(),
            ),
            crate::motion::reduce_motion(cx),
        )
        .into_any_element()
    }
}

fn build_severity_menu(
    view: Entity<AlertsCenterView>,
    active: SeverityFilter,
) -> impl Fn(
    gpui_component::menu::PopupMenu,
    &mut Window,
    &mut gpui::Context<'_, gpui_component::menu::PopupMenu>,
) -> gpui_component::menu::PopupMenu
       + 'static {
    move |mut menu, _w, _cx| {
        for option in SeverityFilter::ALL {
            let view = view.clone();
            menu = menu.item(
                gpui_component::menu::PopupMenuItem::new(option.label())
                    .checked(option == active)
                    .on_click(move |_ev, _w, cx| {
                        view.update(cx, |this, cx| this.set_severity(option, cx));
                    }),
            );
        }
        menu
    }
}

fn build_status_menu(
    view: Entity<AlertsCenterView>,
    active: EventStatusFilter,
) -> impl Fn(
    gpui_component::menu::PopupMenu,
    &mut Window,
    &mut gpui::Context<'_, gpui_component::menu::PopupMenu>,
) -> gpui_component::menu::PopupMenu
       + 'static {
    move |mut menu, _w, _cx| {
        for option in EventStatusFilter::ALL {
            let view = view.clone();
            menu = menu.item(
                gpui_component::menu::PopupMenuItem::new(option.label())
                    .checked(option == active)
                    .on_click(move |_ev, _w, cx| {
                        view.update(cx, |this, cx| this.set_status_filter(option, cx));
                    }),
            );
        }
        menu
    }
}

/// 统计卡六格（对齐 web AlertStatsBar：活跃/严重/警告/信息/今日已确认/已解决）
fn render_stats_cards(stats: &AlertStats, theme: &AppTheme) -> gpui::AnyElement {
    let cards = [
        ("活跃告警", stats.total_active.to_string(), theme.text_primary),
        ("严重", stats.critical_count.to_string(), theme.danger),
        ("警告", stats.warning_count.to_string(), theme.warning),
        ("信息", stats.info_count.to_string(), theme.accent),
        (
            "今日已确认",
            stats.acknowledged_today.to_string(),
            theme.success,
        ),
        ("今日已解决", stats.resolved_today.to_string(), theme.success),
    ];
    h_flex()
        .id("alerts-center-stats")
        .w_full()
        .gap_2()
        .children(cards.map(|(label, value, color)| {
            v_flex()
                .id(SharedString::from(format!(
                    "alerts-stat-{}",
                    label
                )))
                .flex_1()
                .gap_1()
                .px_3()
                .py_2()
                .rounded(px(theme.radius))
                .border_1()
                .border_color(theme.separator)
                .bg(theme.card_bg)
                .child(
                    div().text_size(px(crate::theme::fs(FONT_BASE)))
                        .font_weight(FontWeight::SEMIBOLD)
                        .mono_tabular_nums_text()
                        .text_color(color)
                        .child(value),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(label),
                )
        }))
        .into_any_element()
}

/// mono tabular 辅助（局部 trait 别名避免跨视图重复导入噪音）
trait MonoNumsText: gpui::Styled + Sized {
    fn mono_tabular_nums_text(self) -> Self {
        use crate::widgets::data_table::TabularNumsExt;
        self.mono_tabular_nums()
    }
}
impl<E: gpui::Styled + Sized> MonoNumsText for E {}

// ---------------------------------------------------------------------------
// 列定义
// ---------------------------------------------------------------------------

fn columns() -> Vec<ColumnDef<gui_domain::alerts::AlertEvent>> {
    vec![
        ColumnDef::text("severity", "级别", |r: &AlertEvent, _theme| {
            SharedString::from(severity_label(r))
        })
        .width(72.0),
        ColumnDef::text("metric", "指标", |r: &AlertEvent, _| SharedString::from(r.metric.clone()))
            .width(140.0),
        ColumnDef::text("deviation", "偏差", |r: &AlertEvent, _| {
            SharedString::from(format!("{:+.1}%", r.deviation_pct))
        })
        .width(88.0),
        ColumnDef::text("message", "消息", |r, _| SharedString::from(r.message.clone())),
        ColumnDef::text("status", "状态", |r: &AlertEvent, _| {
            SharedString::from(r.status_label())
        })
        .width(80.0),
        ColumnDef::text("triggered_at", "触发时刻", |r: &AlertEvent, _| {
            SharedString::from(format_time_ago(&r.triggered_at))
        })
        .width(110.0),
    ]
}

/// 级别中文标签（域类型方法为 &self；此处纯函数便于列定义直接使用）
fn severity_label(event: &gui_domain::alerts::AlertEvent) -> String {
    event.severity_label()
}
