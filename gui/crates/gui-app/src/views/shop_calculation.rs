//! 报表中心 → 店铺测算视图（P5-4，BLF-729）
//!
//! frontend `app/dashboard/reports/pricing-calculation/shop-calculation/`
//! （`shop-calculation-client.tsx` 约 887 行 + US/EU section 组件）的 GPUI
//! 等价——按站点（US / DE / UK）对项目下全部活跃 SKU 做利润核算：
//! 选 SKU → 编辑测算草稿 → POST quote（US `/pricing-calculation/quote`
//! 历史运费口径 / EU `/pricing-calculation/eu-quote` 手动三费口径）→
//! 结果落会话 + 自动追加店铺测算记录（append-only，BEL-378）→ 统计带刷新。
//!
//! 架构（复用 Phase 5 基建，与 [`crate::views::new_product_calculation`] 同款）：
//! - **主状态机四态**：`Loading / Loaded / Error / Empty`——主数据为可访问项目
//!   列表（`GET /projects/manage`，首屏 reload）；未选项目不视为异常，列表区
//!   走「请选择项目」引导空态；
//! - **列表子状态**：`list_loading` / `list_error`（红横幅，SKU 拉取失败）
//!   与 `warn_error`（琥珀横幅，店铺历史加载失败 / 保存失败降级提示——
//!   对齐 web snapshotError 的非致命语义），竞态保护 `latest_list_id`；
//! - **测算子相位**：单行 `RowPhase::Calculating(sku_id)` + 会话级结果缓存
//!   `results: HashMap<sku_id, PricingRunItem>`；成功后自动保存（失败仅琥珀
//!   提示，结果保留在会话内——web console.warn 同语义）；竞态保护
//!   `latest_calc_id`；
//! - **表格**：P5-0 公共 `DataTable`——SKU 主列表（尺寸 / FOB / 头程 / 售价 /
//!   利润着色 / 利润率着色 / 状态 badge / 编辑操作列）；
//! - **动效**：Phase 4 `enter_fade_in` + `reduce_motion` 尊重。
//!
//! 与 frontend 的已知差异（有意保留，GPUI 能力边界 / macOS 原生习惯）：
//! - **行内编辑 → 主从布局**：web 为每行内嵌 9~12 个输入框 + 行级测算按钮；
//!   GPUI 下数百行 × 多输入实体的成本过高且滚动错位难控，改为「左侧 SKU
//!   表 + 右侧单 SKU 测算面板」主从结构（macOS Finder 预览列同构）：点行
//!   「编辑」载入该 SKU 草稿（已存历史 > SKU 档案默认值），面板内测算；
//! - **定价历史快照**：web 有快照选择器 + 创建 / 编辑 / 删除对话框
//!   （`/pricing-calculation-snapshots/*`）；GUI 无弹窗基建，首版不接，
//!   当前态历史仍随 SKU 载入草稿与统计（取舍已在 issue 说明）；
//! - **搜索**：web useMemo 实时过滤；GUI 输入 Change 订阅即时过滤本地行
//!   （≤200 行纯内存，无 debounce 需要）；
//! - **Excel 导出**：GUI 未接（对齐既有 GUI 视图范围，见新品核算棒）。

use std::collections::HashMap;

use gpui::{
    div, prelude::*, px, App, AsyncApp, Context, Entity, FontWeight, Render, SharedString,
    WeakEntity, Window,
};
use gpui_component::{
    button::Button,
    h_flex,
    input::{Input, InputEvent, InputState},
    menu::PopupMenuItem,
    v_flex, Disableable, Icon, IconName, Sizable,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::operations::new_product_calculation::{
    InboundPlacementMode, PricingQuoteRequest, PricingRunItem,
};
use gui_domain::operations::shop_calculation::{
    ShopCalculationCreateRequest, ShopCalculationItem, SkuRecordItem,
};

use crate::theme::AppTheme;
use crate::widgets::data_table::{CellAlign, ColumnDef, DataTable};
use crate::widgets::page_header::PageHeader;
use crate::widgets::{filter_bar, state_views};
use crate::views::new_product_calculation::{fmt_percent, fmt_usd};

/// 本页在侧栏中的 URL（root.rs 据此路由到本视图；与 gui-domain::sidebar 的
/// 店铺测算条目一致）
pub const SHOP_CALCULATION_URL: &str = "/dashboard/reports/pricing-calculation/shop-calculation";

/// 站点选项（对齐 web `COUNTRY_OPTIONS`：US / DE / UK 三站）
pub const COUNTRY_OPTIONS: [(&str, &str); 3] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
];

/// 默认站点（对齐 web `useUrlParam('country', 'US')` 缺省值）
pub const DEFAULT_COUNTRY: &str = "US";

/// SKU 列表拉取条数上限（对齐 web `page_size=200` 单页全量口径）
pub const SKU_PAGE_SIZE: usize = 200;

// ---------------------------------------------------------------------------
// 测算草稿字段注册表
// ---------------------------------------------------------------------------

/// 草稿字段键（与 [`DRAFT_FIELDS`] 顺序一一对应，输入实体按序懒建）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DraftKey {
    LengthCm,
    WidthCm,
    HeightCm,
    WeightKg,
    FirstLegRmb,
    SalePriceUsd,
    AdvertisingRate,
    ReturnLossRate,
    StorageMonths,
    DeliveryFeeUsd,
    InboundConfigFeeUsd,
    StorageFeeUsd,
    UsdToRmbRate,
}

/// 草稿字段定义（键 / label / 默认值；默认值对齐 web 未测算新行的
/// INITIAL 口径：头程 5 / 广告费率 12 / 退货折损率 4 / 仓储月数 1）
pub struct DraftFieldDef {
    pub key: DraftKey,
    pub label: &'static str,
    pub default: &'static str,
}

/// 全量草稿字段（顺序 = 输入实体下标序；13 项为 US ∪ EU 字段并集，
/// 按 [`DraftKey::visible_in_country`] 裁剪展示）
pub const DRAFT_FIELDS: [DraftFieldDef; 13] = [
    DraftFieldDef { key: DraftKey::LengthCm, label: "长(cm)", default: "" },
    DraftFieldDef { key: DraftKey::WidthCm, label: "宽(cm)", default: "" },
    DraftFieldDef { key: DraftKey::HeightCm, label: "高(cm)", default: "" },
    DraftFieldDef { key: DraftKey::WeightKg, label: "重量(kg)", default: "" },
    DraftFieldDef { key: DraftKey::FirstLegRmb, label: "头程(RMB)", default: "5" },
    DraftFieldDef { key: DraftKey::SalePriceUsd, label: "售价(USD)", default: "" },
    DraftFieldDef { key: DraftKey::AdvertisingRate, label: "广告费率(%)", default: "12" },
    DraftFieldDef { key: DraftKey::ReturnLossRate, label: "退货折损率(%)", default: "4" },
    DraftFieldDef { key: DraftKey::StorageMonths, label: "仓储月数", default: "1" },
    DraftFieldDef { key: DraftKey::DeliveryFeeUsd, label: "派送费(USD)", default: "0" },
    DraftFieldDef { key: DraftKey::InboundConfigFeeUsd, label: "配置费(USD)", default: "0" },
    DraftFieldDef { key: DraftKey::StorageFeeUsd, label: "仓储费(USD)", default: "0" },
    DraftFieldDef { key: DraftKey::UsdToRmbRate, label: "汇率", default: "" },
];

impl DraftKey {
    /// 字段下标（输入实体按 DRAFT_FIELDS 顺序懒建）
    pub fn index(self) -> usize {
        DRAFT_FIELDS
            .iter()
            .position(|f| f.key == self)
            .expect("DraftKey 必须在 DRAFT_FIELDS 注册")
    }

    /// 站点可见性：仓储月数为 US 专属（EU 固定 1 落库）；派送 / 配置 /
    /// 仓储三费为 EU 手动填写专属；其余字段两站共用（对齐 web US/EU
    /// section 的 StoreSkuDraft 字段差集）
    #[allow(dead_code)]
    pub fn visible_in_country(self, country: &str) -> bool {
        match self {
            Self::StorageMonths => country == "US",
            Self::DeliveryFeeUsd | Self::InboundConfigFeeUsd | Self::StorageFeeUsd => {
                country != "US"
            }
            _ => true,
        }
    }
}

// ---------------------------------------------------------------------------
// 纯函数（与 web 同口径）
// ---------------------------------------------------------------------------

/// 站点 label（未知站点回落美国站）
#[allow(dead_code)]
pub fn country_label(country: &str) -> &'static str {
    COUNTRY_OPTIONS
        .iter()
        .find(|(value, _)| *value == country)
        .map(|(_, label)| *label)
        .unwrap_or("美国站 (US)")
}

/// 汇率币种映射（对齐 web exchange-rates 查询参数：DE→EUR / UK→GBP）
pub fn currency_for_country(country: &str) -> &'static str {
    match country {
        "DE" => "EUR",
        "UK" => "GBP",
        _ => "USD",
    }
}

/// 计费重 kg（对齐 web `Math.max(实重, L×W×H/6000)`）
pub fn chargeable_weight_kg(length_cm: f64, width_cm: f64, height_cm: f64, weight_kg: f64) -> f64 {
    weight_kg.max(length_cm * width_cm * height_cm / 6000.0)
}

/// 展示态利润（对齐 web 盈利统计：EU 取扣税后利润缺失回退税前；
/// run 侧 PricingProfit 与 saved 侧 ShopProfit 共用该口径）
fn display_profit_from_parts(country: &str, profit_usd: f64, after_vat: Option<f64>) -> f64 {
    if country == "US" {
        profit_usd
    } else {
        after_vat.unwrap_or(profit_usd)
    }
}

/// 草稿数值格式化：>0 → 原样字符串；≤0 / 缺失 → 空串（对齐 web
/// `x > 0 ? String(x) : ''` 的档案回填口径）
fn draft_num(value: f64) -> String {
    if value > 0.0 {
        format!("{value}")
    } else {
        String::new()
    }
}

/// 百分比回填：小数 ×100 两位小数（对齐 web `(x ?? 默认) * 100`）
fn draft_rate(value: f64) -> String {
    format!("{:.2}", value * 100.0)
}

