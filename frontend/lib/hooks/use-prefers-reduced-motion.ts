'use client'

import { useSyncExternalStore } from 'react'

/**
 * usePrefersReducedMotion — SSR 安全的「减少动态效果」偏好读取。
 *
 * 与 `use-mobile.ts` 同构：用 `useSyncExternalStore` 订阅 `matchMedia` 变化，
 * 服务端渲染固定返回 false（避免 hydration 不一致）。
 *
 * 流式会话用它关闭打字 caret 闪烁、平滑滚动与入场动画（BLF-1013）。
 */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function subscribe(callback: () => void) {
  const mql = window.matchMedia(REDUCED_MOTION_QUERY)
  mql.addEventListener('change', callback)
  return () => mql.removeEventListener('change', callback)
}

function getSnapshot(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

function getServerSnapshot(): boolean {
  return false
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
