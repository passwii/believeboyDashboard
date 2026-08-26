//! AI 智能 → 客服交流（BLF-803 Stage12 新建；Pattern C 三栏工作台）
//!
//! 对齐 web 端 `app/dashboard/ai/customer-service`（场景化话术生成器）：
//! - 左区：场景选择列表（运营汇报话术 / 邮件撰写等预设）；
//! - 中区：语气卡输出流（每个语气一张卡，流式 markdown 生成）+ 输入区；
//! - 右区：场景参数卡（语言 / 篇幅 / 输出结构）。
//!
//! 数据源：场景预设为**前端静态配置**的 GUI 内嵌等价（`SCENARIO_PRESETS`
//! 子集——GUI v1 只接「运营汇报话术」一个启用场景，邮件撰写 web 端亦为
//! disabled 占位）；生成走 backend `/ai/conversations` V2 SSE 流式对话
//! （system_prompt 由场景预设拼装，对齐 web Next 代理层
//! `messages/stream/route.ts` 的 `buildScenarioSystemPrompt` 转发口径）。
//!
//! ## 与 web 端的取舍
//! - **保留**：场景 / 语气双维选择、自由粘贴区 + 引导字段、中英双语、
//!   三档篇幅、流式 markdown 输出、复制；
//! - **精简**：多场景并行生成卡（web 每个语气一张卡同时流式）→ GUI 单
//!   选中语气逐卡生成（避免并发流管理复杂度）；草稿 sessionStorage 暂存
//!   → 内存态（GUI 无对应持久层约定）；邮件撰写场景不移植（web 未上线）。

use std::collections::HashMap;

use gpui::prelude::*;
use gpui::{
    div, px, App, AsyncApp, Context, Entity, FontWeight, IntoElement, Render, SharedString,
    WeakEntity, Window,
};
use gpui_component::button::{Button, ButtonCustomVariant, ButtonVariants};
use gpui_component::input::{Input, InputState};
use gpui_component::{h_flex, v_flex, Disableable, Icon, IconName, Sizable};
use gui_api_client::ai_chat::AiChatMessageCreate;
use gui_api_client::Client;
use gui_domain::ai_chat::StreamEvent;

use crate::theme::{AppTheme, FONT_BASE, FONT_XS};
use crate::widgets::data_table::TabularNumsExt;
use crate::widgets::pattern_c::{
    context_card, context_stat_row, markdown_body, pane_header_base, pattern_c_shell,
};
use crate::widgets::state_views;

/// sidebar「AI 智能 → 客服交流」URL（数据权威 gui-domain::sidebar）
pub const CUSTOMER_SERVICE_URL: &str = "/dashboard/ai/customer-service";

/// 场景预设（web SCENARIO_PRESETS 启用子集；promptSuffix 见 web 同名常量）
struct ScenarioPreset {
    #[allow(dead_code)] // 对齐 web SCENARIO_PRESETS 字段面；GUI 单场景暂未消费
    id: &'static str,
    label: &'static str,
    description: &'static str,
    /// 基础指令（受众/视角/输出结构）
    system_prompt: &'static str,
    /// 语气选项：(id, 标签, 描述, prompt 后缀)
    tones: &'static [(&'static str, &'static str, &'static str, &'static str)],
}

const OPS_REPORT_SCENARIO: ScenarioPreset = ScenarioPreset {
    id: "ops-report",
    label: "运营汇报话术",
    description: "亚马逊运营视角，向直属主管汇报数据与结论",
    system_prompt: "你是一名资深的亚马逊运营专家，擅长把运营数据转化为清晰、专业、有结论的汇报话术。受众是你的直属主管。请严格遵循结构：结论先行 → 数据支撑 → 风险/异常 → 下一步建议。",
    tones: &[
        (
            "brief",
            "简洁周报版",
            "一句话结论 + 要点，适合群里快速同步",
            "输出简洁的周报版：先一句话结论，再列 3-5 条要点，控制在 200 字以内。",
        ),
        (
            "formal",
            "正式报告版",
            "完整结构化报告，适合正式汇报",
            "输出正式报告版：完整的结构化段落（结论 / 数据支撑 / 风险异常 / 下一步），用词正式、严谨。",
        ),
        (
            "verbal",
            "口头汇报版",
            "口语化、可照读",
            "输出口头汇报版：口语化、自然，像当面汇报一样，可直接照着说。",
        ),
    ],
};

