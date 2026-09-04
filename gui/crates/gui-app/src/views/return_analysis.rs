//! 运营 → 退货分析视图（P5-1，BLF-715）
//!
//! frontend `app/dashboard/operations/return-analysis/return-analysis-client.tsx`
//! 的 GPUI 等价：项目 / 站点 / 日期筛选 + 汇总数字带 + 7 个 tab
//! （高退货排行 / 退货原因 / 退货趋势 / 商品状态 / 库存状态 / 顾客反馈 /
//! AI 总结）。
//!
//! 架构（复用 Phase 1~5 基建）：
//! - **四态状态机**：`Loading / Loaded / Empty / Error`（沿用 `dashboard.rs` /
//!   `ad_analysis.rs` 模式），`latest_request_id` 竞态保护；
//! - **数据管线**：`list_managed_projects` + `return_analysis`（近 7 天窗口，
//!   对齐 GUI 其余页面的固定周期口径）；
//! - **筛选**：项目 Select + 站点 Select（US/DE/UK）+ 日期区间选择器（公共
//!   `DateRangePickerState`）+ 刷新；未选项目时自动选中第一个（对齐 frontend
//!   `useAutoSelectFirstProject`）；
//! - **公共组件**（P5-0）：表格全部用 `DataTable`，筛选用 `filter_select` 同款
//!   下拉构建，日期用 `DateRangePickerState`，占比图用 `donut_share_chart` +
//!   `share_legend`；
//! - **动效**：Loaded 用 `enter_fade_in`（`reduce_motion` 尊重）。
//!
//! 已知差异（GPUI 能力边界，说明取舍）：
//! - web 趋势 tab 为「柱状（销售/退货）+ 折线（退货率）双 Y 轴」组合图；
//!   gpui-component chart 无双 Y 轴 / ComposedChart → 改用双序列面积图
//!   （销售数量 + 退货单数共用轴）+ 每日明细表 + 头部最新退货率统计；
//! - web 排行表「退货周期」为两级表头（rowSpan/colSpan）→ 拍平为单行表头
//!   （平均周期 / 最快周期 / 最慢周期）；
//! - 商品状态 / 库存状态 web 右侧「图表展示区域（可扩展）」为占位 → 不渲染；
//! - 导出 Excel 不做（GUI 无 exceljs；只读查看对齐其余页面）。

use chrono::NaiveDate;
use gpui::{
    div, prelude::*, px, App, AsyncApp, Context, CursorStyle, Entity, FontWeight, Hsla, Render,
    SharedString, WeakEntity, Window,
};
use gpui_component::{
    button::Button,
    chart::AreaChart,
    h_flex,
    menu::{DropdownMenu, PopupMenuItem},
    v_flex, Icon, IconName, Sizable, StyledExt,
};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;
use gui_domain::operations::return_analysis::{
    return_country_label, return_rate_level, translate_reason, CustomerFeedbackItem,
    DispositionItem, FulfillmentCenterItem, ReturnAnalysisResponse, ReturnAnalysisSummary,
    ReturnRankingItem, ReturnReasonItem, ReturnTrendItem, StatusItem,
};

use crate::theme::AppTheme;
use crate::views::dashboard::last_7_days_window;
use crate::widgets::chart_primitives::{donut_share_chart, share_legend, ShareRow};
use crate::widgets::data_table::{CellAlign, ColumnDef, DataTable};
use crate::widgets::date_range::{DateRange, DateRangeEvent, DateRangePickerState};
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};
use crate::widgets::top_projects::fmt_num_precise;

/// 本页在侧栏中的 URL（root.rs 据此路由；与 gui-domain::sidebar 的退货分析条目一致）
pub const RETURN_ANALYSIS_URL: &str = "/dashboard/operations/return-analysis";

/// 站点选项（对齐 frontend `CountryOption = 'US' | 'DE' | 'UK'`）
const COUNTRY_OPTIONS: [(&str, &str); 3] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
];

/// 默认站点（对齐 frontend `useUrlParam('country', 'US')`）
const DEFAULT_COUNTRY: &str = "US";

/// 顾客反馈 tab 展示行数上限（对齐 frontend `feedback_rows.slice(0, 50)`）
const FEEDBACK_ROWS_LIMIT: usize = 50;

/// 仓库分布 tab 展示行数上限（对齐 frontend `fulfillment_center_rows.slice(0, 10)`）
const FULFILLMENT_ROWS_LIMIT: usize = 10;

/// 页面 tab（对齐 frontend `ViewTab`；顺序即展示顺序）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReturnAnalysisTab {
    /// 高退货排行（按 SKU）
    Rankings,
    /// 退货原因
    Reason,
    /// 退货趋势
    Trend,
    /// 商品状态
    ProductStatus,
    /// 库存状态
    InventoryStatus,
    /// 顾客反馈
    Feedback,
    /// AI 总结
    Summary,
}

impl ReturnAnalysisTab {
    /// 全部 tab（对齐 frontend `VIEW_TAB_ORDER`）
    pub const ALL: [Self; 7] = [
        Self::Rankings,
        Self::Reason,
        Self::Trend,
        Self::ProductStatus,
        Self::InventoryStatus,
        Self::Feedback,
        Self::Summary,
    ];

    /// 展示标签（对齐 frontend `TAB_LABELS`）
    pub fn label(self) -> &'static str {
        match self {
            Self::Rankings => "高退货排行",
            Self::Reason => "退货原因",
            Self::Trend => "退货趋势",
            Self::ProductStatus => "商品状态",
            Self::InventoryStatus => "库存状态",
            Self::Feedback => "顾客反馈",
            Self::Summary => "AI 总结",
        }
    }

    /// element id 后缀
    fn id(self) -> &'static str {
        match self {
            Self::Rankings => "rankings",
            Self::Reason => "reason",
            Self::Trend => "trend",
            Self::ProductStatus => "product-status",
            Self::InventoryStatus => "inventory-status",
            Self::Feedback => "feedback",
            Self::Summary => "summary",
        }
    }
}

/// 退货分析载荷（Loaded 持有）
#[derive(Debug, Clone, PartialEq)]
pub struct ReturnAnalysisData {
    pub projects: Vec<ManagedProject>,
    pub response: ReturnAnalysisResponse,
    /// 实际请求的项目（未选时自动选第一个后回填）
    pub selected_project_id: Option<i64>,
}

impl ReturnAnalysisData {
    /// 空态判定：所有行 / 总结文本均为空 → Empty
    /// （对齐 frontend：各表内独立空态，页面级整体空态用 EmptyState）
    pub fn is_empty(&self) -> bool {
        let r = &self.response;
        r.ranking_rows.is_empty()
            && r.reason_rows.is_empty()
            && r.trend_rows.is_empty()
            && r.disposition_rows.is_empty()
            && r.status_rows.is_empty()
            && r.feedback_rows.is_empty()
            && r.weekday_rows.is_empty()
            && r.fulfillment_center_rows.is_empty()
            && r.summary_text.is_empty()
    }
}

/// 退货分析状态机（四态；对齐 dashboard.rs / ad_analysis.rs）
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum ReturnAnalysisState {
    Loading,
    Loaded(ReturnAnalysisData),
    Empty,
    Error(String),
}

impl ReturnAnalysisState {
    /// 拉取结果 → 落点状态（唯一合法的「拉取完成」转移）
    pub fn from_fetch_result(result: Result<ReturnAnalysisData, String>) -> Self {
        match result {
            Ok(data) if data.is_empty() => Self::Empty,
            Ok(data) => Self::Loaded(data),
            Err(msg) => Self::Error(msg),
        }
    }
}

