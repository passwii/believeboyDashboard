//! 系统管理 → 账号管理（P5-8，BLF-754）
//!
//! 对齐 web 端 `app/dashboard/system/account-management/page.tsx`（约 758 行）：
//! 管理员维护用户账号的角色属性（管理员/运营/招商）与启停状态——
//! - **账号列表**：名称 / 姓名 / 邮箱 / 角色属性 / 启停状态 / 更新时间；
//! - **行级动作**：停用|启用切换、编辑（运营姓名 + 角色属性）、重置密码（≥8 位）、
//!   删除账号（Yawei 保护账号禁用，与 web `isYaweiAccount` 及后端 403 守卫一致）；
//! - **新增账号**：名称 / 姓名（可选）/ 邮箱 / 初始密码（≥8 位）/ 角色属性。
//!
//! ## 与 web 端的取舍（issue 允许按 macOS 原生习惯精简并说明）
//!
//! - **行内操作按钮 + DropdownMenu** → 表格行选中 + 操作条（GPUI DataTable 无
//!   行内事件回调；选中行操作是 macOS 原生习惯，如 Finder / Xcode 列表详情模式）；
//! - **角色 Select 下拉** → 对话框内三档分段 pill（管理员/运营/招商，选项固定
//!   且少，分段控件比下拉少一次点击，macOS 原生习惯）;
//! - **手机端卡片列表** → 不接入（桌面 GUI 无移动断点）。
//!
//! ## 权限口径
//!
//! 端点走 `/api/v1/system-management/users`（admin-gated）；GUI 登录会话为 admin
//! 时 `Client` 自动携带 `X-Is-Admin: true`（client.rs 上下文头管线），非 admin 登录
//! 将收到后端 403（错误态透传展示）。

use gpui::prelude::*;
use gpui::{
    div, px, App, AsyncApp, Context, CursorStyle, Entity, FontWeight, IntoElement, SharedString,
    WeakEntity, Window,
};
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::input::{Input, InputState};
use gpui_component::{h_flex, v_flex, Disableable, Sizable};
use gui_api_client::admin_users::{AdminUserCreateBody, AdminUserUpdateBody};
use gui_api_client::Client;
use gui_domain::admin_users::{role_type_label, AdminUserItem};
use gui_domain::auth::UserRoleType;

use crate::theme::AppTheme;
use crate::widgets::data_table::{ColumnDef, DataTable};
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「系统管理 → 账号管理」URL（数据权威 gui-domain::sidebar）
pub const ACCOUNT_MANAGEMENT_URL: &str = "/dashboard/system/account-management";

/// 密码最小长度（对齐 web minLength=8 与 backend Field(min_length=8)）
const PASSWORD_MIN_LEN: usize = 8;

// ---------------------------------------------------------------------------
// 纯辅助函数
// ---------------------------------------------------------------------------

/// ISO 时间戳 → 北京时间 `YYYY-MM-DD HH:MM`（空 / 解析失败 → 「—」/ 原文回退）
fn beijing_time(iso: &str) -> String {
    let iso = iso.trim();
    if iso.is_empty() {
        return "—".to_string();
    }
    let beijing = chrono::FixedOffset::east_opt(8 * 3600).expect("固定偏移");
    let parsed = chrono::DateTime::parse_from_rfc3339(iso)
        .map(|dt| dt.with_timezone(&beijing))
        .or_else(|_| {
            chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S%.f").map(|naive| {
                use chrono::TimeZone;
                chrono::Utc
                    .from_utc_datetime(&naive)
                    .with_timezone(&beijing)
            })
        });
    parsed
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|_| iso.to_string())
}

/// 创建表单校验（对齐 web required + minLength=8；返回首个错误的提示文案）
fn validate_create_input(
    name: &str,
    email: &str,
    password: &str,
) -> Result<(String, String, String), String> {
    let name = name.trim().to_string();
    let email = email.trim().to_string();
    let password = password.to_string();
    if name.is_empty() {
        return Err("请输入名称".to_string());
    }
    if email.is_empty() || !email.contains('@') {
        return Err("请输入有效邮箱".to_string());
    }
    if password.chars().count() < PASSWORD_MIN_LEN {
        return Err(format!("初始密码至少 {PASSWORD_MIN_LEN} 位"));
    }
    Ok((name, email, password))
}

