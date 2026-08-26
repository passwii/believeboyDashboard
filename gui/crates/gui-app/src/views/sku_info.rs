//! 运营 → SKU 信息视图（BLF-798，Stage7 Pattern A 第二原型页）
//!
//! frontend `app/dashboard/operations/sku-info/page.tsx` 的 GPUI 等价：
//! **Pattern A「控制台工具栏 + 超密度数据网格」套版**——顶部 FilterToolbar
//! （启用状态下拉 + SKU 关键词搜索[回车提交，服务端过滤] + 刷新），中部
//! 虚拟化大表（[`DataGrid`]：粘性表头 28px / 行高 26px / 列宽拖拽 / 横向
//! 滚动 / 斑马纹；成本与规格列全部 mono+tabular），底部 pinned 分页聚合条
//! （SKU 总数 / 启用 / 停用，语义色 token 输出）。
//!
//! 数据源：gui-api-client `sku_info`（`GET /api/v1/sku-info` 全可选参数）；
//! **服务端分页**（include_total 精确总数驱动分页器），项目 / 站点维度由
//! Stage4 Console Bar 唯一权威承载（BLF-795）。
//!
//! 已知差异（有意保留）：web 页的导入 CSV / 同步头程 / 工厂信息编辑等写操作
//! 属后续迁移批次（本页只读，对齐 Pattern A 原型验收范围）。

use gpui::{
    div, prelude::*, px, App, AsyncApp, Context, Entity, SharedString, WeakEntity, Window,
};
use gpui_component::{
    button::Button,
    h_flex,
    input::{InputEvent, InputState},
    menu::{DropdownMenu, PopupMenuItem},
    v_flex, Icon, IconName, Sizable,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::operations::shop_calculation::SkuRecordItem;

use crate::theme::{AppTheme, FONT_BASE};
use crate::widgets::data_grid::{
    grid_footer_bar, pattern_a_shell, tone_text, AggregateItem, AggregateTone, DataGrid,
};
use crate::widgets::data_table::ColumnDef;
use crate::widgets::date_range::DateRange;
use crate::widgets::filter_bar::{toolbar_search_input, toolbar_spacer};
use crate::widgets::page_header::PageHeader;
use crate::widgets::pagination::PageState;
use crate::widgets::state_views::{self, SkeletonBlock};
use crate::widgets::top_projects::fmt_num_precise;

/// 本页在侧栏中的 URL（root.rs 据此路由；与 gui-domain::sidebar 的 SKU 信息条目一致）
pub const SKU_INFO_URL: &str = "/dashboard/operations/sku-info";

/// 每页行数选项（服务端分页档位）
const PAGE_SIZE_OPTIONS: [usize; 4] = [50, 100, 200, 500];

/// 默认每页行数
const DEFAULT_PAGE_SIZE: usize = 100;

// ---------------------------------------------------------------------------
// 工具栏筛选模型
// ---------------------------------------------------------------------------

/// 启用状态筛选（状态下拉；映射 backend `is_active` 参数）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ActiveFilter {
    /// 全部（不下发 is_active）
    #[default]
    All,
    /// 仅启用（is_active=true）
    OnlyActive,
    /// 仅停用（is_active=false）
    OnlyInactive,
}

impl ActiveFilter {
    pub const OPTIONS: [(&'static str, ActiveFilter); 3] = [
        ("全部", ActiveFilter::All),
        ("仅启用", ActiveFilter::OnlyActive),
        ("仅停用", ActiveFilter::OnlyInactive),
    ];

    /// backend `is_active` 参数取值（All → None 不下发）
    pub fn param(self) -> Option<bool> {
        match self {
            Self::All => None,
            Self::OnlyActive => Some(true),
            Self::OnlyInactive => Some(false),
        }
    }

    fn label(self) -> &'static str {
        Self::OPTIONS
            .iter()
            .find(|(_, f)| *f == self)
            .map(|(label, _)| *label)
            .unwrap_or("全部")
    }
}

// ---------------------------------------------------------------------------
// 数据载荷与状态机
// ---------------------------------------------------------------------------