/// 退货分析视图（状态机 + 项目/站点/日期筛选 + 7 tab + 竞态保护）
pub struct ReturnAnalysisView {
    state: Entity<ReturnAnalysisState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表（reload 刷新；筛选菜单数据源）
    projects: Vec<ManagedProject>,
    /// 当前选中项目；未选时自动选第一个
    selected_project_id: Option<i64>,
    /// 当前站点（"US" / "DE" / "UK"）
    country: &'static str,
    /// 日期区间筛选（默认近 7 天；return_analysis 支持 start_date/end_date）
    date_range: DateRange,
    /// 日期区间选择器（懒建 + 订阅 Change）
    date_picker: Option<Entity<DateRangePickerState>>,
    /// 当前 tab
    active_tab: ReturnAnalysisTab,
    /// 排行表（懒建 DataTable）
    rankings_table: Option<Entity<DataTable<ReturnRankingItem>>>,
    /// 退货原因表（懒建）
    reason_table: Option<Entity<DataTable<ReturnReasonItem>>>,
    /// 趋势明细表（懒建）
    trend_table: Option<Entity<DataTable<ReturnTrendItem>>>,
    /// 商品状态表（懒建）
    disposition_table: Option<Entity<DataTable<DispositionItem>>>,
    /// 库存状态表（懒建）
    status_table: Option<Entity<DataTable<StatusItem>>>,
    /// 顾客反馈表（懒建）
    feedback_table: Option<Entity<DataTable<CustomerFeedbackItem>>>,
    /// 仓库分布表（懒建）
    fulfillment_table: Option<Entity<DataTable<FulfillmentCenterItem>>>,
    /// 日期区间选择器事件订阅（必须持有，否则变更不送达）
    _subscriptions: Vec<gpui::Subscription>,
    /// 请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,
}

impl ReturnAnalysisView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| ReturnAnalysisState::Loading);
        // 默认近 7 天（对齐其余页面）；订阅日期区间选择器的变更
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
            active_tab: ReturnAnalysisTab::Rankings,
            rankings_table: None,
            reason_table: None,
            trend_table: None,
            disposition_table: None,
            status_table: None,
            feedback_table: None,
            fulfillment_table: None,
            _subscriptions: vec![subscription],
            latest_request_id: 0,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> ReturnAnalysisState {
        self.state.read(cx).clone()
    }

    /// 重新拉取数据：项目/站点/日期切换、错误重试、空态刷新共用入口。
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
            *state = ReturnAnalysisState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(load_return_analysis(
                        &client, selected, country, date_from, date_to,
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

    /// 切换 tab（同一 tab 为 no-op）
    pub fn select_tab(&mut self, tab: ReturnAnalysisTab, cx: &mut Context<Self>) {
        if tab == self.active_tab {
            return;
        }
        self.active_tab = tab;
        cx.notify();
    }

    /// 把响应各行喂进各 DataTable（懒建 + 幂等注入；render 期调用）。
    ///
    /// `set_rows_if_changed` 保证 render 期重复调用不触发多余重绘。
    fn sync_tables(&mut self, data: &ReturnAnalysisData, cx: &mut Context<Self>) {
        let r = &data.response;
        let rankings = self.rankings_table.get_or_insert_with(|| {
            cx.new(|_| {
                DataTable::new("return-rankings-table", ranking_columns())
                    .striped(true)
                    .empty_text("暂无退货排行数据")
            })
        });
        rankings.update(cx, |t, cx| t.set_rows_if_changed(&r.ranking_rows, cx));

        let reason = self.reason_table.get_or_insert_with(|| {
            cx.new(|_| {
                DataTable::new("return-reason-table", reason_columns())
                    .striped(true)
                    .empty_text("暂无退货原因数据")
            })
        });
        reason.update(cx, |t, cx| t.set_rows_if_changed(&r.reason_rows, cx));

        let trend = self.trend_table.get_or_insert_with(|| {
            cx.new(|_| {
                DataTable::new("return-trend-table", trend_columns())
                    .striped(true)
                    .empty_text("暂无退货趋势数据")
            })
        });
        trend.update(cx, |t, cx| t.set_rows_if_changed(&r.trend_rows, cx));

        let disposition = self.disposition_table.get_or_insert_with(|| {
            cx.new(|_| {
                DataTable::new("return-disposition-table", disposition_columns())
                    .striped(true)
                    .empty_text("暂无商品状态数据")
            })
        });
        disposition.update(cx, |t, cx| t.set_rows_if_changed(&r.disposition_rows, cx));

        let status = self.status_table.get_or_insert_with(|| {
            cx.new(|_| {
                DataTable::new("return-status-table", status_columns())
                    .striped(true)
                    .empty_text("暂无库存状态数据")
            })
        });
        status.update(cx, |t, cx| t.set_rows_if_changed(&r.status_rows, cx));

        let feedback = self.feedback_table.get_or_insert_with(|| {
            cx.new(|_| {
                DataTable::new("return-feedback-table", feedback_columns())
                    .striped(true)
                    .empty_text("暂无顾客反馈数据")
            })
        });
        feedback.update(cx, |t, cx| {
            t.set_rows_if_changed(
                &r.feedback_rows[..r.feedback_rows.len().min(FEEDBACK_ROWS_LIMIT)],
                cx,
            )
        });

        let fulfillment = self.fulfillment_table.get_or_insert_with(|| {
            cx.new(|_| {
                DataTable::new("return-fulfillment-table", fulfillment_columns())
                    .striped(true)
                    .empty_text("暂无仓库分布数据")
            })
        });
        fulfillment.update(cx, |t, cx| {
            t.set_rows_if_changed(
                &r.fulfillment_center_rows
                    [..r.fulfillment_center_rows.len().min(FULFILLMENT_ROWS_LIMIT)],
                cx,
            )
        });
    }

    /// 应用拉取结果：竞态保护（过期响应丢弃）+ Loaded 落点前记录项目列表与
    /// 实际请求项目（未选时自动选第一个后回填，对齐 frontend useAutoSelectFirstProject）。
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<ReturnAnalysisData, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok(data) = &result {
            self.projects = data.projects.clone();
            if let Some(id) = data.selected_project_id {
                self.selected_project_id = Some(id);
            }
        }
        self.state.update(cx, |state, cx| {
            *state = ReturnAnalysisState::from_fetch_result(result);
            cx.notify();
        });
    }
}

/// 未选项目时解析实际请求项目：选中项目仍有效 → 用它；否则回退第一个
/// （对齐 frontend `useAutoSelectFirstProject`：URL 指定项目失效 → 回退第一）。
fn resolve_project_id(selected: Option<i64>, projects: &[ManagedProject]) -> Option<i64> {
    match selected {
        Some(id) if projects.iter().any(|p| p.id == id) => Some(id),
        _ => projects.first().map(|p| p.id),
    }
}

/// 拉取退货分析（项目列表 + 全量响应），与视图解耦便于测试。
///
/// 对齐 frontend `loadData`：项目列表为空 → 空载荷（Empty）；
/// 未选项目（或选中失效）→ 自动选第一个真实项目（对齐 useAutoSelectFirstProject）。
async fn load_return_analysis(
    client: &Client,
    selected_project_id: Option<i64>,
    country: &str,
    date_from: NaiveDate,
    date_to: NaiveDate,
) -> Result<ReturnAnalysisData, String> {
    let projects = client
        .list_managed_projects()
        .await
        .map_err(|e| e.user_message())?;

    let Some(project_id) = resolve_project_id(selected_project_id, &projects) else {
        return Ok(ReturnAnalysisData {
            projects,
            response: empty_response(country, date_from, date_to),
            selected_project_id: None,
        });
    };

    let response = client
        .return_analysis(project_id, country, date_from, date_to)
        .await
        .map_err(|e| e.user_message())?;
    Ok(ReturnAnalysisData {
        projects,
        response,
        selected_project_id: Some(project_id),
    })
}

