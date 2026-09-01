'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Check, ChevronUp, ExternalLink, X } from 'lucide-react'

import { Skeleton } from '@/components/ui/skeleton'
import { useLiveStream } from '@/components/terminal/use-live-stream'
import { TermBody, TermCell, TermRow, TermTable } from '@/components/terminal/term-table'
import {
  usePendingOrders,
  type PendingOrderItem,
} from '@/components/dashboard-v2/use-pending-orders'
import { usePendingCount } from '@/components/dashboard-v2/use-pending-count'
import { useProcessedOrders } from '@/components/dashboard-v2/use-processed-orders'
import { getOrderStatusLabel, getOrderStatusTone, ORDER_STATUS_TONE_PILL_CLASS } from '@/lib/order-status'
import { buildBackendClientHeaders } from '@/lib/backend-auth'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { useNotifications } from '@/components/notifications'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import type { LiveStreamItem } from '@/components/terminal/terminal-inspector'
import { cn } from '@/lib/utils'

/**
 * BLF-926：Dashboard 首页右侧新订单流面板。
 *
 * ## Stage 1（已实现）
 * - 桌面（lg+）右侧面板，默认折叠窄条（w-11），点击展开 w-[320px]；折叠状态持久化。
 *
 * ## Stage 2（BLF-927 已实现）
 * - 订单级 pending 列表（overview 单请求，仅展开时请求，项目+日期窗口限定 BEL-422）。
 * - 行点击跳转 order-info 并预填 Pending 筛选。
 *
 * ## Stage 3（BLF-928 本期）
 * - 实时计数：`usePendingCount`（30s 可见感知轮询，收起时也更新折叠徽标）；
 *   展开态列表 `usePendingOrders` 自身 30s 可见感知轮询首页。
 * - 操作闭环：行内「标记处理」（PATCH /api/v1/order-info/{id}，对齐 OrderEditDialog 的
 *   X-Operator 请求头模式）+「清空 pending」入口；已处理 id 持久化（localStorage），
 *   本地计数/列表即时更新。
 * - 移动端（<lg）：底部折叠条 + Sheet 抽屉（对齐 terminal-shell 移动端抽屉范式），
 *   与左侧导航 Sheet（side=left）互不冲突。
 */

// ======================== 类型 ========================

/** 日销售行（取本组件用到的字段）—— 与 app/dashboard/page.tsx 的 DailyAnalysisRow 对齐 */
export type V2OrderFlowRow = {
  date: string
  pending_order_qty: number
  order_qty: number
  sales_amount: number
}

export interface V2ProjectEntry {
  project_name: string
  summary_rows: V2OrderFlowRow[]
}

export interface V2ProjectOption {
  id: number | null
  name: string
}

export interface V2OrderFlowPanelProps {
  /** 当前区间的日销售行（含 pending_order_qty） */
  currentRows: V2OrderFlowRow[]
  /** 项目分解（按项目各自的 summary_rows） */
  projectBreakdown?: Record<number, V2ProjectEntry>
  /** 项目列表（补全项目名与顺序） */
  projects: V2ProjectOption[]
  /** 数据加载中 */
  loading?: boolean
  /** 当前区间日期窗口（PT 时区 YYYY-MM-DD，与首页 currentRows 对应区间一致） */
  dateFrom: string
  dateTo: string
}

// ======================== 常量 ========================

const STORAGE_KEY = 'bb.dashboard.order-flow.open'
const MAX_PROJECT_ROWS = 5
/** 清空确认按钮自动复位时长（ms） */
const CLEAR_CONFIRM_TIMEOUT_MS = 4_000

// ======================== 工具函数 ========================

function readFlag(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeFlag(value: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0')
  } catch {
    // 静默降级
  }
}

