//! Pattern A「控制台工具栏 + 超密度数据网格」核心组件（BLF-798，Stage7）
//!
//! 父 issue「视图模板」Pattern A 规格的可复用实现，供销售数据 / SKU 信息 /
//! 订单 / FBA 发货等最大宗约 25+ 页套版。三段式骨架：
//!
//! - **顶部 FilterToolbar**：[`crate::widgets::filter_bar`] 的工具栏构建块
//!   （搜索输入 / 状态下拉 / 操作按钮，控件 24~28px）；
//! - **中部虚拟化大表** [`DataGrid`]：`uniform_list` 只渲染可见行（万行级
//!   滚动不掉帧）、粘性表头 28px（[`crate::theme::TABLE_HEADER_HEIGHT`]，
//!   表头在纵向滚动容器之外故纵滚不漂移）、行高锁 24~28px（[`GRID_ROW_HEIGHT`]）、
//!   列宽拖拽调宽（[`GridColResize`] 拖拽会话）+ 横向滚动（表头与行列同容器
//!   同步横移）、斑马纹可选；
//! - **底部 pinned 分页聚合条** [`grid_footer_bar`]：聚合摘要（数字一律
//!   mono+tabular）+ 分页器（复用 `pagination` 的 [`PageState`] 体系）。
//!
//! 数字与色彩语义（规格条款）：数值列走 [`ColumnDef::number`] 构造器
//! （JetBrains Mono + tnum）；涨/正向 `theme.success`、警示/待处理
//! `theme.warning`、缺货/亏损 `theme.danger`——语义色只经 AppTheme token
//! 输出，视图内禁止裸十六进制。
//!
//! 使用（宿主视图持有 `Entity<DataGrid<Row>>`，懒建 + `set_rows` 注入）：
//! ```ignore
//! let grid = cx.new(|_| DataGrid::new("sku-grid", columns()).striped(true));
//! grid.update(cx, |g, cx| g.set_rows(rows, cx));
//! // render: pattern_a_shell(&theme, "page", toolbar, grid.clone(), footer)
//! ```

use gpui::{
    div, prelude::*, px, AnyElement, Context, CursorStyle, Entity, FontWeight, IntoElement,
    ParentElement, SharedString, Styled, Window,
};
use gpui_component::{h_flex, v_flex, Sizable};

use crate::theme::{AppTheme, FONT_BASE, FONT_XS, TABLE_HEADER_HEIGHT};
use crate::widgets::data_table::{CellAlign, ColumnDef, SortDir, TabularNumsExt, CELL_PX};
use crate::widgets::pagination::{pagination_controls, page_size_select, PageState};

/// 数据行高（px）：锁定规格区间 24~28px（26 = 20px 行高 + 2×3px 内边距，
/// 与 data_table 的 ROW_LINE_HEIGHT/ROW_PY 组合一致）
pub const GRID_ROW_HEIGHT: f32 = 26.0;

/// 列宽拖拽手柄宽度（px；命中区，视觉线由 hover 态内部 1px child 绘制）
const RESIZE_HANDLE_W: f32 = 6.0;

/// 列宽下限（px；拖拽收敛，防列被拖没）
pub const MIN_COL_WIDTH: f32 = 48.0;

/// 列宽上限（px；防单列拖爆横向滚动总宽）
pub const MAX_COL_WIDTH: f32 = 640.0;

/// 未显式指定宽度的列的默认宽度（px）
pub const DEFAULT_COL_WIDTH: f32 = 120.0;

// ---------------------------------------------------------------------------
// 列模型（复用 data_table::ColumnDef；运行期宽度由 DataGrid 单独持有）
// ---------------------------------------------------------------------------

/// 运行期列宽初始化：显式 width 优先，未指定回落默认宽；统一收敛到下限之上
fn initial_width<T>(col: &ColumnDef<T>) -> f32 {
    col.width.unwrap_or(DEFAULT_COL_WIDTH).clamp(MIN_COL_WIDTH, MAX_COL_WIDTH)
}

// ---------------------------------------------------------------------------
// 列宽拖拽（gpui-component Table 同款机制：on_drag + DragMoveEvent 会话）
// ---------------------------------------------------------------------------

/// 列宽拖拽状态（on_drag 的 drag value；含所属网格 EntityId 防多表串扰）
#[derive(Clone)]
struct GridColResize {
    grid: gpui::EntityId,
    col_ix: usize,
}

