//! 应用入口
//!
//! 启动流程：
//! 1. 初始化 tracing
//! 2. 读环境配置（api_base / token）
//! 3. 启动 GPUI 应用，打开主窗口（左侧侧栏 + 右侧内容区）
//!
//! 阶段 0.1 骨架：只证明 workspace / GPUI 依赖链跑通；
//! 阶段 0.3：主窗口接入侧栏（8 大分类 52 子项，数据来自 gui-domain::sidebar），
//! 点击子项 → 内容区切换到对应占位 View。鉴权与真实页面在后续 issue 实现。

mod views;

use std::env;

use gpui::{
    actions, prelude::*, App, Application, Bounds, Context, Entity, KeyBinding, Window,
    WindowBounds, WindowOptions, div, px, rgb, size,
};
use tracing_subscriber::EnvFilter;

use gui_domain::sidebar::sidebar_groups;

use views::placeholder::PlaceholderView;
use views::sidebar::{SidebarEvent, SidebarView};

actions!(gui_app, [Quit]);

/// 根视图：左侧侧栏 + 右侧内容区（两栏布局）
struct RootView {
    sidebar: Entity<SidebarView>,
    content: Entity<PlaceholderView>,
}

impl RootView {
    fn new(cx: &mut Context<Self>) -> Self {
        // 启动时默认选中第一个子项（运营 → 站点导航），内容区立即显示对应占位 View
        let initial = sidebar_groups()
            .first()
            .and_then(|group| group.items.first())
            .cloned();
        let (initial_title, initial_url) = match &initial {
            Some(item) => (item.title.clone(), item.url.clone()),
            None => ("欢迎使用 BelieveBoy GUI".into(), "从左侧选择一个功能入口".into()),
        };

        let sidebar = cx.new(|cx| SidebarView::new(initial.as_ref().map(|i| i.url.as_str()), cx));
        let content = cx.new(|_| PlaceholderView::new(&initial_title, &initial_url));

        // 侧栏选中变化 → 内容区切换到对应占位 View
        cx.subscribe(&sidebar, |this, _sidebar, event, cx| {
            let SidebarEvent::Select { url, title } = event;
            this.content.update(cx, |content, cx| {
                content.title = title.clone();
                content.url = url.clone();
                cx.notify();
            });
            cx.notify();
        })
        .detach();

        Self { sidebar, content }
    }
}

impl Render for RootView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("root")
            .flex()
            .size_full()
            .bg(rgb(0xfafafa))
            .child(self.sidebar.clone())
            .child(
                div()
                    .id("content")
                    .flex_1()
                    .h_full()
                    .child(self.content.clone()),
            )
    }
}

fn main() -> anyhow::Result<()> {
    // 1. .env（仅本地开发）
    let _ = dotenvy::dotenv();

    // 2. tracing
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_target(false)
        .init();

    // 3. 读 api_base
    let api_base = env::var("BELIEVEBOY_API_BASE")
        .unwrap_or_else(|_| "https://api.believeboy.com".to_string());
    tracing::info!(api_base, "believeboy-gui 启动中");

    // 4. 后端客户端（后续鉴权 / 数据接口使用；0.3 阶段侧栏为纯硬编码，暂不发起请求）
    let _client = gui_api_client::Client::new(&api_base);

    // 5. 启动 GPUI 主窗口（左侧侧栏 + 右侧内容区）
    Application::new().run(|cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1280.0), px(800.0)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            |_, cx| cx.new(RootView::new),
        )
        .expect("打开主窗口失败");

        cx.activate(true);
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.bind_keys([KeyBinding::new("cmd-q", Quit, None)]);
    });

    Ok(())
}
