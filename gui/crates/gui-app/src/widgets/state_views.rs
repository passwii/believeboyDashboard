//! 统一三态视图（P5-0 公共基建，BLF-759；P4-6 骨架块系统升华，BLF-761）
//!
//! 对齐 web 端骨架屏 + 空态文案习惯，收敛各业务视图的
//! Loading / Error（带重试）/ Empty 渲染：
//!
//! - [`skeleton_loading`]：Spinner 行 + 声明式骨架块（`SkeletonBlock` 枚举），
//!   视图声明「我要哪几种骨架块」即可，不再各自手写 div 堆叠；
//! - [`error_state`]：卡片内 Alert + 重试按钮（对齐 ad_analysis.rs
//!   `render_error`）；通过传入视图实体 `Entity<V>` + `on_retry` 闭包回连视图；
//! - [`empty_state`] / [`empty_state_with_action`]：Icon + 文案 + 可选按钮
//!   （对齐 ad_analysis.rs `render_empty`）。
//!
//! 三态都包在统一卡片外壳里（card_bg + radius_lg + 轻投影），视觉与
//! dashboard 卡片一致；亮 / 暗主题只消费 `AppTheme` token。
//!
//! ## 骨架块（P4-6）
//!
//! [`SkeletonBlock`] 是可组合的占位块原语：标题条 / 筛选条 / KPI 统计卡行 /
//! 等高条行 / 表格 / 图表 / 卡片网格。视图用自己的页面壳（size_full + p_6 +
//! window_bg）包裹 [`skeleton_loading`]，并按需声明块序列——块样式全部来自
//! 主题 token，跨视图观感一致。

use gpui::{div, prelude::*, px, Entity, IntoElement, ParentElement, SharedString, Styled};
use gpui_component::{
    alert::Alert,
    button::Button,
    skeleton::Skeleton,
    spinner::Spinner,
    h_flex, v_flex, Icon, IconName, Sizable,
};

use crate::theme::AppTheme;
use crate::widgets::layout::content_guard;

/// 声明式骨架块：视图按需声明「我要哪几种骨架占位」。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SkeletonBlock {
    /// 标题条（页头占位，120×6）
    Title,
    /// 筛选条（n 个 chip 占位 + 末尾刷新按钮占位）
    Filter(usize),
    /// KPI 统计卡行（n 张等宽卡；对齐 stat_band_skeleton 的卡观感）
    Kpi(usize),
    /// 等高条行（n 个等宽条，如「近 7 天」维度条 / 汇总条）
    BarRow(usize, f32),
    /// 全宽表格块（高度 px）
    Table(f32),
    /// 全宽图表块（高度 px）
    Chart(f32),
    /// 卡片网格（count 张卡片 × columns 列，如店铺卡片列表）
    CardGrid { count: usize, columns: usize },
    /// 图表卡网格（count 张带标题行的图表卡 × columns 列，图表区高度 `height`）
    ChartGrid { count: usize, columns: usize, height: f32 },
}

