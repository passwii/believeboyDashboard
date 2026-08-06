/**
 * 总览区（BLF-428 前端重构）— 常驻于两个明细 tab 之上，响应全局筛选条。
 *
 * KPI / 构成 / 分布全部由 ledger-derive 从筛选后的 summary+detail 原始行
 * 派生（设计决策 D6）；趋势折线来自 /trend（项目级、月份序列，不参与维度筛选）。
 *
 * 本组件使用 recharts，页面侧用 next/dynamic + ssr:false 懒加载。
 */

import { useMemo } from 'react'
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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { cn } from '@/lib/utils'

import {
  computeKpis,
  computeMomChange,
  dispositionBreakdown,
  groupDetailByEventType,
  topLocations,
} from './ledger-derive'
import { ConsistencyBadge, IntegrityBadge } from './ledger-badges'
import {
  dispositionLabel,
  eventTypeLabel,
  type ConsistencyCheckResult,
  type LedgerDetailRow,
  type LedgerSummaryRow,
  type SnapshotResponse,
  type TrendResponse,
} from './ledger-types'

// ── KPI 卡 ────────────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'positive' | 'negative' | 'warning'
}) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="pb-0">
        <CardDescription className="text-xs">{label}</CardDescription>
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            'text-2xl font-semibold tabular-nums',
            tone === 'positive' && 'text-green-600',
            tone === 'negative' && 'text-red-600',
            tone === 'warning' && 'text-orange-600',
          )}
        >
          {value}
        </div>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}

// ── 事件类型配色 ──────────────────────────────────────────────────────────────

const EVENT_CHART_COLORS: Record<string, string> = {
  Receipts: 'var(--chart-1)',
  Shipments: 'var(--chart-2)',
  WhseTransfers: 'var(--chart-3)',
  CustomerReturns: 'var(--chart-4)',
  VendorReturns: 'var(--chart-5)',
  Adjustments: 'var(--chart-6)',
}

const eventChartConfig = {
  count: { label: '事件数' },
} satisfies ChartConfig

const trendChartConfig = {
  qty: { label: '期末库存', color: 'var(--chart-1)' },
  damaged: { label: '损坏率 %', color: 'var(--chart-2)' },
} satisfies ChartConfig

// ── 横向占比条（Disposition / Top 仓库共用） ──────────────────────────────────

