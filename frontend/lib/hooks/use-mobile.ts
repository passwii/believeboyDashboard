'use client'

import { useSyncExternalStore } from 'react'

/**
 * useMobile — SSR 安全的视口断点判断（MOBILE_ADAPTATION_RULES.md「图表区域手机端优化」第 6 条）。
 *
 * 以 Tailwind `md` 断点（<768px 视为手机）为界，用 `useSyncExternalStore` 订阅
 * `matchMedia` 变化，服务端渲染阶段固定返回 false（避免 hydration 闪烁）。
 *
 * 用法：
 * ```tsx
 * const isMobile = useMobile()
 * {!isMobile && <YAxis />}
 * <LineChart margin={isMobile ? { left: -24 } : { left: 10 }} />
 * ```
 */
const MOBILE_QUERY = '(max-width: 767px)'

function subscribe(callback: () => void) {
  const mql = window.matchMedia(MOBILE_QUERY)
  mql.addEventListener('change', callback)
  return () => mql.removeEventListener('change', callback)
}

function getSnapshot(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches
}

function getServerSnapshot(): boolean {
  return false
}

export function useMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