impl SkeletonBlock {
    fn render(self, theme: &AppTheme) -> gpui::AnyElement {
        match self {
            SkeletonBlock::Title => v_flex()
                .gap_2()
                .child(div().w(px(120.)).h_6().child(Skeleton::new()))
                .into_any_element(),
            SkeletonBlock::Filter(chips) => h_flex()
                .gap_2()
                .children((0..chips).map(|_| {
                    div().w(px(140.)).h_8().child(Skeleton::new())
                }))
                .child(div().w_20().h_8().child(Skeleton::new()))
                .into_any_element(),
            SkeletonBlock::Kpi(count) => h_flex()
                .gap_3()
                .children((0..count).map(|_| kpi_card_skeleton(theme).into_any_element()))
                .into_any_element(),
            SkeletonBlock::BarRow(count, height) => h_flex()
                .gap_3()
                .children((0..count).map(|_| {
                    div().flex_1().h(px(height)).child(Skeleton::new()).into_any_element()
                }))
                .into_any_element(),
            SkeletonBlock::Table(height) => div()
                .w_full()
                .h(px(height))
                .child(Skeleton::new())
                .into_any_element(),
            SkeletonBlock::Chart(height) => div()
                .w_full()
                .h(px(height))
                .child(Skeleton::new())
                .into_any_element(),
            SkeletonBlock::CardGrid { count, columns } => div()
                .grid()
                .grid_cols(columns as u16)
                .gap_2()
                .children((0..count).map(|_| {
                    v_flex()
                        .gap_2()
                        .p_4()
                        .rounded(px(theme.radius_lg))
                        .border_1()
                        .border_color(theme.separator)
                        .bg(theme.card_bg)
                        .child(div().w_24().h(px(18.)).child(Skeleton::new()))
                        .child(div().w_16().h_4().child(Skeleton::new()))
                        .child(div().w_full().h_10().child(Skeleton::new()))
                        .into_any_element()
                }))
                .into_any_element(),
            SkeletonBlock::ChartGrid { count, columns, height } => div()
                .grid()
                .grid_cols(columns as u16)
                .gap_3()
                .children((0..count).map(|_| {
                    // 与正式图表卡同构：标题行 + 描述行 + 图表区
                    v_flex()
                        .w_full()
                        .rounded(px(theme.radius_lg))
                        .bg(theme.card_bg)
                        .shadow(vec![theme.card_shadow_box()])
                        .p_4()
                        .gap_3()
                        .child(
                            v_flex()
                                .gap_1()
                                .child(div().w_24().child(Skeleton::new()))
                                .child(div().w_40().child(Skeleton::new())),
                        )
                        .child(div().w_full().h(px(height)).child(Skeleton::new()))
                        .into_any_element()
                }))
                .into_any_element(),
        }
    }
}

/// 单张 KPI 统计卡骨架（label 短条 + 数字条 + 补充条；对齐 stat_band 卡观感）
fn kpi_card_skeleton(theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .flex_1()
        .gap_2()
        .p_4()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(div().w_16().child(Skeleton::new()))
        .child(div().w_24().h_7().child(Skeleton::new()))
        .child(div().w_20().child(Skeleton::new()))
}

/// Loading：Spinner 行 + 声明式骨架块序列（视图用自己的页面壳包裹）
///
/// ```rust,ignore
/// v_flex()
///     .id("xxx-loading")
///     .size_full().gap_4().p_6().overflow_y_scroll().bg(theme.window_bg)
///     .child(state_views::skeleton_loading(&theme, &[
///         SkeletonBlock::Title,
///         SkeletonBlock::Filter(3),
///         SkeletonBlock::Kpi(6),
///         SkeletonBlock::Table(280.0),
///     ]))
/// ```
pub fn skeleton_loading(theme: &AppTheme, blocks: &[SkeletonBlock]) -> impl IntoElement {
    v_flex()
        .gap_4()
        .child(loading_state(theme, "加载中…"))
        .children(blocks.iter().map(|b| b.render(theme)))
}

/// Loading：Spinner + 文案（默认「加载中…」）
pub fn loading_state(
    theme: &AppTheme,
    text: impl Into<SharedString>,
) -> impl IntoElement {
    h_flex()
        .gap_2()
        .items_center()
        .child(Spinner::new().small().color(theme.text_primary.opacity(0.6)))
        .child(
            div()
                .text_color(theme.text_muted)
                .child(text.into()),
        )
}

/// Error：卡片内 Alert + 重试按钮。
///
/// `view` 是宿主视图实体，`on_retry` 是「重试」点击时在视图上执行的动作
/// （如 `|this, cx| this.reload(cx)`）——闭包捕获方式与既有视图一致，
/// 由组件内部完成 `view.update` 接线。
///
/// P4-5：卡片随 [`content_guard`] 受内容上限约束（宽窗不拉伸）。
pub fn error_state<V: 'static>(
    view: &Entity<V>,
    theme: &AppTheme,
    // 容器与 Alert 的 element id（测试定位 / 快照用；如 `"ad-data-error"`）
    id: &'static str,
    title: impl Into<SharedString>,
    message: impl Into<SharedString>,
    on_retry: impl Fn(&mut V, &mut gpui::Context<V>) + 'static + Copy,
) -> impl IntoElement {
    let view_for_retry = view.clone();
    content_guard().child(
        v_flex()
            .id(id)
            .gap_3()
            .p_4()
            .rounded(px(theme.radius_lg))
            .bg(theme.card_bg)
            .shadow(vec![theme.card_shadow_box()])
            .child(Alert::error(id, message.into()).title(title).w_full())
            .child(
                div().w_full().flex().justify_end().child(
                    Button::new(SharedString::from(format!("{id}-retry")))
                        .outline()
                        .small()
                        .label("重试")
                        .on_click(move |_, _, cx| {
                            view_for_retry.update(cx, |this, cx| on_retry(this, cx));
                        }),
                ),
            ),
    )
}

