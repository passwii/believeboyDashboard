//! 主窗口根视图：左侧全高侧栏 + 右侧内容区（P4-1 macOS 原生左右结构）
//!
//! 继承 GUI-3（BLF-675）的侧栏渲染 / 键盘导航 / 占位内容区，
//! GUI-2（BLF-674）叠加：已登录用户信息栏 + 退出登录（emit `RootViewEvent::Logout`，
//! 由 main.rs 清 Keychain 并切回登录窗口）。
//! GUI-7（BLF-679）叠加：Dashboard 首页作为「sidebar 之外的着陆页」启动即显示
//! （对齐 Web /dashboard），侧栏初始无选中项；点击/键盘选中任意子项后切回占位视图。
//! GUI-12（BLF-684）叠加：侧栏命中「运营 → 站点导航」URL 时显示真实站点导航视图
//! （懒创建），其余子项仍为占位视图。
//! P2-2（BLF-689）叠加：主题系统基线——全视图消费 [`AppTheme`] 语义 token
//! （跟随系统亮/暗），「外观」菜单（跟随系统/浅色/深色三态切换）迁入内容区头部。
//! P4-1（BLF-707）窗口 Chrome 重构：**移除跨全宽 gpui-component `TitleBar`**——主窗口
//! 改为经典左右结构，侧栏全高从窗口顶部开始（系统 traffic lights 悬于侧栏头部之上，
//! 头部顶部留避让区）；右侧内容区头部 = 面包屑路径 + 外观菜单 + 用户/退出；
//! P4-5（BLF-760）标题去重：chrome 头部不再重复渲染业务标题（此前 text_base 标题 +
//! 面包屑末项 + 页面 text_2xl 大标题三层重复），仅保留面包屑路径作导航上下文；
//! 页面标题唯一来源 = 各视图 [`crate::widgets::page_header::PageHeader`] 大标题。
//! 折叠态下展开按钮位于内容区头部最左，侧栏只剩 56px 图标轨道。

use gpui::prelude::*;
use gpui::{
    div, px, Context, Corner, CursorStyle, Entity, EventEmitter, FocusHandle, Focusable,
    MouseButton, MouseMoveEvent, MouseUpEvent, Render, Window, WindowControlArea,
};
use gpui_component::breadcrumb::{Breadcrumb, BreadcrumbItem};
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::menu::{DropdownMenu, PopupMenuItem};
use gpui_component::{ActiveTheme, Icon, IconName, InteractiveElementExt, Sizable};
use gui_api_client::Client;
use gui_domain::auth::LoginResponse;
use gui_domain::sidebar::breadcrumb_for;

use crate::theme::{set_theme_pref, AppTheme, ThemePref, ThemePreference};
use crate::views::ad_analysis::{AdAnalysisView, AD_ANALYSIS_URL};
use crate::views::ad_data::{AdDataView, AD_DATA_URL};
use crate::views::ai_chat::{AiChatView, AI_CHAT_URL};
use crate::views::auto_upload::{AutoUploadView, AUTO_UPLOAD_URL};
use crate::views::commission::{CommissionView, COMMISSION_URL};
use crate::views::crm_dashboard::{CrmDashboardView, CRM_DASHBOARD_URL};
use crate::views::crm_follow_ups::{CrmFollowUpsView, CRM_FOLLOW_UPS_URL};
use crate::views::daily_analysis::{DailyAnalysisView, DAILY_ANALYSIS_URL};
use crate::views::dashboard::DashboardView;
use crate::views::exchange_rate::{ExchangeRateView, EXCHANGE_RATE_URL};
use crate::views::inventory_analysis::{InventoryAnalysisView, INVENTORY_ANALYSIS_URL};
use crate::views::inventory_ledger::{InventoryLedgerView, INVENTORY_LEDGER_URL};
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
use crate::views::shipment_management::{ShipmentManagementView, SHIPMENT_MANAGEMENT_URL};
use crate::views::sidebar::{SidebarEvent, SidebarView};
use crate::views::site_navigation::{SiteNavigationView, SITE_NAV_URL};
use crate::views::store_navigation::{StoreNavigationView, STORE_NAV_URL};
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

