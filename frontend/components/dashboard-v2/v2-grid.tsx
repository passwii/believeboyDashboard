import type * as React from 'react'

import { cn } from '@/lib/utils'

/** Efferd 密集网格：gap-px 发丝线分隔（BLF-609 续：dark 侧发改为中性 border token），lg 4 列 / md 2 列 / 移动端 2 列
 * BLF-624：子卡片必须无边框（V2Card 已 border-0），分隔线完全由本网格 gap-px + bg 承担，避免双层边框。
 * BLF-621：移动端 grid-cols-2 —— KPI 一行两个（规则 4）；宽组件（图表/TopProjects）用 col-span-2 独占一行。 */
export function V2Grid({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        /* BLF-809 终端化：发丝线改用 --term-border；lg 4 列 / md 2 列 / 移动端 2 列。
         * BLF-621：移动端 grid-cols-2 —— KPI 一行两个（规则 4）；宽组件（图表/TopProjects）用 col-span-2 独占一行。 */
        'grid grid-cols-2 gap-px bg-term-border p-px lg:grid-cols-4',
        className
      )}
    >
      {children}
    </div>
  )
}
