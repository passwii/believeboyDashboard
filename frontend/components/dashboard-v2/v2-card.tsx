import type * as React from 'react'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export function V2Card({ className, ...props }: React.ComponentProps<typeof Card>) {
  return (
    <Card
      className={cn(
        /* BLF-809 终端化：去渐变与阴影，改用 --term-* 面板色；
         * border-0 保留 —— 卡片边框交给 V2Grid 的 gap-px + bg 发丝线分隔。 */
        'rounded-none border-0 bg-term-panel shadow-none ring-0',
        className
      )}
      {...props}
    />
  )
}
