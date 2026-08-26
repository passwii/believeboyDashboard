//! 应用外壳六区栅格常量（BLF-793，父 issue「空间栅格」节）
//!
//! 主窗口 root 布局 = 零外边距平铺六区：
//!
//! ```text
//! ┌────┬──────────┬────────────────────┬───────────┐
//! │Rail│ Sub-Nav  │ Console Bar (36px) │ Inspector │
//! │48  │          ├────────────────────┤  (300)    │
//! │px  │          │ Canvas (flex-1)    │           │
//! ├────┴──────────┴────────────────────┴───────────┤
//! │ Footer (24px)                                   │
//! └─────────────────────────────────────────────────┘
//! ```
//!
//! 容器外 padding 0；区间层级一律靠 1px [`crate::theme::BORDER_SEPARATOR`]
//! 边界表达（无重投影）。全部区宽/区高常量集中在本模块管理——后续阶段
//! （Stage3 折叠 / Stage5 拖拽调宽 / Stage6 Footer）只改这里，不散落视图。

/// Master Rail 主图标栏宽度（规格 48~52px）
pub const RAIL_WIDTH: f32 = 48.0;

/// Sub-Nav 子导航列基准宽度（规格 180~220px）。
///
/// BLF-794 起 Sub-Nav 实装为可折叠模块选择器：实际展开宽度按内容自适应
/// （`sub_nav::fit_width`，以本常量为缺省基准），折叠至 0；本常量保留为
/// 布局契约锚点（shell 尺寸回归锁 + 动画起点初值）。
pub const SUB_NAV_WIDTH: f32 = 200.0;

/// 顶部 Console Bar 控制条高度（规格固定 36px）。
///
/// 本期插槽由内容区头部 chrome（面包屑 + 用户/退出 + 窗口拖拽区）占位，
/// Stage4 换成四件套筛选条组件。
pub const CONSOLE_BAR_HEIGHT: f32 = 36.0;

/// 右侧 Inspector 插槽宽度（规格 280~340px 可调，默认值）。
///
/// BLF-796 起实装 Cmd+B 自适应抽屉：实际宽度可拖拽（[`INSPECTOR_WIDTH_MIN`]
/// ~ [`INSPECTOR_WIDTH_MAX`] 区间）并持久化，本常量保留为默认宽度锚点。
pub const INSPECTOR_WIDTH: f32 = 300.0;

/// Inspector 拖拽调宽下限（父 issue「空间栅格」规格）
pub const INSPECTOR_WIDTH_MIN: f32 = 280.0;

/// Inspector 拖拽调宽上限
pub const INSPECTOR_WIDTH_MAX: f32 = 340.0;

/// 全局 Footer 状态栏高度（规格固定 24px）。
///
/// 本期为空面板占位；Stage6 实装汇率 ticker / 同步状态 / 通知徽标。
pub const FOOTER_HEIGHT: f32 = 24.0;

// ---------------------------------------------------------------------------
// BLF-831：布局弹性断点（P4 窄窗折行 / Inspector 最小宽度）
// ---------------------------------------------------------------------------

/// Canvas 最小可读宽度（px）：Pattern A 大表「主键 + 核心金额列组」的
/// 底线。Inspector 弹性压缩与列优先级隐藏都为保住这条底线服务。
pub const CANVAS_MIN_READABLE: f32 = 420.0;

