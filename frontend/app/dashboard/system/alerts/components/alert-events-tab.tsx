'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { useNotifications } from '@/components/notifications'
import {
  acknowledgeEvent,
  fetchAlertEvents,
  resolveEvent,
  type AlertEventItem,
} from '@/lib/alerts-api'

const SEVERITY_TONE: Record<string, string> = {
  critical: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  warning: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  info: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
}

const STATUS_LABEL: Record<string, string> = {
  active: '活跃',
  acknowledged: '已确认',
  resolved: '已解决',
}

const PAGE_SIZE = 20

export function AlertEventsTab() {
  const { notify } = useNotifications()
  const [status, setStatus] = useState<string>('active')
  const [severity, setSeverity] = useState<string>('all')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<AlertEventItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetchAlertEvents({
        status: status === 'all' ? undefined : status,
        severity: severity === 'all' ? undefined : severity,
        page,
        page_size: PAGE_SIZE,
      })
      setItems(res.items)
      setTotal(res.total)
    } catch (err) {
      notify({ type: 'error', title: '加载告警事件失败', message: String(err) })
    } finally {
      setLoading(false)
    }
  }, [status, severity, page, notify])

  useEffect(() => {
    void load()
  }, [load])

  const onAck = async (id: number) => {
    try {
      await acknowledgeEvent(id)
      notify({ type: 'success', title: '已确认告警' })
      void load()
    } catch (err) {
      notify({ type: 'error', title: '确认失败', message: String(err) })
    }
  }

  const onResolve = async (id: number) => {
    try {
      await resolveEvent(id)
      notify({ type: 'success', title: '已解决告警' })
      void load()
    } catch (err) {
      notify({ type: 'error', title: '解决失败', message: String(err) })
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1) }}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="active">活跃</SelectItem>
            <SelectItem value="acknowledged">已确认</SelectItem>
            <SelectItem value="resolved">已解决</SelectItem>
            <SelectItem value="all">全部状态</SelectItem>
          </SelectContent>
        </Select>
        <Select value={severity} onValueChange={(v) => { setSeverity(v); setPage(1) }}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="critical">严重</SelectItem>
            <SelectItem value="warning">警告</SelectItem>
            <SelectItem value="info">提示</SelectItem>
            <SelectItem value="all">全部级别</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="dashboard-surface rounded-xl">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>指标</TableHead>
              <TableHead>消息</TableHead>
              <TableHead className="text-right">偏差</TableHead>
              <TableHead>级别</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">加载中…</TableCell></TableRow>
            ) : items.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">暂无告警事件</TableCell></TableRow>
            ) : (
              items.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {new Date(e.triggered_at).toLocaleString('zh-CN')}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{e.metric}</TableCell>
                  <TableCell className="max-w-md truncate" title={e.message}>{e.message}</TableCell>
                  <TableCell className="text-right tabular-nums">{e.deviation_pct.toFixed(1)}%</TableCell>
                  <TableCell>
                    <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${SEVERITY_TONE[e.severity] ?? ''}`}>
                      {e.severity}
                    </span>
                  </TableCell>
                  <TableCell>{STATUS_LABEL[e.status] ?? e.status}</TableCell>
                  <TableCell className="text-right">
                    {e.status === 'active' && (
                      <Button size="sm" variant="outline" onClick={() => onAck(e.id)}>确认</Button>
                    )}
                    {e.status !== 'resolved' && (
                      <Button size="sm" variant="ghost" className="ml-1" onClick={() => onResolve(e.id)}>解决</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>共 {total} 条</span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
          <span>{page} / {totalPages}</span>
          <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</Button>
        </div>
      </div>
    </div>
  )
}
