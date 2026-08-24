//! Pattern D「财务计算矩阵」标准模板（BLF-801，Stage10）
//!
//! 父 issue「视图模板」Pattern D 规格的可复用实现，供新品核算 / 店铺测算 /
//! VAT 发票及一切「币种站点选择 + Excel 风格计算表单」页套版。结构（自上而下）：
//!
//! - **PageHeader**：复用 [`crate::widgets::page_header::PageHeader`]（宿主注入）；
//! - **工具栏行**（36px）：宿主放模式切换 / 搜索等控件（同 Pattern A/B 密度带）；
//! - **币种 & VAT 站点卡片选择器** [`site_card_selector`]：站点卡 = 国旗 +
//!   站点码 + 币种 / VAT 税率摘要，选中态 accent 描边；规格数据源 [`SITES`]；
//! - **Excel 风格高密度 sheet 矩阵**：行列表头 + 可编辑输入单元格 +
//!   只读计算单元格。单元格格高 [`CELL_HEIGHT`]（26px，落在规格 24~28px），
//!   表头 [`HEADER_HEIGHT`]（28px）；数字一律 mono 等宽；
//!   校验失败单元格即时红框（[`cell_error_frame`]）。
//!
//! ## 三层职责拆分（通用化保证）
//!
//! 1. **公式引擎（纯函数，集中定义可测试）**——[`parse_number`]（千分位 /
//!    货币符号 / 全角空格容错解析）、[`parse_rate`](百分数容错)、
//!    [`format_amount`]（货币格式化）、[`validate_cell`]（规则校验）、
//!    [`compute_rows`]（声明式行定义 → 即时派生值）。宿主把「输入变更即时重算」
//!    实现为纯函数表，渲染期直接调用，不维护第二份状态。
//! 2. **键盘导航（纯函数）**——[`SheetSelection`] + [`move_selection`]：
//!    方向键步进、Tab/Shift+Tab 环绕。宿主在输入 Change/KeyDown 订阅里调用，
//!    模板不绑定焦点系统。
//! 3. **渲染小件**——[`pattern_d_shell`]（页面壳）+ [`site_card_selector`]
//!    （站点卡）+ [`sheet_matrix`]（只读矩阵：列表头 + 行 + 单元格）+
//!    [`editable_cell_frame`] / [`computed_cell`]（可编辑格框 / 只读格）。
//!    可编辑格由宿主注入 `Entity<InputState>`（懒建纪律同既有视图），模板提供
//!    统一的 26px 密度框线与选中态。
//!
//! ## 接入方式（财务矩阵页套版清单）
//!
//! 1. 宿主持有：当前站点 `code`、输入实体组、选中格 [`SheetSelection`]；
//! 2. 渲染：`pattern_d_shell(theme, id, header, toolbar, site_cards, body)`
//!    组装页面壳；站点卡用 `site_card_selector(view, …)`；数值区用
//!    `sheet_matrix`（只读形态，VAT 发票明细 / 结果面板用）或
//!    `editable_cell_frame` 组合（录入形态）；
//! 3. 派生值：输入 Change 订阅 notify 后渲染期经公式引擎纯函数重算——
//!    「改任一输入派生值即时刷新」由此保证，无额外状态同步；
//! 4. 只读分支：财务月报等展示页后续复用 [`sheet_matrix`]（无编辑态、
//!    无校验红框），本模板即该形态的唯一出口。
//!
//! ```ignore
//! // 宿主 render 片段：
//! let sites = site_card_selector(view, &theme, "npc-sites", self.country, |this, code, cx| {
//!     this.select_country(code, cx);
//! });
//! pattern_d_shell(&theme, "npc", header, toolbar_row, sites, body)
//! ```
//!
//! ## 已知坑（接入必读）
//!
//! 1. 金额口径 Σ(item_price + shipping_price)，item_price 是行总价已含数量，
//!    **不要再乘 quantity**（父 issue 守则 2）；
//! 2. [`parse_number`] 返回 `Option`：空白输入是合法的「未填」，调用方决定
//!    默认值；不要 `.unwrap_or(0.0)` 后再拿 0 当「未填」信号（0 是合法输入）；
//! 3. 百分数字段统一走 [`parse_rate`]（12 与 12% 同义 = 0.12）；展示回填时
//!    用 [`format_rate`] 还原为用户习惯的百分数。

