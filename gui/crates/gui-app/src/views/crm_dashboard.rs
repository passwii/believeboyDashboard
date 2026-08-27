//! CRM → 数据看板（P5-7，BLF-742）
//!
//! 对齐 web 端 `app/dashboard/crm/dashboard/page.tsx`（约 248 行）的**读取
//! 主面**：本月新增 / 跟进活跃度 KPI 卡行 + 线索漏斗（raw 阶段口径 + 逐级
//! 转化率）+ 每销售业绩表 + 生命周期看板（三种时间分布直方图 + 转化时间
//! 漏斗叠加）。数据源两个端点一次拉全：
//! - `GET /api/v1/crm/dashboard/stats`（gui-api-client::crm）
//! - `GET /api/v1/crm/dashboard/lifecycle`
//!
//! ## 与 web 端的取舍（issue 允许按 macOS 原生习惯精简并说明）
//!
//! - **保留**：四态状态机、KPI 四卡、漏斗 raw 阶段口径（BLF-516 决策 4）、
//!   整体转化率徽标（弃置不进分母）、本期弃置徽标、逐级转化率三格（前档
//!   0 显示 "—"）、每销售业绩三列、生命周期三分布卡（直方图 + 摘要 chips +
//!   转化卡的「N 天内」漏斗叠加）、当前公海徽标；
//! - **精简**：
//!   - 漏斗二层复盘抽屉（`FunnelStageDrawer`，点击某级展开停留时长/卡点
//!     明细，依赖 `GET …/funnel/stage/{stage}` 分页接口）不移植——GUI 无
//!     抽屉/弹层先例，v1 只读主面已覆盖看板核心信号；后续需要时单独立项；
//!   - web FunnelChart 为曲线梯形层；GPUI 无该图型，用「标签 + 比例宽条 +
//!     计数」的水平条形呈现（宽度 ∝ 当前计数 / 最大计数），raw 口径下视觉
//!     等价（层宽即堆人信号）；
//!   - 生命周期直方图沿用 web 的轻量 div 柱实现（不引入图表库），柱高
//!     ∝ count/max，柱顶计数、底部桶名缩写（"30 天以上"→"30 天+"）；
//!   - 数字紧凑格式沿用 GUI stat_band 的 K/M 口径（web 为 zh-CN 万进制，
//!     CRM 计数量级下两者几乎不出现差异）。
//!
//! ## 权限
//!
//! 两端点后端均仅管理员可见（`require_admin`）；非管理员会话请求返回 403，
//! 错误消息透传到错误态（与 web 页面描述「仅管理员可见」一致）。

use gpui::prelude::*;
use gpui::{
    div, px, relative, App, AsyncApp, Context, Entity, FontWeight, Hsla, IntoElement, SharedString,
    Styled, WeakEntity, Window,
};
use gpui_component::button::Button;
use gpui_component::{h_flex, v_flex, Sizable, StyledExt};
use gui_api_client::Client;
use gui_domain::crm::{
    build_stage_funnel, lead_conversion_rate, stage_label, step_rates, time_funnel_stages,
    DashboardStats, FunnelStageBar, LifecycleBoard, LifecycleDistribution, OwnerPerformance,
};

use crate::theme::AppTheme;
use crate::widgets::data_table::{CellAlign, ColumnDef, DataTable};
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「CRM 客户与合作伙伴 → 数据看板」URL（数据权威 gui-domain::sidebar）
pub const CRM_DASHBOARD_URL: &str = "/dashboard/crm/dashboard";

// ---------------------------------------------------------------------------
// 格式化 / 配色辅助
// ---------------------------------------------------------------------------

/// 天数摘要文本（对齐 web `fmt1`：一位小数 + " 天"；无数据显示 "—"）
fn fmt_days(value: Option<f64>) -> String {
    match value {
        Some(v) => format!("{v:.1} 天"),
        None => "—".to_string(),
    }
}

