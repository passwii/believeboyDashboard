import * as React from 'react'

import { cn } from '@/lib/utils'

// TableProps：Terminal 收口（BLF-872）——外层零圆角，密度基线 = compact 档
// （表头 h-9 + 0.66rem，数据格 px-3 py-2 + 13px，与 table-presets 唯一配方同源）。
interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  containerClassName?: string
  /** 表格布局方式，fixed 模式下 colgroup/width 才能精确控制列宽 */
  tableLayout?: 'auto' | 'fixed'
  /** 是否使用边框折叠模式（推荐，用于精确列宽控制） */
  borderCollapse?: boolean
}

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, containerClassName, tableLayout, borderCollapse, ...props }, ref) => (
    <div className={cn('relative w-full overflow-x-auto overflow-y-visible', containerClassName)}>
      <table
        ref={ref}
        className={cn(
          'w-full caption-bottom font-mono text-[13px]',
          borderCollapse ? 'border-collapse' : 'border-separate border-spacing-0',
          tableLayout === 'fixed' && '[table-layout:fixed]',
          className
        )}
        {...props}
      />
    </div>
  )
)
Table.displayName = 'Table'

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => <thead ref={ref} className={cn(className)} {...props} />)
TableHeader.displayName = 'TableHeader'

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn('[&_tr:last-child]:border-b-0', className)} {...props} />
))
TableBody.displayName = 'TableBody'

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn('bg-term-raised font-medium [&>tr]:last:border-b-0', className)}
    {...props}
  />
))
TableFooter.displayName = 'TableFooter'

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        'transition-colors [&>th]:border-b [&>th]:border-r [&>th]:border-term-border [&>th:last-child]:border-r-0 [&>td]:border-b [&>td]:border-r [&>td]:border-term-border [&>td:last-child]:border-r-0 hover:bg-term-hover data-[state=selected]:bg-term-raised data-[state=selected]:hover:bg-term-raised',
        className
      )}
      {...props}
    />
  )
)
TableRow.displayName = 'TableRow'

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      'h-9 bg-term-raised px-3 text-left align-middle font-mono text-[0.66rem] font-semibold uppercase tracking-[0.14em] text-term-muted [&:has([role=checkbox])]:pr-0',
      className
    )}
    {...props}
  />
))
TableHead.displayName = 'TableHead'

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn('px-3 py-2 align-middle text-term-text [&:has([role=checkbox])]:pr-0', className)}
    {...props}
  />
))
TableCell.displayName = 'TableCell'

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn('mt-3 font-mono text-xs text-term-muted', className)} {...props} />
))
TableCaption.displayName = 'TableCaption'

// ========================
// ColGroup — 配合 table-fixed 使用，定义固定列宽
// 用法: <Table><ColGroup columns={[{width: 112}, {width: 144}, ...]} />...</Table>
// ========================
interface ColGroupProps {
  columns: { width?: number | string }[]
  className?: string
}

export function ColGroup({ columns, className }: ColGroupProps) {
  return (
    <colgroup className={className}>
      {columns.map((col, i) => (
        <col
          key={i}
          style={
            col.width
              ? { width: typeof col.width === 'number' ? `${col.width}px` : col.width }
              : undefined
          }
        />
      ))}
    </colgroup>
  )
}

// ========================
// 公共 Sticky 样式常量
// 用于 DataTableCard、inventory-replenishment、shop-calculation 等页面
// 原则：实体不透明 term 令牌背景（无 opacity），z-index 分层，shadow 模拟边框
// （BLF-872 Terminal 收口：surface-subtle/base → term-raised/panel，去除暗黑玻璃高光）
// ========================

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption }

/** 第一列表头单元格：固定左侧 + 顶部（配合 STICKY_TOP_ROW 使用） */
export const STICKY_LEFT_HEAD_CELL =
  'sticky left-0 z-50 bg-term-raised shadow-[inset_-1px_0_0_0_var(--term-border)]'

/** 第一行表头行：固定顶部（z-index 40，数据行上方） */
export const STICKY_TOP_ROW = 'sticky top-0 z-40 bg-term-raised shadow-[inset_0_-1px_0_0_var(--term-border)]'

/** 两行表头场景第1行 group header：固定顶部，z-index 最高 */
export const STICKY_TOP_GROUP_ROW = 'sticky top-0 z-50'

/** 两行表头场景第2行 sub-header：固定顶部，offset=第1行表头高度（h-9 + border = 37px） */
export const STICKY_TOP_SUB_ROW = 'sticky top-[37px] z-40'

/** 第一列数据单元格：固定左侧，实体不透明背景 */
export const STICKY_LEFT_CELL =
  'sticky left-0 z-30 bg-term-panel shadow-[inset_-1px_0_0_0_var(--term-border)]'

/** 第一列数据单元格（含 hover 变亮效果） */
export const STICKY_LEFT_CELL_HOVER =
  'sticky left-0 z-30 bg-term-panel shadow-[inset_-1px_0_0_0_var(--term-border)] hover:!bg-term-hover'
