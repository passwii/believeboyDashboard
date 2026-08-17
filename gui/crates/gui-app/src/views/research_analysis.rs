//! 运营 → 调研分析视图（P5-3，BLF-724）
//!
//! frontend `app/dashboard/operations/research-analysis/page.tsx`（约 4398 行）
//! 的 GPUI 等价：站点 × 品类关键词 × 数据集版本筛选 + 6 KPI 卡 + 市场趋势图
//! + 决策卡（市场增长 / 季节性 / 新品机会 / 数据质量）+ 风险卡（品牌/卖家/中国卖家）
//! + 价格区间柱图 + 价格统计 + 品牌份额柱图 + 产品明细分页表。
//!
//! 架构（复用 Phase 3/4/5 基建）：
//! - **四态状态机**：`Loading / Loaded / Empty / Error`（数据集 + 总览合并主态）；
//!   `latest_request_id` / `latest_products_request_id` 双竞态保护；产品明细
//!   翻页有独立竞态；
//! - **数据管线**：
//!   1. `list_managed_projects`（辅助元数据，未直接展示——仅占位未来支持）；
//!   2. `category_research_datasets`（`include_history=true`）→ 派生「关键词」
//!      去重下拉 + 「数据集版本」下拉；
//!   3. 用户选关键词 → 自动选「最新」版本 → `category_research_overview` +
//!      `category_research_market_trend` 并行；
//!   4. 用户切版本 / 站点 → 重拉 3+4；
//!   5. 产品明细 tab 激活时拉首屏 `category_research_products`（`page_size=100`，
//!      分页 `DataTable` + 内置 `pagination_bar`）；
//! - **决策卡 / 风险卡**：对齐 frontend `buildOverviewChartModels` 的「市场增长等级」
//!   /「季节性等级」/「新品机会等级」/「数据质量」/「品牌垄断」/「卖家垄断」/「中国
//!   卖家竞争」字段，中文等级文案（`growthTierText` / `seasonalityTierText` 等）
//!   与 frontend 一致；
//! - **品牌份额 / 价格区间柱图**：P5-0 `chart_primitives::bar_series_chart` 复用；
//! - **市场趋势图**：P5-0 `chart_primitives::trend_line_chart` 复用（折线，对齐
//!   frontend `LineChart`）；
//! - **筛选**：P5-0 `filter_bar`（站点 US·DE·UK——backend 严格模式 + 关键词下拉 +
//!   数据集版本下拉 + 刷新）；
//! - **动效**：Phase 4 `enter_fade_in` + `reduce_motion` 尊重。
//!
//! 与 frontend 的已知差异（有意保留，BLF-724 范围边界 / GPUI 能力边界）：
//! - **导入 / 上传 xlsx 入口**（multipart `POST /datasets/import`）：GUI 视图只消费
//!   「数据看板」读取入口；导入走 web 端（GUI 文件选择/上传基建暂未沉淀）；
//! - **导出文件**（xlsx / pdf / png）：与 BLF-723 `weekly_product_analysis` 一致——
//!   GUI 暂无导出基建，保留 `category_research_recompute_*` API 供后续视图按需
//!   接入「重算」按钮；
//! - **6 个 analysis 子 tab**（总览 / 市场 / 品牌 / 卖家 / 评论 / 价格）：web 端
//!   用 6 张子 tab 承载 6 大维度深度分析（含 radar/radial gauge 等图表）；
//!   GPUI 0.2 暂不支持 radar / 双系列复杂图型，**单页平铺**：决策卡 + 风险卡 +
//!   价格区间柱图 + 品牌份额柱图覆盖 6 tab 的核心结论（取舍在本棒 PR 描述
//!   详细说明）；
//! - **dimension_blocks / metric_definitions / action_recommendations / signals /
//!   dimension_profiles / dimension_price_band_analysis / brand_price_band_analysis /
//!   price_band_standard / price_band_method_description** 等 web 端诊断/导出派生
//!   字段：不在 DTO 中消费（DTO 字段仍保留以便后续扩展视图层）；
//! - **品牌份额按销量**（web 是按销售额 share；后端 schema 无 revenue 字段，按
//!   monthly_sales 排序展示）；
//! - **数据质量等级**：web 有 5 级（excellent / good / fair / poor / 较差），本视图
//!   用 4 级中文文案（excellent/good/fair/poor → 优秀/良好/一般/较差）；
//! - **空态语义**：项目列表为空 → 页面级空态「暂无可用数据集」（与 weekly_product
//!   「暂无可用项目」对齐）；有数据集但关键词无版本 → 内嵌空态提示。

use std::collections::BTreeMap;

use gpui::{
    div, prelude::*, px, App, AsyncApp, Context, Entity, FontWeight, Render, SharedString,
    WeakEntity, Window,
};
use gpui_component::{button::Button, h_flex, menu::PopupMenuItem, v_flex, Disableable, Icon, Sizable};
use gui_api_client::Client;
use gui_domain::operations::research_analysis::{
    CategoryResearchBucketItem, CategoryResearchDatasetItem, CategoryResearchMarketTrendPoint,
    CategoryResearchMarketTrendResponse, CategoryResearchOverviewResponse,
    CategoryResearchProductsResponse, CategoryResearchProductRow,
};

use crate::theme::AppTheme;
use crate::widgets::chart_primitives::{
    bar_series_chart, chart_area, chart_empty, trend_line_chart, share_legend, ShareRow, TrendPoint,
};
use crate::widgets::chart_primitives::chart_card;
use crate::widgets::data_table::{CellAlign, ColumnDef, DataTable};
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};
use crate::widgets::filter_bar;

/// 本页在侧栏中的 URL（root.rs 据此路由到本视图；与 gui-domain::sidebar 的
/// 调研分析条目一致）
pub const RESEARCH_ANALYSIS_URL: &str = "/dashboard/operations/research-analysis";

/// 站点选项（backend `_normalize_country` 严格模式只认 US/DE/UK；
/// 对齐 frontend `useState('US')`）
const COUNTRY_OPTIONS: [(&str, &str); 3] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
];

/// 默认站点
const DEFAULT_COUNTRY: &str = "US";

/// 产品明细分页 page_size（对齐 web 端常用值；backend 上限 500）
const PRODUCTS_PAGE_SIZE: i64 = 100;

// ---------------------------------------------------------------------------
// 派生数据（纯函数，可单测）
// ---------------------------------------------------------------------------

/// 站点展示名（未知值原样返回）
fn country_label(country: &str) -> String {
    COUNTRY_OPTIONS
        .iter()
        .find(|(value, _)| *value == country)
        .map_or_else(|| country.to_string(), |(_, label)| label.to_string())
}

/// 风险等级 → 中文文案
fn risk_level_text(level: &str) -> &'static str {
    match level {
        "high" => "高风险",
        "medium" => "中风险",
        "low" => "低风险",
        _ => "未知",
    }
}

/// 风险等级 → 语义色（高=红 / 中=橙 / 低=绿 / 未知=灰）
fn risk_color(level: &str, theme: &AppTheme) -> gpui::Hsla {
    match level {
        "high" => theme.danger,
        "medium" => theme.warning,
        "low" => theme.success,
        _ => theme.text_muted,
    }
}

/// 增长 tier → 中文文案（对齐 web `growthTierText`）
fn growth_tier_text(level: &str) -> &'static str {
    match level {
        "explosive" => "爆发增长",
        "fast_growing" => "快速增长",
        "growing" => "温和增长",
        "softening" => "增长走弱",
        "shrinking" => "持续收缩",
        _ => "平稳",
    }
}

/// 季节性 tier → 中文文案
fn seasonality_tier_text(level: &str) -> &'static str {
    match level {
        "extreme" => "极强季节性",
        "strong" => "强季节性",
        "elevated" => "偏强季节性",
        "moderate" => "中季节性",
        "mild" => "轻季节性",
        _ => "全年较均衡",
    }
}