/// 构建选中 SKU 的草稿初值（下标与 DRAFT_FIELDS 一一对应；优先级：
/// 已存历史快照 > SKU 档案 > 字段默认值；汇率优先系统汇率——对齐 web
/// loadSkusAndSnapshots 的 row 初始化分支）
pub fn build_draft_values(
    item: &SkuRecordItem,
    saved: Option<&ShopCalculationItem>,
    system_rate: &str,
) -> Vec<String> {
    let snap_dims = (
        saved.map(|s| s.package_length_cm).unwrap_or(0.0),
        saved.map(|s| s.package_width_cm).unwrap_or(0.0),
        saved.map(|s| s.package_height_cm).unwrap_or(0.0),
        saved.map(|s| s.weight_kg).unwrap_or(0.0),
    );
    let pick = |snap: f64, archive: f64| -> String {
        if snap > 0.0 {
            draft_num(snap)
        } else {
            draft_num(archive)
        }
    };
    let first_leg = if let Some(s) = saved {
        pick(s.first_leg_cost_rmb, item.first_leg_cost_rmb)
    } else {
        draft_num(item.first_leg_cost_rmb)
    };
    // 头程空缺时回退字段默认 5（web `'5'` 分支）
    let first_leg = if first_leg.is_empty() { "5".to_string() } else { first_leg };

    let rate = if system_rate.trim().is_empty() {
        saved.map(|s| draft_num(s.usd_to_rmb_rate)).unwrap_or_default()
    } else {
        system_rate.to_string()
    };

    let mut values = vec![String::new(); DRAFT_FIELDS.len()];
    values[DraftKey::LengthCm.index()] = pick(snap_dims.0, item.package_length_cm);
    values[DraftKey::WidthCm.index()] = pick(snap_dims.1, item.package_width_cm);
    values[DraftKey::HeightCm.index()] = pick(snap_dims.2, item.package_height_cm);
    values[DraftKey::WeightKg.index()] = pick(snap_dims.3, item.weight_kg);
    values[DraftKey::FirstLegRmb.index()] = first_leg;
    values[DraftKey::SalePriceUsd.index()] =
        saved.map(|s| draft_num(s.sale_price_usd)).unwrap_or_default();
    values[DraftKey::AdvertisingRate.index()] =
        saved.map(|s| draft_rate(s.advertising_rate)).unwrap_or_else(|| "12".to_string());
    values[DraftKey::ReturnLossRate.index()] =
        saved.map(|s| draft_rate(s.return_loss_rate)).unwrap_or_else(|| "4".to_string());
    values[DraftKey::StorageMonths.index()] =
        saved.map(|s| draft_num(s.storage_months)).filter(|v| !v.is_empty()).unwrap_or_else(|| "1".to_string());
    values[DraftKey::DeliveryFeeUsd.index()] = saved
        .map(|s| format!("{}", s.fees.delivery_fee_usd))
        .unwrap_or_else(|| "0".to_string());
    values[DraftKey::InboundConfigFeeUsd.index()] = saved
        .map(|s| format!("{}", s.fees.inbound_config_fee_manual_usd))
        .unwrap_or_else(|| "0".to_string());
    values[DraftKey::StorageFeeUsd.index()] = saved
        .map(|s| format!("{}", s.fees.storage_fee_manual_usd))
        .unwrap_or_else(|| "0".to_string());
    values[DraftKey::UsdToRmbRate.index()] = rate;
    values
}

/// 统计带（对齐 web stats：SKU 总数 / 已测算 / 盈利 / 盈利占比；
/// 盈利占比基于已测算数，未测算时为 0）
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ShopStats {
    pub total: usize,
    pub calculated: usize,
    pub profitable: usize,
    pub pass_rate: f64,
}

/// 计算 SKU 总数 / 已测算 / 盈利统计（total 用全量 SKU；盈利判定用展示口径
/// 利润 ≥ 0；EU 扣税后。会话结果优先于已存历史——刚测完即反映）
pub fn compute_stats(
    skus: &[SkuRecordItem],
    saved: &HashMap<String, ShopCalculationItem>,
    results: &HashMap<i64, PricingRunItem>,
    keyword: &str,
    country: &str,
) -> ShopStats {
    let kw = keyword.trim().to_lowercase();
    let visible: Vec<&SkuRecordItem> = skus
        .iter()
        .filter(|item| {
            kw.is_empty()
                || item.sku.to_lowercase().contains(&kw)
                || item.asin.to_lowercase().contains(&kw)
        })
        .collect();
    let mut stats = ShopStats {
        total: visible.len(),
        ..Default::default()
    };
    for item in visible {
        let display = session_display(results, item, country)
            .or_else(|| saved_display(saved, item, country));
        if let Some((_, profit, rate)) = display {
            stats.calculated += 1;
            if profit >= 0.0 {
                stats.profitable += 1;
            }
            let _ = rate;
        }
    }
    stats.pass_rate = if stats.calculated > 0 {
        stats.profitable as f64 / stats.calculated as f64 * 100.0
    } else {
        0.0
    };
    stats
}

/// 会话结果的展示口径（售价 / 利润 / 利润率）
type RowDisplay = (f64, f64, f64);

fn session_display(
    results: &HashMap<i64, PricingRunItem>,
    item: &SkuRecordItem,
    country: &str,
) -> Option<RowDisplay> {
    let run = results.get(&item.id)?;
    Some((
        run.sale_price_usd,
        display_profit_from_parts(country, run.profit.profit_usd, run.profit.profit_after_vat_usd),
        if country == "US" {
            run.profit.profit_rate
        } else {
            run.profit.profit_after_vat_rate.unwrap_or(run.profit.profit_rate)
        },
    ))
}

