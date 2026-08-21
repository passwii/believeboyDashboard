//! CRM → 待跟进（P5-7，BLF-743）
//!
//! 对齐 web 端 `app/dashboard/crm/follow-ups/page.tsx`（21 行，转发
//! `components/crm/follow-up-list`）的**读取主面**：按 `next_follow_at`
//! 归桶的三组列表（逾期未跟进 / 今日待跟进 / 本周待跟进），每组带计数徽标，
//! 行内展示实体类型（客户/线索）、名称、客户等级、副标题（线索=公司名 /
//! 客户=行业）、上次跟进内容、下次跟进时间文案与负责人。数据源：
//! - `GET /api/v1/crm/follow-ups?scope=mine|all`（gui-api-client::crm）
//!
//! 分桶由后端完成（Asia/Shanghai 时区）；展示时刻文案用本机时区换算——与
//! web 用浏览器本地时间同口径。
//!
//! ## 与 web 端的取舍（issue 允许按 macOS 原生习惯精简并说明）
//!
//! - **保留**：四态状态机、数据范围切换（我的/全部，非管理员请求 all 后端
//!   静默降级为 mine）、三组分区 + 计数徽标、行内全部展示字段、空态文案
//!   「暂无待跟进，太棒了 🎉」；
//! - **精简**：
//!   - 行点击 → 详情抽屉（`CrmOverviewDrawer`：字段面板 + 记跟进表单 +
//!     线索转客户）不移植——GUI 无抽屉/弹层先例且属写流程，v1 只读主面已
//!     覆盖「谁需要跟进」核心信号；后续需要时单独立项；
//!   - 等级徽标取短文案（"A 级"；web 列表行同款，完整 "A 级（高价值）"
//!     仅抽屉场景使用）。

use chrono::Local;
use gpui::prelude::*;
use gpui::{
    div, px, App, AsyncApp, Context, Entity, FontWeight, Hsla, IntoElement, SharedString, Styled,
    WeakEntity, Window,
};
use gpui_component::button::Button;
use gpui_component::{h_flex, v_flex, Sizable};
use gui_api_client::Client;
use gui_domain::crm::{format_next_follow, rating_label, FollowUpGroup, FollowUpGroups};

use crate::theme::AppTheme;
use crate::widgets::filter_bar::filter_select;
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「CRM 客户与合作伙伴 → 待跟进」URL（数据权威 gui-domain::sidebar）
pub const CRM_FOLLOW_UPS_URL: &str = "/dashboard/crm/follow-ups";

// ---------------------------------------------------------------------------
// 数据范围（对齐 web ScopeToggle：我的 / 全部）
// ---------------------------------------------------------------------------

/// 数据范围（后端 `resolve_scope`：非管理员请求 all 静默降级为 mine）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum CrmScope {
    /// 我名下（默认）
    #[default]
    Mine,
    /// 全部（仅管理员实际生效）
    All,
}

impl CrmScope {
    /// query 参数值（对齐 web `scope` search param）
    pub fn as_str(self) -> &'static str {
        match self {
            CrmScope::Mine => "mine",
            CrmScope::All => "all",
        }
    }

    /// 切换到另一档（toggle 语义；菜单构建用）
    pub fn label(self) -> &'static str {
        match self {
            CrmScope::Mine => "我的",
            CrmScope::All => "全部",
        }
    }

    /// 全部两档（菜单项顺序：我的 → 全部，对齐 web ScopeToggle）
    pub const ALL: [CrmScope; 2] = [CrmScope::Mine, CrmScope::All];
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/// 视图四态（对齐既有业务视图约定）
#[derive(Debug, Clone, PartialEq)]
pub enum CrmFollowUpsState {
    /// 首屏 / 刷新中
    Loading,
    /// 数据就绪
    Loaded(Box<FollowUpGroups>),
    /// 完全无待跟进（total_count == 0）
    Empty,
    /// 请求失败（携带用户可读消息）
    Error(String),
}

