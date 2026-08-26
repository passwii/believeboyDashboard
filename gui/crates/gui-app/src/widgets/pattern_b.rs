//! Pattern B「双轴分析画布」标准模板（BLF-799，Stage8）
//!
//! 父 issue「视图模板」Pattern B 规格的可复用实现，供广告分析 / 销售趋势 /
//! 退货分析及一切「多 Tab 复合页」（财务月报 3 Tab、佣金 5 Tab、库存台账）
//! 套版。结构（自上而下）：
//!
//! - **PageHeader**：复用 [`crate::widgets::page_header::PageHeader`]；
//! - **FilterToolbar 行**（36px）：同 Pattern A 的 [`FILTER_TOOLBAR_HEIGHT`]，
//!   宿主放项目 / 站点 / 日期与刷新控件；
//! - **上部图表区**：高度 = [`Self::shell 高度 × chart_ratio`]（`relative()`
//!   分数高），规格锁 40%~50%（[`MIN_CHART_RATIO`] ~ [`MAX_CHART_RATIO`]）。
//!   多图并排由宿主组合（折线趋势 + 柱状分布，基于 chart_primitives 基元），
//!   空态 [`crate::widgets::chart_primitives::chart_empty`] 与加载态
//!   [`chart_loading`] 统一出口；
//! - **分割条** [`split_divider`]：6px 命中区 + ResizeUpDown 光标 + 拖拽视觉
//!   线；比例经 [`apply_split_drag`] 回写宿主（拖拽全程平滑、松手提交记忆）；
//! - **下部子 Tab 区**：Tab 条 [`tab_bar`]（32px）+ 各 Tab 独立内容区。
//!   数据网格直接复用 Pattern A 的 [`crate::widgets::data_grid::DataGrid`]。
//!
//! ## 接入方式（多 Tab 复合页套版清单）
//!
//! 1. **宿主持有状态**：
//!    - `chart_ratio: f32`——初始值自 `prefs::load_ui_prefs().analysis_chart_ratio`
//!      恢复（缺省 [`DEFAULT_CHART_RATIO`]）；松手时 emit 事件交组合根持久化
//!      （视图层不碰文件系统，延续 BLF-794~796 纪律）；
//!    - 每 Tab 一个惰性槽（如 `Option<Entity<DataGrid<T>>>`）+ 该 Tab 已加载
//!      参数快照 + 三态（Loading / Loaded / Empty / Error）。
//! 2. **渲染**：`pattern_b_shell(theme, id, header, toolbar, chart_ratio,
//!    charts_row, divider, tab_bar, active_content)` 组装页面壳；分割条在宿主
//!    方法内接 `.on_drag(SplitDrag …)` 与 `.on_drag_move(cx.listener(…))`
//!    （内部调 [`apply_split_drag`]）以及 `.on_mouse_up(_out)` 提交记忆。
//! 3. **Tab 懒加载与状态保持**（机制约定，模板不做强约束）：
//!    - 首次激活某 Tab 时才发起该 Tab 的数据请求（懒建网格实体 + 触发拉取）；
//!    - 已加载的 Tab 切走再切回**不重复请求**——判据 = 「已持有实体 且 其加载
//!      参数 == 当前筛选参数」；筛选参数变化时使全部 Tab 失效（下次激活重拉）；
//!    - Tab 内容实体常驻宿主（不随切换销毁），滚动位置 / 列宽等状态自然保持。
//! 4. **数字一律 mono**：数值列走 [`ColumnDef::number`] 或 numeric 构造器；
//!    图表图例 / 统计项等自绘数字加 `mono_tabular_nums`。
//!
//! ```ignore
//! // 宿主 render 片段（广告分析原型即此形态）：
//! let divider = split_divider(&theme, "ad-split")
//!     .on_drag(SplitDrag, |_, _, _, cx| cx.new(|_| SplitDragGhost))
//!     .on_drag_move(cx.listener(|this, ev, _, cx| {
//!         apply_split_drag(ev, this, cx, |this, ratio, cx| this.set_chart_ratio(ratio, cx));
//!     }))
//!     .on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, cx| this.commit_chart_ratio(cx)))
//!     .on_mouse_up_out(MouseButton::Left, cx.listener(|this, _, _, cx| this.commit_chart_ratio(cx)));
//! pattern_b_shell(&theme, "ad-analysis", header, toolbar, self.chart_ratio,
//!                 charts_row, divider, tab_bar, active_tab_content)
//! ```

use gpui::{
    div, prelude::*, px, relative, Context, CursorStyle, Entity, FontWeight, IntoElement,
    ParentElement, SharedString, Styled,
};
use gpui_component::{h_flex, v_flex};

use crate::theme::{AppTheme, FONT_BASE};
use crate::widgets::data_grid::FILTER_TOOLBAR_HEIGHT;