/// 主窗口根视图事件
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootViewEvent {
    /// 用户点了退出登录（coordinator 负责清 Keychain + 切窗口）
    Logout,
}

/// 根视图：TitleBar + 侧栏 + 内容区
pub struct RootView {
    pub sidebar: Entity<SidebarView>,
    pub content: Entity<PlaceholderView>,
    /// Dashboard 着陆页（sidebar 之外的首页，对齐 Web /dashboard）；启动即显示
    dashboard: Option<Entity<DashboardView>>,
    /// 站点导航真实视图（GUI-12；首个接入的真实 sidebar 页面，点击「运营 → 站点导航」懒创建）
    site_navigation: Option<Entity<SiteNavigationView>>,
    /// 店铺导航真实视图（P5-1；点击「运营 → 店铺导航」懒创建，数据源 /projects/manage）
    store_navigation: Option<Entity<StoreNavigationView>>,
    /// 运营 → 销售数据真实视图（P3-1；点击「运营 → 销售数据」懒创建，复用数据管线）
    daily_analysis: Option<Entity<DailyAnalysisView>>,
    /// 广告 → 广告分析真实视图（P3-3；点击「广告 → 广告分析」懒创建）
    ad_analysis: Option<Entity<AdAnalysisView>>,
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
    /// AI 智能 → AI Chat 真实视图（P5-6 BLF-737；点击「AI 智能 → AI Chat」懒创建，SSE 流式对话）
    ai_chat: Option<Entity<AiChatView>>,

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
    /// 内容区当前是否显示 AI Chat 视图（sidebar Select 命中 AI_CHAT_URL 时置真）
    show_ai_chat: bool,

    /// 内容区当前是否显示平台巡检视图（sidebar Select 命中 PLATFORM_INSPECTION_URL 时置真）
    show_platform_inspection: bool,
    /// 内容区当前视图标题（着陆页为 "Dashboard"，选中侧栏项后跟随）。
    /// P4-5 起 chrome 头部不再渲染该标题（去重），仅用于面包屑兜底与测试断言。
    current_title: String,
    /// P4-1：当前面包屑路径（一级分类 → 二级标题；Dashboard 着陆页为单段）
    breadcrumb: Vec<String>,
    /// P4-1：侧栏当前是否折叠（订阅 `SidebarEvent::Collapsed` 同步；折叠态下
    /// 内容区头部最左渲染「展开侧栏」按钮）
    sidebar_collapsed: bool,
    /// P4-1 修复：窗口拖拽武装标志——鼠标在内容区头部按下后置真，移动时触发
    /// `start_window_move()`；未移动直接松开 = 普通点击（头部内按钮仍可交互）
    should_move: bool,
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

        let sidebar = cx.new(|cx| SidebarView::new(None, cx));
        let content = cx.new(|_| PlaceholderView::new("", ""));

