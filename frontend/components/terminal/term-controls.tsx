import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * BLF-838 · 批次 F（系统/AI/工具域）终端化共享原语。
 * 控件基类与 BLF-817/836/837 的 term-shared 同规格：h-8 工具行档 /
 * 零圆角 / 1px term 边界 / 等宽数值。
 *
 * 本批次为全站收官批，原语上收到 `components/terminal/`，供三域页面共用；
 * 后续新页面一律从这里取控件基类，不再各域复制。
 */

export const TERM_TRIGGER =
  'h-8 rounded-none border border-term-border bg-term-bg text-xs leading-5 text-term-text shadow-none focus-visible:outline-none focus-visible:border-term-border-strong data-[state=open]:border-term-border-strong'
export const TERM_SELECT_ITEM = 'rounded-none text-xs leading-5 focus:bg-term-hover focus:text-term-text'
export const TERM_INPUT =
  'h-8 rounded-none border border-term-border bg-term-bg font-mono text-sm leading-5 text-term-text shadow-none placeholder:font-sans placeholder:text-term-faint focus-visible:outline-none focus-visible:border-term-border-strong focus-visible:ring-0 focus-visible:ring-offset-0'
export const TERM_BUTTON =
  'flex h-8 shrink-0 items-center gap-1 rounded-none border border-term-border bg-term-panel px-2 font-mono text-xs leading-5 text-term-muted shadow-none transition-colors hover:border-term-border-strong hover:text-term-text active:bg-term-raised focus-visible:outline-none focus-visible:border-term-border-strong disabled:cursor-not-allowed disabled:opacity-50'
export const TERM_SELECT_NATIVE =
  'h-8 rounded-none border border-term-border bg-term-bg px-2 font-mono text-xs leading-5 text-term-text shadow-none transition-colors focus:outline-none focus:border-term-border-strong disabled:cursor-not-allowed disabled:opacity-50'

/** 终端语义色（涨跌/状态微语义，去彩色胶囊底）。 */
export type TermTone = 'pos' | 'neg' | 'warn' | 'accent' | 'info' | 'muted'

const TONE_TEXT: Record<TermTone, string> = {
  pos: 'text-term-pos',
  neg: 'text-term-neg',
  warn: 'text-term-warn',
  accent: 'text-term-accent',
  info: 'text-term-text',
  muted: 'text-term-muted',
}

/** 单色枚举 pill：1px 同色弱边界 + mono 小字（与 CRM TermEnumPill 同规格）。 */
export function TermPill({
  tone,
  children,
  className,
  title,
  ...rest
}: {
  tone: TermTone
  children: React.ReactNode
  className?: string
  title?: string
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'title' | 'className' | 'children'>) {
  return (
    <span
      {...rest}
      title={title}
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-none border border-current/30 px-1.5 py-0.5 font-mono text-[11px] leading-4',
        TONE_TEXT[tone],
        className
      )}
    >
      {children}
    </span>
  )
}

/**
 * 批次 F 页面壳：flex 列布局、工具行右对齐、内容区 min-h-0 内滚。
 * 页面标题由 Top Header 面包屑承载（BLF-824 去重原则），不再渲染页内标题胶囊。
 */
export function TermPageShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex min-w-0 flex-col gap-2 rounded-none', className)}>{children}</div>
}

/** 工具行：h-8 控件带，右对齐操作区；移动端允许换行。 */
export function TermToolbarRow({
  left,
  right,
  className,
}: {
  left?: React.ReactNode
  right?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-center justify-end gap-1.5 rounded-none max-md:justify-between', className)}>
      {left}
      {right}
    </div>
  )
}

/** 页内 Tab 切换（portfolio-overview 同款 h-9 标题带规格，激活态 term-raised）。 */
export function TermTabBar<T extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: Array<{ key: T; label: React.ReactNode }>
  active: T
  onChange: (key: T) => void
  className?: string
}) {
  return (
    <div
      role="tablist"
      className={cn('flex h-9 shrink-0 items-center gap-1 rounded-none border-b border-term-border px-0', className)}
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          onClick={() => onChange(tab.key)}
          aria-selected={active === tab.key}
          role="tab"
          className={
            active === tab.key
              ? 'h-7 rounded-none border border-term-border bg-term-raised px-2 font-mono text-xs leading-5 font-semibold text-term-text shadow-none'
              : 'h-7 rounded-none border border-transparent px-2 text-xs leading-5 text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:border-term-border'
          }
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

/** KPI 终端磁贴（mono 数值 + 标签行，与 HeaderKpiTile / portfolio KpiTile 同规格）。 */
export function TermKpiTile({
  label,
  value,
  hint,
  tone,
  loading,
}: {
  label: string
  value: string
  hint?: string
  tone?: TermTone
  loading?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-none border border-term-border bg-term-panel px-2 py-1.5 shadow-none">
      <span className="truncate font-mono text-[11px] uppercase tracking-wider text-term-muted">
        {label}
      </span>
      <span
        data-testid="kpi-value"
        className={`truncate font-mono text-base leading-6 tabular-nums ${TONE_TEXT[tone ?? 'info']}`}
        title={value}
      >
        {loading ? '···' : value}
      </span>
      {hint ? (
        <span className="truncate font-mono text-[10px] leading-3 text-term-faint">{hint}</span>
      ) : null}
    </div>
  )
}