/// 整数计数（千分位；对齐 web StatCard 直接 String() 的可读性诉求取更强格式）
fn fmt_count(value: i64) -> String {
    let text = value.abs().to_string();
    let mut out = String::with_capacity(text.len() + text.len() / 3);
    for (i, ch) in text.chars().enumerate() {
        if i > 0 && (text.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    if value < 0 {
        out.insert(0, '-');
    }
    out
}

/// 百分比文本（一位小数；对齐 web `(rate * 100).toFixed(1)%`）
fn fmt_percent_1(rate: f64) -> String {
    format!("{:.1}%", rate * 100.0)
}

/// 漏斗各阶段条色（收尾清点 BLF-804：裸 hex 收敛到主题图表色板——
/// 亮暗两态成组，蓝系递进表「新→联系中→已验证」，转化态用成功色收口）
fn stage_color(stage: &str, theme: &AppTheme) -> Hsla {
    match stage {
        "new" => theme.chart_primary,
        "contacting" => theme.chart_secondary,
        "qualified" => theme.chart_tertiary,
        "converted" => theme.success,
        _ => theme.text_muted,
    }
}

/// 生命周期三分布卡的圆点色（对齐 web var(--chart-1/2/3) 语义：主/次/三色）
fn distribution_color(ix: usize, theme: &AppTheme) -> Hsla {
    match ix {
        0 => theme.chart_primary,
        1 => theme.chart_secondary,
        _ => theme.chart_tertiary,
    }
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/// 看板聚合数据（stats + lifecycle 一次拉全）
#[derive(Debug, Clone, PartialEq)]
pub struct CrmDashboardData {
    pub stats: DashboardStats,
    pub lifecycle: LifecycleBoard,
}

impl CrmDashboardData {
    /// 页面级空态判定：漏斗全零 + 无业绩行 + 三分布均无样本（各区块在
    /// Loaded 态仍有独立空态文案，页面级 Empty 仅在完全无数据时进入）
    fn is_empty(&self) -> bool {
        let funnel_total: i64 = self.stats.lead_funnel.values().sum();
        let lifecycle_empty = [
            &self.lifecycle.first_follow,
            &self.lifecycle.conversion,
            &self.lifecycle.churn,
        ]
        .iter()
        .all(|d| d.summary.sample_count == 0);
        funnel_total == 0 && self.stats.per_owner.is_empty() && lifecycle_empty
    }
}

/// 视图四态（对齐既有业务视图约定）
#[derive(Debug, Clone, PartialEq)]
pub enum CrmDashboardState {
    /// 首屏 / 刷新中
    Loading,
    /// 数据就绪
    Loaded(Box<CrmDashboardData>),
    /// 完全无数据
    Empty,
    /// 请求失败（携带用户可读消息）
    Error(String),
}

impl CrmDashboardState {
    fn from_fetch_result(result: Result<CrmDashboardData, String>) -> Self {
        match result {
            Ok(data) => {
                if data.is_empty() {
                    Self::Empty
                } else {
                    Self::Loaded(Box::new(data))
                }
            }
            Err(msg) => Self::Error(msg),
        }
    }
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// CRM 数据看板视图（四态状态机 + 双端点拉取 + 竞态保护）
pub struct CrmDashboardView {
    state: Entity<CrmDashboardState>,
    /// 带会话的 API client
    client: Client,
    /// 每销售业绩表（Stage 0 DataTable，总存在）
    owner_table: Entity<DataTable<OwnerPerformance>>,
    /// 主请求竞态保护
    latest_request_id: u64,
}

impl CrmDashboardView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| CrmDashboardState::Loading);
        let owner_table = cx.new(|_| {
            DataTable::new("crm-owner-table", owner_columns())
                .striped(true)
                .empty_text("暂无业绩数据")
        });
        Self {
            state,
            client,
            owner_table,
            latest_request_id: 0,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> CrmDashboardState {
        self.state.read(cx).clone()
    }

    /// 重新拉取：首屏 / 错误重试 / 空态刷新共用入口（竞态保护；每次调用
    /// 递增 `latest_request_id` 并进入 Loading）。stats + lifecycle 顺序
    /// 拉取，任一失败整体报错——与 web `Promise.all` 同口径。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;

        self.state.update(cx, |state, cx| {
            *state = CrmDashboardState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move { crate::runtime::runtime().block_on(load_dashboard(&client)) })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 应用拉取结果（竞态保护）：落业绩表行 + 状态机
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<CrmDashboardData, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok(data) = &result {
            self.owner_table.update(cx, |t, cx| {
                t.set_rows(data.stats.per_owner.clone(), cx);
            });
        } else {
            self.owner_table
                .update(cx, |t, cx| t.set_rows(Vec::new(), cx));
        }
        let next = CrmDashboardState::from_fetch_result(result);
        self.state.update(cx, |state, cx| {
            *state = next;
            cx.notify();
        });
    }
}

/// 数据加载：stats → lifecycle（顺序拉取；任一失败整体报错）
async fn load_dashboard(client: &Client) -> Result<CrmDashboardData, String> {
    let stats = client
        .crm_dashboard_stats()
        .await
        .map_err(|e| e.user_message())?;
    let lifecycle = client
        .crm_lifecycle_board()
        .await
        .map_err(|e| e.user_message())?;
    Ok(CrmDashboardData { stats, lifecycle })
}

/// 每销售业绩表列（负责人 / 名下客户数 / 本月转化；数字列右对齐）
fn owner_columns() -> Vec<ColumnDef<OwnerPerformance>> {
    vec![
        ColumnDef::text("owner", "负责人", |p: &OwnerPerformance, _| {
            SharedString::from(p.owner_name.clone().unwrap_or_else(|| p.owner_id.clone()))
        })
        .width(160.0),
        ColumnDef::number(
            "customers",
            "名下客户数",
            |p: &OwnerPerformance| p.customer_count as f64,
            |p: &OwnerPerformance, _| SharedString::from(fmt_count(p.customer_count)),
        )
        .align(CellAlign::Right)
        .width(120.0),
        ColumnDef::number(
            "converted",
            "本月转化",
            |p: &OwnerPerformance| p.converted_this_month as f64,
            |p: &OwnerPerformance, _| SharedString::from(fmt_count(p.converted_this_month)),
        )
        .align(CellAlign::Right)
        .width(120.0),
    ]
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for CrmDashboardView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let view = cx.entity();

        v_flex()
            .id("crm-dashboard")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            .child(page_header(&view))
            .child(match state {
                CrmDashboardState::Loading => render_loading(&app_theme).into_any_element(),
                CrmDashboardState::Error(msg) => state_views::error_state(
                    &view,
                    &app_theme,
                    "crm-dashboard-error",
                    "看板数据加载失败",
                    msg,
                    |this, cx| this.reload(cx),
                )
                .into_any_element(),
                CrmDashboardState::Empty => state_views::empty_state_with_action_desc(
                    &view,
                    &app_theme,
                    "crm-dashboard-empty",
                    "icons/bar-chart-3.svg",
                    "暂无看板数据",
                    Some(
                        "线索漏斗 / 业绩 / 生命周期均无数据；确认 CRM 已有线索与客户后刷新"
                            .to_string(),
                    ),
                    "刷新",
                    |this, cx| this.reload(cx),
                )
                .into_any_element(),
                CrmDashboardState::Loaded(data) => {
                    render_loaded(cx, &app_theme, &data, self.owner_table.clone())
                        .into_any_element()
                }
            })
    }
}

/// 页面头部：标题 + 副标题 + 刷新按钮（对齐 web PageHeader actions）
fn page_header(view: &Entity<CrmDashboardView>) -> impl IntoElement {
    let view_for_refresh = view.clone();
    PageHeader::new("数据看板")
        .subtitle("线索漏斗 / 本月新增 / 跟进活跃度 / 每销售业绩（仅管理员可见）")
        .action(
            Button::new("crm-dashboard-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_ev, _w, cx| {
                    view_for_refresh.update(cx, |this, cx| this.reload(cx));
                }),
        )
}

/// Loading 骨架：KPI 卡行 + 漏斗块 + 表格块 + 图表网格
fn render_loading(theme: &AppTheme) -> impl IntoElement {
    state_views::skeleton_loading(
        theme,
        &[
            SkeletonBlock::Kpi(4),
            SkeletonBlock::Chart(220.0),
            SkeletonBlock::Table(180.0),
            SkeletonBlock::ChartGrid {
                count: 3,
                columns: 3,
                height: 200.0,
            },
        ],
    )
}

/// Loaded：KPI 卡行 + 线索漏斗 + 每销售业绩 + 生命周期
fn render_loaded(
    cx: &mut Context<CrmDashboardView>,
    theme: &AppTheme,
    data: &CrmDashboardData,
    owner_table: Entity<DataTable<OwnerPerformance>>,
) -> gpui::AnyElement {
    let reduce = crate::motion::reduce_motion(cx);

    crate::motion::enter_fade_in(
        SharedString::from("crm-dashboard-loaded-fade"),
        v_flex()
            .id("crm-dashboard-loaded")
            .gap_4()
            .child(content_guard().child(render_kpi_cards(&data.stats, theme)))
            .child(content_guard().child(render_funnel_card(&data.stats, theme)))
            .child(content_guard().child(render_owner_card(theme, owner_table)))
            .child(content_guard().child(render_lifecycle_card(&data.lifecycle, theme))),
        reduce,
    )
    .into_any_element()
}

/// KPI 卡行（label + 数值；对齐 web StatCardRow 四卡）
fn render_kpi_cards(stats: &DashboardStats, theme: &AppTheme) -> impl IntoElement {
    let cards = [
        ("本月新增客户", stats.new_this_month.new_customers),
        ("本月新增线索", stats.new_this_month.new_leads),
        ("本月转化", stats.new_this_month.converted_count),
        ("近 7 天跟进", stats.follow_activity.follow_count_7d),
    ];
    h_flex()
        .id("crm-kpi-row")
        .gap_3()
        .flex_wrap()
        .children(cards.map(|(label, value)| {
            v_flex()
                .id(SharedString::from(format!("crm-kpi-{label}")))
                .flex_1()
                .min_w_40()
                .gap_1p5()
                .p_3()
                .rounded(px(theme.radius_lg))
                .bg(theme.card_bg)
                .shadow(vec![theme.card_shadow_box()])
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(label.to_string()),
                )
                .child(
                    div()
                        .text_lg()
                        .font_semibold()
                        .text_color(theme.text_primary)
                        .truncate()
                        .child(fmt_count(value)),
                )
        }))
}

