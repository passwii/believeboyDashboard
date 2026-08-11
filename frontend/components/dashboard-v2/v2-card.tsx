import type * as React from 'react'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export function V2Card({ className, ...props }: React.ComponentProps<typeof Card>) {
  return (
    <Card
      className={cn(
        /* BLF-609 续：dark 侧去蓝调——from-blue-950/40 换成中性 surface-subtle
         * 半透明顶光（保持原"顶部微亮 → 底部沉底"的明度斜坡，仅去色相）。
         * BLF-624：border-0 —— 卡片边框交给 V2Grid 的 gap-px + bg 发丝线分隔，
         * 否则每张卡继承 dashboard-surface 的 1px border，组合后与 1px 间隙叠加成双层边框。 */
        'rounded-none border-0 bg-gradient-to-b from-blue-50/70 to-white shadow-none ring-0 dark:from-[hsl(var(--surface-subtle)/0.5)] dark:to-background',
        className
      )}
      {...props}
    />
  )
}
