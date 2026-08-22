//! 应用入口（窗口协调器）
//!
//! 启动流程：
//! 1. 初始化 tracing / 读 api_base
//! 2. 读 Keychain（service=believeboy-gui）：
//!    - 有会话 → 直接打开主窗口（侧栏 + 内容区），后台 `me()` 校验（401 → 清 Keychain 回登录窗）
//!    - 无会话 → 打开登录小窗口（440×560）
//! 3. 登录成功 → 存 Keychain → 关登录窗、开主窗口
//! 4. 主窗口点「退出登录」→ 清 Keychain → 关主窗、回登录窗

mod assets;
mod icon;
mod keychain;
mod motion;
mod runtime;
mod theme;
mod views;
mod widgets;

use std::{cell::RefCell, env, rc::Rc};

use gpui::prelude::*;
use gpui::{
    App, Application, Bounds, Entity, Focusable, KeyBinding, TitlebarOptions, WindowBounds,
    WindowKind, WindowOptions, actions, px, size,
};
use gpui_component::{Root, TitleBar};
use tracing_subscriber::EnvFilter;

use assets::AppAssets;
use gui_api_client::Client;
use gui_api_client::client::AuthSession;
use gui_domain::auth::LoginResponse;
use motion::{MotionPref, detect_system_reduce_motion};
use theme::{ThemePreference, set_theme_pref};

use views::login::{LoginView, LoginViewEvent};
use views::root::{RootView, RootViewEvent, SessionInfo};

actions!(gui_app, [Quit]);

fn main() -> anyhow::Result<()> {
    // 1. .env（仅本地开发）
    let _ = dotenvy::dotenv();

    // 2. tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    // 3. 读 api_base + api_key（README 契约：BELIEVEBOY_API_BASE / BELIEVEBOY_TOKEN）
    //    默认 api_base 指向生产后端 dash-api.believeboy.com（api.believeboy.com 是
    //    另一套 AI 网关，非 dashboard 后端，GUI-11 冒烟实测确认）
    let api_base = env::var("BELIEVEBOY_API_BASE")
        .unwrap_or_else(|_| "https://dash-api.believeboy.com".to_string());
    let api_key = env::var("BELIEVEBOY_TOKEN").ok();
    tracing::info!(
        api_base,
        api_key_present = api_key.is_some(),
        "believeboy-gui 启动中"
    );

    // 4. 启动 GPUI 应用
    Application::new()
        .with_assets(AppAssets)
        .run(move |cx: &mut App| {
            // 初始化 gpui-component（主题系统 + 全局状态；GUI-6 起 Dashboard 视图的
            // Skeleton / Spinner / Alert / Icon 依赖其语义色板与全局单例）
            gpui_component::init(cx);

            // P2-2（BLF-689）：主题偏好基线——默认跟随系统；窗口外观监听在
            // open_*_window 内注册（on_window_appearance_changed），系统切亮/暗时
            // 无感跟随。显式浅色/深色由标题栏外观菜单写入本全局。
            set_theme_pref(ThemePreference::FollowSystem, None, cx);

            // P4-2（BLF-708）：动效偏好基线——启动时读取系统「减弱动态效果」，
            // 写入全局；所有动效路径据此降级为瞬时切换/无动画。
            cx.set_global(MotionPref(detect_system_reduce_motion()));

            // 登录窗 / 主窗口的文本输入、菜单、窗口级按键绑定：
            // - 文本输入（gpui-component Input，上下文 "Input"）由 gpui_component::init 注册
            // - 全局退出：cmd-q
            cx.bind_keys([KeyBinding::new("cmd-q", Quit, None)]);
            cx.on_action(|_: &Quit, cx| cx.quit());

            // 启动：有会话 → 主窗口；无 → 登录窗口
            let client = Client::new(&api_base);
            let client = match &api_key {
                Some(key) => client.with_api_key(key),
                None => client,
            };
            match keychain::load_session() {
                Ok(Some(resp)) => {
                    // BLF-787：恢复会话时同步恢复登录下发的专属 API key——业务路由
                    // `require_api_key` 需要 Bearer 凭据，否则重启后业务模块全 401。
                    let client = if resp.api_key.is_empty() {
                        client
                    } else {
                        client.with_api_key(resp.api_key.clone())
                    };
                    let authed = client.with_session(AuthSession::from_login(&resp));
                    open_main_window(cx, authed, resp, None);
                }
                Ok(None) => open_login_window(cx, client, None),
                Err(msg) => open_login_window(
                    cx,
                    client,
                    Some(format!("钥匙串读取失败：{msg}（本次不自动登录）")),
                ),
            }
        });

    Ok(())
}