/// 新品机会 level → 中文文案
fn opportunity_level_text(level: &str) -> &'static str {
    match level {
        "very_high" => "极高",
        "high" => "高",
        "medium" => "中",
        "low" => "低",
        _ => "极低",
    }
}

/// 数据质量 level → 中文文案
fn data_quality_level_text(level: &str) -> &'static str {
    match level {
        "excellent" => "优秀",
        "good" => "良好",
        "fair" => "一般",
        "poor" => "较差",
        _ => "未知",
    }
}

/// 数据集版本展示（V{n} · {data_date}）
fn dataset_version_label(dataset: &CategoryResearchDatasetItem) -> String {
    let date_part = dataset
        .data_date
        .map(|d| d.to_string())
        .or_else(|| {
            match (dataset.data_year, dataset.data_month, dataset.data_day) {
                (Some(y), Some(m), Some(d)) => Some(format!("{:04}-{:02}-{:02}", y, m, d)),
                _ => None,
            }
        })
        .unwrap_or_else(|| "—".to_string());
    if dataset.is_current {
        format!("V{} · {} (当前)", dataset.version, date_part)
    } else {
        format!("V{} · {}", dataset.version, date_part)
    }
}

/// 从数据集列表派生「关键词」去重下拉项（key = category_keyword_en，
/// label = 中文名；与 web `loadKeywordOptions` 同语义）
fn unique_keywords(datasets: &[CategoryResearchDatasetItem]) -> Vec<(String, String)> {
    let mut seen: BTreeMap<String, String> = BTreeMap::new();
    for item in datasets {
        seen.entry(item.category_keyword_en.clone())
            .or_insert_with(|| item.category_name_zh.clone());
    }
    seen.into_iter().collect()
}

/// 从数据集列表按关键词过滤版本
fn datasets_for_keyword_owned(
    datasets: &[CategoryResearchDatasetItem],
    keyword: &str,
) -> Vec<CategoryResearchDatasetItem> {
    datasets
        .iter()
        .filter(|d| d.category_keyword_en == keyword)
        .cloned()
        .collect()
}

/// 市场趋势点 → 折线图数据
fn market_trend_series(points: &[CategoryResearchMarketTrendPoint]) -> Vec<TrendPoint> {
    points
        .iter()
        .map(|p| TrendPoint {
            label: format!("{}/{}", &p.year_month[..4], &p.year_month[5..]),
            value: p.monthly_sales as f64,
        })
        .collect()
}

/// 价格区间柱图（前 N 项）
fn top_price_bands(bands: &[CategoryResearchBucketItem], top_n: usize) -> Vec<ShareRow> {
    bands
        .iter()
        .take(top_n)
        .map(|b| ShareRow {
            name: b.label.clone(),
            sales: b.count as f64,
        })
        .collect()
}

/// 品牌份额柱图（前 N 项；按销量降序，对齐 web `brand_sales_share`）
fn top_brands(
    overview: &CategoryResearchOverviewResponse,
    top_n: usize,
) -> Vec<ShareRow> {
    let mut rows: Vec<ShareRow> = overview
        .brand_sales_share
        .iter()
        .map(|b| ShareRow {
            name: b.brand.clone(),
            sales: b.monthly_sales as f64,
        })
        .collect();
    rows.sort_by(|a, b| b.sales.partial_cmp(&a.sales).unwrap_or(std::cmp::Ordering::Equal));
    rows.into_iter().take(top_n).collect()
}

