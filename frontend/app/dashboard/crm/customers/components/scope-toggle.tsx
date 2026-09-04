'use client'

import { useCrmDataScope } from '@/hooks/use-crm-data-scope'
import { cn } from '@/lib/utils'

/** 数据范围切换（mine/all）：终端 Tab 规格——零圆角、1px 边界、激活态 term-raised。 */
export function ScopeToggle() {
  const { scope, setScope } = useCrmDataScope()
  return (
    <div
      role="radiogroup"
      aria-label="数据范围"
      className="inline-flex items-center rounded-none border border-term-border bg-term-bg p-0.5"
    >
      {(
        [
          { value: 'mine', label: '我的' },
          { value: 'all', label: '全部' },
        ] as const
      ).map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={scope === o.value}
          onClick={() => setScope(o.value)}
          className={cn(
            'px-2 py-0.5 font-mono text-xs transition-colors',
            scope === o.value
              ? 'bg-term-raised text-term-text'
              : 'text-term-muted hover:text-term-text'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
