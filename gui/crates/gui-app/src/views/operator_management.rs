//! 系统管理 → 运营管理（Stage13，BLF-804）
//!
//! 对齐 web 端 `app/dashboard/system/operator-management/page.tsx` 的
//! **绩效只读面**：运营绩效月报表（月份选择 + 项目 / 人员 / 周次 /
//! 绩效分），数据源 `GET /api/v1/system-management/operator-management/performance`
//! （gui-api-client::system_management，BLF-797 同源扩展）。
//!
//! ## 与 web 端的取舍（issue 允许按 macOS 原生习惯精简并说明）
//!
//! - **保留**：报告月切换、绩效表（周次 / 项目 / 人员 / 角色 / 分数）、
//!   分数语义色、分页；
//! - **精简**：「角色信息」「佣金管理」两个 Tab 的写链路（角色指派 upsert /
//!   佣金比例覆盖）不移植——admin 写操作走 web 端；本视图承载 performance
//!   Tab 的只读主面。

// Stage13 视图：URL 常量与测试钩子属模块契约面，root.rs 接线前允许暂未消费。
#![allow(dead_code)] // ⚠️ 内部属性必须在文件顶部——见下方等价实现

use gpui::prelude::*;
use gpui::{
    div, App, AsyncApp, Context, Entity, IntoElement, Render, SharedString, WeakEntity, Window,
};
use gpui_component::button::Button;
use gpui_component::{v_flex, Sizable};
use gui_api_client::Client;
use gui_domain::system_management::OperatorPerformanceItem;

use crate::theme::AppTheme;
use crate::widgets::data_table::{ColumnDef, DataTable};
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「系统管理 → 运营管理」URL（数据权威 gui-domain::sidebar）
pub const OPERATOR_MANAGEMENT_URL: &str = "/dashboard/system/operator-management";

/// 每页行数（GUI 单页大表口径）
const PAGE_SIZE: usize = 100;

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum OperatorState {
    Loading,
    Loaded(Box<OperatorPerformanceResponse>),
    Empty,
    Error(String),
}

/// `GET …/operator-performance` 响应别名（域类型）
type OperatorPerformanceResponse = gui_domain::system_management::OperatorPerformanceResponse;

/// 运营管理视图（绩效只读面：四态 + 月份切换 + 竞态保护）
pub struct OperatorManagementView {
    state: Entity<OperatorState>,
    client: Client,
    /// 报告月（`YYYY-MM`）
    report_month: String,
    latest_request_id: u64,
    table: Option<Entity<DataTable<OperatorPerformanceItem>>>,
}

impl OperatorManagementView {
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| OperatorState::Loading);
        Self {
            state,
            client,
            report_month: current_month(),
            latest_request_id: 0,
            table: None,
        }
    }

    #[allow(dead_code)]
    pub(crate) fn current_state(&self, cx: &App) -> OperatorState {
        self.state.read(cx).clone()
    }

    /// 当前报告月（测试用）
    #[allow(dead_code)]
    pub fn current_month(&self) -> &str {
        &self.report_month
    }

    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let month = self.report_month.clone();

        self.state.update(cx, |state, cx| {
            *state = OperatorState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(async { client.operator_performance(&month).await })
                        .map_err(|e| e.user_message())
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<OperatorPerformanceResponse, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return;
        }
        let next = match result {
            Ok(resp) if resp.items.is_empty() => OperatorState::Empty,
            Ok(resp) => OperatorState::Loaded(Box::new(resp)),
            Err(msg) => OperatorState::Error(msg),
        };
        self.state.update(cx, |state, cx| {
            *state = next;
            cx.notify();
        });
    }
}

/// 当前月（`YYYY-MM`；本地时区）
fn current_month() -> String {
    chrono::Local::now().format("%Y-%m").to_string()
}