impl CrmFollowUpsState {
    fn from_fetch_result(result: Result<FollowUpGroups, String>) -> Self {
        match result {
            Ok(groups) => {
                // 以实际分组内容为准（渲染数据源）；total_count 仅作展示计数，
                // 与分组不一致时不据此误判非空（防御后端口径漂移）
                if groups.overdue.is_empty()
                    && groups.today.is_empty()
                    && groups.this_week.is_empty()
                {
                    Self::Empty
                } else {
                    Self::Loaded(Box::new(groups))
                }
            }
            Err(msg) => Self::Error(msg),
        }
    }
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// CRM 待跟进视图（四态状态机 + scope 切换 + 竞态保护）
pub struct CrmFollowUpsView {
    state: Entity<CrmFollowUpsState>,
    /// 带会话的 API client
    client: Client,
    /// 数据范围（我的 / 全部）
    scope: CrmScope,
    /// 主请求竞态保护
    latest_request_id: u64,
}

impl CrmFollowUpsView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| CrmFollowUpsState::Loading);
        Self {
            state,
            client,
            scope: CrmScope::default(),
            latest_request_id: 0,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> CrmFollowUpsState {
        self.state.read(cx).clone()
    }

    /// 当前数据范围（只读，测试用）
    #[allow(dead_code)]
    pub fn current_scope(&self) -> CrmScope {
        self.scope
    }

    /// 重新拉取：首屏 / 错误重试 / 空态刷新 / 切换范围共用入口（竞态保护；
    /// 每次调用递增 `latest_request_id` 并进入 Loading）
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;

        self.state.update(cx, |state, cx| {
            *state = CrmFollowUpsState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let scope = self.scope.as_str().to_string();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    // reqwest 需要 tokio reactor：统一走应用级 runtime block_on
                    // （对齐 crm_dashboard::load_dashboard 模式）
                    crate::runtime::runtime().block_on(async {
                        client
                            .crm_follow_ups(&scope)
                            .await
                            .map_err(|e| e.user_message())
                    })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 切换数据范围并重新拉取（同档不重复请求）
    pub fn set_scope(&mut self, scope: CrmScope, cx: &mut Context<Self>) {
        if self.scope == scope {
            return;
        }
        self.scope = scope;
        self.reload(cx);
    }

    /// 应用拉取结果（竞态保护）：落状态机
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<FollowUpGroups, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        let next = CrmFollowUpsState::from_fetch_result(result);
        self.state.update(cx, |state, cx| {
            *state = next;
            cx.notify();
        });
    }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for CrmFollowUpsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let view = cx.entity();

        v_flex()
            .id("crm-follow-ups")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            .child(page_header(&view, self.scope, &app_theme))
            .child(match state {
                CrmFollowUpsState::Loading => render_loading(&app_theme).into_any_element(),
                CrmFollowUpsState::Error(msg) => state_views::error_state(
                    &view,
                    &app_theme,
                    "crm-follow-ups-error",
                    "待跟进加载失败",
                    msg,
                    |this, cx| this.reload(cx),
                )
                .into_any_element(),
                CrmFollowUpsState::Empty => state_views::empty_state_with_action(
                    &view,
                    &app_theme,
                    "crm-follow-ups-empty",
                    "icons/bell.svg",
                    "暂无待跟进，太棒了 🎉",
                    "刷新",
                    |this, cx| this.reload(cx),
                )
                .into_any_element(),
                CrmFollowUpsState::Loaded(groups) => {
                    render_loaded(cx, &app_theme, &groups).into_any_element()
                }
            })
    }
}

