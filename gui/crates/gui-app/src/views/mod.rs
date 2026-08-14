//! GUI 视图层
//!
//! - `login`      登录小窗口（GUI-2 / 0.2）
//! - `root`       主窗口根视图：会话栏 + 侧栏 + 内容区（GUI-3 / 0.3 + GUI-2 会话）
//! - `sidebar`    侧栏（8 大分类 52 子项，数据权威在 gui-domain::sidebar）
//! - `placeholder`占位内容视图
//!
//! 后续每个 sidebar 子项对应一个真实 View，按 frontend sidebar 顺序推进。

pub mod login;
pub mod placeholder;
pub mod root;
pub mod sidebar;