/// 卡片外壳（card_bg + radius_lg + 轻投影 + 内边距；对齐 commission table_card 外壳）
fn card_shell(id: &'static str, theme: &AppTheme) -> gpui::Stateful<gpui::Div> {
    v_flex()
        .id(id)
        .gap_3()
        .p_4()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
}

/// 区块头（标题 + 说明 + 右侧徽标位）
fn card_header(
    title: &'static str,
    subtitle: &'static str,
    badges: Vec<gpui::AnyElement>,
    theme: &AppTheme,
) -> gpui::Div {
    h_flex()
        .items_start()
        .justify_between()
        .flex_wrap()
        .gap_2()
        .child(
            v_flex()
                .gap_0p5()
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_primary)
                        .child(title.to_string()),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(subtitle.to_string()),
                ),
        )
        .child(h_flex().gap_2().children(badges))
}

/// 圆角小徽标（转化率 / 弃置 / 公海数共用）
fn pill(id: &'static str, text: String, fg: Hsla, bg: Hsla) -> gpui::AnyElement {
    h_flex()
        .id(id)
        .items_center()
        .gap_1()
        .rounded_full()
        .px_2p5()
        .py_0p5()
        .bg(bg)
        .child(
            div()
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                .child(text),
        )
        .into_any_element()
}

