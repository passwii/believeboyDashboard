//! 工具箱 → Markdown 转换（P5-8，BLF-749）
//!
//! 对齐 web 端 `app/dashboard/tools/markdown-to-word`（约 1139 行）。
//!
//! ## 数据源结论（执行时读 web 源码确认）
//!
//! web 端是**纯浏览器本地工具**：无任何后端 API 请求（页脚明示「文件仅在
//! 浏览器本地处理」），docx 由自研 `lib/markdown-docx.ts` 在客户端生成，PDF
//! 由 `lib/markdown-pdf.ts`（pdf-lib + fontkit 手写排版引擎）生成。因此本视图
//! **不需要 gui-api-client 模块**（与 `model_selection` 同类的零接口视图），
//! 转换逻辑复用本 crate [`crate::markdown_export`]（web 解析器 / docx 构建 /
//! 文件名规则的 Rust 实现，34 个单测锁定契约）。
//!
//! ## 与 web 端的取舍（issue 允许按 macOS 原生习惯精简并说明）
//!
//! - **保留**：双栏布局（左编辑 / 右预览）、打开 .md（rfd 原生对话框替代
//!   UploadZone，同样 5 MB 上限）、多行编辑、实时预览（gpui-component
//!   [`TextView`] markdown 渲染）、导出 Word（rfd 原生保存对话框替代浏览器
//!   下载）、清空、来源文件名/大小展示、「可导出」状态徽标；
//! - **精简**：
//!   - 「下载 PDF」不移植：web 端 PDF 是 pdf-lib + fontkit 自绘 A4 排版引擎
//!     （逐字符测宽换行），Rust 侧无等价依赖、1:1 复刻需重写整套排版；按
//!     issue「保存对话框 + 生成 docx 或导出 md 方案」授权本棒只交付 DOCX；
//!   - 拖拽上传不移植（macOS 原生文件选择习惯）；成功/失败 toast 转为
//!     PageHeader 下方的内联状态条（GUI 无 toast 系统）。

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

use gpui::{div, prelude::*, px, Context, Entity, Render, Window};
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::input::{Input, InputEvent, InputState};
use gpui_component::{h_flex, v_flex, Disableable, Icon, IconName, Sizable};

use crate::markdown_export::{
    create_word_filename, format_file_size, markdown_to_docx_bytes,
};
use crate::theme::AppTheme;
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;

/// sidebar「工具箱 → Markdown 转换」URL（数据权威 gui-domain::sidebar）
pub const MARKDOWN_TO_WORD_URL: &str = "/dashboard/tools/markdown-to-word";

/// 来源 .md 文件大小上限（对齐 web UploadZone maxSize={5} = 5 MB）
const MAX_SOURCE_BYTES: usize = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 纯逻辑（可单测；web 行为契约的 Rust 对应）
// ---------------------------------------------------------------------------

/// 是否可导出：锁 web `isEmpty = markdown.trim().length === 0` 语义。
pub fn is_exportable(markdown: &str) -> bool {
    !markdown.trim().is_empty()
}

/// 来源文件大小校验（对齐 web UploadZone maxSize={5}）：超出 5 MB 拒绝。
pub fn validate_source_bytes(len: usize) -> Result<(), String> {
    if len > MAX_SOURCE_BYTES {
        Err(format!(
            "文件超过 {} MB 上限，请拆分后再试",
            MAX_SOURCE_BYTES / (1024 * 1024)
        ))
    } else {
        Ok(())
    }
}

/// 来源文件元信息展示（文件名 · 人性化大小，复用导出模块的 web 同款格式化）。
fn source_meta(name: &str, size: u64) -> String {
    format!("{} · {}", name, format_file_size(size))
}

/// 操作结果内联反馈（GUI 无 toast，用状态条替代 web notify）。
enum Status {
    Success(String),
    Error(String),
}

impl Status {
    fn text(&self) -> &str {
        match self {
            Self::Success(text) | Self::Error(text) => text,
        }
    }