// ---------------------------------------------------------------------------
// 分割比例（规格：上部图表区占高 40~50%）
// ---------------------------------------------------------------------------

/// 默认图表区占比（45%，落在规格区间中点附近）
pub const DEFAULT_CHART_RATIO: f32 = 0.45;
/// 图表区占比下限（40%）
pub const MIN_CHART_RATIO: f32 = 0.40;
/// 图表区占比上限（50%）
pub const MAX_CHART_RATIO: f32 = 0.50;

/// 由指针位置计算图表区新占比（纯函数可测；clamp 进规格区间）。
///
/// `container_top` / `container_height` 为**页面壳**（pattern_b_shell 元素）的
/// 顶部 y 与总高——on_drag_move 挂在壳上，`DragMoveEvent::bounds` 即壳 bounds。
pub fn chart_ratio_for(container_top: f32, container_height: f32, pointer_y: f32) -> f32 {
    if container_height <= 0.0 {
        return DEFAULT_CHART_RATIO;
    }
    ((pointer_y - container_top) / container_height).clamp(MIN_CHART_RATIO, MAX_CHART_RATIO)
}

/// 占比持久化的整数编码（per-mille；400..=500），与 prefs u16 字段对齐
pub fn ratio_to_per_mille(ratio: f32) -> u16 {
    (ratio * 1000.0)
        .round()
        .clamp(MIN_CHART_RATIO * 1000.0, MAX_CHART_RATIO * 1000.0) as u16
}

/// 占比持久化的解码（越界 / 缺省回落默认值）
pub fn ratio_from_per_mille(per_mille: Option<u16>) -> f32 {
    let default = || DEFAULT_CHART_RATIO;
    let Some(v) = per_mille else {
        return default();
    };
    let v = v as f32;
    if !(MIN_CHART_RATIO * 1000.0..=MAX_CHART_RATIO * 1000.0).contains(&v) {
        return default();
    }
    v / 1000.0
}

// ---------------------------------------------------------------------------
// 垂直分割条（上下两区；gpui DnD 机制同 data_grid 列宽拖拽 / Inspector 调宽）
// ---------------------------------------------------------------------------

/// 分割条命中区宽度（px；视觉线由 hover 态内部 1px child 绘制）
pub const SPLIT_HANDLE_HIT: f32 = 6.0;

/// 分割条拖拽标记（on_drag/on_drag_move 配对；无数据负载）
#[derive(Clone)]
pub struct SplitDrag;

/// 拖拽 ghost（accent 细条视觉反馈）
pub struct SplitDragGhost;

impl Render for SplitDragGhost {
    fn render(&mut self, _window: &mut gpui::Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div().w(px(2.)).h_full().bg(AppTheme::dark().accent)
    }
}

/// 垂直分割条（宿主再接 on_drag / on_drag_move / on_mouse_up(_out) 三件套；
/// 见模块级 doc-comment 的接入示例）。
pub fn split_divider(theme: &AppTheme, id: &'static str) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .cursor(CursorStyle::ResizeUpDown)
        .h(px(SPLIT_HANDLE_HIT))
        .w_full()
        .flex_none()
        .items_center()
        .justify_center()
        .bg(theme.window_bg)
        .child(
            // 常态可见的 1px 分隔线（提示可拖拽；hover 时提亮为 accent）
            div()
                .id(SharedString::from(format!("{id}-line")))
                .w_full()
                .h(px(1.))
                .bg(theme.separator)
                .hover(|this| this.bg(theme.accent)),
        )
        .hover(|this| this.bg(theme.muted_fill))
}

/// 从 [`gpui::DragMoveEvent`] 提取指针相对页面壳的位置并回写占比
/// （通用接线：宿主 listener 内一行调用；`on_ratio` 只在值变化时收到回调）。
pub fn apply_split_drag<V: 'static>(
    ev: &gpui::DragMoveEvent<SplitDrag>,
    this: &mut V,
    cx: &mut Context<V>,
    on_ratio: impl FnOnce(&mut V, f32, &mut Context<V>),
) {
    let top: f32 = ev.bounds.origin.y.into();
    let height: f32 = ev.bounds.size.height.into();
    let pointer_y: f32 = ev.event.position.y.into();
    on_ratio(this, chart_ratio_for(top, height, pointer_y), cx);
}

// ---------------------------------------------------------------------------
// 子 Tab 条
// ---------------------------------------------------------------------------

/// 子 Tab 条高度（32px；与 Console Bar / 工具栏行同一密度带）
pub const TAB_BAR_HEIGHT: f32 = 32.0;

/// Tab 条目定义（key 供宿主路由 / 测试断言；label 直接展示）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TabItem {
    pub key: &'static str,
    pub label: &'static str,
}

