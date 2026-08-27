'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Database, Loader2, RefreshCw, Server, Trash2 } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Button } from '@/components/ui/button'
import { TermPanel } from '@/components/terminal/term-panel'
import { TermPill, TermKpiTile, TERM_BUTTON } from '@/components/terminal/term-controls'
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
  // BLF-838：终端单色语义（healthy=pos · empty=muted · stale=warn · 其余 neg）
  if (status === 'healthy') return 'rounded-none border-term-pos/40 font-mono text-[11px] text-term-pos'
  if (status === 'empty') return 'rounded-none border-term-border font-mono text-[11px] text-term-muted'
  if (status === 'stale') return 'rounded-none border-term-warn/40 font-mono text-[11px] text-term-warn'
  return 'rounded-none border-term-neg/40 font-mono text-[11px] text-term-neg'
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
    <div className="w-full space-y-3">
      <TermPanel
        title="系统管理"
        bodyClassName="p-3"
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              className={TERM_BUTTON}
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
              className={TERM_BUTTON}
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
      >
        <div className="flex flex-wrap items-center gap-2">
          <TermPill tone="info">实时查看数据库/表/数据状态</TermPill>
        </div>
        <div className={cn('mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4', detailsLoading && 'opacity-60')}>
          {summaryCards.map((card) => (
            <TermKpiTile
              key={card.key}
              label={card.title}
              value={card.value}
              hint={card.hint}
            />
          ))}
        </div>
      </TermPanel>

      <TermPanel title="数据表状态" bodyClassName="overflow-auto p-0" className="overflow-hidden">
        <div style={{ maxHeight: '600px' }} className="overflow-auto">
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
                          'inline-flex items-center border px-1.5 py-0.5',
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
        </div>
      </TermPanel>

      <p className="font-mono text-xs leading-5 text-term-muted">
        数据源：{(overview ?? statusOverview)?.database.source || '-'}，检查时间：
        {formatDateTime((overview ?? statusOverview)?.database.checked_at || null)}。
      </p>
    </div>
  )
}
