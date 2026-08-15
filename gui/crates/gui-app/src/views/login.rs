//! 登录视图（独立小窗口 440×560）
//!
//! 邮箱 + 密码表单，回车 / 按钮提交；错误用 gpui-component `Alert` 展示。
//! 提交成功时 emit `LoginViewEvent`，由 main.rs 存 Keychain 并打开主窗口。
//!
//! P2-5（BLF-692）：表单控件全面换成 gpui-component 原生组件——
//! `Input`（原生边框 + 焦点环 + Tab 焦点序列）+ `Button`（品牌蓝主按钮 +
//! loading 态）+ `Alert`（错误提示）；原自绘 div 按钮与自绘 TextField 移除。

use gpui::prelude::*;
use gpui::{div, px, App, Context, Entity, EventEmitter, FocusHandle, Focusable, Render, Window};
use gpui_component::alert::Alert;
use gpui_component::button::{Button, ButtonCustomVariant, ButtonVariants};
use gpui_component::input::{Input, InputEvent, InputState};
use gui_api_client::Client;
use gui_domain::auth::LoginResponse;

use crate::theme::AppTheme;

/// 登录成功事件（携带带会话的 client + 用户信息）
#[derive(Debug, Clone)]
pub struct LoginViewEvent {
    pub client: Client,
    pub user: LoginResponse,
}

/// 登录表单状态
enum LoginStatus {
    Idle,
    Submitting,
    Error(String),
}

/// 登录表单视图
pub struct LoginView {
    /// 邮箱输入（gpui-component InputState；首个渲染时惰性创建，需要 Window）
    email: Option<Entity<InputState>>,
    /// 密码输入（masked 圆点）
    password: Option<Entity<InputState>>,
    /// 输入事件订阅（PressEnter → 提交；Change → 清除错误）
    input_sub: Option<gpui::Subscription>,
    /// 未登录的 base client（登录成功后派生带会话 client）
    client: Client,
    status: LoginStatus,
    /// 本视图自己的焦点句柄（初始聚焦邮箱由首个渲染把焦点让给邮箱 Input）
    focus_handle: FocusHandle,
    /// P2-2：窗口外观变化监听（跟随系统；main.rs 注册时写入）
    pub theme_appearance_sub: Option<gpui::Subscription>,
}

impl LoginView {
    pub fn new(cx: &mut Context<Self>, client: Client, initial_error: Option<String>) -> Self {
        let status = match initial_error {
            Some(msg) => LoginStatus::Error(msg),
            None => LoginStatus::Idle,
        };

        Self {
            email: None,
            password: None,
            input_sub: None,
            client,
            status,
            focus_handle: cx.focus_handle(),
            theme_appearance_sub: None,
        }
    }

    /// 首个渲染时创建两个输入框 + 订阅（需要 `&mut Window` 才能建 InputState）。
    ///
    /// 输入框创建后立即把焦点交给邮箱框（等价旧实现 main.rs 的初始聚焦）。
    fn ensure_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.email.is_some() {
            return;
        }
        let email = cx.new(|cx| InputState::new(window, cx).placeholder("邮箱（必填）"));
        let password = cx
            .new(|cx| InputState::new(window, cx).placeholder("密码（必填）").masked(true));

        // 回车提交 / 输入变化清除错误（任一字段）
        let sub_email = cx.subscribe(&email, |this, _e, event: &InputEvent, cx| match event {
            InputEvent::PressEnter { .. } => this.submit_login(cx),
            InputEvent::Change => {
                if matches!(this.status, LoginStatus::Error(_)) {
                    this.status = LoginStatus::Idle;
                    cx.notify();
                }
            }
            _ => {}
        });
        let sub_password = cx.subscribe(&password, |this, _e, event: &InputEvent, cx| match event {
            InputEvent::PressEnter { .. } => this.submit_login(cx),
            InputEvent::Change => {
                if matches!(this.status, LoginStatus::Error(_)) {
                    this.status = LoginStatus::Idle;
                    cx.notify();
                }
            }
            _ => {}
        });

        self.email = Some(email.clone());
        self.password = Some(password);
        self.input_sub = Some(gpui::Subscription::join(sub_email, sub_password));

