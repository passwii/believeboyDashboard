//! 平台巡检编辑表单（P5-1，BLF-717）
//!
//! frontend `inspection-form.tsx` 的 GPUI 等价（按 macOS 习惯精简为内联面板）：
//! 概览点击项目卡片后展开，可编辑账户健康（AHR + 客服绩效 + 配送绩效）、
//! 政策与合规（10 项计数）与状态说明，支持「保存草稿」与「提交」。
//!
//! 架构：
//! - 独立实体（父视图 `PlatformInspectionView` 懒建 + 订阅事件）；
//! - 打开时 `inspection_report` 加载既有草稿（无 → 新建）；
//! - 数字字段用 `InputState`（懒建，初始值来自报告或默认值），保存时统一解析；
//! - 保存 / 提交走 `inspection_save_report` / `inspection_submit_report`，
//!   成功 → emit `ReportEditEvent::Changed`（父视图关闭面板 + 刷新概览）。
//!
//! 已知差异（有意保留）：
//! - 截图上传 / 删除未接入（GPUI 无远程图片管线，见父视图文档）；
//! - 提交前不弹阈值警告（后端校验为准）；
//! - 状态说明用单行输入（web 是 textarea，GPUI 输入能力边界内单行够用）。

use gpui::{
    div, prelude::*, px, App, AsyncApp, Context, Entity, FontWeight, Render, SharedString,
    WeakEntity, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants},
    h_flex,
    input::{Input, InputState},
    menu::PopupMenuItem,
    v_flex, Icon, IconName, Sizable, StyledExt,
};
use gui_api_client::Client;
use gui_domain::operations::platform_inspection::{
    ComplianceData, HealthData, InspectionReport, InspectionReportSave,
};

use crate::theme::AppTheme;
use crate::widgets::filter_bar;

/// 编辑面板事件（父视图订阅）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportEditEvent {
    /// 保存 / 提交成功 → 关闭面板并刷新概览
    Changed,
    /// 返回概览（不保存）
    Back,
}

/// AHR 选项（对齐 frontend AHR_OPTIONS / 后端模板 options）
const AHR_OPTIONS: [(&str, &str); 4] = [
    ("Healthy", "Healthy (健康)"),
    ("Good", "Good (良好)"),
    ("At Risk", "At Risk (有风险)"),
    ("Critical", "Critical (危险)"),
];

/// 数字字段定义（key 对应 HealthData / ComplianceData 字段）
#[derive(Clone, Copy)]
struct MetricField {
    key: &'static str,
    label: &'static str,
    /// 默认值（对齐 frontend DEFAULT_HEALTH：追踪类 100，其余 0）
    default: f64,
    /// 单位后缀（% 或空）
    unit: &'static str,
}

/// 客服绩效字段（health_data 前 3 项）
const SERVICE_FIELDS: [MetricField; 3] = [
    MetricField { key: "negative_feedback", label: "负面反馈", default: 0.0, unit: "" },
    MetricField { key: "a2z_claims", label: "亚马逊 A-to-Z", default: 0.0, unit: "" },
    MetricField { key: "chargeback_claims", label: "信用卡拒付", default: 0.0, unit: "" },
];

/// 配送绩效字段（health_data 后 4 项）
const SHIPPING_FIELDS: [MetricField; 4] = [
    MetricField { key: "late_shipment_rate", label: "迟发率", default: 0.0, unit: "%" },
    MetricField { key: "pre_fulfillment_cancel_rate", label: "配送前取消率", default: 0.0, unit: "%" },
    MetricField { key: "valid_tracking_rate", label: "有效追踪率", default: 100.0, unit: "%" },
    MetricField { key: "on_time_delivery_rate", label: "准时交付率", default: 100.0, unit: "%" },
];

