'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  FileText,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useConfirm } from '@/hooks/use-confirm'
import { ViewDialog } from './view-dialog'

type InsightItem = {
  id: number
  project_id: number
  project_name: string
  country: string
  title: string
  insight_type: string
  date_range_start: string
  date_range_end: string
  status: string
  sub_status: string | null
  error_message?: string | null
  created_by: string
  created_at: string
  updated_at: string
}

interface HistoryListProps {
  projectId?: number | null
  country?: string | null
  refreshTrigger?: number
}

const STATUS_CONFIG: Record<
  string,
  {
    label: string
    variant: 'default' | 'secondary' | 'destructive' | 'outline'
    icon: typeof CheckCircle2
  }
> = {
  completed: { label: '已完成', variant: 'default', icon: CheckCircle2 },
  generating: { label: '生成中', variant: 'secondary', icon: Loader2 },
  pending: { label: '等待中', variant: 'outline', icon: Clock },
  failed: { label: '失败', variant: 'destructive', icon: XCircle },
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function HistoryList({ projectId, country, refreshTrigger }: HistoryListProps) {
  const [insights, setInsights] = useState<InsightItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [actionLoading, setActionLoading] = useState<number | null>(null)
  const [viewInsightId, setViewInsightId] = useState<number | null>(null)
  const { confirm } = useConfirm()
  const limit = 20

  const loadInsights = useCallback(async () => {
    try {
      setError(null)
      const params = new URLSearchParams({
        insight_type: 'ad_analysis',
        limit: String(limit),
        offset: String(offset),
      })
      if (projectId) params.set('project_id', String(projectId))
      if (country) params.set('country', country)

      const res = await fetch(`/api/backend/v1/ai-insights?${params}`)
      if (!res.ok) throw new Error('加载失败')
      const data = await res.json()
      setInsights(data.items || [])
      setTotal(data.total || 0)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [projectId, country, offset])

  useEffect(() => {
    setOffset(0)
  }, [projectId, country])

  useEffect(() => {
    setLoading(true)
    loadInsights()
  }, [loadInsights])

  useEffect(() => {
    if (refreshTrigger && refreshTrigger > 0) {
      loadInsights()
    }
  }, [refreshTrigger, loadInsights])

  const handleRetry = async (id: number) => {
    setActionLoading(id)
    try {
      const res = await fetch(`/api/backend/v1/ai-insights/${id}/retry`, { method: 'POST' })
      if (!res.ok) throw new Error('重试失败')
      loadInsights()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setActionLoading(null)
    }
  }

  const handleDelete = async (item: InsightItem) => {
    const ok = await confirm({
      title: '删除确认',
      description: `确定要删除「${item.title}」吗？此操作不可撤销。`,
    })
    if (!ok) return

    setActionLoading(item.id)
    try {
      const res = await fetch(`/api/backend/v1/ai-insights/${item.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('删除失败')
      loadInsights()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setActionLoading(null)
    }
  }

  const totalPages = Math.ceil(total / limit)
  const currentPage = Math.floor(offset / limit) + 1

  if (loading && insights.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">加载中...</span>
      </div>
    )
  }

  if (error && insights.length === 0) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center">
        <AlertTriangle className="mx-auto h-8 w-8 text-red-500 mb-3" />
        <p className="text-sm text-red-600 mb-4">{error}</p>
        <Button variant="outline" size="sm" onClick={loadInsights}>
          重试
        </Button>
      </div>
    )
  }

  if (insights.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center">
        <FileText className="mx-auto h-10 w-10 text-muted-foreground/50 mb-3" />
        <p className="text-sm text-muted-foreground mb-1">暂无广告分析报告</p>
        <p className="text-xs text-muted-foreground">
          点击「立即生成」按钮创建一个，或设置定时任务自动生成
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-2 text-sm text-amber-700 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
          <button className="ml-auto text-xs underline" onClick={() => setError(null)}>
            关闭
          </button>
        </div>
      )}

      <div className="rounded-lg border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="w-[220px]">标题</TableHead>
              <TableHead className="w-[120px]">项目</TableHead>
              <TableHead className="w-[60px]">站点</TableHead>
              <TableHead className="w-[160px]">日期范围</TableHead>
              <TableHead className="w-[80px] text-center">状态</TableHead>
              <TableHead className="w-[100px]">创建者</TableHead>
              <TableHead className="w-[120px]">创建时间</TableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {insights.map((item) => {
              const cfg = STATUS_CONFIG[item.status] || STATUS_CONFIG.pending
              const StatusIcon = cfg.icon
              return (
                <TableRow
                  key={item.id}
                  className={cn(
                    'cursor-pointer hover:bg-muted/30',
                    item.status === 'failed' && 'opacity-70'
                  )}
                  onClick={() => {
                    if (item.status === 'completed') setViewInsightId(item.id)
                  }}
                >
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <span className="truncate max-w-[200px]">{item.title}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{item.project_name}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">
                      {item.country}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {item.date_range_start} ~ {item.date_range_end}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant={cfg.variant} className="text-xs gap-1">
                      <StatusIcon
                        className={cn('h-3 w-3', item.status === 'generating' && 'animate-spin')}
                      />
                      {cfg.label}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground truncate max-w-[100px]">
                    {item.created_by}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(item.created_at)}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="sm" className="h-9 w-9 p-0 sm:h-8 sm:w-8">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-[140px]">
                        {item.status === 'completed' && (
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation()
                              setViewInsightId(item.id)
                            }}
                          >
                            <Eye className="mr-2 h-4 w-4" />
                            查看
                          </DropdownMenuItem>
                        )}
                        {item.status === 'failed' && (
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation()
                              handleRetry(item.id)
                            }}
                            disabled={actionLoading === item.id}
                          >
                            <RefreshCw className="mr-2 h-4 w-4" />
                            重试
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDelete(item)
                          }}
                          disabled={actionLoading === item.id}
                          className="text-red-600 focus:text-red-600"
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          删除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {/* Pagination + stats footer */}
      <div className="flex flex-col gap-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span>共 {total} 条记录</span>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage <= 1}
              onClick={() => setOffset(Math.max(0, offset - limit))}
            >
              上一页
            </Button>
            <span>
              第 {currentPage} / {totalPages} 页
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage >= totalPages}
              onClick={() => setOffset(offset + limit)}
            >
              下一页
            </Button>
          </div>
        )}
      </div>

      {/* View Dialog */}
      <ViewDialog
        open={viewInsightId !== null}
        onOpenChange={(open) => {
          if (!open) setViewInsightId(null)
        }}
        insightId={viewInsightId}
        onUpdated={loadInsights}
      />
    </div>
  )
}
