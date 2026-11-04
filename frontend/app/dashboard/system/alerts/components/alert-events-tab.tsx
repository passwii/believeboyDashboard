'use client'

import { useCallback, useEffect, useState } from 'react'
import { useNotifications } from '@/components/notifications'
import {
  acknowledgeEvent,
  fetchAlertEvents,
  resolveEvent,
  type AlertEventItem,
} from '@/lib/alerts-api'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import {
  WarmBadge,
  WarmButton,
  type WarmBadgeTone,
} from '@/components/dashboard-v2/warm-ledger/controls'
import styles from '../alerts-warm.module.css'

const SEVERITY_TONE: Record<string, WarmBadgeTone> = {
  critical: 'negative',
  warning: 'accent',
  info: 'neutral',
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
    <div className={styles.tabPanel} data-warm-alert-events="true">
      <div className={styles.filters}>
        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value)
            setPage(1)
          }}
          className={styles.filterSelect}
          aria-label="按告警状态筛选"
        >
          <option value="active">活跃</option>
          <option value="acknowledged">已确认</option>
          <option value="resolved">已解决</option>
          <option value="all">全部状态</option>
        </select>
        <select
          value={severity}
          onChange={(event) => {
            setSeverity(event.target.value)
            setPage(1)
          }}
          className={styles.filterSelect}
          aria-label="按告警级别筛选"
        >
          <option value="critical">严重</option>
          <option value="warning">警告</option>
          <option value="info">提示</option>
          <option value="all">全部级别</option>
        </select>
      </div>

      <section className={styles.panel}>
        <div className={styles.tableScroll}>
          <table className={styles.table} aria-label="告警事件">
            <thead>
              <tr>
                <th>时间</th>
                <th>指标</th>
                <th>消息</th>
                <th className={styles.numericCell}>偏差</th>
                <th>级别</th>
                <th>状态</th>
                <th className={styles.numericCell}>操作</th>
              </tr>
            </thead>
            <tbody>
            {loading ? (
              <tr><td colSpan={7} className={styles.emptyCell}>加载中…</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={7} className={styles.emptyCell}>暂无告警事件</td></tr>
            ) : (
              items.map((e) => (
                <tr key={e.id}>
                  <td className={styles.timeCell}>{new Date(e.triggered_at).toLocaleString('zh-CN')}</td>
                  <td>{e.metric}</td>
                  <td className={styles.messageCell} title={e.message}>{e.message}</td>
                  <td className={styles.numericCell} data-tone={e.deviation_pct > 0 ? 'negative' : 'muted'}>
                    {e.deviation_pct.toFixed(1)}%
                  </td>
                  <td>
                    <WarmBadge tone={SEVERITY_TONE[e.severity] ?? 'neutral'}>
                      {e.severity}
                    </WarmBadge>
                  </td>
                  <td className={styles.mutedCell}>{STATUS_LABEL[e.status] ?? e.status}</td>
                  <td className={styles.actionCell}>
                    {e.status === 'active' && (
                      <WarmButton className={styles.rowAction} onClick={() => onAck(e.id)}>确认</WarmButton>
                    )}
                    {e.status !== 'resolved' && (
                      <WarmButton variant="quiet" className={styles.rowAction} onClick={() => onResolve(e.id)}>解决</WarmButton>
                    )}
                  </td>
                </tr>
              ))
            )}
            </tbody>
          </table>
        </div>
      </section>

      <div className={styles.pagination}>
        <span>共 {total} 条</span>
        <div className={styles.paginationActions}>
          <WarmButton className={styles.rowAction} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</WarmButton>
          <span className={styles.pageCount}>{page} / {totalPages}</span>
          <WarmButton className={styles.rowAction} disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</WarmButton>
        </div>
      </div>
    </div>
  )
}
