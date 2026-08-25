//! 运营 → 店铺导航视图（P5-1，BLF-714）
//!
//! frontend `app/dashboard/operations/store-navigation/page.tsx` 的 GPUI 等价：
//!
//! - 数据源：`GET /api/v1/projects/manage`（`list_store_navigation`，按 X-Operator /
//!   X-Is-Admin 过滤当前用户可见店铺 = 项目；与 Dashboard 项目列表同源）；
//! - 顶部 PageHeader 等价：eyebrow pill（运营导航 · 店铺导航）+ 描述 + 3 张统计卡
//!   （店铺总数 / 有链接店铺 / 品牌数量，对齐 frontend `stats` 数组）；
//! - 全部店铺：响应式卡片网格（复用 `site_navigation::grid_columns` 的 2/3/4/6 列
//!   断点，frontend 两页 grid-cols 相同）；每张卡片 = tone 渐变 wash（按索引循环
//!   8 色，light/dark 各一套，对齐 frontend `tonePresets`）+ 店铺名 + 品牌 pill +
//!   外链角标 + 描述 + 「店铺链接 / 点击直达」；有 `store_address` 时点击用默认
//!   浏览器打开（`App::open_url`，系统能力，非内嵌 webview）；
//! - 三态（Stage 0 公共组件 `state_views`）：加载（Spinner + 卡片骨架，对齐
//!   frontend `CardListSkeleton`）/ 错误（Alert + 重试，对齐 `ErrorState`）/
//!   空（「暂无店铺数据」+ 刷新）。
//!
//! 架构（沿用 Phase 3/4/5 基建）：四态状态机（Loading / Loaded / Empty / Error）
//! + `latest_request_id` 竞态保护 + `enter_fade_in` 页面动效（减弱动态时瞬时）。
//!
//! 与 frontend 的已知差异（有意保留，GPUI 0.2 能力边界）：
//! - `ArrowUpRight` 角标 → `IconName::ExternalLink`（gpui-component 无前者）；
//! - 卡片 hover 无 `-translate-y-1` 上浮（无 transform），改为边框高亮 + 阴影加深。

use gpui::{
    div, prelude::*, px, rgb, ClickEvent, Context, Entity, FontWeight, Hsla, Render, SharedString,
    Window,
};
use gpui_component::{h_flex, v_flex, Icon, IconName, Sizable};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;

use crate::theme::AppTheme;
use crate::views::site_navigation::grid_columns;
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};

/// 本页在侧栏中的 URL（root.rs 据此路由到本视图；与 gui-domain::sidebar 的店铺导航条目一致）
pub const STORE_NAV_URL: &str = "/dashboard/operations/store-navigation";

// ---------------------------------------------------------------------------
// tone 色板（对齐 frontend tonePresets / labelTones：8 色循环，light/dark 各一套）
// ---------------------------------------------------------------------------

/// 卡片 wash 底色（frontend `tonePresets` 首色；light = pastel-200，dark = -950）
const TONE_WASH_LIGHT: [u32; 8] = [
    0xe0e7ff, 0xd1fae5, 0xfef3c7, 0xfee2e2, 0xede9fe, 0xfce7f3, 0xcffafe, 0xecfccb,
];
const TONE_WASH_DARK: [u32; 8] = [
    0x1e1b4b, 0x064e3b, 0x78350f, 0x881337, 0x4c1d95, 0x831843, 0x164e63, 0x365314,
];

/// 品牌 pill 文字/描边色（frontend `labelTones` 文字色；light = -500，dark = -300）
const TONE_LABEL_LIGHT: [u32; 8] = [
    0x3b82f6, 0x10b981, 0xf59e0b, 0xef4444, 0x8b5cf6, 0xec4899, 0x0891b2, 0x65a30d,
];
const TONE_LABEL_DARK: [u32; 8] = [
    0x93c5fd, 0x6ee7b7, 0xfcd34d, 0xfca5a5, 0xc4b5fd, 0xf9a8d4, 0x67e8f9, 0xbef264,
];

fn tone(index: usize, dark: bool, light: &[u32; 8], dark_set: &[u32; 8]) -> Hsla {
    let hex = if dark { dark_set } else { light }[index % 8];
    rgb(hex).into()
}

