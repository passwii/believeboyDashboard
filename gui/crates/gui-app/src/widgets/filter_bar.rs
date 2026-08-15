//! 通用筛选栏（P5-0 公共基建，BLF-759）
//!
//! 对齐 web 端 `useUrlParam` 筛选模式：项目 / 国家 / 日期区间等常用筛选项
//! 组合成一排控件，输出结构化 [`gui_domain::filter::TableFilter`]（由各视图
//! 维护），api-client 侧用 `QueryBuilder::with_filter` 直接转 query 参数。
//!
//! 组成：
//! - [`filter_bar_layout`]：容器（label + 控件 + 弹性空隙 + 尾部操作位）；
//! - [`filter_select`]：带 label 的下拉按钮构建块（项目 / 国家 / 报表类型等
//!   单选下拉共用；与 ad_data.rs 既有 `filter_select` 语义一致）。
//!
//! 视图组装示例：
//! ```ignore
//! filter_bar_layout(&theme)
//!     .child(filter_select(&theme, "项目", label, "stock-project-filter",
//!         move |menu, _w, _cx| { /* PopupMenuItem… */ menu }))
//!     .child(/* date_range_picker 等 */)
//! ```

use gpui::{div, px, IntoElement, ParentElement, SharedString, Styled};
use gpui_component::{button::Button, h_flex, menu::DropdownMenu, Icon, IconName, Sizable};

use crate::theme::AppTheme;

/// 筛选栏容器：`h_flex`（可换行）+ 12px 间距，尾部自动弹性空隙
/// （右侧刷新按钮等操作位用 `child(...)` 追加到最末）。
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
                .text_color(theme.text_muted)
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
}
