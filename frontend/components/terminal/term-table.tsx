import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Terminal 高密度数据表格原语（BLF-809 规范 Pattern A）。
 * 表头 40px / 行高 40px（BLF-887 高度上档 2026-08-29）、等宽数字右对齐、涨跌微语义色由调用方按单元格语义追加。
 */

const CELL_BASE = 'h-10 px-2 align-middle whitespace-nowrap text-xs leading-5'
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

export function TermHead({
  children,
  className,
  numeric,
  onClick,
  title,
}: {
  /** 空操作列表头（无文字）时可为空 */
  children?: React.ReactNode
  className?: string
  numeric?: boolean
  /** 可选点击（列排序）；传入时自动带 cursor + hover 反馈 */
  onClick?: () => void
  /** 可选原生 title（截断表头的完整内容提示） */
  title?: string
}) {
  return (
    <th
      scope="col"
      title={title}
      onClick={onClick}
      className={cn(
        HEAD_BASE,
        numeric && 'text-right',
        onClick && 'cursor-pointer select-none hover:text-term-text',
        className
      )}
    >
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
  onClick,
}: {
  children: React.ReactNode
  className?: string
  /** 行 hover / 当日高亮 */
  highlight?: boolean
  /** 可选行点击（如台账行打开详情）；传入时自动带 cursor-pointer */
  onClick?: () => void
}) {
  return (
    <tr
      onClick={onClick}
      className={cn(
        'transition-colors hover:bg-term-hover',
        highlight && 'bg-term-raised',
        onClick && 'cursor-pointer',
        className
      )}
    >
      {children}
    </tr>
  )
}

export function TermCell({
  children,
  className,
  numeric,
  tone,
  title,
  colSpan,
  rowSpan,
  onClick,
}: {
  /** 纯 colSpan 占位单元格（合计行空位）时可为空 */
  children?: React.ReactNode
  className?: string
  numeric?: boolean
  /** 微语义色：pos 涨/有货 · warn 待处理 · neg 跌/缺货 */
  tone?: 'pos' | 'warn' | 'neg' | 'muted'
  /** 可选原生 title（截断单元格的完整内容提示） */
  title?: string
  /** 跨列合并（状态行 / 合计行用） */
  colSpan?: number
  /** 跨行合并（项目名按站点合并行用） */
  rowSpan?: number
  /** 可选单元格点击（操作列阻断行点击等场景） */
  onClick?: (event: React.MouseEvent<HTMLTableCellElement>) => void
}) {
  return (
    <td
      title={title}
      colSpan={colSpan}
      rowSpan={rowSpan}
      onClick={onClick}
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
