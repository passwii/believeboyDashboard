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
import { AGENT_DOMAINS, getAgentDomain } from '@/lib/agent-domains'

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
  key_label: string | null
  /** BLF-460 读操作明细：请求涉及的项目 ID 与业务域（中间件从 path 解析） */
  project_id: number | null
  operation_type: string | null
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

function operationTypeLabel(code: string | null): string {
  if (!code) return '-'
  return getAgentDomain(code)?.label ?? '其他'
}

function statusMeta(code: number) {
  if (code >= 500)
    return {
      label: `${code} · 服务端错误`,
      className: 'border-rose-500/50 bg-rose-500/10 text-rose-600 dark:text-rose-400',
    }
  if (code >= 400)
    return {
      label: `${code} · 请求错误`,
      className: 'border-orange-500/50 bg-orange-500/10 text-orange-600 dark:text-orange-400',
    }
  if (code >= 300)
    return {
      label: `${code} · 重定向`,
      className: 'border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    }
  return {
    label: `${code} · 成功`,
    className: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  }
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
    <div className="space-y-6">
      <DataCard>
        <DataCardHeader
          title="Agent 访问统计概览"
          description="当前筛选条件下 /api/v1/agent/* 的访问统计（保留 90 天）"
        />
        <div className="px-6 py-5">
          <DataTableCardStatBar
            items={[
              { label: '请求总量', value: summary?.total ?? 0, highlight: true },
              { label: '成功 (2xx)', value: summary?.success_count ?? 0 },
              { label: '失败 (≥4xx)', value: summary?.error_count ?? 0 },
              { label: '活跃 Agent', value: summary?.unique_agent_count ?? 0 },
            ]}
          />
          {summary && summary.top_agents.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {summary.top_agents.map((item) => (
                <span
                  key={item.agent_id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs text-indigo-700 dark:text-indigo-300"
                  title={`${item.agent_id}（${item.key_label || '无标签'}）`}
                >
                  <code className="font-mono">{item.agent_id}</code>
                  <span className="text-muted-foreground">×{item.count}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </DataCard>

      <DataTableCard>
        <DataCardHeader
          title="访问记录"
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
                  <TableHead className="w-[150px]">Agent ID</TableHead>
                  <TableHead className="w-[130px]">Key 标签</TableHead>
                  <TableHead className="w-[70px]">方法</TableHead>
                  <TableHead>路径</TableHead>
                  <TableHead className="w-[90px]">项目 ID</TableHead>
                  <TableHead className="w-[110px]">操作类型</TableHead>
                  <TableHead className="w-[110px]">状态码</TableHead>
                  <TableHead className="w-[70px]">耗时</TableHead>
                  <TableHead className="w-[120px]">IP 地址</TableHead>
                  <TableHead className="w-[80px] text-right">详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  loading ? (
                    <TableRow>
                      <TableCell colSpan={11} className="text-center text-muted-foreground">
                        加载中...
                      </TableCell>
                    </TableRow>
                  ) : (
                    <EmptyTableState colSpan={11} message="暂无 Agent 访问记录" />
                  )
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{formatDateTime(row.created_at)}</TableCell>
                      <TableCell>
                        {row.agent_id ? (
                          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                            {row.agent_id}
                          </code>
                        ) : (
                          <span className="text-muted-foreground">未绑定 / 未鉴权</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[130px] truncate" title={row.key_label || '-'}>
                        {row.key_label || '-'}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono">
                          {row.method}
                        </Badge>
                      </TableCell>
                      <TableCell
                        className="max-w-[300px] truncate font-mono text-xs"
                        title={row.path}
                      >
                        {row.path}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.project_id ?? '-'}
                      </TableCell>
                      <TableCell>
                        {row.operation_type ? (
                          <Badge variant="outline" className="font-mono text-xs">
                            {operationTypeLabel(row.operation_type)}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={statusMeta(row.status_code).className}>
                          {statusMeta(row.status_code).label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.latency_ms}ms
                      </TableCell>
                      <TableCell className="font-mono text-xs">{row.ip_address || '-'}</TableCell>
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
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <Input
              value={keywordInput}
              onChange={(event) => setKeywordInput(event.target.value)}
              placeholder="关键词（Agent ID / Key 标签 / 路径）"
            />
            <Select value={methodInput} onValueChange={setMethodInput}>
              <SelectTrigger>
                <SelectValue placeholder="请求方法" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部方法</SelectItem>
                <SelectItem value="GET">GET</SelectItem>
                <SelectItem value="POST">POST</SelectItem>
                <SelectItem value="PUT">PUT</SelectItem>
                <SelectItem value="PATCH">PATCH</SelectItem>
                <SelectItem value="DELETE">DELETE</SelectItem>
              </SelectContent>
            </Select>
            <Select value={resultInput} onValueChange={setResultInput}>
              <SelectTrigger>
                <SelectValue placeholder="请求结果" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部结果</SelectItem>
                <SelectItem value="success">成功 (2xx)</SelectItem>
                <SelectItem value="error">失败 (≥4xx)</SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={projectIdInput}
              onChange={(event) => setProjectIdInput(event.target.value)}
              placeholder="项目 ID（数字）"
              inputMode="numeric"
            />
            <Select value={operationTypeInput} onValueChange={setOperationTypeInput}>
              <SelectTrigger>
                <SelectValue placeholder="操作类型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部操作类型</SelectItem>
                {AGENT_DOMAINS.map((domain) => (
                  <SelectItem key={domain.code} value={domain.code}>
                    {domain.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-2">
              <Button className="flex-1" onClick={applyFilters}>
                <Search className="h-4 w-4" />
                查询
              </Button>
              <Button type="button" variant="outline" onClick={resetFilters}>
                重置
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={Boolean(activeRow)} onOpenChange={(open) => (open ? null : setActiveRow(null))}>
        <DialogContent
          aria-describedby="agent-log-detail-dialog-description"
          className="max-h-[85vh] max-w-3xl overflow-y-auto dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]"
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
                  <span className="text-muted-foreground">Agent ID:</span>{' '}
                  <code className="font-mono">{activeRow.agent_id || '未绑定 / 未鉴权'}</code>
                </p>
                <p>
                  <span className="text-muted-foreground">项目 ID:</span>{' '}
                  <code className="font-mono">{activeRow.project_id ?? '-'}</code>
                </p>
                <p>
                  <span className="text-muted-foreground">操作类型:</span>{' '}
                  {activeRow.operation_type
                    ? operationTypeLabel(activeRow.operation_type)
                    : '-'}
                </p>
                <p>
                  <span className="text-muted-foreground">Key 标签:</span>{' '}
                  {activeRow.key_label || '-'}
                </p>
                <p>
                  <span className="text-muted-foreground">耗时:</span> {activeRow.latency_ms}ms
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
