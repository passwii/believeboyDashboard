//! 左侧侧栏视图（P2-3 原生化打磨版，BLF-690；P4-1 窗口 Chrome 重构版，BLF-707）
//!
//! 渲染 gui-domain::sidebar 的 8 个一级分类 + 全部二级子项（52 项，硬编码数据）。
//!
//! macOS 原生质感（对齐 Finder / 系统设置侧栏）：
//! - **不透明实色材质（P4-3）**：GPUI 0.2.2 无 NSVisualEffectView 直接接入，半透明
//!   覆盖 + 系统整窗模糊模拟观感粗糙（且禁用亚像素文字渲染，见 build-gpui-apps
//!   apple-glass.md Tier 4/6）——收敛为不透明显实色侧栏（浅 #ECECEC / 深 #282828），
//!   右侧 1px 发丝分隔线（Finder 风格），文字图标清晰不脏
//! - **全高布局（P4-1）**：侧栏从窗口顶部开始（不再有跨全宽的 TitleBar），
//!   头部顶部留出 traffic lights 避让区（系统红绿灯悬于其上）
//! - **选中态**：中性色圆角胶囊（浅色=白胶囊+柔和投影 / 深色=高亮灰胶囊），
//!   hover 轻微灰底反馈；macOS 侧栏选中不用品牌蓝（那是 iOS 风格），靠明度区分
//! - **分组标题（section header）**：小字号/灰色/上留白，纯文字无图标（原生语义）
//! - **间距体系**：行高 32px、圆角 6px、图标 16px 定宽对齐、8px 内边距与图标间距、
//!   文字超长省略号截断
//! - **折叠/展开（P4-1）**：切换按钮在**侧栏头部右上角**（Mail/Notes 风格）；
//!   折叠后为 56px 图标轨道（icon rail），折叠按钮迁往右侧内容区头部（root.rs），
//!   悬停显示原生 tooltip（gpui 内建 tooltip 系统），分组以间距分隔
//! - **键盘导航保持**：↑/↓ 移动选中并激活，Enter 确认（GUI-3 实现，折叠不影响）
//! - **窗口拖拽（P4-1 修复）**：移除跨全宽 TitleBar 后，侧栏头部承担窗口拖拽职责——
//!   复刻 gpui-component TitleBar 交互链（`WindowControlArea::Drag` + 按下武装/移动
//!   `start_window_move()` + 双击 `titlebar_double_click()`），traffic lights 旁即拖拽区

use gpui::{
    AnimationExt, App, BoxShadow, Context, EventEmitter, FocusHandle, Focusable, KeyDownEvent,
    MouseButton, MouseMoveEvent, SharedString, Stateful, Window, WindowControlArea, div,
    prelude::*, px, svg,
};
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::{ActiveTheme, Icon, IconName, InteractiveElementExt, Sizable};

use gui_domain::sidebar::{SidebarGroup, SidebarItem, sidebar_groups};

use crate::icon::icon_path;
use crate::motion::{hover_transition, lerp_hsla, reduce_motion};
use crate::theme::AppTheme;

/// 展开态侧栏宽度（px）
const SIDEBAR_WIDTH: f32 = 240.0;
/// 折叠态侧栏宽度（px，图标轨道）
const SIDEBAR_WIDTH_COLLAPSED: f32 = 56.0;
/// P4-1：侧栏头部顶部 traffic lights 避让高度（px）——系统红绿灯位于 (9,9)、
/// 直径约 12px（y 9–21），主窗口不再有跨全宽 TitleBar，红绿灯直接悬于侧栏头部之上
const TRAFFIC_LIGHTS_CLEARANCE: f32 = 34.0;
/// 侧栏头部品牌行高度（px，logo + APP 名称 + 折叠按钮）
const SIDEBAR_HEADER_ROW: f32 = 52.0;

