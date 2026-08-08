import type * as React from 'react'

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

const colorClasses = {
  emerald: {
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/20',
    text: 'text-emerald-600 dark:text-emerald-400',
    gradient: 'from-emerald-500/5',
    icon: 'text-emerald-600',
  },
  rose: {
    bg: 'bg-rose-500/10',
    border: 'border-rose-500/20',
    text: 'text-rose-600 dark:text-rose-400',
    gradient: 'from-rose-500/5',
    icon: 'text-rose-600',
  },
  sky: {
    bg: 'bg-sky-500/10',
    border: 'border-sky-500/20',
    text: 'text-sky-600 dark:text-sky-400',
    gradient: 'from-sky-500/5',
    icon: 'text-sky-600',
  },
  amber: {
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/20',
    text: 'text-amber-600 dark:text-amber-400',
    gradient: 'from-amber-500/5',
    icon: 'text-amber-600',
  },
}

function StatCard({ title, value, icon, color, trend, trendLabel, className }: StatCardProps) {
  const colors = colorClasses[color]

  return (
    <div
      className={cn(
        'dashboard-surface hover-lift animate-enter border relative overflow-hidden',
        colors.border,
        className
      )}
    >
      <div
        className={cn(
          'absolute inset-0 bg-gradient-to-br via-transparent to-transparent opacity-60 dark:opacity-35',
          colors.gradient
        )}
      />
      <div className="relative z-10 flex flex-row items-start justify-between space-y-0 px-4 pb-3 pt-4">
        <div
          className={cn(
            'text-[13px] font-semibold uppercase tracking-[0.08em] text-muted-foreground'
          )}
        >
          {title}
        </div>
        <div className={cn('rounded-lg p-2', colors.bg, colors.icon)}>{icon}</div>
      </div>
      <div className="relative z-10 px-4 pb-4 pt-0">
        <div className={cn('text-2xl font-semibold tracking-tight md:text-[1.7rem]', colors.text)}>
          {value}
        </div>
        {trend !== undefined ? (
          <p className="mt-2 text-xs text-muted-foreground">
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