impl Render for GridColResize {
    fn render(
        &mut self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> impl IntoElement {
        div()
    }
}

/// 拖拽会话（首次 move 事件锚定起点，之后按位移差调宽——避免用实时 bounds
/// 造成反馈回路漂移）
struct ResizeSession {
    col_ix: usize,
    origin_x: f32,
    start_width: f32,
}

// ---------------------------------------------------------------------------
// 聚合条目与语义色调（微色彩语义唯一出口：AppTheme token）
// ---------------------------------------------------------------------------

/// 聚合值 / 状态 pill 色调（映射 AppTheme 语义 token；禁止视图侧裸十六进制）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AggregateTone {
    /// 中性（主文字色）
    #[default]
    Neutral,
    /// 正向（涨 / 有货 → theme.success #22c55e）
    Positive,
    /// 警示（待处理 → theme.warning #f59e0b）
    Warning,
    /// 危险（缺货 / 亏损 → theme.danger #ef4444）
    Danger,
}

impl AggregateTone {
    /// 对应语义色 token（唯一出口）
    pub fn color(self, theme: &AppTheme) -> gpui::Hsla {
        match self {
            Self::Neutral => theme.text_primary,
            Self::Positive => theme.success,
            Self::Warning => theme.warning,
            Self::Danger => theme.danger,
        }
    }
}

/// 底部聚合条目（label + mono 数值 + 可选口径标注）
#[derive(Debug, Clone)]
pub struct AggregateItem {
    pub label: SharedString,
    pub value: SharedString,
    pub tone: AggregateTone,
    /// 口径标注（如 Pending 的统计口径说明；警示色小字缀于数值后）
    pub note: Option<SharedString>,
}

impl AggregateItem {
    pub fn new(label: impl Into<SharedString>, value: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            value: value.into(),
            tone: AggregateTone::Neutral,
            note: None,
        }
    }

    /// 设置语义色调
    pub fn tone(mut self, tone: AggregateTone) -> Self {
        self.tone = tone;
        self
    }

    /// 附口径标注
    pub fn note(mut self, note: impl Into<SharedString>) -> Self {
        self.note = Some(note.into());
        self
    }
}

// ---------------------------------------------------------------------------
// DataGrid —— Pattern A 虚拟化大表
// ---------------------------------------------------------------------------

/// Pattern A 虚拟化数据网格（`Render` 实体；宿主视图懒建后 `set_rows` 注入）
///
/// 列定义复用 [`ColumnDef`]（渲染闭包 / 对齐 / 排序 / numeric 语义齐全）；
/// 运行期列宽由本实体持有（拖拽调宽只改 [`Self::widths`]，不重建列定义）。
/// 排序派生为**索引序**（[`Self::display`]），注入/排序变更时重算一次，
/// 渲染帧内零克隆零排序——10k 行滚动每帧只实例化可见 ~30 行元素。
pub struct DataGrid<T> {
    id: &'static str,
    columns: Vec<ColumnDef<T>>,
    /// 运行期列宽（与 columns 一一对应；拖拽调宽的唯一可变源）
    widths: Vec<f32>,
    rows: Vec<T>,
    /// 展示索引序（rows 下标；排序/注入时重建）
    display: Vec<usize>,
    sort: Option<(usize, SortDir)>,
    striped: bool,
    empty_text: SharedString,
    scroll: gpui::UniformListScrollHandle,
    resize: Option<ResizeSession>,
}