/// 空响应（无项目 / 无数据时构造；所有行与总结文本为空 → Empty 态）
fn empty_response(
    country: &str,
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> ReturnAnalysisResponse {
    ReturnAnalysisResponse {
        project_id: 0,
        project_name: String::new(),
        country: country.to_string(),
        start_date: start_date.to_string(),
        end_date: end_date.to_string(),
        summary: ReturnAnalysisSummary {
            total_returns: 0,
            total_quantity: 0,
            unique_skus: 0,
            top_return_sku: None,
            top_return_reason: None,
            total_sales_quantity: 0,
            total_sales_amount: 0.0,
            overall_return_rate: 0.0,
        },
        summary_text: String::new(),
        ranking_rows: Vec::new(),
        reason_rows: Vec::new(),
        trend_rows: Vec::new(),
        disposition_rows: Vec::new(),
        status_rows: Vec::new(),
        feedback_rows: Vec::new(),
        weekday_rows: Vec::new(),
        fulfillment_center_rows: Vec::new(),
        multi_item_return_count: 0,
        multi_item_return_quantity: 0,
    }
}

impl Render for ReturnAnalysisView {
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
            .unwrap_or_else(|| "退货分析".to_string());

        v_flex()
            .id("return-analysis")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(theme.window_bg)
            // 页面头部（P4-5：共享 PageHeader）
            .child(PageHeader::new("退货分析").subtitle(match &state {
                ReturnAnalysisState::Loaded(data) => format!(
                    "{} · {} · {} ~ {}",
                    project_name,
                    return_country_label(&data.response.country),
                    data.response.start_date,
                    data.response.end_date
                ),
                _ => "退货分析（排行 / 原因 / 趋势 / 状态 / 反馈）".to_string(),
            }))
            // 筛选栏：项目 + 站点 + 日期区间 + 刷新（宽窗受内容上限约束）
            .child(content_guard().child(render_filter_bar(
                &view,
                &theme,
                &self.projects,
                self.selected_project_id,
                self.country,
                self.date_picker.clone(),
            )))
            // 状态区（加载/错误/空态受上限约束；表格内容保留全宽）
            .child(match state {
                ReturnAnalysisState::Loading => content_guard()
                    .child(render_loading(&theme))
                    .into_any_element(),
                ReturnAnalysisState::Error(msg) => content_guard()
                    .child(render_error(cx, &theme, &msg))
                    .into_any_element(),
                ReturnAnalysisState::Empty => content_guard()
                    .child(render_empty(cx, &theme, self.projects.is_empty()))
                    .into_any_element(),
                ReturnAnalysisState::Loaded(data) => {
                    self.sync_tables(&data, cx);
                    let rankings = self.rankings_table.clone().expect("已同步");
                    let reason = self.reason_table.clone().expect("已同步");
                    let trend = self.trend_table.clone().expect("已同步");
                    let disposition = self.disposition_table.clone().expect("已同步");
                    let status = self.status_table.clone().expect("已同步");
                    let feedback = self.feedback_table.clone().expect("已同步");
                    let fulfillment = self.fulfillment_table.clone().expect("已同步");
                    render_loaded(
                        cx,
                        &theme,
                        &data,
                        self.active_tab,
                        rankings,
                        reason,
                        trend,
                        disposition,
                        status,
                        feedback,
                        fulfillment,
                    )
                    .into_any_element()
                }
            })
    }
}

// ---------------------------------------------------------------------------
// 四态渲染
// ---------------------------------------------------------------------------

/// Loading：顶部筛选占位 + 数字带骨架 + 卡片骨架
///
/// P4-6：骨架块统一走 `state_views::skeleton_loading` 声明式组合
/// （隔离条用 `BarRow`，卡片带用 `BarRow` 高卡近似）。
fn render_loading(app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("return-analysis-loading")
        .size_full()
        .gap_4()
        .overflow_y_scroll()
        .child(state_views::skeleton_loading(
            app_theme,
            &[
                // 隔离条（原 7 个 72px 等宽条）
                SkeletonBlock::BarRow(7, 72.0),
                // 卡片带（原 7 张 180px 等宽卡）
                SkeletonBlock::BarRow(7, 180.0),
            ],
        ))
}

/// Error：卡片内 Alert + 重试按钮（State 0 公共组件 `state_views::error_state`）
fn render_error(
    cx: &mut Context<ReturnAnalysisView>,
    app_theme: &AppTheme,
    msg: &str,
) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("return-analysis-error")
        .size_full()
        .gap_4()
        .overflow_y_scroll()
        .child(state_views::error_state(
            &view,
            app_theme,
            "return-analysis-error",
            "退货分析加载失败",
            msg.to_string(),
            |this, cx| this.reload(cx),
        ))
}

/// Empty：Icon + 文案 + 刷新按钮（State 0 公共组件 `empty_state_with_action`）
fn render_empty(
    cx: &mut Context<ReturnAnalysisView>,
    app_theme: &AppTheme,
    no_projects: bool,
) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("return-analysis-empty")
        .size_full()
        .items_center()
        .justify_center()
        .overflow_y_scroll()
        .child(state_views::empty_state_with_action(
            &view,
            app_theme,
            "return-analysis-empty",
            "icons/package.svg",
            if no_projects {
                "暂无可用项目"
            } else {
                "暂无退货数据"
            },
            "刷新",
            |this, cx| this.reload(cx),
        ))
}

/// Loaded：汇总数字带 + tab 栏 + 当前 tab 内容
#[allow(clippy::too_many_arguments)]
fn render_loaded(
    cx: &mut Context<ReturnAnalysisView>,
    app_theme: &AppTheme,
    data: &ReturnAnalysisData,
    active_tab: ReturnAnalysisTab,
    rankings: Entity<DataTable<ReturnRankingItem>>,
    reason: Entity<DataTable<ReturnReasonItem>>,
    trend: Entity<DataTable<ReturnTrendItem>>,
    disposition: Entity<DataTable<DispositionItem>>,
    status: Entity<DataTable<StatusItem>>,
    feedback: Entity<DataTable<CustomerFeedbackItem>>,
    fulfillment: Entity<DataTable<FulfillmentCenterItem>>,
) -> impl IntoElement {
    let view = cx.entity();
    let reduce = crate::motion::reduce_motion(cx);
    let response = &data.response;

    crate::motion::enter_fade_in(
        gpui::SharedString::from("return-analysis-loaded-fade"),
        v_flex()
            .id("return-analysis-loaded")
            .size_full()
            .gap_4()
            .overflow_y_scroll()
            // 汇总数字带（7 卡；对齐 frontend Summary Stats；宽窗受上限约束）
            .child(content_guard().child(summary_stat_cards(response, app_theme)))
            // tab 栏
            .child(content_guard().child(render_tab_bar(&view, active_tab, app_theme)))
            // 当前 tab 内容（数据表格保留全宽）
            .child(match active_tab {
                ReturnAnalysisTab::Rankings => {
                    render_rankings_tab(response, rankings, app_theme).into_any_element()
                }
                ReturnAnalysisTab::Reason => {
                    render_reason_tab(response, reason, app_theme).into_any_element()
                }
                ReturnAnalysisTab::Trend => {
                    render_trend_tab(response, trend, app_theme).into_any_element()
                }
                ReturnAnalysisTab::ProductStatus => render_distribution_tab(
                    "return-disposition-card",
                    "商品状态分布",
                    disposition,
                    app_theme,
                )
                .into_any_element(),
                ReturnAnalysisTab::InventoryStatus => {
                    render_distribution_tab("return-status-card", "库存状态分布", status, app_theme)
                        .into_any_element()
                }
                ReturnAnalysisTab::Feedback => {
                    render_feedback_tab(feedback, app_theme).into_any_element()
                }
                ReturnAnalysisTab::Summary => {
                    render_summary_tab(response, fulfillment, app_theme).into_any_element()
                }
            }),
        reduce,
    )
}

// ---------------------------------------------------------------------------
// 筛选栏
// ---------------------------------------------------------------------------