    fn is_error(&self) -> bool {
        matches!(self, Self::Error(_))
    }
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// 工具箱 → Markdown 转换视图：纯本地工具（无网络请求），左编辑 / 右预览。
pub struct MarkdownToWordView {
    /// 多行输入框（首个渲染时创建——InputState 需要 `&mut Window`）
    input: Option<Entity<InputState>>,
    input_sub: Option<gpui::Subscription>,
    /// 当前 markdown 内容（InputEvent::Change 时同步；驱动预览与可导出徽标）
    markdown: String,
    /// 打开的来源文件名 / 大小（导出文件名派生自它；未打开为 None）
    source_file_name: Option<String>,
    source_file_size: Option<u64>,
    /// 内联操作反馈（打开/导出后设置；None 隐藏）
    status: Option<Status>,
    /// 异步读文件完成后待写入输入框的内容（set_value 需要 Window，延迟到 render）
    pending_input_value: Option<String>,
    /// 清空按钮触发的待清空标记（同上）
    pending_clear_input: bool,
}

impl MarkdownToWordView {
    pub fn new() -> Self {
        Self {
            input: None,
            input_sub: None,
            markdown: String::new(),
            source_file_name: None,
            source_file_size: None,
            status: None,
            pending_input_value: None,
            pending_clear_input: false,
        }
    }

    /// 首个渲染时创建多行输入框 + 订阅 Change 实时同步内容（ai_chat 同款懒建模式）。
    fn ensure_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.input.is_some() {
            return;
        }
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("在这里粘贴 Markdown 内容…")
                .multi_line(true)
        });
        let sub = cx.subscribe(&input, |this, input, event: &InputEvent, cx| {
            if let InputEvent::Change = event {
                this.markdown = input.read(cx).value().to_string();
                cx.notify();
            }
        });
        self.input = Some(input);
        self.input_sub = Some(sub);
    }

    /// 消费待应用输入框变更（render 时调用——set_value 需要 Window）。
    fn take_pending_input(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(value) = self.pending_input_value.take() {
            if let Some(input) = &self.input {
                input.update(cx, |state, cx| state.set_value(&value, window, cx));
            }
            // set_value 会触发 Change → markdown 已同步；此处兜底（订阅时序不确定）
            self.markdown = value;
        } else if self.pending_clear_input {
            self.pending_clear_input = false;
            if let Some(input) = &self.input {
                input.update(cx, |state, cx| state.set_value("", window, cx));
            }
            self.markdown.clear();
        }
    }

    /// 打开 .md 文件：rfd 原生对话框（macOS NSOpenPanel）→ 读入 UTF-8 文本。
    /// 大小超限拒绝（对齐 web UploadZone 5 MB）；读取失败转内联错误反馈。
    fn open_file(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let picked = rfd::AsyncFileDialog::new()
                .add_filter("Markdown", &["md", "markdown", "txt"])
                .pick_file()
                .await;
            let Some(handle) = picked else {
                return; // 用户取消，不算失败
            };
            let name = handle.file_name();
            let bytes = handle.read().await;
            this.update(cx, |this, cx| {
                if let Err(message) = validate_source_bytes(bytes.len()) {
                    this.status = Some(Status::Error(message));
                    cx.notify();
                    return;
                }
                let content = String::from_utf8_lossy(&bytes).into_owned();
                this.source_file_name = Some(name.clone());
                this.source_file_size = Some(bytes.len() as u64);
                // set_value 需要 Window，延迟到下一帧 render 应用
                this.pending_input_value = Some(content);
                this.status = Some(Status::Success(format!("Markdown 文件已读取：{name}")));
                cx.notify();
            })
            .ok(); // 窗口已关闭等场景丢弃错误（视图销毁后无需反馈）
        })
        .detach();
    }

    /// 清空：内容 + 来源信息 + 反馈全部复位（对齐 web handleClear）。
    fn clear(&mut self, cx: &mut Context<Self>) {
        self.source_file_name = None;
        self.source_file_size = None;
        self.status = None;
        self.pending_clear_input = true; // set_value 延迟到 render
        cx.notify();
    }

    /// 导出 Word：生成 DOCX 字节流（本地、同步、毫秒级）→ rfd 原生保存对话框
    /// （macOS NSSavePanel）→ 写盘。用户取消不算失败。空内容拒绝（web 同文案）。
    fn export_word(&mut self, cx: &mut Context<Self>) {
        if !is_exportable(&self.markdown) {
            self.status = Some(Status::Error("请先填写 Markdown 内容".into()));
            cx.notify();
            return;
        }
        let filename = create_word_filename(self.source_file_name.as_deref());
        let bytes = match markdown_to_docx_bytes(&self.markdown) {
            Ok(bytes) => bytes,
            Err(err) => {
                self.status = Some(Status::Error(err.to_string()));
                cx.notify();
                return;
            }
        };
        cx.spawn(async move |this, cx| {
            let picked = rfd::AsyncFileDialog::new()
                .set_file_name(&filename)
                .add_filter("Word 文档", &["docx"])
                .save_file()
                .await;
            let Some(handle) = picked else {
                return; // 用户取消
            };
            let path = handle.path().to_path_buf();
            let write_result = std::fs::write(&path, &bytes);
            this.update(cx, |this, cx| {
                this.status = Some(match write_result {
                    Ok(()) => Status::Success(format!("Word 文件已导出：{}", path.display())),
                    Err(err) => Status::Error(format!("写入文件失败：{err}")),
                });
                cx.notify();
            })
            .ok(); // 窗口已关闭等场景丢弃错误
        })
        .detach();
    }

    // -----------------------------------------------------------------------
    // 渲染
    // -----------------------------------------------------------------------

    /// 左卡头部：图标 + 标题 + 「.md」徽标（对齐 web CardHeader + Badge outline）。
    fn editor_card_header(theme: &AppTheme) -> gpui::AnyElement {
        h_flex()
            .items_center()
            .justify_between()
            .child(
                h_flex()
                    .items_center()
                    .gap_2()
                    .child(Icon::new(IconName::File).with_size(px(16.)).text_color(theme.accent))
                    .child(
                        div()
                            .text_sm()
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .text_color(theme.text_primary)
                            .child("Markdown 编辑区"),
                    ),
            )
            .child(
                div()
                    .rounded_md()
                    .border_1()
                    .border_color(theme.separator)
                    .px_2()
                    .py_px()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child(".md"),
            )
            .into_any_element()
    }

    /// 预览区主体：空态占位（对齐 web FileText 空态文案）/ TextView 实时渲染。
    fn preview_body(
        &self,
        theme: &AppTheme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        if !is_exportable(&self.markdown) {
            return v_flex()
                .flex_1()
                .min_h(px(200.))
                .items_center()
                .justify_center()
                .gap_2()
                .text_color(theme.text_muted)
                .child(Icon::new(IconName::File).with_size(px(28.)).opacity(0.4))
                .child(
                    div()
                        .text_sm()
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .text_color(theme.text_secondary)
                        .child("暂无 Markdown 内容"),
                )
                .child(
                    div()
                        .text_xs()
                        .child("上传文件或粘贴内容后，这里会实时显示预览。"),
                )
                .into_any_element();
        }
        div()
            .id("md-preview-body")
            .flex_1()
            .overflow_y_scroll()
            .child(gpui_component::text::TextView::markdown(
                "markdown-to-word-preview",
                self.markdown.clone(),
                window,
                cx,
            ))
            .into_any_element()
    }
}

