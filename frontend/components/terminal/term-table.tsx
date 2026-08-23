import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Terminal 高密度数据表格原语（BLF-809 规范 Pattern A）。
 * 表头 28px / 行高 28px、等宽数字右对齐、涨跌微语义色由调用方按单元格语义追加。
 */

const CELL_BASE = 'h-7 px-2 align-middle whitespace-nowrap'
const HEAD_BASE = cn(CELL_BASE, 'border-b border-term-border bg-term-raised text-left font-medium normal-case tracking-normal text-term-muted')
const CELL_CN = cn(CELL_BASE, 'border-b border-term-border text-term-text')

export function TermTable({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <table className={cn('w-full border-collapse font-mono text-xs tabular-nums', className)}>
      {children}
    </table>
  )
}

export function TermTHead({ children }: { children: React.ReactNode }) {
  return <thead className="sticky top-0 z-10">{children}</thead>
}

export function TermHead({ children, className, numeric }: { children: React.ReactNode; className?: string; numeric?: boolean }) {
  return (
    <th scope="col" className={cn(HEAD_BASE, numeric && 'text-right', className)}>
      {children}
    </th>
  )
}

export function TermBody({ children }: { children: React.ReactNode }) {
  return <tbody>{children}</tbody>
}

export function TermRow({
  children,
  className,
  highlight,
}: {
  children: React.ReactNode
  className?: string
  /** 行 hover / 当日高亮 */
  highlight?: boolean
}) {
  return (
    <tr className={cn('transition-colors hover:bg-term-hover', highlight && 'bg-term-raised', className)}>
      {children}
    </tr>
  )
}

export function TermCell({
  children,
  className,
  numeric,
  tone,
}: {
  children: React.ReactNode
  className?: string
  numeric?: boolean
  /** 微语义色：pos 涨/有货 · warn 待处理 · neg 跌/缺货 */
  tone?: 'pos' | 'warn' | 'neg' | 'muted'
}) {
  return (
    <td
      className={cn(
        CELL_CN,
        numeric && 'text-right',
        tone === 'pos' && 'text-term-pos',
        tone === 'warn' && 'text-term-warn',
        tone === 'neg' && 'text-term-neg',
        tone === 'muted' && 'text-term-muted',
        className
      )}
    >
      {children}
    </td>
  )
}