/// 侧栏发出的导航事件
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidebarEvent {
    /// 选中某个子项
    Select { url: String, title: String },
    /// P4-1：折叠状态变化（RootView 据此在内容区头部渲染/收起展开按钮）
    Collapsed { collapsed: bool },
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
    /// P4-2：折叠动画起点宽度（px）——上次 toggle 时的展示宽度，渲染层
    /// `with_animation` 从它插值到目标宽度；减弱动态时直接瞬时切换。
    width_anim_from: f32,
    /// P4-1 修复：窗口拖拽武装标志——鼠标在侧栏头部按下后置真，移动时触发
    /// `start_window_move()`；未移动直接松开 = 普通点击（头部内按钮仍可交互）
    should_move: bool,
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
            width_anim_from: SIDEBAR_WIDTH,
            should_move: false,
        }
    }

    /// P4-1 修复：武装窗口拖拽（侧栏头部鼠标按下）
    fn arm_drag(&mut self) {
        self.should_move = true;
    }

    /// P4-1 修复：解除拖拽武装（松开 / 在头部外按下）
    fn disarm_drag(&mut self) {
        self.should_move = false;
    }

    /// P4-1 修复：消费拖拽武装——返回 true 表示应启动窗口拖拽并解除武装。
    /// 拆成无 `Window` 依赖的方法以便单测锁状态机。
    fn consume_drag_armed(&mut self) -> bool {
        if self.should_move {
            self.should_move = false;
            true
        } else {
            false
        }
    }

    /// P4-1 修复：鼠标移动时若已武装则启动原生窗口拖拽（与 gpui-component TitleBar
    /// 行为一致——按下并拖动 = 拖窗；按下即松 = 点击，头部内按钮不受影响）
    fn maybe_start_window_move(&mut self, window: &mut Window) {
        if self.consume_drag_armed() {
            window.start_window_move();
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

    /// 折叠/展开切换（P4-1；展开态由侧栏头部右上角按钮触发，折叠态由右侧
    /// 内容区头部最左的展开按钮触发——root.rs 通过本方法驱动）。
    /// 切换后 emit [`SidebarEvent::Collapsed`]，RootView 同步内容区头部布局。
    /// P4-2：切换时记录动画起点宽度（当前展示宽度），渲染层据此做宽度过渡；
    /// 减弱动态时仍同步状态（由渲染层决定瞬时/动画）。
    pub(crate) fn toggle_collapsed(&mut self, cx: &mut Context<Self>) {
        self.width_anim_from = self.width();
        self.collapsed = !self.collapsed;
        cx.emit(SidebarEvent::Collapsed {
            collapsed: self.collapsed,
        });
        cx.notify();
    }

    /// 选中某个子项（RootView 订阅后切换内容区；pub(crate) 供 root 测试驱动）
    pub(crate) fn select(&mut self, url: &str, title: &str, cx: &mut Context<Self>) {
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
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let selected_url = self.selected_url.clone();
        let focus_handle = self.focus_handle.clone();
        let collapsed = self.collapsed;
        let reduce = reduce_motion(cx);
        // P4-2：宽度过渡动画起点/目标（toggle 时记录起点，见 [`SidebarView::toggle_collapsed`]）
        let width_from = self.width_anim_from;
        let width_to = self.width();

        let base = div()
            .id("sidebar")
            .flex()
            .flex_col()
            .w(px(width_to))
            .h_full()
            // P4-3 材质：不透明实色 sidebar_bg（macOS 浅 #ECECEC / 深 #282828）——
            // 半透明叠加系统模糊的模拟已收敛（粗糙且禁用亚像素文字渲染）；
            // 右侧发丝分隔线把侧栏与内容区切开（macOS sidebar 风格）
            .bg(theme.sidebar_bg)
            .border_r_1()
            .border_color(theme.sidebar_border)
            .focusable()
            .track_focus(&focus_handle)
            .on_key_down(cx.listener(|this, event, _, cx| this.on_key_down(event, cx)))
            .child(sidebar_header(&theme, collapsed, cx))
            .child(
                div()
                    .id("sidebar-scroll")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .w_full()
                    .overflow_y_scroll()
                    .children(self.groups.iter().map(|group| {
                        render_group(group, selected_url.as_deref(), collapsed, window, cx)
                    })),
            )
            .child(sidebar_footer(&theme, collapsed));

        if reduce {
            // 减弱动态：瞬时切换（无宽度动画）
            return base.into_any_element();
        }

        // P4-2：宽度过渡动画。动画 id 编码折叠态——折叠翻转 → 元素状态重建 → 动画
        // 0→1 重放 → 宽度从起点插值到目标（ease-out，200ms）。
        base.with_animation(
            SharedString::from(format!("sidebar-width-{collapsed}")),
            crate::motion::animation(
                crate::motion::DURATION_SIDEBAR,
                crate::motion::ease_out_cubic,
            ),
            move |el, delta| {
                el.w(px(width_from
                    + (width_to - width_from)
                        * crate::motion::ease_out_cubic(delta)))
            },
        )
        .into_any_element()
    }
}

/// 侧栏头部（P4-1）：顶部留出 traffic lights 避让区（系统红绿灯悬于其上），
/// 品牌行 = logo + APP 名称 + 右上角折叠按钮（Mail/Notes 风格）。
/// 折叠态只显示品牌方块（居中）——折叠按钮迁往右侧内容区头部（root.rs）。
fn sidebar_header(
    theme: &AppTheme,
    collapsed: bool,
    cx: &mut Context<SidebarView>,
) -> impl IntoElement {
    if collapsed {
        return div()
            .id("sidebar-header")
            .flex()
            .flex_col()
            .items_center()
            .w_full()
            .child(div().h(px(TRAFFIC_LIGHTS_CLEARANCE)))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .w_full()
                    .h(px(SIDEBAR_HEADER_ROW))
                    .child(brand_mark(theme)),
            )
            .map(|el| attach_window_drag(el, cx));
    }

    div()
        .id("sidebar-header")
        .flex()
        .flex_col()
        .w_full()
        .child(div().h(px(TRAFFIC_LIGHTS_CLEARANCE)))
        .child(
            div()
                .flex()
                .items_center()
                .w_full()
                .h(px(SIDEBAR_HEADER_ROW))
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
                .child(div().flex_1())
                .child(collapse_toggle_button(false, cx)),
        )
        .map(|el| attach_window_drag(el, cx))
}

