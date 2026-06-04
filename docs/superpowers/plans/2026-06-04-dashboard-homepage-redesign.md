# Dashboard 首页重设计 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 dashboard 首页从平铺直叙布局重设计为数据海报风格——指标磁贴、大图表区、合并的状态/告警面板，一眼掌控全局。

**架构：** 保留现有数据 hook (`useDashboardOverview`)，重新组织页面布局和组件。创建 3 个新组件（`DashboardToolbar`, `DashboardMetricTiles`, `DashboardSystemStatus`），升级 1 个现有组件（`DashboardSalesChart`），重写 `page.tsx` 布局。移除 SKU 表格引用。

**技术栈：** Next.js 14, React 18, Tailwind CSS, shadcn/ui, Recharts, Space Grotesk + Manrope 字体

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 重写 | `frontend/app/dashboard/page.tsx` | 新布局：toolbar + 指标+图表 + 状态面板 |
| 新建 | `frontend/components/dashboard/dashboard-toolbar.tsx` | 顶栏：视图切换 + 日期 + 刷新 |
| 新建 | `frontend/components/dashboard/dashboard-metric-tiles.tsx` | 指标磁贴 2×2 网格 |
| 新建 | `frontend/components/dashboard/dashboard-system-status.tsx` | 合并状态+告警面板 |
| 修改 | `frontend/components/dashboard/dashboard-sales-chart.tsx` | 样式升级（圆角、标题区、数据条） |
| 不变 | `frontend/components/dashboard/sku-sales-detail-table.tsx` | 保留组件，从首页移除引用 |
| 不变 | `frontend/components/dashboard/dashboard-status-cards.tsx` | 保留组件，从首页移除引用 |
| 不变 | `frontend/components/dashboard/dashboard-alert-widget.tsx` | 保留组件，从首页移除引用 |
| 不变 | `frontend/components/dashboard/metric-cards.tsx` | 保留组件，从首页移除引用 |
| 修改 | `frontend/components/dashboard/dashboard-page-loading.tsx` | 骨架屏适配新布局 |
| 不变 | `frontend/hooks/use-dashboard-overview.ts` | 数据 hook 保持不变 |

---

### 任务 1：创建 DashboardToolbar 组件

**文件：**
- 创建：`frontend/components/dashboard/dashboard-toolbar.tsx`

- [ ] **步骤 1：编写 DashboardToolbar 组件**

```tsx
// frontend/components/dashboard/dashboard-toolbar.tsx
'use client'

import { Calendar, CalendarDays, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

type ViewMode = 'today' | 'weekly'

interface DashboardToolbarProps {
  mode: ViewMode
  onModeChange: (mode: ViewMode) => void
  onRefresh: () => void
  refreshing?: boolean
  dateLabel?: string
}

export function DashboardToolbar({
  mode,
  onModeChange,
  onRefresh,
  refreshing = false,
  dateLabel,
}: DashboardToolbarProps) {
  return (
    <div className="dashboard-toolbar flex items-center justify-between rounded-xl">
      <div className="inline-flex items-center rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] p-1">
        <button
          onClick={() => onModeChange('today')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-all duration-200',
            mode === 'today'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Calendar className="h-3.5 w-3.5" />
          今日销售概况
        </button>
        <button
          onClick={() => onModeChange('weekly')}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-all duration-200',
            mode === 'weekly'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <CalendarDays className="h-3.5 w-3.5" />
          每周销售概况
        </button>
      </div>

      {dateLabel && (
        <span className="hidden text-xs text-muted-foreground sm:block">
          {dateLabel}
        </span>
      )}

      <button
        onClick={onRefresh}
        disabled={refreshing}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-background hover:text-foreground',
          refreshing && 'opacity-50'
        )}
      >
        <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
        刷新
      </button>
    </div>
  )
}

export type { ViewMode }
```

- [ ] **步骤 2：Commit**

```bash
git add frontend/components/dashboard/dashboard-toolbar.tsx
git commit -m "feat: 创建 DashboardToolbar 顶栏组件"
```

---

### 任务 2：创建 DashboardMetricTiles 组件

**文件：**
- 创建：`frontend/components/dashboard/dashboard-metric-tiles.tsx`

- [ ] **步骤 1：编写 DashboardMetricTiles 组件**

