'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useNotifications } from '@/components/notifications'
import {
  acknowledgeEvent,
  fetchAlertEvents,
  resolveEvent,
  type AlertEventItem,
} from '@/lib/alerts-api'
import {
  TermBody,
  TermCell,
  TermHead,
  TermRow,
  TermTHead,
  TermTable,
} from '@/components/terminal/term-table'
import { TermPanel } from '@/components/terminal/term-panel'
import { TERM_TRIGGER, TERM_SELECT_ITEM, TERM_BUTTON, type TermTone } from '@/components/terminal/term-controls'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'

const SEVERITY_TONE: Record<string, TermTone> = {
  critical: 'neg',
  warning: 'warn',
  info: 'info',
}

const STATUS_LABEL: Record<string, string> = {
  active: '活跃',
  acknowledged: '已确认',
  resolved: '已解决',
}

const PAGE_SIZE = 20

export function AlertEventsTab({
  onRefreshReady,
}: {
  onRefreshReady?: (refresh: () => Promise<void>) => void
}) {
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

  useEffect(() => {
    onRefreshReady?.(load)
  }, [load, onRefreshReady])

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
    <div className="flex min-w-0 flex-col gap-2">
      {/* BLF-838：筛选行 h-9 终端规格（BLF-887 上档） */}
      <div className="flex flex-wrap items-center justify-end gap-1.5 max-md:justify-between">
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1) }}>
          <SelectTrigger className={`w-32 ${TERM_TRIGGER}`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem className={TERM_SELECT_ITEM} value="active">活跃</SelectItem>
            <SelectItem className={TERM_SELECT_ITEM} value="acknowledged">已确认</SelectItem>
            <SelectItem className={TERM_SELECT_ITEM} value="resolved">已解决</SelectItem>
            <SelectItem className={TERM_SELECT_ITEM} value="all">全部状态</SelectItem>
          </SelectContent>
        </Select>
        <Select value={severity} onValueChange={(v) => { setSeverity(v); setPage(1) }}>
          <SelectTrigger className={`w-32 ${TERM_TRIGGER}`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem className={TERM_SELECT_ITEM} value="critical">严重</SelectItem>
            <SelectItem className={TERM_SELECT_ITEM} value="warning">警告</SelectItem>
            <SelectItem className={TERM_SELECT_ITEM} value="info">提示</SelectItem>
            <SelectItem className={TERM_SELECT_ITEM} value="all">全部级别</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <TermPanel bodyClassName="p-0 overflow-x-auto">
        <TermTable>
          <TermTHead>
            <TermRow>
              <TermHead>时间</TermHead>
              <TermHead>指标</TermHead>
              <TermHead>消息</TermHead>
              <TermHead numeric>偏差</TermHead>
              <TermHead>级别</TermHead>
              <TermHead>状态</TermHead>
              <TermHead numeric>操作</TermHead>
            </TermRow>
          </TermTHead>
          <TermBody>
            {loading ? (
              <TermRow><TermCell colSpan={7} className="py-8 text-center text-term-faint">加载中…</TermCell></TermRow>
            ) : items.length === 0 ? (
              <TermRow><TermCell colSpan={7} className="py-8 text-center text-term-faint">暂无告警事件</TermCell></TermRow>
            ) : (
              items.map((e) => (
                <TermRow key={e.id}>
                  <TermCell className="text-term-muted">{new Date(e.triggered_at).toLocaleString('zh-CN')}</TermCell>
                  <TermCell>{e.metric}</TermCell>
                  <TermCell className="max-w-md truncate" title={e.message}>{e.message}</TermCell>
                  <TermCell numeric tone={e.deviation_pct > 0 ? 'neg' : 'muted'}>{e.deviation_pct.toFixed(1)}%</TermCell>
                  <TermCell>
                    <span className={`font-mono text-[11px] ${
                      e.severity === 'critical' ? 'text-term-neg' : e.severity === 'warning' ? 'text-term-warn' : 'text-term-text'
                    }`}>
                      {SEVERITY_TONE[e.severity] ? e.severity : e.severity}
                    </span>
                  </TermCell>
                  <TermCell className="text-term-muted">{STATUS_LABEL[e.status] ?? e.status}</TermCell>
                  <TermCell numeric>
                    {e.status === 'active' && (
                      <Button size="sm" variant="outline" className={`${TERM_BUTTON} px-1.5`} onClick={() => onAck(e.id)}>确认</Button>
                    )}
                    {e.status !== 'resolved' && (
                      <Button size="sm" variant="ghost" className={`${TERM_BUTTON} border-transparent bg-transparent px-1.5`} onClick={() => onResolve(e.id)}>解决</Button>
                    )}
                  </TermCell>
                </TermRow>
              ))
            )}
          </TermBody>
        </TermTable>
      </TermPanel>

      {/* 分页：终端规格（mono 计数 + h-9 按钮，BLF-887 上档） */}
      <div className="flex items-center justify-between font-mono text-xs text-term-muted">
        <span>共 {total} 条</span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className={`${TERM_BUTTON} px-1.5`} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</Button>
          <span className="tabular-nums">{page} / {totalPages}</span>
          <Button size="sm" variant="outline" className={`${TERM_BUTTON} px-1.5`} disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</Button>
        </div>
      </div>
    </div>
  )
}