/// P4-1 修复：给头部容器挂窗口拖拽交互——复刻 gpui-component `TitleBar` 的交互链：
/// `WindowControlArea::Drag` 注册原生拖拽区（与 traffic lights 共存）；按下武装 →
/// 移动时 `start_window_move()` 启动原生窗口拖拽；未移动直接松开 = 普通点击（头部内
/// 折叠按钮仍可交互）；macOS 双击 = `titlebar_double_click()`（缩放/最小化跟随系统偏好）。
fn attach_window_drag(
    el: gpui::Stateful<gpui::Div>,
    cx: &mut Context<SidebarView>,
) -> gpui::Stateful<gpui::Div> {
    el.window_control_area(WindowControlArea::Drag)
        .when(cfg!(target_os = "macos"), |this| {
            this.on_double_click(|_, window, _| window.titlebar_double_click())
        })
        .on_mouse_down_out(cx.listener(|this, _, _, _| this.disarm_drag()))
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|this, _, _, _| this.arm_drag()),
        )
        .on_mouse_up(
            MouseButton::Left,
            cx.listener(|this, _, _, _| this.disarm_drag()),
        )
        .on_mouse_move(
            cx.listener(|this, _: &MouseMoveEvent, window, _| this.maybe_start_window_move(window)),
        )
}

/// 品牌标识（展开态左侧 / 折叠态居中）：中性圆角方块 + Dashboard 图标——P4-3（BLF-709）
/// 去掉品牌蓝方块+圆点的自定义质感，收敛为 macOS 原生应用图标位观感
/// （方块底 = 中性浅填充，图标 = 侧栏文字色，不引入品牌色）。
fn brand_mark(theme: &AppTheme) -> impl IntoElement {
    div()
        .size(px(22.0))
        .rounded(px(6.0))
        .flex()
        .items_center()
        .justify_center()
        .bg(theme.muted_fill)
        .child(
            svg()
                .path("icons/layout-dashboard.svg")
                .size(px(13.0))
                .text_color(theme.sidebar_text),
        )
}

/// 侧栏底部（P4-1）：功能入口计数。折叠态不渲染——折叠后仅剩 56px 图标轨道，
/// 切换按钮已上移至侧栏头部（展开态）/ 右侧内容区头部（折叠态）。
fn sidebar_footer(theme: &AppTheme, collapsed: bool) -> impl IntoElement {
    if collapsed {
        return div().id("sidebar-footer-empty");
    }

    div()
        .id("sidebar-footer")
        .flex()
        .items_center()
        .w_full()
        .h_9()
        .px_3()
        .child(
            div()
                .text_xs()
                .text_color(theme.sidebar_footer_text)
                .child(SharedString::from("52 个功能入口")),
        )
}

