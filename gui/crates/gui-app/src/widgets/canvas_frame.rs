//! 布局弹性断点（BLF-831，父 issue「空间栅格」P4 收尾）
//!
//! 每帧画布度量快照（[`CanvasFrame`]）：RootView render 时写入窗口宽 /
//! 左侧占用 / Inspector 弹性宽度，下游 widget（Console Bar 折行、
//! DataGrid/DataTable 列优先级）在自身渲染帧内读取——GPUI 元素无法感知
//! 自身布局宽度，用帧内快照替代（单窗口应用，无多窗竞争；测试可直写）。
//!
//! 断点纯函数集中在 [`crate::views::shell`]（六区尺寸同一权威源）。

use std::cell::Cell;

/// 帧内画布度量快照。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CanvasFrame {
    /// 主窗口内容宽度（px）
    pub window_width: f32,
    /// Canvas 左侧占用（Rail + Sub-Nav 实际宽度之和）
    pub left_occupied: f32,
    /// 右侧 Inspector 本帧弹性宽度（收起 / 未注册形态为 0）
    pub inspector_width: f32,
}

thread_local! {
    static CURRENT: Cell<CanvasFrame> = const { Cell::new(CanvasFrame {
        window_width: f32::MAX,
        left_occupied: 0.0,
        inspector_width: 0.0,
    }) };
}

/// 写入本帧画布度量（RootView render 开头调用；测试可直写构造场景）。
pub fn set_frame(frame: CanvasFrame) {
    CURRENT.with(|c| c.set(frame));
}

/// 读取本帧画布度量（未写入时回落「无限宽」= 全量档位，宽窗行为不变）。
pub fn current_frame() -> CanvasFrame {
    CURRENT.with(Cell::get)
}

/// 本帧中央内容区可用宽度（窗口宽 − 左侧占用 − Inspector 弹性宽）。
///
/// Console Bar 折行档位与大表列优先级都以此为唯一宽度依据。
pub fn available_width() -> f32 {
    let f = current_frame();
    (f.window_width - f.left_occupied - f.inspector_width).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 快照读写契约：set 后 current 原样返回；available = 窗口−左占−Inspector。
    #[test]
    fn frame_roundtrip_and_available_math() {
        set_frame(CanvasFrame {
            window_width: 1280.0,
            left_occupied: 248.0,
            inspector_width: 320.0,
        });
        assert_eq!(available_width(), 712.0);
        set_frame(CanvasFrame {
            inspector_width: 0.0,
            ..current_frame()
        });
        assert_eq!(available_width(), 1032.0);
    }

    /// 负数防御：组件宽度之和超过窗口时可用宽度收敛 0（不产生负值档位）。
    #[test]
    fn available_width_never_negative() {
        set_frame(CanvasFrame {
            window_width: 500.0,
            left_occupied: 400.0,
            inspector_width: 300.0,
        });
        assert_eq!(available_width(), 0.0);
    }

    /// 未写入帧时回落无限宽（全量档位）：保证未接入 RootView 的调用点
    /// （单元测试 / 未来新入口）保持宽窗行为，不误触折行。
    #[test]
    fn default_frame_is_unbounded() {
        assert_eq!(current_frame().window_width, f32::MAX);
        assert_eq!(current_frame().inspector_width, 0.0);
        assert!(available_width() > 10_000.0);
    }
}
