//! Sub-Nav 子导航列（BLF-794，父 issue「空间栅格」第 2 区）
//!
//! 可折叠的模块选择器：渲染当前 Master Rail 分类下的全部子模块
//! （数据源唯一 = [`gui_domain::sidebar::sidebar_groups`]，禁止前端侧复制第二份清单）。
//!
//! 规格（父 issue「空间栅格」节）：
//! - 宽度 180~220px 随内容自适应（[`fit_width`]），整列可折叠至 0；
//! - 活动项 4px accent 左指示条 + hover Hover 层底（暗色 `#272730`）；
//! - 折叠状态持久化（[`crate::prefs::UiPrefs::sub_nav_collapsed`]）；
//! - ⌘K/Ctrl+K 搜索入口在头部按钮 + 全局快捷键（命令面板见
//!   [`crate::views::command_palette`]）。
//!
//! 导航联动：点击子项 → emit [`SubNavEvent::Select`]，RootView 复用既有视图分发链
//! （懒创建 + show_* 标志 + 面包屑跟随）；选中态与 Rail 高亮由 RootView 中枢回写
//! （[`SubNavView::set_active`]）。折叠切换 emit [`SubNavEvent::Collapsed`]，
//! RootView 同步内容区头部的展开按钮并持久化。
//!
//! 动态徽标：[`SubNavView::set_badge`] 是外部数据注入点（如 CRM 待跟进逾期数红点，
//! 对齐 frontend `CrmFollowUpBadge`）；当前无实时数据源，默认全部无徽标。

use std::collections::HashMap;

use gpui::{
    div, prelude::*, px, svg, AnimationExt, App, Context, EventEmitter, FocusHandle, Focusable,
    KeyDownEvent, SharedString, Window,
};
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::{ActiveTheme, Icon, IconName, Sizable};

use gui_domain::sidebar::{sidebar_groups, SidebarGroup, SidebarItem};

use crate::icon::icon_path;
use crate::motion::{animation, ease_out_cubic, reduce_motion, DURATION_SIDEBAR};
use crate::theme::{AppTheme, FONT_2XS, FONT_BASE, FONT_MONO_FAMILY, FONT_XS};
use crate::views::shell::SUB_NAV_WIDTH;

/// 子导航列发出的导航事件
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubNavEvent {
    /// 选中某个子模块（RootView 订阅后切换内容区视图）
    Select { url: String, title: String },
    /// 折叠状态变化（RootView 据此同步内容区头部展开按钮 + 持久化）
    Collapsed { collapsed: bool },
}

/// 列宽下限（规格 180px）
pub(crate) const SUB_NAV_WIDTH_MIN: f32 = 180.0;
/// 列宽上限（规格 220px）
pub(crate) const SUB_NAV_WIDTH_MAX: f32 = 220.0;

/// 由最长标题（全角位数）估算展开列宽（180~220px 随内容自适应）：
/// 左右留白 24px + 图标槽 26px + 文字宽（13px 字号 × 全角位数）+ 徽标余量 20px。
pub(crate) fn fit_width(longest_title_units: f32) -> f32 {
    const CHAR_PX: f32 = 13.0;
    let natural = 24.0 + 26.0 + longest_title_units * CHAR_PX + 20.0;
    natural.clamp(SUB_NAV_WIDTH_MIN, SUB_NAV_WIDTH_MAX)
}

/// 标题显示宽度估算：CJK 等非 ASCII 字符按 1 个全角位、ASCII 按 0.55 半角位计。
fn display_width(title: &str) -> f32 {
    title
        .chars()
        .map(|c| if c.is_ascii() { 0.55 } else { 1.0 })
        .sum()
}

/// Sub-Nav 子导航列视图
pub struct SubNavView {
    groups: Vec<SidebarGroup>,
    /// 当前激活一级分类 id（None = Dashboard 着陆页，列表为空）
    active_group: Option<String>,
    selected_url: Option<String>,
    /// 是否折叠至 0 宽
    collapsed: bool,
    /// 折叠动画起点宽度（toggle 时记录当前展示宽度；渲染层插值到目标）
    width_anim_from: f32,
    /// 动态徽标计数表（url → 数量；外部数据注入点，默认空）
    badges: HashMap<String, u32>,
    /// 键盘焦点游标（指向可见子项展平索引）
    cursor: usize,
    focus_handle: FocusHandle,
}

