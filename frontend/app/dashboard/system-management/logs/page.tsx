'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Eye, FileSpreadsheet, Loader2, PackageCheck, RefreshCw, Search, ShieldCheck, Users } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { buildBackendHeaders } from '@/lib/backend-auth'

type OperationAuditLogItem = {
  id: number
  created_at: string
  operator: string | null
  action: string
  target_type: string
  target_id: string | null
  result: string
  trace_id: string | null
  request_method: string | null
  request_path: string | null
  ip_address: string | null
  user_agent: string | null
  before_json: Record<string, unknown> | unknown[] | null
  after_json: Record<string, unknown> | unknown[] | null
  error_message: string | null
}

type OperationAuditLogsResponse = {
  items: OperationAuditLogItem[]
  total: number
  page: number
  page_size: number
  has_next: boolean
}

type OperationAuditLogModuleSummaryItem = {
  key: string
  label: string
  count: number
  success_count: number
  failure_count: number
}

type OperationAuditLogActionSummaryItem = {
  action: string
  count: number
}

type OperationAuditLogsSummaryResponse = {
  total: number
  success_count: number
  failure_count: number
  unique_operator_count: number
  modules: OperationAuditLogModuleSummaryItem[]
  top_actions: OperationAuditLogActionSummaryItem[]
}

const API_BASE = '/api/backend'
const MODULE_ACTION_FILTERS: Record<string, string> = {
  commission: 'commission.',
  shipment_schedules: 'shipment_schedules.',
  projects: 'projects.',
  users: 'users.',
}

function formatDateTime(value: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

async function parseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: string; message?: string }
    return payload.detail || payload.message || `请求失败 (${response.status})`
  } catch {
    return `请求失败 (${response.status})`
  }
}

