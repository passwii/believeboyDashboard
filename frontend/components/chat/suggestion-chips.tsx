'use client'

import { useMemo } from 'react'
import {
  TrendingUp,
  BarChart3,
  AlertCircle,
  ClipboardList,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'

export type SuggestionItem = {
  icon: LucideIcon
  label: string
  prompt: string
}

const SUGGESTIONS: SuggestionItem[] = [
  {
    icon: TrendingUp,
    label: '销售趋势',
    prompt: '分析近期销售趋势，哪些品类增长最快？',
  },
  {
    icon: BarChart3,
    label: '昨日数据',
    prompt: '帮我总结昨天的核心运营数据',
  },
  {
    icon: AlertCircle,
    label: '异常订单',
    prompt: '最近7天有哪些订单存在异常？请列出详情',
  },
  {
    icon: ClipboardList,
    label: '周报摘要',
    prompt: '请为本周围绕核心指标生成一份周报摘要',
  },
]

export function SuggestionChips({
  onSelect,
  suggestions = SUGGESTIONS,
}: {
  onSelect: (prompt: string) => void
  suggestions?: SuggestionItem[]
}) {
  return (
    <div className="flex flex-wrap justify-center gap-2 sm:gap-3">
      {suggestions.map((item, index) => {
        const Icon = item.icon
        return (
          <button
            key={item.label}
            type="button"
            onClick={() => onSelect(item.prompt)}
            className="group relative inline-flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-medium transition-all duration-300 hover:scale-[1.03] active:scale-[0.97] bb-anim-scale-in cursor-pointer bg-white border border-slate-200 shadow-sm hover:border-slate-300 hover:shadow dark:bg-transparent dark:border-white/[0.06] dark:shadow-none"
            style={{
              animationDelay: `${2.8 + index * 0.12}s`,
            }}
          >
            {/* Light: subtle hover tint — dark: blue wash */}
            <span
              className="absolute inset-0 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none hidden dark:block"
              style={{
                background: 'linear-gradient(135deg, rgba(20,136,252,0.15), rgba(99,102,241,0.08))',
              }}
            />
            <span className="absolute inset-0 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none dark:hidden bg-slate-50" />
            <Icon
              className="size-4 relative z-10 text-blue-500 dark:text-blue-400/70 group-hover:text-blue-600 dark:group-hover:text-blue-300 transition-colors duration-200"
              aria-hidden
            />
            <span className="relative z-10 text-slate-700 dark:text-[#c8c8cc] group-hover:text-slate-900 dark:group-hover:text-white transition-colors duration-200 whitespace-nowrap">
              {item.label}
            </span>
            <Sparkles
              className="size-3 relative z-10 text-blue-400/40 dark:text-blue-400/30 group-hover:text-blue-500/60 dark:group-hover:text-blue-400/60 transition-all duration-200"
              aria-hidden
            />
          </button>
        )
      })}
    </div>
  )
}
