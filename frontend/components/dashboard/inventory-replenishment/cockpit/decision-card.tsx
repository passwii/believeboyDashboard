'use client'

/**
 * 三段式决策卡（Decision Card）—— 驾驶舱工作台的最小单元。
 *
 * 一张卡 = 一个 SKU 的三段式仪表：
 * - 左侧 4px 状态 rail（判断维度）
 * - 状态/行动双徽章（判断 + 动作维度）
 * - 库存：可售 / 在途 / 可售天数（库存）
 * - 库龄分布条（signals.aging_share）
 * - DMS 4 窗口迷你条 + 加权 + 趋势（销售 DMS）
 * - 库存周期时间轴：补货指令 → 建仓 → 发货 → 售罄
 * - 信号行：季节性 / 置信度 / 数据新鲜度
 * - 设置三件套（生产交货/运输/加权系数）+ 保存 + 查看发货
 */
import { CircleHelp, Loader2, Save, Send, TrendingDown, TrendingUp, Minus } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  ACTION_LABELS,
  ACTION_RULE_LABELS,
  ACTION_THEME,
  CONFIDENCE_LABELS,
  CRITICAL_SUBTYPE_LABELS,
  MOMENTUM_LABELS,
  SEASONAL_EMOJI,
  SEASONAL_LABELS,
  STATE_LABELS,
  STATE_RULE_LABELS,
  STATE_THEME,
  type CockpitDecisionPath,
  type CockpitRow,
} from './cockpit-types'

export type DecisionCardEdit = {
  production_lead_days: string
  shipping_days: string
  safety_factor: string
}

interface DecisionCardProps {
  row: CockpitRow
  edit: DecisionCardEdit
  isSnapshotMode: boolean
  saving: boolean
  onEditChange: (patch: Partial<DecisionCardEdit>) => void
  onSave: () => void
  onOpenShipments: () => void
}

function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--'
  return value.toLocaleString('zh-CN')
}

function formatNum(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '--'
  return value.toFixed(digits)
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--'
  return `${(value * 100).toFixed(0)}%`
}

/** 短日期 MM/DD */
function shortDate(value: string | null | undefined): string | null {
  if (!value) return null
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return value
  return `${Number(m[2])}/${Number(m[3])}`
}

