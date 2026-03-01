'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Database, Loader2, RefreshCw, Save, Server } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
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

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? ''
const API_KEY = process.env.NEXT_PUBLIC_BACKEND_API_KEY ?? ''

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  if (API_KEY) headers['X-API-Key'] = API_KEY
  headers['X-Operator'] = 'dashboard-admin'
  return headers
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
  try {
    const payload = (await response.json()) as { detail?: string; message?: string }
    return payload.detail || payload.message || `请求失败 (${response.status})`
  } catch {
    const text = await response.text()
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
  if (status === 'healthy') return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
  if (status === 'empty') return 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/30'
  if (status === 'stale') return 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30'
  return 'bg-destructive/10 text-destructive border-destructive/30'
}

export default function SystemDataManagementPage() {
  const [overview, setOverview] = useState<DataManagementOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [selectedStatus, setSelectedStatus] = useState<DataLifecycleStatus>('active')
  const [statusNote, setStatusNote] = useState('')

  const loadOverview = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch(`${API_BASE}/api/v1/system-management/data-management/overview`, {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      const payload = (await response.json()) as DataManagementOverview
      setOverview(payload)
      setSelectedStatus(payload.summary.data_status)
      setStatusNote(payload.data_status_note || '')
    } catch (loadErr) {
      setError(loadErr instanceof Error ? loadErr.message : '状态加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  const onSaveStatus = useCallback(async () => {
    setSaving(true)
    setError(null)
    setSuccess(null)

    try {
      const response = await fetch(`${API_BASE}/api/v1/system-management/data-management/data-status`, {
        method: 'PATCH',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: selectedStatus,
          note: statusNote.trim() || null,
        }),
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      setSuccess('数据状态更新成功')
      await loadOverview()
    } catch (saveErr) {
      setError(saveErr instanceof Error ? saveErr.message : '状态更新失败')
    } finally {
      setSaving(false)
    }
  }, [loadOverview, selectedStatus, statusNote])

  const summaryCards = useMemo(() => {
    if (!overview) return []
    return [
      {
        key: 'db',
        title: '数据库连接',
        value: overview.database.healthy ? '正常' : '异常',
        hint: `引擎 ${overview.database.engine}`,
        icon: <Database className="h-4 w-4" />,
        tone: overview.database.healthy ? 'text-emerald-600' : 'text-destructive',
      },
      {
        key: 'tables',
        title: '表数量',
        value: formatNumber(overview.summary.total_tables),
        hint: `异常/陈旧 ${overview.summary.stale_tables}`,
        icon: <Server className="h-4 w-4" />,
        tone: overview.summary.stale_tables > 0 ? 'text-amber-600' : 'text-foreground',
      },
      {
        key: 'rows',
        title: '总数据量',
        value: formatNumber(overview.summary.total_rows),
        hint: '统计所有业务表',
        icon: <Database className="h-4 w-4" />,
        tone: 'text-foreground',
      },
      {
        key: 'status',
        title: '数据状态',
        value: statusLabel(overview.summary.data_status),
        hint: `更新时间 ${formatDateTime(overview.data_status_updated_at)}`,
        icon: <CheckCircle2 className="h-4 w-4" />,
        tone: 'text-cyan-700 dark:text-cyan-300',
      },
    ]
  }, [overview])

  return (
    <div className="w-full space-y-6">
      <Card className="overflow-hidden border-border/80 shadow-[0_20px_45px_-24px_rgba(15,23,42,0.26)]">
        <CardHeader className="space-y-3 bg-gradient-to-r from-cyan-500/10 via-sky-500/10 to-transparent">
          <Badge variant="outline" className="w-fit rounded-md border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
            系统管理
          </Badge>
          <CardTitle>数据库状态</CardTitle>
          <CardDescription>支持修改数据状态，并实时查看数据库状态、表状态、数据状态与最近系统状态。</CardDescription>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={() => void loadOverview()} disabled={loading || saving}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {loading ? '刷新中...' : '刷新状态'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6 p-5 sm:p-7">
          {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">{error}</div> : null}
          {success ? (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-700 dark:text-emerald-300">
              {success}
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {summaryCards.map((card) => (
              <div key={card.key} className="rounded-xl border border-border/70 bg-card/70 p-4">
                <div className="flex items-center justify-between text-muted-foreground">
                  <p className="text-xs">{card.title}</p>
                  {card.icon}
                </div>
                <p className={cn('mt-2 text-xl font-semibold', card.tone)}>{card.value}</p>
                <p className="mt-1 text-xs text-muted-foreground">{card.hint}</p>
              </div>
            ))}
          </div>

          <Card className="border-border/70 bg-muted/20">
            <CardHeader>
              <CardTitle className="text-base">修改数据状态</CardTitle>
              <CardDescription>用于控制当前业务数据是否开放写入、维护或暂停。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-[220px_1fr_auto]">
              <Select value={selectedStatus} onValueChange={(value: DataLifecycleStatus) => setSelectedStatus(value)}>
                <SelectTrigger>
                  <SelectValue placeholder="选择状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">正常运行</SelectItem>
                  <SelectItem value="maintenance">维护中</SelectItem>
                  <SelectItem value="read_only">只读模式</SelectItem>
                  <SelectItem value="paused">暂停更新</SelectItem>
                </SelectContent>
              </Select>
              <Input placeholder="变更备注（可选）" value={statusNote} onChange={(event) => setStatusNote(event.target.value)} maxLength={500} />
              <Button onClick={() => void onSaveStatus()} disabled={saving || loading}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {saving ? '保存中...' : '保存状态'}
              </Button>
            </CardContent>
          </Card>

          <div className="grid gap-6 xl:grid-cols-[1.35fr_1fr]">
            <Card className="border-border/70">
              <CardHeader>
                <CardTitle className="text-base">数据表状态</CardTitle>
                <CardDescription>检查各表数据规模、最近更新时间和健康状态。</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-lg border border-border/70">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>表名</TableHead>
                        <TableHead>行数</TableHead>
                        <TableHead>最后更新</TableHead>
                        <TableHead>状态</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {!overview || overview.tables.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center text-muted-foreground">
                            {loading ? '加载中...' : '暂无表状态数据'}
                          </TableCell>
                        </TableRow>
                      ) : (
                        overview.tables.map((item) => (
                          <TableRow key={item.table_name}>
                            <TableCell className="font-medium">{item.table_name}</TableCell>
                            <TableCell>{item.row_count == null ? '-' : formatNumber(item.row_count)}</TableCell>
                            <TableCell>{formatDateTime(item.last_updated_at)}</TableCell>
                            <TableCell>
                              <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs', tableStatusTone(item.status))}>
                                {item.status}
                              </span>
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            <Card className="border-border/70">
              <CardHeader>
                <CardTitle className="text-base">最近系统状态</CardTitle>
                <CardDescription>展示数据状态和最近任务执行反馈。</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {!overview || overview.recent_statuses.length === 0 ? (
                  <div className="rounded-md border border-border/70 p-3 text-sm text-muted-foreground">暂无系统状态记录</div>
                ) : (
                  overview.recent_statuses.map((item, index) => (
                    <div key={`${item.source}-${index}`} className="rounded-lg border border-border/70 bg-card/60 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          {item.level === 'failed' || item.level === 'error' ? (
                            <AlertTriangle className="h-4 w-4 text-destructive" />
                          ) : (
                            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                          )}
                          <span>{item.source}</span>
                        </div>
                        <Badge variant="outline" className="text-[11px]">
                          {item.level}
                        </Badge>
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">{item.message}</p>
                      <p className="mt-2 text-xs text-muted-foreground">{formatDateTime(item.occurred_at)}</p>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>

          <p className="text-xs leading-5 text-muted-foreground">
            数据源：{overview?.database.source || '-'}，检查时间：{formatDateTime(overview?.database.checked_at || null)}。
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