/// 页面头部：标题 + 副标题 + 范围切换 + 刷新按钮（对齐 web 标题行 +
/// ScopeToggle 布局）
fn page_header(
    view: &Entity<CrmFollowUpsView>,
    scope: CrmScope,
    theme: &AppTheme,
) -> impl IntoElement {
    let view_for_scope = view.clone();
    let view_for_refresh = view.clone();
    PageHeader::new("待跟进")
        .subtitle("逾期 / 今日 / 本周需要跟进的客户与线索")
        .action(filter_select(
            theme,
            "范围",
            SharedString::from(scope.label()),
            "crm-follow-ups-scope-filter",
            move |menu, _w, _cx| {
                let mut menu = menu;
                for option in CrmScope::ALL {
                    let view = view_for_scope.clone();
                    menu = menu.item(
                        gpui_component::menu::PopupMenuItem::new(option.label())
                            .checked(option == scope)
                            .on_click(move |_ev, _w, cx| {
                                view.update(cx, |this, cx| this.set_scope(option, cx));
                            }),
                    );
                }
                menu
            },
        ))
        .action(
            Button::new("crm-follow-ups-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_ev, _w, cx| {
                    view_for_refresh.update(cx, |this, cx| this.reload(cx));
                }),
        )
}

/// Loading 骨架：筛选条 + 三组列表块
fn render_loading(theme: &AppTheme) -> impl IntoElement {
    state_views::skeleton_loading(
        theme,
        &[
            SkeletonBlock::Filter(1),
            SkeletonBlock::Table(96.0),
            SkeletonBlock::Table(96.0),
            SkeletonBlock::Table(96.0),
        ],
    )
}

/// Loaded：三组分区（仅渲染非空组，对齐 web `items.length === 0` 跳过）
fn render_loaded(
    cx: &mut Context<CrmFollowUpsView>,
    theme: &AppTheme,
    groups: &FollowUpGroups,
) -> gpui::AnyElement {
    let reduce = crate::motion::reduce_motion(cx);
    let now_local = Local::now();

    let sections = [
        (FollowUpGroup::Overdue, &groups.overdue, "逾期未跟进"),
        (FollowUpGroup::Today, &groups.today, "今日待跟进"),
        (FollowUpGroup::ThisWeek, &groups.this_week, "本周待跟进"),
    ];

    let content =
        v_flex()
            .id("crm-follow-ups-loaded")
            .gap_6()
            .children(sections.iter().filter_map(|(group, items, label)| {
                if items.is_empty() {
                    return None;
                }
                Some(render_section(*group, label, items, now_local, theme))
            }));

    crate::motion::enter_fade_in(
        SharedString::from("crm-follow-ups-loaded-fade"),
        content_guard().child(content),
        reduce,
    )
    .into_any_element()
}

/// 分组视觉元信息（标签色 / 计数徽标配色；对齐 web rose/amber/slate 强调色）
fn group_accent(group: FollowUpGroup, theme: &AppTheme) -> Hsla {
    match group {
        FollowUpGroup::Overdue => theme.danger,
        FollowUpGroup::Today => theme.warning,
        FollowUpGroup::ThisWeek => theme.text_secondary,
    }
}

/// 单组分区：彩色标题 + 计数徽标 + 行卡片
fn render_section(
    group: FollowUpGroup,
    label: &str,
    items: &[gui_domain::crm::FollowUpItem],
    now_local: chrono::DateTime<Local>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let accent = group_accent(group, theme);
    let count_fg = match group {
        FollowUpGroup::Overdue => theme.danger,
        _ => theme.text_secondary,
    };
    let count_bg = match group {
        FollowUpGroup::Overdue => theme.danger_soft,
        _ => theme.muted_fill,
    };

    v_flex()
        .id(SharedString::from(format!(
            "crm-follow-ups-section-{}",
            group_label_key(group)
        )))
        .gap_2()
        .child(
            h_flex()
                .items_center()
                .gap_2()
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(accent)
                        .child(label.to_string()),
                )
                .child(
                    h_flex()
                        .items_center()
                        .rounded_full()
                        .px_2()
                        .py_0p5()
                        .bg(count_bg)
                        .child(
                            div()
                                .text_xs()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(count_fg)
                                .child(items.len().to_string()),
                        ),
                ),
        )
        .child(
            v_flex()
                .rounded(px(theme.radius_lg))
                .border_1()
                .border_color(theme.separator.opacity(0.6))
                .bg(theme.card_bg)
                .shadow(vec![theme.card_shadow_box()])
                .children(items.iter().enumerate().map(|(i, item)| {
                    let mut row = render_row(group, item, now_local, theme);
                    if i > 0 {
                        row = row.border_t_1().border_color(theme.separator.opacity(0.6));
                    }
                    row.into_any_element()
                })),
        )
        .into_any_element()
}

