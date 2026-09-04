//! 全局 Footer 系统状态栏（BLF-797，父 issue「空间栅格」节第 6 条）
//!
//! 固定 24px 全宽状态条（[`crate::views::shell::FOOTER_HEIGHT`]），四段信息以
//! 1px 竖分隔线切分，文字统一辅助级字号 [`crate::theme::FONT_FOOTER`]：
//!
//! ```text
//! ┌────────────────────────────┬──────────────────┬───────────┬───────────┐
//! │ ↻  USD 7.2345 EUR 7.8901 … │ ● DB 正常 14:05  │ 🔔 3      │ P95 128ms │
//! └────────────────────────────┴──────────────────┴───────────┴───────────┘
//!      汇率 ticker（手动刷新）        同步引擎 DB 状态     未读徽标     延迟指标
//! ```
//!
//! 四段数据面：
//! 1. **汇率 ticker**：USD/EUR/GBP→RMB。数据走 `Client::exchange_rate_list`
//!    （逐币种 `page_size=1` 取该货币最新一条，后端按 `year_month desc` 排序），
//!    定时轮询 `RATE_POLL_INTERVAL`（≥5 分钟规格）+ 左端手动刷新钮（刷新整条
//!    状态栏）。缺数据 / 轮询失败一律「--」占位。展示形态为静态平铺而非无限
//!    滚动 marquee：主窗最小宽 960px（main.rs `window_min_size`）下三组汇率
//!    约 260px 必然放得下，marquee 只会白烧 GPU 且违背 reduce-motion 无障碍
//!    约定——如后续确需滚动再立项。
//! 2. **同步引擎 DB 状态**：绿/黄/红 pill + 最近检查时刻。接数据库状态页同源
//!    接口 `/api/v1/system-management/data-management/status`（view 类审计
//!    后端默认不落库，低频轮询无审计噪音）。语义：绿 = 主库连通；
//!    红 = 后端明确报 unhealthy；黄 = 轮询失败 / 超时（断网降级，不 panic）。
//!    **待后端补齐项**（完成评论已列需求清单）：现接口只有探测时刻
//!    `checked_at`（≈请求时刻），没有真实「最近同步完成时间」——建议后端补
//!    一个轻量聚合端点（内部任务心跳或关键表 max(updated_at)），届时本段
//!    仅改 fetch_db_status 数据源即可，pill 语义与渲染不变。
//! 3. **未读通知徽标**：`/api/v1/notifications/unread-count`，
//!    `UNREAD_POLL_INTERVAL`（30s）轮询对齐 web `server-notifications-context.
//!    tsx` 的 30s 行为；0 未读只显示铃铛不显示数字（对齐 web sidebar）。
//! 4. **延迟指标**：客户端埋点近似值——`gui_api_client::metrics` 把每次 JSON
//!    请求耗时推进进程级滑动窗口，本条渲染期读 P95 快照；快照刷新由独立轻量
//!    tick 驱动（`LATENCY_REFRESH_INTERVAL`，纯 notify 无网络请求）。
//!
//! 断网 / 超时纪律：所有网络结果经 request-id 守卫应用（竞态安全），失败一律
//! 降级占位符 + `tracing::warn!`，绝不 unwrap 网络结果——footer 不 panic、
//! 不白块（验收第 2 条）。

use gpui::{div, prelude::*, px, Context, EventEmitter, Render, SharedString, Styled};
use gui_api_client::metrics;
use gui_api_client::Client;
use gui_domain::exchange_rate::ExchangeRateItem;

use crate::icon::icon_path;
use crate::theme::{self, AppTheme};
use crate::views::shell::FOOTER_HEIGHT;
use crate::widgets::data_table::TabularNumsExt;

/// BLF-830：Footer 事件（密度切换上抛组合根）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FooterEvent {
    /// 用户在密度分段控件中选中了新档位
    DensityChanged(theme::DensityLevel),
}

// ---------------------------------------------------------------------------
// 轮询节奏常量（规格锚点）
// ---------------------------------------------------------------------------