/// 政策与合规字段（compliance_data 全 10 项）
const COMPLIANCE_FIELDS: [MetricField; 10] = [
    MetricField { key: "ip_infringement", label: "涉嫌侵犯知识产权", default: 0.0, unit: "" },
    MetricField { key: "ip_complaints", label: "知识产权投诉", default: 0.0, unit: "" },
    MetricField { key: "product_authenticity_complaints", label: "商品真实性投诉", default: 0.0, unit: "" },
    MetricField { key: "product_condition_complaints", label: "商品状况投诉", default: 0.0, unit: "" },
    MetricField { key: "food_product_safety", label: "食品商品安全", default: 0.0, unit: "" },
    MetricField { key: "listing_policy_violations", label: "上架政策违规", default: 0.0, unit: "" },
    MetricField { key: "restricted_product_violations", label: "受限商品违规", default: 0.0, unit: "" },
    MetricField { key: "review_policy_violations", label: "评论政策违规", default: 0.0, unit: "" },
    MetricField { key: "other_policy_violations", label: "其他违反政策", default: 0.0, unit: "" },
    MetricField { key: "regulatory_compliance", label: "监管合规性", default: 0.0, unit: "" },
];

/// 全部数字字段（输入实体创建顺序 = 此顺序；客服 3 + 配送 4 + 合规 10）
const ALL_FIELDS: [MetricField; 17] = [
    SERVICE_FIELDS[0],
    SERVICE_FIELDS[1],
    SERVICE_FIELDS[2],
    SHIPPING_FIELDS[0],
    SHIPPING_FIELDS[1],
    SHIPPING_FIELDS[2],
    SHIPPING_FIELDS[3],
    COMPLIANCE_FIELDS[0],
    COMPLIANCE_FIELDS[1],
    COMPLIANCE_FIELDS[2],
    COMPLIANCE_FIELDS[3],
    COMPLIANCE_FIELDS[4],
    COMPLIANCE_FIELDS[5],
    COMPLIANCE_FIELDS[6],
    COMPLIANCE_FIELDS[7],
    COMPLIANCE_FIELDS[8],
    COMPLIANCE_FIELDS[9],
];

/// 编辑表单实体（父视图持有 `Option<Entity<ReportEditForm>>`；打开时懒建）
pub struct ReportEditForm {
    client: Client,
    period_id: i64,
    project_id: i64,
    project_name: String,
    /// 已加载的报告（None = 新建草稿）
    report: Option<InspectionReport>,
    loading: bool,
    error: Option<String>,
    /// 操作反馈（保存失败等）
    feedback: Option<String>,
    /// 提交进行中（防重复点击）
    submitting: bool,
    /// AHR 选择
    ahr: Option<String>,
    /// 数字字段输入（懒建；与 ALL_FIELDS 一一对应）
    inputs: Option<Vec<Entity<InputState>>>,
    /// 状态说明输入（懒建）
    summary_input: Option<Entity<InputState>>,
}

impl ReportEditForm {
    /// 新建表单：立即加载既有报告（草稿或空）。
    pub fn new(
        cx: &mut Context<Self>,
        client: Client,
        period_id: i64,
        project_id: i64,
        project_name: String,
    ) -> Self {
        let mut this = Self {
            client,
            period_id,
            project_id,
            project_name,
            report: None,
            loading: true,
            error: None,
            feedback: None,
            submitting: false,
            ahr: None,
            inputs: None,
            summary_input: None,
        };
        this.load(cx);
        this
    }

