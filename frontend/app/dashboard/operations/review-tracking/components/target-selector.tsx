'use client'

import { type ReviewTarget } from '@/lib/review-tracking-api'
import { cn } from '@/lib/utils'
import styles from '../review-tracking-warm.module.css'

export interface TargetSelectorProps {
  targets: ReviewTarget[]
  loading?: boolean
  selectedId: number | null
  onSelect: (id: number) => void
  className?: string
}

function TargetCard({
  target,
  active,
  onSelect,
}: {
  target: ReviewTarget
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      data-testid={`target-${target.id}`}
      className={styles.targetCard}
    >
      <span className={styles.targetCardTop}>
        <span className={styles.targetName}>{target.displayName}</span>
        {target.isActive ? null : <span className={styles.inactiveBadge}>已停用</span>}
      </span>
      <span className={styles.targetMeta}>
        {target.marketplace} · {target.asin || '代表 ASIN 未设置'}
      </span>
      <span className={styles.targetKind}>
        {target.kindLabel} · {target.projectName}
      </span>
    </button>
  )
}

export function TargetSelector({
  targets,
  loading = false,
  selectedId,
  onSelect,
  className,
}: TargetSelectorProps) {
  const internal = targets.filter((target) => target.kind === 'internal_group')
  const external = targets.filter((target) => target.kind === 'external_asin')

  return (
    <div
      className={cn(styles.targetSelector, className)}
      data-testid="target-selector"
    >
      <div className={styles.targetSelectorHeader}>
        <h2 className={styles.targetSelectorTitle}>追踪目标</h2>
        <span className={styles.targetSelectorCount}>{targets.length} 个</span>
      </div>

      {loading ? (
        <div className={styles.targetGroups} role="status" aria-busy="true">
          <span className={styles.targetSelectorCount}>正在加载追踪目标</span>
          <div className={styles.skeletonCard} aria-hidden="true" />
          <div className={styles.skeletonCard} aria-hidden="true" />
        </div>
      ) : targets.length === 0 ? (
        <div className={styles.emptyTarget} role="status">
          还没有追踪目标：内部共享组在 SKU 信息页配置，外部竞品可在本页登记；等待采集端接入后这里会出现目标。
        </div>
      ) : (
        <div className={styles.targetGroups}>
          {internal.length > 0 ? (
            <section className={styles.targetGroup} aria-label="内部共享组目标">
              <p className={styles.groupTitle}>内部共享组 ({internal.length})</p>
              {internal.map((target) => (
                <TargetCard
                  key={target.id}
                  target={target}
                  active={target.id === selectedId}
                  onSelect={() => onSelect(target.id)}
                />
              ))}
            </section>
          ) : null}

          {external.length > 0 ? (
            <section className={styles.targetGroup} aria-label="外部竞品目标">
              <p className={styles.groupTitle}>外部竞品 ({external.length})</p>
              {external.map((target) => (
                <TargetCard
                  key={target.id}
                  target={target}
                  active={target.id === selectedId}
                  onSelect={() => onSelect(target.id)}
                />
              ))}
            </section>
          ) : null}
        </div>
      )}
    </div>
  )
}
