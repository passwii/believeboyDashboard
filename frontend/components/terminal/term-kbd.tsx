import type { HTMLAttributes } from 'react'

import { cn } from '@/lib/utils'

/**
 * kbd 快捷键共享组件（BLF-832 / master-prompt §任务 1b-6）。
 * 唯一实现，替代此前 SubNav 搜索框与 Header 用户菜单两处手写 <kbd> 的漂移。
 */
export function TermKbd({ className, children, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'border border-term-border px-1 font-mono text-xs leading-4 text-term-faint',
        className
      )}
      {...props}
    >
      {children}
    </kbd>
  )
}
