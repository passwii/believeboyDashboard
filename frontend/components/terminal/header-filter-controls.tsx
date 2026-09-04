'use client'

import * as React from 'react'
import { SlidersHorizontal } from 'lucide-react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/**
 * Top Header 中段插槽内容的统一容器（BLF-826 范式收口）。
 *
 * 各页面把本页筛选控件经 `useHeaderSlot` portal 进 TerminalHeader 中段；
 * 本组件决定这批控件在不同视口的呈现形态：
 *
 * - `<md`（isMobileView）：折叠为「筛选」Popover，避免 56px header 塞不下（BLF-887 上档）；
 * - `≥md`：单行平铺（flex-nowrap + overflow-hidden），超宽部分裁切，
 *   与 HeaderSlotMount 的 `hidden md:flex` 容器配合。
 *
 * 历史上该组件被复制粘贴在 7 个页面文件里（daily-analysis / inventory-analysis /
 * portfolio-overview / ad-data/top-filters / finance×3），现收口为单一共享实现；
 * 新迁移页面一律 import 本组件，不要再手写拷贝。
 */
export function HeaderFilterControls({
  isMobileView,
  controls,
}: {
  isMobileView: boolean
  controls: React.ReactNode
}) {
  if (isMobileView) {
    return (
      <Popover>
        <PopoverTrigger
          className="flex h-9 items-center gap-1 rounded-md border border-term-border bg-term-panel px-2 text-xs text-term-muted transition-colors hover:bg-term-hover hover:text-term-text"
          aria-label="页面筛选"
        >
          <SlidersHorizontal className="h-4 w-4" aria-hidden />
          筛选
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-[320px] rounded-none border border-term-border bg-term-panel p-3 text-term-text"
        >
          <div className="grid grid-cols-1 gap-3">{controls}</div>
        </PopoverContent>
      </Popover>
    )
  }
  return <div className="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden">{controls}</div>
}
