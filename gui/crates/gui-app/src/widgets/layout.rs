//! 布局系统工具（P4-5，BLF-760；BLF-792 高密度化收敛）
//!
//! 宽窗度量策略（BLF-792 起变更）：高密度暗色工具主题要求**零外边距平铺**——
//! 原「内容上限 1440px + 居中」（CONTENT_MAX_WIDTH + mx_auto）已取消，
//! 主工作区全幅平铺，数据表格天然全宽。[`content_guard`] 保留为全宽透传壳
//! （全部业务视图的既有调用点无需改动），Stage2 外壳框架重构时移除调用点。

use gpui::{div, Div, Styled};

/// 内容容器：宽度跟随父级全幅平铺。
///
/// BLF-792：不再设上限宽度与水平居中（原 CONTENT_MAX_WIDTH=1440 机制移除）；
/// 数据表格（DataTable）同样全宽渲染。函数名保留至 Stage2 外壳重构。
pub fn content_guard() -> Div {
    div().w_full()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// BLF-792 契约：content_guard 必须是全宽透传——不设上限宽度、
    /// 不做水平居中（原 P4-5 的 1440px 居中 guard 已在高密度模式下取消）。
    #[test]
    fn content_guard_is_full_width_without_centering() {
        let mut el = content_guard();
        let style = el.style();

        // 无上限宽度（原 max_w(px(1440)) 已移除）
        assert!(
            style.max_size.width.is_none(),
            "content_guard 不得再设置上限宽度（高密度全幅平铺）"
        );

        // 无 auto 边距（原 mx_auto 居中已移除）
        assert!(
            !matches!(style.margin.left, Some(gpui::Length::Auto)),
            "左边距不得为 auto（取消居中）"
        );
        assert!(
            !matches!(style.margin.right, Some(gpui::Length::Auto)),
            "右边距不得为 auto（取消居中）"
        );
    }
}
