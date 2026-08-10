'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Database, Loader2, RefreshCw, Server, Trash2 } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataCard, DataCardContent, DataCardHeader } from '@/components/ui/data-card'
import {
  DataTableCard,
  DataTableCardBody,
  DataTableCardHeader,
  DataTableCardStatBar,
} from '@/components/ui/data-card'
import { EmptyTableState } from '@/components/ui/empty-state'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  STICKY_TOP_ROW,
} from '@/components/ui/table'
import { densityCell, densityHead } from '@/components/ui/table-presets'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import { buildBackendClientHeaders } from '@/lib/backend-auth'
import { cn } from '@/lib/utils'

type DataLifecycleStatus = 'active' | 'maintenance' | 'read_only' | 'paused'
type TableHealthStatus = 'healthy' | 'empty' | 'stale' | 'error'

type DataManagementOverview = {
  server_time: string
  database: {
    engine: string
    source: string | null
    healthy: boolean
    checked_at: string
  }
  cache_enabled: boolean
  summary: {
    total_tables: number
    total_rows: number
    stale_tables: number
    data_status: DataLifecycleStatus
  }
  data_status_note: string | null
  data_status_updated_at: string | null
  data_status_updated_by: string | null
  tables: Array<{
    table_name: string
    table_name_cn: string | null
    row_count: number | null
    last_updated_at: string | null
    status: TableHealthStatus
    note: string | null
  }>
  recent_statuses: Array<{
    source: string
    level: string
    message: string
    occurred_at: string
  }>
}

type DataManagementStatusPayload = {
  server_time: string
  database: {
    engine: string
    source: string | null
    healthy: boolean
    checked_at: string
  }
  cache_enabled: boolean
  summary: {
    total_tables: number
    total_rows: number
    stale_tables: number
    data_status: DataLifecycleStatus
  }
  data_status_note: string | null
  data_status_updated_at: string | null
  data_status_updated_by: string | null
}

const API_BASE = '/api/backend'
const EMPTY_SUMMARY = {
  total_tables: 0,
  total_rows: 0,
  stale_tables: 0,
  data_status: 'active' as DataLifecycleStatus,
}