/// Console Bar 折行档位纯函数（BLF-831 P4-1）：按 Canvas 可用宽度给出档位。
/// （消费方直接 `use crate::widgets::console_bar::...`；bin crate 无外部
/// 再导出需求，pub use 会触发 unused_imports）
/// Inspector 弹性宽度纯函数（BLF-831 P4-2）。
///
/// 输入窗口宽 / 左侧占用 / 用户设定宽 / 是否展开，输出本帧实际宽度：
/// - 收起 → `Some(0)`（不参与弹性计算）
/// - 宽敞 → `Some(用户宽)`（原样生效）
/// - Canvas 被压到 [`CANVAS_MIN_READABLE`] 以下 → 向下压缩到恰好满足底线
///   （不低于 [`INSPECTOR_WIDTH_MIN`]，只压不放）
/// - 连压缩到 [`INSPECTOR_WIDTH_MIN`] 后仍击穿底线 → `None`（调用方临时收起）
pub fn inspector_effective_width(
    window_width: f32,
    left_occupied: f32,
    user_width: f32,
    visible: bool,
) -> Option<f32> {
    if !visible {
        return Some(0.0);
    }
    let usable = (window_width - left_occupied).max(0.0);
    // 连 Inspector 下限都放不下：Canvas 底线被击穿 → 自动收起
    if usable - INSPECTOR_WIDTH_MIN < CANVAS_MIN_READABLE {
        return None;
    }
    let compressed = usable - CANVAS_MIN_READABLE;
    if user_width > compressed && compressed >= INSPECTOR_WIDTH_MIN {
        Some(compressed)
    } else {
        Some(user_width.clamp(INSPECTOR_WIDTH_MIN, INSPECTOR_WIDTH_MAX))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// BLF-793 契约：六区尺寸必须落在父 issue「空间栅格」规格区间内。
    #[test]
    fn shell_zone_dimensions_match_spec() {
        assert!(
            (48.0..=52.0).contains(&RAIL_WIDTH),
            "Master Rail 宽度必须在 48~52px，实际 {RAIL_WIDTH}"
        );
        assert_eq!(CONSOLE_BAR_HEIGHT, 36.0, "Console Bar 固定 36px");
        assert!(
            (180.0..=220.0).contains(&SUB_NAV_WIDTH),
            "Sub-Nav 目标宽度必须在 180~220px，实际 {SUB_NAV_WIDTH}"
        );
        assert!(
            (280.0..=340.0).contains(&INSPECTOR_WIDTH),
            "Inspector 宽度必须在 280~340px，实际 {INSPECTOR_WIDTH}"
        );
        assert_eq!(INSPECTOR_WIDTH_MIN, 280.0, "Inspector 调宽下限 280px");
        assert_eq!(INSPECTOR_WIDTH_MAX, 340.0, "Inspector 调宽上限 340px");
        assert_eq!(FOOTER_HEIGHT, 24.0, "Footer 固定 24px");
    }
}

/// BLF-831：布局弹性断点契约锁（独立模块，避免与既有 tests 模块交叉）。
#[cfg(test)]
mod blf831_tests {
    use super::*;

    // ------------------------------------------------------------------
    // BLF-831：布局弹性断点（P4 窄窗折行 / Inspector 最小宽度 / 列优先级）
    // ------------------------------------------------------------------

    use crate::widgets::console_bar::{
        console_bar_mode_for_space, ConsoleBarMode, CONSOLE_BAR_SPACE_COMPACT,
    };

    /// Console Bar 折行契约·全量档：宽窗下四件套全部直出。
    #[test]
    fn console_bar_mode_full_when_space_is_plenty() {
        assert_eq!(console_bar_mode_for_space(1200.0), ConsoleBarMode::Full);
    }

    /// Console Bar 折行契约·收纳档：统计 pill 是最低频信息 → 第一个收进
    /// 溢出菜单（数据在页面内仍可见，控制条只留筛选控件）。
    #[test]
    fn console_bar_mode_compact_hides_stat_pills_first() {
        let mode = console_bar_mode_for_space(820.0);
        assert!(
            matches!(mode, ConsoleBarMode::Compact { hide_stats: true }),
            "中等空间先收统计 pill，实际 {mode:?}"
        );
    }

    /// Console Bar 折行契约·极窄档：站点选择器也收进溢出菜单——
    /// 项目/日期是最高频筛选，必须始终保留为一级控件。
    #[test]
    fn console_bar_mode_minimal_keeps_project_and_date_only() {
        let mode = console_bar_mode_for_space(CONSOLE_BAR_SPACE_COMPACT - 10.0);
        assert!(
            matches!(mode, ConsoleBarMode::Minimal { hide_stats: true }),
            "贴地板空间收站点选择器，实际 {mode:?}"
        );
    }

    /// Console Bar 折行契约·地板保护：可用空间低于
    /// [`CONSOLE_BAR_SPACE_COMPACT`] 时不再进一步收纳（项目 + 日期 + ⋯ 是
    /// 不可再折的底线组合），溢出由外层 overflow_hidden 兜底。
    #[test]
    fn console_bar_mode_floors_at_minimal() {
        for space in [CONSOLE_BAR_SPACE_COMPACT - 100.0, 0.0] {
            let mode = console_bar_mode_for_space(space);
            assert!(
                matches!(mode, ConsoleBarMode::Minimal { .. }),
                "空间 {space}px 必须停在 Minimal 档，实际 {mode:?}"
            );
        }
    }

    /// Console Bar 折行契约·阈值单调性：可用空间越大档位只升不降
    /// （Full ⊃ Compact ⊃ Minimal 的包含关系）。
    #[test]
    fn console_bar_mode_is_monotonic_in_space() {
        let mut prev = (console_bar_mode_for_space(0.0), rank_of(0.0));
        for step in (1..=240).map(|i| i as f32 * 5.0) {
            let mode = console_bar_mode_for_space(step);
            if mode != prev.0 {
                assert!(
                    rank_of(step) > prev.1,
                    "空间 {step}px 处档位回退：{prev:?} → {mode:?}"
                );
                prev = (mode, rank_of(step));
            }
        }
    }

    /// 档位序数（单调性测试用；Full=2 ⊃ Compact=1 ⊃ Minimal=0）。
    fn rank_at(space: f32) -> u8 {
        match console_bar_mode_for_space(space) {
            ConsoleBarMode::Minimal { .. } => 0,
            ConsoleBarMode::Compact { .. } => 1,
            ConsoleBarMode::Full => 2,
        }
    }

    /// 包装（rank_of 别名，保持测试主体可读）。
    fn rank_of(space: f32) -> u8 {
        rank_at(space)
    }

    /// Inspector 弹性宽度契约·宽窗：可用空间充足时保持用户设定宽度
    /// （拖拽调宽 / 偏好恢复的值原样生效）。
    #[test]
    fn inspector_effective_width_keeps_user_width_when_space_allows() {
        let left = RAIL_WIDTH + SUB_NAV_WIDTH; // ~248px
        assert_eq!(
            inspector_effective_width(1280.0, left, 320.0, true),
            Some(320.0),
            "宽窗下用户宽度原样生效"
        );
    }

    /// Inspector 弹性宽度契约·最小窗口即进入压缩带：960 宽下
    /// （Rail+Sub-Nav 展开）用户上限 340 会把 Canvas 压到 420 以下 →
    /// 压缩到恰好满足底线（292 ≥ Inspector 下限 280 合法）。
    #[test]
    fn inspector_effective_width_compresses_at_min_window() {
        let left = RAIL_WIDTH + SUB_NAV_WIDTH;
        assert_eq!(
            inspector_effective_width(960.0, left, 340.0, true),
            Some(292.0),
            "最小窗口下压缩到 Canvas 底线恰好满足"
        );
    }

    /// Inspector 弹性宽度契约·压缩带：Canvas 可读底线优先于用户宽度，
    /// 但只压不放、不低于 Inspector 自身下限。
    #[test]
    fn inspector_effective_width_compresses_to_protect_canvas() {
        let left = RAIL_WIDTH + SUB_NAV_WIDTH;
        // Sub-Nav 折叠（left≈48）：usable=952 → 压缩目标 532 > 340 → 用户宽原样
        assert_eq!(
            inspector_effective_width(1000.0, RAIL_WIDTH, 340.0, true),
            Some(340.0)
        );
        // 展开态：usable=752 → 理论压到 332（≥280）→ 生效
        assert_eq!(
            inspector_effective_width(1000.0, left, 340.0, true),
            Some(332.0)
        );
        // 只压不放：用户手动收窄到 300 时压缩目标 332 不生效
        assert_eq!(
            inspector_effective_width(1000.0, left, 300.0, true),
            Some(300.0)
        );
    }

    /// Inspector 弹性宽度契约·自动收起：可用空间连「Inspector 下限 +
    /// Canvas 底线」都放不下（usable < 700）→ None，调用方临时收起抽屉。
    #[test]
    fn inspector_effective_width_none_when_floor_cannot_hold() {
        // window=940 展开态：usable=692 < 700 → 收起（与压缩带边界衔接）
        assert_eq!(
            inspector_effective_width(940.0, RAIL_WIDTH + SUB_NAV_WIDTH, 340.0, true),
            None,
            "usable < INSPECTOR_WIDTH_MIN + CANVAS_MIN_READABLE 必须自动收起"
        );
        // 极端：无侧栏占用、窗口 660 同样击穿底线
        assert_eq!(
            inspector_effective_width(660.0, 0.0, 340.0, true),
            None,
            "left=0 且窗口 660：660-420=240 < 280 → 必须自动收起"
        );
    }

    /// Inspector 弹性宽度契约·收起态恒零宽（不参与弹性计算）。
    #[test]
    fn inspector_effective_width_zero_when_collapsed_or_unregistered() {
        let left = RAIL_WIDTH + SUB_NAV_WIDTH;
        assert_eq!(
            inspector_effective_width(1280.0, left, 300.0, false),
            Some(0.0)
        );
    }

    /// Canvas 可读底线契约：420px 是 Pattern A 大表「主键 + 核心金额列组」的
    /// 最小可读宽度（与列优先级联动：窄窗先隐藏次要列、再压 Inspector）。
    #[test]
    fn canvas_min_readable_constant_is_locked() {
        assert_eq!(CANVAS_MIN_READABLE, 420.0);
    }

    /// 大表列优先级契约·遮罩生成：budget 从右往左牺牲次要列，
    /// 主键/金额列（Primary）永远保留；全 Primary 时任何 budget 都全可见。
    #[test]
    fn column_visibility_mask_hides_secondary_from_right() {
        use crate::widgets::data_table::{column_visibility_mask, ColumnPriority};

        let priorities = [
            ColumnPriority::Primary,
            ColumnPriority::Secondary,
            ColumnPriority::Secondary,
            ColumnPriority::Primary,
            ColumnPriority::Secondary,
        ];
        assert_eq!(
            column_visibility_mask(&priorities, 3),
            vec![true, true, true, true, true]
        );
        // 收 1 列：最右的 Secondary（ix=4）
        assert_eq!(
            column_visibility_mask(&priorities, 2),
            vec![true, true, true, true, false]
        );
        // 收 2 列：Secondary ix=4、ix=2
        assert_eq!(
            column_visibility_mask(&priorities, 1),
            vec![true, true, false, true, false]
        );
        // 收到底：只剩两个 Primary
        assert_eq!(
            column_visibility_mask(&priorities, 0),
            vec![true, false, false, true, false]
        );
    }

    /// 大表列优先级契约·Primary 不可牺牲：全 Primary 表格不允许任何隐藏。
    #[test]
    fn column_visibility_mask_never_hides_primary() {
        use crate::widgets::data_table::{column_visibility_mask, ColumnPriority};
        let all_primary = [ColumnPriority::Primary; 4];
        assert_eq!(
            column_visibility_mask(&all_primary, 0),
            vec![true, true, true, true],
            "全 Primary 表格不允许任何隐藏"
        );
    }

    /// 大表列优先级契约·budget 即允许保留的 Secondary 列数
    /// （超出的从右往左全隐；Primary 不占预算、永不隐）。
    #[test]
    fn column_visibility_mask_budget_is_visible_count() {
        use crate::widgets::data_table::{column_visibility_mask, ColumnPriority};
        let mixed = [
            ColumnPriority::Secondary,
            ColumnPriority::Primary,
            ColumnPriority::Secondary,
        ];
        // budget=1：从右往左牺牲，保留最左的 1 个 Secondary + Primary
        assert_eq!(column_visibility_mask(&mixed, 1), vec![true, true, false]);
    }
}