/// SKU 信息载荷（Loaded 持有）
#[derive(Debug, Clone, PartialEq)]
pub struct SkuInfoData {
    /// 项目列表（id → name 映射，供 Console Bar project_id 转项目名入参）
    pub projects: Vec<ManagedProject>,
    /// 当前页行（服务端分页返回）
    pub items: Vec<SkuRecordItem>,
    /// 服务端总数（include_total=true；None = 后端未给，退化为当前页行数）
    pub total: Option<i64>,
}

impl SkuInfoData {
    /// 空态判定：无可见项目或当前页无行
    pub fn is_empty(&self) -> bool {
        self.projects.is_empty() || self.items.is_empty()
    }
}

/// SKU 信息状态机（四态，对齐 daily_analysis.rs）
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum SkuInfoState {
    Loading,
    Loaded(SkuInfoData),
    Empty,
    Error(String),
}

impl SkuInfoState {
    /// 拉取结果 → 落点状态
    pub fn from_fetch_result(result: Result<SkuInfoData, String>) -> Self {
        match result {
            Ok(data) if data.is_empty() => Self::Empty,
            Ok(data) => Self::Loaded(data),
            Err(msg) => Self::Error(msg),
        }
    }
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// SKU 信息视图（Pattern A 骨架：FilterToolbar + 虚拟化大表 + pinned 底条；
/// 服务端分页 + 服务端关键词过滤）
pub struct SkuInfoView {
    state: Entity<SkuInfoState>,
    client: Client,
    /// 项目列表（首次 reload 拉取；Console Bar project_id → 项目名映射源）
    projects: Vec<ManagedProject>,
    /// 当前选中项目 id（Console Bar 驱动）；None = 全部可管理项目
    selected_project_id: Option<i64>,
    /// 当前站点码（"US"/"DE"/"UK"/"ALL"）；ALL → None 不下发 country
    country: &'static str,
    date_range: DateRange,
    latest_request_id: u64,

    // ---- 工具栏状态 ----
    active_filter: ActiveFilter,
    /// 已提交的服务端关键词（回车提交；清空即重置）
    keyword: String,
    search_input: Option<Entity<InputState>>,
    search_sub: Option<gpui::Subscription>,