        // 初始焦点：邮箱框（macOS IME 组合中回车由输入法消费，不会误提交）
        email.update(cx, |state, cx| state.focus(window, cx));
    }

    fn submit_login(&mut self, cx: &mut Context<Self>) {
        if matches!(self.status, LoginStatus::Submitting) {
            return; // 已在请求中，忽略重复提交
        }
        let (Some(email), Some(password)) = (&self.email, &self.password) else {
            return; // 首个渲染前（理论上不可达）
        };
        let email_text = email.read(cx).value();
        let password_text = password.read(cx).unmask_value();
        if email_text.trim().is_empty() || password_text.trim().is_empty() {
            self.status = LoginStatus::Error("请输入邮箱和密码".to_string());
            cx.notify();
            return;
        }
        self.status = LoginStatus::Submitting;
        cx.notify();

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(
            async move |this: gpui::WeakEntity<Self>, cx: &mut gpui::AsyncApp| {
                let result = bg
                    .spawn(async move {
                        crate::runtime::runtime()
                            .block_on(client.login(&email_text, &password_text))
                    })
                    .await;
                this.update(&mut *cx, |this, cx| match result {
                    Ok((authed, user)) => {
                        this.status = LoginStatus::Idle;
                        cx.emit(LoginViewEvent {
                            client: authed,
                            user,
                        });
                    }
                    Err(e) => {
                        this.status = LoginStatus::Error(e.user_message());
                        cx.notify();
                    }
                })
                .ok();
            },
        )
        .detach();
    }
}

impl EventEmitter<LoginViewEvent> for LoginView {}

impl Render for LoginView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        self.ensure_inputs(window, cx);

        let (status_text, submitting) = match &self.status {
            LoginStatus::Idle => (None, false),
            LoginStatus::Submitting => (None, true),
            LoginStatus::Error(msg) => (Some(msg.clone()), false),
        };

        // 登录按钮：品牌蓝主按钮（HIG：全宽主行动 + loading 态）
        let btn_variant = ButtonCustomVariant::new(cx)
            .color(theme.accent)
            .foreground(theme.on_accent)
            .hover(theme.accent_hover)
            .active(theme.accent_hover)
            .shadow(false);
        let this = cx.entity();
        let email = self.email.clone().unwrap();
        let password = self.password.clone().unwrap();

        div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .bg(theme.window_bg)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .w(px(360.))
                    .bg(theme.card_bg)
                    .rounded(px(theme.radius_lg))
                    .border_1()
                    .border_color(theme.separator)
                    .p(px(32.))
                    .gap_4()
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(
                                div()
                                    .text_size(px(22.))
                                    .text_color(theme.text_primary)
                                    .child("登录 BelieveBoy"),
                            )
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .text_color(theme.text_secondary)
                                    .child("使用你的 BelieveBoy 账号继续"),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .text_color(theme.text_secondary)
                                    .child("邮箱"),
                            )
                            .child(Input::new(&email).w_full()),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .text_color(theme.text_secondary)
                                    .child("密码"),
                            )
                            .child(Input::new(&password).w_full()),
                    )
                    .child(
                        Button::new("login-submit")
                            .custom(btn_variant)
                            .label(if submitting {
                                "登录中…"
                            } else {
                                "登 录"
                            })
                            .loading(submitting)
                            .w_full()
                            .h(px(36.))
                            .on_click(move |_, _window, cx| {
                                this.update(cx, LoginView::submit_login);
                            }),
                    )
                    .children(
                        status_text.map(|msg| Alert::error("login-error", msg)),
                    ),
            )
    }
}

impl Focusable for LoginView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::Entity;
    use gpui_component::Root;
    use std::{cell::RefCell, rc::Rc};
    use gui_api_client::Client;

    /// 建窗：首层必须是 gpui-component `Root`（Input 聚焦时经 `Root::read` 跟踪
    /// focused_input）。返回 LoginView 实体句柄。
    fn create_login_view(
        cx: &mut gpui::TestAppContext,
        initial_error: Option<String>,
    ) -> Rc<RefCell<Option<Entity<LoginView>>>> {
        let login: Rc<RefCell<Option<Entity<LoginView>>>> = Default::default();
        let holder = login.clone();
        cx.add_window_view(move |window, cx| {
            let view =
                cx.new(|cx| LoginView::new(cx, Client::new("http://127.0.0.1:1"), initial_error));
            *holder.borrow_mut() = Some(view.clone());
            Root::new(view, window, cx)
        });
        login
    }

    /// 渲染冒烟（浅色）：原生 Input/Button/Alert 骨架可完整渲染不 panic。
    #[gpui::test]
    async fn login_renders_in_light_mode(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        create_login_view(cx, None);
    }

    /// 渲染冒烟（深色）：AppTheme::dark 语义色板 + 原生组件路径可渲染。
    #[gpui::test]
    async fn login_renders_in_dark_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        create_login_view(cx, None);
        cx.update(|cx| assert!(AppTheme::current(cx).is_dark()));
    }

    /// 渲染冒烟（初始错误）：Alert error 提示路径可渲染（Keychain 读取失败等场景）。
    #[gpui::test]
    async fn login_renders_with_initial_error(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        create_login_view(cx, Some("钥匙串读取失败：test".into()));
    }

    /// 空字段提交 → 本地校验错误态（不发起网络请求）。
    #[gpui::test]
    async fn login_empty_fields_shows_error(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let login = create_login_view(cx, None);
        let view = login.borrow().clone().expect("登录视图已创建");
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.submit_login(cx);
                assert!(matches!(this.status, LoginStatus::Error(_)));
            });
        });
    }
}