        // 侧栏选中变化 → 内容区切换 + 标题/面包屑跟随（GUI-12：命中站点导航
        // URL 显示真实视图，其余仍为占位）；折叠变化 → 同步内容区头部布局（P4-1）
        cx.subscribe(&sidebar, |this, _sidebar, event, cx| {
            match event {
                SidebarEvent::Collapsed { collapsed } => {
                    this.sidebar_collapsed = *collapsed;
                }
                SidebarEvent::Select { url, title } => {
                    this.show_dashboard = false;
                    this.current_title = title.clone();
                    this.breadcrumb = breadcrumb_for(url).unwrap_or_else(|| vec![title.clone()]);
                    if url == SITE_NAV_URL {
                        this.site_navigation
                            .get_or_insert_with(|| cx.new(|_| SiteNavigationView::new()));
                        this.show_site_navigation = true;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
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
                        this.show_store_navigation = true;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
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
                    } else if url == DAILY_ANALYSIS_URL {
                        // P3-1：销售数据视图懒创建（带会话 client），首帧即触发首屏拉取
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
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
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
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
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
                    } else if url == AD_ANALYSIS_URL
                        || url.starts_with("/dashboard/advertising/ad-analysis")
                    {
                        // P3-3：广告分析视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.ad_analysis.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view = AdAnalysisView::new(
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
                        this.show_ad_analysis = false;
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
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
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
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
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
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
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
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
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
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
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
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
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
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
                        this.show_portfolio_overview = false;
                        this.show_return_analysis = false;
                        this.show_project_goals = false;
                        this.show_inventory_analysis = false;
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
                        this.show_shipment_management = true;
                        this.show_order_info = false;
                        this.show_exchange_rate = false;
                        this.show_vat_invoice = false;
                        this.show_commission = false;
                        this.show_model_selection = false;
                        this.show_crm_dashboard = false;
                        this.show_ai_chat = false;
                        this.show_crm_follow_ups = false;
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
                        this.show_new_product_calculation = true;
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
                        this.show_crm_follow_ups = true;
                    } else if url == AI_CHAT_URL {
                        // P5-6 BLF-737：AI Chat 视图懒创建（带会话 client），首帧即触发首屏拉取
                        this.ai_chat.get_or_insert_with(|| {
                            let client = this.session.as_ref().map(|s| s.client.clone());
                            cx.new(|cx| {
                                let mut view =
                                    AiChatView::new(cx, client.unwrap_or_else(|| Client::new("")));
                                view.reload(cx);
                                view
                            })
                        });
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
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
                        this.show_ai_chat = true;
                    } else {
                        this.show_site_navigation = false;
                        this.show_store_navigation = false;
                        this.show_platform_inspection = false;
                        this.show_daily_analysis = false;
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

                        this.content.update(cx, |content, cx| {
                            content.title = title.clone();
                            content.url = url.clone();
                            cx.notify();
                        });
                    }
                }
            }
            cx.notify();
        })
        .detach();

        Self {
            sidebar,
            content,
            dashboard,
            site_navigation: None,
            store_navigation: None,
            daily_analysis: None,
            ad_analysis: None,
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
            shipment_management: None,
            order_info: None,
            exchange_rate: None,
            vat_invoice: None,
            commission: None,
            model_selection: None,
            crm_dashboard: None,
            crm_follow_ups: None,
            ai_chat: None,

            platform_inspection: None,
            show_dashboard,
            show_site_navigation: false,
            show_store_navigation: false,
            show_daily_analysis: false,
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
            show_shipment_management: false,
            show_order_info: false,
            show_exchange_rate: false,
            show_vat_invoice: false,
            show_commission: false,
            show_model_selection: false,
            show_crm_dashboard: false,
            show_crm_follow_ups: false,
            show_ai_chat: false,
            show_auto_upload: false,

            show_platform_inspection: false,
            current_title: "Dashboard".to_string(),
            breadcrumb: vec!["Dashboard".to_string()],
            sidebar_collapsed: false,
            should_move: false,
            session,
            focus_handle: cx.focus_handle(),
            theme_appearance_sub: None,
        }
    }

    /// 显示非致命警告横幅（会话校验等后台任务回调用）
    pub fn set_warning(&mut self, warning: String, cx: &mut Context<Self>) {
        if let Some(s) = &mut self.session {
            s.warning = Some(warning);
        }
        cx.notify();
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
        } else if self.show_ai_chat {
            "ai-chat"
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
        } else if self.show_ai_chat {
            self.ai_chat.clone().map_or_else(
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
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);

        div()
            .id("root")
            .flex()
            .size_full()
            // P4-3（BLF-709）材质收敛：主窗口背景改用不透明（main.rs 移除
            // `WindowBackgroundAppearance::Blurred`）——GPUI 0.2.2 无 NSVisualEffectView
            // 接入，整窗模糊 + 半透明叠加观感粗糙且禁用亚像素文字渲染（apple-glass.md
            // Tier 4/6）。根容器画不透明 window_bg 兜底（侧栏折叠动画期间无透底/间隙），
            // 侧栏与内容列均为不透明实色（macOS 原生标准窗口观感）。
            .bg(theme.window_bg)
            .child(self.sidebar.clone())
            .child(
                div()
                    .id("content-col")
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex_col()
                    .bg(theme.window_bg)
                    // P4-1：内容区头部 = 面包屑 + 外观菜单 + 用户/退出
                    // P4-5：业务标题去重——头部只留面包屑，标题由页面 PageHeader 承载
                    .child(content_header(
                        &self.breadcrumb,
                        self.sidebar_collapsed,
                        &self.session,
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
                            .id("content")
                            .flex_1()
                            .h_full()
                            .child(self.content_view(cx)),
                    ),
            )
    }
}