/// 筛选栏：项目选择 + 站点选择 + 日期区间选择器 + 刷新按钮
/// （on_click 静态闭包经捕获 `Entity<ReturnAnalysisView>` 更新视图）。
#[allow(clippy::too_many_arguments)]
fn render_filter_bar(
    view: &Entity<ReturnAnalysisView>,
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
        .id("return-analysis-filters")
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
                    Button::new("return-analysis-project-filter")
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
                    Button::new("return-analysis-country-filter")
                        .outline()
                        .small()
                        .label(return_country_label(country))
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
            Button::new("return-analysis-refresh")
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
// 汇总数字带
// ---------------------------------------------------------------------------

/// 汇总数字带（7 卡；对齐 frontend Summary Stats：退货单数 / 退货总量 /
/// 销售数量 / 整体退货率 / 涉及SKU / Top退货原因 / 多件退货）
fn summary_stat_cards(response: &ReturnAnalysisResponse, app_theme: &AppTheme) -> impl IntoElement {
    let s = &response.summary;
    let rate_color = match return_rate_level(s.overall_return_rate) {
        gui_domain::operations::return_analysis::ReturnRateLevel::High => app_theme.danger,
        gui_domain::operations::return_analysis::ReturnRateLevel::Medium => app_theme.warning,
        gui_domain::operations::return_analysis::ReturnRateLevel::Low => app_theme.success,
    };
    let top_reason = s
        .top_return_reason
        .as_deref()
        .map(translate_reason)
        .unwrap_or_else(|| "--".to_string());

    let cards: Vec<(&'static str, String, Option<Hsla>, Option<String>)> = vec![
        ("退货单数", fmt_num_precise(s.total_returns), None, None),
        ("退货总量", fmt_num_precise(s.total_quantity), None, None),
        (
            "销售数量",
            fmt_num_precise(s.total_sales_quantity),
            None,
            None,
        ),
        (
            "整体退货率",
            format!("{:.1}%", s.overall_return_rate),
            Some(rate_color),
            None,
        ),
        ("涉及SKU", fmt_num_precise(s.unique_skus), None, None),
        ("Top退货原因", top_reason, None, None),
        (
            "多件退货",
            fmt_num_precise(response.multi_item_return_count),
            None,
            Some(format!(
                "共{}件",
                fmt_num_precise(response.multi_item_return_quantity)
            )),
        ),
    ];

    h_flex()
        .id("return-analysis-stats")
        .gap_3()
        .flex_wrap()
        .children(cards.into_iter().map(|(label, value, color, sub)| {
            v_flex()
                .id(SharedString::from(format!("return-stat-{label}")))
                .flex_1()
                .min_w_32()
                .gap_1p5()
                .p_3()
                .rounded(px(app_theme.radius_lg))
                .bg(app_theme.card_bg)
                .shadow(vec![app_theme.card_shadow_box()])
                .child(
                    div()
                        .text_xs()
                        .text_color(app_theme.text_muted)
                        .child(label.to_string()),
                )
                .child(
                    div()
                        .text_lg()
                        .font_semibold()
                        .text_color(color.unwrap_or(app_theme.text_primary))
                        .truncate()
                        .child(value),
                )
                .when(sub.is_some(), |this| {
                    let sub = sub.unwrap();
                    this.child(div().text_xs().text_color(app_theme.text_muted).child(sub))
                })
        }))
}

// ---------------------------------------------------------------------------
// tab 栏
// ---------------------------------------------------------------------------

/// 顶部 tab 栏（对齐 frontend 滑动 Tab 的 7 项；gpui 无滑动指示器动画，
/// 用「选中强调底 + 文本色」区分，hover 反馈）
fn render_tab_bar(
    view: &Entity<ReturnAnalysisView>,
    active: ReturnAnalysisTab,
    theme: &AppTheme,
) -> impl IntoElement {
    h_flex()
        .id("return-analysis-tabs")
        .w_full()
        .p_1()
        .gap_1()
        .rounded(px(theme.radius_lg))
        .bg(theme.muted_fill)
        .children(ReturnAnalysisTab::ALL.into_iter().map(|tab| {
            let view = view.clone();
            let selected = active == tab;
            div()
                .id(SharedString::from(format!(
                    "return-analysis-tab-{}",
                    tab.id()
                )))
                .flex_1()
                .py_1p5()
                .px_2()
                .text_center()
                .text_xs()
                .rounded(px(theme.radius))
                .cursor(CursorStyle::PointingHand)
                .when(selected, |this| {
                    this.bg(theme.card_bg)
                        .text_color(theme.accent)
                        .font_weight(FontWeight::MEDIUM)
                })
                .when(!selected, |this| {
                    this.text_color(theme.text_secondary).hover(|this| {
                        this.bg(theme.card_bg.opacity(0.5))
                            .text_color(theme.text_primary)
                    })
                })
                .child(tab.label().to_string())
                .on_mouse_up(gpui::MouseButton::Left, move |_, _window, cx| {
                    view.update(cx, |this, cx| this.select_tab(tab, cx));
                })
        }))
}

// ---------------------------------------------------------------------------
// 高退货排行 tab
// ---------------------------------------------------------------------------

fn render_rankings_tab(
    response: &ReturnAnalysisResponse,
    table: Entity<DataTable<ReturnRankingItem>>,
    app_theme: &AppTheme,
) -> impl IntoElement {
    section_card(
        "return-rankings-card",
        "高退货排行（按SKU）",
        &format!(
            "{} 个 SKU · {} 件退货",
            fmt_num_precise(response.summary.unique_skus),
            fmt_num_precise(response.summary.total_quantity)
        ),
        app_theme,
        table,
    )
}

/// 排行表列定义（对齐 frontend：SKU / 品名 / ASIN / 退货数量 / 退货单数 /
/// 销售数量 / 退货率 / 平均·最快·最慢退货周期；两级表头拍平为单行）
fn ranking_columns() -> Vec<ColumnDef<ReturnRankingItem>> {
    vec![
        ColumnDef::text("sku", "SKU", |r: &ReturnRankingItem, _| {
            SharedString::from(r.sku.clone())
        })
        .width(104.0),
        ColumnDef::text("product", "品名", |r: &ReturnRankingItem, _| {
            SharedString::from(r.product_name.clone().unwrap_or_else(|| "--".to_string()))
        }),
        ColumnDef::text("asin", "ASIN", |r: &ReturnRankingItem, _| {
            SharedString::from(r.asin.clone().unwrap_or_else(|| "--".to_string()))
        })
        .width(88.0),
        ColumnDef::text("return_qty", "退货数量", |r: &ReturnRankingItem, _| {
            SharedString::from(fmt_num_precise(r.total_quantity))
        })
        .width(84.0)
        .align(CellAlign::Right),
        ColumnDef::text(
            "return_count",
            "退货单数",
            |r: &ReturnRankingItem, _| SharedString::from(fmt_num_precise(r.return_count)),
        )
        .width(84.0)
        .align(CellAlign::Right),
        ColumnDef::text("sales_qty", "销售数量", |r: &ReturnRankingItem, _| {
            SharedString::from(fmt_num_precise(r.sales_quantity))
        })
        .width(84.0)
        .align(CellAlign::Right),
        ColumnDef::text("return_rate", "退货率", |r: &ReturnRankingItem, _| {
            SharedString::from(return_rate_text(r))
        })
        .width(76.0)
        .align(CellAlign::Right)
        .with_render_element(return_rate_element),
        ColumnDef::text("avg_cycle", "平均周期", |r: &ReturnRankingItem, _| {
            SharedString::from(cycle_text(r.avg_return_cycle_days))
        })
        .width(84.0)
        .align(CellAlign::Right),
        ColumnDef::text("min_cycle", "最快周期", |r: &ReturnRankingItem, _| {
            SharedString::from(cycle_text(r.min_return_cycle_days))
        })
        .width(84.0)
        .align(CellAlign::Right)
        .with_render_element(|r, theme| {
            // 最快周期绿色（对齐 frontend text-green-600）
            colored_cell(cycle_text(r.min_return_cycle_days), theme.success, theme)
        }),
        ColumnDef::text("max_cycle", "最慢周期", |r: &ReturnRankingItem, _| {
            SharedString::from(cycle_text(r.max_return_cycle_days))
        })
        .width(84.0)
        .align(CellAlign::Right)
        .with_render_element(|r, theme| {
            // 最慢周期琥珀色（对齐 frontend text-amber-600）
            colored_cell(cycle_text(r.max_return_cycle_days), theme.warning, theme)
        }),
    ]
}

/// 退货率展示：销售数量为 0 时显示 `--`（对齐 frontend）
fn return_rate_text(r: &ReturnRankingItem) -> String {
    if r.sales_quantity > 0 {
        format!("{:.1}%", r.return_rate)
    } else {
        "--".to_string()
    }
}

/// 退货率单元格：按阈值着色（>8 红 / >3 黄 / 其余绿，对齐 frontend）
fn return_rate_element(r: &ReturnRankingItem, theme: &AppTheme) -> gpui::AnyElement {
    let color = match return_rate_level(r.return_rate) {
        gui_domain::operations::return_analysis::ReturnRateLevel::High => theme.danger,
        gui_domain::operations::return_analysis::ReturnRateLevel::Medium => theme.warning,
        gui_domain::operations::return_analysis::ReturnRateLevel::Low => theme.success,
    };
    colored_cell(return_rate_text(r), color, theme)
}

/// 周期展示：None → `--`
fn cycle_text(value: Option<impl ToString>) -> String {
    match value {
        Some(v) => v.to_string(),
        None => "--".to_string(),
    }
}

/// 右对齐彩色单元格（DataTable render_element 用）
fn colored_cell(text: String, color: Hsla, _theme: &AppTheme) -> gpui::AnyElement {
    div()
        .w_full()
        .text_right()
        .font_weight(FontWeight::MEDIUM)
        .text_color(color)
        .child(text)
        .into_any_element()
}

// ---------------------------------------------------------------------------
// 退货原因 tab
// ---------------------------------------------------------------------------

fn render_reason_tab(
    response: &ReturnAnalysisResponse,
    table: Entity<DataTable<ReturnReasonItem>>,
    app_theme: &AppTheme,
) -> impl IntoElement {
    // 占比环形图：Top 5 原因（对齐 frontend `reason_rows.slice(0, 5)` 饼图）
    let share_rows: Vec<ShareRow> = response
        .reason_rows
        .iter()
        .take(5)
        .map(|r| ShareRow {
            name: r.reason_display.clone(),
            sales: r.return_count as f64,
        })
        .collect();
    let total: f64 = response
        .reason_rows
        .iter()
        .map(|r| r.return_count as f64)
        .sum();

    v_flex()
        .id("return-reason-tab")
        .w_full()
        .gap_4()
        .child(section_card(
            "return-reason-card",
            "退货原因分析",
            "原因分布（占比按退货单数）",
            app_theme,
            table,
        ))
        .when(!share_rows.is_empty(), |this| {
            this.child(
                v_flex()
                    .id("return-reason-chart")
                    .w_full()
                    .gap_3()
                    .p_4()
                    .rounded(px(app_theme.radius_lg))
                    .bg(app_theme.card_bg)
                    .shadow(vec![app_theme.card_shadow_box()])
                    .child(
                        div()
                            .text_base()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(app_theme.text_primary)
                            .child("退货原因占比（Top 5）"),
                    )
                    .child(
                        h_flex()
                            .gap_4()
                            .items_center()
                            .child(div().size(px(220.)).child(donut_share_chart(
                                &share_rows,
                                56.0,
                                app_theme,
                            )))
                            .child(div().flex_1().child(share_legend(
                                &share_rows,
                                total,
                                app_theme,
                            ))),
                    ),
            )
        })
}

/// 原因表列定义（对齐 frontend：退货原因 / 退货数量 / 占比）
fn reason_columns() -> Vec<ColumnDef<ReturnReasonItem>> {
    vec![
        ColumnDef::text("reason", "退货原因", |r: &ReturnReasonItem, _| {
            SharedString::from(r.reason_display.clone())
        }),
        ColumnDef::text("quantity", "退货数量", |r: &ReturnReasonItem, _| {
            SharedString::from(fmt_num_precise(r.total_quantity))
        })
        .width(96.0)
        .align(CellAlign::Right),
        ColumnDef::text("percentage", "占比", |r: &ReturnReasonItem, _| {
            SharedString::from(format!("{:.1}%", r.percentage))
        })
        .width(96.0)
        .align(CellAlign::Right),
    ]
}

// ---------------------------------------------------------------------------
// 退货趋势 tab
// ---------------------------------------------------------------------------

/// 趋势图数据点（销售数量 + 退货单数双序列，共用轴）
#[derive(Debug, Clone, PartialEq)]
struct TrendDualPoint {
    label: String,
    sales: f64,
    returns: f64,
}

/// 日期 `YYYY-MM-DD` → `M/D`（对齐 frontend tickFormatter）
fn trend_day_label(date: &str) -> String {
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|d| d.format("%-m/%-d").to_string())
        .unwrap_or_else(|_| date.to_string())
}

