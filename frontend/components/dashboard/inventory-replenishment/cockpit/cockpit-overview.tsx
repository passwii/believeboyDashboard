'use client'

/**
 * 指挥带（Command Strip）—— 驾驶舱顶部的全景总览。
 *
 * - 状态光谱：5 段比例条（critical/deteriorating/watch/healthy/unknown），点击筛选
 * - 行动全景：6 行动计数（紧急补货→移除），点击筛选，带选中态
 * - 库存总览：可售总量 / 在途总量 / SKU 数
 * - 数据健康：数据新鲜度（max）+ 置信度构成
 */
import { Boxes, PackageSearch, Ship, Activity } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  ACTION_LABELS,
  ACTION_ORDER,
  ACTION_THEME,
  STATE_LABELS,
  STATE_ORDER,
  STATE_THEME,
  type CockpitRow,
  type CockpitSummary,
} from './cockpit-types'

interface CockpitOverviewProps {
  rows: CockpitRow[]
  summary: CockpitSummary
  loading: boolean
  stateFilter: string | null
  actionFilter: string | null
  onStateFilter: (state: string | null) => void
  onActionFilter: (action: string | null) => void
}

function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--'
  return value.toLocaleString('zh-CN')
}

export function CockpitOverview({
  rows,
  summary,
  loading,
  stateFilter,
  actionFilter,
  onStateFilter,
  onActionFilter,
}: CockpitOverviewProps) {
  // 状态分布（从 rows 统计，保证与工作台一致）
  const stateCounts = STATE_ORDER.map((state) => ({
    state,
    count: rows.filter((r) => (r.inventory_state ?? 'unknown') === state).length,
  }))
  const totalState = Math.max(1, rows.length)

  // 行动分布
  const actionCounts = ACTION_ORDER.map((action) => ({
    action,
    count: rows.filter((r) => (r.replenishment_action ?? 'NO_ACTION') === action).length,
  }))

  // 数据健康：新鲜度 + 置信度
  const maxFreshness = rows.reduce((acc, r) => Math.max(acc, r.signals?.data_freshness_days ?? 0), 0)
  const confidenceCounts = {
    high: rows.filter((r) => r.signals?.confidence === 'high').length,
    medium: rows.filter((r) => r.signals?.confidence === 'medium').length,
    low: rows.filter((r) => r.signals?.confidence === 'low').length,
  }
  const freshnessTone =
    maxFreshness <= 1
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
      : maxFreshness <= 3
        ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
        : 'bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300'

  if (loading && rows.length === 0) {
    return (
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.4fr_1fr_0.8fr]">
        <Skeleton className="h-32 w-full rounded-none" />
        <Skeleton className="h-32 w-full rounded-none" />
        <Skeleton className="h-32 w-full rounded-none" />
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.4fr_1fr_0.8fr]">
      {/* 状态光谱 */}
      <div className="rounded-none border border-term-border bg-term-panel p-4 shadow-none dark:border-term-border dark:bg-term-raised">
        <div className="mb-2.5 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5 text-term-muted" />
            <span className="text-xs font-semibold text-term-text">状态光谱</span>
          </div>
          <span className="text-[11px] text-term-muted">点击分段筛选</span>
        </div>
        <div className="flex h-9 w-full gap-px overflow-hidden rounded-none">
          {stateCounts.map(({ state, count }) => {
            if (count === 0) return null
            const theme = STATE_THEME[state] ?? STATE_THEME.unknown
            const active = stateFilter === state
            return (
              <button
                key={state}
                type="button"
                onClick={() => onStateFilter(active ? null : state)}
                className={cn(
                  'flex flex-col items-center justify-center gap-0.5 transition-all hover:brightness-110',
                  theme.rail,
                  active && 'ring-2 ring-inset ring-foreground/60'
                )}
                style={{ width: `${(count / totalState) * 100}%` }}
                title={`${STATE_LABELS[state] ?? state}: ${count}`}
              >
                <span className="text-[11px] font-bold leading-none text-white drop-shadow-none">
                  {count}
                </span>
                <span className="text-[9px] leading-none text-white/90 drop-shadow-none">
                  {STATE_LABELS[state] ?? state}
                </span>
              </button>
            )
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {stateCounts.map(({ state, count }) => (
            <button
              key={state}
              type="button"
              onClick={() => onStateFilter(stateFilter === state ? null : state)}
              className={cn(
                'flex items-center gap-1 text-[11px] transition-colors',
                stateFilter === state
                  ? 'font-semibold text-term-text'
                  : 'text-term-muted hover:text-term-text'
              )}
            >
              <span className={cn('inline-block h-2 w-2 rounded-full', STATE_THEME[state].dot)} />
              {STATE_LABELS[state] ?? state}
              <span className="tabular-nums">{count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 行动全景 */}
      <div className="rounded-none border border-term-border bg-term-panel p-4 shadow-none dark:border-term-border dark:bg-term-raised">
        <div className="mb-2.5 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <PackageSearch className="h-3.5 w-3.5 text-term-muted" />
            <span className="text-xs font-semibold text-term-text">行动全景</span>
          </div>
          <span className="text-[11px] text-term-muted">按决策优先级排序</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {actionCounts.map(({ action, count }) => {
            const theme = ACTION_THEME[action] ?? ACTION_THEME.NO_ACTION
            const active = actionFilter === action
            return (
              <button
                key={action}
                type="button"
                onClick={() => onActionFilter(active ? null : action)}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-all',
                  theme.badge,
                  active && 'ring-2 ring-foreground/50'
                )}
              >
                <span className={cn('inline-block h-1.5 w-1.5 rounded-full', theme.bar)} />
                {ACTION_LABELS[action] ?? action}
                <span className="font-bold tabular-nums">{count}</span>
              </button>
            )
          })}
        </div>
        <div className="mt-2.5 flex items-center gap-3 border-t border-term-border pt-2 text-[11px] text-term-muted dark:border-term-border">
          <span className="flex items-center gap-1">
            可售 <span className="font-semibold tabular-nums text-term-text">{formatInt(summary.total_available_inventory)}</span>
          </span>
          <span className="flex items-center gap-1">
            在途 <span className="font-semibold tabular-nums text-term-text">{formatInt(summary.total_in_transit_quantity)}</span>
          </span>
        </div>
      </div>

      {/* 库存总览 + 数据健康 */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-1 items-center justify-between rounded-none border border-term-border bg-term-panel px-4 py-3 shadow-none dark:border-term-border dark:bg-term-raised">
          <div className="flex items-center gap-2">
            <Boxes className="h-4 w-4 text-term-muted" />
            <span className="text-xs text-term-muted">SKU 数</span>
          </div>
          <span className="text-lg font-bold tabular-nums text-term-text">
            {formatInt(summary.sku_count)}
          </span>
        </div>
        <div className="flex flex-1 items-center justify-between rounded-none border border-term-border bg-term-panel px-4 py-3 shadow-none dark:border-term-border dark:bg-term-raised">
          <div className="flex items-center gap-2">
            <Ship className="h-4 w-4 text-term-muted" />
            <span className="text-xs text-term-muted">数据新鲜度</span>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={cn('text-[11px]', freshnessTone)}>
              最大 {maxFreshness > 0 ? `${maxFreshness} 天` : '--'}
            </Badge>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-between gap-2 rounded-none border border-term-border bg-term-panel px-4 py-3 shadow-none dark:border-term-border dark:bg-term-raised">
          <span className="text-xs text-term-muted">置信度构成</span>
          <div className="flex gap-1.5 text-[11px]">
            <span className="text-emerald-600 dark:text-emerald-300">高 {confidenceCounts.high}</span>
            <span className="text-amber-600 dark:text-amber-300">中 {confidenceCounts.medium}</span>
            <span className="text-term-muted">低 {confidenceCounts.low}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