/// 重置密码校验（≥8 位）
fn validate_password(password: &str) -> Result<String, String> {
    let password = password.to_string();
    if password.chars().count() < PASSWORD_MIN_LEN {
        return Err(format!("新密码至少 {PASSWORD_MIN_LEN} 位"));
    }
    Ok(password)
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/// 账号列表状态机
#[derive(Debug, Clone, PartialEq)]
pub enum UserListState {
    Loading,
    Loaded,
    Empty,
    Error(String),
}

/// 打开中的对话框（互斥；同一时刻最多一个）
#[derive(Debug, Clone)]
enum OpenDialog {
    /// 新增账号（输入草稿存输入框实体）
    Create { role: UserRoleType },
    /// 编辑账号：运营姓名 + 角色属性
    Edit {
        user: AdminUserItem,
        role: UserRoleType,
    },
    /// 重置密码
    ResetPassword { user: AdminUserItem },
    /// 删除确认
    DeleteConfirm { user: AdminUserItem },
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// 账号管理视图（列表 + 行级动作 + 四类对话框）
pub struct AccountManagementView {
    client: Client,
    users_state: UserListState,
    users: Vec<AdminUserItem>,
    table: Entity<DataTable<AdminUserItem>>,
    request_id: u64,

    /// 行级动作 / 提交进行中（防重复提交）
    busy: bool,
    dialog_error: Option<String>,
    open_dialog: Option<OpenDialog>,

    // ── 输入框实体（render 期懒建，需要 window） ──────────────
    create_name_input: Option<Entity<InputState>>,
    create_full_name_input: Option<Entity<InputState>>,
    create_email_input: Option<Entity<InputState>>,
    create_password_input: Option<Entity<InputState>>,
    edit_name_input: Option<Entity<InputState>>,
    reset_password_input: Option<Entity<InputState>>,

    /// 操作反馈（成功绿 / 失败红内联提示条）
    notice: Option<(bool, String)>,
}

impl AccountManagementView {
    /// 新建视图：初始 Loading，由 root.rs 懒创建后触发 `reload_users`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let table = cx.new(|_| {
            DataTable::new("account-user-table", user_columns())
                .striped(true)
                .selectable(true)
                .empty_text("暂无账号 — 点击右上角「新增账号」创建")
        });
        Self {
            client,
            users_state: UserListState::Loading,
            users: Vec::new(),
            table,
            request_id: 0,
            busy: false,
            dialog_error: None,
            open_dialog: None,
            create_name_input: None,
            create_full_name_input: None,
            create_email_input: None,
            create_password_input: None,
            edit_name_input: None,
            reset_password_input: None,
            notice: None,
        }
    }

    /// 当前列表状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self) -> &UserListState {
        &self.users_state
    }

    // ── 数据拉取 ────────────────────────────────────────────

    /// 拉取账号列表（首屏 / 动作完成后刷新）
    pub fn reload_users(&mut self, cx: &mut Context<Self>) {
        self.request_id = self.request_id.wrapping_add(1);
        let request_id = self.request_id;
        self.users_state = UserListState::Loading;
        self.notice = None;
        cx.notify();

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(async { client.admin_user_list().await })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                if request_id != this.request_id {
                    return; // 过期响应
                }
                match result {
                    Ok(users) => {
                        this.users = users;
                        this.users_state = if this.users.is_empty() {
                            UserListState::Empty
                        } else {
                            UserListState::Loaded
                        };
                    }
                    Err(e) => {
                        this.users = Vec::new();
                        this.users_state = UserListState::Error(e.user_message());
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // ── 对话框开关 ──────────────────────────────────────────

    /// 打开新增账号对话框（清空上次输入）
    pub fn open_create(&mut self, cx: &mut Context<Self>) {
        self.dialog_error = None;
        self.open_dialog = Some(OpenDialog::Create {
            role: UserRoleType::Operator,
        });
        self.create_name_input = None;
        self.create_full_name_input = None;
        self.create_email_input = None;
        self.create_password_input = None;
        cx.notify();
    }

    /// 打开编辑对话框（预填运营姓名与角色属性）
    pub fn open_edit(&mut self, user: AdminUserItem, cx: &mut Context<Self>) {
        self.dialog_error = None;
        self.open_dialog = Some(OpenDialog::Edit {
            role: user.role_type,
            user,
        });
        self.edit_name_input = None;
        cx.notify();
    }

    /// 打开重置密码对话框
    pub fn open_reset_password(&mut self, user: AdminUserItem, cx: &mut Context<Self>) {
        self.dialog_error = None;
        self.open_dialog = Some(OpenDialog::ResetPassword { user });
        self.reset_password_input = None;
        cx.notify();
    }

    /// 打开删除确认对话框（保护账号在操作条已禁用入口，双保险再拦一层）
    pub fn open_delete_confirm(&mut self, user: AdminUserItem, cx: &mut Context<Self>) {
        if user.is_protected() {
            self.notice = Some((true, "Yawei 账号不允许删除".to_string()));
            cx.notify();
            return;
        }
        self.dialog_error = None;
        self.open_dialog = Some(OpenDialog::DeleteConfirm { user });
        cx.notify();
    }

    /// 关闭对话框（四类共用入口）
    pub fn close_dialog(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return; // 提交中禁止关闭，避免响应回来落空
        }
        self.open_dialog = None;
        self.dialog_error = None;
        self.create_name_input = None;
        self.create_full_name_input = None;
        self.create_email_input = None;
        self.create_password_input = None;
        self.edit_name_input = None;
        self.reset_password_input = None;
        cx.notify();
    }

    /// 对话框内切角色属性（无创建/编辑对话框时 no-op）
    pub fn set_dialog_role(&mut self, role: UserRoleType, cx: &mut Context<Self>) {
        match &mut self.open_dialog {
            Some(OpenDialog::Create { role: r }) => *r = role,
            Some(OpenDialog::Edit { role: r, .. }) => *r = role,
            _ => return,
        }
        cx.notify();
    }

    fn input_value(input: Option<&Entity<InputState>>, cx: &Context<Self>) -> String {
        input
            .map(|i| i.read(cx).value().trim().to_string())
            .unwrap_or_default()
    }

    // ── 提交动作 ────────────────────────────────────────────

    /// 提交新增账号
    pub fn submit_create(&mut self, cx: &mut Context<Self>) {
        let Some(OpenDialog::Create { role }) = self.open_dialog.clone() else {
            return;
        };
        if self.busy {
            return;
        }
        let name = Self::input_value(self.create_name_input.as_ref(), cx);
        let full_name = Self::input_value(self.create_full_name_input.as_ref(), cx);
        let email = Self::input_value(self.create_email_input.as_ref(), cx);
        let password = Self::input_value(self.create_password_input.as_ref(), cx);
        let (name, email, password) = match validate_create_input(&name, &email, &password) {
            Ok(v) => v,
            Err(msg) => {
                self.dialog_error = Some(msg);
                cx.notify();
                return;
            }
        };

        let body = AdminUserCreateBody {
            is_admin: role == UserRoleType::Admin,
            full_name: (!full_name.is_empty()).then_some(full_name),
            operator_name_zh: None,
            name,
            email,
            password,
            role_type: role,
        };
        self.run_mutation(
            move |client| Box::pin(async move { client.admin_user_create(&body).await }),
            "用户创建成功",
            true,
            false,
            cx,
        );
    }

    /// 提交编辑（运营姓名 + 角色属性；role_type 变更时后端自动派生 is_admin）
    pub fn submit_edit(&mut self, cx: &mut Context<Self>) {
        let Some(OpenDialog::Edit { user, role }) = self.open_dialog.clone() else {
            return;
        };
        if self.busy {
            return;
        }
        let name_zh = Self::input_value(self.edit_name_input.as_ref(), cx);
        let body = AdminUserUpdateBody {
            operator_name_zh: if name_zh.is_empty() {
                None
            } else {
                Some(name_zh)
            },
            role_type: Some(role),
            ..Default::default()
        };
        let label = user.display_name().to_string();
        let user_id = user.id;
        self.run_mutation(
            move |client| Box::pin(async move { client.admin_user_update(&user_id, &body).await }),
            &format!("账号已更新：{label}"),
            false,
            true,
            cx,
        );
    }

    /// 提交重置密码
    pub fn submit_reset_password(&mut self, cx: &mut Context<Self>) {
        let Some(OpenDialog::ResetPassword { user }) = self.open_dialog.clone() else {
            return;
        };
        if self.busy {
            return;
        }
        let password = Self::input_value(self.reset_password_input.as_ref(), cx);
        let password = match validate_password(&password) {
            Ok(p) => p,
            Err(msg) => {
                self.dialog_error = Some(msg);
                cx.notify();
                return;
            }
        };
        let body = AdminUserUpdateBody {
            password: Some(password),
            ..Default::default()
        };
        let label = user.display_name().to_string();
        let user_id = user.id;
        self.run_mutation(
            move |client| Box::pin(async move { client.admin_user_update(&user_id, &body).await }),
            &format!("密码已重置：{label}"),
            false,
            true,
            cx,
        );
    }

    /// 执行删除确认
    pub fn run_delete(&mut self, cx: &mut Context<Self>) {
        let Some(OpenDialog::DeleteConfirm { user }) = self.open_dialog.clone() else {
            return;
        };
        if self.busy {
            return;
        }
        let label = user.display_name().to_string();
        let user_id = user.id;
        self.busy = true;
        self.dialog_error = None;
        cx.notify();

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(async { client.admin_user_delete(&user_id).await })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(()) => {
                        this.open_dialog = None;
                        this.notice = Some((false, format!("账号已删除：{label}")));
                        this.reload_users(cx);
                    }
                    Err(e) => {
                        this.dialog_error = Some(e.user_message());
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// 行级启停切换（web 行内按钮语义：直接 PATCH，不经确认对话框；
    /// 保护账号本地拦截——对齐 web「Yawei 账号不允许停用」提示）
    pub fn toggle_active(&mut self, user: AdminUserItem, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        if user.is_protected() && user.is_active {
            self.notice = Some((true, "Yawei 账号不允许停用".to_string()));
            cx.notify();
            return;
        }
        let next_active = !user.is_active;
        let verb = if next_active { "启用" } else { "停用" };
        let body = AdminUserUpdateBody {
            is_active: Some(next_active),
            ..Default::default()
        };
        let label = user.display_name().to_string();
        let user_id = user.id;
        self.run_mutation(
            move |client| Box::pin(async move { client.admin_user_update(&user_id, &body).await }),
            &format!("{verb}成功：{label}"),
            false,
            false,
            cx,
        );
    }

    /// 统一变更管线：busy 守卫 + 后台请求 + 反馈条 + reload。
    ///
    /// - `close_on_start`：提交即收起对话框（创建用，对齐 web 先关表单再提示）；
    /// - `close_on_success`：成功后收起对话框（编辑 / 改密用；失败保留原对话框
    ///   展示错误）。行级启停无对话框，两参均 false。
    fn run_mutation<F>(
        &mut self,
        call: F,
        success_msg: &str,
        close_on_start: bool,
        close_on_success: bool,
        cx: &mut Context<Self>,
    ) where
        F: FnOnce(
                Client,
            ) -> std::pin::Pin<
                Box<
                    dyn std::future::Future<
                            Output = Result<AdminUserItem, gui_api_client::error::ApiError>,
                        > + Send,
                >,
            > + Send
            + 'static,
    {
        self.busy = true;
        if close_on_start {
            self.open_dialog = None;
        }
        self.dialog_error = None;
        cx.notify();

        let client = self.client.clone();
        let msg = success_msg.to_string();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg.spawn(async move { call(client).await }).await;
            this.update(&mut *cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(_) => {
                        this.notice = Some((false, msg));
                        if close_on_success {
                            this.close_dialog_inner();
                        }
                        this.reload_users(cx);
                    }
                    Err(e) => {
                        // 失败保留原对话框展示错误（创建已提前收起 → 重新打开表单）
                        this.dialog_error = Some(e.user_message());
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// 内部清理对话框（不判 busy，供响应回调使用）
    fn close_dialog_inner(&mut self) {
        self.open_dialog = None;
        self.dialog_error = None;
        self.create_name_input = None;
        self.create_full_name_input = None;
        self.create_email_input = None;
        self.create_password_input = None;
        self.edit_name_input = None;
        self.reset_password_input = None;
    }

    // ── 选中行 ──────────────────────────────────────────────

    /// 当前选中行对应的账号（表格选中下标 → 用户列表）
    fn selected_user(&self, cx: &App) -> Option<AdminUserItem> {
        let ix = self.table.read(cx).selected()?;
        self.users.get(ix).cloned()
    }
}

// ---------------------------------------------------------------------------
// 列定义
// ---------------------------------------------------------------------------

/// 账号表 6 列（对齐 web 桌面列序去掉操作列；操作改为选中行操作条）
fn user_columns() -> Vec<ColumnDef<AdminUserItem>> {
    vec![
        ColumnDef::text("user-name", "名称", |r: &AdminUserItem, _| {
            SharedString::from(r.display_name().to_string())
        })
        .width(130.0),
        ColumnDef::text("user-full-name", "姓名", |r: &AdminUserItem, _| {
            SharedString::from(r.full_name_display())
        })
        .width(130.0),
        ColumnDef::text("user-email", "邮箱", |r: &AdminUserItem, _| {
            SharedString::from(r.email.clone())
        })
        .width(230.0),
        ColumnDef::text("user-role", "角色属性", |r: &AdminUserItem, _| {
            SharedString::from(role_type_label(r.role_type))
        })
        .width(96.0),
        ColumnDef::text("user-status", "状态", |_r, _| SharedString::from(""))
            .with_render_element(|r: &AdminUserItem, theme| {
                status_pill(r.is_active, theme).into_any_element()
            })
            .width(80.0),
        ColumnDef::text("user-updated", "更新时间", |r: &AdminUserItem, _| {
            SharedString::from(beijing_time(&r.updated_at))
        })
        .width(150.0),
    ]
}

/// 启停状态 pill（启用绿 / 停用红，对齐 web 文案配色）
fn status_pill(active: bool, theme: &AppTheme) -> gpui::AnyElement {
    use gpui_component::{Icon, IconName, Sizable};
    let (bg, fg) = if active {
        (theme.success_soft, theme.success)
    } else {
        (theme.danger_soft, theme.danger)
    };
    h_flex()
        .items_center()
        .gap_1()
        .rounded_full()
        .border_1()
        .border_color(fg.opacity(0.35))
        .bg(bg)
        .px_2()
        .py(px(1.))
        .child(
            Icon::new(if active {
                IconName::Check
            } else {
                IconName::Close
            })
            .with_size(px(11.)),
        )
        .child(
            div()
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .child(if active { "启用" } else { "停用" }),
        )
        .into_any_element()
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for AccountManagementView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let view = cx.entity();

        // 对话框输入框懒建（需要 window；关闭后重建）
        match &self.open_dialog {
            Some(OpenDialog::Create { .. }) => {
                if self.create_name_input.is_none() {
                    self.create_name_input =
                        Some(cx.new(|cx| InputState::new(window, cx).placeholder("登录名")));
                }
                if self.create_full_name_input.is_none() {
                    self.create_full_name_input =
                        Some(cx.new(|cx| {
                            InputState::new(window, cx).placeholder("可选，后续可手动维护")
                        }));
                }
                if self.create_email_input.is_none() {
                    self.create_email_input = Some(
                        cx.new(|cx| InputState::new(window, cx).placeholder("name@example.com")),
                    );
                }
                if self.create_password_input.is_none() {
                    self.create_password_input = Some(cx.new(|cx| {
                        InputState::new(window, cx)
                            .placeholder(format!("至少 {PASSWORD_MIN_LEN} 位"))
                            .masked(true)
                    }));
                }
            }
            Some(OpenDialog::Edit { user, .. }) => {
                if self.edit_name_input.is_none() {
                    let initial = user
                        .full_name
                        .clone()
                        .or(user.operator_name_zh.clone())
                        .unwrap_or_default();
                    self.edit_name_input = Some(cx.new(|cx| {
                        let mut s =
                            InputState::new(window, cx).placeholder("用于权限控制和操作记录");
                        if !initial.is_empty() {
                            s = s.default_value(initial);
                        }
                        s
                    }));
                }
            }
            Some(OpenDialog::ResetPassword { .. }) if self.reset_password_input.is_none() => {
                self.reset_password_input = Some(cx.new(|cx| {
                    InputState::new(window, cx)
                        .placeholder(format!("至少 {PASSWORD_MIN_LEN} 位"))
                        .masked(true)
                }));
            }
            _ => {}
        }

        v_flex()
            .id("account-management")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            .child(
                PageHeader::new("账号管理")
                    .subtitle("管理员可维护用户角色属性（管理员/运营/招商）及账号启停状态。")
                    .action(refresh_button(&view, self.busy))
                    .action(create_button(&view)),
            )
            .when_some(self.notice.clone(), |this, (is_err, text)| {
                this.child(notice_banner(&app_theme, is_err, &text))
            })
            .child(self.render_list_card(cx, &view, &app_theme))
            // 模态层（创建 / 编辑 / 改密 / 删除确认）
            .when(self.open_dialog.is_some(), |this| {
                this.child(render_modal_overlay(self, cx, &view, &app_theme))
            })
    }
}

impl AccountManagementView {
    /// 列表卡（四态：加载骨架 / 错误重试 / 空态引导 / 表格 + 选中行操作条）
    fn render_list_card(
        &mut self,
        cx: &mut Context<Self>,
        view: &Entity<Self>,
        theme: &AppTheme,
    ) -> gpui::AnyElement {
        // 表格行注入（render 期幂等）
        self.table
            .update(cx, |t, cx| t.set_rows_if_changed(&self.users, cx));

        let selected = self.selected_user(cx);
        let reduce = crate::motion::reduce_motion(cx);

        let body: gpui::AnyElement =
            match &self.users_state {
                UserListState::Loading => state_views::skeleton_loading(
                    theme,
                    &[SkeletonBlock::Kpi(2), SkeletonBlock::Table(280.0)],
                )
                .into_any_element(),
                UserListState::Error(msg) => state_views::error_state(
                    view,
                    theme,
                    "account-users-error",
                    "账号列表加载失败",
                    msg.clone(),
                    |this, cx| this.reload_users(cx),
                )
                .into_any_element(),
                UserListState::Empty => state_views::empty_state_with_action_desc(
                    view,
                    theme,
                    "account-users-empty",
                    "icons/users.svg",
                    "暂无账号",
                    Some("点击「新增账号」创建第一个用户".to_string()),
                    "刷新",
                    |this, cx| this.reload_users(cx),
                )
                .into_any_element(),
                UserListState::Loaded => {
                    let action_bar = render_selected_actions(selected.as_ref(), view, theme);
                    let table_card =
                        v_flex()
                            .id("account-users-card")
                            .w_full()
                            .rounded(px(theme.radius_lg))
                            .bg(theme.card_bg)
                            .shadow(vec![theme.card_shadow_box()])
                            .child(
                                v_flex()
                                    .gap_1()
                                    .px_4()
                                    .py_3()
                                    .border_b_1()
                                    .border_color(theme.separator)
                                    .child(
                                        div()
                                            .text_base()
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(theme.text_primary)
                                            .child("账号列表"),
                                    )
                                    .child(div().text_xs().text_color(theme.text_muted).child(
                                        "角色属性决定权限范围；停用账号立即吊销其全部登录会话",
                                    )),
                            )
                            .child(action_bar)
                            .child(div().w_full().px_4().py_2().child(self.table.clone()))
                            .child(
                                div()
                                    .px_4()
                                    .pb_2()
                                    .text_xs()
                                    .text_color(theme.text_muted)
                                    .child(SharedString::from(format!(
                                "共 {} 个账号 · 点击行选中后可在上方启停 / 编辑 / 重置密码 / 删除",
                                self.users.len()
                            ))),
                            );
                    crate::motion::enter_fade_in(
                        SharedString::from("account-users-loaded-fade"),
                        table_card,
                        reduce,
                    )
                    .into_any_element()
                }
            };

        content_guard().child(body).into_any_element()
    }
}

/// 头部刷新按钮（loading 中禁用）
fn refresh_button(view: &Entity<AccountManagementView>, busy: bool) -> gpui::AnyElement {
    let view = view.clone();
    Button::new("account-refresh-btn")
        .outline()
        .small()
        .label("刷新")
        .disabled(busy)
        .on_click(move |_, _, cx| {
            view.update(cx, |this, cx| this.reload_users(cx));
        })
        .into_any_element()
}

/// 头部新增账号按钮
fn create_button(view: &Entity<AccountManagementView>) -> gpui::AnyElement {
    let view = view.clone();
    Button::new("account-create-btn")
        .primary()
        .small()
        .label("新增账号")
        .on_click(move |_, _, cx| {
            view.update(cx, |this, cx| this.open_create(cx));
        })
        .into_any_element()
}

/// 内联反馈条（成功 / 失败）
fn notice_banner(theme: &AppTheme, is_err: bool, text: &str) -> gpui::AnyElement {
    let (bg, fg, border) = if is_err {
        (theme.danger_soft, theme.danger, theme.danger.opacity(0.35))
    } else {
        (
            theme.success_soft,
            theme.success,
            theme.success.opacity(0.35),
        )
    };
    h_flex()
        .id("account-notice-banner")
        .rounded(px(theme.radius))
        .border_1()
        .border_color(border)
        .bg(bg)
        .px_3()
        .py_2()
        .text_sm()
        .text_color(fg)
        .child(text.to_string())
        .into_any_element()
}

/// 选中行操作条（macOS 列表详情模式：选中后展示 启停 / 编辑 / 重置密码 / 删除）
fn render_selected_actions(
    selected: Option<&AdminUserItem>,
    view: &Entity<AccountManagementView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let container = h_flex()
        .id("account-user-actions")
        .gap_2()
        .items_center()
        .px_4()
        .py_2()
        .border_b_1()
        .border_color(theme.separator);

    let Some(item) = selected else {
        return container
            .child(
                div()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child("点击表格行选中账号后可在此启停 / 编辑 / 重置密码 / 删除"),
            )
            .into_any_element();
    };

    let protected = item.is_protected();
    let active = item.is_active;
    let busy_guard = div()
        .text_xs()
        .text_color(theme.text_secondary)
        .child(SharedString::from(format!(
            "已选中：{}（{}）",
            item.display_name(),
            role_type_label(item.role_type)
        )));

    let v_toggle = view.clone();
    let v_edit = view.clone();
    let v_reset = view.clone();
    let v_delete = view.clone();
    let item_for_toggle = item.clone();
    let item_for_edit = item.clone();
    let item_for_reset = item.clone();
    let item_for_delete = item.clone();

    container
        .child(busy_guard)
        .child({
            // 保护账号不允许停用（启用过则禁用切换）；停用态允许重新启用
            let toggle_disabled = protected && active;
            Button::new("account-user-toggle")
                .outline()
                .small()
                .label(if active { "停用" } else { "启用" })
                .disabled(toggle_disabled)
                .on_click(move |_, _, cx| {
                    let u = item_for_toggle.clone();
                    v_toggle.update(cx, |this, cx| this.toggle_active(u, cx));
                })
        })
        .child(
            Button::new("account-user-edit")
                .outline()
                .small()
                .label("编辑")
                .on_click(move |_, _, cx| {
                    let u = item_for_edit.clone();
                    v_edit.update(cx, |this, cx| this.open_edit(u, cx));
                }),
        )
        .child(
            Button::new("account-user-reset-password")
                .outline()
                .small()
                .label("重置密码")
                .on_click(move |_, _, cx| {
                    let u = item_for_reset.clone();
                    v_reset.update(cx, |this, cx| this.open_reset_password(u, cx));
                }),
        )
        .child(
            Button::new("account-user-delete")
                .outline()
                .small()
                .label("删除")
                .disabled(protected)
                .on_click(move |_, _, cx| {
                    let u = item_for_delete.clone();
                    v_delete.update(cx, |this, cx| this.open_delete_confirm(u, cx));
                }),
        )
        .when(protected, |this| {
            this.child(
                div()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child("保护账号不可停用 / 删除"),
            )
        })
        .into_any_element()
}

// ---------------------------------------------------------------------------
// 模态层（创建 / 编辑 / 改密 / 删除确认）
// ---------------------------------------------------------------------------

/// 模态覆盖层
fn render_modal_overlay(
    this: &AccountManagementView,
    cx: &Context<AccountManagementView>,
    view: &Entity<AccountManagementView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let overlay = div()
        .id("account-management-modal-overlay")
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .bg(gpui::hsla(0., 0., 0., 0.35));

    match &this.open_dialog {
        Some(dialog) => overlay
            .child(match dialog {
                OpenDialog::Create { role } => render_create_dialog(this, *role, view, cx, theme),
                OpenDialog::Edit { user, role } => {
                    render_edit_dialog(this, user, *role, view, cx, theme)
                }
                OpenDialog::ResetPassword { user } => {
                    render_reset_dialog(this, user, view, cx, theme)
                }
                OpenDialog::DeleteConfirm { user } => render_delete_confirm(user, view, theme),
            })
            .into_any_element(),
        None => overlay.into_any_element(),
    }
}

/// 字段标签
fn field_label(theme: &AppTheme, text: &str) -> gpui::AnyElement {
    div()
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
        .mt_1()
        .text_color(theme.text_secondary)
        .child(text.to_string())
        .into_any_element()
}

/// 错误提示块（对话框内）
fn dialog_error_block(theme: &AppTheme, error: &Option<String>) -> gpui::AnyElement {
    let empty = div();
    match error {
        Some(msg) => div()
            .rounded(px(theme.radius))
            .bg(theme.danger_soft)
            .px_3()
            .py_2()
            .text_sm()
            .text_color(theme.danger)
            .child(msg.clone())
            .into_any_element(),
        None => empty.into_any_element(),
    }
}

/// 角色属性分段选择（三档 pill；对齐 web Select 的选项集）
fn role_segmented(
    theme: &AppTheme,
    id_prefix: &'static str,
    current: UserRoleType,
    view: &Entity<AccountManagementView>,
) -> gpui::AnyElement {
    let options = [
        UserRoleType::Admin,
        UserRoleType::Operator,
        UserRoleType::Businessdev,
    ];
    h_flex()
        .id(SharedString::from(format!("{id_prefix}-roles")))
        .gap_1()
        .children(options.into_iter().map(|role| {
            let view = view.clone();
            let selected = role == current;
            div()
                .id(SharedString::from(format!(
                    "{id_prefix}-role-{}",
                    role.as_str()
                )))
                .px_2p5()
                .py_1()
                .text_sm()
                .rounded(px(theme.radius))
                .border_1()
                .cursor(CursorStyle::PointingHand)
                .when(selected, |this| {
                    this.border_color(theme.accent.opacity(0.5))
                        .bg(theme.accent_soft)
                        .text_color(theme.accent)
                        .font_weight(FontWeight::MEDIUM)
                })
                .when(!selected, |this| {
                    this.border_color(theme.separator)
                        .text_color(theme.text_secondary)
                        .hover(|this| this.bg(theme.muted_fill).text_color(theme.text_primary))
                })
                .child(role_type_label(role))
                .on_mouse_up(gpui::MouseButton::Left, move |_, _window, cx| {
                    view.update(cx, |this, cx| this.set_dialog_role(role, cx));
                })
        }))
        .into_any_element()
}

/// 新增账号对话框（名称 / 姓名 / 邮箱 / 初始密码 / 角色）
fn render_create_dialog(
    this: &AccountManagementView,
    role: UserRoleType,
    view: &Entity<AccountManagementView>,
    _cx: &Context<AccountManagementView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let v_cancel = view.clone();
    let v_save = view.clone();
    let saving = this.busy;
    let error = this.dialog_error.clone();

    v_flex()
        .id("account-create-dialog")
        .w(px(460.))
        .max_h(px(640.))
        .overflow_y_scroll()
        .gap_3()
        .p_5()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(
            div()
                .text_base()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_primary)
                .child("新增账号"),
        )
        .child(
            div()
                .text_sm()
                .text_color(theme.text_muted)
                .child("创建新用户并指定角色属性和权限级别。"),
        )
        .child(field_label(theme, "名称"))
        .when_some(this.create_name_input.clone(), |this, input| {
            this.child(Input::new(&input))
        })
        .child(field_label(theme, "姓名"))
        .when_some(this.create_full_name_input.clone(), |this, input| {
            this.child(Input::new(&input))
        })
        .child(field_label(theme, "邮箱"))
        .when_some(this.create_email_input.clone(), |this, input| {
            this.child(Input::new(&input))
        })
        .child(field_label(theme, "初始密码"))
        .when_some(this.create_password_input.clone(), |this, input| {
            this.child(Input::new(&input))
        })
        .child(field_label(theme, "角色属性"))
        .child(role_segmented(theme, "create", role, view))
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .child(if role == UserRoleType::Admin {
                    "管理员拥有系统全局权限。"
                } else {
                    "选择用户的业务角色属性。"
                }),
        )
        .when_some(error, |this, msg| {
            this.child(dialog_error_block(theme, &Some(msg)))
        })
        .child(
            h_flex()
                .gap_2()
                .justify_end()
                .pt_1()
                .child(
                    Button::new("account-create-cancel")
                        .outline()
                        .small()
                        .label("取消")
                        .disabled(saving)
                        .on_click(move |_, _, cx| {
                            v_cancel.update(cx, |this, cx| this.close_dialog(cx));
                        }),
                )
                .child(
                    Button::new("account-create-save")
                        .primary()
                        .small()
                        .label(if saving {
                            "创建中..."
                        } else {
                            "创建账号"
                        })
                        .disabled(saving)
                        .on_click(move |_, _, cx| {
                            v_save.update(cx, |this, cx| this.submit_create(cx));
                        }),
                ),
        )
        .into_any_element()
}

/// 编辑账号对话框（运营姓名 + 角色属性）
fn render_edit_dialog(
    this: &AccountManagementView,
    user: &AdminUserItem,
    role: UserRoleType,
    view: &Entity<AccountManagementView>,
    _cx: &Context<AccountManagementView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let v_cancel = view.clone();
    let v_save = view.clone();
    let saving = this.busy;
    let error = this.dialog_error.clone();

    v_flex()
        .id("account-edit-dialog")
        .w(px(440.))
        .max_h(px(560.))
        .overflow_y_scroll()
        .gap_3()
        .p_5()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(
            div()
                .text_base()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_primary)
                .child("编辑账号"),
        )
        .child(
            div()
                .text_sm()
                .text_color(theme.text_muted)
                .child(SharedString::from(format!(
                    "修改 {}（{}）的姓名和角色属性。",
                    user.display_name(),
                    user.email
                ))),
        )
        .child(field_label(theme, "运营姓名"))
        .when_some(this.edit_name_input.clone(), |this, input| {
            this.child(Input::new(&input))
        })
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .child("工厂账号请务必填写，与调研分析权限控制相关"),
        )
        .child(field_label(theme, "角色属性"))
        .child(role_segmented(theme, "edit", role, view))
        .when_some(error, |this, msg| {
            this.child(dialog_error_block(theme, &Some(msg)))
        })
        .child(
            h_flex()
                .gap_2()
                .justify_end()
                .pt_1()
                .child(
                    Button::new("account-edit-cancel")
                        .outline()
                        .small()
                        .label("取消")
                        .disabled(saving)
                        .on_click(move |_, _, cx| {
                            v_cancel.update(cx, |this, cx| this.close_dialog(cx));
                        }),
                )
                .child(
                    Button::new("account-edit-save")
                        .primary()
                        .small()
                        .label(if saving { "保存中..." } else { "保存" })
                        .disabled(saving)
                        .on_click(move |_, _, cx| {
                            v_save.update(cx, |this, cx| this.submit_edit(cx));
                        }),
                ),
        )
        .into_any_element()
}

/// 重置密码对话框
fn render_reset_dialog(
    this: &AccountManagementView,
    user: &AdminUserItem,
    view: &Entity<AccountManagementView>,
    _cx: &Context<AccountManagementView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let v_cancel = view.clone();
    let v_save = view.clone();
    let saving = this.busy;
    let error = this.dialog_error.clone();

    v_flex()
        .id("account-reset-dialog")
        .w(px(400.))
        .gap_3()
        .p_5()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(
            div()
                .text_base()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_primary)
                .child("重置密码"),
        )
        .child(
            div()
                .text_sm()
                .line_height(px(18.))
                .text_color(theme.text_muted)
                .child(SharedString::from(format!(
                    "为账号 {} 设置新密码（至少 {PASSWORD_MIN_LEN} 位）。重置后该账号全部登录会话将被吊销。",
                    user.email
                ))),
        )
        .child(field_label(theme, "新密码"))
        .when_some(this.reset_password_input.clone(), |this, input| {
            this.child(Input::new(&input))
        })
        .when_some(error, |this, msg| {
            this.child(dialog_error_block(theme, &Some(msg)))
        })
        .child(
            h_flex()
                .gap_2()
                .justify_end()
                .pt_1()
                .child(
                    Button::new("account-reset-cancel")
                        .outline()
                        .small()
                        .label("取消")
                        .disabled(saving)
                        .on_click(move |_, _, cx| {
                            v_cancel.update(cx, |this, cx| this.close_dialog(cx));
                        }),
                )
                .child(
                    Button::new("account-reset-save")
                        .primary()
                        .small()
                        .label(if saving { "提交中..." } else { "确认重置" })
                        .disabled(saving)
                        .on_click(move |_, _, cx| {
                            v_save.update(cx, |this, cx| this.submit_reset_password(cx));
                        }),
                ),
        )
        .into_any_element()
}

