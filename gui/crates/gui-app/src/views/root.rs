//! 主窗口根视图：六区平铺外壳（BLF-793）+ 视图分发
//!
//! **BLF-793 外壳重构**：布局改为父 issue「空间栅格」的零外边距六区栅格——
//! 左 Master Rail（[`crate::views::shell::RAIL_WIDTH`] 图标栏）/ 左二 Sub-Nav 列
//! （BLF-794 起实装可折叠模块选择器 [`crate::views::sub_nav::SubNavView`] + ⌘K
//! 命令面板 [`crate::views::command_palette::CommandPaletteView`]）/ 顶 Console
//! Bar 36px 插槽（BLF-795 四件套筛选条）/ 中央 Canvas / 右 Inspector 抽屉
//! （BLF-796 起实装 Cmd+B 自适应三态内容，见 [`crate::views::inspector`]）/
//! 底 Footer 24px 系统状态栏（BLF-797 起：汇率 ticker / DB 同步 / 未读徽标 /
//! 延迟指标，见 [`crate::views::footer`]）。容器外 padding 0，区间
//! 一律 1px 分隔线；尺寸常量集中在 [`crate::views::shell`]。
//!
//! Rail ↔ 导航绑定：Rail 选中分类 → 默认视图路由（该组第一项，同时把 Sub-Nav
//! 列表切到该分类）；Sub-Nav / ⌘K 面板选中子项 → 反写 Rail 高亮所属分类。
//! 两侧状态唯一权威 = `gui_domain::sidebar` 的 8 组 52 项。Sub-Nav 折叠状态经
//! [`crate::prefs`] 持久化（重启保留）。
//!
//! 历史能力保留：继承 GUI-3（BLF-675）侧栏渲染 / 键盘导航 / 占位内容区，
//! GUI-2（BLF-674）已登录用户信息栏 + 退出登录（emit `RootViewEvent::Logout`，
//! 由 main.rs 清 Keychain 并切回登录窗口），GUI-7（BLF-679）Dashboard 着陆页，
//! GUI-12（BLF-684）起各真实视图懒创建分发（~30 视图整体挂进 Canvas 区）。
//! P2-2（BLF-689）：全视图消费 [`AppTheme`] 语义 token；BLF-792 起应用默认锁定
//! 深色（高密度暗色工具主题）。P4-1（BLF-707）窗口 Chrome 契约保持——透明标题栏
//! + traffic lights(9,9) 悬于最左列之上，头部承担窗口拖拽区。

use gpui::prelude::*;
use gpui::{
    div, px, App, Context, CursorStyle, Entity, EventEmitter, FocusHandle, Focusable, MouseButton,
    MouseMoveEvent, MouseUpEvent, Render, SharedString, Window, WindowControlArea,
};
use gpui_component::breadcrumb::{Breadcrumb, BreadcrumbItem};
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::{ActiveTheme, Icon, IconName, InteractiveElementExt, Sizable};
use gui_api_client::Client;
use gui_domain::auth::LoginResponse;
use gui_domain::sidebar::{breadcrumb_for, group_id_for_url, sidebar_groups};

use crate::theme::{hex_color, AppTheme};
use crate::views::ad_analysis::{AdAnalysisEvent, AdAnalysisView, AD_ANALYSIS_URL};
use crate::widgets::console_bar::{
    console_config_for_url, ConsoleBarEvent, ConsoleBarView, ConsoleFilter, ConsoleStatsEvent,
    DASHBOARD_LANDING_URL,
};
use crate::views::ad_data::{AdDataView, AD_DATA_URL};
use crate::views::account_management::{AccountManagementView, ACCOUNT_MANAGEMENT_URL};
use crate::views::agent_management::{AgentManagementView, AGENT_MANAGEMENT_URL};
use crate::views::ai_chat::{AiChatEvent, AiChatView, AI_CHAT_URL};
use crate::views::ai_insights::{AiInsightsView, AI_INSIGHTS_URL};
use crate::views::customer_service::{CustomerServiceView, CUSTOMER_SERVICE_URL};
use crate::views::virtual_office::{
    VirtualOfficeView, VIRTUAL_OFFICE_URL, DIGITAL_EMPLOYEES_URL,
};
use crate::views::auto_upload::{AutoUploadView, AUTO_UPLOAD_URL};
use crate::views::command_palette::{CommandPaletteEvent, CommandPaletteView};
use crate::views::commission::{CommissionView, COMMISSION_URL};
use crate::views::crm_audit::{CrmAuditView, CRM_AUDIT_URL};
use crate::views::crm_dashboard::{CrmDashboardView, CRM_DASHBOARD_URL};
use crate::views::crm_follow_ups::{CrmFollowUpsView, CRM_FOLLOW_UPS_URL};
// Stage13（BLF-804）：CRM 三页 + 设置 + 工具箱渲染 + 系统管理五页
use crate::views::crm_customers::{CrmCustomersView, CRM_CUSTOMERS_URL};
use crate::views::crm_leads::{CrmLeadsView, CRM_LEADS_URL};
use crate::views::crm_tasks::{CrmTasksView, CRM_TASKS_URL};
use crate::views::crm_settings::{CrmSettingsView, CRM_SETTINGS_URL};
use crate::views::alerts_center::{AlertsCenterView, ALERTS_CENTER_URL};
use crate::views::changelog::{ChangelogView, CHANGELOG_URL};
use crate::views::database_status::{DatabaseStatusView, DATABASE_STATUS_URL};
use crate::views::operator_management::{OperatorManagementView, OPERATOR_MANAGEMENT_URL};
use crate::views::page_render::{PageRenderView, PAGE_RENDER_URL};
use crate::views::project_info::{ProjectInfoView, PROJECT_INFO_URL};
use crate::views::daily_analysis::{DailyAnalysisView, DAILY_ANALYSIS_URL};
use crate::views::sku_info::{SkuInfoView, SKU_INFO_URL};
use crate::views::dashboard::DashboardView;
use crate::views::exchange_rate::{ExchangeRateView, EXCHANGE_RATE_URL};
use crate::views::footer::FooterView;
use crate::views::inventory_analysis::{InventoryAnalysisView, INVENTORY_ANALYSIS_URL};
use crate::views::inventory_ledger::{InventoryLedgerView, INVENTORY_LEDGER_URL};
use crate::views::inspector::{mode_for_view, InspectorEvent, InspectorView};
use crate::views::markdown_to_word::{MarkdownToWordView, MARKDOWN_TO_WORD_URL};
use crate::views::master_rail::{MasterRailEvent, MasterRailView};
use crate::views::model_selection::{ModelSelectionView, MODEL_SELECTION_URL};
use crate::views::monthly_report::{MonthlyReportView, MONTHLY_REPORT_URL};
use crate::views::new_product_calculation::{
    NewProductCalculationView, NEW_PRODUCT_CALCULATION_URL,
};
use crate::views::order_info::{OrderInfoView, ORDER_INFO_URL};
use crate::views::placeholder::PlaceholderView;
use crate::views::platform_inspection::{PlatformInspectionView, PLATFORM_INSPECTION_URL};
use crate::views::platform_revenue::{PlatformRevenueView, PLATFORM_REVENUE_URL};
use crate::views::portfolio_overview::{PortfolioOverviewView, PORTFOLIO_URL};
use crate::views::product_analysis::{ProductAnalysisView, PRODUCT_ANALYSIS_URL};
use crate::views::project_goals::{ProjectGoalsView, PROJECT_GOALS_URL};
use crate::views::replenishment::{ReplenishmentView, REPLENISHMENT_URL};
use crate::views::research_analysis::{ResearchAnalysisView, RESEARCH_ANALYSIS_URL};
use crate::views::return_analysis::{ReturnAnalysisView, RETURN_ANALYSIS_URL};
use crate::views::scheduled_reports::{ScheduledReportsView, SCHEDULED_REPORTS_URL};
use crate::views::seasonal_replenishment::{SeasonalReplenishmentView, SEASONAL_REPLENISHMENT_URL};
use crate::views::shell::{CONSOLE_BAR_HEIGHT, FOOTER_HEIGHT};use crate::views::shipment_management::{ShipmentManagementView, SHIPMENT_MANAGEMENT_URL};
use crate::views::shop_calculation::{ShopCalculationView, SHOP_CALCULATION_URL};
use crate::views::site_navigation::{SiteNavigationView, SITE_NAV_URL};
use crate::views::store_navigation::{StoreNavigationView, STORE_NAV_URL};
use crate::views::sub_nav::{SubNavEvent, SubNavView};
use crate::views::system_logs::{SystemLogsView, SYSTEM_LOGS_URL};
use crate::views::vat_invoice::{VatInvoiceView, VAT_INVOICE_URL};
use crate::views::weekly_product_analysis::{WeeklyProductAnalysisView, WEEKLY_PRODUCT_URL};

/// 主窗口会话信息（登录成功 / Keychain 恢复后注入）
pub struct SessionInfo {
    /// 带会话的 client（后续 issue 的 API 调用入口；GUI-4+ 消费前暂时只持有）
    #[allow(dead_code)]
    pub client: Client,
    pub user: LoginResponse,
    /// 非致命警告（Keychain 持久化失败 / 服务器连接失败）
    pub warning: Option<String>,
}

/// 主窗口根视图事件（BLF-796 起含 f32 宽度载荷，故不再派生 Eq；
/// BLF-800 起含 Vec 载荷，故不再派生 Copy；匹配用）
#[derive(Debug, Clone, PartialEq)]
pub enum RootViewEvent {
    /// 用户点了退出登录（coordinator 负责清 Keychain + 切窗口）
    Logout,
    /// BLF-794：Sub-Nav 折叠态变化（组合根据此持久化 UI 偏好）
    SubNavCollapsed { collapsed: bool },
    /// BLF-795：Console Bar 筛选变化（组合根据此持久化，重启还原）
    ConsoleFilterChanged(ConsoleFilter),
    /// BLF-796：Inspector 开合变化（组合根据此持久化 visible 偏好）
    InspectorVisibleChanged(bool),
    /// BLF-796：Inspector 拖拽调宽结束（组合根据此持久化宽度偏好）
    InspectorWidthChanged(f32),
    /// BLF-799：广告分析双轴画布分割比例提交（per-mille 400..=500；组合根持久化）
    AdChartRatioChanged(u16),
    /// BLF-800：AI Chat 会话置顶列表变化（全量 id；组合根持久化）
    AiChatPinnedChanged(Vec<i64>),
    /// BLF-800：AI Chat 右上下文栏收起态变化（组合根持久化）
    AiChatContextCollapsed(bool),
}

/// 根视图：六区外壳（Rail + Sub-Nav + 控制条 + Canvas + Inspector + Footer）
pub struct RootView {
    /// BLF-794：Sub-Nav 子导航列（可折叠模块选择器，绑定 gui-domain 8 组 52 项）
    pub sub_nav: Entity<SubNavView>,
    /// BLF-796：右侧 Inspector 上下文抽屉（Cmd+B 自适应三态内容）
    pub inspector: Entity<InspectorView>,
    /// BLF-796：Inspector 事件订阅（开合/调宽上抛组合根持久化；必须持有）
    _inspector_event_sub: gpui::Subscription,
    /// BLF-795：顶部通用控制条（四件套；无会话时为 None）
    pub console_bar: Option<Entity<ConsoleBarView>>,
    /// BLF-797：全局 Footer 系统状态栏（24px 汇率 ticker / DB 同步 / 未读 /
    /// 延迟；无会话时为 None，插槽回落空面板）
    pub footer: Option<Entity<FooterView>>,
    /// BLF-795：业务视图统计推送订阅（每个接入视图懒创建时挂一条；必须持有）
    console_stats_subs: Vec<gpui::Subscription>,
    /// BLF-795：控制条 Changed 事件订阅（必须持有，否则筛选变更不转发）
    _console_bar_changed_sub: Option<gpui::Subscription>,
    /// BLF-794：⌘K 命令面板（打开时才存在；None = 关闭）
    command_palette: Option<Entity<CommandPaletteView>>,
    /// BLF-793：Master Rail 主图标栏（六区最左列，绑定 gui-domain 8 分类）
    pub rail: Entity<MasterRailView>,
    /// BLF-793：当前激活一级分类 id（Rail 选中态与侧栏子项双向绑定的中枢；
    /// None = Dashboard 着陆页）
    active_category: Option<String>,
    pub content: Entity<PlaceholderView>,
    /// Dashboard 着陆页（sidebar 之外的首页，对齐 Web /dashboard）；启动即显示
    dashboard: Option<Entity<DashboardView>>,
    /// 站点导航真实视图（GUI-12；首个接入的真实 sidebar 页面，点击「运营 → 站点导航」懒创建）
    site_navigation: Option<Entity<SiteNavigationView>>,
    /// 店铺导航真实视图（P5-1；点击「运营 → 店铺导航」懒创建，数据源 /projects/manage）
    store_navigation: Option<Entity<StoreNavigationView>>,
    /// 运营 → 销售数据真实视图（P3-1；点击「运营 → 销售数据」懒创建，复用数据管线）
    daily_analysis: Option<Entity<DailyAnalysisView>>,
    /// 运营 → SKU 信息真实视图（BLF-798；Pattern A 第二原型页，点击「运营 → SKU 信息」懒创建）
    sku_info: Option<Entity<SkuInfoView>>,
    /// 广告 → 广告分析真实视图（P3-3；点击「广告 → 广告分析」懒创建）
    ad_analysis: Option<Entity<AdAnalysisView>>,
    /// BLF-799：广告分析 Pattern B 事件订阅（分割比例提交上抛组合根持久化；必须持有）
    _ad_analysis_event_sub: Option<gpui::Subscription>,
    /// BLF-800：AI Chat Pattern C 偏好事件订阅（置顶列表 / 右栏收起态上抛
    /// 组合根持久化；必须持有）
    _ai_chat_event_sub: Option<gpui::Subscription>,
    /// 广告 → 广告数据真实视图（P3-3；点击「广告 → 广告数据」懒创建）
    ad_data: Option<Entity<AdDataView>>,
    /// 报表中心 → 财务月报真实视图（P3-4；点击「报表中心 → 财务月报」懒创建）
    monthly_report: Option<Entity<MonthlyReportView>>,
    /// 财务资金 → 平台回款真实视图（P3-4；点击「财务资金 → 平台回款」懒创建）
    platform_revenue: Option<Entity<PlatformRevenueView>>,
    /// 报表中心 → 定时报告真实视图（P3-5；点击「报表中心 → 定时报告」懒创建）
    scheduled_reports: Option<Entity<ScheduledReportsView>>,
    /// 报表中心 → 报表自动化真实视图（P5-4；点击「报表中心 → 报表自动化」懒创建）
    auto_upload: Option<Entity<AutoUploadView>>,
    /// 运营 → 组合分析真实视图（P5-1；点击「运营 → 组合分析」懒创建）
    portfolio_overview: Option<Entity<PortfolioOverviewView>>,
    /// 运营 → 项目目标真实视图（P5-1；点击「运营 → 项目目标」懒创建）
    project_goals: Option<Entity<ProjectGoalsView>>,
    /// 运营 → 退货分析真实视图（P5-1；点击「运营 → 退货分析」懒创建）
    return_analysis: Option<Entity<ReturnAnalysisView>>,
    /// 运营 → 库存分析真实视图（P5-2；点击「运营 → 库存分析」懒创建）
    inventory_analysis: Option<Entity<InventoryAnalysisView>>,
    /// 运营 → 库存分类账真实视图（P5-2；点击「运营 → 库存分类账」懒创建）
    inventory_ledger: Option<Entity<InventoryLedgerView>>,
    /// 运营 → 补货分析真实视图（P5-2；点击「运营 → 补货分析」懒创建）
    replenishment: Option<Entity<ReplenishmentView>>,
    /// 运营 → 季节性补货分析真实视图（P5-2；点击「运营 → 季节性补货分析」懒创建）
    seasonal_replenishment: Option<Entity<SeasonalReplenishmentView>>,
    /// 运营 → 按周产品分析真实视图（P5-2；点击「运营 → 按周产品分析」懒创建）
    weekly_product: Option<Entity<WeeklyProductAnalysisView>>,
    /// 运营 → 调研分析真实视图（P5-3；点击「运营 → 调研分析」懒创建）
    research_analysis: Option<Entity<ResearchAnalysisView>>,
    /// 报表中心 → 产品分析真实视图（P5-4；点击「报表中心 → 产品分析」懒创建）
    product_analysis: Option<Entity<ProductAnalysisView>>,
    /// 报表中心 → 新品核算真实视图（P5-4；点击「报表中心 → 新品核算」懒创建）
    new_product_calculation: Option<Entity<NewProductCalculationView>>,
    /// 报表中心 → 店铺测算真实视图（P5-4 BLF-729；点击「报表中心 → 店铺测算」懒创建）
    shop_calculation: Option<Entity<ShopCalculationView>>,
    /// 运营 → 发货管理真实视图（P5-3；点击「运营 → 发货管理」懒创建）
    shipment_management: Option<Entity<ShipmentManagementView>>,
    /// 报表中心 → 订单信息真实视图（P5-4；点击「报表中心 → 订单信息」懒创建）
    order_info: Option<Entity<OrderInfoView>>,
    exchange_rate: Option<Entity<ExchangeRateView>>,
    /// 财务资金 → VAT 发票真实视图（P5-5；点击「财务资金 → VAT 发票」懒创建）
    vat_invoice: Option<Entity<VatInvoiceView>>,
    /// 财务资金 → 佣金管理真实视图（P5-5 BLF-734；点击「财务资金 → 佣金管理」懒创建）
    commission: Option<Entity<CommissionView>>,
    /// AI 智能 → 模型选型真实视图（P5-6 BLF-739；点击「AI 智能 → 模型选型」懒创建）
    model_selection: Option<Entity<ModelSelectionView>>,
    /// CRM → 数据看板真实视图（P5-7 BLF-742；点击「CRM → 数据看板」懒创建）
    crm_dashboard: Option<Entity<CrmDashboardView>>,
    /// CRM → 待跟进真实视图（P5-7 BLF-743；点击「CRM → 待跟进」懒创建）
    crm_follow_ups: Option<Entity<CrmFollowUpsView>>,
    /// CRM → 操作日志真实视图（P5-7 BLF-747；点击「CRM → 操作日志」懒创建）
    crm_audit: Option<Entity<CrmAuditView>>,
    // Stage13（BLF-804）：新增十视图懒建槽
    crm_customers: Option<Entity<CrmCustomersView>>,
    crm_leads: Option<Entity<CrmLeadsView>>,
    crm_tasks: Option<Entity<CrmTasksView>>,
    crm_settings: Option<Entity<CrmSettingsView>>,
    page_render: Option<Entity<PageRenderView>>,
    project_info: Option<Entity<ProjectInfoView>>,
    operator_management: Option<Entity<OperatorManagementView>>,
    alerts_center: Option<Entity<AlertsCenterView>>,
    database_status: Option<Entity<DatabaseStatusView>>,
    changelog: Option<Entity<ChangelogView>>,
    /// AI 智能 → AI Chat 真实视图（P5-6 BLF-737；点击「AI 智能 → AI Chat」懒创建，SSE 流式对话）
    ai_chat: Option<Entity<AiChatView>>,
    /// BLF-803：AI 洞察真实视图（历史查看）
    ai_insights: Option<Entity<AiInsightsView>>,
    /// BLF-803：客服交流真实视图（场景化话术生成，V2 SSE 流式）
    customer_service: Option<Entity<CustomerServiceView>>,
    /// BLF-803：数字员工 / 虚拟办公室真实视图（管理列表 + 办公室卡片墙双形态）
    virtual_office: Option<Entity<VirtualOfficeView>>,
    /// 工具箱 → Markdown 转换真实视图（P5-8 BLF-749；点击「工具箱 → Markdown 转换」懒创建）
    markdown_to_word: Option<Entity<MarkdownToWordView>>,
    /// 系统管理 → 日志查看真实视图（P5-8 BLF-757；点击「系统管理 → 日志查看」懒创建）
    system_logs: Option<Entity<SystemLogsView>>,
    /// 系统管理 → Agent 接入管理真实视图（P5-8 BLF-758；点击「系统管理 → Agent 接入管理」懒创建）
    agent_management: Option<Entity<AgentManagementView>>,
    /// 系统管理 → 账号管理真实视图（P5-8 BLF-754；点击「系统管理 → 账号管理」懒创建）
    account_management: Option<Entity<AccountManagementView>>,

