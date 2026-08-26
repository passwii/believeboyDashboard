//! Pattern C「分屏交互工作台」标准模板（BLF-800，Stage9）
//!
//! 父 issue「视图模板」Pattern C 规格的可复用实现，供 AI Chat（原型）/
//! 客服交流 / 数字员工详情对话等一切「三栏流式会话」页套版。结构（自左向右）：
//!
//! - **左会话列表** [`SESSION_PANE_WIDTH`]（240px）：会话条目（标题 / 时间 /
//!   未读态）+ 新建 / 删除 / 置顶；排序纯函数 [`sort_pinned_first`]、时间格式化
//!   [`format_session_time`]、未读判定 [`is_unread`]、未读点 [`unread_dot`]；
//! - **中流式对话区**（flex-1）：消息气泡流 + 输入区，由宿主注入；助手消息
//!   markdown 渲染走 [`markdown_body`]（`TextView::markdown` 封装，内容变更
//!   自动重解析）；长回复滚动跟随由 [`FollowScroll`] 承载——贴底则持续跟随，
//!   用户上翻自动暂停、回底（或点回到底部按钮）自动恢复；
//! - **右上下文栏** [`CONTEXT_PANE_WIDTH`]（300px）：会话关联信息卡
//!   （[`context_card`] 骨架），可整体收起（收起态由宿主持有并经事件链持久化）。
//!
//! ## 三区自定义渲染器注入契约（通用化保证）
//!
//! [`pattern_c_shell`] 只负责分区尺寸与 chrome（1px 分隔线 / 面板底），三个
//! 区域的**内容全部由宿主以元素形式注入**，模板不绑定任何业务类型：
//!
//! 1. **左区（会话列表渲染器）**：宿主自建列表列（[`crate::widgets::state_views`]
//!    空态可选）。AI Chat 用「条目 = 置顶星标 + 标题 + 未读点 + 时间 + 删除钮」；
//!    客服场景可替换为「客户名 + 最近摘要」，数字员工可替换为「任务队列」。置顶 /
//!    排序 / 未读判定直接复用本模块纯函数，避免各页口径漂移。
//! 2. **中区（消息流渲染器 + 输入区渲染器）**：宿主自建消息气泡流与底部输入框。
//!    模板提供两件基础设施：[`markdown_body`]（助手消息 markdown 渲染；用户消息
//!    保持纯文本右对齐由宿主决定）与 [`FollowScroll`]（滚动跟随控制器，挂
//!    `.track_scroll(handle)` 后按 [`FollowScroll::is_pinned`] 推导是否贴底）。
//!    流式喂入纪律见下方「已知坑」。
//! 3. **右区（上下文卡渲染器）**：宿主自建卡片组，骨架用 [`context_card`] +
//!    [`context_stat_row`]（label 左 / mono 数值右）。AI Chat 放模型参数卡 +
//!    会话统计卡；客服放客户卡 / Listing SKU 卡——正是本契约预留的两个插槽。
//!
//! ## 接入方式（三栏会话页套版清单）
//!
//! 1. 宿主持有：会话列表数据、当前选中 id、未读基线（GUI 本地）、右栏收起态、
//!    [`FollowScroll`]；置顶 id 列表与收起态属 UI 偏好——视图 emit 事件交组合根
//!    持久化（视图层不碰文件系统，延续 BLF-794~799 纪律）。
//! 2. 渲染：`pattern_c_shell(theme, id, 左区, 中区, 右栏可见, 右区)` 组装页面壳，
//!    收起态传 `context_visible=false` 即整体折叠右栏。
//! 3. 流式增量：文本 delta 先累积到宿主数据，再按固定节拍（AI Chat 为 250ms）
//!    同步到「显示快照」并 notify——见已知坑第 3 条。
//!
//! ```ignore
//! // AI Chat 原型即此形态（views/ai_chat.rs）：
//! pattern_c_shell(
//!     &theme,
//!     "ai-chat",
//!     self.render_session_list(&theme, cx),          // 左：240px 会话列
//!     self.render_center(window, cx),                // 中：消息流 + 输入区
//!     !self.context_collapsed,                       // 右栏可见性
//!     self.render_context_cards(&theme),             // 右：上下文卡组
//! )
//! ```
//!
//! ## 已知坑（接入必读）
//!
//! 1. `InputEvent::Change` 是 unit variant（gpui-component 0.5.x），匹配时不带
//!    载荷；取值走 `InputState::value()`。
//! 2. `cx.spawn` 闭包内一律 `this.update(cx, …).ok()` 容忍窗口关闭（返回
//!    `Result`，实体已释放时静默退出）。
//! 3. `TextView::markdown` 内容更新是「距最后一次变更 200ms」防抖重解析：
//!    逐 token 直接喂入会让 timer 一直重置、流式期间画面冻结。必须节流快照
//!    喂入（快照间隔 > 200ms），done 后再同步一次精确终稿。

