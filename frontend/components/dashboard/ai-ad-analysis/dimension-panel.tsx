'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, Layers, Link2, Clock, SkipForward, Signal } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface DimensionInfo {
  dimension_id: string
  name: string
  level: number
  priority?: number
  signal_strength?: string
  depends_on?: string[]
}

export interface DimensionCoverage {
  analyzed?: DimensionInfo[]
  cross?: DimensionInfo[]
  temporal?: DimensionInfo[]
  skipped?: Array<{ dimension_id: string; name: string; reason: string }>
}

interface DimensionPanelProps {
  coverage: DimensionCoverage
  className?: string
  defaultExpanded?: boolean
}

const SIGNAL_STYLES: Record<string, { bg: string; text: string; dot: string; label: string }> = {
  strong: {
    bg: 'bg-emerald-50 dark:bg-emerald-950/30',
    text: 'text-emerald-700 dark:text-emerald-400',
    dot: 'bg-emerald-500',
    label: '强',
  },
  moderate: {
    bg: 'bg-term-warn/5',
    text: 'text-term-warn',
    dot: 'bg-term-warn',
    label: '中',
  },
  weak: {
    bg: 'bg-[hsl(var(--muted))]',
    text: 'text-[hsl(var(--muted-foreground))]',
    dot: 'bg-[hsl(var(--data-neutral))]',
    label: '弱',
  },
  empty: {
    bg: 'bg-[hsl(var(--muted))]',
    text: 'text-[hsl(var(--muted-foreground))]',
    dot: 'bg-[hsl(var(--data-neutral))]',
    label: '无',
  },
}

function SignalBadge({ strength }: { strength?: string }) {
  const s = SIGNAL_STYLES[strength ?? 'empty'] ?? SIGNAL_STYLES.empty
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        s.bg,
        s.text
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} />
      {s.label}
    </span>
  )
}

export function DimensionPanel({
  coverage,
  className,
  defaultExpanded = false,
}: DimensionPanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  const total =
    (coverage.analyzed?.length ?? 0) +
    (coverage.cross?.length ?? 0) +
    (coverage.temporal?.length ?? 0)
  const skippedCount = coverage.skipped?.length ?? 0

  if (total === 0 && skippedCount === 0) return null

  return (
    <div className={cn('rounded-md border bg-muted/20', className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        <Signal className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">分析策略</span>
        <span className="text-muted-foreground">
          {total} 维度覆盖{skippedCount > 0 ? `，${skippedCount} 跳过` : ''}
        </span>
      </button>

      {expanded && (
        <div className="border-t px-3 py-2.5 space-y-3">
          {/* L1 Single Dimensions */}
          {coverage.analyzed && coverage.analyzed.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Layers className="h-3 w-3 text-emerald-600" />
                <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                  单维度深挖 (L1)
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {coverage.analyzed.map((d) => (
                  <span
                    key={d.dimension_id}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium',
                      'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-400'
                    )}
                  >
                    {d.name}
                    {d.signal_strength && <SignalBadge strength={d.signal_strength} />}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* L2 Cross Dimensions */}
          {coverage.cross && coverage.cross.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Link2 className="h-3 w-3 text-blue-600" />
                <span className="text-xs font-medium text-blue-700 dark:text-blue-400">
                  交叉分析 (L2)
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {coverage.cross.map((d) => (
                  <span
                    key={d.dimension_id}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium',
                      'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-400'
                    )}
                  >
                    {d.name}
                    {d.depends_on && d.depends_on.length > 0 && (
                      <span className="text-[9px] opacity-60">({d.depends_on.length} 依赖)</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* L3 Temporal Dimensions */}
          {coverage.temporal && coverage.temporal.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Clock className="h-3 w-3 text-purple-600" />
                <span className="text-xs font-medium text-purple-700 dark:text-purple-400">
                  跨周期分析 (L3)
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {coverage.temporal.map((d) => (
                  <span
                    key={d.dimension_id}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium',
                      'border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-950/30 dark:text-purple-400'
                    )}
                  >
                    {d.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Skipped Dimensions */}
          {coverage.skipped && coverage.skipped.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <SkipForward className="h-3 w-3 text-gray-500" />
                <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                  跳过维度
                </span>
              </div>
              <div className="space-y-0.5">
                {coverage.skipped.map((s) => (
                  <div
                    key={s.dimension_id}
                    className="flex items-center gap-2 text-[11px] text-muted-foreground"
                  >
                    <span className="h-1 w-1 rounded-full bg-gray-300 shrink-0" />
                    <span className="font-medium">{s.name}</span>
                    <span className="opacity-60">— {s.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
