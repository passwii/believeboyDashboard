'use client'

import { MotionConfig } from 'framer-motion'

/**
 * 全局 framer-motion 无障碍退化（BLF-1361）。
 *
 * 为什么放全局而不是逐个组件补 `useReducedMotion()`：产品面里 8 个 framer-motion
 * 消费点中，`notification-toast` / `funnel-chart` / `table-showcase` 三个既没有
 * `useReducedMotion` 也没有全局配置（迁移 #737 把 toast 的上浮 + scale + blur 强度
 * 提上去了，等于放大了这个缺口）。逐个补是「补一个漏一个」的形状，`MotionConfig`
 * 一次覆盖全部现有与以后新写的 framer 组件。
 *
 * `reducedMotion="user"` 是 framer-motion 的官方语义：当系统 `prefers-reduced-motion:
 * reduce` 时，**transform / layout 类动画降为瞬时**（opacity / color 保留，仍给出状态反馈）。
 *
 * 落点必须在 `NotificationToastContainer` 外层：那个容器是 `dynamic(..., { ssr: false })`
 * 懒挂载 + `createPortal` 到 body（`components/system/notification-wrapper.tsx`），
 * React context 会穿过 portal，所以只要本 provider 在 layout 里包住整棵树就覆盖它。
 */
export function MotionConfigProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>
}
