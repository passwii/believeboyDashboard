//! 广告 → 广告分析视图（P3-3，BLF-703）
//!
//! frontend `app/dashboard/advertising/ad-analysis/overview/page.tsx` 的 GPUI 等价：
//! 指标卡（花费 / ACOS / ROAS 等，`display_value` 已由后端格式化）+ 周期对比 +
//! 近 7 日趋势表 + 高消耗活动 / SKU / 浪费搜索词 + 结构化分析与风险提醒。
//!
//! 架构（复用 Phase 1/2 基建）：
//! - **四态状态机**：`Loading / Loaded / Empty / Error`（沿用 `dashboard.rs` /
//!   `daily_analysis.rs` 模式），`latest_request_id` 竞态保护；
//! - **数据管线**：`list_managed_projects` + `ad_analysis_overview`（近 7 天窗口，
//!   对齐 GUI 其余页面的固定周期口径）；
//! - **筛选**：项目 Select + 站点 Select（US/DE/UK，对齐 frontend ad-analysis
//!   `COUNTRY_OPTIONS`；概览端点要求必选项目）+ 刷新；
//! - **图表边界**：趋势用列表呈现（图表真渲染属 P3-2 Dashboard 范围，本棒不做）。
//!
//! 已知差异（有意保留）：
//! - 周期固定「近 7 天」（与 Dashboard / 销售数据一致），日期范围选择器留后续；
//! - 下钻链接（活动/SKU/搜索词）在 GUI 侧不实现（无内部路由），仅展示排名。

use chrono::NaiveDate;
use gpui::{
    div, prelude::*, px, App, AsyncApp, Context, Entity, FontWeight, Render, SharedString,
    WeakEntity, Window,
};
use gpui_component::{
    button::Button,
    h_flex,
    menu::{DropdownMenu, PopupMenuItem},
    v_flex, Icon, IconName, Sizable, StyledExt,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::advertising::{
    AdIssueCard, AdNarrativeSection, AdOverviewResponse, AdPeriodComparison, AdTopCampaignRow,
    AdTopProductRow, AdTopWasteTermRow, AdTrendRow,
};

use crate::theme::AppTheme;
use crate::views::dashboard::last_7_days_window;
use crate::widgets::data_table::{CellAlign, ColumnDef, DataTable};
use crate::widgets::date_range::{DateRange, DateRangeEvent, DateRangePickerState};
use crate::widgets::layout::content_guard;
use crate::widgets::state_views::{self, SkeletonBlock};
use crate::widgets::page_header::PageHeader;
use crate::widgets::top_projects::{fmt_money_precise, fmt_num_precise};

/// 本页在侧栏中的 URL（root.rs 据此路由；与 gui-domain::sidebar 的广告分析条目一致）
pub const AD_ANALYSIS_URL: &str = "/dashboard/advertising/ad-analysis/overview";

/// 站点选项（对齐 frontend ad-analysis `COUNTRY_OPTIONS`：US/DE/UK，无「全部站点」）
const COUNTRY_OPTIONS: [(&str, &str); 3] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
];

/// 默认站点（对齐 frontend `useUrlParam('country', 'US')`）
const DEFAULT_COUNTRY: &str = "US";

/// 站点展示名（未知值原样返回）
pub fn ad_country_label(country: &str) -> String {
    COUNTRY_OPTIONS
        .iter()
        .find(|(value, _)| *value == country)
        .map_or_else(|| country.to_string(), |(_, label)| label.to_string())
}

/// 广告分析载荷（Loaded 持有）
#[derive(Debug, Clone, PartialEq)]
pub struct AdAnalysisData {
    pub projects: Vec<ManagedProject>,
    pub overview: AdOverviewResponse,
    pub date_from: NaiveDate,
    pub date_to: NaiveDate,
}

impl AdAnalysisData {
    /// 空态判定：没有任何指标卡 / 趋势 / Top 表 → Empty
    /// （对齐 frontend overview-client 的 `!data` 空态；后端无数据时 metrics 为空）
    pub fn is_empty(&self) -> bool {
        self.overview.metrics.is_empty()
            && self.overview.trend_summary.is_empty()
            && self.overview.top_campaigns.is_empty()
            && self.overview.top_products.is_empty()
            && self.overview.top_waste_terms.is_empty()
    }
}

/// 广告分析状态机（四态；对齐 dashboard.rs / daily_analysis.rs）
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum AdAnalysisState {
    Loading,
    Loaded(AdAnalysisData),
    Empty,
    Error(String),
}

impl AdAnalysisState {
    /// 拉取结果 → 落点状态（唯一合法的「拉取完成」转移）
    pub fn from_fetch_result(result: Result<AdAnalysisData, String>) -> Self {
        match result {
            Ok(data) if data.is_empty() => Self::Empty,
            Ok(data) => Self::Loaded(data),
            Err(msg) => Self::Error(msg),
        }
    }
}

/// 广告分析视图（状态机 + 项目/站点筛选 + 竞态保护）
pub struct AdAnalysisView {
    state: Entity<AdAnalysisState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表（reload 刷新；筛选菜单数据源）
    projects: Vec<ManagedProject>,
    /// 当前选中项目；概览端点要求必选，`None` 时显示「请先选择项目」
    selected_project_id: Option<i64>,
    /// 当前站点（"US" / "DE" / "UK"）
    country: &'static str,
    /// 日期区间筛选（默认近 7 天；ad_analysis_overview 支持 date_from/date_to）
    date_range: DateRange,
    /// 日期区间选择器（懒建 + 订阅 Change）
    date_picker: Option<Entity<DateRangePickerState>>,
    /// 三个 Top 表（高消耗活动 / SKU / 浪费搜索词；懒建 DataTable）
    top_campaigns_table: Option<Entity<DataTable<AdTopCampaignRow>>>,
    top_products_table: Option<Entity<DataTable<AdTopProductRow>>>,
    top_waste_terms_table: Option<Entity<DataTable<AdTopWasteTermRow>>>,
    /// 日期区间选择器事件订阅（必须持有，否则变更不送达）
    _subscriptions: Vec<gpui::Subscription>,
    /// 请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,
}

