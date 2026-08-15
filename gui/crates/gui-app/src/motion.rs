//! 动效系统（P4-2，BLF-708）
//!
//! 三层设计（对齐 P2-2 主题系统的分层思想）：
//! 1. **开关层**：[`MotionPref`] 全局 + [`reduce_motion`] —— 系统「减弱动态效果」
//!    （macOS `NSWorkspace.accessibilityDisplayShouldReduceMotion`）开启时全局降级为
//!    瞬时切换 / 无动画（可访问性优先）。
//! 2. **度量层**：时长 token（[`DURATION_*`]）+ 缓动函数（[`ease_out_cubic`] /
//!    [`ease_out_quint`]），全部纯函数可单测。
//! 3. **工具层**：[`lerp`] / [`lerp_hsla`] / [`count_up`] 插值辅助 + [`hover_transition`]
//!    （gpui 0.2 无 CSS transition，用 keyed-state + `with_animation` 模拟 hover 过渡）。
//!
//! 能力边界（gpui 0.2.2）：无 CSS `transition` / transform —— 元素级动画只能通过
//! `AnimationExt::with_animation`（一次性 0→1 动画）+ 元素状态重触发实现；视图切换
//! 的「轻微 slide」不可行（无 translate），降级为 fade。见 PR 说明。

use std::sync::OnceLock;
use std::time::Duration;

use gpui::{
    Animation, AnimationExt, App, Div, ElementId, Hsla, IntoElement, SharedString, Stateful,
    StatefulInteractiveElement, Window,
};

/// 全局动效偏好：`reduce_motion = true` 表示系统「减弱动态效果」开启（降级瞬时）。
/// 默认关闭（动效正常）；main.rs 启动时从系统检测写入。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MotionPref(pub bool);

impl gpui::Global for MotionPref {}

/// 当前是否应降级动效（读取全局偏好；未设置时默认动效开启）
pub fn reduce_motion(cx: &App) -> bool {
    cx.try_global::<MotionPref>().map(|p| p.0).unwrap_or(false)
}

/// 检测系统「减弱动态效果」（macOS：`NSWorkspace.accessibilityDisplayShouldReduceMotion`）。
///
/// - 结果 `OnceLock` 缓存（启动读一次即可，运行期系统设置变更需重启生效）
/// - 非 macOS 平台恒为 `false`（动效开启）
pub fn detect_system_reduce_motion() -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| {
        #[cfg(target_os = "macos")]
        {
            use objc2_app_kit::NSWorkspace;
            NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceMotion()
        }
        #[cfg(not(target_os = "macos"))]
        {
            false
        }
    })
}

// ---------------------------------------------------------------------------
// 时长 token（纯常量，可单测）
// ---------------------------------------------------------------------------

/// 视图切换过渡时长（内容区业务视图 fade-in）
pub const DURATION_VIEW_SWITCH: Duration = Duration::from_millis(180);
/// 侧栏折叠/展开宽度过渡时长
pub const DURATION_SIDEBAR: Duration = Duration::from_millis(200);
/// hover / 按压反馈过渡时长
pub const DURATION_HOVER: Duration = Duration::from_millis(100);
/// KPI 数字 count-up 时长（对齐 frontend 数字带观感）
pub const DURATION_COUNT_UP: Duration = Duration::from_millis(600);
/// 列表/表格 enter 轻量 fade-in 时长
pub const DURATION_FADE_IN: Duration = Duration::from_millis(150);

// ---------------------------------------------------------------------------
// 缓动函数（纯函数，可单测）
// ---------------------------------------------------------------------------

/// 三次缓出（ease-out cubic）：起步快、收尾慢——视图切换/侧栏折叠/数字增长通用
pub fn ease_out_cubic(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(3)
}

/// 五次缓出（ease-out quint）：比 cubic 收尾更缓——hover 过渡等短反馈
pub fn ease_out_quint(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(5)
}

/// 线性插值（f32）
pub fn lerp(from: f32, to: f32, t: f32) -> f32 {
    from + (to - from) * t
}

/// Hsla 分量线性插值（hover 颜色过渡用）
pub fn lerp_hsla(from: Hsla, to: Hsla, t: f32) -> Hsla {
    Hsla {
        h: lerp(from.h, to.h, t),
        s: lerp(from.s, to.s, t),
        l: lerp(from.l, to.l, t),
        a: lerp(from.a, to.a, t),
    }
}

