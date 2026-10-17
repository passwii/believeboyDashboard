'use client'

import type * as React from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'

/**
 * BLF-818 · Pattern B 双轴分析画布 —— 广告分析页共用终端 chrome。
 *
 * 与 BLF-817 Pattern A（订单大表）同源：term-* 色板、1px 边界、零阴影零圆角、
 * font-mono + tabular-nums 等宽数值、涨跌微语义色（pos/warn/neg）。
 */

/** 全局加载/错误条：工具条下方 24px 通道，不挤压内容区高度。 */
export function TermErrorBar({ message }: { message?: string | null }) {
  if (!message) return null
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-2 border border-term-neg/50 bg-term-neg/10 px-2 py-1 font-mono text-xs text-term-neg"
    >
      <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate" title={message}>
        ERR · {message}
      </span>
    </div>
  )
}

/** Keep an already-rendered analysis visible while a Header-triggered refresh runs. */
export function TermRefreshStatus({
  loading,
  error,
  hasData,
}: {
  loading: boolean
  error?: string | null
  hasData: boolean
}) {
  if (!loading && !error) return null

  return (
    <div className="flex shrink-0 flex-col gap-1">
      {loading ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 border border-term-border bg-term-panel px-2 py-1 font-mono text-xs text-term-muted"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          正在刷新广告分析数据…
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="flex items-center gap-2 border border-term-neg/50 bg-term-neg/10 px-2 py-1 font-mono text-xs text-term-neg"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate" title={error}>
            ERR · {error}{hasData ? ' · 已保留上次成功结果' : ''}
          </span>
        </div>
      ) : null}
    </div>
  )
}

/**
 * KPI 等宽磁贴（BLF-818 范围 3）：
 * 花费/销售额/ACoS/ROAS 等指标卡统一为终端磁贴 ——
 * h-6 标题行（11px mono muted）+ 数值行（mono tabular-nums 右对齐语义色），
 * helper 说明收进 title 提示；同比环比变化带 pos/neg 着色箭头。
 */
export function TermMetricTile({
  label,
  value,
  changeRatio,
  helper,
}: {
  label: string
  value: string
  /** 同比/环比变化比率（0.12 = +12%），null 表示无对比数据 */
  changeRatio?: number | null
  helper?: string | null
}) {
  const hasChange = typeof changeRatio === 'number' && Number.isFinite(changeRatio)
  const positive = hasChange && (changeRatio as number) >= 0
  return (
    <div
      className="min-w-0 border border-term-border bg-term-panel px-2 py-1.5"
      title={helper || undefined}
    >
      <div className="flex h-4 items-center justify-between gap-1">
        <span className="truncate text-xs uppercase tracking-wider text-term-muted">
          {label}
        </span>
        {hasChange ? (
          <span
            className={cn(
              'shrink-0 font-mono text-xs tabular-nums',
              positive ? 'text-term-pos' : 'text-term-neg'
            )}
          >
            {positive ? '▲' : '▼'}
            {Math.abs(changeRatio as number).toFixed(2)}%
          </span>
        ) : (
          <span className="shrink-0 font-mono text-xs text-term-faint">—</span>
        )}
      </div>
      <div className="truncate pt-0.5 font-mono text-base leading-6 tabular-nums text-term-text" title={value}>
        {value}
      </div>
    </div>
  )
}

/**
 * 图表面板（BLF-818 范围 1）：1px 边框无阴影，标题条 28px，
 * 图表容器 flex-1 自适应（父级给固定比例高度，内部 ResponsiveContainer 撑满）。
 */
export function TermChartPanel({
  title,
  actions,
  children,
  className,
}: {
  title: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={cn('flex min-w-0 min-h-0 flex-col border border-term-border bg-term-panel', className)}
      aria-label={title}
    >
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-term-border pl-2 pr-1.5">
        <h2 className="truncate font-mono text-xs font-semibold uppercase tracking-wider text-term-muted">
          {title}
        </h2>
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </header>
      <div className="min-h-0 flex-1 p-1">{children}</div>
    </section>
  )
}

/**
 * 数据网格面板标题条（下部子 Tab 数据区共用）：与图表面板同规格但无内边距，
 * body 由调用方接管（TermTable 独立滚动区）。
 */
export function TermGridHeader({
  title,
  meta,
  actions,
}: {
  title: string
  meta?: string
  actions?: React.ReactNode
}) {
  return (
    <header className="flex h-7 shrink-0 items-center gap-2 border-b border-term-border pl-2 pr-1.5">
      <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-term-muted">
        {title}
      </h2>
      {meta && (
        <span className="font-mono text-xs tabular-nums text-term-faint">{meta}</span>
      )}
      {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
    </header>
  )
}