use chrono::{DateTime, Local};
use gpui::{
    div, prelude::*, px, App, FontWeight, IntoElement, ParentElement, ScrollHandle, SharedString,
    Styled, Window,
};
use gpui_component::{h_flex, text::TextView, v_flex};

use crate::theme::{AppTheme, FONT_BASE, FONT_XS};
use crate::widgets::data_table::TabularNumsExt;

// ---------------------------------------------------------------------------
// 规格（父 issue Pattern C：左 240px / 中 flex-1 / 右 300px 可收起）
// ---------------------------------------------------------------------------

/// 左会话列表宽度（px）
pub const SESSION_PANE_WIDTH: f32 = 240.0;
/// 右上下文栏宽度（px）
pub const CONTEXT_PANE_WIDTH: f32 = 300.0;
/// 面板头高度（px；Console Bar / 工具栏同一密度带）
pub const PANE_HEADER_HEIGHT: f32 = 36.0;
/// 未读点直径（px）
pub const UNREAD_DOT_SIZE: f32 = 6.0;
/// 距底容差（px；滚动偏移落在该范围内视为「贴底」）
pub const AT_BOTTOM_EPSILON_PX: f32 = 24.0;

// ---------------------------------------------------------------------------
// 滚动跟随（中区长回复流式的贴底推导）
// ---------------------------------------------------------------------------

/// 距底判定（纯函数可测）。gpui 滚动偏移向下为负：offset.y ∈ [-max, 0]，
/// 距底距离 = offset.y + max；max ≤ 0（内容不足一屏）恒为贴底。
pub fn at_bottom(offset_y: f32, max_offset_y: f32) -> bool {
    if max_offset_y <= 0.0 {
        return true;
    }
    (offset_y + max_offset_y).max(0.0) <= AT_BOTTOM_EPSILON_PX
}

/// 中区消息流滚动跟随控制器：几何推导式，无独立暂停位。
///
/// 语义（满足验收「滚动跟随可暂停」）：每帧渲染前读上一帧几何
/// [`Self::is_pinned`]——贴底则 [`Self::stick`] 继续跟随新内容；用户上翻后
/// 几何自然离开底部 → 不再 stick（暂停）；滚回底部或点宿主的「回到底部」钮
/// （内部调 [`Self::stick`]）即恢复。切换会话时宿主调 [`Self::stick`] 让首帧
/// 直落最新消息。
pub struct FollowScroll {
    handle: ScrollHandle,
}

impl FollowScroll {
    pub fn new() -> Self {
        Self {
            handle: ScrollHandle::new(),
        }
    }

    /// 挂 `.track_scroll(...)` 用
    pub fn handle(&self) -> &ScrollHandle {
        &self.handle
    }

    /// 上一帧是否贴在底部（内容不足一屏视为贴底）
    pub fn is_pinned(&self) -> bool {
        let max = self.handle.max_offset();
        at_bottom(self.handle.offset().y.into(), max.height.into())
    }

    /// 请求下一帧贴底（`scroll_to_bottom` 在 paint 阶段消费）
    pub fn stick(&self) {
        self.handle.scroll_to_bottom();
    }
}

