//! 通用数据表格（P5-0 公共基建，BLF-759）
//!
//! 对齐 `frontend/components/ui/table` 能力子集（列定义 / 行渲染 / 表头排序 /
//! hover 与选中行态 / 空态 / 可复用表头样式），供后续 45 个业务板块视图
//! 直接复用——只需给出 [`ColumnDef`] 列定义 + 行数据，无需每个视图重复
//! 编写表头 / 斑马纹 / 空态 / 排序样板（对比 ad_analysis.rs 三个 Top 表
//! 手写 `h_flex` 行渲染的旧模式）。
//!
//! 能力：
//! - 列定义：id / 标题 / 宽度（None = 弹性）/ 对齐 / 排序 / 格式化；
//! - 表头排序：可排序列点击循环 `升序 → 降序 → 默认`，箭头图标反射；
//! - hover 行态（`.hover` 背景）与选中行态（点击选中，强调色浅底）；
//! - 斑马纹（可选）、空态（图标 + 文案）、固定最大高度滚动（可选）。
//!
//! 使用（宿主视图持有 `Entity<DataTable<Row>>`，懒建 + `set_rows` 注入）：
//! ```ignore
//! let table = cx.new(|_| {
//!     DataTable::new("stock-table", columns())
//!         .striped(true)
//!         .empty_text("暂无库存数据")
//! });
//! table.update(cx, |t, cx| t.set_rows(rows, cx));
//! // render: table.clone()
//! ```

use gpui::{
    div, prelude::*, px, AnyElement, Context, CursorStyle, FontWeight, IntoElement,
    ParentElement, SharedString, Styled, Window,
};
use gpui_component::{h_flex, v_flex, Sizable};

use crate::theme::AppTheme;

/// 单元格对齐方式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellAlign {
    Left,
    Right,
    /// 居中（当前示例视图未用；公共 API 面，供后续板块视图）
    #[allow(dead_code)]
    Center,
}

/// 排序方向
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortDir {
    Ascending,
    Descending,
}

/// 自定义单元格渲染器（闭包捕获视图实体或纯 fn 指针；P5-1 起支持闭包）
pub type CellRenderer<T> = Box<dyn Fn(&T, &AppTheme) -> AnyElement>;

/// 列定义（通用行类型的渲染 / 排序约定）
pub struct ColumnDef<T> {
    /// 列 id（表头 element id 用；如 `"stock-sku"`）。
    /// `String`（非 `&'static str`）以支持**动态列**（库存分析的在途 shipment 列
    /// 数量随响应变化，id 需含 shipment_no 去重，见 inventory_analysis.rs）。
    pub id: String,
    /// 表头标题
    pub title: SharedString,
    /// 列宽（px）；`None` = 弹性占满剩余空间
    pub width: Option<f32>,
    /// 对齐（表头 + 单元格）
    pub align: CellAlign,
    /// 是否可排序（配合 `sort_value`）
    pub sortable: bool,
    /// 排序取值函数（仅 sortable 列需要）
    pub sort_value: Option<fn(&T) -> f64>,
    /// 单元格文本格式化（默认渲染；`render_element` 存在时忽略）
    pub render: fn(&T, &AppTheme) -> SharedString,
    /// 自定义单元格渲染（图标 / 彩色 badge / 行内按钮等；优先于 `render`）。
    /// 用闭包可捕获视图实体（P5-1 起支持；`fn` 指针仍兼容）。
    pub render_element: Option<CellRenderer<T>>,
}

impl<T> ColumnDef<T> {
    /// 构造文本列（默认左对齐、不可排序）
    pub fn text(id: impl Into<String>, title: impl Into<SharedString>, render: fn(&T, &AppTheme) -> SharedString) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            width: None,
            align: CellAlign::Left,
            sortable: false,
            sort_value: None,
            render,
            render_element: None,
        }
    }

    /// 构造数值列（默认右对齐；可排序）
    pub fn number(id: impl Into<String>, title: impl Into<SharedString>, sort_value: fn(&T) -> f64, render: fn(&T, &AppTheme) -> SharedString) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            width: None,
            align: CellAlign::Right,
            sortable: true,
            sort_value: Some(sort_value),
            render,
            render_element: None,
        }
    }

    /// 设置列宽（px）
    pub fn width(mut self, width: f32) -> Self {
        self.width = Some(width);
        self
    }

    /// 设置对齐
    pub fn align(mut self, align: CellAlign) -> Self {
        self.align = align;
        self
    }

    /// 切换可排序
    /// 公共 API 面（当前示例视图为保持服务端排序顺序未启用）
    #[allow(dead_code)]
    pub fn sortable(mut self, sortable: bool) -> Self {
        self.sortable = sortable;
        self
    }

    /// 自定义单元格渲染（覆盖 `render`）
    pub fn with_render_element(
        mut self,
        render: impl Fn(&T, &AppTheme) -> AnyElement + 'static,
    ) -> Self {
        self.render_element = Some(Box::new(render));
        self
    }
}