/// 线索漏斗卡：阶段条形（raw 口径）+ 逐级转化率三格
fn render_funnel_card(stats: &DashboardStats, theme: &AppTheme) -> gpui::AnyElement {
    let stages = build_stage_funnel(&stats.lead_funnel);
    let funnel_total: i64 = stages.iter().map(|s| s.value).sum();
    let discarded = stats.lead_funnel.get("discarded").copied().unwrap_or(0);

    // 徽标：整体转化率（弃置不进分母）+ 本期弃置
    let mut badges: Vec<gpui::AnyElement> = Vec::new();
    if let Some(rate) = lead_conversion_rate(&stats.lead_funnel) {
        badges.push(pill(
            "crm-funnel-conversion",
            format!("整体转化率 {}", fmt_percent_1(rate)),
            theme.success,
            theme.success.opacity(0.12),
        ));
    }
    if discarded > 0 {
        badges.push(pill(
            "crm-funnel-discarded",
            format!("本期弃置 {}（不计入漏斗）", fmt_count(discarded)),
            theme.text_secondary,
            theme.muted_fill,
        ));
    }

    let body: gpui::AnyElement = if funnel_total > 0 {
        v_flex()
            .gap_4()
            .child(render_funnel_bars(&stages, theme))
            .child(render_step_rates(&stages, theme))
            .into_any_element()
    } else {
        h_flex()
            .h(px(220.0))
            .items_center()
            .justify_center()
            .child(
                div()
                    .text_sm()
                    .text_color(theme.text_muted)
                    .child("暂无漏斗数据"),
            )
            .into_any_element()
    };

    card_shell("crm-funnel-card", theme)
        .child(card_header(
            "线索漏斗",
            "阶段口径：各阶段当前线索数（raw，不累计）",
            badges,
            theme,
        ))
        .child(body)
        .into_any_element()
}

/// 漏斗条形：每档 [标签 | 比例宽条 | 计数]（宽度 ∝ value/max）
fn render_funnel_bars(stages: &[FunnelStageBar], theme: &AppTheme) -> impl IntoElement {
    let max = stages.iter().map(|s| s.value).max().unwrap_or(0).max(1);
    v_flex()
        .id("crm-funnel-bars")
        .gap_2()
        .children(stages.iter().map(|stage| {
            let ratio = stage.value as f32 / max as f32;
            h_flex()
                .id(SharedString::from(format!(
                    "crm-funnel-bar-{}",
                    stage.stage
                )))
                .items_center()
                .gap_3()
                .child(
                    div()
                        .w(px(56.0))
                        .text_xs()
                        .text_color(theme.text_secondary)
                        .child(stage.label.to_string()),
                )
                .child(
                    // 条轨：全宽底 + 比例宽填充（最小可见宽 2px）
                    div()
                        .flex_1()
                        .h(px(18.0))
                        .rounded(px(theme.radius))
                        .bg(theme.muted_fill)
                        .child(
                            div()
                                .h_full()
                                .w(relative(
                                    ratio.clamp(if stage.value > 0 { 0.02 } else { 0.0 }, 1.0),
                                ))
                                .rounded(px(theme.radius))
                                .bg(stage_color(stage.stage, theme)),
                        ),
                )
                .child(
                    div()
                        .w(px(48.0))
                        .text_right()
                        .text_xs()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_primary)
                        .child(crate::views::stat_band::format_compact_number(stage.value)),
                )
        }))
}

