'use client'

import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'

import { cn } from '@/lib/utils'

const Tabs = TabsPrimitive.Root

type TabsListProps = React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & {
  variant?: 'default' | 'term'
}

const TABS_LIST_BASE =
  'inline-flex items-center justify-center text-muted-foreground'

const TABS_LIST_DEFAULT =
  'min-h-11 gap-1 rounded-2xl border border-[hsl(var(--surface-high))/0.9] bg-[linear-gradient(180deg,hsl(var(--surface-soft))/0.94,hsl(var(--surface-subtle))/0.98)] p-1.5 shadow-[inset_0_1px_0_hsl(0_0%_100%/0.72),inset_0_-1px_0_hsl(214_18%_82%/0.38),0_10px_24px_-20px_rgba(15,23,42,0.12)] dark:border-[hsl(var(--surface-outline))/0.22] dark:bg-[linear-gradient(180deg,hsl(var(--surface-soft))/0.88,hsl(var(--surface-low))/0.98)] dark:shadow-[inset_0_1px_0_hsl(220_30%_100%/0.03),inset_0_-1px_0_rgba(0,0,0,0.28),0_20px_44px_-34px_rgba(0,0,0,0.82)]'

// BLF-883 全局统一：term 基座底改为 term-panel（对齐 monthly-report 参考样式），
// 页面侧不再各自覆盖 bg。
// BLF-887 高度上档：h-10（40px）。Tab 切换属页头级导航，较 h-9 标准控件档
// （TERM_HEADER_TRIGGER / 输入类）再高一档，保持「导航 > 输入 > 工具行」的层次。
const TABS_LIST_TERM =
  'h-10 min-h-10 max-w-full gap-0 rounded-none border border-term-border bg-term-panel p-0 text-xs overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  TabsListProps
>(({ className, variant = 'default', ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      TABS_LIST_BASE,
      variant === 'term' ? TABS_LIST_TERM : TABS_LIST_DEFAULT,
      className
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

type TabsTriggerProps = React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & {
  variant?: 'default' | 'term'
}

const TRIGGER_BASE =
  'relative inline-flex items-center justify-center whitespace-nowrap ring-offset-background transition-[color,background-color,border-color,box-shadow] [transition-duration:var(--motion-fast)] [transition-timing-function:var(--motion-ease-out)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-50 u-interactive'

const TRIGGER_DEFAULT =
  "min-h-[2.85rem] rounded-[calc(theme(borderRadius.2xl)-0.25rem)] border border-transparent px-4 py-2.5 text-sm font-semibold text-[hsl(218_19%_39%)] data-[state=active]:-translate-y-px data-[state=active]:border-[hsl(0_0%_100%/0.96)] data-[state=active]:bg-[linear-gradient(180deg,hsl(0_0%_100%/1),hsl(210_20%_99%/1))] data-[state=active]:text-[hsl(222_33%_16%)] data-[state=active]:shadow-[0_1px_0_hsl(0_0%_100%/1),0_10px_22px_-14px_rgba(15,23,42,0.18),0_2px_6px_rgba(15,23,42,0.06)] data-[state=active]:brightness-[1.01] data-[state=active]:[transition-duration:var(--motion-base)] data-[state=active]:[&::after]:content-[''] data-[state=active]:[&::after]:absolute data-[state=active]:[&::after]:bottom-0 data-[state=active]:[&::after]:left-1/2 data-[state=active]:[&::after]:-translate-x-1/2 data-[state=active]:[&::after]:w-[50%] data-[state=active]:[&::after]:h-[2px] data-[state=active]:[&::after]:rounded-full data-[state=active]:[&::after]:bg-[hsl(var(--primary))] data-[state=active]:[&::after]:shadow-[0_0_8px_hsl(var(--primary)/0.7),0_0_16px_hsl(var(--primary)/0.4)] dark:text-[hsl(220_14%_72%)] dark:hover:bg-[hsl(var(--surface-overlay))/0.36] dark:hover:text-white dark:data-[state=active]:border-[hsl(var(--surface-high))] dark:data-[state=active]:bg-[linear-gradient(180deg,hsl(var(--surface-high)/0.95),hsl(var(--surface-overlay)/0.98))] dark:data-[state=active]:text-white dark:data-[state=active]:shadow-[0_0_0_1px_hsl(var(--primary)/0.25),0_0_24px_-8px_hsl(var(--primary)/0.45),0_0_48px_-16px_hsl(var(--primary)/0.25),0_4px_12px_-4px_rgba(0,0,0,0.5),inset_0_1px_0_hsl(220_30%_100%/0.12)] dark:data-[state=active]:brightness-[1.08] dark:data-[state=active]:[&::after]:content-[''] dark:data-[state=active]:[&::after]:absolute dark:data-[state=active]:[&::after]:bottom-0 dark:data-[state=active]:[&::after]:left-1/2 dark:data-[state=active]:[&::after]:-translate-x-1/2 dark:data-[state=active]:[&::after]:w-[50%] dark:data-[state=active]:[&::after]:h-[2px] dark:data-[state=active]:[&::after]:rounded-full dark:data-[state=active]:[&::after]:bg-[hsl(var(--primary))] dark:data-[state=active]:[&::after]:shadow-[0_0_10px_hsl(var(--primary)/0.9),0_0_20px_hsl(var(--primary)/0.5)]"

// BLF-867 补充：term 选中态 = 抬升底 + 内嵌 accent 发光指示条（对齐旧版发光下划线语言，无 translate/不溢出）；与 tab-motion.tsx 的 motion.span 填充保持同步
const TERM_ACTIVE_UNDERLINE =
  'data-[state=active]:after:absolute data-[state=active]:after:inset-x-0 data-[state=active]:after:bottom-0 data-[state=active]:after:h-[2px] data-[state=active]:after:bg-term-accent data-[state=active]:after:shadow-[0_0_8px_color-mix(in_srgb,var(--term-accent)_60%,transparent),0_0_16px_color-mix(in_srgb,var(--term-accent)_30%,transparent)]'

// 高度与基座同档 h-10：Tab 触发器撑满列表高度，导出按钮等工作区操作钮同取 h-10，排齐不落差。
const TRIGGER_TERM =
  `h-10 min-h-10 rounded-none border border-transparent px-3 py-0 gap-1.5 font-mono text-xs leading-none text-term-muted hover:text-term-text data-[state=active]:bg-term-raised data-[state=active]:text-term-text data-[state=active]:shadow-none ${TERM_ACTIVE_UNDERLINE} [&_svg]:h-3.5 [&_svg]:w-3.5`

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  TabsTriggerProps
>(({ className, variant = 'default', ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      TRIGGER_BASE,
      variant === 'term' ? TRIGGER_TERM : TRIGGER_DEFAULT,
      className
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'mt-0 w-full ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[state=active]:animate-enter motion-reduce:data-[state=active]:animate-none',
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