impl Default for FollowScroll {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// 页面壳
// ---------------------------------------------------------------------------

/// Pattern C 页面骨架：左会话列（240px）+ 中对话区（flex-1）+ 右上下文栏
/// （300px，`context_visible=false` 时整体折叠）。
///
/// 容器外 padding 0、区间 1px 分隔线；三区内容由宿主注入（注入契约见模块级
/// doc-comment），壳只负责分区尺寸与 chrome。
pub fn pattern_c_shell(
    theme: &AppTheme,
    id: &'static str,
    sessions: impl IntoElement,
    conversation: impl IntoElement,
    context_visible: bool,
    context: impl IntoElement,
) -> gpui::Stateful<gpui::Div> {
    h_flex()
        .id(id)
        .size_full()
        .min_w_0()
        .bg(theme.window_bg)
        .child(
            div()
                .id(SharedString::from(format!("{id}-sessions")))
                .w(px(SESSION_PANE_WIDTH))
                .h_full()
                .flex_none()
                .min_h_0()
                .border_r_1()
                .border_color(theme.separator)
                .bg(theme.card_bg)
                .overflow_hidden()
                .child(sessions),
        )
        .child(
            div()
                .id(SharedString::from(format!("{id}-conversation")))
                .flex_1()
                .min_w_0()
                .h_full()
                .overflow_hidden()
                .child(conversation),
        )
        .when(context_visible, |this| {
            this.child(
                div()
                    .id(SharedString::from(format!("{id}-context")))
                    .w(px(CONTEXT_PANE_WIDTH))
                    .h_full()
                    .flex_none()
                    .min_h_0()
                    .border_l_1()
                    .border_color(theme.separator)
                    .bg(theme.card_bg)
                    .overflow_hidden()
                    .child(context),
            )
        })
}

/// 面板头基座（36px 密度带）：宿主自行 push 标题与动作按钮 children。
pub fn pane_header_base(theme: &AppTheme, id: &'static str) -> gpui::Stateful<gpui::Div> {
    h_flex()
        .id(id)
        .w_full()
        .flex_none()
        .h(px(PANE_HEADER_HEIGHT))
        .min_h_0()
        .items_center()
        .justify_between()
        .px_2()
        .gap_1()
        .border_b_1()
        .border_color(theme.separator)
        .bg(theme.panel_bg)
}

// ---------------------------------------------------------------------------
// 右区上下文卡小件
// ---------------------------------------------------------------------------

/// 上下文卡骨架：标题行 + 内容列（宿主继续 `.child(...)` 追加内容行）。
pub fn context_card(theme: &AppTheme, id: &'static str, title: &'static str) -> gpui::Stateful<gpui::Div> {
    v_flex()
        .id(id)
        .w_full()
        .rounded_md()
        .border_1()
        .border_color(theme.separator)
        .bg(theme.window_bg)
        .gap_1p5()
        .child(
            div()
                .px_2()
                .pt_1p5().text_size(px(crate::theme::fs(FONT_XS)))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_muted)
                .child(title),
        )
}

/// 上下文卡内容行：label 左（辅助色）/ 数值右（mono 等宽，数字对齐）。
pub fn context_stat_row(
    theme: &AppTheme,
    label: &'static str,
    value: impl Into<SharedString>,
) -> gpui::Stateful<gpui::Div> {
    h_flex()
        .id(SharedString::from(format!("pc-row-{label}")))
        .w_full()
        .items_center()
        .justify_between()
        .gap_2()
        .px_2().text_size(px(crate::theme::fs(FONT_BASE)))
        .child(
            div().text_size(px(crate::theme::fs(FONT_XS)))
                .text_color(theme.text_muted)
                .child(label),
        )
        .child(
            div()
                .min_w_0()
                .truncate()
                .mono_tabular_nums().text_size(px(crate::theme::fs(FONT_XS)))
                .text_color(theme.text_secondary)
                .child(value.into()),
        )
}

// ---------------------------------------------------------------------------
// 左区会话条目小件
// ---------------------------------------------------------------------------

/// 未读点（accent 圆点）
pub fn unread_dot(theme: &AppTheme) -> gpui::Div {
    div()
        .size(px(UNREAD_DOT_SIZE))
        .flex_none()
        .rounded_full()
        .bg(theme.accent)
}

/// 置顶优先排序（稳定：同组内保持原有相对顺序——服务端已按 updated_at 倒序）。
pub fn sort_pinned_first<T>(items: &mut [T], is_pinned: impl Fn(&T) -> bool) {
    items.sort_by_key(|item| !is_pinned(item));
}

