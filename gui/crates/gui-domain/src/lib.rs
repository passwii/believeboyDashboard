//! BelieveBoy GUI 领域类型层
//!
//! 约定：
//! - 本 crate **不允许** 引入任何 IO / 网络 / GUI 依赖
//! - 所有类型必须 `serde::Serialize + serde::Deserialize`（与 FastAPI JSON 互通）
//! - 字段命名沿用后端 Pydantic 模型（snake_case），便于 1:1 映射
//! - 时间统一用 `chrono::DateTime<Utc>`；日期用 `chrono::NaiveDate`
//!
//! 模块划分按 sidebar 一级分类：
//! - `dashboard`   首页（KPI / 趋势 / 项目 / 国家 / 库存 / 流量）
//! - `operations`  运营
//! - `reports`     报表中心
//! - `finance`     财务资金
//! - `advertising` 广告
//! - `ai`          AI 智能
//! - `crm`         CRM 客户与合作伙伴
//! - `tools`       工具箱
//! - `system`      系统管理

pub mod ai_chat;
pub mod auth;
pub mod advertising;
pub mod auto_upload;
pub mod commission;
pub mod common;
pub mod crm;
pub mod filter;
pub mod dashboard;
pub mod exchange_rate;
pub mod finance;
pub mod operations;
pub mod order_info;
pub mod reports;
pub mod scheduled_reports;
pub mod sidebar;
pub mod system_management;
pub mod vat_invoice;
