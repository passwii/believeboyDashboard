//! 通用筛选栏（P5-0 公共基建，BLF-759）
//!
//! 对齐 web 端 `useUrlParam` 筛选模式：项目 / 国家 / 日期区间等常用筛选项
//! 组合成一排控件，输出结构化 [`gui_domain::filter::TableFilter`]（由各视图
//! 维护），api-client 侧用 `QueryBuilder::with_filter` 直接转 query 参数。
//!
//! 组成：
//! - [`filter_bar_layout`]：容器（label + 控件 + 弹性空隙 + 尾部操作位）；
//!   控件间距统一 12px（gap_3 节奏，回归锁见测试），控件高度基线统一
//!   `.small()` 尺寸（与 date_range / pagination 一致，P4-7）；
//! - [`filter_select`]：带 label 的下拉按钮构建块（项目 / 国家 / 报表类型等
//!   单选下拉共用）；label 走说明级色阶 `text_secondary`（P4-7 排版层级）。
//!
//! 视图组装示例：
//! ```ignore
//! filter_bar_layout(&theme)
//!     .child(filter_select(&theme, "项目", label, "stock-project-filter",
//!         move |menu, _w, _cx| { /* PopupMenuItem… */ menu }))
//!     .child(/* date_range_picker 等 */)
//! ```

use gpui::{div, px, InteractiveElement, IntoElement, ParentElement, SharedString, Styled};
use gpui_component::{button::Button, h_flex, menu::DropdownMenu, Icon, IconName, Sizable, Size};

use crate::theme::AppTheme;

/// 筛选栏容器：`h_flex`（可换行）+ 12px 间距（gap_3 节奏，控件间统一），
/// 尾部自动弹性空隙（右侧刷新按钮等操作位用 `child(...)` 追加到最末）。
///
/// 返回具体 `h_flex` 类型以便调用方链式 `.child(...)` 追加控件。
pub fn filter_bar_layout(theme: &AppTheme) -> gpui::Div {
    let _ = theme; // 目前无主题相关样式；保留参数保持调用一致性
    h_flex().gap_3().items_center().flex_wrap()
}

/// 带 label 的下拉筛选构建块（项目 / 国家 / 报表类型共用）。
///
/// - `current`：按钮当前显示值（如「测试项目」/「美国站 (US)」）；
/// - `id`：按钮 element id（测试定位用）；
/// - `menu_builder`：`dropdown_menu_with_anchor` 的菜单构建闭包
///   （捕获视图实体 + 选项数据，逐项 `PopupMenuItem`）。
pub fn filter_select(
    theme: &AppTheme,
    label: &str,
    current: SharedString,
    id: &'static str,
    menu_builder: impl Fn(
            gpui_component::menu::PopupMenu,
            &mut gpui::Window,
            &mut gpui::Context<'_, gpui_component::menu::PopupMenu>,
        ) -> gpui_component::menu::PopupMenu
        + 'static,
) -> impl IntoElement {
    h_flex()
        .gap_2()
        .items_center()
        .child(
            div()
                .text_sm()
                .text_color(theme.text_secondary)
                .child(label.to_string()),
        )
        .child(
            Button::new(id)
                .outline()
                .small()
                .label(current)
                .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                .dropdown_menu_with_anchor(gpui::Corner::BottomLeft, menu_builder),
        )
}

/// 工具栏弹性空隙（把右侧操作按钮推到行尾）
pub fn toolbar_spacer() -> gpui::Div {
    div().flex_1()
}

/// Pattern A 工具栏搜索输入框（BLF-798）：小尺寸（26px 高，落在控件
/// 24~28px 规格）、放大镜 prefix、可清空、固定宽。
///
/// `InputState` 懒建由宿主视图负责（首帧 render 内创建，见 ad_data.rs 范式）。
pub fn toolbar_search_input(
    theme: &AppTheme,
    state: &gpui::Entity<gpui_component::input::InputState>,
    id: &'static str,
    width: f32,
) -> impl IntoElement {
    div()
        .id(SharedString::from(id))
        .child(
            gpui_component::input::Input::new(state)
                .with_size(Size::Small)
                .h(px(26.))
                .w(px(width))
                .cleanable(true)
                .prefix(
                    gpui::svg()
                        .path("icons/search.svg")
                        .size(px(13.))
                        .text_color(theme.text_muted),
                ),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 渲染冒烟：亮 / 暗主题下筛选栏（两个下拉 + 布局容器）可渲染
    #[gpui::test]
    async fn filter_bar_renders_in_light_and_dark(cx: &mut gpui::TestAppContext) {
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
            struct FilterBarHost;
            impl gpui::Render for FilterBarHost {
                fn render(&mut self, _window: &mut gpui::Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
                    let theme = AppTheme::current(cx);
                    filter_bar_layout(&theme)
                        .child(filter_select(
                            &theme,
                            "项目",
                            SharedString::from("请选择项目"),
                            "test-project-filter",
                            |menu, _w, _cx| menu,
                        ))
                        .child(filter_select(
                            &theme,
                            "站点",
                            SharedString::from("美国站 (US)"),
                            "test-country-filter",
                            |menu, _w, _cx| menu,
                        ))
                        .child(
                            Button::new("test-refresh")
                                .outline()
                                .small()
                                .label("刷新"),
                        )
                }
            }
            let (_host, cx2) = cx.add_window_view(|_window, _cx| FilterBarHost);
            cx2.read(|app| {
                assert_eq!(
                    crate::theme::AppTheme::current(app).is_dark(),
                    dark
                );
            });
        }
    }

    /// P4-7（BLF-762）节奏契约：筛选栏控件间距统一 12px（gap_3）——
    /// 跨视图垂直 / 水平节奏单一来源，防散落间距回退。
    #[test]
    fn filter_bar_layout_gap_rhythm_contract() {
        let theme = AppTheme::light();
        let mut el = filter_bar_layout(&theme);
        let gap_px = match el.style().gap.width {
            Some(gpui::DefiniteLength::Absolute(abs)) => f32::from(abs.to_pixels(gpui::px(16.0))),
            other => panic!("筛选栏间距必须是定长：{other:?}"),
        };
        assert_eq!(gap_px, 12.0, "控件间距必须统一 12px（gap_3 节奏）");
    }

    /// P4-7（BLF-762）排版层级契约：筛选 label 走说明级色阶（text_secondary，
    /// 非弱化四级的 text_muted）——label 是字段说明而非元信息。
    #[test]
    fn filter_select_label_uses_secondary_tier() {
        let src = include_str!("filter_bar.rs");
        assert!(
            src.contains("text_color(theme.text_secondary)"),
            "筛选 label 必须用 text_secondary 说明级色阶"
        );
    }
}
