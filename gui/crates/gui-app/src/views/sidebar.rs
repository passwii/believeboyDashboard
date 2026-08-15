//! 左侧侧栏视图（P2-3 原生化打磨版，BLF-690）
//!
//! 渲染 gui-domain::sidebar 的 8 个一级分类 + 全部二级子项（52 项，硬编码数据）。
//!
//! macOS 原生质感（对齐 Finder / 系统设置侧栏）：
//! - **半透明材质**：主窗口背景为系统模糊材质（main.rs 配
//!   `WindowBackgroundAppearance::Blurred`，RootView 根容器不画不透明背景），
//!   侧栏以低透明度 [`crate::theme::AppTheme::sidebar_bg`] 覆盖其上透出模糊，
//!   右侧 1px 发丝分隔线（Finder 风格）
//! - **选中态**：中性色圆角胶囊（浅色=白胶囊+柔和投影 / 深色=高亮灰胶囊），
//!   hover 轻微灰底反馈；macOS 侧栏选中不用品牌蓝（那是 iOS 风格），靠明度区分
//! - **分组标题（section header）**：小字号/灰色/上留白，纯文字无图标（原生语义）
//! - **间距体系**：行高 32px、圆角 6px、图标 16px 定宽对齐、8px 内边距与图标间距、
//!   文字超长省略号截断
//! - **折叠/展开**：底部切换按钮；折叠后为 56px 图标轨道（icon rail），
//!   悬停显示原生 tooltip（gpui 内建 tooltip 系统），分组以间距分隔
//! - **键盘导航保持**：↑/↓ 移动选中并激活，Enter 确认（GUI-3 实现，折叠不影响）

use gpui::{
    div, prelude::*, px, svg, App, BoxShadow, Context, EventEmitter, FocusHandle, Focusable,
    KeyDownEvent, SharedString, Window,
};
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::{ActiveTheme, Icon, IconName, Sizable};

use gui_domain::sidebar::{sidebar_groups, SidebarGroup, SidebarItem};

use crate::icon::icon_path;
use crate::theme::AppTheme;

/// 展开态侧栏宽度（px）
const SIDEBAR_WIDTH: f32 = 240.0;
/// 折叠态侧栏宽度（px，图标轨道）
const SIDEBAR_WIDTH_COLLAPSED: f32 = 56.0;
/// 侧栏材质透明度：半透明覆盖在主窗口系统模糊之上（越低越透出背景）
const SIDEBAR_BG_ALPHA: f32 = 0.85;

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
    /// P2-3：是否折叠为图标轨道
    collapsed: bool,
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
            collapsed: false,
        }
    }

    /// 当前侧栏宽度（px）：折叠态 56 / 展开态 240
    fn width(&self) -> f32 {
        if self.collapsed {
            SIDEBAR_WIDTH_COLLAPSED
        } else {
            SIDEBAR_WIDTH
        }
    }

    /// 折叠/展开切换（P2-3；底部切换按钮触发）
    fn toggle_collapsed(&mut self, cx: &mut Context<Self>) {
        self.collapsed = !self.collapsed;
        cx.notify();
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
        let collapsed = self.collapsed;

        div()
            .id("sidebar")
            .flex()
            .flex_col()
            .w(px(self.width()))
            .h_full()
            // P2-3 材质：半透明 sidebar_bg 覆盖在主窗口系统模糊材质之上（main.rs 配
            // `WindowBackgroundAppearance::Blurred` + root 不画不透明背景），透出模糊；
            // 右侧发丝分隔线把侧栏与内容区切开（macOS sidebar 风格）
            .bg(theme.sidebar_bg.alpha(SIDEBAR_BG_ALPHA))
            .border_r_1()
            .border_color(theme.sidebar_border.alpha(0.7))
            .focusable()
            .track_focus(&focus_handle)
            .on_key_down(cx.listener(|this, event, _, cx| this.on_key_down(event, cx)))
            .child(sidebar_header(&theme, collapsed))
            .child(
                div()
                    .id("sidebar-scroll")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .w_full()
                    .overflow_y_scroll()
                    .children(
                        self.groups.iter().map(|group| {
                            render_group(group, selected_url.as_deref(), collapsed, cx)
                        }),
                    ),
            )
            .child(sidebar_footer(&theme, collapsed, cx))
    }
}

