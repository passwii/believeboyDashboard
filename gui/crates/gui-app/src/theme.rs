//! 语义色板
//!
//! 对齐 frontend sidebar 设计语言：
//! - 侧栏：深色（zinc 系），对应 Web dark-mode sidebar（`bg-sidebar` ≈ #18181b）
//! - 内容区：浅色（zinc-50 画布 + 白色卡片）
//!
//! 所有视图从本模块取色，不散落十六进制字面量；后续切浅色侧栏 / 跟随系统外观
//! 时只需扩展 Theme 的构建函数。

use gpui::{rgb, Hsla};

/// 把 0xRRGGBB 转成 GPUI 色值（统一 Hsla，避免 Rgba/Hsla 混用）
fn c(hex: u32) -> Hsla {
    rgb(hex).into()
}

#[derive(Clone, Copy, Debug)]
pub struct Theme {
    // ---- 侧栏（深色）----
    pub sidebar_bg: Hsla,
    pub sidebar_border: Hsla,
    pub sidebar_header_text: Hsla,
    pub sidebar_group_text: Hsla,
    pub sidebar_item_text: Hsla,
    pub sidebar_item_hover: Hsla,
    pub sidebar_item_active_bg: Hsla,
    pub sidebar_item_active_text: Hsla,
    pub sidebar_footer_text: Hsla,

    // ---- 内容区（浅色）----
    pub content_bg: Hsla,
    pub content_title: Hsla,
    pub content_subtitle: Hsla,
    pub content_muted: Hsla,
    pub content_card_bg: Hsla,
    pub content_card_border: Hsla,
    pub content_accent: Hsla,
    pub brand: Hsla,
    pub brand_soft: Hsla,
}

impl Theme {
    /// 深色侧栏 + 浅色内容区（当前唯一外观；对应 Web 默认 dark sidebar）
    pub fn dark_sidebar_light_content() -> Self {
        Self {
            // 侧栏
            sidebar_bg: c(0x18181b),             // zinc-950
            sidebar_border: c(0x27272a),         // zinc-800
            sidebar_header_text: c(0xfafafa),    // 白
            sidebar_group_text: c(0x8b8b8b),     // zinc-500 偏亮
            sidebar_item_text: c(0xd4d4d8),      // zinc-300
            sidebar_item_hover: c(0x27272a),     // zinc-800
            sidebar_item_active_bg: c(0x3f3f46), // zinc-700
            sidebar_item_active_text: c(0xffffff),
            sidebar_footer_text: c(0x71717a), // zinc-500

            // 内容区
            content_bg: c(0xfafafa), // zinc-50
            content_title: c(0x18181b),
            content_subtitle: c(0x71717a),
            content_muted: c(0xa1a1aa),
            content_card_bg: c(0xffffff),
            content_card_border: c(0xe4e4e7), // zinc-200
            content_accent: c(0x3b82f6),      // blue-500（标题前的小竖条/徽标）
            brand: c(0x3b82f6),               // blue-500
            brand_soft: c(0xeff6ff),          // blue-50
        }
    }
}
