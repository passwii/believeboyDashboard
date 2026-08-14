//! 应用入口
//!
//! 启动流程：
//! 1. 初始化 tracing
//! 2. 读环境配置（api_base / token）
//! 3. 启动 GPUI 应用，进入登录窗口或主窗口
//!
//! 阶段 0.1 骨架：只展示一个 placeholder 窗口，证明 GPUI 跑通；
//! 鉴权、实际视图在后续 issue 实现。

use std::env;

use tracing_subscriber::EnvFilter;

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

    // 4. 启动 GPUI 应用（具体实现在后续 issue）
    let _client = gui_api_client::Client::new(&api_base);

    // 0.1 阶段：先打一条启动日志退出，证明 workspace / GPUI 依赖链 OK
    tracing::info!("GUI workspace 骨架已就位（0.1）— 实际窗口在 issue 0.2/1.0 接入");
    Ok(())
}