/// 单行：实体徽标 + 名称/等级/副标题 + 上次跟进 | 右侧时间文案 + 负责人
fn render_row(
    group: FollowUpGroup,
    item: &gui_domain::crm::FollowUpItem,
    now_local: chrono::DateTime<Local>,
    theme: &AppTheme,
) -> gpui::Stateful<gpui::Div> {
    // 实体类型徽标（web：客户=蓝描边 / 线索=紫描边；GUI 用软底色 pill 同语义）
    let (entity_fg, entity_bg) = if item.is_customer() {
        (theme.chart_primary, theme.chart_primary.opacity(0.12))
    } else {
        (theme.chart_secondary, theme.chart_secondary.opacity(0.12))
    };
    // 时间文案强调色（逾期行红、其余弱化）
    let time_color = if group == FollowUpGroup::Overdue {
        theme.danger
    } else {
        theme.text_muted
    };

    h_flex()
        .id(SharedString::from(format!(
            "crm-follow-up-{}-{}",
            item.entity_type, item.entity_id
        )))
        .items_start()
        .justify_between()
        .gap_3()
        .px_4()
        .py_3()
        .child(
            // 左列：第一行 徽标+名称+等级+副标题；第二行 上次跟进内容
            v_flex()
                .min_w_0()
                .flex_1()
                .gap_0p5()
                .child(
                    h_flex()
                        .gap_2()
                        .child(pill(entity_fg, entity_bg, item.entity_label().to_string()))
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text_primary)
                                .truncate()
                                .child(item.name.clone()),
                        )
                        .when_some(item.rating.as_deref(), |row, rating| {
                            row.child(pill(theme.accent, theme.accent_soft, rating_label(rating)))
                        })
                        .when_some(item.subtitle.as_deref(), |row, subtitle| {
                            row.child(
                                div()
                                    .text_xs()
                                    .text_color(theme.text_muted)
                                    .truncate()
                                    .child(subtitle.to_string()),
                            )
                        }),
                )
                .when_some(item.last_follow_content.as_deref(), |col, content| {
                    col.child(
                        div()
                            .text_xs()
                            .text_color(theme.text_muted)
                            .truncate()
                            .child(format!("上次：{content}")),
                    )
                }),
        )
        .child(
            // 右列：下次跟进时间文案 + 负责人
            v_flex()
                .items_end()
                .flex_shrink_0()
                .gap_0p5()
                .child(
                    div()
                        .text_xs()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(time_color)
                        .child(format_next_follow(item.next_follow_at, group, now_local)),
                )
                .when_some(item.owner_name.as_deref(), |col, owner| {
                    col.child(
                        div()
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child(owner.to_string()),
                    )
                }),
        )
}

