//! 顶部 Universal Console Filter Bar（BLF-795，父 issue「空间栅格」Console Bar 节）
//!
//! 36px sticky 控制条的四件套组件层：**声明式配置**（[`console_config_for_url`]，
//! 按页面 URL 决定显示哪些控件与默认值）+ **筛选快照**（[`ConsoleFilter`]，项目/
//! 站点/日期三元组，唯一权威状态）+ **统计 pill**（[`console_stat_bar`] 数据面）。
//!
//! 组成：
//! - [`ConsoleBarView`]：控制条实体。渲染 ProjectSelect（选项来自
//!   `/api/v1/projects/manage`，按 X-Operator 服务端过滤）/ CountrySelect /
//!   DateRangePicker（复用 `DateRangePickerState` 翻页模式：日/周/月快捷档 +
//!   自定义区间 + ◀▶ 前后翻页）/ 统计 pill（GMV·订单数·Pending）。
//!   任一筛选变化 emit [`ConsoleBarEvent::Changed`]，由 RootView 转发给当前业务
//!   视图并持久化（组合根 main.rs 写偏好文件——视图层不碰文件系统，与 BLF-794
//!   Sub-Nav 折叠持久化同一纪律）。
//! - [`ConsoleStats`] / [`ConsoleStatsEvent`]：业务视图 Loaded 后把 KPI 推给
//!   控制条，数字一律等宽构造器（JetBrains Mono + tnum，BLF-792 契约）。
//!
//! 与 web 端对齐：筛选状态持久化等价于 web「筛选写 URL query 刷新还原」的桌面
//! 形态（重启还原）；控件高度走 `.small()`（24~28px 规格带），暗色 token 由
//! [`AppTheme`] 统一供给。

use chrono::NaiveDate;
use gpui::{
    div, prelude::*, px, Context, Entity, EventEmitter, IntoElement, ParentElement, Render,
    SharedString, Styled,
};
use gpui_component::{
    button::Button,
    h_flex,
    menu::{DropdownMenu, PopupMenuItem},
    Icon, IconName, Sizable,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;

use crate::prefs;
use crate::theme::AppTheme;
use crate::views::ad_analysis::AD_ANALYSIS_URL;
use crate::views::daily_analysis::DAILY_ANALYSIS_URL;
use crate::views::dashboard::last_7_days_window;
use crate::views::monthly_report::MONTHLY_REPORT_URL;
use crate::views::sku_info::SKU_INFO_URL;
use crate::views::stat_band::{format_compact_currency, format_compact_number};
use crate::widgets::data_table::TabularNumsExt;
use crate::widgets::date_range::{DateRange, DateRangeEvent, DateRangePickerState};

// ---------------------------------------------------------------------------
// 声明式配置：哪些页面显示哪些控件、默认值
// ---------------------------------------------------------------------------

/// Console Bar 四件套声明式配置（模块级配置；按页面能力裁剪控件）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ConsoleBarConfig {
    /// 项目选择器（选项 = 当前 Operator 可见项目）
    pub project: bool,
    /// 站点选择器（US/DE/UK/ALL）；无站点维度的页面不显示
    pub country: bool,
    /// 日期区间选择器（日/周/月快捷档 + 自定义 + 前后翻页）
    pub date: bool,
    /// 统计 pill 位（GMV / 订单数 / Pending；数据由当前视图推送）
    pub stat: bool,
}

impl ConsoleBarConfig {
    /// 是否没有任何控件（此时控制条只渲染面包屑 + 用户 chrome）
    #[allow(dead_code)] // 公共 API 面（视图/测试消费，对齐 widgets 惯例）
    pub fn is_empty(self) -> bool {
        !self.project && !self.country && !self.date && !self.stat
    }
}