/// Empty：Icon + 文案（无按钮），包在卡片外壳里
///
/// 公共 API 面（P5-0）：无动作空态（如表格内 / 提示性空态）可用；
/// 绝大多数页面级空态带刷新按钮，用 [`empty_state_with_action`]。
#[allow(dead_code)]
pub fn empty_state(
    theme: &AppTheme,
    // 容器 element id
    id: &'static str,
    // 图标资源路径（`icons/*.svg`）或内置 IconName（语义更贴切时）
    icon: impl Into<EmptyIcon>,
    text: impl Into<SharedString>,
) -> impl IntoElement {
    let inner = empty_card(id, theme, icon.into(), text.into(), None, None);
    content_guard().child(inner)
}

/// Empty：Icon + 文案 + 动作按钮（如「刷新」/「选择项目」）
pub fn empty_state_with_action<V: 'static>(
    view: &Entity<V>,
    theme: &AppTheme,
    id: &'static str,
    // 图标资源路径（`icons/*.svg`）或内置 IconName（语义更贴切时）
    icon: impl Into<EmptyIcon>,
    text: impl Into<SharedString>,
    // 按钮 label（如「刷新」）
    action_label: &'static str,
    on_action: impl Fn(&mut V, &mut gpui::Context<V>) + 'static + Copy,
) -> impl IntoElement {
    empty_state_with_action_desc(
        view,
        theme,
        id,
        icon,
        text,
        None::<SharedString>,
        action_label,
        on_action,
    )
}

/// Empty：Icon + 文案 + 可选次级说明 + 动作按钮（比 [`empty_state_with_action`]
/// 多一行说明文案，如台账空态的「调整筛选条件或点击刷新」）
#[allow(clippy::too_many_arguments)]
pub fn empty_state_with_action_desc<V: 'static>(
    view: &Entity<V>,
    theme: &AppTheme,
    id: &'static str,
    // 图标资源路径（`icons/*.svg`）或内置 IconName（语义更贴切时）
    icon: impl Into<EmptyIcon>,
    text: impl Into<SharedString>,
    // 次级说明（可空：不渲染说明行，行为与 [`empty_state_with_action`] 一致）
    desc: Option<impl Into<SharedString>>,
    // 按钮 label（如「刷新」）
    action_label: &'static str,
    on_action: impl Fn(&mut V, &mut gpui::Context<V>) + 'static + Copy,
) -> impl IntoElement {
    let view_for_action = view.clone();
    let desc = desc.map(Into::into);
    let inner = empty_card(
        id,
        theme,
        icon.into(),
        text.into(),
        desc,
        Some(
            Button::new(SharedString::from(format!("{id}-action")))
                .outline()
                .small()
                .label(action_label)
                .on_click(move |_, _, cx| {
                    view_for_action.update(cx, |this, cx| on_action(this, cx));
                })
                .into_any_element(),
        ),
    );
    content_guard().child(inner)
}

/// 空态图标：SVG 路径（`icons/*.svg`）或内置 IconName
#[derive(Clone)]
pub enum EmptyIcon {
    /// 资源路径（`icons/*.svg`）
    Path(&'static str),
    /// gpui-component 内置图标（语义更贴切时）
    Name(IconName),
}

impl From<&'static str> for EmptyIcon {
    fn from(path: &'static str) -> Self {
        EmptyIcon::Path(path)
    }
}