/// 卡片 wash 色（按索引循环 8 色）
fn tone_wash(index: usize, dark: bool) -> Hsla {
    tone(index, dark, &TONE_WASH_LIGHT, &TONE_WASH_DARK)
}

/// 品牌 pill 强调色（按索引循环 8 色）
fn tone_label(index: usize, dark: bool) -> Hsla {
    tone(index, dark, &TONE_LABEL_LIGHT, &TONE_LABEL_DARK)
}

// ---------------------------------------------------------------------------
// 统计（对齐 frontend `stats` 数组；纯函数可单测）
// ---------------------------------------------------------------------------

/// 店铺总数
pub fn store_count(stores: &[ManagedProject]) -> usize {
    stores.len()
}

/// 有链接店铺数（store_address 非空）
pub fn linked_store_count(stores: &[ManagedProject]) -> usize {
    stores.iter().filter(|s| s.store_address.is_some()).count()
}

/// 品牌数量（brand_name 去重，忽略空值；对齐 frontend `new Set(...)`）
pub fn brand_count(stores: &[ManagedProject]) -> usize {
    let mut seen: Vec<&str> = Vec::new();
    for store in stores {
        if let Some(brand) = store.brand_name.as_deref() {
            if !seen.contains(&brand) {
                seen.push(brand);
            }
        }
    }
    seen.len()
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/// 店铺导航状态机（四态；Loaded 载荷 = 可见项目列表）
#[derive(Debug, Clone, PartialEq)]
pub enum StoreNavState {
    Loading,
    Loaded(Vec<ManagedProject>),
    Empty,
    Error(String),
}

impl StoreNavState {
    /// 拉取结果 → 落点状态（唯一合法的「拉取完成」转移）
    pub fn from_fetch_result(result: Result<Vec<ManagedProject>, String>) -> Self {
        match result {
            Ok(stores) if stores.is_empty() => Self::Empty,
            Ok(stores) => Self::Loaded(stores),
            Err(msg) => Self::Error(msg),
        }
    }
}

/// 店铺导航视图（四态状态机 + 竞态保护）
pub struct StoreNavigationView {
    state: Entity<StoreNavState>,
    /// 带会话的 API client
    client: Client,
    /// 请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,
}

impl StoreNavigationView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| StoreNavState::Loading);
        Self {
            state,
            client,
            latest_request_id: 0,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &gpui::App) -> StoreNavState {
        self.state.read(cx).clone()
    }

    /// 重新拉取数据：错误重试、空态刷新共用入口（竞态保护）。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;

        self.state.update(cx, |state, cx| {
            *state = StoreNavState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: gpui::WeakEntity<Self>, cx: &mut gpui::AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(load_store_navigation(&client))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 应用拉取结果：竞态保护（过期响应丢弃）
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<Vec<ManagedProject>, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        self.state.update(cx, |state, cx| {
            *state = StoreNavState::from_fetch_result(result);
            cx.notify();
        });
    }
}

/// 拉取店铺导航数据（与视图解耦便于测试）
async fn load_store_navigation(client: &Client) -> Result<Vec<ManagedProject>, String> {
    client
        .list_store_navigation()
        .await
        .map_err(|e| e.user_message())
}

impl Render for StoreNavigationView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        match state {
            StoreNavState::Loading => render_loading(&app_theme).into_any_element(),
            StoreNavState::Error(msg) => {
                render_error(cx, &app_theme, msg).into_any_element()
            }
            StoreNavState::Empty => render_empty(cx, &app_theme).into_any_element(),
            StoreNavState::Loaded(stores) => render_loaded(
                cx,
                &app_theme,
                &stores,
                grid_columns(_window.bounds().size.width.into()),
                crate::motion::reduce_motion(cx),
            )
            .into_any_element(),
        }
    }
}

// ---------------------------------------------------------------------------
// 四态渲染
// ---------------------------------------------------------------------------

/// Loading：Spinner + 卡片网格骨架（对齐 frontend `CardListSkeleton count={6}`；
/// P4-6：骨架块统一走 `state_views::skeleton_loading` 声明式组合）
fn render_loading(app_theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .id("store-nav-loading")
        .size_full()
        .gap_2()
        .px_2()
        .py_2()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(page_header())
        .child(state_views::skeleton_loading(
            app_theme,
            &[SkeletonBlock::CardGrid {
                count: 6,
                columns: 2,
            }],
        ))
}

