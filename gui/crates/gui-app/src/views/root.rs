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
//! 头部顶部留避让区）；右侧内容区头部 = 业务标题 + 面包屑路径 + 外观菜单 + 用户/退出；
//! 折叠态下展开按钮位于内容区头部最左，侧栏只剩 56px 图标轨道。

use gpui::prelude::*;
use gpui::{
    div, px, Context, Corner, CursorStyle, Entity, EventEmitter, FocusHandle, Focusable,
    FontWeight, MouseButton, MouseMoveEvent, MouseUpEvent, Render, Window, WindowControlArea,
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
use crate::views::daily_analysis::{DailyAnalysisView, DAILY_ANALYSIS_URL};
use crate::views::dashboard::DashboardView;
use crate::views::monthly_report::{MonthlyReportView, MONTHLY_REPORT_URL};
use crate::views::placeholder::PlaceholderView;
use crate::views::platform_revenue::{PlatformRevenueView, PLATFORM_REVENUE_URL};
use crate::views::scheduled_reports::{ScheduledReportsView, SCHEDULED_REPORTS_URL};
use crate::views::sidebar::{SidebarEvent, SidebarView};
use crate::views::site_navigation::{SiteNavigationView, SITE_NAV_URL};

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
    /// 内容区当前是否显示 Dashboard 着陆页（侧栏选中任意项后切换为占位视图）
    show_dashboard: bool,
    /// 内容区当前是否显示站点导航视图（sidebar Select 命中 SITE_NAV_URL 时置真）
    show_site_navigation: bool,
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
    /// TitleBar 左侧显示的当前视图标题（着陆页为 "Dashboard"，选中侧栏项后跟随）
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
                        this.show_daily_analysis = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
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
                        this.show_daily_analysis = true;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
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
                        this.show_daily_analysis = false;
                        this.show_ad_analysis = true;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
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
                        this.show_daily_analysis = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = true;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
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
                        this.show_daily_analysis = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = true;
                        this.show_platform_revenue = false;
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
                        this.show_daily_analysis = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = true;
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
                        this.show_daily_analysis = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = true;
                    } else {
                        this.show_site_navigation = false;
                        this.show_daily_analysis = false;
                        this.show_ad_analysis = false;
                        this.show_ad_data = false;
                        this.show_monthly_report = false;
                        this.show_platform_revenue = false;
                        this.show_scheduled_reports = false;
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
            daily_analysis: None,
            ad_analysis: None,
            ad_data: None,
            monthly_report: None,
            platform_revenue: None,
            scheduled_reports: None,
            show_dashboard,
            show_site_navigation: false,
            show_daily_analysis: false,
            show_ad_analysis: false,
            show_ad_data: false,
            show_monthly_report: false,
            show_platform_revenue: false,
            show_scheduled_reports: false,
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
            // P2-3（BLF-690）：根容器不画不透明背景——主窗口背景为系统模糊材质
            // （main.rs `WindowBackgroundAppearance::Blurred`），侧栏的半透明材质
            // 直接透出该模糊；右侧内容区仍由下方 content-col 覆盖不透明 window_bg。
            // P4-1（BLF-707）：不再有跨全宽 TitleBar——侧栏全高从窗口顶部开始
            // （头部顶部留 traffic lights 避让区，系统红绿灯悬于其上）。
            .child(self.sidebar.clone())
            .child(
                div()
                    .id("content-col")
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex_col()
                    .bg(theme.window_bg)
                    // P4-1：内容区头部 = 业务标题 + 面包屑 + 外观菜单 + 用户/退出
                    .child(content_header(
                        &self.current_title,
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
                            .child(if self.show_dashboard {
                                self.dashboard.clone().map_or_else(
                                    || self.content.clone().into_any_element(),
                                    |dashboard| dashboard.into_any_element(),
                                )
                            } else if self.show_site_navigation {
                                self.site_navigation.clone().map_or_else(
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
                            } else if self.show_scheduled_reports {
                                self.scheduled_reports.clone().map_or_else(
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
                            } else {
                                self.content.clone().into_any_element()
                            }),
                    ),
            )
    }
}

impl Focusable for RootView {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

/// 右侧内容区头部（P4-1）：左侧 = 业务标题 + 面包屑路径（折叠态下最左还有
/// 「展开侧栏」按钮），右侧 = 外观菜单 + 已登录用户 + 退出登录。
/// 原跨全宽 `TitleBar`（P2-1）的职责迁入此处——主窗口不再有顶部工具栏，
/// 侧栏全高从窗口顶部开始，系统 traffic lights 悬于侧栏头部之上。
fn content_header(
    title: &str,
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
                .child(
                    div()
                        .flex_col()
                        .min_w_0()
                        .child(
                            div()
                                .text_base()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.text_primary)
                                .truncate()
                                .child(title.to_string()),
                        )
                        .child(breadcrumb_row(breadcrumb)),
                ),
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
        .mt_0p5()
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
}
