import type * as React from 'react'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export function V2Card({ className, ...props }: React.ComponentProps<typeof Card>) {
  return (
    <Card
      className={cn(
        /* BLF-609 续：dark 侧去蓝调——from-blue-950/40 换成中性 surface-subtle
         * 半透明顶光（保持原"顶部微亮 → 底部沉底"的明度斜坡，仅去色相）。 */
        'rounded-none bg-gradient-to-b from-blue-50/70 to-white shadow-none ring-0 dark:from-[hsl(var(--surface-subtle)/0.5)] dark:to-background',
        className
      )}
      {...props}
    />
  )
}