impl TabItem {
    pub fn new(key: &'static str, label: &'static str) -> Self {
        Self { key, label }
    }
}

/// 子 Tab 条（下划线式高密度 Tab：活动项 accent 下指示条 + 主文字色；
/// 非活动项 muted 文字 + hover 反馈）。选中回调走 `Entity<V>` + 闭包
/// （同 [`crate::widgets::data_grid::grid_footer_bar`] 范式）。
pub fn tab_bar<V: 'static>(
    view: &Entity<V>,
    theme: &AppTheme,
    id_prefix: &'static str,
    items: &[TabItem],
    active_ix: usize,
    on_select: impl Fn(&mut V, usize, &mut Context<V>) + 'static + Copy,
) -> gpui::Stateful<gpui::Div> {
    let view = view.clone();
    h_flex()
        .id(SharedString::from(format!("{id_prefix}-tab-bar")))
        .w_full()
        .flex_none()
        .h(px(TAB_BAR_HEIGHT))
        .px_2()
        .gap_1()
        .overflow_x_scroll()
        .bg(theme.panel_bg)
        .border_b_1()
        .border_color(theme.separator)
        .children(items.iter().enumerate().map(|(ix, item)| {
            let active = ix == active_ix;
            let item_id = SharedString::from(format!("{id_prefix}-tab-{}", item.key));
            let mut tab = h_flex()
                .id(item_id)
                .relative()
                .px_3()
                .items_center()
                .cursor(gpui::CursorStyle::PointingHand).text_size(px(crate::theme::fs(FONT_BASE)))
                .when(active, |this| {
                    this.font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_primary)
                })
                .when(!active, |this| {
                    this.text_color(theme.text_muted).hover(|h| {
                        h.bg(theme.table_row_hover).text_color(theme.text_secondary)
                    })
                })
                .child(item.label);
            // 活动 Tab 底部 2px accent 指示条（贴住 Tab 条底边框）
            tab = tab.child(
                div()
                    .absolute()
                    .bottom_0()
                    .left_0()
                    .right_0()
                    .h(px(2.))
                    .when(active, |this| this.bg(theme.accent))
                    .when(!active, |this| this.bg(gpui::transparent_black())),
            );
            tab.on_click({
                let view = view.clone();
                move |_, _, cx| {
                    view.update(cx, |this, cx| on_select(this, ix, cx));
                }
            })
        }))
}

// ---------------------------------------------------------------------------
// Pattern B 页面壳
// ---------------------------------------------------------------------------

/// Pattern B 页面骨架：PageHeader + FilterToolbar（36px）+ 上部图表区
/// （高 = `chart_ratio` 分数）+ 分割条 + 下部子 Tab 区（弹性占满剩余高）。
///
/// 容器外 padding 0、区间 1px 分隔线；`charts` / `tabs` 由宿主传入**内容**
/// （图表卡组合 / Tab 条 + 活跃内容列），壳负责分区尺寸与 chrome。分割条的
/// 拖拽三件套由宿主在传入前接好（见模块 doc-comment）。
#[allow(clippy::too_many_arguments)]
pub fn pattern_b_shell(
    theme: &AppTheme,
    id: &'static str,
    header: impl IntoElement,
    toolbar: impl IntoElement,
    chart_ratio: f32,
    charts: impl IntoElement,
    divider: impl IntoElement,
    tabs: impl IntoElement,
) -> gpui::Stateful<gpui::Div> {
    let ratio = chart_ratio.clamp(MIN_CHART_RATIO, MAX_CHART_RATIO);
    v_flex()
        .id(id)
        .size_full()
        .min_h_0()
        .bg(theme.window_bg)
        .child(
            div()
                .id(SharedString::from(format!("{id}-page-header")))
                .w_full()
                .flex_none()
                .border_b_1()
                .border_color(theme.separator)
                .bg(theme.window_bg)
                .child(header),
        )
        .child(
            h_flex()
                .id(SharedString::from(format!("{id}-toolbar")))
                .w_full()
                .flex_none()
                .h(px(FILTER_TOOLBAR_HEIGHT))
                .px_2()
                .gap_2()
                .items_center()
                .bg(theme.panel_bg)
                .border_b_1()
                .border_color(theme.separator)
                .child(toolbar),
        )
        .child(
            div()
                .id(SharedString::from(format!("{id}-charts")))
                .w_full()
                .flex_none()
                .min_h_0()
                .h(relative(ratio))
                .overflow_hidden()
                .child(charts),
        )
        .child(divider)
        .child(
            div()
                .id(SharedString::from(format!("{id}-tabs")))
                .flex()
                .flex_col()
                .flex_1()
                .min_h_0()
                .w_full()
                .overflow_hidden()
                .child(tabs),
        )
}