/// 按页面 URL 给出该页的 Console Bar 配置（BLF-795 三类代表页先行接入；
/// 未声明的页面一律空配置——控制条保持纯 chrome 不占额外空间）。
pub fn console_config_for_url(url: &str) -> ConsoleBarConfig {
    // 销售数据：全四件套（验收基准页——切项目/站点/日期明细与汇总随之刷新）
    if url == DAILY_ANALYSIS_URL {
        return ConsoleBarConfig {
            project: true,
            country: true,
            date: true,
            stat: true,
        };
    }
    // 广告分析：项目 + 站点 + 日期（概览端点必选项目；指标卡为后端预制文案，
    // 无结构化 GMV/订单数可推 → 不开统计位）
    if url.starts_with(AD_ANALYSIS_URL.trim_end_matches("/overview")) {
        return ConsoleBarConfig {
            project: true,
            country: true,
            date: true,
            stat: false,
        };
    }
    // SKU 信息（BLF-798）：项目 + 站点（服务端分页档案查询；无日期维度与统计位）
    if url == SKU_INFO_URL {
        return ConsoleBarConfig {
            project: true,
            country: true,
            date: false,
            stat: false,
        };
    }
    // 财务月报：项目 + 站点（月粒度窗口由页内月份选择器承载，本阶段不重复暴露日期）
    if url == MONTHLY_REPORT_URL {
        return ConsoleBarConfig {
            project: true,
            country: true,
            date: false,
            stat: false,
        };
    }
    ConsoleBarConfig::default()
}

// ---------------------------------------------------------------------------
// 站点选项（对齐各业务视图 COUNTRY_OPTIONS 口径：value = backend 入参）
// ---------------------------------------------------------------------------

/// 站点选项（US/DE/UK + 全部站点；label 对齐 frontend 站点展示名）
pub const CONSOLE_COUNTRY_OPTIONS: [(&str, &str); 4] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
    ("ALL", "全部站点"),
];

/// 默认站点（对齐 frontend `useUrlParam('country', 'US')`）
pub const DEFAULT_CONSOLE_COUNTRY: &str = "US";

/// 站点展示名（未知码原样返回）
pub fn console_country_label(country: &str) -> String {
    CONSOLE_COUNTRY_OPTIONS
        .iter()
        .find(|(value, _)| *value == country)
        .map_or_else(|| country.to_string(), |(_, label)| label.to_string())
}

/// 站点码是否受支持（脏数据防御：偏好恢复 / 菜单回调共用）
fn known_country(country: &str) -> bool {
    CONSOLE_COUNTRY_OPTIONS
        .iter()
        .any(|(value, _)| *value == country)
}

// ---------------------------------------------------------------------------
// 筛选快照（项目 / 站点 / 日期三元组，唯一权威状态）
// ---------------------------------------------------------------------------

/// Console Bar 筛选快照（`Copy`——可随事件零成本传递）
///
/// `country` 为 `'static` 站点码（"US"/"DE"/"UK"/"ALL"），与各业务视图
/// `select_country(&'static str)` 契约一致；`range` 为闭区间（None = 不限）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConsoleFilter {
    /// 项目 ID（None = 全部项目）
    pub project_id: Option<i64>,
    /// 站点码（'static；见 [`CONSOLE_COUNTRY_OPTIONS`]）
    pub country: &'static str,
    /// 日期区间
    pub range: DateRange,
}

impl Default for ConsoleFilter {
    fn default() -> Self {
        Self {
            project_id: None,
            country: DEFAULT_CONSOLE_COUNTRY,
            range: DateRange::all(),
        }
    }
}

impl ConsoleFilter {
    /// 默认筛选（近 7 天；对齐各业务视图初始口径）
    pub fn today_default(today: NaiveDate) -> Self {
        let (from, to) = last_7_days_window(today);
        Self {
            range: DateRange::new(Some(from), Some(to)),
            ..Self::default()
        }
    }
}

/// [`ConsoleFilter`] → 偏好持久化值（ISO 字符串存日期）
pub fn console_filter_prefs(filter: ConsoleFilter) -> prefs::ConsoleFilterPrefs {
    prefs::ConsoleFilterPrefs {
        project_id: filter.project_id,
        country: Some(filter.country.to_string()),
        date_from: filter.range.from.map(|d| d.to_string()),
        date_to: filter.range.to.map(|d| d.to_string()),
    }
}

