//! AI 智能 → 虚拟办公室 / 数字员工（BLF-803 Stage12 新建）
//!
//! - **数字员工**（`/dashboard/ai/digital-employees`）：管理列表 Pattern A
//!   形态——员工卡片墙 + 状态灯（名称 / 类型 / 状态徽标 / 心跳时间），
//!   数据源 `GET /api/v1/digital-employees`（gui-api-client::ai，只读）。
//! - **虚拟办公室**（`/dashboard/ai/digital-employees/office`）：轻量占位
//!   场景页——员工卡片墙 + 状态灯 + 今日完成数。web 端的 SSE 实时推进
//!   （`/digital-employees/office/stream`）、拟人化动效与 chatter 信息流
//!   **明确 out of scope**（长驻 SSE 消费 + 虚拟播放引擎属后续批次；
//!   本期以列表快照呈现办公室全景），PR 描述已注明。

use gpui::prelude::*;
use gpui::{
    div, px, App, AsyncApp, Context, Entity, FontWeight, IntoElement, Render, SharedString,
    WeakEntity, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants},
    v_flex, Sizable,
};
use gui_api_client::Client;
use gui_domain::ai::DigitalEmployeeItem;

use crate::theme::{AppTheme, FONT_BASE};
use crate::widgets::data_grid::{pattern_a_shell, AggregateItem};
use crate::widgets::data_table::TabularNumsExt;
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「AI 智能 → 数字员工」URL
pub const DIGITAL_EMPLOYEES_URL: &str = "/dashboard/ai/digital-employees";
/// sidebar「AI 智能 → 虚拟办公室」URL（本期为同一视图的 office 形态入口）
pub const VIRTUAL_OFFICE_URL: &str = "/dashboard/ai/digital-employees/office";

/// 视图形态：管理列表 / 办公室场景墙（数据同源，展示口径不同）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfficeMode {
    /// 数字员工管理列表
    Management,
    /// 虚拟办公室卡片墙
    Office,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EmployeesState {
    Loading,
    Loaded(Vec<DigitalEmployeeItem>),
    Empty,
    Error(String),
}

pub struct VirtualOfficeView {
    client: Client,
    mode: OfficeMode,
    state: Entity<EmployeesState>,
    latest_request_id: u64,
}

impl VirtualOfficeView {
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| EmployeesState::Loading);
        Self {
            client,
            mode: OfficeMode::Management,
            state,
            latest_request_id: 0,
        }
    }

    /// 切换形态（管理 ↔ 办公室）
    pub fn set_mode(&mut self, mode: OfficeMode, cx: &mut Context<Self>) {
        if self.mode != mode {
            self.mode = mode;
            cx.notify();
        }
    }

    /// 当前状态（测试 / 外部消费）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> EmployeesState {
        self.state.read(cx).clone()
    }

    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        self.state.update(cx, |state, cx| {
            *state = EmployeesState::Loading;
            cx.notify();
        });
        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(async {
                        let list = client
                            .digital_employee_list()
                            .await
                            .map_err(|e| e.user_message())?;
                        Ok::<_, String>(list)
                    })
                })
                .await;
            this.update(cx, |this, cx| {
                if this.latest_request_id != request_id {
                    return;
                }
                let next = match result {
                    Ok(list) if list.items.is_empty() => EmployeesState::Empty,
                    Ok(list) => EmployeesState::Loaded(list.items),
                    Err(msg) => EmployeesState::Error(msg),
                };
                this.state.update(cx, |state, cx| {
                    *state = next;
                    cx.notify();
                });
            })
            .ok();
        })
        .detach();
    }
}

