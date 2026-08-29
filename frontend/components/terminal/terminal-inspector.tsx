'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { History, X } from 'lucide-react'

import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import {
  TERMINAL_INSPECTOR_WIDTH,
  TERMINAL_TOP_STRIP_HEIGHT,
  readRecents,
  type RecentPageEntry,
} from '@/components/terminal/terminal-constants'

/** 快捷操作：高频模块直达 */
const QUICK_ACTIONS = [
  { title: '销售数据', url: '/dashboard/operations/daily-analysis' },
  { title: '订单信息', url: '/dashboard/reports/order-info' },
  { title: 'SKU 信息', url: '/dashboard/operations/sku-info' },
  { title: '库存分类账', url: '/dashboard/operations/inventory-ledger' },
  { title: '汇率信息', url: '/dashboard/finance/exchange-rate' },
  { title: '数据库状态', url: '/dashboard/system/data-management' },
] as const

/**
 * Live Stream 单条事件（BLF-839）：后端「今日出单流」端点就绪前 items 恒为空，
 * 渲染空态 + 「同步中」骨架；接入时由 shell/页面层传入真实数据。
 */
export interface LiveStreamItem {
  /** 唯一键（如订单号或事件 id） */
  id: string
  /** 展示标题（订单摘要） */
  title: string
  /** 相对时间文案（由调用方格式化，Inspector 不持有时钟） */
  timeLabel: string
}

interface TerminalInspectorProps {
  open: boolean
  onClose: () => void
  /** 今日出单流事件列表；缺省/空数组均渲染空态 + 同步中骨架 */
  liveStreamItems?: LiveStreamItem[]
}

/**
 * Right Inspector 上下文面板（360px 宽度不变；BLF-887 高度上档 2026-08-29）：Cmd/Ctrl+B 或 Header 按钮开关。
 * 本期承载快捷入口 + 最近访问 + Live Stream 数据源插槽（BLF-839：后端端点就绪前空态占位）。
 */
export function TerminalInspector({ open, onClose, liveStreamItems }: TerminalInspectorProps) {
  const pathname = usePathname()
  const [recents, setRecents] = React.useState<RecentPageEntry[]>([])

  // recents 由 shell 在路由变化时写入 localStorage；挂载与路由变化时同步到本地状态
  React.useEffect(() => {
    setRecents(readRecents())
  }, [pathname])

  if (!open) return null

  return (
    <aside
      style={{ width: TERMINAL_INSPECTOR_WIDTH }}
      data-testid="terminal-inspector"
      className="hidden h-full shrink-0 flex-col rounded-none border-l border-term-border bg-term-panel shadow-none lg:flex"
    >
      <div
        className="flex shrink-0 items-center gap-1 border-b border-term-border pl-3 pr-1"
        style={{ height: TERMINAL_TOP_STRIP_HEIGHT }}
      >
        <span className="min-w-0 flex-1 text-sm font-semibold uppercase tracking-wider text-term-muted">
          Inspector
        </span>
        <button
          type="button"
          onClick={onClose}
          title="收起 (⌘B)"
          aria-label="收起 Inspector"
          className="flex h-9 w-9 items-center justify-center rounded-none text-term-faint shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent"
        >
          <X className="h-5 w-5" strokeWidth={1.75} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto term-scroll">
        <section className="border-b border-term-border p-2">
          <h3 className="flex items-center gap-1 px-1 pb-1.5 text-sm font-semibold uppercase tracking-wider text-term-faint">
            Live Stream · 今日出单
          </h3>
          {liveStreamItems === undefined || liveStreamItems.length === 0 ? (
            <div aria-busy="true" data-testid="live-stream-empty">
              <p className="px-1 pt-1 text-sm text-term-faint">暂无今日出单事件</p>
              <p className="px-1 pb-1.5 text-xs text-term-faint/70">同步中…</p>
              <div className="mt-1 space-y-1.5" role="status" aria-label="同步中">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="h-9 w-full animate-pulse bg-term-hover"
                    style={{ opacity: 1 - i * 0.25 }}
                  />
                ))}
              </div>
            </div>
          ) : (
            <ul className="px-1 py-1">
              {liveStreamItems.map((item) => (
                <li key={item.id} className="flex items-baseline justify-between gap-2 py-1 text-sm">
                  <span className="min-w-0 truncate text-term-text">{item.title}</span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-term-faint">{item.timeLabel}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="border-b border-term-border p-2">
          <h3 className="flex items-center gap-1 px-1 pb-1.5 text-sm font-semibold uppercase tracking-wider text-term-faint">
            快捷操作
          </h3>
          <div className="grid grid-cols-2 gap-px bg-term-border">
            {QUICK_ACTIONS.map((action) => (
              <RouteLoadingLink
                key={action.url}
                href={action.url}
                className="flex h-10 items-center rounded-none bg-term-panel px-2 text-sm leading-5 text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent"
              >
                <span className="truncate">{action.title}</span>
              </RouteLoadingLink>
            ))}
          </div>
        </section>

        <section className="p-2">
          <h3 className="flex items-center gap-1 px-1 pb-1.5 text-sm font-semibold uppercase tracking-wider text-term-faint">
            <History className="h-5 w-5" strokeWidth={1.75} /> 最近访问
          </h3>
          {recents.length === 0 ? (
            <p className="px-1 py-2 text-sm text-term-faint">暂无记录</p>
          ) : (
            <div className="flex flex-col">
              {recents.map((entry) => {
                const isActive = entry.path === pathname
                return (
                  <RouteLoadingLink
                    key={entry.path}
                    href={entry.path}
                    className={`truncate px-1 py-2 text-sm transition-colors hover:text-term-text ${
                      isActive ? 'text-term-text' : 'text-term-muted'
                    }`}
                  >
                    {entry.title}
                  </RouteLoadingLink>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}
