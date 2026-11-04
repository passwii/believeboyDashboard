'use client'

/**
 * Agent 写操作明细面板（BLF-460 Task 8）。
 *
 * 展示 operation_audit_logs 的 agent 写操作子集：
 * 列表 + 详情 Dialog，before/after 经 agent-operation-diff 渲染成人类可读 diff。
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
import { describeOperation, operationActionLabel, targetTypeLabel } from '@/lib/agent-operation-diff'
import { formatProjectRef } from '@/lib/agent-display'

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
const TABLE = 'w-full min-w-[1040px] border-separate border-spacing-0 text-left text-[12px]'
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

export type AgentOperationLogItem = {
  id: number
  created_at: string
  agent_id: string | null
  /** Agent 中文显示名：写操作落库时随行快照，未填回退 agent_id。 */
  agent_name: string | null
  action: string
  target_type: string
  target_id: string | null
  /** 人类可读对象标识：货件域派生 shipment_no，无则回退 #target_id。 */
  target_label: string | null
  result: string
  project_id: number | null
  /** 请求涉及的项目名：运营可读，未命中回退 #id。 */
  project_name: string | null
  operation_type: string | null
  request_path: string | null
  request_method: string | null
  before_json: Record<string, unknown> | unknown[] | null
  after_json: Record<string, unknown> | unknown[] | null
  idempotency_key: string | null
  error_message: string | null
}

type AgentOperationLogsResponse = {
  items: AgentOperationLogItem[]
  total: number
  page: number
  page_size: number
  has_next: boolean
}

type AgentOperationLogSummaryItem = { agent_id: string; agent_name?: string | null; count: number }
type AgentOperationLogActionSummaryItem = { action: string; count: number }

