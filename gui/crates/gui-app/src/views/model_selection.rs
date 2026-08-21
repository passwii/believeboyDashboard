//! AI 智能 → 模型选型（P5-6，BLF-739）
//!
//! 对齐 web 端 `app/dashboard/ai/believeboy-models`（约 146 行）。
//!
//! ## 数据源结论（执行时读 web 源码确认）
//!
//! web 端 `page.tsx` 是 server component 直接 `readFile` 仓库内
//! `frontend/docs/believeboy-models.md`——**无后端 API**；客户端仅用
//! react-markdown + remark-gfm 渲染。因此本视图按 issue 允许的
//! 「内嵌 md 渲染」路线：`include_str!` 直接引用**同一份** md 文件
//! （单一数据源，rustc dep-info 追踪该文件，团队改 md 后 web / GUI
//! 同步生效、GUI 重编译自动带上），渲染用 gpui-component `TextView`
//! markdown（GFM 表格 / 任务列表支持）。
//!
//! ## 与 web 端的取舍（issue 允许按 macOS 原生习惯精简并说明）
//!
//! - **保留**：PageHeader（标题 + 描述）、文档元信息条（归档位 / 归属 /
//!   最后更新，对齐 web `DOC_META` + md frontmatter）、markdown 全文渲染；
//! - **精简**：
//!   - 「查看原始 markdown」外链不移植（web 链接指向 Next 静态资源
//!     `/docs/believeboy-models.md`，GUI 无对应静态服务；原文即本仓库
//!     md 文件）；
//!   - web `[&_h1]:hidden` 的等价实现：渲染前剥离文档首个 H1 行
//!     （标题由 PageHeader 承载，见 [`strip_leading_h1`]）；
//!   - 手机端排版断点不移植（GUI 桌面端单布局）。
//!
//! ## 状态机
//!
//! 纯静态文档（编译期内嵌，无网络请求）——无加载 / 错误 / 空态，
//! 与 `site_navigation` 同类的静态视图；冒烟覆盖亮 / 暗主题渲染。

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

use gpui::{div, prelude::*, Context, Render, Window};
use gpui_component::text::TextView;
use gpui_component::{h_flex, v_flex};

use crate::theme::AppTheme;
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;

/// sidebar「AI 智能 → 模型选型」URL（数据权威 gui-domain::sidebar）
pub const MODEL_SELECTION_URL: &str = "/dashboard/ai/believeboy-models";

/// 文档数据源：与 web 端同一份 md（frontend/docs/believeboy-models.md，
/// 从 teamRock 同步）。include_str! 编译期内嵌——单一数据源，团队改 md 后
/// web / GUI 同步生效（rustc dep-info 追踪该文件，改动触发 GUI 重编译）。
const DOC_SOURCE: &str = include_str!("../../../../../frontend/docs/believeboy-models.md");

/// 页面副标题（对齐 web PageHeader description）
const PAGE_SUBTITLE: &str = "汇总 Believeboy 系列大模型的规格与定位，以表格形式对比各档位模型在 名称 / 架构 / 大小 / 上下文 / 背后模型 五个维度的差异，便于算力选型、推理部署、对外展示时快速查阅。（最后更新 2026-07-07）";

/// 文档元信息（对齐 web `DOC_META` + md frontmatter「最后更新」）
const DOC_META: &[(&str, &str)] = &[
    (
        "归档位",
        "teamRock/BBCC-彼励扶基础设施/彼励扶_Believeboy模型选型方案.md",
    ),
    ("归属", "BBCC · 彼励扶基础设施 / 模型选型"),
    ("最后更新", "2026-07-07"),
];

/// 去掉文档首个 H1 标题行（对齐 web `[&_h1]:hidden`——页面标题由
/// PageHeader 承载，避免重复）。仅剥首个 `# ` 行；正文其余内容原样保留。
fn strip_leading_h1(doc: &str) -> String {
    let trimmed = doc.trim_start();
    match trimmed.strip_prefix("# ") {
        Some(rest) => {
            let after = rest.split_once('\n').map(|(_, tail)| tail).unwrap_or("");
            after.trim_start_matches('\n').trim_end().to_string()
        }
        None => doc.trim().to_string(),
    }
}

/// 文档元信息 chip（对齐 web 虚线框内 label + mono value 观感）
fn meta_chip(label: &str, value: &str, theme: &AppTheme) -> gpui::AnyElement {
    h_flex()
        .items_center()
        .gap_1p5()
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .child(label.to_string()),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.text_secondary)
                .child(value.to_string()),
        )
        .into_any_element()
}

/// 文档元信息条（虚线边框容器，对齐 web `border-dashed` meta bar）
fn meta_bar(theme: &AppTheme) -> gpui::AnyElement {
    h_flex()
        .flex_wrap()
        .items_center()
        .gap_4()
        .rounded_lg()
        .border_1()
        .border_color(theme.separator)
        .bg(theme.muted_fill.opacity(0.4))
        .px_4()
        .py_2p5()
        .children(
            DOC_META
                .iter()
                .map(|(label, value)| meta_chip(label, value, theme)),
        )
        .into_any_element()
}