/// 千分位整数
fn fmt_int_thousands(value: f64) -> String {
    let rounded = value.round();
    let negative = rounded < 0.0;
    let int_str = (rounded.abs() as u64).to_string();
    let mut out = String::with_capacity(int_str.len() + int_str.len() / 3 + 1);
    for (i, ch) in int_str.chars().enumerate() {
        if i > 0 && (int_str.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    if negative {
        out.insert(0, '-');
    }
    out
}

/// 严格货币（2 位小数 + 千分位 + $）
fn fmt_money_usd(value: f64) -> String {
    let negative = value < 0.0;
    let abs = value.abs();
    let scaled = (abs * 100.0).round() as u64;
    let int_part = scaled / 100;
    let frac_part = scaled % 100;
    let int_str = fmt_int_thousands(int_part as f64);
    format!(
        "{}${}.{:02}",
        if negative { "-" } else { "" },
        int_str,
        frac_part
    )
}

/// 百分比（保留 2 位小数）
fn fmt_percent(value: f64) -> String {
    format!("{:.2}%", value * 100.0)
}

/// 评级小数（保留 1 位）
fn fmt_score(value: f64) -> String {
    format!("{:.1}", value)
}

// ---------------------------------------------------------------------------
// 载荷 / 状态机
// ---------------------------------------------------------------------------

/// 调研分析载荷（Loaded 持有）
#[derive(Debug, Clone, PartialEq)]
pub struct ResearchAnalysisData {
    /// 全部数据集版本（关键词 + 版本下拉数据源）
    pub datasets: Vec<CategoryResearchDatasetItem>,
    /// 当前选中关键词
    pub selected_keyword: String,
    /// 当前选中数据集版本 id
    pub selected_dataset_id: i64,
    /// 当前数据集的 overview（KPI + 高级指标）
    pub overview: CategoryResearchOverviewResponse,
    /// 市场趋势（24 月销量序列）
    pub market_trend: Vec<CategoryResearchMarketTrendPoint>,
    /// 当前站点（KPI 卡等用）
    pub country: String,
}

impl ResearchAnalysisData {
    /// 空态判定：datasets 为空
    pub fn is_empty(&self) -> bool {
        self.datasets.is_empty()
    }

    /// 空载荷
    fn empty() -> Self {
        Self {
            datasets: Vec::new(),
            selected_keyword: String::new(),
            selected_dataset_id: 0,
            overview: CategoryResearchOverviewResponse {
                dataset: CategoryResearchDatasetItem {
                    id: 0,
                    marketplace: String::new(),
                    category_keyword_en: String::new(),
                    category_name_zh: String::new(),
                    version: 0,
                    is_current: false,
                    superseded_at: None,
                    upload_file_id: String::new(),
                    upload_file_path: String::new(),
                    original_filename: None,
                    stored_filename: String::new(),
                    file_size_bytes: None,
                    file_sha256: None,
                    ingestion_status: String::new(),
                    ingestion_error: None,
                    data_date: None,
                    data_year: None,
                    data_month: None,
                    data_day: None,
                    row_count_products: 0,
                    row_count_trends: 0,
                    quality_warnings: BTreeMap::new(),
                    created_by: None,
                    created_at: None,
                    updated_at: None,
                },
                kpis: gui_domain::operations::research_analysis::CategoryResearchOverviewKpis::default(),
                brand_sales_share: Vec::new(),
                listing_age_distribution: Vec::new(),
                launch_month_distribution: Vec::new(),
                fulfillment_distribution: Vec::new(),
                fixed_price_bands: Vec::new(),
                quantile_price_bands: Vec::new(),
                price_stats: gui_domain::operations::research_analysis::CategoryResearchPriceStats::default(),
                price_sales_correlation: 0.0,
                fba_fee_distribution: Vec::new(),
                price_sales_points: Vec::new(),
                available_asins: Vec::new(),
                advanced_metrics: gui_domain::operations::research_analysis::CategoryResearchAdvancedMetrics::default(),
            },
            market_trend: Vec::new(),
            country: DEFAULT_COUNTRY.to_string(),
        }
    }
}

/// 调研分析状态机（四态；沿用既有 view 模式）
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum ResearchAnalysisState {
    Loading,
    Loaded(ResearchAnalysisData),
    Empty,
    Error(String),
}

impl ResearchAnalysisState {
    /// 拉取结果 → 落点状态
    pub fn from_fetch_result(result: Result<ResearchAnalysisData, String>) -> Self {
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

/// 调研分析视图（四态状态机 + 站点/关键词/版本筛选 + 竞态保护）
pub struct ResearchAnalysisView {
    state: Entity<ResearchAnalysisState>,
    /// 带会话的 API client
    client: Client,
    /// 全部数据集版本（关键词 + 版本下拉数据源；reload 刷新）
    datasets: Vec<CategoryResearchDatasetItem>,
    /// 当前站点（"US" / "DE" / "UK"）
    country: &'static str,
    /// 当前选中关键词（空 = 未选；默认首个）
    selected_keyword: String,
    /// 当前选中数据集 id
    selected_dataset_id: Option<i64>,
    /// 用户是否已手动调整过关键词/版本（决定默认首关键词 / 首版本语义）
    user_touched: bool,
    /// 主请求竞态保护
    latest_request_id: u64,
    /// 产品明细加载态
    products_loading: bool,
    /// 产品明细错误
    products_error: Option<String>,
    /// 产品明细分页载荷
    products_payload: Option<CategoryResearchProductsResponse>,
    /// 产品明细表（P5-0 DataTable，总存在）
    products_table: Entity<DataTable<CategoryResearchProductRow>>,
    /// 产品明细当前页
    products_page: i64,
    /// 产品明细竞态保护
    latest_products_request_id: u64,
    /// 明细表筛选（品牌）
    products_brand_filter: Option<String>,
}

impl ResearchAnalysisView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| ResearchAnalysisState::Loading);
        let products_table = cx.new(|_| {
            DataTable::new("research-analysis-products", product_columns())
        });
        Self {
            state,
            client,
            datasets: Vec::new(),
            country: DEFAULT_COUNTRY,
            selected_keyword: String::new(),
            selected_dataset_id: None,
            user_touched: false,
            latest_request_id: 0,
            products_loading: false,
            products_error: None,
            products_payload: None,
            products_table,
            products_page: 1,
            latest_products_request_id: 0,
            products_brand_filter: None,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> ResearchAnalysisState {
        self.state.read(cx).clone()
    }

    /// 重新拉取：站点切换 / 错误重试 / 空态刷新 / 关键词 / 版本切换共用入口
    /// （竞态保护；每次调用递增 `latest_request_id` 并进入 Loading）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let country = self.country;
        let selected_keyword = self.selected_keyword.clone();
        let selected_dataset_id = self.selected_dataset_id;

        // 产品明细缓存失效
        self.products_payload = None;
        self.products_page = 1;
        self.products_error = None;
        self.products_brand_filter = None;

        self.state.update(cx, |state, cx| {
            *state = ResearchAnalysisState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(load_main(
                        &client,
                        country,
                        &selected_keyword,
                        selected_dataset_id,
                    ))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_main_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 切换站点（同一站点为 no-op）
    pub fn select_country(&mut self, country: &'static str, cx: &mut Context<Self>) {
        if country == self.country {
            return;
        }
        self.country = country;
        self.reload(cx);
    }

    /// 切换关键词（同一关键词为 no-op；切换后自动选「最新」版本）
    pub fn select_keyword(&mut self, keyword: String, cx: &mut Context<Self>) {
        if keyword == self.selected_keyword {
            return;
        }
        self.selected_keyword = keyword.clone();
        self.user_touched = true;
        // 选最新版本（is_current 优先，否则按 version desc 取首条）
        let latest = self
            .datasets
            .iter()
            .filter(|d| d.category_keyword_en == keyword)
            .max_by_key(|d| d.version);
        self.selected_dataset_id = latest.map(|d| d.id);
        self.reload(cx);
    }

    /// 切换数据集版本（同一版本为 no-op）
    pub fn select_dataset(&mut self, dataset_id: i64, cx: &mut Context<Self>) {
        if Some(dataset_id) == self.selected_dataset_id {
            return;
        }
        self.selected_dataset_id = Some(dataset_id);
        self.user_touched = true;
        self.reload(cx);
    }

    /// 加载产品明细（按当前 page / brand_filter）
    pub fn load_products(&mut self, cx: &mut Context<Self>) {
        let Some(dataset_id) = self.selected_dataset_id else {
            return;
        };
        self.latest_products_request_id = self.latest_products_request_id.wrapping_add(1);
        let request_id = self.latest_products_request_id;
        let page = self.products_page;
        let brand = self.products_brand_filter.clone();

        self.products_loading = true;
        self.products_error = None;
        cx.notify();

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(async move {
                        client
                            .category_research_products(
                                dataset_id,
                                page,
                                PRODUCTS_PAGE_SIZE,
                                brand.as_deref(),
                                None,
                                None,
                            )
                            .await
                            .map_err(|e| e.user_message())
                    })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_products_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 应用主数据拉取结果（竞态保护）
    fn apply_main_result(
        &mut self,
        request_id: u64,
        result: Result<ResearchAnalysisData, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return;
        }
        if let Ok(data) = &result {
            // 落点数据集缓存（关键词 / 版本下拉数据源）
            self.datasets = data.datasets.clone();
            // 落点关键词 / 版本
            self.selected_keyword = data.selected_keyword.clone();
            self.selected_dataset_id = Some(data.selected_dataset_id);
        }
        self.state.update(cx, |state, cx| {
            *state = ResearchAnalysisState::from_fetch_result(result);
            cx.notify();
        });
    }

    /// 应用产品明细拉取结果（竞态保护）
    fn apply_products_result(
        &mut self,
        request_id: u64,
        result: Result<CategoryResearchProductsResponse, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_products_request_id {
            return;
        }
        self.products_loading = false;
        match result {
            Ok(payload) => {
                self.products_payload = Some(payload.clone());
                // 同步表格行（幂等）
                self.products_table.update(cx, |t, cx| {
                    t.set_rows(payload.rows.clone(), cx);
                });
            }
            Err(msg) => {
                self.products_error = Some(msg);
            }
        }
        cx.notify();
    }

    /// 切到下一页（如有）
    pub fn products_next_page(&mut self, cx: &mut Context<Self>) {
        if let Some(payload) = &self.products_payload {
            if payload.has_next {
                self.products_page += 1;
                self.load_products(cx);
            }
        }
    }

    /// 切到上一页
    pub fn products_prev_page(&mut self, cx: &mut Context<Self>) {
        if self.products_page > 1 {
            self.products_page -= 1;
            self.load_products(cx);
        }
    }

    /// 按品牌筛选（重新拉首屏）
    pub fn filter_products_by_brand(&mut self, brand: Option<String>, cx: &mut Context<Self>) {
        if brand == self.products_brand_filter {
            return;
        }
        self.products_brand_filter = brand;
        self.products_page = 1;
        self.load_products(cx);
    }
}

// ---------------------------------------------------------------------------
// 数据加载辅助函数
// ---------------------------------------------------------------------------

/// 主数据加载：list_datasets → 选关键词 → overview + market-trend 并行
async fn load_main(
    client: &Client,
    country: &'static str,
    selected_keyword: &str,
    selected_dataset_id: Option<i64>,
) -> Result<ResearchAnalysisData, String> {
    // 1. 列数据集（include_history=true；视图层展示历史版本下拉）
    let datasets = client
        .category_research_datasets(country, None, None, Some(true))
        .await
        .map_err(|e| e.user_message())?;

    if datasets.is_empty() {
        return Ok(ResearchAnalysisData::empty());
    }

    // 2. 选关键词（用户已选 → 用之；否则用数据集首个关键词）
    let keywords = unique_keywords(&datasets);
    let effective_keyword = if !selected_keyword.is_empty()
        && keywords.iter().any(|(k, _)| k == selected_keyword)
    {
        selected_keyword.to_string()
    } else {
        keywords
            .first()
            .map(|(k, _)| k.clone())
            .ok_or_else(|| "暂无数据集".to_string())?
    };

    // 3. 选数据集版本（用户已选 → 用之；否则取该关键词下「最新」版本）
    let effective_dataset_id = if let Some(id) = selected_dataset_id {
        if datasets.iter().any(|d| d.id == id && d.category_keyword_en == effective_keyword) {
            id
        } else {
            datasets
                .iter()
                .filter(|d| d.category_keyword_en == effective_keyword)
                .max_by_key(|d| d.version)
                .map(|d| d.id)
                .ok_or_else(|| format!("关键词 {effective_keyword} 暂无可用版本"))?
        }
    } else {
        datasets
            .iter()
            .filter(|d| d.category_keyword_en == effective_keyword)
            .max_by_key(|d| d.version)
            .map(|d| d.id)
            .ok_or_else(|| format!("关键词 {effective_keyword} 暂无可用版本"))?
    };

    // 4. 并行拉 overview + market-trend
    let overview_fut = client.category_research_overview(effective_dataset_id, None, None);
    let trend_fut = client.category_research_market_trend(effective_dataset_id, 24);
    let (overview_res, trend_res) = tokio::join!(
        async { overview_fut.await.map_err(|e| e.user_message()) },
        async { trend_fut.await.map_err(|e| e.user_message()) }
    );
    let overview = overview_res?;
    let trend: CategoryResearchMarketTrendResponse = trend_res?;

    Ok(ResearchAnalysisData {
        datasets,
        selected_keyword: effective_keyword,
        selected_dataset_id: effective_dataset_id,
        overview,
        market_trend: trend.points,
        country: country.to_string(),
    })
}

// ---------------------------------------------------------------------------
// 列定义（产品明细表）
// ---------------------------------------------------------------------------

/// 产品明细 11 列（asin / 产品名 / 品牌 / 月销量 / 月营收 / 价格 / 评分 / 评论数 / 履约方式 / 上架日 / FBA fee）
fn product_columns() -> Vec<ColumnDef<CategoryResearchProductRow>> {
    vec![
        ColumnDef::text(
            "asin",
            "ASIN",
            |row, _| row.asin.clone().unwrap_or_else(|| "—".into()).into(),
        ),
        ColumnDef::text(
            "product_name",
            "产品名",
            |row, _| {
                row.product_name
                    .clone()
                    .unwrap_or_else(|| "—".into())
                    .into()
            },
        ),
        ColumnDef::text(
            "brand",
            "品牌",
            |row, _| row.brand.clone().unwrap_or_else(|| "—".into()).into(),
        ),
        ColumnDef::number(
            "monthly_sales",
            "月销量",
            |row| row.monthly_sales as f64,
            |row, _| fmt_int_thousands(row.monthly_sales as f64).into(),
        ),
        ColumnDef::number(
            "monthly_revenue",
            "月营收",
            |row| row.monthly_revenue_usd.unwrap_or(0.0),
            |row, _| {
                row.monthly_revenue_usd
                    .map(fmt_money_usd)
                    .unwrap_or_else(|| "—".into())
                    .into()
            },
        ),
        ColumnDef::number(
            "price",
            "价格",
            |row| row.price_usd.unwrap_or(0.0),
            |row, _| {
                row.price_usd
                    .map(fmt_money_usd)
                    .unwrap_or_else(|| "—".into())
                    .into()
            },
        ),
        ColumnDef::number(
            "rating",
            "评分",
            |row| row.rating.unwrap_or(0.0),
            |row, _| {
                row.rating
                    .map(fmt_score)
                    .unwrap_or_else(|| "—".into())
                    .into()
            },
        ),
        ColumnDef::number(
            "review_count",
            "评论数",
            |row| row.review_count as f64,
            |row, _| fmt_int_thousands(row.review_count as f64).into(),
        ),
        ColumnDef::text(
            "fulfillment",
            "履约",
            |row, _| {
                row.fulfillment_method
                    .clone()
                    .unwrap_or_else(|| "—".into())
                    .into()
            },
        ),
        ColumnDef::text(
            "launch_date",
            "上架日",
            |row, _| {
                row.launch_date
                    .map(|d| d.to_string())
                    .unwrap_or_else(|| "—".into())
                    .into()
            },
        ),
        ColumnDef::number(
            "fba_fee",
            "FBA 费",
            |row: &CategoryResearchProductRow| row.fba_fee_usd.unwrap_or(0.0),
            |row, _| {
                row.fba_fee_usd
                    .map(fmt_money_usd)
                    .unwrap_or_else(|| "—".into())
                    .into()
            },
        )
        .width(120.0)
        .align(CellAlign::Right),
    ]
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

impl Render for ResearchAnalysisView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let view = cx.entity();
        let subtitle = match &state {
            ResearchAnalysisState::Loaded(data) => format!(
                "{} · {} · {}",
                data.selected_keyword,
                country_label(data.country.as_str()),
                if data.overview.dataset.is_current {
                    "当前版本"
                } else {
                    "历史版本"
                },
            ),
            _ => "站点品类调研与深度分析".to_string(),
        };

        v_flex()
            .id("research-analysis")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            .child(PageHeader::new("调研分析").subtitle(subtitle))
            .child(content_guard().child(render_filter_bar(
                &view,
                &app_theme,
                &self.datasets,
                &self.selected_keyword,
                self.selected_dataset_id,
                self.country,
            )))
            .child(match state {
                ResearchAnalysisState::Loading => render_loading(&app_theme).into_any_element(),
                ResearchAnalysisState::Error(msg) => state_views::error_state(
                    &view,
                    &app_theme,
                    "research-analysis-error",
                    "调研分析加载失败",
                    msg,
                    |this, cx| this.reload(cx),
                )
                .into_any_element(),
                ResearchAnalysisState::Empty => state_views::empty_state_with_action(
                    &view,
                    &app_theme,
                    "research-analysis-empty",
                    "icons/file-search.svg",
                    "当前站点暂无可用数据集，请先在 web 端上传品类数据".to_string(),
                    "刷新",
                    |this, cx| this.reload(cx),
                )
                .into_any_element(),
                ResearchAnalysisState::Loaded(data) => render_loaded(
                    &view,
                    cx,
                    &app_theme,
                    &data,
                    self.products_loading,
                    self.products_error.clone(),
                    self.products_payload.clone(),
                    self.products_table.clone(),
                    self.products_page,
                    self.products_brand_filter.clone(),
                )
                .into_any_element(),
            })
    }
}

// ---------------------------------------------------------------------------
// 筛选栏
// ---------------------------------------------------------------------------

fn render_filter_bar(
    view: &Entity<ResearchAnalysisView>,
    theme: &AppTheme,
    datasets: &[CategoryResearchDatasetItem],
    selected_keyword: &str,
    selected_dataset_id: Option<i64>,
    country: &'static str,
) -> impl IntoElement {
    let keywords = unique_keywords(datasets);
    let current_keyword_label: SharedString = if selected_keyword.is_empty() {
        SharedString::from("请选择关键词")
    } else {
        let zh = keywords
            .iter()
            .find(|(k, _)| k == selected_keyword)
            .map(|(_, name)| name.clone())
            .unwrap_or_else(|| selected_keyword.to_string());
        SharedString::from(format!("{zh} ({selected_keyword})"))
    };

    let datasets_for_current = datasets_for_keyword_owned(datasets, selected_keyword);
    let current_dataset_label: SharedString = selected_dataset_id
        .and_then(|id| datasets.iter().find(|d| d.id == id))
        .map(dataset_version_label)
        .map(SharedString::from)
        .unwrap_or_else(|| SharedString::from("请选择版本"));

    let view_for_country = view.clone();
    let view_for_keyword = view.clone();
    let view_for_dataset = view.clone();
    let view_for_refresh = view.clone();

    let country_label_str = country_label(country);
    // 闭包内需要的 owned 数据，避免借用逃逸
    let selected_keyword_owned = selected_keyword.to_string();
    let selected_dataset_id_owned = selected_dataset_id;
    let _datasets_owned = datasets.to_vec();

    filter_bar::filter_bar_layout(theme)
        .child(filter_bar::filter_select(
            theme,
            "站点",
            SharedString::from(country_label_str),
            "research-analysis-country-filter",
            move |menu, _w, _cx| {
                let mut menu = menu;
                for (value, label) in COUNTRY_OPTIONS.iter() {
                    let view = view_for_country.clone();
                    let v: &'static str = value;
                    let checked = *value == country;
                    menu = menu.item(
                        PopupMenuItem::new(label.to_string())
                            .on_click(move |_ev, _w, cx| {
                                view.update(cx, |this, cx| this.select_country(v, cx));
                            })
                            .checked(checked),
                    );
                }
                menu
            },
        ))
        .child(filter_bar::filter_select(
            theme,
            "关键词",
            current_keyword_label,
            "research-analysis-keyword-filter",
            move |menu, _w, _cx| {
                let mut menu = menu;
                if keywords.is_empty() {
                    menu = menu.item(PopupMenuItem::new("暂无可用关键词"));
                } else {
                    for (kw, name) in &keywords {
                        let view = view_for_keyword.clone();
                        let kw_owned = kw.clone();
                        let checked = kw == selected_keyword_owned.as_str();
                        menu = menu.item(
                            PopupMenuItem::new(format!("{name} ({kw})"))
                                .on_click(move |_ev, _w, cx| {
                                    view.update(cx, |this, cx| {
                                        this.select_keyword(kw_owned.clone(), cx)
                                    });
                                })
                                .checked(checked),
                        );
                    }
                }
                menu
            },
        ))
        .child(filter_bar::filter_select(
            theme,
            "版本",
            current_dataset_label,
            "research-analysis-dataset-filter",
            move |menu, _w, _cx| {
                let mut menu = menu;
                if datasets_for_current.is_empty() {
                    menu = menu.item(PopupMenuItem::new("暂无可用版本"));
                } else {
                    for d in &datasets_for_current {
                        let view = view_for_dataset.clone();
                        let id = d.id;
                        let label = dataset_version_label(d);
                        let checked = Some(id) == selected_dataset_id_owned;
                        menu = menu.item(
                            PopupMenuItem::new(label)
                                .on_click(move |_ev, _w, cx| {
                                    view.update(cx, |this, cx| this.select_dataset(id, cx));
                                })
                                .checked(checked),
                        );
                    }
                }
                menu
            },
        ))
        .child(
            Button::new("research-analysis-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_ev, _w, cx| {
                    view_for_refresh.update(cx, |this, cx| this.reload(cx));
                }),
        )
}

// ---------------------------------------------------------------------------
// 四态渲染
// ---------------------------------------------------------------------------

fn render_loading(theme: &AppTheme) -> impl IntoElement {
    state_views::skeleton_loading(
        theme,
        &[
            SkeletonBlock::Kpi(6),
            SkeletonBlock::Chart(220.0),
            SkeletonBlock::Chart(220.0),
        ],
    )
}

#[allow(clippy::too_many_arguments)]
fn render_loaded(
    view: &Entity<ResearchAnalysisView>,
    cx: &mut Context<ResearchAnalysisView>,
    theme: &AppTheme,
    data: &ResearchAnalysisData,
    products_loading: bool,
    products_error: Option<String>,
    products_payload: Option<CategoryResearchProductsResponse>,
    products_table: Entity<DataTable<CategoryResearchProductRow>>,
    products_page: i64,
    products_brand_filter: Option<String>,
) -> impl IntoElement {
    let reduce = crate::motion::reduce_motion(cx);
    crate::motion::enter_fade_in(
        SharedString::from("research-analysis-loaded-fade"),
        v_flex()
            .id("research-analysis-loaded")
            .gap_4()
            // KPI 6 卡
            .child(content_guard().child(kpi_cards(&data.overview, theme)))
            // 市场趋势 + 决策卡
            .child(
                content_guard().child(
                    h_flex()
                        .id("research-analysis-trend-and-decisions")
                        .gap_4()
                        .flex_wrap()
                        .child(market_trend_card(theme, &data.market_trend))
                        .child(decision_cards(theme, &data.overview.advanced_metrics)),
                ),
            )
            // 风险卡 + 价格分布
            .child(
                content_guard().child(
                    h_flex()
                        .id("research-analysis-risks")
                        .gap_4()
                        .flex_wrap()
                        .child(risk_cards(theme, &data.overview.advanced_metrics))
                        .child(price_distribution_card(theme, &data.overview)),
                ),
            )
            // 品牌份额
            .child(
                content_guard()
                    .child(brand_share_card(theme, &data.overview)),
            )
            // 产品明细分页
            .child(content_guard().child(products_section(
                view,
                theme,
                products_loading,
                products_error,
                products_payload,
                products_table,
                products_page,
                products_brand_filter,
            ))),
        reduce,
    )
    .into_any_element()
}

// ---------------------------------------------------------------------------
// KPI 卡（6 张）
// ---------------------------------------------------------------------------

fn kpi_cards(
    overview: &CategoryResearchOverviewResponse,
    theme: &AppTheme,
) -> impl IntoElement {
    let k = &overview.kpis;
    h_flex()
        .id("research-analysis-kpi-cards")
        .gap_3()
        .flex_wrap()
        .children([
            kpi_card(
                theme,
                "icons/database.svg",
                "样本产品数",
                fmt_int_thousands(k.sample_count as f64),
                "件".to_string(),
            ),
            kpi_card(
                theme,
                "icons/shopping-bag.svg",
                "品牌数",
                fmt_int_thousands(k.brand_count as f64),
                "个".to_string(),
            ),
            kpi_card(
                theme,
                "icons/coins.svg",
                "平均价格",
                fmt_money_usd(k.average_price_usd),
                "USD".to_string(),
            ),
            kpi_card(
                theme,
                "icons/bar-chart-3.svg",
                "月销量",
                fmt_int_thousands(k.total_monthly_sales as f64),
                "件".to_string(),
            ),
            kpi_card(
                theme,
                "icons/dollar-sign.svg",
                "月营收",
                fmt_money_usd(k.total_monthly_revenue_usd),
                "USD".to_string(),
            ),
            kpi_card(
                theme,
                "icons/shield.svg",
                "Amazon 份额",
                fmt_percent(k.amazon_share),
                "占总量".to_string(),
            ),
        ])
}

fn kpi_card(
    theme: &AppTheme,
    icon_path: &'static str,
    label: &'static str,
    value: String,
    unit: String,
) -> impl IntoElement {
    let chip_bg = if theme.is_dark() {
        theme.muted_fill
    } else {
        theme.accent_soft
    };
    let chip_icon = if theme.is_dark() {
        theme.text_muted
    } else {
        theme.accent
    };
    v_flex()
        .id(SharedString::from(format!("ra-kpi-{label}")))
        .flex_1()
        .min_w(px(180.0))
        .gap_1()
        .px_4()
        .py_3()
        .rounded(px(theme.radius_lg))
        .border_1()
        .border_color(theme.separator)
        .bg(theme.card_bg)
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    h_flex()
                        .size_6()
                        .flex_shrink_0()
                        .items_center()
                        .justify_center()
                        .rounded_md()
                        .bg(chip_bg)
                        .child(
                            Icon::empty()
                                .path(icon_path)
                                .with_size(px(12.))
                                .text_color(chip_icon),
                        ),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(SharedString::from(label)),
                ),
        )
        .child(
            h_flex()
                .gap_2()
                .items_baseline()
                .child(
                    div()
                        .text_2xl()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_primary)
                        .child(value),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(unit),
                ),
        )
}