    // ---- 网格与底条 ----
    grid: Entity<DataGrid<SkuRecordItem>>,
    page: usize,
    page_size: usize,
    page_state: PageState,
    aggregates: Vec<AggregateItem>,
}

impl SkuInfoView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| SkuInfoState::Loading);
        let grid = cx.new(|_| DataGrid::new("sku-info-grid", sku_columns()).striped(true));
        let today = chrono::Local::now().date_naive();
        Self {
            state,
            client,
            projects: Vec::new(),
            selected_project_id: None,
            country: "US",
            date_range: DateRange::new(Some(today), Some(today)),
            latest_request_id: 0,
            active_filter: ActiveFilter::default(),
            keyword: String::new(),
            search_input: None,
            search_sub: None,
            grid,
            page: 1,
            page_size: DEFAULT_PAGE_SIZE,
            page_state: PageState::new(1, DEFAULT_PAGE_SIZE, 0),
            aggregates: Vec::new(),
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)] // 视图级测试消费
    pub fn current_state(&self, cx: &App) -> SkuInfoState {
        self.state.read(cx).clone()
    }

    /// 当前筛选三元组（项目/站点/日期，只读；根视图回归测试断言用）。
    /// 本页无日期维度，date 为占位区间。
    #[allow(dead_code)] // 根视图级测试消费
    pub fn console_filter_state(&self) -> (Option<i64>, &'static str, DateRange) {
        (self.selected_project_id, self.country, self.date_range)
    }

    /// 拉取数据：项目列表（懒加载一次）→ 解析项目名 → 服务端分页查询。
    /// 项目/站点切换、关键词提交、状态筛选、翻页、错误重试共用入口。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;

        self.state.update(cx, |state, cx| {
            *state = SkuInfoState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let need_projects = self.projects.is_empty();
        let project_name = self.project_name().map(str::to_string);
        let keyword = (!self.keyword.is_empty()).then(|| self.keyword.clone());
        let country_param = (self.country != "ALL").then(|| self.country.to_string());
        let is_active = self.active_filter.param();
        let (page, page_size) = (self.page, self.page_size);

        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(load_sku_info(
                        &client,
                        need_projects,
                        project_name.as_deref(),
                        keyword.as_deref(),
                        country_param.as_deref(),
                        is_active,
                        page,
                        page_size,
                    ))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 项目名解析（选中 id → 项目名；None = 全部项目不限定）
    fn project_name(&self) -> Option<&str> {
        let id = self.selected_project_id?;
        self.projects.iter().find(|p| p.id == id).map(|p| p.name.as_str())
    }

    /// BLF-795：Console Bar 筛选一键应用（项目 / 站点；本页无日期维度，
    /// 区间参数仅记录）。变化才 reload，同值回放 no-op。
    pub fn apply_console_filter(
        &mut self,
        project_id: Option<i64>,
        country: &'static str,
        range: DateRange,
        cx: &mut Context<Self>,
    ) -> bool {
        let project_changed = project_id != self.selected_project_id;
        let country_changed = country != self.country;
        if !project_changed && !country_changed && range == self.date_range {
            return false;
        }
        if project_changed {
            self.selected_project_id = project_id;
        }
        if country_changed {
            self.country = country;
        }
        self.date_range = range;
        self.page = 1;
        self.reload(cx);
        true
    }

    // ---- 工具栏动作 ----

    /// 启用状态筛选变更 → 回第 1 页 refetch
    pub fn set_active_filter(&mut self, filter: ActiveFilter, cx: &mut Context<Self>) {
        if filter == self.active_filter {
            return;
        }
        self.active_filter = filter;
        self.page = 1;
        self.reload(cx);
    }

    /// 关键词提交（回车 / 清空）→ 回第 1 页 refetch（服务端过滤）
    pub fn commit_keyword(&mut self, keyword: String, cx: &mut Context<Self>) {
        let trimmed = keyword.trim().to_string();
        if trimmed == self.keyword {
            return;
        }
        self.keyword = trimmed;
        self.page = 1;
        self.reload(cx);
    }

    /// 翻页 → refetch（服务端分页）
    pub fn set_page(&mut self, page: usize, cx: &mut Context<Self>) {
        let target = page.max(1);
        if target == self.page {
            return;
        }
        self.page = target;
        self.reload(cx);
    }

    /// 改每页行数 → 回第 1 页 refetch
    pub fn set_page_size(&mut self, size: usize, cx: &mut Context<Self>) {
        let size = size.max(1);
        if size == self.page_size {
            return;
        }
        self.page_size = size;
        self.page = 1;
        self.reload(cx);
    }

    /// 应用拉取结果：竞态保护（过期响应丢弃）+ 项目列表合并 + 刷新网格与聚合
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<(Vec<ManagedProject>, SkuRecordsPageLike), String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        let data = result.map(|(mut new_projects, page)| {
            if !new_projects.is_empty() {
                self.projects = std::mem::take(&mut new_projects);
            }
            SkuInfoData {
                projects: self.projects.clone(),
                items: page.items,
                total: page.total,
            }
        });
        if let Ok(loaded) = &data {
            // 空数据也保留项目列表（菜单复用）；仅落点 Empty 态
            if loaded.projects.len() > self.projects.len() {
                self.projects = loaded.projects.clone();
            }
        }
        self.state.update(cx, |state, cx| {
            *state = SkuInfoState::from_fetch_result(data);
            cx.notify();
        });
        self.refresh_grid(cx);
    }

    /// 中枢刷新：把 Loaded 当前页行注入网格并重算聚合条目
    fn refresh_grid(&mut self, cx: &mut Context<Self>) {
        let SkuInfoState::Loaded(data) = self.state.read(cx).clone() else {
            self.aggregates.clear();
            self.page_state = PageState::new(1, self.page_size, 0);
            cx.notify();
            return;
        };
        let total = data
            .total
            .map(|t| t as usize)
            .unwrap_or(data.items.len());
        self.page_state = PageState::new(self.page, self.page_size, total);
        let rows = data.items.clone();
        self.grid.update(cx, |g, cx| g.set_rows(rows, cx));
        self.aggregates = sku_aggregates(&data);
        cx.notify();
    }
}