```tsx
// frontend/components/dashboard/dashboard-metric-tiles.tsx
'use client'

import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export interface MetricTileProps {
  title: string
  value: string
  change: string
  changeType: 'up' | 'down' | 'neutral'
  trend: number[]
  icon: React.ReactNode
  accentColor?: string
  badge?: string
  badgeColor?: string
}

function AcosTile({
  title,
  value,
  change,
  changeType,
  trend,
  icon,
  badge,
  badgeColor,
}: MetricTileProps) {
  const gradientId = title.toLowerCase().replace(/\s+/g, '-')
  const max = Math.max(...trend, 1)
  const min = Math.min(...trend)
  const range = Math.max(max - min, 1)
  const path = trend
    .map((point, index) => {
      const x = (index / Math.max(trend.length - 1, 1)) * 100
      const y = 28 - ((point - min) / range) * 22
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`
    })
    .join(' ')

  const bgClass =
    badgeColor === 'green'
      ? 'bg-secondary/5'
      : badgeColor === 'yellow'
        ? 'bg-amber-500/5'
        : badgeColor === 'red'
          ? 'bg-destructive/5'
          : ''

  return (
    <TileCard className={bgClass}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1.5">
          <p className="dashboard-kicker">{title}</p>
          <p className="dashboard-display text-[clamp(1.8rem,2.8vw,2.6rem)]">{value}</p>
          <div className="flex items-center gap-1.5">
            <ChangeIndicator change={change} type={changeType} />
            {badge && (
              <span
                className={cn(
                  'inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold',
                  badgeColor === 'green' && 'bg-secondary/10 text-secondary',
                  badgeColor === 'yellow' && 'bg-amber-500/10 text-amber-600',
                  badgeColor === 'red' && 'bg-destructive/10 text-destructive'
                )}
              >
                {badge}
              </span>
            )}
          </div>
        </div>
        <div className="rounded-lg bg-secondary/10 p-2.5 text-secondary">{icon}</div>
      </div>
      <div className="mt-2 h-8 w-full">
        <Sparkline path={path} gradientId={gradientId} />
      </div>
    </TileCard>
  )
}

function DefaultTile({
  title,
  value,
  change,
  changeType,
  trend,
  icon,
  accentColor,
}: MetricTileProps) {
  const gradientId = title.toLowerCase().replace(/\s+/g, '-')
  const max = Math.max(...trend, 1)
  const min = Math.min(...trend)
  const range = Math.max(max - min, 1)
  const path = trend
    .map((point, index) => {
      const x = (index / Math.max(trend.length - 1, 1)) * 100
      const y = 28 - ((point - min) / range) * 22
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`
    })
    .join(' ')

  return (
    <TileCard>
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1.5">
          <p className="dashboard-kicker">{title}</p>
          <p className="dashboard-display text-[clamp(1.8rem,2.8vw,2.6rem)]">{value}</p>
          <ChangeIndicator change={change} type={changeType} />
        </div>
        <div className="rounded-lg bg-secondary/10 p-2.5 text-secondary">{icon}</div>
      </div>
      <div className="mt-2 h-8 w-full">
        <SparkLineSvg gradientId={gradientId} accentColor={accentColor}>
          <path d={`${path} L 100 30 L 0 30 Z`} fill={`url(#spark-${gradientId})`} />
          <path
            d={path}
            fill="none"
            stroke={accentColor || 'hsl(var(--secondary))'}
            strokeWidth="2.25"
            strokeLinecap="round"
          />
        </SparkLineSvg>
      </div>
    </TileCard>
  )
}

function ChangeIndicator({ change, type }: { change: string; type: 'up' | 'down' | 'neutral' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center text-xs font-medium',
        type === 'up' && 'text-secondary',
        type === 'down' && 'text-destructive',
        type === 'neutral' && 'text-muted-foreground'
      )}
    >
      {type === 'up' && <ArrowUp className="mr-0.5 h-3 w-3" />}
      {type === 'down' && <ArrowDown className="mr-0.5 h-3 w-3" />}
      {type === 'neutral' && <Minus className="mr-0.5 h-3 w-3" />}
      {change}
    </span>
  )
}

function TileCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'hover-lift animate-enter relative rounded-xl border border-border/50 bg-background/70 p-5 backdrop-blur-sm',
        'transition-all duration-200',
        className
      )}
    >
      {children}
    </div>
  )
}