impl AdAnalysisView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| AdAnalysisState::Loading);
        // 默认近 7 天（对齐旧行为）；订阅日期区间选择器的变更
        let (from, to) = last_7_days_window(chrono::Local::now().date_naive());
        let date_range = DateRange::new(Some(from), Some(to));
        let date_picker = cx.new(DateRangePickerState::new);
        let subscription = cx.subscribe(&date_picker, |this, _entity, ev, cx| {
            let range = match ev {
                DateRangeEvent::Change(range) => *range,
            };
            this.apply_date_range(range, cx);
        });
        Self {
            state,
            client,
            projects: Vec::new(),
            selected_project_id: None,
            country: DEFAULT_COUNTRY,
            date_range,
            date_picker: Some(date_picker),
            top_campaigns_table: None,
            top_products_table: None,
            top_waste_terms_table: None,
            _subscriptions: vec![subscription],
            latest_request_id: 0,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> AdAnalysisState {
        self.state.read(cx).clone()
    }

    /// 重新拉取数据：项目/站点切换、错误重试、空态刷新共用入口。
    ///
    /// 每次调用递增 `latest_request_id` 并进入 Loading；响应回来时
    /// `apply_result` 只应用最新一次（竞态保护，对齐 dashboard.rs）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let selected = self.selected_project_id;
        let country = self.country;
        // 未设置区间时回退近 7 天（防御：外部 set_range 清空等）
        let (date_from, date_to) = match (self.date_range.from, self.date_range.to) {
            (Some(f), Some(t)) => (f, t),
            _ => last_7_days_window(chrono::Local::now().date_naive()),
        };

        self.state.update(cx, |state, cx| {
            *state = AdAnalysisState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(load_ad_analysis(&client, selected, country, date_from, date_to))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 切换选中项目 → reload（`None` = 未选择；同一项目为 no-op）
    pub fn select_project(&mut self, project_id: Option<i64>, cx: &mut Context<Self>) {
        if project_id == self.selected_project_id {
            return;
        }
        self.selected_project_id = project_id;
        self.reload(cx);
    }

    /// 切换站点 → reload（同一站点为 no-op）
    pub fn select_country(&mut self, country: &'static str, cx: &mut Context<Self>) {
        if country == self.country {
            return;
        }
        self.country = country;
        self.reload(cx);
    }

    /// 应用日期区间（同一区间 no-op）→ reload
    pub fn apply_date_range(&mut self, range: DateRange, cx: &mut Context<Self>) {
        if self.date_range == range {
            return;
        }
        self.date_range = range;
        self.reload(cx);
    }

    /// BLF-795：Console Bar 筛选一键应用——对比当前三维，只对变化维度落值，
    /// 任一变化仅触发一次 reload。返回是否有实际变化。
    pub fn apply_console_filter(
        &mut self,
        project_id: Option<i64>,
        country: &'static str,
        range: DateRange,
        cx: &mut Context<Self>,
    ) -> bool {
        let project_changed = project_id != self.selected_project_id;
        let country_changed = country != self.country;
        let range_changed =
            range.from.is_some() && range.to.is_some() && range != self.date_range;
        if !project_changed && !country_changed && !range_changed {
            return false;
        }
        if project_changed {
            self.selected_project_id = project_id;
        }
        if country_changed {
            self.country = country;
        }
        if range_changed {
            self.date_range = range;
        }
        self.reload(cx);
        true
    }

    /// 把概览 Top 行同步进三张 DataTable（懒建 + 幂等注入；render 期调用）
    fn sync_top_tables(&mut self, data: &AdAnalysisData, cx: &mut Context<Self>) {
        let campaigns = self
            .top_campaigns_table
            .get_or_insert_with(|| {
                cx.new(|_| {
                    DataTable::new("ad-top-campaigns-table", campaign_columns())
                        .striped(true)
                        .empty_text("暂无活动明细")
                        .max_height(280.0)
                })
            });
        campaigns.update(cx, |table, cx| {
            table.set_rows_if_changed(&data.overview.top_campaigns, cx);
        });
        let products = self
            .top_products_table
            .get_or_insert_with(|| {
                cx.new(|_| {
                    DataTable::new("ad-top-products-table", product_columns())
                        .striped(true)
                        .empty_text("暂无推广商品明细")
                        .max_height(280.0)
                })
            });
        products.update(cx, |table, cx| {
            table.set_rows_if_changed(&data.overview.top_products, cx);
        });
        let waste = self
            .top_waste_terms_table
            .get_or_insert_with(|| {
                cx.new(|_| {
                    DataTable::new("ad-top-waste-table", waste_columns())
                        .striped(true)
                        .empty_text("暂无浪费词明细")
                        .max_height(280.0)
                })
            });
        waste.update(cx, |table, cx| {
            table.set_rows_if_changed(&data.overview.top_waste_terms, cx);
        });
    }

    /// 应用拉取结果：竞态保护（过期响应丢弃）+ Loaded 落点前记录项目列表。
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<AdAnalysisData, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok(data) = &result {
            self.projects = data.projects.clone();
        }
        self.state.update(cx, |state, cx| {
            *state = AdAnalysisState::from_fetch_result(result);
            cx.notify();
        });
    }
}

/// 拉取广告分析（项目列表 + 概览），与视图解耦便于测试。
///
/// 对齐 frontend overview-client：项目列表为空 → 空载荷（Empty）；
/// 概览端点要求必选项目，未选时返回空载荷（前端同样要求先选项目）。
async fn load_ad_analysis(
    client: &Client,
    selected_project_id: Option<i64>,
    country: &str,
    date_from: chrono::NaiveDate,
    date_to: chrono::NaiveDate,
) -> Result<AdAnalysisData, String> {
    let projects = client
        .list_managed_projects()
        .await
        .map_err(|e| e.user_message())?;

    let Some(project_id) = selected_project_id else {
        return Ok(AdAnalysisData {
            projects,
            overview: AdOverviewResponse {
                project_id: 0,
                country: country.to_string(),
                metrics: Vec::new(),
                issue_cards: Vec::new(),
                narrative_sections: Vec::new(),
                comparison: None,
                top_campaigns: Vec::new(),
                top_products: Vec::new(),
                top_waste_terms: Vec::new(),
                trend_summary: Vec::new(),
            },
            date_from,
            date_to,
        });
    };

    let overview = client
        .ad_analysis_overview(project_id, country, Some(date_from), Some(date_to))
        .await
        .map_err(|e| e.user_message())?;
    Ok(AdAnalysisData {
        projects,
        overview,
        date_from,
        date_to,
    })
}

impl Render for AdAnalysisView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let view = cx.entity();
        let project_name = self
            .selected_project_id
            .and_then(|id| {
                self.projects
                    .iter()
                    .find(|p| p.id == id)
                    .map(|p| p.name.clone())
            })
            .unwrap_or_else(|| "广告分析".to_string());

        v_flex()
            .id("ad-analysis")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(theme.window_bg)
            // 页面头部（P4-5：共享 PageHeader 统一结构；副标题随筛选上下文）
            .child(PageHeader::new("广告分析").subtitle(match &state {
                AdAnalysisState::Loaded(data) => format!(
                    "{} · {} · {} ~ {}",
                    project_name,
                    ad_country_label(&data.overview.country),
                    data.date_from,
                    data.date_to
                ),
                _ => "广告分析概览（指标卡 / 周期对比 / 趋势）".to_string(),
            }))
            // 筛选栏：项目 + 站点 + 刷新（四种状态下都可见；宽窗受内容上限约束）
            .child(content_guard().child(render_filter_bar(
                &view,
                &theme,
                &self.projects,
                self.selected_project_id,
                self.country,
                self.date_picker.clone(),
            )))
            // 状态区
            .child(match state {
                AdAnalysisState::Loading => content_guard()
                    .child(state_views::skeleton_loading(
                        &theme,
                        &[
                            SkeletonBlock::Kpi(4),
                            SkeletonBlock::Chart(160.0),
                            SkeletonBlock::Table(240.0),
                        ],
                    ))
                    .into_any_element(),
                AdAnalysisState::Error(msg) => state_views::error_state(
                    &cx.entity(),
                    &theme,
                    "ad-analysis-error",
                    "广告分析加载失败",
                    msg,
                    |this, cx| this.reload(cx),
                )
                .into_any_element(),
                AdAnalysisState::Empty => {
                    let needs_project = self.selected_project_id.is_none();
                    state_views::empty_state_with_action(
                        &cx.entity(),
                        &theme,
                        "ad-analysis-empty",
                        "icons/package.svg",
                        if needs_project {
                            "请先选择项目以加载广告分析数据"
                        } else {
                            "当前没有可展示的广告分析数据"
                        },
                        "刷新",
                        |this, cx| this.reload(cx),
                    )
                    .into_any_element()
                }
                AdAnalysisState::Loaded(data) => {
                    self.sync_top_tables(&data, cx);
                    let campaigns = self.top_campaigns_table.clone().expect("已同步");
                    let products = self.top_products_table.clone().expect("已同步");
                    let waste = self.top_waste_terms_table.clone().expect("已同步");
                    render_loaded(&theme, &data, campaigns, products, waste).into_any_element()
                }
            })
    }
}

