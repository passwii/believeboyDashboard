//! GUI 视图层
//!
//! - `login`      登录小窗口（GUI-2 / 0.2）
//! - `root`       主窗口根视图：六区外壳（Rail/Sub-Nav/控制条/Canvas/Inspector/Footer）
//!   + 视图分发（BLF-793 起平铺分区框架；GUI-3 / 0.3 起）
//! - `shell`      外壳六区尺寸常量集中管理（BLF-793）
//! - `master_rail` 左侧 Master Rail 主图标栏（BLF-793，绑定 gui-domain::sidebar 8 组）
//! - `sub_nav`     Sub-Nav 子导航列：可折叠 180~220px 模块选择器（BLF-794，
//!   数据权威在 gui-domain::sidebar，替换 Stage2 遗留 sidebar）
//! - `inspector`   右侧 Inspector 上下文抽屉：Cmd+B 自适应三态内容（BLF-796，
//!   280~340px 拖拽调宽；运营/广告/Copilot 三态经 mode_for_view 注册表声明）
//! - `command_palette` ⌘K 全局命令面板（BLF-794，检索全部 52 个子模块）
//! - `dashboard`  Dashboard 视图状态机（GUI-6 / 1.0-a；GUI-7 数字带、GUI-8 图表占位卡、
//!   GUI-9 Top 项目列表均已接入）
//! - `auto_upload` 报表中心 → 报表自动化（P5-4，RPA 自动上传状态矩阵，只读查看）
//! - `stat_band`  Dashboard 数字带（GUI-7 / 1.0-b，frontend v2-stats 的 GPUI 等价）
//! - `site_navigation` 站点导航（GUI-12 / 2.0，静态数据，点击卡片默认浏览器打开）
//! - `daily_analysis` 运营 → 销售数据（P3-1，四态状态机 + 项目/国家筛选 + 明细/下钻表）
//! - `placeholder`占位内容视图
//!
//! 后续每个 sidebar 子项对应一个真实 View，按 frontend sidebar 顺序推进。
//!
//! > GUI-7 起 `dashboard` 挂载到 root.rs：作为「sidebar 之外的着陆页」在启动时默认
//! > 显示（对齐 Web /dashboard 首页），侧栏选中任意项后切换到对应占位视图。
pub mod ad_analysis;
pub mod ad_data;
pub mod account_management;
pub mod agent_management;
pub mod ai_chat;
pub mod auto_upload;
pub mod command_palette;
pub mod commission;
pub mod crm_audit;
pub mod crm_dashboard;
pub mod crm_follow_ups;
pub mod daily_analysis;
pub mod dashboard;
pub mod exchange_rate;
pub mod inspector;
pub mod inventory_analysis;
pub mod inventory_ledger;
pub mod login;
pub mod markdown_to_word;
pub mod master_rail;
pub mod model_selection;
pub mod monthly_report;
pub mod new_product_calculation;
pub mod order_info;
pub mod placeholder;
pub mod platform_inspection;
pub mod platform_inspection_edit;
pub mod platform_revenue;
pub mod portfolio_overview;
pub mod product_analysis;
pub mod project_goals;
pub mod replenishment;
pub mod research_analysis;
pub mod return_analysis;
pub mod root;
pub mod scheduled_reports;
pub mod seasonal_replenishment;
pub mod shell;
pub mod shipment_management;
pub mod shop_calculation;
pub mod site_navigation;
pub mod stat_band;
pub mod store_navigation;
pub mod sub_nav;
pub mod system_logs;
pub mod vat_invoice;
pub mod weekly_product_analysis;