function SparkLineSvg({
  gradientId,
  accentColor,
  children,
}: {
  gradientId: string
  accentColor?: string
  children: React.ReactNode
}) {
  return (
    <svg viewBox="0 0 100 30" className="h-full w-full overflow-visible">
      <defs>
        <linearGradient id={`spark-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={accentColor || 'hsl(var(--secondary))'} stopOpacity="0.22" />
          <stop offset="100%" stopColor={accentColor || 'hsl(var(--secondary))'} stopOpacity="0" />
        </linearGradient>
      </defs>
      {children}
    </svg>
  )
}

function SparkLine({ path, gradientId }: { path: string; gradientId: string }) {
  return (
    <SparkLineSvg gradientId={gradientId}>
      <path d={`${path} L 100 30 L 0 30 Z`} fill={`url(#spark-${gradientId})`} />
      <path d={path} fill="none" stroke="hsl(var(--secondary))" strokeWidth="2.25" strokeLinecap="round" />
    </SparkLineSvg>
  )
}

function MetricTileSkeleton() {
  return (
    <div className="rounded-xl border border-border/50 bg-background/70 p-5 backdrop-blur-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-3 w-14" />
        </div>
        <Skeleton className="h-10 w-10 rounded-lg" />
      </div>
      <Skeleton className="mt-2 h-8 w-full rounded" />
    </div>
  )
}

export interface DashboardMetricTilesProps {
  metrics?: MetricTileProps[]
  loading?: boolean
}

export function DashboardMetricTiles({ metrics, loading = false }: DashboardMetricTilesProps) {
  if (loading && !metrics) {
    return (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-2 xl:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <MetricTileSkeleton key={i} />
        ))}
      </div>
    )
  }

  if (!metrics || metrics.length === 0) {
    return (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-2 xl:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <MetricTileSkeleton key={i} />
        ))}
      </div>
    )
  }

  const isAcosTile = (m: MetricTileProps) =>
    m.title === '广告成本比'

  return (
    <div className="grid grid-cols-2 gap-4">
      {metrics.map((metric) =>
        isAcosTile(metric) ? (
          <AcosTile key={metric.title} {...metric} />
        ) : (
          <DefaultTile
            key={metric.title}
            {...metric}
            accentColor={
              metric.title === '销售额'
                ? 'hsl(var(--secondary))'
                : metric.title === '订单量'
                  ? 'hsl(var(--chart-2))'
                  : undefined
            }
          />
        )
      )}
    </div>
  )
}
```

- [ ] **步骤 2：Commit**

```bash
git add frontend/components/dashboard/dashboard-metric-tiles.tsx
git commit -m "feat: 创建 DashboardMetricTiles 指标磁贴组件"
```

---

### 任务 3：创建 DashboardSystemStatus 合并面板

**文件：**
- 创建：`frontend/components/dashboard/dashboard-system-status.tsx`

- [ ] **步骤 1：编写 DashboardSystemStatus 组件**

合并原 `DashboardStatusCards` 的发货/退货/广告效果数据和 `DashboardAlertWidget` 的告警数据。

```tsx
// frontend/components/dashboard/dashboard-system-status.tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Bell,
  CheckCircle,
  RefreshCw,
  TrendingUp,
  Truck,
  RotateCcw,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { DataCard, DataCardHeader, DataCardContent } from '@/components/ui/data-card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { DashboardOverviewResponse } from '@/hooks/use-dashboard-overview'

// ── Alert types (from dashboard-alert-widget) ──

interface AlertStats {
  total_active: number
  critical_count: number
  warning_count: number
  info_count: number
  acknowledged_today: number
  resolved_today: number
}

interface AlertEvent {
  id: number
  message: string
  severity: string
  status: string
  triggered_at: string
  metric: string
  deviation_pct: number
}

// ── Helpers ──

function formatMoney(val: number) {
  return val >= 1000 ? `$${(val / 1000).toFixed(1)}k` : `$${val.toFixed(2)}`
}

function formatNumber(val: number) {
  return val >= 1000 ? `${(val / 1000).toFixed(1)}k` : String(val)
}