/// 删除确认对话框
fn render_delete_confirm(
    user: &AdminUserItem,
    view: &Entity<AccountManagementView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let v_ok = view.clone();
    let v_cancel = view.clone();
    v_flex()
        .id("account-delete-dialog")
        .w(px(400.))
        .gap_4()
        .p_5()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(
            div()
                .text_base()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_primary)
                .child("删除账号"),
        )
        .child(
            div()
                .text_sm()
                .line_height(px(18.))
                .text_color(theme.text_muted)
                .child(SharedString::from(format!(
                    "确定要删除账号 {}（{}）吗？此操作不可恢复。",
                    user.display_name(),
                    user.email
                ))),
        )
        .child(
            h_flex()
                .gap_2()
                .justify_end()
                .child(
                    Button::new("account-delete-cancel")
                        .outline()
                        .small()
                        .label("取消")
                        .on_click(move |_, _, cx| {
                            v_cancel.update(cx, |this, cx| this.close_dialog(cx));
                        }),
                )
                .child(
                    Button::new("account-delete-ok")
                        .danger()
                        .small()
                        .label("确认删除")
                        .on_click(move |_, _, cx| {
                            v_ok.update(cx, |this, cx| this.run_delete(cx));
                        }),
                ),
        )
        .into_any_element()
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_constant_matches_sidebar() {
        assert_eq!(
            ACCOUNT_MANAGEMENT_URL,
            "/dashboard/system/account-management"
        );
        assert!(gui_domain::sidebar::sidebar_groups()
            .iter()
            .flat_map(|g| g.items.iter())
            .any(|item| item.url == ACCOUNT_MANAGEMENT_URL));
    }

    #[test]
    fn password_min_len_aligns_with_web_and_backend() {
        assert_eq!(PASSWORD_MIN_LEN, 8);
    }

    #[test]
    fn beijing_time_handles_empty_bad_and_offset() {
        assert_eq!(beijing_time(""), "—");
        assert_eq!(beijing_time("   "), "—");
        assert_eq!(
            beijing_time("2026-08-20T06:23:00+00:00"),
            "2026-08-20 14:23"
        );
        // 解析失败回退原文（不吞内容）
        assert_eq!(beijing_time("not-a-date"), "not-a-date");
    }

    #[test]
    fn create_validation_follows_web_required_rules() {
        // 名称必填
        assert_eq!(
            validate_create_input("", "a@b.c", "password8").unwrap_err(),
            "请输入名称"
        );
        // 邮箱必填且含 @
        assert_eq!(
            validate_create_input("n", "", "password8").unwrap_err(),
            "请输入有效邮箱"
        );
        assert_eq!(
            validate_create_input("n", "no-at-sign", "password8").unwrap_err(),
            "请输入有效邮箱"
        );
        // 密码 ≥8 位
        assert_eq!(
            validate_create_input("n", "a@b.c", "pass123").unwrap_err(),
            "初始密码至少 8 位"
        );
        // 合法 + trim 归一
        let (n, e, p) = validate_create_input("  n ", " a@B.c ", "password8").expect("合法");
        assert_eq!((n.as_str(), e.as_str()), ("n", "a@B.c"));
        assert_eq!(p, "password8");
    }

    #[test]
    fn reset_password_validation_enforces_min_length() {
        assert!(validate_password("short12").is_err());
        assert_eq!(validate_password("newpass123").expect("合法"), "newpass123");
    }
}

