'use client'

import type { StarBucket } from '@/lib/review-tracking-api'
import { cn } from '@/lib/utils'
import styles from '../review-tracking-warm.module.css'

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
    <div className={cn(styles.starDistribution, className)} data-testid="star-distribution">
      <div className={styles.starHeader}>
        <span>星级分布</span>
        <span data-testid="star-quality">{qualityLabel}</span>
      </div>
      {stars.map((bucket) => {
        const width =
          bucket.percentage === null ? 0 : Math.max(0, Math.min(100, bucket.percentage))
        return (
          <div key={bucket.star} className={styles.starRow}>
            <span>{bucket.star}★</span>
            <div className={styles.starTrack}>
              <div
                className={cn(
                  styles.starFill,
                  bucket.percentage === null && styles.starFillMissing
                )}
                style={{ width: `${width}%` }}
              />
            </div>
            <span className={styles.starValue}>
              {bucket.percentage === null ? '—' : `${bucket.percentage}%`}
            </span>
            <span className={styles.starCount} data-testid={`star-count-${bucket.star}`}>
              {bucket.countText}
            </span>
          </div>
        )
      })}
    </div>
  )
}
