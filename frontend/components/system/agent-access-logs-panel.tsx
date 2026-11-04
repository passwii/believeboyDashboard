'use client'

/**
 * Agent 访问日志面板（BLF-448 抽离为共享组件）。
 *
 * 日志页与「Agent 接入管理」共用同一实现：自持状态与拉取
 * （/system-management/agent-access-logs + /summary），保留 keyword / method /
 * result / project / operation_type 筛选、分页与详情 Dialog。
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSession } from 'next-auth/react'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { WarmBadge, WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { Eye, RefreshCw, Search } from 'lucide-react'
import { buildBackendClientHeaders } from '@/lib/backend-auth'
import { normalizeErrorMessage, parseResponseError } from '@/lib/error-utils'
import { useNotifications } from '@/components/notifications'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { AGENT_DOMAINS } from '@/lib/agent-domains'
import { formatProjectRef } from '@/lib/agent-display'
import { accessOperationLabel } from '@/lib/agent-operation-labels'

const API_BASE = '/api/backend'

const PANEL =
  'min-w-0 overflow-hidden rounded-[16px] border border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel)] text-[color:var(--warm-ledger-color-text)] shadow-[var(--warm-ledger-highlight-rest)]'
const PANEL_HEADER =
  'flex min-h-12 items-center gap-2 border-b border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel-strong)] px-5'
const PANEL_TITLE =
  'm-0 min-w-0 truncate text-[16px] font-medium leading-[1.4] text-[color:var(--warm-ledger-color-text)]'
const PANEL_BODY = 'grid min-w-0 gap-3 p-5'
const STAT_GRID = 'grid min-w-0 grid-cols-5 gap-2'
const STAT_TILE =
  'flex min-w-0 min-h-[88px] flex-col justify-between gap-3 rounded-[10px] border border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel-strong)] px-4 py-3 shadow-[var(--warm-ledger-highlight-rest)]'
const STAT_LABEL =
  'truncate text-[11px] font-normal leading-4 text-[color:var(--warm-ledger-color-text-muted)]'
const STAT_VALUE =
  'truncate font-mono text-[28px] leading-none tabular-nums text-[color:var(--warm-ledger-color-text)]'
const RANK_PANEL =
  'grid min-w-0 gap-1 rounded-[10px] border border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel-strong)] p-3'
const RANK_LABEL =
  'm-0 mb-1 text-[11px] font-normal leading-4 text-[color:var(--warm-ledger-color-text-muted)]'
const FIELD = 'grid min-w-0 gap-1'
const FIELD_LABEL =
  'text-[11px] font-normal leading-4 text-[color:var(--warm-ledger-color-text-muted)]'
const SELECT =
  'h-10 w-full min-w-0 rounded-[10px] border border-[var(--warm-ledger-color-hairline-strong)] bg-[var(--warm-ledger-color-panel-strong)] px-3 text-[12px] text-[color:var(--warm-ledger-color-text)] shadow-[var(--warm-ledger-highlight-rest)] outline-none transition-[background-color,border-color] duration-[140ms] hover:bg-[var(--warm-ledger-color-raised)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--warm-ledger-color-accent-strong)]'
const INPUT = cn(
  SELECT,
  'placeholder:text-[color:var(--warm-ledger-color-text-muted)]'
)
const TABLE_SCROLL =
  'max-h-[520px] min-w-0 overflow-auto overscroll-contain border-b border-[var(--warm-ledger-color-hairline)]'
const TABLE = 'w-full min-w-[1320px] border-separate border-spacing-0 text-left text-[12px]'
const THEAD = 'sticky top-0 z-[1] bg-[var(--warm-ledger-color-panel-strong)]'
const TH =
  'border-b border-[var(--warm-ledger-color-hairline)] px-3 py-2.5 text-left text-[11px] font-medium leading-4 text-[color:var(--warm-ledger-color-text-muted)]'
const TD =
  'border-b border-[var(--warm-ledger-color-hairline)] px-3 py-2.5 align-middle leading-5 text-[color:var(--warm-ledger-color-text-soft)]'
const ROW =
  'cursor-pointer transition-colors duration-[140ms] hover:bg-[var(--warm-ledger-color-raised)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--warm-ledger-color-accent-strong)]'
const MUTED = 'text-[color:var(--warm-ledger-color-text-muted)]'
const PAGER =
  'flex min-h-11 flex-wrap items-center justify-between gap-2 px-5 text-[12px] tabular-nums text-[color:var(--warm-ledger-color-text-muted)]'
const DIALOG =
  '!max-h-[85vh] !max-w-[calc(100%-2rem)] !gap-0 !overflow-y-auto !rounded-[16px] !border-[var(--warm-ledger-color-hairline-strong)] !bg-[var(--warm-ledger-color-panel)] !p-0 !text-[color:var(--warm-ledger-color-text)] !shadow-[var(--warm-ledger-shadow-window)] sm:!max-w-3xl [&>button]:!right-4 [&>button]:!top-4 [&>button]:!rounded-[8px] [&>button]:!text-[color:var(--warm-ledger-color-text-muted)] [&>button:hover]:!bg-[var(--warm-ledger-color-raised)] [&>button:hover]:!text-[color:var(--warm-ledger-color-text)]'
const DIALOG_HEADER =
  'border-b border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel-strong)] px-5 py-4'
const DIALOG_TITLE =
  '!font-sans !text-[16px] !font-medium !tracking-normal !text-[color:var(--warm-ledger-color-text)]'
const DETAIL_GRID = 'grid gap-x-6 gap-y-2 sm:grid-cols-2'
const DETAIL_LABEL = 'text-[color:var(--warm-ledger-color-text-muted)]'
const DETAIL_VALUE = 'break-words text-[color:var(--warm-ledger-color-text)]'
const SUBPANEL =
  'rounded-[10px] border border-[var(--warm-ledger-color-hairline)] bg-[var(--warm-ledger-color-panel-strong)] p-3'
const SECTION_LABEL =
  'm-0 text-[11px] font-medium uppercase tracking-[0.04em] text-[color:var(--warm-ledger-color-text-muted)]'

export type AgentAccessLogItem = {
  id: number
  created_at: string
  method: string
  path: string
  status_code: number
  latency_ms: number
  ip_address: string | null
  api_key_id: number | null
  agent_id: string | null
  /** Agent 中文名即「名称」：join agent_api_keys 还原 key_label。 */
  key_label: string | null
  /** 请求涉及的项目 ID 与业务域（中间件从 path 解析）。 */
  project_id: number | null
  /** 请求涉及的项目名：运营侧只展示名称。 */
  project_name: string | null
  operation_type: string | null
  /** 审计国家维度；历史行与无 country 参数的请求为 NULL。 */
  country?: string | null
}

