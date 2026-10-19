'use client'

import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { type ReviewTarget } from '@/lib/review-tracking-api'
import { cn } from '@/lib/utils'

/**
 * 目标选择区（阶段 C，BLF-1377）。
 *
 * 两类目标混排在同一列表但分组呈现：
 *  - `internal_group`：某项目下的内部评论共享组，代表 ASIN 由运营在 SKU 信息页维护；
 *  - `external_asin`：外部竞品 ASIN，没有 project，对所有运营可见。
 *
 * 运营账号只能看到自己可见项目下的内部目标；不可见目标后端直接 404，
 * 因此这里不做「全部项目」的假象——筛选项由页面根据 session 决定。
 */
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
      className={cn(
        'w-full border px-3 py-2 text-left transition-colors',
        active
          ? 'border-term-border-strong bg-term-raised'
          : 'border-term-border bg-term-panel hover:bg-term-hover'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[12px] font-semibold text-term-text">
          {target.displayName}
        </span>
        {target.isActive ? null : (
          <Badge variant="outline" className="shrink-0 border-term-border text-term-muted">
            已停用
          </Badge>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-term-muted">
        <span>{target.marketplace}</span>
        <span aria-hidden>·</span>
        <span>{target.asin || '代表 ASIN 未设置'}</span>
      </div>
      <div className="mt-0.5 truncate font-mono text-[10px] text-term-faint">
        {target.kindLabel} · {target.projectName}
      </div>
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
    <div className={cn('space-y-3', className)} data-testid="target-selector">
      <div className="flex items-center justify-between border-b border-term-border pb-2">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-term-muted">追踪目标</h2>
        <span className="font-mono text-[10px] text-term-faint">{targets.length} 个</span>
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full rounded-none" />
          <Skeleton className="h-16 w-full rounded-none" />
        </div>
      ) : targets.length === 0 ? (
        <EmptyState
          icon="database"
          message="还没有追踪目标：内部共享组在 SKU 信息页配置，外部竞品可在本页登记；等待采集端接入后这里会出现目标。"
        />
      ) : (
        <div className="space-y-4">
          {internal.length > 0 ? (
            <section className="space-y-2" aria-label="内部共享组目标">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-term-faint">
                内部共享组 ({internal.length})
              </p>
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
            <section className="space-y-2" aria-label="外部竞品目标">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-term-faint">
                外部竞品 ({external.length})
              </p>
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
