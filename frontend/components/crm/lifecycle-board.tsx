'use client'

/**
 * 生命周期看板区块（P8，BLF-520）：客户从创建到 首次跟进/转化/流失 的时间分布。
 */
import { Users } from 'lucide-react'
import type { LifecycleBoard, LifecycleDistribution } from '@/lib/crm/types'
import { buildTimeFunnelStages } from '@/lib/crm/method/lifecycle'
import { WarmBadge } from '@/components/dashboard-v2/warm-ledger/controls'
import {
  WarmCrmSection,
  WarmCrmState,
} from '@/components/dashboard-v2/warm-ledger/crm'
import { FunnelChart } from '@/components/ui/funnel-chart'

import styles from './lifecycle-board.module.css'

/** 桶名缩写（横轴空间有限）："30 天以上" → "30 天+"。 */
const shortLabel = (label: string) => label.replace('天以上', '天+')

const fmt1 = (value: number | undefined) =>
  value === undefined ? '—' : `${value.toFixed(1)} 天`

function SummaryChips({ dist }: { dist: LifecycleDistribution }) {
  const summary = dist.summary
  const chips = [
    { label: '样本', value: String(summary.sampleCount) },
    { label: '总体', value: String(summary.totalCount) },
    { label: '均值', value: fmt1(summary.avgDays) },
    { label: '中位', value: fmt1(summary.medianDays) },
    { label: 'P90', value: fmt1(summary.p90Days) },
  ]

  return (
    <div className={styles.summaryChips}>
      {chips.map((chip) => (
        <span key={chip.label} className={styles.summaryChip}>
          <span>{chip.label}</span>
          <span className={styles.summaryValue}>{chip.value}</span>
        </span>
      ))}
    </div>
  )
}

/** 直方图按桶计数画柱，柱顶显示数量，hover 显示明细。 */
function Histogram({ dist }: { dist: LifecycleDistribution }) {
  const max = Math.max(...dist.buckets.map((bucket) => bucket.count), 1)

  return (
    <div className={styles.histogram}>
      <div className={styles.bars}>
        {dist.buckets.map((bucket) => {
          const height =
            bucket.count === 0 ? 0 : Math.max((bucket.count / max) * 100, 6)
          return (
            <div
              key={bucket.label}
              className={styles.barSlot}
              title={`${bucket.label}：${bucket.count} 个（${(bucket.pct * 100).toFixed(1)}%）`}
            >
              {bucket.count > 0 ? (
                <span className={styles.barCount}>{bucket.count}</span>
              ) : null}
              <span className={styles.bar} style={{ height: `${height}%` }} />
            </div>
          )
        })}
      </div>
      <div className={styles.axis}>
        {dist.buckets.map((bucket) => (
          <span key={bucket.label}>{shortLabel(bucket.label)}</span>
        ))}
      </div>
    </div>
  )
}

function ConversionFunnel({ dist }: { dist: LifecycleDistribution }) {
  const stages = buildTimeFunnelStages(dist)
  if (stages.length === 0) return null

  return (
    <div className={styles.conversionFunnel}>
      <p className={styles.funnelLabel}>转化时间漏斗（漏斗叠加）</p>
      <FunnelChart
        data={stages.map((stage) => ({
          label: stage.label,
          value: stage.value,
          displayValue: stage.displayValue,
        }))}
        className={styles.funnelChart}
        color="var(--warm-ledger-color-accent)"
        edges="curved"
        layers={2}
        orientation="horizontal"
        showPercentage={false}
        formatValue={(value) => `${value} 个`}
      />
    </div>
  )
}

function DistributionCard({
  dist,
  funnel = false,
}: {
  dist: LifecycleDistribution
  funnel?: boolean
}) {
  return (
    <article className={styles.distributionCard}>
      <h3>{dist.label}</h3>
      <p className={styles.distributionDescription}>{dist.description}</p>
      {dist.summary.sampleCount > 0 ? (
        <>
          <Histogram dist={dist} />
          <SummaryChips dist={dist} />
          {funnel ? <ConversionFunnel dist={dist} /> : null}
        </>
      ) : (
        <WarmCrmState
          className={styles.embeddedState}
          kind="empty"
          title="暂无数据"
        />
      )}
    </article>
  )
}

export interface LifecycleBoardSectionProps {
  board: LifecycleBoard | null
  loading?: boolean
}

export function LifecycleBoardSection({
  board,
  loading = false,
}: LifecycleBoardSectionProps) {
  return (
    <WarmCrmSection
      title="生命周期"
      actions={
        board && board.nowInSea > 0 ? (
          <WarmBadge tone="neutral">
            <Users aria-hidden="true" />
            当前公海 {board.nowInSea} 家
          </WarmBadge>
        ) : undefined
      }
    >
      {board ? (
        <div className={styles.distributionGrid}>
          <DistributionCard dist={board.firstFollow} />
          <DistributionCard dist={board.conversion} funnel />
          <DistributionCard dist={board.churn} />
        </div>
      ) : (
        <WarmCrmState
          className={styles.embeddedState}
          kind={loading ? 'loading' : 'empty'}
          title={loading ? '加载中…' : '暂无生命周期数据'}
        />
      )}
    </WarmCrmSection>
  )
}

export default LifecycleBoardSection
