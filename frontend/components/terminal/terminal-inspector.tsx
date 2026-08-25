'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { History, X } from 'lucide-react'

import { RouteLoadingLink } from '@/components/dashboard/route-loading-link'
import {
  TERMINAL_INSPECTOR_WIDTH,
  readRecents,
  type RecentPageEntry,
} from '@/components/terminal/terminal-constants'

/** 快捷操作：高频模块直达（后续 stage 可按模块形态切换为实时出单流 / AI 助手） */
const QUICK_ACTIONS = [
  { title: '销售数据', url: '/dashboard/operations/daily-analysis' },
  { title: '订单信息', url: '/dashboard/reports/order-info' },
  { title: 'SKU 信息', url: '/dashboard/operations/sku-info' },
  { title: '库存分类账', url: '/dashboard/operations/inventory-ledger' },
  { title: '汇率信息', url: '/dashboard/finance/exchange-rate' },
  { title: '数据库状态', url: '/dashboard/system/data-management' },
] as const

interface TerminalInspectorProps {
  open: boolean
  onClose: () => void
}

/**
 * Right Inspector 上下文面板（360px，BLF-809；二档放大 2026-08-25）：Cmd/Ctrl+B 或 Header 按钮开关。
 * 本期承载快捷入口 + 最近访问；实时出单流 / AI 助手等内容形态留待后续 stage。
 */
export function TerminalInspector({ open, onClose }: TerminalInspectorProps) {
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
      className="hidden h-full shrink-0 flex-col border-l border-term-border bg-term-panel lg:flex"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-term-border pl-3 pr-1">
        <span className="min-w-0 flex-1 text-sm font-semibold uppercase tracking-wider text-term-muted">
          Inspector
        </span>
        <button
          type="button"
          onClick={onClose}
          title="收起 (⌘B)"
          aria-label="收起 Inspector"
          className="flex h-8 w-8 items-center justify-center text-term-faint transition-colors hover:bg-term-hover hover:text-term-text"
        >
          <X className="h-[18px] w-[18px]" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto term-scroll">
        <section className="border-b border-term-border p-2">
          <h3 className="px-1 pb-1.5 text-sm uppercase tracking-wider text-term-faint">
            快捷操作
          </h3>
          <div className="grid grid-cols-2 gap-px bg-term-border">
            {QUICK_ACTIONS.map((action) => (
              <RouteLoadingLink
                key={action.url}
                href={action.url}
                className="flex h-10 items-center bg-term-panel px-2 text-sm text-term-muted transition-colors hover:bg-term-hover hover:text-term-text"
              >
                <span className="truncate">{action.title}</span>
              </RouteLoadingLink>
            ))}
          </div>
        </section>

        <section className="p-2">
          <h3 className="flex items-center gap-1 px-1 pb-1.5 text-sm uppercase tracking-wider text-term-faint">
            <History className="h-4 w-4" /> 最近访问
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