// ---------------------------------------------------------------------------
// 渲染（Pattern A 骨架）
// ---------------------------------------------------------------------------

impl Render for SkuInfoView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();

        // 搜索输入框懒建（首帧；InputState::new 需要 window）。
        // 回车提交（服务端过滤，避免逐键请求）；清空按钮触发 Change→空值提交。
        if self.search_input.is_none() {
            let input =
                cx.new(|cx| InputState::new(window, cx).placeholder("SKU 关键词，回车搜索…"));
            self.search_sub =
                Some(cx.subscribe(&input, |this, _e, event: &InputEvent, cx| match event {
                    InputEvent::PressEnter { .. } => {
                        let value = this
                            .search_input
                            .as_ref()
                            .map(|input| input.read(cx).value().to_string())
                            .unwrap_or_default();
                        this.commit_keyword(value, cx);
                    }
                    InputEvent::Change => {
                        // cleanable 清空时 value 变空 → 提交重置；非空输入不打断输入法
                        let value = this
                            .search_input
                            .as_ref()
                            .map(|input| input.read(cx).value().to_string())
                            .unwrap_or_default();
                        if value.trim().is_empty() && !this.keyword.is_empty() {
                            this.commit_keyword(value, cx);
                        }
                    }
                    _ => {}
                }));
            self.search_input = Some(input);
        }

        match state {
            SkuInfoState::Loading => render_loading(&app_theme).into_any_element(),
            SkuInfoState::Error(msg) => render_error(cx, &app_theme, &msg).into_any_element(),
            SkuInfoState::Empty => render_empty(cx, &app_theme).into_any_element(),
            SkuInfoState::Loaded(_) => {
                self.render_loaded(&app_theme, cx).into_any_element()
            }
        }
    }
}

impl SkuInfoView {
    /// Loaded：Pattern A 骨架——FilterToolbar 行 + 虚拟化大表 + pinned 底条
    fn render_loaded(&mut self, app_theme: &AppTheme, cx: &mut Context<Self>) -> impl IntoElement {
        let view = cx.entity();
        let reduce = crate::motion::reduce_motion(cx);

        // 工具栏内容：状态下拉 + 搜索输入 + 弹性位 + 刷新
        let active_filter = self.active_filter;
        let toolbar = h_flex()
            .gap_2()
            .items_center()
            .child(active_filter_menu(&view.clone(), active_filter))
            .child(toolbar_search_input(
                app_theme,
                self.search_input.as_ref().expect("搜索框已懒建"),
                "sku-info-search",
                200.0,
            ))
            .child(toolbar_spacer())
            .child(
                Button::new("sku-info-refresh")
                    .outline()
                    .small()
                    .label("刷新")
                    .on_click({
                        let view = view.clone();
                        move |_, _window, cx| {
                            view.update(cx, |this, cx| this.reload(cx));
                        }
                    }),
            );

        // 页面头部（全仓库业务视图一致性契约；副标题 = 项目/站点/总数口径）
        let (project_label, total) = match self.state.read(cx).clone() {
            SkuInfoState::Loaded(data) => (
                self.project_name()
                    .map(str::to_string)
                    .unwrap_or_else(|| "全部项目".to_string()),
                data.total,
            ),
            _ => unreachable!("render_loaded 仅在 Loaded 态进入"),
        };
        let country_label = if self.country == "ALL" {
            "全部站点".to_string()
        } else {
            crate::widgets::console_bar::console_country_label(self.country)
        };
        let header = PageHeader::new("SKU 信息").subtitle(format!(
            "{} · {} · 共 {} 个 SKU",
            project_label,
            country_label,
            total.map(|t| t.to_string())
                .unwrap_or_else(|| "—".to_string())
        ));

        // pinned 底部聚合分页条（聚合数字 mono；分页器走服务端分页）
        let aggregates = self.aggregates.clone();
        let page_state = self.page_state;
        let footer = grid_footer_bar(
            &view,
            app_theme,
            "sku-info",
            &aggregates,
            &page_state,
            &PAGE_SIZE_OPTIONS,
            |this, page, cx| this.set_page(page, cx),
            |this, size, cx| this.set_page_size(size, cx),
        );

        crate::motion::enter_fade_in(
            gpui::SharedString::from("sku-info-loaded-fade"),
            pattern_a_shell(
                app_theme,
                "sku-info",
                header,
                toolbar,
                self.grid.clone(),
                footer,
            ),
            reduce,
        )
    }
}