function renderJson(value: unknown): string {
  if (value == null) return '-'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export default function SystemOperationLogsPage() {
  const { data: session, status } = useSession()

  const [rows, setRows] = useState<OperationAuditLogItem[]>([])
  const [summary, setSummary] = useState<OperationAuditLogsSummaryResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const pageSize = 20
  const [total, setTotal] = useState(0)
  const [hasNext, setHasNext] = useState(false)

  const [keywordInput, setKeywordInput] = useState('')
  const [operatorInput, setOperatorInput] = useState('')
  const [actionInput, setActionInput] = useState('')
  const [targetTypeInput, setTargetTypeInput] = useState('')
  const [resultInput, setResultInput] = useState<'all' | 'success' | 'failure'>('all')

  const [keyword, setKeyword] = useState('')
  const [operator, setOperator] = useState('')
  const [action, setAction] = useState('')
  const [targetType, setTargetType] = useState('')
  const [result, setResult] = useState<'all' | 'success' | 'failure'>('all')

  const [activeRow, setActiveRow] = useState<OperationAuditLogItem | null>(null)

  const fetchLogs = useCallback(async () => {
    if (status === 'loading') return
    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('page_size', String(pageSize))
      if (keyword) params.set('keyword', keyword)
      if (operator) params.set('operator', operator)
      if (action) params.set('action', action)
      if (targetType) params.set('target_type', targetType)
      if (result !== 'all') params.set('result', result)

      const headers = buildBackendHeaders(session)
      const [logsResponse, summaryResponse] = await Promise.all([
        fetch(`${API_BASE}/api/v1/system-management/audit-logs?${params.toString()}`, {
          headers,
          cache: 'no-store',
        }),
        fetch(`${API_BASE}/api/v1/system-management/audit-logs/summary?${params.toString()}`, {
          headers,
          cache: 'no-store',
        }),
      ])

      if (!logsResponse.ok) {
        throw new Error(await parseError(logsResponse))
      }
      if (!summaryResponse.ok) {
        throw new Error(await parseError(summaryResponse))
      }

      const [logsPayload, summaryPayload] = (await Promise.all([
        logsResponse.json(),
        summaryResponse.json(),
      ])) as [OperationAuditLogsResponse, OperationAuditLogsSummaryResponse]

      setRows(logsPayload.items || [])
      setTotal(logsPayload.total || 0)
      setHasNext(Boolean(logsPayload.has_next))
      setSummary(summaryPayload)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载日志失败')
    } finally {
      setLoading(false)
    }
  }, [action, keyword, operator, page, result, session, status, targetType])

  useEffect(() => {
    void fetchLogs()
  }, [fetchLogs])

  const totalPages = useMemo(() => {
    if (total <= 0) return 1
    return Math.max(1, Math.ceil(total / pageSize))
  }, [total])

  const applyFilters = useCallback(() => {
    setPage(1)
    setKeyword(keywordInput.trim())
    setOperator(operatorInput.trim())
    setAction(actionInput.trim())
    setTargetType(targetTypeInput.trim())
    setResult(resultInput)
  }, [actionInput, keywordInput, operatorInput, resultInput, targetTypeInput])

  const resetFilters = useCallback(() => {
    setKeywordInput('')
    setOperatorInput('')
    setActionInput('')
    setTargetTypeInput('')
    setResultInput('all')
    setPage(1)
    setKeyword('')
    setOperator('')
    setAction('')
    setTargetType('')
    setResult('all')
  }, [])

  const summaryCards = useMemo(() => {
    const modules = summary?.modules ?? []
    return [
      {
        key: 'total',
        title: '全部审计日志',
        value: summary?.total ?? 0,
        detail: `成功 ${summary?.success_count ?? 0} / 失败 ${summary?.failure_count ?? 0}`,
        icon: <Activity className="h-4 w-4" />,
        accent: 'from-slate-900/90 via-slate-700/80 to-slate-500/70 text-white',
        onClick: () => {
          setActionInput('')
          setPage(1)
          setAction('')
        },
      },
      {
        key: 'commission',
        title: '运营报表核算',
        value: modules.find((item) => item.key === 'commission')?.count ?? 0,
        detail: `成功 ${modules.find((item) => item.key === 'commission')?.success_count ?? 0} / 失败 ${modules.find((item) => item.key === 'commission')?.failure_count ?? 0}`,
        icon: <FileSpreadsheet className="h-4 w-4" />,
        accent: 'from-cyan-500 via-sky-500 to-blue-600 text-white',
        onClick: () => {
          setActionInput(MODULE_ACTION_FILTERS.commission)
          setPage(1)
          setAction(MODULE_ACTION_FILTERS.commission)
        },
      },
      {
        key: 'shipment',
        title: '编辑发货管理',
        value: modules.find((item) => item.key === 'shipment_schedules')?.count ?? 0,
        detail: `成功 ${modules.find((item) => item.key === 'shipment_schedules')?.success_count ?? 0} / 失败 ${modules.find((item) => item.key === 'shipment_schedules')?.failure_count ?? 0}`,
        icon: <PackageCheck className="h-4 w-4" />,
        accent: 'from-amber-400 via-orange-500 to-rose-500 text-white',
        onClick: () => {
          setActionInput(MODULE_ACTION_FILTERS.shipment_schedules)
          setPage(1)
          setAction(MODULE_ACTION_FILTERS.shipment_schedules)
        },
      },
      {
        key: 'operators',
        title: '活跃操作人',
        value: summary?.unique_operator_count ?? 0,
        detail: '当前筛选条件下的去重人数',
        icon: <Users className="h-4 w-4" />,
        accent: 'from-emerald-500 via-teal-500 to-cyan-500 text-white',
        onClick: undefined,
      },
    ]
  }, [summary])

  const topActions = summary?.top_actions ?? []

  return (
    <div className="w-full space-y-6">
      <Card className="overflow-hidden border-border/80 shadow-[0_20px_45px_-24px_rgba(15,23,42,0.26)]">
        <CardHeader className="space-y-3 bg-gradient-to-r from-slate-500/10 via-cyan-500/10 to-transparent">
          <Badge variant="outline" className="w-fit rounded-md border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
            系统管理
          </Badge>
          <CardTitle>日志查看</CardTitle>
          <CardDescription>查看后端关键操作审计日志，支持按操作人、动作、资源类型和结果筛选。</CardDescription>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={() => void fetchLogs()} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {loading ? '刷新中...' : '刷新'}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-5 p-5 sm:p-7">
          {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">{error}</div> : null}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {summaryCards.map((card) => (
              <button
                key={card.key}
                type="button"
                onClick={card.onClick}
                disabled={!card.onClick}
                className={`group rounded-2xl bg-gradient-to-br ${card.accent} p-[1px] text-left ${card.onClick ? 'transition-transform duration-200 hover:-translate-y-0.5' : 'cursor-default'}`}
              >
                <div className="flex h-full min-h-[138px] flex-col justify-between rounded-[calc(1rem-1px)] bg-black/10 p-4 backdrop-blur-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/72">{card.title}</p>
                      <p className="mt-3 text-3xl font-semibold tracking-tight">{card.value}</p>
                    </div>
                    <div className="rounded-xl border border-white/15 bg-white/10 p-2 text-white/90">
                      {card.icon}
                    </div>
                  </div>
                  <p className="text-sm text-white/78">{card.detail}</p>
                </div>
              </button>
            ))}
          </div>

          <Card className="border-border/70 bg-muted/20 shadow-none">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4 text-cyan-600" />
                高频动作统计
              </CardTitle>
              <CardDescription>帮助快速定位最近最常见的审计动作，点击下方标签可直接带入动作筛选。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2 pt-0">
              {topActions.length === 0 ? (
                <span className="text-sm text-muted-foreground">当前筛选条件下暂无动作统计</span>
              ) : (
                topActions.map((item) => (
                  <button
                    key={item.action}
                    type="button"
                    onClick={() => {
                      setActionInput(item.action)
                      setPage(1)
                      setAction(item.action)
                    }}
                    className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-background px-3 py-1.5 text-sm transition-colors hover:border-cyan-500/40 hover:bg-cyan-500/5"
                  >
                    <span className="font-medium">{item.action}</span>
                    <Badge variant="secondary" className="rounded-full px-2 py-0 text-[11px]">
                      {item.count}
                    </Badge>
                  </button>
                ))
              )}
            </CardContent>
          </Card>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
            <Input value={keywordInput} onChange={(event) => setKeywordInput(event.target.value)} placeholder="关键词（路径/目标ID/trace）" />
            <Input value={operatorInput} onChange={(event) => setOperatorInput(event.target.value)} placeholder="操作人" />
            <Input value={actionInput} onChange={(event) => setActionInput(event.target.value)} placeholder="动作（例如 users.update）" />
            <Input value={targetTypeInput} onChange={(event) => setTargetTypeInput(event.target.value)} placeholder="资源类型（project/user）" />
            <Select value={resultInput} onValueChange={(value: 'all' | 'success' | 'failure') => setResultInput(value)}>
              <SelectTrigger>
                <SelectValue placeholder="结果" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部结果</SelectItem>
                <SelectItem value="success">成功</SelectItem>
                <SelectItem value="failure">失败</SelectItem>
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

          <div className="rounded-lg border border-border/70">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[180px]">时间</TableHead>
                  <TableHead className="w-[120px]">操作人</TableHead>
                  <TableHead>动作</TableHead>
                  <TableHead className="w-[140px]">资源类型</TableHead>
                  <TableHead className="w-[130px]">资源 ID</TableHead>
                  <TableHead className="w-[100px]">结果</TableHead>
                  <TableHead className="w-[100px] text-right">详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      {loading ? '加载中...' : '暂无日志'}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{formatDateTime(row.created_at)}</TableCell>
                      <TableCell>{row.operator || '-'}</TableCell>
                      <TableCell className="max-w-[360px] truncate font-medium" title={row.action}>
                        {row.action}
                      </TableCell>
                      <TableCell>{row.target_type}</TableCell>
                      <TableCell className="max-w-[130px] truncate" title={row.target_id || '-'}>
                        {row.target_id || '-'}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={row.result === 'success' ? 'text-emerald-600' : 'text-destructive'}>
                          {row.result}
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

          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              共 {total} 条，当前第 {page} / {totalPages} 页
            </p>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setPage((prev) => Math.max(1, prev - 1))} disabled={page <= 1 || loading}>
                上一页
              </Button>
              <Button variant="outline" onClick={() => setPage((prev) => prev + 1)} disabled={!hasNext || loading}>
                下一页
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={Boolean(activeRow)} onOpenChange={(open) => (open ? null : setActiveRow(null))}>
        <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>日志详情</DialogTitle>
          </DialogHeader>
          {activeRow ? (
            <div className="space-y-4 text-sm">
              <div className="grid gap-2 sm:grid-cols-2">
                <p>时间: {formatDateTime(activeRow.created_at)}</p>
                <p>操作人: {activeRow.operator || '-'}</p>
                <p>动作: {activeRow.action}</p>
                <p>结果: {activeRow.result}</p>
                <p>资源类型: {activeRow.target_type}</p>
                <p>资源 ID: {activeRow.target_id || '-'}</p>
                <p>请求: {activeRow.request_method || '-'} {activeRow.request_path || ''}</p>
                <p>Trace ID: {activeRow.trace_id || '-'}</p>
              </div>
              <div className="space-y-2">
                <p className="font-medium">Before</p>
                <pre className="overflow-x-auto rounded-md border border-border/70 bg-muted/40 p-3 text-xs">{renderJson(activeRow.before_json)}</pre>
              </div>
              <div className="space-y-2">
                <p className="font-medium">After</p>
                <pre className="overflow-x-auto rounded-md border border-border/70 bg-muted/40 p-3 text-xs">{renderJson(activeRow.after_json)}</pre>
              </div>
              {activeRow.error_message ? (
                <div className="space-y-2">
                  <p className="font-medium text-destructive">Error</p>
                  <pre className="overflow-x-auto rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                    {activeRow.error_message}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