    /// 加载报告（打开时调用；失败可重试）
    fn load(&mut self, cx: &mut Context<Self>) {
        self.loading = true;
        self.error = None;
        let client = self.client.clone();
        let period_id = self.period_id;
        let project_id = self.project_id;
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(client.inspection_report(period_id, project_id))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.loading = false;
                match result {
                    Ok(report) => {
                        this.report = report;
                        this.ahr = this
                            .report
                            .as_ref()
                            .and_then(|r| r.health_data.as_ref())
                            .and_then(|h| h.account_health_rating.clone());
                        cx.notify();
                    }
                    Err(e) => {
                        this.error = Some(e.user_message());
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    /// 懒建全部输入实体（报告加载完成后首帧；初始值来自报告或默认值）
    fn build_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let report = self.report.clone();
        let health = report.as_ref().and_then(|r| r.health_data.clone());
        let compliance = report.as_ref().and_then(|r| r.compliance_data.clone());
        let mut inputs = Vec::with_capacity(ALL_FIELDS.len());
        for field in ALL_FIELDS {
            let value = field_value(&field, health.as_ref(), compliance.as_ref())
                .unwrap_or(field.default);
            let text = if field.unit.is_empty() {
                format!("{}", value.round() as i64)
            } else {
                format!("{value}")
            };
            let state = cx.new(|cx| {
                InputState::new(window, cx).placeholder("0")
            });
            state.update(cx, |state, cx| state.set_value(text, window, cx));
            inputs.push(state);
        }
        let summary = report
            .as_ref()
            .and_then(|r| r.status_summary.clone())
            .unwrap_or_default();
        let summary_input = cx.new(|cx| {
            InputState::new(window, cx).placeholder("填写本期状态说明（可选）")
        });
        summary_input.update(cx, |state, cx| state.set_value(summary, window, cx));
        self.inputs = Some(inputs);
        self.summary_input = Some(summary_input);
    }

    /// 收集当前输入 → 保存请求体（空输入回退默认值，对齐 web 全量提交契约）。
    /// 纯读取（&App 即可），不触发 notify。
    fn collect(&self, cx: &App) -> InspectionReportSave {
        let mut health = HealthData::default();
        let mut compliance = ComplianceData::default();
        if let Some(inputs) = &self.inputs {
            for (field, state) in ALL_FIELDS.iter().zip(inputs.iter()) {
                let text = state.read(cx).value().to_string();
                let parsed = text.trim().parse::<f64>().ok();
                let value = parsed.or(Some(field.default));
                set_field_value(field.key, value, &mut health, &mut compliance);
            }
        }
        let summary = self
            .summary_input
            .as_ref()
            .map(|s| s.read(cx).value().to_string())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        InspectionReportSave {
            health_data: Some(health),
            compliance_data: Some(compliance),
            status_summary: summary,
            screenshot_ids: Vec::new(),
        }
    }

    /// 保存草稿（POST 创建/更新）
    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.submit_impl(false, window, cx);
    }

    /// 提交（POST .../submit；后端校验必填项）
    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.submit_impl(true, window, cx);
    }

    fn submit_impl(&mut self, submit: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.submitting {
            return;
        }
        self.submitting = true;
        self.feedback = None;
        let body = self.collect(cx);
        let client = self.client.clone();
        let period_id = self.period_id;
        let project_id = self.project_id;
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(async {
                        if submit {
                            client.inspection_submit_report(period_id, project_id).await
                        } else {
                            client
                                .inspection_save_report(period_id, project_id, &body)
                                .await
                        }
                    })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.submitting = false;
                match result {
                    Ok(_) => cx.emit(ReportEditEvent::Changed),
                    Err(e) => {
                        this.feedback = Some(format!("操作失败：{}", e.user_message()));
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
        let _ = window; // InputState 在 render 期创建；本方法用不到 window
    }

    /// 返回概览
    fn back(&mut self, cx: &mut Context<Self>) {
        cx.emit(ReportEditEvent::Back);
    }
}

impl gpui::EventEmitter<ReportEditEvent> for ReportEditForm {}

impl Render for ReportEditForm {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        // 报告加载完成后首帧懒建输入（初始值来自报告；后续报告不再变化）
        if self.report.is_some() && self.inputs.is_none() {
            self.build_inputs(window, cx);
        }

        let mut panel = v_flex()
            .id("pi-edit-form")
            .w_full()
            .gap_4()
            // 头部：返回 + 项目名
            .child(
                h_flex()
                    .items_center()
                    .gap_3()
                    .child(
                        Button::new("pi-edit-back")
                            .ghost()
                            .small()
                            .icon(Icon::new(IconName::ArrowLeft).with_size(px(14.)))
                            .label("返回概览")
                            .on_click(cx.listener(|this, _, _, cx| this.back(cx))),
                    )
                    .child(
                        div()
                            .text_lg()
                            .font_semibold()
                            .text_color(theme.text_primary)
                            .child(self.project_name.clone()),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.text_muted)
                            .child("编辑巡检报告"),
                    )
                    .child(div().flex_1()),
            );

        if self.loading {
            panel = panel.child(
                v_flex()
                    .id("pi-edit-loading")
                    .gap_4()
                    .child(crate::widgets::state_views::loading_state(
                        &theme,
                        "加载报告…",
                    ))
                    .child(
                        div()
                            .w_full()
                            .h(px(320.))
                            .child(gpui_component::skeleton::Skeleton::new()),
                    ),
            );
        } else if let Some(msg) = &self.error {
            panel = panel.child(
                v_flex()
                    .id("pi-edit-error")
                    .w_full()
                    .rounded(px(theme.radius_lg))
                    .bg(theme.card_bg)
                    .shadow(vec![theme.card_shadow_box()])
                    .p_4()
                    .child(
                        gpui_component::alert::Alert::error("pi-edit-error-alert", msg.clone())
                            .title("报告加载失败"),
                    )
                    .child(
                        div().w_full().flex().justify_end().child(
                            Button::new("pi-edit-retry")
                                .outline()
                                .small()
                                .label("重试")
                                .on_click(cx.listener(|this, _, _, cx| this.load(cx))),
                        ),
                    ),
            );
        } else {
            panel = panel
                .child(self.render_sections(&theme, cx))
                .child(div().flex_1())
                .child(self.render_footer(&theme, cx));
        }

        panel
    }
}