impl SubNavView {
    pub fn new(initial_collapsed: bool, cx: &mut Context<Self>) -> Self {
        Self {
            groups: sidebar_groups(),
            active_group: None,
            selected_url: None,
            collapsed: initial_collapsed,
            // 起点与初始态一致：持久化恢复的折叠态启动时不回放折叠动画
            width_anim_from: if initial_collapsed {
                0.0
            } else {
                SUB_NAV_WIDTH
            },
            badges: HashMap::new(),
            cursor: 0,
            focus_handle: cx.focus_handle(),
        }
    }

    /// 当前可见子项（激活分类的全部子模块；着陆页/未知分类为空切片）
    pub(crate) fn visible_items(&self) -> &[SidebarItem] {
        self.active_group
            .as_deref()
            .and_then(|id| self.groups.iter().find(|g| g.id == id))
            .map(|g| g.items.as_slice())
            .unwrap_or(&[])
    }

    /// 当前分类展示名（着陆页为 None）
    pub(crate) fn active_label(&self) -> Option<&str> {
        self.active_group
            .as_deref()
            .and_then(|id| self.groups.iter().find(|g| g.id == id))
            .map(|g| g.label.as_str())
    }

    /// 反向同步：Rail 分类变化时更新本列内容。分类切换后游标跟随已选中的
    /// 子项（无选中则归零），保证 ↑↓ 从高亮项继续遍历。
    pub(crate) fn set_active(&mut self, group_id: Option<String>, cx: &mut Context<Self>) {
        if self.active_group == group_id {
            return;
        }
        self.active_group = group_id;
        self.cursor = self
            .selected_url
            .as_deref()
            .and_then(|url| self.visible_items().iter().position(|it| it.url == url))
            .unwrap_or(0);
        cx.notify();
    }

    /// 选中某个子项并 emit（点击 / 键盘确认 / ⌘K 命中跳转共用入口）。
    /// RootView 订阅后走统一视图分发链。
    pub(crate) fn select(&mut self, url: &str, title: &str, cx: &mut Context<Self>) {
        if self.selected_url.as_deref() == Some(url) {
            return;
        }
        self.selected_url = Some(url.to_string());
        if let Some(i) = self.visible_items().iter().position(|it| it.url == url) {
            self.cursor = i;
        }
        cx.emit(SubNavEvent::Select {
            url: url.to_string(),
            title: title.to_string(),
        });
        cx.notify();
    }

    /// 折叠/展开切换（列宽 ↔ 0）。emit [`SubNavEvent::Collapsed`]，
    /// RootView 负责同步内容区头部布局（持久化在组合根 main.rs）。
    pub(crate) fn toggle_collapsed(&mut self, cx: &mut Context<Self>) {
        self.width_anim_from = self.width();
        self.collapsed = !self.collapsed;
        cx.emit(SubNavEvent::Collapsed {
            collapsed: self.collapsed,
        });
        cx.notify();
    }

    /// 直接恢复折叠态（启动时从 UI 偏好还原；不发事件、动画起点与初始态
    /// 一致，避免启动回放折叠动画）。仅组合根经 RootView 调用。
    pub(crate) fn restore_collapsed(&mut self, collapsed: bool, cx: &mut Context<Self>) {
        if self.collapsed == collapsed {
            return;
        }
        self.width_anim_from = self.width();
        self.collapsed = collapsed;
        cx.notify();
    }

    /// 注入动态徽标计数（count=0 清除；如 CRM 待跟进逾期数红点）。
    ///
    /// 外部数据注入点：实时数据源（CRM 待跟进逾期数等）在后续迁移阶段接入，
    /// 当前无调用方（仅测试驱动渲染路径）。
    #[allow(dead_code)]
    pub(crate) fn set_badge(&mut self, url: &str, count: u32, cx: &mut Context<Self>) {
        if count == 0 {
            self.badges.remove(url);
        } else {
            self.badges.insert(url.to_string(), count);
        }
        cx.notify();
    }

    fn badge_count(&self, url: &str) -> u32 {
        self.badges.get(url).copied().unwrap_or(0)
    }