/// 逐级转化率三格：「from → to」+ 百分比 + 进度条（定位漏斗卡点）
fn render_step_rates(stages: &[FunnelStageBar], theme: &AppTheme) -> impl IntoElement {
    let rates = step_rates(stages);
    h_flex()
        .id("crm-step-rates")
        .gap_2()
        .flex_wrap()
        .children(rates.into_iter().enumerate().map(|(i, rate)| {
            let from = stages[i].label;
            let to = stages[i + 1].label;
            let pct = rate.unwrap_or(0.0).clamp(0.0, 1.0) as f32;
            h_flex()
                .id(SharedString::from(format!("crm-step-rate-{i}")))
                .flex_1()
                .min_w(px(208.0))
                .flex_col()
                .gap_1p5()
                .p_2()
                .rounded(px(theme.radius))
                .border_1()
                .border_color(theme.separator)
                .bg(theme.muted_fill.opacity(0.4))
                .child(
                    h_flex()
                        .justify_between()
                        .gap_2()
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.text_muted)
                                .truncate()
                                .child(format!("{from} → {to}")),
                        )
                        .child(
                            div()
                                .text_xs()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.text_primary)
                                .child(match rate {
                                    Some(r) => fmt_percent_1(r),
                                    None => "—".to_string(),
                                }),
                        ),
                )
                .child(
                    div()
                        .h(px(4.0))
                        .w_full()
                        .rounded_full()
                        .bg(theme.muted_fill)
                        .child(
                            div()
                                .h_full()
                                .w(relative(pct))
                                .rounded_full()
                                .bg(theme.success.opacity(0.7)),
                        ),
                )
        }))
}

/// 每销售业绩卡（Stage 0 DataTable；空态由表格 empty_text 承载）
fn render_owner_card(
    theme: &AppTheme,
    owner_table: Entity<DataTable<OwnerPerformance>>,
) -> gpui::AnyElement {
    card_shell("crm-owner-card", theme)
        .child(card_header(
            "每销售业绩",
            "按负责人分组的名下客户与本月转化",
            Vec::new(),
            theme,
        ))
        .child(owner_table)
        .into_any_element()
}

/// 生命周期卡：三分布子卡（直方图 + 摘要 chips；转化卡加时间漏斗叠加）
fn render_lifecycle_card(board: &LifecycleBoard, theme: &AppTheme) -> gpui::AnyElement {
    let mut badges: Vec<gpui::AnyElement> = Vec::new();
    if board.now_in_sea > 0 {
        badges.push(pill(
            "crm-lifecycle-sea",
            format!("当前公海 {} 家", fmt_count(board.now_in_sea)),
            theme.text_secondary,
            theme.muted_fill,
        ));
    }

    let distributions = [
        (&board.first_follow, false),
        (&board.conversion, true),
        (&board.churn, false),
    ];

    card_shell("crm-lifecycle-card", theme)
        .child(card_header(
            "生命周期",
            "客户从创建到 首次跟进 / 转化 / 流失 的时间分布（天）",
            badges,
            theme,
        ))
        .child(
            h_flex()
                .id("crm-lifecycle-grid")
                .gap_3()
                .flex_wrap()
                .children(
                    distributions
                        .iter()
                        .enumerate()
                        .map(|(ix, (dist, with_funnel))| {
                            render_distribution_card(dist, ix, *with_funnel, theme)
                        }),
                ),
        )
        .into_any_element()
}

/// 单张分布子卡：标题 + 口径说明 + 直方图 + 摘要 chips（+ 时间漏斗叠加）
fn render_distribution_card(
    dist: &LifecycleDistribution,
    color_ix: usize,
    with_funnel: bool,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let color = distribution_color(color_ix, theme);
    let has_sample = dist.summary.sample_count > 0;

    let body: gpui::AnyElement = if has_sample {
        v_flex()
            .gap_3()
            .child(render_histogram(dist, theme))
            .child(render_summary_chips(dist, theme))
            .when(with_funnel, |this| {
                let stages = time_funnel_stages(dist);
                if stages.is_empty() {
                    this
                } else {
                    this.child(render_time_funnel(&stages, theme))
                }
            })
            .into_any_element()
    } else {
        h_flex()
            .h(px(96.0))
            .items_center()
            .justify_center()
            .child(
                div()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child("暂无数据"),
            )
            .into_any_element()
    };

    v_flex()
        .id(SharedString::from(format!("crm-lifecycle-{}", dist.metric)))
        .flex_1()
        .min_w_72()
        .flex_col()
        .gap_2()
        .p_3()
        .rounded(px(theme.radius_lg))
        .border_1()
        .border_color(theme.separator.opacity(0.6))
        .bg(theme.window_bg)
        .child(
            h_flex()
                .justify_between()
                .gap_2()
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_primary)
                        .truncate()
                        .child(dist.label.clone()),
                )
                .child(div().size_2().rounded_full().bg(color)),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .line_height(relative(1.35))
                .child(dist.description.clone()),
        )
        .child(body)
        .into_any_element()
}