function formatRelativeTime(isoString: string): string {
  try {
    const date = new Date(isoString)
    const now = new Date()
    const diffMins = Math.floor((now.getTime() - date.getTime()) / 60000)
    const diffHours = Math.floor(diffMins / 60)
    const diffDays = Math.floor(diffHours / 24)
    if (diffMins < 1) return '刚刚'
    if (diffMins < 60) return `${diffMins}分钟前`
    if (diffHours < 24) return `${diffHours}小时前`
    return `${diffDays}天前`
  } catch {
    return ''
  }
}

// ── Sub-components ──

function StatCell({
  icon,
  label,
  children,
  className,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1 rounded-lg p-4', className)}>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <span className="text-secondary">{icon}</span>
        <span className="dashboard-kicker text-[0.65rem]">{label}</span>
      </div>
      {children}
    </div>
  )
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, { className: string; label: string }> = {
    critical: { className: 'bg-destructive/10 text-destructive border-destructive/20', label: '严重' },
    warning: { className: 'bg-amber-500/10 text-amber-600 border-amber-500/20', label: '警告' },
    info: { className: 'bg-primary/10 text-primary border-primary/20', label: '提示' },
  }
  const cfg = map[severity] ?? map.info
  return <Badge className={cn(cfg.className, 'text-[10px] px-1.5 border')}>{cfg.label}</Badge>
}

// ── Main component ──

interface DashboardSystemStatusProps {
  data: DashboardOverviewResponse | undefined
  loading?: boolean
}