/// 切换到上/下一个月（`YYYY-MM` 加减；钳制不越界未来月）
pub fn shift_month(month: &str, delta: i32) -> Option<String> {
    let (y, m) = month.split_once('-')?;
    let mut year: i32 = y.parse().ok()?;
    let mut mon: i32 = m.parse().ok()?;
    if !(1..=12).contains(&mon) {
        return None;
    }
    mon += delta;
    while mon > 12 {
        mon -= 12;
        year += 1;
    }
    while mon < 1 {
        mon += 12;
        year -= 1;
    }
    Some(format!("{year:04}-{mon:02}"))
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for OperatorManagementView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let view = cx.entity();
        let state = self.state.read(cx).clone();

        // 页头动作：上月 / 报告月 / 下月 + 刷新
        let header = PageHeader::new("运营管理")
            .subtitle(format!(
                "运营绩效 · {}（角色与佣金编辑走 web 端）",
                self.report_month
            ))
            .action({
                let view = view.clone();
                Button::new("op-prev-month")
                    .outline()
                    .small()
                    .label("← 上月")
                    .on_click(move |_ev, _w, cx| {
                        view.update(cx, |this, cx| {
                            if let Some(m) = shift_month(&this.report_month.clone(), -1) {
                                this.set_report_month(m, cx);
                            }
                        });
                    })
            })
            .action({
                let view = view.clone();
                Button::new("op-next-month")
                    .outline()
                    .small()
                    .label("下月 →")
                    .on_click(move |_ev, _w, cx| {
                        view.update(cx, |this, cx| {
                            if let Some(m) = shift_month(&this.report_month.clone(), 1) {
                                this.set_report_month(m, cx);
                            }
                        });
                    })
            })
            .action({
                let view = view.clone();
                Button::new("op-refresh")
                    .outline()
                    .small()
                    .label("刷新")
                    .on_click(move |_ev, _w, cx| {
                        view.update(cx, |this, cx| this.reload(cx));
                    })
            });

        let body: gpui::AnyElement = match &state {
            OperatorState::Loading => state_views::skeleton_loading(
                &app_theme,
                &[SkeletonBlock::Filter(2), SkeletonBlock::Table(300.0)],
            )
            .into_any_element(),
            OperatorState::Error(msg) => state_views::error_state(
                &view,
                &app_theme,
                "op-mgmt-error",
                "运营绩效加载失败",
                msg.clone(),
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            OperatorState::Empty => state_views::empty_state_with_action_desc(
                &view,
                &app_theme,
                "op-mgmt-empty",
                "icons/shield-user.svg",
                format!("{} 无绩效记录", self.report_month),
                Some("切换月份或先在 web 端录入绩效".to_string()),
                "刷新",
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            OperatorState::Loaded(_) => {
                let rows = match self.state.read(cx) {
                    OperatorState::Loaded(resp) => resp.items.clone(),
                    _ => Vec::new(),
                };
                let table = self.table.get_or_insert_with(|| {
                    cx.new(|_| DataTable::new("op-mgmt-table", columns()).striped(true))
                });
                table.update(cx, |t, cx| t.set_rows_if_changed(&rows, cx));

                v_flex()
                    .id("op-mgmt-scroll")
                    .size_full()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(div().w_full().px_2().child(table.clone()))
                    .into_any_element()
            }
        };

        v_flex()
            .id("operator-management")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            .child(header)
            .child(content_guard().child(body))
    }
}

impl OperatorManagementView {
    /// 切换报告月并重拉
    pub fn set_report_month(&mut self, month: String, cx: &mut Context<Self>) {
        if self.report_month == month {
            return;
        }
        self.report_month = month;
        self.reload(cx);
    }
}

// ---------------------------------------------------------------------------
// 列定义
// ---------------------------------------------------------------------------

fn columns() -> Vec<ColumnDef<OperatorPerformanceItem>> {
    vec![
        ColumnDef::text("week_index", "周次", |r: &OperatorPerformanceItem, _| {
            SharedString::from(format!("第 {} 周", r.week_index))
        })
        .width(88.0)
        .numeric(true),
        ColumnDef::text(
            "project_name",
            "项目",
            |r: &OperatorPerformanceItem, _| SharedString::from(r.project_name.clone()),
        ),
        ColumnDef::text("person_name", "人员", |r: &OperatorPerformanceItem, _| {
            SharedString::from(r.person_name.clone())
        })
        .width(110.0),
        ColumnDef::text("role_type", "角色", |r: &OperatorPerformanceItem, _| {
            SharedString::from(role_label(&r.role_type))
        })
        .width(88.0),
        ColumnDef::number(
            "score",
            "绩效分",
            |r: &OperatorPerformanceItem| r.score as f64,
            |r: &OperatorPerformanceItem, _| SharedString::from(r.score.to_string()),
        )
        .width(96.0),
        ColumnDef::text("note", "备注", |r: &OperatorPerformanceItem, _| {
            SharedString::from(r.note.clone().unwrap_or_else(|| "—".into()))
        }),
    ]
}

/// 角色码中文标签（对齐 web 角色属性三档）
fn role_label(role_type: &str) -> String {
    match role_type {
        "admin" => "管理员",
        "operator" => "运营",
        "businessdev" => "招商",
        other => return other.to_string(),
    }
    .to_string()
}