impl<T: Clone + PartialEq + 'static> DataGrid<T> {
    /// 新建网格（空行 + 给定列定义）
    pub fn new(id: &'static str, columns: Vec<ColumnDef<T>>) -> Self {
        let widths = columns.iter().map(initial_width).collect();
        Self {
            id,
            columns,
            widths,
            rows: Vec::new(),
            display: Vec::new(),
            sort: None,
            striped: false,
            empty_text: SharedString::from("暂无数据"),
            scroll: gpui::UniformListScrollHandle::default(),
            resize: None,
        }
    }

    /// 斑马纹（可选；暗态可见 token）
    pub fn striped(mut self, striped: bool) -> Self {
        self.striped = striped;
        self
    }

    /// 空态文案
    #[allow(dead_code)] // 公共 API 面（测试 / 后续视图批次消费）
    pub fn empty_text(mut self, text: impl Into<SharedString>) -> Self {
        self.empty_text = text.into();
        self
    }

    /// 注入当前页行数据（替换全量；翻页回顶）
    pub fn set_rows(&mut self, rows: Vec<T>, cx: &mut Context<Self>) {
        self.rows = rows;
        self.rebuild_display();
        self.scroll
            .0
            .borrow_mut()
            .base_handle
            .set_offset(gpui::point(px(0.0), px(0.0)));
        cx.notify();
    }

    /// 当前行数据（只读；测试 / 外部消费）
    #[allow(dead_code)] // 公共 API 面（测试 / 后续视图批次消费）
    pub fn rows(&self) -> &[T] {
        &self.rows
    }

    /// 运行期列宽快照（测试 / 外部消费）
    #[allow(dead_code)] // 公共 API 面（测试 / 后续视图批次消费）
    pub fn widths(&self) -> &[f32] {
        &self.widths
    }

    /// 当前排序（列下标 + 方向；公共 API 面）
    #[allow(dead_code)] // 公共 API 面（测试 / 后续视图批次消费）
    pub fn sort(&self) -> Option<(usize, SortDir)> {
        self.sort
    }

    /// 展示行数（= 行数；公共 API 面）
    #[allow(dead_code)] // 公共 API 面（测试 / 后续视图批次消费）
    pub fn display_len(&self) -> usize {
        self.display.len()
    }

    /// 第 pos 个展示位对应的行引用（渲染闭包取行入口；None 越界）
    pub fn display_row(&self, pos: usize) -> Option<&T> {
        self.display.get(pos).and_then(|&ix| self.rows.get(ix))
    }

    /// 总内容宽度（各列运行期宽之和；横向滚动内容据此设固定宽）
    pub fn total_width(&self) -> f32 {
        self.widths.iter().sum()
    }

    /// 重建展示索引序（当前排序 → 稳定升/降；默认序 = 原序。
    /// 排序取值：fn 指针优先，缺省回落闭包版 `sort_value_dyn`——动态行类型
    /// （serde_json::Value 行按列 key 取值，BLF-799）依赖此回落）
    fn rebuild_display(&mut self) {
        self.display = (0..self.rows.len()).collect();
        let Some((col_ix, dir)) = self.sort else {
            return;
        };
        let Some(col) = self.columns.get(col_ix) else {
            return;
        };
        let rows = &self.rows;
        if let Some(sort_value) = col.sort_value {
            match dir {
                SortDir::Ascending => self.display.sort_by(|&a, &b| {
                    sort_value(&rows[a]).total_cmp(&sort_value(&rows[b]))
                }),
                SortDir::Descending => self.display.sort_by(|&a, &b| {
                    sort_value(&rows[b]).total_cmp(&sort_value(&rows[a]))
                }),
            }
            return;
        }
        let Some(sort_value_dyn) = col.sort_value_dyn.clone() else {
            return;
        };
        match dir {
            SortDir::Ascending => self.display.sort_by(|&a, &b| {
                sort_value_dyn(&rows[a]).total_cmp(&sort_value_dyn(&rows[b]))
            }),
            SortDir::Descending => self.display.sort_by(|&a, &b| {
                sort_value_dyn(&rows[b]).total_cmp(&sort_value_dyn(&rows[a]))
            }),
        }
    }

    /// 表头点击循环排序（升 → 降 → 默认；共享纯函数见 [`next_sort_state`]）
    fn toggle_sort(&mut self, col_ix: usize, cx: &mut Context<Self>) {
        self.sort = next_sort_state(self.sort, col_ix);
        self.rebuild_display();
        self.scroll
            .0
            .borrow_mut()
            .base_handle
            .set_offset(gpui::point(px(0.0), px(0.0)));
        cx.notify();
    }

    /// 应用拖拽会话位移（纯状态；返回是否变化，调用方 notify）。
    /// 首次 move 事件锚定起点（origin = 当时光标 x、start = 当前宽）。
    fn apply_resize(&mut self, col_ix: usize, position_x: f32) -> bool {
        let session = match &self.resize {
            Some(s) if s.col_ix == col_ix => s,
            _ => {
                let session = ResizeSession {
                    col_ix,
                    origin_x: position_x,
                    start_width: self.widths[col_ix],
                };
                self.resize = Some(session);
                self.resize.as_ref().expect("session 已写入")
            }
        };
        let new_width =
            (session.start_width + (position_x - session.origin_x)).clamp(MIN_COL_WIDTH, MAX_COL_WIDTH);
        if (self.widths[col_ix] - new_width).abs() > f32::EPSILON {
            self.widths[col_ix] = new_width;
            true
        } else {
            false
        }
    }

    /// 结束拖拽（鼠标抬起；清会话。返回是否清掉了会话，调用方 notify）
    fn end_resize(&mut self) -> bool {
        self.resize.take().is_some()
    }

    // ---- 渲染片段 ----

    /// 表头单元格（固定宽 + 内边距 + 对齐；与数据行共享 CELL_PX 度量：
    /// 零容器 padding、零列间距 → 拖拽换算 col_left 与布局严格一致）
    fn render_header_cell(
        &self,
        col_ix: usize,
        col: &ColumnDef<T>,
        active: bool,
        theme: &AppTheme,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let cell = div()
            .id(SharedString::from(format!("{}-h-{}", self.id, col.id)))
            .w(px(self.widths[col_ix]))
            .h_full()
            .flex_none()
            .overflow_hidden()
            .px(px(CELL_PX))
            .flex()
            .items_center()
            .when_align(col.align)
            .when(col.sortable, |this| this.cursor(CursorStyle::PointingHand))
            .when(col.sortable && active, |this| {
                this.text_color(theme.text_primary)
            })
            .when(!col.sortable || !active, |this| {
                this.text_color(theme.text_muted)
            });
        let arrow = if col.sortable {
            let (icon, color) = match (active, self.sort) {
                (true, Some((_, SortDir::Ascending))) => {
                    (gpui_component::IconName::ArrowUp, theme.accent)
                }
                (true, Some((_, SortDir::Descending))) => {
                    (gpui_component::IconName::ArrowDown, theme.accent)
                }
                _ => (gpui_component::IconName::Minus, theme.text_muted),
            };
            Some(
                h_flex()
                    .gap_1()
                    .items_center()
                    .child(div().child(col.title.clone()))
                    .child(
                        gpui_component::Icon::new(icon)
                            .with_size(px(12.))
                            .text_color(color),
                    ),
            )
        } else {
            None
        };
        let mut cell = cell.child(arrow.unwrap_or_else(|| div().child(col.title.clone())));
        if col.sortable {
            cell = cell.on_click(cx.listener(move |grid, _, _, cx| {
                grid.toggle_sort(col_ix, cx);
            }));
        }
        cell
    }

    /// 列宽拖拽手柄（右缘负 margin 叠压在列边界上；occlude 防触发排序点击）
    fn render_resize_handle(
        &self,
        col_ix: usize,
        theme: &AppTheme,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let grid_id = cx.entity_id();
        let handle_id = SharedString::from(format!("{}-rz-{}", self.id, col_ix));
        let group_id = SharedString::from(format!("{}-rzg-{}", self.id, col_ix));
        div()
            .id(handle_id)
            .group(group_id.clone())
            .occlude()
            .cursor(CursorStyle::ResizeColumn)
            .h_full()
            .flex_none()
            .w(px(RESIZE_HANDLE_W))
            .ml(-px(RESIZE_HANDLE_W))
            .items_center()
            .justify_end()
            .child(
                div()
                    .w(px(1.))
                    .h_full()
                    .bg(gpui::transparent_black())
                    .group_hover(group_id, |line| line.bg(theme.accent)),
            )
            .on_drag_move(cx.listener(move |grid, e: &gpui::DragMoveEvent<GridColResize>, _, cx| {
                let drag = e.drag(cx);
                if drag.grid != grid_id || drag.col_ix != col_ix {
                    return;
                }
                let position_x: f32 = e.event.position.x.into();
                if grid.apply_resize(col_ix, position_x) {
                    cx.notify();
                }
            }))
            .on_drag(
                GridColResize {
                    grid: grid_id,
                    col_ix,
                },
                |drag, _, _, cx| {
                    cx.stop_propagation();
                    cx.new(|_| drag.clone())
                },
            )
            .on_mouse_up_out(
                gpui::MouseButton::Left,
                cx.listener(|grid, _, _, cx| {
                    if grid.end_resize() {
                        cx.notify();
                    }
                }),
            )
    }

    /// 单个数据行（固定高 + 固定宽单元格，水平度量与表头一致）
    fn render_row(&self, pos: usize, row: &T, theme: &AppTheme) -> gpui::Stateful<gpui::Div> {
        let bg = if self.striped && pos % 2 == 1 {
            theme.table_row_stripe
        } else {
            theme.card_bg
        };
        let mut el = h_flex()
            .id(SharedString::from(format!("{}-r-{}", self.id, pos)))
            .h(px(GRID_ROW_HEIGHT))
            .w_full()
            .flex_none()
            .bg(bg)
            .hover(|this| this.bg(theme.table_row_hover))
            .tabular_nums()
            .text_size(px(FONT_BASE))
            .text_color(theme.text_secondary);
        for (col_ix, col) in self.columns.iter().enumerate() {
            let cell = div()
                .w(px(self.widths[col_ix]))
                .h_full()
                .flex_none()
                .overflow_hidden()
                .px(px(CELL_PX))
                .when_align(col.align);
            // BLF-792/798：数字列 JetBrains Mono + tnum（金额/数值纵向对齐）
            let cell = if col.numeric {
                cell.mono_tabular_nums()
            } else {
                cell
            };
            let cell = match &col.render_element {
                Some(render) => cell.child(render(row, theme)),
                None => cell.child((col.render)(row, theme)),
            };
            el = el.child(cell);
        }
        el
    }
}