    /// 当前列宽：折叠 0 / 展开 [`fit_width`]（按激活分类最长标题自适应）
    pub(crate) fn width(&self) -> f32 {
        if self.collapsed {
            return 0.0;
        }
        let longest = self
            .visible_items()
            .iter()
            .map(|it| display_width(&it.title))
            .fold(0.0f32, f32::max);
        fit_width(longest)
    }

    /// ↑/↓ 移动键盘游标并立即激活对应子项（对齐遗留侧栏语义）。
    pub(crate) fn move_cursor(&mut self, delta: isize, cx: &mut Context<Self>) {
        let len = self.visible_items().len();
        if len == 0 {
            return;
        }
        let next = (self.cursor as isize + delta).clamp(0, len as isize - 1) as usize;
        if next != self.cursor {
            self.cursor = next;
            let item = &self.visible_items()[next];
            let url = item.url.clone();
            let title = item.title.clone();
            self.select(&url, &title, cx);
        }
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        match event.keystroke.key.as_str() {
            "down" => self.move_cursor(1, cx),
            "up" => self.move_cursor(-1, cx),
            "enter" => {
                if let Some(item) = self.visible_items().get(self.cursor) {
                    let url = item.url.clone();
                    let title = item.title.clone();
                    self.select(&url, &title, cx);
                }
            }
            _ => {}
        }
    }
}

impl EventEmitter<SubNavEvent> for SubNavView {}

impl Focusable for SubNavView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for SubNavView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let collapsed = self.collapsed;
        let reduce = reduce_motion(cx);
        // P4-2 同款宽度过渡：toggle 时记录起点，渲染层从起点插值到目标
        // （折叠/展开双向动画；减弱动态时瞬时切换）
        let width_from = self.width_anim_from;
        let width_to = self.width();
        let animate_width = !reduce && (width_from - width_to).abs() > f32::EPSILON;

        // 折叠态也保留内容树（宽度收 0 + overflow_hidden 裁剪）——折叠动画期间
        // 有内容可裁剪；稳态下 0 宽列不可见、焦点链已摘除（见下方 when 门控）
        let base = div()
            .id("sub-nav")
            .flex()
            .flex_col()
            .w(px(width_to))
            .h_full()
            .overflow_hidden()
            .bg(theme.sidebar_bg)
            .when(!collapsed, |col| {
                col.border_r_1().border_color(theme.sidebar_border)
            })
            .child(
                div()
                    .id("sub-nav-header")
                    .flex()
                    .items_center()
                    .gap_2()
                    .w_full()
                    .h(px(36.0))
                    .pl_3()
                    .pr_2()
                    .flex_none()
                    .child(
                        div().text_size(px(crate::theme::fs(FONT_XS)))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .text_color(theme.text_primary)
                            .truncate()
                            .child(SharedString::from(active_label_text(self))),
                    )
                    .when(item_count_of(self) > 0, |header| {
                        header.child(
                            div().text_size(px(crate::theme::fs(FONT_XS)))
                                .font_family(FONT_MONO_FAMILY)
                                .text_color(theme.text_muted)
                                .child(SharedString::from(item_count_of(self).to_string())),
                        )
                    })
                    .child(div().flex_1())
                    .child(collapse_button(cx)),
            )
            .child(
                div()
                    .id("sub-nav-list")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .overflow_y_scroll()
                    .py_1()
                    .children(
                        self.visible_items()
                            .iter()
                            .map(|item| self.render_item(item, cx)),
                    ),
            )
            .when(item_count_of(self) == 0, |col| {
                col.child(
                    div()
                        .id("sub-nav-empty")
                        .px_3()
                        .pt_2().text_size(px(crate::theme::fs(FONT_XS)))
                        .text_color(theme.text_muted)
                        .child("点左侧图标选择分类"),
                )
            })
            .when(!collapsed, |col| {
                col.focusable()
                    .track_focus(&self.focus_handle.clone())
                    .on_key_down(cx.listener(Self::on_key_down))
            });

        if !animate_width {
            return base.into_any_element();
        }

        // 折叠↔展开宽度过渡动画（动画 id 编码折叠态——翻转即重放 0→1 插值）
        base.with_animation(
            SharedString::from(format!("sub-nav-width-{collapsed}")),
            animation(DURATION_SIDEBAR, ease_out_cubic),
            move |el, delta| {
                el.w(px(
                    width_from + (width_to - width_from) * ease_out_cubic(delta)
                ))
            },
        )
        .into_any_element()
    }
}