impl ReportEditForm {
    fn render_sections(&self, theme: &AppTheme, cx: &mut Context<Self>) -> impl IntoElement {
        let inputs = self.inputs.clone().unwrap_or_default();
        let summary_input = self.summary_input.clone();

        v_flex()
            .id("pi-edit-sections")
            .gap_4()
            // 账户健康：AHR 下拉 + 客服绩效 3 项
            .child(section_card(
                theme,
                "账户健康",
                h_flex()
                    .gap_3()
                    .items_center()
                    .child(self.render_ahr_select(theme, cx))
                    .child(div().text_xs().text_color(theme.text_muted).child("客服绩效"))
                    .child(metric_inputs(theme, &inputs, 0, 3)),
            ))
            // 配送绩效：4 项
            .child(section_card(
                theme,
                "配送绩效",
                metric_inputs(theme, &inputs, 3, 4),
            ))
            // 政策与合规：10 项
            .child(section_card(
                theme,
                "政策与合规",
                metric_inputs(theme, &inputs, 7, 10),
            ))
            // 状态说明
            .child(section_card(
                theme,
                "状态说明",
                h_flex().w_full().child(match summary_input {
                    Some(state) => div().w_full().child(Input::new(&state)).into_any_element(),
                    None => div().into_any_element(),
                }),
            ))
    }

    /// AHR 下拉（filter_select；值存 self.ahr）
    fn render_ahr_select(
        &self,
        theme: &AppTheme,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let current_ahr = self.ahr.clone();
        let current = current_ahr
            .as_deref()
            .and_then(|v| AHR_OPTIONS.iter().find(|(value, _)| *value == v))
            .map(|(_, label)| SharedString::from(*label))
            .unwrap_or_else(|| SharedString::from("请选择"));
        let view = cx.entity();
        filter_bar::filter_select(
            theme,
            "AHR",
            current,
            "pi-edit-ahr",
            move |mut menu, _window, _cx| {
                for (value, label) in AHR_OPTIONS {
                    let checked = current_ahr.as_deref() == Some(value);
                    let view = view.clone();
                    let value = value.to_string();
                    menu = menu.item(
                        PopupMenuItem::new(label)
                            .checked(checked)
                            .on_click(move |_, _window, cx| {
                                view.update(cx, |this, cx| {
                                    this.ahr = Some(value.clone());
                                    cx.notify();
                                });
                            }),
                    );
                }
                menu
            },
        )
    }

