//! GUI 视图层
//!
//! - `login`      登录小窗口（GUI-2 / 0.2）
//! - `root`       主窗口根视图：会话栏 + 侧栏 + 内容区（GUI-3 / 0.3 + GUI-2 会话）
//! - `sidebar`    侧栏（8 大分类 52 子项，数据权威在 gui-domain::sidebar）
//! - `dashboard`  Dashboard 视图状态机（GUI-6 / 1.0-a；GUI-7 数字带、GUI-8 图表占位卡、
//!   GUI-9 Top 项目列表均已接入）
//! - `stat_band`  Dashboard 数字带（GUI-7 / 1.0-b，frontend v2-stats 的 GPUI 等价）
//! - `site_navigation` 站点导航（GUI-12 / 2.0，静态数据，点击卡片默认浏览器打开）
//! - `daily_analysis` 运营-销售数据（P3-1 / BLF-701，四态状态机 + 筛选 + 维度下钻 + 明细表）
//! - `placeholder`占位内容视图
//!
//! 后续每个 sidebar 子项对应一个真实 View，按 frontend sidebar 顺序推进。
//!
//! > GUI-7 起 `dashboard` 挂载到 root.rs：作为「sidebar 之外的着陆页」在启动时默认
//! > 显示（对齐 Web /dashboard 首页），侧栏选中任意项后切换到对应占位视图。
pub mod daily_analysis;
pub mod dashboard;
pub mod login;
pub mod placeholder;
pub mod root;
pub mod sidebar;
pub mod site_navigation;
pub mod stat_band;
