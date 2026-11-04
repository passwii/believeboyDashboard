'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, Layers, Link2, Clock, SkipForward, Signal } from 'lucide-react'

import { WarmBadge } from '@/components/dashboard-v2/warm-ledger/controls'
import styles from './ai-ad-analysis-warm.module.css'

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

const SIGNAL_LABELS: Record<string, string> = {
  strong: '强',
  moderate: '中',
  weak: '弱',
  empty: '无',
}

function SignalBadge({ strength }: { strength?: string }) {
  const key = strength ?? 'empty'
  const tone = key === 'strong' ? 'positive' : key === 'moderate' ? 'accent' : 'neutral'
  return (
    <WarmBadge tone={tone} className="text-[10px]">
      {SIGNAL_LABELS[key] ?? SIGNAL_LABELS.empty}
    </WarmBadge>
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
    <div className={`${styles.dimensionPanel} ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={styles.dimensionToggle}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        <Signal className="h-3.5 w-3.5" aria-hidden />
        <span className={styles.dimensionTitle}>分析策略</span>
        <span>
          {total} 维度覆盖{skippedCount > 0 ? `，${skippedCount} 跳过` : ''}
        </span>
      </button>

      {expanded && (
        <div className={styles.dimensionBody}>
          {/* L1 Single Dimensions */}
          {coverage.analyzed && coverage.analyzed.length > 0 && (
            <div className={styles.dimensionGroup}>
              <div className={styles.dimensionGroupTitle}>
                <Layers className="h-3 w-3" aria-hidden />
                <span>
                  单维度深挖 (L1)
                </span>
              </div>
              <div className={styles.dimensionItems}>
                {coverage.analyzed.map((d) => (
                  <span
                    key={d.dimension_id}
                    className={styles.dimensionItem}
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
            <div className={styles.dimensionGroup}>
              <div className={styles.dimensionGroupTitle}>
                <Link2 className="h-3 w-3" aria-hidden />
                <span>
                  交叉分析 (L2)
                </span>
              </div>
              <div className={styles.dimensionItems}>
                {coverage.cross.map((d) => (
                  <span
                    key={d.dimension_id}
                    className={styles.dimensionItem}
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
            <div className={styles.dimensionGroup}>
              <div className={styles.dimensionGroupTitle}>
                <Clock className="h-3 w-3" aria-hidden />
                <span>
                  跨周期分析 (L3)
                </span>
              </div>
              <div className={styles.dimensionItems}>
                {coverage.temporal.map((d) => (
                  <span
                    key={d.dimension_id}
                    className={styles.dimensionItem}
                  >
                    {d.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Skipped Dimensions */}
          {coverage.skipped && coverage.skipped.length > 0 && (
            <div className={styles.dimensionGroup}>
              <div className={styles.dimensionGroupTitle}>
                <SkipForward className="h-3 w-3" aria-hidden />
                <span>
                  跳过维度
                </span>
              </div>
              <div>
                {coverage.skipped.map((s) => (
                  <div
                    key={s.dimension_id}
                    className={styles.dimensionSkipped}
                  >
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
