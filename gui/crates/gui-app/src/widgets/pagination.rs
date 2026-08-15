//! 通用分页（P5-0 公共基建，BLF-759）
//!
//! - [`PageState`]：纯分页状态（当前页 / 每页行数 / 总数），不依赖 GPUI，
//!   可单测；提供页数计算、页号窗口、首末条索引等派生逻辑；
//! - [`pagination_bar`]：渲染「每页行数选择 + 上一页 / 页码 / 下一页 + 总数」，
//!   与 DataTable / 任意列表组合；翻页与改每页行数通过宿主视图实体回连
//!   （`on_page` / `on_page_size` 闭包，如 `|this, page, cx| this.set_page(page, cx)`）。
//!
//! 对齐 ad_data.rs 既有分页栏的观感（outline 小按钮 + 页信息文字），
//! 额外补上页码数字（对齐 web 端分页习惯）。

use gpui::{div, prelude::*, px, Entity, IntoElement, ParentElement, SharedString, Styled};
use gpui_component::{
    button::{Button, ButtonVariants},
    h_flex,
    menu::{DropdownMenu, PopupMenuItem},
    Disableable, Icon, IconName, Sizable,
};

use crate::theme::AppTheme;

/// 纯分页状态（page 为 1-based）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageState {
    /// 当前页（1-based；构造时收敛到 `[1, page_count]`）
    pub page: usize,
    /// 每页行数（≥1）
    pub page_size: usize,
    /// 总行数
    pub total: usize,
}

impl PageState {
    /// 构造（page 立即收敛到安全范围）
    pub fn new(page: usize, page_size: usize, total: usize) -> Self {
        let page_size = page_size.max(1);
        let page_count = total.div_ceil(page_size).max(1);
        Self {
            page: page.clamp(1, page_count),
            page_size,
            total,
        }
    }

    /// 总页数（空数据 = 1 页）
    pub fn page_count(&self) -> usize {
        self.total.div_ceil(self.page_size).max(1)
    }

    /// 是否可上一页
    pub fn can_prev(&self) -> bool {
        self.page > 1
    }

    /// 是否可下一页
    pub fn can_next(&self) -> bool {
        self.page < self.page_count()
    }

    /// 当前页首条下标（0-based；空数据 = 0；公共 API 面）
    #[allow(dead_code)]
    pub fn first_index(&self) -> usize {
        if self.total == 0 {
            0
        } else {
            (self.page - 1) * self.page_size
        }
    }

    /// 当前页末条下标（0-based，含；不越界；公共 API 面）
    #[allow(dead_code)]
    pub fn last_index(&self) -> usize {
        if self.total == 0 {
            0
        } else {
            (self.first_index() + self.page_size).min(self.total) - 1
        }
    }

    /// 当前页行数（末页可能不足一页；公共 API 面）
    #[allow(dead_code)]
    pub fn displayed(&self) -> usize {
        if self.total == 0 {
            0
        } else {
            self.last_index() - self.first_index() + 1
        }
    }

    /// 页码窗口（当前页前后各 `window` 个，首尾保留；0 = 省略号占位）
    pub fn windowed_pages(&self, window: usize) -> Vec<usize> {
        let count = self.page_count();
        if count <= window * 2 + 1 {
            return (1..=count).collect();
        }
        let lo = self.page.saturating_sub(window).max(1);
        let hi = (self.page + window).min(count);
        let mut pages: Vec<usize> = Vec::new();
        pages.push(1);
        if lo > 2 {
            pages.push(0); // 前省略号占位
        }
        for p in lo.max(2)..=hi.min(count - 1).max(2) {
            if p > 1 && p < count {
                pages.push(p);
            }
        }
        if hi < count - 1 {
            pages.push(0); // 后省略号占位
        }
        if count > 1 {
            pages.push(count);
        }
        pages
    }
}