// 模板 API 面向 Stage11/12 迁移批次（财务月报只读形态、更多计算矩阵页）
// 预留；三原型套版仅消费其中一部分，其余出口在接入前允许暂时未用。
#![allow(dead_code)]

use gpui::{
    div, prelude::*, px, Context, Entity, FontWeight, IntoElement, ParentElement, SharedString,
    Styled,
};
use gpui_component::{h_flex, v_flex};

use crate::theme::{AppTheme, FONT_BASE, FONT_XS};
use crate::widgets::data_table::TabularNumsExt;

// ---------------------------------------------------------------------------
// 规格（父 issue Pattern D：站点卡选择头 + Excel 风格高密度矩阵）
// ---------------------------------------------------------------------------

/// 单元格高度（px；规格锁 24~28px 区间中点）
pub const CELL_HEIGHT: f32 = 26.0;
/// 表头行高度（px；对齐 TABLE_HEADER_HEIGHT 密度带）
pub const HEADER_HEIGHT: f32 = 28.0;
/// 站点卡最小宽度（px）
pub const SITE_CARD_WIDTH: f32 = 148.0;
/// 站点卡高度（px）
pub const SITE_CARD_HEIGHT: f32 = 44.0;

// ---------------------------------------------------------------------------
// 站点规格（国旗 / 币种 / VAT 税率摘要）
// ---------------------------------------------------------------------------

/// 站点规格卡数据（US 免销售税口径按平台代扣代缴记 0%）
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SiteSpec {
    /// 站点码（US / DE / UK，对齐各页 COUNTRY_OPTIONS）
    pub code: &'static str,
    /// 国旗 emoji
    pub flag: &'static str,
    /// 中文站名
    pub label: &'static str,
    /// 结算币种
    pub currency: &'static str,
    /// VAT / 销售税率摘要（百分数数值，如 19.0 表示 19%）
    pub vat_rate_pct: f64,
}

/// 支持站点（对齐 web COUNTRY_OPTIONS：US / DE / UK 三站）
pub const SITES: [SiteSpec; 3] = [
    SiteSpec { code: "US", flag: "🇺🇸", label: "美国站", currency: "USD", vat_rate_pct: 0.0 },
    SiteSpec { code: "DE", flag: "🇩🇪", label: "德国站", currency: "EUR", vat_rate_pct: 19.0 },
    SiteSpec { code: "UK", flag: "🇬🇧", label: "英国站", currency: "GBP", vat_rate_pct: 20.0 },
];

/// 按站点码取规格（未知码回落 US）
pub fn site_for(code: &str) -> &'static SiteSpec {
    SITES.iter().find(|s| s.code == code).unwrap_or(&SITES[0])
}

// ---------------------------------------------------------------------------
// 公式引擎 · 数字解析（容错：千分位 / 货币符号 / 空白）
// ---------------------------------------------------------------------------

/// 容错数字解析（纯函数）。容忍：千分位逗号、货币符号（$ € £ ¥）、币种后缀
/// （USD / EUR / GBP / RMB / CNY，大小写不敏感）、全角/半角空格、全角数字、
/// 括号负数「(123)」；空白串返回 None（= 未填，见已知坑 2）。
pub fn parse_number(raw: &str) -> Option<f64> {
    let mut s = raw.trim();
    if s.is_empty() {
        return None;
    }
    // 括号负数（会计口径）
    let paren_negative = s.starts_with('(') && s.ends_with(')');
    if paren_negative {
        s = &s[1..s.len() - 1];
    }
    // 去货币符号 / 各类空白（千分位逗号单独处理，见下）
    let mut cleaned = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '$' | '€' | '£' | '¥' | ' ' | '\u{00a0}' | '\u{3000}' | '\'' => {}
            _ => cleaned.push(ch),
        }
    }
    // 千分位 / 小数逗号消歧：无小数点且最后一组逗号后是 1~2 位数字时，
    // 视作欧式小数逗号（99,90 → 99.90）；其余逗号一律按千分位丢弃。
    let has_dot = cleaned.contains('.');
    let decimal_comma = !has_dot && {
        match cleaned.rfind(',') {
            Some(pos) => {
                let frac = &cleaned[pos + 1..];
                (1..=2).contains(&frac.len()) && frac.bytes().all(|b| b.is_ascii_digit())
            }
            None => false,
        }
    };
    let mut normalized = String::with_capacity(cleaned.len());
    for ch in cleaned.chars() {
        match ch {
            ',' if decimal_comma => normalized.push('.'),
            ',' => {}
            _ => normalized.push(ch),
        }
    }
    // 去百分号与币种字母前后缀（USD123 / 123USD / eur 等）
    let upper = normalized.to_uppercase();
    let stripped = upper
        .trim_start_matches(|c: char| c.is_ascii_alphabetic() || c == '%')
        .trim_end_matches(|c: char| c.is_ascii_alphabetic() || c == '%')
        .to_string();
    let stripped = stripped.as_str();
    if stripped.is_empty() || stripped == "-" || stripped == "." {
        return None;
    }
    let value: f64 = stripped.parse().ok()?;
    Some(if paren_negative { -value } else { value })
}

