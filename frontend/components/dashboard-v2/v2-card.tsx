import type * as React from 'react'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * BLF-911 收口：Dashboard 首页卡片从 terminal 黑底（rounded-none + border-0 +
 * bg-term-panel）改为 surface 面板风——圆角 + 边框 + 卡片背景 + 成对阴影。
 * light 走 shadow-soft，dark 走 shadow-level-2（Raycast 式成对阴影，BLF-573）。
 * 保留导出名与 props 签名，消费者零改动；仅视觉令牌变更。
 */
export function V2Card({ className, ...props }: React.ComponentProps<typeof Card>) {
  return (
    <Card
      className={cn(
        'rounded-lg border-border bg-card text-card-foreground shadow-soft',
        'dark:border-border/70 dark:shadow-level-2',
        className
      )}
      {...props}
    />
  )
}
