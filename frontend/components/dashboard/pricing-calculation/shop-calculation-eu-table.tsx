'use client'

import { Calculator, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
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
  delivery_fee_usd: string
  inbound_config_fee_usd: string
  storage_fee_usd: string
  usd_to_rmb_rate: string
}

type StoreSkuRowState = {
  draft: StoreSkuDraft
  loading: boolean
  result: PricingCalculationRunItem | null
  error: string | null
}

type ShopCalculationEuTableProps = {
  items: ProductCostItem[]
  rowStates: Record<number, StoreSkuRowState>
  onDraftChange: (
    rowId: number,
    key: keyof StoreSkuDraft,
    value: string,
  ) => void
  onCalculate: (item: ProductCostItem) => void
  systemExchangeRate: string
  selectedCountry: string
}

function buildInitialDraft(item: ProductCostItem): StoreSkuDraft {
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
    delivery_fee_usd: '0',
    inbound_config_fee_usd: '0',
    storage_fee_usd: '0',
    usd_to_rmb_rate: '',
  }
}

function getCurrencySymbol(country?: string) {
  if (country === 'DE') return '€'
  if (country === 'UK') return '£'
  return '$'
}

function formatCurrency(value: number, country?: string) {
  return `${getCurrencySymbol(country)}${value.toFixed(2)}`
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
 * Unified semantic color system — mirrors shop-calculation-table.tsx.
 * Provides consistent group header colors across both US and EU tables.
 */
const GROUP_COLORS = {
  店铺产品: {
    light: { header: 'bg-[#e0e7ff] text-[#1e1b4b]', sub: 'bg-[#eef2ff]' },
    dark:  { header: 'bg-[#312e81] text-[#e0e7ff]', sub: 'bg-[#1e1b4b]/80' },
  },
  货品数据: {
    light: { header: 'bg-[#e0f2fe] text-[#0c4a6e]', sub: 'bg-[#f0f9ff]' },
    dark:  { header: 'bg-[#0c4a6e] text-[#e0f2fe]', sub: 'bg-[#082f49]/80' },
  },
  'DDP 成本': {
    light: { header: 'bg-[#fef3c7] text-[#78350f]', sub: 'bg-[#fffbeb]' },
    dark:  { header: 'bg-[#78350f] text-[#fef3c7]', sub: 'bg-[#451a03]/80' },
  },
  费用支出: {
    light: { header: 'bg-[#ffe4e6] text-[#881337]', sub: 'bg-[#fff1f2]' },
    dark:  { header: 'bg-[#881337] text-[#ffe4e6]', sub: 'bg-[#4c0519]/80' },
  },
  利润核算: {
    light: { header: 'bg-[#d1fae5] text-[#064e3b]', sub: 'bg-[#ecfdf5]' },
    dark:  { header: 'bg-[#064e3b] text-[#d1fae5]', sub: 'bg-[#022c22]/80' },
  },
  操作: {
    light: { header: 'bg-[hsl(var(--surface-subtle))] text-[hsl(var(--foreground))]', sub: 'bg-[hsl(var(--surface-subtle))]' },
    dark:  { header: 'bg-[hsl(var(--surface-soft))] text-[hsl(var(--foreground))]', sub: 'bg-[hsl(var(--surface-soft))]' },
  },
} as const

function getGroupStyle(
  group: keyof typeof GROUP_COLORS,
  variant: 'header' | 'sub',
) {
  return GROUP_COLORS[group]?.light[variant] ?? ''
}

export function ShopCalculationEuTable({
  items,
  rowStates,
  onDraftChange,
  onCalculate,
  systemExchangeRate,
  selectedCountry,
}: ShopCalculationEuTableProps) {
  const compactInputClassName =
    'h-8 w-[52px] min-w-[52px] rounded-sm border border-input bg-background px-1.5 text-center text-xs tabular-nums [-moz-appearance:textfield] appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none focus-visible:border-[hsl(var(--ring))] focus-visible:ring-1 focus-visible:ring-[hsl(var(--ring)/0.25)] sm:w-[60px] sm:min-w-[60px]'

  return (
    <Table
      className='w-max min-w-full text-xs'
      containerClassName='max-h-[72vh] overflow-auto'
    >
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
          <TableHead colSpan={4} className={cn('px-3 py-2.5 text-center font-semibold', getGroupStyle('利润核算', 'header'))}>
            利润核算
          </TableHead>
          <TableHead colSpan={2} className={cn('px-3 py-2.5 text-center font-semibold', getGroupStyle('操作', 'header'))}>
            操作
          </TableHead>
        </TableRow>
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
            DDP({selectedCountry === 'DE' ? 'EUR' : selectedCountry === 'UK' ? 'GBP' : 'USD'})
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('DDP 成本', 'sub'))}>
            汇率
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            售价({selectedCountry === 'DE' ? 'EUR' : selectedCountry === 'UK' ? 'GBP' : 'USD'})
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            平台佣金
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            广告费率%
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            广告费
          </TableHead>
          <TableHead className={cn('min-w-[96px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            退货率%
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            退货损失
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            派送费
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            配置费
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            仓储费
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('费用支出', 'sub'))}>
            费用合计
          </TableHead>
          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('利润核算', 'sub'))}>
            回款
          </TableHead>
          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('利润核算', 'sub'))}>
            增值税
          </TableHead>
          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('利润核算', 'sub'))}>
            利润(扣税)
          </TableHead>
          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]', getGroupStyle('利润核算', 'sub'))}>
            利润率(扣税)
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
          const draft = rowState?.draft ?? buildInitialDraft(item)
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

          const profitAfterVat = result?.profit?.profit_after_vat_usd
          const profitRateAfterVat = result?.profit?.profit_after_vat_rate

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

              {/* L/W/H/Weight */}
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input type='number' step='0.01' className={compactInputClassName} value={draft.package_length_cm} onChange={(event) => onDraftChange(item.id, 'package_length_cm', event.target.value)} />
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input type='number' step='0.01' className={compactInputClassName} value={draft.package_width_cm} onChange={(event) => onDraftChange(item.id, 'package_width_cm', event.target.value)} />
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input type='number' step='0.01' className={compactInputClassName} value={draft.package_height_cm} onChange={(event) => onDraftChange(item.id, 'package_height_cm', event.target.value)} />
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input type='number' step='0.001' className={compactInputClassName} value={draft.weight_kg} onChange={(event) => onDraftChange(item.id, 'weight_kg', event.target.value)} />
              </TableCell>
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
                {ddpUsd !== null ? formatCurrency(ddpUsd, selectedCountry) : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input
                  type='number'
                  step='0.0001'
                  className={compactInputClassName}
                  value={draft.usd_to_rmb_rate}
                  onChange={(event) => onDraftChange(item.id, 'usd_to_rmb_rate', event.target.value)}
                  placeholder={result ? formatMetric(result.usd_to_rmb_rate, 4) : systemExchangeRate || '自动'}
                />
              </TableCell>

              {/* 费用支出 */}
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input type='number' step='0.01' className={compactInputClassName} value={draft.sale_price_usd} onChange={(event) => onDraftChange(item.id, 'sale_price_usd', event.target.value)} />
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>
                {result?.fees?.platform_fee_usd != null ? formatCurrency(result.fees.platform_fee_usd, selectedCountry) : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input type='number' step='0.01' className={compactInputClassName} value={draft.advertising_rate} onChange={(event) => onDraftChange(item.id, 'advertising_rate', event.target.value)} />
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>
                {result ? formatCurrency(result.fees.advertising_fee_usd, selectedCountry) : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input type='number' step='0.01' className={compactInputClassName} value={draft.return_loss_rate} onChange={(event) => onDraftChange(item.id, 'return_loss_rate', event.target.value)} />
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>
                {result ? formatCurrency(result.fees.return_loss_usd, selectedCountry) : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input type='number' step='0.01' className={compactInputClassName} value={draft.delivery_fee_usd} onChange={(event) => onDraftChange(item.id, 'delivery_fee_usd', event.target.value)} placeholder='0' />
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input type='number' step='0.01' className={compactInputClassName} value={draft.inbound_config_fee_usd} onChange={(event) => onDraftChange(item.id, 'inbound_config_fee_usd', event.target.value)} placeholder='0' />
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                <Input type='number' step='0.01' className={compactInputClassName} value={draft.storage_fee_usd} onChange={(event) => onDraftChange(item.id, 'storage_fee_usd', event.target.value)} placeholder='0' />
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>
                {result ? formatCurrency(result.fees.total_fee_usd, selectedCountry) : <span className='text-muted-foreground'>—</span>}
              </TableCell>

              {/* 利润核算 */}
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right font-medium tabular-nums'>
                {result ? formatCurrency(result.profit.payout_usd, selectedCountry) : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>
                {result?.profit?.vat_usd && result.profit.vat_usd > 0 ? (
                  <div className='tabular-nums'>{formatCurrency(result.profit.vat_usd, selectedCountry)}</div>
                ) : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className={cn(
                'whitespace-nowrap border-r px-3 py-2 text-right font-semibold tabular-nums',
                profitAfterVat !== undefined && profitAfterVat !== null
                  ? profitAfterVat >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                  : 'text-muted-foreground',
              )}>
                {profitAfterVat !== undefined && profitAfterVat !== null
                  ? formatCurrency(profitAfterVat, selectedCountry)
                  : result?.profit?.profit_usd !== undefined
                    ? formatCurrency(result.profit.profit_usd, selectedCountry)
                    : <span className='text-muted-foreground'>—</span>}
              </TableCell>
              <TableCell className={cn(
                'whitespace-nowrap border-r px-3 py-2 text-right font-semibold tabular-nums',
                profitRateAfterVat !== undefined && profitRateAfterVat !== null
                  ? profitRateAfterVat >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                  : 'text-muted-foreground',
              )}>
                {profitRateAfterVat !== undefined && profitRateAfterVat !== null
                  ? formatPercent(profitRateAfterVat)
                  : <span className='text-muted-foreground'>—</span>}
              </TableCell>

              {/* 状态 */}
              <TableCell className='px-3 py-2 text-center'>
                {rowState?.error ? (
                  <div className='mx-auto max-w-[88px] rounded-md bg-destructive/10 px-1.5 py-1 text-[11px] leading-4 text-destructive'>
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
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
