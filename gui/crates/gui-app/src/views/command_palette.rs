//! ⌘K 全局命令面板（BLF-794，父 issue「空间栅格」Sub-Nav 节）
//!
//! 检索 [`gui_domain::sidebar`] 全部 52 个子模块（分类名 / 标题 / url 关键词，
//! 大小写不敏感；url 片段天然覆盖英文关键词如 `ad-analysis`），回车跳转对应视图，
//! Esc / 失焦关闭，↑↓ 键盘上下选择。
//!
//! 键盘链路（gpui-component Input 的 Input 上下文会静默消费单行 ↑↓ 动作）：
//! - **↑/↓**：全局绑定 `up`/`down` → [`PaletteSelectPrev`]/[`PaletteSelectNext`]
//!   （无 key context、在 `gpui_component::init` **之后**注册——同深度时后注册者
//!   优先，故能抢在 Input 的 MoveUp/MoveDown 之前）。面板未打开时本视图不在
//!   渲染树上、无监听器命中 → 按键继续传播到原绑定，其余输入框不受影响。
//! - **Enter**：订阅 `InputEvent::PressEnter`。
//! - **Esc**：Input 对 escape 默认 `propagate()`，冒泡到本容器 raw key 监听。
//! - **失焦**：订阅 `InputEvent::Blur` 自动关闭。

use gpui::{
    div, prelude::*, px, Context, Entity, EventEmitter, FocusHandle, Focusable, KeyDownEvent,
    SharedString, Window,
};
use gpui_component::input::{Input, InputEvent, InputState};

use gui_domain::sidebar::{sidebar_groups, SidebarGroup};

use crate::icon::icon_path;
use crate::theme::AppTheme;
use crate::theme::{FONT_2XS, FONT_BASE, FONT_XS};

/// 面板宽度
const PALETTE_WIDTH: f32 = 560.0;
/// 结果区最大高度
const RESULTS_MAX_HEIGHT: f32 = 384.0;

/// 命令面板事件
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandPaletteEvent {
    /// 用户确认某个检索结果（RootView 订阅后驱动 Sub-Nav/视图分发并关闭面板）
    Navigate { url: String, title: String },
    /// 面板请求关闭（Esc / 失焦 / 背景点击）
    Dismissed,
}

/// 检索条目（gui-domain 权威清单的展平视图）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaletteEntry {
    pub group_label: String,
    pub title: String,
    pub url: String,
    pub icon: String,
}

/// 展平全部分组为检索条目（顺序 = sidebar 权威顺序）
pub(crate) fn flatten_entries(groups: &[SidebarGroup]) -> Vec<PaletteEntry> {
    groups
        .iter()
        .flat_map(|g| {
            g.items.iter().map(move |it| PaletteEntry {
                group_label: g.label.clone(),
                title: it.title.clone(),
                url: it.url.clone(),
                icon: it.icon.clone(),
            })
        })
        .collect()
}

/// 关键词过滤（纯函数）：大小写不敏感子串匹配 标题 / 分类名 / url；
/// 空查询返回全部索引。命中标题者优先于仅命中分类/url 的项。
pub(crate) fn filter_entries(entries: &[PaletteEntry], query: &str) -> Vec<usize> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return (0..entries.len()).collect();
    }
    let mut by_title = Vec::new();
    let mut by_other = Vec::new();
    for (i, e) in entries.iter().enumerate() {
        if e.title.to_lowercase().contains(&q) {
            by_title.push(i);
        } else if e.group_label.to_lowercase().contains(&q) || e.url.to_lowercase().contains(&q) {
            by_other.push(i);
        }
    }
    by_title.extend(by_other);
    by_title
}

/// ⌘K 命令面板视图（由 RootView 持有，打开时才挂入渲染树）
pub struct CommandPaletteView {
    entries: Vec<PaletteEntry>,
    /// 当前过滤后的可见条目（entries 索引）
    filtered: Vec<usize>,
    /// 键盘选中游标（filtered 索引）
    cursor: usize,
    input: Option<Entity<InputState>>,
    input_sub: Option<gpui::Subscription>,
    focus_handle: FocusHandle,
}