/// count-up 插值：目标值 × 缓出进度（delta ∈ [0,1]，返回 [0, target]）
pub fn count_up(target: f64, delta: f32) -> f64 {
    target * ease_out_cubic(delta) as f64
}

/// 构造一次性动画（oneshot + 指定缓动）
pub fn animation(duration: Duration, easing: fn(f32) -> f32) -> Animation {
    Animation::new(duration).with_easing(easing)
}

// ---------------------------------------------------------------------------
// hover 过渡（gpui 0.2 无 CSS transition，用 keyed-state + with_animation 模拟）
// ---------------------------------------------------------------------------

/// hover 过渡状态（`use_keyed_state` 按元素 id 持有）：
/// - `hovered`：当前是否悬停
/// - `touched`：是否发生过首次 hover 事件（首帧不套动画，避免挂载时闪一下 hover 色）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HoverState {
    pub hovered: bool,
    pub touched: bool,
}

/// 给可交互元素加 hover 过渡：hover 进入/离开都在 [`DURATION_HOVER`] 内做插值过渡。
///
/// - `key`：元素唯一 id（同时作 `use_keyed_state` 与动画 id 的前缀；动画 id =
///   `{key}-hover-{hovered}` 与元素 id 错开）
/// - `base`：已构造样式/事件的 `Stateful<Div>`（**不含需要随 hover 插值的内容**——
///   插值内容由 `apply` 每帧重建，避免 child 累积）
/// - `apply`：`Fn(Stateful<Div>, t) -> Stateful<Div>`，`t=0` 常态、`t=1` hover 态；
///   可在其中 `.bg()` / `.shadow()` / `.child()` 插值（gpui 0.2 无 transform，限颜色/阴影）
///
/// 实现：hovered 翻转 → 动画 id 变化 → `with_animation` 重放 0→1 → 方向由调用方
/// `apply` 内的插值决定；首帧（touched=false）与减弱动态时直接渲染目标态（瞬时）。
pub fn hover_transition(
    key: impl Into<ElementId> + Clone,
    base: Stateful<Div>,
    window: &mut Window,
    cx: &mut App,
    apply: impl Fn(Stateful<Div>, f32) -> Stateful<Div> + 'static,
) -> impl gpui::IntoElement {
    let id: ElementId = key.clone().into();
    let state = window.use_keyed_state(id.clone(), cx, |_, _| HoverState::default());
    let s = *state.read(cx);
    let reduce = reduce_motion(cx);

    let base = base.on_hover(move |hovered, _, cx| {
        state.update(cx, |s, cx| {
            s.hovered = *hovered;
            s.touched = true;
            cx.notify();
        });
    });

    if !s.touched || reduce {
        // 首帧 / 减弱动态：瞬时渲染目标态（无动画）
        return apply(base, if s.hovered { 1.0 } else { 0.0 }).into_any_element();
    }

    // 状态翻转 → id 变化 → 动画重放。方向：hovered 时 0→1（常态→hover）；
    // 离开时 1→0（hover→常态）。
    let anim_id = SharedString::from(format!("{id}-hover-{}", s.hovered));
    base.with_animation(
        anim_id,
        animation(DURATION_HOVER, ease_out_quint),
        move |el, delta| {
            let t = if s.hovered { delta } else { 1.0 - delta };
            apply(el, t)
        },
    )
    .into_any_element()
}

/// 视图切换 fade-in 包装：内容区业务视图切换时 0→1 淡入（非减弱动态时）。
/// `id` 需编码当前视图身份——视图变化 → 元素 id 变化 → 动画重放。
pub fn view_fade_in<E>(id: SharedString, element: E, reduce: bool) -> impl gpui::IntoElement
where
    E: gpui::IntoElement + gpui::Styled + 'static,
{
    if reduce {
        return element.into_any_element();
    }
    element
        .with_animation(
            id,
            animation(DURATION_VIEW_SWITCH, ease_out_cubic),
            |el, delta| el.opacity(delta),
        )
        .into_any_element()
}