/// 通用数据表格 widget（`Render` 实体；宿主视图懒建后 `set_rows` 注入）
pub struct DataTable<T> {
    /// 容器 element id（测试定位用）
    id: &'static str,
    columns: Vec<ColumnDef<T>>,
    /// 原始行（排序在渲染期派生，`set_rows` 无需重排）
    rows: Vec<T>,
    /// 当前排序（列下标 + 方向）；None = 默认顺序
    sort: Option<(usize, SortDir)>,
    /// 选中行下标（None = 未选中）
    selected: Option<usize>,
    /// 空态文案
    empty_text: SharedString,
    /// 空态图标（默认 `icons/package.svg`）
    empty_icon: &'static str,
    /// 是否斑马纹
    striped: bool,
    /// 是否行可选中（点击切换选中态）
    selectable: bool,
    /// 固定最大高度（px，超出滚动）；None = 自适应
    max_height: Option<f32>,
}

impl<T: Clone + PartialEq + 'static> DataTable<T> {
    /// 新建表格（空行 + 给定列定义）
    pub fn new(id: &'static str, columns: Vec<ColumnDef<T>>) -> Self {
        Self {
            id,
            columns,
            rows: Vec::new(),
            sort: None,
            selected: None,
            empty_text: SharedString::from("暂无数据"),
            empty_icon: "icons/package.svg",
            striped: false,
            selectable: false,
            max_height: None,
        }
    }

    /// 空态文案
    pub fn empty_text(mut self, text: impl Into<SharedString>) -> Self {
        self.empty_text = text.into();
        self
    }

    /// 空态图标（`icons/*.svg`；公共 API 面）
    #[allow(dead_code)]
    pub fn empty_icon(mut self, icon: &'static str) -> Self {
        self.empty_icon = icon;
        self
    }

    /// 斑马纹
    pub fn striped(mut self, striped: bool) -> Self {
        self.striped = striped;
        self
    }

    /// 行可选中（点击切换选中行；公共 API 面，供后续视图）
    #[allow(dead_code)]
    pub fn selectable(mut self, selectable: bool) -> Self {
        self.selectable = selectable;
        self
    }

    /// 固定最大高度（px，超出滚动）
    pub fn max_height(mut self, height: f32) -> Self {
        self.max_height = Some(height);
        self
    }

    /// 注入行数据（替换全量；选中行越界时清空）
    pub fn set_rows(&mut self, rows: Vec<T>, cx: &mut Context<Self>) {
        self.rows = rows;
        if self.selected.is_some_and(|ix| ix >= self.rows.len()) {
            self.selected = None;
        }
        cx.notify();
    }

    /// 注入行数据（仅内容变化时触发 notify；供父视图 render 期幂等调用）
    pub fn set_rows_if_changed(&mut self, rows: &[T], cx: &mut Context<Self>) {
        if self.rows == rows {
            return;
        }
        self.set_rows(rows.to_vec(), cx);
    }

    /// 当前行数据（只读；测试 / 外部消费）
    /// 目前仅测试消费；公共 API 面
    #[allow(dead_code)]
    pub fn rows(&self) -> &[T] {
        &self.rows
    }

    /// 当前排序（列下标 + 方向；公共 API 面）
    #[allow(dead_code)]
    pub fn sort(&self) -> Option<(usize, SortDir)> {
        self.sort
    }

    /// 当前选中行下标（公共 API 面）
    #[allow(dead_code)]
    pub fn selected(&self) -> Option<usize> {
        self.selected
    }

    /// 纯函数：按当前排序派生展示行（不修改 `rows`）
    fn sorted_rows(&self) -> Vec<T> {
        let Some((col_ix, dir)) = self.sort else {
            return self.rows.clone();
        };
        let Some(ColumnDef {
            sort_value: Some(value),
            ..
        }) = self.columns.get(col_ix)
        else {
            return self.rows.clone();
        };
        let mut rows = self.rows.clone();
        match dir {
            SortDir::Ascending => rows.sort_by(|a, b| value(a).total_cmp(&value(b))),
            SortDir::Descending => rows.sort_by(|a, b| value(b).total_cmp(&value(a))),
        }
        rows
    }

    /// 纯函数：点击某列后的下一个排序状态（升序 → 降序 → 默认）
    pub fn next_sort(current: Option<(usize, SortDir)>, col_ix: usize) -> Option<(usize, SortDir)> {
        match current {
            Some((ix, dir)) if ix == col_ix => match dir {
                SortDir::Ascending => Some((col_ix, SortDir::Descending)),
                SortDir::Descending => None,
            },
            _ => Some((col_ix, SortDir::Ascending)),
        }
    }

    /// 表头点击：循环 升序 → 降序 → 默认（回到未排序）
    fn toggle_sort(&mut self, col_ix: usize, cx: &mut Context<Self>) {
        self.sort = Self::next_sort(self.sort, col_ix);
        cx.notify();
    }

    fn select_row(&mut self, row_ix: usize, cx: &mut Context<Self>) {
        self.selected = Some(row_ix);
        cx.notify();
    }
}

