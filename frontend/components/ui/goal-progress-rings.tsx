'use client'

/**
 * GoalProgressRings — 目标达成进度环（改编自 kokonutui 开源组件 Apple Activity Card）
 *
 * @author: @kokonutui — https://kokonutui.com — https://github.com/kokonut-labs/kokonutui
 * @license: MIT（保留原作者署名）
 *
 * 相对原版（apple-activity-card.tsx）的改动（BLF-535）：
 * - 数据驱动：原组件硬编码 MOVE/EXERCISE/STAND 三条数据，改为 props 注入；
 * - 语义 0-1：原组件 value 按 0-100 百分比计算且 >100 时 strokeDashoffset 为负，
 *   现改为小数（0.86 = 86%），弧长按 100% 封顶，超额在文案层表达；
 * - 主题化：原组件硬编码 zinc 色 + 3 组渐变特判，改用项目 CSS 变量色 + 单色渐变
 *   （stopOpacity 淡出），自动适配亮暗主题；
 * - 布局：原组件是 Apple Watch 式同心圆（200/160/120 三层嵌套）方形卡片，
 *   对"3 个独立指标"不够直观；改为横向"环 + 数据"长条布局——桌面 3 列各一个等大圆环，
 *   手机端纵向堆叠，圆环保持圆形不被拉伸（"长条形"通过布局而非几何变形实现）；
 * - 动画：保留 framer-motion 描边绘制与入场，接入项目 motion tokens，并尊重
 *   prefers-reduced-motion（降级为无动画直出）。
 */

import { motion, useReducedMotion } from 'framer-motion'
import { useId } from 'react'

import { DURATION, EASE } from '@/lib/motion/tokens'
import { cn } from '@/lib/utils'

export type GoalRingItem = {
  key: string
  /** 指标名，如「截止今日完成率」 */
  label: string
  /** 完成率（小数）：0.86 = 86%；>1 表示超额（环按 100% 封顶，文案层提示） */
  value: number
  /** 展示文本，如 "86.3%" */
  display: string
  /** 主说明文字，如 "已完成 ¥1,700 / 应完成 ¥1,970" */
  caption: string
  /** 次要说明（可空），如 "按当前日均线性外推，仅供参考" */
  note?: string
  /** 环颜色（CSS color，推荐 hsl(var(--chart-N)) 以适配主题） */
  color: string
}

/** 环弧长语义 0-1 封顶（>100% 超额时环画满，超额由展示层表达） */
export function clampRingValue(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(value, 1))
}

/**
 * 预估月度完成率（线性外推 run-rate）：
 * 当前已完成 ÷ 已过天数 × 整月天数 ÷ 整月目标 = 实际月度进度 × (整月天数 ÷ 今日日序)。
 * 例如 15 号已完成整月目标的 40% → 40% × 30/15 = 80%。
 * today_day <= 0（非当前月）时不具备口径，返回 0。
 */
export function projectedMonthlyRate(
  completionVsMonthly: number,
  daysInMonth: number,
  todayDay: number
): number {
  if (!Number.isFinite(completionVsMonthly) || todayDay <= 0 || daysInMonth <= 0) return 0
  return completionVsMonthly * (daysInMonth / todayDay)
}

type GoalRingProps = {
  item: GoalRingItem
  index: number
  reduce: boolean
}

function GoalRing({ item, index, reduce }: GoalRingProps) {
  const gradientId = useId()
  const size = 68
  const strokeWidth = 9
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = clampRingValue(item.value)
  const dashOffset = circumference * (1 - clamped)
  const over = item.value >= 1

  return (
    <motion.div
      aria-label={`${item.label}：${item.display}`}
      role="img"
      animate={{ opacity: 1, scale: 1 }}
      className="relative shrink-0"
      initial={reduce ? false : { opacity: 0, scale: 0.8 }}
      transition={{ duration: DURATION.slow, delay: index * 0.1, ease: EASE.out }}
    >
      <svg
        className="-rotate-90"
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        width={size}
      >
        <title>{`${item.label}：${item.display}`}</title>
        <defs>
          <linearGradient id={gradientId} x1="0%" x2="100%" y1="0%" y2="100%">
            <stop offset="0%" stopColor={item.color} />
            <stop offset="100%" stopColor={item.color} stopOpacity={0.45} />
          </linearGradient>
        </defs>
        {/* track */}
        <circle
          className="text-border/70 dark:text-border/60"
          cx={size / 2}
          cy={size / 2}
          fill="none"
          r={radius}
          stroke="currentColor"
          strokeWidth={strokeWidth}
        />
        {/* progress arc */}
        <motion.circle
          animate={{ strokeDashoffset: dashOffset }}
          cx={size / 2}
          cy={size / 2}
          fill="none"
          initial={reduce ? { strokeDashoffset: dashOffset } : { strokeDashoffset: circumference }}
          r={radius}
          stroke={`url(#${gradientId})`}
          strokeDasharray={circumference}
          strokeLinecap="round"
          strokeWidth={strokeWidth}
          style={{ filter: 'drop-shadow(0 0 3px rgba(0,0,0,0.12))' }}
          transition={{ duration: 1.1, delay: index * 0.1, ease: EASE.out }}
        />
      </svg>
      {over ? (
        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[9px] font-semibold text-white shadow-sm">
          !
        </span>
      ) : null}
    </motion.div>
  )
}

type GoalProgressRingsProps = {
  items: GoalRingItem[]
  className?: string
}

/**
 * 三环进度带：每个指标 = 一个等大圆环 + 指标名 / 数值 / 说明文字。
 * 桌面端 3 列横向排布（"长条"观感），手机端纵向堆叠，圆环恒定 68px 不被拉伸。
 */
export function GoalProgressRings({ items, className }: GoalProgressRingsProps) {
  const reduce = useReducedMotion()
  if (items.length === 0) return null

  return (
    <div
      className={cn('grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-3', className)}
      role="group"
      aria-label="目标完成率指标"
    >
      {items.map((item, index) => {
        const over = item.value >= 1
        return (
          <div key={item.key} className="flex min-w-0 items-center gap-4">
            <GoalRing item={item} index={index} reduce={reduce === true} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-xs font-medium text-muted-foreground">{item.label}</p>
                {over ? (
                  <span className="rounded-full bg-emerald-500/10 px-1.5 py-px text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                    超额
                  </span>
                ) : null}
              </div>
              <p
                className="text-2xl font-semibold leading-tight tabular-nums"
                style={{ color: item.color }}
              >
                {item.display}
              </p>
              <p className="truncate text-xs text-muted-foreground">{item.caption}</p>
              {item.note ? (
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">{item.note}</p>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