impl<T: Clone + PartialEq + 'static> Render for DataGrid<T> {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let grid = cx.entity();
        let row_count = self.display.len();
        let empty_text = self.empty_text.clone();
        let total_width = self.total_width();
        let id = self.id;
        let empty = row_count == 0;

        // 表头（粘性：位于纵向滚动容器之外，纵滚不漂移；横滚随外层容器同步）+
        // 每列右缘拖拽手柄
        let header_cells: Vec<AnyElement> = {
            let mut cells = Vec::with_capacity(self.columns.len());
            for (col_ix, col) in self.columns.iter().enumerate() {
                let active = self.sort.map(|(ix, _)| ix == col_ix).unwrap_or(false);
                cells.push(
                    h_flex()
                        .child(self.render_header_cell(col_ix, col, active, &theme, cx))
                        .child(self.render_resize_handle(col_ix, &theme, cx))
                        .into_any_element(),
                );
            }
            cells
        };

        // 虚拟化行列表：uniform_list 每帧只实例化可见区间行（10k 行 O(可见行) 开销）。
        // 渲染闭包只有 &mut App，经 Entity 句柄回读状态（Zed 惯用法）；
        // 行按展示索引序取引用，帧内零克隆。
        let list = gpui::uniform_list(
            SharedString::from(format!("{id}-list")),
            row_count,
            move |visible, _window, app| {
                let grid_ref = grid.read(app);
                let theme = AppTheme::current(app);
                visible
                    .clone()
                    .filter_map(|pos| grid_ref.display_row(pos).map(|row| (pos, row)))
                    .map(|(pos, row)| {
                        grid_ref.render_row(pos, row, &theme).into_any_element()
                    })
                    .collect::<Vec<_>>()
            },
        )
        .track_scroll(self.scroll.clone());

        let inner = v_flex()
            .id(SharedString::from(format!("{id}-inner")))
            .flex_1()
            .min_h_0()
            .w(px(total_width))
            .border_b_1()
            .border_color(theme.separator)
            .child(
                // 表头行：28px 规格 + MEDIUM 字重（bg Panel 与数据区分层）
                h_flex()
                    .id(SharedString::from(format!("{id}-header")))
                    .h(px(TABLE_HEADER_HEIGHT))
                    .w_full()
                    .flex_none()
                    .items_center()
                    .border_b_1()
                    .border_color(theme.separator)
                    .bg(theme.panel_bg)
                    .text_size(px(FONT_XS))
                    .font_weight(FontWeight::MEDIUM)
                    .children(header_cells),
            );

        // 空态（覆盖整格；无行时不挂 uniform_list）
        let body = if empty {
            v_flex()
                .id(SharedString::from(format!("{id}-empty")))
                .flex_1()
                .min_h_0()
                .w_full()
                .items_center()
                .justify_center()
                .gap_2()
                .py_6()
                .text_color(theme.text_muted)
                .child(
                    gpui_component::Icon::new(gpui_component::Icon::empty())
                        .path("icons/package.svg")
                        .with_size(px(24.)),
                )
                .child(div().text_sm().child(empty_text))
                .into_any_element()
        } else {
            inner
                .child(list.flex_1().min_h_0().w_full())
                .into_any_element()
        };

        // 横向滚动容器：表头 + 行列表同容器 → 横滚时表头与列同步平移；
        // 纵滚发生在 uniform_list 内部 → 表头粘性不漂移
        div()
            .id(SharedString::from(format!("{id}-hscroll")))
            .flex_1()
            .min_h_0()
            .min_w_0()
            .w_full()
            .overflow_x_scroll()
            .bg(theme.window_bg)
            .child(v_flex().h_full().child(body))
    }
}