const LENGTH_INSTRUCTIONS: [(&str, &str, &str); 3] = [
    ("brief", "简短", "篇幅尽量短：结论 + 要点，适合快速同步。"),
    ("standard", "适中", "篇幅适中：结构完整但不冗长。"),
    ("detailed", "详细", "篇幅可以较长：展开原因、依据与细节。"),
];

const LANGUAGE_INSTRUCTIONS: [(&str, &str); 2] =
    [("zh", "中文"), ("en", "English")];

#[allow(dead_code)] // 保留：与 LENGTH_INSTRUCTIONS 对称的展示辅助（后续批次消费）
fn language_instruction(language: &str) -> &'static str {
    match language {
        "en" => "Respond in English.",
        _ => "用中文输出。",
    }
}

/// 拼装场景 system prompt（对齐 web buildScenarioSystemPrompt 口径）
pub fn build_scenario_system_prompt(
    tone_id: &str,
    length: &str,
    language: &str,
) -> String {
    let mut parts = vec![OPS_REPORT_SCENARIO.system_prompt.to_string()];
    if let Some((_, _, _, suffix)) = OPS_REPORT_SCENARIO
        .tones
        .iter()
        .find(|(id, _, _, _)| *id == tone_id)
    {
        parts.push(suffix.to_string());
    }
    if let Some((_, _, instruction)) = LENGTH_INSTRUCTIONS.iter().find(|(id, _, _)| *id == length)
    {
        parts.push(instruction.to_string());
    }
    parts.push(language_instruction(language).to_string());
    parts.join("\n\n")
}

/// 用户消息拼装（对齐 web buildUserContent：【原始内容】+【补充信息】）
fn build_user_content(free_text: &str) -> String {
    let free = free_text.trim();
    if free.is_empty() {
        return String::new();
    }
    format!("【原始内容】\n{free}")
}

/// 单个语气卡的输出状态
#[derive(Debug, Clone, PartialEq, Default)]
struct ToneOutput {
    content: String,
    streaming: bool,
    error: Option<String>,
    done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)] // Error 变体预留给 provider 探测失败路径（对齐 ai_chat 三态）
enum PaneState {
    Ready,
    Error(String),
}

/// 客服交流视图
pub struct CustomerServiceView {
    client: Client,
    state: PaneState,
    /// 自由粘贴输入
    free_input: Option<Entity<InputState>>,
    pending_clear_input: bool,
    /// 选中的语气（tone id）
    selected_tone: &'static str,
    /// 语言："zh" | "en"
    language: &'static str,
    /// 篇幅："brief" | "standard" | "detailed"
    length: &'static str,
    /// 每个语气 id 的输出状态
    outputs: HashMap<&'static str, ToneOutput>,
    /// 当前会话（懒创建）
    conversation_id: Option<i64>,
    /// 是否正在生成（任一语气）
    is_generating: bool,
    /// 流式代际（新发送使旧消费循环失效）
    stream_generation: u64,
}

impl CustomerServiceView {
    pub fn new(_cx: &mut Context<Self>, client: Client) -> Self {
        Self {
            client,
            state: PaneState::Ready,
            free_input: None,
            pending_clear_input: false,
            selected_tone: OPS_REPORT_SCENARIO.tones[0].0,
            language: "zh",
            length: "standard",
            outputs: HashMap::new(),
            conversation_id: None,
            is_generating: false,
            stream_generation: 0,
        }
    }