/// 从偏好恢复筛选（站点码不受支持 / 日期解析失败 → 该项回退默认）
pub fn console_filter_from_prefs(saved: &prefs::ConsoleFilterPrefs) -> ConsoleFilter {
    let country = saved
        .country
        .as_deref()
        .filter(|c| known_country(c))
        .and_then(|c| {
            CONSOLE_COUNTRY_OPTIONS
                .iter()
                .find(|(value, _)| *value == c)
                .map(|(value, _)| *value)
        })
        .unwrap_or(DEFAULT_CONSOLE_COUNTRY);
    let parse = |s: &Option<String>| {
        s.as_deref()
            .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
    };
    ConsoleFilter {
        project_id: saved.project_id,
        country,
        range: DateRange::new(parse(&saved.date_from), parse(&saved.date_to)),
    }
}

// ---------------------------------------------------------------------------
// 统计 pill（GMV / 订单数 / Pending）
// ---------------------------------------------------------------------------

/// Console Stat Bar 数据面（None 字段不出对应 pill）
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ConsoleStats {
    /// GMV（销售额；币种口径随数据源）
    pub gmv: Option<f64>,
    /// 订单数
    pub orders: Option<i64>,
    /// Pending（待处理单量；警示语义色）
    pub pending: Option<i64>,
}

/// 业务视图 → 控制条的统计推送事件（Loaded 后发出）
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ConsoleStatsEvent(pub ConsoleStats);

/// 紧凑统计 pill 行：`GMV $1.2M · 订单 3.4K · Pending 12`
///
/// 数字一律等宽构造器（JetBrains Mono + tnum）；pill 底 muted_fill、Pending 用
/// 警示语义色（微色彩语义规格）。字段为 None 的位不渲染。
pub fn console_stat_bar(stats: ConsoleStats, theme: &AppTheme) -> gpui::Div {
    let mut row = h_flex().gap_2().items_center();
    if let Some(gmv) = stats.gmv {
        row = row.child(stat_pill(
            "GMV",
            SharedString::from(format_compact_currency(gmv)),
            theme.text_primary,
            theme,
        ));
    }
    if let Some(orders) = stats.orders {
        row = row.child(stat_pill(
            "订单",
            SharedString::from(format_compact_number(orders)),
            theme.text_primary,
            theme,
        ));
    }
    if let Some(pending) = stats.pending {
        row = row.child(stat_pill(
            "Pending",
            SharedString::from(format_compact_number(pending)),
            theme.warning,
            theme,
        ));
    }
    row
}

/// 单个统计 pill（label 说明级弱化色 + 数值等宽语义色）
fn stat_pill(
    label: &'static str,
    value: SharedString,
    value_color: gpui::Hsla,
    theme: &AppTheme,
) -> gpui::Div {
    h_flex()
        .gap_1()
        .items_center()
        .px_2()
        .py_0p5()
        .rounded(px(theme.radius))
        .bg(theme.muted_fill)
        .child(div().text_xs().text_color(theme.text_muted).child(label))
        .child(
            div()
                .text_xs()
                .text_color(value_color)
                .mono_tabular_nums()
                .child(value),
        )
}

// ---------------------------------------------------------------------------
// 控制条实体
// ---------------------------------------------------------------------------

/// 控制条事件（宿主 RootView 订阅）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsoleBarEvent {
    /// 任一筛选控件变化 → 携带完整快照（RootView 转发当前视图 + 持久化）
    Changed(ConsoleFilter),
}

/// 顶部通用控制条（四件套容器；36px 高度由 RootView 插槽承担，本实体只渲染
/// 控件簇——面包屑 / 用户 chrome / 窗口拖拽仍归外壳）
pub struct ConsoleBarView {
    /// 带会话的 API client（项目列表数据源）
    client: Client,
    /// 当前页面声明式配置
    config: ConsoleBarConfig,
    /// 项目列表（Operator 可见；首次启用 project 控件时懒加载）
    projects: Vec<ManagedProject>,
    /// 项目列表是否已请求过（防重复拉取；失败后进入带 project 的页面会重试）
    projects_requested: bool,
    /// 当前筛选
    filter: ConsoleFilter,
    /// 日期区间选择器（翻页模式；变更经订阅回连）
    date_picker: Entity<DateRangePickerState>,
    /// 当前页面统计（视图推送；None 时 pill 区不渲染）
    stats: Option<ConsoleStats>,
    /// 日期选择器订阅（必须持有，否则变更不送达）
    _date_subscription: gpui::Subscription,
}