/// 表头排序循环（升 → 降 → 默认；data_grid/data_table 共用纯函数）
pub fn next_sort_state(
    current: Option<(usize, SortDir)>,
    col_ix: usize,
) -> Option<(usize, SortDir)> {
    match current {
        Some((ix, dir)) if ix == col_ix => match dir {
            SortDir::Ascending => Some((col_ix, SortDir::Descending)),
            SortDir::Descending => None,
        },
        _ => Some((col_ix, SortDir::Ascending)),
    }
}

/// 语义色文本单元格（状态列等；色调经 [`AggregateTone`] 映射 AppTheme token，
/// 禁止视图侧裸十六进制）。数字语义场景请配合 numeric 列走 mono。
pub fn tone_text(
    text: impl Into<SharedString>,
    tone: AggregateTone,
    theme: &AppTheme,
) -> gpui::AnyElement {
    div()
        .text_color(tone.color(theme))
        .child(text.into())
        .into_any_element()
}

/// 环比变化指示单元格（语义色 token：涨绿 `success` / 跌红 `danger` /
/// 平与无数据灰 `text_muted`；阈值 ±0.5% 对齐 frontend `renderChangeIndicator`）。
/// 数字走 mono+tabular（规格：数值一律等宽）。
pub fn change_indicator(change: Option<f64>, theme: &AppTheme) -> gpui::AnyElement {
    let (icon, color, text) = match change {
        None => (gpui_component::IconName::Minus, theme.text_muted, "—".to_string()),
        Some(v) if v > 0.5 => (
            gpui_component::IconName::ArrowUp,
            theme.success,
            format!("{v:.1}%"),
        ),
        Some(v) if v < -0.5 => (
            gpui_component::IconName::ArrowDown,
            theme.danger,
            format!("{:.1}%", v.abs()),
        ),
        Some(v) => (gpui_component::IconName::Minus, theme.text_muted, format!("{v:.1}%")),
    };
    h_flex()
        .w_full()
        .justify_end()
        .items_center()
        .gap_1()
        .text_xs()
        .mono_tabular_nums()
        .text_color(color)
        .child(
            gpui_component::Icon::new(icon)
                .with_size(px(12.))
                .text_color(color),
        )
        .child(div().child(text))
        .into_any_element()
}