/// Loaded：指标卡 + 周期对比 + 近 7 日趋势 + Top 表 + 分析/风险
fn render_loaded(
    app_theme: &AppTheme,
    data: &AdAnalysisData,
    campaigns: Entity<DataTable<AdTopCampaignRow>>,
    products: Entity<DataTable<AdTopProductRow>>,
    waste: Entity<DataTable<AdTopWasteTermRow>>,
) -> impl IntoElement {
    let overview = &data.overview;
    v_flex()
        .id("ad-analysis-loaded")
        .gap_4()
        // 指标卡（display_value 已由后端格式化；宽窗受内容上限约束）
        .child(content_guard().child(metric_cards(&overview.metrics, app_theme)))
        // 周期对比（有对比数据时）
        .when(overview.comparison.is_some(), |page| {
            page.child(content_guard().child(comparison_card(
                overview.comparison.as_ref().expect("已判 Some"),
                app_theme,
            )))
        })
        // 近 7 日趋势
        .child(content_guard().child(trend_card(&overview.trend_summary, app_theme)))
        // Top 表：高消耗活动 / 高消耗 SKU / 浪费搜索词
        // （P4-5：数据表格保留全宽，不受内容上限约束）
        .child(
            h_flex()
                .id("ad-analysis-top-grid")
                .gap_4()
                .flex_wrap()
                .child(top_campaigns_card(app_theme, campaigns))
                .child(top_products_card(app_theme, products))
                .child(top_waste_terms_card(app_theme, waste)),
        )
        // 结构化分析 + 风险提醒（卡片内容，宽窗受上限约束）
        .child(
            content_guard().child(
                h_flex()
                    .id("ad-analysis-insight-grid")
                    .gap_4()
                    .items_start()
                    .flex_wrap()
                    .child(narrative_card(&overview.narrative_sections, app_theme))
                    .child(issue_card(&overview.issue_cards, app_theme)),
            ),
        )
}

// ---------------------------------------------------------------------------
// 筛选栏（项目 / 站点 / 刷新）
// ---------------------------------------------------------------------------