fn saved_display(
    saved: &HashMap<String, ShopCalculationItem>,
    item: &SkuRecordItem,
    country: &str,
) -> Option<RowDisplay> {
    let snap = saved.get(&item.sku)?;
    Some((
        snap.sale_price_usd,
        snap.profit.display_profit_usd(country),
        snap.profit.profit_after_vat_rate.unwrap_or(snap.profit.profit_rate),
    ))
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/// 页面主状态机（主数据 = 可访问项目列表；空列表升级页面级空态）
#[derive(Debug, Clone, PartialEq)]
pub enum ShopPageState {
    Loading,
    Loaded,
    Error(String),
    Empty,
}

/// 行测算子相位（同一时刻最多一行在测；Idle = 无进行中请求）
#[derive(Debug, Clone, PartialEq)]
pub enum RowPhase {
    Idle,
    Calculating(i64),
}

/// 表格展示行（状态随 `set_rows` 重建注入）
#[derive(Debug, Clone, PartialEq)]
pub struct SkuRow {
    pub item: SkuRecordItem,
    /// 当前编辑面板选中的 SKU
    pub selected: bool,
    /// 该行测算请求中
    pub calculating: bool,
    /// 展示口径（售价 / 利润 / 利润率）；None = 未测算
    pub display: Option<RowDisplay>,
}

/// 测算提交体（站点分派：US quote / EU eu-quote）
#[derive(Debug, Clone, PartialEq)]
enum SubmitBody {
    Us(PricingQuoteRequest),
    Eu(gui_domain::operations::shop_calculation::PricingEuQuoteRequest),
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// 店铺测算视图（主四态 + 列表子状态 + 单行测算子相位，异步链路竞态保护）
pub struct ShopCalculationView {
    state: Entity<ShopPageState>,
    client: Client,
    /// 可访问项目列表（reload 刷新；筛选菜单数据源）
    projects: Vec<ManagedProject>,
    /// 当前项目 id
    project_id: Option<i64>,
    /// 当前站点（US / DE / UK）
    country: &'static str,
    /// 项目下的活跃 SKU 档案
    skus: Vec<SkuRecordItem>,
    /// 店铺测算当前态（sku → 最新有效行）
    saved: HashMap<String, ShopCalculationItem>,
    /// 系统汇率文本（exchange-rates 首条；拉取失败留空走历史值）
    system_rate: String,
    /// SKU 列表拉取中
    list_loading: bool,
    /// SKU 列表错误（红横幅，致命——表格隐藏）
    list_error: Option<String>,
    /// 非致命警告（店铺历史加载失败 / 自动保存失败；琥珀横幅）
    warn_error: Option<String>,
    /// 列表请求竞态保护
    latest_list_id: u64,
    /// 搜索输入框（懒建；Change 即时过滤本地行）
    search_input: Option<Entity<InputState>>,
    /// 生效的搜索关键词（client-side 过滤 sku / asin）
    keyword: String,
    /// 搜索输入订阅（必须持有，否则变更不送达）
    _search_sub: Option<gpui::Subscription>,
    /// 编辑面板选中的 SKU 记录 id
    selected_sku_id: Option<i64>,
    /// 草稿输入实体（懒建；与 DRAFT_FIELDS 一一对应）
    inputs: Option<Vec<Entity<InputState>>>,
    /// 草稿输入订阅（Change → notify）
    _input_subs: Vec<gpui::Subscription>,
    /// 待落草稿载荷（render 期应用——`set_value` 需要 Window）
    pending_load: Option<Vec<String>>,
    /// 行测算子相位
    calc_phase: RowPhase,
    /// 测算请求竞态保护
    latest_calc_id: u64,
    /// 会话级测算结果缓存（sku 记录 id → run）
    results: HashMap<i64, PricingRunItem>,
    /// 最近一次测算的运行结果（详情面板结果区展示）
    last_run: Option<Box<PricingRunItem>>,
    /// SKU 表（懒建；列静态，行随 set_rows 重建）
    table: Option<Entity<DataTable<SkuRow>>>,
}

impl ShopCalculationView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| ShopPageState::Loading);
        Self {
            state,
            client,
            projects: Vec::new(),
            project_id: None,
            country: DEFAULT_COUNTRY,
            skus: Vec::new(),
            saved: HashMap::new(),
            system_rate: String::new(),
            list_loading: false,
            list_error: None,
            warn_error: None,
            latest_list_id: 0,
            search_input: None,
            keyword: String::new(),
            _search_sub: None,
            selected_sku_id: None,
            inputs: None,
            _input_subs: Vec::new(),
            pending_load: None,
            calc_phase: RowPhase::Idle,
            latest_calc_id: 0,
            results: HashMap::new(),
            last_run: None,
            table: None,
        }
    }

    /// 当前主状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> ShopPageState {
        self.state.read(cx).clone()
    }

    /// 当前编辑选中的 SKU id（只读，测试用）
    #[allow(dead_code)]
    pub fn selected_sku_id(&self) -> Option<i64> {
        self.selected_sku_id
    }

    // -----------------------------------------------------------------------
    // 项目列表（首屏）
    // -----------------------------------------------------------------------

    /// 首屏 / 错误重试：重置选择，重新拉项目列表（页面主状态 Loading）
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.project_id = None;
        self.state.update(cx, |state, cx| {
            *state = ShopPageState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(client.list_managed_projects())
                        .map_err(|e| e.user_message())
                })
                .await;
            this.update(&mut *cx, |this, cx| this.apply_projects_result(result, cx))
                .ok();
        })
        .detach();
    }

    /// 应用项目列表结果：Error / Empty / Loaded 落点
    fn apply_projects_result(
        &mut self,
        result: Result<Vec<ManagedProject>, String>,
        cx: &mut Context<Self>,
    ) {
        let next = match result {
            Ok(projects) if projects.is_empty() => ShopPageState::Empty,
            Ok(projects) => {
                self.projects = projects;
                ShopPageState::Loaded
            }
            Err(msg) => ShopPageState::Error(msg),
        };
        self.state.update(cx, |state, cx| {
            *state = next;
            cx.notify();
        });
        cx.notify();
    }

    // -----------------------------------------------------------------------
    // 项目 / 站点切换
    // -----------------------------------------------------------------------

    /// 选择项目（同名 no-op；切换清空编辑选择与会话结果，重拉列表）
    pub fn select_project(&mut self, name: &str, cx: &mut Context<Self>) {
        let Some(project) = self.projects.iter().find(|p| p.name == name) else {
            return;
        };
        if self.project_id == Some(project.id) {
            return;
        }
        self.project_id = Some(project.id);
        self.reset_session_selection();
        self.load_list(cx);
    }

    /// 切换站点（同站点 no-op；切换清空编辑选择，重拉列表）
    pub fn select_country(&mut self, country: &'static str, cx: &mut Context<Self>) {
        if country == self.country {
            return;
        }
        self.country = country;
        self.reset_session_selection();
        self.load_list(cx);
    }

    /// 清空会话级选择 / 结果 / 草稿载荷（项目或站点变化时——对齐 web
    /// 切换后退出旧数据上下文的语义）
    fn reset_session_selection(&mut self) {
        self.selected_sku_id = None;
        self.pending_load = None;
        self.results.clear();
        self.last_run = None;
        self.calc_phase = RowPhase::Idle;
        self.row_error_reset();
    }

    fn row_error_reset(&mut self) {
        // 占位：行错误与警告横幅随列表刷新一并清除
        self.warn_error = None;
    }

    // -----------------------------------------------------------------------
    // SKU + 历史 + 汇率拉取
    // -----------------------------------------------------------------------

    /// 拉取列表三元组：SKU 档案（致命）/ 系统汇率（静默）/ 店铺测算当前态
    /// （非致命琥珀提示）。任一前置缺失直接跳过。
    fn load_list(&mut self, cx: &mut Context<Self>) {
        let Some(project_id) = self.project_id else {
            return;
        };
        self.latest_list_id = self.latest_list_id.wrapping_add(1);
        let request_id = self.latest_list_id;
        self.list_loading = true;
        self.list_error = None;
        self.warn_error = None;
        self.skus.clear();
        self.saved.clear();
        self.system_rate.clear();
        self.sync_table(cx);
        cx.notify();

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        let project_name = self
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .map(|p| p.name.clone())
            .unwrap_or_default();
        let country = self.country.to_string();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let outcome = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(async move {
                            let skus = client
                                .list_sku_records(&project_name, &country, 1, SKU_PAGE_SIZE)
                                .await;
                            let rate = client
                                .exchange_rate_list(
                                    &gui_api_client::exchange_rate::ExchangeRateFilter {
                                        currency: Some(currency_for_country(&country).to_string()),
                                        year: None,
                                        month: None,
                                    },
                                    1,
                                    1,
                                )
                                .await;
                            let saved = client
                                .list_shop_calculations(project_id, &country, 1, SKU_PAGE_SIZE)
                                .await;
                            (
                                skus.map_err(|e| e.user_message()),
                                rate.ok().and_then(|resp| resp.items.first().map(|r| r.rate)),
                                saved.map_err(|e| e.user_message()),
                            )
                        })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_list_result(request_id, outcome, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 应用列表结果：竞态保护 + 三路落点（SKU 致命 / 汇率静默 / 历史非致命）
    fn apply_list_result(
        &mut self,
        request_id: u64,
        outcome: (
            Result<gui_domain::operations::shop_calculation::SkuRecordsPage, String>,
            Option<f64>,
            Result<gui_domain::operations::shop_calculation::ShopCalculationListResponse, String>,
        ),
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_list_id {
            return; // 过期响应丢弃
        }
        self.list_loading = false;
        let (skus, rate, saved) = outcome;

        match skus {
            Err(msg) => {
                self.list_error = Some(msg);
                self.skus.clear();
                self.sync_table(cx);
                cx.notify();
                return;
            }
            Ok(page) => {
                // 双保险过滤（backend 已筛 is_active + country；web 侧同样复筛）
                self.skus = page
                    .items
                    .into_iter()
                    .filter(|i| i.is_active && i.country == self.country)
                    .collect();
            }
        }

        if let Some(rate) = rate {
            self.system_rate = format!("{rate}");
        }

        match saved {
            Ok(resp) => {
                self.saved = resp
                    .items
                    .into_iter()
                    .map(|item| (item.sku.clone(), item))
                    .collect();
            }
            Err(msg) => {
                self.warn_error = Some(format!("店铺历史加载失败：{msg}"));
            }
        }

        self.sync_table(cx);
        cx.notify();
    }

    // -----------------------------------------------------------------------
    // 编辑选择 / 草稿
    // -----------------------------------------------------------------------

    /// 选中 SKU 进入编辑面板（操作列「编辑」回连；载入草稿初值）
    pub fn select_sku(&mut self, sku_record_id: i64, cx: &mut Context<Self>) {
        let Some(item) = self.skus.iter().find(|s| s.id == sku_record_id) else {
            return;
        };
        let item = item.clone();
        let saved = self.saved.get(&item.sku).cloned();
        let values = build_draft_values(&item, saved.as_ref(), &self.system_rate);
        self.selected_sku_id = Some(item.id);
        self.pending_load = Some(values);
        self.last_run = self.results.get(&item.id).cloned().map(Box::new);
        self.sync_table(cx);
        cx.notify();
    }

    /// 应用待落草稿（render 期；`set_value` 需要 Window）
    fn apply_pending_load(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(values) = self.pending_load.take() else {
            return;
        };
        let Some(inputs) = self.inputs.clone() else {
            return;
        };
        for (ix, text) in values.into_iter().enumerate() {
            if let Some(input) = inputs.get(ix) {
                input.update(cx, |state, cx| state.set_value(text, window, cx));
            }
        }
    }

    /// 读取字段原始文本（输入未建时为空串）
    fn field_text(&self, cx: &App, key: DraftKey) -> String {
        self.inputs
            .as_ref()
            .and_then(|inputs| inputs.get(key.index()))
            .map(|input| input.read(cx).value().to_string())
            .unwrap_or_default()
    }

    /// 必填正数字段校验（缺失 / 非法 / ≤0 → 中文错误）
    fn require_positive(&self, cx: &App, key: DraftKey, label: &str) -> Result<f64, String> {
        let text = self.field_text(cx, key);
        let value: f64 = text
            .trim()
            .parse()
            .ok()
            .filter(|v: &f64| v.is_finite())
            .ok_or_else(|| format!("请填写{label}"))?;
        if value <= 0.0 {
            return Err(format!("{label}必须大于 0"));
        }
        Ok(value)
    }

    /// 非负数字段校验（空 → 0；非法 / 负数 → 错误）
    fn require_non_negative(&self, cx: &App, key: DraftKey, label: &str) -> Result<f64, String> {
        let trimmed = self.field_text(cx, key).trim().to_string();
        if trimmed.is_empty() {
            return Ok(0.0);
        }
        let value: f64 = trimmed
            .parse()
            .ok()
            .filter(|v: &f64| v.is_finite())
            .ok_or_else(|| format!("{label}必须为数字"))?;
        if value < 0.0 {
            return Err(format!("{label}不能为负数"));
        }
        Ok(value)
    }

    /// 百分比费率校验（0~100 → 小数）
    fn require_rate(&self, cx: &App, key: DraftKey, label: &str) -> Result<f64, String> {
        let text = self.field_text(cx, key);
        let value: f64 = text
            .trim()
            .parse()
            .ok()
            .filter(|v: &f64| v.is_finite())
            .ok_or_else(|| format!("请填写{label}"))?;
        if !(0.0..=100.0).contains(&value) {
            return Err(format!("{label}需在 0~100 之间"));
        }
        Ok(value / 100.0)
    }

    /// 可选正数校验（空 → None；非法 / ≤0 → 错误）
    fn optional_positive(&self, cx: &App, key: DraftKey, label: &str) -> Result<Option<f64>, String> {
        let trimmed = self.field_text(cx, key).trim().to_string();
        if trimmed.is_empty() {
            return Ok(None);
        }
        let value: f64 = trimmed
            .parse()
            .ok()
            .filter(|v: &f64| v.is_finite())
            .ok_or_else(|| format!("{label}必须为数字"))?;
        if value <= 0.0 {
            return Err(format!("{label}必须大于 0"));
        }
        Ok(Some(value))
    }

    /// 构建测算请求（纯读取；站点分支对齐 web handleCalculate 的 US/EU
    /// 请求体口径）。校验失败 → Err（中文提示，不发请求）。
    fn build_submission(&self, cx: &App) -> Result<(SubmitBody, SaveContext), String> {
        let Some(item) = self
            .selected_sku_id
            .and_then(|id| self.skus.iter().find(|s| s.id == id))
        else {
            return Err("请先在左侧列表选择 SKU".to_string());
        };
        let project_id = self.project_id;
        let project_name = self
            .projects
            .iter()
            .find(|p| Some(p.id) == project_id)
            .map(|p| p.name.clone())
            .unwrap_or_default();

        let length = self.require_positive(cx, DraftKey::LengthCm, "长")?;
        let width = self.require_positive(cx, DraftKey::WidthCm, "宽")?;
        let height = self.require_positive(cx, DraftKey::HeightCm, "高")?;
        let weight = self.require_positive(cx, DraftKey::WeightKg, "重量")?;
        let first_leg = self.require_non_negative(cx, DraftKey::FirstLegRmb, "头程")?;
        let sale_price = self.require_positive(cx, DraftKey::SalePriceUsd, "售价")?;
        let advertising_rate = self.require_rate(cx, DraftKey::AdvertisingRate, "广告费率")?;
        let return_loss_rate = self.require_rate(cx, DraftKey::ReturnLossRate, "退货折损率")?;
        let usd_to_rmb_rate = self.optional_positive(cx, DraftKey::UsdToRmbRate, "汇率")?;

        let ctx = SaveContext {
            sku_record_id: item.id,
            project_id,
            project_name,
            sku: item.sku.clone(),
            asin: if item.asin.is_empty() { None } else { Some(item.asin.clone()) },
            country: self.country.to_string(),
            delivery_fee_usd: self.require_non_negative(cx, DraftKey::DeliveryFeeUsd, "派送费")?,
            inbound_config_fee_usd: self.require_non_negative(
                cx,
                DraftKey::InboundConfigFeeUsd,
                "配置费",
            )?,
            storage_fee_usd: self.require_non_negative(cx, DraftKey::StorageFeeUsd, "仓储费")?,
        };
        let product_name = format!("{} / {}", ctx.project_name, item.sku);

        if self.country == "US" {
            let storage_months = self.require_positive(cx, DraftKey::StorageMonths, "仓储月数")?;
            Ok((
                SubmitBody::Us(PricingQuoteRequest {
                    country: self.country.to_string(),
                    product_name,
                    competitor_url: None,
                    package_length_cm: length,
                    package_width_cm: width,
                    package_height_cm: height,
                    weight_kg: weight,
                    fob_product_cost_rmb: item.fob_unit_cost,
                    first_leg_cost_rmb: first_leg,
                    first_leg_unit_price_rmb: None,
                    sale_price_usd: sale_price,
                    commission_rate: 0.15,
                    advertising_rate,
                    return_loss_rate,
                    storage_months,
                    inbound_placement_mode: InboundPlacementMode::SingleDestination,
                    usd_to_rmb_rate,
                    project_id,
                    sku: Some(item.sku.clone()),
                    use_historical_shipping_cost: Some(true),
                }),
                ctx,
            ))
        } else {
            use gui_domain::operations::shop_calculation::PricingEuQuoteRequest;
            Ok((
                SubmitBody::Eu(PricingEuQuoteRequest {
                    country: self.country.to_string(),
                    product_name,
                    package_length_cm: length,
                    package_width_cm: width,
                    package_height_cm: height,
                    weight_kg: weight,
                    fob_product_cost_rmb: item.fob_unit_cost,
                    first_leg_cost_rmb: first_leg,
                    project_id,
                    sku: Some(item.sku.clone()),
                    sale_price_usd: sale_price,
                    delivery_fee_usd: ctx.delivery_fee_usd,
                    inbound_config_fee_usd: ctx.inbound_config_fee_usd,
                    storage_fee_usd: ctx.storage_fee_usd,
                    commission_rate: 0.15,
                    advertising_rate,
                    return_loss_rate,
                    usd_to_rmb_rate,
                }),
                ctx,
            ))
        }
    }

    /// 提交测算（面板按钮回连；成功后会话缓存 + 自动追加店铺测算记录 +
    /// 统计带刷新；失败红横幅内联）。请求体非法 → 直接落错误，不发请求。
    pub fn submit_calculation(&mut self, cx: &mut Context<Self>) {
        let RowPhase::Calculating(busy_id) = self.calc_phase else {
            // Idle：继续
            let (body, ctx) = match self.build_submission(cx) {
                Ok(pair) => pair,
                Err(msg) => {
                    self.set_inline_error(msg);
                    cx.notify();
                    return;
                }
            };
            self.latest_calc_id = self.latest_calc_id.wrapping_add(1);
            let request_id = self.latest_calc_id;
            self.calc_phase = RowPhase::Calculating(ctx.sku_record_id);
            cx.notify();

            let client = self.client.clone();
            let bg = cx.background_executor().clone();
            cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
                let outcome = bg
                    .spawn(async move {
                        crate::runtime::runtime()
                            .block_on(async move {
                                let quoted = match body {
                                    SubmitBody::Us(req) => client.pricing_quote(&req).await,
                                    SubmitBody::Eu(req) => client.pricing_eu_quote(&req).await,
                                };
                                match quoted {
                                    Err(e) => (Err(e.user_message()), None),
                                    Ok(run) => {
                                        // 自动追加店铺测算记录（best-effort；失败仅提示）
                                        let save = match ctx.project_id {
                                            None => None,
                                            Some(pid) => {
                                                let payload = if ctx.country == "US" {
                                                    ShopCalculationCreateRequest::from_us_run(
                                                        &run,
                                                        pid,
                                                        &ctx.project_name,
                                                        ctx.asin.clone(),
                                                        &ctx.country,
                                                        0.0,
                                                        0.0,
                                                        0.0,
                                                    )
                                                } else {
                                                    ShopCalculationCreateRequest::from_eu_run(
                                                        &run,
                                                        pid,
                                                        &ctx.project_name,
                                                        ctx.asin.clone(),
                                                        &ctx.country,
                                                        ctx.delivery_fee_usd,
                                                        ctx.inbound_config_fee_usd,
                                                        ctx.storage_fee_usd,
                                                    )
                                                };
                                                Some(client.save_shop_calculation(&payload).await)
                                            }
                                        };
                                        (Ok(run), save)
                                    }
                                }
                            })
                    })
                    .await;
                this.update(&mut *cx, |this, cx| {
                    this.apply_calc_result(request_id, outcome, cx);
                })
                .ok();
            })
            .detach();
            return;
        };
        let _ = busy_id; // 测算中忽略重复提交
    }

    fn set_inline_error(&mut self, msg: String) {
        self.list_error = Some(msg);
    }

    /// 应用测算结果：竞态保护 + 会话缓存 + 自动保存落点 + 表格同步
    fn apply_calc_result(
        &mut self,
        request_id: u64,
        outcome: (
            Result<PricingRunItem, String>,
            Option<Result<ShopCalculationItem, gui_api_client::error::ApiError>>,
        ),
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_calc_id {
            return; // 过期响应丢弃
        }
        self.calc_phase = RowPhase::Idle;
        let (quoted, save) = outcome;
        match quoted {
            Err(msg) => {
                self.warn_error = Some(format!("店铺测算失败：{msg}"));
            }
            Ok(run) => {
                self.results.insert(
                    self.selected_sku_id.unwrap_or_default(),
                    run.clone(),
                );
                self.last_run = Some(Box::new(run));
                match save {
                    Some(Ok(item)) => {
                        self.saved.insert(item.sku.clone(), item);
                        self.warn_error = None;
                    }
                    Some(Err(e)) => {
                        self.warn_error =
                            Some(format!("测算完成，但保存店铺测算失败：{}", e.user_message()));
                    }
                    None => {}
                }
            }
        }
        self.sync_table(cx);
        cx.notify();
    }

    // -----------------------------------------------------------------------
    // 表格同步
    // -----------------------------------------------------------------------

    /// 同步 SKU 表行（数据 / 关键词 / 选择 / 测算中标记变化时调用）
    fn sync_table(&mut self, cx: &mut Context<Self>) {
        let kw = self.keyword.trim().to_lowercase();
        let rows: Vec<SkuRow> = self
            .skus
            .iter()
            .filter(|item| {
                kw.is_empty()
                    || item.sku.to_lowercase().contains(&kw)
                    || item.asin.to_lowercase().contains(&kw)
            })
            .map(|item| {
                let display = session_display(&self.results, item, self.country)
                    .or_else(|| saved_display(&self.saved, item, self.country));
                SkuRow {
                    item: item.clone(),
                    selected: self.selected_sku_id == Some(item.id),
                    calculating: matches!(self.calc_phase, RowPhase::Calculating(id) if id == item.id),
                    display,
                }
            })
            .collect();
        match &self.table {
            Some(table) => {
                let table = table.clone();
                table.update(cx, |t, cx| t.set_rows(rows, cx));
            }
            None => {
                let view_entity = cx.entity();
                let table = cx.new(|_| {
                    DataTable::new("shop-calculation-sku-table", sku_columns(view_entity))
                        .striped(true)
                        .empty_text("该项目在此站点下没有活跃 SKU")
                });
                table.update(cx, |t, cx| t.set_rows(rows, cx));
                self.table = Some(table);
            }
        }
    }
}

