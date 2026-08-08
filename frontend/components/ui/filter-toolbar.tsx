'use client'

import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * FilterToolbar 原语（BLF-503 §8 页面模式）：统一筛选工具栏的排列、间距与响应式换行。
 * 容器用 `dashboard-toolbar`（overlay 底 + 玻璃边），默认 `px-4 py-4 lg:px-6 lg:py-5`。
 *
 * 响应式（对齐 MOBILE_ADAPTATION_RULES 规则 2）：
 * - 桌面（md+）：`flex flex-wrap items-center gap-3`，字段横向排列、自动换行；
 * - 手机（<md）：折叠为 `grid grid-cols-2 gap-2`，字段按 2 列网格排列；
 * - `actions`（如刷新按钮）桌面靠右（ml-auto），手机占满一行（col-span-2）。
 *
 * 用法：
 * ```tsx
 * <FilterToolbar actions={<RefreshButton onClick={refresh} />}>
 *   <ProjectSelect ... />
 *   <CountrySelect ... />
 *   <DateRangePicker ... />
 * </FilterToolbar>
 * ```
 * 字段自身的宽度（如 w-[140px]）在桌面保留，手机端由网格撑满。
 * 需要完全自定义布局时传 `contentClassName` 覆盖。
 */
export interface FilterToolbarProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
  /** 右侧操作区（刷新按钮等），手机端自动占满一行 */
  actions?: React.ReactNode
  /** 手机端是否折叠为 2 列网格（默认 true，符合移动规则 2） */
  mobileGrid?: boolean
  /** 覆盖内部字段区布局 */
  contentClassName?: string
}

export function FilterToolbar({
  children,
  actions,
  mobileGrid = true,
  className,
  contentClassName,
  ...props
}: FilterToolbarProps) {
  return (
    <div className={cn('dashboard-toolbar px-4 py-4 lg:px-6 lg:py-5', className)} {...props}>
      <div
        className={cn(
          mobileGrid
            ? 'grid grid-cols-2 items-center gap-2 md:flex md:flex-wrap md:items-center md:gap-3'
            : 'flex flex-wrap items-center gap-3',
          contentClassName
        )}
      >
        {children}
        {actions ? (
          <div
            className={cn(
              mobileGrid
                ? 'col-span-2 grid grid-cols-2 gap-2 md:col-span-1 md:ml-auto md:flex md:flex-wrap md:items-center md:gap-2'
                : 'ml-auto flex flex-wrap items-center gap-2'
            )}
          >
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default FilterToolbar