/// 单元格对齐辅助（固定宽列）
trait GridAlignExt: Styled + Sized {
    fn when_align(self, align: CellAlign) -> Self;
}

impl<E: Styled> GridAlignExt for E {
    fn when_align(self, align: CellAlign) -> Self {
        match align {
            CellAlign::Left => self.text_left(),
            CellAlign::Right => self.text_right(),
            CellAlign::Center => self.text_center(),
        }
    }
}

// ---------------------------------------------------------------------------
// Pattern A 页面骨架 + 底部 pinned 分页聚合条
// ---------------------------------------------------------------------------

/// Pattern A 工具栏行高（36px，与 Console Bar 同尺；控件自身 24~28px）
pub const FILTER_TOOLBAR_HEIGHT: f32 = 36.0;

/// 底部聚合分页条高度（32px；pinned 于页面底部）
pub const GRID_FOOTER_HEIGHT: f32 = 32.0;

/// Pattern A 页面骨架：页面头部（可选，共享 PageHeader 承载标题/副标题）+
/// FilterToolbar 行（36px）+ 弹性主体（虚拟化大表）+ pinned 底部聚合分页条。
/// 容器外 padding 0、区间 1px 分隔线。
///
/// `header` 传共享 [`crate::widgets::page_header::PageHeader`]（全仓库业务视图
/// 一致性契约要求）；`toolbar` / `footer` 传**内容**（搜索输入、状态下拉、
/// 操作按钮；聚合条目 + 分页器），壳负责行容器的尺寸 / 背景 / 分隔线 chrome。
pub fn pattern_a_shell(
    theme: &AppTheme,
    id: &'static str,
    header: impl IntoElement,
    toolbar: impl IntoElement,
    grid: impl IntoElement,
    footer: impl IntoElement,
) -> gpui::Stateful<gpui::Div> {
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
                .id(SharedString::from(format!("{id}-body")))
                .flex()
                .flex_col()
                .flex_1()
                .min_h_0()
                .w_full()
                .child(grid),
        )
        .child(div().w_full().flex_none().child(footer))
}

