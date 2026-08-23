//! Master Rail 主图标栏（BLF-793，父 issue「空间栅格」节第 1 条）
//!
//! 六区外壳最左列：48px 全高图标栏，承载 8 个一级分类入口 + 底部用户头像与
//! 系统设置。专业交易终端风格的常驻导航轨道——任何视图下都保持可见，
//! 点击即切换业务域。
//!
//! - **数据权威唯一**：图标清单直接遍历 [`gui_domain::sidebar::sidebar_groups`]
//!   的 8 组定义（id/label/icon），本模块不持有第二份分类清单；
//! - **选中态**：accent 高亮（图标 accent 色 + 左缘 2px 指示条 + accent 浅底），
//!   hover Hover 层 `#272730`；
//! - **底部**：用户头像（首字符圆形徽标）+ 系统设置入口（选中「系统管理」分类）；
//! - **键盘可达**：容器可聚焦并监听按键，8 个图标各自是独立 tab stop——
//!   Tab/Shift+Tab 全局遍历（绑定见 main.rs `TabNext`/`TabPrev`），聚焦容器后
//!   ↑/↓ 在图标与底部入口间移动焦点、Enter 选中当前项；
//! - **事件契约**：选中分类 emit [`MasterRailEvent::CategorySelected`]，
//!   RootView 据此驱动 Sub-Nav 插槽与默认视图路由；反向同步经
//!   [`MasterRailView::set_active`]（Sub-Nav 侧栏子项选中时回写所属分类）。

use gpui::{
    div, prelude::*, px, svg, App, Context, EventEmitter, FocusHandle, Focusable, KeyDownEvent,
    Render, SharedString, Window,
};

use gui_domain::sidebar::{sidebar_groups, SidebarGroup};

use crate::icon::icon_path;
use crate::theme::{AppTheme, FONT_BASE};
use crate::views::shell::RAIL_WIDTH;
use crate::views::sidebar::SidebarTooltip;

/// 图标按钮命中区高度（48px 栏宽、左右各缩进 4px 下约 40×40 触控目标）
const RAIL_BUTTON_HEIGHT: f32 = 40.0;
/// 图标边长
const RAIL_ICON_SIZE: f32 = 20.0;
/// 头像圆徽标直径
const AVATAR_SIZE: f32 = 28.0;
/// macOS traffic lights 避让高度（红绿灯悬于 Rail 顶部之上，同 sidebar.rs 契约）
const TRAFFIC_LIGHTS_CLEARANCE: f32 = 34.0;

/// Master Rail 发出的导航事件
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MasterRailEvent {
    /// 用户选中某个一级分类（点击 / Enter / 系统设置入口）
    CategorySelected { group_id: String },
}

/// 主图标栏视图
pub struct MasterRailView {
    groups: Vec<SidebarGroup>,
    /// 当前选中分类 id（与 gui-domain::sidebar 8 组严格绑定；None = Dashboard 着陆页）
    active_group: Option<String>,
    /// 键盘焦点游标（展平索引：0..8 分类 → 8 头像 → 9 系统设置）
    cursor: usize,
    focus_handle: FocusHandle,
    /// 各图标的独立 tab stop 句柄（分类 8 个 + 底部头像/系统设置 2 个）
    stops: Vec<FocusHandle>,
    /// 登录用户显示名（头像首字符来源；空串时渲染中性占位点）
    user_name: String,
}

impl MasterRailView {
    pub fn new(user_name: &str, cx: &mut Context<Self>) -> Self {
        let groups = sidebar_groups();
        let stop_count = groups.len() + 2;
        Self {
            groups,
            active_group: None,
            cursor: 0,
            focus_handle: cx.focus_handle(),
            stops: (0..stop_count).map(|_| cx.focus_handle()).collect(),
            user_name: user_name.to_string(),
        }
    }