// ---------------------------------------------------------------------------
// 市场趋势 + 决策卡
// ---------------------------------------------------------------------------

fn market_trend_card(
    theme: &AppTheme,
    points: &[CategoryResearchMarketTrendPoint],
) -> impl IntoElement {
    let series = market_trend_series(points);
    let title = "市场近 24 月销量";
    let description = "按月聚合总销量（同期对比见 backend market-trend 24 月窗口）";
    let body: gpui::AnyElement = if series.is_empty() {
        chart_empty("暂无市场趋势数据", 200.0, theme).into_any_element()
    } else {
        chart_area(200.0, trend_line_chart(&series, theme.chart_primary))
            .into_any_element()
    };
    chart_card(
        "research-analysis-market-trend",
        title,
        description,
        "icons/trending-up.svg",
        None,
        theme,
        body,
    )
}

fn decision_cards(
    theme: &AppTheme,
    metrics: &gui_domain::operations::research_analysis::CategoryResearchAdvancedMetrics,
) -> impl IntoElement {
    v_flex()
        .id("research-analysis-decision-cards")
        .gap_3()
        .min_w(px(280.0))
        .child(decision_card(
            theme,
            "市场增长",
            growth_tier_text(&metrics.market_growth.growth_tier),
            format!(
                "同比 {} · 斜率 {}",
                fmt_percent(metrics.market_growth.last12_vs_prev12_growth),
                fmt_score(metrics.market_growth.trend_slope)
            ),
        ))
        .child(decision_card(
            theme,
            "季节性",
            seasonality_tier_text(&metrics.seasonality.seasonality_tier),
            format!(
                "Peak3 份额 {} · CV {}",
                fmt_percent(metrics.seasonality.peak3_month_sales_share),
                fmt_score(metrics.seasonality.monthly_sales_cv)
            ),
        ))
        .child(decision_card(
            theme,
            "新品机会",
            opportunity_level_text(&metrics.new_product_opportunity.opportunity_level),
            format!(
                "占比 {} · 销量份额 {}",
                fmt_percent(metrics.new_product_opportunity.new_product_share),
                fmt_percent(metrics.new_product_opportunity.new_product_sales_share)
            ),
        ))
        .child(decision_card(
            theme,
            "数据质量",
            data_quality_level_text(&metrics.data_quality.level),
            format!(
                "综合 {} · 警告密度 {}",
                fmt_score(metrics.data_quality.score),
                fmt_score(metrics.data_quality.warning_density)
            ),
        ))
}