/// 直方图：div 柱（高度 ∝ count/max，柱顶计数，底部桶名缩写）
fn render_histogram(dist: &LifecycleDistribution, theme: &AppTheme) -> impl IntoElement {
    let max = dist
        .buckets
        .iter()
        .map(|b| b.count)
        .max()
        .unwrap_or(0)
        .max(1) as f32;
    let chart_h = 88.0f32;

    v_flex()
        .id(SharedString::from(format!("crm-hist-{}", dist.metric)))
        .gap_1()
        .child(
            h_flex()
                .items_end()
                .gap_1p5()
                .h(px(chart_h))
                .children(dist.buckets.iter().map(|b| {
                    let bar_h = if b.count == 0 {
                        0.0
                    } else {
                        ((b.count as f32 / max) * chart_h).max(6.0)
                    };
                    v_flex()
                        .id(SharedString::from(format!(
                            "crm-hist-bar-{}-{}",
                            dist.metric, b.label
                        )))
                        .flex_1()
                        .items_center()
                        .justify_end()
                        .gap_0p5()
                        .when(b.count > 0, |this| {
                            this.child(
                                div()
                                    .text_size(px(crate::theme::fs(crate::theme::FONT_XS)))
                                    .text_color(theme.text_muted)
                                    .child(b.count.to_string()),
                            )
                        })
                        .child(
                            div()
                                .w_full()
                                .h(px(bar_h))
                                .rounded_t(px(theme.radius))
                                .bg(theme.chart_primary.opacity(0.7)),
                        )
                })),
        )
        .child(
            h_flex()
                .gap_1p5()
                .border_t_1()
                .border_color(theme.separator.opacity(0.6))
                .pt_1()
                .children(dist.buckets.iter().map(|b| {
                    div()
                        .flex_1()
                        .text_center()
                        .text_size(px(crate::theme::fs(crate::theme::FONT_XS)))
                        .text_color(theme.text_muted)
                        .truncate()
                        .child(short_bucket_label(&b.label))
                })),
        )
}

/// 桶名缩写（横轴空间有限；对齐 web shortLabel："30 天以上" → "30 天+"）
fn short_bucket_label(label: &str) -> String {
    label.replace("天以上", "天+")
}

/// 摘要 chips：样本 / 总体 / 均值 / 中位 / P90
fn render_summary_chips(dist: &LifecycleDistribution, theme: &AppTheme) -> impl IntoElement {
    let s = &dist.summary;
    let chips = [
        ("样本", s.sample_count.to_string()),
        ("总体", s.total_count.to_string()),
        ("均值", fmt_days(s.avg_days)),
        ("中位", fmt_days(s.median_days)),
        ("P90", fmt_days(s.p90_days)),
    ];
    h_flex()
        .id(SharedString::from(format!("crm-chips-{}", dist.metric)))
        .gap_1p5()
        .flex_wrap()
        .children(chips.map(|(label, value)| {
            h_flex()
                .id(SharedString::from(format!(
                    "crm-chip-{}-{label}",
                    dist.metric
                )))
                .items_center()
                .gap_1()
                .rounded(px(theme.radius))
                .px_2()
                .py_0p5()
                .bg(theme.muted_fill.opacity(0.6))
                .child(
                    div()
                        .text_size(px(crate::theme::fs(crate::theme::FONT_XS)))
                        .text_color(theme.text_muted)
                        .child(label.to_string()),
                )
                .child(
                    div()
                        .text_size(px(crate::theme::fs(crate::theme::FONT_XS)))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_primary)
                        .child(value),
                )
        }))
}

