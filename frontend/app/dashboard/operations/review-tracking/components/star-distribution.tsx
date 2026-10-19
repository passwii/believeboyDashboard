'use client'

import type { StarBucket } from '@/lib/review-tracking-api'
import { cn } from '@/lib/utils'

/**
 * 1–5 星分布条（阶段 C，BLF-1377）。
 *
 * 口径纪律：
 *  - 百分比是 Amazon 页面原始值，不做四舍五入改写成「精确占比」；
 *  - 本次没取到百分比 → 渲染 `—` 且条宽为 0（不画成 0% 掩盖缺采）；
 *  - 数量按 `star_count_quality` 三档展示（exact / ≈estimated / unavailable 不展示）。
 */
export function StarDistribution({
  stars,
  qualityLabel,
  className,
}: {
  stars: StarBucket[]
  qualityLabel: string
  className?: string
}) {
  return (
    <div className={cn('space-y-1.5', className)} data-testid="star-distribution">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-term-muted">
        <span>星级分布</span>
        <span data-testid="star-quality">{qualityLabel}</span>
      </div>
      {stars.map((bucket) => {
        const width = bucket.percentage === null ? 0 : Math.max(0, Math.min(100, bucket.percentage))
        return (
          <div key={bucket.star} className="flex items-center gap-2 font-mono text-[11px]">
            <span className="w-8 shrink-0 text-term-muted">{bucket.star}★</span>
            <div className="h-1.5 flex-1 bg-term-raised">
              <div
                className={cn('h-full', bucket.percentage === null ? 'bg-term-border' : 'bg-term-accent')}
                style={{ width: `${width}%` }}
              />
            </div>
            <span className="w-12 shrink-0 text-right tabular-nums text-term-text">
              {bucket.percentage === null ? '—' : `${bucket.percentage}%`}
            </span>
            <span
              className="w-14 shrink-0 text-right tabular-nums text-term-muted"
              data-testid={`star-count-${bucket.star}`}
            >
              {bucket.countText}
            </span>
          </div>
        )
      })}
    </div>
  )
}