#[cfg(test)]
mod gpui_tests {
    use super::*;

    /// 构造测试账号
    fn sample_user(id: &str, name: &str, email: &str, active: bool) -> AdminUserItem {
        AdminUserItem {
            id: id.into(),
            name: name.into(),
            email: email.into(),
            full_name: None,
            operator_name_zh: None,
            is_admin: false,
            is_active: active,
            role_type: UserRoleType::Operator,
            created_at: "2026-08-01T00:00:00+00:00".into(),
            updated_at: "2026-08-20T06:23:00+00:00".into(),
        }
    }

    /// 构造一个 dummy client（无有效 base_url；仅构造视图用）
    fn dummy_client() -> Client {
        Client::new("http://127.0.0.1:1")
    }

    /// 渲染冒烟：亮 / 暗主题下视图可构建 + 默认 Loading 态 + 对话框可开关
    #[gpui::test]
    async fn renders_loading_state_in_light_and_dark(cx: &mut gpui::TestAppContext) {
        for dark in [false, true] {
            cx.update(|cx| {
                gpui_component::init(cx);
                crate::theme::set_theme_pref(
                    if dark {
                        crate::theme::ThemePreference::Dark
                    } else {
                        crate::theme::ThemePreference::Light
                    },
                    None,
                    cx,
                );
            });
            let (view, cx2) =
                cx.add_window_view(|_window, cx| AccountManagementView::new(cx, dummy_client()));
            view.update(cx2, |this, cx| {
                assert_eq!(this.current_state(), &UserListState::Loading);

                // 对话框开关链路（渲染层覆盖见下方 loaded 态冒烟）
                this.open_create(cx);
                assert!(matches!(this.open_dialog, Some(OpenDialog::Create { .. })));
                this.set_dialog_role(UserRoleType::Businessdev, cx);
                assert!(matches!(
                    this.open_dialog,
                    Some(OpenDialog::Create {
                        role: UserRoleType::Businessdev
                    })
                ));
                this.close_dialog(cx);
                assert!(this.open_dialog.is_none());
            });
            cx2.read(|app| {
                assert_eq!(
                    crate::theme::AppTheme::current(app).is_dark(),
                    dark,
                    "主题切换生效"
                );
            });
        }
    }