/// 趋势双序列点
fn trend_dual_points(rows: &[ReturnTrendItem]) -> Vec<TrendDualPoint> {
    rows.iter()
        .map(|r| TrendDualPoint {
            label: trend_day_label(&r.date),
            sales: r.sales_quantity as f64,
            returns: r.return_count as f64,
        })
        .collect()
}

fn render_trend_tab(
    response: &ReturnAnalysisResponse,
    table: Entity<DataTable<ReturnTrendItem>>,
    app_theme: &AppTheme,
) -> impl IntoElement {
    let rows = &response.trend_rows;
    let latest_rate = rows.last().map(|r| r.return_rate).unwrap_or(0.0);

    v_flex()
        .id("return-trend-tab")
        .w_full()
        .gap_4()
        .when(!rows.is_empty(), |this| {
            // 双序列面积图（销售数量 + 退货单数；web 为柱+线双轴 → GPUI
            // 能力边界回退为共用轴面积图，量级差仍可观察）
            this.child(
                v_flex()
                    .id("return-trend-chart")
                    .w_full()
                    .gap_3()
                    .p_4()
                    .rounded(px(app_theme.radius_lg))
                    .bg(app_theme.card_bg)
                    .shadow(vec![app_theme.card_shadow_box()])
                    .child(
                        h_flex()
                            .items_center()
                            .justify_between()
                            .child(
                                div()
                                    .text_base()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(app_theme.text_primary)
                                    .child("销售与退货趋势对比"),
                            )
                            .child(
                                div()
                                    .text_sm()
                                    .text_color(app_theme.text_muted)
                                    .child(format!("最新退货率 {latest_rate:.1}%")),
                            ),
                    )
                    .child(
                        h_flex()
                            .gap_4()
                            .items_center()
                            .child(
                                div()
                                    .w_full()
                                    .h(px(240.))
                                    .child(trend_area_chart(rows, app_theme)),
                            )
                            .child(
                                v_flex()
                                    .gap_2()
                                    .child(trend_legend_swatch(
                                        app_theme.chart_primary,
                                        "销售数量",
                                        app_theme,
                                    ))
                                    .child(trend_legend_swatch(
                                        app_theme.chart_secondary,
                                        "退货单数",
                                        app_theme,
                                    )),
                            ),
                    ),
            )
        })
        .child(section_card(
            "return-trend-card",
            "每日明细",
            "日期 · 销售数量 · 退货单数 · 退货率",
            app_theme,
            table,
        ))
}

