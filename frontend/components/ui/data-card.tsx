import * as React from "react"

import { cn } from "@/lib/utils"

// 表格密集单元格间距常量（供所有表格卡片使用）
export const DENSE_CELL = "!p-2"
export const DENSE_HEAD = "!px-2"

// ========================
// DataCard — 普通内容卡片
// 替代: Card > CardHeader > CardContent 的手动组合
// 特点: 标题行（含分隔线） + 内容区带默认 padding
// ========================

function DataCard({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("dashboard-surface", className)} {...props} />
}

interface DataCardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string
  titleClassName?: string
  description?: string
  badge?: React.ReactNode
  action?: React.ReactNode
}

function DataCardHeader({ title, titleClassName, description, badge, action, className, ...props }: DataCardHeaderProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center justify-between border-b border-border/70 bg-[hsl(var(--surface-subtle))] px-4 py-3",
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {badge}
        {title && <h2 className={cn("text-base font-semibold text-foreground leading-none", titleClassName)}>{title}</h2>}
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="ml-4 flex shrink-0 flex-wrap gap-2">{action}</div>}
    </div>
  )
}

function DataCardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-6 py-5", className)} {...props} />
}

// ========================
// DataTableCard — 表格专用卡片
// 特点: 上半部分灵活布局 + 下半部分表格贴边
// ========================

function DataTableCard({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("dashboard-surface relative", className)} {...props} />
}

// 标题行容器（border-b 分隔）— 支持 title/description/action 或任意子元素
interface DataTableCardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string
  description?: string
  action?: React.ReactNode
}

function DataTableCardHeader({ title, description, action, className, children, ...props }: DataTableCardHeaderProps) {
  return (
    <div
      className={cn(
        "border-b border-border/70 bg-[hsl(var(--surface-subtle))] px-6 py-4 md:px-7 md:py-5",
        className
      )}
      {...props}
    >
      {children ?? (
        <div className="flex min-w-0 items-center justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            {title && <h2 className="text-base font-semibold text-foreground leading-none">{title}</h2>}
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {action && <div className="ml-4 flex shrink-0 flex-wrap gap-2">{action}</div>}
        </div>
      )}
    </div>
  )
}

// 指标卡行（内置响应式 grid）— 接收任意子元素
function DataTableCardMetrics({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid gap-2 px-4 pb-3 md:grid-cols-4 xl:grid-cols-7", className)} {...props} />
}

// 表格区域（零 padding）
function DataTableCardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("min-w-0", className)} {...props} />
}

// ========================
// DataTableCardStatBar — 扁平统计条
// 替代 DataTableCardMetrics：无边框/圆角/背景，等分列展示数据
// 用法: <DataTableCardStatBar items={[{label, value}, ...]} />
// ========================
interface DataTableCardStatBarItem {
  label: string
  value: string | number | React.ReactNode
  highlight?: boolean
}

interface DataTableCardStatBarProps extends React.HTMLAttributes<HTMLDivElement> {
  items: DataTableCardStatBarItem[]
}

function DataTableCardStatBar({ items, className, ...props }: DataTableCardStatBarProps) {
  if (items.length === 0) return null
  return (
    <div
      className={cn("flex divide-x divide-border/60", className)}
      {...props}
    >
      {items.map((item, i) => (
        <div
          key={i}
          className={cn(
            "flex flex-1 flex-col items-center justify-center py-2.5",
            i === 0 && "pl-4",
            i === items.length - 1 && "pr-4",
          )}
        >
          <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">{item.label}</div>
          <div className={cn(
            "mt-0.5 text-xl font-semibold leading-tight",
            item.highlight ? "text-primary" : "text-foreground"
          )}>
            {item.value}
          </div>
        </div>
      ))}
    </div>
  )
}

export {
  DataCard,
  DataCardHeader,
  DataCardContent,
  DataTableCard,
  DataTableCardHeader,
  DataTableCardMetrics,
  DataTableCardBody,
  DataTableCardStatBar,
}
export type { DataCardHeaderProps, DataTableCardStatBarItem }