    /// Loaded 态注入 + 保护账号守卫（本地拦截不发请求）+ Empty/Error 落点
    #[gpui::test]
    async fn list_states_and_protected_account_guards(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| AccountManagementView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            // Loaded 注入
            this.users = vec![
                sample_user("u-yawei", "yawei", "yawei@believeboy.com", true),
                sample_user("u-ops", "运营甲", "ops@believeboy.com", false),
            ];
            this.users_state = UserListState::Loaded;
            assert_eq!(this.users.len(), 2);

            // 保护账号本地拦截：停用被拒并出提示，不发请求
            let yawei = this.users[0].clone();
            this.toggle_active(yawei.clone(), cx);
            assert_eq!(
                this.notice,
                Some((true, "Yawei 账号不允许停用".to_string()))
            );
            // 保护账号删除入口双保险拦截
            this.open_delete_confirm(yawei, cx);
            assert!(this.open_dialog.is_none());
            assert!(this
                .users
                .iter()
                .all(|u| u.id == "u-yawei" || u.id == "u-ops"));

            // 普通账号可进删除确认
            let ops = this.users[1].clone();
            this.open_delete_confirm(ops, cx);
            assert!(matches!(
                this.open_dialog,
                Some(OpenDialog::DeleteConfirm { .. })
            ));
            this.close_dialog_inner();

            // Empty / Error 落点语义
            this.users.clear();
            this.users_state = UserListState::Empty;
            assert!(this.users.is_empty());
            this.users_state = UserListState::Error("boom".into());
            assert_eq!(this.current_state(), &UserListState::Error("boom".into()));
        });
    }
}
