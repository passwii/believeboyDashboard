'use client'

import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import dynamic from 'next/dynamic'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  Loader2,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  TrendingUp,
} from 'lucide-react'
import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { EmptyState, EmptyTableState, EmptyChartState } from '@/components/ui/empty-state'
import { FilterToolbar } from '@/components/ui/filter-toolbar'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { StatCard, StatCardRow } from '@/components/ui/stat-card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { DataTableCard, DataTableCardHeader, DataTableCardBody } from '@/components/ui/data-card'
import { SimpleDatePicker } from '@/components/ui/date-picker'
import { useNotifications } from '@/components/notifications'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import {
  type ComplaintOverview,
  type CheckStatus,
  fetchComplaintOverview,
} from '@/lib/complaint-api'

const LazyTrendChart = dynamic(
  () => import('./components/trend-chart').then((m) => m.ComplaintTrendChart),
  {
    ssr: false,
    loading: () => (
      <div className="border border-term-border bg-term-panel p-2">
        <Skeleton className="h-[260px] w-full rounded-none" />
      </div>
    ),
  }
)

const CHECK_STATUS_LABEL: Record<CheckStatus, string> = {
  ok: '正常',
  login_page: '登录页',
  launch_fail: '启动失败',
  identity_mismatch: '身份不符',
}

const CHECK_STATUS_STYLE: Record<CheckStatus, string> = {
  ok: 'text-term-pos',
  launch_fail: 'text-term-neg',
  identity_mismatch: 'text-term-warn',
  login_page: 'text-term-warn',
}

function formatDateLabel(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function getDayStart(d: Date | undefined): Date {
  const r = new Date(d ?? new Date())
  r.setHours(0, 0, 0, 0)
  return r
}

export default function ComplaintCenterClient() {
  const { notify } = useNotifications()
  const [date, setDate] = useState<Date>(new Date())
  const [overview, setOverview] = useState<ComplaintOverview | null>(null)
  const [loading, setLoading] = useState(true)

  const loadOverview = useCallback(async () => {
    setLoading(true)
    try {
      const iso = date.toISOString().slice(0, 10)
      const data = await fetchComplaintOverview({ date: iso, country: 'US' })
      setOverview(data)
    } catch (err) {
      notify({ type: 'error', title: '加载失败', message: `加载概览失败: ${(err as Error).message}` })
    } finally {
      setLoading(false)
    }
  }, [date, notify])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  const handleRefreshRef = useRef(loadOverview)
  handleRefreshRef.current = loadOverview
  useHeaderRefresh(() => handleRefreshRef.current(), { loading })

  const dateLabel = date.toISOString().slice(0, 10)
  const isToday = useMemo(() => {
    const today = new Date()
    return (
      today.getFullYear() === date.getFullYear() &&
      today.getMonth() === date.getMonth() &&
      today.getDate() === date.getDate()
    )
  }, [date])

  const hasPending = (overview?.metrics.total_needs_reply ?? 0) > 0
  const allFailed = overview?.projects.every((s) => s.check_status !== 'ok') ?? false
  const isEmpty = !loading && overview && overview.metrics.total_needs_reply === 0

  return (
    <div className="w-full space-y-6">
      <PageHeader
        eyebrow={<><ShieldAlert size={14} /> Agent 中心 · 客户消息</>}
        title="客户消息"
        description="每日巡检买家消息,管理待回复客诉。Agent 写入 → Dashboard 人工处理 → 状态流转。"
        actions={
          <Button variant="term" size="sm" asChild>
            <Link href="/dashboard/operations/complaint-center/list">
              <Eye size={14} />
              查看明细
            </Link>
          </Button>
        }
      />

      <FilterToolbar
        actions={
          <Button variant="term" size="sm" onClick={() => void loadOverview()} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            刷新
          </Button>
        }
      >
        <SimpleDatePicker
          value={date}
          onChange={(d) => d && setDate(getDayStart(d))}
          className="w-[140px]"
        />
      </FilterToolbar>

      {loading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-[88px] rounded-none" />
            ))}
          </div>
          <Skeleton className="h-[260px] w-full rounded-none" />
          <Skeleton className="h-[320px] w-full rounded-none" />
        </div>
      ) : overview ? (
        <>
          <StatCardRow>
            <StatCard
              title="待回复"
              value={String(overview.metrics.total_needs_reply)}
              icon={<MessageSquare size={16} />}
              color="sky"
            />
            <StatCard
              title="已解决"
              value={String(overview.metrics.total_resolved)}
              icon={<CheckCircle2 size={16} />}
              color="emerald"
            />
            <StatCard
              title="SLA 临期"
              value={String(overview.metrics.sla_due_soon)}
              icon={<Clock size={16} />}
              color="amber"
            />
            <StatCard
              title="已过期"
              value={String(overview.metrics.sla_overdue)}
              icon={<AlertTriangle size={16} />}
              color="rose"
            />
          </StatCardRow>

          <DataTableCard>
            <DataTableCardHeader
              title="近 30 天趋势"
              description="每日待回复客诉数"
              action={<TrendingUp size={14} className="text-term-muted" />}
            />
            <DataTableCardBody>
              {overview.trend.length > 0 ? (
                <LazyTrendChart data={overview.trend} />
              ) : (
                <EmptyChartState message="暂无趋势数据" height="h-[260px]" />
              )}
            </DataTableCardBody>
          </DataTableCard>

          <DataTableCard>
            <DataTableCardHeader
              title="店铺健康"
              description={`15 店铺巡检状态 · ${dateLabel}${isToday ? ' 今天' : ''}`}
            />
            <DataTableCardBody>
              {isEmpty ? (
                <EmptyState
                  icon="database"
                  message={
                    allFailed && overview.projects.length > 0
                      ? '今日巡检启动失败，请检查 Agent 配置'
                      : isToday
                        ? '今日无待回复消息'
                        : `${dateLabel} 无待回复消息`
                  }
                  className="py-16"
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[180px]">店铺</TableHead>
                      <TableHead>站点</TableHead>
                      <TableHead>巡检状态</TableHead>
                      <TableHead className="text-right">待回复</TableHead>
                      <TableHead className="text-right">已解决</TableHead>
                      <TableHead className="text-right">SLA 临期</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overview.projects.map((p) => (
                      <TableRow key={`${p.project_id}-${p.country}`}>
                        <TableCell className="font-medium text-term-text">{p.project_name}</TableCell>
                        <TableCell className="text-term-muted">{p.country}</TableCell>
                        <TableCell>
                          <span className={CHECK_STATUS_STYLE[p.check_status]}>
                            {CHECK_STATUS_LABEL[p.check_status]}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{p.needs_reply}</TableCell>
                        <TableCell className="text-right tabular-nums">{p.resolved}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {p.sla_due_soon > 0 ? (
                            <span className="text-term-warn">{p.sla_due_soon}</span>
                          ) : (
                            0
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </DataTableCardBody>
          </DataTableCard>
        </>
      ) : null}
    </div>
  )
}