fn decision_card(
    theme: &AppTheme,
    title: &'static str,
    value: &'static str,
    hint: String,
) -> impl IntoElement {
    v_flex()
        .id(SharedString::from(format!("ra-decision-{title}")))
        .gap_1()
        .px_4()
        .py_3()
        .rounded(px(theme.radius_lg))
        .border_1()
        .border_color(theme.separator)
        .bg(theme.card_bg)
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .child(SharedString::from(title)),
        )
        .child(
            div()
                .text_lg()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_primary)
                .child(SharedString::from(value)),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted.opacity(0.85))
                .child(hint),
        )
}

// ---------------------------------------------------------------------------
// 风险卡 + 价格分布
// ---------------------------------------------------------------------------

fn risk_cards(
    theme: &AppTheme,
    metrics: &gui_domain::operations::research_analysis::CategoryResearchAdvancedMetrics,
) -> impl IntoElement {
    v_flex()
        .id("research-analysis-risk-cards")
        .gap_3()
        .min_w(px(280.0))
        .child(risk_card(
            theme,
            "品牌垄断",
            &metrics.brand_monopoly.risk_level,
            format!(
                "CR3 {} · HHI {}",
                fmt_percent(metrics.brand_monopoly.brand_cr3),
                fmt_score(metrics.brand_monopoly.brand_hhi)
            ),
        ))
        .child(risk_card(
            theme,
            "卖家垄断",
            &metrics.seller_monopoly.risk_level,
            format!(
                "CR3 {} · HHI {}",
                fmt_percent(metrics.seller_monopoly.seller_cr3),
                fmt_score(metrics.seller_monopoly.seller_hhi)
            ),
        ))
        .child(risk_card(
            theme,
            "中国卖家竞争",
            &metrics.china_seller_competition.risk_level,
            format!(
                "数量占比 {} · 销量份额 {}",
                fmt_percent(metrics.china_seller_competition.china_seller_count_share),
                fmt_percent(metrics.china_seller_competition.china_seller_sales_share)
            ),
        ))
}

