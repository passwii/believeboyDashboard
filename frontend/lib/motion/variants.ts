import type { Variants } from "framer-motion";
import { DURATION, EASE, SPRING, STAGGER, BEZIER } from "./tokens";

/**
 * 页面容器（C 形态）：scale + blur + opacity，spring 物理。
 * 与 spec §5 对齐：initial scale 0.985、blur 8px、y 6；exit scale 0.99、blur 4px、y -4。
 *
 * 注：framer-motion 12 的 Variants 类型只允许 [key: string]: Variant，
 * 但运行时支持顶层 transition（作为状态级 transition 的默认值）。
 * 这里用 as Variants 走类型逃生口（runtime 行为已验证）。
 */
export function pageTransitionContainer(): Variants {
  return {
    initial: { opacity: 0, scale: 0.985, filter: "blur(8px)", y: 6 },
    animate: { opacity: 1, scale: 1, filter: "blur(0px)", y: 0 },
    exit: { opacity: 0, scale: 0.99, filter: "blur(4px)", y: -4 },
    transition: SPRING.page,
  } as Variants;
}

/** 通用 fade-up，opacity + y。 */
export function fadeUp(): Variants {
  return {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: DURATION.base, ease: EASE.out },
  } as Variants;
}

/** stagger 容器：staggerChildren 0.07。 */
export function staggerContainer(): Variants {
  return {
    initial: {},
    animate: { transition: { staggerChildren: STAGGER.childDelay, delayChildren: 0.02 } },
  };
}

/** stagger 子项：fadeUp + ease out。 */
export function staggerItem(): Variants {
  return {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: DURATION.base, ease: EASE.out },
  } as Variants;
}

/**
 * 第二层面板「整体揭幕」：横向滑入 + 轻微 blur 消退，叠加 panelReveal 过冲贝塞尔。
 * 用在 SidebarPanel / SidebarUserPanel 根 motion.div 上。
 * 注意：外壳（sidebar-shell）已做 translate+opacity 滑出，这里叠加 blur+横向位移
 * 形成层次感，且 blur 仅作用于 240px 小面板，成本极低。
 */
export function sidebarPanelReveal(): Variants {
  return {
    initial: { opacity: 0, x: -16, filter: "blur(6px)" },
    animate: {
      opacity: 1,
      x: 0,
      filter: "blur(0px)",
      transition: { duration: DURATION.slow, ease: BEZIER.itemReveal },
    },
    exit: {
      opacity: 0,
      x: -10,
      filter: "blur(4px)",
      transition: { duration: DURATION.fast, ease: EASE.standard },
    },
  } as Variants;
}

/**
 * 第二层面板「容器」：staggerChildren 让子项逐个揭晓（叠加贝塞尔）。
 * 配合 sidebarPanelItem() 使用，父级 animate="animate" 会自动向下传播标签。
 */
export function sidebarPanelContainer(delayChildren = 0.04): Variants {
  return {
    initial: {},
    animate: { transition: { staggerChildren: 0.045, delayChildren } },
    exit: { transition: { staggerChildren: 0, staggerDirection: -1 } },
  } as Variants;
}

/**
 * 第二层面板「子项」：从 -12px 横向滑入 + 微缩放 0.98→1 + 透明度，
 * 叠加 panelReveal 过冲贝塞尔，让每个菜单项「弹出」更灵动。
 */
export function sidebarPanelItem(): Variants {
  return {
    initial: { opacity: 0, x: -12, scale: 0.98 },
    animate: {
      opacity: 1,
      x: 0,
      scale: 1,
      // 0.28s：略长于 base，让过冲贝塞尔的回弹被看清楚
      transition: { duration: 0.28, ease: BEZIER.panelReveal },
    },
    exit: {
      opacity: 0,
      x: -8,
      scale: 0.98,
      transition: { duration: DURATION.fast, ease: EASE.standard },
    },
  } as Variants;
}

/** 按下反馈：scale 0.97。 */
export function pressTap() {
  return { whileTap: { scale: 0.97 } };
}