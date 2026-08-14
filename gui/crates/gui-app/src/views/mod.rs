//! GUI 视图层
//!
//! - `login`      登录小窗口（GUI-2 / 0.2）
//! - `root`       主窗口根视图：会话栏 + 侧栏 + 内容区（GUI-3 / 0.3 + GUI-2 会话）
//! - `sidebar`    侧栏（8 大分类 52 子项，数据权威在 gui-domain::sidebar）
//! - `dashboard`  Dashboard 视图状态机（GUI-6 / 1.0-a，数字带/图表在 GUI-7/8/9 接入）
//! - `placeholder`占位内容视图
//!
//! 后续每个 sidebar 子项对应一个真实 View，按 frontend sidebar 顺序推进。
//!
//! > `dashboard` 模块暂未挂载到 root.rs（GUI-7 起接入），先允许 dead_code；
//! > 沿用 root.rs 对 SessionInfo.client 的先行交付惯例。

// GUI-7 起 root.rs 将按侧栏「数据看板」选中项替换 PlaceholderView 为本视图
#[allow(dead_code)]
pub mod dashboard;
pub mod login;
pub mod placeholder;
pub mod root;
pub mod sidebar;