function HBarList({
  items,
  formatValue,
}: {
  items: { label: string; value: number; pct?: number }[]
  formatValue?: (v: number) => string
}) {
  const max = Math.max(...items.map((i) => i.value), 1)
  return (
    <div className="space-y-2.5">
      {items.map((item) => (
        <div key={item.label} className="space-y-1">
          <div className="flex items-baseline justify-between text-xs">
            <span className="font-medium">{item.label}</span>
            <span className="tabular-nums text-muted-foreground">
              {formatValue ? formatValue(item.value) : item.value}
              {item.pct !== undefined && ` · ${item.pct.toFixed(1)}%`}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary/70"
              style={{ width: `${(item.value / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── 总览区主体 ────────────────────────────────────────────────────────────────

export function LedgerOverview({
  snapshot,
  trend,
  consistency,
  summaryRows,
  detailRows,
  mskuFilter,
}: {
  snapshot: SnapshotResponse | null
  trend: TrendResponse | null
  consistency: ConsistencyCheckResult | null
  /** 已按全局筛选过滤的 summary 行 */
  summaryRows: LedgerSummaryRow[]
  /** 已按全局筛选过滤的 detail 行 */
  detailRows: LedgerDetailRow[]
  mskuFilter: string
}) {
  const kpis = useMemo(() => computeKpis(summaryRows, detailRows), [summaryRows, detailRows])
  const momChange = useMemo(
    () => (snapshot ? computeMomChange(snapshot.skus, mskuFilter) : null),
    [snapshot, mskuFilter],
  )
  const eventGroups = useMemo(() => groupDetailByEventType(detailRows), [detailRows])
  const dispositions = useMemo(() => dispositionBreakdown(summaryRows), [summaryRows])
  const locations = useMemo(() => topLocations(summaryRows, 5), [summaryRows])

  const trendData = useMemo(
    () =>
      (trend?.months ?? []).map((m) => ({
        month: m.report_month,
        qty: m.total_qty_eom,
        damaged: Number(m.damaged_pct.toFixed(2)),
      })),
    [trend],
  )

  const hasData = summaryRows.length > 0 || detailRows.length > 0

  return (
    <div className="space-y-4">
      {/* 数据健康徽章 */}
      {(snapshot?.integrity || consistency) && (
        <div className="flex flex-wrap items-center gap-2">
          {snapshot?.integrity && <IntegrityBadge integrity={snapshot.integrity} />}
          {consistency && <ConsistencyBadge consistency={consistency} />}
        </div>
      )}

      {/* KPI 卡 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="期末总库存"
          value={hasData ? String(kpis.endingTotal) : '—'}
          hint="筛选范围内期末水位合计"
        />
        <KpiCard
          label="环比变动"
          value={momChange === null ? '—' : momChange > 0 ? `+${momChange}` : String(momChange)}
          tone={momChange === null ? 'default' : momChange > 0 ? 'positive' : momChange < 0 ? 'negative' : 'default'}
          hint="较上月期末（SKU 筛选口径）"
        />
        <KpiCard
          label="损坏占比"
          value={hasData ? `${kpis.damagedPct.toFixed(1)}%` : '—'}
          tone={kpis.damagedPct > 5 ? 'warning' : 'default'}
          hint={`非可售期末 ${kpis.damagedQty} 件`}
        />
        <KpiCard
          label="事件净变动"
          value={hasData ? (kpis.netChange > 0 ? `+${kpis.netChange}` : String(kpis.netChange)) : '—'}
          tone={kpis.netChange > 0 ? 'positive' : kpis.netChange < 0 ? 'negative' : 'default'}
          hint={`${kpis.eventCount} 条事件`}
        />
      </div>

      {/* 图表区 */}
      <div className="grid gap-3 lg:grid-cols-2">
        {/* 近 N 月趋势 */}
        <Card className="gap-2">
          <CardHeader>
            <CardTitle className="text-sm">近 {trendData.length} 月库存趋势</CardTitle>
            <CardDescription>项目级期末库存与损坏率（不受维度筛选影响）</CardDescription>
          </CardHeader>
          <CardContent>
            {trendData.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">暂无趋势数据</p>
            ) : (
              <ChartContainer className="h-52 w-full" config={trendChartConfig}>
                <LineChart accessibilityLayer data={trendData} margin={{ left: 4, right: 8, top: 8 }}>
                  <CartesianGrid className="stroke-border" vertical={false} />
                  <XAxis axisLine={false} dataKey="month" tickLine={false} tickMargin={8} />
                  <YAxis axisLine={false} tickLine={false} width={44} />
                  <YAxis axisLine={false} orientation="right" tickLine={false} width={36} unit="%" yAxisId={1} />
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
          </CardContent>
        </Card>

        {/* 事件构成 */}
        <Card className="gap-2">
          <CardHeader>
            <CardTitle className="text-sm">事件构成</CardTitle>
            <CardDescription>筛选范围内各事件类型条数</CardDescription>
          </CardHeader>
          <CardContent>
            {eventGroups.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">暂无事件数据</p>
            ) : (
              <ChartContainer className="h-52 w-full" config={eventChartConfig}>
                <BarChart
                  accessibilityLayer
                  data={eventGroups.map((g) => ({
                    ...g,
                    label: eventTypeLabel(g.event_type),
                    fill: EVENT_CHART_COLORS[g.event_type] ?? 'var(--chart-1)',
                  }))}
                  margin={{ left: 4, right: 8, top: 8 }}
                >
                  <CartesianGrid className="stroke-border" vertical={false} />
                  <XAxis axisLine={false} dataKey="label" tickLine={false} tickMargin={8} />
                  <YAxis allowDecimals={false} axisLine={false} tickLine={false} width={36} />
                  <ChartTooltip
                    content={<ChartTooltipContent hideLabel />}
                    cursor={{ fill: 'var(--muted)' }}
                  />
                  <Bar dataKey="count" name="事件数" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        {/* Disposition 构成 */}
        <Card className="gap-2">
          <CardHeader>
            <CardTitle className="text-sm">期末 Disposition 构成</CardTitle>
            <CardDescription>筛选范围内期末库存按状态拆分</CardDescription>
          </CardHeader>
          <CardContent>
            {dispositions.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">暂无水位数据</p>
            ) : (
              <HBarList
                items={dispositions.map((d) => ({
                  label: dispositionLabel(d.disposition),
                  value: d.qty,
                  pct: d.pct,
                }))}
              />
            )}
          </CardContent>
        </Card>

        {/* Top 仓库 */}
        <Card className="gap-2">
          <CardHeader>
            <CardTitle className="text-sm">Top 仓库分布</CardTitle>
            <CardDescription>筛选范围内期末库存最多的仓库</CardDescription>
          </CardHeader>
          <CardContent>
            {locations.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">暂无水位数据</p>
            ) : (
              <HBarList items={locations.map((l) => ({ label: l.location, value: l.qty }))} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
