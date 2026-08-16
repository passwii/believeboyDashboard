//! 布局系统工具（P4-5，BLF-760）
//!
//! 宽窗度量策略：超宽显示器上卡片 / 表单 / 图表内容一路拉伸会导致行宽过长、
//! 可读性下降，统一给上限宽度并居中（[`content_guard`]）；数据表格需要承载
//! 多列 + 横向滚动，保留全宽不包上限。策略常量见 [`crate::theme::CONTENT_MAX_WIDTH`]。

use gpui::{div, px, Div, Styled};

use crate::theme::CONTENT_MAX_WIDTH;

/// 内容上限容器：宽度跟随父级、上限 [`CONTENT_MAX_WIDTH`]、水平居中。
///
/// 用于页面头部 / 筛选栏 / 指标卡 / 图表卡 / 表单等非表格内容块；
/// 数据表格（DataTable）直接全宽渲染，不要用本容器包裹。
pub fn content_guard() -> Div {
    div().w_full().max_w(px(CONTENT_MAX_WIDTH)).mx_auto()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// P4-5 契约：content_guard 的样式 = 全宽 + 上限宽度 + 水平居中，
    /// 上限值来自 theme 常量（防止两处漂移）。
    #[test]
    fn content_guard_applies_max_width_and_centering() {
        let mut el = content_guard();
        let style = el.style();

        // 上限宽度 = CONTENT_MAX_WIDTH（绝对像素）
        match &style.max_size.width {
            Some(gpui::Length::Definite(gpui::DefiniteLength::Absolute(
                gpui::AbsoluteLength::Pixels(p),
            ))) => assert_eq!(f32::from(*p), CONTENT_MAX_WIDTH, "上限宽度必须取自 CONTENT_MAX_WIDTH"),
            other => panic!("content_guard 必须有绝对像素上限宽度，实际：{other:?}"),
        }

        // 水平居中：左右 margin 均为 auto
        assert!(
            matches!(style.margin.left, Some(gpui::Length::Auto)),
            "左边距必须 auto（居中）"
        );
        assert!(
            matches!(style.margin.right, Some(gpui::Length::Auto)),
            "右边距必须 auto（居中）"
        );
    }
}
