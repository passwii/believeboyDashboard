'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, X } from 'lucide-react'

import { Skeleton } from '@/components/ui/skeleton'
import { useLiveStream } from '@/components/terminal/use-live-stream'
import { cn } from '@/lib/utils'

/**
 * BLF-926：Dashboard 首页右侧新订单流面板。
 *
 * 桌面（lg+）显示，默认折叠为窄条（w-11），点击展开为 w-[320px] 面板。
 * 折叠状态持久化 localStorage（key: `bb.dashboard.order-flow-open`）。
 * 移动端隐藏（与 Inspector 同规则，`hidden lg:flex`）。
 *
 * ## Stage 1 数据源
 * - Pending 件数：复用首页已加载的 `currentRows`（`pending_order_qty`），零额外请求。
 * - 项目分解：复用首页 `projectBreakdown`，按项目最新 pending_order_qty 排序取 Top 5。
 * - 今日出单流：复用 `useLiveStream` hook（仅面板展开时轮询，30s 间隔）。
 *
 * ## Stage 2（规划）
 * - 调用 `order-info/overview?order_statuses=Pending` 获取订单级 pending 列表
 * - 状态 pill（语义色：warn = 待处理）
 * - 链接到 order-info 页面预填 Pending 筛选
 *
 * ## Stage 3（规划）
 * - 实时刷新（页面可见性 + 轮询 pending 计数）
 * - 操作闭环（标记处理）
 * - 移动端 sheet 适配
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
}

// ======================== 常量 ========================

const STORAGE_KEY = 'bb.dashboard.order-flow-open'
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
}: V2OrderFlowPanelProps) {
  const [open, setOpen] = useState(false)

  // 水合 localStorage 状态
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

  // 最新 pending 件数（currentRows 最后一天的 snapshot）
  const pendingCount = useMemo(() => {
    if (currentRows.length === 0) return 0
    return latestPending(currentRows)
  }, [currentRows])

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

  // 今日出单流（仅面板展开时轮询；展开后才传 true，收起即停）
  const liveStreamItems = useLiveStream(open)

  // ========== 折叠态：窄条 ==========

  if (!open) {
    return (
      <div className="hidden shrink-0 lg:flex">
        <button
          type="button"
          onClick={toggle}
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
          {pendingCount > 0 && (
            <span className="flex h-5 min-w-[20px] items-center justify-center rounded-none border border-term-warn/60 px-1 font-mono text-[10px] leading-none text-term-warn">
              {pendingCount > 99 ? '99+' : pendingCount}
            </span>
          )}
        </button>
      </div>
    )
  }

  // ========== 展开态：面板 ==========

  return (
    <div className="hidden shrink-0 lg:flex">
      <aside
        className="flex w-[320px] flex-col border-l border-term-border bg-term-panel"
      >
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
            onClick={toggle}
            title="收起 (默认折叠)"
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
                {loading && currentRows.length === 0 ? '\u2014\u2014' : pendingCount}
              </span>
              <span className="text-xs text-term-muted">件待处理</span>
            </div>
            {loading && currentRows.length === 0 && (
              <Skeleton className="mt-2 h-3 w-32" />
            )}
          </section>

          {/* 项目分解 */}
          {projectPendingRows.length > 0 && (
            <section className="border-b border-term-border p-3">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-term-faint">
                待处理项目
              </h3>
              <div className="flex flex-col gap-1">
                {projectPendingRows.map((row) => (
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

          {/* 今日出单流 */}
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
    </div>
  )
}