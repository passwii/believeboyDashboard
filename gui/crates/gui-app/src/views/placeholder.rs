//! 占位内容视图（GUI-3 / 0.3）
//!
//! 侧栏子项对应页面的 GUI 实现尚未开始（按 frontend sidebar 顺序逐个推进），
//! 点击任意子项后，内容区先显示本占位视图；后续 issue 逐项替换为真实 View。

use gpui::{prelude::*, Context, SharedString, Window, div, rgb};

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
        div()
            .id("placeholder-content")
            .flex()
            .flex_col()
            .size_full()
            .items_center()
            .justify_center()
            .gap_2()
            .bg(rgb(0xfafafa)) // zinc-50
            .child(
                div()
                    .text_xl()
                    .text_color(rgb(0x18181b))
                    .child(SharedString::from(self.title.clone())),
            )
            .child(
                div()
                    .text_sm()
                    .text_color(rgb(0x71717a))
                    .child(SharedString::from(self.url.clone())),
            )
            .child(
                div()
                    .mt_2()
                    .text_sm()
                    .text_color(rgb(0xa1a1aa))
                    .child(SharedString::from("该页面 GUI 实现中（按 frontend sidebar 顺序推进）")),
            )
    }
}
