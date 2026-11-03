/**
 * Page-local inventory overview: health, eight KPIs, and six analysis panels.
 * The monthly trend and each distribution keep their existing filter scopes.
 */

import { useMemo, type ReactNode } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts'

import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'

import {
  computeMomChange,
  computeOverviewKpis,
  dailyEventSummary,
  dispositionBreakdown,
  groupDetailByEventType,
  skuEndingSummary,
  topLocations,
} from './ledger-derive'
import {
  dispositionLabel,
  eventTypeLabel,
  type LedgerDetailRow,
  type LedgerSummaryRow,
  type SnapshotResponse,
  type TrendResponse,
} from './ledger-types'
import styles from './inventory-ledger-warm.module.css'

const eventChartConfig = {
  count: { label: '事件数', color: 'var(--warm-ledger-color-text-soft)' },
} satisfies ChartConfig

const dailyEventChartConfig = {
  count: { label: '事件数', color: 'var(--warm-ledger-color-accent)' },
  netQty: { label: '净数量', color: 'var(--warm-ledger-color-text-soft)' },
} satisfies ChartConfig

const trendChartConfig = {
  qty: { label: '期末库存', color: 'var(--warm-ledger-color-accent)' },
  damaged: { label: '损坏率 %', color: 'var(--warm-ledger-color-text-soft)' },
} satisfies ChartConfig

type OverviewPanelProps = {
  title: string
  children: ReactNode
  className?: string
}

function OverviewPanel({ title, children, className }: OverviewPanelProps) {
  return (
    <section className={`${styles.panel} ${className ?? ''}`}>
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>{title}</h2>
      </header>
      <div className={styles.panelBody}>{children}</div>
    </section>
  )
}

function KpiTile({
  label,
  value,
  tone,
  primary = false,
}: {
  label: string
  value: string
  tone?: 'positive' | 'negative' | 'warning'
  primary?: boolean
}) {
  const valueClass = tone === 'positive'
    ? styles.kpiPositive
    : tone === 'negative'
      ? styles.kpiNegative
      : tone === 'warning'
        ? styles.kpiWarning
        : ''

  return (
    <div className={`${styles.kpiTile} ${primary ? styles.kpiTilePrimary : ''}`}>
      <span className={styles.kpiLabel}>{label}</span>
      <span className={`${styles.kpiValue} ${valueClass}`.trim()}>{value}</span>
    </div>
  )
}