fn active_label_text(view: &SubNavView) -> String {
    view.active_label().unwrap_or("模块").to_string()
}

fn item_count_of(view: &SubNavView) -> usize {
    view.visible_items().len()
}

impl SubNavView {
    /// 单个子模块行：图标 + 标题 + 动态徽标；活动项 = 4px accent 左指示条 +
    /// Hover 层底（暗色 `#272730`），非活动项 hover 同底色反馈。
    fn render_item(&self, item: &SidebarItem, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = AppTheme::current(cx);
        let active = self.selected_url.as_deref() == Some(item.url.as_str());
        let badge = self.badge_count(&item.url);
        let url = item.url.clone();
        let title = item.title.clone();

        div()
            .id(SharedString::from(format!("sub-nav-item-{}", item.url)))
            .relative()
            .flex()
            .items_center()
            .gap_2()
            .w_full()
            .h(px(28.0))
            .px_3()
            .cursor_pointer()
            .when(active, |row| row.bg(theme.sidebar_item_active_bg))
            .hover(|style| style.bg(theme.sidebar_item_hover))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.select(&url, &title, cx);
            }))
            // 4px accent 左指示条（仅活动项）
            .when(active, |row| {
                row.child(
                    div()
                        .absolute()
                        .left_0()
                        .top(px(3.0))
                        .bottom(px(3.0))
                        .w(px(4.0))
                        .rounded(px(2.0))
                        .bg(theme.accent),
                )
            })
            .child(
                svg()
                    .path(icon_path(&item.icon))
                    .size(px(15.0))
                    .text_color(if active {
                        theme.accent
                    } else {
                        theme.text_secondary
                    }),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate().text_size(px(crate::theme::fs(FONT_BASE)))
                    .font_weight(if active {
                        gpui::FontWeight::MEDIUM
                    } else {
                        gpui::FontWeight::NORMAL
                    })
                    .text_color(if active {
                        theme.text_primary
                    } else {
                        theme.text_secondary
                    })
                    .child(SharedString::from(item.title.clone())),
            )
            .when(badge > 0, |row| row.child(badge_pill(badge, &theme)))
            .into_any_element()
    }
}

/// 动态徽标胶囊（危险红底 + 白色等宽数字；数量 > 99 显示 99+）
fn badge_pill(count: u32, theme: &AppTheme) -> impl IntoElement {
    let label = if count > 99 {
        "99+".to_string()
    } else {
        count.to_string()
    };
    div()
        .flex()
        .items_center()
        .justify_center()
        .min_w(px(16.0))
        .h(px(14.0))
        .px_1()
        .rounded(px(7.0))
        .bg(theme.danger).text_size(px(crate::theme::fs(FONT_2XS)))
        .font_family(FONT_MONO_FAMILY)
        .text_color(theme.on_accent)
        .child(SharedString::from(label))
}

/// 头部折叠按钮（ghost 图标钮；⌘\ / Ctrl+\ 全局快捷键见 main.rs 绑定）
fn collapse_button(cx: &mut Context<SubNavView>) -> impl IntoElement {
    Button::new("sub-nav-collapse")
        .ghost()
        .small()
        .icon(Icon::new(IconName::PanelLeftClose).with_size(px(14.0)))
        // BLF-828：快捷键文案平台化（macOS ⌘\ / Windows Ctrl+\）
        .tooltip(format!("折叠侧栏（{}）", crate::platform::combo("\\")))
        .on_click(cx.listener(|this, _, _, cx| this.toggle_collapsed(cx)))
}

// ---------------------------------------------------------------------------
// 原生 tooltip 视图（Master Rail 图标提示复用；自遗留 sidebar.rs 迁入 BLF-794）
// ---------------------------------------------------------------------------

/// 原生 tooltip 视图（跟随主题 popover 语义色）
pub(crate) struct SidebarTooltip {
    title: SharedString,
}

impl SidebarTooltip {
    pub(crate) fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
        }
    }
}

impl Render for SidebarTooltip {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let radius = AppTheme::current(cx).radius;
        div()
            .px_2()
            .py_1()
            .rounded(px(radius))
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

