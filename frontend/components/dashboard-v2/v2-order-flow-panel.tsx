'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ChevronDown, ChevronRight, ChevronUp, ExternalLink, X } from 'lucide-react'

import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { useLiveStream } from '@/components/terminal/use-live-stream'
import { TermBody, TermCell, TermRow, TermTable } from '@/components/terminal/term-table'
import {
  usePendingOrders,
  type PendingOrderItem,
} from '@/components/dashboard-v2/use-pending-orders'
import { usePendingCount } from '@/components/dashboard-v2/use-pending-count'
import { getOrderStatusLabel, getOrderStatusTone, ORDER_STATUS_TONE_PILL_CLASS } from '@/lib/order-status'
import type { LiveStreamItem } from '@/components/terminal/terminal-inspector'
import { cn } from '@/lib/utils'

/**
 * BLF-939：Dashboard 首页右侧订单流面板重构。
 *
 * - 纯展示：去掉「处理」按钮与「清空 pending」入口（点 1）。
 * - 按项目聚合：待处理项目与待处理订单合并为一个模块，项目可展开/折叠（点 2）。
 * - 完整信息：OrderID / SKU / 数量 / 金额 / 状态 / 国家 / 时间，多行小字排列（点 3）。
 * - 点击行跳转 order-info 并携带参数（点 4b）。
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

  // 今日出单流（仅任一面板展开时轮询）
  const liveStreamItems = useLiveStream(panelActive)

  // 服务端待处理订单数：展开取列表 total，收起取轻量轮询 count
  const serverCount = panelActive ? pendingOrders.total : pendingCount.count
  const countLoading =
    (panelActive ? pendingOrders.loading : pendingCount.loading) && serverCount === 0

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

  // 行点击 → order-info 页预填 Pending 筛选 + 项目 + 日期
  const router = useRouter()
  const goToOrderInfo = useCallback(
    (projectId?: number) => {
      const params = new URLSearchParams()
      params.set('order_statuses', 'Pending')
      if (projectId) params.set('project_id', String(projectId))
      params.set('date_from', dateFrom)
      params.set('date_to', dateTo)
      router.push(`/dashboard/reports/order-info?${params.toString()}`)
    },
    [router, dateFrom, dateTo]
  )

  const bodyProps: OrderFlowPanelBodyProps = {
    pendingCount: serverCount,
    countLoading,
    projectRows: projectPendingRows,
    pendingOrders: {
      items: pendingOrders.items,
      total: pendingOrders.total,
      loading: pendingOrders.loading,
      loadingMore: pendingOrders.loadingMore,
      error: pendingOrders.error,
      hasMore: pendingOrders.hasMore,
      loadMore: pendingOrders.loadMore,
    },
    liveStreamItems,
    onToggle: handleToggle,
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
            {serverCount > 0 && (
              <span className="flex h-5 min-w-[20px] items-center justify-center rounded-none border border-term-warn/60 px-1 font-mono text-[10px] leading-none text-term-warn">
                {serverCount > 99 ? '99+' : serverCount}
              </span>
            )}
          </button>
        ) : (
          <OrderFlowPanelBody {...bodyProps} />
        )}
      </div>

      {/* ========== 移动端（<lg）：底部固定条 + Sheet 抽屉 ==========
       * BLF-999：脱离桌面 flex 行——之前作为 flex 子项挤占一半横向空间（内容被压到左半屏），
       * 且 sticky 挂在矮包含块上无法贴底。改为 fixed 全宽贴视口底，内容区让出底栏高度。 */}
      <div className="fixed inset-x-0 bottom-0 z-20 lg:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="展开订单流面板（移动端）"
          className={cn(
            'flex h-11 w-full items-center gap-2 border-t border-term-border bg-term-panel px-3',
            'transition-colors hover:bg-term-hover active:bg-term-hover'
          )}
        >
          <span className="text-xs font-semibold uppercase tracking-widest text-term-muted">
            订单流
          </span>
          {serverCount > 0 && (
            <span className="flex h-5 min-w-[20px] items-center justify-center rounded-none border border-term-warn/60 px-1 font-mono text-[10px] leading-none text-term-warn">
              {serverCount > 99 ? '99+' : serverCount}
            </span>
          )}
          <span className="flex-1" />
          <span className="text-xs text-term-faint">待处理订单</span>
          <ChevronUp className="h-4 w-4 text-term-faint" strokeWidth={1.75} />
        </button>
      </div>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="right"
          className="flex w-[min(340px,92vw)] flex-col rounded-none border-term-border bg-term-panel p-0 text-term-text"
        >
          <OrderFlowPanelBody {...bodyProps} onToggle={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  )
}