    /// Provider 可用性探测失败时置错误态（root.rs reload 触发）
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.state = PaneState::Ready;
        cx.notify();
    }

    fn take_pending_clear(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pending_clear_input {
            self.pending_clear_input = false;
            if let Some(input) = &self.free_input {
                input.update(cx, |state, cx| {
                    state.set_value(SharedString::from(""), window, cx);
                });
            }
        }
    }

    pub fn ensure_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.free_input.is_none() {
            let input = cx.new(|cx| InputState::new(window, cx).placeholder("粘贴要改写的数据 / 结论…"));
            self.free_input = Some(input);
        }
    }

    fn select_tone(&mut self, tone: &'static str, cx: &mut Context<Self>) {
        self.selected_tone = tone;
        cx.notify();
    }

    fn set_language(&mut self, language: &'static str, cx: &mut Context<Self>) {
        self.language = language;
        cx.notify();
    }

    fn set_length(&mut self, length: &'static str, cx: &mut Context<Self>) {
        self.length = length;
        cx.notify();
    }

    /// 生成当前选中语气的输出（V2 SSE；system_prompt 场景化拼装）
    pub fn generate(&mut self, cx: &mut Context<Self>) {
        if self.is_generating {
            return;
        }
        let Some(input) = &self.free_input else {
            return;
        };
        let content = build_user_content(&input.read(cx).value());
        if content.is_empty() {
            return;
        }
        self.pending_clear_input = true;

        let tone_id = self.selected_tone;
        self.outputs.insert(
            tone_id,
            ToneOutput {
                streaming: true,
                ..Default::default()
            },
        );
        self.is_generating = true;
        self.stream_generation = self.stream_generation.wrapping_add(1);
        let generation = self.stream_generation;

        let client = self.client.clone();
        let client_for_stream = self.client.clone();
        let existing_conv = self.conversation_id;
        let system_prompt = build_scenario_system_prompt(tone_id, self.length, self.language);
        let bg = cx.background_executor().clone();

        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            // ① 确保会话存在
            let conversation_id = match existing_conv {
                Some(id) => id,
                None => {
                    let created = bg
                        .spawn(async move {
                            crate::runtime::runtime()
                                .block_on(client.ai_conversation_create(Some("客服交流".into())))
                        })
                        .await;
                    match created {
                        Ok(conv) => {
                            let new_id = conv.id;
                            let alive = this
                                .update(cx, |this, cx| {
                                    this.conversation_id = Some(new_id);
                                    cx.notify();
                                })
                                .is_ok();
                            if !alive {
                                return;
                            }
                            new_id
                        }
                        Err(e) => {
                            let _ = this.update(cx, |this, cx| {
                                this.outputs.entry(tone_id).or_default().error =
                                    Some(e.user_message());
                                this.outputs.entry(tone_id).or_default().streaming = false;
                                this.is_generating = false;
                                cx.notify();
                            });
                            return;
                        }
                    }
                }
            };

            // ② SSE 流式请求 + 事件消费循环
            let payload = AiChatMessageCreate {
                content,
                model: None,
                system_prompt,
                regenerate: false,
                enable_web_search: false,
            };
            let (tx, mut rx) =
                tokio::sync::mpsc::unbounded_channel::<Result<StreamEvent, String>>();
            let producer = bg.spawn(async move {
                let _ = crate::runtime::runtime()
                    .block_on(client_for_stream.ai_stream_message(conversation_id, &payload, tx));
            });
            drop(producer); // 后台流任务自持 tx；接收端退出即结束

            loop {
                let Some(event) = rx.recv().await else { break };
                let alive = this
                    .update(cx, |this, cx| {
                        if this.stream_generation != generation {
                            return false; // 过代际，丢弃
                        }
                        let out = this.outputs.entry(tone_id).or_default();
                        match event {
                            Ok(StreamEvent::ContentBlockDelta { delta }) if delta.kind == "text_delta" => {
                                out.content.push_str(&delta.text);
                            }
                            Ok(StreamEvent::Done(_)) => {
                                out.streaming = false;
                                out.done = true;
                                this.is_generating = false;
                            }
                            Ok(_) => {}
                            Err(msg) => {
                                out.error = Some(msg);
                                out.streaming = false;
                                this.is_generating = false;
                            }
                        }
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);
                if !alive {
                    break;
                }
            }
            // 流结束兜底复位
            let _ = this.update(cx, |this, cx| {
                if let Some(out) = this.outputs.get_mut(tone_id) {
                    if out.streaming {
                        out.streaming = false;
                    }
                }
                this.is_generating = false;
                cx.notify();
            });
        })
        .detach();
    }
}

impl Render for CustomerServiceView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        self.ensure_inputs(window, cx);
        self.take_pending_clear(window, cx);

        match &self.state {
            PaneState::Error(msg) => v_flex()
                .id("customer-service")
                .size_full()
                .p_6()
                .bg(theme.window_bg)
                .child(state_views::error_state(
                    &cx.entity(),
                    &theme,
                    "customer-service-error",
                    "客服交流加载失败",
                    msg.clone(),
                    |this, cx| this.reload(cx),
                ))
                .into_any_element(),
            PaneState::Ready => {
                let sessions = self.render_scenario_pane(&theme, cx);
                let center = self.render_center(window, &theme, cx);
                let context = self.render_context_pane(&theme, cx);
                pattern_c_shell(&theme, "customer-service", sessions, center, true, context)
                    .into_any_element()
            }
        }
    }
}

impl CustomerServiceView {
    // ---------- 左区：场景列表 ----------