/// 自动保存上下文（测算成功后构建 append-only 载荷所需的项目 / 草稿快照）
#[derive(Debug, Clone, PartialEq)]
struct SaveContext {
    sku_record_id: i64,
    project_id: Option<i64>,
    project_name: String,
    sku: String,
    asin: Option<String>,
    country: String,
    delivery_fee_usd: f64,
    inbound_config_fee_usd: f64,
    storage_fee_usd: f64,
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

impl Render for ShopCalculationView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // 懒建草稿输入实体（首帧；InputState::new 需要 window）
        if self.inputs.is_none() {
            let mut subs = Vec::with_capacity(DRAFT_FIELDS.len());
            let inputs = DRAFT_FIELDS
                .iter()
                .map(|field| {
                    let state =
                        cx.new(|cx| InputState::new(window, cx).placeholder(field.default));
                    let sub = cx.subscribe(&state, |_this, _entity, event: &InputEvent, cx| {
                        if matches!(event, InputEvent::Change) {
                            cx.notify();
                        }
                    });
                    subs.push(sub);
                    state
                })
                .collect();
            self.inputs = Some(inputs);
            self._input_subs = subs;
        }
        // 懒建搜索框 + Change 即时过滤订阅
        if self.search_input.is_none() {
            let input =
                cx.new(|cx| InputState::new(window, cx).placeholder("搜索 SKU / ASIN"));
            let sub = cx.subscribe(&input, |this, entity, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    // Change 事件后读最新值需要下一帧；这里直接读实体当前值即可
                    // （Change 携带的是最终值已写入后的通知）
                    let value = entity.read(cx).value().to_string();
                    this.keyword = value;
                    this.sync_table(cx);
                }
            });
            self.search_input = Some(input);
            self._search_sub = Some(sub);
        }
        // 待落草稿（set_value 需要 window，render 期应用）
        self.apply_pending_load(window, cx);

        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        match state {
            ShopPageState::Loading => render_loading(&app_theme).into_any_element(),
            ShopPageState::Error(msg) => render_error(cx, &app_theme, &msg).into_any_element(),
            ShopPageState::Empty => render_empty(&app_theme).into_any_element(),
            ShopPageState::Loaded => {
                // 渲染快照：render 期视图实体已持更新租约，下游渲染函数不得
                // `view.read(cx)`（双租约 panic），所需数据全部取自 self
                let snap = ViewSnapshot {
                    country: self.country,
                    project_label: self
                        .project_id
                        .and_then(|id| self.projects.iter().find(|p| p.id == id))
                        .map(|p| p.name.clone())
                        .unwrap_or_else(|| "选择项目".to_string()),
                    has_project: self.project_id.is_some(),
                    projects: self.projects.iter().map(|p| p.name.clone()).collect(),
                    inputs: self.inputs.clone(),
                    search_input: self.search_input.clone(),
                    keyword: self.keyword.clone(),
                    list_loading: self.list_loading,
                    list_error: self.list_error.clone(),
                    warn_error: self.warn_error.clone(),
                    stats: compute_stats(
                        &self.skus,
                        &self.saved,
                        &self.results,
                        &self.keyword,
                        self.country,
                    ),
                    selected: self.selected_sku_id.and_then(|id| {
                        self.skus.iter().find(|s| s.id == id).cloned()
                    }),
                    calc_phase: self.calc_phase.clone(),
                    last_run: self.last_run.clone(),
                    table: self.table.clone(),
                };
                let view = cx.entity();
                render_loaded(&view, cx, &app_theme, &snap).into_any_element()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 四态渲染
// ---------------------------------------------------------------------------

/// Loading：Spinner + 骨架块（筛选 + 统计 + 表格同构占位）
fn render_loading(app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("shop-calculation-loading")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::skeleton_loading(
            app_theme,
            &[
                state_views::SkeletonBlock::Title,
                state_views::SkeletonBlock::Filter(2),
                state_views::SkeletonBlock::Kpi(4),
                state_views::SkeletonBlock::Table(320.0),
            ],
        ))
}

/// Error：内联 Alert + 重试按钮（Stage 0 `state_views::error_state`）
fn render_error(
    cx: &mut Context<ShopCalculationView>,
    app_theme: &AppTheme,
    msg: &str,
) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("shop-calculation-error")
        .size_full()
        .gap_4()
        .p_6()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(state_views::error_state(
            &view,
            app_theme,
            "shop-calculation-error",
            "店铺测算加载失败",
            msg.to_string(),
            |this, cx| this.reload(cx),
        ))
}

/// Empty：无可访问项目的页面级空态
fn render_empty(app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("shop-calculation-empty")
        .size_full()
        .p_6()
        .bg(app_theme.window_bg)
        .child(state_views::empty_state(
            app_theme,
            "shop-calculation-empty-state",
            "icons/package.svg",
            "暂无可用项目，请先在系统中配置项目。",
        ))
}

/// Loaded 渲染快照（render 期只读；交互回连走 view 实体闭包）
struct ViewSnapshot {
    country: &'static str,
    project_label: String,
    has_project: bool,
    projects: Vec<String>,
    inputs: Option<Vec<Entity<InputState>>>,
    search_input: Option<Entity<InputState>>,
    keyword: String,
    list_loading: bool,
    list_error: Option<String>,
    warn_error: Option<String>,
    stats: ShopStats,
    selected: Option<SkuRecordItem>,
    calc_phase: RowPhase,
    last_run: Option<Box<PricingRunItem>>,
    table: Option<Entity<DataTable<SkuRow>>>,
}

/// Loaded：页头 + 控制台卡（筛选 / 搜索 / 统计）+ SKU 表 × 测算面板
fn render_loaded(
    view: &Entity<ShopCalculationView>,
    cx: &mut Context<ShopCalculationView>,
    app_theme: &AppTheme,
    snap: &ViewSnapshot,
) -> impl IntoElement {
    let reduce = crate::motion::reduce_motion(cx);
    let ViewSnapshot {
        country,
        project_label,
        has_project,
        projects,
        inputs,
        search_input,
        keyword,
        list_loading,
        list_error,
        warn_error,
        stats,
        selected,
        calc_phase,
        last_run,
        table,
    } = snap;
    let country = *country;
    let project_label = project_label.clone();
    let has_project = *has_project;
    let projects = projects.clone();
    let inputs = inputs.clone();
    let search_input = search_input.clone();
    let keyword = keyword.clone();
    let list_loading = *list_loading;
    let list_error = list_error.clone();
    let warn_error = warn_error.clone();
    let stats = *stats;
    let selected = selected.clone();
    let calc_phase = calc_phase.clone();
    let last_run = last_run.clone();
    let table = table.clone();

    crate::motion::enter_fade_in(
        SharedString::from("shop-calculation-loaded-fade"),
        v_flex()
            .id("shop-calculation-loaded")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            .child(PageHeader::new("店铺测算").subtitle(format!(
                "{} · 店铺维度 SKU 利润核算（美国 / 德国 / 英国）",
                country_label(country)
            )))
            .child(render_console_card(
                view,
                app_theme,
                project_label,
                projects,
                country,
                search_input,
                &keyword,
                stats,
                list_loading,
            ))
            .when_some(warn_error, |el, msg| {
                el.child(warn_banner(app_theme, "shop-calculation-warn", &msg))
            })
            .child(
                h_flex()
                    .w_full()
                    .items_start()
                    .gap_4()
                    .child(render_master_card(app_theme, table, list_loading, list_error, has_project))
                    .child(render_detail_panel(
                        view,
                        cx,
                        app_theme,
                        inputs,
                        country,
                        &selected,
                        &calc_phase,
                        last_run.as_deref(),
                    )),
            ),
        reduce,
    )
}

