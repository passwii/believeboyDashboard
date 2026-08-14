//! 左侧侧栏视图（GUI-3 / 0.3）
//!
//! 渲染 gui-domain::sidebar 的 8 个一级分类 + 全部二级子项（52 项），
//! 数据来自 `sidebar_groups()`（与 frontend `lib/sidebar-config.ts` 1:1，硬编码，不调后端）。
//!
//! 交互：
//! - 点击子项 → 高亮该项并 emit `SidebarEvent::Select`（根视图切内容区到占位 View）
//! - 分组标题显示「label · 子项数」，便于核对条目数

use gpui::{prelude::*, Context, EventEmitter, SharedString, Window, div, px, rgb};

use gui_domain::sidebar::{sidebar_groups, SidebarGroup, SidebarItem};

/// 侧栏发出的导航事件
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidebarEvent {
    /// 选中某个子项
    Select { url: String, title: String },
}

/// 左侧侧栏视图
pub struct SidebarView {
    groups: Vec<SidebarGroup>,
    selected_url: Option<String>,
}

impl SidebarView {
    pub fn new(initial_url: Option<&str>, _cx: &mut Context<Self>) -> Self {
        Self {
            groups: sidebar_groups(),
            selected_url: initial_url.map(|url| url.to_string()),
        }
    }

    fn on_item_click(&mut self, url: String, title: String, cx: &mut Context<Self>) {
        if self.selected_url.as_deref() == Some(url.as_str()) {
            return;
        }
        self.selected_url = Some(url.clone());
        cx.emit(SidebarEvent::Select { url, title });
        cx.notify();
    }
}

impl EventEmitter<SidebarEvent> for SidebarView {}

impl Render for SidebarView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let selected_url = self.selected_url.clone();

        div()
            .id("sidebar")
            .flex()
            .flex_col()
            .w(px(240.0))
            .h_full()
            .bg(rgb(0x18181b)) // zinc-950，dark 侧栏底色
            .overflow_y_scroll()
            .child(sidebar_header())
            .children(self.groups.iter().map(|group| {
                render_group(group, selected_url.as_deref(), cx)
            }))
    }
}

fn sidebar_header() -> impl IntoElement {
    div()
        .id("sidebar-header")
        .flex()
        .items_center()
        .w_full()
        .h(px(48.0))
        .px_3()
        .border_b_1()
        .border_color(rgb(0x27272a))
        .child(
            div()
                .text_base()
                .text_color(rgb(0xffffff))
                .child(SharedString::from("BelieveBoy GUI")),
        )
}

fn render_group(
    group: &SidebarGroup,
    selected_url: Option<&str>,
    cx: &mut Context<SidebarView>,
) -> impl IntoElement {
    let group_id = group.id.clone();
    let header = div()
        .id(SharedString::from(format!("sidebar-group-{group_id}")))
        .flex()
        .items_center()
        .w_full()
        .px_3()
        .pt_3()
        .pb_1()
        .child(
            div()
                .text_xs()
                .text_color(rgb(0x8b8b8b))
                .child(SharedString::from(format!("{} · {}", group.label, group.items.len()))),
        );

    div()
        .id(SharedString::from(format!("sidebar-group-wrap-{group_id}")))
        .flex()
        .flex_col()
        .w_full()
        .child(header)
        .children(
            group
                .items
                .iter()
                .map(|item| render_item(item, selected_url == Some(item.url.as_str()), cx)),
        )
}

fn render_item(
    item: &SidebarItem,
    active: bool,
    cx: &mut Context<SidebarView>,
) -> impl IntoElement {
    let url = item.url.clone();
    let title = item.title.clone();
    let item_id = SharedString::from(format!("sidebar-item-{}", item.url));

    div()
        .id(item_id)
        .flex()
        .items_center()
        .w_full()
        .px_3()
        .py_1()
        .rounded_sm()
        .cursor_pointer()
        .text_sm()
        .text_color(if active { rgb(0xffffff) } else { rgb(0xa1a1aa) })
        .bg(if active {
            rgb(0x3f3f46).into()
        } else {
            gpui::transparent_black()
        })
        .hover(|this| {
            this.bg(if active {
                rgb(0x3f3f46).into()
            } else {
                gpui::transparent_black()
            })
        })
        .child(SharedString::from(item.title.clone()))
        .on_click(cx.listener(move |this, _, _, cx| {
            this.on_item_click(url.clone(), title.clone(), cx);
        }))
}