/// 趋势图（双序列面积图：销售数量 + 退货单数；gpui-component AreaChart
/// 是唯一支持多 y 序列的图型，见 widgets/charts.rs 调研结论）
fn trend_area_chart(rows: &[ReturnTrendItem], theme: &AppTheme) -> impl IntoElement {
    let points = trend_dual_points(rows);
    AreaChart::new(points)
        .x(|p| p.label.clone())
        .y(|p| p.sales)
        .y(|p| p.returns)
        .stroke(theme.chart_primary)
        .stroke(theme.chart_secondary)
        .fill(theme.chart_primary.opacity(0.16))
        .fill(theme.chart_secondary.opacity(0.16))
        .linear()
        .linear()
        .tick_margin(1)
}

/// 图例色块项
fn trend_legend_swatch(color: Hsla, label: &'static str, theme: &AppTheme) -> impl IntoElement {
    h_flex()
        .gap_1p5()
        .items_center()
        .child(div().size_2p5().rounded_sm().bg(color))
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .child(label.to_string()),
        )
}

/// 趋势明细表列定义（对齐 frontend 每日明细：日期 / 销售数量 / 退货单数 / 退货率）
fn trend_columns() -> Vec<ColumnDef<ReturnTrendItem>> {
    vec![
        ColumnDef::text("date", "日期", |r: &ReturnTrendItem, _| {
            SharedString::from(r.date.clone())
        })
        .width(120.0),
        ColumnDef::text("sales_qty", "销售数量", |r: &ReturnTrendItem, _| {
            SharedString::from(fmt_num_precise(r.sales_quantity))
        })
        .width(100.0)
        .align(CellAlign::Right),
        ColumnDef::text("return_count", "退货单数", |r: &ReturnTrendItem, _| {
            SharedString::from(fmt_num_precise(r.return_count))
        })
        .width(100.0)
        .align(CellAlign::Right),
        ColumnDef::text("return_rate", "退货率", |r: &ReturnTrendItem, _| {
            SharedString::from(format!("{:.1}%", r.return_rate))
        })
        .width(100.0)
        .align(CellAlign::Right),
    ]
}

// ---------------------------------------------------------------------------
// 商品状态 / 库存状态 tab（同构：状态分布表）
// ---------------------------------------------------------------------------

fn render_distribution_tab<T: Clone + PartialEq + 'static>(
    id: &'static str,
    title: &'static str,
    table: Entity<DataTable<T>>,
    app_theme: &AppTheme,
) -> impl IntoElement {
    section_card(id, title, "", app_theme, table)
}

/// 商品状态表列定义（对齐 frontend：商品状态 / 数量 / 占比）
fn disposition_columns() -> Vec<ColumnDef<DispositionItem>> {
    vec![
        ColumnDef::text("disposition", "商品状态", |r: &DispositionItem, _| {
            SharedString::from(r.disposition_display.clone())
        }),
        ColumnDef::text("quantity", "数量", |r: &DispositionItem, _| {
            SharedString::from(fmt_num_precise(r.total_quantity))
        })
        .width(96.0)
        .align(CellAlign::Right),
        ColumnDef::text("percentage", "占比", |r: &DispositionItem, _| {
            SharedString::from(format!("{:.1}%", r.percentage))
        })
        .width(96.0)
        .align(CellAlign::Right),
    ]
}

/// 库存状态表列定义（对齐 frontend：库存状态 / 数量 / 占比）
fn status_columns() -> Vec<ColumnDef<StatusItem>> {
    vec![
        ColumnDef::text("status", "库存状态", |r: &StatusItem, _| {
            SharedString::from(r.status_display.clone())
        }),
        ColumnDef::text("quantity", "数量", |r: &StatusItem, _| {
            SharedString::from(fmt_num_precise(r.total_quantity))
        })
        .width(96.0)
        .align(CellAlign::Right),
        ColumnDef::text("percentage", "占比", |r: &StatusItem, _| {
            SharedString::from(format!("{:.1}%", r.percentage))
        })
        .width(96.0)
        .align(CellAlign::Right),
    ]
}

// ---------------------------------------------------------------------------
// 顾客反馈 tab
// ---------------------------------------------------------------------------

fn render_feedback_tab(
    table: Entity<DataTable<CustomerFeedbackItem>>,
    app_theme: &AppTheme,
) -> impl IntoElement {
    section_card(
        "return-feedback-card",
        "顾客反馈",
        &format!("最多展示 {FEEDBACK_ROWS_LIMIT} 条"),
        app_theme,
        table,
    )
}

/// 反馈表列定义（对齐 frontend：日期 / SKU / 退货原因 / 顾客评论）
fn feedback_columns() -> Vec<ColumnDef<CustomerFeedbackItem>> {
    vec![
        ColumnDef::text("date", "日期", |r: &CustomerFeedbackItem, _| {
            SharedString::from(r.return_date.clone())
        })
        .width(104.0),
        ColumnDef::text("sku", "SKU", |r: &CustomerFeedbackItem, _| {
            SharedString::from(r.sku.clone())
        })
        .width(140.0),
        ColumnDef::text("reason", "退货原因", |r: &CustomerFeedbackItem, _| {
            SharedString::from(r.reason_display.clone())
        })
        .width(120.0),
        ColumnDef::text("comment", "顾客评论", |r: &CustomerFeedbackItem, _| {
            SharedString::from(r.customer_comment.clone())
        }),
    ]
}

// ---------------------------------------------------------------------------
// AI 总结 tab
// ---------------------------------------------------------------------------

fn render_summary_tab(
    response: &ReturnAnalysisResponse,
    fulfillment: Entity<DataTable<FulfillmentCenterItem>>,
    app_theme: &AppTheme,
) -> impl IntoElement {
    v_flex()
        .id("return-summary-tab")
        .w_full()
        .gap_4()
        // 文字总结（emoji 前缀行为小节标题）
        .child(
            v_flex()
                .id("return-summary-text")
                .w_full()
                .gap_3()
                .p_4()
                .rounded(px(app_theme.radius_lg))
                .bg(app_theme.card_bg)
                .shadow(vec![app_theme.card_shadow_box()])
                .child(
                    h_flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_base()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(app_theme.text_primary)
                                .child("退货分析总结"),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(app_theme.text_muted)
                                .child(format!("{} 至 {}", response.start_date, response.end_date)),
                        ),
                )
                .when(!response.summary_text.is_empty(), |this| {
                    this.child(summary_text_block(&response.summary_text, app_theme))
                }),
        )
        // 星期退货分布
        .when(!response.weekday_rows.is_empty(), |this| {
            this.child(weekday_grid(&response.weekday_rows, app_theme))
        })
        // 仓库退货分布
        .when(!response.fulfillment_center_rows.is_empty(), |this| {
            this.child(section_card(
                "return-fulfillment-card",
                "仓库退货分布",
                &format!("最多展示 {FULFILLMENT_ROWS_LIMIT} 个仓库"),
                app_theme,
                fulfillment,
            ))
        })
}

/// 总结文本块：空行 → 间距；emoji 前缀行 → 小节标题；其余 → 正文弱化色
/// （对齐 frontend `summary_text.split('\n')` 渲染）
fn summary_text_block(text: &str, app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("return-summary-lines")
        .w_full()
        .children(text.lines().map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return div().h_3().into_any_element();
            }
            if is_summary_header(trimmed) {
                return div()
                    .mt_3()
                    .text_sm()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(app_theme.text_primary)
                    .child(trimmed.to_string())
                    .into_any_element();
            }
            div()
                .text_sm()
                .text_color(app_theme.text_secondary)
                .child(trimmed.to_string())
                .into_any_element()
        }))
}

/// 总结小节标题判定（对齐 frontend emoji 前缀清单）
fn is_summary_header(line: &str) -> bool {
    [
        '📊', '⚠', '🔍', '📈', '📦', '🏭', '💡', '🗓', '📏', '🖼', '💬', '📋', 'ℹ', '⚡',
    ]
    .iter()
    .any(|prefix| line.starts_with(*prefix))
}

