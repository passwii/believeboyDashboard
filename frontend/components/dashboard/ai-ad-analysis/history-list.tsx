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

import {
  WarmBadge,
  WarmButton,
  WarmIconButton,
  type WarmBadgeTone,
} from '@/components/dashboard-v2/warm-ledger/controls'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useConfirm } from '@/hooks/use-confirm'
import styles from './ai-ad-analysis-warm.module.css'
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
    tone: WarmBadgeTone
    icon: typeof CheckCircle2
  }
> = {
  completed: { label: '已完成', tone: 'positive', icon: CheckCircle2 },
  generating: { label: '生成中', tone: 'accent', icon: Loader2 },
  pending: { label: '等待中', tone: 'neutral', icon: Clock },
  failed: { label: '失败', tone: 'negative', icon: XCircle },
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
      <div data-warm-ad-history>
        <div className={styles.loadingState} role="status">
          <Loader2 className="animate-spin" aria-hidden />
          <span>加载中...</span>
        </div>
      </div>
    )
  }

  if (error && insights.length === 0) {
    return (
      <div data-warm-ad-history>
        <div className={styles.errorState} role="alert">
          <AlertTriangle aria-hidden />
          <span>{error}</span>
          <WarmButton type="button" variant="secondary" onClick={loadInsights}>
            重试
          </WarmButton>
        </div>
      </div>
    )
  }

  if (insights.length === 0) {
    return (
      <div data-warm-ad-history>
        <div className={styles.emptyState}>
          <FileText aria-hidden />
          <span>暂无广告分析报告</span>
          <span>点击「立即生成」按钮创建一个，或设置定时任务自动生成</span>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.stack} data-warm-ad-history>
      {error && (
        <div className={styles.errorBanner} role="alert">
          <AlertTriangle aria-hidden />
          <span>{error}</span>
          <WarmButton
            type="button"
            variant="quiet"
            className="ml-auto"
            onClick={() => setError(null)}
          >
            关闭
          </WarmButton>
        </div>
      )}

      <div className={styles.tableScroller} data-testid="ai-ad-history-table-scroll">
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>标题</th>
              <th>项目</th>
              <th>站点</th>
              <th>日期范围</th>
              <th>状态</th>
              <th>创建者</th>
              <th>创建时间</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {insights.map((item) => {
              const cfg = STATUS_CONFIG[item.status] || STATUS_CONFIG.pending
              const StatusIcon = cfg.icon
              return (
                <tr
                  key={item.id}
                  data-clickable={item.status === 'completed' ? 'true' : undefined}
                  onClick={() => {
                    if (item.status === 'completed') setViewInsightId(item.id)
                  }}
                >
                  <td className={styles.titleCell}>
                    <span className={styles.titleText}>{item.title}</span>
                  </td>
                  <td>{item.project_name}</td>
                  <td>
                    <WarmBadge tone="neutral">{item.country}</WarmBadge>
                  </td>
                  <td className={styles.numeric}>
                    {item.date_range_start} ~ {item.date_range_end}
                  </td>
                  <td>
                    <WarmBadge tone={cfg.tone}>
                      <StatusIcon
                        className={item.status === 'generating' ? 'animate-spin' : undefined}
                      />
                      {cfg.label}
                    </WarmBadge>
                  </td>
                  <td>{item.created_by}</td>
                  <td className={styles.numeric}>{formatDate(item.created_at)}</td>
                  <td>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                        <WarmIconButton
                          type="button"
                          aria-label="更多操作"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <MoreHorizontal aria-hidden />
                        </WarmIconButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className={styles.menuContent}>
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
                          className={styles.deleteItem}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          删除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination + stats footer */}
      <div className={styles.footer}>
        <span>共 {total} 条记录</span>
        {totalPages > 1 && (
          <div className={styles.pager}>
            <WarmButton
              type="button"
              variant="secondary"
              disabled={currentPage <= 1}
              onClick={() => setOffset(Math.max(0, offset - limit))}
            >
              上一页
            </WarmButton>
            <span>
              第 {currentPage} / {totalPages} 页
            </span>
            <WarmButton
              type="button"
              variant="secondary"
              disabled={currentPage >= totalPages}
              onClick={() => setOffset(offset + limit)}
            >
              下一页
            </WarmButton>
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
