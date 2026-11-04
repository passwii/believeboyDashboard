'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Database, RefreshCw, Server, Trash2 } from 'lucide-react'
import { useSession } from 'next-auth/react'

import {
  WarmBadge,
  WarmButton,
  type WarmBadgeTone,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import { buildBackendClientHeaders } from '@/lib/backend-auth'
import styles from './data-management-warm.module.css'

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

function tableStatusTone(status: TableHealthStatus): WarmBadgeTone {
  if (status === 'healthy') return 'positive'
  if (status === 'stale') return 'accent'
  if (status === 'error') return 'negative'
  return 'neutral'
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
  useHeaderRefresh(refreshAll, { loading: loading || detailsLoading })

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
  }, [refreshAll, session, notify, confirm])

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
        icon: Database,
        tone: snapshot.database.healthy ? 'positive' : 'negative',
      },
      {
        key: 'tables',
        title: '表数量',
        value: formatNumber(summary.total_tables),
        hint: detailsLoading ? '明细加载中' : `异常/陈旧 ${summary.stale_tables}`,
        icon: Server,
        tone: summary.stale_tables > 0 ? 'accent' : 'neutral',
      },
      {
        key: 'rows',
        title: '总数据量',
        value: formatNumber(summary.total_rows),
        hint: detailsLoading ? '正在更新统计' : '统计所有业务表',
        icon: Database,
        tone: 'neutral',
      },
      {
        key: 'status',
        title: '数据状态',
        value: statusLabel(summary.data_status),
        hint: `更新时间 ${formatDateTime(snapshot.data_status_updated_at)}`,
        icon: CheckCircle2,
        tone: 'accent',
      },
    ] satisfies Array<{
      key: string
      title: string
      value: string
      hint: string
      icon: typeof Database
      tone: 'positive' | 'negative' | 'accent' | 'neutral'
    }>
  }, [detailsLoading, overview, statusOverview])

  const isRefreshing = loading || detailsLoading

  return (
    <div className={styles.page} data-warm-data-management="true">
      <div className={styles.toolbar}>
        <WarmButton
          type="button"
          variant="secondary"
          onClick={() => void refreshAll()}
          disabled={isRefreshing || clearingCache}
          loading={isRefreshing}
          loadingLabel="正在刷新数据库状态"
        >
          {!isRefreshing ? <RefreshCw aria-hidden="true" /> : null}
          {isRefreshing ? '刷新中...' : '刷新状态'}
        </WarmButton>
        <WarmButton
          type="button"
          variant="secondary"
          className={styles.destructiveButton}
          onClick={() => void onClearCache()}
          disabled={isRefreshing || clearingCache}
          loading={clearingCache}
          loadingLabel="正在清理 Redis 缓存"
        >
          {!clearingCache ? <Trash2 aria-hidden="true" /> : null}
          {clearingCache ? '清理中...' : '清理缓存'}
        </WarmButton>
      </div>

      <section
        className={styles.summaryPanel}
        aria-label="数据库状态概览"
        aria-busy={isRefreshing}
      >
        {summaryCards.length > 0 ? (
          <div className={styles.summaryGrid}>
            {summaryCards.map((card) => {
              const Icon = card.icon

              return (
                <article
                  key={card.key}
                  className={styles.summaryCard}
                  data-tone={card.tone}
                >
                  <div className={styles.summaryLabel}>
                    <Icon aria-hidden="true" />
                    <span>{card.title}</span>
                  </div>
                  <p className={styles.summaryValue}>{card.value}</p>
                  <p className={styles.summaryHint}>{card.hint}</p>
                </article>
              )
            })}
          </div>
        ) : (
          <p className={styles.summaryPlaceholder} role="status">
            加载中...
          </p>
        )}
      </section>

      <section className={styles.tablePanel} aria-labelledby="data-table-status-title">
        <header className={styles.tableHeader}>
          <h2 id="data-table-status-title">数据表状态</h2>
        </header>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">表名</th>
                <th scope="col">中文名</th>
                <th scope="col">行数</th>
                <th scope="col">最后更新</th>
                <th scope="col">状态</th>
              </tr>
            </thead>
            <tbody>
              {!overview || overview.tables.length === 0 ? (
                <tr>
                  <td colSpan={5} className={styles.tableEmpty}>
                    {detailsLoading ? '加载中...' : '暂无表状态数据'}
                  </td>
                </tr>
              ) : (
                overview.tables.map((item) => (
                  <tr key={item.table_name} data-table-status={item.status}>
                    <td className={styles.tableName}>{item.table_name}</td>
                    <td>{item.table_name_cn ?? '-'}</td>
                    <td className={styles.numeric}>
                      {item.row_count == null ? '-' : formatNumber(item.row_count)}
                    </td>
                    <td className={styles.dateTime}>
                      {formatDateTime(item.last_updated_at)}
                    </td>
                    <td>
                      <WarmBadge tone={tableStatusTone(item.status)}>
                        {item.status}
                      </WarmBadge>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className={styles.sourceNote}>
        数据源：{(overview ?? statusOverview)?.database.source || '-'}，检查时间：
        {formatDateTime((overview ?? statusOverview)?.database.checked_at || null)}。
      </p>
    </div>
  )
}