/// 筛选栏：项目选择 + 站点选择（gpui-component DropdownMenu）+ 刷新按钮。
///
/// on_click 是静态闭包（`&mut App`），通过捕获 `Entity<AdAnalysisView>` 更新视图
/// （BLF-692 沉淀的「Button on_click 捕获 cx.entity()」范式，同 daily_analysis.rs）。
#[allow(clippy::too_many_arguments)]
fn render_filter_bar(
    view: &Entity<AdAnalysisView>,
    app_theme: &AppTheme,
    projects: &[ManagedProject],
    selected_project_id: Option<i64>,
    country: &'static str,
    date_picker: Option<Entity<DateRangePickerState>>,
) -> impl IntoElement {
    let projects_owned = projects.to_vec();
    let project_label: SharedString = match selected_project_id {
        Some(id) => projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| SharedString::from(p.name.clone()))
            .unwrap_or_else(|| SharedString::from("请选择项目")),
        None => SharedString::from("请选择项目"),
    };
    let view_for_project = view.clone();
    let view_for_country = view.clone();
    let view_for_refresh = view.clone();

    h_flex()
        .id("ad-analysis-filters")
        .gap_3()
        .items_center()
        .flex_wrap()
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .text_sm()
                        .text_color(app_theme.text_muted)
                        .child("项目"),
                )
                .child(
                    Button::new("ad-analysis-project-filter")
                        .outline()
                        .small()
                        .label(project_label)
                        .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                        .dropdown_menu_with_anchor(
                            gpui::Corner::BottomLeft,
                            move |menu, _window, _cx| {
                                let mut menu = menu;
                                for project in &projects_owned {
                                    let checked = selected_project_id == Some(project.id);
                                    let id = project.id;
                                    let name = project.name.clone();
                                    let view = view_for_project.clone();
                                    menu = menu.item(
                                        PopupMenuItem::new(name).checked(checked).on_click(
                                            move |_, _window, cx| {
                                                view.update(cx, |this, cx| {
                                                    this.select_project(Some(id), cx)
                                                });
                                            },
                                        ),
                                    );
                                }
                                menu
                            },
                        ),
                ),
        )
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .text_sm()
                        .text_color(app_theme.text_muted)
                        .child("站点"),
                )
                .child(
                    Button::new("ad-analysis-country-filter")
                        .outline()
                        .small()
                        .label(ad_country_label(country))
                        .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                        .dropdown_menu_with_anchor(
                            gpui::Corner::BottomLeft,
                            move |menu, _window, _cx| {
                                let mut menu = menu;
                                for (value, label) in COUNTRY_OPTIONS {
                                    let checked = country == value;
                                    let view = view_for_country.clone();
                                    menu = menu.item(
                                        PopupMenuItem::new(label).checked(checked).on_click(
                                            move |_, _window, cx| {
                                                view.update(cx, |this, cx| {
                                                    this.select_country(value, cx)
                                                });
                                            },
                                        ),
                                    );
                                }
                                menu
                            },
                        ),
                ),
        )
        // 日期区间（DateRangePicker 公共组件；变更经订阅回连 reload）
        .when(date_picker.is_some(), |this| {
            this.child(date_picker.clone().expect("已创建"))
        })
        .child(div().flex_1())
        .child(
            Button::new("ad-analysis-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_, _window, cx| {
                    let view = view_for_refresh.clone();
                    view.update(cx, |this, cx| this.reload(cx));
                }),
        )
}

// ---------------------------------------------------------------------------
// 指标卡 / 周期对比
// ---------------------------------------------------------------------------

/// 指标卡网格（flex 自动换行；display_value 来自后端，helper 为说明文字）
fn metric_cards(
    metrics: &[gui_domain::advertising::AdMetricCard],
    app_theme: &AppTheme,
) -> impl IntoElement {
    h_flex()
        .id("ad-analysis-metrics")
        .gap_3()
        .flex_wrap()
        .children(metrics.iter().map(|m| {
            let value_color = if app_theme.is_dark() {
                app_theme.text_primary
            } else {
                app_theme.accent
            };
            v_flex()
                .id(SharedString::from(format!("ad-metric-{}", m.label)))
                .flex_1()
                .min_w(px(150.))
                .gap_2()
                .p_4()
                .rounded(px(app_theme.radius_lg))
                .bg(app_theme.card_bg)
                .shadow(vec![app_theme.card_shadow_box()])
                .hover(|this| this.bg(app_theme.muted_fill))
                .child(
                    div()
                        .text_sm()
                        .text_color(app_theme.text_muted)
                        .child(m.label.clone()),
                )
                .child(
                    div()
                        .text_2xl()
                        .font_semibold()
                        .text_color(value_color)
                        .child(m.display_value.clone()),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(app_theme.text_muted)
                        .child(m.helper.clone().unwrap_or_else(|| "-".to_string())),
                )
        }))
}