export function DashboardSystemStatus({ data, loading = false }: DashboardSystemStatusProps) {
  const [stats, setStats] = useState<AlertStats | null>(null)
  const [recentEvents, setRecentEvents] = useState<AlertEvent[]>([])
  const [alertLoading, setAlertLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const fetchAlerts = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    try {
      const [statsRes, eventsRes] = await Promise.all([
        fetch('/api/backend/alerts/stats'),
        fetch('/api/backend/alerts/events?status=active&page_size=3'),
      ])
      if (statsRes.ok && eventsRes.ok) {
        const statsData = await statsRes.json()
        const eventsData = await eventsRes.json()
        setStats(statsData)
        setRecentEvents(eventsData.items || [])
      }
    } catch {
      // silent fail for alerts
    } finally {
      setAlertLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchAlerts()
  }, [fetchAlerts])

  const handleRefresh = () => fetchAlerts(true)

  const isLoading = (loading && !data) || alertLoading

  if (isLoading) {
    return (
      <DataCard>
        <DataCardHeader title="系统状态" />
        <DataCardContent>
          <div className="grid grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-6 w-12" />
                <Skeleton className="h-3 w-16" />
              </div>
            ))}
          </div>
          <div className="mt-4 space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </DataCardContent>
      </DataCard>
    )
  }

  const hasActive = stats && stats.total_active > 0

  return (
    <DataCard>
      <DataCardHeader
        title="系统状态"
        action={
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-background hover:text-foreground',
              refreshing && 'opacity-50'
            )}
          >
            <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
          </button>
        }
      />
      <DataCardContent className="space-y-4">
        {/* 4-column summary */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCell
            icon={<Truck className="h-3.5 w-3.5" />}
            label="发货"
            className="bg-secondary/5"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-semibold">{formatNumber(data?.shipments.in_transit_count ?? 0)}</span>
              <span className="text-xs text-muted-foreground">批</span>
            </div>
            <span className="text-xs text-muted-foreground">{formatNumber(data?.shipments.in_transit_qty ?? 0)} 件</span>
          </StatCell>

          <StatCell
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            label="退货"
            className="bg-amber-500/5"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-semibold">{data?.returns.return_rate.toFixed(1) ?? '0.0'}%</span>
            </div>
            <span className="text-xs text-muted-foreground truncate">
              {data?.returns.top_reason || '—'}
            </span>
          </StatCell>

          <StatCell
            icon={<TrendingUp className="h-3.5 w-3.5" />}
            label="广告效果"
            className="bg-[hsl(var(--chart-1))]/5"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-semibold text-secondary">
                {data?.ads.period_roas.toFixed(2) ?? '0.00'}
              </span>
              <span className="text-[10px] text-muted-foreground">ROAS</span>
            </div>
            <div className="flex gap-2 text-xs text-muted-foreground">
              <span>ACOS {data?.ads.period_acos.toFixed(1) ?? '0.0'}%</span>
              <span>CTR {data?.ads.period_ctr.toFixed(2) ?? '0.00'}%</span>
            </div>
          </StatCell>

          <StatCell
            icon={hasActive ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle className="h-3.5 w-3.5" />}
            label="告警"
            className={hasActive ? 'bg-destructive/5' : 'bg-secondary/5'}
          >
            {hasActive ? (
              <>
                <div className="flex items-baseline gap-2">
                  <span className="text-lg font-semibold text-destructive">{stats?.total_active ?? 0}</span>
                  <span className="text-xs text-muted-foreground">条活跃</span>
                </div>
                <div className="flex gap-1.5">
                  {stats && stats.critical_count > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-destructive">
                      <XCircle className="h-2.5 w-2.5" />
                      {stats.critical_count}
                    </span>
                  )}
                  {stats && stats.warning_count > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-amber-600">
                      <AlertTriangle className="h-2.5 w-2.5" />
                      {stats.warning_count}
                    </span>
                  )}
                </div>
              </>
            ) : (
              <span className="text-sm font-medium text-secondary">系统正常</span>
            )}
          </StatCell>
        </div>

        {/* Recent alert events */}
        {recentEvents.length > 0 && (
          <div className="space-y-2 border-t border-border/50 pt-3">
            {recentEvents.map((event) => (
              <div
                key={event.id}
                className="flex items-start gap-2.5 rounded-md border border-border/60 bg-[hsl(var(--surface-subtle))] px-3 py-2.5 dark:bg-[hsl(var(--surface-soft))]"
              >
                <div
                  className={cn(
                    'mt-0.5 h-2 w-2 shrink-0 rounded-full',
                    event.severity === 'critical'
                      ? 'bg-destructive'
                      : event.severity === 'warning'
                        ? 'bg-amber-500'
                        : 'bg-primary'
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium leading-tight text-foreground line-clamp-1">
                    {event.message}
                  </p>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">
                      {event.deviation_pct >= 0 ? '+' : ''}{event.deviation_pct.toFixed(1)}%
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatRelativeTime(event.triggered_at)}
                    </span>
                  </div>
                </div>
                <SeverityBadge severity={event.severity} />
              </div>
            ))}
          </div>
        )}

        {/* Footer: resolved/acknowledged today */}
        {stats && (stats.acknowledged_today > 0 || stats.resolved_today > 0) && (
          <div className="flex items-center justify-center gap-4 border-t border-border/50 pt-2">
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <CheckCircle className="h-2.5 w-2.5 text-secondary" />
              今日确认 {stats.acknowledged_today}
            </span>
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <CheckCircle className="h-2.5 w-2.5 text-primary" />
              今日解决 {stats.resolved_today}
            </span>
          </div>
        )}
      </DataCardContent>
    </DataCard>
  )
}
```

- [ ] **步骤 2：Commit**

```bash
git add frontend/components/dashboard/dashboard-system-status.tsx
git commit -m "feat: 创建 DashboardSystemStatus 合并面板组件"
```

---

### 任务 4：升级 DashboardSalesChart 样式

**文件：**
- 修改：`frontend/components/dashboard/dashboard-sales-chart.tsx`

升级要点：
1. 柱状图圆角增大 `radius=[8,8,0,0]`
2. 内嵌数据摘要磁贴改为更紧凑的 inline 横排
3. 图表背景改为 `surface-soft`
4. 空状态升级

- [ ] **步骤 1：修改 DashboardSalesChart 的柱状图圆角和数据摘要区**

在 `dashboard-sales-chart.tsx` 中，修改以下位置：

1. 将所有 `<Bar>` 的 `radius={[6, 6, 0, 0]}` 改为 `radius={[8, 8, 0, 0]}`
2. 将所有 `<Bar>` 的 `barSize={isMobile ? 10 : 14}` 改为 `barSize={isMobile ? 12 : 16}`
3. 将内嵌数据摘要区的样式从 `rounded-lg border border-border/70 bg-[hsl(var(--surface-soft))]/80 px-3 py-3` 改为更紧凑的 `rounded-lg border border-border/50 bg-[hsl(var(--surface-soft))]/60 px-2.5 py-2`

这些修改直接在现有文件中定位并替换即可。

- [ ] **步骤 2：Commit**

```bash
git add frontend/components/dashboard/dashboard-sales-chart.tsx
git commit -m "feat: 升级销售图表样式—更大圆角和更紧凑的数据条"
```

---

### 任务 5：重写 DashboardPage 布局

**文件：**
- 修改：`frontend/app/dashboard/page.tsx`

这是核心任务——将所有新组件组装到新布局中。

- [ ] **步骤 1：重写 page.tsx**

```tsx
// frontend/app/dashboard/page.tsx
'use client'

import { useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'

import { DashboardSalesChart } from '@/components/dashboard/dashboard-sales-chart'
import { DashboardPageLoading } from '@/components/dashboard/dashboard-page-loading'
import { FactoryDashboard } from '@/components/dashboard/factory-dashboard'
import { DashboardToolbar, type ViewMode } from '@/components/dashboard/dashboard-toolbar'
import { DashboardMetricTiles } from '@/components/dashboard/dashboard-metric-tiles'
import type { MetricTileProps } from '@/components/dashboard/dashboard-metric-tiles'
import { DashboardSystemStatus } from '@/components/dashboard/dashboard-system-status'
import { useDashboardOverview } from '@/hooks/use-dashboard-overview'
import type { DashboardOverviewResponse } from '@/hooks/use-dashboard-overview'

function buildMetricProps(data: DashboardOverviewResponse, mode: ViewMode) {
  const fmtMoney = (v: number) =>
    v >= 10000 ? `$${(v / 1000).toFixed(0)}k` : v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(2)}`
  const fmtNum = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v))
  const fmtPct = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`

  const salesTrend = data.sales_trend.map((t) => t.sales_amount)
  const orderTrend = data.sales_trend.map((t) => t.order_qty)

  const acos = data.ads.period_acos
  const acosBadge = acos <= 20 ? '优秀' : acos <= 40 ? '正常' : '偏高'
  const acosBadgeColor = acos <= 20 ? 'green' : acos <= 40 ? 'yellow' : 'red'

  return [
    {
      title: '销售额',
      value: fmtMoney(data.sales.today_sales_amount),
      change: fmtPct(data.sales.sales_change_pct),
      changeType: data.sales.change_type_sales as 'up' | 'down' | 'neutral',
      trend: salesTrend,
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
      accentColor: 'hsl(var(--secondary))',
    },
    {
      title: '订单量',
      value: fmtNum(data.sales.today_order_qty),
      change: fmtPct(data.sales.order_qty_change_pct),
      changeType: data.sales.change_type_order_qty as 'up' | 'down' | 'neutral',
      trend: orderTrend,
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
        </svg>
      ),
      accentColor: 'hsl(var(--chart-2))',
    },
    {
      title: '广告成本比',
      value: `${acos.toFixed(1)}%`,
      change: data.ads.period_spend > 0 ? fmtPct(-acos) : '—',
      changeType: (acos <= 20 ? 'up' : acos >= 40 ? 'down' : 'neutral') as 'up' | 'down' | 'neutral',
      trend: orderTrend,
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      ),
      badge: acosBadge,
      badgeColor: acosBadgeColor,
    },
    {
      title: '增长指数',
      value: fmtPct(data.sales.sales_change_pct),
      change: fmtPct(data.sales.sales_change_pct),
      changeType: data.sales.change_type_sales as 'up' | 'down' | 'neutral',
      trend: orderTrend,
      icon: (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
        </svg>
      ),
    },
  ] satisfies MetricTileProps[]
}

