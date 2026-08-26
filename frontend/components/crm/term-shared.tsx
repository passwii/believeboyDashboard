import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * BLF-837 · CRM 域终端化共享原语（term-shared 同款控件基类，BLF-817/836 一致）。
 *
 * CRM 页面筛选不上移 Top Header 插槽（CrmTable 的筛选条是 URL 状态驱动的
 * 表格内建能力，非页面级全局参数；ScopeToggle 数据范围切换与表格联动），
 * 统一沿用页内工具行模式：h-8 控件 / 零圆角 / 1px 边界 / 等宽数值。
 */

export const TERM_TRIGGER =
  'h-8 rounded-none border-term-border bg-term-bg text-xs text-term-text focus:ring-0 data-[state=open]:border-term-border-strong'
export const TERM_SELECT_ITEM = 'rounded-none text-sm focus:bg-term-hover focus:text-term-text'
export const TERM_INPUT =
  'h-8 rounded-none border-term-border bg-term-bg font-mono text-sm text-term-text shadow-none placeholder:font-sans placeholder:text-term-faint focus-visible:ring-0 focus-visible:ring-offset-0'
export const TERM_BUTTON =
  'flex h-8 shrink-0 items-center gap-1 border border-term-border bg-term-panel px-2 font-mono text-sm text-term-muted transition-colors hover:border-term-border-strong hover:text-term-text disabled:cursor-not-allowed disabled:opacity-50'
export const TERM_SELECT_NATIVE =
  'h-8 rounded-none border border-term-border bg-term-bg px-2 font-mono text-sm text-term-text transition-colors focus:outline-none focus:border-term-border-strong disabled:cursor-not-allowed disabled:opacity-50'

/**
 * CRM 枚举 → 终端单色语义（去彩色胶囊底，仅 term 文本色 + 1px 边界）。
 * 语义约定：绿=活跃/已转化/高意向 · 红=流失/丢弃/删除 · 琥珀=暂缓/待处理 · 蓝/紫/青=中性流程态。
 */
export type TermTone = 'pos' | 'neg' | 'warn' | 'accent' | 'info' | 'muted'

const TONE_TEXT: Record<TermTone, string> = {
  pos: 'text-term-pos',
  neg: 'text-term-neg',
  warn: 'text-term-warn',
  accent: 'text-term-accent',
  info: 'text-term-text',
  muted: 'text-term-muted',
}

/** 单色枚举 pill：1px 同色弱边界 + mono 小写字距（与 TermStatusPill 同规格）。 */
export function TermEnumPill({
  tone,
  children,
  className,
  title,
}: {
  tone: TermTone
  children: React.ReactNode
  className?: string
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-none border px-1.5 py-0.5 font-mono text-[11px]',
        TONE_TEXT[tone],
        className
      )}
    >
      {children}
    </span>
  )
}

/** 客户状态 → 终端语义色（active=pos · lost=neg · signed=accent · on_hold=warn）。 */
export const CUSTOMER_STATUS_TERM: Record<string, TermTone> = {
  active: 'pos',
  lost: 'neg',
  signed: 'accent',
  on_hold: 'warn',
}

/** 客户等级 → 终端语义（A=info 强调 · B/C/D=muted 递弱，等级是分档非涨跌）。 */
export const CUSTOMER_RATING_TERM: Record<string, TermTone> = {
  A: 'info',
  B: 'muted',
  C: 'muted',
  D: 'muted',
}

/** 线索状态 → 终端语义（converted=pos · discarded=neg · new=accent · contacting=warn · qualified=info）。 */
export const LEAD_STATUS_TERM: Record<string, TermTone> = {
  new: 'accent',
  contacting: 'warn',
  qualified: 'info',
  converted: 'pos',
  discarded: 'neg',
}

/** 线索意向 → 终端语义（high=pos 热线索 · medium=warn · low=muted）。 */
export const LEAD_INTENT_TERM: Record<string, TermTone> = {
  high: 'pos',
  medium: 'warn',
  low: 'muted',
}

/** CRM 操作日志 → 终端语义（delete/move_sea=neg · create/convert/complete/claim=pos · update/status=accent 其余 muted）。 */
export const AUDIT_ACTION_TERM: Record<string, TermTone> = {
  create: 'pos',
  complete: 'pos',
  convert: 'pos',
  claim: 'pos',
  delete: 'neg',
  move_sea: 'neg',
  cancel: 'muted',
  transfer: 'info',
  update: 'accent',
  status: 'accent',
}

/** 来源等无涨跌语义的分类值 → 统一 muted（终端里中性分类不抢视觉）。 */
export const NEUTRAL_TERM: TermTone = 'muted'

/**
 * CRM 域页面壳：去 PageHeader 后的统一容器。
 * flex 列布局钉满 Canvas 高度、工具行右对齐、内容区 min-h-0 内滚。
 */
export function CrmPageShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex min-w-0 flex-col gap-2', className)}>{children}</div>
}

/** 工具行：h-8 控件带，右对齐操作区；移动端允许换行。 */
export function CrmToolbarRow({
  left,
  right,
  className,
}: {
  left?: React.ReactNode
  right?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-center justify-end gap-1.5 max-md:justify-between', className)}>
      {left}
      {right}
    </div>
  )
}