/// 转化时间漏斗叠加（转化卡专属）：[档名 | 比例宽条 | N 个]
fn render_time_funnel(
    stages: &[gui_domain::crm::TimeFunnelStage],
    theme: &AppTheme,
) -> impl IntoElement {
    let max = stages.iter().map(|s| s.value).max().unwrap_or(0).max(1);
    v_flex()
        .id("crm-time-funnel")
        .gap_1p5()
        .child(
            div()
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text_muted)
                .child("转化时间漏斗（漏斗叠加）"),
        )
        .children(stages.iter().map(|stage| {
            let ratio = stage.value as f32 / max as f32;
            h_flex()
                .id(SharedString::from(format!(
                    "crm-time-funnel-{}",
                    stage.label
                )))
                .items_center()
                .gap_2()
                .child(
                    div()
                        .w(px(52.0))
                        .text_size(px(crate::theme::fs(crate::theme::FONT_XS)))
                        .text_color(theme.text_secondary)
                        .truncate()
                        .child(stage.label.clone()),
                )
                .child(
                    div()
                        .flex_1()
                        .h(px(12.0))
                        .rounded(px(theme.radius))
                        .bg(theme.muted_fill)
                        .child(
                            div()
                                .h_full()
                                .w(relative(
                                    ratio.clamp(if stage.value > 0 { 0.02 } else { 0.0 }, 1.0),
                                ))
                                .rounded(px(theme.radius))
                                .bg(theme.chart_secondary.opacity(0.8)),
                        ),
                )
                .child(
                    div()
                        .w(px(36.0))
                        .text_right()
                        .text_size(px(crate::theme::fs(crate::theme::FONT_XS)))
                        .text_color(theme.text_muted)
                        .child(format!("{} 个", stage.value)),
                )
        }))
}

/// stage_label 供测试断言展示名映射（re-export 避免 unused 警告路径分歧）
#[allow(unused_imports)]
use stage_label as _stage_label_reexport;

#[cfg(test)]
mod tests {
    use super::*;
    use gui_domain::crm::{LifecycleBucket, LifecycleSummary};

    fn dummy_client() -> Client {
        Client::new("http://127.0.0.1:1")
    }

    fn bucket(
        label: &str,
        count: i64,
        max_days: Option<f64>,
        cumulative_pct: f64,
    ) -> LifecycleBucket {
        LifecycleBucket {
            label: label.to_string(),
            min_days: 0.0,
            max_days,
            count,
            pct: 0.0,
            cumulative_pct,
        }
    }

    fn sample_data() -> CrmDashboardData {
        let mut lead_funnel = std::collections::BTreeMap::new();
        lead_funnel.insert("new".to_string(), 10);
        lead_funnel.insert("contacting".to_string(), 6);
        lead_funnel.insert("qualified".to_string(), 3);
        lead_funnel.insert("converted".to_string(), 2);
        lead_funnel.insert("discarded".to_string(), 4);
        CrmDashboardData {
            stats: DashboardStats {
                lead_funnel,
                new_this_month: gui_domain::crm::NewThisMonth {
                    new_customers: 5,
                    new_leads: 10,
                    converted_count: 2,
                },
                follow_activity: gui_domain::crm::FollowActivity {
                    follow_count_7d: 18,
                },
                per_owner: vec![OwnerPerformance {
                    owner_id: "u-1".into(),
                    owner_name: Some("张三".into()),
                    customer_count: 12,
                    converted_this_month: 2,
                }],
            },
            lifecycle: LifecycleBoard {
                first_follow: LifecycleDistribution {
                    metric: "first_follow".into(),
                    label: "首次跟进".into(),
                    description: "客户创建到第一条跟进".into(),
                    buckets: vec![
                        bucket("1 天内", 8, Some(1.0), 0.4),
                        bucket("3-7 天", 6, Some(7.0), 0.7),
                        bucket("30 天以上", 2, None, 1.0),
                    ],
                    summary: LifecycleSummary {
                        sample_count: 20,
                        total_count: 25,
                        avg_days: Some(4.2),
                        median_days: Some(3.0),
                        p90_days: Some(12.0),
                        max_days: Some(40.0),
                    },
                },
                conversion: LifecycleDistribution {
                    metric: "conversion".into(),
                    label: "转化".into(),
                    description: "线索创建到转化".into(),
                    buckets: vec![
                        bucket("1 天内", 1, Some(1.0), 0.2),
                        bucket("3-7 天", 2, Some(7.0), 0.6),
                    ],
                    summary: LifecycleSummary {
                        sample_count: 5,
                        total_count: 25,
                        avg_days: Some(6.0),
                        median_days: Some(5.0),
                        p90_days: None,
                        max_days: None,
                    },
                },
                churn: LifecycleDistribution {
                    metric: "churn".into(),
                    label: "流失".into(),
                    description: "客户创建到首次回公海".into(),
                    buckets: vec![],
                    summary: LifecycleSummary {
                        sample_count: 0,
                        total_count: 25,
                        ..Default::default()
                    },
                },
                now_in_sea: 7,
            },
        }
    }

    // ---------- 纯函数 ----------

    #[test]
    fn fmt_helpers_match_web_display() {
        assert_eq!(fmt_days(Some(4.25)), "4.2 天"); // toFixed 一位小数截断显示
        assert_eq!(fmt_days(None), "—");
        assert_eq!(fmt_count(12400), "12,400");
        assert_eq!(fmt_percent_1(0.333), "33.3%");
        assert_eq!(short_bucket_label("30 天以上"), "30 天+");
        assert_eq!(short_bucket_label("3-7 天"), "3-7 天");
    }

