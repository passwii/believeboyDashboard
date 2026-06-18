'use client'

import { useMemo } from 'react'
import { Activity, Boxes, Eye, MousePointerClick, Percent, Users } from 'lucide-react'

import {
  DataCard,
  DataCardHeader,
  DataCardContent,
} from '@/components/ui/data-card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { fmtNum, fmtNumPrecise } from '@/lib/dashboard-format'
import { AreaSparkline } from './area-sparkline'

/**
 * 与 app/dashboard/page.tsx 保持一致的简化 DailyAnalysisRow 类型 —— 只声明本组件用到的字段。
 */
export interface HealthKpiRow {
  date: string
  order_qty: number
  sales_amount: number
  impressions: number
  clicks: number
  cpc: number
  ad_spend: number
  ad_orders: number
  available_qty: number
  page_views: number
  units_ordered: number
  sessions: number
  conversion_rate: number
}

export interface DashboardHealthKpisProps {
  currentRows: HealthKpiRow[]
  comparisonRows?: HealthKpiRow[]
  loading?: boolean
}

type HealthKey = 'stock' | 'impressions' | 'clicks' | 'cpc' | 'conv' | 'sessions'

interface HealthMeta {
  key: HealthKey
  label: string
  icon: React.ReactNode
  color: string // hsl(var(--chart-N))
  /** 当前周期数值计算 */
  current: (rows: HealthKpiRow[]) => number
  /** 上一周期数值计算 */
  previous: (rows: HealthKpiRow[]) => number
  /** 数值显示格式 */
  format: (n: number) => string
  /** sparkline trend:从 currentRows 提取每日数据 */
  trend: (rows: HealthKpiRow[]) => number[]
  /** sparkline tooltip 数值格式 */
  trendFormat: (n: number) => string
}

const HEALTH_META: HealthMeta[] = [
  {
    key: 'stock',
    label: '可用库存',
    icon: <Boxes className="h-3.5 w-3.5" />,
    color: 'hsl(var(--chart-1))',
    // 可用库存:取区间最后一天的快照(每日是当时累计)
    current: (rows) => (rows.length > 0 ? rows[rows.length - 1].available_qty ?? 0 : 0),
    previous: (rows) => (rows.length > 0 ? rows[rows.length - 1].available_qty ?? 0 : 0),
    format: (n) => `${fmtNumPrecise(n)} 件`,
    trend: (rows) => rows.map((r) => r.available_qty ?? 0),
    trendFormat: (n) => `${fmtNumPrecise(n)} 件`,
  },
  {
    key: 'impressions',
    label: '曝光',
    icon: <Eye className="h-3.5 w-3.5" />,
    color: 'hsl(var(--chart-2))',
    current: (rows) => rows.reduce((s, r) => s + (r.impressions ?? 0), 0),
    previous: (rows) => rows.reduce((s, r) => s + (r.impressions ?? 0), 0),
    format: (n) => `${fmtNum(n)} 次`,
    trend: (rows) => rows.map((r) => r.impressions ?? 0),
    trendFormat: (n) => fmtNumPrecise(n),
  },
  {
    key: 'clicks',
    label: '点击',
    icon: <MousePointerClick className="h-3.5 w-3.5" />,
    color: 'hsl(var(--chart-3))',
    current: (rows) => rows.reduce((s, r) => s + (r.clicks ?? 0), 0),
    previous: (rows) => rows.reduce((s, r) => s + (r.clicks ?? 0), 0),
    format: (n) => fmtNum(n),
    trend: (rows) => rows.map((r) => r.clicks ?? 0),
    trendFormat: (n) => fmtNumPrecise(n),
  },
  {
    key: 'cpc',
    label: 'CPC',
    icon: <Activity className="h-3.5 w-3.5" />,
    color: 'hsl(var(--chart-4))',
    current: (rows) => {
      const totalClicks = rows.reduce((s, r) => s + (r.clicks ?? 0), 0)
      if (totalClicks <= 0) return 0
      const totalAdSpend = rows.reduce((s, r) => s + (r.ad_spend ?? 0), 0)
      return totalAdSpend / totalClicks
    },
    previous: (rows) => {
      const totalClicks = rows.reduce((s, r) => s + (r.clicks ?? 0), 0)
      if (totalClicks <= 0) return 0
      const totalAdSpend = rows.reduce((s, r) => s + (r.ad_spend ?? 0), 0)
      return totalAdSpend / totalClicks
    },
    format: (n) => `$${n.toFixed(2)}`,
    trend: (rows) => rows.map((r) => r.cpc ?? 0),
    trendFormat: (n) => `$${n.toFixed(2)}`,
  },
  {
    key: 'conv',
    label: '转化率',
    icon: <Percent className="h-3.5 w-3.5" />,
    color: 'hsl(var(--chart-5))',
    current: (rows) => {
      const totalClicks = rows.reduce((s, r) => s + (r.clicks ?? 0), 0)
      if (totalClicks <= 0) return 0
      const totalAdOrders = rows.reduce((s, r) => s + (r.ad_orders ?? 0), 0)
      return totalAdOrders / totalClicks
    },
    previous: (rows) => {
      const totalClicks = rows.reduce((s, r) => s + (r.clicks ?? 0), 0)
      if (totalClicks <= 0) return 0
      const totalAdOrders = rows.reduce((s, r) => s + (r.ad_orders ?? 0), 0)
      return totalAdOrders / totalClicks
    },
    format: (n) => `${(n * 100).toFixed(2)}%`,
    trend: (rows) => rows.map((r) => (r.conversion_rate ?? 0) * 100),
    trendFormat: (n) => `${n.toFixed(2)}%`,
  },
  {
    key: 'sessions',
    label: '会话',
    icon: <Users className="h-3.5 w-3.5" />,
    color: 'hsl(var(--chart-6))',
    current: (rows) => rows.reduce((s, r) => s + (r.sessions ?? 0), 0),
    previous: (rows) => rows.reduce((s, r) => s + (r.sessions ?? 0), 0),
    format: (n) => fmtNum(n),
    trend: (rows) => rows.map((r) => r.sessions ?? 0),
    trendFormat: (n) => fmtNumPrecise(n),
  },
]

