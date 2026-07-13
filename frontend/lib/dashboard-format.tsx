/**
 * Dashboard 通用格式化工具
 *
 * 抽离自 app/dashboard/page.tsx 与 dashboard-sales-chart.tsx 的私有函数,
 * 让其它 dashboard 组件(如 DashboardTopProjects / DashboardTopCountries /
 * DashboardAdSpendChart)也能复用同一套展示口径,避免重复实现 / 视觉漂移。
 *
 * 用法:
 *   import { fmtMoney, formatAxisMoney, renderChangeIndicator } from '@/lib/dashboard-format'
 */

import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import React from 'react'

// ============================================================================
// 数字/百分比格式化
// ============================================================================

export function fmtMoney(v: number): string {
  return v >= 10000
    ? `$${(v / 1000).toFixed(0)}k`
    : v >= 1000
      ? `$${(v / 1000).toFixed(1)}k`
      : `$${v.toFixed(2)}`
}

export function fmtNum(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
}

export function fmtPct(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`
}

/** 详细金额(2 位小数),给表格/详情区使用。 */
export function fmtMoneyPrecise(v: number): string {
  return `$${v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** 详细数量(千位分隔),给表格使用。 */
export function fmtNumPrecise(v: number): string {
  return v.toLocaleString('zh-CN')
}

// ============================================================================
// 日期 / 日期范围工具
// ============================================================================

/** Date → 'YYYY-MM-DD' */
export function formatYMD(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 生成 [from, to] 区间内每一天的 'YYYY-MM-DD' 字符串数组(闭区间)。 */
export function generateDateRangeStrings(from: Date, to: Date): string[] {
  const dates: string[] = []
  const current = new Date(from)
  while (current <= to) {
    dates.push(formatYMD(current))
    current.setDate(current.getDate() + 1)
  }
  return dates
}

// ============================================================================
// recharts 专用的金额/数字格式化
// ============================================================================

/** Tooltip 内显示金额:zh-CN 千分位 2 位(无 $ 符号)。 */
export function formatMoney(value: number): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** 坐标轴短格式:>=1000 用 k 简写 + $,否则整数 + $。 */
export function formatAxisMoney(value: number): string {
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(1)}k`
  return `$${value.toFixed(0)}`
}

// ============================================================================
// 环比渲染(统一 up / down / neutral 视觉)
// ============================================================================

/**
 * 渲染"环比"小徽章。change > 0.5 → 绿↑,change < -0.5 → 红↓,否则灰—。
 * 用法:
 *   <td>{renderChangeIndicator(change)}</td>
 */
export function renderChangeIndicator(change: number | null | undefined): React.ReactNode {
  if (change === null || change === undefined || !Number.isFinite(change)) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
        <Minus className="h-3 w-3" />—
      </span>
    )
  }
  const threshold = 0.5
  if (change > threshold) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <ArrowUp className="h-3 w-3" />
        {change.toFixed(1)}%
      </span>
    )
  }
  if (change < -threshold) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-destructive">
        <ArrowDown className="h-3 w-3" />
        {change.toFixed(1)}%
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
      <Minus className="h-3 w-3" />
      {change.toFixed(1)}%
    </span>
  )
}