function HBarList({
  items,
  formatValue,
}: {
  items: { label: string; value: number; pct?: number }[]
  formatValue?: (value: number) => string
}) {
  const max = Math.max(...items.map((item) => item.value), 1)
  return (
    <div className={styles.barList}>
      {items.map((item) => (
        <div key={item.label} className={styles.barItem}>
          <div className={styles.barHeading}>
            <span className={styles.barLabel}>{item.label}</span>
            <span className={styles.barValue}>
              {formatValue ? formatValue(item.value) : item.value}
              {item.pct !== undefined && ` · ${item.pct.toFixed(1)}%`}
            </span>
          </div>
          <div className={styles.barTrack} aria-hidden="true">
            <div className={styles.barFill} style={{ width: `${(item.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function LedgerOverview({
  snapshot,
  trend,
  summaryRows,
  detailRows,
  mskuFilter,
}: {
  snapshot: SnapshotResponse | null
  trend: TrendResponse | null
  /** Summary uses MSKU/location/disposition; Detail also uses eventType. */
  summaryRows: LedgerSummaryRow[]
  detailRows: LedgerDetailRow[]
  mskuFilter: string
}) {
  const kpis = useMemo(
    () => computeOverviewKpis(summaryRows, detailRows),
    [summaryRows, detailRows],
  )
  const momChange = useMemo(
    () => (snapshot ? computeMomChange(snapshot.skus, mskuFilter) : null),
    [snapshot, mskuFilter],
  )
  const eventGroups = useMemo(() => groupDetailByEventType(detailRows), [detailRows])
  const dispositions = useMemo(() => dispositionBreakdown(summaryRows), [summaryRows])
  const locations = useMemo(() => topLocations(summaryRows, 5), [summaryRows])
  const skuRanking = useMemo(
    () => skuEndingSummary(summaryRows).slice(0, 10),
    [summaryRows],
  )
  const dailyEvents = useMemo(() => dailyEventSummary(detailRows), [detailRows])

  const trendData = useMemo(
    () =>
      (trend?.months ?? []).map((month) => ({
        month: month.report_month,
        qty: month.total_qty_eom,
        damaged: Number(month.damaged_pct.toFixed(2)),
      })),
    [trend],
  )

  const hasData = summaryRows.length > 0 || detailRows.length > 0
  const kpiTiles = [
    { label: 'SKU 数', value: hasData ? String(kpis.skuCount) : '—' },
    { label: '期末总库存', value: hasData ? String(kpis.endingTotal) : '—' },
    { label: '可售库存', value: hasData ? String(kpis.sellableQty) : '—' },
    { label: '损坏库存', value: hasData ? String(kpis.damagedQty) : '—' },
    {
      label: '损坏占比',
      value: hasData ? `${kpis.damagedPct.toFixed(1)}%` : '—',
      tone: kpis.damagedPct > 5 ? 'warning' as const : undefined,
    },
    {
      label: '事件净变动',
      value: hasData ? (kpis.netChange > 0 ? `+${kpis.netChange}` : String(kpis.netChange)) : '—',
      tone: kpis.netChange > 0 ? 'positive' as const : kpis.netChange < 0 ? 'negative' as const : undefined,
    },
    { label: '事件数', value: hasData ? String(kpis.eventCount) : '—' },
    {
      label: '环比变动',
      value: momChange === null ? '—' : momChange > 0 ? `+${momChange}` : String(momChange),
      tone: momChange === null ? undefined : momChange > 0 ? 'positive' as const : momChange < 0 ? 'negative' as const : undefined,
    },
  ]

  return (
    <section className={styles.overview} aria-label="库存月度概览">
      <div className={styles.kpiGrid}>
        <div className={styles.kpiSummaryGroup}>
          <p className={styles.kpiScope}>汇总库存 · MSKU / 仓库 / 状态</p>
          <div className={styles.kpiSummaryTiles}>
            {kpiTiles.slice(0, 5).map((tile) => (
              <KpiTile
                key={tile.label}
                {...tile}
                primary={tile.label === '期末总库存'}
              />
            ))}
          </div>
        </div>
        <div className={styles.kpiDetailGroup}>
          <p className={styles.kpiScope}>明细事件 · 四项筛选</p>
          <div className={styles.kpiDetailTiles}>
            {kpiTiles.slice(5, 7).map((tile) => <KpiTile key={tile.label} {...tile} />)}
          </div>
        </div>
        <div className={styles.kpiMomGroup}>
          <p className={styles.kpiScope}>仅 MSKU 筛选</p>
          <KpiTile {...kpiTiles[7]} />
        </div>
      </div>

      <div className={styles.chartGrid}>
        <OverviewPanel
          title={`近 ${trendData.length} 月库存趋势`}
          className={styles.trendPanel}
        >
          <p className={styles.panelContext}>
            项目级期末库存与损坏率（不受维度筛选影响）
          </p>
          {trendData.length === 0 ? (
            <p className={styles.chartEmpty}>暂无趋势数据</p>
          ) : (
            <ChartContainer className={styles.chartContainer} config={trendChartConfig}>
              <LineChart accessibilityLayer data={trendData} margin={{ left: 4, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis axisLine={false} dataKey="month" tickLine={false} tickMargin={8} />
                <YAxis axisLine={false} tickLine={false} width={44} />
                <YAxis
                  axisLine={false}
                  orientation="right"
                  tickLine={false}
                  width={36}
                  unit="%"
                  yAxisId={1}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Line
                  dataKey="qty"
                  dot={false}
                  name="期末库存"
                  stroke="var(--color-qty)"
                  strokeWidth={2}
                />
                <Line
                  dataKey="damaged"
                  dot={false}
                  name="损坏率 %"
                  stroke="var(--color-damaged)"
                  strokeWidth={2}
                  yAxisId={1}
                />
              </LineChart>
            </ChartContainer>
          )}
        </OverviewPanel>

        <OverviewPanel title="事件构成" className={styles.eventPanel}>
          <p className={styles.panelContext}>明细四项筛选后 · 各事件类型条数</p>
          {eventGroups.length === 0 ? (
            <p className={styles.chartEmpty}>暂无事件数据</p>
          ) : (
            <ChartContainer className={styles.chartContainer} config={eventChartConfig}>
              <BarChart
                accessibilityLayer
                data={eventGroups.map((group) => ({
                  ...group,
                  label: eventTypeLabel(group.event_type),
                }))}
                margin={{ left: 4, right: 8, top: 8 }}
              >
                <CartesianGrid vertical={false} />
                <XAxis axisLine={false} dataKey="label" tickLine={false} tickMargin={8} />
                <YAxis allowDecimals={false} axisLine={false} tickLine={false} width={36} />
                <ChartTooltip
                  content={<ChartTooltipContent hideLabel />}
                  cursor={{ fill: 'var(--warm-ledger-color-raised)' }}
                />
                <Bar
                  dataKey="count"
                  name="事件数"
                  fill="var(--color-count)"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ChartContainer>
          )}
        </OverviewPanel>

        <OverviewPanel title="期末 Disposition 构成" className={styles.distributionPanel}>
          <p className={styles.panelContext}>汇总三项筛选后 · 期末库存按状态拆分</p>
          {dispositions.length === 0 ? (
            <p className={styles.chartEmpty}>暂无水位数据</p>
          ) : (
            <HBarList
              items={dispositions.map((item) => ({
                label: dispositionLabel(item.disposition),
                value: item.qty,
                pct: item.pct,
              }))}
            />
          )}
        </OverviewPanel>

        <OverviewPanel title="Top 仓库分布" className={styles.distributionPanel}>
          <p className={styles.panelContext}>汇总三项筛选后 · 期末库存最多的仓库</p>
          {locations.length === 0 ? (
            <p className={styles.chartEmpty}>暂无水位数据</p>
          ) : (
            <HBarList items={locations.map((location) => ({
              label: location.location,
              value: location.qty,
            }))} />
          )}
        </OverviewPanel>

        <OverviewPanel title="SKU 期末库存 Top 10" className={styles.distributionPanel}>
          <p className={styles.panelContext}>汇总三项筛选后 · 期末库存最高的 SKU</p>
          {skuRanking.length === 0 ? (
            <p className={styles.chartEmpty}>暂无水位数据</p>
          ) : (
            <HBarList items={skuRanking.map((row) => ({
              label: row.msku,
              value: row.endingQty,
            }))} />
          )}
        </OverviewPanel>

        <OverviewPanel title="每日事件活动" className={styles.distributionPanel}>
          <p className={styles.panelContext}>明细四项筛选后 · 按实际发生日期汇总事件数与净数量</p>
          {dailyEvents.length === 0 ? (
            <p className={styles.chartEmpty}>暂无事件数据</p>
          ) : (
            <ChartContainer className={styles.chartContainer} config={dailyEventChartConfig}>
              <BarChart
                accessibilityLayer
                data={dailyEvents}
                margin={{ left: 4, right: 8, top: 8 }}
              >
                <CartesianGrid vertical={false} />
                <XAxis axisLine={false} dataKey="date" tickLine={false} tickMargin={8} />
                <YAxis axisLine={false} tickLine={false} width={36} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar
                  dataKey="eventCount"
                  name="事件数"
                  fill="var(--color-count)"
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="netQty"
                  name="净数量"
                  fill="var(--color-netQty)"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ChartContainer>
          )}
        </OverviewPanel>
      </div>
    </section>
  )
}