/// 卡片标题（text_base semibold；对齐既有视图卡片头观感）
fn card_title(app_theme: &AppTheme, title: &str) -> impl IntoElement {
    div()
        .text_base()
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(app_theme.text_primary)
        .child(title.to_string())
}

/// 内联警告横幅（warning 软底；非致命降级提示）
fn warn_banner(app_theme: &AppTheme, id: &'static str, msg: &str) -> impl IntoElement {
    h_flex()
        .id(id)
        .w_full()
        .gap_2()
        .items_center()
        .px_3()
        .py_2()
        .rounded(px(app_theme.radius))
        .border_1()
        .border_color(app_theme.warning.opacity(0.4))
        .bg(app_theme.warning.opacity(0.1))
        .child(
            Icon::new(IconName::TriangleAlert)
                .with_size(px(14.))
                .text_color(app_theme.warning),
        )
        .child(div().text_xs().text_color(app_theme.text_primary).child(msg.to_string()))
}

/// 控制台卡：项目 / 站点筛选 + 搜索 + 统计带（web 控制台 Card 1 的 GPUI 等价）
#[allow(clippy::too_many_arguments)]
fn render_console_card(
    view: &Entity<ShopCalculationView>,
    app_theme: &AppTheme,
    project_label: String,
    projects: Vec<String>,
    country: &'static str,
    search_input: Option<Entity<InputState>>,
    keyword: &str,
    stats: ShopStats,
    list_loading: bool,
) -> impl IntoElement {
    let view_for_project = view.clone();
    let view_for_country = view.clone();
    let pass_color = if stats.pass_rate >= 50.0 {
        app_theme.success
    } else if stats.pass_rate >= 25.0 {
        app_theme.warning
    } else {
        app_theme.danger
    };

    v_flex()
        .id("shop-calculation-console-card")
        .w_full()
        .gap_3()
        .p_4()
        .rounded(px(app_theme.radius_lg))
        .bg(app_theme.card_bg)
        .shadow(vec![app_theme.card_shadow_box()])
        .child(card_title(app_theme, "控制台"))
        .child(
            filter_bar::filter_bar_layout(app_theme)
                .child(filter_bar::filter_select(
                    app_theme,
                    "项目",
                    project_label.clone().into(),
                    "shop-calculation-project-select",
                    move |menu, _window, _cx| {
                        let mut menu = menu;
                        for name in &projects {
                            let checked = *name == project_label;
                            let view = view_for_project.clone();
                            let name = name.clone();
                            menu = menu.item(
                                PopupMenuItem::new(name.clone())
                                    .checked(checked)
                                    .on_click(move |_, _window, cx| {
                                        let view = view.clone();
                                        let name = name.clone();
                                        view.update(cx, |this, cx| this.select_project(&name, cx));
                                    }),
                            );
                        }
                        menu
                    },
                ))
                .child(filter_bar::filter_select(
                    app_theme,
                    "站点",
                    country_label(country).into(),
                    "shop-calculation-country-select",
                    move |menu, _window, _cx| {
                        let mut menu = menu;
                        for (value, label) in COUNTRY_OPTIONS {
                            let checked = country == value;
                            let view = view_for_country.clone();
                            menu = menu.item(
                                PopupMenuItem::new(label)
                                    .checked(checked)
                                    .on_click(move |_, _window, cx| {
                                        let view = view.clone();
                                        view.update(cx, |this, cx| this.select_country(value, cx));
                                    }),
                            );
                        }
                        menu
                    },
                ))
                .when_some(search_input, |el, input| {
                    el.child(div().w(px(220.)).child(Input::new(&input)))
                })
                .when(!keyword.trim().is_empty(), |el| {
                    el.child(
                        div()
                            .text_xs()
                            .text_color(app_theme.text_muted)
                            .child(format!("关键词: {}", keyword.trim())),
                    )
                })
                .when(list_loading, |el| {
                    el.child(state_views::loading_state(app_theme, "加载中…"))
                }),
        )
        .child(
            h_flex()
                .w_full()
                .gap_3()
                .children(vec![
                    stat_card(app_theme, "SKU", &stats.total.to_string(), app_theme.text_primary),
                    stat_card(
                        app_theme,
                        "已测算",
                        &stats.calculated.to_string(),
                        if stats.calculated > 0 { app_theme.success } else { app_theme.text_primary },
                    ),
                    stat_card(
                        app_theme,
                        "盈利",
                        &stats.profitable.to_string(),
                        if stats.profitable > 0 { app_theme.success } else { app_theme.text_primary },
                    ),
                    stat_card(
                        app_theme,
                        "盈利占比",
                        &if stats.calculated > 0 {
                            format!("{:.1}%", stats.pass_rate)
                        } else {
                            "—".to_string()
                        },
                        pass_color,
                    ),
                ]),
        )
}

/// 单张统计卡：标签 + 数值（数值可带强调色）
fn stat_card(app_theme: &AppTheme, label: &str, value: &str, value_color: gpui::Hsla) -> impl IntoElement {
    v_flex()
        .flex_1()
        .gap_1()
        .p_3()
        .rounded(px(app_theme.radius))
        .bg(app_theme.window_bg)
        .border_1()
        .border_color(app_theme.separator)
        .child(
            div()
                .text_xs()
                .text_color(app_theme.text_muted)
                .child(label.to_string()),
        )
        .child(
            div()
                .text_lg()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(value_color)
                .child(value.to_string()),
        )
}

/// SKU 主列表卡（左栏；DataTable + 加载 / 错误 / 引导空态）
fn render_master_card(
    app_theme: &AppTheme,
    table: Option<Entity<DataTable<SkuRow>>>,
    list_loading: bool,
    list_error: Option<String>,
    has_project: bool,
) -> impl IntoElement {
    v_flex()
        .id("shop-calculation-master-card")
        .flex_1()
        .min_w(px(560.))
        .gap_3()
        .p_4()
        .rounded(px(app_theme.radius_lg))
        .bg(app_theme.card_bg)
        .shadow(vec![app_theme.card_shadow_box()])
        .child(card_title(app_theme, "SKU 列表"))
        .when_some(list_error, |el, msg| {
            el.child(warn_banner(app_theme, "shop-calculation-list-error", &msg))
        })
        .child(if list_loading {
            state_views::loading_state(app_theme, "SKU 加载中…").into_any_element()
        } else if !has_project {
            div()
                .w_full()
                .py_10()
                .text_sm()
                .text_color(app_theme.text_muted)
                .text_center()
                .child("请选择项目以加载 SKU 数据")
                .into_any_element()
        } else {
            match &table {
                Some(table) => table.clone().into_any_element(),
                None => div()
                    .w_full()
                    .py_10()
                    .text_sm()
                    .text_color(app_theme.text_muted)
                    .text_center()
                    .child("暂无 SKU 数据")
                    .into_any_element(),
            }
        })
}

/// 测算面板（右栏 w480；选中 SKU 草稿输入 + 派生量提示 + 测算按钮 + 结果区）
#[allow(clippy::too_many_arguments)]
fn render_detail_panel(
    view: &Entity<ShopCalculationView>,
    cx: &mut Context<ShopCalculationView>,
    app_theme: &AppTheme,
    inputs: Option<Vec<Entity<InputState>>>,
    country: &'static str,
    selected: &Option<SkuRecordItem>,
    calc_phase: &RowPhase,
    last_run: Option<&PricingRunItem>,
) -> impl IntoElement {
    let Some(inputs) = inputs else {
        return v_flex().id("shop-calculation-detail-panel").w(px(480.)).into_any_element();
    };
    let view_for_submit = view.clone();
    let calculating = matches!(calc_phase, RowPhase::Calculating(_));

    let header = match selected {
        Some(item) => h_flex()
            .w_full()
            .gap_2()
            .items_center()
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(app_theme.text_primary)
                    .child(item.sku.clone()),
            )
            .when(!item.asin.is_empty(), |el| {
                el.child(
                    div()
                        .text_xs()
                        .text_color(app_theme.text_muted)
                        .child(format!("ASIN {}", item.asin)),
                )
            })
            .child(div().flex_1())
            .child(
                div()
                    .text_xs()
                    .text_color(app_theme.text_muted)
                    .child(country_label(country).to_string()),
            ),
        None => h_flex()
            .w_full()
            .child(
                div()
                    .text_sm()
                    .text_color(app_theme.text_muted)
                    .child("未选择 SKU"),
            ),
    };

    let mut panel = v_flex()
        .id("shop-calculation-detail-panel")
        .w(px(480.))
        .flex_shrink()
        .gap_3()
        .p_4()
        .rounded(px(app_theme.radius_lg))
        .bg(app_theme.card_bg)
        .shadow(vec![app_theme.card_shadow_box()])
        .child(card_title(app_theme, "测算"))
        .child(header);

    match selected {
        Some(_item) => {
            // 草稿字段网格（按站点裁剪可见字段；4 列紧凑排布）
            let fields: Vec<&DraftFieldDef> = DRAFT_FIELDS
                .iter()
                .filter(|f| f.key.visible_in_country(country))
                .collect();
            for chunk in fields.chunks(2) {
                let mut row = h_flex().w_full().gap_3();
                for field in chunk {
                    let ix = field.key.index();
                    let input = inputs.get(ix);
                    row = row.child(
                        v_flex()
                            .flex_1()
                            .gap_1()
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(app_theme.text_secondary)
                                    .child(field.label.to_string()),
                            )
                            .children(input.map(Input::new)),
                    );
                }
                panel = panel.child(row);
            }
            // 派生量提示（随键入实时；对齐 web 表单内计费重派生展示）
            let num = |key: DraftKey| -> f64 {
                inputs
                    .get(key.index())
                    .and_then(|input| input.read(cx).value().trim().parse::<f64>().ok())
                    .filter(|v| v.is_finite())
                    .unwrap_or(0.0)
            };
            let weight = num(DraftKey::WeightKg);
            let volume = chargeable_weight_kg(
                num(DraftKey::LengthCm),
                num(DraftKey::WidthCm),
                num(DraftKey::HeightCm),
                weight,
            );
            panel = panel.child(
                div()
                    .text_xs()
                    .text_color(app_theme.text_muted)
                    .child(format!(
                        "实重 {weight:.3} kg · 计费重 {volume:.3} kg（实重与体积重取大）"
                    )),
            );
            panel = panel
                .child(
                    Button::new("shop-calculation-submit")
                        .w_full()
                        .disabled(calculating)
                        .label(if calculating { "测算中…" } else { "开始测算" })
                        .on_click(move |_, _window, cx| {
                            let view = view_for_submit.clone();
                            view.update(cx, |this, cx| this.submit_calculation(cx));
                        }),
                )
                .children(last_run.map(|run| render_run_summary(app_theme, country, run)));
        }
        None => {
            panel = panel.child(
                div()
                    .w_full()
                    .py_10()
                    .text_sm()
                    .text_color(app_theme.text_muted)
                    .text_center()
                    .child("在左侧列表点击「编辑」选择 SKU 开始测算"),
            );
        }
    }
    panel.into_any_element()
}