impl Render for VirtualOfficeView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let view = cx.entity();

        let (title, subtitle) = match self.mode {
            OfficeMode::Office => (
                "虚拟办公室",
                "数字员工工作状态全景 · 实时推进请在 web 端查看",
            ),
            OfficeMode::Management => (
                "数字员工",
                "自动化员工的类型与心跳状态（管理操作走 web 端）",
            ),
        };
        let header = PageHeader::new(title).subtitle(subtitle);

        // 工具栏：形态切换 + 刷新
        let is_office = self.mode == OfficeMode::Office;
        let toolbar = h_flex()
            .gap_2()
            .items_center()
            .px_2()
            .child(
                Button::new("vo-mode-management")
                    .when(!is_office, |b| b.primary())
                    .when(is_office, |b| b.outline())
                    .small()
                    .label("管理列表")
                    .on_click({
                        let view = view.clone();
                        move |_, _, cx| {
                            view.update(cx, |this, cx| this.set_mode(OfficeMode::Management, cx));
                        }
                    }),
            )
            .child(
                Button::new("vo-mode-office")
                    .when(is_office, |b| b.primary())
                    .when(!is_office, |b| b.outline())
                    .small()
                    .label("办公室")
                    .on_click({
                        let view = view.clone();
                        move |_, _, cx| {
                            view.update(cx, |this, cx| this.set_mode(OfficeMode::Office, cx));
                        }
                    }),
            )
            .child(div().flex_1())
            .child(
                Button::new("vo-refresh")
                    .outline()
                    .small()
                    .label("刷新")
                    .on_click({
                        let view = view.clone();
                        move |_, _, cx| {
                            view.update(cx, |this, cx| this.reload(cx));
                        }
                    }),
            );

        let body: gpui::AnyElement = match &state {
            EmployeesState::Loading => state_views::skeleton_loading(
                &app_theme,
                &[SkeletonBlock::Kpi(4), SkeletonBlock::Table(240.0)],
            )
            .into_any_element(),
            EmployeesState::Error(msg) => state_views::error_state(
                &view,
                &app_theme,
                "virtual-office-error",
                "数字员工加载失败",
                msg,
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            EmployeesState::Empty => state_views::empty_state_with_action_desc(
                &view,
                &app_theme,
                "virtual-office-empty",
                "icons/users.svg",
                "暂无数字员工",
                Some("创建与管理请走 web 端「AI 智能 → 数字员工」".to_string()),
                "刷新",
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            EmployeesState::Loaded(ref items) => {
                let mut wall = v_flex()
                    .id("virtual-office-wall")
                    .p_2()
                    .gap_2()
                    .overflow_y_scroll();
                // 卡片墙：每行 3 张（flex wrap 由外层承担）
                for chunk in items.chunks(3) {
                    wall = wall.child(
                        h_flex().gap_2().children(
                            chunk
                                .iter()
                                .map(|e| employee_card(e, is_office, &app_theme)),
                        ),
                    );
                }

                v_flex()
                    .id("virtual-office-body")
                    .size_full()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(wall)
                    .into_any_element()
            }
        };

        // 底部聚合条（Loaded 态才有数据）
        let footer = if let EmployeesState::Loaded(items) = &state {
            let running = items.iter().filter(|e| e.status == "running").count();
            let failed = items.iter().filter(|e| e.status == "failed").count();
            let idle = items.iter().filter(|e| e.status == "idle").count();
            crate::widgets::data_grid::aggregate_strip(
                &app_theme,
                "virtual-office",
                &[
                    AggregateItem::new("总数", items.len().to_string()),
                    AggregateItem::new("运行中", running.to_string())
                        .tone(crate::widgets::data_grid::AggregateTone::Positive),
                    AggregateItem::new("待命", idle.to_string()),
                    AggregateItem::new("异常", failed.to_string()).tone(if failed > 0 {
                        crate::widgets::data_grid::AggregateTone::Danger
                    } else {
                        crate::widgets::data_grid::AggregateTone::Neutral
                    }),
                ],
            )
            .into_any_element()
        } else {
            div().into_any_element()
        };

        pattern_a_shell(&app_theme, "virtual-office", header, toolbar, body, footer)
            .into_any_element()
    }
}

use gpui_component::h_flex;