type AgentAccessLogsResponse = {
  items: AgentAccessLogItem[]
  total: number
  page: number
  page_size: number
  has_next: boolean
}

export type AgentAccessLogAgentSummaryItem = {
  agent_id: string
  key_label: string | null
  count: number
}

type AgentAccessLogsSummaryResponse = {
  total: number
  success_count: number
  error_count: number
  unique_agent_count: number
  top_agents: AgentAccessLogAgentSummaryItem[]
}

function formatDateTime(value: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

async function parseError(response: Response): Promise<string> {
  return parseResponseError(response, '请求失败')
}

function statusMeta(code: number) {
  if (code >= 500) return { label: `${code} · 服务端错误`, tone: 'negative' as const }
  if (code >= 400) return { label: `${code} · 请求错误`, tone: 'negative' as const }
  if (code >= 300) return { label: `${code} · 重定向`, tone: 'neutral' as const }
  return { label: `${code} · 成功`, tone: 'positive' as const }
}

function WarmPanel({
  title,
  actions,
  children,
  bodyClassName,
}: {
  title: string
  actions?: ReactNode
  children: ReactNode
  bodyClassName?: string
}) {
  return (
    <section className={PANEL} aria-label={title} data-warm-panel="true">
      <header className={PANEL_HEADER}>
        <h2 className={PANEL_TITLE}>{title}</h2>
        {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
      </header>
      <div className={cn(PANEL_BODY, bodyClassName)}>{children}</div>
    </section>
  )
}

function OverviewStatTile({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  tone?: 'default' | 'positive' | 'negative'
}) {
  return (
    <div className={STAT_TILE} title={`${label} · ${value}`}>
      <span className={STAT_LABEL}>{label}</span>
      <span
        className={cn(
          STAT_VALUE,
          tone === 'positive' && 'text-[color:var(--warm-ledger-color-positive)]',
          tone === 'negative' && 'text-[color:var(--warm-ledger-color-negative)]'
        )}
      >
        {value}
      </span>
    </div>
  )
}

function RankBar({
  primary,
  secondary,
  count,
  max,
}: {
  primary: string
  secondary?: string | null
  count: number
  max: number
}) {
  const pct = max > 0 ? Math.max(4, Math.round((count / max) * 100)) : 0
  return (
    <div className="flex min-w-0 items-center gap-3 py-1" title={`${primary} · ${count} 次`}>
      <div className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--warm-ledger-color-text)]">
        {primary}
        {secondary ? (
          <span className="ml-2 font-mono text-[11px] text-[color:var(--warm-ledger-color-text-muted)]">
            {secondary}
          </span>
        ) : null}
      </div>
      <div className="h-1.5 w-32 shrink-0 overflow-hidden rounded-full bg-[var(--warm-ledger-color-raised)]">
        <div
          className="h-full rounded-full bg-[var(--warm-ledger-color-accent)]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-[color:var(--warm-ledger-color-text-soft)]">
        ×{count.toLocaleString('zh-CN')}
      </span>
    </div>
  )
}

