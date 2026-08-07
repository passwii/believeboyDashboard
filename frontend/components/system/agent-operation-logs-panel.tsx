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
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DataCard,
  DataCardHeader,
  DataTableCard,
  DataTableCardBody,
  DataTableCardStatBar,
} from '@/components/ui/data-card'
import { EmptyTableState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
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
      className: 'border-rose-500/50 bg-rose-500/10 text-rose-600 dark:text-rose-400',
    }
  return {
    label: '成功',
    className: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  }
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
    <div className="space-y-6">
      <DataCard>
        <DataCardHeader
          title="Agent 写操作统计概览"
          description="当前筛选条件下 agent 写操作（confirm 两步确认落库，保留 90 天）"
        />
        <div className="px-6 py-5">
          <DataTableCardStatBar
            items={[
              { label: '写操作总量', value: summary?.total ?? 0, highlight: true },
              { label: '成功', value: summary?.success_count ?? 0 },
              { label: '失败', value: summary?.failure_count ?? 0 },
              { label: '活跃 Agent', value: summary?.unique_agent_count ?? 0 },
            ]}
          />
          {summary && summary.top_actions.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {summary.top_actions.map((item) => (
                <span
                  key={item.action}
                  className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-xs text-violet-700 dark:text-violet-300"
                  title={item.action}
                >
                  {operationActionLabel(item.action)}
                  <span className="text-muted-foreground">×{item.count}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </DataCard>

      <DataTableCard>
        <DataCardHeader
          title="写操作记录"
          action={
            <Button type="button" variant="outline" onClick={() => void fetchLogs()} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {loading ? '刷新中...' : '刷新'}
            </Button>
          }
        />
        <DataTableCardBody>
          <div className="border border-white/45 bg-[hsl(var(--surface-subtle))] p-1.5 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[170px]">时间</TableHead>
                  <TableHead className="w-[150px]">Agent</TableHead>
                  <TableHead className="w-[130px]">操作</TableHead>
                  <TableHead className="w-[150px]">项目</TableHead>
                  <TableHead className="w-[150px]">对象</TableHead>
                  <TableHead className="w-[80px]">结果</TableHead>
                  <TableHead className="w-[80px] text-right">详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  loading ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground">
                        加载中...
                      </TableCell>
                    </TableRow>
                  ) : (
                    <EmptyTableState colSpan={7} message="暂无 Agent 写操作记录" />
                  )
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{formatDateTime(row.created_at)}</TableCell>
                      <TableCell>
                        <AgentIdentityCell agentId={row.agent_id} agentName={row.agent_name} />
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-xs">
                          {operationActionLabel(row.action)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {formatProjectRef(row.project_id, row.project_name)}
                      </TableCell>
                      <TableCell className="max-w-[150px] truncate" title={row.target_label || row.target_id || '-'}>
                        {targetTypeLabel(row.target_type)}
                        {row.target_label ? (
                          <span className="font-mono text-xs text-muted-foreground">
                            {' '}#{row.target_label}
                          </span>
                        ) : row.target_id ? (
                          <span className="text-muted-foreground"> #{row.target_id}</span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={resultMeta(row.result).className}>
                          {resultMeta(row.result).label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => setActiveRow(row)}>
                          <Eye className="h-4 w-4" />
                          查看
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between px-4 py-3">
            <p className="text-sm text-muted-foreground">
              共 {total} 条，当前第 {page} / {totalPages} 页
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                disabled={page <= 1 || loading}
              >
                上一页
              </Button>
              <Button
                variant="outline"
                onClick={() => setPage((prev) => prev + 1)}
                disabled={!hasNext || loading}
              >
                下一页
              </Button>
            </div>
          </div>
        </DataTableCardBody>
      </DataTableCard>

      <Card className="dashboard-surface">
        <CardContent className="p-4">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
            <Input
              value={keywordInput}
              onChange={(event) => setKeywordInput(event.target.value)}
              placeholder="关键词（Agent / 操作 / 对象 / 路径）"
            />
            <Input
              value={agentIdInput}
              onChange={(event) => setAgentIdInput(event.target.value)}
              placeholder="Agent ID"
            />
            <Input
              value={projectIdInput}
              onChange={(event) => setProjectIdInput(event.target.value)}
              placeholder="项目 ID（数字）"
              inputMode="numeric"
            />
            <Input
              value={actionInput}
              onChange={(event) => setActionInput(event.target.value)}
              placeholder="操作（如 shipment.status.transition）"
            />
            <Select value={resultInput} onValueChange={setResultInput}>
              <SelectTrigger>
                <SelectValue placeholder="操作结果" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部结果</SelectItem>
                <SelectItem value="success">成功</SelectItem>
                <SelectItem value="failure">失败</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="mt-3 flex gap-2">
            <Button className="flex-1 sm:flex-none" onClick={applyFilters}>
              <Search className="h-4 w-4" />
              查询
            </Button>
            <Button type="button" variant="outline" onClick={resetFilters}>
              重置
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={Boolean(activeRow)} onOpenChange={(open) => (open ? null : setActiveRow(null))}>
        <DialogContent
          aria-describedby="agent-operation-detail-dialog-description"
          className="max-h-[85vh] max-w-3xl overflow-y-auto dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]"
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
                  <div className="overflow-hidden rounded-md border border-border/70 dark:border-border/80">
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
