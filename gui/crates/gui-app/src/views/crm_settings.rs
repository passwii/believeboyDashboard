//! CRM → CRM 设置（Stage13，BLF-804）
//!
//! 对齐 web 端 `app/dashboard/crm/settings` 的**只读配置面**：规则引擎
//! （「当 X 发生，做 Y」自动化规则列表 + 启停徽标）+ 工作流自动化设置
//! （7 天无跟进提醒阈值 / 邮件开关）。
//!
//! 数据源：
//! - `GET /api/v1/crm/rules`（gui-api-client::crm `crm_rules`）
//! - `GET /api/v1/crm/settings/workflow`（gui-api-client::crm `crm_workflow_settings`）
//!
//! ## 与 web 端的取舍（issue 允许按 macOS 原生习惯精简并说明）
//!
//! - **保留**：双区块结构（规则引擎 + 工作流设置）、规则启停状态徽标、
//!   触发条件 / 执行动作中文描述、工作流阈值天数与邮件开关展示；
//! - **精简**：规则新建 / 编辑 / 删除与工作流设置的**写链路**不移植——GUI 无
//!   表单弹层先例（v1 只读主面），且两块均为 admin-gated 配置，低频修改走
//!   web 端；403 无权限态优雅降级（对齐 crm_audit 范式）。
//!
//! 权限口径：后端 `require_admin` 兜底；非管理员会话请求返回 403 → Forbidden 态。


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
use gui_domain::crm::{CrmRuleItem, CrmWorkflowSettings};

use crate::theme::AppTheme;
use crate::widgets::data_table::TabularNumsExt;
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「CRM 客户与合作伙伴 → CRM 设置」URL（数据权威 gui-domain::sidebar）
pub const CRM_SETTINGS_URL: &str = "/dashboard/crm/settings";

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/// 视图四态（对齐既有业务视图约定；403 → Forbidden 单列）
#[derive(Debug, Clone, PartialEq)]
pub enum SettingsState {
    /// 首屏 / 刷新中
    Loading,
    /// 数据就绪（规则列表 + 工作流设置）
    Loaded(Box<SettingsData>),
    /// 完全无配置
    Empty,
    /// 请求失败
    Error(String),
    /// 非管理员（后端 403）
    Forbidden,
}

/// Loaded 数据（两个端点合并落点；任一成功即可展示另一段空占位）
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SettingsData {
    pub rules: Vec<CrmRuleItem>,
    pub workflow: Option<CrmWorkflowSettings>,
}

impl SettingsState {
    /// 由两段拉取结果合成下一状态（纯函数，可单测）：
    /// - 任一段 403 → Forbidden（admin 页整页无权限）；
    /// - 规则段成功 → Loaded（workflow 失败仅丢该段，主数据仍可看）；
    /// - 规则段失败但 workflow 成功 → Loaded（rules 空）；
    /// - 两段都失败 → Error（取第一条错误文案）。
    pub fn merge(
        rules: Result<Vec<CrmRuleItem>, (String, bool)>,
        workflow: Result<CrmWorkflowSettings, (String, bool)>,
    ) -> Self {
        let rules_forbidden = matches!(&rules, Err((_, true)));
        let workflow_forbidden = matches!(&workflow, Err((_, true)));
        if rules_forbidden || workflow_forbidden {
            return Self::Forbidden;
        }
        let rules_ok = rules.map_err(|(msg, _)| msg);
        let workflow_ok = workflow.ok();
        match rules_ok {
            Ok(rules) if !rules.is_empty() => {
                Self::Loaded(Box::new(SettingsData { rules, workflow: workflow_ok }))
            }
            // workflow 兜底可见（有设置即非完全空页面）
            Ok(_) | Err(_) if workflow_ok.is_some() => Self::Loaded(Box::new(SettingsData {
                rules: Vec::new(),
                workflow: workflow_ok,
            })),
            Ok(_) => Self::Empty,
            Err(msg) => Self::Error(msg),
        }
    }
}