/// 圆角小徽标（实体类型 / 客户等级共用）
fn pill(fg: Hsla, bg: Hsla, text: String) -> gpui::AnyElement {
    h_flex()
        .items_center()
        .rounded_full()
        .px_2()
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

/// 分组 key（element id 用）
fn group_label_key(group: FollowUpGroup) -> &'static str {
    match group {
        FollowUpGroup::Overdue => "overdue",
        FollowUpGroup::Today => "today",
        FollowUpGroup::ThisWeek => "this-week",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use gui_domain::crm::FollowUpItem;

    fn dummy_client() -> Client {
        Client::new("http://127.0.0.1:1")
    }

    fn item(entity_type: &str, id: i64, name: &str) -> FollowUpItem {
        FollowUpItem {
            entity_type: entity_type.into(),
            entity_id: id,
            name: name.into(),
            subtitle: None,
            owner_id: None,
            owner_name: None,
            next_follow_at: chrono::Utc::now(),
            last_follow_content: None,
            last_follow_at: None,
            rating: None,
            status: None,
            intent: None,
        }
    }

    fn sample_groups() -> FollowUpGroups {
        let mut overdue = item("customer", 3, "客户甲");
        overdue.subtitle = Some("制造业".into());
        overdue.rating = Some("A".into());
        overdue.last_follow_content = Some("电话沟通报价".into());
        overdue.owner_name = Some("张三".into());
        let today_lead = item("lead", 7, "线索乙");
        FollowUpGroups {
            overdue: vec![overdue],
            today: vec![today_lead],
            this_week: Vec::new(),
            overdue_count: 1,
            total_count: 2,
        }
    }

    // ---------- 纯函数 ----------

    /// scope 枚举 ↔ query 参数 / 菜单文案
    #[test]
    fn scope_maps_to_query_and_label() {
        assert_eq!(CrmScope::Mine.as_str(), "mine");
        assert_eq!(CrmScope::All.as_str(), "all");
        assert_eq!(CrmScope::Mine.label(), "我的");
        assert_eq!(CrmScope::All.label(), "全部");
        assert_eq!(CrmScope::ALL, [CrmScope::Mine, CrmScope::All]);
        assert_eq!(CrmScope::default(), CrmScope::Mine, "默认我的（对齐 web）");
    }

    /// 页面级空态判定：total_count=0 且三组全空 → Empty；任一组有数据 → Loaded
    #[test]
    fn state_from_fetch_result_transitions() {
        let data = sample_groups();
        assert_eq!(
            CrmFollowUpsState::from_fetch_result(Ok(data.clone())),
            CrmFollowUpsState::Loaded(Box::new(data.clone()))
        );

        let empty = FollowUpGroups::default();
        assert_eq!(
            CrmFollowUpsState::from_fetch_result(Ok(empty)),
            CrmFollowUpsState::Empty
        );

        // total_count 与分组不一致时以分组为准（防御后端口径漂移）
        let mismatched = FollowUpGroups {
            total_count: 5,
            ..Default::default()
        };
        assert_eq!(
            CrmFollowUpsState::from_fetch_result(Ok(mismatched)),
            CrmFollowUpsState::Empty
        );

        assert_eq!(
            CrmFollowUpsState::from_fetch_result(Err("登录已过期".into())),
            CrmFollowUpsState::Error("登录已过期".into())
        );
    }

    /// 分组视觉映射：逾期红 / 今日琥珀 / 本周次级文本；key 稳定
    #[test]
    fn group_meta_is_stable() {
        assert_eq!(group_label_key(FollowUpGroup::Overdue), "overdue");
        assert_eq!(group_label_key(FollowUpGroup::Today), "today");
        assert_eq!(group_label_key(FollowUpGroup::ThisWeek), "this-week");

        let light = AppTheme::light();
        let dark = AppTheme::dark();
        for theme in [&light, &dark] {
            assert_eq!(
                group_accent(FollowUpGroup::Overdue, theme),
                theme.danger,
                "逾期组用 danger 强调"
            );
            assert_eq!(
                group_accent(FollowUpGroup::Today, theme),
                theme.warning,
                "今日组用 warning 强调"
            );
            assert_eq!(
                group_accent(FollowUpGroup::ThisWeek, theme),
                theme.text_secondary,
                "本周组用次级文本"
            );
        }
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
                cx.add_window_view(|_window, cx| CrmFollowUpsView::new(cx, dummy_client()));
        }
    }

    #[gpui::test]
    async fn renders_loaded_in_light_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let (view, cx2) =
            cx.add_window_view(|_window, cx| CrmFollowUpsView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = CrmFollowUpsState::Loaded(Box::new(sample_groups()));
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
            cx.add_window_view(|_window, cx| CrmFollowUpsView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = CrmFollowUpsState::Loaded(Box::new(sample_groups()));
            });
        });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    /// 仅非空组渲染：this_week 为空时 Loaded 态仍正常（过滤逻辑在 render 内）
    #[gpui::test]
    async fn renders_loaded_with_partial_groups(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| CrmFollowUpsView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            let mut groups = sample_groups();
            groups.this_week = vec![item("customer", 9, "客户丙")];
            this.state.update(cx, |state, _| {
                *state = CrmFollowUpsState::Loaded(Box::new(groups));
            });
        });
    }

    #[gpui::test]
    async fn renders_error_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| CrmFollowUpsView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = CrmFollowUpsState::Error("登录已过期".into());
            });
        });
    }

    #[gpui::test]
    async fn renders_empty_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| CrmFollowUpsView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = CrmFollowUpsState::Empty;
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
            cx.add_window_view(|_window, cx| CrmFollowUpsView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = CrmFollowUpsState::Loaded(Box::new(sample_groups()));
            });
        });
    }

    // ---------- 状态机动作 ----------

    /// reload 递增竞态 id 并进入 Loading；过期响应被丢弃（apply_result 竞态保护）
    #[gpui::test]
    async fn reload_bumps_request_id_and_drops_stale_results(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| CrmFollowUpsView::new(cx, dummy_client()));

        view.update(cx2, |this, cx| {
            let before = this.latest_request_id;
            this.reload(cx);
            assert!(this.latest_request_id > before, "reload 应递增竞态 id");
            assert_eq!(this.current_state(cx), CrmFollowUpsState::Loading);

            // 过期响应（request_id 落后于 latest）应被丢弃，不改变状态
            let stale_id = this.latest_request_id - 1;
            this.apply_result(stale_id, Err("过期响应不应落地".into()), cx);
            assert_eq!(this.current_state(cx), CrmFollowUpsState::Loading);
        });

        // 新鲜响应正常落地
        view.update(cx2, |this, cx| {
            let fresh_id = this.latest_request_id;
            this.apply_result(fresh_id, Ok(sample_groups()), cx);
            assert!(matches!(
                this.current_state(cx),
                CrmFollowUpsState::Loaded(_)
            ));
        });
    }

    /// 切换范围：更新 scope 并触发 reload；同档不重复请求
    #[gpui::test]
    async fn set_scope_updates_and_reloads(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| CrmFollowUpsView::new(cx, dummy_client()));

        view.update(cx2, |this, cx| {
            assert_eq!(this.current_scope(), CrmScope::Mine);
            let before = this.latest_request_id;
            this.set_scope(CrmScope::All, cx);
            assert_eq!(this.current_scope(), CrmScope::All);
            assert!(this.latest_request_id > before, "切档应触发重拉");
            assert_eq!(this.current_state(cx), CrmFollowUpsState::Loading);

            // 同档再切不重复请求
            let after = this.latest_request_id;
            this.set_scope(CrmScope::All, cx);
            assert_eq!(this.latest_request_id, after, "同档不应重复请求");
        });
    }

    /// 展示文案联动冒烟：固定 now 下逾期/今日/本周文案可生成（域函数已在
    /// gui-domain 测过口径，这里锁视图调用链不 panic 且走本机时区）
    #[test]
    fn format_next_follow_via_view_path() {
        let now = Local.with_ymd_and_hms(2026, 8, 21, 15, 0, 0).unwrap();
        let at = Local
            .with_ymd_and_hms(2026, 8, 19, 9, 30, 0)
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(
            format_next_follow(at, FollowUpGroup::Overdue, now),
            "逾期 2 天"
        );
    }
}