/// 启用状态筛选下拉
fn active_filter_menu(view: &Entity<SkuInfoView>, current: ActiveFilter) -> impl IntoElement {
    let view = view.clone();
    Button::new("sku-info-active-filter")
        .outline()
        .small()
        .label(SharedString::from(format!("状态：{}", current.label())))
        .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
        .dropdown_menu_with_anchor(gpui::Corner::BottomLeft, move |menu, _window, _cx| {
            let mut menu = menu;
            for (label, filter) in ActiveFilter::OPTIONS {
                let checked = current == filter;
                let view = view.clone();
                menu = menu.item(
                    PopupMenuItem::new(label)
                        .checked(checked)
                        .on_click(move |_, _window, cx| {
                            view.update(cx, |this, cx| this.set_active_filter(filter, cx));
                        }),
                );
            }
            menu
        })
}

// ---------------------------------------------------------------------------
// 四态渲染（Loading / Error / Empty 复用公共 state_views）
// ---------------------------------------------------------------------------

/// Loading：声明式骨架块（筛选行 / 明细表）
fn render_loading(app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("sku-info-loading")
        .size_full()
        .bg(app_theme.window_bg)
        .child(state_views::skeleton_loading(
            app_theme,
            &[SkeletonBlock::Title, SkeletonBlock::Filter(2)],
        ))
        .child(state_views::skeleton_loading(app_theme, &[SkeletonBlock::Table(300.0)]))
}

/// Error：卡片内 Alert + 重试按钮（公共组件 `state_views::error_state`）
fn render_error(cx: &mut Context<SkuInfoView>, app_theme: &AppTheme, msg: &str) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("sku-info-error")
        .size_full()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::error_state(
            &view,
            app_theme,
            "sku-info-error",
            "SKU 信息加载失败",
            msg.to_string(),
            |this, cx| this.reload(cx),
        ))
}

/// Empty：Icon + 文案 + 刷新按钮（公共组件 `empty_state_with_action`）
fn render_empty(cx: &mut Context<SkuInfoView>, app_theme: &AppTheme) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("sku-info-empty")
        .size_full()
        .items_center()
        .justify_center()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::empty_state_with_action(
            &view,
            app_theme,
            "sku-info-empty",
            "icons/package.svg",
            "暂无 SKU 数据",
            "刷新",
            |this, cx| this.reload(cx),
        ))
}

// ---------------------------------------------------------------------------
// 聚合条目与列定义
// ---------------------------------------------------------------------------

/// 底部聚合条目：SKU 总数（服务端精确总数）/ 本页行数 / 启用（正向绿）/
/// 停用（危险红）——语义色 token 输出，数字一律 mono 渲染于底条。
pub fn sku_aggregates(data: &SkuInfoData) -> Vec<AggregateItem> {
    let active_count = data.items.iter().filter(|r| r.is_active).count();
    let inactive_count = data.items.len() - active_count;
    let total_label = data
        .total
        .map(fmt_num_precise)
        .unwrap_or_else(|| data.items.len().to_string());
    vec![
        AggregateItem::new("SKU 总数", SharedString::from(total_label)),
        AggregateItem::new("本页", fmt_num_precise(data.items.len() as i64)),
        AggregateItem::new("启用", fmt_num_precise(active_count as i64))
            .tone(AggregateTone::Positive),
        AggregateItem::new("停用", fmt_num_precise(inactive_count as i64))
            .tone(AggregateTone::Danger),
    ]
}