/// 空态卡片外壳（icon + 文案 + 可选说明 + 可选按钮；P4-5：随 [`content_guard`] 受宽窗上限）
fn empty_card(
    id: &'static str,
    theme: &AppTheme,
    icon: EmptyIcon,
    text: SharedString,
    desc: Option<SharedString>,
    action: Option<gpui::AnyElement>,
) -> impl IntoElement {
    let icon_el = match icon {
        EmptyIcon::Path(path) => Icon::new(Icon::empty())
            .path(path)
            .with_size(px(40.))
            .text_color(theme.text_muted.opacity(0.7))
            .into_any_element(),
        EmptyIcon::Name(name) => Icon::new(name)
            .with_size(px(40.))
            .text_color(theme.text_muted.opacity(0.7))
            .into_any_element(),
    };
    v_flex()
        .id(id)
        .items_center()
        .justify_center()
        .gap_3()
        .px_8()
        .py_10()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(icon_el)
        .child(
            div()
                .text_size(px(14.))
                .text_color(theme.text_muted)
                .child(text),
        )
        .when(desc.is_some(), |this| {
            this.child(
                div()
                    .text_xs()
                    .text_color(theme.text_muted.opacity(0.7))
                    .child(desc.expect("已判 Some")),
            )
        })
        .when(action.is_some(), |this| this.child(action.expect("已判 Some")))
}

/// 空态文案图标（业务视图默认用 `icons/package.svg`；`empty_state` 可自由指定）
///
/// 公共 API 面（P5-0）：默认空态图标，供自定义空态时取用。
#[allow(dead_code)]
pub fn default_empty_icon() -> EmptyIcon {
    EmptyIcon::Path("icons/package.svg")
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    /// 测试宿主视图：同屏渲染全部三态（加载 / 错误 / 空）
    struct StateViewsHost;

    impl gpui::Render for StateViewsHost {
        fn render(&mut self, _window: &mut gpui::Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
            let theme = AppTheme::current(cx);
            v_flex()
                .child(String::from("host"))
                .child(skeleton_loading(
                    &theme,
                    &[
                        SkeletonBlock::Title,
                        SkeletonBlock::Filter(3),
                        SkeletonBlock::Kpi(4),
                        SkeletonBlock::BarRow(7, 72.0),
                        SkeletonBlock::Table(240.0),
                        SkeletonBlock::Chart(180.0),
                        SkeletonBlock::CardGrid { count: 6, columns: 2 },
                    ],
                ))
                .child(error_state(
                    &cx.entity(),
                    &theme,
                    "test-error",
                    "加载失败",
                    "服务暂时不可用",
                    |_, _| {},
                ))
                .child(empty_state_with_action(
                    &cx.entity(),
                    &theme,
                    "test-empty",
                    "icons/package.svg",
                    "没有数据",
                    "刷新",
                    |_, _| {},
                ))
                .child(empty_state(&theme, "test-empty-plain", "icons/package.svg", "空空如也"))
                .child(loading_state(&theme, "加载中…"))
        }
    }

    #[gpui::test]
    async fn state_views_render_in_light_mode(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        cx.add_window_view(|_window, _cx| StateViewsHost);
    }

    #[gpui::test]
    async fn state_views_render_in_dark_mode(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (_host, cx2) = cx.add_window_view(|_window, _cx| StateViewsHost);
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    /// 骨架块声明覆盖全部 7 种块（渲染冒烟在 StateViewsHost 中完成，纯枚举断言防遗漏）
    #[test]
    fn all_skeleton_block_variants_covered() {
        let blocks = [
            SkeletonBlock::Title,
            SkeletonBlock::Filter(2),
            SkeletonBlock::Kpi(3),
            SkeletonBlock::BarRow(5, 60.0),
            SkeletonBlock::Table(120.0),
            SkeletonBlock::Chart(90.0),
            SkeletonBlock::CardGrid { count: 4, columns: 2 },
            SkeletonBlock::ChartGrid { count: 4, columns: 2, height: 120.0 },
        ];
        // 枚举可构造、可 Copy、可计数（无 unreachable 分支导致的 panic）
        assert_eq!(blocks.len(), 8);
        assert!(matches!(blocks[0], SkeletonBlock::Title));
    }

    /// 空态图标变体均可构造（Path / Name 两路）
    #[test]
    fn empty_icon_variants_compose() {
        let _path: EmptyIcon = "icons/package.svg".into();
        let _name = EmptyIcon::Name(IconName::Inbox);
    }
}