impl ConsoleBarView {
    /// 新建控制条：从偏好恢复上次筛选（读不到 / 脏数据 → 近 7 天默认）
    pub fn new(client: Client, cx: &mut Context<Self>) -> Self {
        let saved = prefs::load_ui_prefs().console_filter;
        Self::with_initial_filter(
            client,
            saved
                .as_ref()
                .map(console_filter_from_prefs)
                .unwrap_or_else(|| ConsoleFilter::today_default(chrono::Local::now().date_naive())),
            cx,
        )
    }

    /// 注入初始筛选构造（测试确定性入口；生产路径走 [`Self::new`] 读偏好）
    pub fn with_initial_filter(
        client: Client,
        filter: ConsoleFilter,
        cx: &mut Context<Self>,
    ) -> Self {
        let date_picker = cx.new(DateRangePickerState::new);
        date_picker.update(cx, |picker, _| {
            picker.set_range(filter.range);
            // BLF-795：Console Bar 场景开翻页模式（◀ 区间 ▶；隐藏「日期」label）
            picker.set_paging(true);
        });
        let subscription = cx.subscribe(&date_picker, |this, _entity, ev, cx| {
            let DateRangeEvent::Change(range) = ev;
            this.filter.range = *range;
            this.commit(cx);
        });
        Self {
            client,
            config: ConsoleBarConfig::default(),
            projects: Vec::new(),
            projects_requested: false,
            filter,
            date_picker,
            stats: None,
            _date_subscription: subscription,
        }
    }

    /// 当前筛选快照
    pub fn snapshot(&self) -> ConsoleFilter {
        self.filter
    }

    /// 当前页面配置
    #[allow(dead_code)] // 测试消费（对齐各视图 current_state 惯例）
    pub fn config(&self) -> ConsoleBarConfig {
        self.config
    }

    /// 页面路由变化 → 应用新声明式配置（保留用户已有筛选值；首次启用项目
    /// 控件时懒加载项目列表）
    pub fn set_config(&mut self, config: ConsoleBarConfig, cx: &mut Context<Self>) {
        if self.config == config {
            return;
        }
        self.config = config;
        if config.project && !self.projects_requested {
            self.load_projects(cx);
        }
        cx.notify();
    }

    /// 视图推送统计（Loaded 后；仅刷新 pill 区，不影响筛选）
    pub fn set_stats(&mut self, stats: ConsoleStats, cx: &mut Context<Self>) {
        if self.stats == Some(stats) {
            return;
        }
        self.stats = Some(stats);
        cx.notify();
    }

    /// 当前统计数据面（只读，测试用）
    #[allow(dead_code)] // 视图级测试消费（对齐各视图 current_state 惯例）
    pub fn current_stats(&self) -> Option<ConsoleStats> {
        self.stats
    }

    /// 外部设置筛选（恢复/测试用；同值 no-op，异值提交并同步日期选择器回显）
    #[allow(dead_code)]
    pub fn apply_filter(&mut self, filter: ConsoleFilter, cx: &mut Context<Self>) {
        if self.filter == filter {
            return;
        }
        self.filter = filter;
        self.date_picker
            .update(cx, |picker, _| picker.set_range(filter.range));
        self.commit(cx);
    }

    /// 项目切换（菜单回调；同值 no-op）
    fn select_project(&mut self, project_id: Option<i64>, cx: &mut Context<Self>) {
        if self.filter.project_id == project_id {
            return;
        }
        self.filter.project_id = project_id;
        self.commit(cx);
    }

    /// 站点切换（菜单回调；同值 / 未知码 no-op）
    fn select_country(&mut self, country: &'static str, cx: &mut Context<Self>) {
        if self.filter.country == country || !known_country(country) {
            return;
        }
        self.filter.country = country;
        self.commit(cx);
    }