    /// 运营 → 平台巡检真实视图（P5-1；点击「运营 → 平台巡检」懒创建）
    platform_inspection: Option<Entity<PlatformInspectionView>>,
    /// 内容区当前是否显示 Dashboard 着陆页（侧栏选中任意项后切换为占位视图）
    show_dashboard: bool,
    /// 内容区当前是否显示站点导航视图（sidebar Select 命中 SITE_NAV_URL 时置真）
    show_site_navigation: bool,
    /// 内容区当前是否显示店铺导航视图（sidebar Select 命中 STORE_NAV_URL 时置真）
    show_store_navigation: bool,
    /// 内容区当前是否显示销售数据视图（sidebar Select 命中 DAILY_ANALYSIS_URL 时置真）
    show_daily_analysis: bool,
    /// 内容区当前是否显示广告分析视图（sidebar Select 命中广告分析前缀时置真）
    show_ad_analysis: bool,
    /// 内容区当前是否显示广告数据视图（sidebar Select 命中 AD_DATA_URL 时置真）
    show_ad_data: bool,
    /// 内容区当前是否显示财务月报视图（sidebar Select 命中 MONTHLY_REPORT_URL 时置真）
    show_monthly_report: bool,
    /// 内容区当前是否显示平台回款视图（sidebar Select 命中 PLATFORM_REVENUE_URL 时置真）
    show_platform_revenue: bool,
    /// 内容区当前是否显示定时报告视图（sidebar Select 命中 SCHEDULED_REPORTS_URL 时置真）
    show_scheduled_reports: bool,
    /// 内容区当前是否显示报表自动化视图（sidebar Select 命中 AUTO_UPLOAD_URL 时置真）
    show_auto_upload: bool,
    /// 内容区当前是否显示组合分析视图（sidebar Select 命中 PORTFOLIO_URL 时置真）
    show_portfolio_overview: bool,
    /// 内容区当前是否显示项目目标视图（sidebar Select 命中 PROJECT_GOALS_URL 时置真）
    show_project_goals: bool,
    /// 内容区当前是否显示退货分析视图（sidebar Select 命中 RETURN_ANALYSIS_URL 时置真）
    show_return_analysis: bool,
    /// 内容区当前是否显示库存分析视图（sidebar Select 命中 INVENTORY_ANALYSIS_URL 时置真）
    show_inventory_analysis: bool,
    /// 内容区当前是否显示库存分类账视图（sidebar Select 命中 INVENTORY_LEDGER_URL 时置真）
    show_inventory_ledger: bool,
    /// 内容区当前是否显示补货分析视图（sidebar Select 命中 REPLENISHMENT_URL 时置真）
    show_replenishment: bool,
    /// 内容区当前是否显示季节性补货分析视图（sidebar Select 命中 SEASONAL_REPLENISHMENT_URL 时置真）
    show_seasonal_replenishment: bool,
    /// 内容区当前是否显示按周产品分析视图（sidebar Select 命中 WEEKLY_PRODUCT_URL 时置真）
    show_weekly_product: bool,
    /// 内容区当前是否显示调研分析视图（sidebar Select 命中 RESEARCH_ANALYSIS_URL 时置真）
    show_research_analysis: bool,
    /// 内容区当前是否显示产品分析视图（sidebar Select 命中 PRODUCT_ANALYSIS_URL 时置真）
    show_product_analysis: bool,
    /// 内容区当前是否显示新品核算视图（sidebar Select 命中 NEW_PRODUCT_CALCULATION_URL 时置真）
    show_new_product_calculation: bool,
    /// 内容区当前是否显示店铺测算视图（sidebar Select 命中 SHOP_CALCULATION_URL 时置真）
    show_shop_calculation: bool,
    /// 内容区当前是否显示发货管理视图（sidebar Select 命中 SHIPMENT_MANAGEMENT_URL 时置真）
    show_shipment_management: bool,
    /// 内容区当前是否显示订单信息视图（sidebar Select 命中 ORDER_INFO_URL 时置真）
    show_order_info: bool,
    /// 内容区当前是否显示汇率信息视图（sidebar Select 命中 EXCHANGE_RATE_URL 时置真）
    show_exchange_rate: bool,
    /// 内容区当前是否显示 VAT 发票视图（sidebar Select 命中 VAT_INVOICE_URL 时置真）
    show_vat_invoice: bool,
    /// 内容区当前是否显示佣金管理视图（sidebar Select 命中 COMMISSION_URL 时置真）
    show_commission: bool,
    /// 内容区当前是否显示模型选型视图（sidebar Select 命中 MODEL_SELECTION_URL 时置真）
    show_model_selection: bool,
    /// 内容区当前是否显示 CRM 数据看板视图（sidebar Select 命中 CRM_DASHBOARD_URL 时置真）
    show_crm_dashboard: bool,
    /// 内容区当前是否显示 CRM 待跟进视图（sidebar Select 命中 CRM_FOLLOW_UPS_URL 时置真）
    show_crm_follow_ups: bool,
    /// 内容区当前是否显示 CRM 操作日志视图（sidebar Select 命中 CRM_AUDIT_URL 时置真）
    show_crm_audit: bool,
    /// 内容区当前是否显示 AI Chat 视图（sidebar Select 命中 AI_CHAT_URL 时置真）
    show_ai_chat: bool,
    /// BLF-803：内容区当前是否显示 AI 洞察视图
    show_ai_insights: bool,
    /// BLF-803：内容区当前是否显示客服交流视图
    show_customer_service: bool,
    /// BLF-803：内容区当前是否显示数字员工/虚拟办公室视图
    show_virtual_office: bool,
    /// 内容区当前是否显示 Markdown 转换视图（sidebar Select 命中 MARKDOWN_TO_WORD_URL 时置真）
    show_markdown_to_word: bool,
    /// 内容区当前是否显示日志查看视图（sidebar Select 命中 SYSTEM_LOGS_URL 时置真）
    show_system_logs: bool,
    /// 内容区当前是否显示 Agent 接入管理视图（sidebar Select 命中 AGENT_MANAGEMENT_URL 时置真）
    show_agent_management: bool,
    /// 内容区当前是否显示账号管理视图（sidebar Select 命中 ACCOUNT_MANAGEMENT_URL 时置真）
    show_account_management: bool,
    /// 内容区当前是否显示 SKU 信息视图（BLF-798；Select 命中 SKU_INFO_URL 时置真）
    show_sku_info: bool,
    // Stage13（BLF-804）：新增十视图 show 标志
    show_crm_customers: bool,
    show_crm_leads: bool,
    show_crm_tasks: bool,
    show_crm_settings: bool,
    show_page_render: bool,
    show_project_info: bool,
    show_operator_management: bool,
    show_alerts_center: bool,
    show_database_status: bool,
    show_changelog: bool,

    /// 内容区当前是否显示平台巡检视图（sidebar Select 命中 PLATFORM_INSPECTION_URL 时置真）
    show_platform_inspection: bool,
    /// 内容区当前视图标题（着陆页为 "Dashboard"，选中侧栏项后跟随）。
    /// P4-5 起 chrome 头部不再渲染该标题（去重），仅用于面包屑兜底与测试断言。
    current_title: String,
    /// P4-1：当前面包屑路径（一级分类 → 二级标题；Dashboard 着陆页为单段）
    breadcrumb: Vec<String>,
    /// P4-1：侧栏当前是否折叠（订阅 `SubNavEvent::Collapsed` 同步；折叠态下
    /// 内容区头部最左渲染「展开侧栏」按钮）
    sub_nav_collapsed: bool,
    /// P4-1 修复：窗口拖拽武装标志——鼠标在内容区头部按下后置真，移动时触发
    /// `start_window_move()`；未移动直接松开 = 普通点击（头部内按钮仍可交互）
    should_move: bool,
    /// BLF-828：Windows Snap Layouts 浮层是否展开（最大化钮 hover 弹出；
    /// 仅 Windows 有 caption buttons，macOS 恒 false）
    snap_layout_open: bool,
    session: Option<SessionInfo>,
    focus_handle: FocusHandle,
    /// P2-2：窗口外观变化监听（跟随系统；main.rs 注册时写入）
    pub theme_appearance_sub: Option<gpui::Subscription>,
}

