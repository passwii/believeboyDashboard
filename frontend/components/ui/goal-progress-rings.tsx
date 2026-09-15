'use client'

/**
 * GoalProgressRings — 目标达成进度环（改编自 kokonutui 开源组件 Apple Activity Card）
 *
 * @author: @kokonutui — https://kokonutui.com — https://github.com/kokonut-labs/kokonutui
 * @license: MIT（保留原作者署名）
 *
 * 布局（BLF-595 回归原参考设计 + 后续调整）：
 * 原版 kokonutui apple-activity-card 是 Apple Watch 式同心圆——一个圈里 3 个嵌套环
 * （200/160/120 三层），右侧分别列出 3 个指标的情况与说明。本组件恢复该合并式布局：
 * - 左侧：单一圆形容器内绝对居中叠放 3 个同心圆环（外→内 = 指标 1 → 指标 3）；
 * - 右侧：3 个指标块（指标名 / 大号百分比 / 主说明 / 次要说明 note），桌面端
 *   3 列横排（充分利用屏幕宽度），手机端单列堆叠。
 *
 * 相对原版（apple-activity-card.tsx）的改动（BLF-535 + BLF-595）：
 * - 数据驱动：原组件硬编码 MOVE/EXERCISE/STAND 三条数据，改为 props 注入；
 * - 语义 0-1：原组件 value 按 0-100 百分比计算且 >100 时 strokeDashoffset 为负，
 *   现改为小数（0.86 = 86%），弧长按 100% 封顶，超额在文案层表达；
 * - 主题化：原组件硬编码 zinc 色 + 3 组渐变特判，改用项目 CSS 变量色 + 单色渐变
 *   （stopOpacity 淡出），自动适配亮暗主题；
 * - 动画：保留 framer-motion 描边绘制与入场，接入项目 motion tokens，并尊重
 *   prefers-reduced-motion（降级为无动画直出）。
 */

import Link from 'next/link'
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

/**
 * 同心环尺寸（外 → 内）：与 kokonutui 原版一致（200/160/120），
 * 叠放在同一圆形容器内，形成 Apple Watch 式合并三环。
 */
const RING_SIZES = [200, 160, 120] as const
const RING_STROKE_WIDTH = 14

type ConcentricRingProps = {
  item: GoalRingItem
  index: number
  size: number
  reduce: boolean
}

function ConcentricRing({ item, index, size, reduce }: ConcentricRingProps) {
  const gradientId = useId()
  const radius = (size - RING_STROKE_WIDTH) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = clampRingValue(item.value)
  const dashOffset = circumference * (1 - clamped)

  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <svg
        aria-label={`${item.label}：${item.display}`}
        className="-rotate-90"
        height={size}
        role="img"
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
          strokeWidth={RING_STROKE_WIDTH}
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
          strokeWidth={RING_STROKE_WIDTH}
          style={{ filter: 'drop-shadow(0 0 3px rgba(0,0,0,0.12))' }}
          transition={{ duration: 1.1, delay: index * 0.1, ease: EASE.out }}
        />
      </svg>
    </div>
  )
}

type GoalProgressRingsProps = {
  items: GoalRingItem[]
  className?: string
}

export type GoalProgressStatProps = {
  items: GoalRingItem[]
  href: string
  value: string
  loading?: boolean
  className?: string
}

/**
 * Stats 区使用的紧凑目标磁贴：沿用目标管理页的三环语义，但缩成一个
 * 与 MetricSwitcherCard 指标格同高的可点击入口，避免把完整说明面板挤进 KPI 行。
 */
