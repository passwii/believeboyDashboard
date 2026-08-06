import type * as React from 'react'

import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export function V2Card({ className, ...props }: React.ComponentProps<typeof Card>) {
  return (
    <Card
      className={cn(
        'rounded-none bg-gradient-to-b from-blue-50/70 to-white shadow-none ring-0 dark:from-blue-950/40 dark:to-background',
        className
      )}
      {...props}
    />
  )
}