    /// 数据源唯一性契约：本列直接遍历 gui-domain 权威清单——8 组 52 项，
    /// 不允许前端侧复制第二份列表。
    #[test]
    fn data_source_is_gui_domain_sidebar() {
        let groups = sidebar_groups();
        assert_eq!(groups.len(), 8);
        let total: usize = groups.iter().map(|g| g.items.len()).sum();
        assert_eq!(total, 52);
    }

    /// 显示宽度估算：ASCII 半角、CJK 全角。
    #[test]
    fn display_width_counts_cjk_full() {
        assert!((display_width("AI Chat") - 7.0 * 0.55).abs() < 1e-6);
        assert_eq!(display_width("广告"), 2.0);
        assert_eq!(display_width(""), 0.0);
    }

    /// 列宽契约：展开态必须落在规格区间 180~220px；`fit_width` 输出被夹紧。
    #[test]
    fn width_contract_stays_in_spec_range() {
        assert_eq!(fit_width(0.0), SUB_NAV_WIDTH_MIN, "极短标题夹到下限");
        assert_eq!(fit_width(100.0), SUB_NAV_WIDTH_MAX, "极长标题夹到上限");
        // 混排长标题（Markdown/HTML 渲染）落在区间中段
        let mid = fit_width(display_width("Markdown/HTML 渲染"));
        assert!(
            mid > SUB_NAV_WIDTH_MIN && mid < SUB_NAV_WIDTH_MAX,
            "混排长标题列宽 {mid} 应在区间中段"
        );
    }

    /// 折叠契约：toggle 后宽度 0、emit Collapsed、动画起点记录切换前宽度。
    #[gpui::test]
    async fn toggle_collapses_to_zero_and_emits(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let events = Rc::new(RefCell::new(Vec::new()));
        let (view, cx) = cx.add_window_view(|_window, cx| {
            let events = events.clone();
            let handle = cx.entity();
            cx.subscribe(&handle, move |_, _, event: &SubNavEvent, _| {
                events.borrow_mut().push(event.clone());
            })
            .detach();
            let mut v = SubNavView::new(false, cx);
            v.set_active(Some("operations".into()), cx);
            v
        });

        let expanded_width = cx.read(|app| view.read(app).width());
        assert!((SUB_NAV_WIDTH_MIN..=SUB_NAV_WIDTH_MAX).contains(&expanded_width));

        view.update(cx, |v, cx| v.toggle_collapsed(cx));
        cx.read(|app| {
            let v = view.read(app);
            assert!(v.collapsed);
            assert_eq!(v.width(), 0.0, "折叠后整列宽度应为 0");
            assert_eq!(v.width_anim_from, expanded_width, "动画起点应为切换前宽度");
        });
        assert_eq!(
            *events.borrow(),
            vec![SubNavEvent::Collapsed { collapsed: true }]
        );

        view.update(cx, |v, cx| v.toggle_collapsed(cx));
        cx.read(|app| {
            let v = view.read(app);
            assert!(!v.collapsed);
            assert_eq!(v.width_anim_from, 0.0, "再展开时起点应为折叠宽 0");
        });
    }

    /// set_active 切换分类：可见子项跟随该组（operations=15 / advertising=2），
    /// 且子项数据（含 match_prefixes）原样来自权威清单。
    #[gpui::test]
    async fn set_active_swaps_visible_items(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_window, cx| SubNavView::new(false, cx));

        view.update(cx, |v, cx| v.set_active(Some("advertising".into()), cx));
        cx.read(|app| {
            let v = view.read(app);
            assert_eq!(v.active_label(), Some("广告"));
            assert_eq!(v.visible_items().len(), 2);
            assert_eq!(v.visible_items()[0].title, "广告分析");
            assert_eq!(
                v.visible_items()[0].match_prefixes,
                vec!["/dashboard/advertising/ad-analysis"]
            );
            assert_eq!(v.visible_items()[0].icon, "BarChart3");
        });