    /// 提交一次筛选变化：emit 事件（宿主转发视图 + 持久化）+ 重绘
    fn commit(&mut self, cx: &mut Context<Self>) {
        cx.emit(ConsoleBarEvent::Changed(self.snapshot()));
        cx.notify();
    }

    /// 懒加载项目列表（`GET /projects/manage`，服务端按 X-Operator 过滤；
    /// 失败静默——菜单仍提供「全部项目」，复位请求标志后下次进入带 project
    /// 的页面会重试）
    fn load_projects(&mut self, cx: &mut Context<Self>) {
        self.projects_requested = true;
        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(
            async move |this: gpui::WeakEntity<Self>, cx: &mut gpui::AsyncApp| {
                // 与各业务视图同一管线：专用 tokio runtime 上阻塞拉取（后台线程）
                let projects = bg
                    .spawn(async move {
                        crate::runtime::runtime().block_on(client.list_managed_projects())
                    })
                    .await;
                this.update(cx, |this, cx| {
                    match projects {
                        Ok(list) => this.projects = list,
                        // 失败复位请求标志：否则下拉永远只有「全部项目」直到重启
                        Err(_) => this.projects_requested = false,
                    }
                    cx.notify();
                })
                .ok();
            },
        )
        .detach();
    }

    /// 项目按钮显示名
    fn project_label(&self) -> String {
        match self.filter.project_id {
            None => "全部项目".to_string(),
            Some(id) => self
                .projects
                .iter()
                .find(|p| p.id == id)
                .map(|p| p.name.clone())
                .unwrap_or_else(|| format!("项目 {id}")),
        }
    }
}

impl EventEmitter<ConsoleBarEvent> for ConsoleBarView {}

