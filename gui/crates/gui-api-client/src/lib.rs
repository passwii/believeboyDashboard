//! BelieveBoy GUI 后端 API 客户端
//!
//! 约束：
//! - 所有端点必须与 `backend/app/api/v1/...` 下的 FastAPI 定义 1:1 对应
//! - 鉴权：所有方法通过 `Client::with_session(...)` 或登录后自动持有会话
//!   （`X-User-Id` / `X-User-Email` / `X-Session-Id` 头，后端会话模型，非 JWT）
//! - 错误：业务层错误用 `ApiError`，基础设施错误用 `anyhow`
//!
//! 模块划分按 sidebar 一级分类：
//! - `dashboard`   首页
//! - `auth`        登录 / 会话校验（domain crate 不涉及，所以放这里）
//! - 其余一级分类对应同名模块

pub mod advertising;
pub mod auth;
pub mod client;
pub mod dashboard;
pub mod error;
pub mod monthly_reports;
pub mod platform_revenues;
pub mod portfolio;
pub mod project_goals;
pub mod query;
pub mod return_analysis;
pub mod scheduled_reports;
pub mod store_navigation;

// 常用类型在 crate 根暴露，避免 `gui_api_client::client::Client` 这种深路径
pub use client::{Client, ClientConfig};