/// 百分数解析（纯函数）：`12` / `12%` / `0.12`？——约定入参一律「用户口中的
/// 百分数」：`12` 与 `12%` 同义返回 0.12。空 / 非法返回 None。
pub fn parse_rate(raw: &str) -> Option<f64> {
    parse_number(raw).map(|v| v / 100.0)
}

/// 百分数展示（用户习惯口径：0.126 → "12.6%"）
pub fn format_rate(rate: f64) -> String {
    let pct = rate * 100.0;
    if (pct - pct.round()).abs() < f64::EPSILON {
        format!("{pct:.0}%")
    } else {
        format!("{pct:.1}%")
    }
}

/// 千分位格式化（纯函数；decimals 位小数，负号前置）
pub fn format_thousands(value: f64, decimals: usize) -> String {
    let negative = value < 0.0 || (value == 0.0 && value.is_sign_negative());
    let formatted = format!("{value:.decimals$}");
    let (int_part, dec_part) = match formatted.split_once('.') {
        Some((i, d)) => (i, Some(d)),
        None => (formatted.as_str(), None),
    };
    let int_digits = int_part.trim_start_matches('-');
    let mut out = String::with_capacity(int_digits.len() + int_digits.len() / 3 + 4);
    if negative {
        out.push('-');
    }
    for (i, ch) in int_digits.chars().enumerate() {
        if i > 0 && (int_digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    if let Some(d) = dec_part {
        out.push('.');
        out.push_str(d);
    }
    out
}

/// 币种符号映射
pub fn currency_symbol(currency: &str) -> &'static str {
    match currency {
        "EUR" => "€",
        "GBP" => "£",
        "RMB" | "CNY" => "¥",
        _ => "$",
    }
}

/// 金额格式化（符号前缀 + 千分位两位小数）：-12.5 USD → "$-12.50"
pub fn format_amount(value: f64, currency: &str) -> String {
    format!("{}{}", currency_symbol(currency), format_thousands(value, 2))
}

// ---------------------------------------------------------------------------
// 公式引擎 · 校验
// ---------------------------------------------------------------------------

/// 单元格录入规则（集中定义可测试）
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CellRule {
    /// 自由文本（不做校验）
    Text,
    /// 数值：required=必填（空即错）；min/max 闭区间界
    Number {
        required: bool,
        min: Option<f64>,
        max: Option<f64>,
    },
}

impl CellRule {
    /// 数值规则便捷构造（必填、无界）
    pub const fn required_number() -> Self {
        CellRule::Number { required: true, min: None, max: None }
    }
}

/// 校验单个单元格（纯函数）：Ok(解析值) / Err(错误摘要文案)。
/// 错误文案面向底部错误摘要栏，保持「字段语义 + 原因」两段式。
pub fn validate_cell(field_label: &str, rule: &CellRule, raw: &str) -> Result<f64, String> {
    match rule {
        CellRule::Text => Ok(0.0),
        CellRule::Number { required, min, max } => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return if *required {
                    Err(format!("{field_label}：必填，请填写数值"))
                } else {
                    Ok(0.0)
                };
            }
            match parse_number(trimmed) {
                None => Err(format!("{field_label}：「{trimmed}」不是有效数值")),
                Some(v) => {
                    if let Some(lo) = min {
                        if v < *lo {
                            return Err(format!(
                                "{field_label}：不能小于 {}",
                                format_thousands(*lo, 2)
                            ));
                        }
                    }
                    if let Some(hi) = max {
                        if v > *hi {
                            return Err(format!(
                                "{field_label}：不能大于 {}",
                                format_thousands(*hi, 2)
                            ));
                        }
                    }
                    Ok(v)
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 公式引擎 · 声明式派生行（改任一输入即时重算的载体）
// ---------------------------------------------------------------------------

/// 矩阵列定义
#[derive(Debug, Clone, Copy)]
pub struct SheetColumn {
    pub key: &'static str,
    pub label: &'static str,
    /// 固定宽（None = flex 弹性）
    pub width: Option<f32>,
    /// 数值列（右对齐 + mono）
    pub numeric: bool,
}

impl SheetColumn {
    pub const fn new(key: &'static str, label: &'static str, numeric: bool) -> Self {
        SheetColumn { key, label, width: None, numeric }
    }

    pub const fn fixed(mut self, px_width: f32) -> Self {
        self.width = Some(px_width);
        self
    }
}

/// 矩阵单元格数据（只读形态；可编辑格由宿主注入 Input 实体）
#[derive(Debug, Clone, Default)]
pub struct SheetCellData {
    pub text: String,
    /// 计算单元格（只读、弱化底色、mono）
    pub computed: bool,
    /// 校验失败态（红框 + 红字）
    pub error: bool,
    /// 数值格（右对齐 + mono 等宽）
    pub numeric: bool,
}

impl SheetCellData {
    pub fn text(text: impl Into<String>) -> Self {
        SheetCellData { text: text.into(), ..Default::default() }
    }

    pub fn computed(text: impl Into<String>) -> Self {
        SheetCellData { text: text.into(), computed: true, numeric: true, ..Default::default() }
    }

    pub fn number(text: impl Into<String>) -> Self {
        SheetCellData { text: text.into(), numeric: true, ..Default::default() }
    }

    pub fn with_error(mut self) -> Self {
        self.error = true;
        self
    }
}

// ---------------------------------------------------------------------------
// 键盘导航（纯函数）
// ---------------------------------------------------------------------------

/// 选中格坐标（行优先）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SheetSelection {
    pub row: usize,
    pub col: usize,
}

/// 导航步进方向（Tab/Shift+Tab 环绕；方向键边界截停）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavStep {
    Up,
    Down,
    Left,
    Right,
    /// Tab：先行后列环绕
    Next,
    /// Shift+Tab：逆序环绕
    Prev,
}

/// 由当前选中格推导下一格（纯函数）。rows/cols 为 0 时返回 None（空表无导航）。
pub fn move_selection(
    rows: usize,
    cols: usize,
    sel: SheetSelection,
    step: NavStep,
) -> Option<SheetSelection> {
    if rows == 0 || cols == 0 {
        return None;
    }
    let clamped = SheetSelection {
        row: sel.row.min(rows - 1),
        col: sel.col.min(cols - 1),
    };
    let next = match step {
        NavStep::Up => {
            if clamped.row == 0 {
                return None;
            }
            SheetSelection { row: clamped.row - 1, ..clamped }
        }
        NavStep::Down => {
            if clamped.row + 1 >= rows {
                return None;
            }
            SheetSelection { row: clamped.row + 1, ..clamped }
        }
        NavStep::Left => {
            if clamped.col == 0 {
                return None;
            }
            SheetSelection { col: clamped.col - 1, ..clamped }
        }
        NavStep::Right => {
            if clamped.col + 1 >= cols {
                return None;
            }
            SheetSelection { col: clamped.col + 1, ..clamped }
        }
        NavStep::Next => {
            let flat = clamped.row * cols + clamped.col;
            let next_flat = (flat + 1) % (rows * cols);
            SheetSelection { row: next_flat / cols, col: next_flat % cols }
        }
        NavStep::Prev => {
            let flat = clamped.row * cols + clamped.col;
            let prev_flat = (flat + rows * cols - 1) % (rows * cols);
            SheetSelection { row: prev_flat / cols, col: prev_flat % cols }
        }
    };
    Some(next)
}

// ---------------------------------------------------------------------------
// 页面壳
// ---------------------------------------------------------------------------

/// Pattern D 页面骨架：页头 + 工具栏（36px 密度带）+ 站点卡片选择器行 +
/// 矩阵主体（flex-1）。容器外 padding 0、区间 1px 分隔线；内容全部宿主注入。
pub fn pattern_d_shell(
    theme: &AppTheme,
    id: &'static str,
    header: impl IntoElement,
    toolbar: impl IntoElement,
    show_sites: bool,
    sites: impl IntoElement,
    body: impl IntoElement,
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
                .h(px(crate::widgets::data_grid::FILTER_TOOLBAR_HEIGHT))
                .px_2()
                .gap_2()
                .items_center()
                .bg(theme.panel_bg)
                .border_b_1()
                .border_color(theme.separator)
                .child(toolbar),
        )
        .when(show_sites, |shell| {
            shell.child(
                h_flex()
                    .id(SharedString::from(format!("{id}-sites")))
                    .w_full()
                    .flex_none()
                    .min_h_0()
                    .gap_2()
                    .px_2()
                    .py_2()
                    .bg(theme.panel_bg)
                    .border_b_1()
                    .border_color(theme.separator)
                    .overflow_x_scroll()
                    .child(sites),
            )
        })
        .child(
            div()
                .id(SharedString::from(format!("{id}-body")))
                .flex_1()
                .min_h_0()
                .w_full()
                .overflow_hidden()
                .child(body),
        )
}

// ---------------------------------------------------------------------------
// 站点卡片选择器
// ---------------------------------------------------------------------------

/// 币种 & VAT 站点卡片选择器：遍历 [`SITES`]，选中卡 accent 描边 + hover 底。
/// 回调签名对齐 pattern_b `tab_bar`（view 实体 + 静态站点码 + ctx）。
pub fn site_card_selector<V: 'static>(
    view: &Entity<V>,
    theme: &AppTheme,
    id: &'static str,
    active_code: &str,
    on_select: impl Fn(&mut V, &'static str, &mut Context<V>) + Clone + 'static,
) -> gpui::Stateful<gpui::Div> {
    let mut row = h_flex().id(id).w_full().gap_2();
    for site in SITES {
        let selected = site.code == active_code;
        let view = view.clone();
        let on_select = on_select.clone();
        let card_id = SharedString::from(format!("{id}-card-{}", site.code.to_lowercase()));
        let summary = if site.vat_rate_pct > 0.0 {
            format!("{} · VAT {:.0}%", site.currency, site.vat_rate_pct)
        } else {
            format!("{} · 免税(平台代扣)", site.currency)
        };
        row = row.child(
            v_flex()
                .id(card_id)
                .w(px(SITE_CARD_WIDTH))
                .h(px(SITE_CARD_HEIGHT))
                .flex_none()
                .justify_center()
                .gap_0p5()
                .px_2()
                .rounded(px(theme.radius))
                .cursor_pointer()
                .border_1()
                .when(selected, |el| {
                    el.border_color(theme.accent).bg(theme.sidebar_item_active_bg)
                })
                .when(!selected, |el| {
                    el.border_color(theme.separator)
                        .bg(theme.card_bg)
                        .hover(|el| el.bg(theme.table_row_hover))
                })
                .on_click(move |_, _window, cx| {
                    let view = view.clone();
                    view.update(cx, |this, cx| on_select(this, site.code, cx));
                })
                .child(
                    h_flex()
                        .gap_1()
                        .items_center()
                        .child(div().text_size(px(FONT_BASE)).child(site.flag))
                        .child(
                            div()
                                .text_size(px(FONT_XS))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(if selected {
                                    theme.text_primary
                                } else {
                                    theme.text_secondary
                                })
                                .child(site.label),
                        ),
                )
                .child(
                    div()
                        .text_size(px(FONT_XS))
                        .mono_tabular_nums()
                        .text_color(theme.text_muted)
                        .child(summary),
                ),
        );
    }
    row
}

// ---------------------------------------------------------------------------
// sheet 矩阵渲染（只读形态 + 可编辑格框）
// ---------------------------------------------------------------------------

/// 表头行（28px；列定义驱动）
pub fn sheet_header_row(theme: &AppTheme, cols: &[SheetColumn]) -> impl IntoElement {
    let mut row = h_flex()
        .id("pd-sheet-header")
        .w_full()
        .flex_none()
        .h(px(HEADER_HEIGHT))
        .border_b_1()
        .border_color(theme.separator)
        .bg(theme.muted_fill);
    for (i, col) in cols.iter().enumerate() {
        row = row.child(
            div()
                .id(SharedString::from(format!("pd-hd-{i}")))
                .when_some(col.width, |el, w| el.w(px(w)).flex_none())
                .when(col.width.is_none(), |el| el.flex_1().min_w_0())
                .h_full()
                .flex()
                .items_center()
                .px_2()
                .text_size(px(FONT_XS))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_muted)
                .when(col.numeric, |el| el.justify_end())
                .child(col.label),
        );
    }
    row
}