/// CRM 设置视图（只读配置面：规则引擎 + 工作流自动化）
pub struct CrmSettingsView {
    state: Entity<SettingsState>,
    client: Client,
    latest_request_id: u64,
}

impl CrmSettingsView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| SettingsState::Loading);
        Self {
            state,
            client,
            latest_request_id: 0,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> SettingsState {
        self.state.read(cx).clone()
    }

    /// 重新拉取：首屏 / 错误重试共用入口（竞态保护）
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;

        self.state.update(cx, |state, cx| {
            *state = SettingsState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    let (rules, workflow) = crate::runtime::runtime().block_on(async {
                        let r = client.crm_rules().await;
                        let w = client.crm_workflow_settings().await;
                        (
                            r.map_err(|e| (e.user_message(), e.status() == Some(403))),
                            w.map_err(|e| (e.user_message(), e.status() == Some(403))),
                        )
                    });
                    (request_id, SettingsState::merge(rules, workflow))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                if result.0 != this.latest_request_id {
                    return; // 过期响应，丢弃
                }
                this.state.update(cx, |state, cx| {
                    *state = result.1;
                    cx.notify();
                });
            })
            .ok();
        })
        .detach();
    }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for CrmSettingsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let view = cx.entity();
        let state = self.state.read(cx).clone();

        let header = PageHeader::new("CRM 设置")
            .subtitle("规则引擎 · 工作流自动化（仅管理员）；编辑操作走 web 端")
            .action(
                Button::new("crm-settings-refresh")
                    .outline()
                    .small()
                    .label("刷新")
                    .on_click({
                        let view = view.clone();
                        move |_ev, _w, cx| {
                            view.update(cx, |this, cx| this.reload(cx));
                        }
                    }),
            );

        let body: gpui::AnyElement = match &state {
            SettingsState::Loading => state_views::skeleton_loading(
                &app_theme,
                &[SkeletonBlock::Kpi(4), SkeletonBlock::Table(240.0)],
            )
            .into_any_element(),
            SettingsState::Error(msg) => state_views::error_state(
                &view,
                &app_theme,
                "crm-settings-error",
                "CRM 设置加载失败",
                msg.clone(),
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            SettingsState::Empty => state_views::empty_state_with_action_desc(
                &view,
                &app_theme,
                "crm-settings-empty",
                "icons/settings.svg",
                "暂无配置",
                Some("规则引擎与工作流设置请先在 web 端创建".to_string()),
                "刷新",
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            SettingsState::Forbidden => render_forbidden(&app_theme).into_any_element(),
            SettingsState::Loaded(data) => render_loaded(data, &app_theme).into_any_element(),
        };

        v_flex()
            .id("crm-settings")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            .child(header)
            .child(content_guard().child(body))
    }
}

/// 非管理员兜底（对齐 crm_audit forbidden 范式：优雅降级而非报错）
fn render_forbidden(theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("crm-settings-forbidden")
        .items_center()
        .justify_center()
        .gap_2()
        .p_10()
        .rounded(px(theme.radius_lg))
        .border_1()
        .border_color(theme.warning)
        .child(
            div().text_size(px(crate::theme::fs(crate::theme::FONT_BASE)))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.warning)
                .child("无权限查看 CRM 设置"),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .child("该页面仅管理员可见，请联系管理员或前往 web 端查看"),
        )
}

/// Loaded：规则引擎卡 + 工作流设置卡
fn render_loaded(data: &SettingsData, theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("crm-settings-loaded")
        .w_full()
        .gap_4()
        .child(render_rules_card(&data.rules, theme))
        .child(render_workflow_card(data.workflow.as_ref(), theme))
}