    /// 页面级空态判定：漏斗全零 + 无业绩 + 三分布无样本
    #[test]
    fn empty_detection_requires_all_sections_blank() {
        let empty = CrmDashboardData {
            stats: DashboardStats::default(),
            lifecycle: LifecycleBoard::default(),
        };
        assert!(empty.is_empty());

        let mut only_stats = empty.clone();
        only_stats.stats.lead_funnel.insert("new".to_string(), 1);
        assert!(!only_stats.is_empty());

        let mut only_owner = empty.clone();
        only_owner.stats.per_owner.push(OwnerPerformance::default());
        assert!(!only_owner.is_empty());

        let mut only_lifecycle = empty;
        only_lifecycle.lifecycle.first_follow.summary.sample_count = 1;
        assert!(!only_lifecycle.is_empty());
    }

    /// 状态机落点：全空数据 → Empty；有数据 → Loaded；错误 → Error
    #[test]
    fn state_from_fetch_result_transitions() {
        let data = sample_data();
        assert_eq!(
            CrmDashboardState::from_fetch_result(Ok(data.clone())),
            CrmDashboardState::Loaded(Box::new(data.clone()))
        );
        let empty_data = CrmDashboardData {
            stats: DashboardStats::default(),
            lifecycle: LifecycleBoard::default(),
        };
        assert_eq!(
            CrmDashboardState::from_fetch_result(Ok(empty_data)),
            CrmDashboardState::Empty
        );
        assert_eq!(
            CrmDashboardState::from_fetch_result(Err("仅管理员可访问".into())),
            CrmDashboardState::Error("仅管理员可访问".into())
        );
    }

    // ---------- 渲染冒烟（亮 / 暗 × 四态 + 减弱动态） ----------

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
            let (_view, _cx) =
                cx.add_window_view(|_window, cx| CrmDashboardView::new(cx, dummy_client()));
        }
    }

    #[gpui::test]
    async fn renders_loaded_in_light_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let (view, cx2) =
            cx.add_window_view(|_window, cx| CrmDashboardView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            let data = sample_data();
            this.owner_table.update(cx, |t, cx| {
                t.set_rows(data.stats.per_owner.clone(), cx);
            });
            this.state.update(cx, |state, _| {
                *state = CrmDashboardState::Loaded(Box::new(data));
            });
        });
        cx2.read(|app| assert!(!crate::theme::AppTheme::current(app).is_dark()));
    }

    #[gpui::test]
    async fn renders_loaded_in_dark_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (view, cx2) =
            cx.add_window_view(|_window, cx| CrmDashboardView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            let data = sample_data();
            this.owner_table.update(cx, |t, cx| {
                t.set_rows(data.stats.per_owner.clone(), cx);
            });
            this.state.update(cx, |state, _| {
                *state = CrmDashboardState::Loaded(Box::new(data));
            });
        });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    #[gpui::test]
    async fn renders_error_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| CrmDashboardView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = CrmDashboardState::Error("仅管理员可访问".into());
            });
        });
    }

    #[gpui::test]
    async fn renders_empty_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| CrmDashboardView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = CrmDashboardState::Empty;
            });
        });
    }

    #[gpui::test]
    async fn renders_loaded_with_reduce_motion(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            cx.set_global(crate::motion::MotionPref(true));
        });
        let (view, cx2) =
            cx.add_window_view(|_window, cx| CrmDashboardView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            let data = sample_data();
            this.state.update(cx, |state, _| {
                *state = CrmDashboardState::Loaded(Box::new(data));
            });
        });
    }

    // ---------- 状态机动作 ----------

    /// reload 递增竞态 id 并进入 Loading；过期响应被丢弃（apply_result 竞态保护）
    #[gpui::test]
    async fn reload_bumps_request_id_and_drops_stale_results(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| CrmDashboardView::new(cx, dummy_client()));

        view.update(cx2, |this, cx| {
            let before = this.latest_request_id;
            this.reload(cx);
            assert!(this.latest_request_id > before, "reload 应递增竞态 id");
            assert_eq!(this.current_state(cx), CrmDashboardState::Loading);

            // 过期响应（request_id 落后于 latest）应被丢弃，不改变状态
            let stale_id = this.latest_request_id - 1;
            this.apply_result(stale_id, Err("过期响应不应落地".into()), cx);
            assert_eq!(this.current_state(cx), CrmDashboardState::Loading);
        });

        // 新鲜响应正常落地
        view.update(cx2, |this, cx| {
            let fresh_id = this.latest_request_id;
            this.apply_result(fresh_id, Ok(sample_data()), cx);
            assert!(matches!(
                this.current_state(cx),
                CrmDashboardState::Loaded(_)
            ));
        });
    }
}