/// 数据行（26px；cells 与 cols 一一对应，长度不一致时以短者为准）
pub fn sheet_data_row(
    theme: &AppTheme,
    id_prefix: &'static str,
    row_index: usize,
    cols: &[SheetColumn],
    cells: &[SheetCellData],
) -> impl IntoElement {
    let striped = row_index % 2 == 1;
    let mut row = h_flex()
        .id(SharedString::from(format!("{id_prefix}-row-{row_index}")))
        .w_full()
        .flex_none()
        .min_h(px(CELL_HEIGHT))
        .border_b_1()
        .border_color(theme.separator)
        .when(striped, |el| el.bg(theme.table_row_stripe));
    for (i, col) in cols.iter().enumerate() {
        let Some(cell) = cells.get(i) else { break };
        row = row.child(computed_cell(
            theme,
            SharedString::from(format!("{id_prefix}-c-{row_index}-{i}")),
            col.width,
            cell.clone(),
        ));
    }
    row
}

/// 可编辑格框（宿主把 `Input` 塞进 frame；frame 负责 26px 高密度与错误红框）。
pub fn editable_cell_frame(
    theme: &AppTheme,
    id: impl Into<gpui::ElementId>,
    width: Option<f32>,
    error: bool,
    input: impl IntoElement,
) -> gpui::Stateful<gpui::Div> {
    h_flex()
        .id(id)
        .when_some(width, |el, w| el.w(px(w)).flex_none())
        .when(width.is_none(), |el| el.flex_1().min_w_0())
        .min_h(px(CELL_HEIGHT))
        .items_center()
        .px_1()
        .py_0p5()
        .border_1()
        .rounded_sm()
        .when(error, |el| {
            el.border_color(theme.danger).bg(theme.danger.opacity(0.08))
        })
        .when(!error, |el| el.border_color(gpui::transparent_black()))
        .child(input)
}