    fn render_scenario_pane(&self, theme: &AppTheme, cx: &Context<Self>) -> gpui::AnyElement {
        let header = pane_header_base(theme, "cs-scenario-header").child(
            div().text_size(px(crate::theme::fs(FONT_BASE)))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_secondary)
                .child("场景"),
        );
        let scenario_card = v_flex()
            .px_1p5()
            .py_2()
            .gap_1p5()
            .child(
                div().text_size(px(crate::theme::fs(FONT_BASE)))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text_primary)
                    .child(OPS_REPORT_SCENARIO.label),
            )
            .child(
                div().text_size(px(crate::theme::fs(FONT_XS)))
                    .text_color(theme.text_muted)
                    .child(OPS_REPORT_SCENARIO.description),
            );
        // 语气子列表
        let tone_list = v_flex().gap_0p5().children(OPS_REPORT_SCENARIO.tones.iter().map(
            |(id, label, desc, _)| {
                let selected = self.selected_tone == *id;
                h_flex()
                    .id(SharedString::from(format!("cs-tone-{id}")))
                    .px_1()
                    .py_1()
                    .rounded_md()
                    .cursor(gpui::CursorStyle::PointingHand)
                    .when(selected, |this| this.bg(theme.muted_fill))
                    .when(!selected, |this| {
                        this.hover(|h| h.bg(theme.table_row_hover))
                    })
                    .on_click({
                        let view = cx.entity();
                        move |_, _, cx| {
                            view.update(cx, |this, cx| this.select_tone(id, cx));
                        }
                    })
                    .child(
                        v_flex()
                            .min_w_0()
                            .child(
                                div().text_size(px(crate::theme::fs(FONT_BASE)))
                                    .text_color(if selected {
                                        theme.text_primary
                                    } else {
                                        theme.text_secondary
                                    })
                                    .child(*label),
                            )
                            .child(
                                div().text_size(px(crate::theme::fs(FONT_XS)))
                                    .text_color(theme.text_muted)
                                    .truncate()
                                    .child(*desc),
                            ),
                    )
            },
        ));
        v_flex()
            .h_full()
            .child(header)
            .child(
                v_flex()
                    .id("cs-scenario-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(scenario_card)
                    .child(tone_list),
            )
            .into_any_element()
    }

    // ---------- 中区：输出流 + 输入区 ----------

    fn render_center(
        &mut self,
        window: &mut Window,
        theme: &AppTheme,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let view = cx.entity();
        // 输出卡（选中语气的输出状态）
        let tone_id = self.selected_tone;
        let (_, tone_label, _, _) = OPS_REPORT_SCENARIO
            .tones
            .iter()
            .find(|(id, ..)| *id == tone_id)
            .expect("tone 存在");
        let output = self.outputs.get(tone_id).cloned().unwrap_or_default();

        let send_variant = ButtonCustomVariant::new(cx)
            .color(theme.accent)
            .foreground(theme.on_accent)
            .hover(theme.accent_hover)
            .active(theme.accent_hover)
            .shadow(false);

        let input = self.free_input.clone().expect("已懒建");
        let input_empty = input.read(cx).value().trim().is_empty();

        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .child(
                pane_header_base(theme, "cs-center-header")
                    .child(
                        div().text_size(px(crate::theme::fs(FONT_BASE)))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text_secondary)
                            .child(*tone_label),
                    )
                    .child(if output.streaming {
                        div()
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child("正在生成…")
                    } else {
                        div()
                    }),
            )
            .child(
                div()
                    .id("cs-output-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(crate::widgets::pattern_c::FollowScroll::new().handle())
                    .child(
                        v_flex()
                            .w_full()
                            .max_w(px(640.))
                            .mx_auto()
                            .p_4()
                            .gap_3()
                            .child(self.render_output_card(tone_id, &output, theme, window, cx)),
                    ),
            )
            .child(
                h_flex()
                    .items_end()
                    .gap_2()
                    .px_4()
                    .py_3()
                    .border_t_1()
                    .border_color(theme.separator)
                    .child(Input::new(&input).w_full().h(px(72.)))
                    .child(
                        v_flex().items_end().gap_1().child(
                            Button::new("cs-generate")
                                .custom(send_variant)
                                .label("生成")
                                .disabled(input_empty || self.is_generating)
                                .on_click(move |_, _, cx| {
                                    view.update(cx, CustomerServiceView::generate);
                                }),
                        ),
                    ),
            )
            .into_any_element()
    }

    fn render_output_card(
        &self,
        tone_id: &'static str,
        output: &ToneOutput,
        theme: &AppTheme,
        window: &mut Window,
        cx: &mut App,
    ) -> gpui::AnyElement {
        let element_id = SharedString::from(format!("cs-out-{tone_id}"));
        if output.error.is_some() && output.content.is_empty() {
            return v_flex()
                .rounded_lg()
                .border_1()
                .border_color(theme.danger)
                .bg(theme.danger_soft)
                .px_3()
                .py_2()
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.danger)
                        .child(output.error.clone().unwrap_or_default()),
                )
                .into_any_element();
        }
        if output.content.is_empty() && !output.streaming {
            return v_flex()
                .items_center()
                .justify_center()
                .gap_2()
                .py_16()
                .child(
                    Icon::new(IconName::Bot)
                        .with_size(px(32.))
                        .text_color(theme.text_muted),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.text_muted)
                        .child("粘贴数据后点击「生成」，输出将显示在这里"),
                )
                .into_any_element();
        }
        let md_source = if output.streaming {
            format!("{} ▍", output.content)
        } else {
            output.content.clone()
        };
        v_flex()
            .rounded_lg()
            .border_1()
            .border_color(theme.separator)
            .bg(theme.card_bg)
            .px_3()
            .py_2()
            .when_some(output.error.clone(), |card, err| {
                card.child(div().text_xs().text_color(theme.danger).child(err))
            })
            .child(markdown_body(element_id, md_source, window, cx))
            .when(output.done, |card| {
                card.child(
                    div()
                        .text_xs()
                        .mono_tabular_nums()
                        .text_color(theme.text_muted)
                        .child("已完成 · 点击卡片外文本可直接复制"),
                )
            })
            .into_any_element()
    }

    // ---------- 右区：场景参数卡 ----------

    fn render_context_pane(&self, theme: &AppTheme, cx: &Context<Self>) -> gpui::AnyElement {
        let view = cx.entity();
        let header = pane_header_base(theme, "cs-context-header").child(
            div().text_size(px(crate::theme::fs(FONT_BASE)))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_secondary)
                .child("参数"),
        );

        let lang_card = context_card(theme, "cs-card-lang", "输出语言")
            .children(LANGUAGE_INSTRUCTIONS.iter().map(|(code, label)| {
                let selected = self.language == *code;
                context_stat_row(
                    theme,
                    label,
                    if selected { "● 选中" } else { "○" },
                )
            }));
        let length_card = context_card(theme, "cs-card-length", "篇幅")
            .children(LENGTH_INSTRUCTIONS.iter().map(|(code, label, _)| {
                let selected = self.length == *code;
                context_stat_row(theme, label, if selected { "● 选中" } else { "○" })
            }));

        // 语言切换按钮组（简化为两枚按钮）
        let lang_buttons = h_flex().gap_2().children(
            LANGUAGE_INSTRUCTIONS.iter().map(|(code, label)| {
                let view = view.clone();
                let code = *code;
                Button::new(SharedString::from(format!("cs-lang-{code}")))
                    .when(code == self.language, |b| b.primary())
                    .when(code != self.language, |b| b.outline())
                    .xsmall()
                    .label(*label)
                    .on_click(move |_, _, cx| {
                        view.update(cx, |this, cx| this.set_language(code, cx));
                    })
            }),
        );
        let length_buttons = h_flex().gap_2().children(
            LENGTH_INSTRUCTIONS.iter().map(|(code, label, _)| {
                let view = view.clone();
                let code = *code;
                Button::new(SharedString::from(format!("cs-len-{code}")))
                    .when(code == self.length, |b| b.primary())
                    .when(code != self.length, |b| b.outline())
                    .xsmall()
                    .label(*label)
                    .on_click(move |_, _, cx| {
                        view.update(cx, |this, cx| this.set_length(code, cx));
                    })
            }),
        );

        v_flex()
            .h_full()
            .child(header)
            .child(
                v_flex()
                    .id("cs-context-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_2()
                    .gap_2()
                    .child(lang_card.child(lang_buttons))
                    .child(length_card.child(length_buttons)),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_constant_matches_sidebar() {
        assert_eq!(CUSTOMER_SERVICE_URL, "/dashboard/ai/customer-service");
    }

    #[test]
    fn scenario_system_prompt_composes_tone_length_language() {
        let prompt = build_scenario_system_prompt("brief", "detailed", "en");
        assert!(prompt.contains("运营专家"));
        assert!(prompt.contains("200 字以内"), "语气后缀应注入");
        assert!(prompt.contains("篇幅可以较长"), "篇幅指令应注入");
        assert!(prompt.contains("Respond in English."), "语言指令应注入");
    }

    #[test]
    fn user_content_wraps_free_text() {
        assert_eq!(
            build_user_content(" 销售上涨 "),
            "【原始内容】\n销售上涨"
        );
        assert_eq!(build_user_content("   "), "");
    }
}