impl Focusable for RootView {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

/// 右侧内容区头部（P4-1；P4-5 标题去重）：左侧 = 面包屑路径（折叠态下最左还有
/// 「展开侧栏」按钮），右侧 = 外观菜单 + 已登录用户 + 退出登录。
/// 业务标题不在头部渲染——chrome 标题与页面 PageHeader 大标题重复，
/// 去重后头部仅保留面包屑导航上下文（决策见 BLF-760 完成评论）。
/// 原跨全宽 `TitleBar`（P2-1）的职责迁入此处——主窗口不再有顶部工具栏，
/// 侧栏全高从窗口顶部开始，系统 traffic lights 悬于侧栏头部之上。
fn content_header(
    breadcrumb: &[String],
    collapsed: bool,
    session: &Option<SessionInfo>,
    cx: &mut Context<RootView>,
) -> impl IntoElement {
    let theme = AppTheme::current(cx);

    div()
        .id("content-header")
        .flex()
        .items_center()
        .w_full()
        .h(px(56.0))
        .px_4()
        .gap_3()
        .border_b_1()
        .border_color(theme.separator)
        .child(
            div()
                .id("content-header-left")
                .flex()
                .items_center()
                .gap_3()
                .flex_1()
                .min_w_0()
                .when(collapsed, |this| this.child(expand_sidebar_button(cx)))
                .child(breadcrumb_row(breadcrumb)),
        )
        .child(theme_switcher(cx))
        .child(session_cluster(session, theme, cx))
        .map(|el| attach_window_drag(el, cx))
}

/// P4-1 修复：给内容区头部挂窗口拖拽交互——复刻 gpui-component `TitleBar` 的交互链：
/// `WindowControlArea::Drag` 注册原生拖拽区；按下武装 → 移动时 `start_window_move()`
/// 启动原生窗口拖拽；未移动直接松开 = 普通点击（外观菜单/退出登录仍可交互）；macOS
/// 双击 = `titlebar_double_click()`。与侧栏头部（sidebar.rs）构成左右两条拖拽区。
fn attach_window_drag(
    el: gpui::Stateful<gpui::Div>,
    cx: &mut Context<RootView>,
) -> gpui::Stateful<gpui::Div> {
    el.window_control_area(WindowControlArea::Drag)
        .when(cfg!(target_os = "macos"), |this| {
            this.on_double_click(|_, window, _| window.titlebar_double_click())
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

/// 折叠态内容区头部最左的「展开侧栏」按钮（P4-1：折叠按钮从侧栏头迁移到此处，
/// 侧栏折叠后仅剩 56px 图标轨道，右侧顶部整行让给业务内容）。
fn expand_sidebar_button(cx: &mut Context<RootView>) -> impl IntoElement {
    Button::new("sidebar-expand-button")
        .ghost()
        .small()
        .icon(Icon::new(IconName::PanelLeftOpen).with_size(px(14.0)))
        .tooltip("展开侧栏")
        .on_click(cx.listener(|this, _, _, cx| {
            this.sidebar
                .update(cx, |sidebar, cx| sidebar.toggle_collapsed(cx));
        }))
}

/// 内容区头部「外观」菜单：跟随系统 / 浅色 / 深色 三态（P2-2 主题基线）。
///
/// 当前项带勾选标记；切换经 [`set_theme_pref`] 写入全局偏好并即时换肤。
/// 跟随系统时系统亮暗变化由窗口外观监听自动同步。
fn theme_switcher(cx: &mut Context<RootView>) -> impl IntoElement {
    let pref = cx
        .try_global::<ThemePref>()
        .map(|p| p.0)
        .unwrap_or_default();

    Button::new("theme-switcher")
        .icon(Icon::new(IconName::Palette).with_size(px(14.)))
        .tooltip("外观：跟随系统 / 浅色 / 深色")
        .dropdown_menu_with_anchor(Corner::TopRight, move |menu, _window, _cx| {
            menu.item(
                PopupMenuItem::new(ThemePreference::Light.label())
                    .icon(IconName::Sun)
                    .checked(pref == ThemePreference::Light)
                    .on_click(move |_, window, cx| {
                        set_theme_pref(ThemePreference::Light, Some(window), cx)
                    }),
            )
            .item(
                PopupMenuItem::new(ThemePreference::Dark.label())
                    .icon(IconName::Moon)
                    .checked(pref == ThemePreference::Dark)
                    .on_click(move |_, window, cx| {
                        set_theme_pref(ThemePreference::Dark, Some(window), cx)
                    }),
            )
            .item(
                PopupMenuItem::new(ThemePreference::FollowSystem.label())
                    .icon(IconName::Palette)
                    .checked(pref == ThemePreference::FollowSystem)
                    .on_click(move |_, window, cx| {
                        set_theme_pref(ThemePreference::FollowSystem, Some(window), cx)
                    }),
            )
        })
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
            },
            warning: Some("无法连接服务器：test".into()),
        };
        let (_view, _window_cx) =
            cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
    }

    /// P4-1：折叠状态同步契约——侧栏 toggle 后 RootView 的 sidebar_collapsed 跟随
    /// （内容区头部据此渲染最左「展开侧栏」按钮）。
    /// 通过 sidebar 实体句柄驱动（避免在 RootView update 内嵌套更新自身的
    /// re-entrant borrow——gpui 实体更新是互斥借用）。
    #[gpui::test]
    async fn root_follows_sidebar_collapsed(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, None));
        let sidebar = cx.read(|app| view.read(app).sidebar.clone());

