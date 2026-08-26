//! 平台差异收敛层（BLF-828）
//!
//! 父 issue「Windows 平台补齐」交付项 3/4/5：把散落在视图里的 `cfg(target_os)`
//! 收敛到一个模块——平台判定、窗口 chrome 度量、快捷键文案、Win11 视觉 token
//! 全部从这里取，视图层不再出现 `cfg!(target_os = ...)` 字面量。
//!
//! 设计基调（BLF-828 拍板）：**Win11 Fluent 独立风格**，不与 macOS 强行统一。
//! - macOS：透明标题栏 + traffic lights(9,9)（既有契约，零回归）；
//! - Windows：无系统红绿灯（gpui `appears_transparent` 下 Win10/11 均隐藏原生
//!   标题栏），由应用自绘 caption buttons（[`crate::views::root`] 的
//!   `caption_buttons`）并注册 `WindowControlArea::Min/Max/Close` 原生命中区
//!   ——点击行为由 Windows 消息循环处理（HTMINBUTTON/HTMAXBUTTON/HTCLOSE，
//!   gpui events.rs `handle_nc_mouse_up_msg`），无需应用侧写 minimize/zoom 逻辑。

/// 当前是否 macOS 构建（编译期常量；运行时用 [`is_macos`] 免 cfg 散落）
pub const IS_MACOS: bool = cfg!(target_os = "macos");

/// 当前是否 Windows 构建
pub const IS_WINDOWS: bool = cfg!(target_os = "windows");

/// 当前是否 macOS（helper 形式，语义化调用点）
#[inline]
pub fn is_macos() -> bool {
    IS_MACOS
}

/// 当前是否 Windows
#[inline]
pub fn is_windows() -> bool {
    IS_WINDOWS
}

// ---------------------------------------------------------------------------
// 窗口 chrome 度量（各平台差异集中一处）
// ---------------------------------------------------------------------------

/// Windows caption buttons 区总宽（3 × [`CAPTION_BUTTON_WIDTH`]）。
///
/// Win11 官方规格每钮约 46~47px；本应用高密度外壳取 36px 与 Console Bar
/// 行高等高对齐（按钮区贴 Console Bar 右端，见 root.rs `caption_buttons`）。
pub const CAPTION_BUTTON_WIDTH: f32 = 36.0;

/// Windows caption buttons 区高度（与 Console Bar 同高，覆盖其右端）。
/// macOS 下无此区（traffic lights 悬于侧栏头部，见 sidebar.rs 避让区）。
/// 当前 caption 按钮直接挂在 36px 头部内（无需单独设高），本常量保留为
/// 度量契约锚点（回归锁见 tests::caption_metrics_contract）。
#[allow(dead_code)]
pub const CAPTION_BAR_HEIGHT: f32 = 36.0;

/// 各平台 chrome 占用的顶部避让宽度：
/// - macOS：traffic lights 三灯 ≈ 70px 宽（sidebar.rs 头部已留白）；
/// - Windows：caption buttons 3 × 36 = 108px（Console Bar 右端需避让）。
///
/// 内容区头部布局据此决定右侧 padding（Windows 下用户身份簇不被关闭钮遮挡）。
pub const CAPTION_ZONE_WIDTH: f32 = if IS_WINDOWS {
    CAPTION_BUTTON_WIDTH * 3.0
} else {
    0.0
};

// ---------------------------------------------------------------------------
// 快捷键文案（交付项 4）：⌘ vs Ctrl
// ---------------------------------------------------------------------------

/// 平台修饰键符号：macOS ⌘ / 其余（Windows/Linux）Ctrl。
///
/// cmd-k / cmd-b / cmd-\ 已有 ctrl-* 双绑定（main.rs），此处只统一**文案**，
/// 不改键位行为。组合键场景优先用 [`combo`]（自动处理 macOS 无 + 号的紧凑
/// 形式）；单键提及（如「按 ⌘」）用本函数。
#[inline]
#[allow(dead_code)]
pub fn mod_key_symbol() -> &'static str {
    if is_macos() {
        "⌘"
    } else {
        "Ctrl"
    }
}

/// 组合快捷键提示文案：`mod + key` 的平台化渲染。
///
/// - macOS：`⌘K`
/// - Windows：`Ctrl+K`
#[inline]
pub fn combo(key: &str) -> String {
    if is_macos() {
        format!("{MOD}{key}")
    } else {
        format!("{MOD}+{key}")
    }
}

