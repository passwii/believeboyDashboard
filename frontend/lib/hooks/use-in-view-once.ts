'use client'

import { useEffect, useRef, useState } from 'react'

export interface UseInViewOnceOptions {
  /** 提前触发距离，默认 '320px'（元素距视口 320px 时即视为可见，给数据预取留提前量） */
  rootMargin?: string
  /** 可见面积比例阈值，默认 0 */
  threshold?: number
}

/**
 * BEL-419 数据懒加载基座：一次性进入视口检测。
 *
 * 用法：`const { ref, inView } = useInViewOnce<HTMLElement>()`。
 * 元素首次进入视口（含 rootMargin 提前量）后 `inView` 永久置 true 并断开 observer，
 * 调用方据此延迟发起 mount-fetch，从而削减首屏并发请求、降低后台数据库瞬时压力。
 *
 * 无 IntersectionObserver 的环境（旧浏览器 / jsdom 未 mock 时）直接降级为可见，
 * 保证功能可用而非白屏。
 */
export function useInViewOnce<T extends HTMLElement = HTMLDivElement>(
  options?: UseInViewOnceOptions
) {
  const ref = useRef<T | null>(null)
  const [inView, setInView] = useState(false)
  const rootMargin = options?.rootMargin ?? '320px'
  const threshold = options?.threshold ?? 0

  useEffect(() => {
    if (inView) return
    const element = ref.current
    if (!element) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true)
          observer.disconnect()
        }
      },
      { rootMargin, threshold }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [inView, rootMargin, threshold])

  return { ref, inView }
}