export function GoalProgressStat({
  items,
  href,
  value,
  loading = false,
  className,
}: GoalProgressStatProps) {
  const reduce = useReducedMotion()
  const ringItems = items.slice(0, RING_SIZES.length)
  const compactSizes = [56, 44, 32] as const

  return (
    <Link
      aria-label="查看目标管理"
      className={cn(
        'group relative flex min-h-[112px] cursor-pointer items-center gap-3 p-4 text-start transition-colors duration-150 hover:bg-muted/40',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent',
        className
      )}
      href={href}
    >
      <div className="relative h-16 w-16 shrink-0" aria-hidden="true">
        {loading ? (
          <div className="h-16 w-16 animate-pulse rounded-full border-[5px] border-term-border" />
        ) : ringItems.length > 0 ? (
          ringItems.map((item, index) => {
            const size = compactSizes[index] ?? compactSizes[compactSizes.length - 1]
            const radius = (size - 5) / 2
            const circumference = 2 * Math.PI * radius
            const dashOffset = circumference * (1 - clampRingValue(item.value))
            return (
              <div className="absolute inset-0 flex items-center justify-center" key={item.key}>
                <svg
                  className="-rotate-90"
                  height={size}
                  viewBox={`0 0 ${size} ${size}`}
                  width={size}
                >
                  <circle
                    cx={size / 2}
                    cy={size / 2}
                    fill="none"
                    r={radius}
                    stroke="currentColor"
                    strokeWidth={5}
                    className="text-border/70 dark:text-border/60"
                  />
                  <motion.circle
                    animate={{ strokeDashoffset: dashOffset }}
                    cx={size / 2}
                    cy={size / 2}
                    fill="none"
                    initial={
                      reduce
                        ? { strokeDashoffset: dashOffset }
                        : { strokeDashoffset: circumference }
                    }
                    r={radius}
                    stroke={item.color}
                    strokeDasharray={circumference}
                    strokeLinecap="round"
                    strokeWidth={5}
                    transition={{ duration: 0.8, delay: index * 0.08, ease: EASE.out }}
                  />
                </svg>
              </div>
            )
          })
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-full border border-dashed border-term-border text-[10px] text-term-faint">
            —
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex items-center justify-between gap-1.5">
          <span className="truncate font-mono text-[11px] uppercase tracking-wider text-term-muted">
            目标进度
          </span>
          <span
            className="text-term-faint transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          >
            →
          </span>
        </div>
        <div className="truncate font-mono text-base leading-6 tabular-nums text-term-text">
          {loading ? '加载中' : value}
        </div>
        <div className="mt-1 truncate font-mono text-[10px] leading-3 text-term-faint">
          {items.length > 0 ? '点击查看目标管理' : '查看目标设置'}
        </div>
      </div>
    </Link>
  )
}

/**
 * 合并式三环进度：左侧一个圆内嵌套 3 个同心环，右侧 3 个指标块
 * （指标名 / 大号百分比 / 说明）。桌面横排（右侧 3 列）、手机端上下堆叠。
 */
export function GoalProgressRings({ items, className }: GoalProgressRingsProps) {
  const reduce = useReducedMotion()
  if (items.length === 0) return null

  // 环序：外 → 内 = items[0] → items[2]（第 1 个指标最大环，最外层）
  const ringItems = items.slice(0, RING_SIZES.length)

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:gap-10',
        className
      )}
      role="group"
      aria-label="目标完成率指标"
    >
      {/* 左侧：一个圆内 3 个同心环 */}
      <motion.div
        animate={{ opacity: 1, scale: 1 }}
        aria-label="目标完成率三环"
        className="relative h-52 w-52 shrink-0"
        data-testid="goal-rings-concentric"
        initial={reduce ? false : { opacity: 0, scale: 0.85 }}
        role="group"
        transition={{ duration: DURATION.slow, ease: EASE.out }}
      >
        {ringItems.map((item, index) => (
          <ConcentricRing
            key={item.key}
            index={index}
            item={item}
            reduce={reduce === true}
            size={RING_SIZES[index] ?? 120}
          />
        ))}
      </motion.div>

      {/* 右侧：3 个指标情况与说明（BLF-595 调整：桌面 3 列横排，充分利用宽度） */}
      <div className="grid w-full min-w-0 flex-1 grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-5">
        {ringItems.map((item, index) => {
          const over = item.value >= 1
          return (
            <motion.div
              key={item.key}
              animate={{ opacity: 1, x: 0 }}
              className="flex min-w-0 items-start gap-3"
              initial={reduce ? false : { opacity: 0, x: 16 }}
              transition={{ duration: DURATION.fast, delay: 0.15 + index * 0.1, ease: EASE.out }}
            >
              {/* 指标色点 */}
              <span
                aria-hidden="true"
                className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: item.color }}
              />
              <div className="min-w-0 flex-1">
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
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
                    {item.note}
                  </p>
                ) : null}
              </div>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}
