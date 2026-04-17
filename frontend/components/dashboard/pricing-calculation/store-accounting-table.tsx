'use client'

import { Calculator, Loader2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  STICKY_LEFT_HEAD_CELL,
  STICKY_TOP_GROUP_ROW,
  STICKY_TOP_SUB_ROW,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { PricingCalculationRunItem, ProductCostItem } from '@/lib/pricing-calculation-types'

type StoreSkuDraft = {
  package_length_cm: string
  package_width_cm: string
  package_height_cm: string
  weight_kg: string
  first_leg_cost_rmb: string
  sale_price_usd: string
  advertising_rate: string
  return_loss_rate: string
  storage_months: string
  inbound_placement_mode: 'single_destination' | 'amazon_optimized_split'
  usd_to_rmb_rate: string
}

type StoreSkuRowState = {
  draft: StoreSkuDraft
  loading: boolean
  result: PricingCalculationRunItem | null
  error: string | null
}

type StoreAccountingTableProps = {
  items: ProductCostItem[]
  rowStates: Record<number, StoreSkuRowState>
  onDraftChange: (
    rowId: number,
    key: keyof StoreSkuDraft,
    value: string,
  ) => void
  onCalculate: (
    item: ProductCostItem,
  ) => void
  systemExchangeRate: string
}

function buildInitialStoreDraft(item: ProductCostItem): StoreSkuDraft {
  return {
    package_length_cm:
      item.package_length_cm > 0 ? String(item.package_length_cm) : '',
    package_width_cm:
      item.package_width_cm > 0 ? String(item.package_width_cm) : '',
    package_height_cm:
      item.package_height_cm > 0 ? String(item.package_height_cm) : '',
    weight_kg: item.weight_kg > 0 ? String(item.weight_kg) : '',
    first_leg_cost_rmb:
      item.first_leg_cost_rmb > 0 ? String(item.first_leg_cost_rmb) : '5',
    sale_price_usd: '',
    advertising_rate: '12',
    return_loss_rate: '4',
    storage_months: '1',
    inbound_placement_mode: 'single_destination',
    usd_to_rmb_rate: '',
  }
}

function formatCurrency(value: number) {
  return `$${value.toFixed(2)}`
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`
}

function formatMetric(value: number, digits = 4) {
  return value.toFixed(digits)
}

function toNumber(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Semantic color system for table group headers.
 * Mirrors the EU table for visual consistency.
 */
const GROUP_COLORS = {
  店铺产品: {
    header: 'bg-[#e0e7ff] text-[#1e1b4b] dark:bg-[#312e81] dark:text-[#e0e7ff]',
    sub: 'bg-[#eef2ff] dark:bg-[#1e1b4b]/80',
  },
  货品数据: {
    header: 'bg-[#e0f2fe] text-[#0c4a6e] dark:bg-[#0c4a6e] dark:text-[#e0f2fe]',
    sub: 'bg-[#f0f9ff] dark:bg-[#082f49]/80',
  },
  'DDP 成本': {
    header: 'bg-[#fef3c7] text-[#78350f] dark:bg-[#78350f] dark:text-[#fef3c7]',
    sub: 'bg-[#fffbeb] dark:bg-[#451a03]/80',
  },
  费用支出: {
    header: 'bg-[#ffe4e6] text-[#881337] dark:bg-[#881337] dark:text-[#ffe4e6]',
    sub: 'bg-[#fff1f2] dark:bg-[#4c0519]/80',
  },
  利润核算: {
    header: 'bg-[#d1fae5] text-[#064e3b] dark:bg-[#064e3b] dark:text-[#d1fae5]',
    sub: 'bg-[#ecfdf5] dark:bg-[#022c22]/80',
  },
  产品核定: {
    header: 'bg-[#ede9fe] text-[#4c1d95] dark:bg-[#4c1d95] dark:text-[#ede9fe]',
    sub: 'bg-[#f5f3ff] dark:bg-[#2e1065]/80',
  },
  操作: {
    header: 'bg-[hsl(var(--surface-subtle))] text-[hsl(var(--foreground))] dark:bg-[hsl(var(--surface-soft))]',
    sub: 'bg-[hsl(var(--surface-subtle))] dark:bg-[hsl(var(--surface-soft))]',
  },
} as const

function getGroupStyle(
  group: keyof typeof GROUP_COLORS,
  variant: 'header' | 'sub',
) {
  return GROUP_COLORS[group]?.[variant] ?? ''
}

export function StoreAccountingTable({
  items,
  rowStates,
  onDraftChange,
  onCalculate,
  systemExchangeRate,
}: StoreAccountingTableProps) {
  const compactInputClassName =
    'h-8 w-[52px] min-w-[52px] rounded-sm border border-input bg-background px-1.5 text-center text-xs tabular-nums [-moz-appearance:textfield] appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none focus-visible:border-[hsl(var(--ring))] focus-visible:ring-1 focus-visible:ring-[hsl(var(--ring)/0.25)] sm:w-[60px] sm:min-w-[60px]'
  const compactSelectClassName =
    'flex h-8 w-[84px] min-w-[84px] rounded-md border border-input bg-background px-1.5 py-1 text-xs ring-offset-background focus-visible:border-[hsl(var(--ring))] focus-visible:ring-1 focus-visible:ring-[hsl(var(--ring)/0.25)] sm:w-[96px] sm:min-w-[96px]'

  return (
    <Table
      className='w-max min-w-full text-xs'
      noWrapperRounded={true}
      containerClassName='max-h-[72vh] overflow-auto'
    >
      {/* Group-level header row */}
      <TableHeader>
        <TableRow className={STICKY_TOP_GROUP_ROW}>
          <TableHead colSpan={1} className={cn('sticky left-0 z-[60] border-r px-3 py-2.5 text-center font-semibold shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('店铺产品', 'header'))}>
            店铺产品
          </TableHead>
          <TableHead colSpan={6} className={cn('border-r px-3 py-2.5 text-center font-semibold shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('货品数据', 'header'))}>
            货品数据
          </TableHead>
          <TableHead colSpan={4} className={cn('border-r px-3 py-2.5 text-center font-semibold shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('DDP 成本', 'header'))}>
            DDP 成本
          </TableHead>
          <TableHead colSpan={10} className={cn('border-r px-3 py-2.5 text-center font-semibold shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'header'))}>
            费用支出
          </TableHead>
          <TableHead colSpan={4} className={cn('border-r px-3 py-2.5 text-center font-semibold shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('利润核算', 'header'))}>
            利润核算
          </TableHead>
          <TableHead colSpan={3} className={cn('border-r px-3 py-2.5 text-center font-semibold shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('产品核定', 'header'))}>
            产品核定
          </TableHead>
          <TableHead colSpan={2} className={cn('px-3 py-2.5 text-center font-semibold', getGroupStyle('操作', 'header'))}>
            操作
          </TableHead>
        </TableRow>
        {/* Column-level sub-header row */}
        <TableRow className={STICKY_TOP_SUB_ROW}>
          <TableHead className={cn('sticky left-0 z-[55] min-w-[160px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('店铺产品', 'sub'))}>
            SKU / 项目
          </TableHead>
          <TableHead className={cn('min-w-[86px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('货品数据', 'sub'))}>
            FOB(RMB)
          </TableHead>
          <TableHead className={cn('min-w-[84px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('货品数据', 'sub'))}>
            长(cm)
          </TableHead>
          <TableHead className={cn('min-w-[84px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('货品数据', 'sub'))}>
            宽(cm)
          </TableHead>
          <TableHead className={cn('min-w-[84px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('货品数据', 'sub'))}>
            高(cm)
          </TableHead>
          <TableHead className={cn('min-w-[84px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('货品数据', 'sub'))}>
            重量(kg)
          </TableHead>
          <TableHead className={cn('min-w-[96px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('货品数据', 'sub'))}>
            计费重
          </TableHead>
          <TableHead className={cn('min-w-[96px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('DDP 成本', 'sub'))}>
            头程(RMB)
          </TableHead>
          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('DDP 成本', 'sub'))}>
            DDP(RMB)
          </TableHead>
          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('DDP 成本', 'sub'))}>
            DDP(USD)
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('DDP 成本', 'sub'))}>
            汇率
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            售价(USD)
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            广告费率%
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            广告费
          </TableHead>
          <TableHead className={cn('min-w-[96px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            退货折损率%
          </TableHead>
          <TableHead className={cn('min-w-[96px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            退货损耗
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            佣金
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            派送费
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            配置费
          </TableHead>
          <TableHead className={cn('min-w-[84px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            仓储月数
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            仓储费
          </TableHead>
          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('利润核算', 'sub'))}>
            费用合计
          </TableHead>
          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('利润核算', 'sub'))}>
            回款
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('利润核算', 'sub'))}>
            利润
          </TableHead>
          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('利润核算', 'sub'))}>
            利润率
          </TableHead>
          <TableHead className={cn('min-w-[112px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('产品核定', 'sub'))}>
            尺寸等级
          </TableHead>
          <TableHead className={cn('min-w-[112px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('产品核定', 'sub'))}>
            售价带
          </TableHead>
          <TableHead className={cn('min-w-[208px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('产品核定', 'sub'))}>
            规则
          </TableHead>
          <TableHead className={cn('min-w-[100px] whitespace-nowrap px-3 py-2 text-center', getGroupStyle('操作', 'sub'))}>
            状态
          </TableHead>
          <TableHead className={cn('min-w-[108px] whitespace-nowrap px-3 py-2 text-center', getGroupStyle('操作', 'sub'))}>
            测算
          </TableHead>
        </TableRow>
      </TableHeader>

      <TableBody>
        {items.map((item, idx) => {
          const rowState = rowStates[item.id]
          const draft = rowState?.draft ?? buildInitialStoreDraft(item)
          const volumeKg =
            (toNumber(draft.package_length_cm) *
              toNumber(draft.package_width_cm) *
              toNumber(draft.package_height_cm)) /
            6000
          const chargeableKg = Math.max(toNumber(draft.weight_kg), volumeKg)
          const firstLegCost = toNumber(draft.first_leg_cost_rmb)
          const result = rowState?.result
          const exchangeRate = draft.usd_to_rmb_rate
            ? toNumber(draft.usd_to_rmb_rate)
            : (result?.usd_to_rmb_rate
                ? result.usd_to_rmb_rate
                : toNumber(systemExchangeRate))
          const ddpRmb =
            item.fob_unit_cost > 0 && firstLegCost > 0
              ? item.fob_unit_cost + firstLegCost
              : null
          const ddpUsd =
            ddpRmb && exchangeRate > 0 ? ddpRmb / exchangeRate : null

          return (
            <TableRow
              key={item.id}
              className={cn(
                'align-middle transition-colors duration-75 hover:bg-[hsl(var(--surface-subtle)/0.7)]',
                idx % 2 === 1 && 'bg-[hsl(var(--surface-subtle)/0.35)]',
              )}
            >
              {/* SKU / 项目 */}
              <TableCell className={cn('sticky left-0 z-20 whitespace-nowrap border-r bg-white px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))] dark:bg-[hsl(var(--surface-base))]', getGroupStyle('店铺产品', 'sub'))}>
                <div className='min-w-[136px]'>
                  <p className='truncate font-semibold text-foreground'>{item.sku}</p>
                  <p className='truncate text-[11px] text-muted-foreground'>{item.project_name}</p>
                </div>
              </TableCell>

              {/* FOB */}
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right font-medium tabular-nums'>
                {item.fob_unit_cost > 0 ? item.fob_unit_cost.toFixed(2) : <span className='text-muted-foreground'>—</span>}
              </TableCell>

              {/* L / W / H / Weight */}
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input type='number' step='0.01' className={compactInputClassName} value={draft.package_length_cm} onChange={(e) => onDraftChange(item.id, 'package_length_cm', e.target.value)} />
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input type='number' step='0.01' className={compactInputClassName} value={draft.package_width_cm} onChange={(e) => onDraftChange(item.id, 'package_width_cm', e.target.value)} />
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input type='number' step='0.01' className={compactInputClassName} value={draft.package_height_cm} onChange={(e) => onDraftChange(item.id, 'package_height_cm', e.target.value)} />
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input type='number' step='0.001' className={compactInputClassName} value={draft.weight_kg} onChange={(e) => onDraftChange(item.id, 'weight_kg', e.target.value)} />
              </TableCell>

              {/* 计费重 */}
              <TableCell className={cn('whitespace-nowrap border-r px-3 py-2 text-right tabular-nums', chargeableKg > toNumber(draft.weight_kg) ? 'text-amber-600 dark:text-amber-400' : '')}>
                {formatMetric(chargeableKg, 2)} kg
              </TableCell>

              {/* DDP */}
              <TableCell className={cn('whitespace-nowrap border-r px-3 py-2 text-right tabular-nums', firstLegCost <= 0 ? 'text-amber-600 dark:text-amber-400' : '')}>
                {firstLegCost > 0 ? firstLegCost.toFixed(2) : <span className='text-[11px] text-amber-600 dark:text-amber-400'>待补</span>}
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>
                {ddpRmb !== null ? ddpRmb.toFixed(2) : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>
                {ddpUsd !== null ? formatCurrency(ddpUsd) : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input
                  type='number'
                  step='0.0001'
                  className={compactInputClassName}
                  value={draft.usd_to_rmb_rate}
                  onChange={(e) => onDraftChange(item.id, 'usd_to_rmb_rate', e.target.value)}
                  placeholder={result ? formatMetric(result.usd_to_rmb_rate, 4) : systemExchangeRate || '自动'}
                />
              </TableCell>

              {/* 费用支出 */}
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input type='number' step='0.01' className={compactInputClassName} value={draft.sale_price_usd} onChange={(e) => onDraftChange(item.id, 'sale_price_usd', e.target.value)} />
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input type='number' step='0.01' className={compactInputClassName} value={draft.advertising_rate} onChange={(e) => onDraftChange(item.id, 'advertising_rate', e.target.value)} />
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>
                {result ? formatCurrency(result.fees.advertising_fee_usd) : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input type='number' step='0.01' className={compactInputClassName} value={draft.return_loss_rate} onChange={(e) => onDraftChange(item.id, 'return_loss_rate', e.target.value)} />
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>
                {result ? formatCurrency(result.fees.return_loss_usd) : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>
                {result ? formatCurrency(result.fees.referral_fee_usd) : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>
                {result ? formatCurrency(result.fees.fba_fulfillment_fee_usd) : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>
                {result ? formatCurrency(result.fees.inbound_config_fee_usd) : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input type='number' step='0.01' className={compactInputClassName} value={draft.storage_months} onChange={(e) => onDraftChange(item.id, 'storage_months', e.target.value)} />
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>
                {result ? formatCurrency(result.fees.storage_fee_usd) : <span className='text-muted-foreground'>—</span>}
              </TableCell>

              {/* 利润核算 */}
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>
                {result ? formatCurrency(result.fees.total_fee_usd) : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right font-medium tabular-nums'>
                {result ? formatCurrency(result.profit.payout_usd) : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className={cn(
                'whitespace-nowrap border-r px-3 py-2 text-right font-semibold tabular-nums',
                !result ? 'text-muted-foreground' : result.profit.profit_usd >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
              )}>
                {result ? formatCurrency(result.profit.profit_usd) : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className={cn(
                'whitespace-nowrap border-r px-3 py-2 text-right font-semibold tabular-nums',
                !result ? 'text-muted-foreground' : result.profit.profit_rate >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
              )}>
                {result ? formatPercent(result.profit.profit_rate) : <span className='text-muted-foreground'>—</span>}
              </TableCell>

              {/* 产品核定 */}
              <TableCell className={cn('whitespace-nowrap border-r px-3 py-2', getGroupStyle('产品核定', 'sub'))}>
                {result ? (
                  <div className='leading-5'>
                    <div className='inline-block rounded-[4px] bg-[hsl(var(--primary)/0.1)] px-1.5 py-0.5 text-[11px] font-medium text-[hsl(var(--primary))]'>
                      {result.size_tier_label}
                    </div>
                  </div>
                ) : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className={cn('whitespace-nowrap border-r px-3 py-2', getGroupStyle('产品核定', 'sub'))}>
                {result ? (
                  <div className='text-[11px] text-muted-foreground'>
                    {result.price_band_label}
                  </div>
                ) : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className={cn('whitespace-nowrap border-r px-3 py-2', getGroupStyle('产品核定', 'sub'))}>
                {result ? (
                  <div className='space-y-0.5 text-[11px] text-muted-foreground'>
                    <p className='truncate'>派送: {result.fulfillment_fee_rule_label}</p>
                    <p className='truncate'>配置: {result.inbound_config_fee_rule_label}</p>
                    <p className='truncate'>仓储: {result.storage_fee_rule_label}</p>
                  </div>
                ) : <span className='text-muted-foreground'>—</span>}
              </TableCell>

              {/* 状态 */}
              <TableCell className='px-3 py-2 text-center'>
                {rowState?.error ? (
                  <div className='mx-auto max-w-[88px] truncate rounded-md bg-destructive/10 px-1.5 py-1 text-[11px] leading-4 text-destructive'>
                    {rowState.error}
                  </div>
                ) : result?.warnings.length ? (
                  <div
                    className='mx-auto max-w-[88px] truncate rounded-md bg-amber-50 px-1.5 py-1 text-[11px] leading-4 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300'
                    title={result.warnings.join('；')}
                  >
                    {result.warnings[0]}
                  </div>
                ) : result ? (
                  <span className='inline-flex items-center gap-1'>
                    <span className='h-1.5 w-1.5 rounded-full bg-emerald-500' />
                    <span className='text-[11px] text-emerald-600 dark:text-emerald-400'>已测算</span>
                  </span>
                ) : (
                  <span className='text-[11px] text-muted-foreground/60'>待测算</span>
                )}
              </TableCell>

              {/* 测算按钮 */}
              <TableCell className='px-3 py-2 text-center'>
                <div className='flex flex-col items-center gap-1.5'>
                  <select
                    value={draft.inbound_placement_mode}
                    onChange={(e) => onDraftChange(item.id, 'inbound_placement_mode', e.target.value)}
                    className={compactSelectClassName}
                  >
                    <option value='single_destination'>单仓</option>
                    <option value='amazon_optimized_split'>优化拆仓</option>
                  </select>
                  <Button
                    type='button'
                    size='sm'
                    onClick={() => onCalculate(item)}
                    disabled={rowState?.loading}
                    className={cn(
                      'h-8 min-w-[92px] text-xs transition-all',
                      rowState?.result
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-900'
                        : '',
                    )}
                  >
                    {rowState?.loading ? (
                      <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                    ) : (
                      <Calculator className='mr-1.5 h-3.5 w-3.5' />
                    )}
                    测算
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