const MOD: &str = if cfg!(target_os = "macos") {
    "⌘"
} else {
    "Ctrl"
};

// ---------------------------------------------------------------------------
// Win11 Fluent 视觉基调（交付项 5）
// ---------------------------------------------------------------------------

/// Mica 近似暗色渐变顶色（窗口顶部，偏暖深灰 #1f1f23）。
///
/// GPUI 0.2.2 无原生 Mica/DWM_SYSTEMBACKDROP_TYPE 接入；按 build-gpui-apps
/// apple-glass.md Tier 4「跨平台近似」原则，用极低对比暗色渐变模拟 Mica
/// 质感意向（不宣称是原生 Mica）。消费点：root.rs 根容器背景叠加层。
pub const WIN11_MICA_TOP: u32 = 0x1f1f23;

/// Mica 近似渐变底色（窗口底部，更深 #141417，与 BG_PANEL 同相衔接）
pub const WIN11_MICA_BOTTOM: u32 = 0x141417;

/// Win11 窗口圆角半径（px，逻辑单位）。DWM 在 Win11 上自动给顶层窗口加 ~8px
/// 圆角裁切客户区四角；GPUI 无法主动请求 DWMWCP_ROUND，但根容器四角内容若为
/// 深色实底则视觉上无缝。此 token 供未来绘制圆角描边/内容圆角时使用，
/// 当前仅作文档锚点（值对齐 Win11 默认 8px；回归锁见
/// tests::win11_mica_gradient_is_top_lit）。
#[allow(dead_code)]
pub const WIN11_WINDOW_CORNER_RADIUS: f32 = 8.0;

#[cfg(test)]
mod tests {
    use super::*;

    /// BLF-828 契约：平台互斥性——is_macos 与 is_windows 不应同时为真。
    #[test]
    fn platform_flags_are_mutually_exclusive() {
        assert!(!(is_macos() && is_windows()));
        // IS_MACOS / IS_WINDOWS 与 helper 一致（防两套常量漂移）
        assert_eq!(IS_MACOS, is_macos());
        assert_eq!(IS_WINDOWS, is_windows());
    }

    /// BLF-828 契约：caption buttons 度量对齐 Win11 Fluent 惯例——
    /// 三钮区总宽 = 3 × 单钮宽，且与 Console Bar 同高。
    #[test]
    fn caption_metrics_contract() {
        assert_eq!(CAPTION_BUTTON_WIDTH, 36.0, "单钮宽 36px（高密度外壳对齐）");
        assert_eq!(CAPTION_BAR_HEIGHT, 36.0, "与 Console Bar 同高");
        if is_windows() {
            assert_eq!(CAPTION_ZONE_WIDTH, CAPTION_BUTTON_WIDTH * 3.0);
        } else {
            assert_eq!(CAPTION_ZONE_WIDTH, 0.0, "非 Windows 无 caption 区");
        }
    }

    /// BLF-828 契约：快捷键文案平台化——macOS ⌘K 紧凑形式，Windows Ctrl+K。
    #[test]
    fn mod_key_copy_platform_aware() {
        if is_macos() {
            assert_eq!(mod_key_symbol(), "⌘");
            assert_eq!(combo("K"), "⌘K");
            assert_eq!(combo("\\"), "⌘\\");
        } else {
            assert_eq!(mod_key_symbol(), "Ctrl");
            assert_eq!(combo("K"), "Ctrl+K");
            assert_eq!(combo("B"), "Ctrl+B");
        }
    }

    /// BLF-828 契约：Mica 近似渐变顶色必须亮于底色（自顶向下变暗的 Mica 质感），
    /// 且两者都落在暗色区间（不破坏暗色主题基调）。
    #[test]
    fn win11_mica_gradient_is_top_lit() {
        let lum = |hex: u32| {
            let r = ((hex >> 16) & 0xff) as f32;
            let g = ((hex >> 8) & 0xff) as f32;
            let b = (hex & 0xff) as f32;
            (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
        };
        assert!(
            lum(WIN11_MICA_TOP) > lum(WIN11_MICA_BOTTOM),
            "顶色必须亮于底色"
        );
        assert!(lum(WIN11_MICA_TOP) < 0.2, "顶色必须仍是暗色");
        assert_eq!(WIN11_WINDOW_CORNER_RADIUS, 8.0, "对齐 Win11 默认圆角");
    }
}