/// 汇率 ticker 轮询间隔（规格「≥5 分钟一次」取下限）
pub const RATE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(300);
/// 同步引擎 DB 状态轮询间隔（规格未定值；60s 对齐状态页手动刷新体感，
/// 接口为 `SELECT 1` 级廉价探测且 view 类审计不落库）
pub const DB_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);
/// 未读通知轮询间隔（规格：对齐 Web 侧 30s 行为）
pub const UNREAD_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
/// 延迟指标快照刷新 tick（纯 notify 重绘，不发请求）
pub const LATENCY_REFRESH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// ticker 展示的币种（顺序即展示顺序；USD/EUR/GBP→RMB 规格）
pub const TICKER_CURRENCIES: [&str; 3] = ["USD", "EUR", "GBP"];

// ---------------------------------------------------------------------------
// 状态模型（纯数据，单测直接构造断言）
// ---------------------------------------------------------------------------

/// 汇率段状态：`Loading`（首拉中）→ `Loaded`（逐币种最新一条；`None` = 该币种
/// 无数据 / 拉取失败，渲染「--」占位）。轮询失败不清空已有数据以外的部分——
/// 整段失败即全部 `None`，视觉退化为全「--」（验收：失败降级为占位符）。
#[derive(Debug, Clone, PartialEq, Default)]
pub enum RateState {
    /// 尚无数据（首拉进行中）
    #[default]
    Loading,
    /// 与 [`TICKER_CURRENCIES`] 对齐的最新汇率（`None` = 该币种占位「--」；
    /// Box 压枚举尺寸——ExchangeRateItem 携带备注图 Vec，三连数组超 clippy
    /// large_enum_variant 阈值）
    Loaded(Box<[Option<ExchangeRateItem>; TICKER_CURRENCIES.len()]>),
}

/// 同步引擎 DB 状态（pill 三色语义见模块注释）
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum DbSyncState {
    /// 尚未拿到任何一次成功探测（灰点兜底，等价黄色语义「未知」）
    #[default]
    Unknown,
    /// 主库连通（绿 pill）+ 检查时刻显示串（解析失败为空串则省略时刻）
    Healthy { checked_label: String },
    /// 后端明确报 unhealthy（红 pill）
    Unhealthy { checked_label: String },
    /// 轮询失败 / 超时（黄 pill：状态未知 ≠ 确认故障）
    Unreachable,
}

impl DbSyncState {
    /// 是否尚未确认健康（未知 / 不可达；测试与后续告警挂点）
    #[cfg(test)]
    pub(crate) fn is_degraded(&self) -> bool {
        matches!(self, Self::Unknown | Self::Unreachable)
    }
}

/// 未读通知数：`None` = 无数据（隐藏数字只留铃铛）；`Some(n)` = 徽标数
type UnreadState = Option<u64>;

// ---------------------------------------------------------------------------
// 纯函数（展示层口径，单测锁定）
// ---------------------------------------------------------------------------

/// 从列表响应里挑出每个 ticker 币种的最新一条（列表已按 `year_month desc,
/// currency asc` 排序——首个命中即最新；缺失币种落 `None`）
pub fn pick_latest_per_currency(
    items_by_currency: &[(&str, Vec<ExchangeRateItem>)],
) -> [Option<ExchangeRateItem>; TICKER_CURRENCIES.len()] {
    let mut picked: [Option<ExchangeRateItem>; TICKER_CURRENCIES.len()] = [None, None, None];
    for (slot, currency) in TICKER_CURRENCIES.iter().enumerate() {
        if let Some((_, items)) = items_by_currency.iter().find(|(cur, _)| *cur == *currency) {
            picked[slot] = items.first().cloned();
        }
    }
    picked
}

/// 汇率显示串（固定 4 位小数，等宽数字对齐）
pub fn format_rate(rate: f64) -> SharedString {
    SharedString::from(format!("{rate:.4}"))
}

/// ISO8601 时刻 → 本地时区 `HH:MM:SS`（解析失败返回 `None`，调用方省略时刻段）
pub fn format_local_clock(iso: &str) -> Option<String> {
    let dt = chrono::DateTime::parse_from_rfc3339(iso).ok()?;
    Some(
        dt.with_timezone(&chrono::Local)
            .format("%H:%M:%S")
            .to_string(),
    )
}

// ---------------------------------------------------------------------------
// FooterView
// ---------------------------------------------------------------------------