/// 员工卡（状态灯 + 名称 + 类型/描述；office 形态加今日完成数）
fn employee_card(e: &DigitalEmployeeItem, office_mode: bool, theme: &AppTheme) -> gpui::AnyElement {
    let (status_text, on_duty) = status_for(&e.status);
    let (dot_color, card_border) = if e.status == "failed" {
        (theme.danger, theme.danger.opacity(0.35))
    } else if on_duty {
        (theme.success, theme.success.opacity(0.30))
    } else {
        (theme.text_muted, theme.separator)
    };
    v_flex()
        .id(SharedString::from(format!("emp-card-{}", e.id)))
        .w(px(300.))
        .flex_none()
        .gap_1p5()
        .p_3()
        .rounded(px(theme.radius_lg))
        .border_1()
        .border_color(card_border)
        .bg(theme.card_bg)
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .gap_2()
                .child(
                    h_flex()
                        .gap_1p5()
                        .items_center()
                        .child(div().size_2().flex_shrink_0().rounded_full().bg(dot_color))
                        .child(
                            div()
                                .text_size(px(crate::theme::fs(FONT_BASE)))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text_primary)
                                .truncate()
                                .child(e.name.clone()),
                        ),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(if e.status == "failed" {
                            theme.danger
                        } else if on_duty {
                            theme.success
                        } else {
                            theme.text_muted
                        })
                        .child(status_text),
                ),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .truncate()
                .child(employee_type_label(&e.employee_type)),
        )
        .when_some(e.description.clone(), |card, desc| {
            card.child(
                div()
                    .text_xs()
                    .line_height(px(15.))
                    .text_color(theme.text_secondary)
                    .truncate()
                    .child(desc),
            )
        })
        .when(office_mode, |card| {
            card.child(
                h_flex()
                    .justify_between()
                    .items_center()
                    .pt_0p5()
                    .border_t_1()
                    .border_color(theme.separator)
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child("今日完成"),
                    )
                    .child(
                        div()
                            .text_sm()
                            .mono_tabular_nums()
                            .text_color(theme.text_primary)
                            .child(heartbeat_text(e)),
                    ),
            )
        })
        .into_any_element()
}

/// 员工状态 → (标签, 是否在岗)
fn status_for(status: &str) -> (&'static str, bool) {
    match status {
        "running" => ("运行中", true),
        "idle" => ("待命", true),
        "succeeded" => ("已完成", false),
        "failed" => ("异常", false),
        "suspended" => ("已暂停", false),
        _ => ("未知", false),
    }
}

/// 员工类型中文标签
fn employee_type_label(t: &str) -> String {
    let label = match t {
        "auto_report_upload" => "报表上传",
        "scheduled_job" => "定时任务",
        "rpa_bot" => "RPA 机器人",
        "ai_agent" => "AI Agent",
        "monitoring" => "监控",
        "database" => "数据库",
        "custom" => "自定义",
        other => other,
    };
    format!("类型：{label}")
}

/// 心跳摘要（office 卡片底部；无心跳显示占位）
fn heartbeat_text(e: &DigitalEmployeeItem) -> String {
    match &e.last_heartbeat_at {
        Some(ts) => {
            let date_part = ts.get(..10).unwrap_or(ts);
            format!("{date_part} 有心跳")
        }
        None => "— 无心跳".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_constants_match_sidebar() {
        assert_eq!(DIGITAL_EMPLOYEES_URL, "/dashboard/ai/digital-employees");
        assert_eq!(VIRTUAL_OFFICE_URL, "/dashboard/ai/digital-employees/office");
    }

    #[test]
    fn status_maps_semantics() {
        assert_eq!(status_for("running"), ("运行中", true));
        assert_eq!(status_for("idle"), ("待命", true));
        assert_eq!(status_for("failed"), ("异常", false));
        assert_eq!(status_for("offline"), ("未知", false));
    }

    #[test]
    fn employee_type_labels_localized() {
        assert!(employee_type_label("rpa_bot").contains("RPA"));
        assert!(employee_type_label("custom").contains("自定义"));
        assert!(employee_type_label("weird").contains("weird"));
    }
}