fn risk_card(theme: &AppTheme, title: &'static str, level: &str, hint: String) -> impl IntoElement {
    let color = risk_color(level, theme);
    v_flex()
        .id(SharedString::from(format!("ra-risk-{title}")))
        .gap_1()
        .px_4()
        .py_3()
        .rounded(px(theme.radius_lg))
        .border_1()
        .border_color(theme.separator)
        .bg(theme.card_bg)
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(SharedString::from(title)),
                )
                .child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(color)
                        .child(SharedString::from(risk_level_text(level))),
                ),
        )
        .child(
            div()
                .text_sm()
                .text_color(theme.text_secondary)
                .child(hint),
        )
}

fn price_distribution_card(
    theme: &AppTheme,
    overview: &CategoryResearchOverviewResponse,
) -> impl IntoElement {
    let rows = top_price_bands(&overview.fixed_price_bands, 10);
    let stats = &overview.price_stats;
    let stats_hint = format!(
        "均价 {} · 中位 {} · p25 {} · p75 {}",
        fmt_money_usd(stats.mean),
        fmt_money_usd(stats.median),
        fmt_money_usd(stats.p25),
        fmt_money_usd(stats.p75),
    );
    let body: gpui::AnyElement = if rows.is_empty() {
        chart_empty("暂无价格区间数据", 200.0, theme).into_any_element()
    } else {
        chart_area(200.0, bar_series_chart(&rows, theme.chart_secondary)).into_any_element()
    };
    chart_card(
        "research-analysis-price-distribution",
        "价格区间分布",
        stats_hint,
        "icons/dollar-sign.svg",
        None,
        theme,
        body,
    )
}

// ---------------------------------------------------------------------------
// 品牌份额
// ---------------------------------------------------------------------------

fn brand_share_card(
    theme: &AppTheme,
    overview: &CategoryResearchOverviewResponse,
) -> impl IntoElement {
    let rows = top_brands(overview, 10);
    let total: f64 = overview
        .brand_sales_share
        .iter()
        .map(|b| b.monthly_sales as f64)
        .sum();
    let description = format!(
        "Top 10 品牌按月销量排序；总样本 {} 个品牌",
        overview.brand_sales_share.len()
    );
    let body: gpui::AnyElement = if rows.is_empty() {
        chart_empty("暂无品牌份额数据", 240.0, theme).into_any_element()
    } else {
        h_flex()
            .gap_4()
            .items_start()
            .child(chart_area(240.0, bar_series_chart(&rows, theme.chart_primary)))
            .child(div().flex_1().child(share_legend(&rows, total, theme)))
            .into_any_element()
    };
    chart_card(
        "research-analysis-brand-share",
        "品牌销量份额",
        description,
        "icons/store.svg",
        None,
        theme,
        body,
    )
}