/// Tab 区内容行辅助：Tab 条 + 活跃内容（内容区 flex_1 占满剩余高）。
pub fn tabs_zone(
    tab_strip: impl IntoElement,
    content: impl IntoElement,
) -> gpui::Stateful<gpui::Div> {
    v_flex()
        .id("pattern-b-tabs-zone")
        .size_full()
        .min_h_0()
        .child(tab_strip)
        .child(
            div()
                .id("pattern-b-tab-content")
                .flex_1()
                .min_h_0()
                .w_full()
                .overflow_hidden()
                .child(content),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 契约：比例区间落在规格 40~50%、默认值居中、分割条 / Tab 条度量齐备
    #[test]
    fn dense_metrics_contract() {
        assert_eq!(DEFAULT_CHART_RATIO, 0.45);
        assert_eq!(MIN_CHART_RATIO, 0.40, "图表区占比规格下限 40%");
        assert_eq!(MAX_CHART_RATIO, 0.50, "图表区占比规格上限 50%");
        assert!(
            (MIN_CHART_RATIO..=MAX_CHART_RATIO).contains(&DEFAULT_CHART_RATIO),
            "默认占比必须落在规格区间内"
        );
        assert_eq!(TAB_BAR_HEIGHT, 32.0, "子 Tab 条 32px");
        assert_eq!(SPLIT_HANDLE_HIT, 6.0, "分割条命中区 6px");
    }

    #[test]
    fn chart_ratio_for_maps_pointer_and_clamps() {
        // 壳顶 y=200、总高 800：指针在 560 → 占比 45%
        assert!((chart_ratio_for(200.0, 800.0, 560.0) - 0.45).abs() < 1e-6);
        // 上边界 clamp 到 0.40
        assert!((chart_ratio_for(200.0, 800.0, 380.0) - MIN_CHART_RATIO).abs() < 1e-6);
        assert!((chart_ratio_for(200.0, 800.0, 100.0) - MIN_CHART_RATIO).abs() < 1e-6);
        // 下边界 clamp 到 0.50
        assert!((chart_ratio_for(200.0, 800.0, 700.0) - MAX_CHART_RATIO).abs() < 1e-6);
        // 非法容器高 → 默认值（防御除零）
        assert!((chart_ratio_for(0.0, 0.0, 500.0) - DEFAULT_CHART_RATIO).abs() < 1e-6);
    }

    #[test]
    fn per_mille_roundtrip_is_lossless_within_bounds() {
        for per_mille in [400u16, 420, 450, 480, 500] {
            let ratio = ratio_from_per_mille(Some(per_mille));
            assert!((ratio - per_mille as f32 / 1000.0).abs() < 1e-6);
            assert_eq!(ratio_to_per_mille(ratio), per_mille);
        }
        // None / 越界 → 默认
        assert!((ratio_from_per_mille(None) - DEFAULT_CHART_RATIO).abs() < 1e-6);
        assert!((ratio_from_per_mille(Some(300)) - DEFAULT_CHART_RATIO).abs() < 1e-6);
        assert!((ratio_from_per_mille(Some(900)) - DEFAULT_CHART_RATIO).abs() < 1e-6);
        // 编码收敛进区间
        assert_eq!(ratio_to_per_mille(0.10), 400);
        assert_eq!(ratio_to_per_mille(0.90), 500);
    }

    #[test]
    fn tab_items_carry_key_and_label() {
        let item = TabItem::new("campaigns", "活动");
        assert_eq!(item.key, "campaigns");
        assert_eq!(item.label, "活动");
    }

    // ---------- 渲染冒烟 ----------

    struct ShellHost {
        ratio: f32,
    }

    impl gpui::Render for ShellHost {
        fn render(&mut self, _window: &mut gpui::Window, cx: &mut Context<Self>) -> impl IntoElement {
            let theme = AppTheme::current(cx);
            let view = cx.entity();
            let divider = split_divider(&theme, "host-split");
            let strip = tab_bar(
                &view,
                &theme,
                "host",
                &[TabItem::new("a", "甲"), TabItem::new("b", "乙")],
                0,
                |_, _, _| {},
            );
            pattern_b_shell(
                &theme,
                "host-canvas",
                div().child("header"),
                div().child("toolbar"),
                self.ratio,
                div().child("charts"),
                divider,
                tabs_zone(strip, div().child("content")),
            )
        }
    }

    #[gpui::test]
    async fn shell_renders_in_dark_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        cx.add_window_view(|_window, _cx| ShellHost {
            ratio: DEFAULT_CHART_RATIO,
        });
    }

    #[gpui::test]
    async fn shell_renders_with_extreme_ratios(cx: &mut gpui::TestAppContext) {
        // 比例越界也要能渲染（壳内 clamp 兜底）
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        cx.add_window_view(|_window, _cx| ShellHost { ratio: 0.9 });
    }
}