/// 周期对比卡：当前 vs 上一周期，6 项变化率（比率 ×100 → %）
fn comparison_card(comparison: &AdPeriodComparison, app_theme: &AppTheme) -> impl IntoElement {
    let current = format!(
        "{} ~ {}",
        comparison.current_start.as_deref().unwrap_or("—"),
        comparison.current_end.as_deref().unwrap_or("—")
    );
    let previous = format!(
        "{} ~ {}",
        comparison.previous_start.as_deref().unwrap_or("—"),
        comparison.previous_end.as_deref().unwrap_or("—")
    );
    let items: [(&str, Option<f64>); 6] = [
        ("花费变化", comparison.spend_change_ratio),
        ("点击变化", comparison.clicks_change_ratio),
        ("销售变化", comparison.sales_change_ratio),
        ("订单变化", comparison.orders_change_ratio),
        ("CPC 变化", comparison.cpc_change_ratio),
        ("ACOS 变化", comparison.acos_change_ratio),
    ];

    v_flex()
        .id("ad-analysis-comparison")
        .w_full()
        .rounded(px(app_theme.radius_lg))
        .bg(app_theme.card_bg)
        .shadow(vec![app_theme.card_shadow_box()])
        .child(
            v_flex()
                .gap_1()
                .px_4()
                .py_3()
                .border_b_1()
                .border_color(app_theme.separator)
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(app_theme.text_primary)
                        .child("周期对比"),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(app_theme.text_muted)
                        .child(format!("当前周期 {current} 对比上一周期 {previous}")),
                ),
        )
        .child(
            v_flex()
                .gap_3()
                .px_4()
                .py_3()
                .when(comparison.summary.is_some(), |this| {
                    this.child(
                        div()
                            .text_sm()
                            .text_color(app_theme.text_secondary)
                            .child(
                                comparison
                                    .summary
                                    .clone()
                                    .unwrap_or_default(),
                            ),
                    )
                })
                .child(
                    h_flex()
                        .gap_3()
                        .flex_wrap()
                        .children(items.iter().map(|(label, ratio)| {
                            v_flex()
                                .id(SharedString::from(format!("ad-compare-{label}")))
                                .flex_1()
                                .min_w(px(140.))
                                .gap_1()
                                .p_3()
                                .rounded(px(app_theme.radius))
                                .bg(app_theme.muted_fill.opacity(0.4))
                                .child(
                                    div()
                                        .text_sm()
                                        .text_color(app_theme.text_muted)
                                        .child(*label),
                                )
                                .child(
                                    div()
                                        .text_base()
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(change_color(*ratio, app_theme))
                                        .child(ratio
                                            .map(|r| format!("{:+.2}%", r * 100.0))
                                            .unwrap_or_else(|| "—".to_string())),
                                )
                        })),
                ),
        )
}

/// 变化率颜色：正 → success，负 → danger，0 / None → 中性
fn change_color(ratio: Option<f64>, app_theme: &AppTheme) -> gpui::Hsla {
    match ratio {
        Some(r) if r > 0.0 => app_theme.success,
        Some(r) if r < 0.0 => app_theme.danger,
        _ => app_theme.text_secondary,
    }
}

// ---------------------------------------------------------------------------
// 近 7 日趋势（div 自绘列表）
// ---------------------------------------------------------------------------

fn trend_card(rows: &[AdTrendRow], app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("ad-analysis-trend")
        .w_full()
        .rounded(px(app_theme.radius_lg))
        .bg(app_theme.card_bg)
        .shadow(vec![app_theme.card_shadow_box()])
        .child(
            v_flex()
                .gap_1()
                .px_4()
                .py_3()
                .border_b_1()
                .border_color(app_theme.separator)
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(app_theme.text_primary)
                        .child("近 7 日趋势"),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(app_theme.text_muted)
                        .child("每日花费 / 点击 / CPC 与环比（图表渲染属 P3-2 范围，当前列表呈现）"),
                ),
        )
        .child(
            div()
                .id("ad-analysis-trend-scroll")
                .max_h_80()
                .overflow_y_scroll()
                .child(trend_table(rows, app_theme)),
        )
}

fn trend_table(rows: &[AdTrendRow], app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("ad-analysis-trend-rows")
        .gap_0()
        .child(trend_header(app_theme))
        .children(
            rows.iter()
                .enumerate()
                .map(|(ix, row)| trend_row(row, ix % 2 == 1, app_theme)),
        )
        .when(rows.is_empty(), |this| {
            this.child(
                div()
                    .px_4()
                    .py_8()
                    .text_center()
                    .text_sm()
                    .text_color(app_theme.text_muted)
                    .child("暂无趋势明细"),
            )
        })
}

fn trend_header(app_theme: &AppTheme) -> impl IntoElement {
    h_flex()
        .id("ad-trend-header")
        .px_4()
        .py_2()
        .gap_3()
        .border_b_1()
        .border_color(app_theme.separator)
        .text_xs()
        .font_weight(FontWeight::MEDIUM)
        .text_color(app_theme.text_muted)
        .child(div().w(px(104.)).child("日期"))
        .child(div().w(px(110.)).text_right().child("花费"))
        .child(div().w(px(76.)).text_right().child("点击"))
        .child(div().w(px(90.)).text_right().child("CPC"))
        .child(div().flex_1().text_right().child("花费环比"))
}

fn trend_row(row: &AdTrendRow, tinted: bool, app_theme: &AppTheme) -> impl IntoElement {
    let bg = if tinted {
        app_theme.muted_fill.opacity(0.5)
    } else {
        app_theme.card_bg
    };
    h_flex()
        .id(SharedString::from(format!(
            "ad-trend-row-{}",
            row.report_date.as_deref().unwrap_or("?")
        )))
        .px_4()
        .py_1p5()
        .gap_3()
        .bg(bg)
        .text_sm()
        .text_color(app_theme.text_secondary)
        .child(
            div()
                .w(px(104.))
                .text_color(app_theme.text_primary)
                .child(row.report_date.clone().unwrap_or_else(|| "—".to_string())),
        )
        .child(div().w(px(110.)).text_right().child(fmt_money_precise(row.spend)))
        .child(div().w(px(76.)).text_right().child(fmt_num_precise(row.clicks)))
        .child(div().w(px(90.)).text_right().child(format!("{:.2}", row.cpc)))
        .child(
            div()
                .flex_1()
                .text_right()
                .text_color(change_color(row.spend_change_ratio, app_theme))
                .child(
                    row.spend_change_ratio
                        .map(|r| format!("{:+.2}%", r * 100.0))
                        .unwrap_or_else(|| "—".to_string()),
                ),
        )
}

// ---------------------------------------------------------------------------
// Top 表（高消耗活动 / 高消耗 SKU / 浪费搜索词，复用公共 DataTable）
// ---------------------------------------------------------------------------