/// 网格列定义：档案主键文本列 + 成本/规格数值列（number 构造器 →
/// JetBrains Mono + tnum 右对齐可排序）+ 启用状态语义色列
fn sku_columns() -> Vec<ColumnDef<SkuRecordItem>> {
    vec![
        ColumnDef::text("sku", "SKU", |_r: &SkuRecordItem, _| SharedString::from(""))
            .with_render_element(|r: &SkuRecordItem, theme| key_cell(&r.sku, theme))
            .width(150.0),
        ColumnDef::text("asin", "ASIN", |r: &SkuRecordItem, _| {
            SharedString::from(r.asin.clone())
        })
        .width(110.0)
        .numeric(true),
        ColumnDef::text("project", "项目", |r: &SkuRecordItem, _| {
            SharedString::from(r.project_name.clone())
        })
        .width(140.0),
        ColumnDef::text("country", "站点", |r: &SkuRecordItem, _| {
            SharedString::from(r.country.clone())
        })
        .width(56.0),
        ColumnDef::text("currency", "币种", |r: &SkuRecordItem, _| {
            SharedString::from(r.currency.clone())
        })
        .width(52.0),
        ColumnDef::number("fob_cost", "FOB 成本", |r: &SkuRecordItem| r.fob_unit_cost, |r: &_ , _| {
            SharedString::from(format!("{:.2}", r.fob_unit_cost))
        })
        .width(96.0),
        ColumnDef::number(
            "first_leg",
            "头程运费 ¥",
            |r: &SkuRecordItem| r.first_leg_cost_rmb,
            |r: &_, _| SharedString::from(format!("{:.2}", r.first_leg_cost_rmb)),
        )
        .width(100.0),
        ColumnDef::number("pkg_l", "包长 cm", |r: &SkuRecordItem| r.package_length_cm, |r: &_, _| {
            SharedString::from(format!("{:.1}", r.package_length_cm))
        })
        .width(80.0),
        ColumnDef::number("pkg_w", "包宽 cm", |r: &SkuRecordItem| r.package_width_cm, |r: &_, _| {
            SharedString::from(format!("{:.1}", r.package_width_cm))
        })
        .width(80.0),
        ColumnDef::number("pkg_h", "包高 cm", |r: &SkuRecordItem| r.package_height_cm, |r: &_, _| {
            SharedString::from(format!("{:.1}", r.package_height_cm))
        })
        .width(80.0),
        ColumnDef::number("weight", "重量 kg", |r: &SkuRecordItem| r.weight_kg, |r: &_, _| {
            SharedString::from(format!("{:.2}", r.weight_kg))
        })
        .width(84.0),
        ColumnDef::number("per_carton", "装箱量", |r: &SkuRecordItem| r.units_per_carton as f64, |r: &_, _| {
            if r.units_per_carton > 0 {
                SharedString::from(r.units_per_carton.to_string())
            } else {
                SharedString::from("—")
            }
        })
        .width(72.0),
        ColumnDef::text("active", "状态", |_r: &SkuRecordItem, _| SharedString::from(""))
            .with_render_element(|r: &SkuRecordItem, theme| {
                if r.is_active {
                    tone_text("启用", AggregateTone::Positive, theme)
                } else {
                    tone_text("停用", AggregateTone::Danger, theme)
                }
            })
            .width(64.0),
    ]
}

/// 主键文本单元格（primary 色 + 截断）
fn key_cell(text: &str, theme: &AppTheme) -> gpui::AnyElement {
    div()
        .truncate().text_size(px(crate::theme::fs(FONT_BASE)))
        .text_color(theme.text_primary)
        .child(SharedString::from(text.to_string()))
        .into_any_element()
}

// ---------------------------------------------------------------------------
// 数据管线（与视图解耦便于测试）
// ---------------------------------------------------------------------------

