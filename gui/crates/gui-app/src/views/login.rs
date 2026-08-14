//! 登录视图（独立小窗口 440×560）
//!
//! 邮箱 + 密码表单，回车 / 按钮提交；错误显示后端 `detail`。
//! 提交成功时 emit `LoginViewEvent`，由 main.rs 存 Keychain 并打开主窗口。

use gpui::{
    App, Context, CursorStyle, Entity, EventEmitter, FocusHandle, Focusable, MouseButton,
    MouseUpEvent, Render, Window, div, px, rgb, red, white,
};
use gpui::prelude::*;
use gui_api_client::Client;
use gui_domain::auth::LoginResponse;

use crate::widgets::text_input::{TextField, TextFieldSubmit};

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
    email: Entity<TextField>,
    password: Entity<TextField>,
    /// 未登录的 base client（登录成功后派生带会话 client）
    client: Client,
    status: LoginStatus,
}

impl LoginView {
    pub fn new(
        cx: &mut Context<Self>,
        client: Client,
        initial_error: Option<String>,
    ) -> Self {
        let email = cx.new(|cx| TextField::new(cx, "邮箱（必填）", false));
        let password = cx.new(|cx| TextField::new(cx, "密码（必填）", true));

        // 回车提交：邮箱 / 密码任一字段回车都触发登录
        let email_sub = email.clone();
        let password_sub = password.clone();
        cx.subscribe(&email_sub, |this, _e, _evt: &TextFieldSubmit, cx| {
            this.submit_login(cx)
        })
        .detach();
        cx.subscribe(&password_sub, |this, _e, _evt: &TextFieldSubmit, cx| {
            this.submit_login(cx)
        })
        .detach();

        let status = match initial_error {
            Some(msg) => LoginStatus::Error(msg),
            None => LoginStatus::Idle,
        };

        Self {
            email,
            password,
            client,
            status,
        }
    }

    fn submit_login(&mut self, cx: &mut Context<Self>) {
        if matches!(self.status, LoginStatus::Submitting) {
            return; // 已在请求中，忽略重复提交
        }
        // 输入法组合中（如拼音未上屏）不提交，避免读到半截内容
        if self.email.read(cx).has_marked_text() || self.password.read(cx).has_marked_text() {
            return;
        }
        let email = self.email.read(cx).content().to_string();
        let password = self.password.read(cx).content().to_string();
        if email.trim().is_empty() || password.is_empty() {
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
                        crate::runtime::runtime().block_on(client.login(&email, &password))
                    })
                    .await;
                this.update(&mut *cx, |this, cx| match result {
                    Ok((authed, user)) => {
                        this.password.update(cx, |f, cx| f.clear(cx));
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

    fn on_login_click(&mut self, _: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.submit_login(cx);
    }
}

impl EventEmitter<LoginViewEvent> for LoginView {}

impl Render for LoginView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (status_text, submitting) = match &self.status {
            LoginStatus::Idle => (None, false),
            LoginStatus::Submitting => (None, true),
            LoginStatus::Error(msg) => (Some(msg.clone()), false),
        };

        div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .bg(rgb(0xf3f4f6))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .w(px(360.))
                    .bg(white())
                    .rounded(px(12.))
                    .border_1()
                    .border_color(rgb(0xe5e7eb))
                    .p(px(28.))
                    .gap_4()
                    .child(
                        div()
                            .text_size(px(22.))
                            .text_color(rgb(0x111827))
                            .child("登录 BelieveBoy"),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .text_color(rgb(0x374151))
                                    .child("邮箱"),
                            )
                            .child(self.email.clone()),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .text_color(rgb(0x374151))
                                    .child("密码"),
                            )
                            .child(self.password.clone()),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .h(px(40.))
                            .rounded(px(8.))
                            .bg(rgb(0x1a66ff))
                            .text_size(px(15.))
                            .text_color(white())
                            .cursor(CursorStyle::PointingHand)
                            .hover(|style| style.bg(rgb(0x1552d4)))
                            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_login_click))
                            .child(if submitting { "登录中…" } else { "登 录" }),
                    )
                    .children(status_text.map(|msg| {
                        div()
                            .text_size(px(13.))
                            .text_color(red())
                            .child(msg)
                    })),
            )
    }
}

impl Focusable for LoginView {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        // 初始焦点给邮箱框
        self.email.read(cx).focus_handle(cx)
    }
}