    /// 反向同步：Sub-Nav 侧栏选中子项后，RootView 回写其所属分类
    /// （Rail 选中态与 gui-domain::sidebar 8 组严格绑定的另一半）。
    pub(crate) fn set_active(&mut self, group_id: Option<String>, cx: &mut Context<Self>) {
        if self.active_group == group_id {
            return;
        }
        // 焦点游标跟随激活分类（方向键从高亮项继续遍历）
        if let Some(id) = &group_id {
            if let Some(idx) = self.groups.iter().position(|g| g.id == *id) {
                self.cursor = idx;
            }
        }
        self.active_group = group_id;
        cx.notify();
    }

    /// 选中分类并 emit 事件（点击 / Enter / 系统设置入口共用）
    pub(crate) fn select_category(&mut self, group_id: &str, cx: &mut Context<Self>) {
        let idx = self
            .groups
            .iter()
            .position(|g| g.id == group_id)
            .unwrap_or(0);
        self.cursor = idx;
        self.active_group = Some(group_id.to_string());
        cx.emit(MasterRailEvent::CategorySelected {
            group_id: group_id.to_string(),
        });
        cx.notify();
    }

    /// ↑/↓ 移动焦点游标并聚焦对应 tab stop（遍历 ≠ 激活，Enter 才选中）。
    /// 返回新游标。
    fn move_cursor(&mut self, delta: isize, window: &mut Window) -> usize {
        let next = self.clamp_cursor(delta);
        window.focus(&self.stops[next]);
        next
    }

    /// 游标区间夹紧：[0, 分类数+2)，越界回弹到边界（纯函数便于单测）
    fn clamp_cursor(&mut self, delta: isize) -> usize {
        let max = self.stops.len() as isize - 1;
        (self.cursor as isize + delta).clamp(0, max.max(0)) as usize
    }

    fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event.keystroke.key.as_str() {
            "down" => {
                self.move_cursor(1, window);
            }
            "up" => {
                self.move_cursor(-1, window);
            }
            "enter" => {
                if let Some(group) = self.groups.get(self.cursor) {
                    let id = group.id.clone();
                    self.select_category(&id, cx);
                }
            }
            _ => {}
        }
    }

    /// 单个分类图标按钮（选中态 accent 高亮 + 左缘指示条；hover Hover 层底）
    fn category_button(
        &self,
        index: usize,
        group: &SidebarGroup,
        focused: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let active = self.active_group.as_deref() == Some(group.id.as_str());
        let group_id = group.id.clone();
        let label = group.label.clone();

        div()
            .id(SharedString::from(format!("rail-button-{}", group.id)))
            .flex()
            .items_center()
            .justify_center()
            .w_full()
            .h(px(RAIL_BUTTON_HEIGHT))
            .mx_1()
            .rounded(px(theme.radius))
            .cursor_pointer()
            .relative()
            .track_focus(&self.stops[index])
            .map(|el| {
                if active {
                    el.bg(theme.accent_soft)
                } else {
                    el.bg(gpui::transparent_black())
                }
            })
            .hover(|style| style.bg(theme.muted_fill))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.select_category(&group_id, cx);
            }))
            .tooltip(move |_window, cx| cx.new(|_| SidebarTooltip::new(label.clone())).into())
            .child(
                svg()
                    .path(icon_path(&group.icon))
                    .size(px(RAIL_ICON_SIZE))
                    .text_color(if active {
                        theme.accent
                    } else {
                        theme.text_secondary
                    }),
            )
            .when(active, |el| {
                el.child(
                    div()
                        .absolute()
                        .left_0()
                        .top(px(8.0))
                        .bottom(px(8.0))
                        .w(px(2.0))
                        .rounded_full()
                        .bg(theme.accent),
                )
            })
            .when(focused, |el| el.border_1().border_color(theme.accent))
    }

    /// 底部入口按钮基座（头像位 / 系统设置位共用布局）
    fn bottom_button(
        &self,
        index: usize,
        id: &'static str,
        tooltip: &str,
        focused: bool,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let theme = AppTheme::current(cx);
        let tip = tooltip.to_string();

        div()
            .id(id)
            .flex()
            .items_center()
            .justify_center()
            .w_full()
            .h(px(RAIL_BUTTON_HEIGHT))
            .mx_1()
            .rounded(px(theme.radius))
            .cursor_pointer()
            .track_focus(&self.stops[index])
            .hover(|style| style.bg(theme.muted_fill))
            .tooltip(move |_window, cx| cx.new(|_| SidebarTooltip::new(tip.clone())).into())
            .when(focused, |el| el.border_1().border_color(theme.accent))
    }

    /// 用户头像（首字符圆形徽标；accent 浅底 + accent 文字）
    fn avatar_badge(&self, theme: &AppTheme) -> impl IntoElement {
        let initial = self
            .user_name
            .chars()
            .next()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "·".to_string());

        div()
            .id("rail-avatar-badge")
            .flex()
            .items_center()
            .justify_center()
            .size(px(AVATAR_SIZE))
            .rounded_full()
            .bg(theme.accent_soft)
            .text_size(px(FONT_BASE))
            .font_weight(gpui::FontWeight::MEDIUM)
            .text_color(theme.accent)
            .child(SharedString::from(initial))
    }
}