/// 全局 Footer 状态栏实体（登录态创建，随主窗口生命周期常驻）
pub struct FooterView {
    client: Client,
    rates: RateState,
    db_sync: DbSyncState,
    unread: UnreadState,
    /// 各段竞态守卫：只应用最新一次请求的结果（慢响应不覆盖新响应）
    rates_request_id: u64,
    db_request_id: u64,
    unread_request_id: u64,
}

impl FooterView {
    pub fn new(client: Client, cx: &mut Context<Self>) -> Self {
        let mut view = Self {
            client,
            rates: RateState::default(),
            db_sync: DbSyncState::default(),
            unread: None,
            rates_request_id: 0,
            db_request_id: 0,
            unread_request_id: 0,
        };
        // 创建即首拉（否则各段要空转一个完整轮询周期）；随后进入定时循环
        view.fetch_rates(cx);
        view.fetch_db_status(cx);
        view.fetch_unread(cx);
        view.start_rate_poll(cx);
        view.start_db_poll(cx);
        view.start_unread_poll(cx);
        view.start_latency_refresh_tick(cx);
        view
    }

    /// 手动刷新入口（ticker 左端按钮）：立即重拉全部三段数据
    fn refresh_all(&mut self, cx: &mut Context<Self>) {
        self.fetch_rates(cx);
        self.fetch_db_status(cx);
        self.fetch_unread(cx);
    }

    // ---------------- 轮询循环 ----------------
    //
    // 统一模式（对齐 inspector.rs start_ops_poll 先例）：WeakEntity 守卫 +
    // 定时唤醒；实体销毁（登出关窗）后 `update` 失败即自退出。

