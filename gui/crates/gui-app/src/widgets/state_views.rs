//! 统一三态视图（P5-0 公共基建，BLF-759）
//!
//! 对齐 web 端骨架屏 + 空态文案习惯，收敛各业务视图的
//! Loading / Error（带重试）/ Empty 渲染：
//!
//! - [`loading_state`]：Spinner + 文案 + 骨架占位（对齐
//!   ad_analysis.rs `render_loading` 的骨架观感）；
//! - [`error_state`]：卡片内 Alert + 重试按钮（对齐 ad_analysis.rs
//!   `render_error`）；通过传入视图实体 `Entity<V>` + `on_retry` 闭包回连视图；
//! - [`empty_state`] / [`empty_state_with_action`]：Icon + 文案 + 可选按钮
//!   （对齐 ad_analysis.rs `render_empty`）。
//!
//! 三态都包在统一卡片外壳里（card_bg + radius_lg + 轻投影），视觉与
//! dashboard 卡片一致；亮 / 暗主题只消费 `AppTheme` token。

use gpui::{div, prelude::*, px, Entity, IntoElement, ParentElement, SharedString, Styled};
use gpui_component::{
    alert::Alert,
    button::Button,
    skeleton::Skeleton,
    spinner::Spinner,
    h_flex, v_flex, Icon, Sizable,
};

use crate::theme::AppTheme;
use crate::widgets::layout::content_guard;

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

/// Loading + 骨架占位：Spinner 行 + 4 张指标卡骨架 + 两块表格骨架
/// （对齐 ad_analysis.rs `render_loading`，供列表 / 详情页复用；公共 API 面）
#[allow(dead_code)]
pub fn loading_state_with_skeleton(theme: &AppTheme) -> impl IntoElement {
    v_flex()
        .gap_4()
        .child(loading_state(theme, "加载中…"))
        .child(
            h_flex()
                .gap_3()
                .children((0..4).map(|_| {
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
                })),
        )
        .child(div().w_full().h_40().child(Skeleton::new()))
        .child(div().w_full().h(px(240.)).child(Skeleton::new()))
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

/// Empty：Icon + 文案（无按钮），包在卡片外壳里（公共 API 面）
#[allow(dead_code)]
pub fn empty_state(
    theme: &AppTheme,
    // 容器 element id
    id: &'static str,
    // 图标资源路径（`icons/*.svg`）
    icon_path: &'static str,
    text: impl Into<SharedString>,
) -> impl IntoElement {
    empty_card(id, theme, icon_path, text.into(), None)
}

/// Empty：Icon + 文案 + 动作按钮（如「刷新」/「选择项目」）
pub fn empty_state_with_action<V: 'static>(
    view: &Entity<V>,
    theme: &AppTheme,
    id: &'static str,
    icon_path: &'static str,
    text: impl Into<SharedString>,
    // 按钮 label（如「刷新」）
    action_label: &'static str,
    on_action: impl Fn(&mut V, &mut gpui::Context<V>) + 'static + Copy,
) -> impl IntoElement {
    let view_for_action = view.clone();
    empty_card(
        id,
        theme,
        icon_path,
        text.into(),
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
    )
}

/// Empty 卡片外壳（icon + 文案 + 可选按钮；P4-5：随 [`content_guard`] 受宽窗上限）
fn empty_card(
    id: &'static str,
    theme: &AppTheme,
    icon_path: &'static str,
    text: SharedString,
    action: Option<gpui::AnyElement>,
) -> impl IntoElement {
    content_guard().child(
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
            .child(
                Icon::new(Icon::empty())
                    .path(icon_path)
                    .with_size(px(40.))
                    .text_color(theme.text_muted.opacity(0.7)),
            )
            .child(
                div()
                    .text_size(px(14.))
                    .text_color(theme.text_muted)
                    .child(text),
            )
            .when(action.is_some(), |this| this.child(action.expect("已判 Some"))),
    )
}

/// 空态文案图标（业务视图默认用 `icons/package.svg`；`empty_state` 可自由指定；
/// 公共 API 面）
#[allow(dead_code)]
pub fn default_empty_icon() -> &'static str {
    "icons/package.svg"
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
                .child(loading_state_with_skeleton(&theme))
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
}
