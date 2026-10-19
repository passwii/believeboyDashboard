import { type ReactNode } from 'react'

import { cn } from '@/lib/utils'

export interface SkeletonRevealProps {
  /** `true` = 显示骨架（脉冲）；`false` = 揭示内容（交叉淡入 + 去模糊，骨架淡出 + 加模糊）。 */
  loading: boolean
  /**
   * 骨架层内容。脉冲作用在它的**直接子元素**上（`--pulse-*`），
   * 故传纯占位块即可（不必用 `Skeleton` 的扫光底）。
   */
  skeleton: ReactNode
  children: ReactNode
  className?: string
  'data-testid'?: string
}

/**
 * transitions.dev 14-skeleton-reveal 的 React 承载层。
 *
 * 运动规格全部来自 `_root.css` 的语义变量（见 `globals.css` 的 `.ui-skel*`）：
 * `--pulse-dur` / `--pulse-count` / `--pulse-min` / `--reveal-dur` / `--reveal-blur` / `--reveal-ease`。
 *
 * 与「加载完卸载骨架」旧模式的差异：揭示后骨架层**仍在 DOM**（`opacity: 0` + `aria-hidden`），
 * 否则没有可交叉淡出的对象。代价是一个全透明层；收益是真实的交叉模糊揭示而非硬切换。
 *
 * 两层用 grid 同格叠放（`.ui-skel-skeleton` / `.ui-skel-content` 各占 `grid-area: 1/1`），
 * 容器高度取两层较高者——调用方不需要提供确定高度（见 `globals.css` 注释里的适配说明）。
 */
export function SkeletonReveal({
  loading,
  skeleton,
  children,
  className,
  'data-testid': testId,
}: SkeletonRevealProps) {
  return (
    <div
      className={cn('ui-skel', !loading && 'is-revealed', className)}
      data-testid={testId}
      data-state={loading ? 'loading' : 'revealed'}
      aria-busy={loading || undefined}
    >
      <div className="ui-skel-skeleton is-pulsing" data-testid="skeleton-layer" aria-hidden="true">
        {skeleton}
      </div>
      <div
        ref={(element) => {
          // React 18 does not type the HTML inert attribute. Apply it directly so hidden
          // controls leave the keyboard focus order until the reveal is complete.
          if (!element) return
          if (loading) element.setAttribute('inert', '')
          else element.removeAttribute('inert')
        }}
        className="ui-skel-content"
        data-testid="content-layer"
        aria-hidden={loading || undefined}
      >
        {children}
      </div>
    </div>
  )
}
