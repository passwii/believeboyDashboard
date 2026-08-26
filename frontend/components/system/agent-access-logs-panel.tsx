'use client'

/**
 * Agent 访问日志面板（BLF-448 抽离为共享组件）。
 *
 * 从日志查看页抽离，日志页与新「Agent 接入管理」页 Tab 4 共用同一实现：
 * 自持状态与拉取（/system-management/agent-access-logs + /summary），
 * 行为与日志页原 Tab 完全一致（keyword/method/result 筛选 + 分页 + 详情 Dialog）。
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
import { AGENT_DOMAINS, getAgentDomain } from '@/lib/agent-domains'
import { AgentIdentityCell, formatProjectRef } from '@/lib/agent-display'

const API_BASE = '/api/backend'

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
  // Agent 中文名即「名称」（BLF-471 follow-up）：join agent_api_keys 还原 key_label。
  key_label: string | null
  /** BLF-460 读操作明细：请求涉及的项目 ID 与业务域（中间件从 path 解析） */
  project_id: number | null
  /** 请求涉及的项目名（BLF-471 follow-up）：仅用名称（运营不用编号） */
  project_name: string | null
  operation_type: string | null
  /** BLF-845 ③：审计国家维度（中间件从 query ?country= 解析，迁移 259 起
   * 落库；历史行与无 country 参数的请求为 NULL） */
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

/**
 * 操作类型 → 中文标签（BLF-845 精细化）。
 *
 * 与 AGENT_DOMAINS 注册表对齐：命中返回中文名；未注册的 code（后端新域
 * 尚未同步前端，或历史遗留值）显示原始 code 本身而非笼统「其他」，
 * 保证运维可辨识；title 悬浮提示说明这是未收录的业务域标识。
 */
function operationTypeLabel(code: string | null): string {
  if (!code) return '-'
  return getAgentDomain(code)?.label ?? code
}

function statusMeta(code: number) {
  if (code >= 500)
    return {
      label: `${code} · 服务端错误`,
      className: 'border-term-neg/50 bg-term-neg/10 text-term-neg',
    }
  if (code >= 400)
    return {
      label: `${code} · 请求错误`,
      className: 'border-term-warn/50 bg-term-warn/10 text-term-warn',
    }
  if (code >= 300)
    return {
      label: `${code} · 重定向`,
      className: 'border-term-warn/50 bg-term-warn/10 text-term-warn',
    }
  return {
    label: `${code} · 成功`,
    className: 'border-term-pos/50 bg-term-pos/10 text-term-pos',
  }
}

// ── 终端化统计概览原语（BLF-845：概览重设计） ─────────────────────
// 对齐 docs/terminal-design/master-prompt.md 硬约束：1px 边框平铺禁阴影、
// mono tabular-nums 数值、term-* 语义色、间距只取 4/8/12px 档。