    fn render_footer(&self, theme: &AppTheme, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .id("pi-edit-footer")
            .items_center()
            .gap_3()
            .child(match &self.feedback {
                Some(msg) => div()
                    .text_sm()
                    .text_color(theme.danger)
                    .child(msg.clone())
                    .into_any_element(),
                None => div().into_any_element(),
            })
            .child(div().flex_1())
            .child(
                Button::new("pi-edit-save")
                    .outline()
                    .small()
                    .label("保存草稿")
                    .loading(self.submitting)
                    .on_click(cx.listener(|this, _, window, cx| this.save(window, cx))),
            )
            .child(
                Button::new("pi-edit-submit")
                    .primary()
                    .small()
                    .label("提交")
                    .loading(self.submitting)
                    .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx))),
            )
    }
}

/// 分组卡片外壳（标题 + 内容）
fn section_card(
    theme: &AppTheme,
    title: &str,
    content: impl IntoElement,
) -> impl IntoElement {
    v_flex()
        .gap_3()
        .p_4()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(
            div()
                .text_sm()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_primary)
                .child(title.to_string()),
        )
        .child(content)
}

/// 数字字段输入组（网格渲染 `inputs[from..from+len]`；单位后缀按字段定义）
fn metric_inputs(
    theme: &AppTheme,
    inputs: &[Entity<InputState>],
    from: usize,
    len: usize,
) -> impl IntoElement {
    div()
        .grid()
        .grid_cols(3)
        .gap_3()
        .children(inputs.iter().skip(from).take(len).enumerate().map(
            |(ix, state)| {
                let field = ALL_FIELDS[from + ix];
                v_flex()
                    .gap_1p5()
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child(field.label),
                    )
                    .child(
                        h_flex()
                            .items_center()
                            .gap_2()
                            .child(div().w(px(110.)).child(Input::new(state)))
                            .child(if field.unit.is_empty() {
                                div().into_any_element()
                            } else {
                                div()
                                    .text_sm()
                                    .text_color(theme.text_muted)
                                    .child(field.unit)
                                    .into_any_element()
                            }),
                    )
            },
        ))
}

/// 从报告取字段值（health/compliance 按 key 查找）
fn field_value(
    field: &MetricField,
    health: Option<&HealthData>,
    compliance: Option<&ComplianceData>,
) -> Option<f64> {
    match field.key {
        "negative_feedback" => health?.negative_feedback.map(|v| v as f64),
        "a2z_claims" => health?.a2z_claims.map(|v| v as f64),
        "chargeback_claims" => health?.chargeback_claims.map(|v| v as f64),
        "late_shipment_rate" => health?.late_shipment_rate,
        "pre_fulfillment_cancel_rate" => health?.pre_fulfillment_cancel_rate,
        "valid_tracking_rate" => health?.valid_tracking_rate,
        "on_time_delivery_rate" => health?.on_time_delivery_rate,
        "ip_infringement" => compliance?.ip_infringement.map(|v| v as f64),
        "ip_complaints" => compliance?.ip_complaints.map(|v| v as f64),
        "product_authenticity_complaints" => {
            compliance?.product_authenticity_complaints.map(|v| v as f64)
        }
        "product_condition_complaints" => {
            compliance?.product_condition_complaints.map(|v| v as f64)
        }
        "food_product_safety" => compliance?.food_product_safety.map(|v| v as f64),
        "listing_policy_violations" => compliance?.listing_policy_violations.map(|v| v as f64),
        "restricted_product_violations" => {
            compliance?.restricted_product_violations.map(|v| v as f64)
        }
        "review_policy_violations" => compliance?.review_policy_violations.map(|v| v as f64),
        "other_policy_violations" => compliance?.other_policy_violations.map(|v| v as f64),
        "regulatory_compliance" => compliance?.regulatory_compliance.map(|v| v as f64),
        _ => None,
    }
}