impl Render for ConsoleBarView {
    fn render(&mut self, _window: &mut gpui::Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let config = self.config;
        let projects_owned = self.projects.clone();
        let selected_project_id = self.filter.project_id;
        let country = self.filter.country;
        let entity_for_project = cx.entity();
        let entity_for_country = cx.entity();

        h_flex()
            .id("console-bar-controls")
            .gap_2()
            .items_center()
            .min_w_0()
            // 项目选择器：label + 下拉（选项 = Operator 可见项目，服务端过滤）
            .when(config.project, |row| {
                let label: SharedString = self.project_label().into();
                let entity = entity_for_project;
                row.child(div().text_xs().text_color(theme.text_muted).child("项目"))
                    .child(
                        Button::new("console-project-select")
                            .outline()
                            .small()
                            .label(label)
                            .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                            .dropdown_menu_with_anchor(
                                gpui::Corner::BottomLeft,
                                move |menu, _window, _cx| {
                                    let mut menu = menu;
                                    // 「全部项目」= 清除项目筛选（None）
                                    menu = menu.item(
                                        PopupMenuItem::new("全部项目")
                                            .checked(selected_project_id.is_none())
                                            .on_click({
                                                let view = entity.clone();
                                                move |_, _, cx| {
                                                    view.update(cx, |this, cx| {
                                                        this.select_project(None, cx)
                                                    });
                                                }
                                            }),
                                    );
                                    for project in &projects_owned {
                                        let checked = selected_project_id == Some(project.id);
                                        let id = project.id;
                                        let name = project.name.clone();
                                        menu = menu.item(
                                            PopupMenuItem::new(name).checked(checked).on_click({
                                                let view = entity.clone();
                                                move |_, _, cx| {
                                                    view.update(cx, |this, cx| {
                                                        this.select_project(Some(id), cx)
                                                    });
                                                }
                                            }),
                                        );
                                    }
                                    menu
                                },
                            ),
                    )
            })
            // 站点选择器：label + 下拉（US/DE/UK/ALL）
            .when(config.country, |row| {
                let entity = entity_for_country;
                row.child(div().text_xs().text_color(theme.text_muted).child("站点"))
                    .child(
                        Button::new("console-country-select")
                            .outline()
                            .small()
                            .label(SharedString::from(console_country_label(country)))
                            .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                            .dropdown_menu_with_anchor(
                                gpui::Corner::BottomLeft,
                                move |menu, _window, _cx| {
                                    let mut menu = menu;
                                    for (value, label) in CONSOLE_COUNTRY_OPTIONS {
                                        let checked = country == value;
                                        menu = menu.item(
                                            PopupMenuItem::new(label).checked(checked).on_click({
                                                let view = entity.clone();
                                                move |_, _, cx| {
                                                    view.update(cx, |this, cx| {
                                                        this.select_country(value, cx)
                                                    });
                                                }
                                            }),
                                        );
                                    }
                                    menu
                                },
                            ),
                    )
            })
            // 日期区间：复用 DateRangePickerState 翻页模式（◀ 快捷/自定义区间 ▶）
            .when(config.date, |row| row.child(self.date_picker.clone()))
            // 统计 pill（视图未推送数据前不占位）
            .when(config.stat, |row| {
                row.when_some(self.stats, |inner, stats| {
                    inner.child(console_stat_bar(stats, &theme))
                })
            })
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    // ---------- 声明式配置 ----------

    /// BLF-795 验收：三类代表页各自默认配置正确——销售数据全四件套、广告分析
    /// 项目+站点+日期、财务月报项目+站点；未声明页面（如订单信息之外的 AI Chat）
    /// 一律空配置。
    #[test]
    fn console_config_for_url_maps_representative_pages() {
        let daily = console_config_for_url(DAILY_ANALYSIS_URL);
        assert!(daily.project && daily.country && daily.date && daily.stat);

        let ad = console_config_for_url(AD_ANALYSIS_URL);
        assert!(ad.project && ad.country && ad.date);
        assert!(!ad.stat, "广告分析不开统计位");

        let monthly = console_config_for_url(MONTHLY_REPORT_URL);
        assert!(monthly.project && monthly.country);
        assert!(!monthly.date, "财务月报月粒度由页内月份选择器承载");
        assert!(!monthly.stat);

        let other = console_config_for_url("/dashboard/ai/ai-chat");
        assert!(other.is_empty(), "未声明页面一律空配置");
    }

    // ---------- 筛选快照 ↔ 偏好互转 ----------

    #[test]
    fn console_filter_prefs_roundtrip() {
        let filter = ConsoleFilter {
            project_id: Some(7),
            country: "DE",
            range: DateRange::new(Some(d(2026, 8, 1)), Some(d(2026, 8, 15))),
        };
        let prefs = console_filter_prefs(filter);
        assert_eq!(prefs.country.as_deref(), Some("DE"));
        assert_eq!(prefs.date_from.as_deref(), Some("2026-08-01"));
        let restored = console_filter_from_prefs(&prefs);
        assert_eq!(restored, filter);
    }

    /// 脏数据防御：未知站点码回退默认 US；坏日期按 None（不限）处理
    #[test]
    fn console_filter_from_prefs_falls_back_on_dirty_data() {
        let saved = prefs::ConsoleFilterPrefs {
            project_id: None,
            country: Some("XX".into()),
            date_from: Some("not-a-date".into()),
            date_to: None,
        };
        let filter = console_filter_from_prefs(&saved);
        assert_eq!(filter.country, DEFAULT_CONSOLE_COUNTRY);
        assert_eq!(filter.range.from, None);
    }

    /// 默认筛选 = 近 7 天（对齐各业务视图初始口径，避免首切页面多余 reload）
    #[test]
    fn today_default_is_last_seven_days() {
        let filter = ConsoleFilter::today_default(d(2026, 8, 15));
        // last_7_days_window 口径：[today-7, today-1]（昨天为界，共 7 天）
        assert_eq!(filter.range.from, Some(d(2026, 8, 8)));
        assert_eq!(filter.range.to, Some(d(2026, 8, 14)));
        assert_eq!(filter.country, "US");
        assert_eq!(filter.project_id, None);
    }

    // ---------- 渲染与事件 ----------

    /// 宿主视图：持有控制条 + 捕获最近一次 Changed 事件
    struct ConsoleBarHost {
        bar: Entity<ConsoleBarView>,
        last_event: Option<ConsoleFilter>,
        _subscription: gpui::Subscription,
    }

    impl ConsoleBarHost {
        fn new(cx: &mut gpui::Context<Self>) -> Self {
            let client = Client::new("");
            let bar = cx.new(|cx| {
                ConsoleBarView::with_initial_filter(
                    client,
                    ConsoleFilter::today_default(d(2026, 8, 15)),
                    cx,
                )
            });
            let subscription = cx.subscribe(&bar, |this, _entity, ev, _cx| {
                let ConsoleBarEvent::Changed(filter) = ev;
                this.last_event = Some(*filter);
            });
            Self {
                bar,
                last_event: None,
                _subscription: subscription,
            }
        }
    }

    impl Render for ConsoleBarHost {
        fn render(
            &mut self,
            _window: &mut gpui::Window,
            _cx: &mut gpui::Context<Self>,
        ) -> impl IntoElement {
            self.bar.clone()
        }
    }

    /// select_project / select_country 更新快照并 emit Changed；同值 / 未知码 no-op
    #[gpui::test]
    async fn console_bar_select_updates_snapshot_and_emits(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (host, cx2) = cx.add_window_view(|_window, cx| ConsoleBarHost::new(cx));

        cx2.update(|_, app| {
            host.update(app, |host, cx| {
                host.bar
                    .update(cx, |bar, cx| bar.select_project(Some(3), cx))
            });
        });
        cx2.read(|app| {
            let host = host.read(app);
            assert_eq!(host.last_event.map(|f| f.project_id), Some(Some(3)));
        });

        // 同值 no-op：last_event 不变（仍为第一次的事件）
        cx2.update(|_, app| {
            host.update(app, |host, cx| {
                host.bar
                    .update(cx, |bar, cx| bar.select_project(Some(3), cx))
            });
        });
        cx2.read(|app| {
            let host = host.read(app);
            assert_eq!(host.last_event.map(|f| f.project_id), Some(Some(3)));
        });

        // 站点切换 + 快照整体校验
        cx2.update(|_, app| {
            host.update(app, |host, cx| {
                host.bar.update(cx, |bar, cx| bar.select_country("UK", cx))
            });
        });
        cx2.read(|app| {
            let host = host.read(app);
            let snapshot = host.bar.read(app).snapshot();
            assert_eq!(snapshot.project_id, Some(3));
            assert_eq!(snapshot.country, "UK");
            assert_eq!(snapshot.range.from, Some(d(2026, 8, 8)));
            assert_eq!(host.last_event, Some(snapshot));
        });

        // 未知站点码拒绝（脏数据防御）
        cx2.update(|_, app| {
            host.update(app, |host, cx| {
                host.bar.update(cx, |bar, cx| bar.select_country("ZZ", cx))
            });
        });
        cx2.read(|app| {
            assert_eq!(host.read(app).bar.read(app).snapshot().country, "UK");
        });
    }

    /// 渲染冒烟（亮 / 暗）：控制条实体（含翻页日期选择器）可完整渲染不 panic
    #[gpui::test]
    async fn console_bar_renders_in_light_and_dark(cx: &mut gpui::TestAppContext) {
        for dark in [false, true] {
            cx.update(|cx| {
                gpui_component::init(cx);
                crate::theme::set_theme_pref(
                    if dark {
                        crate::theme::ThemePreference::Dark
                    } else {
                        crate::theme::ThemePreference::Light
                    },
                    None,
                    cx,
                );
            });
            let (_host, cx2) = cx.add_window_view(|_window, cx| ConsoleBarHost::new(cx));
            cx2.read(|app| {
                assert_eq!(AppTheme::current(app).is_dark(), dark);
            });
        }
    }

    /// set_config 全四件套后配置生效（控件渲染分支打开）
    #[gpui::test]
    async fn console_bar_set_config_enables_controls(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (host, cx2) = cx.add_window_view(|_window, cx| ConsoleBarHost::new(cx));
        cx2.read(|app| {
            assert!(host.read(app).bar.read(app).config().is_empty());
        });
        cx2.update(|_, app| {
            host.update(app, |host, cx| {
                host.bar.update(cx, |bar, cx| {
                    bar.set_config(console_config_for_url(DAILY_ANALYSIS_URL), cx)
                });
            });
        });
        cx2.read(|app| {
            let config = host.read(app).bar.read(app).config();
            assert!(config.project && config.country && config.date && config.stat);
        });
    }

    /// 统计推送：set_stats 后数据面就位（同值 no-op 不触发重绘请求以外的副作用）
    #[gpui::test]
    async fn console_bar_accepts_stats_push(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let (host, cx2) = cx.add_window_view(|_window, cx| ConsoleBarHost::new(cx));
        let stats = ConsoleStats {
            gmv: Some(3100.0),
            orders: Some(56),
            pending: Some(2),
        };
        cx2.update(|_, app| {
            host.update(app, |host, cx| {
                host.bar.update(cx, |bar, cx| bar.set_stats(stats, cx));
            });
        });
        cx2.read(|app| {
            assert_eq!(host.read(app).bar.read(app).current_stats(), Some(stats));
        });
    }

    /// review 顺手项回归：项目列表拉取**失败**后必须复位 `projects_requested`，
    /// 否则下拉永远只有「全部项目」直到重启。client 指向不可达地址
    /// （127.0.0.1:1 本地立即拒绝连接，无外部网络依赖）；真实失败回调经
    /// allow_parking + run_until_parked 冲刷。
    #[gpui::test]
    async fn projects_requested_resets_on_load_failure_allowing_retry(
        cx: &mut gpui::TestAppContext,
    ) {
        cx.update(gpui_component::init);
        let bar = cx.update(|cx| {
            let client = Client::new("http://127.0.0.1:1");
            cx.new(|cx| {
                ConsoleBarView::with_initial_filter(
                    client,
                    ConsoleFilter::today_default(d(2026, 8, 15)),
                    cx,
                )
            })
        });

        // 首次进入带 project 的页面：发起拉取并置位防重复标志
        bar.update(cx, |bar, cx| {
            bar.set_config(console_config_for_url(DAILY_ANALYSIS_URL), cx)
        });
        cx.read(|app| assert!(bar.read(app).projects_requested));

        // 冲刷真实失败回调（connection refused 即刻返回）
        cx.executor().allow_parking();
        cx.run_until_parked();
        cx.read(|app| {
            let bar = bar.read(app);
            assert!(
                !bar.projects_requested,
                "拉取失败必须复位请求标志（否则永不重试）"
            );
            assert!(bar.projects.is_empty(), "失败不应写入任何项目");
        });

        // 复位后再次进入带 project 的页面（配置经空页往返）应重新发起请求
        bar.update(cx, |bar, cx| {
            bar.set_config(ConsoleBarConfig::default(), cx)
        });
        bar.update(cx, |bar, cx| {
            bar.set_config(console_config_for_url(DAILY_ANALYSIS_URL), cx)
        });
        cx.read(|app| {
            assert!(
                bar.read(app).projects_requested,
                "失败复位后再次进入带 project 的页面应重试拉取"
            );
        });
    }

    // ---------- 契约锁 ----------

    /// 数字 pill 必须走等宽构造器（BLF-792 数字列契约）
    #[test]
    fn stat_pill_values_use_mono_builder() {
        let src = include_str!("console_bar.rs");
        assert!(
            src.contains(".mono_tabular_nums()"),
            "统计 pill 数值必须用 mono_tabular_nums 等宽构造器"
        );
    }

    /// 站点选项口径与销售数据视图一致（US/DE/UK/ALL，label 对齐 frontend）
    #[test]
    fn country_options_align_with_daily_analysis_view() {
        use crate::views::daily_analysis::country_label;
        for (value, label) in CONSOLE_COUNTRY_OPTIONS {
            assert_eq!(console_country_label(value), country_label(value));
            assert_eq!(console_country_label(value), label);
        }
    }
}