/// 分页栏：每页行数 + 上一页 / 页码 / 下一页 + 总数
///
/// - `id_prefix`：容器 element id（如 `"ad-data-pagination"`，测试定位用）；
/// - `page_size_options`：每页行数下拉选项（如 `&[50, 100, 200, 500]`）；
/// - `on_page(page)` / `on_page_size(size)`：宿主视图的动作（闭包捕获实体）。
#[allow(clippy::too_many_arguments)]
pub fn pagination_bar<V: 'static>(
    view: &Entity<V>,
    theme: &AppTheme,
    id_prefix: &'static str,
    state: &PageState,
    page_size_options: &[usize],
    on_page: impl Fn(&mut V, usize, &mut gpui::Context<V>) + 'static + Copy,
    on_page_size: impl Fn(&mut V, usize, &mut gpui::Context<V>) + 'static + Copy,
) -> impl IntoElement {
    let options: Vec<usize> = page_size_options.to_vec();
    let (page, page_size, total, page_count) =
        (state.page, state.page_size, state.total, state.page_count());
    let view_for_size = view.clone();
    let view_for_prev = view.clone();
    let view_for_next = view.clone();
    let view_for_jump = view.clone();

    h_flex()
        .id(id_prefix)
        .w_full()
        .items_center()
        .justify_between()
        .gap_3()
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .text_sm()
                .text_color(theme.text_muted)
                .child(div().child("每页"))
                .child(
                    Button::new(SharedString::from(format!("{id_prefix}-page-size")))
                        .outline()
                        .small()
                        .label(SharedString::from(format!("{page_size}")))
                        .icon(Icon::new(IconName::ChevronDown).with_size(px(12.)))
                        .dropdown_menu_with_anchor(
                            gpui::Corner::TopLeft,
                            move |menu, _window, _cx| {
                                let mut menu = menu;
                                for size in &options {
                                    let checked = page_size == *size;
                                    let view = view_for_size.clone();
                                    let size = *size;
                                    menu = menu.item(
                                        PopupMenuItem::new(SharedString::from(format!("{size}")))
                                            .checked(checked)
                                            .on_click(move |_, _window, cx| {
                                                view.update(cx, |this, cx| {
                                                    on_page_size(this, size, cx)
                                                });
                                            }),
                                    );
                                }
                                menu
                            },
                        ),
                )
                .child(div().child("行")),
        )
        .child(
            h_flex()
                .gap_1()
                .items_center()
                .child(
                    Button::new(SharedString::from(format!("{id_prefix}-prev")))
                        .outline()
                        .small()
                        .label("上一页")
                        .disabled(!state.can_prev())
                        .on_click(move |_, _, cx| {
                            let view = view_for_prev.clone();
                            view.update(cx, |this, cx| {
                                on_page(this, page.saturating_sub(1).max(1), cx)
                            });
                        }),
                )
                .children(state.windowed_pages(2).into_iter().map(|p| {
                    if p == 0 {
                        // 省略号占位
                        div()
                            .px_1()
                            .text_sm()
                            .text_color(theme.text_muted)
                            .child("…")
                            .into_any_element()
                    } else {
                        let is_current = p == page;
                        let view = view_for_jump.clone();
                        Button::new(SharedString::from(format!("{id_prefix}-page-{p}")))
                            .outline()
                            .small()
                            .label(SharedString::from(format!("{p}")))
                            .when(is_current, |b| b.primary())
                            .when(!is_current, |b| b)
                            .on_click(move |_, _, cx| {
                                let view = view.clone();
                                view.update(cx, |this, cx| on_page(this, p, cx));
                            })
                            .into_any_element()
                    }
                }))
                .child(
                    Button::new(SharedString::from(format!("{id_prefix}-next")))
                        .outline()
                        .small()
                        .label("下一页")
                        .disabled(!state.can_next())
                        .on_click(move |_, _, cx| {
                            let view = view_for_next.clone();
                            view.update(cx, |this, cx| {
                                on_page(this, (page + 1).min(page_count), cx)
                            });
                        }),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.text_muted)
                        .child(format!(
                            "第 {page} / {page_count} 页 · 共 {total} 条",
                        )),
                ),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_state_counts_pages() {
        let s = PageState::new(1, 50, 123);
        assert_eq!(s.page_count(), 3);
        assert!(!s.can_prev());
        assert!(s.can_next());
    }

    #[test]
    fn page_state_clamps_out_of_range() {
        // 页超出范围 → 收敛到末页
        let s = PageState::new(99, 50, 123);
        assert_eq!(s.page, 3);
        // 0 页 → 收敛到 1
        let s = PageState::new(0, 50, 123);
        assert_eq!(s.page, 1);
        // page_size 0 → 兜底 1
        let s = PageState::new(1, 0, 10);
        assert_eq!(s.page_size, 1);
    }

    #[test]
    fn page_state_empty_total_is_single_page() {
        let s = PageState::new(1, 50, 0);
        assert_eq!(s.page_count(), 1);
        assert_eq!(s.first_index(), 0);
        assert_eq!(s.last_index(), 0);
        assert_eq!(s.displayed(), 0);
        assert!(!s.can_next());
    }

    #[test]
    fn page_state_first_last_and_displayed() {
        // 第 2 页（50/页，共 123）：51..100
        let s = PageState::new(2, 50, 123);
        assert_eq!(s.first_index(), 50);
        assert_eq!(s.last_index(), 99);
        assert_eq!(s.displayed(), 50);
        // 末页（第 3 页）：101..123 → 23 行
        let s = PageState::new(3, 50, 123);
        assert_eq!(s.first_index(), 100);
        assert_eq!(s.last_index(), 122);
        assert_eq!(s.displayed(), 23);
    }

    #[test]
    fn windowed_pages_keeps_first_last_and_ellipsis() {
        // 少页 → 全量
        let s = PageState::new(2, 10, 50);
        assert_eq!(s.windowed_pages(2), vec![1, 2, 3, 4, 5]);
        // 多页且当前页在中间 → 首尾 + 窗口 + 省略号(0)
        let s = PageState::new(5, 10, 200);
        assert_eq!(s.windowed_pages(2), vec![1, 0, 3, 4, 5, 6, 7, 0, 20]);
        // 当前页靠前 → 无前省略号
        let s = PageState::new(2, 10, 200);
        assert_eq!(s.windowed_pages(2), vec![1, 2, 3, 4, 0, 20]);
        // 当前页靠后 → 无后省略号
        let s = PageState::new(19, 10, 200);
        assert_eq!(s.windowed_pages(2), vec![1, 0, 17, 18, 19, 20]);
    }

    /// 渲染冒烟：亮 / 暗主题下分页栏（含省略号与页码按钮）可渲染
    #[gpui::test]
    async fn pagination_bar_renders_in_light_and_dark(cx: &mut gpui::TestAppContext) {
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
            struct PaginationHost;
            impl gpui::Render for PaginationHost {
                fn render(&mut self, _window: &mut gpui::Window, cx: &mut gpui::Context<Self>) -> impl IntoElement {
                    let theme = AppTheme::current(cx);
                    let state = PageState::new(5, 50, 1234);
                    pagination_bar(
                        &cx.entity(),
                        &theme,
                        "test-pagination",
                        &state,
                        &[50, 100, 200, 500],
                        |_, _, _| {},
                        |_, _, _| {},
                    )
                }
            }
            let (_host, cx2) = cx.add_window_view(|_window, _cx| PaginationHost);
            cx2.read(|app| {
                assert_eq!(
                    crate::theme::AppTheme::current(app).is_dark(),
                    dark
                );
            });
        }
    }
}
