'use client'

/**
 * Agent 写操作明细面板（BLF-460 Task 8）。
 *
 * 展示 operation_audit_logs 的 agent 写操作子集（/system-management/agent-operation-logs）：
 * 列表 + 详情 Dialog，before/after 经 lib/agent-operation-diff.ts 渲染成人类可读 diff
 * （如「货件状态：在途 (in_transit) → 已入库 (completed)」）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TermPanel } from '@/components/terminal/term-panel'
import {
  TermTable,
  TermTHead,
  TermHead,
  TermBody,
  TermRow,
  TermCell,
} from '@/components/terminal/term-table'
import { Eye, Loader2, RefreshCw, Search } from 'lucide-react'
import { buildBackendClientHeaders } from '@/lib/backend-auth'
import { normalizeErrorMessage, parseResponseError } from '@/lib/error-utils'
import { useNotifications } from '@/components/notifications'
import { describeOperation, operationActionLabel, targetTypeLabel } from '@/lib/agent-operation-diff'
import { AgentIdentityCell, formatProjectRef } from '@/lib/agent-display'

const API_BASE = '/api/backend'

export type AgentOperationLogItem = {
  id: number
  created_at: string
  agent_id: string | null
  /** Agent 中文显示名（BLF-471）：写操作落库时随行快照，未填回退 agent_id */
  agent_name: string | null
  action: string
  target_type: string
  target_id: string | null
  /** 人类可读对象标识（BLF-471）：货件域派生 shipment_no，无则回退 #target_id */
  target_label: string | null
  result: string
  project_id: number | null
  /** 请求涉及的项目名（BLF-471）：运营可读，未命中回退 #id */
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
  if (result === 'failure')
    return {
      label: '失败',
      className: 'border-term-neg/50 bg-term-neg/10 text-term-neg',
    }
  return {
    label: '成功',
    className: 'border-term-pos/50 bg-term-pos/10 text-term-pos',
  }
}

// ── 终端化统计概览原语（BLF-845：与访问日志面板同规格） ─────────────

/** 概览 KPI 磁贴：标签小字 faint + 主数值 mono 大号；tone 决定语义色。 */
function OverviewStatTile({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  tone?: 'default' | 'pos' | 'neg'
}) {
  return (
    <div
      className="flex min-w-0 flex-1 flex-col gap-1 border border-term-border bg-term-bg px-3 py-2"
      title={`${label} · ${value}`}
    >
      <span className="truncate font-mono text-[11px] uppercase tracking-wider text-term-faint">
        {label}
      </span>
      <span
        className={cn(
          'truncate font-mono text-lg leading-none tabular-nums',
          tone === 'pos' && 'text-term-pos',
          tone === 'neg' && 'text-term-neg',
          tone === 'default' && 'text-term-text'
        )}
      >
        {value}
      </span>
    </div>
  )
}