// ---------------------------------------------------------------------------
// 产品明细分页
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn products_section(
    view: &Entity<ResearchAnalysisView>,
    theme: &AppTheme,
    products_loading: bool,
    products_error: Option<String>,
    products_payload: Option<CategoryResearchProductsResponse>,
    products_table: Entity<DataTable<CategoryResearchProductRow>>,
    products_page: i64,
    products_brand_filter: Option<String>,
) -> impl IntoElement {
    let view_for_brand_clear = view.clone();
    let view_for_load = view.clone();
    let view_for_prev = view.clone();
    let view_for_next = view.clone();

    let brand_filter_for_label = products_brand_filter.clone();
    let payload_for_brands = products_payload.clone();
    let payload_for_disabled = products_payload.clone();

    v_flex()
        .id("research-analysis-products")
        .gap_3()
        .w_full()
        .child(
            h_flex()
                .gap_3()
                .items_center()
                .flex_wrap()
                .child(filter_bar::filter_select(
                    theme,
                    "品牌",
                    SharedString::from(
                        brand_filter_for_label
                            .unwrap_or_else(|| "全部品牌".to_string()),
                    ),
                    "research-analysis-products-brand-filter",
                    move |menu, _w, _cx| {
                        let mut menu = menu;
                        let view_clear = view_for_brand_clear.clone();
                        menu = menu.item(
                            PopupMenuItem::new("全部品牌").on_click(move |_ev, _w, cx| {
                                view_clear.update(cx, |this, cx| {
                                    this.filter_products_by_brand(None, cx)
                                });
                            }),
                        );
                        if let Some(payload) = &payload_for_brands {
                            // 派生前 20 品牌（按月销量降序）作为筛选项
                            let mut brands: Vec<&CategoryResearchProductRow> = payload
                                .rows
                                .iter()
                                .filter(|r| r.brand.is_some())
                                .collect();
                            brands.sort_by_key(|b| std::cmp::Reverse(b.monthly_sales));
                            brands.truncate(20);
                            for row in brands {
                                if let Some(brand) = &row.brand {
                                    let view = view_for_brand_clear.clone();
                                    let brand_owned = brand.clone();
                                    menu = menu.item(
                                        PopupMenuItem::new(brand.clone()).on_click(
                                            move |_ev, _w, cx| {
                                                view.update(cx, |this, cx| {
                                                    this.filter_products_by_brand(
                                                        Some(brand_owned.clone()),
                                                        cx,
                                                    )
                                                })
                                            },
                                        ),
                                    );
                                }
                            }
                        }
                        menu
                    },
                ))
                .child(
                    Button::new("research-analysis-products-load")
                        .outline()
                        .small()
                        .label(if products_loading { "加载中…" } else { "加载产品明细" })
                        .disabled(products_loading)
                        .on_click(move |_ev, _w, cx| {
                            view_for_load.update(cx, |this, cx| this.load_products(cx));
                        }),
                )
                .child(
                    Button::new("research-analysis-products-prev")
                        .outline()
                        .small()
                        .label("上一页")
                        .disabled(products_page <= 1 || products_loading)
                        .on_click(move |_ev, _w, cx| {
                            view_for_prev.update(cx, |this, cx| this.products_prev_page(cx));
                        }),
                )
                .child(
                    Button::new("research-analysis-products-next")
                        .outline()
                        .small()
                        .label("下一页")
                        .disabled(
                            products_loading
                                || !payload_for_disabled
                                    .as_ref()
                                    .is_some_and(|p| p.has_next),
                        )
                        .on_click(move |_ev, _w, cx| {
                            view_for_next.update(cx, |this, cx| this.products_next_page(cx));
                        }),
                ),
        )
        .child(match (products_loading, &products_error, &products_payload) {
            (true, _, _) => state_views::loading_state(theme, "加载产品明细中…").into_any_element(),
            (false, Some(msg), _) => state_views::error_state(
                view,
                theme,
                "research-analysis-products-error",
                "产品明细加载失败",
                msg.clone(),
                move |this, cx| this.load_products(cx),
            )
            .into_any_element(),
            (false, None, None) => state_views::empty_state(
                theme,
                "research-analysis-products-empty",
                "icons/package.svg",
                "点击「加载产品明细」查看该数据集产品列表".to_string(),
            )
            .into_any_element(),
            (false, None, Some(payload)) => {
                let pager_total_pages =
                    (payload.page_size.max(1) as f64 / PRODUCTS_PAGE_SIZE as f64).ceil() as i64;
                v_flex()
                    .gap_2()
                    .child(div().child(products_table))
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child(format!(
                                "第 {} 页 · {} 条 · 总页数 {}（page_size={}）",
                                products_page,
                                payload.rows.len(),
                                pager_total_pages,
                                PRODUCTS_PAGE_SIZE
                            )),
                    )
                    .into_any_element()
            }
        })
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    // ---------- 派生函数契约 ----------

    #[test]
    fn risk_level_text_covers_known_levels() {
        assert_eq!(risk_level_text("high"), "高风险");
        assert_eq!(risk_level_text("medium"), "中风险");
        assert_eq!(risk_level_text("low"), "低风险");
        assert_eq!(risk_level_text("unknown"), "未知");
    }

    #[test]
    fn growth_tier_text_covers_known_tiers() {
        assert_eq!(growth_tier_text("explosive"), "爆发增长");
        assert_eq!(growth_tier_text("fast_growing"), "快速增长");
        assert_eq!(growth_tier_text("growing"), "温和增长");
        assert_eq!(growth_tier_text("softening"), "增长走弱");
        assert_eq!(growth_tier_text("shrinking"), "持续收缩");
        assert_eq!(growth_tier_text(""), "平稳");
    }

    #[test]
    fn seasonality_tier_text_covers_known_tiers() {
        assert_eq!(seasonality_tier_text("extreme"), "极强季节性");
        assert_eq!(seasonality_tier_text("strong"), "强季节性");
        assert_eq!(seasonality_tier_text("elevated"), "偏强季节性");
        assert_eq!(seasonality_tier_text("moderate"), "中季节性");
        assert_eq!(seasonality_tier_text("mild"), "轻季节性");
        assert_eq!(seasonality_tier_text(""), "全年较均衡");
    }

    #[test]
    fn opportunity_level_text_covers_known_levels() {
        assert_eq!(opportunity_level_text("very_high"), "极高");
        assert_eq!(opportunity_level_text("high"), "高");
        assert_eq!(opportunity_level_text("medium"), "中");
        assert_eq!(opportunity_level_text("low"), "低");
        assert_eq!(opportunity_level_text(""), "极低");
    }

    #[test]
    fn data_quality_level_text_covers_known_levels() {
        assert_eq!(data_quality_level_text("excellent"), "优秀");
        assert_eq!(data_quality_level_text("good"), "良好");
        assert_eq!(data_quality_level_text("fair"), "一般");
        assert_eq!(data_quality_level_text("poor"), "较差");
        assert_eq!(data_quality_level_text(""), "未知");
    }

    #[test]
    fn dataset_version_label_includes_marker() {
        let mut d = make_dataset(7, "US", "yoga mat", "瑜伽垫", 3, true);
        let label = dataset_version_label(&d);
        assert!(label.contains("V3"));
        assert!(label.contains("2026-08-12"));
        assert!(label.contains("(当前)"));
        d.is_current = false;
        let label = dataset_version_label(&d);
        assert!(!label.contains("(当前)"));
    }

    #[test]
    fn unique_keywords_dedupes_and_keeps_zh_label() {
        let datasets = vec![
            make_dataset(7, "US", "yoga mat", "瑜伽垫", 3, true),
            make_dataset(6, "US", "yoga mat", "瑜伽垫", 2, false),
            make_dataset(5, "US", "water bottle", "水杯", 1, true),
        ];
        let keywords = unique_keywords(&datasets);
        assert_eq!(keywords.len(), 2);
        // 按字母顺序（BTreeMap）
        assert_eq!(keywords[0].0, "water bottle");
        assert_eq!(keywords[0].1, "水杯");
        assert_eq!(keywords[1].0, "yoga mat");
        assert_eq!(keywords[1].1, "瑜伽垫");
    }

    #[test]
    fn datasets_for_keyword_owned_filters() {
        let datasets = vec![
            make_dataset(7, "US", "yoga mat", "瑜伽垫", 3, true),
            make_dataset(5, "US", "water bottle", "水杯", 1, true),
        ];
        let yoga = datasets_for_keyword_owned(&datasets, "yoga mat");
        assert_eq!(yoga.len(), 1);
        assert_eq!(yoga[0].id, 7);
        let none = datasets_for_keyword_owned(&datasets, "nonexistent");
        assert!(none.is_empty());
    }

    #[test]
    fn market_trend_series_converts_to_label_value() {
        let points = vec![
            CategoryResearchMarketTrendPoint {
                year_month: "2024-09".into(),
                monthly_sales: 8500,
            },
            CategoryResearchMarketTrendPoint {
                year_month: "2024-10".into(),
                monthly_sales: 9100,
            },
        ];
        let series = market_trend_series(&points);
        assert_eq!(series.len(), 2);
        assert_eq!(series[0].label, "2024/09");
        assert_eq!(series[0].value, 8500.0);
        assert_eq!(series[1].label, "2024/10");
        assert_eq!(series[1].value, 9100.0);
    }

    #[test]
    fn top_brands_sorts_by_sales_descending_and_limits() {
        let overview = CategoryResearchOverviewResponse {
            dataset: make_dataset(1, "US", "k", "类", 1, true),
            kpis: gui_domain::operations::research_analysis::CategoryResearchOverviewKpis::default(),
            brand_sales_share: vec![
                gui_domain::operations::research_analysis::CategoryResearchBrandShareItem {
                    brand: "BrandA".into(),
                    monthly_sales: 100,
                    share: 0.4,
                },
                gui_domain::operations::research_analysis::CategoryResearchBrandShareItem {
                    brand: "BrandB".into(),
                    monthly_sales: 300,
                    share: 0.5,
                },
                gui_domain::operations::research_analysis::CategoryResearchBrandShareItem {
                    brand: "BrandC".into(),
                    monthly_sales: 200,
                    share: 0.1,
                },
            ],
            listing_age_distribution: Vec::new(),
            launch_month_distribution: Vec::new(),
            fulfillment_distribution: Vec::new(),
            fixed_price_bands: Vec::new(),
            quantile_price_bands: Vec::new(),
            price_stats: gui_domain::operations::research_analysis::CategoryResearchPriceStats::default(),
            price_sales_correlation: 0.0,
            fba_fee_distribution: Vec::new(),
            price_sales_points: Vec::new(),
            available_asins: Vec::new(),
            advanced_metrics: gui_domain::operations::research_analysis::CategoryResearchAdvancedMetrics::default(),
        };
        let rows = top_brands(&overview, 2);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "BrandB");
        assert_eq!(rows[0].sales, 300.0);
        assert_eq!(rows[1].name, "BrandC");
    }

    #[test]
    fn top_price_bands_takes_first_n() {
        let bands: Vec<CategoryResearchBucketItem> = (0..15)
            .map(|i| CategoryResearchBucketItem {
                label: format!("{}-{}", i * 10, (i + 1) * 10),
                count: 100 - i,
            })
            .collect();
        let rows = top_price_bands(&bands, 5);
        assert_eq!(rows.len(), 5);
        assert_eq!(rows[0].name, "0-10");
        assert_eq!(rows[4].name, "40-50");
    }

    #[test]
    fn formatters_handle_normal_and_edge_cases() {
        assert_eq!(fmt_int_thousands(1234.0), "1,234");
        assert_eq!(fmt_int_thousands(0.0), "0");
        assert_eq!(fmt_int_thousands(-1234.7), "-1,235");
        assert_eq!(fmt_money_usd(1234.5), "$1,234.50");
        assert_eq!(fmt_money_usd(0.0), "$0.00");
        assert_eq!(fmt_percent(0.18), "18.00%");
        assert_eq!(fmt_score(72.5), "72.5");
    }

    // ---------- 状态机契约 ----------

    #[test]
    fn state_from_result_maps_correctly() {
        let err = ResearchAnalysisState::from_fetch_result(Err("network".into()));
        assert!(matches!(err, ResearchAnalysisState::Error(m) if m == "network"));

        let empty_data = ResearchAnalysisData::empty();
        let empty = ResearchAnalysisState::from_fetch_result(Ok(empty_data));
        assert!(matches!(empty, ResearchAnalysisState::Empty));

        // Loaded: 非空 datasets
        let mut data = ResearchAnalysisData::empty();
        data.datasets.push(make_dataset(1, "US", "k", "类", 1, true));
        let loaded = ResearchAnalysisState::from_fetch_result(Ok(data));
        assert!(matches!(loaded, ResearchAnalysisState::Loaded(_)));
    }

    // ---------- 视图 URL / URL 契约 ----------

    #[test]
    fn url_constant_matches_sidebar() {
        assert_eq!(
            RESEARCH_ANALYSIS_URL,
            "/dashboard/operations/research-analysis"
        );
    }

    #[test]
    fn country_label_known_and_unknown() {
        assert_eq!(country_label("US"), "美国站 (US)");
        assert_eq!(country_label("DE"), "德国站 (DE)");
        assert_eq!(country_label("UK"), "英国站 (UK)");
        assert_eq!(country_label("FR"), "FR");
    }

    // ---------- 渲染冒烟（亮 / 暗） ----------

    struct ViewHost {
        view: Option<Entity<ResearchAnalysisView>>,
    }

    impl Render for ViewHost {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            if let Some(view) = &self.view {
                view.clone().into_any_element()
            } else {
                div().into_any_element()
            }
        }
    }

    /// 构造一个 dummy client（无 base_url；用于构造视图；不实际发请求）
    fn dummy_client() -> Client {
        Client::new("http://127.0.0.1:1")
    }

    /// 渲染冒烟：加载中（Loading 态）
    #[gpui::test]
    async fn renders_loading_state_in_light_and_dark(cx: &mut gpui::TestAppContext) {
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
            let (_host, _cx) = cx.add_window_view(|_window, cx| {
                let view = cx.new(|cx| ResearchAnalysisView::new(cx, dummy_client()));
                ViewHost { view: Some(view) }
            });
        }
    }

    // ---------- 测试辅助 ----------

    fn make_dataset(
        id: i64,
        marketplace: &str,
        kw: &str,
        name_zh: &str,
        version: i64,
        is_current: bool,
    ) -> CategoryResearchDatasetItem {
        CategoryResearchDatasetItem {
            id,
            marketplace: marketplace.into(),
            category_keyword_en: kw.into(),
            category_name_zh: name_zh.into(),
            version,
            is_current,
            superseded_at: None,
            upload_file_id: format!("u-{id}"),
            upload_file_path: format!("/srv/{id}.xlsx"),
            original_filename: None,
            stored_filename: format!("{id}.xlsx"),
            file_size_bytes: None,
            file_sha256: None,
            ingestion_status: "ok".into(),
            ingestion_error: None,
            data_date: NaiveDate::from_ymd_opt(2026, 8, 12),
            data_year: Some(2026),
            data_month: Some(8),
            data_day: Some(12),
            row_count_products: 100,
            row_count_trends: 200,
            quality_warnings: BTreeMap::new(),
            created_by: None,
            created_at: None,
            updated_at: None,
        }
    }
}
