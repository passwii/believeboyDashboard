'use client'

/**
 * 决策工作台（Decision Cockpit）—— 补货分析默认视图。
 *
 * 按 replenishment_action 将 SKU 分组为 6 条「行动道」（lane），
 * 每条道是响应式决策卡网格。行动即主组织轴，直接对应后端三段式的
 * 动作维度；状态通过卡片 rail + 指挥带光谱表达。
 *
 * - 行动道可折叠；NO_ACTION 默认折叠（信号少、噪声大）
 * - 支持 actionFilter 时只渲染匹配道（由父级控制 rows 已过滤）
 */
import { ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import { DecisionCard, type DecisionCardEdit } from './decision-card'
import {
  ACTION_HINTS,
  ACTION_LABELS,
  ACTION_ORDER,
  ACTION_THEME,
  type CockpitRow,
} from './cockpit-types'

interface DecisionCockpitProps {
  rows: CockpitRow[]
  isSnapshotMode: boolean
  /** rowKey -> edit，与父级 edits 同构 */
  edits: Record<string, DecisionCardEdit>
  savingSku: string | null
  rowKeyOf: (row: CockpitRow) => string
  onEditChange: (key: string, patch: Partial<DecisionCardEdit>) => void
  onSaveRow: (row: CockpitRow) => void
  onOpenShipments: (row: CockpitRow) => void
}

const COLLAPSED_BY_DEFAULT = new Set(['NO_ACTION'])

function buildDefaultEdit(row: CockpitRow): DecisionCardEdit {
  return {
    production_lead_days: String(row.production_lead_days),
    shipping_days: String(row.shipping_days),
    safety_factor: String(Math.round(row.safety_factor * 100)),
  }
}

export function DecisionCockpit({
  rows,
  isSnapshotMode,
  edits,
  savingSku,
  rowKeyOf,
  onEditChange,
  onSaveRow,
  onOpenShipments,
}: DecisionCockpitProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(COLLAPSED_BY_DEFAULT)

  const lanes = useMemo(
    () =>
      ACTION_ORDER.map((action) => ({
        action,
        rows: rows.filter((r) => (r.replenishment_action ?? 'NO_ACTION') === action),
      })).filter((lane) => lane.rows.length > 0),
    [rows]
  )

  if (rows.length === 0) {
    return (
      <div className="bg-term-panel px-6 py-16 text-center text-sm text-term-muted">
        当前筛选条件下没有可分析的 SKU。
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {lanes.map((lane) => {
        const isCollapsed = collapsed.has(lane.action)
        const theme = ACTION_THEME[lane.action] ?? ACTION_THEME.NO_ACTION
        return (
          <section key={lane.action} className="overflow-hidden rounded-none border border-term-border dark:border-term-border">
            {/* lane header */}
            <button
              type="button"
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev)
                  if (next.has(lane.action)) next.delete(lane.action)
                  else next.add(lane.action)
                  return next
                })
              }
              className="flex w-full items-center gap-2.5 border-b border-term-border bg-term-raised px-4 py-2.5 text-left transition-colors hover:bg-term-panel dark:border-term-border dark:bg-term-raised dark:hover:bg-term-raised"
            >
              <span className={cn('h-2.5 w-2.5 rounded-full', theme.bar)} />
              <span className="text-sm font-semibold text-term-text">
                {ACTION_LABELS[lane.action] ?? lane.action}
              </span>
              <span className="rounded-full bg-term-panel px-2 py-0.5 text-xs font-bold tabular-nums text-term-text dark:bg-term-raised">
                {lane.rows.length}
              </span>
              <span className="hidden min-w-0 truncate text-xs text-term-muted sm:block">
                {ACTION_HINTS[lane.action] ?? ''}
              </span>
              <ChevronDown
                className={cn(
                  'ml-auto h-4 w-4 shrink-0 text-term-muted transition-transform',
                  isCollapsed && '-rotate-90'
                )}
              />
            </button>

            {/* lane body */}
            {!isCollapsed && (
              <div className="grid grid-cols-1 gap-3 bg-term-panel p-3 md:grid-cols-2 dark:bg-term-raised 2xl:grid-cols-3">
                {lane.rows.map((row) => {
                  const key = rowKeyOf(row)
                  return (
                    <DecisionCard
                      key={key}
                      row={row}
                      edit={edits[key] ?? buildDefaultEdit(row)}
                      isSnapshotMode={isSnapshotMode}
                      saving={savingSku === key}
                      onEditChange={(patch) => onEditChange(key, patch)}
                      onSave={() => onSaveRow(row)}
                      onOpenShipments={() => onOpenShipments(row)}
                    />
                  )
                })}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