        // 初始展开
        cx.read(|app| {
            let root = view.read(app);
            assert!(!root.sidebar_collapsed, "初始应展开");
            assert_eq!(root.breadcrumb, vec!["Dashboard"]);
        });

        // 折叠：SidebarView emit Collapsed → RootView 同步（同步 emit，单帧内生效）
        sidebar.update(cx, |this, cx| this.toggle_collapsed(cx));
        cx.read(|app| assert!(view.read(app).sidebar_collapsed, "应同步折叠"));

        // 再展开：状态回弹
        sidebar.update(cx, |this, cx| this.toggle_collapsed(cx));
        cx.read(|app| assert!(!view.read(app).sidebar_collapsed, "应同步回展开"));
    }

    /// P4-1：面包屑解析——侧栏选中「销售数据」后内容区头部面包屑 = [运营, 销售数据]，
    /// 标题跟随；占位视图路径也解析（全部 52 子项都能从 gui-domain 解析出两级路径）。
    #[gpui::test]
    async fn root_breadcrumb_follows_sidebar_select(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, None));
        let sidebar = cx.read(|app| view.read(app).sidebar.clone());

        sidebar.update(cx, |this, cx| {
            this.select("/dashboard/operations/daily-analysis", "销售数据", cx)
        });
        cx.read(|app| {
            let root = view.read(app);
            assert_eq!(root.current_title, "销售数据");
            assert_eq!(root.breadcrumb, vec!["运营", "销售数据"]);
        });

        // 广告分析深层子路径经 match_prefixes 命中同一面包屑
        sidebar.update(cx, |this, cx| {
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

    /// P2-2：主题偏好三态菜单语义（label + 显式性），不依赖全局状态。
    #[test]
    fn theme_pref_menu_semantics() {
        assert_eq!(ThemePreference::default(), ThemePreference::FollowSystem);
        assert_eq!(ThemePreference::FollowSystem.label(), "跟随系统");
        assert!(ThemePreference::Dark.is_explicit());
        assert!(!ThemePreference::FollowSystem.is_explicit());
    }

    /// P2-2 核心契约：强制深色模式下主窗口（内容区头部 + 外观菜单 + 侧栏 + 会话栏）
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
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sidebar = cx.read(|app| view.read(app).sidebar.clone());

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
        ] {
            sidebar.update(cx, |this, cx| this.select(url, title, cx));
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
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sidebar = cx.read(|app| view.read(app).sidebar.clone());

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
            sidebar.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sidebar.update(cx, |this, cx| this.select(url_b, title_b, cx));
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
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sidebar = cx.read(|app| view.read(app).sidebar.clone());

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
            sidebar.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sidebar.update(cx, |this, cx| this.select(url_b, title_b, cx));
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
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sidebar = cx.read(|app| view.read(app).sidebar.clone());

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
            sidebar.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sidebar.update(cx, |this, cx| this.select(url_b, title_b, cx));
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
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sidebar = cx.read(|app| view.read(app).sidebar.clone());

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
                "placeholder",
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
            sidebar.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sidebar.update(cx, |this, cx| this.select(url_b, title_b, cx));
            cx.read(|app| {
                assert_eq!(
                    view.read(app).view_key(),
                    expected_key,
                    "新品核算两步切换 {title_a} → {title_b}"
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
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sidebar = cx.read(|app| view.read(app).sidebar.clone());

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
            sidebar.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sidebar.update(cx, |this, cx| this.select(url_b, title_b, cx));
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
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sidebar = cx.read(|app| view.read(app).sidebar.clone());

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
            sidebar.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sidebar.update(cx, |this, cx| this.select(url_b, title_b, cx));
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
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sidebar = cx.read(|app| view.read(app).sidebar.clone());

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
            sidebar.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sidebar.update(cx, |this, cx| this.select(url_b, title_b, cx));
            cx.read(|app| {
                assert_eq!(
                    view.read(app).view_key(),
                    expected_key,
                    "CRM 待跟进两步切换 {title_a} → {title_b}"
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
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        let sidebar = cx.read(|app| view.read(app).sidebar.clone());

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
            sidebar.update(cx, |this, cx| this.select(url_a, title_a, cx));
            sidebar.update(cx, |this, cx| this.select(url_b, title_b, cx));
            cx.read(|app| {
                assert_eq!(
                    view.read(app).view_key(),
                    expected_key,
                    "AI Chat 两步切换 {title_a} → {title_b}"
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
            },
            warning: None,
        };
        let (view, cx) = cx.add_window_view(|_window, cx| RootView::new(cx, Some(session)));
        // 减弱动态下切换到业务视图仍可渲染（无动画路径）
        let sidebar = cx.read(|app| view.read(app).sidebar.clone());
        sidebar.update(cx, |this, cx| {
            this.select("/dashboard/operations/daily-analysis", "销售数据", cx)
        });
        // 折叠也瞬时切换
        sidebar.update(cx, |this, cx| this.toggle_collapsed(cx));
        cx.read(|app| assert!(view.read(app).sidebar_collapsed));
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
                let sidebar = cx.read(|app| view.read(app).sidebar.clone());

                // 切到站点导航（真实视图，含共享 PageHeader 页面头部）
                sidebar.update(cx, |this, cx| this.select(SITE_NAV_URL, "站点导航", cx));
                cx.read(|app| {
                    let root = view.read(app);
                    assert!(root.show_site_navigation, "应显示站点导航视图");
                    assert_eq!(root.breadcrumb.last().map(String::as_str), Some("站点导航"));
                });

                // 折叠态切换
                if collapsed {
                    sidebar.update(cx, |this, cx| this.toggle_collapsed(cx));
                }
                cx.read(|app| {
                    assert_eq!(view.read(app).sidebar_collapsed, collapsed);
                    assert_eq!(AppTheme::current(app).is_dark(), dark);
                });

                // 再展开回弹（覆盖同窗口内二次切换路径）
                if collapsed {
                    sidebar.update(cx, |this, cx| this.toggle_collapsed(cx));
                    cx.read(|app| assert!(!view.read(app).sidebar_collapsed));
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
}