function getDateLabel(mode: ViewMode): string {
  const today = new Date()
  const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`
  if (mode === 'today') return fmt(today)
  const weekAgo = new Date(today)
  weekAgo.setDate(weekAgo.getDate() - 6)
  return `${fmt(weekAgo)} — ${fmt(today)}`
}

export default function DashboardPage() {
  const { data: session, status } = useSession()
  const roleType = session?.user?.roleType as string | undefined
  const operatorName = session?.user?.operatorNameZh ?? session?.user?.name ?? undefined

  const [viewMode, setViewMode] = useState<ViewMode>('today')
  const days = viewMode === 'today' ? 1 : 7

  const { data: overviewData, loading: overviewLoading, refresh: overviewRefresh } = useDashboardOverview({
    enabled: status === 'authenticated' && roleType !== 'factory',
    days,
  })

  if (status === 'loading') {
    return <DashboardPageLoading />
  }

  if (roleType === 'factory') {
    return <FactoryDashboard operatorName={operatorName} />
  }

  const metrics = overviewData ? buildMetricProps(overviewData, viewMode) : undefined
  const dateLabel = getDateLabel(viewMode)

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <DashboardToolbar
        mode={viewMode}
        onModeChange={setViewMode}
        onRefresh={() => overviewRefresh()}
        refreshing={overviewLoading}
        dateLabel={dateLabel}
      />

      {/* Main content: tiles + chart */}
      <section className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <DashboardMetricTiles metrics={metrics} loading={overviewLoading} />
        <DashboardSalesChart session={session} />
      </section>

      {/* System status */}
      <DashboardSystemStatus data={overviewData} loading={overviewLoading} />
    </div>
  )
}
```

- [ ] **步骤 2：本地验证 — 检查 TypeScript 编译**

```bash
cd frontend && npx tsc --noEmit 2>&1 | head -30
```

预期：无类型错误。如果有导入路径错误，修复后重试。

- [ ] **步骤 3：本地验证 — 构建检查**

```bash
cd frontend && pnpm build
```

预期：构建成功。

- [ ] **步骤 4：Commit**

```bash
git add frontend/app/dashboard/page.tsx
git commit -m "feat: 重写 dashboard 首页布局——数据海报风格"
```

---

### 任务 6：更新 DashboardPageLoading 骨架屏

**文件：**
- 修改：`frontend/components/dashboard/dashboard-page-loading.tsx`

- [ ] **步骤 1：重写骨架屏匹配新布局**

```tsx
// frontend/components/dashboard/dashboard-page-loading.tsx
import { Skeleton } from '@/components/ui/skeleton'

function MetricTileSkeleton() {
  return (
    <div className="rounded-xl border border-border/50 bg-background/70 p-5 backdrop-blur-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-3 w-14" />
        </div>
        <Skeleton className="h-10 w-10 rounded-lg" />
      </div>
      <Skeleton className="mt-2 h-8 w-full rounded" />
    </div>
  )
}

function ChartSkeleton() {
  return (
    <div className="dashboard-surface p-5">
      <div className="flex items-center justify-between pb-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-3 w-36" />
        </div>
        <Skeleton className="h-8 w-16" />
      </div>
      <div className="flex gap-3 pb-4">
        <Skeleton className="h-14 w-40" />
        <Skeleton className="h-14 w-40" />
      </div>
      <Skeleton className="h-[280px] w-full rounded-lg" />
    </div>
  )
}

function StatusSkeleton() {
  return (
    <div className="dashboard-surface p-5">
      <Skeleton className="h-5 w-24" />
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-6 w-12" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      <div className="mt-4 space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  )
}

export function DashboardPageLoading() {
  return (
    <div className="space-y-5">
      {/* Toolbar skeleton */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-8 w-16" />
      </div>

      {/* Tiles + Chart skeleton */}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="grid grid-cols-2 gap-4">
          <MetricTileSkeleton />
          <MetricTileSkeleton />
          <MetricTileSkeleton />
          <MetricTileSkeleton />
        </div>
        <ChartSkeleton />
      </div>

      {/* Status skeleton */}
      <StatusSkeleton />
    </div>
  )
}
```

- [ ] **步骤 2：Commit**

```bash
git add frontend/components/dashboard/dashboard-page-loading.tsx
git commit -m "feat: 更新骨架屏匹配新首页布局"
```

---

### 任务 7：最终验证与清理

- [ ] **步骤 1：TypeScript 编译检查**

```bash
cd frontend && npx tsc --noEmit
```

预期：无错误。

- [ ] **步骤 2：构建检查**

```bash
cd frontend && pnpm build
```

预期：构建成功，无警告阻断。

- [ ] **步骤 3：清理未使用的旧组件导入**

检查 `page.tsx` 中是否还引用了 `DashboardStatusCards`、`DashboardAlertWidget`、`MetricCards`、`SkuSalesDetailTable`。如果有残留导入，删除。

```bash
cd frontend && grep -n "DashboardStatusCards\|DashboardAlertWidget\|MetricCards\|SkuSalesDetailTable" app/dashboard/page.tsx
```

预期：无匹配（已移除）。

- [ ] **步骤 4：最终 Commit**

```bash
git add -A
git commit -m "chore: 清理首页旧组件引用，最终验证通过"
```