/// 打开登录小窗口（440×560）。登录成功 → 存 Keychain → 关本窗开主窗。
///
/// P2-5（BLF-692）：窗口首层改为 gpui-component `Root`（`Root::new`）——登录表单的
/// `Input` 组件在聚焦时通过 `Root::read` 跟踪 focused_input，窗口根必须是 Root；
/// Root 在 macOS 下只是透明包装（server decorations，无额外绘制），视觉不变。
/// 主窗口不加 Root：其 `RootView` 根容器不画不透明背景以透出 P2-3 的系统模糊材质，
/// 而 Root 会铺一层不透明 theme.background，两者冲突。
fn open_login_window(cx: &mut App, client: Client, initial_error: Option<String>) {
    let bounds = Bounds::centered(None, size(px(440.0), px(560.0)), cx);
    let login_view: Rc<RefCell<Option<Entity<LoginView>>>> = Default::default();
    let window = cx
        .open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some("BelieveBoy GUI".into()),
                    appears_transparent: false,
                    traffic_light_position: None,
                }),
                kind: WindowKind::Normal,
                is_resizable: false,
                ..Default::default()
            },
            |window, cx| {
                let view = cx.new(|cx| LoginView::new(cx, client, initial_error));
                *login_view.borrow_mut() = Some(view.clone());
                cx.new(|cx| Root::new(view, window, cx))
            },
        )
        .expect("打开登录窗口失败");

    let login = login_view.borrow().clone().expect("登录窗口根视图");

    // P2-2：监听登录窗口外观变化（跟随系统时同步全局外观并重绘）
    window
        .update(cx, |_, window, cx| {
            login.update(cx, |login, _cx| {
                login.theme_appearance_sub =
                    Some(window.observe_window_appearance(theme::on_window_appearance_changed));
            });
        })
        .ok();

    let login_window = window;

    // 登录成功 → 持久化会话 → 关登录窗 → 开主窗
    cx.subscribe(&login, move |_login, event: &LoginViewEvent, cx| {
        let warning = keychain::save_session(&event.user)
            .err()
            .map(|m| format!("⚠️ 会话未持久化：{m}（重启后需重新登录）"));
        login_window
            .update(cx, |_, window, _| window.remove_window())
            .ok();
        open_main_window(cx, event.client.clone(), event.user.clone(), warning);
    })
    .detach();

    // 初始焦点邮箱框 + 置前（首个渲染内 ensure_inputs 会把焦点交给邮箱 Input）
    window
        .update(cx, |_, window, cx| {
            window.focus(&login.focus_handle(cx));
            cx.activate(true);
        })
        .ok();
}

/// 打开主窗口（1280×800 侧栏 + 内容区）。退出登录 → 清 Keychain → 关本窗开登录窗。
///
/// P2-1（BLF-688）：主窗口改用 gpui-component `TitleBar::title_bar_options()`——
/// `appears_transparent: true` 让系统标题栏透明、traffic lights 定位到 (9,9)，
/// 使红绿灯悬于 RootView 自绘的统一工具栏（TitleBar 组件）之上，实现 macOS 原生
/// unified toolbar 质感。
fn open_main_window(cx: &mut App, client: Client, user: LoginResponse, warning: Option<String>) {
    let session = SessionInfo {
        client: client.clone(),
        user,
        warning,
    };
    let bounds = Bounds::centered(None, size(px(1280.0), px(800.0)), cx);
    let window = cx
        .open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitleBar::title_bar_options()),
                // P4-3（BLF-709）材质收敛：主窗口背景改回不透明（默认）——GPUI 0.2.2
                // 无 NSVisualEffectView 直接接入，`WindowBackgroundAppearance::Blurred`
                // 整窗模糊只能靠侧栏半透明覆盖模拟，观感粗糙且按 gpui 约束禁用亚像素
                // 文字渲染（见 build-gpui-apps references/apple-glass.md Tier 4/6）。
                // 收敛为不透明窗口 + 实色分层（侧栏/内容列各自实色），即 macOS 原生
                // 标准窗口质感，文字渲染也恢复亚像素清晰度。
                // P4-1（BLF-707）：仍保留透明标题栏 + traffic lights(9,9) 悬于侧栏头部。
                // P2-5（BLF-692）：主窗口最小尺寸，避免内容被压到不可用（侧栏折叠态
                // 也保证右侧内容区至少有可读宽度）。
                window_min_size: Some(size(px(960.0), px(640.0))),
                ..Default::default()
            },
            |_, cx| cx.new(|cx| RootView::new(cx, Some(session))),
        )
        .expect("打开主窗口失败");

    // P2-2：监听主窗口外观变化（跟随系统时同步全局外观并重绘，无闪烁）
    window
        .update(cx, |root, window, _cx| {
            root.theme_appearance_sub =
                Some(window.observe_window_appearance(theme::on_window_appearance_changed));
        })
        .ok();

    let root = window
        .update(cx, |_, _, cx| cx.entity())
        .expect("主窗口根视图");
    let main_window = window;

    // 退出登录 → 清 Keychain → 关主窗 → 回登录窗
    let base_client = client.clone();
    cx.subscribe(&root, move |_root, event: &RootViewEvent, cx| {
        if *event == RootViewEvent::Logout {
            let _ = keychain::clear_session();
            main_window
                .update(cx, |_, window, _| window.remove_window())
                .ok();
            open_login_window(cx, base_client.without_session(), None);
        }
    })
    .detach();

    // 初始聚焦侧栏（键盘 ↑/↓ 导航立即可用）
    window
        .update(cx, |root, window, cx| {
            window.focus(&root.sidebar.read(cx).focus_handle(cx));
            cx.activate(true);
        })
        .ok();

    // 后台校验会话：401 → 清 Keychain 回登录窗；网络错 → 主窗口横幅提示（会话仍保留）
    let bg = cx.background_executor().clone();
    let validate_client = client.clone();
    let login_base = client.without_session();
    let validate_window = window;
    cx.spawn(async move |cx: &mut gpui::AsyncApp| {
        let result = bg
            .spawn(async move { crate::runtime::runtime().block_on(validate_client.me()) })
            .await;
        let _ = cx.update(|cx| match result {
            Ok(_) => { /* 会话有效（me() 已刷新 Redis 滑动窗口） */ }
            Err(e) if e.is_unauthorized() => {
                let _ = keychain::clear_session();
                validate_window
                    .update(cx, |_, window, _| window.remove_window())
                    .ok();
                open_login_window(cx, login_base, Some("会话已失效，请重新登录".to_string()));
            }
            Err(e) => {
                let msg = format!("⚠️ 无法连接服务器：{}", e.user_message());
                validate_window
                    .update(cx, |root, _window, cx| root.set_warning(msg, cx))
                    .ok();
            }
        });
    })
    .detach();
}