/** 环比文本(无颜色,纯数值 —— 健康度的"下降"未必是坏事) */
function pctText(current: number, previous: number): string | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null
  const pct = ((current - previous) / previous) * 100
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(1)}%`
}

export function DashboardHealthKpis({
  currentRows,
  comparisonRows = [],
  loading = false,
}: DashboardHealthKpisProps) {
  const kpis = useMemo(
    () =>
      HEALTH_META.map((meta) => {
        const value = meta.current(currentRows)
        const prevValue = meta.previous(comparisonRows)
        return {
          ...meta,
          value,
          prevValue,
          changeText: pctText(value, prevValue),
          trendData: meta.trend(currentRows),
        }
      }),
    [currentRows, comparisonRows],
  )

  const isEmpty = currentRows.length === 0

  return (
    <DataCard className="h-full">
      <DataCardHeader
        title="库存 / 流量 健康度"
        description="6 维度核心指标 · 含 7 日趋势"
      />
      <DataCardContent className="space-y-2">
        {isEmpty ? (
          <EmptyHealth />
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {kpis.map((kpi) => (
              <HealthKpiRow key={kpi.key} kpi={kpi} loading={loading && kpi.trendData.every((v) => v === 0)} />
            ))}
          </div>
        )}
      </DataCardContent>
    </DataCard>
  )
}

interface HealthKpiRowProps {
  kpi: HealthMeta & {
    value: number
    prevValue: number
    changeText: string | null
    trendData: number[]
  }
  loading: boolean
}

function HealthKpiRow({ kpi, loading }: HealthKpiRowProps) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-[hsl(var(--surface-subtle))] px-2.5 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'flex h-4 w-4 shrink-0 items-center justify-center rounded text-white/90',
            )}
            style={{ backgroundColor: kpi.color }}
          >
            {kpi.icon}
          </span>
          <span className="truncate text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
            {kpi.label}
          </span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-sm font-semibold tabular-nums leading-tight">
            {kpi.format(kpi.value)}
          </span>
          {kpi.changeText && (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {kpi.changeText}
            </span>
          )}
        </div>
      </div>
      <div className="h-9 w-20 shrink-0">
        {loading ? (
          <Skeleton className="h-full w-full" />
        ) : (
          <AreaSparkline
            trend={kpi.trendData}
            gradientId={`health-${kpi.key}`}
            strokeColor={kpi.color}
            strokeWidth={2}
            formatValue={kpi.trendFormat}
          />
        )}
      </div>
    </div>
  )
}

function EmptyHealth() {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <div className="mb-2 rounded-xl bg-secondary/10 p-2.5 text-secondary">
        <Activity className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium text-foreground">暂无健康度数据</p>
      <p className="mt-1 max-w-[220px] text-xs leading-relaxed text-muted-foreground">
        当前时段没有可统计的库存 / 流量数据。
      </p>
    </div>
  )
}