/// Error：内联 Alert + 重试按钮（Stage 0 `state_views::error_state`）
fn render_error(
    cx: &mut Context<StoreNavigationView>,
    app_theme: &AppTheme,
    msg: String,
) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("store-nav-error")
        .size_full()
        .gap_2()
        .px_2()
        .py_2()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(page_header())
        .child(state_views::error_state(
            &view,
            app_theme,
            "store-nav-error",
            "店铺列表加载失败",
            msg,
            |this, cx| this.reload(cx),
        ))
}

/// Empty：Icon + 文案 + 刷新按钮（Stage 0 `state_views::empty_state_with_action`）
fn render_empty(cx: &mut Context<StoreNavigationView>, app_theme: &AppTheme) -> impl IntoElement {
    let view = cx.entity();
    v_flex()
        .id("store-nav-empty")
        .size_full()
        .gap_2()
        .px_2()
        .py_2()
        .overflow_y_scroll()
        .bg(app_theme.window_bg)
        .child(page_header())
        .child(state_views::empty_state_with_action(
            &view,
            app_theme,
            "store-nav-empty",
            "icons/store.svg",
            "暂无店铺数据",
            "刷新",
            |this, cx| this.reload(cx),
        ))
}

/// Loaded：页面头部 + PageHeader 等价（eyebrow + 描述 + 3 统计卡）+ 全部店铺卡片网格
fn render_loaded(
    cx: &mut Context<StoreNavigationView>,
    app_theme: &AppTheme,
    stores: &[ManagedProject],
    columns: usize,
    reduce: bool,
) -> impl IntoElement {
    crate::motion::enter_fade_in(
        gpui::SharedString::from("store-nav-loaded-fade"),
        v_flex()
            .id("store-nav-loaded")
            .size_full()
            .gap_2()
            .px_2()
            .py_2()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            .child(page_header())
            .child(header_card(app_theme, stores))
            .child(section(app_theme, stores, columns, cx)),
        reduce,
    )
}

/// 页面头部（P4-5：共享 PageHeader；四态统一接入，消除无头部页面）
fn page_header() -> PageHeader {
    PageHeader::new("店铺导航")
        .subtitle("聚合团队所有店铺入口 · 一键直达各店铺后台与前台页面")
}

// ---------------------------------------------------------------------------
// 顶部：PageHeader 等价（eyebrow pill + 描述 + 3 张统计卡）
// ---------------------------------------------------------------------------

fn header_card(app_theme: &AppTheme, stores: &[ManagedProject]) -> impl IntoElement {
    v_flex()
        .id("store-nav-header")
        .gap_4()
        .p_5()
        .rounded(px(app_theme.radius))
        .border_1()
        .border_color(app_theme.separator)
        .bg(app_theme.card_bg)
        .child(
            h_flex()
                .flex_wrap()
                .items_start()
                .justify_between()
                .gap_4()
                .child(
                    v_flex()
                        .max_w(px(640.))
                        .gap_3()
                        .child(eyebrow_pill(app_theme))
                        .child(
                            div()
                                .text_sm()
                                .text_color(app_theme.text_muted)
                                .child("聚合团队所有店铺入口，可视化书签卡片，方便一键直达各店铺后台与前台页面。"),
                        ),
                )
                .child(
                    h_flex()
                        .gap_2()
                        .children(stats_cards(app_theme, stores)),
                ),
        )
}

/// Eyebrow pill（对齐 frontend PageHeader pill 形态：带 icon 的胶囊小标）
fn eyebrow_pill(app_theme: &AppTheme) -> impl IntoElement {
    let accent = app_theme.accent;
    h_flex()
        .items_center()
        .gap_2()
        .rounded_full()
        .border_1()
        .border_color(accent.opacity(0.25))
        .bg(accent.opacity(0.10))
        .px_3()
        .py_1()
        .child(
            Icon::empty()
                .path("icons/store.svg")
                .with_size(px(14.))
                .text_color(accent.opacity(0.9)),
        )
        .child(
            div()
                .text_xs()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(accent.opacity(0.9))
                .child(SharedString::from("运营导航 · 店铺导航")),
        )
}