/// 结果摘要（售价 / 回款 / 利润 / 利润率指标带 + 费用明细 + 核算规则 +
/// warnings；EU 追加增值税与扣税后利润行）
fn render_run_summary(app_theme: &AppTheme, country: &str, run: &PricingRunItem) -> impl IntoElement {
    let is_eu = country != "US";
    let profit = display_profit_from_parts(country, run.profit.profit_usd, run.profit.profit_after_vat_usd);
    let profit_rate = if is_eu {
        run.profit.profit_after_vat_rate.unwrap_or(run.profit.profit_rate)
    } else {
        run.profit.profit_rate
    };
    let profit_color = if profit >= 0.0 { app_theme.success } else { app_theme.danger };

    let mut fees: Vec<(&str, String)> = vec![
        ("平台佣金", fmt_usd(run.fees.referral_fee_usd)),
        ("广告费", fmt_usd(run.fees.advertising_fee_usd)),
        ("退货损耗", fmt_usd(run.fees.return_loss_usd)),
        ("派送", fmt_usd(run.fees.fba_fulfillment_fee_usd)),
        ("入库配置", fmt_usd(run.fees.inbound_config_fee_usd)),
        ("仓储费", fmt_usd(run.fees.storage_fee_usd)),
    ];
    if is_eu {
        fees.push(("平台佣金(EU)", fmt_usd(run.fees.platform_fee_usd)));
    }
    let rules = [
        ("尺寸等级", run.size_tier_label.clone()),
        ("售价带", run.price_band_label.clone()),
        ("计费重", format!("{:.2} lb", run.weights.chargeable_weight_lb)),
        ("体积", format!("{:.2} ft³", run.dimensions.volume_cubic_ft)),
        ("派送规则", run.fulfillment_fee_rule_label.clone()),
        (
            "汇率",
            format!(
                "{:.4}（{}）",
                run.usd_to_rmb_rate,
                if run.usd_to_rmb_rate_source.is_empty() { "-" } else { &run.usd_to_rmb_rate_source }
            ),
        ),
    ];

    v_flex()
        .id("shop-calculation-run-summary")
        .w_full()
        .gap_3()
        .pt_2()
        .border_t_1()
        .border_color(app_theme.separator)
        // 指标带
        .child(
            h_flex()
                .w_full()
                .gap_2()
                .child(metric_block(app_theme, "售价", &fmt_usd(run.sale_price_usd), app_theme.text_primary))
                .child(metric_block(app_theme, "回款", &fmt_usd(run.profit.payout_usd), app_theme.text_primary))
                .child(metric_block(app_theme, "利润", &fmt_usd(profit), profit_color))
                .child(metric_block(app_theme, "利润率", &fmt_percent(profit_rate), profit_color)),
        )
        // DDP 成本行
        .child(
            h_flex()
                .w_full()
                .gap_2()
                .text_xs()
                .text_color(app_theme.text_secondary)
                .child(div().child(format!("FOB RMB {:.2}", run.fob_product_cost_rmb)))
                .child(div().child(format!("头程 RMB {:.2}", run.first_leg_cost_rmb)))
                .child(div().child(format!("DDP RMB {:.2}", run.profit.ddp_cost_rmb)))
                .child(div().child(format!("≈ {}", fmt_usd(run.profit.ddp_cost_usd)))),
        )
        .when(is_eu, |el| {
            el.child(
                h_flex()
                    .w_full()
                    .justify_between()
                    .px_2()
                    .py_1()
                    .rounded(px(app_theme.radius))
                    .bg(app_theme.muted_fill)
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(app_theme.text_primary)
                            .child(format!(
                                "增值税 / 扣税后利润 {}",
                                fmt_usd(run.profit.vat_usd)
                            )),
                    )
                    .child(
                        div()
                            .text_xs()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(profit_color)
                            .child(fmt_usd(run.profit.profit_after_vat_usd.unwrap_or(profit))),
                    ),
            )
        })
        // 费用明细
        .child(section_label(app_theme, "费用明细"))
        .child(kv_grid(app_theme, &fees))
        .child(
            h_flex()
                .w_full()
                .justify_between()
                .px_2()
                .py_1()
                .rounded(px(app_theme.radius))
                .bg(app_theme.muted_fill)
                .child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(app_theme.text_primary)
                        .child("费用合计"),
                )
                .child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(app_theme.text_primary)
                        .child(fmt_usd(run.fees.total_fee_usd)),
                ),
        )
        // 核算规则
        .child(section_label(app_theme, "核算规则"))
        .child(kv_grid(app_theme, &rules))
        // warnings
        .when(!run.warnings.is_empty(), |el| {
            el.child(
                v_flex()
                    .id("shop-calculation-run-warnings")
                    .w_full()
                    .gap_1()
                    .children(run.warnings.iter().map(|warning| {
                        h_flex()
                            .w_full()
                            .gap_2()
                            .items_center()
                            .px_3()
                            .py_2()
                            .rounded(px(app_theme.radius))
                            .border_1()
                            .border_color(app_theme.warning.opacity(0.4))
                            .bg(app_theme.warning.opacity(0.1))
                            .child(
                                Icon::new(IconName::TriangleAlert)
                                    .with_size(px(13.))
                                    .text_color(app_theme.warning),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(app_theme.text_primary)
                                    .child(warning.clone()),
                            )
                    })),
            )
        })
}

/// 指标小块（label + 数值，数值色由调用方给定——利润涨绿跌红）
fn metric_block(app_theme: &AppTheme, label: &str, value: &str, value_color: gpui::Hsla) -> impl IntoElement {
    v_flex()
        .flex_1()
        .gap_1()
        .p_2()
        .rounded(px(app_theme.radius))
        .bg(app_theme.window_bg)
        .child(
            div()
                .text_xs()
                .text_color(app_theme.text_muted)
                .child(label.to_string()),
        )
        .child(
            div()
                .text_sm()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(value_color)
                .child(value.to_string()),
        )
}

/// 小节 label
fn section_label(app_theme: &AppTheme, text: &str) -> impl IntoElement {
    div()
        .text_xs()
        .text_color(app_theme.text_muted)
        .child(text.to_string())
}

/// 键值两列网格（费用明细 / 核算规则共用）
fn kv_grid(app_theme: &AppTheme, items: &[(&str, String)]) -> impl IntoElement {
    div()
        .w_full()
        .grid()
        .grid_cols(2)
        .gap_1()
        .children(items.iter().map(|(label, value)| {
            h_flex()
                .w_full()
                .justify_between()
                .gap_2()
                .px_2()
                .py(px(3.0))
                .child(
                    div()
                        .text_xs()
                        .text_color(app_theme.text_secondary)
                        .child(label.to_string()),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(app_theme.text_primary)
                        .child(value.clone()),
                )
        }))
}

// ---------------------------------------------------------------------------
// 表格列定义
// ---------------------------------------------------------------------------