/// 侧栏头部：品牌标识 + 名称。折叠态只显示品牌方块（居中）。
fn sidebar_header(theme: &AppTheme, collapsed: bool) -> impl IntoElement {
    if collapsed {
        return div()
            .id("sidebar-header")
            .flex()
            .items_center()
            .justify_center()
            .w_full()
            .h(px(52.0))
            .child(brand_mark(theme));
    }

    div()
        .id("sidebar-header")
        .flex()
        .items_center()
        .w_full()
        .h(px(52.0))
        .gap_2()
        .px_3()
        // 原生侧栏头部无底部分隔线（材质整体一体，分组靠留白）
        .child(brand_mark(theme))
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

/// 品牌小方块（展开态左侧 / 折叠态居中）
fn brand_mark(theme: &AppTheme) -> impl IntoElement {
    div()
        .size(px(22.0))
        .rounded_md()
        .flex()
        .items_center()
        .justify_center()
        .bg(theme.brand)
        .child(div().size(px(10.0)).rounded_full().bg(theme.brand_soft))
}

/// 侧栏底部：功能入口计数 + 折叠/展开切换按钮。
///
/// 折叠态只保留居中切换按钮（图标轨道下缘）。
fn sidebar_footer(
    theme: &AppTheme,
    collapsed: bool,
    cx: &mut Context<SidebarView>,
) -> impl IntoElement {
    if collapsed {
        return div()
            .id("sidebar-footer")
            .flex()
            .items_center()
            .justify_center()
            .w_full()
            .h(px(36.0))
            .child(collapse_toggle_button(collapsed, cx));
    }

    div()
        .id("sidebar-footer")
        .flex()
        .items_center()
        .justify_between()
        .w_full()
        .h(px(36.0))
        .px_3()
        .child(
            div()
                .text_xs()
                .text_color(theme.sidebar_footer_text)
                .child(SharedString::from("52 个功能入口")),
        )
        .child(collapse_toggle_button(collapsed, cx))
}

/// 折叠/展开切换按钮（ghost 图标按钮 + tooltip）
fn collapse_toggle_button(collapsed: bool, cx: &mut Context<SidebarView>) -> impl IntoElement {
    let (icon, tip) = if collapsed {
        (IconName::PanelLeftOpen, "展开侧栏")
    } else {
        (IconName::PanelLeftClose, "折叠侧栏")
    };

    Button::new("sidebar-toggle")
        .ghost()
        .small()
        .icon(Icon::new(icon).with_size(px(14.0)))
        .tooltip(tip)
        .on_click(cx.listener(|this, _, _, cx| this.toggle_collapsed(cx)))
}

/// 一个分组：展开态 = section header + 子项列表；折叠态 = 只留子项（间距分隔分组）。
fn render_group(
    group: &SidebarGroup,
    selected_url: Option<&str>,
    collapsed: bool,
    cx: &mut Context<SidebarView>,
) -> impl IntoElement {
    let theme = AppTheme::current(cx);
    let wrap_id = SharedString::from(format!("sidebar-group-wrap-{}", group.id));

    div()
        .id(wrap_id)
        .flex()
        .flex_col()
        .w_full()
        .when(collapsed, |this| this.mt_3())
        .when(!collapsed, |this| {
            this.child(render_group_header(group, &theme))
        })
        .children(
            group.items.iter().map(|item| {
                render_item(item, selected_url == Some(item.url.as_str()), collapsed, cx)
            }),
        )
}

/// 分组标题（section header）：小字号/灰色/上留白，纯文字（macOS 原生语义）。
fn render_group_header(group: &SidebarGroup, theme: &AppTheme) -> impl IntoElement {
    div()
        .id(SharedString::from(format!("sidebar-group-{}", group.id)))
        .w_full()
        .px_3()
        .mt_4()
        .mb_1()
        .text_xs()
        .text_color(theme.sidebar_group_text)
        .font_weight(gpui::FontWeight::MEDIUM)
        .child(SharedString::from(group.label.clone()))
}

/// 单个子项：
/// - 展开态：图标 + 文字，选中=中性色圆角胶囊（浅色白胶囊+投影 / 深色高亮灰）
/// - 折叠态：纯图标居中，悬停显示原生 tooltip（标题）
fn render_item(
    item: &SidebarItem,
    active: bool,
    collapsed: bool,
    cx: &mut Context<SidebarView>,
) -> impl IntoElement {
    let theme = AppTheme::current(cx);
    let url = item.url.clone();
    let title = item.title.clone();
    let item_id = SharedString::from(format!("sidebar-item-{}", item.url));
    let icon_path = icon_path(&item.icon);
    let icon_color = if active {
        theme.sidebar_item_active_text
    } else {
        // 未激活图标弱化（macOS 侧栏图标常态 60% 灰度）
        theme.sidebar_group_text
    };
    // 点击 / tooltip / 文字各持一份（闭包 move 捕获）
    let url_for_click = url.clone();
    let title_for_click = title.clone();

    let base = div()
        .id(item_id)
        .flex()
        .items_center()
        .w_full()
        .h(px(32.0))
        .gap_2()
        .px_2()
        .mx_1()
        .rounded(px(theme.radius))
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
        .shadow(if active {
            vec![active_item_shadow(&theme)]
        } else {
            vec![]
        })
        .hover(|this| {
            this.bg(if active {
                theme.sidebar_item_active_bg
            } else {
                theme.sidebar_item_hover
            })
        })
        .child(svg().path(icon_path).size(px(16.0)).text_color(icon_color))
        .on_click(cx.listener(move |this, _, _, cx| {
            this.select(&url_for_click, &title_for_click, cx);
        }));

    if collapsed {
        // 图标轨道：图标居中；悬停出原生 tooltip 补足标题可发现性
        return base
            .justify_center()
            .tooltip(move |_window, cx| cx.new(|_| SidebarTooltip::new(title.clone())).into())
            .into_any_element();
    }

    base.child(
        div()
            .flex_1()
            .min_w_0()
            .truncate()
            .child(SharedString::from(item.title.clone())),
    )
    .into_any_element()
}

/// 选中胶囊的柔和投影（macOS 浅色侧栏选中项带轻投影）
fn active_item_shadow(theme: &AppTheme) -> BoxShadow {
    BoxShadow {
        color: theme.sidebar_item_shadow,
        offset: gpui::point(px(0.0), px(1.0)),
        blur_radius: px(8.0),
        spread_radius: px(0.0),
    }
}

/// 折叠态悬停的原生 tooltip 视图（跟随主题 popover 语义色）
struct SidebarTooltip {
    title: SharedString,
}

impl SidebarTooltip {
    fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
        }
    }
}