/// Top 表卡片外壳：标题 + 说明 + DataTable 实体
fn top_table_card<T: Clone + PartialEq + 'static>(
    id: &'static str,
    title: &'static str,
    subtitle: &'static str,
    app_theme: &AppTheme,
    table: Entity<DataTable<T>>,
) -> impl IntoElement {
    v_flex()
        .id(id)
        .flex_1()
        .min_w(px(300.))
        .rounded(px(app_theme.radius_lg))
        .bg(app_theme.card_bg)
        .shadow(vec![app_theme.card_shadow_box()])
        .child(
            v_flex()
                .gap_1()
                .px_4()
                .py_3()
                .border_b_1()
                .border_color(app_theme.separator)
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(app_theme.text_primary)
                        .child(title.to_string()),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(app_theme.text_muted)
                        .child(subtitle.to_string()),
                ),
        )
        .child(table)
}

/// 高消耗活动列定义（对齐旧 mini 表头：活动 / Spend / Sales / 订单 / ACOS）
fn campaign_columns() -> Vec<ColumnDef<AdTopCampaignRow>> {
    vec![
        ColumnDef::text("campaign", "活动", |r: &AdTopCampaignRow, _| {
            SharedString::from(r.campaign_name.clone().unwrap_or_else(|| "—".to_string()))
        }),
        ColumnDef::text("spend", "Spend", |r: &AdTopCampaignRow, _| {
            SharedString::from(fmt_money_precise(r.spend))
        })
        .width(88.0)
        .align(CellAlign::Right),
        ColumnDef::text("sales", "Sales", |r: &AdTopCampaignRow, _| {
            SharedString::from(fmt_money_precise(r.sales_7d))
        })
        .width(88.0)
        .align(CellAlign::Right),
        ColumnDef::text("orders", "订单", |r: &AdTopCampaignRow, _| {
            SharedString::from(fmt_num_precise(r.orders_7d))
        })
        .width(56.0)
        .align(CellAlign::Right),
        ColumnDef::text("acos", "ACOS", |r: &AdTopCampaignRow, _| {
            SharedString::from(format!("{:.2}%", r.acos * 100.0))
        })
        .width(64.0)
        .align(CellAlign::Right),
    ]
}

/// 高消耗 SKU 列定义（SKU / Spend / Sales / 订单 / ACOS）
fn product_columns() -> Vec<ColumnDef<AdTopProductRow>> {
    vec![
        ColumnDef::text("sku", "SKU", |r: &AdTopProductRow, _| {
            SharedString::from(r.ad_sku.clone().unwrap_or_else(|| "—".to_string()))
        }),
        ColumnDef::text("spend", "Spend", |r: &AdTopProductRow, _| {
            SharedString::from(fmt_money_precise(r.spend))
        })
        .width(88.0)
        .align(CellAlign::Right),
        ColumnDef::text("sales", "Sales", |r: &AdTopProductRow, _| {
            SharedString::from(fmt_money_precise(r.sales_7d))
        })
        .width(88.0)
        .align(CellAlign::Right),
        ColumnDef::text("orders", "订单", |r: &AdTopProductRow, _| {
            SharedString::from(fmt_num_precise(r.orders_7d))
        })
        .width(56.0)
        .align(CellAlign::Right),
        ColumnDef::text("acos", "ACOS", |r: &AdTopProductRow, _| {
            SharedString::from(format!("{:.2}%", r.acos * 100.0))
        })
        .width(64.0)
        .align(CellAlign::Right),
    ]
}

/// 浪费搜索词列定义（搜索词 / 活动 / 点击 / Spend / 订单）
fn waste_columns() -> Vec<ColumnDef<AdTopWasteTermRow>> {
    vec![
        ColumnDef::text("term", "搜索词", |r: &AdTopWasteTermRow, _| {
            SharedString::from(r.search_term.clone().unwrap_or_else(|| "—".to_string()))
        }),
        ColumnDef::text("campaign", "活动", |r: &AdTopWasteTermRow, _| {
            SharedString::from(r.campaign_name.clone().unwrap_or_else(|| "—".to_string()))
        })
        .width(120.0),
        ColumnDef::text("clicks", "点击", |r: &AdTopWasteTermRow, _| {
            SharedString::from(fmt_num_precise(r.clicks))
        })
        .width(56.0)
        .align(CellAlign::Right),
        ColumnDef::text("spend", "Spend", |r: &AdTopWasteTermRow, _| {
            SharedString::from(fmt_money_precise(r.spend))
        })
        .width(88.0)
        .align(CellAlign::Right),
        ColumnDef::text("orders", "订单", |r: &AdTopWasteTermRow, _| {
            SharedString::from(fmt_num_precise(r.orders_7d))
        })
        .width(56.0)
        .align(CellAlign::Right),
    ]
}

fn top_campaigns_card(
    app_theme: &AppTheme,
    table: Entity<DataTable<AdTopCampaignRow>>,
) -> impl IntoElement {
    top_table_card(
        "ad-analysis-top-campaigns",
        "高消耗活动",
        "按花费排序的 Top 广告活动",
        app_theme,
        table,
    )
}

fn top_products_card(
    app_theme: &AppTheme,
    table: Entity<DataTable<AdTopProductRow>>,
) -> impl IntoElement {
    top_table_card(
        "ad-analysis-top-products",
        "高消耗 SKU",
        "按花费排序的 Top 推广商品",
        app_theme,
        table,
    )
}

fn top_waste_terms_card(
    app_theme: &AppTheme,
    table: Entity<DataTable<AdTopWasteTermRow>>,
) -> impl IntoElement {
    top_table_card(
        "ad-analysis-top-waste-terms",
        "浪费搜索词",
        "有花费但订单贡献为 0 的搜索词",
        app_theme,
        table,
    )
}

// ---------------------------------------------------------------------------
// 结构化分析 / 风险提醒
// ---------------------------------------------------------------------------