/// 星期退货分布网格（对齐 frontend：7 格，星期名 + 单数 + 占比）
fn weekday_grid(
    rows: &[gui_domain::operations::return_analysis::WeekdayItem],
    app_theme: &AppTheme,
) -> impl IntoElement {
    v_flex()
        .id("return-weekday-card")
        .w_full()
        .gap_3()
        .p_4()
        .rounded(px(app_theme.radius_lg))
        .bg(app_theme.card_bg)
        .shadow(vec![app_theme.card_shadow_box()])
        .child(
            div()
                .text_base()
                .font_weight(FontWeight::MEDIUM)
                .text_color(app_theme.text_primary)
                .child("📅 星期退货分布"),
        )
        .child(h_flex().gap_2().children(rows.iter().map(|row| {
            v_flex()
                .id(SharedString::from(format!(
                    "return-weekday-{}",
                    row.weekday
                )))
                .flex_1()
                .items_center()
                .gap_1()
                .p_2()
                .rounded_md()
                .bg(app_theme.muted_fill)
                .child(
                    div()
                        .text_xs()
                        .text_color(app_theme.text_muted)
                        .child(row.weekday_display.clone()),
                )
                .child(
                    div()
                        .text_base()
                        .font_semibold()
                        .text_color(app_theme.text_primary)
                        .child(fmt_num_precise(row.return_count)),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(app_theme.text_muted)
                        .child(format!("{:.1}%", row.percentage)),
                )
        })))
}

/// 仓库分布表列定义（对齐 frontend：仓库 / 退货单数 / 退货件数 / 占比）
fn fulfillment_columns() -> Vec<ColumnDef<FulfillmentCenterItem>> {
    vec![
        ColumnDef::text("fc", "仓库", |r: &FulfillmentCenterItem, _| {
            SharedString::from(r.fulfillment_center_id.clone())
        }),
        ColumnDef::text(
            "return_count",
            "退货单数",
            |r: &FulfillmentCenterItem, _| SharedString::from(fmt_num_precise(r.return_count)),
        )
        .width(100.0)
        .align(CellAlign::Right),
        ColumnDef::text(
            "quantity",
            "退货件数",
            |r: &FulfillmentCenterItem, _| SharedString::from(fmt_num_precise(r.quantity)),
        )
        .width(100.0)
        .align(CellAlign::Right),
        ColumnDef::text("percentage", "占比", |r: &FulfillmentCenterItem, _| {
            SharedString::from(format!("{:.1}%", r.percentage))
        })
        .width(100.0)
        .align(CellAlign::Right),
    ]
}

// ---------------------------------------------------------------------------
// 通用卡片外壳
// ---------------------------------------------------------------------------