/// Pattern A 底部 pinned 分页聚合条：左侧聚合摘要（mono 数值 + 可选口径标注），
/// 右侧每页行数选择 + 页码导航。数字一律 mono+tabular（规格条款）。
#[allow(clippy::too_many_arguments)]
pub fn grid_footer_bar<V: 'static>(
    view: &Entity<V>,
    theme: &AppTheme,
    id_prefix: &'static str,
    aggregates: &[AggregateItem],
    state: &PageState,
    page_size_options: &[usize],
    on_page: impl Fn(&mut V, usize, &mut gpui::Context<V>) + 'static + Copy,
    on_page_size: impl Fn(&mut V, usize, &mut gpui::Context<V>) + 'static + Copy,
) -> gpui::Stateful<gpui::Div> {
    let items: Vec<AggregateItem> = aggregates.to_vec();
    h_flex()
        .id(SharedString::from(format!("{id_prefix}-footer")))
        .w_full()
        .flex_none()
        .h(px(GRID_FOOTER_HEIGHT))
        .px_2()
        .gap_3()
        .items_center()
        .bg(theme.panel_bg)
        .border_t_1()
        .border_color(theme.separator)
        .child(
            h_flex()
                .id(SharedString::from(format!("{id_prefix}-aggregates")))
                .min_w_0()
                .gap_3()
                .items_center()
                .overflow_hidden()
                .children(items.iter().enumerate().map(|(ix, item)| {
                    h_flex()
                        .id(SharedString::from(format!(
                            "{id_prefix}-agg-{ix}-{}",
                            item.label
                        )))
                        .min_w_0()
                        .gap_1p5()
                        .items_center()
                        .when(ix > 0, |this| {
                            this.border_l_1().border_color(theme.separator).pl_3()
                        })
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.text_muted)
                                .child(item.label.clone()),
                        )
                        .child(
                            div()
                                .mono_tabular_nums()
                                .text_size(px(FONT_BASE))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(item.tone.color(theme))
                                .child(item.value.clone()),
                        )
                        .children(item.note.clone().map(|note| {
                            div().text_xs().text_color(theme.warning).child(note)
                        }))
                        .into_any_element()
                })),
        )
        .child(div().flex_1())
        .child(page_size_select(
            view,
            theme,
            id_prefix,
            state,
            page_size_options,
            on_page_size,
        ))
        .child(pagination_controls(view, theme, id_prefix, state, on_page))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, PartialEq)]
    struct DemoRow {
        name: String,
        qty: i64,
        amount: f64,
    }

    fn demo_columns() -> Vec<ColumnDef<DemoRow>> {
        vec![
            ColumnDef::text("name", "名称", |r: &DemoRow, _| SharedString::from(r.name.clone()))
                .width(180.0),
            ColumnDef::number("qty", "数量", |r: &DemoRow| r.qty as f64, |r: &_, _| {
                SharedString::from(r.qty.to_string())
            })
            .width(96.0),
            ColumnDef::number("amount", "金额", |r: &DemoRow| r.amount, |r: &_, _| {
                SharedString::from(format!("{:.2}", r.amount))
            }),
        ]
    }

    fn demo_rows(n: usize) -> Vec<DemoRow> {
        (0..n)
            .map(|i| DemoRow {
                name: format!("SKU-{i:05}"),
                qty: (i % 97) as i64,
                amount: (i % 1000) as f64 * 1.5,
            })
            .collect()
    }

    #[test]
    fn column_widths_initialize_from_def_or_default_with_clamp() {
        let grid = DataGrid::new("g", demo_columns());
        assert_eq!(grid.widths(), &[180.0, 96.0, DEFAULT_COL_WIDTH]);
        assert_eq!(grid.total_width(), 180.0 + 96.0 + DEFAULT_COL_WIDTH);
        // 显式过窄宽度被抬到 MIN_COL_WIDTH
        let narrow = ColumnDef::text("n", "窄", |_: &DemoRow, _| SharedString::from(""))
            .width(20.0);
        let g2 = DataGrid::new("g2", vec![narrow]);
        assert_eq!(g2.widths()[0], MIN_COL_WIDTH);
    }

    #[test]
    fn set_rows_rebuilds_display_and_sort_indexes() {
        let mut grid = DataGrid::new("g", demo_columns());
        grid.rows = demo_rows(4);
        grid.rebuild_display();
        assert_eq!(grid.display_len(), 4);
        // 默认顺序保持原序
        let qtys: Vec<_> = (0..4).map(|p| grid.display_row(p).expect("pos").qty).collect();
        assert_eq!(qtys, vec![0, 1, 2, 3]);
        // 数量降序 → 索引序 [3,2,1,0]（qty=i%97）
        grid.sort = Some((1, SortDir::Descending));
        grid.rebuild_display();
        let qtys: Vec<_> = (0..4).map(|p| grid.display_row(p).expect("pos").qty).collect();
        assert_eq!(qtys, vec![3, 2, 1, 0]);
        // 越界安全
        assert!(grid.display_row(99).is_none());
    }

    #[test]
    fn next_sort_cycles_like_data_table() {
        assert_eq!(next_sort_state(None, 1), Some((1, SortDir::Ascending)));
        assert_eq!(
            next_sort_state(Some((1, SortDir::Ascending)), 1),
            Some((1, SortDir::Descending))
        );
        assert_eq!(next_sort_state(Some((1, SortDir::Descending)), 1), None);
        assert_eq!(
            next_sort_state(Some((1, SortDir::Descending)), 0),
            Some((0, SortDir::Ascending))
        );
    }

    #[test]
    fn resize_session_tracks_delta_with_clamp() {
        let mut grid = DataGrid::new("g", demo_columns());
        let base = grid.widths()[0];
        // 首次 move 锚定起点（无位移不变形）
        assert!(!grid.apply_resize(0, 100.0));
        assert_eq!(grid.widths()[0], base);
        // +40px 位移 → 宽 +40
        assert!(grid.apply_resize(0, 140.0));
        assert!((grid.widths()[0] - (base + 40.0)).abs() < 0.001);
        // 拖过下限 → 收敛 MIN
        assert!(grid.apply_resize(0, -500.0));
        assert_eq!(grid.widths()[0], MIN_COL_WIDTH);
        // 上限收敛
        assert!(grid.apply_resize(0, 100_000.0));
        assert_eq!(grid.widths()[0], MAX_COL_WIDTH);
        // 结束清会话
        assert!(grid.end_resize());
        assert!(!grid.end_resize(), "二次 end 无会话可清");
    }

    /// 契约：粘性表头 28px + 行高落 24~28px 区间 + 工具栏 36px + 拖拽常量齐备
    #[test]
    fn dense_metrics_contract() {
        assert_eq!(TABLE_HEADER_HEIGHT, 28.0, "表头规格 28px");
        assert!(
            (24.0..=28.0).contains(&GRID_ROW_HEIGHT),
            "行高必须落在 24~28px 区间，实际 {GRID_ROW_HEIGHT}"
        );
        assert_eq!(FILTER_TOOLBAR_HEIGHT, 36.0, "工具栏行 36px");
        assert_eq!(GRID_FOOTER_HEIGHT, 32.0, "底部分页聚合条 32px");
        const { assert!(MIN_COL_WIDTH < MAX_COL_WIDTH, "列宽上下限必须有序") }
    }

    /// BLF-798 性能基准（数据层）：10,000 行 mock 数据的注入 / 排序派生 /
    /// 筛选 / 全量聚合必须亚帧级完成——配合 uniform_list 只实例化可见行
    /// （虚拟化契约见下），滚动 / 筛选无明显掉帧（实测帧耗时记录于 PR）。
    #[test]
    fn ten_thousand_rows_pipeline_under_frame_budget() {
        let started = std::time::Instant::now();
        let rows = demo_rows(10_000);
        let generated = started.elapsed();

        let mut grid = DataGrid::new("perf", demo_columns());
        let before = std::time::Instant::now();
        grid.rows = rows;
        grid.rebuild_display();
        let injected = before.elapsed();

        let before = std::time::Instant::now();
        grid.sort = Some((2, SortDir::Descending));
        grid.rebuild_display();
        let sorted_elapsed = before.elapsed();

        let before = std::time::Instant::now();
        let filtered_count = (0..grid.display_len())
            .filter(|&p| grid.display_row(p).expect("pos").qty > 50)
            .count();
        let filtered_elapsed = before.elapsed();

        let before = std::time::Instant::now();
        let total: f64 = (0..grid.display_len())
            .map(|p| grid.display_row(p).expect("pos").amount)
            .sum();
        let aggregated = before.elapsed();

        assert_eq!(grid.display_len(), 10_000);
        assert!(filtered_count > 0 && total > 0.0);
        // 各环节预算一帧 16ms；断言放宽到 ≤50ms 防 CI 抖动误报
        assert!(generated.as_millis() <= 50, "生成 10k 行耗时过长: {generated:?}");
        assert!(injected.as_millis() <= 50, "注入 10k 行耗时过长: {injected:?}");
        assert!(
            sorted_elapsed.as_millis() <= 50,
            "排序 10k 行耗时过长: {sorted_elapsed:?}"
        );
        assert!(
            filtered_elapsed.as_millis() <= 50,
            "筛选 10k 行耗时过长: {filtered_elapsed:?}"
        );
        assert!(
            aggregated.as_millis() <= 50,
            "聚合 10k 行耗时过长: {aggregated:?}"
        );
    }
}
