import type * as React from 'react'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * BLF-979 Stage 2：Dashboard 首页 KPI 卡从 surface 面板风改为 term 直角面板——
 * `rounded-none border-term-border bg-term-panel shadow-none`，对齐订单流/明细表。
 * 标题条 uppercase mono 小标签，数值 mono 大数（tabular-nums）。
 */
export function V2Card({ className, ...props }: React.ComponentProps<typeof Card>) {
  return (
    <Card
      className={cn(
        'rounded-none border border-term-border bg-term-panel shadow-none',
        className
      )}
      {...props}
    />
  )
}
