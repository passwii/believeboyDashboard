//! 占位内容视图（GUI-3 / 0.3，打磨版）
//!
//! 侧栏子项对应页面的 GUI 实现尚未开始，点击任意子项后内容区显示本占位视图：
//! 居中卡片（图标 + 标题 + url + 状态说明），后续 issue 逐项替换为真实 View。

use gpui::{div, prelude::*, px, svg, Context, SharedString, Window};

use crate::icon::icon_path;
use crate::theme::Theme;

pub struct PlaceholderView {
    pub title: String,
    pub url: String,
}

impl PlaceholderView {
    pub fn new(title: &str, url: &str) -> Self {
        Self {
            title: title.to_string(),
            url: url.to_string(),
        }
    }
}

impl Render for PlaceholderView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::dark_sidebar_light_content();

        div()
            .id("placeholder-content")
            .flex()
            .flex_col()
            .size_full()
            .items_center()
            .justify_center()
            .gap_3()
            .bg(theme.content_bg)
            .child(
                div()
                    .id("placeholder-card")
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap_3()
                    .px(px(48.0))
                    .py(px(40.0))
                    .rounded_xl()
                    .bg(theme.content_card_bg)
                    .border_1()
                    .border_color(theme.content_card_border)
                    .child(placeholder_icon(&theme, &self.title))
                    .child(
                        div()
                            .text_2xl()
                            .text_color(theme.content_title)
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child(SharedString::from(self.title.clone())),
                    )
                    .child(
                        div()
                            .text_sm()
                            .text_color(theme.content_subtitle)
                            .child(SharedString::from(self.url.clone())),
                    )
                    .child(
                        div()
                            .mt_2()
                            .text_sm()
                            .text_color(theme.content_muted)
                            .child(SharedString::from(
                                "该页面 GUI 实现中（按 frontend sidebar 顺序推进）",
                            )),
                    ),
            )
    }
}

/// 占位卡上方的图标（取当前子项的图标资源）
fn placeholder_icon(theme: &Theme, title: &str) -> impl IntoElement {
    // 这里只按标题取个代表性图标；后续真实 View 落地后此函数移除
    let path = icon_path(match title {
        "站点导航" => "LayoutDashboard",
        "销售数据" | "AI洞察" => "TrendingUp",
        "财务月报" => "FileBarChart",
        "广告分析" | "数据看板" => "BarChart3",
        "AI Chat" | "客服交流" => "MessagesSquare",
        "库存分析" | "库存分类账" => "Warehouse",
        "客户" | "数字员工" => "Users",
        _ => "LayoutDashboard",
    });

    div()
        .size(px(56.0))
        .rounded_2xl()
        .flex()
        .items_center()
        .justify_center()
        .bg(theme.brand_soft) // blue-50
        .child(
            svg()
                .path(path)
                .size(px(28.0))
                .text_color(theme.content_accent),
        )
}