impl RootView {
    pub fn new(cx: &mut Context<Self>, session: Option<SessionInfo>) -> Self {
        // GUI-7：Dashboard 首页为着陆页（sidebar 之外的 landing），启动默认显示；
        // 侧栏初始无选中项，点击/键盘选中后再切换内容区为对应占位视图。
        let show_dashboard = session.is_some();
        let dashboard = session.as_ref().map(|s| {
            let client = s.client.clone();
            cx.new(|cx| {
                let mut view = DashboardView::new(cx, client, Vec::new());
                // 启动即触发首屏拉取（项目列表 + 近 7 天聚合 + 对比期）
                view.reload(cx);
                view
            })
        });

        // BLF-794：Sub-Nav 子导航列（折叠态从 UI 偏好恢复，重启保留）
        let initial_collapsed = crate::prefs::load_ui_prefs().sub_nav_collapsed;
        let sub_nav = cx.new(|cx| SubNavView::new(initial_collapsed, cx));
        // BLF-795：顶部通用控制条（登录后创建；初始筛选自偏好恢复）。
        // Changed 事件 → 转发当前业务视图 + 向组合根 emit 持久化事件。
        let console_bar = session.as_ref().map(|s| {
            let client = s.client.clone();
            cx.new(|cx| ConsoleBarView::new(client, cx))
        });
        // BLF-797：全局 Footer 状态栏（登录后创建；创建即首拉三段数据）
        let footer = session.as_ref().map(|s| {
            let client = s.client.clone();
            cx.new(|cx| FooterView::new(client, cx))
        });
        let console_bar_changed_sub = console_bar.as_ref().map(|bar| {
            cx.subscribe(bar, |this, _bar, event: &ConsoleBarEvent, cx| {
                let ConsoleBarEvent::Changed(filter) = event;
                this.forward_console_filter(*filter, cx);
                cx.emit(RootViewEvent::ConsoleFilterChanged(*filter));
            })
        });
        let rail_user = session
            .as_ref()
            .map(|s| s.user.name.clone())
            .unwrap_or_default();
        let rail = cx.new(|cx| MasterRailView::new(&rail_user, cx));
        let content = cx.new(|_| PlaceholderView::new("", ""));

        // BLF-796：右侧 Inspector 抽屉——可见性/宽度自 UI 偏好恢复；事件上抛
        // 组合根持久化（视图层不碰文件系统，延续 BLF-794/795 纪律）
        let ui_prefs = crate::prefs::load_ui_prefs();
        let inspector_client = session
            .as_ref()
            .map(|s| s.client.clone())
            .unwrap_or_else(|| Client::new(""));
        let inspector = cx.new(|cx| {
            InspectorView::new(
                inspector_client,
                ui_prefs.inspector_visible,
                ui_prefs.inspector_width,
                cx,
            )
        });
        let inspector_event_sub =
            cx.subscribe(&inspector, |_this, _inspector, event: &InspectorEvent, cx| {
                match event {
                    InspectorEvent::VisibleChanged(visible) => {
                        cx.emit(RootViewEvent::InspectorVisibleChanged(*visible));
                    }
                    InspectorEvent::WidthCommitted(width) => {
                        cx.emit(RootViewEvent::InspectorWidthChanged(*width));
                    }
                }
            });

        // BLF-793：Rail 选中分类 → 默认视图路由（该组第一项；已在该分类内则
        // 保留当前子视图不重路由）。emit 经 pending_effects 异步冲刷，此处
        // 再驱动 sub_nav 不会与 rail 实体借用嵌套。
        cx.subscribe(
            &rail,
            |this, _rail, event: &MasterRailEvent, cx| match event {
                MasterRailEvent::CategorySelected { group_id } => {
                    this.on_rail_category_selected(group_id, cx);
                }
            },
        )
        .detach();

        // Sub-Nav 选中变化 → 内容区切换 + 标题/面包屑跟随（复用既有分发链）；
        // 折叠变化 → 同步内容区头部布局（持久化由组合根 main.rs 统一处理，
        // 视图层不碰文件系统——保证测试确定性）
        cx.subscribe(&sub_nav, |this, _sub_nav, event: &SubNavEvent, cx| {
            match event {
                SubNavEvent::Collapsed { collapsed } => {
                    this.sub_nav_collapsed = *collapsed;
                    cx.emit(RootViewEvent::SubNavCollapsed {
                        collapsed: *collapsed,
                    });
                }
                SubNavEvent::Select { url, title } => {
                    // BLF-803：进入分发前统一复位 BLF-803 新增三视图标志——
                    // 既有 36 个分支的内联复位列表不含它们，残留 true 会在
                    // view_key/content_view if 链中误命中新视图（两步切换测试
                    // 锁定此契约）
                    this.show_ai_insights = false;
                    this.show_customer_service = false;
                    this.show_virtual_office = false;
                    this.show_dashboard = false;
                    this.current_title = title.clone();
                    this.breadcrumb = breadcrumb_for(url).unwrap_or_else(|| vec![title.clone()]);
                    // BLF-795：页面切换 → 控制条按新页面声明式配置换装
                    // （保留用户已有筛选值；未声明页面回落空配置纯 chrome）
                    this.sync_console_config(url, cx);
                    // BLF-793：Rail 选中态与 gui-domain 8 组严格绑定——子项选中
                    // 回写所属分类高亮（Dashboard 着陆页等侧栏外 url → None）
                    let category = group_id_for_url(url);
                    if this.active_category != category {
                        this.active_category = category.clone();
                        this.rail
                            .update(cx, |rail_view, cx| rail_view.set_active(category, cx));
                    }
                    // Stage13（BLF-804）：着陆页路由——点击 Logo / 返回首页时回到
                    // Dashboard（接控制条项目选择器）；复用 reset_all_show_flags
                    if url == DASHBOARD_LANDING_URL {
                        this.reset_all_show_flags();
                        this.show_dashboard = true;
                    } else if url == SITE_NAV_URL {
                        this.site_navigation
                            .get_or_insert_with(|| cx.new(|_| SiteNavigationView::new()));
                        this.show_shop_calculation = false;
                        this.show_site_navigation = true;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == STORE_NAV_URL {
                        // P5-1：店铺导航视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.store_navigation.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = StoreNavigationView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_shop_calculation = false;
                        this.show_store_navigation = true;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == DAILY_ANALYSIS_URL {
                        // P3-1：销售数据视图懒创建（带会话 client），首帧即触发首屏拉取
                        let daily_new = this.daily_analysis.is_none();
                        this.daily_analysis.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = DailyAnalysisView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        // BLF-795：Console Bar 联动——统计订阅仅首次创建挂一次；
                        // 筛选快照每次进入都回放（review 阻塞项修复：视图是常驻
                        // 缓存、无销毁路径，二次进入也必须对齐控制条——条是唯一
                        // 权威状态；apply_console_filter 同值 no-op，重复回放
                        // 零额外拉取）
                        if daily_new {
                            if let Some(view) = this.daily_analysis.clone() {
                                this.subscribe_view_stats(&view, cx);
                            }
                        }
                        if let Some(view) = this.daily_analysis.clone() {
                            if let Some(bar) = &this.console_bar {
                                let snapshot = bar.read(cx).snapshot();
                                view.update(cx, |v, cx| {
                                    v.apply_console_filter(
                                        snapshot.project_id,
                                        snapshot.country,
                                        snapshot.range,
                                        cx,
                                    )
                                });
                            }
                        }
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_shop_calculation = false;
                        this.show_daily_analysis = true;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == PORTFOLIO_URL {
                        // P5-1：组合分析视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.portfolio_overview.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = PortfolioOverviewView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_shop_calculation = false;
                        this.show_portfolio_overview = true;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == SKU_INFO_URL {
                        // BLF-798：SKU 信息视图懒创建（Pattern A 第二原型页；服务端分页）
                        this.sku_info.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view =
                                    SkuInfoView::new(cx, client.unwrap_or_else(|| Client::new("")));
                                view.reload(cx);
                                view
                            })
                        });
                        if let Some(view) = this.sku_info.clone() {
                            if let Some(bar) = &this.console_bar {
                                let snapshot = bar.read(cx).snapshot();
                                view.update(cx, |v, cx| {
                                    v.apply_console_filter(
                                        snapshot.project_id,
                                        snapshot.country,
                                        snapshot.range,
                                        cx,
                                    )
                                });
                            }
                        }
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_shop_calculation = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = true;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
              } else if url == AD_ANALYSIS_URL
                        || url.starts_with("/dashboard/advertising/ad-analysis")
                    {
                        // P3-3：广告分析视图懒创建（带会话 client），首帧即触发首屏拉取；
                        // BLF-799：Pattern B 分割比例自偏好恢复 + 事件订阅挂一次
                        let ad_new = this.ad_analysis.is_none();
                        this.ad_analysis.get_or_insert_with(|| {
                            let saved_ratio = crate::prefs::load_ui_prefs().analysis_chart_ratio;
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = AdAnalysisView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                    saved_ratio,
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        if ad_new {
                            if let Some(view) = this.ad_analysis.clone() {
                                this._ad_analysis_event_sub =
                                    Some(cx.subscribe(&view, |_this, _v, event: &AdAnalysisEvent, cx| {
                                        match event {
                                            AdAnalysisEvent::ChartRatioCommitted(per_mille) => {
                                                cx.emit(RootViewEvent::AdChartRatioChanged(*per_mille));
                                            }
                                        }
                                    }));
                            }
                        }
                        // BLF-795：Console Bar 联动——筛选快照每次进入都回放
                        // （review 阻塞项修复：视图常驻缓存，二次进入也必须对齐
                        // 控制条；同值 no-op 零额外拉取。广告分析不开统计位，
                        // 无需统计订阅）
                        if let Some(view) = this.ad_analysis.clone() {
                            if let Some(bar) = &this.console_bar {
                                let snapshot = bar.read(cx).snapshot();
                                view.update(cx, |v, cx| {
                                    v.apply_console_filter(
                                        snapshot.project_id,
                                        snapshot.country,
                                        snapshot.range,
                                        cx,
                                    )
                                });
                            }
                        }
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_shop_calculation = false;
                        this.show_ad_analysis = true;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == AD_DATA_URL {
                        // P3-3：广告数据视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.ad_data.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view =
                                    AdDataView::new(cx, client.unwrap_or_else(|| Client::new("")));
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_shop_calculation = false;
                        this.show_ad_data = true;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == MONTHLY_REPORT_URL {
                        // P3-4：财务月报视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.monthly_report.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = MonthlyReportView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        // BLF-795：Console Bar 联动——筛选快照每次进入都回放
                        // （review 阻塞项修复：视图常驻缓存，二次进入也必须对齐
                        // 控制条；同值 no-op 零额外拉取。财务月报不开统计位，
                        // 无需统计订阅）
                        if let Some(view) = this.monthly_report.clone() {
                            if let Some(bar) = &this.console_bar {
                                let snapshot = bar.read(cx).snapshot();
                                view.update(cx, |v, cx| {
                                    v.apply_console_filter(
                                        snapshot.project_id,
                                        snapshot.country,
                                        cx,
                                    )
                                });
                            }
                        }
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_shop_calculation = false;
                        this.show_monthly_report = true;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == PLATFORM_REVENUE_URL {
                        // P3-4：平台回款视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.platform_revenue.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = PlatformRevenueView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_shop_calculation = false;
                        this.show_platform_revenue = true;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == SCHEDULED_REPORTS_URL || url.starts_with(SCHEDULED_REPORTS_URL)
                    {
                        // P3-5：定时报告视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.scheduled_reports.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = ScheduledReportsView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload_active_tab(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_shop_calculation = false;
                        this.show_scheduled_reports = true;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == AUTO_UPLOAD_URL {
                        // P5-4：报表自动化视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.auto_upload.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = AutoUploadView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                        this.show_shop_calculation = false;
                        this.show_auto_upload = true;
                    } else if url == PROJECT_GOALS_URL {
                        // P5-1：项目目标视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.project_goals.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = ProjectGoalsView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_shop_calculation = false;
                        this.show_project_goals = true;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == RETURN_ANALYSIS_URL {
                        // P5-1：退货分析视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.return_analysis.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = ReturnAnalysisView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_shop_calculation = false;
                        this.show_return_analysis = true;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == INVENTORY_ANALYSIS_URL {
                        // P5-2：库存分析视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.inventory_analysis.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = InventoryAnalysisView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_shop_calculation = false;
                        this.show_inventory_analysis = true;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == INVENTORY_LEDGER_URL {
                        // P5-2：库存分类账视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.inventory_ledger.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = InventoryLedgerView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_shop_calculation = false;
                        this.show_inventory_ledger = true;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == REPLENISHMENT_URL {
                        // P5-2：补货分析视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.replenishment.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = ReplenishmentView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_shop_calculation = false;
                        this.show_replenishment = true;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == PLATFORM_INSPECTION_URL
                        || url.starts_with(PLATFORM_INSPECTION_URL)
                    {
                        // P5-1：平台巡检视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.platform_inspection.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = PlatformInspectionView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shop_calculation = false;
                        this.show_platform_inspection = true;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == SEASONAL_REPLENISHMENT_URL {
                        // P5-2：季节性补货分析视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.seasonal_replenishment.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = SeasonalReplenishmentView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_shop_calculation = false;
                        this.show_seasonal_replenishment = true;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == WEEKLY_PRODUCT_URL {
                        // P5-2：按周产品分析视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.weekly_product.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = WeeklyProductAnalysisView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_shop_calculation = false;
                        this.show_weekly_product = true;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == RESEARCH_ANALYSIS_URL {
                        // P5-3：调研分析视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.research_analysis.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = ResearchAnalysisView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shop_calculation = false;
                        this.show_research_analysis = true;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == PRODUCT_ANALYSIS_URL {
                        // P5-4：产品分析视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.product_analysis.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = ProductAnalysisView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                        this.show_shop_calculation = false;
                        this.show_product_analysis = true;
                    } else if url == SHIPMENT_MANAGEMENT_URL {
                        // P5-3：发货管理视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.shipment_management.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = ShipmentManagementView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shop_calculation = false;
                        this.show_shipment_management = true;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == NEW_PRODUCT_CALCULATION_URL {
                        // P5-4：新品核算视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.new_product_calculation.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = NewProductCalculationView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                        this.show_shop_calculation = false;
                        this.show_new_product_calculation = true;
                    } else if url == SHOP_CALCULATION_URL {
                        // P5-4：店铺测算视图懒创建（带会话 client），首帧即触发项目列表拉取
                        this.shop_calculation.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = ShopCalculationView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_new_product_calculation = false;
                        this.show_auto_upload = false;
                        this.show_shop_calculation = true;
                    } else if url == ORDER_INFO_URL {
                        // P5-4：订单信息视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.order_info.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = OrderInfoView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_shipment_management = false;
                        this.show_auto_upload = false;
                        this.show_new_product_calculation = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                        this.show_shop_calculation = false;
                        this.show_order_info = true;
                    } else if url == EXCHANGE_RATE_URL {
                        // P5-5：汇率信息视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.exchange_rate.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = ExchangeRateView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_shipment_management = false;
                        this.show_auto_upload = false;
                        this.show_new_product_calculation = false;
                        this.show_order_info = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                        this.show_shop_calculation = false;
                        this.show_exchange_rate = true;
                    } else if url == VAT_INVOICE_URL {
                        // P5-5：VAT 发票视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.vat_invoice.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = VatInvoiceView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_shipment_management = false;
                        this.show_auto_upload = false;
                        this.show_new_product_calculation = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                        this.show_shop_calculation = false;
                        this.show_vat_invoice = true;
                    } else if url == COMMISSION_URL {
                        // P5-5 BLF-734：佣金管理视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.commission.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = CommissionView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_shipment_management = false;
                        this.show_auto_upload = false;
                        this.show_new_product_calculation = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                        this.show_shop_calculation = false;
                        this.show_commission = true;
                    } else if url == MODEL_SELECTION_URL {
                        // P5-6 BLF-739：模型选型视图懒创建（纯静态文档，编译期内嵌
                        // frontend/docs/believeboy-models.md，无网络请求、无首屏拉取）
                        this.model_selection
                            .get_or_insert_with(|| cx.new(|_| ModelSelectionView::new()));
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_shipment_management = false;
                        this.show_auto_upload = false;
                        this.show_new_product_calculation = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                        this.show_shop_calculation = false;
                        this.show_model_selection = true;
                    } else if url == CRM_DASHBOARD_URL {
                        // P5-7 BLF-742：CRM 数据看板视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.crm_dashboard.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = CrmDashboardView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_shipment_management = false;
                        this.show_auto_upload = false;
                        this.show_new_product_calculation = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                        this.show_shop_calculation = false;
                        this.show_crm_dashboard = true;
                    } else if url == CRM_FOLLOW_UPS_URL {
                        // P5-7 BLF-743：CRM 待跟进视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.crm_follow_ups.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = CrmFollowUpsView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_shipment_management = false;
                        this.show_auto_upload = false;
                        this.show_new_product_calculation = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_shop_calculation = false;
                        this.show_crm_follow_ups = true;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == CRM_AUDIT_URL {
                        // P5-7 BLF-747：CRM 操作日志视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.crm_audit.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = CrmAuditView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_shipment_management = false;
                        this.show_auto_upload = false;
                        this.show_new_product_calculation = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_shop_calculation = false;
                        this.show_crm_audit = true;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == CRM_CUSTOMERS_URL {
                        // Stage13 BLF-804：CRM 客户视图懒创建，首帧触发首屏拉取
                        this.crm_customers.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = CrmCustomersView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.reset_all_show_flags();
                        this.show_crm_customers = true;
                    } else if url == CRM_LEADS_URL {
                        // Stage13 BLF-804：CRM 线索视图懒创建
                        this.crm_leads.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = CrmLeadsView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.reset_all_show_flags();
                        this.show_crm_leads = true;
                    } else if url == CRM_TASKS_URL {
                        // Stage13 BLF-804：CRM 任务视图懒创建（列表 + 看板双形态）
                        this.crm_tasks.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = CrmTasksView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.reset_all_show_flags();
                        this.show_crm_tasks = true;
                    } else if url == CRM_SETTINGS_URL {
                        // Stage13 BLF-804：CRM 设置视图懒创建（只读配置面）
                        this.crm_settings.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = CrmSettingsView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.reset_all_show_flags();
                        this.show_crm_settings = true;
                    } else if url == PAGE_RENDER_URL {
                        // Stage13 BLF-804：Markdown/HTML 渲染工具懒创建（查看主面）
                        this.page_render.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = PageRenderView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.reset_all_show_flags();
                        this.show_page_render = true;
                    } else if url == PROJECT_INFO_URL {
                        // Stage13 BLF-804：项目信息视图懒创建（与控制条项目选择器同源）
                        this.project_info.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = ProjectInfoView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.reset_all_show_flags();
                        this.show_project_info = true;
                    } else if url == OPERATOR_MANAGEMENT_URL {
                        // Stage13 BLF-804：运营管理视图懒创建（绩效只读面）
                        this.operator_management.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = OperatorManagementView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.reset_all_show_flags();
                        this.show_operator_management = true;
                    } else if url == ALERTS_CENTER_URL {
                        // Stage13 BLF-804：告警中心视图懒创建（统计 + 事件表）
                        this.alerts_center.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = AlertsCenterView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.reset_all_show_flags();
                        this.show_alerts_center = true;
                    } else if url == DATABASE_STATUS_URL {
                        // Stage13 BLF-804：数据库状态视图懒创建
                        this.database_status.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = DatabaseStatusView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.reset_all_show_flags();
                        this.show_database_status = true;
                    } else if url == CHANGELOG_URL {
                        // Stage13 BLF-804：更新日志视图懒创建（纯静态，无首拉）
                        this.changelog
                            .get_or_insert_with(|| cx.new(|_| ChangelogView::new()));
                        this.reset_all_show_flags();
                        this.show_changelog = true;
                    } else if url == AI_CHAT_URL {
                        // P5-6 BLF-737：AI Chat 视图懒创建（带会话 client），首帧即触发首屏拉取；
                        // BLF-800：Pattern C 偏好（置顶列表 / 右栏收起态）自偏好恢复 +
                        // 偏好事件订阅挂一次
                        let chat_new = this.ai_chat.is_none();
                        this.ai_chat.get_or_insert_with(|| {
                            let ui_prefs = crate::prefs::load_ui_prefs();
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = AiChatView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                )
                                .with_session_prefs(
                                    ui_prefs.chat_pinned_conversations.clone(),
                                    ui_prefs.chat_context_collapsed,
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        if chat_new {
                            if let Some(view) = this.ai_chat.clone() {
                                this._ai_chat_event_sub =
                                    Some(cx.subscribe(&view, |_this, _v, event: &AiChatEvent, cx| {
                                        match event {
                                            AiChatEvent::PinnedSessionsChanged(ids) => {
                                                cx.emit(RootViewEvent::AiChatPinnedChanged(
                                                    ids.clone(),
                                                ));
                                            }
                                            AiChatEvent::ContextPaneCollapsed(collapsed) => {
                                                cx.emit(RootViewEvent::AiChatContextCollapsed(
                                                    *collapsed,
                                                ));
                                            }
                                        }
                                    }));
                            }
                        }
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_shipment_management = false;
                        this.show_auto_upload = false;
                        this.show_new_product_calculation = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                        this.show_shop_calculation = false;
                        this.show_ai_chat = true;
                    } else if url == AI_INSIGHTS_URL {
                        // BLF-803：AI 洞察视图懒创建，首帧触发列表拉取
                        this.ai_insights.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = AiInsightsView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.reset_all_show_flags();
                        this.show_ai_insights = true;
                    } else if url == CUSTOMER_SERVICE_URL {
                        // BLF-803：客服交流视图懒创建（V2 SSE 场景化生成）
                        this.customer_service.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = CustomerServiceView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.reset_all_show_flags();
                        this.show_customer_service = true;
                    } else if url == DIGITAL_EMPLOYEES_URL || url.starts_with(VIRTUAL_OFFICE_URL) {
                        // BLF-803：数字员工 / 虚拟办公室（同实体双形态）
                        this.virtual_office.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = VirtualOfficeView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload(cx);
                                view
                            })
                        });
                        this.reset_all_show_flags();
                        this.show_virtual_office = true;
                    } else if url == MARKDOWN_TO_WORD_URL {
                        // P5-8 BLF-749：工具箱 → Markdown 转换视图懒创建
                        //（纯本地工具：无网络请求，无需首屏 reload）
                        this.markdown_to_word
                            .get_or_insert_with(|| cx.new(|_| MarkdownToWordView::new()));
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_shipment_management = false;
                        this.show_auto_upload = false;
                        this.show_new_product_calculation = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = true;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == SYSTEM_LOGS_URL {
                        // P5-8 BLF-757：日志查看视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.system_logs.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view =
                                    SystemLogsView::new(cx, client.unwrap_or_else(|| Client::new("")));
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_shipment_management = false;
                        this.show_auto_upload = false;
                        this.show_new_product_calculation = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_shop_calculation = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = true;
                        this.show_agent_management = false;
                        this.show_account_management = false;
                    } else if url == AGENT_MANAGEMENT_URL {
                        // P5-8 BLF-758：系统管理 → Agent 接入管理视图懒创建
                        //（带会话 client），首帧即触发凭据列表拉取
                        this.agent_management.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = AgentManagementView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload_keys(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_shipment_management = false;
                        this.show_auto_upload = false;
                        this.show_new_product_calculation = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_shop_calculation = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = true;
                    } else if url == ACCOUNT_MANAGEMENT_URL {
                        // P5-8 BLF-754：系统管理 → 账号管理视图懒创建
                        //（带会话 client），首帧即触发账号列表拉取
                        this.account_management.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = AccountManagementView::new(
                                    cx,
                                    client.unwrap_or_else(|| Client::new("")),
                                );
                                view.reload_users(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        // 修复：else（占位页）分支此前漏复位 show_auto_upload——
                        // 从报表自动化切到任意占位页会残留 true，view_key/
                        // content_view 链误命中 auto-upload 视图
                        this.show_auto_upload = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_shop_calculation = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        // P5-8 BLF-754：账号管理分支置真（上方 reset 列表覆盖全部既有视图）
                        this.show_account_management = true;
                    } else {
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_sku_info = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
                        this.show_inventory_ledger = false;
                        this.show_replenishment = false;
                        this.show_seasonal_replenishment = false;
                        this.show_weekly_product = false;
                        this.show_research_analysis = false;
                        this.show_product_analysis = false;
                        this.show_new_product_calculation = false;
                        this.show_shipment_management = false;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        // 修复：else（占位页）分支此前漏复位 show_auto_upload——
                        // 从报表自动化切到任意占位页会残留 true，view_key/
                        // content_view 链误命中 auto-upload 视图
                        this.show_auto_upload = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
                        this.show_crm_audit = false;
                        this.show_markdown_to_word = false;
                        this.show_system_logs = false;
                        this.show_agent_management = false;
                        this.show_account_management = false;

                        this.content.update(cx, |content, cx| {
                            content.title = title.clone();
                            content.url = url.clone();
                            cx.notify();
                        });
                    }
                    // BLF-796：路由落地后按新 view_key 声明 Inspector 形态
                    //（未注册形态 → None → 抽屉零宽隐藏入口）
                    this.sync_inspector(cx);
                }
            }
            cx.notify();
        })
        .detach();

        Self {
            sub_nav,
            inspector,
            _inspector_event_sub: inspector_event_sub,
            console_bar,
            footer,
            console_stats_subs: Vec::new(),
            _console_bar_changed_sub: console_bar_changed_sub,
            command_palette: None,
            rail,
            content,
            active_category: None,
            dashboard,
            site_navigation: None,
            store_navigation: None,
            daily_analysis: None,
            ad_analysis: None,
            _ad_analysis_event_sub: None,
            _ai_chat_event_sub: None,
            ad_data: None,
            monthly_report: None,
            platform_revenue: None,
            scheduled_reports: None,
            auto_upload: None,
            portfolio_overview: None,
            project_goals: None,
            return_analysis: None,
            inventory_analysis: None,
            inventory_ledger: None,
            replenishment: None,
            seasonal_replenishment: None,
            weekly_product: None,
            research_analysis: None,
            product_analysis: None,
            new_product_calculation: None,
            shop_calculation: None,
            shipment_management: None,
            order_info: None,
            exchange_rate: None,
            vat_invoice: None,
            commission: None,
            model_selection: None,
            crm_dashboard: None,
            crm_follow_ups: None,
            crm_audit: None,
            // Stage13（BLF-804）：新增十视图懒建槽
            crm_customers: None,
            crm_leads: None,
            crm_tasks: None,
            crm_settings: None,
            page_render: None,
            project_info: None,
            operator_management: None,
            alerts_center: None,
            database_status: None,
            changelog: None,
            ai_chat: None,
            ai_insights: None,
            customer_service: None,
            virtual_office: None,
            markdown_to_word: None,
            system_logs: None,
            agent_management: None,
            account_management: None,
            sku_info: None,

            platform_inspection: None,
            show_dashboard,
            show_site_navigation: false,
            show_store_navigation: false,
            show_daily_analysis: false,
            show_sku_info: false,
            show_ad_analysis: false,
            show_ad_data: false,
            show_monthly_report: false,
            show_platform_revenue: false,
            show_scheduled_reports: false,
            show_portfolio_overview: false,
            show_project_goals: false,
            show_return_analysis: false,
            show_inventory_analysis: false,
            show_inventory_ledger: false,
            show_replenishment: false,
            show_seasonal_replenishment: false,
            show_weekly_product: false,
            show_research_analysis: false,
            show_product_analysis: false,
            show_new_product_calculation: false,
            show_shop_calculation: false,
            show_shipment_management: false,
            show_order_info: false,
            show_exchange_rate: false,
            show_vat_invoice: false,
            show_commission: false,
            show_model_selection: false,
            show_crm_dashboard: false,
            show_crm_follow_ups: false,
            show_crm_audit: false,
            show_ai_chat: false,
            show_ai_insights: false,
            show_customer_service: false,
            show_virtual_office: false,
            show_markdown_to_word: false,
            show_system_logs: false,
            show_agent_management: false,
            show_account_management: false,
            show_auto_upload: false,

            // Stage13（BLF-804）：新增十视图 show 标志
            show_crm_customers: false,
            show_crm_leads: false,
            show_crm_tasks: false,
            show_crm_settings: false,
            show_page_render: false,
            show_project_info: false,
            show_operator_management: false,
            show_alerts_center: false,
            show_database_status: false,
            show_changelog: false,

            show_platform_inspection: false,
            current_title: "Dashboard".to_string(),
            breadcrumb: vec!["Dashboard".to_string()],
            sub_nav_collapsed: initial_collapsed,
            should_move: false,
            snap_layout_open: false,
            session,
            focus_handle: cx.focus_handle(),
            theme_appearance_sub: None,
        }
    }

    /// BLF-803：复位全部视图 show_* 标志（新分支统一入口；既有分支保持
    /// 内联复位不动，避免大面积 diff）。
    fn reset_all_show_flags(&mut self) {
        self.show_dashboard = false;
        self.show_site_navigation = false;
        self.show_store_navigation = false;
        self.show_platform_inspection = false;
        self.show_daily_analysis = false;
        self.show_sku_info = false;
        self.show_ad_analysis = false;
        self.show_ad_data = false;
        self.show_monthly_report = false;
        self.show_platform_revenue = false;
        self.show_scheduled_reports = false;
        self.show_portfolio_overview = false;
        self.show_return_analysis = false;
        self.show_project_goals = false;
        self.show_inventory_analysis = false;
        self.show_inventory_ledger = false;
        self.show_replenishment = false;
        self.show_seasonal_replenishment = false;
        self.show_weekly_product = false;
        self.show_research_analysis = false;
        self.show_product_analysis = false;
        self.show_new_product_calculation = false;
        self.show_shop_calculation = false;
        self.show_shipment_management = false;
        self.show_order_info = false;
        self.show_exchange_rate = false;
        self.show_vat_invoice = false;
        self.show_commission = false;
        self.show_model_selection = false;
        self.show_crm_dashboard = false;
        self.show_ai_chat = false;
        self.show_crm_follow_ups = false;
        self.show_crm_audit = false;
        self.show_markdown_to_word = false;
        self.show_system_logs = false;
        self.show_agent_management = false;
        self.show_account_management = false;
        self.show_auto_upload = false;
        self.show_ai_insights = false;
        self.show_customer_service = false;
        self.show_virtual_office = false;
        // Stage13（BLF-804）：新增十视图
        self.show_crm_customers = false;
        self.show_crm_leads = false;
        self.show_crm_tasks = false;
        self.show_crm_settings = false;
        self.show_page_render = false;
        self.show_project_info = false;
        self.show_operator_management = false;
        self.show_alerts_center = false;
        self.show_database_status = false;
        self.show_changelog = false;
    }

    /// 显示非致命警告横幅（会话校验等后台任务回调用）
    pub fn set_warning(&mut self, warning: String, cx: &mut Context<Self>) {
        if let Some(s) = &mut self.session {
            s.warning = Some(warning);
        }
        cx.notify();
    }

    /// BLF-794：恢复持久化的 Sub-Nav 折叠态（仅组合根 main.rs 打开主窗口时
    /// 调用一次；直接置态不发事件——折叠动画起点与初始态一致，启动不回放）。
    pub fn restore_sub_nav_collapsed(&mut self, collapsed: bool, cx: &mut Context<Self>) {
        if !collapsed {
            return; // 默认即展开，无需处理
        }
        self.sub_nav_collapsed = true;
        self.sub_nav.update(cx, |sub_nav, cx| {
            sub_nav.restore_collapsed(true, cx);
        });
        cx.notify();
    }

    // ------------------------------------------------------------------
    // BLF-796：Inspector 联动
    // ------------------------------------------------------------------

    /// 按当前内容区 view_key 声明 Inspector 形态，并同步 Console Bar 筛选
    /// 快照作为 Ads 数据上下文（未注册形态 → None → 零宽隐藏入口）。
    fn sync_inspector(&mut self, cx: &mut Context<Self>) {
        let mode = mode_for_view(self.view_key());
        let (project_id, country, date_from, date_to) = self
            .console_bar
            .as_ref()
            .map(|bar| {
                let filter = bar.read(cx).snapshot();
                (
                    filter.project_id,
                    filter.country,
                    filter.range.from,
                    filter.range.to,
                )
            })
            .unwrap_or((None, "US", None, None));
        self.inspector.update(cx, |inspector, cx| {
            inspector.set_mode(mode, project_id, country, date_from, date_to, cx);
        });
    }

    // ------------------------------------------------------------------
    // BLF-795：Console Bar 联动
    // ------------------------------------------------------------------

    /// 控制条筛选变化 → 转发给当前激活业务视图（三类代表页先行接入；
    /// 其余页面忽略——控制条配置本就不显示对应控件）
    fn forward_console_filter(&mut self, filter: ConsoleFilter, cx: &mut Context<Self>) {
        // Stage13（BLF-804）：着陆页接控制条项目选择器（页内数据随项目重拉）
        if self.show_dashboard {
            if let Some(view) = self.dashboard.clone() {
                view.update(cx, |v, cx| {
                    v.apply_console_filter(filter.project_id, filter.country, filter.range, cx)
                });
            }
        } else if self.show_daily_analysis {
            if let Some(view) = self.daily_analysis.clone() {
                view.update(cx, |v, cx| {
                    v.apply_console_filter(filter.project_id, filter.country, filter.range, cx)
                });
            }
        } else if self.show_ad_analysis {
            if let Some(view) = self.ad_analysis.clone() {
                view.update(cx, |v, cx| {
                    v.apply_console_filter(filter.project_id, filter.country, filter.range, cx)
                });
            }
        } else if self.show_monthly_report {
            if let Some(view) = self.monthly_report.clone() {
                view.update(cx, |v, cx| {
                    v.apply_console_filter(filter.project_id, filter.country, cx)
                });
            }
        }
        // BLF-796：筛选快照同步给 Inspector（仅广告态消费；同值 no-op）
        self.inspector.update(cx, |inspector, cx| {
            inspector.set_console_context(
                filter.project_id,
                filter.country,
                filter.range.from,
                filter.range.to,
                cx,
            )
        });
    }

    /// 页面路由变化 → 按新页面声明式配置换装控制条（保留用户已有筛选值）。
    /// 由 Sub-Nav Select 分发链统一调用（Rail 分类路由亦汇入该链）。
    fn sync_console_config(&mut self, url: &str, cx: &mut Context<Self>) {
        if let Some(bar) = &self.console_bar {
            bar.update(cx, |bar, cx| bar.set_config(console_config_for_url(url), cx));
        }
    }

    /// 业务视图懒创建后的统计推送订阅（Loaded 后 KPI → 控制条 pill；
    /// 订阅必须持有否则事件不送达，统一收进 `console_stats_subs`）
    fn subscribe_view_stats<V: gpui::EventEmitter<ConsoleStatsEvent> + 'static>(
        &mut self,
        view: &Entity<V>,
        cx: &mut Context<Self>,
    ) {
        let sub = cx.subscribe(view, |this, _view, ev: &ConsoleStatsEvent, cx| {
            if let Some(bar) = &this.console_bar {
                let stats = ev.0;
                bar.update(cx, |bar, cx| bar.set_stats(stats, cx));
            }
        });
        self.console_stats_subs.push(sub);
    }

    /// BLF-793：Rail 选中分类 → 默认视图路由。
    ///
    /// 路由实现 = 驱动 Sub-Nav 选中该分类的**第一项**（默认视图），复用现
    /// root.rs 视图分发链（懒创建 + show_* 标志 + 面包屑跟随），~30 视图
    /// 无需逐个改版。已在该分类内时不重路由——保留用户当前打开的子视图
    /// （如「财务资金」内从平台回款切到汇率信息后，再点 Rail 的财务资金
    /// 图标不会跳回平台回款）。同时把 Sub-Nav 列表切到该分类。
    fn on_rail_category_selected(&mut self, group_id: &str, cx: &mut Context<Self>) {
        if self.active_category.as_deref() == Some(group_id) {
            return;
        }
        let groups = sidebar_groups();
        let Some(group) = groups.iter().find(|g| g.id == group_id) else {
            return;
        };
        let Some(first) = group.items.first() else {
            return;
        };
        self.active_category = Some(group_id.to_string());
        self.sub_nav.update(cx, |sub_nav, cx| {
            sub_nav.set_active(Some(group_id.to_string()), cx);
            sub_nav.select(&first.url, &first.title, cx)
        });
    }

    /// BLF-794：⌘K 打开 / 再按关闭命令面板。打开即创建面板实体、聚焦检索框
    /// （承接输入法），订阅其事件（Navigate → 驱动导航并关闭；Dismissed → 关闭）。
    pub(crate) fn toggle_command_palette(
        &mut self,
        _: &crate::ToggleCommandPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.command_palette.is_some() {
            self.close_command_palette(cx);
            return;
        }
        let palette = cx.new(CommandPaletteView::new);
        cx.subscribe(&palette, |this, _palette, event: &CommandPaletteEvent, cx| {
            match event {
                CommandPaletteEvent::Navigate { url, title } => {
                    // ⌘K 命中跳转与侧栏点击走同一条分发链（Sub-Nav select →
                    // 视图切换 + 面包屑 + Rail 回写）
                    this.sub_nav.update(cx, |sub_nav, cx| {
                        sub_nav.select(url, title, cx);
                    });
                    this.close_command_palette(cx);
                }
                CommandPaletteEvent::Dismissed => this.close_command_palette(cx),
            }
        })
        .detach();
        palette.update(cx, |palette, cx| palette.ensure_input_focused(window, cx));
        self.command_palette = Some(palette);
        cx.notify();
    }

    /// 关闭命令面板（摘除实体；Esc / 失焦 / 选中跳转共用）。
    pub(crate) fn close_command_palette(&mut self, cx: &mut Context<Self>) {
        if self.command_palette.take().is_some() {
            cx.notify();
        }
    }

    /// P4-2：当前内容区视图身份（视图切换过渡动画 id 用）——视图变化时该键变化，
    /// `with_animation` 的元素状态随之重建，淡入动画重放。
    fn view_key(&self) -> &'static str {
        if self.show_dashboard {
            "dashboard"
        } else if self.show_site_navigation {
            "site-navigation"
        } else if self.show_store_navigation {
            "store-navigation"
        } else if self.show_daily_analysis {
            "daily-analysis"
        } else if self.show_sku_info {
            "sku-info"
        } else if self.show_ad_analysis {
            "ad-analysis"
        } else if self.show_ad_data {
            "ad-data"
        } else if self.show_monthly_report {
            "monthly-report"
        } else if self.show_platform_revenue {
            "platform-revenue"
        } else if self.show_scheduled_reports {
            "scheduled-reports"
        } else if self.show_project_goals {
            "project-goals"
        } else if self.show_portfolio_overview {
            "portfolio-overview"
        } else if self.show_return_analysis {
            "return-analysis"
        } else if self.show_inventory_analysis {
            "inventory-analysis"
        } else if self.show_inventory_ledger {
            "inventory-ledger"
        } else if self.show_replenishment {
            "replenishment"
        } else if self.show_seasonal_replenishment {
            "seasonal-replenishment"
        } else if self.show_weekly_product {
            "weekly-product-analysis"
        } else if self.show_research_analysis {
            "research-analysis"
        } else if self.show_product_analysis {
            "product-analysis"
        } else if self.show_new_product_calculation {
            "new-product-calculation"
        } else if self.show_shop_calculation {
            "shop-calculation"
        } else if self.show_shipment_management {
            "shipment-management"
        } else if self.show_order_info {
            "order-info"
        } else if self.show_exchange_rate {
            "exchange-rate"
        } else if self.show_vat_invoice {
            "vat-invoice"
        } else if self.show_commission {
            "commission"
        } else if self.show_model_selection {
            "model-selection"
        } else if self.show_crm_dashboard {
            "crm-dashboard"
        } else if self.show_crm_follow_ups {
            "crm-follow-ups"
        } else if self.show_crm_audit {
            "crm-audit"
        } else if self.show_crm_customers {
            "crm-customers"
        } else if self.show_crm_leads {
            "crm-leads"
        } else if self.show_crm_tasks {
            "crm-tasks"
        } else if self.show_crm_settings {
            "crm-settings"
        } else if self.show_page_render {
            "page-render"
        } else if self.show_project_info {
            "project-info"
        } else if self.show_operator_management {
            "operator-management"
        } else if self.show_alerts_center {
            "alerts-center"
        } else if self.show_database_status {
            "database-status"
        } else if self.show_changelog {
            "changelog"
        } else if self.show_ai_chat {
            "ai-chat"
        } else if self.show_ai_insights {
            "ai-insights"
        } else if self.show_customer_service {
            "customer-service"
        } else if self.show_virtual_office {
            "virtual-office"
        } else if self.show_markdown_to_word {
            "markdown-to-word"
        } else if self.show_system_logs {
            "system-logs"
        } else if self.show_agent_management {
            "agent-management"
        } else if self.show_account_management {
            "account-management"
        } else if self.show_platform_inspection {
            "platform-inspection"
        } else if self.show_auto_upload {
            "auto-upload"
        } else {
            "placeholder"
        }
    }

    /// P4-2：当前内容区视图（带视图切换过渡动画）。
    ///
    /// 选中侧栏项 / Dashboard↔业务页切换时，内容视图从 0→1 淡入（`with_animation` 的
    /// 动画 id 编码当前视图身份——视图变化 → 元素状态重建 → 动画重放）；减弱动态时
    /// 直接渲染（瞬时切换）。
    fn content_view(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let reduce = crate::motion::reduce_motion(cx);
        let active = if self.show_dashboard {
            self.dashboard.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_site_navigation {
            self.site_navigation.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_store_navigation {
            self.store_navigation.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_daily_analysis {
            self.daily_analysis.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_sku_info {
            self.sku_info.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_ad_analysis {
            self.ad_analysis.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_ad_data {
            self.ad_data.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_monthly_report {
            self.monthly_report.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_platform_revenue {
            self.platform_revenue.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_scheduled_reports {
            self.scheduled_reports.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_project_goals {
            self.project_goals.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_portfolio_overview {
            self.portfolio_overview.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_return_analysis {
            self.return_analysis.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_inventory_analysis {
            self.inventory_analysis.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_inventory_ledger {
            self.inventory_ledger.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_replenishment {
            self.replenishment.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_seasonal_replenishment {
            self.seasonal_replenishment.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_weekly_product {
            self.weekly_product.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_research_analysis {
            self.research_analysis.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_product_analysis {
            self.product_analysis.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_new_product_calculation {
            self.new_product_calculation.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_shop_calculation {
            self.shop_calculation.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_shipment_management {
            self.shipment_management.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_order_info {
            self.order_info.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_exchange_rate {
            self.exchange_rate.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_vat_invoice {
            self.vat_invoice.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_commission {
            self.commission.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_model_selection {
            self.model_selection.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_crm_dashboard {
            self.crm_dashboard.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_crm_follow_ups {
            self.crm_follow_ups.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_crm_audit {
            self.crm_audit.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_crm_customers {
            self.crm_customers.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_crm_leads {
            self.crm_leads.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_crm_tasks {
            self.crm_tasks.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_crm_settings {
            self.crm_settings.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_page_render {
            self.page_render.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_project_info {
            self.project_info.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_operator_management {
            self.operator_management.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_alerts_center {
            self.alerts_center.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_database_status {
            self.database_status.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_changelog {
            self.changelog.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_ai_chat {
            self.ai_chat.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_ai_insights {
            self.ai_insights.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_customer_service {
            self.customer_service.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_virtual_office {
            self.virtual_office.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_markdown_to_word {
            self.markdown_to_word.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_system_logs {
            self.system_logs.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_agent_management {
            self.agent_management.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_account_management {
            self.account_management.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_platform_inspection {
            self.platform_inspection.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else if self.show_auto_upload {
            self.auto_upload.clone().map_or_else(
                || self.content.clone().into_any_element(),
                |view| view.into_any_element(),
            )
        } else {
            self.content.clone().into_any_element()
        };

        // P4-2：视图切换过渡。AnyElement 不实现 Styled，先包一层 div 再套淡入动画；
        // 减弱动态时直接渲染（瞬时切换）。
        let wrapped = div().id("content-active").size_full().child(active);
        crate::motion::view_fade_in(
            gpui::SharedString::from(format!("view-{}", self.view_key())),
            wrapped,
            reduce,
        )
    }

    fn on_logout_click(&mut self, _: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(RootViewEvent::Logout);
    }

    /// P4-1 修复：武装窗口拖拽（内容区头部鼠标按下）
    fn arm_drag(&mut self) {
        self.should_move = true;
    }

    /// P4-1 修复：解除拖拽武装（松开 / 在头部外按下）
    fn disarm_drag(&mut self) {
        self.should_move = false;
    }

    /// P4-1 修复：消费拖拽武装——返回 true 表示应启动窗口拖拽并解除武装。
    /// 拆成无 `Window` 依赖的方法以便单测锁状态机。
    fn consume_drag_armed(&mut self) -> bool {
        if self.should_move {
            self.should_move = false;
            true
        } else {
            false
        }
    }

    /// P4-1 修复：鼠标移动时若已武装则启动原生窗口拖拽（与 gpui-component TitleBar
    /// 行为一致——按下并拖动 = 拖窗；按下即松 = 点击，头部内按钮不受影响）
    fn maybe_start_window_move(&mut self, window: &mut Window) {
        if self.consume_drag_armed() {
            window.start_window_move();
        }
    }
}

impl EventEmitter<RootViewEvent> for RootView {}

impl Render for RootView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);

        // BLF-793 六区外壳（尺寸常量见 views::shell）：
        //
        // ┌────┬──────────┬────────────────────┬───────────┐
        // │Rail│ Sub-Nav  │ Console Bar (36px) │ Inspector │
        // │48px│          ├────────────────────┤  (300)    │
        // │    │          │ Canvas (flex-1)    │           │
        // ├────┴──────────┴────────────────────┴───────────┤
        // │ Footer (24px)                                   │
        // └─────────────────────────────────────────────────┘
        //
        // 容器外 padding 0；区间层级一律 1px 分隔线表达（无重投影）。
        div()
            .id("root")
            .flex()
            .flex_col()
            .size_full()
            .relative()
            // BLF-793 键盘可达：tab / shift-tab 在窗口内 tab stop 间前后遍历
            // （Master Rail 的分类图标与底部入口均为 tab stop；动作绑定见
            // main.rs，此处为全窗口唯一处理点——任意焦点下都会冒泡到根容器）
            .on_action(cx.listener(|_, _: &crate::TabNext, window, _| {
                window.focus_next();
            }))
            .on_action(cx.listener(|_, _: &crate::TabPrev, window, _| {
                window.focus_prev();
            }))
            // BLF-794：⌘K / Ctrl+K 命令面板 + ⌘\ 折叠 Sub-Nav（全局快捷键，
            // 绑定注册见 main.rs；此处为全窗口唯一处理点）
            .on_action(cx.listener(Self::toggle_command_palette))
            .on_action(cx.listener(|this, _: &crate::ToggleSubNav, _, cx| {
                this.sub_nav.update(cx, |sub_nav, cx| sub_nav.toggle_collapsed(cx));
            }))
            // BLF-796：⌘B 切换右侧 Inspector 抽屉（绑定见 main.rs；未注册形态
            // 页面内 toggle_visible 自身 no-op——无入口亦不响应快捷键）
            .on_action(cx.listener(|this, _: &crate::ToggleInspector, _, cx| {
                this.inspector.update(cx, |inspector, cx| inspector.toggle_visible(cx));
            }))
            // BLF-794：命令面板 ↑↓ 选择（无 key context 全局绑定，面板未打开时
            // 本监听器不存在于渲染树 → 按键继续传播到原绑定）
            .on_action(
                cx.listener(|this, _: &crate::PaletteSelectPrev, _, cx| {
                    if let Some(palette) = &this.command_palette {
                        palette.update(cx, |p, cx| p.move_cursor(-1, cx));
                    }
                }),
            )
            .on_action(
                cx.listener(|this, _: &crate::PaletteSelectNext, _, cx| {
                    if let Some(palette) = &this.command_palette {
                        palette.update(cx, |p, cx| p.move_cursor(1, cx));
                    }
                }),
            )
            // P4-3（BLF-709）材质收敛：主窗口背景改用不透明（main.rs 移除
            // `WindowBackgroundAppearance::Blurred`）——GPUI 0.2.2 无 NSVisualEffectView
            // 接入，整窗模糊 + 半透明叠加观感粗糙且禁用亚像素文字渲染（apple-glass.md
            // Tier 4/6）。根容器画不透明 window_bg 兜底（分区切换期间无透底/间隙）。
            .bg(theme.window_bg)
            // BLF-828：Win11 Fluent 视觉基调——Mica 近似暗色垂直渐变（仅 Windows）。
            // GPUI 0.2.2 无 DWM_SYSTEMBACKDROP_TYPE 接入，无法启用原生 Mica；
            // 按 apple-glass.md Tier 4「跨平台近似」原则用极低对比暗色渐变模拟
            // 质感意向（不宣称原生 Mica）。macOS 零改动（保持纯实色）。
            .when(crate::platform::is_windows(), |root| {
                root.bg(gpui::linear_gradient(
                    180.0,
                    gpui::linear_color_stop(
                        crate::theme::hex_color(crate::platform::WIN11_MICA_TOP),
                        0.0,
                    ),
                    gpui::linear_color_stop(
                        crate::theme::hex_color(crate::platform::WIN11_MICA_BOTTOM),
                        1.0,
                    ),
                ))
            })
            .child(
                // 上区行：Rail | Sub-Nav | 中央列 | Inspector
                div()
                    .id("shell-upper")
                    .flex()
                    .flex_row()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .overflow_hidden()
                    .child(self.rail.clone())
                    // Sub-Nav 插槽：BLF-794 可折叠模块选择器（180~220px 自适应 +
                    // 折叠至 0 + ⌘K 入口），宽度/分隔线由视图自管
                    .child(
                        div()
                            .id("sub-nav-slot")
                            .h_full()
                            .flex_none()
                            .bg(theme.panel_bg)
                            .child(self.sub_nav.clone()),
                    )
                    // 中央列：Console Bar 插槽 + Canvas
                    .child(
                        div()
                            .id("center-col")
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .bg(theme.window_bg)
                            // Console Bar 插槽（36px）：BLF-795 起由面包屑 + 四件套
                            // 控制条（登录态）+ 用户 chrome 组成并承担窗口拖拽区；
                            // BLF-828 Windows 下右端另有 caption buttons
                            .child(content_header(
                                &self.breadcrumb,
                                self.sub_nav_collapsed,
                                self.console_bar.clone(),
                                &self.session,
                                window.is_maximized(),
                                self.snap_layout_open,
                                cx,
                            ))
                            .when(
                                self.session
                                    .as_ref()
                                    .and_then(|s| s.warning.as_ref())
                                    .is_some(),
                                |col| col.child(warning_banner(&self.session, &theme)),
                            )
                            .child(
                                div()
                                    .id("canvas")
                                    .flex_1()
                                    .min_h_0()
                                    .w_full()
                                    .overflow_hidden()
                                    .bg(theme.window_bg)
                                    .child(self.content_view(cx)),
                            ),
                    )
                    // Inspector 抽屉（BLF-796）：Cmd+B 自适应三态内容 + 280~340
                    // 拖拽调宽；宽度/开合过渡与未注册页零宽隐藏由视图自管
                    //（对齐 Sub-Nav 插槽「宽度和分隔线自管」惯例），Canvas 随
                    // flex 布局在开合动画中平滑扩展
                    .child(self.inspector.clone()),
            )
            // Footer 插槽（24px）：BLF-797 起实装全局系统状态栏——24px 汇率
            // ticker / 同步引擎 DB 状态 / 未读通知徽标 / 延迟指标（登录态创建；
            // 无会话回落空面板，高度与顶部分隔不变）
            .child(
                div()
                    .id("footer-slot")
                    .w_full()
                    .flex_none()
                    .h(px(FOOTER_HEIGHT))
                    .bg(theme.window_bg)
                    .border_t_1()
                    .border_color(theme.separator)
                    .when_some(self.footer.clone(), |slot, footer| slot.child(footer)),
            )
            // BLF-794：⌘K 命令面板 overlay（最后 child = 最顶层；absolute 铺满全窗）
            .when_some(
                self.command_palette.clone(),
                |root, palette| root.child(palette),
            )
    }
}

impl Focusable for RootView {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

/// Console Bar 插槽内容（BLF-793 占位 → BLF-795 四件套实装）：左侧为面包屑路径
/// 与控制条四件套（按页面声明式配置渲染；折叠态下最左还有「展开侧栏」按钮），
/// 右侧为已登录用户与退出登录；高 36px 固定（插槽契约）。
/// 业务标题不在头部渲染——chrome 标题与页面 PageHeader 大标题重复，
/// 去重后头部仅保留面包屑导航上下文（决策见 BLF-760 完成评论）。
/// 原 `TitleBar` 的窗口拖拽职责由本条承担（`WindowControlArea::Drag`），
/// traffic lights 现悬于最左 Master Rail 之上。
fn content_header(
    breadcrumb: &[String],
    collapsed: bool,
    console_bar: Option<Entity<ConsoleBarView>>,
    session: &Option<SessionInfo>,
    maximized: bool,
    snap_open: bool,
    cx: &mut Context<RootView>,
) -> impl IntoElement {
    let theme = AppTheme::current(cx);

    div()
        .id("content-header")
        .flex()
        .items_center()
        .w_full()
        .flex_none()
        .h(px(CONSOLE_BAR_HEIGHT))
        .px_3()
        .gap_3()
        .border_b_1()
        .border_color(theme.separator)
        // bg Panel token（父 issue「空间栅格」控制条规格：与 Canvas 区分层级）
        .bg(theme.panel_bg)
        // BLF-828：Windows 下右侧 caption buttons 覆盖在头部右端之上，
        // 用户身份簇需避让 3 × 36px；macOS 无此区。
        .when(crate::platform::is_windows(), |this| {
            this.pr(px(crate::platform::CAPTION_ZONE_WIDTH))
        })
        .child(
            div()
                .id("content-header-left")
                .flex()
                .items_center()
                .gap_3()
                .flex_1()
                .min_w_0()
                .when(collapsed, |this| this.child(expand_sidebar_button(cx)))
                .child(breadcrumb_row(breadcrumb))
                // BLF-795：四件套控制条（项目/站点/日期/统计 pill，按页配置）
                .when_some(console_bar, |row, bar| row.child(bar)),
        )
        .child(session_cluster(session, theme, cx))
        // BLF-828：Windows caption buttons 挂在头部最右（渲染顺序上位于
        // 身份簇之后；配合上面的 pr 避让不遮挡内容）
        .when(crate::platform::is_windows(), |this| {
            this.child(caption_buttons(maximized, snap_open, &theme, cx))
        })
        .map(|el| attach_window_drag(el, cx))
}

/// P4-1 修复：给内容区头部挂窗口拖拽交互——复刻 gpui-component `TitleBar` 的交互链：
/// `WindowControlArea::Drag` 注册原生拖拽区；按下武装 → 移动时 `start_window_move()`
/// 启动原生窗口拖拽；未移动直接松开 = 普通点击（外观菜单/退出登录仍可交互）；macOS
/// 双击 = `titlebar_double_click()`，Windows 双击 = `zoom_window()`（BLF-828：
/// Win11 惯例双击标题栏最大化/还原）。与侧栏头部（sidebar.rs）构成左右两条拖拽区。
fn attach_window_drag(
    el: gpui::Stateful<gpui::Div>,
    cx: &mut Context<RootView>,
) -> gpui::Stateful<gpui::Div> {
    el.window_control_area(WindowControlArea::Drag)
        .on_double_click(|_, window, _| {
            // macOS：titlebar_double_click 跟随系统「双击窗口标题栏」设置（缩放/最小化/无操作）；
            // Windows：Win11 惯例固定为最大化/还原切换（zoom 即 toggle）。
            if crate::platform::is_macos() {
                window.titlebar_double_click();
            } else {
                window.zoom_window();
            }
        })
        .on_mouse_down_out(cx.listener(|this, _, _, _| this.disarm_drag()))
        .on_mouse_down(
            MouseButton::Left,
            cx.listener(|this, _, _, _| this.arm_drag()),
        )
        .on_mouse_up(
            MouseButton::Left,
            cx.listener(|this, _, _, _| this.disarm_drag()),
        )
        .on_mouse_move(
            cx.listener(|this, _: &MouseMoveEvent, window, _| this.maybe_start_window_move(window)),
        )
}

/// BLF-828：Windows caption buttons 区——右上角自绘最小化/最大化(还原)/关闭三钮。
///
/// 视觉对齐 Win11 Fluent：每钮 [`CAPTION_BUTTON_WIDTH`]×36px、图标 10px 细线、
/// hover 中性高亮、关闭钮 hover 红。交互链与 gpui-component TitleBar 同源：
/// 元素注册 `WindowControlArea::Min/Max/Close` hitbox → Windows 端 WM_NCHITTEST
/// 返回 HTMINBUTTON/HTMAXBUTTON/HTCLOSE → 消息循环在 NC mouse up 时执行原生
/// 最小化/最大化还原/关闭（见 gpui platform/windows/events.rs）。因此**应用侧不写
/// 点击逻辑**——这也保证 hover 弹出 Snap Layouts 与原生点击不冲突（NC down 会先
/// 派发 GPUI MouseDown，未消费才落回系统处理；浮层打开时点最大化钮由浮层关闭
/// 监听消费，不会误触发最大化）。
///
/// macOS 下返回空 div（traffic lights 悬于侧栏头部，无此区）。
fn caption_buttons(
    maximized: bool,
    snap_open: bool,
    theme: &AppTheme,
    cx: &mut Context<RootView>,
) -> gpui::AnyElement {
    if !crate::platform::is_windows() {
        return div().id("caption-buttons-empty").into_any_element();
    }

    let btn_w = px(crate::platform::CAPTION_BUTTON_WIDTH);
    let icon_size = px(10.0);

    // 三钮通用基座：等宽等高、居中图标、hover/active 反馈。
    // 注意不用 .window_control_area 的元素 hover 样式做状态判定——
    // NC 消息路径下 hover 样式仍生效（NC mouse move 会派发 MouseMove），
    // 但点击行为完全交给系统。
    fn button_base(
        id: &'static str,
        w: gpui::Pixels,
        theme: &AppTheme,
    ) -> gpui::Stateful<gpui::Div> {
        div()
            .id(id)
            .flex()
            .items_center()
            .justify_center()
            .w(w)
            .h_full()
            .flex_shrink_0()
            .text_color(theme.text_secondary)
            .hover(|style| style.bg(theme.muted_fill).text_color(theme.text_primary))
            .active(|style| style.bg(theme.separator))
    }

    let maximize_icon = if maximized {
        "icons/window-restore.svg"
    } else {
        "icons/window-maximize.svg"
    };

    div()
        .id("caption-buttons")
        .flex()
        .items_center()
        .h_full()
        .flex_shrink_0()
        .child(
            // 最小化钮
            button_base("caption-minimize", btn_w, theme)
                .window_control_area(WindowControlArea::Min)
                .child(
                    gpui::svg()
                        .path("icons/window-minimize.svg")
                        .size(icon_size),
                ),
        )
        .child(snap_layout_button(
            maximize_icon,
            snap_open,
            btn_w,
            icon_size,
            theme,
            cx,
        ))
        .child(
            // 关闭钮：hover 红（Win11 Fluent 惯例）
            div()
                .id("caption-close")
                .flex()
                .items_center()
                .justify_center()
                .w(btn_w)
                .h_full()
                .flex_shrink_0()
                .window_control_area(WindowControlArea::Close)
                .text_color(theme.text_secondary)
                .hover(|style| {
                    style
                        .bg(theme.danger)
                        .text_color(crate::theme::hex_color(0xffffff))
                })
                .active(|style| style.bg(theme.danger).opacity(0.8))
                .child(gpui::svg().path("icons/window-close.svg").size(icon_size)),
        )
        .into_any_element()
}

/// BLF-828：Snap Layouts 最大化钮——本体注册 `WindowControlArea::Max` 原生
/// 最大化/还原；hover 时向下弹出 Snap 布局选择浮层（交付项 2 的常用四分格子集：
/// 左半 / 右半 / 左 2:1 / 右 1:2，见 [`SNAP_LAYOUTS`]）。选中项由
/// [`apply_snap_layout`] 按当前显示器工作区计算目标 bounds 并移动/缩放窗口。
fn snap_layout_button(
    maximize_icon: &'static str,
    snap_open: bool,
    btn_w: gpui::Pixels,
    icon_size: gpui::Pixels,
    theme: &AppTheme,
    cx: &mut Context<RootView>,
) -> gpui::AnyElement {
    let radius = theme.radius;
    div()
        .id("caption-maximize")
        .relative()
        .flex()
        .items_center()
        .justify_center()
        .w(btn_w)
        .h_full()
        .flex_shrink_0()
        .window_control_area(WindowControlArea::Max)
        .text_color(theme.text_secondary)
        .hover(|style| style.bg(theme.muted_fill).text_color(theme.text_primary))
        .active(|style| style.bg(theme.separator))
        // hover 展开浮层（NC mouse move 会派发 GPUI MouseMove，on_hover 可用；
        // 移出即收起——与 Win11 Snap 弹层的短暂驻留语义近似，简单可靠）
        .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
            if this.snap_layout_open != *hovered {
                this.snap_layout_open = *hovered;
                cx.notify();
            }
        }))
        .child(gpui::svg().path(maximize_icon).size(icon_size))
        // Snap 浮层（absolute 定位在按钮下方右对齐；仅展开态渲染）。
        // 注意：浮层元素**不**注册 WindowControlArea——鼠标进入浮层即离开
        // 最大化钮 hitbox，on_hover(false) 收起逻辑由 open 状态门控（浮层自身
        // hover 时保持 open，见下方 on_hover 驻留）。
        .when(snap_open, |btn| {
            btn.child(
                div()
                    .id("snap-layout-popover")
                    .absolute()
                    .top_full()
                    .right_0()
                    .mt_1()
                    .flex()
                    .gap_1()
                    .p_1()
                    .rounded(px(radius))
                    .bg(theme.card_bg)
                    .border_1()
                    .border_color(theme.separator)
                    // 鼠标移入浮层期间保持展开（离开时整体收起）
                    .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                        if !*hovered && this.snap_layout_open {
                            this.snap_layout_open = false;
                            cx.notify();
                        }
                    }))
                    .child(snap_layout_menu(cx)),
            )
        })
        .into_any_element()
}

/// BLF-828：Snap Layouts 四分格布局选项（常用子集）。
#[derive(Debug, Clone, Copy, PartialEq)]
struct SnapLayout {
    /// 相对显示器工作区的比例矩形（0..1）：(x, y, w, h)
    rect: (f32, f32, f32, f32),
    /// 预览小图标签（无障碍/调试用途；浮层预览用比例小格表达）
    label: &'static str,
}

const SNAP_LAYOUTS: [SnapLayout; 4] = [
    SnapLayout {
        rect: (0.0, 0.0, 0.5, 1.0),
        label: "左半",
    },
    SnapLayout {
        rect: (0.5, 0.0, 0.5, 1.0),
        label: "右半",
    },
    SnapLayout {
        rect: (0.0, 0.0, 0.67, 1.0),
        label: "左三分之二",
    },
    SnapLayout {
        rect: (0.33, 0.0, 0.67, 1.0),
        label: "右三分之二",
    },
];

/// BLF-828：Snap 布局选择菜单（四个预览小格；点击套用对应布局）。
fn snap_layout_menu(cx: &mut Context<RootView>) -> impl IntoElement {
    let cells: Vec<gpui::AnyElement> = SNAP_LAYOUTS
        .iter()
        .map(|layout| {
            let (rx, _ry, rw, _rh) = layout.rect;
            div()
                .id(SharedString::from(format!("snap-{}", (rw * 100.0) as u32)))
                .w(px(44.0))
                .h(px(28.0))
                .p(px(3.0))
                .rounded(px(4.0))
                .cursor(CursorStyle::PointingHand)
                .on_mouse_up(MouseButton::Left, {
                    let rect = layout.rect;
                    cx.listener(move |this, _, window, cx| {
                        apply_snap_layout(this, rect, window, cx);
                        cx.notify();
                    })
                })
                // 预览小格：按布局比例画一个高亮矩形示意分区形状
                .child(
                    div()
                        .w_full()
                        .h_full()
                        .rounded(px(2.0))
                        .bg(hex_color(crate::theme::BORDER_SEPARATOR))
                        .child(
                            div()
                                .relative()
                                .h_full()
                                .bg(hex_color(crate::theme::SEMANTIC_POSITIVE))
                                .ml(px(rx * 38.0))
                                .w(px(rw * 38.0)),
                        ),
                )
                .into_any_element()
        })
        .collect();
    div().flex().gap_1().children(cells)
}

/// BLF-828：应用 Snap 布局——把窗口缩放到当前显示器工作区的比例矩形大小。
///
/// 实现说明：GPUI 0.2.2 无跨平台 `set_position`（Windows `resize` 带 SWP_NOMOVE，
/// 只改尺寸不动位置），因此本实现为「尺寸贴格」近似：按目标格宽高比把窗口
/// resize 到对应大小；若窗口已最大化则先 `zoom_window()` 还原到窗口态再缩放。
/// 位置不自动移动到屏幕左/右半边——用户拖动一次即可对齐。这是当前 gpui
/// 能力下的已知局限（BLF-828 已注明），待上游提供 set_bounds 后替换为精确贴格。
fn apply_snap_layout(
    this: &mut RootView,
    rect: (f32, f32, f32, f32),
    window: &mut Window,
    cx: &App,
) {
    this.snap_layout_open = false;
    let (_, _, ratio_w, ratio_h) = rect;

    // 已最大化先还原（否则 resize 对最大化窗口无效/被系统忽略）
    if window.is_maximized() {
        window.zoom_window();
    }

    // 以显示器 bounds 为基准计算目标内容尺寸（工作区近似取全屏 bounds）
    if let Some(display) = window.display(cx) {
        let db = display.bounds();
        let target_w = db.size.width * ratio_w;
        let target_h = db.size.height * ratio_h;
        window.resize(gpui::size(target_w, target_h));
    }
}



/// 面包屑路径行：`一级分类 › 二级标题`（gpui-component Breadcrumb，末项为
/// 当前页标题——前景色高亮，前级为分类——弱化色；自动带 chevron 分隔）。
fn breadcrumb_row(path: &[String]) -> impl IntoElement {
    if path.is_empty() {
        return div().id("content-breadcrumb-empty");
    }
    div()
        .id("content-breadcrumb")
        .text_xs()
        .child(Breadcrumb::new().children(path.iter().map(|s| BreadcrumbItem::new(s.clone()))))
}

/// 折叠态内容区头部最左的「展开侧栏」按钮（BLF-794：Sub-Nav 整列折叠至 0 后，
/// 从这里恢复——也可按 ⌘\ / Ctrl+\ 或点 Rail 分类图标区域外的快捷键切换）。
fn expand_sidebar_button(cx: &mut Context<RootView>) -> impl IntoElement {
    Button::new("sidebar-expand-button")
        .ghost()
        .small()
        .icon(Icon::new(IconName::PanelLeftOpen).with_size(px(14.0)))
        // BLF-828：快捷键文案平台化（macOS ⌘\ / Windows Ctrl+\）
        .tooltip(format!("展开侧栏（{}）", crate::platform::combo("\\")))
        .on_click(cx.listener(|this, _, _, cx| {
            this.sub_nav
                .update(cx, |sub_nav, cx| sub_nav.toggle_collapsed(cx));
        }))
}

/// 内容区头部右侧：用户身份 + 退出登录（P4-1 由原标题栏迁入）
fn session_cluster(
    session: &Option<SessionInfo>,
    theme: AppTheme,
    cx: &mut Context<RootView>,
) -> impl IntoElement {
    let Some(s) = session else {
        return div().id("session-cluster-empty");
    };
    // 退出登录按钮 hover/active 用 gpui-component 语义色（中性反馈）
    let component = cx.theme().clone();
    let role_label = match s.user.role_type {
        gui_domain::auth::UserRoleType::Admin => "管理员",
        gui_domain::auth::UserRoleType::Operator => "运营",
        gui_domain::auth::UserRoleType::Businessdev => "业务拓展",
    };

    gpui_component::h_flex()
        .id("session-cluster")
        .items_center()
        .gap_4()
        .child(
            div()
                .text_sm()
                .text_color(theme.text_muted)
                .child(format!("{} · {}", s.user.name, role_label)),
        )
        .child(
            div()
                .id("logout-button")
                .px_2()
                .py_0p5()
                .rounded(px(theme.radius))
                .text_sm()
                .text_color(theme.text_secondary)
                .cursor(CursorStyle::PointingHand)
                .hover(|style| style.bg(component.secondary_hover))
                .active(|style| style.bg(component.secondary_active))
                .on_mouse_up(MouseButton::Left, cx.listener(RootView::on_logout_click))
                .child("退出登录"),
        )
}

/// 内容区头部下方警告窄条（Keychain 持久化失败 / 服务器连接失败等非致命提示）
///
/// P4-1：随标题栏移除，横幅从窗口顶部整行迁入内容列头部之下（不遮侧栏）。
fn warning_banner(session: &Option<SessionInfo>, theme: &AppTheme) -> impl IntoElement {
    let Some(s) = session else {
        return div().id("warning-banner-empty");
    };
    let Some(warning) = &s.warning else {
        return div().id("warning-banner-empty");
    };

    div()
        .id("warning-banner")
        .flex()
        .items_center()
        .w_full()
        .px_4()
        .py_1()
        .text_xs()
        // 根容器已透明（P2-3 材质），横幅需自带不透明底保证文字可读
        .bg(theme.window_bg)
        .text_color(theme.warning)
        .child(warning.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{set_theme_pref, ThemePreference};
    use gpui_component::TitleBar;
    use gui_domain::auth::UserRoleType;

    /// 锁 P2-1 窗口 chrome 契约（P4-1 更新语义）：主窗口必须透明标题栏 + traffic lights
    /// 位于 (9,9)——P4-1 移除自绘 TitleBar 后系统红绿灯直接悬于**左侧侧栏头部**之上
    /// （侧栏头部顶部留避让区，见 sidebar.rs `TRAFFIC_LIGHTS_CLEARANCE`）。
    #[test]
    fn title_bar_options_contract() {
        let options = TitleBar::title_bar_options();
        assert!(
            options.appears_transparent,
            "标题栏必须透明以露出侧栏头部（红绿灯悬于其上）"
        );
        assert_eq!(
            options.traffic_light_position,
            Some(gpui::point(gpui::px(9.0), gpui::px(9.0))),
            "traffic lights 必须定位到 (9,9)（gpui-component 默认，悬于侧栏头部）"
        );
    }

    /// 渲染冒烟（无会话）：侧栏 + 内容区头部 + Dashboard 着陆页骨架可完整渲染不 panic。
    #[gpui::test]
    async fn root_renders_content_header_without_session(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (_view, _window_cx) = cx.add_window_view(|_window, cx| RootView::new(cx, None));
    }

    /// 渲染冒烟（有会话）：内容区头部用户身份 + 退出登录 + 警告窄条路径可渲染。
    /// client 指向 127.0.0.1:1（必拒绝连接），Dashboard 首屏拉取会快速进入错误态，
    /// 不依赖网络环境。
    #[gpui::test]
    async fn root_renders_content_header_with_session(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-test".into(),
                name: "测试用户".into(),
                email: "test@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: true,
                is_active: true,
                role_type: UserRoleType::Admin,
                session_id: "s-test".into(),
                api_key: String::new(),
            },
            warning: Some("无法连接服务器：test".into()),
        };
        let (_view, _window_cx) =
            cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
    }

    /// BLF-793：Rail 分类选中 → 默认视图路由——点「财务资金」应打开该组第一项
    /// （平台回款），面包屑/标题跟随，active_category 同步。
    #[gpui::test]
    async fn rail_category_select_routes_default_view(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, None));
        let rail = cx.read(|app| view.read(app).rail.clone());

        // 初始：无会话 → 无着陆页，无激活分类
        cx.read(|app| {
            let root = view.read(app);
            assert_eq!(root.active_category, None);
            assert!(!root.show_dashboard, "无会话时不应显示 Dashboard 着陆页");
            assert!(!root.show_platform_revenue, "路由前不应显示任何业务视图");
        });

        rail.update(cx, |rail_view, cx| rail_view.select_category("finance", cx));
        cx.read(|app| {
            let root = view.read(app);
            assert!(
                root.show_platform_revenue,
                "应路由到财务资金组默认视图（平台回款）"
            );
            assert!(!root.show_dashboard, "着陆页应让位");
            assert_eq!(root.current_title, "平台回款");
            assert_eq!(
                root.breadcrumb,
                vec!["财务资金".to_string(), "平台回款".to_string()]
            );
            assert_eq!(root.active_category.as_deref(), Some("finance"));
        });
    }

    /// BLF-793：反向绑定——Sub-Nav 侧栏选中子项后 Rail 高亮跟随所属分类；
    /// 同分类内切换子视图后再点 Rail 图标不重路由（保留当前子视图）。
    #[gpui::test]
    async fn rail_binding_follows_and_preserves_sub_view(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, None));
        let rail = cx.read(|app| view.read(app).rail.clone());
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        // 侧栏选「运营 → 销售数据」→ Rail 高亮运营
        sub_nav.update(cx, |this, cx| {
            this.select("/dashboard/operations/daily-analysis", "销售数据", cx)
        });
        cx.read(|app| {
            let root = view.read(app);
            assert_eq!(root.active_category.as_deref(), Some("operations"));
            assert!(root.show_daily_analysis);
        });

        // 点 Rail「报表中心」→ 路由到该组默认视图（财务月报）
        rail.update(cx, |rail_view, cx| rail_view.select_category("reports", cx));
        cx.read(|app| {
            let root = view.read(app);
            assert!(root.show_monthly_report);
            assert_eq!(root.active_category.as_deref(), Some("reports"));
        });

        // 同分类内切到「定时报告」→ 再点 Rail「报表中心」不跳回默认视图
        sub_nav.update(cx, |this, cx| {
            this.select("/dashboard/reports/scheduled-reports", "定时报告", cx)
        });
        rail.update(cx, |rail_view, cx| rail_view.select_category("reports", cx));
        cx.read(|app| {
            let root = view.read(app);
            assert!(
                root.show_scheduled_reports,
                "同分类重复点击应保留当前子视图"
            );
            assert!(!root.show_monthly_report, "不应重路由回财务月报");
        });
    }

    /// BLF-795 review 阻塞项回归：返回已存在视图时控制条快照必须回放——
    /// 进入销售数据页（快照 F1=默认）→ 切广告分析页 → 控制条切 P2/DE（转发
    /// 广告视图并持久化）→ 返回销售数据页：常驻缓存（无销毁路径）的日销售
    /// 视图必须对齐 F2——条是唯一权威状态，条变页不变即破坏契约。
    #[gpui::test]
    async fn console_filter_snapshot_replays_when_reentering_cached_view(
        cx: &mut gpui::TestAppContext,
    ) {
        cx.update(gpui_component::init);
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-replay".into(),
                name: "回放测试".into(),
                email: "replay@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: false,
                is_active: true,
                role_type: UserRoleType::Operator,
                session_id: "s-replay".into(),
                api_key: String::new(),
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        // ① 进入销售数据页：懒创建 + 快照 F1（默认 US / 全部项目 / 近 7 天）
        sub_nav.update(cx, |this, cx| {
            this.select(DAILY_ANALYSIS_URL, "销售数据", cx)
        });
        cx.read(|app| {
            let daily = view
                .read(app)
                .daily_analysis
                .clone()
                .expect("首次进入应创建销售数据视图");
            let (project, country, _) = daily.read(app).console_filter_state();
            assert_eq!(project, None);
            assert_eq!(country, "US", "首建应与控制条默认快照一致");
        });

        // ② 切到广告分析页 → 控制条切项目 P2 + 站点 DE（经 Changed 转发当页视图；
        //    bar 句柄顶层驱动，避免 root re-entrant borrow）
        sub_nav.update(cx, |this, cx| {
            this.select(AD_ANALYSIS_URL, "广告分析", cx)
        });
        let bar = cx
            .read(|app| view.read(app).console_bar.clone())
            .expect("有会话必有控制条");
        // apply_filter = 恢复/测试用公开入口（菜单回调 select_* 为私有）
        bar.update(cx, |bar, cx| {
            let mut next = bar.snapshot();
            next.project_id = Some(42);
            next.country = "DE";
            bar.apply_filter(next, cx);
        });
        cx.read(|app| {
            let root = view.read(app);
            let ad = root.ad_analysis.clone().expect("应已创建广告分析视图");
            let (project, country, _) = ad.read(app).console_filter_state();
            assert_eq!(project, Some(42), "改条当页应即时生效");
            assert_eq!(country, "DE");
            assert_eq!(root.console_bar.as_ref().unwrap().read(app).snapshot().project_id, Some(42));
        });

        // ③ 返回销售数据页（视图已缓存，不再走首建分支）：快照必须回放对齐
        sub_nav.update(cx, |this, cx| {
            this.select(DAILY_ANALYSIS_URL, "销售数据", cx)
        });
        cx.read(|app| {
            let daily = view.read(app).daily_analysis.clone().unwrap();
            let (project, country, range) = daily.read(app).console_filter_state();
            assert_eq!(
                project,
                Some(42),
                "返回已存在视图必须回放控制条快照（阻塞项回归）"
            );
            assert_eq!(country, "DE", "站点维度同样必须回放");
            assert!(
                range.from.is_some() && range.to.is_some(),
                "日期区间维度保持两端齐全"
            );
        });
    }

    /// P4-1：折叠状态同步契约——侧栏 toggle 后 RootView 的 sidebar_collapsed 跟随
    /// （内容区头部据此渲染最左「展开侧栏」按钮）。
    /// 通过 sidebar 实体句柄驱动（避免在 RootView update 内嵌套更新自身的
    /// re-entrant borrow——gpui 实体更新是互斥借用）。
    #[gpui::test]
    async fn root_follows_sidebar_collapsed(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, None));
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        // 初始展开
        cx.read(|app| {
            let root = view.read(app);
            assert!(!root.sub_nav_collapsed, "初始应展开");
            assert_eq!(root.breadcrumb, vec!["Dashboard"]);
        });

        // 折叠：SidebarView emit Collapsed → RootView 同步（同步 emit，单帧内生效）
        sub_nav.update(cx, |this, cx| this.toggle_collapsed(cx));
        cx.read(|app| assert!(view.read(app).sub_nav_collapsed, "应同步折叠"));

        // 再展开：状态回弹
        sub_nav.update(cx, |this, cx| this.toggle_collapsed(cx));
        cx.read(|app| assert!(!view.read(app).sub_nav_collapsed, "应同步回展开"));
    }

    /// P4-1：面包屑解析——侧栏选中「销售数据」后内容区头部面包屑 = [运营, 销售数据]，
    /// 标题跟随；占位视图路径也解析（全部 52 子项都能从 gui-domain 解析出两级路径）。
    #[gpui::test]
    async fn root_breadcrumb_follows_sidebar_select(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, None));
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        sub_nav.update(cx, |this, cx| {
            this.select("/dashboard/operations/daily-analysis", "销售数据", cx)
        });
        cx.read(|app| {
            let root = view.read(app);
            assert_eq!(root.current_title, "销售数据");
            assert_eq!(root.breadcrumb, vec!["运营", "销售数据"]);
        });

        // 广告分析深层子路径经 match_prefixes 命中同一面包屑
        sub_nav.update(cx, |this, cx| {
            this.select(
                "/dashboard/advertising/ad-analysis/overview",
                "广告分析",
                cx,
            )
        });
        cx.read(|app| {
            let root = view.read(app);
            assert_eq!(root.breadcrumb, vec!["广告", "广告分析"]);
        });
    }

    /// BLF-792：主题偏好语义——默认锁定深色；休眠路径（浅色/跟随系统）保留。
    #[test]
    fn theme_pref_menu_semantics() {
        assert_eq!(ThemePreference::default(), ThemePreference::Dark);
        assert!(ThemePreference::Dark.is_explicit());
        // 休眠路径仍保留完整枚举能力（不在 UI 暴露）
        assert!(ThemePreference::Light.is_explicit());
        assert!(!ThemePreference::FollowSystem.is_explicit());
    }

    /// P2-2 核心契约：强制深色模式下主窗口（内容区头部 + 侧栏 + 会话栏）
    /// 可完整渲染不 panic（AppTheme::dark 语义色板路径）。
    #[gpui::test]
    async fn root_renders_in_dark_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            set_theme_pref(ThemePreference::Dark, None, cx);
        });
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-test".into(),
                name: "深色用户".into(),
                email: "dark@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: false,
                is_active: true,
                role_type: UserRoleType::Operator,
                session_id: "s-dark".into(),
                api_key: String::new(),
            },
            warning: None,
        };
        let (_view, _window_cx) =
            cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        // 深色偏好仍生效（显式模式不被系统外观覆盖）
        cx.update(|cx| assert!(AppTheme::current(cx).is_dark()));
    }

    /// P4-1 修复（review 阻塞项）：内容区头部窗口拖拽武装状态机——与侧栏头部
    /// 同契约：按下武装、移动消费、松开/外出解除；未武装移动不触发。
    #[gpui::test]
    async fn content_header_window_drag_state_machine(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, None));
        view.update(cx, |this, _| {
            assert!(!this.should_move);
            assert!(!this.consume_drag_armed());

            this.arm_drag();
            assert!(this.should_move);
            assert!(this.consume_drag_armed());
            assert!(!this.should_move);

            this.arm_drag();
            this.disarm_drag();
            assert!(!this.should_move);
            assert!(!this.consume_drag_armed());
        });
    }

    /// P4-2：view_key 契约——初始 Dashboard 为 "dashboard"；侧栏选中各业务视图后
    /// 键跟随（视图切换过渡动画 id 据此变化 → 淡入重放）。
    #[gpui::test]
    async fn view_key_follows_active_view(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-key".into(),
                name: "键测试".into(),
                email: "key@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: false,
                is_active: true,
                role_type: UserRoleType::Operator,
                session_id: "s-key".into(),
                api_key: String::new(),
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        // 初始：Dashboard 着陆页
        cx.read(|app| assert_eq!(view.read(app).view_key(), "dashboard"));

        // 侧栏选中各业务视图 → 键跟随
        for (url, title, key) in [
            (
                "/dashboard/operations/site-navigation",
                "站点导航",
                "site-navigation",
            ),
            (
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "store-navigation",
            ),
            (
                "/dashboard/operations/portfolio-overview",
                "组合分析",
                "portfolio-overview",
            ),
            (
                "/dashboard/operations/daily-analysis",
                "销售数据",
                "daily-analysis",
            ),
            (
                "/dashboard/advertising/ad-analysis",
                "广告分析",
                "ad-analysis",
            ),
            ("/dashboard/advertising/ad-data", "广告数据", "ad-data"),
            // BLF-803：AI 智能三页 + 数字员工/虚拟办公室
            (
                "/dashboard/ai/insights",
                "AI洞察",
                "ai-insights",
            ),
            (
                "/dashboard/ai/customer-service",
                "客服交流",
                "customer-service",
            ),
            (
                "/dashboard/ai/digital-employees",
                "数字员工",
                "virtual-office",
            ),
            (
                "/dashboard/ai/digital-employees/office",
                "虚拟办公室",
                "virtual-office",
            ),
            (
                "/dashboard/reports/monthly-report/display",
                "财务月报",
                "monthly-report",
            ),
            (
                "/dashboard/finance/platform-revenue",
                "平台回款",
                "platform-revenue",
            ),
            (
                "/dashboard/reports/scheduled-reports",
                "定时报告",
                "scheduled-reports",
            ),
            (
                "/dashboard/operations/project-goals",
                "项目目标",
                "project-goals",
            ),
            (
                "/dashboard/operations/return-analysis",
                "退货分析",
                "return-analysis",
            ),
            (
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "inventory-analysis",
            ),
            (
                "/dashboard/operations/inventory-ledger",
                "库存分类账",
                "inventory-ledger",
            ),
            (
                "/dashboard/operations/inventory-replenishment",
                "补货分析",
                "replenishment",
            ),
            (
                "/dashboard/operations/seasonal-replenishment",
                "季节性补货分析",
                "seasonal-replenishment",
            ),
            (
                "/dashboard/operations/weekly-product-analysis",
                "按周产品分析",
                "weekly-product-analysis",
            ),
            (
                "/dashboard/operations/research-analysis",
                "调研分析",
                "research-analysis",
            ),
            (
                "/dashboard/reports/product-analysis",
                "产品分析",
                "product-analysis",
            ),
            (
                "/dashboard/operations/shipment-management",
                "发货管理",
                "shipment-management",
            ),
            (
                "/dashboard/operations/platform-inspection",
                "平台巡检",
                "platform-inspection",
            ),
            (
                "/dashboard/ai/believeboy-models",
                "模型选型",
                "model-selection",
            ),
            ("/dashboard/crm/dashboard", "数据看板", "crm-dashboard"),
            (
                "/dashboard/tools/markdown-to-word",
                "Markdown 转换",
                "markdown-to-word",
            ),
        ] {
            sub_nav.update(cx, |this, cx| this.select(url, title, cx));
            cx.read(|app| assert_eq!(view.read(app).view_key(), key, "选中 {title}"));
        }
    }

    /// P5-1：view_key 两步切换契约——`view_key_follows_active_view` 仅覆盖 dashboard
    /// → 各视图的单步切换；新增「业务视图 A → 业务视图 B」两步路径锁各分支 reset
    /// 列表完整（避免新增视图分支漏 reset 既有 `show_*`，触发 view_key/content_view
    /// if/else 链中靠前的 show_* 误命中）。覆盖既有相邻业务视图对（退货/库存/定时报告/
    /// 项目目标/组合分析）与平台巡检（PLATFORM_INSPECTION_URL 分支对既有视图的复位）。
    #[gpui::test]
    async fn view_key_two_step_transitions(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-2step".into(),
                name: "两步切换".into(),
                email: "twostep@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: false,
                is_active: true,
                role_type: UserRoleType::Operator,
                session_id: "s-2step".into(),
                api_key: String::new(),
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        // 两步切换矩阵：先 A 后 B → view_key 必须为 B（覆盖每一对相邻业务视图）
        let transitions = [
            (
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "/dashboard/operations/return-analysis",
                "退货分析",
                "return-analysis",
            ),
            (
                "/dashboard/operations/return-analysis",
                "退货分析",
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "store-navigation",
            ),
            (
                "/dashboard/reports/scheduled-reports",
                "定时报告",
                "/dashboard/operations/return-analysis",
                "退货分析",
                "return-analysis",
            ),
            (
                "/dashboard/operations/return-analysis",
                "退货分析",
                "/dashboard/reports/scheduled-reports",
                "定时报告",
                "scheduled-reports",
            ),
            (
                "/dashboard/operations/site-navigation",
                "站点导航",
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "store-navigation",
            ),
            (
                "/dashboard/operations/portfolio-overview",
                "组合分析",
                "/dashboard/operations/return-analysis",
                "退货分析",
                "return-analysis",
            ),
            (
                "/dashboard/operations/return-analysis",
                "退货分析",
                "/dashboard/operations/portfolio-overview",
                "组合分析",
                "portfolio-overview",
            ),
            (
                "/dashboard/operations/project-goals",
                "项目目标",
                "/dashboard/operations/return-analysis",
                "退货分析",
                "return-analysis",
            ),
            (
                "/dashboard/operations/return-analysis",
                "退货分析",
                "/dashboard/operations/project-goals",
                "项目目标",
                "project-goals",
            ),
            (
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "/dashboard/operations/return-analysis",
                "退货分析",
                "return-analysis",
            ),
            (
                "/dashboard/operations/return-analysis",
                "退货分析",
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "inventory-analysis",
            ),
            (
                "/dashboard/operations/portfolio-overview",
                "组合分析",
                "/dashboard/operations/platform-inspection",
                "平台巡检",
                "platform-inspection",
            ),
            (
                "/dashboard/operations/platform-inspection",
                "平台巡检",
                "/dashboard/operations/portfolio-overview",
                "组合分析",
                "portfolio-overview",
            ),
            (
                "/dashboard/operations/portfolio-overview",
                "组合分析",
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "store-navigation",
            ),
            (
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "/dashboard/operations/platform-inspection",
                "平台巡检",
                "platform-inspection",
            ),
            (
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "/dashboard/operations/project-goals",
                "项目目标",
                "project-goals",
            ),
            (
                "/dashboard/operations/project-goals",
                "项目目标",
                "/dashboard/operations/portfolio-overview",
                "组合分析",
                "portfolio-overview",
            ),
            (
                "/dashboard/operations/project-goals",
                "项目目标",
                "/dashboard/operations/platform-inspection",
                "平台巡检",
                "platform-inspection",
            ),
            // P5-2：库存分类账 ↔ 相邻业务视图两步切换（锁 INVENTORY_LEDGER_URL
            // 分支与既有分支的 show_inventory_ledger 复位完整）
            (
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "/dashboard/operations/inventory-ledger",
                "库存分类账",
                "inventory-ledger",
            ),
            (
                "/dashboard/operations/inventory-ledger",
                "库存分类账",
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "inventory-analysis",
            ),
            // P5-2：补货分析 ↔ 相邻业务视图两步切换（锁 REPLENISHMENT_URL
            // 分支与既有分支的 show_replenishment 复位完整）
            (
                "/dashboard/operations/inventory-ledger",
                "库存分类账",
                "/dashboard/operations/inventory-replenishment",
                "补货分析",
                "replenishment",
            ),
            (
                "/dashboard/operations/inventory-replenishment",
                "补货分析",
                "/dashboard/operations/inventory-ledger",
                "库存分类账",
                "inventory-ledger",
            ),
            (
                "/dashboard/operations/inventory-replenishment",
                "补货分析",
                "/dashboard/operations/return-analysis",
                "退货分析",
                "return-analysis",
            ),
            (
                "/dashboard/operations/inventory-ledger",
                "库存分类账",
                "/dashboard/operations/platform-inspection",
                "平台巡检",
                "platform-inspection",
            ),
            (
                "/dashboard/operations/platform-inspection",
                "平台巡检",
                "/dashboard/operations/inventory-ledger",
                "库存分类账",
                "inventory-ledger",
            ),
            (
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "/dashboard/operations/inventory-ledger",
                "库存分类账",
                "inventory-ledger",
            ),
            // P5-2：季节性补货分析 ↔ 相邻业务视图两步切换（锁 SEASONAL_REPLENISHMENT_URL
            // 分支与既有分支的 show_seasonal_replenishment 复位完整）
            (
                "/dashboard/operations/inventory-ledger",
                "库存分类账",
                "/dashboard/operations/seasonal-replenishment",
                "季节性补货分析",
                "seasonal-replenishment",
            ),
            (
                "/dashboard/operations/seasonal-replenishment",
                "季节性补货分析",
                "/dashboard/operations/inventory-ledger",
                "库存分类账",
                "inventory-ledger",
            ),
            (
                "/dashboard/operations/seasonal-replenishment",
                "季节性补货分析",
                "/dashboard/operations/platform-inspection",
                "平台巡检",
                "platform-inspection",
            ),
            (
                "/dashboard/operations/platform-inspection",
                "平台巡检",
                "/dashboard/operations/seasonal-replenishment",
                "季节性补货分析",
                "seasonal-replenishment",
            ),
            (
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "/dashboard/operations/seasonal-replenishment",
                "季节性补货分析",
                "seasonal-replenishment",
            ),
            // P5-2：按周产品分析 ↔ 相邻业务视图两步切换（锁 WEEKLY_PRODUCT_URL
            // 分支与既有分支的 show_weekly_product 复位完整）
            (
                "/dashboard/operations/seasonal-replenishment",
                "季节性补货分析",
                "/dashboard/operations/weekly-product-analysis",
                "按周产品分析",
                "weekly-product-analysis",
            ),
            (
                "/dashboard/operations/weekly-product-analysis",
                "按周产品分析",
                "/dashboard/operations/seasonal-replenishment",
                "季节性补货分析",
                "seasonal-replenishment",
            ),
            (
                "/dashboard/operations/weekly-product-analysis",
                "按周产品分析",
                "/dashboard/operations/platform-inspection",
                "平台巡检",
                "platform-inspection",
            ),
            (
                "/dashboard/operations/platform-inspection",
                "平台巡检",
                "/dashboard/operations/weekly-product-analysis",
                "按周产品分析",
                "weekly-product-analysis",
            ),
            (
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "/dashboard/operations/weekly-product-analysis",
                "按周产品分析",
                "weekly-product-analysis",
            ),
            (
                "/dashboard/operations/weekly-product-analysis",
                "按周产品分析",
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "inventory-analysis",
            ),
            (
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "/dashboard/operations/weekly-product-analysis",
                "按周产品分析",
                "weekly-product-analysis",
            ),
            // P5-3：调研分析 ↔ 相邻业务视图两步切换（锁 RESEARCH_ANALYSIS_URL
            // 分支与既有分支的 show_research_analysis 复位完整）
            (
                "/dashboard/operations/weekly-product-analysis",
                "按周产品分析",
                "/dashboard/operations/research-analysis",
                "调研分析",
                "research-analysis",
            ),
            (
                "/dashboard/operations/research-analysis",
                "调研分析",
                "/dashboard/operations/weekly-product-analysis",
                "按周产品分析",
                "weekly-product-analysis",
            ),
            (
                "/dashboard/operations/research-analysis",
                "调研分析",
                "/dashboard/operations/platform-inspection",
                "平台巡检",
                "platform-inspection",
            ),
            (
                "/dashboard/operations/platform-inspection",
                "平台巡检",
                "/dashboard/operations/research-analysis",
                "调研分析",
                "research-analysis",
            ),
            (
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "/dashboard/operations/research-analysis",
                "调研分析",
                "research-analysis",
            ),
            (
                "/dashboard/operations/research-analysis",
                "调研分析",
                "/dashboard/operations/return-analysis",
                "退货分析",
                "return-analysis",
            ),
            (
                "/dashboard/operations/return-analysis",
                "退货分析",
                "/dashboard/operations/research-analysis",
                "调研分析",
                "research-analysis",
            ),
            // P5-4：产品分析 ↔ 相邻业务视图两步切换（锁 PRODUCT_ANALYSIS_URL
            // 分支与既有分支的 show_product_analysis 复位完整）
            (
                "/dashboard/operations/research-analysis",
                "调研分析",
                "/dashboard/reports/product-analysis",
                "产品分析",
                "product-analysis",
            ),
            (
                "/dashboard/reports/product-analysis",
                "产品分析",
                "/dashboard/operations/research-analysis",
                "调研分析",
                "research-analysis",
            ),
            (
                "/dashboard/reports/product-analysis",
                "产品分析",
                "/dashboard/operations/platform-inspection",
                "平台巡检",
                "platform-inspection",
            ),
            (
                "/dashboard/operations/platform-inspection",
                "平台巡检",
                "/dashboard/reports/product-analysis",
                "产品分析",
                "product-analysis",
            ),
            (
                "/dashboard/reports/monthly-report/display",
                "财务月报",
                "/dashboard/reports/product-analysis",
                "产品分析",
                "product-analysis",
            ),
            (
                "/dashboard/reports/product-analysis",
                "产品分析",
                "/dashboard/reports/scheduled-reports",
                "定时报告",
                "scheduled-reports",
            ),
            (
                "/dashboard/reports/scheduled-reports",
                "定时报告",
                "/dashboard/reports/product-analysis",
                "产品分析",
                "product-analysis",
            ),
            (
                "/dashboard/operations/weekly-product-analysis",
                "按周产品分析",
                "/dashboard/reports/product-analysis",
                "产品分析",
                "product-analysis",
            ),
            (
                "/dashboard/reports/product-analysis",
                "产品分析",
                "/dashboard/operations/weekly-product-analysis",
                "按周产品分析",
                "weekly-product-analysis",
            ),
            // P5-3：发货管理 ↔ 相邻业务视图两步切换（锁 SHIPMENT_MANAGEMENT_URL
            // 分支与既有分支的 show_shipment_management 复位完整）
            (
                "/dashboard/operations/weekly-product-analysis",
                "按周产品分析",
                "/dashboard/operations/shipment-management",
                "发货管理",
                "shipment-management",
            ),
            (
                "/dashboard/operations/shipment-management",
                "发货管理",
                "/dashboard/operations/weekly-product-analysis",
                "按周产品分析",
                "weekly-product-analysis",
            ),
            (
                "/dashboard/operations/shipment-management",
                "发货管理",
                "/dashboard/operations/platform-inspection",
                "平台巡检",
                "platform-inspection",
            ),
            (
                "/dashboard/operations/platform-inspection",
                "平台巡检",
                "/dashboard/operations/shipment-management",
                "发货管理",
                "shipment-management",
            ),
            (
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "/dashboard/operations/shipment-management",
                "发货管理",
                "shipment-management",
            ),
            (
                "/dashboard/operations/shipment-management",
                "发货管理",
                "/dashboard/operations/return-analysis",
                "退货分析",
                "return-analysis",
            ),
            (
                "/dashboard/operations/return-analysis",
                "退货分析",
                "/dashboard/operations/shipment-management",
                "发货管理",
                "shipment-management",
            ),
            (
                "/dashboard/operations/research-analysis",
                "调研分析",
                "/dashboard/operations/shipment-management",
                "发货管理",
                "shipment-management",
            ),
            (
                "/dashboard/operations/shipment-management",
                "发货管理",
                "/dashboard/reports/product-analysis",
                "产品分析",
                "product-analysis",
            ),
        ];
        for (url_a, title_a, url_b, title_b, expected_key) in transitions {
            sub_nav.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sub_nav.update(cx, |this, cx| this.select(url_b, title_b, cx));
            cx.read(|app| {
                assert_eq!(
                    view.read(app).view_key(),
                    expected_key,
                    "两步切换 {title_a} → {title_b}"
                )
            });
        }
    }

    /// P5-1（PR #337 合并后）：项目目标 ↔ 各业务视图的两步切换契约——锁每个既有
    /// 分支的 reset 列表都补了 `show_project_goals = false`（以及项目目标分支自身
    /// 对全部既有 show_* 的复位），避免 PROJECT_GOALS_URL 分支漏 reset 既有视图
    /// 或既有分支漏 reset show_project_goals。
    /// P5-6（BLF-739）：模型选型双向 cross-reset——A → 模型选型 与 模型选型 → B
    /// 都必须落在最后选中视图（覆盖 MODEL_SELECTION_URL 分支 reset 完整性与
    /// 既有分支对 show_model_selection 的复位）。
    #[gpui::test]
    async fn view_key_model_selection_cross_resets(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-ms2step".into(),
                name: "模型选型两步切换".into(),
                email: "ms2step@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: false,
                is_active: true,
                role_type: UserRoleType::Operator,
                session_id: "s-ms2step".into(),
                api_key: String::new(),
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        let transitions = [
            (
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "/dashboard/ai/believeboy-models",
                "模型选型",
                "model-selection",
            ),
            (
                "/dashboard/ai/believeboy-models",
                "模型选型",
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "store-navigation",
            ),
            (
                "/dashboard/finance/commission-management",
                "佣金管理",
                "/dashboard/ai/believeboy-models",
                "模型选型",
                "model-selection",
            ),
            (
                "/dashboard/ai/believeboy-models",
                "模型选型",
                "/dashboard/finance/commission-management",
                "佣金管理",
                "commission",
            ),
            (
                "/dashboard/operations/daily-analysis",
                "销售数据",
                "/dashboard/ai/believeboy-models",
                "模型选型",
                "model-selection",
            ),
            (
                "/dashboard/ai/believeboy-models",
                "模型选型",
                "/dashboard/operations/daily-analysis",
                "销售数据",
                "daily-analysis",
            ),
            (
                "/dashboard/finance/exchange-rate",
                "汇率信息",
                "/dashboard/ai/believeboy-models",
                "模型选型",
                "model-selection",
            ),
            (
                "/dashboard/ai/believeboy-models",
                "模型选型",
                "/dashboard/finance/exchange-rate",
                "汇率信息",
                "exchange-rate",
            ),
        ];
        for (url_a, title_a, url_b, title_b, expected_key) in transitions {
            sub_nav.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sub_nav.update(cx, |this, cx| this.select(url_b, title_b, cx));
            cx.read(|app| {
                assert_eq!(
                    view.read(app).view_key(),
                    expected_key,
                    "模型选型两步切换 {title_a} → {title_b}"
                )
            });
        }
    }

    #[gpui::test]
    async fn view_key_project_goals_cross_resets(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-pg2step".into(),
                name: "项目目标两步切换".into(),
                email: "pg2step@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: false,
                is_active: true,
                role_type: UserRoleType::Operator,
                session_id: "s-pg2step".into(),
                api_key: String::new(),
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        // 项目目标 ↔ 各业务视图双向矩阵：A → 项目目标 与 项目目标 → B 都必须
        // 落在最后选中视图（覆盖 PROJECT_GOALS_URL 分支 reset 完整性与既有分支
        // 对 show_project_goals 的复位）。
        let transitions = [
            (
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "/dashboard/operations/project-goals",
                "项目目标",
                "project-goals",
            ),
            (
                "/dashboard/operations/project-goals",
                "项目目标",
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "store-navigation",
            ),
            (
                "/dashboard/operations/daily-analysis",
                "销售数据",
                "/dashboard/operations/project-goals",
                "项目目标",
                "project-goals",
            ),
            (
                "/dashboard/operations/project-goals",
                "项目目标",
                "/dashboard/operations/daily-analysis",
                "销售数据",
                "daily-analysis",
            ),
            (
                "/dashboard/operations/portfolio-overview",
                "组合分析",
                "/dashboard/operations/project-goals",
                "项目目标",
                "project-goals",
            ),
            (
                "/dashboard/operations/project-goals",
                "项目目标",
                "/dashboard/operations/portfolio-overview",
                "组合分析",
                "portfolio-overview",
            ),
            (
                "/dashboard/reports/scheduled-reports",
                "定时报告",
                "/dashboard/operations/project-goals",
                "项目目标",
                "project-goals",
            ),
            (
                "/dashboard/operations/project-goals",
                "项目目标",
                "/dashboard/reports/scheduled-reports",
                "定时报告",
                "scheduled-reports",
            ),
            (
                "/dashboard/operations/site-navigation",
                "站点导航",
                "/dashboard/operations/project-goals",
                "项目目标",
                "project-goals",
            ),
            (
                "/dashboard/operations/project-goals",
                "项目目标",
                "/dashboard/operations/site-navigation",
                "站点导航",
                "site-navigation",
            ),
        ];
        for (url_a, title_a, url_b, title_b, expected_key) in transitions {
            sub_nav.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sub_nav.update(cx, |this, cx| this.select(url_b, title_b, cx));
            cx.read(|app| {
                assert_eq!(
                    view.read(app).view_key(),
                    expected_key,
                    "项目目标两步切换 {title_a} → {title_b}"
                )
            });
        }
    }

    /// P5-4（BLF-728）：新品核算 ↔ 各业务视图的两步切换契约——锁每个既有分支的
    /// reset 列表都补了 `show_new_product_calculation = false`（以及
    /// NEW_PRODUCT_CALCULATION_URL 分支自身对全部既有 show_* 的复位），避免
    /// NEW_PRODUCT_CALCULATION_URL 分支漏 reset 既有视图或既有分支漏 reset
    /// show_new_product_calculation 触发 view_key/content_view 链误命中。
    #[gpui::test]
    async fn view_key_new_product_calculation_cross_resets(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-npc2step".into(),
                name: "新品核算两步切换".into(),
                email: "npc2step@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: false,
                is_active: true,
                role_type: UserRoleType::Operator,
                session_id: "s-npc2step".into(),
                api_key: String::new(),
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        // 新品核算 ↔ 报表中心相邻视图 + 跨板块视图双向切换（含店铺测算占位分支，
        // 覆盖 placeholder else 分支对 show_new_product_calculation 的复位）。
        let transitions = [
            (
                "/dashboard/reports/product-analysis",
                "产品分析",
                "/dashboard/reports/pricing-calculation/new-product",
                "新品核算",
                "new-product-calculation",
            ),
            (
                "/dashboard/reports/pricing-calculation/new-product",
                "新品核算",
                "/dashboard/reports/product-analysis",
                "产品分析",
                "product-analysis",
            ),
            (
                "/dashboard/reports/monthly-report/display",
                "财务月报",
                "/dashboard/reports/pricing-calculation/new-product",
                "新品核算",
                "new-product-calculation",
            ),
            (
                "/dashboard/reports/pricing-calculation/new-product",
                "新品核算",
                "/dashboard/reports/scheduled-reports",
                "定时报告",
                "scheduled-reports",
            ),
            (
                "/dashboard/operations/research-analysis",
                "调研分析",
                "/dashboard/reports/pricing-calculation/new-product",
                "新品核算",
                "new-product-calculation",
            ),
            (
                "/dashboard/reports/pricing-calculation/new-product",
                "新品核算",
                "/dashboard/reports/pricing-calculation/shop-calculation",
                "店铺测算",
                "shop-calculation",
            ),
            (
                "/dashboard/reports/pricing-calculation/shop-calculation",
                "店铺测算",
                "/dashboard/reports/pricing-calculation/new-product",
                "新品核算",
                "new-product-calculation",
            ),
            (
                "/dashboard/reports/pricing-calculation/new-product",
                "新品核算",
                "/dashboard/operations/weekly-product-analysis",
                "按周产品分析",
                "weekly-product-analysis",
            ),
        ];
        for (url_a, title_a, url_b, title_b, expected_key) in transitions {
            sub_nav.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sub_nav.update(cx, |this, cx| this.select(url_b, title_b, cx));
            cx.read(|app| {
                assert_eq!(
                    view.read(app).view_key(),
                    expected_key,
                    "新品核算两步切换 {title_a} → {title_b}"
                )
            });
        }
    }

    /// P5-8（BLF-758）：Agent 接入管理 ↔ 相邻 / 跨板块视图两步切换契约——
    /// 锁每个既有分支的 reset 列表都补了 `show_agent_management = false`
    /// （含 system_logs / markdown_to_word 分支与 placeholder else 分支），避免漏 reset
    /// 触发 view_key/content_view 链误命中。
    #[gpui::test]
    async fn view_key_agent_management_cross_resets(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-agentmgmt".into(),
                name: "Agent 接入管理切换".into(),
                email: "agentmgmt@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: false,
                is_active: true,
                role_type: UserRoleType::Operator,
                session_id: "s-agentmgmt".into(),
                api_key: String::new(),
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        let transitions = [
            (
                "/dashboard/system/logs",
                "日志查看",
                "/dashboard/system/agent-management",
                "Agent 接入管理",
                "agent-management",
            ),
            (
                "/dashboard/system/agent-management",
                "Agent 接入管理",
                "/dashboard/tools/markdown-to-word",
                "Markdown 转换",
                "markdown-to-word",
            ),
            (
                "/dashboard/tools/markdown-to-word",
                "Markdown 转换",
                "/dashboard/system/agent-management",
                "Agent 接入管理",
                "agent-management",
            ),
            (
                "/dashboard/system/agent-management",
                "Agent 接入管理",
                "/dashboard/system/account-management",
                "账号管理",
                "account-management",
            ),
            (
                "/dashboard/system/account-management",
                "账号管理",
                "/dashboard/system/agent-management",
                "Agent 接入管理",
                "agent-management",
            ),
            (
                "/dashboard/system/agent-management",
                "Agent 接入管理",
                "/dashboard/reports/pricing-calculation/shop-calculation",
                "店铺测算",
                "shop-calculation",
            ),
        ];
        for (url_a, title_a, url_b, title_b, expected_key) in transitions {
            sub_nav.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sub_nav.update(cx, |this, cx| this.select(url_b, title_b, cx));
            cx.read(|app| {
                assert_eq!(
                    view.read(app).view_key(),
                    expected_key,
                    "Agent 接入管理两步切换 {title_a} → {title_b}"
                )
            });
        }
    }

    /// P5-8（BLF-754）：账号管理 ↔ 相邻 / 跨板块视图两步切换契约——
    /// 锁每个既有分支的 reset 列表都补了 `show_account_management = false`
    /// （含 system_logs / markdown_to_word 分支与 placeholder else 分支），避免漏
    /// reset 触发 view_key/content_view 链误命中。
        /// BLF-798：SKU 信息 ↔ 相邻视图两步切换契约——锁每个既有分支的 reset
    /// 列表都补了 `show_sku_info = false`（含销售数据 / 占位 else 分支），
    /// 避免漏 reset 触发 view_key/content_view 链误命中。
    #[gpui::test]
    async fn view_key_sku_info_cross_resets(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-skuinfo".into(),
                name: "SKU 信息切换".into(),
                email: "skuinfo@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: false,
                is_active: true,
                role_type: UserRoleType::Operator,
                session_id: "s-skuinfo".into(),
                api_key: String::new(),
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        let transitions = [
            (
                "/dashboard/operations/daily-analysis",
                "销售数据",
                "/dashboard/operations/sku-info",
                "SKU 信息",
                "sku-info",
            ),
            (
                "/dashboard/operations/sku-info",
                "SKU 信息",
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "store-navigation",
            ),
            (
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "/dashboard/operations/sku-info",
                "SKU 信息",
                "sku-info",
            ),
            (
                "/dashboard/operations/sku-info",
                "SKU 信息",
                "/dashboard/nonexistent/placeholder",
                "占位页",
                "placeholder",
            ),
        ];
        for (url_a, title_a, url_b, title_b, expected_key) in transitions {
            sub_nav.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sub_nav.update(cx, |this, cx| this.select(url_b, title_b, cx));
            cx.read(|app| {
                assert_eq!(
                    view.read(app).view_key(),
                    expected_key,
                    "SKU 信息两步切换 {title_a} → {title_b}"
                )
            });
        }
    }

#[gpui::test]
    async fn view_key_account_management_cross_resets(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-accountmgmt".into(),
                name: "账号管理切换".into(),
                email: "accountmgmt@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: false,
                is_active: true,
                role_type: UserRoleType::Operator,
                session_id: "s-accountmgmt".into(),
                api_key: String::new(),
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        let transitions = [
            (
                "/dashboard/system/logs",
                "日志查看",
                "/dashboard/system/account-management",
                "账号管理",
                "account-management",
            ),
            (
                "/dashboard/system/account-management",
                "账号管理",
                "/dashboard/tools/markdown-to-word",
                "Markdown 转换",
                "markdown-to-word",
            ),
            (
                "/dashboard/tools/markdown-to-word",
                "Markdown 转换",
                "/dashboard/system/account-management",
                "账号管理",
                "account-management",
            ),
            (
                "/dashboard/system/account-management",
                "账号管理",
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "store-navigation",
            ),
            (
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "/dashboard/system/account-management",
                "账号管理",
                "account-management",
            ),
            (
                "/dashboard/system/account-management",
                "账号管理",
                "/dashboard/nonexistent/url",
                "占位页",
                "placeholder",
            ),
        ];
        for (url_a, title_a, url_b, title_b, expected_key) in transitions {
            sub_nav.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sub_nav.update(cx, |this, cx| this.select(url_b, title_b, cx));
            cx.read(|app| {
                assert_eq!(
                    view.read(app).view_key(),
                    expected_key,
                    "账号管理两步切换 {title_a} → {title_b}"
                )
            });
        }
    }

    /// P5-2（BLF-719）：库存分析 ↔ 各业务视图的两步切换契约——锁每个既有分支的
    /// reset 列表都补了 `show_inventory_analysis = false`（以及 INVENTORY_ANALYSIS_URL
    /// 分支自身对全部既有 show_* 的复位），避免既有分支漏 reset show_inventory_analysis
    /// 触发 view_key/content_view 链末位误命中。
    #[gpui::test]
    async fn view_key_inventory_cross_resets(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-inv2step".into(),
                name: "库存分析两步切换".into(),
                email: "inv2step@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: false,
                is_active: true,
                role_type: UserRoleType::Operator,
                session_id: "s-inv2step".into(),
                api_key: String::new(),
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        // 库存分析 ↔ 各业务视图双向矩阵：A → 库存分析 与 库存分析 → B 都必须
        // 落在最后选中视图（覆盖 INVENTORY_ANALYSIS_URL 分支 reset 完整性与既有
        // 分支对 show_inventory_analysis 的复位）。
        let transitions = [
            (
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "store-navigation",
            ),
            (
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "inventory-analysis",
            ),
            (
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "/dashboard/operations/daily-analysis",
                "销售数据",
                "daily-analysis",
            ),
            (
                "/dashboard/operations/daily-analysis",
                "销售数据",
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "inventory-analysis",
            ),
            (
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "/dashboard/operations/portfolio-overview",
                "组合分析",
                "portfolio-overview",
            ),
            (
                "/dashboard/operations/portfolio-overview",
                "组合分析",
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "inventory-analysis",
            ),
            (
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "/dashboard/operations/project-goals",
                "项目目标",
                "project-goals",
            ),
            (
                "/dashboard/operations/project-goals",
                "项目目标",
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "inventory-analysis",
            ),
            (
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "/dashboard/operations/site-navigation",
                "站点导航",
                "site-navigation",
            ),
            (
                "/dashboard/operations/site-navigation",
                "站点导航",
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "inventory-analysis",
            ),
            (
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "/dashboard/reports/scheduled-reports",
                "定时报告",
                "scheduled-reports",
            ),
            (
                "/dashboard/reports/scheduled-reports",
                "定时报告",
                "/dashboard/operations/inventory-analysis",
                "库存分析",
                "inventory-analysis",
            ),
        ];
        for (url_a, title_a, url_b, title_b, expected_key) in transitions {
            sub_nav.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sub_nav.update(cx, |this, cx| this.select(url_b, title_b, cx));
            cx.read(|app| {
                assert_eq!(
                    view.read(app).view_key(),
                    expected_key,
                    "库存分析两步切换 {title_a} → {title_b}"
                )
            });
        }
    }

    /// P5-7（BLF-742）：CRM 数据看板 ↔ 各业务视图的两步切换契约——锁每个既有
    /// 分支的 reset 列表都补了 `show_crm_dashboard = false`（以及
    /// CRM_DASHBOARD_URL 分支自身对全部既有 show_* 的复位）；另锁占位页分支
    /// 补复位 show_auto_upload 的回归（此前从报表自动化切任意占位页会残留
    /// true，view_key 链误命中 auto-upload）。
    #[gpui::test]
    async fn view_key_crm_dashboard_cross_resets(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-crm2step".into(),
                name: "CRM 看板两步切换".into(),
                email: "crm2step@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: false,
                is_active: true,
                role_type: UserRoleType::Operator,
                session_id: "s-crm2step".into(),
                api_key: String::new(),
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        // CRM 数据看板 ↔ 各业务视图双向矩阵：A → CRM 看板 与 CRM 看板 → B 都必须
        // 落在最后选中视图；末两行锁占位页分支对 show_auto_upload 的复位。
        let transitions = [
            (
                "/dashboard/crm/dashboard",
                "数据看板",
                "/dashboard/finance/commission-management",
                "佣金管理",
                "commission",
            ),
            (
                "/dashboard/finance/commission-management",
                "佣金管理",
                "/dashboard/crm/dashboard",
                "数据看板",
                "crm-dashboard",
            ),
            (
                "/dashboard/crm/dashboard",
                "数据看板",
                "/dashboard/operations/daily-analysis",
                "销售数据",
                "daily-analysis",
            ),
            (
                "/dashboard/operations/daily-analysis",
                "销售数据",
                "/dashboard/crm/dashboard",
                "数据看板",
                "crm-dashboard",
            ),
            (
                "/dashboard/crm/dashboard",
                "数据看板",
                "/dashboard/reports/scheduled-reports",
                "定时报告",
                "scheduled-reports",
            ),
            (
                "/dashboard/reports/scheduled-reports",
                "定时报告",
                "/dashboard/crm/dashboard",
                "数据看板",
                "crm-dashboard",
            ),
            // P5-7 补强：产品分析/订单信息/汇率信息/VAT 发票四分支在双方父版本
            // 就漏了对方标志复位（被 view_key 链序遮蔽未暴露），rebase 合并时按
            // 「每个既有分支同时复位两个新视图标志」规范补齐，此处锁契约。
            (
                "/dashboard/crm/dashboard",
                "数据看板",
                "/dashboard/reports/product-analysis",
                "产品分析",
                "product-analysis",
            ),
            (
                "/dashboard/reports/product-analysis",
                "产品分析",
                "/dashboard/crm/dashboard",
                "数据看板",
                "crm-dashboard",
            ),
            (
                "/dashboard/crm/dashboard",
                "数据看板",
                "/dashboard/reports/order-info",
                "订单信息",
                "order-info",
            ),
            (
                "/dashboard/reports/order-info",
                "订单信息",
                "/dashboard/crm/dashboard",
                "数据看板",
                "crm-dashboard",
            ),
            (
                "/dashboard/crm/dashboard",
                "数据看板",
                "/dashboard/finance/exchange-rate",
                "汇率信息",
                "exchange-rate",
            ),
            (
                "/dashboard/finance/exchange-rate",
                "汇率信息",
                "/dashboard/crm/dashboard",
                "数据看板",
                "crm-dashboard",
            ),
            (
                "/dashboard/crm/dashboard",
                "数据看板",
                "/dashboard/finance/vat-invoice",
                "VAT 发票",
                "vat-invoice",
            ),
            (
                "/dashboard/finance/vat-invoice",
                "VAT 发票",
                "/dashboard/crm/dashboard",
                "数据看板",
                "crm-dashboard",
            ),
            // 报表自动化 → 待跟进（P5-7 起为真实视图）：回归锁 else 分支补复位
            // show_auto_upload（待跟进分支自身对 show_auto_upload 的复位也在此链路覆盖）
            (
                "/dashboard/reports/auto-upload",
                "报表自动化",
                "/dashboard/crm/follow-ups",
                "待跟进",
                "crm-follow-ups",
            ),
            // 待跟进 → 报表自动化 → CRM 看板：真实视图链路仍正常
            (
                "/dashboard/crm/follow-ups",
                "待跟进",
                "/dashboard/crm/dashboard",
                "数据看板",
                "crm-dashboard",
            ),
        ];
        for (url_a, title_a, url_b, title_b, expected_key) in transitions {
            sub_nav.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sub_nav.update(cx, |this, cx| this.select(url_b, title_b, cx));
            cx.read(|app| {
                assert_eq!(
                    view.read(app).view_key(),
                    expected_key,
                    "CRM 看板两步切换 {title_a} → {title_b}"
                )
            });
        }
    }

    /// P5-7（BLF-743）：CRM 待跟进 ↔ 各业务视图的两步切换契约——锁每个既有
    /// 分支的 reset 列表都补了 `show_crm_follow_ups = false`（以及
    /// CRM_FOLLOW_UPS_URL 分支自身对全部既有 show_* 的复位），避免既有分支漏
    /// reset show_crm_follow_ups 触发 view_key/content_view 链末位误命中。
    #[gpui::test]
    async fn view_key_crm_follow_ups_cross_resets(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-crmfu2step".into(),
                name: "CRM 待跟进两步切换".into(),
                email: "crmfu2step@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: false,
                is_active: true,
                role_type: UserRoleType::Operator,
                session_id: "s-crmfu2step".into(),
                api_key: String::new(),
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        // 待跟进 ↔ 各业务视图双向矩阵：A → 待跟进 与 待跟进 → B 都必须落在最后
        // 选中视图；末行锁占位页分支对 show_crm_follow_ups 的复位。
        let transitions = [
            (
                "/dashboard/crm/follow-ups",
                "待跟进",
                "/dashboard/finance/commission-management",
                "佣金管理",
                "commission",
            ),
            (
                "/dashboard/finance/commission-management",
                "佣金管理",
                "/dashboard/crm/follow-ups",
                "待跟进",
                "crm-follow-ups",
            ),
            (
                "/dashboard/crm/follow-ups",
                "待跟进",
                "/dashboard/operations/daily-analysis",
                "销售数据",
                "daily-analysis",
            ),
            (
                "/dashboard/operations/daily-analysis",
                "销售数据",
                "/dashboard/crm/follow-ups",
                "待跟进",
                "crm-follow-ups",
            ),
            // 同组互切：数据看板 ↔ 待跟进（owner 互复位）
            (
                "/dashboard/crm/follow-ups",
                "待跟进",
                "/dashboard/crm/dashboard",
                "数据看板",
                "crm-dashboard",
            ),
            (
                "/dashboard/crm/dashboard",
                "数据看板",
                "/dashboard/crm/follow-ups",
                "待跟进",
                "crm-follow-ups",
            ),
            // 报表自动化 → 待跟进：锁待跟进分支对 show_auto_upload 的复位
            (
                "/dashboard/reports/auto-upload",
                "报表自动化",
                "/dashboard/crm/follow-ups",
                "待跟进",
                "crm-follow-ups",
            ),
            // 待跟进 → 任意占位页：锁 else 分支对 show_crm_follow_ups 的复位
            (
                "/dashboard/crm/follow-ups",
                "待跟进",
                "/dashboard/other/nonexistent-placeholder",
                "占位页",
                "placeholder",
            ),
        ];
        for (url_a, title_a, url_b, title_b, expected_key) in transitions {
            sub_nav.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sub_nav.update(cx, |this, cx| this.select(url_b, title_b, cx));
            cx.read(|app| {
                assert_eq!(
                    view.read(app).view_key(),
                    expected_key,
                    "CRM 待跟进两步切换 {title_a} → {title_b}"
                )
            });
        }
    }

    /// Stage13（BLF-804）：新增十视图路由契约——每个新 URL 选中后 view_key
    /// 命中对应视图，且从既有视图两步切换后不残留旧 show 标志（
    /// reset_all_show_flags 统一复位）；另锁着陆页 /dashboard 路由回到
    /// Dashboard。
    #[gpui::test]
    async fn view_key_stage13_routes_and_landing(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-stage13".into(),
                name: "Stage13 路由".into(),
                email: "stage13@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: false,
                is_active: true,
                role_type: UserRoleType::Operator,
                session_id: "s-stage13".into(),
                api_key: String::new(),
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        // 新视图 URL → view_key 一一对应
        let routes = [
            ("/dashboard/crm/customers", "客户", "crm-customers"),
            ("/dashboard/crm/leads", "线索", "crm-leads"),
            ("/dashboard/crm/tasks", "任务", "crm-tasks"),
            ("/dashboard/crm/settings", "CRM 设置", "crm-settings"),
            ("/dashboard/tools/page-render", "渲染", "page-render"),
            ("/dashboard/system/project-info", "项目信息", "project-info"),
            (
                "/dashboard/system/operator-management",
                "运营管理",
                "operator-management",
            ),
            ("/dashboard/system/alerts", "告警中心", "alerts-center"),
            (
                "/dashboard/system/data-management",
                "数据库状态",
                "database-status",
            ),
            ("/dashboard/system/changelog", "更新日志", "changelog"),
        ];
        for (url, title, expected_key) in routes {
            sub_nav.update(cx, |this, cx| this.select(url, title, cx));
            cx.read(|app| {
                assert_eq!(
                    view.read(app).view_key(),
                    expected_key,
                    "Stage13 路由 {title}"
                )
            });
        }

        // 两步切换：新视图 ↔ 销售数据互切不残留；再回着陆页
        sub_nav.update(cx, |this, cx| {
            this.select("/dashboard/crm/tasks", "任务", cx)
        });
        sub_nav.update(cx, |this, cx| {
            this.select("/dashboard/operations/daily-analysis", "销售数据", cx)
        });
        cx.read(|app| assert_eq!(view.read(app).view_key(), "daily-analysis"));
        sub_nav.update(cx, |this, cx| {
            this.select("/dashboard/crm/customers", "客户", cx)
        });
        cx.read(|app| assert_eq!(view.read(app).view_key(), "crm-customers"));

        // 着陆页路由：回到 dashboard 且控制条配置为项目选择器单件
        sub_nav.update(cx, |this, cx| {
            this.select("/dashboard", "Dashboard", cx)
        });
        cx.read(|app| assert_eq!(view.read(app).view_key(), "dashboard"));
    }

    /// P5-7（BLF-747）：CRM 操作日志 ↔ 各业务视图的两步切换契约——锁每个既有
    /// 分支的 reset 列表都补了 `show_crm_audit = false`（以及 CRM_AUDIT_URL
    /// 分支自身对全部既有 show_* 的复位），避免既有分支漏 reset show_crm_audit
    /// 触发 view_key/content_view 链末位误命中。
    #[gpui::test]
    async fn view_key_crm_audit_cross_resets(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-crmaudit2step".into(),
                name: "CRM 操作日志两步切换".into(),
                email: "crmaudit2step@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: false,
                is_active: true,
                role_type: UserRoleType::Operator,
                session_id: "s-crmaudit2step".into(),
                api_key: String::new(),
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        // 操作日志 ↔ 各业务视图双向矩阵：A → 操作日志 与 操作日志 → B 都必须
        // 落在最后选中视图；末行锁占位页分支对 show_crm_audit 的复位。
        let transitions = [
            (
                "/dashboard/crm/audit",
                "操作日志",
                "/dashboard/finance/commission-management",
                "佣金管理",
                "commission",
            ),
            (
                "/dashboard/finance/commission-management",
                "佣金管理",
                "/dashboard/crm/audit",
                "操作日志",
                "crm-audit",
            ),
            (
                "/dashboard/crm/audit",
                "操作日志",
                "/dashboard/operations/daily-analysis",
                "销售数据",
                "daily-analysis",
            ),
            (
                "/dashboard/operations/daily-analysis",
                "销售数据",
                "/dashboard/crm/audit",
                "操作日志",
                "crm-audit",
            ),
            // 同组互切：数据看板 / 待跟进 ↔ 操作日志（owner 互复位）
            (
                "/dashboard/crm/audit",
                "操作日志",
                "/dashboard/crm/dashboard",
                "数据看板",
                "crm-dashboard",
            ),
            (
                "/dashboard/crm/dashboard",
                "数据看板",
                "/dashboard/crm/audit",
                "操作日志",
                "crm-audit",
            ),
            (
                "/dashboard/crm/follow-ups",
                "待跟进",
                "/dashboard/crm/audit",
                "操作日志",
                "crm-audit",
            ),
            (
                "/dashboard/crm/audit",
                "操作日志",
                "/dashboard/crm/follow-ups",
                "待跟进",
                "crm-follow-ups",
            ),
            // 报表自动化 → 操作日志：锁操作日志分支对 show_auto_upload 的复位
            (
                "/dashboard/reports/auto-upload",
                "报表自动化",
                "/dashboard/crm/audit",
                "操作日志",
                "crm-audit",
            ),
            // 操作日志 → 任意占位页：锁 else 分支对 show_crm_audit 的复位
            (
                "/dashboard/crm/audit",
                "操作日志",
                "/dashboard/other/nonexistent-placeholder",
                "占位页",
                "placeholder",
            ),
        ];
        for (url_a, title_a, url_b, title_b, expected_key) in transitions {
            sub_nav.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sub_nav.update(cx, |this, cx| this.select(url_b, title_b, cx));
            cx.read(|app| {
                assert_eq!(
                    view.read(app).view_key(),
                    expected_key,
                    "CRM 操作日志两步切换 {title_a} → {title_b}"
                )
            });
        }
    }

    /// P5-6（BLF-737）：AI Chat ↔ 各业务视图的两步切换契约——锁每个既有分支的
    /// reset 列表都补了 `show_ai_chat = false`（以及 AI_CHAT_URL 分支自身对全部
    /// 既有 show_* 的复位），避免既有分支漏 reset show_ai_chat 触发
    /// view_key/content_view 链末位误命中；另锁占位页分支补复位 show_auto_upload
    /// 的回归（此前从报表自动化切任意占位页会残留 true，view_key 链误命中）。
    #[gpui::test]
    async fn view_key_ai_chat_cross_resets(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-aichat2step".into(),
                name: "AI Chat 两步切换".into(),
                email: "aichat2step@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: false,
                is_active: true,
                role_type: UserRoleType::Operator,
                session_id: "s-aichat2step".into(),
                api_key: String::new(),
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        // AI Chat ↔ 各业务视图双向矩阵：A → AI Chat 与 AI Chat → B 都必须
        // 落在最后选中视图（覆盖 AI_CHAT_URL 分支 reset 完整性与既有分支对
        // show_ai_chat 的复位）。
        let transitions = [
            (
                "/dashboard/ai/chat",
                "AI Chat",
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "store-navigation",
            ),
            (
                "/dashboard/operations/store-navigation",
                "店铺导航",
                "/dashboard/ai/chat",
                "AI Chat",
                "ai-chat",
            ),
            (
                "/dashboard/ai/chat",
                "AI Chat",
                "/dashboard/operations/daily-analysis",
                "销售数据",
                "daily-analysis",
            ),
            (
                "/dashboard/operations/daily-analysis",
                "销售数据",
                "/dashboard/ai/chat",
                "AI Chat",
                "ai-chat",
            ),
            (
                "/dashboard/ai/chat",
                "AI Chat",
                "/dashboard/finance/commission-management",
                "佣金管理",
                "commission",
            ),
            (
                "/dashboard/finance/commission-management",
                "佣金管理",
                "/dashboard/ai/chat",
                "AI Chat",
                "ai-chat",
            ),
            (
                "/dashboard/ai/chat",
                "AI Chat",
                "/dashboard/reports/scheduled-reports",
                "定时报告",
                "scheduled-reports",
            ),
            (
                "/dashboard/reports/scheduled-reports",
                "定时报告",
                "/dashboard/ai/chat",
                "AI Chat",
                "ai-chat",
            ),
            (
                "/dashboard/ai/chat",
                "AI Chat",
                "/dashboard/ai/believeboy-models",
                "模型选型",
                "model-selection",
            ),
            (
                "/dashboard/ai/believeboy-models",
                "模型选型",
                "/dashboard/ai/chat",
                "AI Chat",
                "ai-chat",
            ),
            // P5-7 rebase 对齐：产品分析/订单信息/汇率信息/VAT 发票四分支在双方
            // 父版本就漏了对方标志复位，合并时按「每个既有分支同时复位两个新视图
            // 标志」规范补齐，此处锁契约。
            (
                "/dashboard/ai/chat",
                "AI Chat",
                "/dashboard/reports/product-analysis",
                "产品分析",
                "product-analysis",
            ),
            (
                "/dashboard/reports/product-analysis",
                "产品分析",
                "/dashboard/ai/chat",
                "AI Chat",
                "ai-chat",
            ),
            (
                "/dashboard/ai/chat",
                "AI Chat",
                "/dashboard/reports/order-info",
                "订单信息",
                "order-info",
            ),
            (
                "/dashboard/reports/order-info",
                "订单信息",
                "/dashboard/ai/chat",
                "AI Chat",
                "ai-chat",
            ),
            (
                "/dashboard/ai/chat",
                "AI Chat",
                "/dashboard/finance/exchange-rate",
                "汇率信息",
                "exchange-rate",
            ),
            (
                "/dashboard/finance/exchange-rate",
                "汇率信息",
                "/dashboard/ai/chat",
                "AI Chat",
                "ai-chat",
            ),
            (
                "/dashboard/ai/chat",
                "AI Chat",
                "/dashboard/finance/vat-invoice",
                "VAT 发票",
                "vat-invoice",
            ),
            (
                "/dashboard/finance/vat-invoice",
                "VAT 发票",
                "/dashboard/ai/chat",
                "AI Chat",
                "ai-chat",
            ),
            // 报表自动化 → 待跟进（P5-7 起为真实视图）：回归锁 else 分支补复位
            // show_auto_upload（待跟进分支自身对 show_auto_upload 的复位也在此链路覆盖）
            (
                "/dashboard/reports/auto-upload",
                "报表自动化",
                "/dashboard/crm/follow-ups",
                "待跟进",
                "crm-follow-ups",
            ),
            // 待跟进 → 报表自动化 → AI Chat：真实视图链路仍正常
            (
                "/dashboard/crm/follow-ups",
                "待跟进",
                "/dashboard/ai/chat",
                "AI Chat",
                "ai-chat",
            ),
        ];
        for (url_a, title_a, url_b, title_b, expected_key) in transitions {
            sub_nav.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sub_nav.update(cx, |this, cx| this.select(url_b, title_b, cx));
            cx.read(|app| {
                assert_eq!(
                    view.read(app).view_key(),
                    expected_key,
                    "AI Chat 两步切换 {title_a} → {title_b}"
                )
            });
        }
    }

    /// P5-8（BLF-757）：日志查看 ↔ 各业务视图的两步切换契约——锁每个既有
    /// 分支的 reset 列表都补了 `show_system_logs = false`（以及 SYSTEM_LOGS_URL
    /// 分支自身对全部既有 show_* 的复位），避免既有分支漏 reset show_system_logs
    /// 触发 view_key/content_view 链末位误命中。
    #[gpui::test]
    async fn view_key_system_logs_cross_resets(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-syslogs2step".into(),
                name: "日志查看两步切换".into(),
                email: "syslogs2step@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: false,
                is_active: true,
                role_type: UserRoleType::Operator,
                session_id: "s-syslogs2step".into(),
                api_key: String::new(),
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        let transitions = [
            (
                "/dashboard/system/logs",
                "日志查看",
                "/dashboard/finance/commission-management",
                "佣金管理",
                "commission",
            ),
            (
                "/dashboard/finance/commission-management",
                "佣金管理",
                "/dashboard/system/logs",
                "日志查看",
                "system-logs",
            ),
            (
                "/dashboard/system/logs",
                "日志查看",
                "/dashboard/operations/daily-analysis",
                "销售数据",
                "daily-analysis",
            ),
            (
                "/dashboard/operations/daily-analysis",
                "销售数据",
                "/dashboard/system/logs",
                "日志查看",
                "system-logs",
            ),
            // 同组互切：Markdown 转换 ↔ 日志查看（owner 互复位）
            (
                "/dashboard/system/logs",
                "日志查看",
                "/dashboard/tools/markdown-to-word",
                "Markdown 转换",
                "markdown-to-word",
            ),
            (
                "/dashboard/tools/markdown-to-word",
                "Markdown 转换",
                "/dashboard/system/logs",
                "日志查看",
                "system-logs",
            ),
            // CRM 操作日志 ↔ 日志查看：两个日志中心互切互复位
            (
                "/dashboard/crm/audit",
                "操作日志",
                "/dashboard/system/logs",
                "日志查看",
                "system-logs",
            ),
            (
                "/dashboard/system/logs",
                "日志查看",
                "/dashboard/crm/audit",
                "操作日志",
                "crm-audit",
            ),
            // 日志查看 → 任意占位页：锁 else 分支对 show_system_logs 的复位
            (
                "/dashboard/system/logs",
                "日志查看",
                "/dashboard/other/nonexistent-placeholder",
                "占位页",
                "placeholder",
            ),
        ];
        for (url_a, title_a, url_b, title_b, expected_key) in transitions {
            sub_nav.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sub_nav.update(cx, |this, cx| this.select(url_b, title_b, cx));
            cx.read(|app| {
                assert_eq!(
                    view.read(app).view_key(),
                    expected_key,
                    "日志查看两步切换 {title_a} → {title_b}"
                )
            });
        }
    }

    /// P4-2：减弱动态效果分支渲染冒烟——MotionPref(true) 时主窗口（含视图切换淡入
    /// 降级、侧栏瞬时切换）可完整渲染不 panic。
    #[gpui::test]
    async fn root_renders_with_reduce_motion(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            cx.set_global(crate::motion::MotionPref(true));
        });
        let session = SessionInfo {
            client: Client::new("http://127.0.0.1:1"),
            user: LoginResponse {
                id: "u-reduce".into(),
                name: "减弱动态用户".into(),
                email: "reduce@believeboy.com".into(),
                operator_name_zh: None,
                is_admin: false,
                is_active: true,
                role_type: UserRoleType::Operator,
                session_id: "s-reduce".into(),
                api_key: String::new(),
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        // 减弱动态下切换到业务视图仍可渲染（无动画路径）
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());
        sub_nav.update(cx, |this, cx| {
            this.select("/dashboard/operations/daily-analysis", "销售数据", cx)
        });
        // 折叠也瞬时切换
        sub_nav.update(cx, |this, cx| this.toggle_collapsed(cx));
        cx.read(|app| assert!(view.read(app).sub_nav_collapsed));
    }

    /// P4-5（BLF-760）渲染冒烟：侧栏展开/折叠 × 亮/暗 四态交叉——每态都渲染
    /// 完整根视图（chrome 头部 + 站点导航内容视图，后者经共享 PageHeader 渲染
    /// 页面头部），断言折叠状态与主题态跟随。标题去重后 chrome 头部仅面包屑，
    /// 四态下都不得 panic。
    #[gpui::test]
    async fn root_render_smoke_collapse_cross_theme(cx: &mut gpui::TestAppContext) {
        for dark in [false, true] {
            for collapsed in [false, true] {
                cx.update(|cx| {
                    gpui_component::init(cx);
                    set_theme_pref(
                        if dark {
                            ThemePreference::Dark
                        } else {
                            ThemePreference::Light
                        },
                        None,
                        cx,
                    );
                });
                let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, None));
                let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

                // 切到站点导航（真实视图，含共享 PageHeader 页面头部）
                sub_nav.update(cx, |this, cx| this.select(SITE_NAV_URL, "站点导航", cx));
                cx.read(|app| {
                    let root = view.read(app);
                    assert!(root.show_site_navigation, "应显示站点导航视图");
                    assert_eq!(root.breadcrumb.last().map(String::as_str), Some("站点导航"));
                });

                // 折叠态切换
                if collapsed {
                    sub_nav.update(cx, |this, cx| this.toggle_collapsed(cx));
                }
                cx.read(|app| {
                    assert_eq!(view.read(app).sub_nav_collapsed, collapsed);
                    assert_eq!(AppTheme::current(app).is_dark(), dark);
                });

                // 再展开回弹（覆盖同窗口内二次切换路径）
                if collapsed {
                    sub_nav.update(cx, |this, cx| this.toggle_collapsed(cx));
                    cx.read(|app| assert!(!view.read(app).sub_nav_collapsed));
                }
            }
        }
    }

    /// P4-5 标题去重回归锁：chrome 头部（content_header）不再渲染业务标题——
    /// root.rs 源码中不得再出现字重加粗标记（此前业务标题用 SEMIBOLD 渲染），
    /// 且头部注释声明「头部仅面包屑」。页面标题唯一来源 = 各视图 PageHeader。
    #[test]
    fn chrome_header_has_no_business_title() {
        let root_src = include_str!("root.rs");
        // 拆分字面量避免 include_str! 自引用（本测试源码也含该词）
        let font_weight = ["Font", "Weight"].concat();
        assert!(
            !root_src.contains(&font_weight),
            "chrome 头部不得再渲染业务标题（字重加粗标记应已从 root.rs 移除）"
        );
        assert!(
            root_src.contains("仅保留面包屑"),
            "content_header 文档应声明仅保留面包屑"
        );
    }

    // ------------------------------------------------------------------
    // BLF-796：Inspector 联动
    // ------------------------------------------------------------------

    /// BLF-796 验收契约①：页面路由 → Inspector 形态自适应——销售数据=运营态、
    /// 广告分析=广告态、AI Chat=AI 态；未注册页面（站点导航）隐藏入口；
    /// 开合事件经 RootView 上抛组合根（持久化链路契约）。
    #[gpui::test]
    async fn inspector_mode_follows_active_view(cx: &mut gpui::TestAppContext) {
        use crate::views::inspector::InspectorMode;
        use std::cell::RefCell;
        use std::rc::Rc;

        cx.update(gpui_component::init);
        let events: Rc<RefCell<Vec<RootViewEvent>>> = Rc::new(RefCell::new(Vec::new()));
        let (view, cx) = cx.add_window_view(|_window, cx| {
            // 自订阅自身事件（对齐 master_rail 测试惯例：cx.entity() 取自身句柄）
            let root_for_sub = cx.entity();
            let events = events.clone();
            cx.subscribe(&root_for_sub, move |_, _, event: &RootViewEvent, _| {
                events.borrow_mut().push(event.clone());
            })
            .detach();
            RootView::new(cx, None)
        });
        let sub_nav = cx.read(|app| view.read(app).sub_nav.clone());

        // 启动着陆页：Dashboard 未注册 → 无形态
        cx.read(|app| assert_eq!(view.read(app).inspector.read(app).mode(), None));

        // 销售数据 → 运营态
        sub_nav.update(cx, |this, cx| this.select(DAILY_ANALYSIS_URL, "销售数据", cx));
        cx.read(|app| {
            assert_eq!(
                view.read(app).inspector.read(app).mode(),
                Some(InspectorMode::Operations),
                "销售数据页必须显示运营态（验收基准）"
            );
        });

        // 广告分析 → 广告态
        sub_nav.update(cx, |this, cx| {
            this.select(AD_ANALYSIS_URL, "广告分析", cx)
        });
        cx.read(|app| {
            assert_eq!(
                view.read(app).inspector.read(app).mode(),
                Some(InspectorMode::Ads),
                "广告分析页必须显示广告态（验收基准）"
            );
        });

        // AI Chat → AI 态
        sub_nav.update(cx, |this, cx| this.select(AI_CHAT_URL, "AI Chat", cx));
        cx.read(|app| {
            assert_eq!(
                view.read(app).inspector.read(app).mode(),
                Some(InspectorMode::Copilot),
                "AI Chat 页必须显示 AI 态（验收基准）"
            );
        });

        // 未注册页 → 隐藏入口
        sub_nav.update(cx, |this, cx| this.select(SITE_NAV_URL, "站点导航", cx));
        cx.read(|app| assert_eq!(view.read(app).inspector.read(app).mode(), None));

        // 回到已注册页后 Cmd+B 语义：toggle 经实体句柄驱动，事件上抛 RootView 层
        sub_nav.update(cx, |this, cx| this.select(DAILY_ANALYSIS_URL, "销售数据", cx));
        let before = events.borrow().len();
        view.update(cx, |root, cx| {
            root.inspector.update(cx, |inspector, cx| inspector.toggle_visible(cx))
        });
        cx.read(|app| assert!(!view.read(app).inspector.read(app).visible(), "应收起"));
        assert_eq!(events.borrow().len(), before + 1, "开合必须上抛持久化事件");
        assert!(matches!(
            events.borrow().last(),
            Some(RootViewEvent::InspectorVisibleChanged(false))
        ));
    }
}
