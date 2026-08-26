'use client'

/**
 * 生命周期看板区块（P8，BLF-520）：客户从创建到 首次跟进/转化/流失 的时间分布。
 *
 * - 每个指标一张直方图（轻量 div 实现，不引入 recharts）+ 摘要 chips
 *   （样本 / 总体 / 均值 / 中位 / P90）。
 * - 转化指标额外叠加「转化时间漏斗」（FunnelChart 复用，BLF-518 之后同源）：
 *   已转化 → 30 天内 → 14 天内 → 7 天内 → 3 天内 → 1 天内。
 * - 右上角显示当前公海客户数快照。
 */
import { Users } from 'lucide-react'
import type { LifecycleBoard, LifecycleDistribution } from '@/lib/crm/types'
import { buildTimeFunnelStages } from '@/lib/crm/method/lifecycle'
import { FunnelChart } from '@/components/ui/funnel-chart'
import { TermPanel } from '@/components/terminal/term-panel'

/** 桶名缩写（横轴空间有限）："30 天以上" → "30 天+"。 */
const shortLabel = (label: string) => label.replace('天以上', '天+')

const fmt1 = (v: number | undefined) => (v === undefined ? '—' : `${v.toFixed(1)} 天`)

/** 摘要 chips：样本 / 总体 / 均值 / 中位 / P90（BLF-837 终端规格）。 */
function SummaryChips({ dist }: { dist: LifecycleDistribution }) {
  const s = dist.summary
  const chips = [
    { label: '样本', value: String(s.sampleCount) },
    { label: '总体', value: String(s.totalCount) },
    { label: '均值', value: fmt1(s.avgDays) },
    { label: '中位', value: fmt1(s.medianDays) },
    { label: 'P90', value: fmt1(s.p90Days) },
  ]
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <span
          key={c.label}
          className="inline-flex items-center gap-1 border border-term-border bg-term-panel px-1.5 py-0.5 font-mono text-[11px] text-term-muted"
        >
          <span>{c.label}</span>
          <span className="tabular-nums text-term-text">{c.value}</span>
        </span>
      ))}
    </div>
  )
}

/** 直方图：按桶计数画柱，柱顶显示数量（>0 时），hover 显示明细。 */
function Histogram({ dist }: { dist: LifecycleDistribution }) {
  const max = Math.max(...dist.buckets.map((b) => b.count), 1)
  return (
    <div>
      <div className="flex h-28 items-end gap-1.5">
        {dist.buckets.map((b) => {
          const h = b.count === 0 ? 0 : Math.max((b.count / max) * 100, 6)
          return (
            <div
              key={b.label}
              className="group relative flex-1"
              title={`${b.label}：${b.count} 个（${(b.pct * 100).toFixed(1)}%）`}
            >
              {b.count > 0 && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 font-mono text-[10px] tabular-nums text-term-muted">
                  {b.count}
                </div>
              )}
              <div
                className="w-full bg-term-accent/70 transition-colors group-hover:bg-term-accent"
                style={{ height: `${h}%` }}
              />
            </div>
          )
        })}
      </div>
      <div className="mt-1 flex gap-1.5 border-t border-term-border pt-1">
        {dist.buckets.map((b) => (
          <span
            key={b.label}
            className="flex-1 text-center font-mono text-[10px] leading-tight text-term-faint"
          >
            {shortLabel(b.label)}
          </span>
        ))}
      </div>
    </div>
  )
}

/** 转化时间漏斗叠加（漏斗叠加，BLF-520）。 */
function ConversionFunnel({ dist }: { dist: LifecycleDistribution }) {
  const stages = buildTimeFunnelStages(dist)
  if (stages.length === 0) return null
  return (
    <div className="mt-3">
      <p className="mb-1 font-mono text-xs uppercase tracking-wider text-term-muted">
        转化时间漏斗（漏斗叠加）
      </p>
      <FunnelChart
        data={stages.map((s) => ({
          label: s.label,
          value: s.value,
          displayValue: s.displayValue,
        }))}
        className="mx-auto w-full max-w-md"
        color="var(--chart-2)"
        edges="curved"
        layers={2}
        orientation="horizontal"
        showPercentage={false}
        formatValue={(v) => `${v} 个`}
      />
    </div>
  )
}

function DistributionCard({
  dist,
  color,
  funnel,
}: {
  dist: LifecycleDistribution
  color: string
  funnel?: boolean
}) {
  return (
    <div className="flex flex-col border border-term-border p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="font-mono text-xs uppercase tracking-wider text-term-muted">{dist.label}</h3>
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden
        />
      </div>
      <p className="mb-2 text-xs text-term-faint">{dist.description}</p>
      {dist.summary.sampleCount > 0 ? (
        <>
          <Histogram dist={dist} />
          <div className="mt-3">
            <SummaryChips dist={dist} />
          </div>
          {funnel && <ConversionFunnel dist={dist} />}
        </>
      ) : (
        <div className="flex h-32 items-center justify-center font-mono text-xs text-term-faint">
          暂无数据
        </div>
      )}
    </div>
  )
}

export interface LifecycleBoardSectionProps {
  board: LifecycleBoard | null
  loading?: boolean
}

export function LifecycleBoardSection({ board, loading = false }: LifecycleBoardSectionProps) {
  const hasBoard = board !== null
  return (
    // BLF-837：区块容器走 TermPanel（dashboard 页其余面板同规格）
    <TermPanel title="生命周期" actions={
      hasBoard && board!.nowInSea > 0 ? (
        <span className="mr-1 inline-flex items-center gap-1 font-mono text-xs tabular-nums text-term-muted">
          <Users className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
          当前公海 {board!.nowInSea} 家
        </span>
      ) : undefined
    }>
      <div className="p-3">
        {hasBoard ? (
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
            <DistributionCard dist={board!.firstFollow} color="var(--chart-1)" />
            <DistributionCard dist={board!.conversion} color="var(--chart-2)" funnel />
            <DistributionCard dist={board!.churn} color="var(--chart-3)" />
          </div>
        ) : (
          <div className="flex h-[240px] items-center justify-center font-mono text-xs text-term-faint">
            {loading ? '加载中…' : '暂无生命周期数据'}
          </div>
        )}
      </div>
    </TermPanel>
  )
}

export default LifecycleBoardSection
