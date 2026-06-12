"use client"

import * as React from "react"

const MOBILE_BREAKPOINT = 768

/**
 * useIsMobile — SSR-safe 视口订阅 hook
 *
 * 设计要点：
 * - 服务端始终渲染 `false`（与 `MOBILE_ADAPTATION_RULES.md` 移动端规则一致），
 *   避免 hydration mismatch；客户端 hydration 后再订阅 resize 事件回填真实值。
 * - 用 `useSyncExternalStore` 接入 resize，无需 `useState + useEffect` 组合，
 *   避免首屏 `undefined` 中间态与重渲染抖动。
 * - 断点 768 px：与 sidebar 既有约定保持一致；调用方按需用 CSS `md:` /
 *   `tailwindcss` 自行补充桌面样式。
 */
export function useIsMobile(breakpoint: number = MOBILE_BREAKPOINT): boolean {
  const subscribe = React.useCallback((onStoreChange: () => void) => {
    if (typeof window === "undefined") {
      return () => {}
    }
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const onChange = () => onStoreChange()
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [breakpoint])

  const getSnapshot = React.useCallback(
    () => typeof window !== "undefined" && window.innerWidth < breakpoint,
    [breakpoint],
  )

  const getServerSnapshot = React.useCallback(() => false, [])

  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
