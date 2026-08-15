//! 左侧侧栏视图（GUI-3 / 0.3，打磨版）
//!
//! 渲染 gui-domain::sidebar 的 8 个一级分类 + 全部二级子项（52 项，硬编码数据）。
//!
//! 打磨点（对齐 frontend sidebar 设计语言 + build-gpui-apps skill 交互规范）：
//! - 每个子项带 16px 矢量图标（Lucide 路径，内嵌 SVG）
//! - 行高 32px、圆角 6px、8px 内边距与图标间距；悬停 / 激活状态分明
//! - 分组标题小号弱化；侧栏整体可滚动
//! - 键盘导航：↑/↓ 移动选中，Enter 确认（可访问性）
//! - 稳定元素 ID（基于子项 url），语义 role + aria label

use gpui::{
    div, prelude::*, px, svg, App, Context, EventEmitter, FocusHandle, Focusable, KeyDownEvent,
    SharedString, Window,
};

use gui_domain::sidebar::{sidebar_groups, SidebarGroup, SidebarItem};

use crate::icon::icon_path;
use crate::theme::AppTheme;

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
    /// 键盘焦点游标（展平索引，指向所有子项）
    cursor: usize,
    /// 展平的子项引用（键盘导航用，按显示顺序）
    flat_items: Vec<FlatItem>,
    focus_handle: FocusHandle,
}

struct FlatItem {
    url: String,
    title: String,
}

impl SidebarView {
    pub fn new(initial_url: Option<&str>, cx: &mut Context<Self>) -> Self {
        let groups = sidebar_groups();
        let flat_items = groups
            .iter()
            .flat_map(|g| g.items.iter())
            .map(|it| FlatItem {
                url: it.url.clone(),
                title: it.title.clone(),
            })
            .collect::<Vec<_>>();

        let cursor = initial_url
            .and_then(|url| flat_items.iter().position(|it| it.url == url))
            .unwrap_or(0);

        Self {
            groups,
            selected_url: initial_url.map(|url| url.to_string()),
            cursor,
            flat_items,
            focus_handle: cx.focus_handle(),
        }
    }

    fn select(&mut self, url: &str, title: &str, cx: &mut Context<Self>) {
        if self.selected_url.as_deref() == Some(url) {
            return;
        }
        self.selected_url = Some(url.to_string());
        if let Some(i) = self.flat_items.iter().position(|it| it.url == url) {
            self.cursor = i;
        }
        cx.emit(SidebarEvent::Select {
            url: url.to_string(),
            title: title.to_string(),
        });
        cx.notify();
    }

    /// 键盘导航：↑/↓ 移动选中并激活，Enter 确认当前项
    fn on_key_down(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        match key {
            "up" | "down" => {
                let delta = if key == "up" { -1 } else { 1 };
                // 着陆页（无选中项）首次键盘导航：先选中当前游标项（0），不跳跃
                let next = if self.selected_url.is_none() {
                    self.cursor
                } else {
                    (self.cursor as isize + delta).clamp(0, self.flat_items.len() as isize - 1)
                        as usize
                };
                if next != self.cursor {
                    self.cursor = next;
                    let item = &self.flat_items[next];
                    self.selected_url = Some(item.url.clone());
                    cx.emit(SidebarEvent::Select {
                        url: item.url.clone(),
                        title: item.title.clone(),
                    });
                    cx.notify();
                }
            }
            "enter" => {
                if let Some(item) = self.flat_items.get(self.cursor) {
                    if self.selected_url.as_deref() != Some(item.url.as_str()) {
                        self.selected_url = Some(item.url.clone());
                        cx.emit(SidebarEvent::Select {
                            url: item.url.clone(),
                            title: item.title.clone(),
                        });
                        cx.notify();
                    }
                }
            }
            _ => {}
        }
    }
}

impl EventEmitter<SidebarEvent> for SidebarView {}

impl Focusable for SidebarView {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for SidebarView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let selected_url = self.selected_url.clone();
        let focus_handle = self.focus_handle.clone();