fn narrative_card(sections: &[AdNarrativeSection], app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("ad-analysis-narrative")
        .flex_1()
        .min_w(px(300.))
        .rounded(px(app_theme.radius_lg))
        .bg(app_theme.card_bg)
        .shadow(vec![app_theme.card_shadow_box()])
        .child(
            v_flex()
                .gap_1()
                .px_4()
                .py_3()
                .border_b_1()
                .border_color(app_theme.separator)
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(app_theme.text_primary)
                        .child("结构化分析"),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(app_theme.text_muted)
                        .child("AI 基于广告数据的结构化结论"),
                ),
        )
        .child(
            v_flex()
                .gap_3()
                .px_4()
                .py_3()
                .children(sections.iter().map(|s| {
                    v_flex()
                        .id(SharedString::from(format!("ad-narrative-{}", s.title)))
                        .gap_1()
                        .p_3()
                        .rounded(px(app_theme.radius))
                        .bg(app_theme.muted_fill.opacity(0.4))
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(app_theme.text_primary)
                                .child(s.title.clone()),
                        )
                        .child(
                            div()
                                .text_sm()
                                .text_color(app_theme.text_secondary)
                                .child(s.summary.clone()),
                        )
                        .children(s.evidence.iter().map(|e| {
                            div()
                                .text_sm()
                                .text_color(app_theme.text_muted)
                                .child(format!("- {e}"))
                        }))
                        .when(s.action.is_some(), |this| {
                            this.child(
                                div()
                                    .text_sm()
                                    .text_color(app_theme.text_secondary)
                                    .child(format!(
                                        "动作：{}",
                                        s.action.clone().unwrap_or_default()
                                    )),
                            )
                        })
                }))
                .when(sections.is_empty(), |this| {
                    this.child(
                        div()
                            .px_2()
                            .py_6()
                            .text_center()
                            .text_sm()
                            .text_color(app_theme.text_muted)
                            .child("当前还没有可用的结构化分析结论"),
                    )
                }),
        )
}

fn issue_card(issues: &[AdIssueCard], app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("ad-analysis-issues")
        .flex_1()
        .min_w(px(300.))
        .rounded(px(app_theme.radius_lg))
        .bg(app_theme.card_bg)
        .shadow(vec![app_theme.card_shadow_box()])
        .child(
            v_flex()
                .gap_1()
                .px_4()
                .py_3()
                .border_b_1()
                .border_color(app_theme.separator)
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(app_theme.text_primary)
                        .child("风险提醒"),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(app_theme.text_muted)
                        .child("需要关注的广告风险信号"),
                ),
        )
        .child(
            v_flex()
                .gap_3()
                .px_4()
                .py_3()
                .children(issues.iter().map(|issue| {
                    v_flex()
                        .id(SharedString::from(format!("ad-issue-{}", issue.title)))
                        .gap_1()
                        .p_3()
                        .rounded(px(app_theme.radius))
                        .bg(app_theme.danger_soft.opacity(0.35))
                        .child(
                            h_flex()
                                .gap_2()
                                .items_center()
                                .child(
                                    Icon::new(IconName::TriangleAlert)
                                        .with_size(px(14.))
                                        .text_color(app_theme.warning),
                                )
                                .child(
                                    div()
                                        .text_sm()
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(app_theme.text_primary)
                                        .child(issue.title.clone()),
                                )
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(app_theme.text_muted)
                                        .child(issue.level.clone()),
                                ),
                        )
                        .child(
                            div()
                                .text_sm()
                                .text_color(app_theme.text_secondary)
                                .child(issue.summary.clone()),
                        )
                        .when(issue.next_step.is_some(), |this| {
                            this.child(
                                div()
                                    .text_sm()
                                    .text_color(app_theme.text_secondary)
                                    .child(format!(
                                        "下一步：{}",
                                        issue.next_step.clone().unwrap_or_default()
                                    )),
                            )
                        })
                }))
                .when(issues.is_empty(), |this| {
                    this.child(
                        div()
                            .px_2()
                            .py_6()
                            .text_center()
                            .text_sm()
                            .text_color(app_theme.text_muted)
                            .child("当前没有明显风险信号"),
                    )
                }),
        )
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

/// 测试宿主：仅渲染 AdAnalysisView（渲染冒烟用）
#[cfg(test)]
struct AdAnalysisHost {
    view: Entity<AdAnalysisView>,
}