impl<T: Clone + PartialEq + 'static> Render for DataTable<T> {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let reduce = crate::motion::reduce_motion(cx);
        let display = self.sorted_rows();
        let empty = display.is_empty();

        // 表头
        let header = h_flex()
            .id(SharedString::from(format!("{}-header", self.id)))
            .px_4()
            .py_2()
            .gap_3()
            .border_b_1()
            .border_color(theme.separator)
            .text_xs()
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.text_muted)
            .children(self.columns.iter().enumerate().map(|(col_ix, col)| {
                let align = col.align;
                let sortable = col.sortable;
                let active = self.sort.map(|(ix, _)| ix == col_ix).unwrap_or(false);
                let header_cell = div()
                    .id(SharedString::from(col.id.clone()))
                    .when(sortable, |this| {
                        this.cursor(CursorStyle::PointingHand)
                    })
                    .when_align(align, col.width, &theme)
                    .when(sortable && active, |this| {
                        this.text_color(theme.text_primary)
                    });
                let arrow = if sortable {
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
                header_cell
                    .child(arrow.unwrap_or_else(|| div().child(col.title.clone())))
                    .when(sortable, |this| {
                        let sort_col_ix = col_ix;
                        this.on_click(cx.listener(move |table, _, _, cx| {
                            table.toggle_sort(sort_col_ix, cx);
                        }))
                    })
            }));

        // 行
        let rows = display
            .iter()
            .enumerate()
            .map(|(row_ix, row)| {
                let bg = if self.selected == Some(row_ix) {
                    if theme.is_dark() {
                        theme.muted_fill
                    } else {
                        theme.accent_soft
                    }
                } else if self.striped && row_ix % 2 == 1 {
                    theme.muted_fill.opacity(0.5)
                } else {
                    theme.card_bg
                };
                h_flex()
                    .id(SharedString::from(format!("{}-{row_ix}", self.id)))
                    .px_4()
                    .py_1p5()
                    .gap_3()
                    .bg(bg)
                    .when(self.selectable, |this| {
                        this.cursor(CursorStyle::PointingHand)
                            .hover(|this| {
                                if self.selected != Some(row_ix) {
                                    this.bg(theme.muted_fill.opacity(0.35))
                                } else {
                                    this
                                }
                            })
                            .on_click(cx.listener(move |table, _, _, cx| {
                                table.select_row(row_ix, cx);
                            }))
                    })
                    .text_sm()
                    .text_color(theme.text_secondary)
                    .children(self.columns.iter().map(|col| {
                        let cell = div().when_align(col.align, col.width, &theme);
                        match &col.render_element {
                            Some(render) => cell.child(render(row, &theme)),
                            None => cell.child((col.render)(row, &theme)),
                        }
                    }))
            });

        // 空态
        let empty_view = v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap_2()
            .py_6()
            .text_color(theme.text_muted)
            .child(
                gpui_component::Icon::new(gpui_component::Icon::empty())
                    .path(self.empty_icon)
                    .with_size(px(24.)),
            )
            .child(div().text_size(px(13.)).child(self.empty_text.clone()));

        crate::motion::enter_fade_in(
            SharedString::from(format!("{}-fade", self.id)),
            div()
                .id(self.id)
                .w_full()
                .when_some(self.max_height, |this, h| this.max_h(px(h)))
                .when(self.max_height.is_some(), |this| this.overflow_y_scroll())
                .child(v_flex().gap_0().child(header).children(rows))
                .when(empty, |this| this.child(empty_view)),
            reduce,
        )
    }
}

/// 表头 / 单元格对齐 + 宽度辅助（内部）
trait WhenAlignExt {
    fn when_align(self, align: CellAlign, width: Option<f32>, _theme: &AppTheme) -> Self;
}