type AgentOperationLogsSummaryResponse = {
  total: number
  success_count: number
  failure_count: number
  unique_agent_count: number
  top_agents: AgentOperationLogSummaryItem[]
  top_actions: AgentOperationLogActionSummaryItem[]
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

function resultMeta(result: string) {
  if (result === 'failure') return { label: '失败', tone: 'negative' as const }
  return { label: '成功', tone: 'positive' as const }
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

export function AgentOperationLogsPanel() {
  const { notify } = useNotifications()
  const { data: session, status } = useSession()

  const [rows, setRows] = useState<AgentOperationLogItem[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [hasNext, setHasNext] = useState(false)
  const [summary, setSummary] = useState<AgentOperationLogsSummaryResponse | null>(null)
  const [keywordInput, setKeywordInput] = useState('')
  const [agentIdInput, setAgentIdInput] = useState('')
  const [projectIdInput, setProjectIdInput] = useState('')
  const [actionInput, setActionInput] = useState('')
  const [resultInput, setResultInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [agentId, setAgentId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [action, setAction] = useState('')
  const [result, setResult] = useState('')
  const [activeRow, setActiveRow] = useState<AgentOperationLogItem | null>(null)

  const buildParams = useCallback(() => {
    const params = new URLSearchParams()
    params.set('page', String(page))
    params.set('page_size', '50')
    if (keyword) params.set('keyword', keyword)
    if (agentId) params.set('agent_id', agentId)
    const trimmedProjectId = projectId.trim()
    if (/^\d+$/.test(trimmedProjectId)) params.set('project_id', trimmedProjectId)
    if (action) params.set('action', action)
    if (result) params.set('result', result)
    return params
  }, [action, agentId, keyword, page, projectId, result])

  const fetchLogs = useCallback(async () => {
    if (status === 'loading') return
    setLoading(true)

    try {
      const params = buildParams()
      const headers = buildBackendClientHeaders(session)
      const [logsResponse, summaryResponse] = await Promise.all([
        fetch(`${API_BASE}/api/v1/system-management/agent-operation-logs?${params.toString()}`, {
          headers,
          cache: 'no-store',
        }),
        fetch(
          `${API_BASE}/api/v1/system-management/agent-operation-logs/summary?${params.toString()}`,
          { headers, cache: 'no-store' }
        ),
      ])

      if (!logsResponse.ok) throw new Error(await parseError(logsResponse))
      if (!summaryResponse.ok) throw new Error(await parseError(summaryResponse))

      const [logsPayload, summaryPayload] = (await Promise.all([
        logsResponse.json(),
        summaryResponse.json(),
      ])) as [AgentOperationLogsResponse, AgentOperationLogsSummaryResponse]

      setRows(logsPayload.items || [])
      setTotal(logsPayload.total || 0)
      setHasNext(Boolean(logsPayload.has_next))
      setSummary(summaryPayload)
    } catch (err) {
      notify({
        type: 'error',
        title: '加载 Agent 写操作日志失败',
        message: normalizeErrorMessage(err, '加载 Agent 写操作日志失败'),
      })
    } finally {
      setLoading(false)
    }
  }, [buildParams, notify, session, status])

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
    setAgentId(agentIdInput.trim())
    setProjectId(projectIdInput.trim())
    setAction(actionInput.trim())
    setResult(resultInput)
  }, [actionInput, agentIdInput, keywordInput, projectIdInput, resultInput])

  const resetFilters = useCallback(() => {
    setKeywordInput('')
    setAgentIdInput('')
    setProjectIdInput('')
    setActionInput('')
    setResultInput('')
    setPage(1)
    setKeyword('')
    setAgentId('')
    setProjectId('')
    setAction('')
    setResult('')
  }, [])

  const activeDescription = activeRow
    ? describeOperation(activeRow.action, activeRow.before_json, activeRow.after_json)
    : null

  return (
    <div
      className="grid min-w-0 gap-3 text-[color:var(--warm-ledger-color-text)]"
      data-warm-panel-scope="agent-operation-logs"
    >
      <WarmPanel title="写操作统计概览">
        <div className={STAT_GRID}>
          <OverviewStatTile
            label="写操作总量"
            value={(summary?.total ?? 0).toLocaleString('zh-CN')}
          />
          <OverviewStatTile
            label="成功"
            value={(summary?.success_count ?? 0).toLocaleString('zh-CN')}
            tone="positive"
          />
          <OverviewStatTile
            label="失败"
            value={(summary?.failure_count ?? 0).toLocaleString('zh-CN')}
            tone={summary && summary.failure_count > 0 ? 'negative' : 'default'}
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
        {summary && (summary.top_agents.length > 0 || summary.top_actions.length > 0) ? (
          <div className="grid gap-2 md:grid-cols-2">
            {summary.top_agents.length > 0 ? (
              <div className={RANK_PANEL}>
                <p className={RANK_LABEL}>TOP AGENTS</p>
                {(() => {
                  const maxCount = Math.max(...summary.top_agents.map((agent) => agent.count))
                  return summary.top_agents.map((item) => (
                    <RankBar
                      key={item.agent_id}
                      primary={item.agent_name || item.agent_id}
                      secondary={item.agent_id}
                      count={item.count}
                      max={maxCount}
                    />
                  ))
                })()}
              </div>
            ) : null}
            {summary.top_actions.length > 0 ? (
              <div className={RANK_PANEL}>
                <p className={RANK_LABEL}>高频操作</p>
                {(() => {
                  const maxCount = Math.max(...summary.top_actions.map((item) => item.count))
                  return summary.top_actions.map((item) => (
                    <RankBar
                      key={item.action}
                      primary={operationActionLabel(item.action)}
                      secondary={item.action}
                      count={item.count}
                      max={maxCount}
                    />
                  ))
                })()}
              </div>
            ) : null}
          </div>
        ) : null}
        <p className="m-0 font-mono text-[11px] text-[color:var(--warm-ledger-color-text-muted)]">
          agent 写操作（confirm 两步确认落库）· 保留 90 天
        </p>
      </WarmPanel>

      <WarmPanel title="筛选">
        <div className="grid grid-cols-[180px_150px_130px_240px_130px_auto] items-end gap-2">
          <label className={FIELD}>
            <span className={FIELD_LABEL}>关键词</span>
            <input
              value={keywordInput}
              onChange={(event) => setKeywordInput(event.target.value)}
              placeholder="关键词 Agent/操作/对象"
              className={INPUT}
            />
          </label>
          <label className={FIELD}>
            <span className={FIELD_LABEL}>Agent ID</span>
            <input
              value={agentIdInput}
              onChange={(event) => setAgentIdInput(event.target.value)}
              placeholder="Agent ID"
              className={cn(INPUT, 'font-mono')}
            />
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
            <span className={FIELD_LABEL}>操作</span>
            <input
              value={actionInput}
              onChange={(event) => setActionInput(event.target.value)}
              placeholder="操作（如 shipment.status.transition）"
              className={cn(INPUT, 'font-mono')}
            />
          </label>
          <label className={FIELD}>
            <span className={FIELD_LABEL}>操作结果</span>
            <select
              value={resultInput}
              onChange={(event) => setResultInput(event.target.value)}
              className={SELECT}
            >
              <option value="">全部结果</option>
              <option value="success">成功</option>
              <option value="failure">失败</option>
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
        title="写操作记录"
        bodyClassName="gap-0 p-0"
        actions={
          <WarmButton
            onClick={() => void fetchLogs()}
            loading={loading}
            loadingLabel="正在刷新 Agent 写操作日志"
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
                <th className={cn(TH, 'w-[150px]')}>Agent</th>
                <th className={cn(TH, 'w-[130px]')}>操作</th>
                <th className={cn(TH, 'w-[140px]')}>项目</th>
                <th className={cn(TH, 'w-[72px]')} title="操作涉及站点国家">
                  国家
                </th>
                <th className={TH}>对象</th>
                <th className={cn(TH, 'w-[80px]')}>结果</th>
                <th className={cn(TH, 'w-[72px] text-right')}>详情</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={8}
                    className={cn(
                      TD,
                      'h-24 text-center text-[12px] text-[color:var(--warm-ledger-color-text-muted)]'
                    )}
                  >
                    {loading ? '加载中…' : '暂无 Agent 写操作记录'}
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
                      <WarmAgentIdentity agentId={row.agent_id} agentName={row.agent_name} />
                    </td>
                    <td className={TD}>
                      <span title={`action ${row.action}`}>
                        <WarmBadge tone="accent">{operationActionLabel(row.action)}</WarmBadge>
                      </span>
                    </td>
                    <td
                      className={cn(TD, 'max-w-[180px] truncate')}
                      title={formatProjectRef(row.project_id, row.project_name)}
                    >
                      {formatProjectRef(row.project_id, row.project_name)}
                    </td>
                    <td className={cn(TD, MUTED)}>
                      {'country' in row && (row as { country?: string | null }).country
                        ? (row as { country: string }).country
                        : '—'}
                    </td>
                    <td
                      className={cn(TD, 'max-w-[220px] truncate')}
                      title={row.target_label || row.target_id || '-'}
                    >
                      {targetTypeLabel(row.target_type)}
                      {row.target_label ? (
                        <span className="ml-1 font-mono text-[11px] text-[color:var(--warm-ledger-color-text-muted)]">
                          #{row.target_label}
                        </span>
                      ) : row.target_id ? (
                        <span className={MUTED}> #{row.target_id}</span>
                      ) : null}
                    </td>
                    <td className={TD}>
                      <WarmBadge tone={resultMeta(row.result).tone}>
                        {resultMeta(row.result).label}
                      </WarmBadge>
                    </td>
                    <td className={cn(TD, 'text-right')}>
                      <WarmButton
                        variant="quiet"
                        className="!min-h-8 !px-2"
                        aria-label={`查看 ${formatDateTime(row.created_at)} 的写操作明细`}
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
          aria-describedby="agent-operation-detail-dialog-description"
          className={DIALOG}
        >
          <DialogDescription id="agent-operation-detail-dialog-description" className="sr-only">
            Agent 写操作明细查看
          </DialogDescription>
          <DialogHeader className={DIALOG_HEADER}>
            <DialogTitle className={DIALOG_TITLE}>
              写操作明细{activeDescription ? ` · ${activeDescription.title}` : ''}
            </DialogTitle>
          </DialogHeader>
          {activeRow && activeDescription ? (
            <div className="grid gap-4 p-5 font-mono text-[12px] leading-5">
              <div className={DETAIL_GRID}>
                <p>
                  <span className={DETAIL_LABEL}>操作时间:</span>{' '}
                  <span className={DETAIL_VALUE}>{formatDateTime(activeRow.created_at)}</span>
                </p>
                <p>
                  <span className={DETAIL_LABEL}>Agent:</span>{' '}
                  {activeRow.agent_name ? (
                    <span className={DETAIL_VALUE}>{activeRow.agent_name} </span>
                  ) : null}
                  {activeRow.agent_id ? (
                    <code className={DETAIL_VALUE}>{activeRow.agent_id}</code>
                  ) : (
                    <span className={DETAIL_LABEL}>-</span>
                  )}
                </p>
                <p>
                  <span className={DETAIL_LABEL}>对象:</span>{' '}
                  <span className={DETAIL_VALUE}>{targetTypeLabel(activeRow.target_type)}</span>
                  {activeRow.target_label ? (
                    <span className={DETAIL_VALUE}> #{activeRow.target_label}</span>
                  ) : activeRow.target_id ? (
                    <span className={DETAIL_VALUE}> #{activeRow.target_id}</span>
                  ) : null}
                </p>
                <p>
                  <span className={DETAIL_LABEL}>项目:</span>{' '}
                  <span className={DETAIL_VALUE}>
                    {formatProjectRef(activeRow.project_id, activeRow.project_name)}
                  </span>
                </p>
                <p>
                  <span className={DETAIL_LABEL}>国家:</span>{' '}
                  <span className={DETAIL_VALUE}>
                    {'country' in activeRow && (activeRow as { country?: string | null }).country
                      ? (activeRow as { country: string }).country
                      : '—'}
                  </span>
                </p>
                <p>
                  <span className={DETAIL_LABEL}>结果:</span>{' '}
                  <span className={DETAIL_VALUE}>{resultMeta(activeRow.result).label}</span>
                </p>
                <p>
                  <span className={DETAIL_LABEL}>请求方法:</span>{' '}
                  <code className={DETAIL_VALUE}>{activeRow.request_method || '-'}</code>
                </p>
              </div>

              {activeRow.request_path ? (
                <div className="grid gap-2">
                  <p className={SECTION_LABEL}>请求路径</p>
                  <div className={SUBPANEL}>
                    <code className={cn(DETAIL_VALUE, 'break-all')}>
                      {activeRow.request_path}
                    </code>
                  </div>
                </div>
              ) : null}

              <div className="grid gap-2">
                <p className={SECTION_LABEL}>变更明细</p>
                {activeDescription.changes.length === 0 ? (
                  <div className={cn(SUBPANEL, MUTED)}>
                    无可展示的字段级变更（before/after 无差异或均为空）
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-[10px] border border-[var(--warm-ledger-color-hairline)]">
                    <table className="w-full border-separate border-spacing-0 font-mono text-[12px] leading-5">
                      <thead>
                        <tr className="bg-[var(--warm-ledger-color-panel-strong)] text-left text-[color:var(--warm-ledger-color-text-muted)]">
                          <th className="border-b border-[var(--warm-ledger-color-hairline)] px-3 py-2 font-medium">
                            字段
                          </th>
                          <th className="border-b border-[var(--warm-ledger-color-hairline)] px-3 py-2 font-medium">
                            变更前
                          </th>
                          <th className="border-b border-[var(--warm-ledger-color-hairline)] px-3 py-2 font-medium">
                            变更后
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeDescription.changes.map((change, index) => (
                          <tr
                            key={`${change.field}-${index}`}
                            className="border-b border-[var(--warm-ledger-color-hairline)] last:border-0"
                          >
                            <td className="border-b border-[var(--warm-ledger-color-hairline)] px-3 py-2 whitespace-nowrap text-[color:var(--warm-ledger-color-text)]">
                              {change.field}
                            </td>
                            <td className="border-b border-[var(--warm-ledger-color-hairline)] px-3 py-2 text-[color:var(--warm-ledger-color-text-muted)]">
                              {change.from ?? <span className="italic">—</span>}
                            </td>
                            <td className="border-b border-[var(--warm-ledger-color-hairline)] px-3 py-2 text-[color:var(--warm-ledger-color-text)]">
                              {change.to ?? <span className="italic">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {activeRow.error_message ? (
                <div className="grid gap-2">
                  <p className={SECTION_LABEL}>错误信息</p>
                  <div className="rounded-[10px] border border-[var(--warm-ledger-color-negative)] bg-[var(--warm-ledger-color-panel-strong)] p-3 text-[color:var(--warm-ledger-color-negative)]">
                    {activeRow.error_message}
                  </div>
                </div>
              ) : null}

              <div className="grid gap-2">
                <p className={SECTION_LABEL}>原始数据</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className={SUBPANEL}>
                    <p className={cn('mb-1', MUTED)}>before_json</p>
                    <pre className="max-h-48 overflow-auto text-[color:var(--warm-ledger-color-text)]">
                      {activeRow.before_json == null
                        ? 'null'
                        : JSON.stringify(activeRow.before_json, null, 2)}
                    </pre>
                  </div>
                  <div className={SUBPANEL}>
                    <p className={cn('mb-1', MUTED)}>after_json</p>
                    <pre className="max-h-48 overflow-auto text-[color:var(--warm-ledger-color-text)]">
                      {activeRow.after_json == null
                        ? 'null'
                        : JSON.stringify(activeRow.after_json, null, 2)}
                    </pre>
                  </div>
                </div>
                {activeRow.idempotency_key ? (
                  <p className={MUTED}>
                    幂等键:{' '}
                    <code className={DETAIL_VALUE}>{activeRow.idempotency_key}</code>
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