impl Default for MarkdownToWordView {
    fn default() -> Self {
        Self::new()
    }
}

impl Render for MarkdownToWordView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        self.ensure_inputs(window, cx);
        self.take_pending_input(window, cx);

        let exportable = is_exportable(&self.markdown);

        let open_button = Button::new("md-open-file")
            .outline()
            .small()
            .label("打开 .md 文件")
            .on_click(cx.listener(|this, _, _, cx| this.open_file(cx)));
        let clear_button = Button::new("md-clear")
            .ghost()
            .small()
            .label("清空")
            .on_click(cx.listener(|this, _, _, cx| this.clear(cx)));

        // 左卡：编辑区（头部 + 说明 + 打开/来源行 + 粘贴标签/清空 + 输入框）
        let editor_card = v_flex()
            .flex_1()
            .min_w_0()
            .gap_3()
            .rounded_lg()
            .border_1()
            .border_color(theme.separator)
            .bg(theme.card_bg)
            .p_5()
            .child(Self::editor_card_header(&theme))
            .child(
                div()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child("上方打开文件，下方直接粘贴或编辑 Markdown 内容。"),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap_3()
                    .child(open_button)
                    .children(
                        self.source_file_name
                            .as_deref()
                            .zip(self.source_file_size)
                            .map(|(name, size)| {
                                div()
                                    .text_xs()
                                    .text_color(theme.text_muted)
                                    .child(source_meta(name, size))
                            }),
                    ),
            )
            .child(
                h_flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.text_secondary)
                            .child("直接粘贴 Markdown"),
                    )
                    .child(clear_button),
            )
            .child(
                div()
                    .flex_1()
                    .min_h(px(240.))
                    .rounded_md()
                    .border_1()
                    .border_color(theme.separator)
                    .bg(theme.window_bg)
                    .px_3()
                    .py_2()
                    .children(
                        self.input
                            .clone()
                            .map(|input| Input::new(&input).into_any_element()),
                    ),
            );

        let export_button = Button::new("md-export-word")
            .primary()
            .small()
            .disabled(!exportable)
            .label("导出 Word")
            .on_click(cx.listener(|this, _, _, cx| this.export_word(cx)));

        // 右卡：实时预览 + 导出 Word + 底部说明
        let preview_card = v_flex()
            .flex_1()
            .min_w_0()
            .gap_3()
            .rounded_lg()
            .border_1()
            .border_color(theme.separator)
            .bg(theme.card_bg)
            .p_5()
            .child(
                h_flex()
                    .items_center()
                    .justify_between()
                    .child(
                        h_flex()
                            .items_center()
                            .gap_2()
                            .child(Icon::new(IconName::Eye).with_size(px(16.)).text_color(theme.accent))
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(gpui::FontWeight::MEDIUM)
                                    .text_color(theme.text_primary)
                                    .child("实时预览"),
                            ),
                    )
                    .child(export_button),
            )
            .child(
                div()
                    .id("md-preview-card-body")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme.separator)
                    .bg(theme.window_bg)
                    .p_4()
                    .text_sm()
                    .text_color(theme.text_primary)
                    .child(self.preview_body(&theme, window, cx)),
            )
            .child(
                h_flex()
                    .items_center()
                    .justify_between()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child("文件仅在本地处理，不会上传服务器")
                    .child("导出格式：DOCX"),
            );

        v_flex()
            .id("markdown-to-word")
            .size_full()
            .gap_4()
            .p_6()
            .bg(theme.window_bg)
            .child(PageHeader::new("Markdown 转换").subtitle(
                "粘贴或打开 Markdown，右侧实时预览文档结构，一键导出为 Word（DOCX）。",
            ))
            .children(self.status.as_ref().map(|status| {
                let color = if status.is_error() {
                    theme.danger
                } else {
                    theme.success
                };
                content_guard().child(
                    h_flex()
                        .rounded_md()
                        .border_1()
                        .border_color(color.opacity(0.35))
                        .bg(color.opacity(0.08))
                        .px_3()
                        .py_2()
                        .text_xs()
                        .text_color(color)
                        .child(status.text().to_string()),
                )
            }))
            .child(
                div().flex_1().min_h_0().child(
                    content_guard()
                        .child(h_flex().h_full().min_h_0().gap_4().child(editor_card).child(preview_card)),
                ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- 常量契约 ----------

    #[test]
    fn url_constant_matches_sidebar() {
        assert_eq!(MARKDOWN_TO_WORD_URL, "/dashboard/tools/markdown-to-word");
    }

    #[test]
    fn source_size_guard_enforces_web_upload_limit() {
        // web UploadZone maxSize={5}：恰好 5 MB 放行、超出拒绝
        assert!(validate_source_bytes(MAX_SOURCE_BYTES).is_ok());
        assert!(validate_source_bytes(0).is_ok());
        let err = validate_source_bytes(MAX_SOURCE_BYTES + 1).unwrap_err();
        assert!(err.contains("5 MB"), "错误文案应说明上限：{err}");
    }

    // ---------- isEmpty 语义（锁 web `markdown.trim().length === 0`） ----------

    #[test]
    fn is_exportable_locks_web_is_empty_semantics() {
        assert!(!is_exportable(""));
        assert!(!is_exportable("   \n  \t "));
        assert!(is_exportable("内容"));
        assert!(is_exportable("\n# 标题\n"));
        assert!(!is_exportable("　"), "全角空格同样视为空白");
    }

    // ---------- 来源文件元信息展示 ----------

    #[test]
    fn source_meta_formats_name_and_size() {
        assert_eq!(source_meta("笔记.md", 2048), "笔记.md · 2.0 KB");
        assert_eq!(source_meta("a.md", 0), "a.md · 0 KB");
    }

    // ---------- 内联状态反馈 ----------

    #[test]
    fn status_feedback_carries_text_and_severity() {
        let ok = Status::Success("Word 文件已导出".into());
        assert_eq!(ok.text(), "Word 文件已导出");
        assert!(!ok.is_error());

        let err = Status::Error("Markdown 内容为空".into());
        assert_eq!(err.text(), "Markdown 内容为空");
        assert!(err.is_error());
    }

    // ---------- 渲染冒烟（亮 / 暗主题） ----------

    #[gpui::test]
    async fn renders_in_light_and_dark(cx: &mut gpui::TestAppContext) {
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
            let (_view, _cx) = cx.add_window_view(|_window, _cx| MarkdownToWordView::new());
            cx.read(|app| {
                assert_eq!(
                    crate::theme::AppTheme::current(app).dark,
                    dark,
                    "主题偏好未生效"
                );
            });
        }
    }
}
