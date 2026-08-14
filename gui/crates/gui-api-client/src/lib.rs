//! BelieveBoy GUI 后端 API 客户端
//!
//! 约束：
//! - 所有端点必须与 `backend/app/api/v1/...` 下的 FastAPI 定义 1:1 对应
//! - 鉴权：所有方法通过 `Client::with_bearer(token)` 或登录后自动持有
//! - 错误：业务层错误用 `ApiError`，基础设施错误用 `anyhow`
//!
//! 模块划分按 sidebar 一级分类：
//! - `dashboard`   首页
//! - `auth`        登录 / token 刷新（domain crate 不涉及，所以放这里）
//! - 其余一级分类对应同名模块

pub mod client;
pub mod error;
pub mod auth;
pub mod dashboard;

// 常用类型在 crate 根暴露，避免 `gui_api_client::client::Client` 这种深路径
pub use client::{Client, ClientConfig};