/// 统计卡图标种类（Icon 非 Clone，用可 Copy 的枚举在渲染时构造）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StatIcon {
    Store,
    ExternalLink,
    Building2,
}

fn stat_icon(kind: StatIcon) -> Icon {
    match kind {
        StatIcon::Store => Icon::empty().path("icons/store.svg"),
        StatIcon::ExternalLink => Icon::new(IconName::ExternalLink),
        StatIcon::Building2 => Icon::new(IconName::Building2),
    }
}

/// 3 张统计卡：图标 + 数值 + 标签（对齐 frontend `stats` 数组）
fn stats_cards(app_theme: &AppTheme, stores: &[ManagedProject]) -> Vec<impl IntoElement> {
    let accent = app_theme.accent;
    let stats: [(&str, SharedString, StatIcon); 3] = [
        (
            "店铺总数",
            SharedString::from(store_count(stores).to_string()),
            StatIcon::Store,
        ),
        (
            "有链接店铺",
            SharedString::from(linked_store_count(stores).to_string()),
            StatIcon::ExternalLink,
        ),
        (
            "品牌数量",
            SharedString::from(brand_count(stores).to_string()),
            StatIcon::Building2,
        ),
    ];

    stats
        .iter()
        .map(|(label, value, icon)| {
            v_flex()
                .items_center()
                .gap_1()
                .px_3()
                .py_2()
                .w(px(104.))
                .rounded(px(app_theme.radius))
                .border_1()
                .border_color(app_theme.separator)
                .bg(app_theme.muted_fill)
                .child(
                    stat_icon(*icon)
                        .with_size(px(16.))
                        .text_color(accent.opacity(0.85)),
                )
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(app_theme.text_primary)
                        .child(value.clone()),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(app_theme.text_muted)
                        .child(SharedString::from(*label)),
                )
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 店铺卡片网格
// ---------------------------------------------------------------------------

/// 分组区块：标题 + 副标题 + 响应式网格
fn section(
    app_theme: &AppTheme,
    stores: &[ManagedProject],
    columns: usize,
    cx: &mut Context<StoreNavigationView>,
) -> impl IntoElement {
    v_flex()
        .id("store-nav-section")
        .gap_3()
        .child(
            h_flex()
                .items_end()
                .justify_between()
                .gap_3()
                .child(
                    div()
                        .text_lg()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(app_theme.text_primary)
                        .child("全部店铺"),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(app_theme.text_muted)
                        .child("点击卡片直达店铺"),
                ),
        )
        .child(
            div()
                .grid()
                .grid_cols(columns as u16)
                .gap_2()
                .children(stores.iter().enumerate().map(|(index, store)| {
                    store_card(store, index, app_theme, cx)
                })),
        )
}

/// 单张店铺卡片：tone wash + 店铺名 + 品牌 pill + 外链角标 + 描述 + 「店铺链接/点击直达」
fn store_card(
    store: &ManagedProject,
    index: usize,
    app_theme: &AppTheme,
    cx: &mut Context<StoreNavigationView>,
) -> impl IntoElement {
    let dark = app_theme.dark;
    let wash = tone_wash(index, dark);
    let label = tone_label(index, dark);
    let wash_opacity = if dark { 0.6 } else { 0.5 };
    let href = store.store_address.clone().unwrap_or_default();
    let has_address = !href.is_empty();
    let card_id = SharedString::from(format!("store-nav-card-{}", store.id));

    v_flex()
        .id(card_id)
        .relative()
        .overflow_hidden()
        .h_full()
        .gap_3()
        .p_4()
        .rounded_2xl()
        .border_1()
        .border_color(app_theme.separator)
        .bg(app_theme.card_bg)
        .cursor_pointer()
        .hover(|this| {
            this.border_color(label.opacity(0.55))
                .shadow(vec![gpui::BoxShadow {
                    color: label.opacity(0.12),
                    blur_radius: px(20.0),
                    spread_radius: px(0.0),
                    offset: gpui::Point {
                        x: px(0.0),
                        y: px(8.0),
                    },
                }])
        })
        .on_click(cx.listener(move |_, _: &ClickEvent, _, cx| {
            if has_address {
                tracing::info!(url = &href, "打开店铺链接");
                // 用系统默认浏览器打开（macOS Safari / 默认浏览器；非内嵌 webview）
                cx.open_url(&href);
            }
        }))
        // tone wash（absolute 铺底；内容在 relative z 之上；对齐 frontend opacity-50/60）
        .child(div().absolute().inset_0().bg(wash.opacity(wash_opacity)))
        .child(
            v_flex()
                .relative()
                .h_full()
                .gap_3()
                .child(
                    h_flex()
                        .items_start()
                        .justify_between()
                        .gap_3()
                        .child(
                            v_flex()
                                .gap_2()
                                .items_start()
                                .child(
                                    div()
                                        .text_base()
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(app_theme.text_primary)
                                        .child(SharedString::from(store.name.clone())),
                                )
                                .when(store.brand_name.is_some(), |this| {
                                    this.child(brand_pill(store, label))
                                }),
                        )
                        .child(
                            // 右上角外链角标（web 用 ArrowUpRight；gpui-component 取
                            // 语义最近的 ExternalLink）
                            div()
                                .rounded_lg()
                                .border_1()
                                .border_color(app_theme.separator)
                                .bg(app_theme.muted_fill)
                                .p_1()
                                .text_color(app_theme.text_muted)
                                .hover(|this| this.text_color(label))
                                .child(
                                    Icon::new(IconName::ExternalLink)
                                        .with_size(px(16.)),
                                ),
                        ),
                )
                .child(
                    // 描述（min-h + flex-1，对齐 frontend 保证底部对齐）
                    div()
                        .min_h_10()
                        .flex_1()
                        .text_sm()
                        .text_color(app_theme.text_muted)
                        .child(if has_address {
                            SharedString::from("点击访问店铺页面")
                        } else {
                            SharedString::from("暂无店铺链接")
                        }),
                )
                .child(
                    h_flex()
                        .items_center()
                        .justify_between()
                        .gap_2()
                        .border_t_1()
                        .border_color(app_theme.separator)
                        .pt_3()
                        .child(
                            h_flex()
                                .items_center()
                                .gap_1()
                                .rounded_full()
                                .border_1()
                                .border_color(app_theme.separator)
                                .bg(app_theme.muted_fill)
                                .px_2p5()
                                .py_1()
                                .child(
                                    Icon::new(IconName::ExternalLink)
                                        .with_size(px(12.))
                                        .text_color(app_theme.text_muted),
                                )
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(app_theme.text_primary.opacity(0.85))
                                        .child("店铺链接"),
                                ),
                        )
                        .child(
                            h_flex()
                                .items_center()
                                .gap_1()
                                .text_xs()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(label.opacity(0.8))
                                .child(SharedString::from("点击直达")),
                        ),
                ),
        )
}

/// 品牌 pill（Building2 icon + 品牌名；tone 色描边/文字 + wash 底，对齐 frontend labelTones）
fn brand_pill(store: &ManagedProject, label: Hsla) -> impl IntoElement {
    h_flex()
        .items_center()
        .gap_1()
        .rounded_full()
        .border_1()
        .border_color(label.opacity(0.35))
        .bg(label.opacity(0.10))
        .px_2()
        .py_0p5()
        .child(
            Icon::new(IconName::Building2)
                .with_size(px(12.))
                .text_color(label),
        )
        .child(
            div()
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .text_color(label)
                .child(SharedString::from(store.brand_name.clone().unwrap_or_default())),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;
    use gui_domain::common::ManagedProject;

    /// 测试样例店铺（对齐 backend /projects/manage 响应形态）
    fn sample_store(id: i64, name: &str, brand: Option<&str>, address: Option<&str>) -> ManagedProject {
        ManagedProject {
            id,
            name: name.into(),
            brand_name: brand.map(Into::into),
            store_address: address.map(Into::into),
            project_operator: None,
            assistant_operator: None,
            commission_basis: None,
            commission_rate: None,
            sort_order: id,
            is_active: true,
            source_file: None,
            has_context: false,
            project_tier: None,
            vat_enabled: false,
        }
    }

    fn sample_stores() -> Vec<ManagedProject> {
        vec![
            sample_store(1, "店铺 A", Some("BelieveBoy"), Some("https://a.example.com")),
            sample_store(2, "店铺 B", None, None),
            sample_store(3, "店铺 C", Some("BelieveBoy"), Some("https://c.example.com")),
            sample_store(4, "店铺 D", Some("OtherBrand"), None),
        ]
    }

    /// 统计契约（对齐 frontend `stats` 数组）：总数 / 有链接 / 品牌去重
    #[test]
    fn stats_match_frontend_computation() {
        let stores = sample_stores();
        assert_eq!(store_count(&stores), 4);
        assert_eq!(linked_store_count(&stores), 2);
        assert_eq!(brand_count(&stores), 2); // BelieveBoy ×2 去重 + OtherBrand
    }

    /// 统计对空列表返回 0（空态判定依赖）
    #[test]
    fn stats_are_zero_for_empty_list() {
        assert_eq!(store_count(&[]), 0);
        assert_eq!(linked_store_count(&[]), 0);
        assert_eq!(brand_count(&[]), 0);
    }

    /// tone 色板契约：8 色循环、light/dark 不同套、wash 与 label 首色对齐 frontend
    #[test]
    fn tone_palette_cycles_and_dark_differs() {
        // 循环：index 8 回到 index 0
        assert_eq!(tone_wash(8, false), tone_wash(0, false));
        assert_eq!(tone_label(8, true), tone_label(0, true));
        // light / dark 不同套
        assert_ne!(tone_wash(0, false), tone_wash(0, true));
        assert_ne!(tone_label(0, false), tone_label(0, true));
        // wash 首色 = frontend tonePresets 首色 #e0e7ff（indigo-200）
        let rgba: gpui::Rgba = tone_wash(0, false).into();
        assert_eq!((rgba.r * 255.0).round() as u8, 0xe0);
        assert_eq!((rgba.g * 255.0).round() as u8, 0xe7);
        assert_eq!((rgba.b * 255.0).round() as u8, 0xff);
        // label 首色 = frontend labelTones 首色 #3b82f6（blue-500）
        let rgba: gpui::Rgba = tone_label(0, false).into();
        assert_eq!((rgba.r * 255.0).round() as u8, 0x3b);
        assert_eq!((rgba.g * 255.0).round() as u8, 0x82);
        assert_eq!((rgba.b * 255.0).round() as u8, 0xf6);
    }

    /// 状态转移：空列表 → Empty；错误 → Error；有数据 → Loaded
    #[test]
    fn state_transitions_from_fetch_result() {
        assert_eq!(
            StoreNavState::from_fetch_result(Ok(vec![])),
            StoreNavState::Empty
        );
        assert_eq!(
            StoreNavState::from_fetch_result(Ok(sample_stores())),
            StoreNavState::Loaded(sample_stores())
        );
        assert_eq!(
            StoreNavState::from_fetch_result(Err("boom".into())),
            StoreNavState::Error("boom".into())
        );
    }

    /// 渲染冒烟：亮色主题（client 指向 127.0.0.1:1，首屏拉取快速失败 → 错误态，
    /// 不依赖网络环境）
    #[gpui::test]
    async fn view_renders_loading_then_error_in_light_mode(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let (_view, _cx) = cx.add_window_view(|_window, cx| {
            let mut view = StoreNavigationView::new(cx, Client::new("http://127.0.0.1:1"));
            view.reload(cx);
            view
        });
    }

    /// 渲染冒烟：深色主题 + Loaded 态（直接注入数据，覆盖 header stats + 卡片网格）
    #[gpui::test]
    async fn view_renders_loaded_grid_in_dark_mode(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            StoreNavigationView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = StoreNavState::Loaded(sample_stores());
            });
        });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    /// 渲染冒烟：减弱动态偏好下 Loaded 态可渲染（无动画路径）
    #[gpui::test]
    async fn view_renders_loaded_with_reduce_motion(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            cx.set_global(crate::motion::MotionPref(true));
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            StoreNavigationView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = StoreNavState::Loaded(sample_stores());
            });
        });
    }

    /// 渲染冒烟：空态（无店铺数据 → 「暂无店铺数据」+ 刷新按钮）可渲染
    #[gpui::test]
    async fn view_renders_empty_state(cx: &mut TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| {
            StoreNavigationView::new(cx, Client::new("http://127.0.0.1:1"))
        });
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = StoreNavState::Empty;
            });
        });
    }
}