/// 服务端分页响应的视图侧投影（items + total；隔离 domain 类型细节便于测试）
#[derive(Debug, Clone, PartialEq)]
pub struct SkuRecordsPageLike {
    pub items: Vec<SkuRecordItem>,
    pub total: Option<i64>,
}

/// 拉取 SKU 信息：需要时先拉项目列表（供 Console Bar 项目名解析），
/// 再按「项目名 × 关键词 × 站点 × 启用态 × 分页」查询。项目列表拉取失败
/// 不阻塞主查询（仅影响后续按项目过滤的入参精度）。
#[allow(clippy::too_many_arguments)] // 查询参数一一对应 backend Query 字段（与 api-client 同口径）
async fn load_sku_info(
    client: &Client,
    need_projects: bool,
    project_name: Option<&str>,
    keyword: Option<&str>,
    country: Option<&str>,
    is_active: Option<bool>,
    page: usize,
    page_size: usize,
) -> Result<(Vec<ManagedProject>, SkuRecordsPageLike), String> {
    let mut projects = Vec::new();
    if need_projects {
        projects = client
            .list_managed_projects()
            .await
            .map_err(|e| e.user_message())?;
    }
    let resp = client
        .list_sku_records_filtered(
            project_name,
            keyword,
            country,
            is_active,
            page,
            page_size,
            true,
        )
        .await
        .map_err(|e| e.user_message())?;
    Ok((
        projects,
        SkuRecordsPageLike {
            items: resp.items,
            total: resp.total,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_project() -> ManagedProject {
        ManagedProject {
            id: 3,
            name: "测试项目 A".to_string(),
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
        }
    }

    fn item(sku: &str, is_active: bool) -> SkuRecordItem {
        SkuRecordItem {
            id: 1,
            project_name: "测试项目".into(),
            sku: sku.into(),
            asin: "B0TEST01".into(),
            fob_unit_cost: 45.0,
            first_leg_cost_rmb: 8.5,
            package_length_cm: 30.0,
            package_width_cm: 20.0,
            package_height_cm: 10.0,
            weight_kg: 1.2,
            currency: "USD".into(),
            country: "US".into(),
            sort_order: 0,
            units_per_carton: 24,
            is_active,
        }
    }

    // ---------- 纯函数 ----------

    #[test]
    fn active_filter_param_mapping() {
        assert_eq!(ActiveFilter::All.param(), None);
        assert_eq!(ActiveFilter::OnlyActive.param(), Some(true));
        assert_eq!(ActiveFilter::OnlyInactive.param(), Some(false));
        assert_eq!(ActiveFilter::OnlyInactive.label(), "仅停用");
    }

    #[test]
    fn aggregates_use_semantic_tones_and_server_total() {
        let data = SkuInfoData {
            projects: Vec::new(),
            items: vec![item("A", true), item("B", true), item("C", false)],
            total: Some(101),
        };
        let items = sku_aggregates(&data);
        assert_eq!(items.len(), 4);
        assert_eq!(items[0].value, "101", "SKU 总数必须取服务端精确总数");
        assert_eq!(items[1].value, "3");
        assert_eq!(items[2].value, "2");
        assert_eq!(items[2].tone, AggregateTone::Positive, "启用走正向 token");
        assert_eq!(items[3].value, "1");
        assert_eq!(items[3].tone, AggregateTone::Danger, "停用走危险 token");
    }

    #[test]
    fn state_machine_maps_loaded_empty_error() {
        let ok = Ok(SkuInfoData {
            projects: vec![sample_project()],
            items: vec![item("A", true)],
            total: None,
        });
        assert!(matches!(
            SkuInfoState::from_fetch_result(ok),
            SkuInfoState::Loaded(_)
        ));
        assert!(matches!(
            SkuInfoState::from_fetch_result(Ok(SkuInfoData {
                projects: vec![],
                items: vec![],
                total: None,
            })),
            SkuInfoState::Empty
        ));
        assert_eq!(
            SkuInfoState::from_fetch_result(Err("接口 500".into())),
            SkuInfoState::Error("接口 500".into())
        );
    }

    // ---------- 视图级状态转移 / 竞态保护 ----------

    fn create_view(cx: &mut gpui::TestAppContext) -> Entity<SkuInfoView> {
        cx.update(|cx| {
            gpui_component::init(cx);
            let client = Client::new("http://127.0.0.1:1");
            cx.new(|cx| SkuInfoView::new(cx, client))
        })
    }

    fn read_state(cx: &mut gpui::TestAppContext, view: &Entity<SkuInfoView>) -> SkuInfoState {
        cx.read(|app| view.read(app).state.read(app).clone())
    }

    #[gpui::test]
    async fn initial_state_is_loading(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        assert_eq!(read_state(cx, &view), SkuInfoState::Loading);
    }

    #[gpui::test]
    async fn stale_request_result_is_discarded(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        let data = (
            vec![sample_project()],
            SkuRecordsPageLike {
                items: vec![item("A", true)],
                total: Some(1),
            },
        );
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 2;
                this.apply_result(1, Ok(data.clone()), cx);
            });
        });
        assert_eq!(read_state(cx, &view), SkuInfoState::Loading);

        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.apply_result(2, Ok(data), cx);
            });
        });
        cx.read(|app| {
            assert!(matches!(
                view.read(app).state.read(app),
                SkuInfoState::Loaded(_)
            ));
            assert_eq!(
                view.read(app).grid.read(app).rows().len(),
                1,
                "网格应收到当前页切片"
            );
        });
    }

    /// BLF-798 刷新链：聚合条目随数据落点生成（语义色调齐备）
    #[gpui::test]
    async fn apply_result_feeds_grid_and_aggregates(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        let data = (
            vec![sample_project()],
            SkuRecordsPageLike {
                items: vec![item("A", true), item("B", false)],
                total: Some(50),
            },
        );
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Ok(data), cx);
            });
        });
        cx.read(|app| {
            let v = view.read(app);
            assert_eq!(v.grid.read(app).rows().len(), 2);
            assert_eq!(v.aggregates.len(), 4);
            assert_eq!(v.page_state.total, 50);
        });

        // 失败结果不触碰网格
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.apply_result(2, Err("接口 500".to_string()), cx);
            });
        });
        cx.read(|app| {
            assert_eq!(view.read(app).grid.read(app).rows().len(), 2);
        });
    }

    // ---------- 渲染冒烟（亮 / 暗两态 + 三态外壳） ----------

    /// 测试宿主：仅渲染 SkuInfoView（渲染冒烟用）
    struct SkuInfoHost {
        view: Entity<SkuInfoView>,
    }

    impl gpui::Render for SkuInfoHost {
        fn render(
            &mut self,
            _window: &mut gpui::Window,
            _cx: &mut gpui::Context<Self>,
        ) -> impl IntoElement {
            self.view.clone().into_any_element()
        }
    }

    #[gpui::test]
    async fn sku_info_renders_in_both_modes(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        cx.update(|cx| {
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let view = create_view(cx);
        let data = (
            vec![sample_project()],
            SkuRecordsPageLike {
                items: vec![item("BB-US-001", true)],
                total: Some(1),
            },
        );
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Ok(data), cx);
            });
        });
        // 首帧完整渲染路径：工具栏（含懒建 InputState）+ 虚拟化大表 + pinned 底条
        let (_host, cx2) =
            cx.add_window_view(|_window, _cx| SkuInfoHost { view: view.clone() });
        cx2.read(|app| assert!(!crate::theme::AppTheme::current(app).is_dark()));

        cx2.update(|_window, app| {
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, app);
        });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    #[gpui::test]
    async fn sku_info_error_empty_loading_render(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        let (_host, _cx2) =
            cx.add_window_view(|_window, _cx| SkuInfoHost { view: view.clone() });

        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Err("接口超时".to_string()), cx);
            });
        });
        assert!(matches!(read_state(cx, &view), SkuInfoState::Error(_)));
    }
}