impl CommandPaletteView {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let entries = flatten_entries(&sidebar_groups());
        let all = (0..entries.len()).collect();
        Self {
            entries,
            filtered: all,
            cursor: 0,
            input: None,
            input_sub: None,
            focus_handle: cx.focus_handle(),
        }
    }

    /// 惰性创建检索输入框 + 订阅（需要 `&mut Window`；打开面板时调用一次），
    /// 创建后立即聚焦以承接输入法。
    pub(crate) fn ensure_input_focused(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.input.is_none() {
            let input = cx.new(|cx| InputState::new(window, cx).placeholder("搜索模块…"));
            let sub = cx.subscribe(&input, |this, _e, event: &InputEvent, cx| match event {
                InputEvent::PressEnter { .. } => this.confirm(cx),
                InputEvent::Change => {
                    this.refilter(cx);
                }
                InputEvent::Blur => this.dismiss(cx),
                _ => {}
            });
            self.input = Some(input);
            self.input_sub = Some(sub);
        }
        // 重开时清空旧查询并把焦点交给输入框
        let input = self.input.as_ref().expect("input 已创建");
        input.update(cx, |state, cx| {
            state.set_value("", window, cx);
            state.focus(window, cx);
        });
        self.cursor = 0;
        self.refilter(cx);
        cx.notify();
    }

    /// 按当前输入框内容重算过滤集合并夹紧游标。
    fn refilter(&mut self, cx: &mut Context<Self>) {
        let query = self
            .input
            .as_ref()
            .map(|input| input.read(cx).value().to_string())
            .unwrap_or_default();
        self.filtered = filter_entries(&self.entries, &query);
        if self.cursor >= self.filtered.len() {
            self.cursor = self.filtered.len().saturating_sub(1);
        }
        cx.notify();
    }

    /// ↑/↓ 移动选中游标（由全局动作驱动，见 main.rs 绑定说明）。
    pub(crate) fn move_cursor(&mut self, delta: isize, cx: &mut Context<Self>) {
        let len = self.filtered.len();
        if len == 0 {
            return;
        }
        let next = (self.cursor as isize + delta).rem_euclid(len as isize) as usize;
        self.cursor = next;
        cx.notify();
    }

    /// 回车确认：对可见游标项 emit [`CommandPaletteEvent::Navigate`]；
    /// 无可见项时空操作。关闭由 RootView 在处理事件后统一执行。
    pub(crate) fn confirm(&mut self, cx: &mut Context<Self>) {
        let Some(idx) = self.filtered.get(self.cursor).copied() else {
            return;
        };
        let entry = self.entries[idx].clone();
        cx.emit(CommandPaletteEvent::Navigate {
            url: entry.url,
            title: entry.title,
        });
    }

    /// 关闭面板（Esc / 失焦 / 背景点击共用；RootView 收到事件后摘除本视图）。
    pub(crate) fn dismiss(&mut self, cx: &mut Context<Self>) {
        cx.emit(CommandPaletteEvent::Dismissed);
    }

    fn visible(&self) -> impl Iterator<Item = (usize, usize, &PaletteEntry)> {
        self.filtered
            .iter()
            .enumerate()
            .map(|(pos, idx)| (pos, *idx, &self.entries[*idx]))
    }
}

impl EventEmitter<CommandPaletteEvent> for CommandPaletteView {}

impl Focusable for CommandPaletteView {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl gpui::Render for CommandPaletteView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let radius_lg = theme.radius_lg;
        let cursor = self.cursor;
        let has_results = !self.filtered.is_empty();

        // 输入行：惰性创建的 Input（首帧渲染时已由 open 流程创建，此处兜底）
        let input_row = match &self.input {
            Some(input) => div()
                .id("palette-input-row")
                .flex_none()
                .w_full()
                .child(
                    Input::new(input)
                        .w_full()
                        .h(px(40.0))
                        .prefix(
                            gpui::svg()
                                .path("icons/search.svg")
                                .size(px(14.0))
                                .text_color(theme.text_muted),
                        )
                        .cleanable(true),
                )
                .into_any_element(),
            None => div()
                .id("palette-input-placeholder")
                .flex_none()
                .h(px(40.0))
                .into_any_element(),
        };