function formatDateTime(value: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

async function parseError(response: Response): Promise<string> {
  const text = await response.text()
  try {
    const payload = JSON.parse(text) as { detail?: string; message?: string }
    return payload.detail || payload.message || `请求失败 (${response.status})`
  } catch {
    return text || `请求失败 (${response.status})`
  }
}

function statusLabel(status: DataLifecycleStatus): string {
  if (status === 'active') return '正常运行'
  if (status === 'maintenance') return '维护中'
  if (status === 'read_only') return '只读模式'
  return '暂停更新'
}

function tableStatusTone(status: TableHealthStatus): string {
  if (status === 'healthy')
    return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
  if (status === 'empty')
    return 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/30'
  if (status === 'stale')
    return 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30'
  return 'bg-destructive/10 text-destructive border-destructive/30'
}

function hasSummary(value: unknown): value is { summary: DataManagementOverview['summary'] } {
  return (
    !!value &&
    typeof value === 'object' &&
    'summary' in value &&
    !!(value as { summary?: unknown }).summary
  )
}

export default function SystemDataManagementPage() {
  const { data: session, status } = useSession()
  const { notify } = useNotifications()
  const { confirm } = useConfirm()
  const [overview, setOverview] = useState<DataManagementOverview | null>(null)
  const [statusOverview, setStatusOverview] = useState<DataManagementStatusPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [clearingCache, setClearingCache] = useState(false)

  const loadStatus = useCallback(async (): Promise<void> => {
    if (status === 'loading') return

    setLoading(true)

    try {
      const response = await fetch(`${API_BASE}/api/v1/system-management/data-management/status`, {
        headers: buildBackendClientHeaders(session),
        cache: 'no-store',
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      const payload = (await response.json()) as DataManagementStatusPayload
      if (!hasSummary(payload)) {
        throw new Error('数据状态接口返回缺少 summary 字段')
      }
      setStatusOverview(payload)
    } catch (loadErr) {
      notify({ type: 'error', title: loadErr instanceof Error ? loadErr.message : '状态加载失败' })
    } finally {
      setLoading(false)
    }
  }, [session, status, notify])

  const loadOverview = useCallback(async (): Promise<void> => {
    if (status === 'loading') return

    setDetailsLoading(true)

    try {
      const response = await fetch(
        `${API_BASE}/api/v1/system-management/data-management/overview`,
        {
          headers: buildBackendClientHeaders(session),
          cache: 'no-store',
        }
      )
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      const payload = (await response.json()) as DataManagementOverview
      if (!hasSummary(payload)) {
        throw new Error('数据总览接口返回缺少 summary 字段')
      }
      setOverview(payload)
      setStatusOverview((previous) => ({
        server_time: payload.server_time,
        database: payload.database,
        cache_enabled: payload.cache_enabled,
        summary: payload.summary,
        data_status_note: payload.data_status_note,
        data_status_updated_at: payload.data_status_updated_at,
        data_status_updated_by: payload.data_status_updated_by,
      }))
    } catch (loadErr) {
      notify({ type: 'error', title: loadErr instanceof Error ? loadErr.message : '状态加载失败' })
    } finally {
      setDetailsLoading(false)
    }
  }, [session, status, notify])

  useEffect(() => {
    if (status !== 'loading') {
      void loadStatus()
      void loadOverview()
    }
  }, [loadOverview, loadStatus, status])

  const refreshAll = useCallback(async () => {
    await Promise.all([loadStatus(), loadOverview()])
  }, [loadOverview, loadStatus])

  const onClearCache = useCallback(async () => {
    if (!(await confirm({ title: '确定要清理所有 Redis 缓存吗？', variant: 'destructive' }))) return

    setClearingCache(true)

    try {
      const response = await fetch(`${API_BASE}/api/v1/system-management/cache/clear-all`, {
        method: 'POST',
        headers: buildBackendClientHeaders(session),
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      const payload = (await response.json()) as { deleted_count: number; message: string }
      notify({ type: 'success', title: payload.message })
      await refreshAll()
    } catch (clearErr) {
      notify({
        type: 'error',
        title: clearErr instanceof Error ? clearErr.message : '缓存清理失败',
      })
    } finally {
      setClearingCache(false)
    }
  }, [refreshAll, session, notify])

  const summaryCards = useMemo(() => {
    const snapshot = overview ?? statusOverview
    if (!snapshot) return []
    const summary = snapshot.summary ?? EMPTY_SUMMARY
    return [
      {
        key: 'db',
        title: '数据库连接',
        value: snapshot.database.healthy ? '正常' : '异常',
        hint: `引擎 ${snapshot.database.engine}`,
        icon: <Database className="h-4 w-4" />,
        tone: snapshot.database.healthy ? 'text-emerald-600' : 'text-destructive',
      },
      {
        key: 'tables',
        title: '表数量',
        value: formatNumber(summary.total_tables),
        hint: detailsLoading ? '明细加载中' : `异常/陈旧 ${summary.stale_tables}`,
        icon: <Server className="h-4 w-4" />,
        tone: summary.stale_tables > 0 ? 'text-amber-600' : 'text-foreground',
      },
      {
        key: 'rows',
        title: '总数据量',
        value: formatNumber(summary.total_rows),
        hint: detailsLoading ? '正在更新统计' : '统计所有业务表',
        icon: <Database className="h-4 w-4" />,
        tone: 'text-foreground',
      },
      {
        key: 'status',
        title: '数据状态',
        value: statusLabel(summary.data_status),
        hint: `更新时间 ${formatDateTime(snapshot.data_status_updated_at)}`,
        icon: <CheckCircle2 className="h-4 w-4" />,
        tone: 'text-cyan-700 dark:text-cyan-300',
      },
    ]
  }, [detailsLoading, overview, statusOverview])

  return (
    <div className="w-full space-y-6">
      <DataCard>
        <DataCardHeader
          badge={
            <Badge
              variant="outline"
              className="w-fit rounded-full border-primary/25 bg-primary/10 px-3 py-1 text-xs font-semibold tracking-[0.14em] text-primary/90"
            >
              系统管理
            </Badge>
          }
          description="实时查看数据库状态、表状态、数据状态与最近系统状态。"
          action={
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => void refreshAll()}
                disabled={loading || detailsLoading || clearingCache}
              >
                {loading || detailsLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {loading || detailsLoading ? '刷新中...' : '刷新状态'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void onClearCache()}
                disabled={loading || detailsLoading || clearingCache}
              >
                {clearingCache ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                {clearingCache ? '清理中...' : '清理缓存'}
              </Button>
            </>
          }
        />
        <DataTableCardStatBar
          items={summaryCards.map((card) => ({
            label: card.title,
            value: card.value,
            highlight:
              card.key === 'status' ||
              (card.key === 'db' && (overview ?? statusOverview)?.database.healthy),
          }))}
          className={cn('border-t border-border/70', detailsLoading && 'opacity-60')}
        />
      </DataCard>

      <DataTableCard>
        <DataTableCardHeader>
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold text-foreground">数据表状态</h2>
            <p className="text-sm text-muted-foreground">
              检查各表数据规模、最近更新时间和健康状态。
            </p>
          </div>
        </DataTableCardHeader>
        <DataTableCardBody className="overflow-auto" style={{ maxHeight: '600px' }}>
          <Table>
            <TableHeader>
              <TableRow className={STICKY_TOP_ROW}>
                <TableHead className={densityHead.compact}>表名</TableHead>
                <TableHead className={densityHead.compact}>中文名</TableHead>
                <TableHead className={densityHead.compact}>行数</TableHead>
                <TableHead className={densityHead.compact}>最后更新</TableHead>
                <TableHead className={densityHead.compact}>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!overview || overview.tables.length === 0 ? (
                detailsLoading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      加载中...
                    </TableCell>
                  </TableRow>
                ) : (
                  <EmptyTableState colSpan={5} message="暂无表状态数据" />
                )
              ) : (
                overview.tables.map((item) => (
                  <TableRow key={item.table_name}>
                    <TableCell className={cn(densityCell.compact, 'font-medium')}>
                      {item.table_name}
                    </TableCell>
                    <TableCell className={densityCell.compact}>
                      {item.table_name_cn ?? '-'}
                    </TableCell>
                    <TableCell className={cn(densityCell.compact, 'tabular-nums')}>
                      {item.row_count == null ? '-' : formatNumber(item.row_count)}
                    </TableCell>
                    <TableCell className={densityCell.compact}>
                      {formatDateTime(item.last_updated_at)}
                    </TableCell>
                    <TableCell className={densityCell.compact}>
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2 py-0.5 text-xs',
                          tableStatusTone(item.status)
                        )}
                      >
                        {item.status}
                      </span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </DataTableCardBody>
      </DataTableCard>

      <p className="text-xs leading-5 text-muted-foreground">
        数据源：{(overview ?? statusOverview)?.database.source || '-'}，检查时间：
        {formatDateTime((overview ?? statusOverview)?.database.checked_at || null)}。
      </p>
    </div>
  )
}