impl<T: Styled> WhenAlignExt for T {
    fn when_align(self, align: CellAlign, width: Option<f32>, _theme: &AppTheme) -> Self {
        let base = match align {
            CellAlign::Left => self.text_left(),
            CellAlign::Right => self.text_right(),
            CellAlign::Center => self.text_center(),
        };
        match width {
            Some(w) => base.w(px(w)),
            None => base.flex_1(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::Entity;

    /// 测试行类型
    #[derive(Debug, Clone, PartialEq)]
    struct StockRow {
        sku: String,
        qty: i64,
    }

    fn sku_col() -> ColumnDef<StockRow> {
        ColumnDef::text("sku", "SKU", |r: &StockRow, _| SharedString::from(r.sku.clone()))
            .width(200.0)
    }

    fn qty_col() -> ColumnDef<StockRow> {
        ColumnDef::number("qty", "库存", |r: &StockRow| r.qty as f64, |r: &StockRow, _| {
            SharedString::from(r.qty.to_string())
        })
        .width(120.0)
    }

    fn rows() -> Vec<StockRow> {
        vec![
            StockRow { sku: "A".into(), qty: 3 },
            StockRow { sku: "B".into(), qty: 10 },
            StockRow { sku: "C".into(), qty: 5 },
        ]
    }

    #[test]
    fn column_def_builders_configure_fields() {
        let text = sku_col();
        assert_eq!(text.id, "sku");
        assert_eq!(text.align, CellAlign::Left);
        assert!(!text.sortable);
        assert_eq!(text.width, Some(200.0));
        let num = qty_col();
        assert_eq!(num.align, CellAlign::Right);
        assert!(num.sortable);
        assert!(num.sort_value.is_some());
    }

    #[test]
    fn sorted_rows_ascending_descending_and_default() {
        let table = |sort| DataTable {
            id: "t",
            columns: vec![sku_col(), qty_col()],
            rows: rows(),
            sort,
            selected: None,
            empty_text: "暂无数据".into(),
            empty_icon: "icons/package.svg",
            striped: false,
            selectable: false,
            max_height: None,
        };
        // 默认顺序保持原序
        let default = table(None);
        let out = default.sorted_rows();
        assert_eq!(out.iter().map(|r| r.sku.as_str()).collect::<Vec<_>>(), ["A", "B", "C"]);
        // 库存升序
        let asc = table(Some((1, SortDir::Ascending)));
        let out = asc.sorted_rows();
        assert_eq!(out.iter().map(|r| r.qty).collect::<Vec<_>>(), [3, 5, 10]);
        // 库存降序
        let desc = table(Some((1, SortDir::Descending)));
        let out = desc.sorted_rows();
        assert_eq!(out.iter().map(|r| r.qty).collect::<Vec<_>>(), [10, 5, 3]);
    }

    #[test]
    fn next_sort_cycles_asc_desc_default() {
        assert_eq!(DataTable::<StockRow>::next_sort(None, 1), Some((1, SortDir::Ascending)));
        assert_eq!(
            DataTable::<StockRow>::next_sort(Some((1, SortDir::Ascending)), 1),
            Some((1, SortDir::Descending))
        );
        assert_eq!(
            DataTable::<StockRow>::next_sort(Some((1, SortDir::Descending)), 1),
            None
        );
        // 切到另一列 → 该列升序
        assert_eq!(
            DataTable::<StockRow>::next_sort(Some((1, SortDir::Descending)), 0),
            Some((0, SortDir::Ascending))
        );
    }

    // ---------- 渲染冒烟（亮 / 暗 + 空态） ----------

    /// 宿主：渲染 DataTable（有数据）与空表并列
    struct TableHost {
        full: Entity<DataTable<StockRow>>,
        empty: Entity<DataTable<StockRow>>,
    }

    impl TableHost {
        fn new(cx: &mut gpui::Context<Self>) -> Self {
            let full = cx.new(|_| {
                DataTable::new("dt-full", vec![sku_col(), qty_col()])
                    .striped(true)
                    .selectable(true)
                    .max_height(240.0)
            });
            full.update(cx, |t, cx| t.set_rows(rows(), cx));
            let empty = cx.new(|_| {
                DataTable::new("dt-empty", vec![sku_col(), qty_col()])
                    .empty_text("暂无库存数据")
                    .empty_icon("icons/warehouse.svg")
            });
            Self { full, empty }
        }
    }

    impl Render for TableHost {
        fn render(&mut self, _window: &mut gpui::Window, _cx: &mut gpui::Context<Self>) -> impl IntoElement {
            v_flex()
                .gap_4()
                .child(self.full.clone())
                .child(self.empty.clone())
        }
    }

    #[gpui::test]
    async fn data_table_renders_light_dark_and_empty(cx: &mut gpui::TestAppContext) {
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
            let (_host, cx2) = cx.add_window_view(|_window, cx| TableHost::new(cx));
            cx2.read(|app| {
                assert_eq!(crate::theme::AppTheme::current(app).is_dark(), dark);
            });
        }
    }
}