/// 折叠/展开切换按钮（ghost 图标按钮 + tooltip；P4-1 起仅用于侧栏头部展开态
/// 与内容区头部的展开按钮，底部不再渲染）
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
    window: &mut Window,
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
        .children(group.items.iter().map(|item| {
            render_item(
                item,
                selected_url == Some(item.url.as_str()),
                collapsed,
                window,
                cx,
            )
        }))
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
///
/// P4-2：hover 背景/图标颜色过渡（`hover_transition`，100ms 插值）；减弱动态时瞬时。
fn render_item(
    item: &SidebarItem,
    active: bool,
    collapsed: bool,
    window: &mut Window,
    cx: &mut Context<SidebarView>,
) -> impl IntoElement {
    let theme = AppTheme::current(cx);
    let url = item.url.clone();
    let title = item.title.clone();
    let item_id = SharedString::from(format!("sidebar-item-{}", item.url));
    let icon_path = icon_path(&item.icon);
    let icon_normal = if active {
        theme.sidebar_item_active_text
    } else {
        // 未激活图标弱化（macOS 侧栏图标常态 60% 灰度）
        theme.sidebar_group_text
    };
    // P4-2：hover 时图标提亮到侧栏文字色（未激活项），激活项保持激活色
    let icon_hover = if active {
        theme.sidebar_item_active_text
    } else {
        theme.sidebar_text
    };
    // 点击 / tooltip / 文字各持一份（闭包 move 捕获）
    let url_for_click = url.clone();
    let title_for_click = title.clone();

    let text_normal = if active {
        theme.sidebar_item_active_text
    } else {
        theme.sidebar_text
    };
    // P4-2：hover 时文字提亮到激活态文字色（macOS 侧栏 hover 文字略亮）
    let text_hover = theme.sidebar_item_active_text;
    let bg_normal = if active {
        theme.sidebar_item_active_bg
    } else {
        gpui::transparent_black()
    };
    let bg_hover = if active {
        theme.sidebar_item_active_bg
    } else {
        theme.sidebar_item_hover
    };

    let base = div()
        .id(item_id.clone())
        .flex()
        .items_center()
        .w_full()
        .h_8()
        .gap_2()
        .px_2()
        .mx_1()
        .rounded(px(theme.radius))
        .cursor_pointer()
        .text_sm()
        .font_weight(if active {
            gpui::FontWeight::MEDIUM
        } else {
            gpui::FontWeight::NORMAL
        })
        .shadow(if active {
            vec![active_item_shadow(&theme)]
        } else {
            vec![]
        })
        .on_click(cx.listener(move |this, _, _, cx| {
            this.select(&url_for_click, &title_for_click, cx);
        }));

    if collapsed {
        // 图标轨道：图标居中；悬停出原生 tooltip 补足标题可发现性。
        // 图标颜色跟随 hover 过渡（icon_normal → icon_hover）。
        let tooltip_title = title.clone();
        return hover_transition(
            item_id,
            base.justify_center().tooltip(move |_window, cx| {
                cx.new(|_| SidebarTooltip::new(tooltip_title.clone()))
                    .into()
            }),
            window,
            cx,
            move |el: Stateful<gpui::Div>, t| {
                use gpui::Styled;
                el.bg(lerp_hsla(bg_normal, bg_hover, t)).child(
                    svg().path(icon_path).size_4().text_color(lerp_hsla(
                        icon_normal,
                        icon_hover,
                        t,
                    )),
                )
            },
        )
        .into_any_element();
    }

    hover_transition(
        item_id,
        base,
        window,
        cx,
        move |el: Stateful<gpui::Div>, t| {
            use gpui::Styled;
            el.bg(lerp_hsla(bg_normal, bg_hover, t))
                .text_color(lerp_hsla(text_normal, text_hover, t))
                .child(svg().path(icon_path).size_4().text_color(lerp_hsla(
                    icon_normal,
                    icon_hover,
                    t,
                )))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .child(SharedString::from(title.clone())),
                )
        },
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
    use std::cell::RefCell;
    use std::rc::Rc;

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

    /// P4-2：折叠动画起点宽度契约——toggle 时 `width_anim_from` 记录**切换前**的展示宽度
    /// （渲染层 `with_animation` 据此从旧宽度插值到新宽度，而不是跳变）。
    #[gpui::test]
    async fn toggle_collapsed_records_animation_start_width(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_window, cx| SidebarView::new(None, cx));
        cx.read(|app| {
            let sidebar = view.read(app);
            assert_eq!(sidebar.width_anim_from, SIDEBAR_WIDTH, "初始起点 = 展开宽");
        });

        // 展开 → 折叠：起点 = 240（展开宽），目标 = 56
        view.update(cx, |this, cx| this.toggle_collapsed(cx));
        cx.read(|app| {
            let sidebar = view.read(app);
            assert!(sidebar.collapsed);
            assert_eq!(sidebar.width_anim_from, SIDEBAR_WIDTH);
            assert_eq!(sidebar.width(), SIDEBAR_WIDTH_COLLAPSED);
        });

        // 折叠 → 展开：起点 = 56（折叠宽），目标 = 240
        view.update(cx, |this, cx| this.toggle_collapsed(cx));
        cx.read(|app| {
            let sidebar = view.read(app);
            assert!(!sidebar.collapsed);
            assert_eq!(sidebar.width_anim_from, SIDEBAR_WIDTH_COLLAPSED);
            assert_eq!(sidebar.width(), SIDEBAR_WIDTH);
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

    /// P4-2：减弱动态效果分支渲染冒烟——MotionPref(true) 时侧栏（无宽度动画 + 无
    /// hover 过渡）展开/折叠两态均可完整渲染不 panic。
    #[gpui::test]
    async fn sidebar_renders_with_reduce_motion(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            cx.set_global(crate::motion::MotionPref(true));
        });
        let (view, cx) = cx.add_window_view(|_window, cx| {
            SidebarView::new(Some("/dashboard/operations/site-navigation"), cx)
        });
        view.update(cx, |this, cx| this.toggle_collapsed(cx));
    }

    /// P4-1：折叠切换 emit [`SidebarEvent::Collapsed`]——RootView 据此同步
    /// 内容区头部的展开按钮（折叠按钮从侧栏头迁移到右侧内容区头部）。
    #[gpui::test]
    async fn toggle_collapsed_emits_collapsed_event(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let events = Rc::new(RefCell::new(Vec::new()));
        let (view, cx) = cx.add_window_view(|_window, cx| {
            let events = events.clone();
            // 订阅正在创建的自身实体句柄（cx.entity()）
            let sidebar = cx.entity();
            cx.subscribe(&sidebar, move |_, _, event: &SidebarEvent, _| {
                events.borrow_mut().push(event.clone());
            })
            .detach();
            SidebarView::new(None, cx)
        });
        view.update(cx, |this, cx| this.toggle_collapsed(cx));
        view.update(cx, |this, cx| this.toggle_collapsed(cx));
        assert_eq!(
            *events.borrow(),
            vec![
                SidebarEvent::Collapsed { collapsed: true },
                SidebarEvent::Collapsed { collapsed: false },
            ]
        );
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

    /// P4-1 修复（review 阻塞项）：窗口拖拽武装状态机——按下武装、移动消费并
    /// 解除、松开/外出解除；未武装时移动不触发。锁「按下即松 = 点击不拖窗」契约。
    #[gpui::test]
    async fn window_drag_arm_consume_disarm(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_window, cx| SidebarView::new(None, cx));
        view.update(cx, |this, _| {
            // 初始未武装
            assert!(!this.should_move);
            assert!(!this.consume_drag_armed(), "未武装时移动不触发拖拽");

            // 按下武装 → 移动消费（触发拖拽）并解除
            this.arm_drag();
            assert!(this.should_move);
            assert!(this.consume_drag_armed(), "武装后移动应触发拖拽");
            assert!(!this.should_move, "消费后武装解除");
            assert!(!this.consume_drag_armed(), "重复消费不再触发");

            // 按下后未移动直接松开（disarm）＝ 点击不拖窗
            this.arm_drag();
            this.disarm_drag();
            assert!(!this.should_move);
            assert!(!this.consume_drag_armed());
        });
    }
}