/// 规则引擎卡：规则行（名称 + 启停徽标 + 描述）
fn render_rules_card(rules: &[CrmRuleItem], theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("crm-settings-rules-card")
        .w_full()
        .rounded(px(theme.radius_lg))
        .border_1()
        .border_color(theme.separator)
        .bg(theme.card_bg)
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .px_4()
                .py_2()
                .border_b_1()
                .border_color(theme.separator)
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_primary)
                        .child("规则引擎"),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(format!("{} 条规则 · 每日自动扫描", rules.len())),
                ),
        )
        .when(rules.is_empty(), |col| {
            col.child(
                div()
                    .px_4()
                    .py_6()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child("暂无规则，可在 web 端「CRM 设置」新建"),
            )
        })
        .children(rules.iter().enumerate().map(|(ix, rule)| {
            render_rule_row(rule, ix == rules.len() - 1, theme)
        }))
}

/// 单条规则行：名称 + 启停徽标 + 条件/动作描述
fn render_rule_row(rule: &CrmRuleItem, last: bool, theme: &AppTheme) -> gpui::AnyElement {
    let (status_label, status_color) = if rule.enabled {
        ("启用中", theme.success)
    } else {
        ("已停用", theme.text_muted)
    };
    h_flex()
        .id(SharedString::from(format!(
            "crm-settings-rule-{}",
            rule.id
        )))
        .items_start()
        .gap_3()
        .px_4()
        .py_2()
        .when(!last, |row| {
            row.border_b_1().border_color(theme.separator.opacity(0.6))
        })
        .child(
            h_flex()
                .flex_none()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_primary)
                        .child(rule.name.clone()),
                )
                .child(
                    div()
                        .px_1p5()
                        .py_0p5()
                        .rounded(px(theme.radius))
                        .text_xs()
                        .text_color(status_color)
                        .child(status_label),
                ),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_xs()
                .text_color(theme.text_secondary)
                .child(describe_rule(rule)),
        )
        .into_any_element()
}

/// 规则描述：「当 X 发生，做 Y」可视化文案（对齐 web describeRule 口径）
fn describe_rule(rule: &CrmRuleItem) -> String {
    format!("当 {} 时，执行 {}", rule.trigger_kind_label(), rule.action_summary())
}

/// 工作流自动化卡：7 天无跟进提醒阈值 + 邮件开关
fn render_workflow_card(workflow: Option<&CrmWorkflowSettings>, theme: &AppTheme) -> impl IntoElement {
    let threshold = workflow
        .map(|w| w.stale_days.to_string())
        .unwrap_or_else(|| "—".to_string());
    let (email_label, email_color) = match workflow.map(|w| w.stale_email_enabled) {
        Some(true) => ("已开启", theme.success),
        Some(false) => ("已关闭", theme.text_muted),
        None => ("—", theme.text_muted),
    };

    v_flex()
        .id("crm-settings-workflow-card")
        .w_full()
        .rounded(px(theme.radius_lg))
        .border_1()
        .border_color(theme.separator)
        .bg(theme.card_bg)
        .child(
            h_flex()
                .px_4()
                .py_2()
                .border_b_1()
                .border_color(theme.separator)
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_primary)
                        .child("工作流自动化"),
                ),
        )
        .child(
            h_flex()
                .px_4()
                .py_3()
                .gap_8()
                .child(
                    v_flex()
                        .gap_1()
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.text_muted)
                                .child("无跟进提醒阈值（天）"),
                        )
                        .child(
                            div().text_size(px(crate::theme::fs(crate::theme::FONT_TITLE_LG)))
                                .mono_tabular_nums()
                                .text_color(theme.text_primary)
                                .child(threshold),
                        ),
                )
                .child(
                    v_flex()
                        .gap_1()
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.text_muted)
                                .child("提醒邮件"),
                        )
                        .child(
                            div().text_size(px(crate::theme::fs(crate::theme::FONT_TITLE_LG)))
                                .text_color(email_color)
                                .child(email_label),
                        ),
                ),
        )
}