/// 轻量 fade-in（列表/表格 enter 动效）：首次出现时 0→1 淡入，一次性（无循环）。
pub fn enter_fade_in<E>(id: SharedString, element: E, reduce: bool) -> impl gpui::IntoElement
where
    E: gpui::IntoElement + gpui::Styled + 'static,
{
    if reduce {
        return element.into_any_element();
    }
    element
        .with_animation(
            id,
            animation(DURATION_FADE_IN, ease_out_cubic),
            |el, delta| el.opacity(delta),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::rgb;

    /// 缓出函数端点契约：t=0 → 0，t=1 → 1（动画起止必须精确命中）
    #[test]
    fn easing_endpoints() {
        for ease in [ease_out_cubic, ease_out_quint] {
            assert_eq!(ease(0.0), 0.0);
            assert_eq!(ease(1.0), 1.0);
        }
    }

    /// 缓出函数单调递增（在 (0,1) 区间内不回头）
    #[test]
    fn easing_is_monotonic() {
        for ease in [ease_out_cubic, ease_out_quint] {
            let mut prev = 0.0f32;
            for i in 1..=20 {
                let t = i as f32 / 20.0;
                let v = ease(t);
                assert!(v >= prev, "t={t} 处缓出值回退");
                prev = v;
            }
        }
        // 缓出特征：前半段快于线性、后半段慢于线性（区别于线性缓动）
        assert!(ease_out_cubic(0.5) > 0.5);
        assert!(ease_out_quint(0.5) > 0.5);
    }

    /// lerp 端点与中值
    #[test]
    fn lerp_contract() {
        assert_eq!(lerp(0.0, 100.0, 0.0), 0.0);
        assert_eq!(lerp(0.0, 100.0, 1.0), 100.0);
        assert_eq!(lerp(0.0, 100.0, 0.5), 50.0);
    }

    /// Hsla 插值端点：t=0 精确命中 from、t=1 精确命中 to（各分量）
    #[test]
    fn lerp_hsla_endpoints() {
        let from = rgb(0x112233).into();
        let to = rgb(0x445566).into();
        let a = lerp_hsla(from, to, 0.0);
        let b = lerp_hsla(from, to, 1.0);
        assert_eq!(a, from);
        assert_eq!(b, to);
        // 中值位于两者之间（分量线性）
        let mid = lerp_hsla(from, to, 0.5);
        assert!((mid.l - (from.l + to.l) / 2.0).abs() < 1e-6);
    }

    /// count-up 契约：delta=0 → 0，delta=1 → 目标值；单调增长
    #[test]
    fn count_up_contract() {
        assert_eq!(count_up(400.0, 0.0), 0.0);
        assert_eq!(count_up(400.0, 1.0), 400.0);
        let mut prev = 0.0;
        for i in 1..=20 {
            let v = count_up(400.0, i as f32 / 20.0);
            assert!(v >= prev);
            prev = v;
        }
        // 负数目标也成立
        assert_eq!(count_up(-100.0, 1.0), -100.0);
    }

    /// 时长 token 全部为正且有序（视图切换 > fade-in 等短反馈）
    #[test]
    fn durations_positive_and_ordered() {
        assert!(!DURATION_VIEW_SWITCH.is_zero());
        assert!(!DURATION_SIDEBAR.is_zero());
        assert!(!DURATION_HOVER.is_zero());
        assert!(!DURATION_COUNT_UP.is_zero());
        assert!(!DURATION_FADE_IN.is_zero());
        // count-up 最长（数字增长要有停顿感），hover 最短（反馈要快）
        assert!(DURATION_COUNT_UP > DURATION_HOVER);
        assert!(DURATION_HOVER < DURATION_FADE_IN);
    }

    /// MotionPref 默认 = 动效开启（reduce_motion=false）；显式设置可关闭
    #[gpui::test]
    async fn motion_pref_global_contract(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            // 未设置 → 默认开启
            assert!(!reduce_motion(cx));
            // 设置开启减弱动态 → 读取生效
            cx.set_global(MotionPref(true));
            assert!(reduce_motion(cx));
            // 关闭 → 恢复
            cx.set_global(MotionPref(false));
            assert!(!reduce_motion(cx));
        });
    }

    /// hover 过渡状态：默认未悬停、未触碰
    #[test]
    fn hover_state_defaults() {
        let s = HoverState::default();
        assert!(!s.hovered);
        assert!(!s.touched);
    }
}