impl EventEmitter<MasterRailEvent> for MasterRailView {}

impl Focusable for MasterRailView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for MasterRailView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let group_count = self.groups.len();

        // 各按钮聚焦态先算好（避免渲染闭包里逐个查询窗口焦点）
        let focused_flags: Vec<bool> = (0..self.stops.len())
            .map(|i| self.stops[i].is_focused(window))
            .collect();

        let mut buttons: Vec<gpui::AnyElement> = Vec::new();
        for (index, group) in self.groups.iter().enumerate() {
            buttons.push(
                self.category_button(index, group, focused_flags[index], cx)
                    .into_any_element(),
            );
        }

        // 底部：用户头像（无路由行为，仅展示身份）+ 系统设置入口（选中系统管理分类）
        let settings_idx = group_count + 1;
        let system_id = self
            .groups
            .last()
            .map(|g| g.id.clone())
            .unwrap_or_else(|| "system".to_string());
        let avatar_btn = self
            .bottom_button(
                group_count,
                "rail-avatar",
                "当前用户",
                focused_flags[group_count],
                cx,
            )
            .child(self.avatar_badge(&theme));
        let settings_btn = self
            .bottom_button(
                settings_idx,
                "rail-settings",
                "系统设置",
                focused_flags[settings_idx],
                cx,
            )
            .child(
                svg()
                    .path(icon_path("SettingsIcon"))
                    .size(px(RAIL_ICON_SIZE))
                    .text_color(
                        if self.active_group.as_deref() == Some(system_id.as_str()) {
                            theme.accent
                        } else {
                            theme.text_secondary
                        },
                    ),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                this.select_category(&system_id.clone(), cx);
            }));

        div()
            .id("master-rail")
            .flex()
            .flex_col()
            .items_center()
            .w(px(RAIL_WIDTH))
            .h_full()
            .bg(theme.rail_bg)
            .border_r_1()
            .border_color(theme.separator)
            .focusable()
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(Self::on_key_down))
            .child(div().w_full().h(px(TRAFFIC_LIGHTS_CLEARANCE)))
            .child(
                div()
                    .id("master-rail-groups")
                    .flex()
                    .flex_col()
                    .items_center()
                    .w_full()
                    .gap_1()
                    .mt_1()
                    .children(buttons),
            )
            // 弹性空白把底部入口压到 Rail 底端
            .child(div().id("master-rail-spacer").flex_1().w_full())
            .child(
                div()
                    .id("master-rail-bottom")
                    .flex()
                    .flex_col()
                    .items_center()
                    .w_full()
                    .gap_1()
                    .pb_2()
                    .pt_1()
                    .border_t_1()
                    .border_color(theme.separator)
                    .child(avatar_btn)
                    .child(settings_btn),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    /// BLF-793 数据契约：Rail 不持有第二份分类清单——分组数必须等于
    /// gui-domain::sidebar 权威数据（8 组），且每组的 icon 都能解析到内嵌资源路径。
    #[test]
    fn rail_binds_domain_groups_without_local_list() {
        let groups = sidebar_groups();
        assert_eq!(groups.len(), 8, "Rail 必须与 gui-domain 8 组一一对应");
        for g in &groups {
            assert!(!icon_path(&g.icon).is_empty(), "分类 {} 缺图标", g.id);
        }
    }

    /// 选中态契约：select_category 设置 active_group 并 emit
    /// CategorySelected；set_active 反向同步且不产生额外事件。
    #[gpui::test]
    async fn select_and_set_active_contract(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let events: Rc<RefCell<Vec<MasterRailEvent>>> = Rc::new(RefCell::new(Vec::new()));
        let (view, cx) = cx.add_window_view(|_window, cx| {
            let events = events.clone();
            let rail = cx.entity();
            cx.subscribe(&rail, move |_, _, event: &MasterRailEvent, _| {
                events.borrow_mut().push(event.clone());
            })
            .detach();
            MasterRailView::new("达蒙", cx)
        });

        // 初始无选中（Dashboard 着陆页）
        cx.read(|app| assert_eq!(view.read(app).active_group.as_deref(), None));

        // 选中分类 → active 跟随 + 事件携带组 id
        view.update(cx, |rail, cx| rail.select_category("finance", cx));
        cx.read(|app| assert_eq!(view.read(app).active_group.as_deref(), Some("finance")));
        assert_eq!(
            *events.borrow(),
            vec![MasterRailEvent::CategorySelected {
                group_id: "finance".into()
            }]
        );

        // 反向同步（Sub-Nav 子项选中回写）：active 跟随且不产生额外事件
        view.update(cx, |rail, cx| {
            rail.set_active(Some("operations".into()), cx)
        });
        cx.read(|app| assert_eq!(view.read(app).active_group.as_deref(), Some("operations")));
        assert_eq!(
            events.borrow().len(),
            1,
            "set_active 不得触发 CategorySelected"
        );

        // 回着陆页：None 清除高亮
        view.update(cx, |rail, cx| rail.set_active(None, cx));
        cx.read(|app| assert_eq!(view.read(app).active_group.as_deref(), None));
    }

    /// 键盘可达契约：游标区间夹紧 [0, 分类数+2)（8 分类 + 头像 + 系统设置），
    /// 越界回弹边界；set_active 同步游标到激活分类（方向键从高亮项继续遍历）。
    #[gpui::test]
    async fn cursor_clamps_to_stop_bounds(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_window, cx| MasterRailView::new("", cx));

        view.update(cx, |rail, _| {
            rail.cursor = 0;
            rail.clamp_cursor(-1); // 顶部再 ↑ → 仍为 0
            assert_eq!(rail.cursor, 0, "上界回弹");

            rail.cursor = rail.stops.len() - 1;
            rail.clamp_cursor(1); // 底部再 ↓ → 仍为最后
            assert_eq!(rail.cursor, rail.stops.len() - 1, "下界回弹");

            rail.cursor = 0;
            let next = rail.clamp_cursor(3);
            assert_eq!(next, 3, "正常步进");
        });

        // set_active 把游标拉到激活分类位置
        view.update(cx, |rail, cx| rail.set_active(Some("system".into()), cx));
        view.update(cx, |rail, _| {
            let sys_idx = rail.groups.iter().position(|g| g.id == "system").unwrap();
            assert_eq!(rail.cursor, sys_idx, "游标应跟随激活分类");
        });
    }

    /// 渲染冒烟：带用户名完整渲染不 panic（8 图标 + 头像 + 系统设置路径）。
    #[gpui::test]
    async fn rail_renders_with_user(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (_view, _cx) = cx.add_window_view(|_window, cx| MasterRailView::new("测试用户", cx));
    }
}
