'use client'
import { useEffect, useRef, type RefObject } from 'react'

type UseSpotlightOptions<E extends HTMLElement = HTMLElement> = {
  /** 外部传入 ref；不传则 hook 自管一个 */
  ref?: RefObject<E | null>
  /** 是否启用；不传则 coarse pointer / reduced-transparency 下自动关闭 */
  enabled?: boolean
}

/**
 * 轻量 spotlight：pointermove 把光标相对坐标写入 element.style 的
 * `--spot-x` / `--spot-y` CSS 变量（百分比），由 CSS 用 radial-gradient 渲染高光边。
 * 减透明 / 粗指针下不挂监听（CSS 通过 --spotlight-strength 关闭视觉）。
 */
export function useSpotlight<E extends HTMLElement = HTMLDivElement>(
  options: UseSpotlightOptions<E> = {},
) {
  const internalRef = useRef<E | null>(null)
  const ref = options.ref ?? internalRef
  const enabled = options.enabled ?? true

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return

    // 减透明 / 粗指针 → 不挂监听（CSS 仍可读 --spot-x/y 默认 50%）
    if (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function'
    ) {
      const reduce = window.matchMedia('(prefers-reduced-transparency: reduce)')
      if (reduce.matches) return
    }

    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      const x = ((e.clientX - rect.left) / rect.width) * 100
      const y = ((e.clientY - rect.top) / rect.height) * 100
      el.style.setProperty('--spot-x', `${x}%`)
      el.style.setProperty('--spot-y', `${y}%`)
    }

    el.addEventListener('pointermove', onMove)
    return () => el.removeEventListener('pointermove', onMove)
  }, [enabled, ref])

  return ref
}