/** DMS 4 窗口迷你条 + 趋势（销售 DMS 维度） */
function DmsBars({ row }: { row: CockpitRow }) {
  const windows = [
    { label: '3D', value: row.dms_3 },
    { label: '7D', value: row.dms_7 },
    { label: '14D', value: row.dms_14 },
    { label: '30D', value: row.dms_30 },
  ]
  const max = Math.max(1, ...windows.map((w) => w.value ?? 0))
  const trendRatio = row.signals?.trend_ratio_7_30
  const trendLabel = row.signals?.trend_label
  const momentum = row.signals?.trend_momentum

  const trendDown = trendRatio !== null && trendRatio !== undefined && trendRatio < 0.9
  const trendUp = trendRatio !== null && trendRatio !== undefined && trendRatio > 1.1

  return (
    <div className="flex items-end gap-3">
      {windows.map((w) => {
        const height = w.value ? Math.max(14, Math.round((w.value / max) * 100)) : 4
        return (
          <div key={w.label} className="flex flex-col items-center gap-1">
            <div className="flex h-9 w-6 items-end rounded-[3px] bg-[hsl(var(--surface-strong))] dark:bg-[hsl(var(--surface-overlay))]">
              <div
                className={cn(
                  'w-full rounded-[3px] transition-all',
                  trendDown ? 'bg-orange-500/80' : trendUp ? 'bg-emerald-500/80' : 'bg-sky-500/80'
                )}
                style={{ height: `${height}%` }}
              />
            </div>
            <span className="text-[10px] leading-none text-muted-foreground">{w.label}</span>
            <span className="text-[11px] font-semibold tabular-nums text-foreground/90">
              {formatNum(w.value, 1)}
            </span>
          </div>
        )
      })}
      <div className="ml-1 flex flex-col justify-center gap-0.5 border-l border-border/60 pl-3">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">加权 DMS</div>
        <div className="text-sm font-bold tabular-nums text-foreground">
          {formatNum(row.weighted_dms)}
        </div>
        <div className="flex items-center gap-1 text-[11px]">
          {trendLabel ? (
            <>
              {trendDown ? (
                <TrendingDown className="h-3 w-3 text-orange-500" />
              ) : trendUp ? (
                <TrendingUp className="h-3 w-3 text-emerald-500" />
              ) : (
                <Minus className="h-3 w-3 text-slate-400" />
              )}
              <span
                className={cn(
                  'font-medium',
                  trendDown
                    ? 'text-orange-600 dark:text-orange-300'
                    : trendUp
                      ? 'text-emerald-600 dark:text-emerald-300'
                      : 'text-muted-foreground'
                )}
              >
                {trendLabel}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">--</span>
          )}
          {momentum && momentum !== 'stable' ? (
            <span className="text-[10px] text-muted-foreground">
              · {MOMENTUM_LABELS[momentum] ?? momentum}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** 库龄分布条（signals.aging_share） */
function AgingBar({ row }: { row: CockpitRow }) {
  const share = row.signals?.aging_share
  const buckets = [
    { key: '0_90', label: '0-90', color: 'bg-emerald-500' },
    { key: '91_180', label: '91-180', color: 'bg-sky-500' },
    { key: '181_270', label: '181-270', color: 'bg-amber-400' },
    { key: '271_365', label: '271-365', color: 'bg-orange-500' },
    { key: '365_plus', label: '365+', color: 'bg-rose-500' },
  ]
  const hasData = share && Object.values(share).some((v) => v > 0)

  if (!hasData) {
    return (
      <div className="text-[11px] text-muted-foreground/70">
        库龄数据缺失（可售 {formatInt(row.available_inventory)}）
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={80}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex w-full items-center gap-2">
            <div className="flex h-2.5 flex-1 gap-px overflow-hidden rounded-full bg-[hsl(var(--surface-strong))] dark:bg-[hsl(var(--surface-overlay))]">
              {buckets.map((b) => {
                const pct = share?.[b.key] ?? 0
                if (pct <= 0) return null
                return (
                  <div
                    key={b.key}
                    className={cn('h-full', b.color, pct >= 0.5 ? 'opacity-100' : 'opacity-80')}
                    style={{ width: `${pct * 100}%` }}
                  />
                )
              })}
            </div>
            <span className="whitespace-nowrap text-[11px] text-muted-foreground">库龄</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[260px] space-y-1">
          {buckets.map((b) => {
            const pct = share?.[b.key] ?? 0
            if (pct <= 0) return null
            return (
              <div key={b.key} className="flex items-center justify-between gap-4 text-xs">
                <span className="flex items-center gap-1.5">
                  <span className={cn('inline-block h-2 w-2 rounded-full', b.color)} />
                  {b.label} 天
                </span>
                <span className="font-semibold tabular-nums">{formatPercent(pct)}</span>
              </div>
            )
          })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** 库存周期时间轴：补货指令 → 建仓 → 发货 → 售罄（含在途优先） */
function CycleTimeline({ row }: { row: CockpitRow }) {
  const anchors = [
    { label: '补货指令', date: shortDate(row.replenishment_order_date) },
    { label: '建仓指令', date: shortDate(row.warehouse_entry_date) },
    { label: '发货指令', date: shortDate(row.shipment_order_date) },
    { label: '售罄', date: shortDate(row.sellout_date_with_transit ?? row.sellout_date) },
  ]
  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  return (
    <div className="flex items-center">
      {anchors.map((a, i) => {
        // 判断该锚点日期是否已过今天（用 yyyy-mm-dd 字符串比较）
        const anchorFull =
          [row.replenishment_order_date, row.warehouse_entry_date, row.shipment_order_date, row.sellout_date_with_transit ?? row.sellout_date][i] ?? null
        const anchorPast = anchorFull !== null && anchorFull < todayStr
        const isSellout = i === 3
        return (
          <div key={a.label} className="flex items-center">
            {i > 0 && <div className="mx-1 h-px w-6 bg-border/60 sm:w-10" />}
            <div className="flex flex-col items-center gap-1">
              <span
                className={cn(
                  'flex h-2.5 w-2.5 rounded-full border',
                  anchorPast
                    ? 'border-rose-400 bg-rose-400/60 dark:border-rose-500 dark:bg-rose-500/60'
                    : isSellout
                      ? 'border-foreground/50 bg-foreground/70 dark:border-foreground/60 dark:bg-foreground/70'
                      : 'border-border bg-[hsl(var(--surface-strong))] dark:bg-[hsl(var(--surface-overlay))]'
                )}
              />
              <span
                className={cn(
                  'whitespace-nowrap text-[10px] leading-none',
                  anchorPast ? 'font-medium text-rose-600 dark:text-rose-300' : 'text-muted-foreground'
                )}
              >
                {a.label}
              </span>
              <span className="whitespace-nowrap text-[11px] font-semibold tabular-nums text-foreground/90">
                {a.date ?? '--'}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 信号行：季节性 / 置信度 / 数据新鲜度 */
function SignalRow({ row }: { row: CockpitRow }) {
  const s = row.signals
  const phase = s?.seasonal_phase
  const factor = s?.seasonal_factor
  const confidence = s?.confidence
  const freshness = s?.data_freshness_days ?? 0
  const freshnessTone =
    freshness <= 1
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
      : freshness <= 3
        ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
        : 'bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300'

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {phase && phase !== 'unknown' ? (
        <span className="flex items-center gap-1 text-[11px] text-foreground/80">
          <span className="text-xs">{SEASONAL_EMOJI[phase] ?? '?'}</span>
          季节性
          <span className="font-semibold text-foreground">
            {SEASONAL_LABELS[phase] ?? phase}
          </span>
          {factor !== null && factor !== undefined && (
            <span className="tabular-nums text-muted-foreground">×{formatNum(factor)}</span>
          )}
        </span>
      ) : (
        <span className="text-[11px] text-muted-foreground/70">季节性 未知</span>
      )}
      <span className="flex items-center gap-1.5 text-[11px] text-foreground/80">
        <span
          className={cn(
            'inline-block h-1.5 w-1.5 rounded-full',
            confidence === 'high'
              ? 'bg-emerald-500'
              : confidence === 'medium'
                ? 'bg-amber-400'
                : 'bg-slate-400'
          )}
        />
        置信度
        <span className="font-medium text-foreground">
          {CONFIDENCE_LABELS[confidence ?? ''] ?? confidence ?? '--'}
        </span>
      </span>
      <span
        className={cn(
          'rounded-full px-2 py-0.5 text-[11px] font-medium',
          freshnessTone
        )}
      >
        数据 {freshness} 天前
      </span>
    </div>
  )
}

/** 决策依据（BLF-502 decision_path）：为什么是这个 state/action */
function DecisionBasisChip({ path }: { path: CockpitDecisionPath }) {
  const stateRule = path.state_rule
  const actionRule = path.action_rule
  const subtype = path.critical_subtype
  const override = path.seasonal_override
  const phase = path.seasonal_phase_used

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-full border border-border/60 bg-[hsl(var(--surface-soft))] px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-[hsl(var(--surface-panel))] hover:text-foreground dark:border-border/80 dark:bg-[hsl(var(--surface-strong))] dark:hover:bg-[hsl(var(--surface-overlay))]"
        >
          <CircleHelp className="h-3 w-3" />
          决策依据
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-[300px] space-y-2.5">
        <div className="text-xs font-semibold text-foreground">决策依据 · 为什么这么判</div>
        {stateRule ? (
          <div className="space-y-0.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              状态判定 · {stateRule}
            </div>
            <div className="text-xs text-foreground/90">
              {STATE_RULE_LABELS[stateRule] ?? '未知规则'}
            </div>
          </div>
        ) : null}
        {subtype ? (
          <div className="text-xs text-muted-foreground">
            状态类型：{CRITICAL_SUBTYPE_LABELS[subtype] ?? subtype}
          </div>
        ) : null}
        {actionRule ? (
          <div className="space-y-0.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              行动判定 · {actionRule}
            </div>
            <div className="text-xs text-foreground/90">
              {ACTION_RULE_LABELS[actionRule] ?? '未知分支'}
            </div>
          </div>
        ) : null}
        {override ? (
          <div className="rounded-md bg-amber-100/70 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            {phase && phase !== 'unknown' ? (
              <span className="mr-1">
                {SEASONAL_EMOJI[phase] ?? '?'} {SEASONAL_LABELS[phase] ?? phase}
              </span>
            ) : null}
            季节性覆盖：系统按季节策略调整了行动建议
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

export function DecisionCard({
  row,
  edit,
  isSnapshotMode,
  saving,
  onEditChange,
  onSave,
  onOpenShipments,
}: DecisionCardProps) {
  const state = row.inventory_state ?? 'unknown'
  const theme = STATE_THEME[state] ?? STATE_THEME.unknown
  const action = row.replenishment_action ?? 'NO_ACTION'
  const actionTheme = ACTION_THEME[action] ?? ACTION_THEME.NO_ACTION

  return (
    <div
      className={cn(
        'group relative flex flex-col gap-3 overflow-hidden rounded-xl border border-border/70 bg-[hsl(var(--surface-panel))] p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-raised dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]',
        theme.rail === 'bg-rose-500' && 'hover:border-rose-300/70 dark:hover:border-rose-800/60',
        theme.rail === 'bg-orange-500' && 'hover:border-orange-300/70 dark:hover:border-orange-800/60',
        theme.rail === 'bg-amber-400' && 'hover:border-amber-300/70 dark:hover:border-amber-800/60',
        theme.rail === 'bg-emerald-500' && 'hover:border-emerald-300/70 dark:hover:border-emerald-800/60'
      )}
    >
      {/* 状态 rail */}
      <div className={cn('absolute inset-y-0 left-0 w-1 rounded-l-xl', theme.rail)} />

      {/* 头部：SKU + 双徽章 */}
      <div className="flex items-start justify-between gap-3 pl-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-sm font-bold tracking-tight text-foreground">
              {row.sku}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">{row.country}</span>
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {row.product_name || row.asin || '--'}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant="outline" className={cn('gap-1 text-xs', theme.softBg, theme.text)}>
            <span className={cn('inline-block h-1.5 w-1.5 rounded-full', theme.dot)} />
            {STATE_LABELS[state] ?? state}
          </Badge>
          <Badge variant="outline" className={cn('text-xs', actionTheme.badge)}>
            {ACTION_LABELS[action] ?? action}
          </Badge>
          {row.decision_path ? <DecisionBasisChip path={row.decision_path} /> : null}
        </div>
      </div>

      {/* 库存三件套 */}
      <div className="grid grid-cols-3 gap-2 pl-2">
        <div className="rounded-lg bg-[hsl(var(--surface-soft))] px-2.5 py-1.5 dark:bg-[hsl(var(--surface-strong))]">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">可售</div>
          <div className="text-base font-bold tabular-nums text-foreground">
            {formatInt(row.available_inventory)}
          </div>
        </div>
        <div className="rounded-lg bg-[hsl(var(--surface-soft))] px-2.5 py-1.5 dark:bg-[hsl(var(--surface-strong))]">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">在途</div>
          <div className="text-base font-bold tabular-nums text-foreground">
            {formatInt(row.in_transit_quantity)}
          </div>
        </div>
        <div className="rounded-lg bg-[hsl(var(--surface-soft))] px-2.5 py-1.5 dark:bg-[hsl(var(--surface-strong))]">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">可售天数</div>
          <div
            className={cn(
              'text-base font-bold tabular-nums',
              (row.sellable_days ?? 999) < 14
                ? 'text-rose-600 dark:text-rose-300'
                : (row.sellable_days ?? 999) < 30
                  ? 'text-orange-600 dark:text-orange-300'
                  : 'text-foreground'
            )}
          >
            {formatNum(row.sellable_days, 0)}
          </div>
        </div>
      </div>

      {/* 库龄条 */}
      <div className="pl-2">
        <AgingBar row={row} />
      </div>

      {/* DMS + 趋势 */}
      <div className="pl-2">
        <DmsBars row={row} />
      </div>

      {/* 库存周期时间轴 */}
      <div className="overflow-x-auto rounded-lg border border-border/60 bg-[hsl(var(--surface-soft))]/60 px-3 py-2.5 dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]/50">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            库存周期
          </span>
          <span className="text-[10px] text-muted-foreground/70">
            今天 {shortDate(row.risk_anchor_date) ?? '--'}
          </span>
        </div>
        <CycleTimeline row={row} />
      </div>

      {/* 信号行 */}
      <div className="border-t border-border/60 px-2 pt-2.5 dark:border-border/80">
        <SignalRow row={row} />
      </div>

      {/* 设置三件套 + 操作 */}
      <div className="flex flex-wrap items-end gap-2 border-t border-border/60 pt-2.5 pl-2 dark:border-border/80">
        <div className="space-y-1">
          <div className="text-[10px] text-muted-foreground">生产交货</div>
          {isSnapshotMode ? (
            <div className="flex h-8 items-center text-sm text-foreground/90">
              {row.production_lead_days} 天
            </div>
          ) : (
            <Input
              value={edit.production_lead_days}
              onChange={(e) => onEditChange({ production_lead_days: e.target.value })}
              className="h-8 w-[68px] rounded-md border-border/70 bg-[hsl(var(--surface-panel))] text-xs shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground"
            />
          )}
        </div>
        <div className="space-y-1">
          <div className="text-[10px] text-muted-foreground">运输时间</div>
          {isSnapshotMode ? (
            <div className="flex h-8 items-center text-sm text-foreground/90">
              {row.shipping_days} 天
            </div>
          ) : (
            <Input
              value={edit.shipping_days}
              onChange={(e) => onEditChange({ shipping_days: e.target.value })}
              className="h-8 w-[68px] rounded-md border-border/70 bg-[hsl(var(--surface-panel))] text-xs shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground"
            />
          )}
        </div>
        <div className="space-y-1">
          <div className="text-[10px] text-muted-foreground">加权系数</div>
          {isSnapshotMode ? (
            <div className="flex h-8 items-center text-sm text-foreground/90">
              {formatNum(row.safety_factor, 0)}%
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <Input
                value={edit.safety_factor}
                onChange={(e) => onEditChange({ safety_factor: e.target.value })}
                className="h-8 w-[56px] rounded-md border-border/70 bg-[hsl(var(--surface-panel))] text-xs shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground"
              />
              <span className="text-xs text-muted-foreground">%</span>
            </div>
          )}
        </div>
        <div className="ml-auto flex gap-1.5">
          {!isSnapshotMode && (
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs dark:bg-[hsl(var(--surface-strong))] dark:text-foreground"
              onClick={onSave}
              disabled={saving}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              保存
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground"
            onClick={onOpenShipments}
          >
            <Send className="h-3.5 w-3.5" />
            发货
          </Button>
        </div>
      </div>
    </div>
  )
}