/** PT naive datetime（'YYYY-MM-DD HH:MM:SS'）→ 'MM-DD HH:MM'（面板窄列压缩展示） */
function formatPanelPtDate(pt: string): string {
  const m = pt.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (!m) return pt
  return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`
}

/** 金额：千位分隔 + 两位小数（与 order-info 页 fmtAmount 同口径） */
function fmtPanelAmount(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 从 summary_rows 取最新一条 pending_order_qty（当前 snapshot） */
function latestPending(rows: V2OrderFlowRow[]): number {
  if (rows.length === 0) return 0
  return rows[rows.length - 1]?.pending_order_qty ?? 0
}

// ======================== 组件 ========================

export function V2OrderFlowPanel({
  currentRows,
  projectBreakdown,
  projects,
  loading = false,
  dateFrom,
  dateTo,
}: V2OrderFlowPanelProps) {
  const { data: session } = useSession()
  const { notify } = useNotifications()

  // 桌面展开态（持久化）+ 移动端 Sheet 态（会话级）
  const [open, setOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const panelActive = open || mobileOpen

  // 水合桌面展开状态
  useEffect(() => {
    setOpen(readFlag())
  }, [])

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev
      writeFlag(next)
      return next
    })
  }, [])

  // 项目 id 列表（BEL-422 护栏参数；usePendingOrders / usePendingCount 共用）
  const projectIds = useMemo(
    () => projects.map((p) => p.id).filter((id): id is number => id !== null),
    [projects]
  )

  // —— 实时计数（BLF-928）：面板展开时复用列表 total，收起时用轻量 count 轮询 ——
  const pendingCount = usePendingCount({
    enabled: !panelActive,
    projectIds,
    dateFrom,
    dateTo,
  })

  // 订单级 pending 列表（仅任一面板展开时请求；30s 可见感知轮询首页）
  const pendingOrders = usePendingOrders({
    enabled: panelActive,
    projectIds,
    dateFrom,
    dateTo,
  })

  // 已处理 id 集合（窗口级持久化）——「操作后本地计数/列表即时更新」的关键
  const windowKey = `${projectIds.join(',')}|${dateFrom}|${dateTo}`
  const { processedIds, markProcessed } = useProcessedOrders(windowKey)

  // 今日出单流（仅任一面板展开时轮询）
  const liveStreamItems = useLiveStream(panelActive)

  // 服务端待处理订单数：展开取列表 total，收起取轻量轮询 count
  const serverCount = panelActive ? pendingOrders.total : pendingCount.count
  // 展示计数 = 服务端总数 - 已处理数（本地闭环）
  const liveCount = Math.max(0, serverCount - processedIds.size)
  const countLoading =
    (panelActive ? pendingOrders.loading : pendingCount.loading) && serverCount === 0

  // 已处理订单过滤后的可见列表
  const visibleItems = useMemo(
    () => pendingOrders.items.filter((it) => !processedIds.has(it.id)),
    [pendingOrders.items, processedIds]
  )
  const visibleTotal = Math.max(0, pendingOrders.total - processedIds.size)
  const hasMore = visibleItems.length < visibleTotal

  // 展开/收起时立即刷新两个数据源（各自内部守卫 active 才真正发请求）
  const refreshLive = useCallback(() => {
    pendingOrders.refresh()
    pendingCount.refresh()
  }, [pendingOrders, pendingCount])

  const handleToggle = useCallback(() => {
    toggle()
    refreshLive()
  }, [toggle, refreshLive])

  // 项目 pending 分解（按各项目最新 pending_order_qty 排序取 Top N）
  const projectPendingRows = useMemo(() => {
    if (!projectBreakdown) return []
    const rows: { projectId: number; projectName: string; pending: number }[] = []
    for (const project of projects) {
      if (project.id === null) continue
      const entry = projectBreakdown[project.id]
      if (!entry || !Array.isArray(entry.summary_rows) || entry.summary_rows.length === 0) continue
      const pending = latestPending(entry.summary_rows)
      if (pending <= 0) continue
      rows.push({
        projectId: project.id,
        projectName: entry.project_name || project.name,
        pending,
      })
    }
    return rows.sort((a, b) => b.pending - a.pending).slice(0, MAX_PROJECT_ROWS)
  }, [projectBreakdown, projects])

  // 行点击 → order-info 页预填 Pending 筛选
  const router = useRouter()
  const goToOrderInfo = useCallback(() => {
    router.push('/dashboard/reports/order-info?order_statuses=Pending')
  }, [router])

  // 当前登录用户名（默认填到 updated_by，与 order-info 页 currentUserName 同口径）
  const operatorName = useMemo(() => {
    const u = session?.user
    if (!u) return undefined
    const candidates = [u.operatorNameZh, u.name, u.email]
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim()
    }
    return undefined
  }, [session])

  // —— 标记处理（PATCH，对齐 OrderEditDialog 的 X-Operator 请求头模式）——
  const handleMarkProcessed = useCallback(
    async (orderId: number) => {
      if (!operatorName) {
        notify({ type: 'error', title: '无法识别操作人', message: '请检查登录会话后重试' })
        return
      }
      try {
        const headers = buildBackendClientHeaders(session, { contentType: 'application/json' })
        const response = await fetch(`/api/backend/api/v1/order-info/${orderId}`, {
          method: 'PATCH',
          headers: { ...Object.fromEntries(headers.entries()) },
          body: JSON.stringify({ updated_by: operatorName }),
          cache: 'no-store',
        })
        if (!response.ok) {
          const errPayload = (await response.json().catch(() => null)) as {
            error?: string
            detail?: string
            message?: string
          } | null
          const msg = errPayload?.error || errPayload?.detail || errPayload?.message
          throw new Error(normalizeErrorMessage(msg, '标记处理失败'))
        }
        markProcessed([orderId])
        notify({ type: 'success', title: '已标记处理' })
      } catch (error) {
        notify({
          type: 'error',
          title: '标记处理失败',
          message: normalizeErrorMessage(error, '未知错误'),
        })
      }
    },
    [operatorName, session, notify, markProcessed]
  )

  // —— 清空 pending（本地闭环：批量标记为已处理）——
  const [confirmClear, setConfirmClear] = useState(false)
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    }
  }, [])

  const handleClearPending = useCallback(() => {
    if (!confirmClear) {
      setConfirmClear(true)
      clearTimerRef.current = setTimeout(() => setConfirmClear(false), CLEAR_CONFIRM_TIMEOUT_MS)
      return
    }
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    setConfirmClear(false)
    const ids = visibleItems.map((it) => it.id)
    if (ids.length === 0) return
    markProcessed(ids)
    notify({ type: 'success', title: '已清空 pending', message: `标记 ${ids.length} 单为已处理` })
  }, [confirmClear, visibleItems, markProcessed, notify])

  const bodyProps: OrderFlowPanelBodyProps = {
    pendingCount: liveCount,
    countLoading,
    projectRows: projectPendingRows,
    pendingOrders: {
      items: visibleItems,
      total: visibleTotal,
      loading: pendingOrders.loading,
      loadingMore: pendingOrders.loadingMore,
      error: pendingOrders.error,
      hasMore,
      loadMore: pendingOrders.loadMore,
    },
    liveStreamItems,
    onToggle: handleToggle,
    onMarkProcessed: (orderId: number) => void handleMarkProcessed(orderId),
    onClearPending: handleClearPending,
    confirmClear,
    onCancelClear: () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
      setConfirmClear(false)
    },
    goToOrderInfo,
  }

  return (
    <>
      {/* ========== 桌面（lg+）：折叠窄条 / 展开面板 ========== */}
      <div className="hidden shrink-0 lg:flex">
        {!open ? (
          <button
            type="button"
            onClick={handleToggle}
            title="展开订单流面板"
            aria-label="展开订单流面板"
            className={cn(
              'flex w-11 flex-col items-center justify-center gap-3 border-l border-term-border bg-term-panel',
              'transition-colors hover:bg-term-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-term-accent'
            )}
          >
            <span
              className="text-xs font-semibold uppercase tracking-widest text-term-muted"
              style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}
            >
              订单流
            </span>
            {liveCount > 0 && (
              <span className="flex h-5 min-w-[20px] items-center justify-center rounded-none border border-term-warn/60 px-1 font-mono text-[10px] leading-none text-term-warn">
                {liveCount > 99 ? '99+' : liveCount}
              </span>
            )}
          </button>
        ) : (
          <OrderFlowPanelBody {...bodyProps} />
        )}
      </div>

      {/* ========== 移动端（<lg）：底部折叠条 + Sheet 抽屉 ========== */}
      <div className="lg:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="展开订单流面板（移动端）"
          className={cn(
            'sticky bottom-0 z-20 flex h-10 w-full items-center gap-2 border-t border-term-border bg-term-panel px-3',
            'transition-colors hover:bg-term-hover'
          )}
        >
          <span className="text-xs font-semibold uppercase tracking-widest text-term-muted">
            订单流
          </span>
          {liveCount > 0 && (
            <span className="flex h-5 min-w-[20px] items-center justify-center rounded-none border border-term-warn/60 px-1 font-mono text-[10px] leading-none text-term-warn">
              {liveCount > 99 ? '99+' : liveCount}
            </span>
          )}
          <span className="flex-1" />
          <span className="text-xs text-term-faint">待处理订单</span>
          <ChevronUp className="h-4 w-4 text-term-faint" strokeWidth={1.75} />
        </button>

        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent
            side="right"
            className="flex w-[min(340px,92vw)] flex-col rounded-none border-term-border bg-term-panel p-0 text-term-text"
          >
            <OrderFlowPanelBody {...bodyProps} onToggle={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>
      </div>
    </>
  )
}

// ======================== 面板展开态内容（桌面 aside / 移动 Sheet 共用） ========================

interface OrderFlowPanelBodyProps {
  /** 展示计数（服务端 pending - 已处理） */
  pendingCount: number
  countLoading: boolean
  /** 项目 pending 分解（来自 daily-analysis snapshot） */
  projectRows: { projectId: number; projectName: string; pending: number }[]
  pendingOrders: {
    items: PendingOrderItem[]
    total: number
    loading: boolean
    loadingMore: boolean
    error: string | null
    hasMore: boolean
    loadMore: () => void
  }
  liveStreamItems: LiveStreamItem[]
  /** 收起（桌面 aside → toggle；移动 Sheet → 关抽屉） */
  onToggle: () => void
  onMarkProcessed: (orderId: number) => void
  onClearPending: () => void
  confirmClear: boolean
  onCancelClear: () => void
  goToOrderInfo: () => void
}

function OrderFlowPanelBody({
  pendingCount,
  countLoading,
  projectRows,
  pendingOrders,
  liveStreamItems,
  onToggle,
  onMarkProcessed,
  onClearPending,
  confirmClear,
  onCancelClear,
  goToOrderInfo,
}: OrderFlowPanelBodyProps) {
  return (
    <aside className="flex w-[320px] flex-col border-l border-term-border bg-term-panel">
      {/* 头部 */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-term-border pl-3 pr-1">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold uppercase tracking-wider text-term-muted">
          订单流 · 待处理
        </span>
        {pendingCount > 0 && (
          <span className="flex h-5 min-w-[20px] items-center justify-center border border-term-warn/60 px-1 font-mono text-[10px] leading-none text-term-warn">
            {pendingCount > 99 ? '99+' : pendingCount}
          </span>
        )}
        <button
          type="button"
          onClick={onToggle}
          title="收起"
          aria-label="收起订单流面板"
          className="flex h-9 w-9 items-center justify-center rounded-none text-term-faint shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent"
        >
          <X className="h-5 w-5" strokeWidth={1.75} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto term-scroll">
        {/* 待处理摘要 */}
        <section className="border-b border-term-border p-3">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold tabular-nums text-term-warn">
              {countLoading ? '\u2014\u2014' : pendingCount}
            </span>
            <span className="text-xs text-term-muted">单待处理</span>
          </div>
          {countLoading && <Skeleton className="mt-2 h-3 w-32" />}
        </section>

        {/* 项目分解 */}
        {projectRows.length > 0 && (
          <section className="border-b border-term-border p-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-term-faint">
              待处理项目
            </h3>
            <div className="flex flex-col gap-1">
              {projectRows.map((row) => (
                <div
                  key={row.projectId}
                  className="flex items-center justify-between gap-2 py-1"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-term-text">
                    {row.projectName}
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-term-warn">
                    {row.pending}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 订单级 pending 列表（TermTable Pattern A 高密度表，窄宽裁剪列） */}
        <section className="border-b border-term-border" data-testid="order-flow-pending-list">
          <div className="flex items-center gap-1 px-3 pb-2 pt-3">
            <h3 className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wider text-term-faint">
              待处理订单
            </h3>
            {pendingOrders.total > 0 && (
              <button
                type="button"
                onClick={onClearPending}
                aria-label="清空 pending 待处理订单"
                data-testid="order-flow-clear-pending"
                className={cn(
                  'shrink-0 font-mono text-[10px] leading-none transition-colors',
                  confirmClear
                    ? 'border border-term-warn/60 px-1.5 py-1 text-term-warn'
                    : 'px-1.5 py-1 text-term-muted hover:text-term-text'
                )}
              >
                {confirmClear ? `确认清空 ${pendingOrders.total} 单？` : '清空 pending'}
              </button>
            )}
          </div>
          {pendingOrders.loading && pendingOrders.items.length === 0 ? (
            <div aria-busy="true" className="space-y-1.5 px-3 pb-3" role="status" aria-label="待处理订单加载中">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-6 w-full animate-pulse bg-term-hover"
                  style={{ opacity: 1 - i * 0.25 }}
                />
              ))}
            </div>
          ) : pendingOrders.error ? (
            <p className="px-3 pb-3 font-mono text-xs text-term-neg">
              ERR · {pendingOrders.error}
            </p>
          ) : pendingOrders.items.length === 0 ? (
            <p className="px-3 pb-3 text-xs text-term-faint" data-testid="order-flow-pending-empty">
              当前区间暂无待处理订单
            </p>
          ) : (
            <TermTable aria-label="待处理订单列表">
              <TermBody>
                {pendingOrders.items.map((item) => (
                  <TermRow
                    key={item.id}
                    onClick={goToOrderInfo}
                    aria-label={`待处理订单 ${item.amazon_order_id} · ${item.sku ?? '—'} · ${getOrderStatusLabel(item.order_status)}`}
                  >
                    <TermCell className="max-w-0 px-2 py-1.5">
                      <div className="flex flex-col leading-tight">
                        <span className="truncate" title={item.sku ?? undefined}>
                          {item.sku ?? '—'}
                        </span>
                        <span
                          className="truncate text-term-faint"
                          title={`${item.country} · ${formatPanelPtDate(item.purchase_at_pt)}`}
                        >
                          {item.country} · {formatPanelPtDate(item.purchase_at_pt)}
                        </span>
                      </div>
                    </TermCell>
                    <TermCell numeric className="px-2 py-1.5">
                      <div className="flex flex-col items-end leading-tight">
                        <span className="tabular-nums">
                          {fmtPanelAmount(item.item_price + item.shipping_price)}{' '}
                          {item.currency ?? ''}
                        </span>
                        <span
                          className={cn(
                            'font-mono text-[10px] leading-none',
                            ORDER_STATUS_TONE_PILL_CLASS[getOrderStatusTone(item.order_status)]
                          )}
                        >
                          ×{item.quantity} · {getOrderStatusLabel(item.order_status)}
                        </span>
                      </div>
                    </TermCell>
                    <TermCell className="px-1 py-1.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onMarkProcessed(item.id)
                        }}
                        title="标记为已处理（记录操作人，本面板内移除）"
                        aria-label={`标记订单 ${item.amazon_order_id} 为已处理`}
                        className="inline-flex h-5 items-center gap-0.5 border border-term-border px-1 font-mono text-[10px] text-term-accent transition-colors hover:border-term-accent hover:text-term-accent"
                      >
                        <Check className="h-3 w-3" strokeWidth={2} />
                        处理
                      </button>
                    </TermCell>
                  </TermRow>
                ))}
              </TermBody>
            </TermTable>
          )}
          {pendingOrders.hasMore && pendingOrders.items.length > 0 && (
            <div className="p-1.5">
              <button
                type="button"
                onClick={pendingOrders.loadMore}
                disabled={pendingOrders.loadingMore}
                className="flex h-7 w-full items-center justify-center border border-term-border bg-term-bg font-mono text-xs text-term-muted transition-colors hover:border-term-border-strong hover:text-term-text disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="加载更多待处理订单"
                data-testid="order-flow-pending-more"
              >
                {pendingOrders.loadingMore
                  ? '加载中…'
                  : `加载更多（${pendingOrders.items.length}/${pendingOrders.total}）`}
              </button>
            </div>
          )}
        </section>

        {/* 今日出单 */}
        <section className="border-b border-term-border p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-term-faint">
            今日出单
          </h3>
          {liveStreamItems.length === 0 ? (
            <div aria-busy="true" data-testid="order-stream-empty">
              <p className="text-sm text-term-faint">暂无今日出单事件</p>
              <p className="pb-1 text-xs text-term-faint/70">同步中…</p>
              <div className="mt-1 space-y-1.5" role="status" aria-label="同步中">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="h-8 w-full animate-pulse bg-term-hover"
                    style={{ opacity: 1 - i * 0.25 }}
                  />
                ))}
              </div>
            </div>
          ) : (
            <ul className="flex flex-col">
              {liveStreamItems.map((item) => (
                <li
                  key={item.id}
                  className="flex items-baseline justify-between gap-2 py-1.5 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate text-term-text">
                    {item.title}
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-term-faint">
                    {item.timeLabel}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* 底部链接 */}
      <div className="border-t border-term-border">
        <Link
          href="/dashboard/reports/order-info"
          className="flex h-10 items-center gap-1 px-3 text-xs text-term-muted transition-colors hover:bg-term-hover hover:text-term-text"
        >
          <span className="min-w-0 flex-1">查看完整订单信息</span>
          <ExternalLink className="h-4 w-4 shrink-0" strokeWidth={1.5} />
        </Link>
      </div>
    </aside>
  )
}