/// 会话时间显示（本地时区 `MM-dd HH:mm`；解析失败返回空串，调用方隐藏该行）
pub fn format_session_time(iso: &str) -> String {
    DateTime::parse_from_rfc3339(iso)
        .map(|dt| dt.with_timezone(&Local).format("%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

/// 未读判定（纯函数）：活动会话不显示；有已读基线则比较 updated_at；
/// 无基线（从未打开过且非首屏基线）视为未读。
pub fn is_unread(updated_at: &str, read_mark: Option<&str>, is_active: bool) -> bool {
    if is_active {
        return false;
    }
    match read_mark {
        Some(mark) => updated_at > mark,
        None => true,
    }
}

// ---------------------------------------------------------------------------
// 中区 markdown 渲染
// ---------------------------------------------------------------------------

/// 助手消息 markdown 正文（`TextView::markdown` 封装；内容变更自动重解析，
/// 可选中复制）。id 必须按「会话 × 消息」稳定唯一——keyed state 跨帧复用，
/// 复用错 id 会短暂串出别的消息内容。流式喂入纪律见模块 doc-comment 已知坑 3。
pub fn markdown_body(
    id: impl Into<gpui::ElementId>,
    markdown: impl Into<SharedString>,
    window: &mut Window,
    cx: &mut App,
) -> TextView {
    TextView::markdown(id, markdown, window, cx).selectable(true)
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 契约：三栏规格与密度带常量对齐父 issue Pattern C 条目
    #[test]
    fn dense_metrics_contract() {
        assert_eq!(SESSION_PANE_WIDTH, 240.0, "左会话列表规格 240px");
        assert_eq!(CONTEXT_PANE_WIDTH, 300.0, "右上下文栏规格 300px");
        assert_eq!(PANE_HEADER_HEIGHT, 36.0, "面板头 36px 密度带");
        assert_eq!(AT_BOTTOM_EPSILON_PX, 24.0);
    }

    #[test]
    fn at_bottom_truth_table() {
        // 未滚动 / 内容不足一屏 → 贴底
        assert!(at_bottom(0.0, 0.0));
        assert!(at_bottom(-0.0, -1.0)); // 防御：负 max 视作不足一屏
        // 恰在底部（offset == -max）
        assert!(at_bottom(-800.0, 800.0));
        // 落入容差带仍算贴底
        assert!(at_bottom(-785.0, 800.0));
        // 明显离开底部 → 非贴底
        assert!(!at_bottom(-700.0, 800.0));
        // max=50：距底 = offset + 50；-20 → 距底 30 > 24 非贴底
        assert!(!at_bottom(-20.0, 50.0));
        // 越界 offset（gpui 实际会 clamp，防御性视作贴底）
        assert!(at_bottom(-100.0, 50.0));
    }

    struct Row {
        id: i64,
        pinned: bool,
    }

    #[test]
    fn sort_pinned_first_is_stable_within_groups() {
        let mut rows = vec![
            Row { id: 1, pinned: false },
            Row { id: 2, pinned: true },
            Row { id: 3, pinned: false },
            Row { id: 4, pinned: true },
        ];
        sort_pinned_first(&mut rows, |r| r.pinned);
        let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
        assert_eq!(ids, vec![2, 4, 1, 3], "置顶组在前且组内保序");
    }

    #[test]
    fn session_time_formats_local_and_tolerates_garbage() {
        // UTC 输入 → 本地展示（断言格式而非具体时区值）
        let formatted = format_session_time("2026-08-21T00:00:00+00:00");
        assert_eq!(formatted.len(), 11, "MM-dd HH:mm 共 11 字符：{formatted}");
        assert_eq!(formatted.as_bytes()[2], b'-');
        assert_eq!(formatted.as_bytes()[5], b' ');
        assert_eq!(formatted.as_bytes()[8], b':');
        // 非 ISO 输入 → 空串（调用方隐藏时间行）
        assert_eq!(format_session_time("not-a-date"), "");
        assert_eq!(format_session_time(""), "");
    }

    #[test]
    fn unread_matrix() {
        // 活动会话永不未读
        assert!(!is_unread("2026-08-22T00:00:00+00:00", None, true));
        assert!(!is_unread("2026-08-22T00:00:00+00:00", Some("2026-08-20T00:00:00+00:00"), true));
        // 无基线 → 未读
        assert!(is_unread("2026-08-22T00:00:00+00:00", None, false));
        // updated_at 晚于基线 → 未读；早于等于 → 已读
        assert!(is_unread("2026-08-22T10:00:00+00:00", Some("2026-08-22T09:00:00+00:00"), false));
        assert!(!is_unread("2026-08-22T09:00:00+00:00", Some("2026-08-22T10:00:00+00:00"), false));
        assert!(!is_unread("t", Some("t"), false));
    }

    // ---------- 渲染冒烟 ----------

    struct ShellHost {
        context_collapsed: bool,
    }

    impl gpui::Render for ShellHost {
        fn render(&mut self, _window: &mut gpui::Window, cx: &mut Context<Self>) -> impl IntoElement {
            let theme = AppTheme::current(cx);
            let sessions = v_flex().child(pane_header_base(&theme, "host-sessions-header"));
            let conversation = div().child("center");
            let context = v_flex()
                .child(pane_header_base(&theme, "host-context-header"))
                .child(
                    context_card(&theme, "host-card", "模型参数").child(context_stat_row(
                        &theme,
                        "模型",
                        "believeboy-flash",
                    )),
                );
            pattern_c_shell(
                &theme,
                "host-canvas",
                sessions,
                conversation,
                !self.context_collapsed,
                context,
            )
        }
    }

    #[gpui::test]
    async fn shell_renders_dark_expanded_and_collapsed(cx: &mut gpui::TestAppContext) {
        for collapsed in [false, true] {
            cx.update(|cx| {
                gpui_component::init(cx);
                crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
            });
            cx.add_window_view(|_window, _cx| ShellHost {
                context_collapsed: collapsed,
            });
        }
    }

    #[test]
    fn follow_scroll_defaults_to_pinned() {
        let follow = FollowScroll::new();
        // 无布局信息（max=0）→ 视为贴底，首帧即跟随
        assert!(follow.is_pinned());
    }
}
