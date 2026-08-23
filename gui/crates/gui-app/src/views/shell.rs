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
/// 本期为空面板占位；Stage5 实装 Cmd+B 自适应抽屉与拖拽调宽。
pub const INSPECTOR_WIDTH: f32 = 300.0;

/// 全局 Footer 状态栏高度（规格固定 24px）。
///
/// 本期为空面板占位；Stage6 实装汇率 ticker / 同步状态 / 通知徽标。
pub const FOOTER_HEIGHT: f32 = 24.0;

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
        assert_eq!(FOOTER_HEIGHT, 24.0, "Footer 固定 24px");
    }
}