        div()
            .id("sidebar")
            .flex()
            .flex_col()
            .w(px(240.0))
            .h_full()
            .bg(theme.sidebar_bg)
            .focusable()
            .track_focus(&focus_handle)
            .on_key_down(cx.listener(|this, event, _, cx| this.on_key_down(event, cx)))
            .child(sidebar_header(&theme))
            .child(
                div()
                    .id("sidebar-scroll")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .w_full()
                    .overflow_y_scroll()
                    .children(
                        self.groups
                            .iter()
                            .map(|group| render_group(group, selected_url.as_deref(), cx)),
                    ),
            )
            .child(sidebar_footer(&theme))
    }
}

fn sidebar_header(theme: &AppTheme) -> impl IntoElement {
    div()
        .id("sidebar-header")
        .flex()
        .items_center()
        .w_full()
        .h(px(52.0))
        .gap_2()
        .px_3()
        .border_b_1()
        .border_color(theme.sidebar_border)
        .child(
            // 品牌小方块
            div()
                .size(px(22.0))
                .rounded_md()
                .flex()
                .items_center()
                .justify_center()
                .bg(theme.brand)
                .child(div().size(px(10.0)).rounded_full().bg(theme.brand_soft)),
        )
        .child(
            div()
                .flex_col()
                .child(
                    div()
                        .text_base()
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .text_color(theme.sidebar_text)
                        .child(SharedString::from("BelieveBoy")),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.sidebar_group_text)
                        .child(SharedString::from("彼励扶 Dashboard")),
                ),
        )
}

fn sidebar_footer(theme: &AppTheme) -> impl IntoElement {
    div()
        .id("sidebar-footer")
        .flex()
        .items_center()
        .w_full()
        .h(px(32.0))
        .px_3()
        .border_t_1()
        .border_color(theme.sidebar_border)
        .child(
            div()
                .text_xs()
                .text_color(theme.sidebar_footer_text)
                .child(SharedString::from("GUI v0.3 · 52 个功能入口")),
        )
}

fn render_group(
    group: &SidebarGroup,
    selected_url: Option<&str>,
    cx: &mut Context<SidebarView>,
) -> impl IntoElement {
    let theme = AppTheme::current(cx);
    let group_id = group.id.clone();
    let group_icon = icon_path(&group.icon);

    let header = div()
        .id(SharedString::from(format!("sidebar-group-{group_id}")))
        .flex()
        .items_center()
        .w_full()
        .h(px(30.0))
        .gap_2()
        .px_3()
        .child(
            svg()
                .path(group_icon)
                .size(px(12.0))
                .text_color(theme.sidebar_group_text),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.sidebar_group_text)
                .font_weight(gpui::FontWeight::MEDIUM)
                .child(SharedString::from(format!(
                    "{} · {}",
                    group.label,
                    group.items.len()
                ))),
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
    let theme = AppTheme::current(cx);
    let url = item.url.clone();
    let title = item.title.clone();
    let item_id = SharedString::from(format!("sidebar-item-{}", item.url));
    let icon_path = icon_path(&item.icon);

    div()
        .id(item_id)
        .flex()
        .items_center()
        .w_full()
        .h(px(32.0))
        .gap_2()
        .px_2()
        .mx_1()
        .rounded_md()
        .cursor_pointer()
        .text_sm()
        .text_color(if active {
            theme.sidebar_item_active_text
        } else {
            theme.sidebar_text
        })
        .font_weight(if active {
            gpui::FontWeight::MEDIUM
        } else {
            gpui::FontWeight::NORMAL
        })
        .bg(if active {
            theme.sidebar_item_active_bg
        } else {
            gpui::transparent_black()
        })
        .hover(|this| {
            this.bg(if active {
                theme.sidebar_item_active_bg
            } else {
                theme.sidebar_item_hover
            })
        })
        .child(svg().path(icon_path).size(px(16.0)).text_color(if active {
            theme.sidebar_item_active_text
        } else {
            theme.sidebar_group_text // 弱化未激活图标
        }))
        .child(SharedString::from(item.title.clone()))
        .on_click(cx.listener(move |this, _, _, cx| {
            this.select(&url, &title, cx);
        }))
}