/// 表格卡片外壳：卡片底 + 标题行（可选副标题）+ DataTable 实体
fn section_card<T: Clone + PartialEq + 'static>(
    id: &'static str,
    title: &'static str,
    subtitle: &str,
    app_theme: &AppTheme,
    table: Entity<DataTable<T>>,
) -> impl IntoElement {
    v_flex()
        .id(id)
        .w_full()
        .rounded(px(app_theme.radius_lg))
        .bg(app_theme.card_bg)
        .shadow(vec![app_theme.card_shadow_box()])
        .when(!title.is_empty(), |this| {
            this.child(
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
                    .when(!subtitle.is_empty(), |this| {
                        this.child(
                            div()
                                .text_sm()
                                .text_color(app_theme.text_muted)
                                .child(subtitle.to_string()),
                        )
                    }),
            )
        })
        .child(table)
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

/// 测试宿主：仅渲染 ReturnAnalysisView（渲染冒烟用）
#[cfg(test)]
struct ReturnAnalysisHost {
    view: Entity<ReturnAnalysisView>,
}

#[cfg(test)]
impl gpui::Render for ReturnAnalysisHost {
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
    use gui_domain::operations::return_analysis::{ReturnAnalysisResponse, ReturnAnalysisSummary};

    fn project(id: i64, name: &str) -> ManagedProject {
        ManagedProject {
            id,
            name: name.to_string(),
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

    fn sample_response() -> ReturnAnalysisResponse {
        ReturnAnalysisResponse {
            project_id: 1,
            project_name: "测试项目".to_string(),
            country: "US".to_string(),
            start_date: "2026-08-07".to_string(),
            end_date: "2026-08-13".to_string(),
            summary: ReturnAnalysisSummary {
                total_returns: 10,
                total_quantity: 12,
                unique_skus: 3,
                top_return_sku: Some("SKU-1".to_string()),
                top_return_reason: Some("QUALITY_UNACCEPTABLE".to_string()),
                total_sales_quantity: 120,
                total_sales_amount: 2400.0,
                overall_return_rate: 10.0,
            },
            summary_text: "📊 总览\n退货单数 10。\n⚠️ 质量问题突出。".to_string(),
            ranking_rows: vec![ReturnRankingItem {
                sku: "SKU-1".to_string(),
                asin: Some("B0001".to_string()),
                product_name: Some("产品一".to_string()),
                total_quantity: 8,
                return_count: 6,
                sales_quantity: 60,
                return_rate: 13.3,
                avg_return_cycle_days: Some(4.2),
                min_return_cycle_days: Some(1),
                max_return_cycle_days: Some(8),
            }],
            reason_rows: vec![ReturnReasonItem {
                reason: "QUALITY_UNACCEPTABLE".to_string(),
                reason_display: "质量不合格".to_string(),
                total_quantity: 6,
                return_count: 5,
                percentage: 83.33,
            }],
            trend_rows: vec![ReturnTrendItem {
                date: "2026-08-13".to_string(),
                total_quantity: 2,
                return_count: 1,
                sales_quantity: 20,
                sales_amount: 400.0,
                return_rate: 5.0,
            }],
            disposition_rows: Vec::new(),
            status_rows: Vec::new(),
            feedback_rows: Vec::new(),
            weekday_rows: Vec::new(),
            fulfillment_center_rows: Vec::new(),
            multi_item_return_count: 1,
            multi_item_return_quantity: 2,
        }
    }

    fn sample_data() -> ReturnAnalysisData {
        ReturnAnalysisData {
            projects: vec![project(1, "测试项目")],
            response: sample_response(),
            selected_project_id: Some(1),
        }
    }

    // ---------- 纯函数 ----------

    #[test]
    fn tab_labels_and_ids_cover_all_seven() {
        assert_eq!(ReturnAnalysisTab::ALL.len(), 7);
        for tab in ReturnAnalysisTab::ALL {
            assert!(!tab.label().is_empty());
            assert!(!tab.id().is_empty());
        }
        assert_eq!(ReturnAnalysisTab::ALL[0], ReturnAnalysisTab::Rankings);
        assert_eq!(ReturnAnalysisTab::Summary.label(), "AI 总结");
    }

    #[test]
    fn resolve_project_id_falls_back_to_first() {
        let projects = vec![project(1, "A"), project(2, "B")];
        // 选中有效 → 保留
        assert_eq!(resolve_project_id(Some(2), &projects), Some(2));
        // 选中失效 → 回退第一（对齐 frontend useAutoSelectFirstProject）
        assert_eq!(resolve_project_id(Some(99), &projects), Some(1));
        // 未选 → 第一
        assert_eq!(resolve_project_id(None, &projects), Some(1));
        // 无项目 → None
        assert_eq!(resolve_project_id(None, &[]), None);
    }

    #[test]
    fn trend_day_label_formats_md() {
        assert_eq!(trend_day_label("2026-08-13"), "8/13");
        assert_eq!(trend_day_label("2026-11-02"), "11/2");
        assert_eq!(trend_day_label("bad-date"), "bad-date");
    }

    #[test]
    fn from_fetch_result_maps_to_loaded_empty_error() {
        let data = sample_data();
        assert_eq!(
            ReturnAnalysisState::from_fetch_result(Ok(data.clone())),
            ReturnAnalysisState::Loaded(data)
        );

        // 所有行 + 总结为空 → Empty
        let empty = ReturnAnalysisData {
            response: empty_response(
                "US",
                NaiveDate::from_ymd_opt(2026, 8, 7).unwrap(),
                NaiveDate::from_ymd_opt(2026, 8, 13).unwrap(),
            ),
            selected_project_id: None,
            ..sample_data()
        };
        assert_eq!(
            ReturnAnalysisState::from_fetch_result(Ok(empty)),
            ReturnAnalysisState::Empty
        );

        // 失败 → Error
        assert_eq!(
            ReturnAnalysisState::from_fetch_result(Err("接口 500".to_string())),
            ReturnAnalysisState::Error("接口 500".to_string())
        );
    }

    #[test]
    fn data_is_empty_judgement() {
        assert!(!sample_data().is_empty());
        // 只有排行行也算有数据
        let trend_only = ReturnAnalysisData {
            response: ReturnAnalysisResponse {
                trend_rows: Vec::new(),
                summary_text: String::new(),
                ..sample_response()
            },
            ..sample_data()
        };
        // 排行行仍非空 → 有数据
        assert!(!trend_only.is_empty());
        // 全空 → 空
        let all_empty = ReturnAnalysisData {
            response: empty_response(
                "US",
                NaiveDate::from_ymd_opt(2026, 8, 7).unwrap(),
                NaiveDate::from_ymd_opt(2026, 8, 13).unwrap(),
            ),
            selected_project_id: None,
            ..sample_data()
        };
        assert!(all_empty.is_empty());
    }

    #[test]
    fn return_rate_text_shows_dash_when_no_sales() {
        let with_sales = ReturnRankingItem {
            sales_quantity: 60,
            return_rate: 13.3,
            ..sample_response().ranking_rows[0].clone()
        };
        assert_eq!(return_rate_text(&with_sales), "13.3%");
        let no_sales = ReturnRankingItem {
            sales_quantity: 0,
            return_rate: 13.3,
            ..sample_response().ranking_rows[0].clone()
        };
        assert_eq!(return_rate_text(&no_sales), "--");
    }

    // ---------- 视图级状态转移（TestAppContext，无真实网络） ----------

    fn create_view(cx: &mut gpui::TestAppContext) -> Entity<ReturnAnalysisView> {
        cx.update(|cx| {
            let client = Client::new("http://127.0.0.1:1");
            cx.new(|cx| ReturnAnalysisView::new(cx, client))
        })
    }

    fn read_state(
        cx: &mut gpui::TestAppContext,
        view: &Entity<ReturnAnalysisView>,
    ) -> ReturnAnalysisState {
        cx.read(|app| view.read(app).state.read(app).clone())
    }

    #[gpui::test]
    async fn initial_state_is_loading(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        assert_eq!(read_state(cx, &view), ReturnAnalysisState::Loading);
        // 默认站点 / 近 7 天区间 / 默认 tab
        cx.read(|app| {
            let v = view.read(app);
            assert_eq!(v.country, "US");
            assert_eq!(v.active_tab, ReturnAnalysisTab::Rankings);
            assert!(v.date_range.from.is_some() && v.date_range.to.is_some());
        });
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
        assert_eq!(read_state(cx, &view), ReturnAnalysisState::Loading);

        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.apply_result(2, Ok(data.clone()), cx);
            });
        });
        assert_eq!(read_state(cx, &view), ReturnAnalysisState::Loaded(data));
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
            ReturnAnalysisState::Error("接口 500".to_string())
        );

        // 空载荷 → Empty（记录 projects 列表，供筛选菜单使用）
        let empty = ReturnAnalysisData {
            response: empty_response(
                "US",
                NaiveDate::from_ymd_opt(2026, 8, 7).unwrap(),
                NaiveDate::from_ymd_opt(2026, 8, 13).unwrap(),
            ),
            selected_project_id: None,
            projects: vec![project(1, "测试项目")],
        };
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 2;
                this.apply_result(2, Ok(empty), cx);
            });
        });
        assert_eq!(read_state(cx, &view), ReturnAnalysisState::Empty);
        cx.read(|app| {
            assert_eq!(view.read(app).projects.len(), 1);
        });
    }

    #[gpui::test]
    async fn apply_result_backfills_auto_selected_project(cx: &mut gpui::TestAppContext) {
        // 未选项目 → 载荷携带选中项目 → apply_result 回填（筛选栏显示项目名）
        let view = create_view(cx);
        let data = ReturnAnalysisData {
            projects: vec![project(7, "自动选中")],
            response: sample_response(),
            selected_project_id: Some(7),
        };
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Ok(data), cx);
            });
        });
        cx.read(|app| {
            let v = view.read(app);
            assert_eq!(v.selected_project_id, Some(7));
            assert_eq!(v.projects.len(), 1);
        });
    }

    #[gpui::test]
    async fn select_tab_changes_active_tab(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.select_tab(ReturnAnalysisTab::Summary, cx);
            });
        });
        cx.read(|app| {
            assert_eq!(view.read(app).active_tab, ReturnAnalysisTab::Summary);
        });
        // 同一 tab no-op
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.select_tab(ReturnAnalysisTab::Summary, cx);
            });
        });
        cx.read(|app| {
            assert_eq!(view.read(app).active_tab, ReturnAnalysisTab::Summary);
        });
    }

    /// 渲染冒烟：Loading 态 + 筛选栏可完整渲染不 panic。
    #[gpui::test]
    async fn return_analysis_loading_state_renders(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let view = create_view(cx);
        let (_host, _cx2) =
            cx.add_window_view(|_window, _cx| ReturnAnalysisHost { view: view.clone() });
    }

    /// 渲染冒烟：Loaded 态（数字带 / tab 栏 / 排行表 / 原因表 + 环形图 /
    /// 趋势图 / 总结）可渲染不 panic；全部 7 个 tab 依次切换渲染。
    #[gpui::test]
    async fn return_analysis_loaded_state_renders_all_tabs(cx: &mut gpui::TestAppContext) {
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
            cx.add_window_view(|_window, _cx| ReturnAnalysisHost { view: view.clone() });

        // 依次切换 7 个 tab（每个 tab 的渲染路径都覆盖）
        for tab in ReturnAnalysisTab::ALL {
            cx.update(|cx| {
                view.update(cx, |this, cx| this.select_tab(tab, cx));
            });
            cx.read(|app| {
                assert_eq!(view.read(app).active_tab, tab);
            });
        }
    }

    /// 渲染冒烟：Error 态可渲染不 panic。
    #[gpui::test]
    async fn return_analysis_error_state_renders(cx: &mut gpui::TestAppContext) {
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
            cx.add_window_view(|_window, _cx| ReturnAnalysisHost { view: view.clone() });
    }

    /// 渲染冒烟：Empty 态（无项目 + 有项目）可渲染不 panic。
    #[gpui::test]
    async fn return_analysis_empty_state_renders(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        // 无项目
        let view = create_view(cx);
        let empty = ReturnAnalysisData {
            projects: Vec::new(),
            response: empty_response(
                "US",
                NaiveDate::from_ymd_opt(2026, 8, 7).unwrap(),
                NaiveDate::from_ymd_opt(2026, 8, 13).unwrap(),
            ),
            selected_project_id: None,
        };
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Ok(empty), cx);
            });
        });
        let (_host, _cx2) =
            cx.add_window_view(|_window, _cx| ReturnAnalysisHost { view: view.clone() });
    }

    /// 渲染冒烟：强制深色主题下 Loaded 可渲染不 panic。
    #[gpui::test]
    async fn return_analysis_loaded_renders_in_dark_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
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
            cx.add_window_view(|_window, _cx| ReturnAnalysisHost { view: view.clone() });
        cx.read(|app| assert!(AppTheme::current(app).is_dark()));
    }
}