// ======================== 面板展开态内容（桌面 aside / 移动 Sheet 共用） ========================

interface OrderFlowPanelBodyProps {
  /** 展示计数（服务端 pending） */
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
  goToOrderInfo: (projectId?: number) => void
}

function OrderFlowPanelBody({
  pendingCount,
  countLoading,
  projectRows,
  pendingOrders,
  liveStreamItems,
  onToggle,
  goToOrderInfo,
}: OrderFlowPanelBodyProps) {
  // 按项目展开折叠状态
  const [expandedProjects, setExpandedProjects] = useState<Set<number>>(new Set())
  const toggleProject = useCallback((projectId: number) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }, [])

  // 按项目维度聚合（BLF-939）：项目行头以 projectBreakdown（daily-analysis pending 数）为权威
  // 「统计数字」；展开后展示该项目的已加载 pending 订单（pendingOrders.items 按 project_id 分组）。
  // 项目行顺序 = projectRows（breakdown pending 降序）；有已加载订单但不在 breakdown 的项目补在后面。
  const projectGroups = useMemo(() => {
    const byId = new Map<number, { projectName: string; items: PendingOrderItem[] }>()
    for (const item of pendingOrders.items) {
      const existing = byId.get(item.project_id)
      if (existing) {
        existing.items.push(item)
      } else {
        byId.set(item.project_id, { projectName: item.project_name, items: [item] })
      }
    }
    const ordered: {
      projectId: number
      projectName: string
      pending: number
      items: PendingOrderItem[]
    }[] = []
    const seen = new Set<number>()
    // 1) breakdown 项目行头（统计数字 = pending 数，排序已在 projectRows 完成）
    for (const pr of projectRows) {
      seen.add(pr.projectId)
      const group = byId.get(pr.projectId)
      ordered.push({
        projectId: pr.projectId,
        projectName: pr.projectName,
        pending: pr.pending,
        items: group?.items ?? [],
      })
    }
    // 2) 有已加载订单但不在 breakdown 里的项目（如 pending_order_qty 尚未快照），按项目名排序补尾
    const extra: {
      projectId: number
      projectName: string
      pending: number
      items: PendingOrderItem[]
    }[] = []
    for (const [projectId, group] of byId) {
      if (seen.has(projectId)) continue
      extra.push({
        projectId,
        projectName: group.projectName,
        pending: group.items.length,
        items: group.items,
      })
    }
    extra.sort((a, b) => a.projectName.localeCompare(b.projectName))
    return [...ordered, ...extra]
  }, [projectRows, pendingOrders.items])

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

        {/* ====== BLF-939：合并待处理项目 + 待处理订单，按项目维度聚合 ====== */}
        <section className="border-b border-term-border" data-testid="order-flow-pending-grouped">
          {/* 项目/订单合并标题 */}
          <div className="flex items-center gap-1 px-3 pb-2 pt-3">
            <h3 className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wider text-term-faint">
              待处理订单
            </h3>
            {pendingOrders.total > 0 && (
              <span className="shrink-0 font-mono text-[10px] text-term-faint">
                {pendingOrders.items.length}/{pendingOrders.total}
              </span>
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
          ) : projectGroups.length === 0 ? (
            <p className="px-3 pb-3 text-xs text-term-faint" data-testid="order-flow-pending-empty">
              当前区间暂无待处理订单
            </p>
          ) : (
            <div className="flex flex-col" data-testid="order-flow-pending-grouped-items">
              {projectGroups.map((group) => {
                const isExpanded = expandedProjects.has(group.projectId)
                return (
                  <div key={group.projectId} className="border-b border-term-border last:border-b-0">
                    {/* 项目行头（可点击展开/折叠） */}
                    <button
                      type="button"
                      onClick={() => toggleProject(group.projectId)}
                      className="flex h-8 w-full items-center gap-1 px-3 text-left transition-colors hover:bg-term-hover"
                      aria-expanded={isExpanded}
                      aria-label={`${group.projectName} · ${group.pending} 单待处理`}
                    >
                      <span className="shrink-0 text-term-faint">
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-term-text">
                        {group.projectName}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-term-warn">
                        {group.pending}
                      </span>
                    </button>

                    {/* 展开态：订单列表 */}
                    {isExpanded && (
                      <div className="border-t border-term-border/50">
                        {group.items.length === 0 ? (
                          <p className="px-3 py-2 text-[10px] text-term-faint">
                            暂无该项目的待处理订单明细
                          </p>
                        ) : (
                          <TermTable aria-label={`${group.projectName} 待处理订单列表`}>
                            <TermBody>
                              {group.items.map((item) => (
                                <TermRow
                                  key={item.id}
                                  onClick={() => goToOrderInfo(group.projectId)}
                                  aria-label={`待处理订单 ${item.amazon_order_id} · ${item.sku ?? '—'} · ${getOrderStatusLabel(item.order_status)}`}
                                >
                                  <TermCell className="max-w-0 px-2.5 py-2">
                                    {/* BLF-999：手机端可读性重排——三行结构 + 档内最小字号 10px 起步，
                                     之前两行塞 7 字段（9px 字号）在 340px 抽屉里近乎不可读 */}
                                    <div className="flex flex-col gap-1 leading-tight">
                                      {/* 第一行：OrderID（主标识，mono 11px） */}
                                      <span
                                        className="truncate font-mono text-[11px] text-term-text"
                                        title={item.amazon_order_id}
                                      >
                                        {item.amazon_order_id}
                                      </span>
                                      {/* 第二行：SKU · 数量 · 金额 · 状态 */}
                                      <span className="flex min-w-0 items-center gap-1.5 truncate text-[10px]">
                                        <span className="truncate text-term-muted" title={item.sku ?? undefined}>
                                          {item.sku ?? '—'}
                                        </span>
                                        <span className="shrink-0 font-mono text-term-faint">×{item.quantity}</span>
                                        <span className="shrink-0 font-mono tabular-nums text-term-text">
                                          {fmtPanelAmount(item.item_price + item.shipping_price)}{' '}
                                          {item.currency ?? ''}
                                        </span>
                                        <span
                                          className={cn(
                                            'shrink-0 border px-1 leading-4',
                                            ORDER_STATUS_TONE_PILL_CLASS[
                                              getOrderStatusTone(item.order_status)
                                            ]
                                          )}
                                        >
                                          {getOrderStatusLabel(item.order_status)}
                                        </span>
                                      </span>
                                      {/* 第三行：国家 · 时间 */}
                                      <span className="flex items-center gap-1.5 text-[10px] text-term-faint">
                                        <span className="shrink-0">{item.country}</span>
                                        <span className="shrink-0 font-mono tabular-nums">
                                          {formatPanelPtDate(item.purchase_at_pt)}
                                        </span>
                                      </span>
                                    </div>
                                  </TermCell>
                                </TermRow>
                              ))}
                            </TermBody>
                          </TermTable>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {/* 加载更多 */}
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
          {/* BLF-999：空态收口——之前 3 块 h-8 骨架 + 两行文案，手机端占位近 100px 且长期停留 */}
          {liveStreamItems.length === 0 ? (
            <div aria-busy="true" data-testid="order-stream-empty">
              <p className="text-xs text-term-faint">暂无今日出单事件</p>
              <div className="mt-1.5 space-y-1" role="status" aria-label="同步中">
                {[0, 1].map((i) => (
                  <div
                    key={i}
                    className="h-4 w-full animate-pulse bg-term-hover"
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