/// SKU 表列（SKU / ASIN / 尺寸 / 重量 / FOB / 头程 / 售价 / 利润 / 利润率 /
/// 状态 / 操作；操作列闭包捕获视图实体——编辑回连）
fn sku_columns(view: Entity<ShopCalculationView>) -> Vec<ColumnDef<SkuRow>> {
    let view_for_actions = view.clone();
    vec![
        ColumnDef::text("sku-name", "SKU", |row: &SkuRow, _| {
            let prefix = if row.selected { "✓ " } else { "" };
            SharedString::from(format!("{prefix}{}", row.item.sku))
        })
        .width(150.0),
        ColumnDef::text("sku-asin", "ASIN", |row: &SkuRow, _| {
            SharedString::from(if row.item.asin.is_empty() {
                "-".to_string()
            } else {
                row.item.asin.clone()
            })
        })
        .width(110.0),
        ColumnDef::text("sku-dims", "尺寸(cm)", |row: &SkuRow, _| {
            SharedString::from(format!(
                "{:.0}×{:.0}×{:.0}",
                row.item.package_length_cm, row.item.package_width_cm, row.item.package_height_cm
            ))
        })
        .width(96.0),
        ColumnDef::number(
            "sku-weight",
            "重量(kg)",
            |row: &SkuRow| row.item.weight_kg,
            |row: &SkuRow, _| SharedString::from(format!("{:.2}", row.item.weight_kg)),
        )
        .width(76.0),
        ColumnDef::number(
            "sku-fob",
            "FOB(RMB)",
            |row: &SkuRow| row.item.fob_unit_cost,
            |row: &SkuRow, _| SharedString::from(format!("{:.2}", row.item.fob_unit_cost)),
        )
        .width(84.0),
        ColumnDef::number(
            "sku-first-leg",
            "头程(RMB)",
            |row: &SkuRow| row.item.first_leg_cost_rmb,
            |row: &SkuRow, _| SharedString::from(format!("{:.2}", row.item.first_leg_cost_rmb)),
        )
        .width(84.0),
        ColumnDef::number(
            "sku-sale-price",
            "售价",
            |row: &SkuRow| row.display.map(|d| d.0).unwrap_or(f64::NAN),
            |row: &SkuRow, _| {
                SharedString::from(row.display.map(|d| fmt_usd(d.0)).unwrap_or_else(|| "-".into()))
            },
        )
        .width(80.0),
        ColumnDef::number(
            "sku-profit",
            "利润",
            |row: &SkuRow| row.display.map(|d| d.1).unwrap_or(f64::NAN),
            |row: &SkuRow, _| {
                SharedString::from(row.display.map(|d| fmt_usd(d.1)).unwrap_or_else(|| "-".into()))
            },
        )
        .width(88.0)
        .with_render_element(|row, theme| match row.display {
            Some((_, profit, _)) => {
                let color = if profit >= 0.0 { theme.success } else { theme.danger };
                div()
                    .w_full()
                    .text_right()
                    .text_color(color)
                    .child(fmt_usd(profit))
                    .into_any_element()
            }
            None => div().w_full().text_right().child("-").into_any_element(),
        }),
        ColumnDef::number(
            "sku-profit-rate",
            "利润率",
            |row: &SkuRow| row.display.map(|d| d.2).unwrap_or(f64::NAN),
            |row: &SkuRow, _| {
                SharedString::from(row.display.map(|d| fmt_percent(d.2)).unwrap_or_else(|| "-".into()))
            },
        )
        .width(76.0)
        .with_render_element(|row, theme| match row.display {
            Some((_, profit, rate)) => {
                let color = if profit >= 0.0 { theme.success } else { theme.danger };
                div()
                    .w_full()
                    .text_right()
                    .text_color(color)
                    .child(fmt_percent(rate))
                    .into_any_element()
            }
            None => div().w_full().text_right().child("-").into_any_element(),
        }),
        ColumnDef::text("sku-status", "状态", |row: &SkuRow, _| {
            SharedString::from(if row.display.is_some() { "已测算" } else { "未测算" })
        })
        .width(72.0),
        ColumnDef::text("sku-actions", "操作", |_row: &SkuRow, _| SharedString::from(""))
            .width(84.0)
            .align(CellAlign::Right)
            .with_render_element(move |row, _theme| {
                let sku_id = row.item.id;
                let view_for_edit = view_for_actions.clone();
                h_flex()
                    .w_full()
                    .gap_1()
                    .justify_end()
                    .child(
                        Button::new(SharedString::from(format!("sku-edit-{sku_id}")))
                            .outline()
                            .xsmall()
                            .label(if row.selected { "已选中 ✓" } else { "编辑" })
                            .on_click(move |_, _window, cx| {
                                let view = view_for_edit.clone();
                                view.update(cx, |this, cx| this.select_sku(sku_id, cx));
                            }),
                    )
                    .into_any_element()
            }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    use gui_domain::operations::new_product_calculation::{
        PricingDimensions, PricingFees, PricingProfit, PricingWeights,
    };
    use gui_domain::operations::shop_calculation::{ShopFees, ShopProfit};

    // ---------- 样本数据 ----------

    /// SKU 档案样本
    fn sample_sku(id: i64, sku: &str, asin: &str, country: &str) -> SkuRecordItem {
        serde_json::from_str(&format!(
            r#"{{
                "id": {id}, "project_name": "测试项目 A", "sku": "{sku}",
                "asin": "{asin}", "fob_unit_cost": 45.0,
                "first_leg_cost_rmb": 8.5, "package_length_cm": 30.0,
                "package_width_cm": 20.0, "package_height_cm": 10.0,
                "weight_kg": 1.2, "currency": "USD", "country": "{country}",
                "sort_order": 0, "is_active": true
            }}"#
        ))
        .expect("SKU 样本解析失败")
    }

    /// 店铺测算历史样本（US 盈利）
    fn sample_saved(id: i64, sku: &str, country: &str) -> ShopCalculationItem {
        serde_json::from_str(&format!(
            r#"{{
                "id": {id}, "project_id": 3, "project_name": "测试项目 A",
                "sku": "{sku}", "asin": null, "country": "{country}",
                "accounting_type": "profit_calc",
                "package_length_cm": 30.0, "package_width_cm": 20.0,
                "package_height_cm": 10.0, "weight_kg": 1.2,
                "fob_product_cost_rmb": 45.0, "first_leg_cost_rmb": 8.5,
                "ddp_cost_rmb": 106.3, "ddp_cost_usd": 14.87,
                "sale_price_usd": 29.99, "advertising_rate": 0.12,
                "return_loss_rate": 0.04, "storage_months": 1.0,
                "inbound_placement_mode": "single_destination",
                "usd_to_rmb_rate": 7.15, "usd_to_rmb_rate_source": "system",
                "size_tier": "standard", "size_tier_label": "标准尺寸",
                "price_band": "20_50", "price_band_label": "$20-$50",
                "fulfillment_fee_rule_label": "FBA 标准",
                "inbound_config_fee_rule_label": "入库配置",
                "storage_fee_rule_label": "仓储规则",
                "dimensions": {{
                    "longest_side_in": 11.81, "middle_side_in": 7.87,
                    "shortest_side_in": 3.94, "length_plus_girth_in": 35.43,
                    "volume_cubic_in": 366.14, "volume_cubic_ft": 0.21
                }},
                "weights": {{
                    "product_weight_lb": 2.65, "product_weight_oz": 42.33,
                    "dimensional_weight_lb": 1.27, "chargeable_weight_lb": 2.65,
                    "chargeable_weight_oz": 42.33, "chargeable_weight_rule": "取大"
                }},
                "fees": {{
                    "referral_fee_usd": 4.5, "advertising_fee_usd": 3.6,
                    "return_loss_usd": 1.2, "fba_fulfillment_fee_usd": 5.4,
                    "inbound_config_fee_usd": 0.3, "storage_fee_usd": 0.1,
                    "total_fee_usd": 15.1
                }},
                "profit": {{
                    "ddp_cost_rmb": 106.3, "ddp_cost_usd": 14.87,
                    "payout_usd": 25.49, "profit_usd": 10.62, "profit_rate": 0.354
                }},
                "warnings": [],
                "observed_at": "2026-08-22T08:00:00Z", "source": "manual",
                "created_at": "2026-08-22T08:00:00Z",
                "updated_at": "2026-08-22T08:00:00Z"
            }}"#
        ))
        .expect("历史样本解析失败")
    }

    /// 测算 run 样本（EU 带 VAT 扩展）
    fn sample_run(id: i64, profit: f64, after_vat: Option<f64>, after_rate: Option<f64>) -> PricingRunItem {
        PricingRunItem {
            id,
            country: "DE".into(),
            product_name: "测试项目 A / SKU-1".into(),
            calculation_type: gui_domain::operations::new_product_calculation::CalculationType::EuAccounting,
            project_id: Some(3),
            sku: Some("SKU-1".into()),
            package_length_cm: 30.0,
            package_width_cm: 20.0,
            package_height_cm: 10.0,
            weight_kg: 1.2,
            fob_product_cost_rmb: 45.0,
            first_leg_cost_rmb: 8.5,
            first_leg_unit_price_rmb_per_kg: None,
            sale_price_usd: 29.99,
            commission_rate: 0.15,
            advertising_rate: 0.12,
            return_loss_rate: 0.04,
            storage_months: 1.0,
            inbound_placement_mode: InboundPlacementMode::SingleDestination,
            size_tier: "standard".into(),
            size_tier_label: "标准尺寸".into(),
            price_band: "20_50".into(),
            price_band_label: "$20-$50".into(),
            usd_to_rmb_rate: 7.15,
            usd_to_rmb_rate_source: "system".into(),
            fulfillment_fee_rule_label: "EU 规则".into(),
            inbound_config_fee_rule_label: "入库配置".into(),
            storage_fee_rule_label: "仓储规则".into(),
            dimensions: PricingDimensions {
                longest_side_in: 11.81,
                middle_side_in: 7.87,
                shortest_side_in: 3.94,
                length_plus_girth_in: 35.43,
                volume_cubic_in: 366.14,
                volume_cubic_ft: 0.21,
            },
            weights: PricingWeights {
                product_weight_lb: 2.65,
                product_weight_oz: 42.33,
                dimensional_weight_lb: 1.27,
                chargeable_weight_lb: 2.65,
                chargeable_weight_oz: 42.33,
                chargeable_weight_rule: "取大".into(),
            },
            fees: PricingFees {
                referral_fee_usd: 4.5,
                advertising_fee_usd: 3.6,
                return_loss_usd: 1.2,
                fba_fulfillment_fee_usd: 5.4,
                inbound_config_fee_usd: 0.3,
                storage_fee_usd: 0.1,
                total_fee_usd: 15.1,
                platform_fee_usd: 4.5,
            },
            profit: PricingProfit {
                ddp_cost_rmb: 106.3,
                ddp_cost_usd: 14.87,
                payout_usd: 25.49,
                profit_usd: profit,
                profit_rate: 0.083,
                vat_usd: 4.84,
                profit_after_vat_usd: after_vat,
                profit_after_vat_rate: after_rate,
                delivery_fee_usd: 0.0,
                full_container_quantity: 0.0,
                full_container_price_rmb: 0.0,
            },
            warnings: vec![],
            created_by: None,
            created_at: "2026-08-18T10:00:00Z".into(),
            updated_at: "2026-08-18T10:00:00Z".into(),
            delivery_fee_usd: 0.0,
            full_container_quantity: 0.0,
            full_container_price_rmb: 0.0,
            competitor_url: None,
        }
    }

    // ---------- 常量 / 字段注册表 ----------

    #[test]
    fn constants_match_web() {
        assert_eq!(SHOP_CALCULATION_URL, "/dashboard/reports/pricing-calculation/shop-calculation");
        assert_eq!(DEFAULT_COUNTRY, "US");
        assert_eq!(COUNTRY_OPTIONS.map(|(v, _)| v), ["US", "DE", "UK"]);
        assert_eq!(SKU_PAGE_SIZE, 200);
        assert_eq!(country_label("UK"), "英国站 (UK)");
        assert_eq!(country_label("XX"), "美国站 (US)");
        // 汇率币种映射（web DE→EUR / UK→GBP）
        assert_eq!(currency_for_country("US"), "USD");
        assert_eq!(currency_for_country("DE"), "EUR");
        assert_eq!(currency_for_country("UK"), "GBP");
    }

    /// 草稿字段注册表：13 项 + 站点可见性矩阵（仓储月数 US 专属、
    /// 三手动费用 EU 专属）+ 默认值对齐 web 新行口径
    #[test]
    fn draft_fields_registry_and_visibility() {
        assert_eq!(DRAFT_FIELDS.len(), 13);
        for (ix, field) in DRAFT_FIELDS.iter().enumerate() {
            assert_eq!(field.key.index(), ix);
        }
        assert_eq!(DRAFT_FIELDS[DraftKey::FirstLegRmb.index()].default, "5");
        assert_eq!(DRAFT_FIELDS[DraftKey::AdvertisingRate.index()].default, "12");
        assert_eq!(DRAFT_FIELDS[DraftKey::ReturnLossRate.index()].default, "4");
        assert_eq!(DRAFT_FIELDS[DraftKey::StorageMonths.index()].default, "1");

        // US 可见：通用 + 仓储月数；不可见：三手动费用
        assert!(DraftKey::StorageMonths.visible_in_country("US"));
        assert!(!DraftKey::DeliveryFeeUsd.visible_in_country("US"));
        assert!(!DraftKey::InboundConfigFeeUsd.visible_in_country("US"));
        assert!(!DraftKey::StorageFeeUsd.visible_in_country("US"));
        // EU 可见：通用 + 三手动费用；不可见：仓储月数
        assert!(!DraftKey::StorageMonths.visible_in_country("DE"));
        assert!(DraftKey::DeliveryFeeUsd.visible_in_country("DE"));
        assert!(DraftKey::InboundConfigFeeUsd.visible_in_country("UK"));
        assert!(DraftKey::SalePriceUsd.visible_in_country("US"));
        assert!(DraftKey::UsdToRmbRate.visible_in_country("UK"));
    }

    // ---------- 纯函数 ----------

    /// 计费重（实重 vs 体积重取大）
    #[test]
    fn chargeable_weight_matches_web() {
        assert!((chargeable_weight_kg(30.0, 20.0, 10.0, 1.2) - 1.2).abs() < 1e-9);
        assert!((chargeable_weight_kg(30.0, 20.0, 10.0, 0.5) - 1.0).abs() < 1e-9);
    }

    /// 展示口径利润：US 直取税前；EU 缺扣税后回退税前
    #[test]
    fn display_profit_country_semantics() {
        assert_eq!(display_profit_from_parts("US", 10.0, Some(-2.0)), 10.0);
        assert_eq!(display_profit_from_parts("DE", 10.0, Some(-2.0)), -2.0);
        assert_eq!(display_profit_from_parts("UK", 10.0, None), 10.0);
    }

    /// 草稿初值：已存历史 > SKU 档案 > 默认；系统汇率优先于历史汇率
    #[test]
    fn build_draft_values_prefers_saved_then_archive() {
        let item = sample_sku(1, "SKU-1", "B0TEST01", "US");
        let saved = sample_saved(11, "SKU-1", "US");

        // 有历史 + 有系统汇率：尺寸 / 价格 / 费率取历史，汇率取系统
        let values = build_draft_values(&item, Some(&saved), "7.31");
        assert_eq!(values[DraftKey::LengthCm.index()], "30");
        assert_eq!(values[DraftKey::FirstLegRmb.index()], "8.5");
        assert_eq!(values[DraftKey::SalePriceUsd.index()], "29.99");
        assert_eq!(values[DraftKey::AdvertisingRate.index()], "12.00");
        assert_eq!(values[DraftKey::ReturnLossRate.index()], "4.00");
        assert_eq!(values[DraftKey::StorageMonths.index()], "1");
        assert_eq!(values[DraftKey::UsdToRmbRate.index()], "7.31");

        // 无历史：档案兜底（头程档案有值 8.5 不落默认 5），价格空、费率默认
        let values = build_draft_values(&item, None, "");
        assert_eq!(values[DraftKey::LengthCm.index()], "30");
        assert_eq!(values[DraftKey::FirstLegRmb.index()], "8.5");
        assert_eq!(values[DraftKey::SalePriceUsd.index()], "");
        assert_eq!(values[DraftKey::AdvertisingRate.index()], "12");
        assert_eq!(values[DraftKey::ReturnLossRate.index()], "4");
        assert_eq!(values[DraftKey::StorageMonths.index()], "1");
        assert_eq!(values[DraftKey::UsdToRmbRate.index()], "");

        // 无历史且档案头程为 0 → 默认 5（web `'5'` 分支）
        let mut raw = sample_sku(2, "SKU-2", "", "US");
        raw.first_leg_cost_rmb = 0.0;
        let values = build_draft_values(&raw, None, "");
        assert_eq!(values[DraftKey::FirstLegRmb.index()], "5");

        // EU：手动费用取历史 fees（无历史 → 0）
        let values = build_draft_values(&item, Some(&saved), "8.02");
        assert_eq!(values[DraftKey::DeliveryFeeUsd.index()], "0");
        assert_eq!(values[DraftKey::UsdToRmbRate.index()], "8.02");
    }

    /// 统计计算：关键词过滤作用于总数；已测算 / 盈利用展示口径；
    /// 会话结果优先于历史
    #[test]
    fn compute_stats_counts_visible_and_calculated() {
        let skus = vec![
            sample_sku(1, "SKU-A", "B0A", "US"),
            sample_sku(2, "SKU-B", "B0B", "US"),
            sample_sku(3, "SKU-C", "B0C", "US"),
        ];
        let mut saved = HashMap::new();
        saved.insert("SKU-A".to_string(), sample_saved(11, "SKU-A", "US")); // 盈利 10.62
        let results = HashMap::new();

        let stats = compute_stats(&skus, &saved, &results, "", "US");
        assert_eq!(stats.total, 3);
        assert_eq!(stats.calculated, 1);
        assert_eq!(stats.profitable, 1);
        assert!((stats.pass_rate - 100.0).abs() < 1e-9);

        // 关键词命中 1 条（已测算那条）→ 总数 1
        let stats = compute_stats(&skus, &saved, &results, "SKU-A", "US");
        assert_eq!(stats.total, 1);
        assert_eq!(stats.calculated, 1);

        // asin 命中
        let stats = compute_stats(&skus, &saved, &results, "b0b", "US");
        assert_eq!(stats.total, 1);
        assert_eq!(stats.calculated, 0);

        // 会话结果（亏损 EU 扣税后）覆盖历史盈利
        let mut results = HashMap::new();
        results.insert(1, sample_run(101, 2.49, Some(-2.35), Some(-0.078)));
        let stats = compute_stats(&skus, &saved, &results, "", "DE");
        assert_eq!(stats.total, 3);
        assert_eq!(stats.calculated, 1);
        assert_eq!(stats.profitable, 0, "EU 扣税后亏损应计入非盈利");
    }

    // ---------- 视图行为（无网络） ----------

    /// 建视图（client 指向 127.0.0.1:1 快速失败）
    macro_rules! new_view {
        ($cx:expr) => {
            $cx.add_window_view(|_window, cx| {
                ShopCalculationView::new(cx, Client::new("http://127.0.0.1:1"))
            })
        };
    }

    /// 项目 / 站点落点与选择清空语义
    #[gpui::test]
    async fn project_and_country_selection_resets_session(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = new_view!(cx);
        view.update(cx2, |this, cx| {
            // 项目列表落点
            let projects = vec![ManagedProject {
                id: 3,
                name: "测试项目 A".into(),
                ..Default::default()
            }];
            this.apply_projects_result(Ok(projects), cx);
            assert!(matches!(this.current_state(cx), ShopPageState::Loaded));

            // 选择项目
            this.select_project("测试项目 A", cx);
            assert_eq!(this.project_id, Some(3));

            // 会话选择存在时切换站点 → 清空
            this.selected_sku_id = Some(9);
            this.select_country("DE", cx);
            assert_eq!(this.country, "DE");
            assert_eq!(this.selected_sku_id, None);

            // 同站点 no-op
            this.select_country("DE", cx);
            assert_eq!(this.country, "DE");

            // 同项目 no-op
            this.select_project("测试项目 A", cx);
            assert_eq!(this.project_id, Some(3));
        });
    }

    /// 空项目列表 → 页面级 Empty；错误 → Error 落点
    #[gpui::test]
    async fn projects_landing_states(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = new_view!(cx);
        view.update(cx2, |this, cx| {
            this.apply_projects_result(Ok(vec![]), cx);
            assert!(matches!(this.current_state(cx), ShopPageState::Empty));

            this.reload(cx);
            assert!(matches!(this.current_state(cx), ShopPageState::Loading));
            this.apply_projects_result(Err("连接失败".into()), cx);
            assert!(matches!(this.current_state(cx), ShopPageState::Error(_)));
        });
    }

    /// 列表落点：SKU 成功 + 历史失败 → 琥珀提示 + 表格仍构建；
    /// SKU 失败 → 红横幅 + 表清空；过期响应丢弃
    #[gpui::test]
    async fn list_result_landing_and_race_guard(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = new_view!(cx);
        view.update(cx2, |this, cx| {
            this.projects = vec![ManagedProject { id: 3, name: "测试项目 A".into(), ..Default::default() }];
            this.project_id = Some(3);

            let page: gui_domain::operations::shop_calculation::SkuRecordsPage =
                serde_json::from_str(
                    r#"{"items": [
                        {"id": 1, "project_name": "测试项目 A", "sku": "SKU-A", "asin": "B0A",
                         "country": "US", "is_active": true},
                        {"id": 2, "project_name": "测试项目 A", "sku": "SKU-B", "asin": "",
                         "country": "US", "is_active": false}
                    ], "page": 1, "page_size": 200, "total": 2, "has_next": false}"#,
                )
                .expect("解析失败");
            let saved_err = Err("店铺历史接口 500".to_string());
            this.latest_list_id += 1;
            this.apply_list_result(
                this.latest_list_id,
                (Ok(page), Some(7.31), saved_err),
                cx,
            );

            assert_eq!(this.skus.len(), 1, "is_active=false 应被复筛掉");
            assert_eq!(this.system_rate, "7.31");
            assert!(this.warn_error.is_some(), "历史失败 → 琥珀提示");
            assert!(this.table.is_some(), "表格应构建");

            // 过期响应丢弃
            let stale_id = this.latest_list_id;
            this.latest_list_id += 1;
            this.apply_list_result(
                stale_id,
                (
                    Err("过期响应".to_string()),
                    None,
                    Err("过期".to_string()),
                ),
                cx,
            );
            assert!(this.list_error.is_none(), "过期响应不应落点");
        });
    }

    /// 选中 SKU：草稿载荷生成 + 结果面板回填（last_run 从会话结果恢复）
    #[gpui::test]
    async fn select_sku_prepares_draft_and_restores_last_run(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = new_view!(cx);
        view.update(cx2, |this, cx| {
            this.country = "US";
            this.skus = vec![sample_sku(1, "SKU-A", "B0A", "US")];
            let mut saved = HashMap::new();
            saved.insert("SKU-A".to_string(), sample_saved(11, "SKU-A", "US"));
            this.saved = saved;
            this.sync_table(cx);

            this.select_sku(1, cx);
            assert_eq!(this.selected_sku_id, Some(1));
            let values = this.pending_load.take().expect("应生成草稿载荷");
            assert_eq!(values.len(), DRAFT_FIELDS.len());
            assert_eq!(values[DraftKey::LengthCm.index()], "30");

            // 再次选中（幂等路径）
            this.select_sku(1, cx);
            assert_eq!(this.selected_sku_id, Some(1));

            // 不存在的 id no-op
            this.select_sku(999, cx);
            assert_eq!(this.selected_sku_id, Some(1));
        });
    }

    /// 渲染冒烟：Loaded 全帧（含控制台卡 / 表格 / 面板 + 结果摘要 + warnings）
    #[gpui::test]
    async fn view_draws_full_frame_loaded(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, vcx) = new_view!(cx);
        view.update(vcx, |this, cx| {
            let projects = vec![ManagedProject { id: 3, name: "测试项目 A".into(), ..Default::default() }];
            this.apply_projects_result(Ok(projects), cx);
            this.project_id = Some(3);
            this.country = "US";
            this.skus = vec![
                sample_sku(1, "SKU-A", "B0A", "US"),
                sample_sku(2, "SKU-B", "B0B", "US"),
            ];
            let mut saved = HashMap::new();
            saved.insert("SKU-A".to_string(), sample_saved(11, "SKU-A", "US"));
            this.saved = saved;
            this.warn_error = Some("店铺历史加载失败：HTTP 500".into());
            this.select_sku(1, cx);
            this.sync_table(cx);
        });
        vcx.draw(
            gpui::point(px(0.0), px(0.0)),
            gpui::Size::new(
                gpui::AvailableSpace::MaxContent,
                gpui::AvailableSpace::MaxContent,
            ),
            |_, _| view.clone(),
        );
    }

    /// 渲染冒烟：亮色 Loading（初始态）
    #[gpui::test]
    async fn view_renders_loading_in_light_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let (view, vcx) = new_view!(cx);
        vcx.draw(
            gpui::point(px(0.0), px(0.0)),
            gpui::Size::new(
                gpui::AvailableSpace::MaxContent,
                gpui::AvailableSpace::MaxContent,
            ),
            |_, _| view.clone(),
        );
        vcx.read(|app| assert!(!crate::theme::AppTheme::current(app).is_dark()));
    }

    /// 渲染冒烟：暗色 Error 态 + reduce_motion
    #[gpui::test]
    async fn view_renders_error_in_dark_mode_with_reduce_motion(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
            cx.set_global(crate::motion::MotionPref(true));
        });
        let (view, vcx) = new_view!(cx);
        view.update(vcx, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = ShopPageState::Error("连接失败".into());
            });
        });
        vcx.draw(
            gpui::point(px(0.0), px(0.0)),
            gpui::Size::new(
                gpui::AvailableSpace::MaxContent,
                gpui::AvailableSpace::MaxContent,
            ),
            |_, _| view.clone(),
        );
        vcx.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    /// 渲染冒烟：Empty（无可访问项目）页面级空态
    #[gpui::test]
    async fn view_renders_empty_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, vcx) = new_view!(cx);
        view.update(vcx, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = ShopPageState::Empty;
            });
        });
        vcx.draw(
            gpui::point(px(0.0), px(0.0)),
            gpui::Size::new(
                gpui::AvailableSpace::MaxContent,
                gpui::AvailableSpace::MaxContent,
            ),
            |_, _| view.clone(),
        );
    }

    /// 渲染冒烟：EU 站点全帧（草稿含手动费用字段 + VAT 结果行）
    #[gpui::test]
    async fn view_draws_frame_for_eu_country(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, vcx) = new_view!(cx);
        view.update(vcx, |this, cx| {
            let projects = vec![ManagedProject { id: 3, name: "测试项目 A".into(), ..Default::default() }];
            this.apply_projects_result(Ok(projects), cx);
            this.project_id = Some(3);
            this.country = "DE";
            this.skus = vec![sample_sku(1, "SKU-DE-1", "", "DE")];
            this.results.insert(1, sample_run(101, 2.49, Some(-2.35), Some(-0.078)));
            this.select_sku(1, cx);
            this.sync_table(cx);
        });
        vcx.draw(
            gpui::point(px(0.0), px(0.0)),
            gpui::Size::new(
                gpui::AvailableSpace::MaxContent,
                gpui::AvailableSpace::MaxContent,
            ),
            |_, _| view.clone(),
        );
    }

    /// ShopFees / ShopProfit serde 往返冒烟（domain 层补充覆盖）
    #[test]
    fn shop_fees_profit_serde_roundtrip() {
        let fees = ShopFees {
            referral_fee_usd: 4.5,
            advertising_fee_usd: 3.6,
            return_loss_usd: 1.2,
            fba_fulfillment_fee_usd: 3.2,
            inbound_config_fee_usd: 0.3,
            storage_fee_usd: 0.1,
            total_fee_usd: 13.0,
            delivery_fee_usd: 3.2,
            inbound_config_fee_manual_usd: 0.3,
            storage_fee_manual_usd: 0.1,
            platform_fee_usd: 4.5,
        };
        let json = serde_json::to_string(&fees).expect("序列化失败");
        let back: ShopFees = serde_json::from_str(&json).expect("反序列化失败");
        assert_eq!(back, fees);

        let profit = ShopProfit {
            ddp_cost_rmb: 106.3,
            ddp_cost_usd: 14.87,
            payout_usd: 25.49,
            profit_usd: 2.49,
            profit_rate: 0.083,
            vat_usd: 4.84,
            profit_after_vat_usd: Some(-2.35),
            profit_after_vat_rate: Some(-0.078),
        };
        let json = serde_json::to_string(&profit).expect("序列化失败");
        let back: ShopProfit = serde_json::from_str(&json).expect("反序列化失败");
        assert_eq!(back, profit);
        assert_eq!(back.display_profit_usd("DE"), -2.35);
    }
}