    fn start_rate_poll(&mut self, cx: &mut Context<Self>) {
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this, cx| loop {
            bg.timer(RATE_POLL_INTERVAL).await;
            let alive = this
                .update(cx, |this, cx| {
                    this.fetch_rates(cx);
                    true
                })
                .is_ok();
            if !alive {
                break;
            }
        })
        .detach();
    }

    fn start_db_poll(&mut self, cx: &mut Context<Self>) {
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this, cx| loop {
            bg.timer(DB_POLL_INTERVAL).await;
            let alive = this
                .update(cx, |this, cx| {
                    this.fetch_db_status(cx);
                    true
                })
                .is_ok();
            if !alive {
                break;
            }
        })
        .detach();
    }

    fn start_unread_poll(&mut self, cx: &mut Context<Self>) {
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this, cx| loop {
            bg.timer(UNREAD_POLL_INTERVAL).await;
            let alive = this
                .update(cx, |this, cx| {
                    this.fetch_unread(cx);
                    true
                })
                .is_ok();
            if !alive {
                break;
            }
        })
        .detach();
    }

    fn start_latency_refresh_tick(&mut self, cx: &mut Context<Self>) {
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this, cx| loop {
            bg.timer(LATENCY_REFRESH_INTERVAL).await;
            let alive = this.update(cx, |_, cx| cx.notify()).is_ok();
            if !alive {
                break;
            }
        })
        .detach();
    }

    // ---------------- 数据拉取（request-id 守卫 + 日志 + 失败降级） ----------------

    /// 汇率：逐币种 `page_size=1` 顺序拉最新一条；单币种失败不影响其余币种，
    /// 全部失败即整段「--」。成功 info!、失败 warn!（验收：轮询有日志可查）。
    fn fetch_rates(&mut self, cx: &mut Context<Self>) {
        self.rates_request_id = self.rates_request_id.wrapping_add(1);
        let request_id = self.rates_request_id;
        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this, cx| {
            let started = std::time::Instant::now();
            let fetched = bg
                .spawn(async move {
                    let mut per_currency: Vec<(&'static str, Vec<ExchangeRateItem>)> =
                        Vec::with_capacity(TICKER_CURRENCIES.len());
                    for currency in TICKER_CURRENCIES {
                        let filter = gui_api_client::exchange_rate::ExchangeRateFilter {
                            currency: Some(currency.to_string()),
                            ..Default::default()
                        };
                        // reqwest 需 tokio reactor：统一经应用级 runtime block_on
                        // （对齐 inspector.rs 管线；后台线程执行不阻塞 UI）
                        match crate::runtime::runtime()
                            .block_on(client.exchange_rate_list(&filter, 1, 1))
                        {
                            Ok(resp) => per_currency.push((currency, resp.items)),
                            Err(e) => {
                                tracing::warn!(target: "footer", currency, error = %e.user_message(), "汇率轮询单币种失败");
                                per_currency.push((currency, Vec::new()));
                            }
                        }
                    }
                    per_currency
                })
                .await;
            let hit = fetched.iter().filter(|(_, items)| !items.is_empty()).count();
            if hit > 0 {
                tracing::info!(target: "footer", currencies = hit, total = TICKER_CURRENCIES.len(), elapsed_ms = started.elapsed().as_millis() as u64, "汇率轮询完成");
            }
            this.update(cx, |this, cx| {
                if this.rates_request_id != request_id {
                    return;
                }
                this.rates = RateState::Loaded(Box::new(pick_latest_per_currency(&fetched)));
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// DB 同步状态：data-management/status 同源接口；Ok+healthy 绿 /
    /// Ok+unhealthy 红 / Err 黄（不可达）。失败 warn! 不 panic。
    fn fetch_db_status(&mut self, cx: &mut Context<Self>) {
        self.db_request_id = self.db_request_id.wrapping_add(1);
        let request_id = self.db_request_id;
        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this, cx| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(client.data_management_status())
                })
                .await;
            this.update(cx, |this, cx| {
                if this.db_request_id != request_id {
                    return;
                }
                this.db_sync = match result {
                    Ok(status) if status.database.healthy => {
                        tracing::info!(target: "footer", "DB 状态探测正常");
                        DbSyncState::Healthy {
                            checked_label: format_local_clock(&status.database.checked_at)
                                .unwrap_or_default(),
                        }
                    }
                    Ok(status) => {
                        tracing::warn!(target: "footer", healthy = false, "DB 状态探测报告异常");
                        DbSyncState::Unhealthy {
                            checked_label: format_local_clock(&status.database.checked_at)
                                .unwrap_or_default(),
                        }
                    }
                    Err(e) => {
                        tracing::warn!(target: "footer", error = %e.user_message(), "DB 状态探测不可达");
                        DbSyncState::Unreachable
                    }
                };
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// 未读通知数：失败置 `None`（铃铛保留、数字消失），warn! 降噪提示
    fn fetch_unread(&mut self, cx: &mut Context<Self>) {
        self.unread_request_id = self.unread_request_id.wrapping_add(1);
        let request_id = self.unread_request_id;
        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this, cx| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(client.notifications_unread_count())
                })
                .await;
            this.update(cx, |this, cx| {
                if this.unread_request_id != request_id {
                    return;
                }
                this.unread = match result {
                    Ok(resp) => Some(resp.count),
                    Err(e) => {
                        tracing::warn!(target: "footer", error = %e.user_message(), "未读通知轮询失败");
                        None
                    }
                };
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // ---------------- 测试注入口（pub(crate)：gpui::test 直接驱动状态机） ----------------

    #[cfg(test)]
    pub(crate) fn apply_test_states(
        &mut self,
        rates: RateState,
        db_sync: DbSyncState,
        unread: UnreadState,
        cx: &mut Context<Self>,
    ) {
        self.rates = rates;
        self.db_sync = db_sync;
        self.unread = unread;
        cx.notify();
    }

    // ---------------- 渲染 ----------------

    /// 1px 竖分隔线（四段切分；上下不留缝。无 id——同一渲染树出现多次，
    /// GPUI 要求同层元素 id 唯一）
    fn v_divider(theme: &AppTheme) -> impl IntoElement {
        div().w(px(1.0)).h_full().flex_none().bg(theme.separator)
    }

    /// 汇率 ticker 段：手动刷新钮 + 逐币种「CUR 7.2345」（缺数据「--」）
    fn rates_segment(&self, theme: &AppTheme, cx: &mut Context<Self>) -> impl IntoElement {
        let entries: Vec<gpui::AnyElement> = match &self.rates {
            RateState::Loading => vec![placeholder_text(theme, "汇率 --")],
            RateState::Loaded(slots) => {
                let mut els = Vec::with_capacity(TICKER_CURRENCIES.len());
                for (slot, currency) in TICKER_CURRENCIES.iter().enumerate() {
                    let value = slots[slot]
                        .as_ref()
                        .map(|item| format_rate(item.rate))
                        .unwrap_or_else(|| "--".into());
                    els.push(
                        div()
                            .id(SharedString::from(format!("footer-rate-{currency}")))
                            .flex()
                            .items_center()
                            .gap_1()
                            .flex_none()
                            .child(
                                div()
                                    .text_size(px(crate::theme::fs(crate::theme::FONT_FOOTER)))
                                    .text_color(theme.text_muted)
                                    .child(SharedString::from((*currency).to_string())),
                            )
                            .child(
                                div()
                                    .text_size(px(crate::theme::fs(crate::theme::FONT_FOOTER)))
                                    .text_color(theme.text_primary)
                                    .mono_tabular_nums()
                                    .child(value),
                            )
                            .into_any_element(),
                    );
                }
                els
            }
        };

        div()
            .id("footer-segment-rates")
            .flex()
            .items_center()
            .gap_2()
            .flex_none()
            .h_full()
            .px_2()
            .overflow_hidden()
            // 手动刷新入口（规格：ticker 手动刷新；点击刷新整条状态栏数据）
            .child(
                div()
                    .id("footer-refresh")
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(16.0))
                    .rounded(px(3.0))
                    .cursor_pointer()
                    .hover(|style| style.bg(theme.muted_fill))
                    .on_click(cx.listener(move |this, _, _, cx| this.refresh_all(cx)))
                    .tooltip(move |_window, cx| {
                        cx.new(|_| {
                            crate::views::sub_nav::SidebarTooltip::new("刷新状态栏".to_string())
                        })
                        .into()
                    })
                    .child(svg_refresh_icon(theme)),
            )
            .children(entries)
    }

    /// 同步引擎 DB 状态段：色点 pill + 文案 + 最近检查时刻
    fn db_segment(&self, theme: &AppTheme) -> impl IntoElement {
        let (dot_color, label) = match &self.db_sync {
            DbSyncState::Healthy { .. } => (theme.success, "DB 正常"),
            DbSyncState::Unhealthy { .. } => (theme.danger, "DB 异常"),
            // 未知 / 不可达：黄（状态未知 ≠ 确认故障）
            DbSyncState::Unknown | DbSyncState::Unreachable => (theme.warning, "DB 未知"),
        };
        let checked_label = match &self.db_sync {
            DbSyncState::Healthy { checked_label } | DbSyncState::Unhealthy { checked_label } => {
                checked_label.clone()
            }
            _ => String::new(),
        };

        div()
            .id("footer-segment-db")
            .flex()
            .items_center()
            .gap_1()
            .flex_none()
            .h_full()
            .px_2()
            // 色点（6px 圆 pill；暗底上不透明微语义色）
            .child(
                div()
                    .id("footer-db-dot")
                    .size(px(6.0))
                    .rounded_full()
                    .bg(dot_color),
            )
            .child(
                div()
                    .id("footer-db-label")
                    .text_size(px(crate::theme::fs(crate::theme::FONT_FOOTER)))
                    .text_color(theme.text_secondary)
                    .child(label),
            )
            .when(!checked_label.is_empty(), |seg| {
                seg.child(
                    div()
                        .id("footer-db-time")
                        .text_size(px(crate::theme::fs(crate::theme::FONT_FOOTER)))
                        .text_color(theme.text_muted)
                        .mono_tabular_nums()
                        .child(checked_label),
                )
            })
    }

    /// 未读通知徽标段：铃铛 + 数字胶囊（0 未读 / 无数据只显示铃铛，对齐 web）
    fn unread_segment(&self, theme: &AppTheme) -> impl IntoElement {
        let badge = self.unread.filter(|count| *count > 0).map(|count| {
            let text = if count > 999 {
                "999+".to_string()
            } else {
                count.to_string()
            };
            div()
                .id("footer-unread-badge")
                .min_w(px(14.0))
                .h(px(13.0))
                .px_1()
                .rounded(px(6.5))
                .bg(theme.accent_soft)
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(crate::theme::fs(crate::theme::FONT_2XS)))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(theme.accent)
                .mono_tabular_nums()
                .child(text)
        });

        div()
            .id("footer-segment-unread")
            .flex()
            .items_center()
            .gap_1()
            .flex_none()
            .h_full()
            .px_2()
            .child(svg_bell_icon(theme))
            .children(badge)
    }

    /// 延迟指标段：客户端滑动窗口 P95 快照（无样本「--」占位）
    fn latency_segment(&self, theme: &AppTheme) -> impl IntoElement {
        let snapshot = metrics::latency_snapshot();
        let text = match snapshot.p95_ms {
            Some(p95) => format!("P95 {:.0}ms", p95),
            None => "P95 --".to_string(),
        };
        div()
            .id("footer-segment-latency")
            .flex()
            .items_center()
            .gap_1()
            .flex_none()
            .h_full()
            .px_2()
            .child(
                div()
                    .id("footer-latency-value")
                    .text_size(px(crate::theme::fs(crate::theme::FONT_FOOTER)))
                    .text_color(theme.text_secondary)
                    .mono_tabular_nums()
                    .child(text),
            )
    }
}

/// 占位文字（加载中等场景的「--」口径；无 id——避免同层重复）
fn placeholder_text(theme: &AppTheme, text: &str) -> gpui::AnyElement {
    div()
        .text_size(px(crate::theme::fs(crate::theme::FONT_FOOTER)))
        .text_color(theme.text_muted)
        .child(SharedString::from(text.to_string()))
        .into_any_element()
}

/// 刷新图标（仓库自带 rotate-ccw.svg；12px 辅助级）
fn svg_refresh_icon(theme: &AppTheme) -> gpui::Svg {
    gpui::svg()
        .path(icon_path("RotateCcw"))
        .size(px(11.0))
        .text_color(theme.text_secondary)
}

/// 铃铛图标（仓库自带 bell.svg；12px 辅助级）
fn svg_bell_icon(theme: &AppTheme) -> gpui::Svg {
    gpui::svg()
        .path(icon_path("Bell"))
        .size(px(11.0))
        .text_color(theme.text_secondary)
}

impl EventEmitter<FooterEvent> for FooterView {}

impl Render for FooterView {
    fn render(&mut self, _window: &mut gpui::Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);

        div()
            .id("global-footer")
            .flex()
            .flex_row()
            .w_full()
            .flex_none()
            // 高度锁死 24px（shell 契约）；内容溢出一律裁切不挤压（验收第 1 条）
            .h(px(FOOTER_HEIGHT))
            .overflow_hidden()
            // bg Root token（插槽契约：Root 底 + 顶部 1px 分隔由外壳插槽画）
            .bg(theme.window_bg)
            .child(self.rates_segment(&theme, cx))
            .child(Self::v_divider(&theme))
            .child(self.db_segment(&theme))
            .child(Self::v_divider(&theme))
            // 弹性空白：右簇靠右（通知 / 延迟是全局次要信号）
            .child(div().id("footer-spacer").flex_1())
            .child(self.unread_segment(&theme))
            .child(Self::v_divider(&theme))
            .child(self.latency_segment(&theme))
            // BLF-830：密度分段控件（最右端；三档切换入口）
            .child(Self::v_divider(&theme))
            .child(self.density_segment(cx))
    }
}

impl FooterView {
    /// BLF-830：密度分段控件（紧凑 | 标准 | 宽松；选中档 accent 胶囊）。
    ///
    /// 放 Footer 的理由：常驻可见（任意页面一键切）、不占业务空间、与
    /// 延迟/未读同类的「全局界面状态」语义；独立设置页会破坏 gui-domain
    /// sidebar 与 frontend 52 项 1:1 契约（GUI 无私设页路由），完成评论已
    /// 说明此取舍。
    fn density_segment(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let current = theme::density_level();

        div()
            .id("footer-segment-density")
            .flex()
            .items_center()
            .flex_none()
            .h_full()
            .px_2()
            .gap_1()
            .children(theme::DensityLevel::ALL.map(|level| {
                let active = level == current;
                let theme = AppTheme::current(cx);
                div()
                    .id(SharedString::from(format!("density-{}", level.key())))
                    .on_click(cx.listener(move |this, _ev, _window, cx| {
                        if theme::density_level() != level {
                            cx.emit(FooterEvent::DensityChanged(level));
                            let _ = this; // listener 签名要求；事件即交付
                        }
                    }))
                    .cursor_pointer()
                    .px_1()
                    .rounded_sm()
                    .text_size(px(theme::fs(crate::theme::FONT_FOOTER)))
                    .when(active, |el| {
                        el.bg(theme.accent_soft).text_color(theme.accent)
                    })
                    .when(!active, |el| el.text_color(theme.text_muted))
                    .child(level.label())
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gui_domain::exchange_rate::ExchangeRateNoteImage;

    /// 构造一条汇率记录（year_month 即排序键）
    fn rate_item(currency: &str, year_month: &str, rate: f64) -> ExchangeRateItem {
        ExchangeRateItem {
            id: 1,
            currency: currency.to_string(),
            currency_name: None,
            year_month: year_month.to_string(),
            rate,
            description: None,
            note_images: Vec::<ExchangeRateNoteImage>::new(),
            created_at: "2026-08-01T00:00:00+00:00".into(),
            updated_at: "2026-08-01T00:00:00+00:00".into(),
        }
    }

    /// 选取逻辑：每币种取首个命中（列表按年月倒序 = 最新优先），缺失落 None
    #[test]
    fn pick_latest_per_currency_takes_first_hit_in_order() {
        let items = vec![
            (
                "USD",
                vec![
                    rate_item("USD", "2026-08", 7.23),
                    rate_item("USD", "2026-07", 7.20),
                ],
            ),
            ("EUR", vec![rate_item("EUR", "2026-08", 7.89)]),
            // GBP 缺失 → 占位
            ("CNY", vec![rate_item("CNY", "2026-08", 1.0)]),
        ];
        let picked = pick_latest_per_currency(&items);
        assert_eq!(picked[0].as_ref().expect("USD 应有值").rate, 7.23);
        assert_eq!(picked[1].as_ref().expect("EUR 应有值").rate, 7.89);
        assert!(picked[2].is_none(), "GBP 缺失应落 None（-- 占位）");
    }

    /// 空输入 → 全占位
    #[test]
    fn pick_latest_per_currency_empty_input_all_none() {
        let picked = pick_latest_per_currency(&[]);
        assert!(picked.iter().all(|slot| slot.is_none()));
    }

    /// 降级判定：未知 / 不可达算降级，健康 / 明确故障不算（告警挂点语义锁定）
    #[test]
    fn db_sync_state_is_degraded_covers_unknown_and_unreachable() {
        assert!(DbSyncState::Unknown.is_degraded());
        assert!(DbSyncState::Unreachable.is_degraded());
        assert!(!DbSyncState::Healthy {
            checked_label: String::new()
        }
        .is_degraded());
        assert!(!DbSyncState::Unhealthy {
            checked_label: String::new()
        }
        .is_degraded());
    }

    /// 汇率固定 4 位小数
    #[test]
    fn format_rate_four_decimals() {
        assert_eq!(format_rate(7.23), "7.2300");
        assert_eq!(format_rate(9.12345), "9.1235");
    }

    /// 时刻格式化：RFC3339 → 本地 HH:MM:SS；脏数据返回 None（省略时刻段）
    #[test]
    fn format_local_clock_parses_and_falls_back() {
        let parsed = format_local_clock("2026-08-23T06:00:05+00:00").expect("应解析成功");
        assert_eq!(parsed.len(), 8, "HH:MM:SS 共 8 字符");
        assert!(format_local_clock("garbage").is_none());
    }

    /// 轮询节奏契约：汇率 ≥5 分钟、未读 30s 对齐 web、DB/延迟 tick 为正
    #[test]
    fn poll_intervals_match_spec() {
        assert!(RATE_POLL_INTERVAL >= std::time::Duration::from_secs(300));
        assert_eq!(UNREAD_POLL_INTERVAL, std::time::Duration::from_secs(30));
        assert!(DB_POLL_INTERVAL >= std::time::Duration::from_secs(30));
        assert!(LATENCY_REFRESH_INTERVAL >= std::time::Duration::from_secs(5));
    }

    /// 渲染宿主（gpui::test 需要 Render 根）
    struct FooterHost {
        footer: gpui::Entity<FooterView>,
    }

    impl Render for FooterHost {
        fn render(
            &mut self,
            _window: &mut gpui::Window,
            _cx: &mut gpui::Context<Self>,
        ) -> impl IntoElement {
            self.footer.clone()
        }
    }

    fn dead_client() -> Client {
        // 127.0.0.1:1 本地立即拒绝连接（无外部网络依赖，对齐 console_bar 测试先例）
        Client::new("http://127.0.0.1:1")
    }

    /// 渲染冒烟（暗色）：四段 + 分隔线在空数据 / 满数据两种状态下均完整渲染
    /// 不 panic（验收：断网场景不白块）
    #[gpui::test]
    async fn footer_renders_across_state_spectra(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (host, cx2) = cx.add_window_view(|_window, cx| FooterHost {
            footer: cx.new(|cx| FooterView::new(dead_client(), cx)),
        });

        // 空数据态渲染（创建即首拉的真实失败任务留在队列，不影响渲染路径）
        cx2.read(|app| {
            let _ = host.read(app);
        });

        // 注入满数据态后再渲染（Loaded 汇率 + 绿 pill + 未读数）
        cx2.update(|_, app| {
            host.update(app, |host, cx| {
                host.footer.update(cx, |footer, cx| {
                    footer.apply_test_states(
                        RateState::Loaded(Box::new([
                            Some(rate_item("USD", "2026-08", 7.2345)),
                            Some(rate_item("EUR", "2026-08", 7.8901)),
                            Some(rate_item("GBP", "2026-08", 9.1234)),
                        ])),
                        DbSyncState::Healthy {
                            checked_label: "14:05:00".into(),
                        },
                        Some(3),
                        cx,
                    );
                });
            });
        });
        cx2.read(|app| {
            let _ = host.read(app);
        });
    }

    /// 降级矩阵：黄（不可达）/ 红（unhealthy）/ 空（unknown）三种 DB 态 +
    /// 未读 None 都必须可渲染（验收：失败降级为占位符不影响 UI）
    #[gpui::test]
    async fn footer_renders_degraded_states_without_panic(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        for db_state in [
            DbSyncState::Unknown,
            DbSyncState::Unreachable,
            DbSyncState::Unhealthy {
                checked_label: String::new(),
            },
        ] {
            let (host, cx2) = cx.add_window_view(|_window, cx| FooterHost {
                footer: cx.new(|_| FooterView {
                    client: dead_client(),
                    rates: RateState::Loading,
                    db_sync: db_state.clone(),
                    unread: None,
                    rates_request_id: 0,
                    db_request_id: 0,
                    unread_request_id: 0,
                }),
            });
            cx2.read(|app| {
                let _ = host.read(app);
            });
        }
    }

    /// 数字一律等宽构造器（BLF-792 数字列契约；对齐 console_bar 源码锁先例）
    #[test]
    fn footer_values_use_mono_builder() {
        let src = include_str!("footer.rs");
        assert!(
            src.matches(".mono_tabular_nums()").count() >= 3,
            "汇率 / 时刻 / 徽标 / P95 数值必须走 mono_tabular_nums 等宽构造器"
        );
    }

    /// 高度契约：Footer 容器锁 shell::FOOTER_HEIGHT（24px 稳定不挤压）
    #[test]
    fn footer_height_locked_to_shell_constant() {
        let src = include_str!("footer.rs");
        assert!(
            src.contains(".h(px(FOOTER_HEIGHT))"),
            "Footer 容器高度必须消费 shell::FOOTER_HEIGHT（24px 契约）"
        );
    }

    /// 端到端断网降级：dead client（127.0.0.1:1 即刻拒连）真实跑完「创建即首拉」
    /// 后——汇率全 None（Loaded 全占位）、DB 转 Unreachable、未读回退 None；
    /// 全程无 panic（验收第 1/2 条：轮询失败降级占位符、断网不 panic）。
    #[gpui::test]
    async fn dead_client_first_fetches_degrade_to_placeholders(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let footer = cx.update(|cx| cx.new(|cx| FooterView::new(dead_client(), cx)));
        // 冲刷真实失败回调（connection refused 即刻返回）
        cx.executor().allow_parking();
        cx.run_until_parked();
        cx.read(|app| {
            let footer = footer.read(app);
            match &footer.rates {
                RateState::Loaded(slots) => assert!(
                    slots.iter().all(|slot| slot.is_none()),
                    "三币种全部拉取失败应落全 None（-- 占位）"
                ),
                other => panic!("汇率段应完成降级应用，实际 {other:?}"),
            }
            assert_eq!(
                footer.db_sync,
                DbSyncState::Unreachable,
                "DB 探测不可达应转黄"
            );
            assert_eq!(footer.unread, None, "未读轮询失败应回退 None");
        });
    }
}
