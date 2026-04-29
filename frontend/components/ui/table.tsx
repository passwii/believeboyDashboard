import * as React from "react"

import { cn } from "@/lib/utils"

// TableProps 中的 noWrapperRounded 已废弃：默认无圆角（与 DataCard 配合使用时自然对齐）
// 如需恢复圆角，请显式传入 wrapperRounded={true}
// 为了向后兼容，保留 noWrapperRounded 参数但忽略其效果（等同于 noWrapperRounded={true}）
interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  containerClassName?: string
  /** @deprecated 默认已无圆角，无需设置。如需恢复圆角请使用 wrapperRounded */
  noWrapperRounded?: boolean
  /** 显式恢复外层圆角（默认 false，即无圆角） */
  wrapperRounded?: boolean
}

const Table = React.forwardRef<
  HTMLTableElement,
  TableProps
>(({ className, containerClassName, noWrapperRounded, wrapperRounded, ...props }, ref) => (
  <div className={cn("relative w-full overflow-x-auto overflow-y-visible", wrapperRounded ? "rounded-lg" : "", containerClassName)}>
    <table
      ref={ref}
      className={cn("w-full border-separate border-spacing-0 caption-bottom text-sm", className)}
      {...props}
    />
  </div>
))
Table.displayName = "Table"

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn(className)} {...props} />
))
TableHeader.displayName = "TableHeader"

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn("[&_tr:last-child]:border-b-0", className)}
    {...props}
  />
))
TableBody.displayName = "TableBody"

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn(
      "bg-muted/35 font-medium [&>tr]:last:border-b-0",
      className
    )}
    {...props}
  />
))
TableFooter.displayName = "TableFooter"

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      "transition-colors [&>th]:border-b [&>th]:border-r [&>th]:border-border/60 [&>th:last-child]:border-r-0 [&>td]:border-b [&>td]:border-r [&>td]:border-border/60 [&>td:last-child]:border-r-0 hover:bg-[hsl(var(--surface-subtle))] data-[state=selected]:bg-primary/8 data-[state=selected]:hover:bg-primary/12",
      className
    )}
    {...props}
  />
))
TableRow.displayName = "TableRow"

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-11 bg-[hsl(var(--surface-subtle))] px-4 text-left align-middle text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground/92 [&:has([role=checkbox])]:pr-0",
      className
    )}
    {...props}
  />
))
TableHead.displayName = "TableHead"

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn("p-4 align-middle text-sm text-foreground/92 [&:has([role=checkbox])]:pr-0", className)}
    {...props}
  />
))
TableCell.displayName = "TableCell"

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn("mt-4 text-sm text-muted-foreground", className)}
    {...props}
  />
))
TableCaption.displayName = "TableCaption"

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}

// ========================
// 公共 Sticky 样式常量
// 用于 DataTableCard、inventory-replenishment、store-accounting 等页面
// 原则：实体不透明背景（无 opacity），z-index 分层，shadow 模拟边框
// ========================

/** 第一列表头单元格：固定左侧 + 顶部（配合 STICKY_TOP_ROW 使用） */
export const STICKY_LEFT_HEAD_CELL =
  'sticky left-0 z-50 bg-[hsl(var(--surface-subtle))] shadow-[inset_-1px_0_0_0_hsl(var(--border)/0.5)]'

/** 第一行表头行：固定顶部（z-index 40，数据行上方） */
export const STICKY_TOP_ROW =
  'sticky top-0 z-40 bg-[hsl(var(--surface-subtle))] shadow-[inset_0_-1px_0_0_hsl(var(--border)/0.4)]'

/** 两行表头场景第1行 group header：固定顶部，z-index 最高 */
export const STICKY_TOP_GROUP_ROW =
  'sticky top-0 z-50'

/** 两行表头场景第2行 sub-header：固定顶部，offset=第1行表头高度（h-11 + border = 45px） */
export const STICKY_TOP_SUB_ROW =
  'sticky top-[45px] z-40'

/** 第一列数据单元格：固定左侧，实体不透明背景 */
export const STICKY_LEFT_CELL =
  'sticky left-0 z-30 bg-[hsl(var(--surface-base))] shadow-[inset_-1px_0_0_0_hsl(var(--border)/0.4)]'

/** 第一列数据单元格（含 hover 变亮效果） */
export const STICKY_LEFT_CELL_HOVER =
  'sticky left-0 z-30 bg-[hsl(var(--surface-base))] shadow-[inset_-1px_0_0_0_hsl(var(--border)/0.4)] hover:!bg-sky-50/90 dark:hover:!bg-sky-950/40'
