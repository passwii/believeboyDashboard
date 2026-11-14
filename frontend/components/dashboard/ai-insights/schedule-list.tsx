'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  AlertTriangle,
  Bell,
  ChevronDown,
  Clock,
  Copy,
  Edit2,
  Loader2,
  MoreHorizontal,
  Play,
  Power,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  parseCronExpression,
  formatDateTime,
  formatRelativeTime,
} from '@/lib/api/ai-insight-schedules'
import type { InsightScheduleItem } from '@/lib/api/ai-insight-schedules'
import { cn } from '@/lib/utils'

interface ScheduleListProps {
  onEdit: (schedule: InsightScheduleItem) => void
  onRefresh: () => void
  isRefreshing?: boolean
  /** When provided, the list filters schedules server-side by insight_type. */
  insightType?: string
}

export function ScheduleList({ onEdit, onRefresh, isRefreshing, insightType }: ScheduleListProps) {
  const [schedules, setSchedules] = useState<InsightScheduleItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<number | null>(null)

  const loadSchedules = useCallback(async () => {
    try {
      setError(null)
      const params = new URLSearchParams()
      if (insightType) params.set('insight_type', insightType)
      const query = params.toString()
      const res = await fetch(`/api/backend/v1/ai-insights/schedules${query ? `?${query}` : ''}`)
      if (!res.ok) throw new Error('加载失败')
      const data = await res.json()
      setSchedules(data.items || [])
    } catch (e: any) {
      setError(e.message || '加载定时任务失败')
      console.error('Failed to load schedules', e)
    } finally {
      setLoading(false)
    }
  }, [insightType])

  useEffect(() => {
    loadSchedules()
  }, [loadSchedules])

  // Refresh when parent signals
  useEffect(() => {
    if (!isRefreshing) return
    loadSchedules()
  }, [isRefreshing, loadSchedules])

  const handleToggle = async (schedule: InsightScheduleItem) => {
    setActionLoading(schedule.id)
    try {
      const res = await fetch(`/api/backend/v1/ai-insights/schedules/${schedule.id}/toggle`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error('操作失败')
      const data = await res.json()
      setSchedules((prev) =>
        prev.map((s) => (s.id === schedule.id ? { ...s, is_active: data.is_active } : s))
      )
    } catch (e: any) {
      setError(e.message || '切换失败')
    } finally {
      setActionLoading(null)
    }
  }

  const handleRunNow = async (schedule: InsightScheduleItem) => {
    setActionLoading(schedule.id)
    try {
      const res = await fetch(`/api/backend/v1/ai-insights/schedules/${schedule.id}/run-now`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error('操作失败')
      const data = await res.json()
      // Update with new stats
      setSchedules((prev) =>
        prev.map((s) =>
          s.id === schedule.id
            ? {
                ...s,
                last_insight_id: data.insight_id,
                run_count: s.run_count + 1,
              }
            : s
        )
      )
    } catch (e: any) {
      setError(e.message || '立即执行失败')
    } finally {
      setActionLoading(null)
    }
  }

  const handleDelete = async (schedule: InsightScheduleItem) => {
    if (!confirm(`确定要删除定时任务「${schedule.project_name}」吗？`)) return

    setActionLoading(schedule.id)
    try {
      const res = await fetch(`/api/backend/v1/ai-insights/schedules/${schedule.id}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error('删除失败')
      setSchedules((prev) => prev.filter((s) => s.id !== schedule.id))
    } catch (e: any) {
      setError(e.message || '删除失败')
    } finally {
      setActionLoading(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">加载中...</span>
      </div>
    )
  }

  if (error && schedules.length === 0) {
    return (
      <div className="rounded-lg border border-term-neg/30 bg-term-neg/5 p-6 text-center">
        <AlertTriangle className="mx-auto h-8 w-8 text-term-neg mb-3" />
        <p className="text-sm text-term-neg mb-4">{error}</p>
        <Button variant="outline" size="sm" onClick={loadSchedules}>
          重试
        </Button>
      </div>
    )
  }

  if (schedules.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center">
        <Clock className="mx-auto h-10 w-10 text-muted-foreground/50 mb-3" />
        <p className="text-sm text-muted-foreground mb-1">暂无定时任务</p>
        <p className="text-xs text-muted-foreground">点击上方「新建定时任务」按钮创建一个</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Error banner */}
      {error && (
        <div className="rounded-lg bg-term-warn/5 border border-term-warn/30 px-4 py-2 text-sm text-term-warn flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
          <button className="ml-auto text-xs underline" onClick={() => setError(null)}>
            关闭
          </button>
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="w-[140px]">项目</TableHead>
              <TableHead className="w-[80px]">站点</TableHead>
              <TableHead className="w-[80px]">类型</TableHead>
              <TableHead className="w-[140px]">执行时间</TableHead>
              <TableHead className="w-[120px]">数据范围</TableHead>
              <TableHead className="w-[100px]">下次执行</TableHead>
              <TableHead className="w-[80px] text-center">状态</TableHead>
              <TableHead className="w-[80px] text-center">执行/失败</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {schedules.map((schedule) => (
              <TableRow key={schedule.id} className={cn(!schedule.is_active && 'opacity-60')}>
                {/* Project */}
                <TableCell className="font-medium">{schedule.project_name}</TableCell>

                {/* Country */}
                <TableCell>
                  <Badge variant="outline" className="text-xs">
                    {schedule.country}
                  </Badge>
                </TableCell>

                {/* Insight Type */}
                <TableCell>
                  <Badge variant="secondary" className="text-xs">
                    {schedule.insight_type === 'daily'
                      ? '日报'
                      : schedule.insight_type === 'weekly'
                        ? '周报'
                        : schedule.insight_type === 'monthly'
                          ? '月报'
                          : '自定义'}
                  </Badge>
                </TableCell>

                {/* Cron Expression */}
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-sm font-mono">
                      {parseCronExpression(schedule.cron_expression)}
                    </span>
                  </div>
                </TableCell>

                {/* Date Range Strategy */}
                <TableCell>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="text-sm cursor-default">
                        {schedule.date_range_strategy === 'yesterday'
                          ? '昨日'
                          : schedule.date_range_strategy === 'last_7d'
                            ? '近 7 天'
                            : schedule.date_range_strategy === 'last_30d'
                              ? '近 30 天'
                              : schedule.date_range_strategy === 'prev_month'
                                ? '上月'
                                : schedule.date_range_strategy === 'current_month'
                                  ? '当月至今'
                                  : schedule.date_range_strategy === 'last_week'
                                    ? '上周'
                                    : schedule.date_range_strategy}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="text-xs">数据日期范围</p>
                    </TooltipContent>
                  </Tooltip>
                </TableCell>

                {/* Next Run */}
                <TableCell>
                  {schedule.next_run_at ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-sm text-primary cursor-default">
                          {formatRelativeTime(schedule.next_run_at)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">{formatDateTime(schedule.next_run_at)}</p>
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </TableCell>

                {/* Status */}
                <TableCell className="text-center">
                  {schedule.is_active ? (
                    <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                      启用
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="hover:bg-secondary">
                      禁用
                    </Badge>
                  )}
                </TableCell>

                {/* Run/Failure Count */}
                <TableCell className="text-center">
                  <div className="flex items-center justify-center gap-1 text-xs">
                    <span className="text-emerald-600 font-medium">{schedule.run_count}</span>
                    <span className="text-muted-foreground">/</span>
                    <span
                      className={cn(
                        'font-medium',
                        schedule.failure_count > 0 ? 'text-term-neg' : 'text-muted-foreground'
                      )}
                    >
                      {schedule.failure_count}
                    </span>
                  </div>
                </TableCell>

                {/* Actions */}
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-11 w-11 p-0 sm:h-8 sm:w-8"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                        <span className="sr-only">打开菜单</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-[160px]">
                      {/* Run Now */}
                      <DropdownMenuItem
                        onClick={() => handleRunNow(schedule)}
                        disabled={actionLoading === schedule.id}
                        className="min-h-11 sm:min-h-0"
                      >
                        <Play className="mr-2 h-4 w-4" />
                        立即执行
                      </DropdownMenuItem>

                      {/* Toggle */}
                      <DropdownMenuItem
                        onClick={() => handleToggle(schedule)}
                        disabled={actionLoading === schedule.id}
                        className="min-h-11 sm:min-h-0"
                      >
                        <Power className="mr-2 h-4 w-4" />
                        {schedule.is_active ? '禁用' : '启用'}
                      </DropdownMenuItem>

                      <DropdownMenuSeparator />

                      {/* Edit */}
                      <DropdownMenuItem
                        onClick={() => onEdit(schedule)}
                        className="min-h-11 sm:min-h-0"
                      >
                        <Edit2 className="mr-2 h-4 w-4" />
                        编辑
                      </DropdownMenuItem>

                      {/* Delete */}
                      <DropdownMenuItem
                        onClick={() => handleDelete(schedule)}
                        disabled={actionLoading === schedule.id}
                        className="min-h-11 text-term-neg focus:text-term-neg sm:min-h-0"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        删除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Stats footer */}
      <div className="flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span>共 {schedules.length} 个定时任务</span>
        <div className="flex items-center gap-4">
          <span>
            启用中:{' '}
            <span className="font-medium text-emerald-600">
              {schedules.filter((s) => s.is_active).length}
            </span>
          </span>
          <span>
            已执行:{' '}
            <span className="font-medium">
              {schedules.reduce((sum, s) => sum + s.run_count, 0)}
            </span>{' '}
            次
          </span>
        </div>
      </div>
    </div>
  )
}
