import type * as React from 'react'

import { cn } from '@/lib/utils'

/** 卡片网格（BLF-911 收口）：发丝线分隔（gap-px + bg）→ 留白间距。
 * 保留 grid-cols-2 / lg:grid-cols-4 与 col-span 语义，仅改间距。
 * 移动端 gap-3，md+ 放大到 gap-4（布局密度不变，视觉从"面板拼接"变"卡片阵列"）。
 */
export function V2Grid({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4', className)}>
      {children}
    </div>
  )
}