function WarmAgentIdentity({
  agentId,
  agentName,
}: {
  agentId: string | null
  agentName: string | null
}) {
  if (!agentId) return <span className={MUTED}>未绑定 / 未鉴权</span>
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      {agentName ? (
        <span className="max-w-full truncate font-medium text-[color:var(--warm-ledger-color-text)]">
          {agentName}
        </span>
      ) : null}
      <code className="max-w-full truncate rounded-[6px] bg-[var(--warm-ledger-color-raised)] px-1.5 py-0.5 font-mono text-[11px] text-[color:var(--warm-ledger-color-text-soft)]">
        {agentId}
      </code>
    </div>
  )
}

export function AgentAccessLogsPanel() {
  const { notify } = useNotifications()
  const { data: session, status } = useSession()

  const [rows, setRows] = useState<AgentAccessLogItem[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [hasNext, setHasNext] = useState(false)
  const [summary, setSummary] = useState<AgentAccessLogsSummaryResponse | null>(null)
  const [keywordInput, setKeywordInput] = useState('')
  const [methodInput, setMethodInput] = useState('')
  const [resultInput, setResultInput] = useState('')
  const [projectIdInput, setProjectIdInput] = useState('')
  const [operationTypeInput, setOperationTypeInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [method, setMethod] = useState('')
  const [result, setResult] = useState('')
  const [projectId, setProjectId] = useState('')
  const [operationType, setOperationType] = useState('')
  const [activeRow, setActiveRow] = useState<AgentAccessLogItem | null>(null)

  const fetchLogs = useCallback(async () => {
    if (status === 'loading') return
    setLoading(true)

    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('page_size', '50')
      if (keyword) params.set('keyword', keyword)
      if (method) params.set('method', method)
      if (result) params.set('result', result)
      const trimmedProjectId = projectId.trim()
      if (/^\d+$/.test(trimmedProjectId)) params.set('project_id', trimmedProjectId)
      if (operationType) params.set('operation_type', operationType)

      const headers = buildBackendClientHeaders(session)
      const [logsResponse, summaryResponse] = await Promise.all([
        fetch(`${API_BASE}/api/v1/system-management/agent-access-logs?${params.toString()}`, {
          headers,
          cache: 'no-store',
        }),
        fetch(
          `${API_BASE}/api/v1/system-management/agent-access-logs/summary?${params.toString()}`,
          { headers, cache: 'no-store' }
        ),
      ])

      if (!logsResponse.ok) throw new Error(await parseError(logsResponse))
      if (!summaryResponse.ok) throw new Error(await parseError(summaryResponse))

      const [logsPayload, summaryPayload] = (await Promise.all([
        logsResponse.json(),
        summaryResponse.json(),
      ])) as [AgentAccessLogsResponse, AgentAccessLogsSummaryResponse]

      setRows(logsPayload.items || [])
      setTotal(logsPayload.total || 0)
      setHasNext(Boolean(logsPayload.has_next))
      setSummary(summaryPayload)
    } catch (err) {
      notify({
        type: 'error',
        title: '加载 Agent 访问日志失败',
        message: normalizeErrorMessage(err, '加载 Agent 访问日志失败'),
      })
    } finally {
      setLoading(false)
    }
  }, [keyword, method, operationType, page, projectId, result, session, status, notify])

  useEffect(() => {
    void fetchLogs()
  }, [fetchLogs])
  useHeaderRefresh(fetchLogs, { loading })

  const totalPages = useMemo(() => {
    if (total <= 0) return 1
    return Math.max(1, Math.ceil(total / 50))
  }, [total])

  const applyFilters = useCallback(() => {
    setPage(1)
    setKeyword(keywordInput.trim())
    setMethod(methodInput)
    setResult(resultInput)
    setProjectId(projectIdInput.trim())
    setOperationType(operationTypeInput)
  }, [keywordInput, methodInput, operationTypeInput, projectIdInput, resultInput])

  const resetFilters = useCallback(() => {
    setKeywordInput('')
    setMethodInput('')
    setResultInput('')
    setProjectIdInput('')
    setOperationTypeInput('')
    setPage(1)
    setKeyword('')
    setMethod('')
    setResult('')
    setProjectId('')
    setOperationType('')
  }, [])

  return (
    <div
      className="grid min-w-0 gap-3 text-[color:var(--warm-ledger-color-text)]"
      data-warm-panel-scope="agent-access-logs"
    >
      <WarmPanel title="访问统计概览">
        <div className={STAT_GRID}>
          <OverviewStatTile
            label="请求总量"
            value={(summary?.total ?? 0).toLocaleString('zh-CN')}
          />
          <OverviewStatTile
            label="成功 2XX"
            value={(summary?.success_count ?? 0).toLocaleString('zh-CN')}
            tone="positive"
          />
          <OverviewStatTile
            label="失败 ≥4XX"
            value={(summary?.error_count ?? 0).toLocaleString('zh-CN')}
            tone={summary && summary.error_count > 0 ? 'negative' : 'default'}
          />
          <OverviewStatTile
            label="成功率"
            value={
              summary && summary.total > 0
                ? `${Math.round((summary.success_count / summary.total) * 100)}%`
                : '—'
            }
            tone="positive"
          />
          <OverviewStatTile
            label="活跃 AGENT"
            value={(summary?.unique_agent_count ?? 0).toLocaleString('zh-CN')}
          />
        </div>
        {summary && summary.top_agents.length > 0 ? (
          <div className={RANK_PANEL}>
            <p className={RANK_LABEL}>TOP AGENTS（当前筛选范围）</p>
            {(() => {
              const maxCount = Math.max(...summary.top_agents.map((agent) => agent.count))
              return summary.top_agents.map((item) => (
                <RankBar
                  key={item.agent_id}
                  primary={item.key_label || item.agent_id}
                  secondary={item.agent_id}
                  count={item.count}
                  max={maxCount}
                />
              ))
            })()}
          </div>
        ) : null}
        <p className="m-0 font-mono text-[11px] text-[color:var(--warm-ledger-color-text-muted)]">
          /api/v1/agent/* 访问统计 · 保留 90 天
        </p>
      </WarmPanel>

      <WarmPanel title="筛选">
        <div className="grid grid-cols-[180px_120px_130px_130px_160px_auto] items-end gap-2">
          <label className={FIELD}>
            <span className={FIELD_LABEL}>关键词</span>
            <input
              value={keywordInput}
              onChange={(event) => setKeywordInput(event.target.value)}
              placeholder="关键词 Agent/路径"
              className={INPUT}
            />
          </label>
          <label className={FIELD}>
            <span className={FIELD_LABEL}>请求方法</span>
            <select
              value={methodInput}
              onChange={(event) => setMethodInput(event.target.value)}
              className={SELECT}
            >
              <option value="">全部方法</option>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="DELETE">DELETE</option>
            </select>
          </label>
          <label className={FIELD}>
            <span className={FIELD_LABEL}>请求结果</span>
            <select
              value={resultInput}
              onChange={(event) => setResultInput(event.target.value)}
              className={SELECT}
            >
              <option value="">全部结果</option>
              <option value="success">成功 (2xx)</option>
              <option value="error">失败 (≥4xx)</option>
            </select>
          </label>
          <label className={FIELD}>
            <span className={FIELD_LABEL}>项目 ID</span>
            <input
              value={projectIdInput}
              onChange={(event) => setProjectIdInput(event.target.value)}
              placeholder="项目 ID（数字）"
              inputMode="numeric"
              className={cn(INPUT, 'font-mono tabular-nums')}
            />
          </label>
          <label className={FIELD}>
            <span className={FIELD_LABEL}>操作类型</span>
            <select
              value={operationTypeInput}
              onChange={(event) => setOperationTypeInput(event.target.value)}
              className={SELECT}
            >
              <option value="">全部操作类型</option>
              {AGENT_DOMAINS.map((domain) => (
                <option key={domain.code} value={domain.code} title={domain.code}>
                  {domain.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-2">
            <WarmButton onClick={applyFilters} variant="primary">
              <Search className="h-4 w-4" aria-hidden="true" />
              查询
            </WarmButton>
            <WarmButton onClick={resetFilters}>重置</WarmButton>
          </div>
        </div>
      </WarmPanel>

      <WarmPanel
        title="访问记录"
        bodyClassName="gap-0 p-0"
        actions={
          <WarmButton
            onClick={() => void fetchLogs()}
            loading={loading}
            loadingLabel="正在刷新 Agent 访问日志"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {loading ? '刷新中' : '刷新'}
          </WarmButton>
        }
      >
        <div className={TABLE_SCROLL}>
          <table className={TABLE}>
            <thead className={THEAD}>
              <tr>
                <th className={cn(TH, 'w-[150px]')}>时间</th>
                <th className={cn(TH, 'w-[170px]')}>Agent</th>
                <th className={cn(TH, 'w-[72px]')}>方法</th>
                <th className={TH}>路径</th>
                <th className={cn(TH, 'w-[130px]')}>项目</th>
                <th className={cn(TH, 'w-[72px]')} title="请求站点国家">
                  国家
                </th>
                <th className={cn(TH, 'w-[120px]')}>操作</th>
                <th className={cn(TH, 'w-[130px]')}>状态码</th>
                <th className={cn(TH, 'w-[80px] text-right')}>耗时</th>
                <th className={cn(TH, 'w-[118px]')}>IP 地址</th>
                <th className={cn(TH, 'w-[72px] text-right')}>详情</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={11}
                    className={cn(
                      TD,
                      'h-24 text-center text-[12px] text-[color:var(--warm-ledger-color-text-muted)]'
                    )}
                  >
                    {loading ? '加载中…' : '暂无 Agent 访问记录'}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr
                    key={row.id}
                    className={ROW}
                    onClick={() => setActiveRow(row)}
                  >
                    <td className={cn(TD, MUTED, 'font-mono tabular-nums')}>
                      {formatDateTime(row.created_at)}
                    </td>
                    <td className={TD}>
                      <WarmAgentIdentity agentId={row.agent_id} agentName={row.key_label} />
                    </td>
                    <td className={TD}>
                      <WarmBadge tone="neutral">{row.method}</WarmBadge>
                    </td>
                    <td className={cn(TD, 'max-w-[360px] truncate')} title={row.path}>
                      {row.path}
                    </td>
                    <td
                      className={cn(TD, 'max-w-[180px] truncate')}
                      title={formatProjectRef(row.project_id, row.project_name)}
                    >
                      {formatProjectRef(row.project_id, row.project_name)}
                    </td>
                    <td className={cn(TD, MUTED)}>{row.country ?? '—'}</td>
                    <td className={TD}>
                      <span
                        title={`${row.method} ${row.path}${row.operation_type ? ` · 业务域 ${row.operation_type}` : ''}`}
                      >
                        <WarmBadge tone="accent">
                          {accessOperationLabel(row.method, row.path, row.operation_type)}
                        </WarmBadge>
                      </span>
                    </td>
                    <td className={TD}>
                      <WarmBadge tone={statusMeta(row.status_code).tone}>
                        {statusMeta(row.status_code).label}
                      </WarmBadge>
                    </td>
                    <td
                      className={cn(
                        TD,
                        'text-right font-mono tabular-nums',
                        row.latency_ms >= 3000
                          ? 'text-[color:var(--warm-ledger-color-negative)]'
                          : MUTED
                      )}
                    >
                      {row.latency_ms.toLocaleString('zh-CN')}ms
                    </td>
                    <td
                      className={cn(TD, MUTED, 'truncate font-mono')}
                      title={row.ip_address || undefined}
                    >
                      {row.ip_address || '—'}
                    </td>
                    <td className={cn(TD, 'text-right')}>
                      <WarmButton
                        variant="quiet"
                        className="!min-h-8 !px-2"
                        aria-label={`查看 ${formatDateTime(row.created_at)} 的访问详情`}
                        onClick={(event) => {
                          event.stopPropagation()
                          setActiveRow(row)
                        }}
                      >
                        <Eye className="h-4 w-4" aria-hidden="true" />
                        查看
                      </WarmButton>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className={PAGER}>
          <span>
            共{' '}
            <span className="text-[color:var(--warm-ledger-color-text)]">
              {total.toLocaleString('zh-CN')}
            </span>{' '}
            条 · 第{' '}
            <span className="text-[color:var(--warm-ledger-color-text)]">{page}</span>/
            {totalPages} 页
          </span>
          <span className="flex items-center gap-2">
            <WarmButton
              className="!min-h-8 !px-2"
              onClick={() => setPage((previous) => Math.max(1, previous - 1))}
              disabled={page <= 1 || loading}
            >
              ◀ 上一页
            </WarmButton>
            <WarmButton
              className="!min-h-8 !px-2"
              onClick={() => setPage((previous) => previous + 1)}
              disabled={!hasNext || loading}
            >
              下一页 ▶
            </WarmButton>
          </span>
        </div>
      </WarmPanel>

      <Dialog open={Boolean(activeRow)} onOpenChange={(open) => (open ? null : setActiveRow(null))}>
        <DialogContent
          aria-describedby="agent-log-detail-dialog-description"
          className={DIALOG}
        >
          <DialogDescription id="agent-log-detail-dialog-description" className="sr-only">
            Agent 访问日志详情查看
          </DialogDescription>
          <DialogHeader className={DIALOG_HEADER}>
            <DialogTitle className={DIALOG_TITLE}>Agent 访问详情</DialogTitle>
          </DialogHeader>
          {activeRow ? (
            <div className="grid gap-4 p-5 font-mono text-[12px] leading-5">
              <div className={DETAIL_GRID}>
                <p>
                  <span className={DETAIL_LABEL}>请求时间:</span>{' '}
                  <span className={DETAIL_VALUE}>{formatDateTime(activeRow.created_at)}</span>
                </p>
                <p>
                  <span className={DETAIL_LABEL}>状态码:</span>{' '}
                  <span className={DETAIL_VALUE}>{statusMeta(activeRow.status_code).label}</span>
                </p>
                <p>
                  <span className={DETAIL_LABEL}>Agent:</span>{' '}
                  {activeRow.agent_id ? (
                    <>
                      {activeRow.key_label ? (
                        <span className={DETAIL_VALUE}>{activeRow.key_label} </span>
                      ) : null}
                      <code className={DETAIL_VALUE}>{activeRow.agent_id}</code>
                    </>
                  ) : (
                    <span className={DETAIL_LABEL}>未绑定 / 未鉴权</span>
                  )}
                </p>
                <p>
                  <span className={DETAIL_LABEL}>项目:</span>{' '}
                  <span className={DETAIL_VALUE}>
                    {formatProjectRef(activeRow.project_id, activeRow.project_name)}
                  </span>
                </p>
                <p>
                  <span className={DETAIL_LABEL}>国家:</span>{' '}
                  <span className={DETAIL_VALUE}>{activeRow.country ?? '—'}</span>
                </p>
                <p>
                  <span className={DETAIL_LABEL}>操作:</span>{' '}
                  <span className={DETAIL_VALUE}>
                    {accessOperationLabel(
                      activeRow.method,
                      activeRow.path,
                      activeRow.operation_type
                    )}
                  </span>
                </p>
                <p>
                  <span className={DETAIL_LABEL}>凭据标签:</span>{' '}
                  <span className={DETAIL_VALUE}>{activeRow.key_label || '-'}</span>
                </p>
                <p>
                  <span className={DETAIL_LABEL}>耗时:</span>{' '}
                  <code className={cn(DETAIL_VALUE, 'tabular-nums')}>
                    {activeRow.latency_ms}ms
                  </code>
                </p>
                <p>
                  <span className={DETAIL_LABEL}>IP 地址:</span>{' '}
                  <code className={DETAIL_VALUE}>{activeRow.ip_address || '-'}</code>
                </p>
              </div>

              <div className="grid gap-2">
                <p className={SECTION_LABEL}>请求</p>
                <div className={SUBPANEL}>
                  <p>
                    <span className={DETAIL_LABEL}>方法:</span>{' '}
                    <code className={DETAIL_VALUE}>{activeRow.method}</code>
                  </p>
                  <p className="mt-1">
                    <span className={DETAIL_LABEL}>路径:</span>{' '}
                    <code className={cn(DETAIL_VALUE, 'break-all')}>{activeRow.path}</code>
                  </p>
                </div>
              </div>

              <div className="grid gap-2">
                <p className={SECTION_LABEL}>凭据</p>
                <div className={SUBPANEL}>
                  <p>
                    <span className={DETAIL_LABEL}>API Key ID:</span>{' '}
                    <code className={DETAIL_VALUE}>{activeRow.api_key_id ?? '未鉴权'}</code>
                  </p>
                  <p>
                    <span className={DETAIL_LABEL}>日志 ID:</span>{' '}
                    <code className={DETAIL_VALUE}>{activeRow.id}</code>
                  </p>
                </div>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