/** 概览 KPI 磁贴：标签小字 faint + 主数值 mono 大号；tone 决定数值语义色。 */
function OverviewStatTile({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  /** pos=成功绿 / neg=失败红 / default=中性 */
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

/** Top N 排行条：中文名 + mono 计数 + 占比条（宽度按 count/max 归一）。 */
function RankBar({
  primary,
  secondary,
  count,
  max,
}: {
  primary: string
  /** 次级标识（agent_id 原文），可为空则不渲染 */
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
    <div className="space-y-4">
      {/** BLF-845 概览重设计：KPI 磁贴行 + Top Agent 排行，终端化 1px 边框平铺 */}
      <TermPanel title="访问统计概览">
        <div className="space-y-3 p-3">
          <div className="flex flex-wrap gap-2">
            <OverviewStatTile
              label="请求总量"
              value={(summary?.total ?? 0).toLocaleString('zh-CN')}
            />
            <OverviewStatTile
              label="成功 2XX"
              value={(summary?.success_count ?? 0).toLocaleString('zh-CN')}
              tone="pos"
            />
            <OverviewStatTile
              label="失败 ≥4XX"
              value={(summary?.error_count ?? 0).toLocaleString('zh-CN')}
              tone={summary && summary.error_count > 0 ? 'neg' : 'default'}
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
          {summary && summary.top_agents.length > 0 ? (
            <div className="border border-term-border bg-term-bg p-2">
              <p className="mb-1 font-mono text-[11px] uppercase tracking-wider text-term-faint">
                TOP AGENTS（当前筛选范围）
              </p>
              {(() => {
                const maxCount = Math.max(...summary.top_agents.map((a) => a.count))
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
          <p className="font-mono text-[11px] text-term-faint">
            /api/v1/agent/* 访问统计 · 保留 90 天
          </p>
        </div>
      </TermPanel>

      {/** BLF-845：访问记录表终端化（TermTable Pattern A）+ 国家维度列位 */}
      <TermPanel
        title="访问记录"
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
                <TermHead className="w-[170px]">Agent</TermHead>
                <TermHead className="w-[60px]">方法</TermHead>
                <TermHead>路径</TermHead>
                <TermHead className="w-[120px]">项目</TermHead>
                <TermHead className="w-[52px]" title="请求站点国家（后端字段就绪前显示 —，BLF-845）">
                  国家
                </TermHead>
                <TermHead className="w-[100px]">操作类型</TermHead>
                <TermHead className="w-[110px]">状态码</TermHead>
                <TermHead className="w-[64px]" numeric>
                  耗时
                </TermHead>
                <TermHead className="w-[110px]">IP 地址</TermHead>
                <TermHead className="w-[56px]" numeric>
                  详情
                </TermHead>
              </tr>
            </TermTHead>
            <TermBody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="h-24 text-center text-xs text-term-faint">
                    {loading ? '加载中…' : '暂无 Agent 访问记录'}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <TermRow key={row.id} onClick={() => setActiveRow(row)}>
                    <TermCell tone="muted" title={formatDateTime(row.created_at)}>
                      {formatDateTime(row.created_at)}
                    </TermCell>
                    <TermCell>
                      <AgentIdentityCell agentId={row.agent_id} agentName={row.key_label} />
                    </TermCell>
                    <TermCell>
                      <span className="border border-term-border px-1 font-mono text-[10px] text-term-muted">
                        {row.method}
                      </span>
                    </TermCell>
                    <TermCell className="max-w-[300px] truncate" title={row.path}>
                      {row.path}
                    </TermCell>
                    <TermCell title={formatProjectRef(row.project_id, row.project_name)}>
                      {formatProjectRef(row.project_id, row.project_name)}
                    </TermCell>
                    {/* BLF-845 ③：country 列。后端迁移 259 已落库并透出；
                        历史行与未带 ?country= 的请求为 NULL，显 '—' */}
                    <TermCell tone="muted">
                      {row.country ?? '—'}
                    </TermCell>
                    <TermCell>
                      {row.operation_type ? (
                        <span
                          title={`业务域 ${row.operation_type}`}
                          className="border border-term-accent/40 px-1 font-mono text-[10px] text-term-accent"
                        >
                          {operationTypeLabel(row.operation_type)}
                        </span>
                      ) : (
                        <span className="text-term-faint">—</span>
                      )}
                    </TermCell>
                    <TermCell>
                      <span
                        className={cn(
                          'border px-1 font-mono text-[10px]',
                          statusMeta(row.status_code).className
                        )}
                      >
                        {statusMeta(row.status_code).label}
                      </span>
                    </TermCell>
                    <TermCell numeric tone={row.latency_ms >= 3000 ? 'neg' : 'muted'}>
                      {row.latency_ms.toLocaleString('zh-CN')}ms
                    </TermCell>
                    <TermCell tone="muted" title={row.ip_address || undefined}>
                      {row.ip_address || '—'}
                    </TermCell>
                    <TermCell numeric>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          setActiveRow(row)
                        }}
                        className="inline-flex items-center gap-0.5 border border-term-border bg-term-bg px-1 font-mono text-[11px] text-term-accent transition-colors hover:border-term-border-strong"
                        aria-label={`查看 ${formatDateTime(row.created_at)} 的访问详情`}
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

      {/** 筛选工具栏：终端化 h-8 控件（对齐 order-info Console 工具栏规格） */}
      <TermPanel title="筛选">
        <div className="flex flex-wrap items-center gap-1 p-1.5">
          <Input
            value={keywordInput}
            onChange={(event) => setKeywordInput(event.target.value)}
            placeholder="关键词 Agent/路径"
            className="h-8 w-[170px] rounded-none border-term-border bg-term-bg text-xs text-term-text shadow-none placeholder:font-sans placeholder:text-term-faint focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <Select value={methodInput} onValueChange={setMethodInput}>
            <SelectTrigger className="h-8 w-[100px] rounded-none border-term-border bg-term-bg text-xs text-term-text focus:ring-0 data-[state=open]:border-term-border-strong">
              <SelectValue placeholder="请求方法" />
            </SelectTrigger>
            <SelectContent className="rounded-none border-term-border bg-term-panel text-term-text">
              <SelectItem value="all" className="rounded-none text-xs focus:bg-term-hover focus:text-term-text">
                全部方法
              </SelectItem>
              <SelectItem value="GET" className="rounded-none font-mono text-xs focus:bg-term-hover focus:text-term-text">
                GET
              </SelectItem>
              <SelectItem value="POST" className="rounded-none font-mono text-xs focus:bg-term-hover focus:text-term-text">
                POST
              </SelectItem>
              <SelectItem value="PUT" className="rounded-none font-mono text-xs focus:bg-term-hover focus:text-term-text">
                PUT
              </SelectItem>
              <SelectItem value="PATCH" className="rounded-none font-mono text-xs focus:bg-term-hover focus:text-term-text">
                PATCH
              </SelectItem>
              <SelectItem value="DELETE" className="rounded-none font-mono text-xs focus:bg-term-hover focus:text-term-text">
                DELETE
              </SelectItem>
            </SelectContent>
          </Select>
          <Select value={resultInput} onValueChange={setResultInput}>
            <SelectTrigger className="h-8 w-[110px] rounded-none border-term-border bg-term-bg text-xs text-term-text focus:ring-0 data-[state=open]:border-term-border-strong">
              <SelectValue placeholder="请求结果" />
            </SelectTrigger>
            <SelectContent className="rounded-none border-term-border bg-term-panel text-term-text">
              <SelectItem value="all" className="rounded-none text-xs focus:bg-term-hover focus:text-term-text">
                全部结果
              </SelectItem>
              <SelectItem value="success" className="rounded-none text-xs focus:bg-term-hover focus:text-term-text">
                成功 (2xx)
              </SelectItem>
              <SelectItem value="error" className="rounded-none text-xs focus:bg-term-hover focus:text-term-text">
                失败 (≥4xx)
              </SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={projectIdInput}
            onChange={(event) => setProjectIdInput(event.target.value)}
            placeholder="项目 ID（数字）"
            inputMode="numeric"
            className="h-8 w-[110px] rounded-none border-term-border bg-term-bg font-mono text-xs text-term-text shadow-none placeholder:font-sans placeholder:text-term-faint focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <Select value={operationTypeInput} onValueChange={setOperationTypeInput}>
            <SelectTrigger className="h-8 w-[130px] rounded-none border-term-border bg-term-bg text-xs text-term-text focus:ring-0 data-[state=open]:border-term-border-strong">
              <SelectValue placeholder="操作类型" />
            </SelectTrigger>
            <SelectContent className="rounded-none border-term-border bg-term-panel text-term-text">
              <SelectItem value="all" className="rounded-none text-xs focus:bg-term-hover focus:text-term-text">
                全部操作类型
              </SelectItem>
              {AGENT_DOMAINS.map((domain) => (
                <SelectItem
                  key={domain.code}
                  value={domain.code}
                  title={domain.code}
                  className="rounded-none text-xs focus:bg-term-hover focus:text-term-text"
                >
                  {domain.label}
                </SelectItem>
              ))}
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
          aria-describedby="agent-log-detail-dialog-description"
          className="max-h-[85vh] max-w-[calc(100%-2rem)] overflow-y-auto rounded-lg dark:border-border/80 dark:bg-[hsl(var(--surface-panel))] sm:max-w-3xl"
        >
          <span id="agent-log-detail-dialog-description" className="sr-only">
            Agent 访问日志详情查看
          </span>
          <DialogHeader>
            <DialogTitle>Agent 访问详情</DialogTitle>
          </DialogHeader>
          {activeRow ? (
            <div className="space-y-4 text-sm">
              <div className="grid gap-2 sm:grid-cols-2">
                <p>
                  <span className="text-muted-foreground">请求时间:</span>{' '}
                  {formatDateTime(activeRow.created_at)}
                </p>
                <p>
                  <span className="text-muted-foreground">状态码:</span>{' '}
                  {statusMeta(activeRow.status_code).label}
                </p>
                <p>
                  <span className="text-muted-foreground">Agent:</span>{' '}
                  {activeRow.agent_id ? (
                    <>
                      {activeRow.key_label ? (
                        <span className="font-medium">{activeRow.key_label} </span>
                      ) : null}
                      <code className="font-mono">{activeRow.agent_id}</code>
                    </>
                  ) : (
                    '未绑定 / 未鉴权'
                  )}
                </p>
                <p>
                  <span className="text-muted-foreground">项目:</span>{' '}
                  {formatProjectRef(activeRow.project_id, activeRow.project_name)}
                </p>
                {/* BLF-845 ③：国家字段位（迁移 259 起后端已落库并透出） */}
                <p>
                  <span className="text-muted-foreground">国家:</span>{' '}
                  {activeRow.country ?? '—'}
                </p>
                <p>
                  <span className="text-muted-foreground">操作类型:</span>{' '}
                  {activeRow.operation_type
                    ? operationTypeLabel(activeRow.operation_type)
                    : '-'}
                </p>
                <p>
                  <span className="text-muted-foreground">凭据标签:</span>{' '}
                  {activeRow.key_label || '-'}
                </p>
                <p>
                  <span className="text-muted-foreground">耗时:</span>{' '}
                  <code className="font-mono tabular-nums">{activeRow.latency_ms}ms</code>
                </p>
                <p>
                  <span className="text-muted-foreground">IP 地址:</span>{' '}
                  <code className="font-mono">{activeRow.ip_address || '-'}</code>
                </p>
              </div>

              <div className="space-y-2">
                <p className="font-medium">请求</p>
                <div className="rounded-md border border-border/70 bg-muted/40 p-3 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
                  <p>
                    <span className="text-muted-foreground">方法:</span>{' '}
                    <code className="font-mono">{activeRow.method}</code>
                  </p>
                  <p className="mt-1">
                    <span className="text-muted-foreground">路径:</span>{' '}
                    <code className="break-all font-mono text-xs">{activeRow.path}</code>
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <p className="font-medium">凭据</p>
                <div className="rounded-md border border-border/70 bg-muted/40 p-3 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
                  <p>
                    <span className="text-muted-foreground">API Key ID:</span>{' '}
                    <code className="font-mono text-xs">{activeRow.api_key_id ?? '未鉴权'}</code>
                  </p>
                  <p>
                    <span className="text-muted-foreground">日志 ID:</span>{' '}
                    <code className="font-mono text-xs">{activeRow.id}</code>
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
