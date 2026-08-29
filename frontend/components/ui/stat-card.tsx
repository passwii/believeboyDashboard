import type * as React from 'react'

import { TERM_PANEL_SURFACE } from '@/components/ui/card'
import { Delta, DeltaIcon, DeltaValue } from '@/components/ui/delta'
import { cn } from '@/lib/utils'

interface StatCardProps {
  title: string
  value: string
  rawValue?: number
  icon: React.ReactNode
  color: 'emerald' | 'rose' | 'sky' | 'amber'
  trend?: number
  trendLabel?: string
  className?: string
}

// Terminal 收口（BLF-872）：卡片统一 term 平板（零渐变/零圆角/零阴影），
// 颜色仅保留图标芯片一档语义提示，数值与文案走 term 中性色。
const colorClasses = {
  emerald: {
    bg: 'bg-emerald-500/10',
    icon: 'text-emerald-600 dark:text-emerald-400',
  },
  rose: {
    bg: 'bg-term-neg/10',
    icon: 'text-term-neg',
  },
  sky: {
    bg: 'bg-term-accent/10',
    icon: 'text-term-accent',
  },
  amber: {
    bg: 'bg-term-warn/10',
    icon: 'text-term-warn',
  },
}

function StatCard({ title, value, icon, color, trend, trendLabel, className }: StatCardProps) {
  const colors = colorClasses[color]

  return (
    <div className={cn(TERM_PANEL_SURFACE, 'animate-enter overflow-hidden', className)}>
      <div className="flex flex-row items-start justify-between space-y-0 px-4 pb-3 pt-4">
        <div className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-term-muted">
          {title}
        </div>
        <div className={cn('rounded-none p-1.5', colors.bg, colors.icon)}>{icon}</div>
      </div>
      <div className="px-4 pb-4 pt-0">
        <div className="font-mono text-xl font-semibold tracking-tight text-term-text">
          {value}
        </div>
        {trend !== undefined ? (
          <p className="mt-2 font-mono text-xs text-term-muted">
            {/* 涨跌逻辑统一走 Delta 原语（ui/delta.tsx）：正值 emerald / 负值 rose / 0 中性 */}
            <Delta value={trend}>
              <DeltaIcon variant="arrow" />
              <DeltaValue />
            </Delta>
            <span className="ml-1">{trendLabel || '较上期'}</span>
          </p>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 指标卡行（BLF-503 §8 页面模式）：统一 label-value-delta 卡片行的栅格与间距。
 * 默认 2/3/4/5 列响应式（移动规则 4：`grid-cols-2 sm:grid-cols-3 md:grid-cols-5`），
 * 卡片数超过 6 时改用水平滑动（移动规则 7），详见 `docs/FRONTEND-DESIGN-SPEC.md` §8.3。
 */
interface StatCardRowProps {
  children: React.ReactNode
  className?: string
}

function StatCardRow({ children, className }: StatCardRowProps) {
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 xl:gap-4',
        className
      )}
    >
      {children}
    </div>
  )
}

export { StatCard, StatCardRow }
export type { StatCardProps, StatCardRowProps }