/** Top N 排行条：主标识 + mono 计数 + 占比条（宽度按 count/max 归一）。 */
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
    <div className="flex min-w-0 items-center gap-2 py-1" title={`${primary} · ${count} 次`}>
      <div className="min-w-0 flex-1 truncate text-xs text-term-text">
        {primary}
        {secondary ? (
          <span className="ml-1.5 hidden font-mono text-[11px] text-term-faint sm:inline">
            {secondary}
          </span>
        ) : null}
      </div>
      <div className="h-1.5 w-24 shrink-0 bg-term-raised sm:w-32">
        <div className="h-full bg-term-accent/70" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-term-muted">
        ×{count.toLocaleString('zh-CN')}
      </span>
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
    <div className="space-y-4">
      {/** BLF-845 概览重设计：KPI 磁贴行 + 双栏排行（Top Agent × 高频操作），终端化 */}
      <TermPanel title="写操作统计概览">
        <div className="space-y-3 p-3">
          <div className="flex flex-wrap gap-2">
            <OverviewStatTile
              label="写操作总量"
              value={(summary?.total ?? 0).toLocaleString('zh-CN')}
            />
            <OverviewStatTile
              label="成功"
              value={(summary?.success_count ?? 0).toLocaleString('zh-CN')}
              tone="pos"
            />
            <OverviewStatTile
              label="失败"
              value={(summary?.failure_count ?? 0).toLocaleString('zh-CN')}
              tone={summary && summary.failure_count > 0 ? 'neg' : 'default'}
            />
            <OverviewStatTile
              label="成功率"
              value={
                summary && summary.total > 0
                  ? `${Math.round((summary.success_count / summary.total) * 100)}%`
                  : '—'
              }
              tone="pos"
            />
            <OverviewStatTile
              label="活跃 AGENT"
              value={(summary?.unique_agent_count ?? 0).toLocaleString('zh-CN')}
            />
          </div>
          {summary && (summary.top_agents.length > 0 || summary.top_actions.length > 0) ? (
            <div className="grid gap-2 md:grid-cols-2">
              {summary.top_agents.length > 0 ? (
                <div className="border border-term-border bg-term-bg p-2">
                  <p className="mb-1 font-mono text-[11px] uppercase tracking-wider text-term-faint">
                    TOP AGENTS
                  </p>
                  {(() => {
                    const maxCount = Math.max(...summary.top_agents.map((a) => a.count))
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
                <div className="border border-term-border bg-term-bg p-2">
                  <p className="mb-1 font-mono text-[11px] uppercase tracking-wider text-term-faint">
                    高频操作
                  </p>
                  {(() => {
                    const maxCount = Math.max(...summary.top_actions.map((a) => a.count))
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
          <p className="font-mono text-[11px] text-term-faint">
            agent 写操作（confirm 两步确认落库）· 保留 90 天
          </p>
        </div>
      </TermPanel>

      {/** BLF-845：写操作记录表终端化（TermTable）+ 国家维度列位 */}
      <TermPanel
        title="写操作记录"
        actions={
          <button
            type="button"
            onClick={() => void fetchLogs()}
            disabled={loading}
            className="flex h-8 items-center gap-1 border border-term-border bg-term-bg px-2 text-xs text-term-muted transition-colors hover:border-term-border-strong hover:text-term-text disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            )}
            {loading ? '刷新中' : '刷新'}
          </button>
        }
      >
        <div className="max-h-[480px] overflow-auto term-scroll">
          <TermTable>
            <TermTHead>
              <tr>
                <TermHead className="w-[150px]">时间</TermHead>
                <TermHead className="w-[150px]">Agent</TermHead>
                <TermHead className="w-[120px]">操作</TermHead>
                <TermHead className="w-[130px]">项目</TermHead>
                <TermHead
                  className="w-[52px]"
                  title="操作涉及站点国家（后端字段就绪前显示 —，BLF-845）"
                >
                  国家
                </TermHead>
                <TermHead>对象</TermHead>
                <TermHead className="w-[60px]">结果</TermHead>
                <TermHead className="w-[56px]" numeric>
                  详情
                </TermHead>
              </tr>
            </TermTHead>
            <TermBody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="h-24 text-center text-xs text-term-faint">
                    {loading ? '加载中…' : '暂无 Agent 写操作记录'}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <TermRow key={row.id} onClick={() => setActiveRow(row)}>
                    <TermCell tone="muted" title={formatDateTime(row.created_at)}>
                      {formatDateTime(row.created_at)}
                    </TermCell>
                    <TermCell>
                      <AgentIdentityCell agentId={row.agent_id} agentName={row.agent_name} />
                    </TermCell>
                    <TermCell>
                      <span
                        title={`action ${row.action}`}
                        className="border border-term-accent/40 px-1 font-mono text-[10px] text-term-accent"
                      >
                        {operationActionLabel(row.action)}
                      </span>
                    </TermCell>
                    <TermCell title={formatProjectRef(row.project_id, row.project_name)}>
                      {formatProjectRef(row.project_id, row.project_name)}
                    </TermCell>
                    {/* BLF-845 ③：country 列位。operation_audit_logs 暂未落 country，
                        就绪前恒显 '—'；字段透出后零改动生效。 */}
                    <TermCell tone="muted">
                      {'country' in row && (row as { country?: string | null }).country
                        ? (row as { country: string }).country
                        : '—'}
                    </TermCell>
                    <TermCell
                      className="max-w-[150px] truncate"
                      title={row.target_label || row.target_id || '-'}
                    >
                      {targetTypeLabel(row.target_type)}
                      {row.target_label ? (
                        <span className="ml-1 font-mono text-[11px] text-term-faint">
                          #{row.target_label}
                        </span>
                      ) : row.target_id ? (
                        <span className="text-term-faint"> #{row.target_id}</span>
                      ) : null}
                    </TermCell>
                    <TermCell>
                      <span
                        className={cn(
                          'border px-1 font-mono text-[10px]',
                          resultMeta(row.result).className
                        )}
                      >
                        {resultMeta(row.result).label}
                      </span>
                    </TermCell>
                    <TermCell numeric>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          setActiveRow(row)
                        }}
                        className="inline-flex items-center gap-0.5 border border-term-border bg-term-bg px-1 font-mono text-[11px] text-term-accent transition-colors hover:border-term-border-strong"
                        aria-label={`查看 ${formatDateTime(row.created_at)} 的写操作明细`}
                      >
                        <Eye className="h-3 w-3" aria-hidden />
                        查看
                      </button>
                    </TermCell>
                  </TermRow>
                ))
              )}
            </TermBody>
          </TermTable>
        </div>

        <div className="flex h-8 items-center justify-between border-t border-term-border bg-term-raised px-2 font-mono text-xs tabular-nums text-term-muted">
          <span>
            共 <span className="text-term-text">{total.toLocaleString('zh-CN')}</span> 条 · 第{' '}
            <span className="text-term-text">{page}</span>/{totalPages} 页
          </span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              disabled={page <= 1 || loading}
              className="flex h-5 items-center border border-term-border bg-term-bg px-1.5 text-[11px] transition-colors hover:border-term-border-strong hover:text-term-text disabled:cursor-not-allowed disabled:opacity-40"
            >
              ◀ 上一页
            </button>
            <button
              type="button"
              onClick={() => setPage((prev) => prev + 1)}
              disabled={!hasNext || loading}
              className="flex h-5 items-center border border-term-border bg-term-bg px-1.5 text-[11px] transition-colors hover:border-term-border-strong hover:text-term-text disabled:cursor-not-allowed disabled:opacity-40"
            >
              下一页 ▶
            </button>
          </span>
        </div>
      </TermPanel>

      {/** 筛选工具栏：终端化 h-8 控件（与访问日志面板同规格） */}
      <TermPanel title="筛选">
        <div className="flex flex-wrap items-center gap-1 p-1.5">
          <Input
            value={keywordInput}
            onChange={(event) => setKeywordInput(event.target.value)}
            placeholder="关键词 Agent/操作/对象"
            className="h-8 w-[170px] rounded-none border-term-border bg-term-bg text-xs text-term-text shadow-none placeholder:font-sans placeholder:text-term-faint focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <Input
            value={agentIdInput}
            onChange={(event) => setAgentIdInput(event.target.value)}
            placeholder="Agent ID"
            className="h-8 w-[130px] rounded-none border-term-border bg-term-bg font-mono text-xs text-term-text shadow-none placeholder:font-sans placeholder:text-term-faint focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <Input
            value={projectIdInput}
            onChange={(event) => setProjectIdInput(event.target.value)}
            placeholder="项目 ID（数字）"
            inputMode="numeric"
            className="h-8 w-[110px] rounded-none border-term-border bg-term-bg font-mono text-xs text-term-text shadow-none placeholder:font-sans placeholder:text-term-faint focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <Input
            value={actionInput}
            onChange={(event) => setActionInput(event.target.value)}
            placeholder="操作（如 shipment.status.transition）"
            className="h-8 w-[200px] rounded-none border-term-border bg-term-bg font-mono text-xs text-term-text shadow-none placeholder:font-sans placeholder:text-term-faint focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <Select value={resultInput} onValueChange={setResultInput}>
            <SelectTrigger className="h-8 w-[100px] rounded-none border-term-border bg-term-bg text-xs text-term-text focus:ring-0 data-[state=open]:border-term-border-strong">
              <SelectValue placeholder="操作结果" />
            </SelectTrigger>
            <SelectContent className="rounded-none border-term-border bg-term-panel text-term-text">
              <SelectItem value="all" className="rounded-none text-xs focus:bg-term-hover focus:text-term-text">
                全部结果
              </SelectItem>
              <SelectItem value="success" className="rounded-none text-xs focus:bg-term-hover focus:text-term-text">
                成功
              </SelectItem>
              <SelectItem value="failure" className="rounded-none text-xs focus:bg-term-hover focus:text-term-text">
                失败
              </SelectItem>
            </SelectContent>
          </Select>
          <span className="mx-0.5 hidden h-4 w-px bg-term-border md:block" aria-hidden />
          <button
            type="button"
            onClick={applyFilters}
            className="flex h-8 items-center gap-1 border border-term-accent/50 bg-term-accent/10 px-2 font-mono text-xs text-term-accent transition-colors hover:bg-term-accent/20"
          >
            <Search className="h-3.5 w-3.5" aria-hidden />
            查询
          </button>
          <button
            type="button"
            onClick={resetFilters}
            className="flex h-8 items-center border border-term-border bg-term-bg px-2 text-xs text-term-muted transition-colors hover:border-term-border-strong hover:text-term-text"
          >
            重置
          </button>
        </div>
      </TermPanel>

      <Dialog open={Boolean(activeRow)} onOpenChange={(open) => (open ? null : setActiveRow(null))}>
        <DialogContent
          aria-describedby="agent-operation-detail-dialog-description"
          className="max-h-[85vh] max-w-[calc(100%-2rem)] overflow-y-auto rounded-lg dark:border-border/80 dark:bg-[hsl(var(--surface-panel))] sm:max-w-3xl"
        >
          <span id="agent-operation-detail-dialog-description" className="sr-only">
            Agent 写操作明细查看
          </span>
          <DialogHeader>
            <DialogTitle>写操作明细{activeDescription ? ` · ${activeDescription.title}` : ''}</DialogTitle>
          </DialogHeader>
          {activeRow && activeDescription ? (
            <div className="space-y-4 text-sm">
              <div className="grid gap-2 sm:grid-cols-2">
                <p>
                  <span className="text-muted-foreground">操作时间:</span>{' '}
                  {formatDateTime(activeRow.created_at)}
                </p>
                <p>
                  <span className="text-muted-foreground">Agent:</span>{' '}
                  {activeRow.agent_name ? (
                    <span className="font-medium">{activeRow.agent_name} </span>
                  ) : null}
                  {activeRow.agent_id ? (
                    <code className="font-mono">{activeRow.agent_id}</code>
                  ) : (
                    '-'
                  )}
                </p>
                <p>
                  <span className="text-muted-foreground">对象:</span>{' '}
                  {targetTypeLabel(activeRow.target_type)}
                  {activeRow.target_label ? (
                    <span className="font-mono"> #{activeRow.target_label}</span>
                  ) : activeRow.target_id ? (
                    <span className="font-mono"> #{activeRow.target_id}</span>
                  ) : null}
                </p>
                <p>
                  <span className="text-muted-foreground">项目:</span>{' '}
                  {formatProjectRef(activeRow.project_id, activeRow.project_name)}
                </p>
                {/* BLF-845 ③：国家字段位。后端 country 字段就绪前恒显 '—'。 */}
                <p>
                  <span className="text-muted-foreground">国家:</span>{' '}
                  {'country' in activeRow && (activeRow as { country?: string | null }).country
                    ? (activeRow as { country: string }).country
                    : '—'}
                </p>
                <p>
                  <span className="text-muted-foreground">结果:</span>{' '}
                  {resultMeta(activeRow.result).label}
                </p>
                <p>
                  <span className="text-muted-foreground">请求方法:</span>{' '}
                  <code className="font-mono">{activeRow.request_method || '-'}</code>
                </p>
              </div>

              {activeRow.request_path ? (
                <div className="space-y-2">
                  <p className="font-medium">请求路径</p>
                  <div className="rounded-md border border-border/70 bg-muted/40 p-3 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
                    <code className="break-all font-mono text-xs">{activeRow.request_path}</code>
                  </div>
                </div>
              ) : null}

              <div className="space-y-2">
                <p className="font-medium">变更明细</p>
                {activeDescription.changes.length === 0 ? (
                  <div className="rounded-md border border-border/70 bg-muted/40 p-3 text-muted-foreground dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
                    无可展示的字段级变更（before/after 无差异或均为空）
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-md border border-border/70 dark:border-border/80">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground dark:bg-[hsl(var(--surface-soft))]">
                          <th className="px-3 py-2 font-medium">字段</th>
                          <th className="px-3 py-2 font-medium">变更前</th>
                          <th className="px-3 py-2 font-medium">变更后</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeDescription.changes.map((change, index) => (
                          <tr key={`${change.field}-${index}`} className="border-b last:border-0">
                            <td className="px-3 py-2 whitespace-nowrap">{change.field}</td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {change.from ?? <span className="italic">—</span>}
                            </td>
                            <td className="px-3 py-2">
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
                <div className="space-y-2">
                  <p className="font-medium">错误信息</p>
                  <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 font-mono text-xs text-rose-600 dark:text-rose-400">
                    {activeRow.error_message}
                  </div>
                </div>
              ) : null}

              <div className="space-y-2">
                <p className="font-medium">原始数据</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-md border border-border/70 bg-muted/40 p-3 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
                    <p className="mb-1 text-xs text-muted-foreground">before_json</p>
                    <pre className="max-h-48 overflow-auto font-mono text-xs">
                      {activeRow.before_json == null
                        ? 'null'
                        : JSON.stringify(activeRow.before_json, null, 2)}
                    </pre>
                  </div>
                  <div className="rounded-md border border-border/70 bg-muted/40 p-3 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
                    <p className="mb-1 text-xs text-muted-foreground">after_json</p>
                    <pre className="max-h-48 overflow-auto font-mono text-xs">
                      {activeRow.after_json == null
                        ? 'null'
                        : JSON.stringify(activeRow.after_json, null, 2)}
                    </pre>
                  </div>
                </div>
                {activeRow.idempotency_key ? (
                  <p className="text-xs text-muted-foreground">
                    幂等键:{' '}
                    <code className="font-mono">{activeRow.idempotency_key}</code>
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
