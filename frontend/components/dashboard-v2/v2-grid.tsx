import type * as React from 'react'

import { cn } from '@/lib/utils'

/** Efferd 密集网格：gap-px + bg-border 发丝线分隔，lg 4 列 / md 2 列 / 移动端 1 列 */
export function V2Grid({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-1 gap-px bg-border p-px md:grid-cols-2 lg:grid-cols-4', className)}>
      {children}
    </div>
  )
}