/// 只读单元格（文本 / 数值 / 计算格三态）
pub fn computed_cell(
    theme: &AppTheme,
    id: impl Into<gpui::ElementId>,
    width: Option<f32>,
    cell: SheetCellData,
) -> gpui::Stateful<gpui::Div> {
    let text_color = if cell.error {
        theme.danger
    } else if cell.computed {
        theme.text_primary
    } else {
        theme.text_secondary
    };
    h_flex()
        .id(id)
        .when_some(width, |el, w| el.w(px(w)).flex_none())
        .when(width.is_none(), |el| el.flex_1().min_w_0())
        .min_h(px(CELL_HEIGHT))
        .items_center()
        .px_2()
        .rounded_sm()
        .when(cell.computed && !cell.error, |el| el.bg(theme.muted_fill.opacity(0.5)))
        .when(cell.numeric, |el| el.justify_end())
        .child(
            div()
                .min_w_0()
                .truncate()
                .text_size(px(FONT_BASE))
                .when(cell.numeric, |el| el.mono_tabular_nums())
                .font_weight(if cell.computed { FontWeight::SEMIBOLD } else { FontWeight::NORMAL })
                .text_color(text_color)
                .child(cell.text),
        )
}

/// 只读矩阵（列表头 + 数据行集合；财务月报等展示页的只读形态出口）。
pub fn sheet_matrix(
    theme: &AppTheme,
    id: &'static str,
    cols: &[SheetColumn],
    rows: &[Vec<SheetCellData>],
    error_summary: Option<&str>,
) -> impl IntoElement {
    let mut sheet = v_flex()
        .id(id)
        .w_full()
        .min_h_0()
        .overflow_y_scroll()
        .border_1()
        .rounded(px(theme.radius))
        .border_color(theme.separator)
        .bg(theme.card_bg)
        .child(sheet_header_row(theme, cols));
    for (r, cells) in rows.iter().enumerate() {
        sheet = sheet.child(sheet_data_row(theme, id, r, cols, cells));
    }
    if let Some(summary) = error_summary {
        sheet = sheet.child(
            h_flex()
                .id("pd-sheet-error-summary")
                .w_full()
                .flex_none()
                .min_h(px(CELL_HEIGHT))
                .items_center()
                .px_2()
                .gap_1()
                .bg(theme.danger.opacity(0.10))
                .border_t_1()
                .border_color(theme.danger)
                .child(
                    div()
                        .text_size(px(FONT_XS))
                        .text_color(theme.danger)
                        .child(summary.to_string()),
                ),
        );
    }
    sheet
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 契约：密度规格对齐父 issue Pattern D 条目
    #[test]
    fn dense_metrics_contract() {
        assert_eq!(CELL_HEIGHT, 26.0, "单元格 24~28px 规格中点");
        assert_eq!(HEADER_HEIGHT, 28.0, "表头 28px 密度带");
        assert!((24.0..=28.0).contains(&CELL_HEIGHT));
        assert_eq!(SITE_CARD_HEIGHT, 44.0);
    }

    #[test]
    fn parse_number_tolerates_currency_and_thousands() {
        assert_eq!(parse_number("1,234.5"), Some(1234.5));
        assert_eq!(parse_number("$1,234"), Some(1234.0));
        assert_eq!(parse_number("€ 99,90"), Some(99.9), "欧式小数逗号（1~2 位尾组）");
        assert_eq!(parse_number("1,234"), Some(1234.0), "3 位尾组按千分位");
        assert_eq!(parse_number("99.90 EUR"), Some(99.9));
        assert_eq!(parse_number("usd12"), Some(12.0));
        assert_eq!(parse_number("＄１２３"), None, "全角数字不支持——显式拒绝");
        assert_eq!(parse_number("(42)"), Some(-42.0), "括号负数");
        assert_eq!(parse_number("-7"), Some(-7.0));
        assert_eq!(parse_number("  "), None, "空白 = 未填");
        assert_eq!(parse_number(""), None);
        assert_eq!(parse_number("RMB"), None);
        assert_eq!(parse_rate("12%"), parse_rate("12"));
    }

    #[test]
    fn parse_rate_and_format_roundtrip() {
        assert_eq!(parse_rate("12"), Some(0.12));
        assert_eq!(parse_rate("12%"), Some(0.12));
        assert_eq!(parse_rate(""), None);
        assert_eq!(format_rate(0.12), "12%");
        assert_eq!(format_rate(0.126), "12.6%");
        assert_eq!(format_rate(1.0), "100%");
    }

    #[test]
    fn thousands_format_groups_and_signs() {
        assert_eq!(format_thousands(1234567.891, 2), "1,234,567.89");
        assert_eq!(format_thousands(0.5, 2), "0.50");
        assert_eq!(format_thousands(-1234.0, 2), "-1,234.00");
        assert_eq!(format_thousands(100.0, 0), "100");
    }

    #[test]
    fn amount_formats_by_currency() {
        assert_eq!(format_amount(12.5, "USD"), "$12.50");
        assert_eq!(format_amount(12.5, "EUR"), "€12.50");
        assert_eq!(format_amount(12.5, "GBP"), "£12.50");
        assert_eq!(format_amount(12.5, "RMB"), "¥12.50");
    }

    #[test]
    fn validate_cell_rules() {
        let rule = CellRule::required_number();
        assert_eq!(validate_cell("售价", &rule, "12.5"), Ok(12.5));
        assert_eq!(validate_cell("售价", &rule, "$1,000"), Ok(1000.0));
        assert!(validate_cell("售价", &rule, "").is_err(), "必填空值报错");
        assert!(validate_cell("售价", &rule, "abc").is_err());
        let bounded = CellRule::Number { required: false, min: Some(0.0), max: Some(100.0) };
        assert_eq!(validate_cell("费率", &bounded, ""), Ok(0.0), "非必填空值放行");
        assert!(validate_cell("费率", &bounded, "-1").is_err(), "越下界报错");
        assert!(validate_cell("费率", &bounded, "101").is_err(), "越上界报错");
        assert!(validate_cell("名称", &CellRule::Text, "").is_ok());
    }

    #[test]
    fn move_selection_walks_and_wraps() {
        let start = SheetSelection { row: 0, col: 0 };
        // 方向键边界截停
        assert_eq!(move_selection(3, 2, start, NavStep::Up), None, "顶行向上不动 → None");
        assert_eq!(
            move_selection(3, 2, start, NavStep::Left),
            None,
            "首列向左不动 → None"
        );
        assert_eq!(
            move_selection(3, 2, start, NavStep::Down),
            Some(SheetSelection { row: 1, col: 0 })
        );
        assert_eq!(
            move_selection(3, 2, start, NavStep::Right),
            Some(SheetSelection { row: 0, col: 1 })
        );
        // Tab 在末格环绕回首格
        let last = SheetSelection { row: 2, col: 1 };
        assert_eq!(
            move_selection(3, 2, last, NavStep::Next),
            Some(SheetSelection { row: 0, col: 0 })
        );
        assert_eq!(
            move_selection(3, 2, start, NavStep::Prev),
            Some(SheetSelection { row: 2, col: 1 })
        );
        // 越界选中先 clamp 再走
        assert_eq!(
            move_selection(3, 2, SheetSelection { row: 9, col: 9 }, NavStep::Up),
            Some(SheetSelection { row: 1, col: 1 })
        );
        // 边界截停：底行向下 / 末列向右 → None
        let bottom_right = SheetSelection { row: 2, col: 1 };
        assert_eq!(move_selection(3, 2, bottom_right, NavStep::Down), None);
        assert_eq!(move_selection(3, 2, bottom_right, NavStep::Right), None);
        // 空表无导航
        assert_eq!(move_selection(0, 2, start, NavStep::Next), None);
    }

    #[test]
    fn site_lookup_defaults_to_us() {
        assert_eq!(site_for("DE").currency, "EUR");
        assert_eq!(site_for("UK").vat_rate_pct, 20.0);
        assert_eq!(site_for("XX"), &SITES[0], "未知码回落 US");
        // 站点卡摘要含税率的可读性兜底：US 免税、EU 有税
        assert_eq!(SITES[0].vat_rate_pct, 0.0);
    }

    // ---------- 渲染冒烟 ----------

    struct ShellHost {
        active: &'static str,
    }

    impl gpui::Render for ShellHost {
        fn render(&mut self, _window: &mut gpui::Window, cx: &mut Context<Self>) -> impl IntoElement {
            let theme = AppTheme::current(cx);
            let view = cx.entity();
            let cols = [
                SheetColumn::new("item", "项目", false),
                SheetColumn::new("amount", "金额", true).fixed(120.0),
            ];
            let rows = vec![
                vec![
                    SheetCellData::text("售价"),
                    SheetCellData::number("$29.99"),
                ],
                vec![
                    SheetCellData::text("利润率"),
                    SheetCellData::computed("18.2%"),
                ],
            ];
            let sites = site_card_selector(&view, &theme, "host-sites", self.active, |_, _, _| {});
            pattern_d_shell(
                &theme,
                "host-canvas",
                div().child("header"),
                div().child("toolbar"),
                true,
                sites,
                sheet_matrix(&theme, "host-sheet", &cols, &rows, Some("售价：必填，请填写数值")),
            )
        }
    }

    #[gpui::test]
    async fn shell_renders_dark_with_each_site_active(cx: &mut gpui::TestAppContext) {
        for site in SITES {
            cx.update(|cx| {
                gpui_component::init(cx);
                crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
            });
            cx.add_window_view(|_window, _cx| ShellHost { active: site.code });
        }
    }
}