/// 模型选型视图：纯静态文档（编译期内嵌，无网络请求）——无加载 /
/// 错误 / 空态，与 site_navigation 同类的静态视图。
pub struct ModelSelectionView;

impl ModelSelectionView {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ModelSelectionView {
    fn default() -> Self {
        Self::new()
    }
}

impl Render for ModelSelectionView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let doc = strip_leading_h1(DOC_SOURCE);

        v_flex()
            .id("model-selection")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(theme.window_bg)
            // 页面头部（共享 PageHeader；标题 + 描述，对齐 web PageHeader）
            .child(PageHeader::new("彼励扶 Believeboy 模型选型方案").subtitle(PAGE_SUBTITLE))
            // 文档元信息条（归档位 / 归属 / 最后更新）
            .child(content_guard().child(meta_bar(&theme)))
            // markdown 全文（GFM 表格 / 任务列表；可选中文本便于复制）
            .child(content_guard().child(
                div()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme.separator)
                    .bg(theme.card_bg)
                    .p_6()
                    .child(
                        TextView::markdown("model-selection-doc", doc, window, cx)
                            .selectable(true),
                    ),
            ))
    }
}

// ---------------------------------------------------------------------------
// 测试（先写：RED 基准）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- 常量 / 数据源契约 ----------

    #[test]
    fn url_constant_matches_sidebar() {
        assert_eq!(MODEL_SELECTION_URL, "/dashboard/ai/believeboy-models");
    }

    #[test]
    fn doc_source_is_embedded_web_markdown() {
        // 内嵌的必须是与 web 端同一份 md（frontend/docs/believeboy-models.md），
        // 用文档标志性内容锁定：改错文件 / 拷贝漂移会在此失败。
        assert!(DOC_SOURCE.contains("# 彼励扶 Believeboy 模型选型方案"));
        assert!(DOC_SOURCE.contains("## 1. 模型对比表"));
        assert!(DOC_SOURCE.contains("| Believeboy-Ultra |"));
        assert!(DOC_SOURCE.contains("## 3. 选型速览"));
        assert!(!DOC_SOURCE.is_empty());
    }

    #[test]
    fn doc_meta_matches_web_doc_meta() {
        // 对齐 web believeboy-models-view.tsx DOC_META + md frontmatter
        let labels: Vec<&str> = DOC_META.iter().map(|(l, _)| *l).collect();
        assert_eq!(labels, vec!["归档位", "归属", "最后更新"]);
        let archive = DOC_META.iter().find(|(l, _)| *l == "归档位").unwrap();
        assert_eq!(
            archive.1,
            "teamRock/BBCC-彼励扶基础设施/彼励扶_Believeboy模型选型方案.md"
        );
        let updated = DOC_META.iter().find(|(l, _)| *l == "最后更新").unwrap();
        assert_eq!(updated.1, "2026-07-07");
    }

    #[test]
    fn page_subtitle_matches_web_description() {
        // 对齐 web PageHeader description（五维度口径）
        assert!(PAGE_SUBTITLE.contains("名称 / 架构 / 大小 / 上下文 / 背后模型"));
    }

    // ---------- strip_leading_h1（web `[&_h1]:hidden` 的等价实现） ----------

    #[test]
    fn strip_leading_h1_removes_first_heading_line() {
        let doc = "# 标题\n\n## 第一节\n正文\n";
        assert_eq!(strip_leading_h1(doc), "## 第一节\n正文");
    }

    #[test]
    fn strip_leading_h1_handles_no_heading_and_no_trailing_newline() {
        // 无 H1 → 原样（仅去首部空白）
        assert_eq!(strip_leading_h1("## 第一节\n正文"), "## 第一节\n正文");
        // 整文档只有一个 H1 行（无换行）→ 空串
        assert_eq!(strip_leading_h1("# 只有一行"), "");
    }

    #[test]
    fn strip_leading_h1_keeps_later_h1_lines_and_inline_hashes() {
        // 只有**首个** H1 被剥离；正文里出现的 `#` 开头行（非行首）不受影响
        let doc = "# 首标题\n正文提到 # 不是标题\n# 第二个 H1\n";
        let out = strip_leading_h1(doc);
        assert!(out.starts_with("正文提到"));
        assert!(out.contains("# 第二个 H1"));
    }

    #[test]
    fn strip_leading_h1_real_doc_starts_with_section_zero() {
        let out = strip_leading_h1(DOC_SOURCE);
        assert!(out.starts_with("## 0. 摘要") || out.contains("## 0. 摘要"));
        assert!(!out.starts_with("# "));
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
            let (_view, _cx) = cx.add_window_view(|_window, _cx| ModelSelectionView::new());
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