impl Render for SidebarTooltip {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .px_2()
            .py_1()
            .rounded(px(6.0))
            .bg(cx.theme().popover)
            .border_1()
            .border_color(cx.theme().border)
            .shadow_sm()
            .text_sm()
            .text_color(cx.theme().popover_foreground)
            .child(self.title.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// P2-3：侧栏默认展开；展开/折叠宽度契约（240 ↔ 56）。
    #[gpui::test]
    async fn sidebar_defaults_expanded_and_width_contract(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_window, cx| SidebarView::new(None, cx));
        cx.read(|app| {
            let sidebar = view.read(app);
            assert!(!sidebar.collapsed, "侧栏默认应展开");
            assert_eq!(sidebar.width(), SIDEBAR_WIDTH);
        });

        view.update(cx, |this, cx| {
            this.toggle_collapsed(cx);
            assert!(this.collapsed);
            assert_eq!(this.width(), SIDEBAR_WIDTH_COLLAPSED);
            this.toggle_collapsed(cx);
            assert!(!this.collapsed);
            assert_eq!(this.width(), SIDEBAR_WIDTH);
        });
    }

    /// P2-3：渲染冒烟——展开态（含分组标题 + 选中态路径）与折叠态（图标轨道 +
    /// tooltip 构造路径）均可完整渲染不 panic。
    #[gpui::test]
    async fn sidebar_renders_expanded_and_collapsed(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_window, cx| {
            SidebarView::new(Some("/dashboard/operations/site-navigation"), cx)
        });
        // 折叠态再渲染一次（tooltip 构造路径 + 图标轨道布局）
        view.update(cx, |this, cx| this.toggle_collapsed(cx));
    }

    /// P2-3：键盘导航数据契约——展平子项数 = 8 组全量 52 项，折叠不改变导航范围。
    #[test]
    fn sidebar_flat_items_cover_all_groups() {
        let groups = sidebar_groups();
        let flat: usize = groups.iter().map(|g| g.items.len()).sum();
        assert_eq!(
            flat, 52,
            "8 组共 52 个子项（与 frontend SIDEBAR_TOP_GROUPS 一致）"
        );
    }
}