/// 把字段值写回 health / compliance（保存收集用）
fn set_field_value(
    key: &str,
    value: Option<f64>,
    health: &mut HealthData,
    compliance: &mut ComplianceData,
) {
    let int = |v: Option<f64>| v.map(|v| v.round() as i64);
    match key {
        "negative_feedback" => health.negative_feedback = int(value),
        "a2z_claims" => health.a2z_claims = int(value),
        "chargeback_claims" => health.chargeback_claims = int(value),
        "late_shipment_rate" => health.late_shipment_rate = value,
        "pre_fulfillment_cancel_rate" => health.pre_fulfillment_cancel_rate = value,
        "valid_tracking_rate" => health.valid_tracking_rate = value,
        "on_time_delivery_rate" => health.on_time_delivery_rate = value,
        "ip_infringement" => compliance.ip_infringement = int(value),
        "ip_complaints" => compliance.ip_complaints = int(value),
        "product_authenticity_complaints" => {
            compliance.product_authenticity_complaints = int(value)
        }
        "product_condition_complaints" => compliance.product_condition_complaints = int(value),
        "food_product_safety" => compliance.food_product_safety = int(value),
        "listing_policy_violations" => compliance.listing_policy_violations = int(value),
        "restricted_product_violations" => compliance.restricted_product_violations = int(value),
        "review_policy_violations" => compliance.review_policy_violations = int(value),
        "other_policy_violations" => compliance.other_policy_violations = int(value),
        "regulatory_compliance" => compliance.regulatory_compliance = int(value),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_fields_covers_health_and_compliance_keys() {
        // 17 个字段 = 客服 3 + 配送 4 + 合规 10
        assert_eq!(ALL_FIELDS.len(), 17);
        assert_eq!(ALL_FIELDS[0].key, "negative_feedback");
        assert_eq!(ALL_FIELDS[2].key, "chargeback_claims");
        assert_eq!(ALL_FIELDS[3].key, "late_shipment_rate");
        assert_eq!(ALL_FIELDS[6].key, "on_time_delivery_rate");
        assert_eq!(ALL_FIELDS[7].key, "ip_infringement");
        assert_eq!(ALL_FIELDS[16].key, "regulatory_compliance");
    }

    #[test]
    fn field_value_reads_health_and_compliance() {
        let health = HealthData {
            negative_feedback: Some(2),
            late_shipment_rate: Some(1.5),
            ..Default::default()
        };
        let compliance = ComplianceData {
            ip_infringement: Some(3),
            ..Default::default()
        };
        assert_eq!(
            field_value(&ALL_FIELDS[0], Some(&health), Some(&compliance)),
            Some(2.0),
            "负面反馈从 health 读"
        );
        assert_eq!(
            field_value(&ALL_FIELDS[3], Some(&health), Some(&compliance)),
            Some(1.5),
            "迟发率从 health 读"
        );
        assert_eq!(
            field_value(&ALL_FIELDS[7], Some(&health), Some(&compliance)),
            Some(3.0),
            "合规从 compliance 读"
        );
        // 未填 → None（调用方回退默认值）
        assert_eq!(field_value(&ALL_FIELDS[1], Some(&health), Some(&compliance)), None);
        assert_eq!(field_value(&ALL_FIELDS[16], Some(&health), Some(&compliance)), None);
    }

    #[test]
    fn set_field_value_writes_health_and_compliance() {
        let mut health = HealthData::default();
        let mut compliance = ComplianceData::default();
        set_field_value("a2z_claims", Some(1.5), &mut health, &mut compliance);
        set_field_value("on_time_delivery_rate", Some(98.4), &mut health, &mut compliance);
        set_field_value("listing_policy_violations", Some(2.0), &mut health, &mut compliance);
        set_field_value("unknown_key", Some(1.0), &mut health, &mut compliance);
        assert_eq!(health.a2z_claims, Some(2), "浮点计数四舍五入");
        assert_eq!(health.on_time_delivery_rate, Some(98.4));
        assert_eq!(compliance.listing_policy_violations, Some(2));
        assert!(health.account_health_rating.is_none());
    }

    #[test]
    fn ahr_options_match_template() {
        assert_eq!(AHR_OPTIONS.len(), 4);
        assert_eq!(AHR_OPTIONS[0].0, "Healthy");
        assert_eq!(AHR_OPTIONS[3].0, "Critical");
    }
}
