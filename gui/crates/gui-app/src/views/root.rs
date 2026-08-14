//! 主窗口根视图：顶部会话栏 + 左侧侧栏 + 右侧内容区（两栏布局）
//!
//! 继承 GUI-3（BLF-675）的侧栏渲染 / 键盘导航 / 占位内容区，
//! GUI-2（BLF-674）叠加：已登录用户信息栏 + 退出登录（emit `RootViewEvent::Logout`，
//! 由 main.rs 清 Keychain 并切回登录窗口）。
//! GUI-7（BLF-679）叠加：Dashboard 首页作为「sidebar 之外的着陆页」启动即显示
//! （对齐 Web /dashboard），侧栏初始无选中项；点击/键盘选中任意子项后切回占位视图。

use gpui::{
    Context, CursorStyle, Entity, EventEmitter, FocusHandle, Focusable, MouseButton, MouseUpEvent,
    Render, Window, div, px, rgb,
};
use gpui::prelude::*;
use gui_api_client::Client;
use gui_domain::auth::LoginResponse;

use crate::theme::Theme;
use crate::views::dashboard::DashboardView;
use crate::views::placeholder::PlaceholderView;
use crate::views::sidebar::{SidebarEvent, SidebarView};

/// 主窗口会话信息（登录成功 / Keychain 恢复后注入）
pub struct SessionInfo {
    /// 带会话的 client（后续 issue 的 API 调用入口；GUI-4+ 消费前暂时只持有）
    #[allow(dead_code)]
    pub client: Client,
    pub user: LoginResponse,
    /// 非致命警告（Keychain 持久化失败 / 服务器连接失败）
    pub warning: Option<String>,
}

/// 主窗口根视图事件
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootViewEvent {
    /// 用户点了退出登录（coordinator 负责清 Keychain + 切窗口）
    Logout,
}

/// 根视图：会话栏 + 侧栏 + 内容区
pub struct RootView {
    pub sidebar: Entity<SidebarView>,
    pub content: Entity<PlaceholderView>,
    /// Dashboard 着陆页（sidebar 之外的首页，对齐 Web /dashboard）；启动即显示
    dashboard: Option<Entity<DashboardView>>,
    /// 内容区当前是否显示 Dashboard 着陆页（侧栏选中任意项后切换为占位视图）
    show_dashboard: bool,
    session: Option<SessionInfo>,
    focus_handle: FocusHandle,
}

impl RootView {
    pub fn new(cx: &mut Context<Self>, session: Option<SessionInfo>) -> Self {
        // GUI-7：Dashboard 首页为着陆页（sidebar 之外的 landing），启动默认显示；
        // 侧栏初始无选中项，点击/键盘选中后再切换内容区为对应占位视图。
        let show_dashboard = session.is_some();
        let dashboard = session.as_ref().map(|s| {
            let client = s.client.clone();
            cx.new(|cx| {
                let mut view = DashboardView::new(cx, client, Vec::new());
                // 启动即触发首屏拉取（项目列表 + 近 7 天聚合 + 对比期）
                view.reload(cx);
                view
            })
        });

        let sidebar = cx.new(|cx| SidebarView::new(None, cx));
        let content = cx.new(|_| PlaceholderView::new("", ""));

        // 侧栏选中变化 → 内容区切换到对应占位 View（并离开 Dashboard 着陆页）
        cx.subscribe(&sidebar, |this, _sidebar, event, cx| {
            let SidebarEvent::Select { url, title } = event;
            this.show_dashboard = false;
            this.content.update(cx, |content, cx| {
                content.title = title.clone();
                content.url = url.clone();
                cx.notify();
            });
            cx.notify();
        })
        .detach();

        Self {
            sidebar,
            content,
            dashboard,
            show_dashboard,
            session,
            focus_handle: cx.focus_handle(),
        }
    }

    /// 显示非致命警告横幅（会话校验等后台任务回调用）
    pub fn set_warning(&mut self, warning: String, cx: &mut Context<Self>) {
        if let Some(s) = &mut self.session {
            s.warning = Some(warning);
        }
        cx.notify();
    }

    fn on_logout_click(&mut self, _: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(RootViewEvent::Logout);
    }
}

impl EventEmitter<RootViewEvent> for RootView {}

impl Render for RootView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::dark_sidebar_light_content();

        div()
            .id("root")
            .flex()
            .size_full()
            .bg(rgb(0xfafafa))
            .child(self.sidebar.clone())
            .child(
                div()
                    .id("content-col")
                    .flex_1()
                    .h_full()
                    .flex_col()
                    .bg(theme.content_bg)
                    .child(session_header(&self.session, theme, cx))
                    .child(
                        div()
                            .id("content")
                            .flex_1()
                            .h_full()
                            .child(if self.show_dashboard {
                                self.dashboard.clone().map_or_else(
                                    || self.content.clone().into_any_element(),
                                    |dashboard| dashboard.into_any_element(),
                                )
                            } else {
                                self.content.clone().into_any_element()
                            }),
                    ),
            )
    }
}

impl Focusable for RootView {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

/// 内容区顶部的会话栏：已登录用户 + 警告 + 退出登录
fn session_header(
    session: &Option<SessionInfo>,
    theme: Theme,
    cx: &mut Context<RootView>,
) -> impl IntoElement {
    let Some(s) = session else {
        return div().id("session-header-empty");
    };
    let role_label = match s.user.role_type {
        gui_domain::auth::UserRoleType::Admin => "管理员",
        gui_domain::auth::UserRoleType::Operator => "运营",
        gui_domain::auth::UserRoleType::Businessdev => "业务拓展",
    };

    div()
        .id("session-header")
        .flex()
        .flex_row()
        .items_center()
        .justify_between()
        .gap_4()
        .px_4()
        .py_2()
        .border_b_1()
        .border_color(theme.content_card_border)
        .bg(theme.content_card_bg)
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_3()
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.content_title)
                        .child(format!(
                            "已登录：{}（{}）· {}",
                            s.user.name, s.user.email, role_label
                        )),
                )
                .children(s.warning.as_ref().map(|w| {
                    div()
                        .text_sm()
                        .text_color(rgb(0xb45309))
                        .child(w.clone())
                })),
        )
        .child(
            div()
                .px_3()
                .py_1()
                .rounded(px(6.))
                .border_1()
                .border_color(rgb(0xd1d5db))
                .text_size(px(13.))
                .text_color(rgb(0x374151))
                .cursor(CursorStyle::PointingHand)
                .hover(|style| style.bg(rgb(0xe5e7eb)))
                .on_mouse_up(MouseButton::Left, cx.listener(RootView::on_logout_click))
                .child("退出登录"),
        )
}