        // 结果列表
        let rows: Vec<gpui::AnyElement> = self
            .visible()
            .map(|(pos, _, entry)| {
                let active = pos == cursor;
                let theme_bg = theme.sidebar_item_hover;
                div()
                    .id(SharedString::from(format!("palette-row-{}", entry.url)))
                    .flex()
                    .items_center()
                    .gap_2()
                    .w_full()
                    .h(px(34.0))
                    .px_3()
                    .cursor_pointer()
                    .when(active, |row| row.bg(theme_bg))
                    .hover(|style| style.bg(theme.sidebar_item_hover))
                    .on_click(cx.listener(move |this, _, _, cx| this.confirm_at(pos, cx)))
                    .child(
                        gpui::svg()
                            .path(icon_path(&entry.icon))
                            .size(px(15.0))
                            .text_color(if active {
                                theme.accent
                            } else {
                                theme.text_secondary
                            }),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_size(px(FONT_BASE))
                            .text_color(if active {
                                theme.text_primary
                            } else {
                                theme.text_secondary
                            })
                            .child(SharedString::from(entry.title.clone())),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .text_size(px(FONT_XS))
                            .text_color(theme.text_muted)
                            .child(SharedString::from(entry.group_label.clone())),
                    )
                    .into_any_element()
            })
            .collect();

        let results: gpui::AnyElement = if has_results {
            div()
                .id("palette-results")
                .flex()
                .flex_col()
                .w_full()
                .max_h(px(RESULTS_MAX_HEIGHT))
                .overflow_y_scroll()
                .py_1()
                .children(rows)
                .into_any_element()
        } else {
            div()
                .id("palette-results-empty")
                .child(
                    div()
                        .px_3()
                        .py_2()
                        .text_size(px(FONT_BASE))
                        .text_color(theme.text_muted)
                        .child("无匹配模块"),
                )
                .into_any_element()
        };

        // 面板本体（Spotlight 式顶部居中浮层；高密度主题无重投影，1px 边界分层）
        let panel = div()
            .id("command-palette-panel")
            .relative()
            .flex()
            .flex_col()
            .w(px(PALETTE_WIDTH))
            .rounded(px(radius_lg))
            .bg(theme.card_bg)
            .border_1()
            .border_color(theme.separator)
            .overflow_hidden()
            // 面板内点击不触发遮罩关闭（阻断冒泡）
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(input_row)
            .child(
                div()
                    .flex_none()
                    .w_full()
                    .border_t_1()
                    .border_color(theme.separator),
            )
            .child(results)
            .child(
                div()
                    .id("palette-hint")
                    .flex()
                    .items_center()
                    .gap_3()
                    .w_full()
                    .h(px(28.0))
                    .px_3()
                    .border_t_1()
                    .border_color(theme.separator)
                    .text_size(px(FONT_2XS))
                    .text_color(theme.text_muted)
                    .child("↑↓ 选择 · ↵ 打开 · Esc 关闭"),
            );

        // overlay：背景遮罩（点击关闭）+ 顶部居中面板 + Esc 监听
        div()
            .id("command-palette-overlay")
            .absolute()
            .inset_0()
            .flex()
            .items_start()
            .justify_center()
            .pt(px(72.0))
            .bg(gpui::black().opacity(0.45))
            .on_mouse_down(
                gpui::MouseButton::Left,
                cx.listener(|this, _, _, cx| this.dismiss(cx)),
            )
            .child(panel)
            .focusable()
            .track_focus(&self.focus_handle.clone())
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    this.dismiss(cx);
                }
            }))
    }
}

impl CommandPaletteView {
    /// 点击结果行确认第 pos 个可见项。
    fn confirm_at(&mut self, pos: usize, cx: &mut Context<Self>) {
        if pos < self.filtered.len() {
            self.cursor = pos;
            self.confirm(cx);
        }
    }
}
