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
import styles from './warm-chat.module.css'

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
            className={`${styles.chip} group relative inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-all duration-[var(--duration-quick)] hover:scale-[1.03] active:scale-[0.97] bb-anim-scale-in cursor-pointer`}
            style={{
              animationDelay: `${2.8 + index * 0.12}s`,
            }}
          >
            <Icon
              className={`${styles.chipAccent} size-4 relative z-10`}
              aria-hidden
            />
            <span className="relative z-10 whitespace-nowrap">
              {item.label}
            </span>
            <Sparkles
              className={`${styles.chipAccent} size-3 relative z-10`}
              aria-hidden
            />
          </button>
        )
      })}
    </div>
  )
}