        view.update(cx, |v, cx| v.set_active(Some("operations".into()), cx));
        cx.read(|app| {
            let v = view.read(app);
            assert_eq!(v.active_label(), Some("运营"));
            assert_eq!(v.visible_items().len(), 15);
        });
    }

    /// select emit Select 事件（url/title 原样透传给 RootView 分发链）。
    #[gpui::test]
    async fn select_emits_navigation_event(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let events = Rc::new(RefCell::new(Vec::new()));
        let (view, cx) = cx.add_window_view(|_window, cx| {
            let events = events.clone();
            let handle = cx.entity();
            cx.subscribe(&handle, move |_, _, event: &SubNavEvent, _| {
                events.borrow_mut().push(event.clone());
            })
            .detach();
            let mut v = SubNavView::new(false, cx);
            v.set_active(Some("crm".into()), cx);
            v
        });

        view.update(cx, |v, cx| {
            v.select("/dashboard/crm/follow-ups", "待跟进", cx)
        });
        assert_eq!(
            *events.borrow(),
            vec![SubNavEvent::Select {
                url: "/dashboard/crm/follow-ups".into(),
                title: "待跟进".into(),
            }]
        );
    }

    /// 键盘游标契约：↑↓ 在可见子项范围内移动并激活；末尾不越界、不重复 emit；
    /// 空列表（着陆页）安全无操作。
    #[gpui::test]
    async fn keyboard_cursor_moves_and_activates(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let events = Rc::new(RefCell::new(Vec::new()));
        let (view, cx) = cx.add_window_view(|_window, cx| {
            let events = events.clone();
            let handle = cx.entity();
            cx.subscribe(&handle, move |_, _, event: &SubNavEvent, _| {
                events.borrow_mut().push(event.clone());
            })
            .detach();
            let mut v = SubNavView::new(false, cx);
            v.set_active(Some("finance".into()), cx); // 4 项
            v
        });

        // ↓ 从第 0 项走到第 1 项（平台回款 → 汇率信息）
        view.update(cx, |v, cx| v.move_cursor(1, cx));
        assert_eq!(
            *events.borrow(),
            vec![SubNavEvent::Select {
                url: "/dashboard/finance/exchange-rate".into(),
                title: "汇率信息".into(),
            }]
        );

        // 连按 ↓ 到末尾后再按不越界（停在最后一项，不重复 emit）
        events.borrow_mut().clear();
        view.update(cx, |v, cx| {
            for _ in 0..6 {
                v.move_cursor(1, cx);
            }
        });
        assert_eq!(
            events.borrow().last().cloned(),
            Some(SubNavEvent::Select {
                url: "/dashboard/finance/commission-management".into(),
                title: "佣金管理".into(),
            })
        );

        // 空列表（着陆页）：移动游标是无操作，不 panic、不 emit
        events.borrow_mut().clear();
        view.update(cx, |v, cx| {
            v.set_active(None, cx);
            v.move_cursor(1, cx);
        });
        assert!(events.borrow().is_empty());
    }

    /// 动态徽标注入：set_badge 后计数生效，count=0 清除。
    #[gpui::test]
    async fn badges_can_be_injected_and_cleared(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_window, cx| SubNavView::new(false, cx));
        view.update(cx, |v, cx| {
            assert_eq!(v.badge_count("/dashboard/crm/follow-ups"), 0);
            v.set_badge("/dashboard/crm/follow-ups", 3, cx);
            assert_eq!(v.badge_count("/dashboard/crm/follow-ups"), 3);
            v.set_badge("/dashboard/crm/follow-ups", 0, cx);
            assert_eq!(v.badge_count("/dashboard/crm/follow-ups"), 0);
        });
    }

    /// 渲染冒烟：着陆页空列表 / 展开含选中与徽标 / 折叠三态均不 panic。
    #[gpui::test]
    async fn renders_landing_expanded_and_collapsed(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_window, cx| SubNavView::new(false, cx));

        view.update(cx, |v, cx| {
            v.set_active(Some("operations".into()), cx);
            v.select("/dashboard/operations/daily-analysis", "销售数据", cx);
        });
        view.update(cx, |v, cx| v.toggle_collapsed(cx));
        view.update(cx, |v, cx| {
            v.toggle_collapsed(cx);
            v.set_active(None, cx);
        });
    }

    /// 减弱动态分支渲染冒烟（MotionPref(true)：无宽度动画瞬时切换）。
    #[gpui::test]
    async fn renders_with_reduce_motion(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            cx.set_global(crate::motion::MotionPref(true));
        });
        let (view, cx) = cx.add_window_view(|_window, cx| SubNavView::new(false, cx));
        view.update(cx, |v, cx| {
            v.set_active(Some("reports".into()), cx);
            v.toggle_collapsed(cx);
        });
    }
}