#[cfg(test)]
impl gpui::Render for AdAnalysisHost {
    fn render(
        &mut self,
        _window: &mut gpui::Window,
        _cx: &mut gpui::Context<Self>,
    ) -> impl IntoElement {
        self.view.clone().into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gui_domain::advertising::AdMetricCard;

    // ---------- 纯函数 ----------

    #[test]
    fn ad_country_label_matches_frontend_options() {
        assert_eq!(ad_country_label("US"), "美国站 (US)");
        assert_eq!(ad_country_label("DE"), "德国站 (DE)");
        assert_eq!(ad_country_label("UK"), "英国站 (UK)");
        assert_eq!(ad_country_label("FR"), "FR");
    }

    fn sample_data() -> AdAnalysisData {
        AdAnalysisData {
            projects: vec![ManagedProject {
                id: 1,
                name: "测试项目".to_string(),
                brand_name: None,
                store_address: None,
                project_operator: None,
                assistant_operator: None,
                commission_basis: None,
                commission_rate: None,
                sort_order: 0,
                is_active: true,
                source_file: None,
                has_context: false,
                project_tier: None,
                vat_enabled: false,
            }],
            overview: AdOverviewResponse {
                project_id: 1,
                country: "US".to_string(),
                metrics: vec![AdMetricCard {
                    label: "花费".to_string(),
                    value: 122.4,
                    display_value: "$122.40".to_string(),
                    helper: Some("近 7 天".to_string()),
                }],
                issue_cards: Vec::new(),
                narrative_sections: Vec::new(),
                comparison: None,
                top_campaigns: Vec::new(),
                top_products: Vec::new(),
                top_waste_terms: Vec::new(),
                trend_summary: Vec::new(),
            },
            date_from: NaiveDate::from_ymd_opt(2026, 8, 7).unwrap(),
            date_to: NaiveDate::from_ymd_opt(2026, 8, 13).unwrap(),
        }
    }

    #[test]
    fn from_fetch_result_maps_to_loaded_empty_error() {
        let data = sample_data();
        assert_eq!(
            AdAnalysisState::from_fetch_result(Ok(data.clone())),
            AdAnalysisState::Loaded(data)
        );

        // 无指标 / 无趋势 / 无 Top → Empty
        let empty = AdAnalysisData {
            overview: AdOverviewResponse {
                metrics: Vec::new(),
                trend_summary: Vec::new(),
                top_campaigns: Vec::new(),
                top_products: Vec::new(),
                top_waste_terms: Vec::new(),
                ..sample_data().overview
            },
            ..sample_data()
        };
        assert_eq!(
            AdAnalysisState::from_fetch_result(Ok(empty)),
            AdAnalysisState::Empty
        );

        // 失败 → Error
        assert_eq!(
            AdAnalysisState::from_fetch_result(Err("接口 500".to_string())),
            AdAnalysisState::Error("接口 500".to_string())
        );
    }

    #[test]
    fn data_is_empty_judgement() {
        assert!(!sample_data().is_empty());
        // 只有 metrics 也算有数据；metrics 为空但趋势有数据也算有数据
        let trend_only = AdAnalysisData {
            overview: AdOverviewResponse {
                metrics: Vec::new(),
                trend_summary: vec![AdTrendRow {
                    report_date: Some("2026-08-13".to_string()),
                    spend: 18.0,
                    clicks: 35,
                    cpc: 0.51,
                    spend_change_ratio: Some(0.12),
                }],
                ..sample_data().overview
            },
            ..sample_data()
        };
        assert!(!trend_only.is_empty());
    }

    // ---------- 视图级状态转移（TestAppContext，无真实网络） ----------
    fn create_view(cx: &mut gpui::TestAppContext) -> Entity<AdAnalysisView> {
        cx.update(|cx| {
            let client = Client::new("http://127.0.0.1:1");
            cx.new(|cx| AdAnalysisView::new(cx, client))
        })
    }

    fn read_state(
        cx: &mut gpui::TestAppContext,
        view: &Entity<AdAnalysisView>,
    ) -> AdAnalysisState {
        cx.read(|app| view.read(app).state.read(app).clone())
    }

    #[gpui::test]
    async fn initial_state_is_loading(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        assert_eq!(read_state(cx, &view), AdAnalysisState::Loading);
    }

    #[gpui::test]
    async fn stale_request_result_is_discarded(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        let data = sample_data();

        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 2;
                this.apply_result(1, Ok(data.clone()), cx);
            });
        });
        assert_eq!(read_state(cx, &view), AdAnalysisState::Loading);

        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.apply_result(2, Ok(data.clone()), cx);
            });
        });
        assert_eq!(read_state(cx, &view), AdAnalysisState::Loaded(data));
    }

    #[gpui::test]
    async fn apply_result_error_and_empty_transitions(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);

        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Err("接口 500".to_string()), cx);
            });
        });
        assert_eq!(
            read_state(cx, &view),
            AdAnalysisState::Error("接口 500".to_string())
        );

        // 空载荷 → Empty（记录 projects 列表，供筛选菜单使用）
        let empty = AdAnalysisData {
            overview: AdOverviewResponse {
                metrics: Vec::new(),
                trend_summary: Vec::new(),
                top_campaigns: Vec::new(),
                top_products: Vec::new(),
                top_waste_terms: Vec::new(),
                ..sample_data().overview
            },
            ..sample_data()
        };
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 2;
                this.apply_result(2, Ok(empty), cx);
            });
        });
        assert_eq!(read_state(cx, &view), AdAnalysisState::Empty);
        cx.read(|app| {
            assert_eq!(view.read(app).projects.len(), 1);
        });
    }

    /// 渲染冒烟：Loading 态 + 筛选栏可完整渲染不 panic。
    #[gpui::test]
    async fn ad_analysis_loading_state_renders(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let view = create_view(cx);
        let (_host, _cx2) =
            cx.add_window_view(|_window, _cx| AdAnalysisHost { view: view.clone() });
    }

    /// 渲染冒烟：Loaded 态（含指标卡 / 对比 / 趋势 / Top 表 / 分析卡）可渲染不 panic。
    #[gpui::test]
    async fn ad_analysis_loaded_state_renders(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let view = create_view(cx);
        let data = sample_data();
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Ok(data), cx);
            });
        });
        let (_host, _cx2) =
            cx.add_window_view(|_window, _cx| AdAnalysisHost { view: view.clone() });
    }

    /// 渲染冒烟：Error 态可渲染不 panic。
    #[gpui::test]
    async fn ad_analysis_error_state_renders(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Err("接口 500".to_string()), cx);
            });
        });
        let (_host, _cx2) =
            cx.add_window_view(|_window, _cx| AdAnalysisHost { view: view.clone() });
    }

    /// P4-6（BLF-761）三态统一冒烟：Empty 态可渲染不 panic。
    #[gpui::test]
    async fn ad_analysis_empty_state_renders(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let view = create_view(cx);
        // 直接注入 Empty 态（不走网络；渲染冒烟目标 = 统一空态卡片不 panic）
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                let state = this.state.clone();
                state.update(cx, |s, _| *s = AdAnalysisState::Empty);
                cx.notify();
            });
        });
        let (_host, _cx2) =
            cx.add_window_view(|_window, _cx| AdAnalysisHost { view: view.clone() });
    }
}
