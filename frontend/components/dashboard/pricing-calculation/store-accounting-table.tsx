'use client'

import { Calculator, Loader2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

type PricingCalculationRunItem = {
  usd_to_rmb_rate: number
  fulfillment_fee_rule_label: string
  inbound_config_fee_rule_label: string
  storage_fee_rule_label: string
  size_tier_label: string
  price_band_label: string
  warnings: string[]
  sale_price_usd: number
  fees: {
    referral_fee_usd: number
    advertising_fee_usd: number
    return_loss_usd: number
    fba_fulfillment_fee_usd: number
    inbound_config_fee_usd: number
    storage_fee_usd: number
    total_fee_usd: number
  }
  profit: {
    payout_usd: number
    profit_usd: number
    profit_rate: number
  }
}

type ProductCostItem = {
  id: number
  project_name: string
  sku: string
  fob_unit_cost: number
  first_leg_cost_rmb: number
  package_length_cm: number
  package_width_cm: number
  package_height_cm: number
  weight_kg: number
}

type StoreSkuDraft = {
  package_length_cm: string
  package_width_cm: string
  package_height_cm: string
  weight_kg: string
  first_leg_cost_rmb: string
  sale_price_usd: string
  target_profit_rate: string
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
    calculationMode: 'profit-calc' | 'profit-reverse',
  ) => void
  systemExchangeRate: string
  calculationMode: 'profit-calc' | 'profit-reverse'
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
    target_profit_rate: '25',
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

export function StoreAccountingTable({
  items,
  rowStates,
  onDraftChange,
  onCalculate,
  systemExchangeRate,
  calculationMode,
}: StoreAccountingTableProps) {
  const groupStyles: Record<string, { header: string; subHeader: string }> = {
    店铺产品: {
      header:
        'bg-indigo-100 text-indigo-950 dark:bg-indigo-950 dark:text-indigo-100',
      subHeader: 'bg-indigo-50 dark:bg-indigo-950',
    },
    货品数据: {
      header: 'bg-sky-100 text-sky-950 dark:bg-sky-950 dark:text-sky-100',
      subHeader: 'bg-sky-50 dark:bg-sky-950',
    },
    'DDP 成本': {
      header:
        'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100',
      subHeader: 'bg-amber-50 dark:bg-amber-950',
    },
    费用支出: {
      header: 'bg-rose-100 text-rose-950 dark:bg-rose-950 dark:text-rose-100',
      subHeader: 'bg-rose-50 dark:bg-rose-950',
    },
    利润核算: {
      header:
        'bg-emerald-100 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100',
      subHeader: 'bg-emerald-50 dark:bg-emerald-950',
    },
    产品核定: {
      header:
        'bg-violet-100 text-violet-950 dark:bg-violet-950 dark:text-violet-100',
      subHeader: 'bg-violet-50 dark:bg-violet-950',
    },
    操作: {
      header:
        'bg-[hsl(var(--surface-subtle))] text-foreground dark:bg-[hsl(var(--surface-soft))]',
      subHeader:
        'bg-[hsl(var(--surface-subtle))] dark:bg-[hsl(var(--surface-soft))]',
    },
  }

  const compactInputClassName =
    'h-8 w-[52px] min-w-[52px] rounded-sm border border-input bg-background px-1.5 text-center text-xs tabular-nums sm:w-[60px] sm:min-w-[60px]'
  const compactSelectClassName =
    'flex h-8 w-[84px] min-w-[84px] rounded-md border border-input bg-background px-1.5 py-1 text-xs ring-offset-background sm:w-[96px] sm:min-w-[96px]'

  return (
    <Table className='w-max min-w-full text-xs' noWrapperRounded={true}>
      <TableHeader className='bg-[hsl(var(--surface-subtle))]'>
        <TableRow className='hover:bg-transparent'>
          <TableHead colSpan={1} className={cn('sticky left-0 z-50 border-r px-3 py-2 text-center font-semibold', groupStyles['店铺产品'].header)}>店铺产品</TableHead>
          <TableHead colSpan={6} className={cn('border-r px-3 py-2 text-center font-semibold', groupStyles['货品数据'].header)}>货品数据</TableHead>
          <TableHead colSpan={4} className={cn('border-r px-3 py-2 text-center font-semibold', groupStyles['DDP 成本'].header)}>DDP 成本</TableHead>
          <TableHead colSpan={10} className={cn('border-r px-3 py-2 text-center font-semibold', groupStyles['费用支出'].header)}>费用支出</TableHead>
          <TableHead colSpan={4} className={cn('border-r px-3 py-2 text-center font-semibold', groupStyles['利润核算'].header)}>利润核算</TableHead>
          <TableHead colSpan={2} className={cn('border-r px-3 py-2 text-center font-semibold', groupStyles['产品核定'].header)}>产品核定</TableHead>
          <TableHead colSpan={2} className={cn('px-3 py-2 text-center font-semibold', groupStyles['操作'].header)}>操作</TableHead>
        </TableRow>
        <TableRow>
          <TableHead className={cn('sticky left-0 z-40 min-w-[160px] whitespace-nowrap border-r px-3 py-2', groupStyles['店铺产品'].subHeader)}>SKU / 项目</TableHead>
          <TableHead className={cn('min-w-[86px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['货品数据'].subHeader)}>FOB(RMB)</TableHead>
          <TableHead className={cn('min-w-[84px] whitespace-nowrap border-r px-3 py-2', groupStyles['货品数据'].subHeader)}>长(cm)</TableHead>
          <TableHead className={cn('min-w-[84px] whitespace-nowrap border-r px-3 py-2', groupStyles['货品数据'].subHeader)}>宽(cm)</TableHead>
          <TableHead className={cn('min-w-[84px] whitespace-nowrap border-r px-3 py-2', groupStyles['货品数据'].subHeader)}>高(cm)</TableHead>
          <TableHead className={cn('min-w-[84px] whitespace-nowrap border-r px-3 py-2', groupStyles['货品数据'].subHeader)}>重量(kg)</TableHead>
          <TableHead className={cn('min-w-[96px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['货品数据'].subHeader)}>计费重</TableHead>
          <TableHead className={cn('min-w-[96px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['DDP 成本'].subHeader)}>头程(RMB)</TableHead>
          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['DDP 成本'].subHeader)}>DDP(RMB)</TableHead>
          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['DDP 成本'].subHeader)}>DDP(USD)</TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2', groupStyles['DDP 成本'].subHeader)}>汇率</TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2', groupStyles['费用支出'].subHeader)}>
            {calculationMode === 'profit-calc' ? '售价(USD)' : '目标利润率%'}
          </TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2', groupStyles['费用支出'].subHeader)}>广告费率%</TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['费用支出'].subHeader)}>广告费</TableHead>
          <TableHead className={cn('min-w-[96px] whitespace-nowrap border-r px-3 py-2', groupStyles['费用支出'].subHeader)}>退货折损率%</TableHead>
          <TableHead className={cn('min-w-[96px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['费用支出'].subHeader)}>退货损耗</TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['费用支出'].subHeader)}>佣金</TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['费用支出'].subHeader)}>派送费</TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['费用支出'].subHeader)}>配置费</TableHead>
          <TableHead className={cn('min-w-[84px] whitespace-nowrap border-r px-3 py-2', groupStyles['费用支出'].subHeader)}>仓储月数</TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['费用支出'].subHeader)}>仓储费</TableHead>
          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['利润核算'].subHeader)}>费用合计</TableHead>
          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['利润核算'].subHeader)}>回款</TableHead>
          <TableHead className={cn('min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['利润核算'].subHeader)}>利润</TableHead>
          <TableHead className={cn('min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right', groupStyles['利润核算'].subHeader)}>利润率</TableHead>
          <TableHead className={cn('min-w-[112px] whitespace-nowrap border-r px-3 py-2', groupStyles['产品核定'].subHeader)}>尺寸等级 / 售价带</TableHead>
          <TableHead className={cn('min-w-[208px] whitespace-nowrap border-r px-3 py-2', groupStyles['产品核定'].subHeader)}>规则</TableHead>
          <TableHead className={cn('min-w-[100px] whitespace-nowrap px-3 py-2 text-center', groupStyles['操作'].subHeader)}>状态</TableHead>
          <TableHead className={cn('min-w-[108px] whitespace-nowrap px-3 py-2 text-center', groupStyles['操作'].subHeader)}>测算</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
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
            : (result?.usd_to_rmb_rate ?? 0)
          const ddpRmb =
            item.fob_unit_cost > 0 && firstLegCost > 0
              ? item.fob_unit_cost + firstLegCost
              : null
          const ddpUsd =
            ddpRmb && exchangeRate > 0 ? ddpRmb / exchangeRate : null

          return (
            <TableRow
              key={item.id}
              className='align-middle hover:bg-[hsl(var(--surface-subtle))]'
            >
              <TableCell className={cn('sticky left-0 z-20 whitespace-nowrap border-r px-3 py-2', groupStyles['店铺产品'].subHeader)}>
                <div className='min-w-[136px]'>
                  <p className='truncate font-semibold text-foreground'>{item.sku}</p>
                  <p className='truncate text-[11px] text-muted-foreground'>{item.project_name}</p>
                </div>
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right font-medium tabular-nums'>{item.fob_unit_cost.toFixed(2)}</TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'><Input type='number' step='0.01' className={compactInputClassName} value={draft.package_length_cm} onChange={(event) => onDraftChange(item.id, 'package_length_cm', event.target.value)} /></TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'><Input type='number' step='0.01' className={compactInputClassName} value={draft.package_width_cm} onChange={(event) => onDraftChange(item.id, 'package_width_cm', event.target.value)} /></TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'><Input type='number' step='0.01' className={compactInputClassName} value={draft.package_height_cm} onChange={(event) => onDraftChange(item.id, 'package_height_cm', event.target.value)} /></TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'><Input type='number' step='0.001' className={compactInputClassName} value={draft.weight_kg} onChange={(event) => onDraftChange(item.id, 'weight_kg', event.target.value)} /></TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>{formatMetric(chargeableKg, 2)} kg</TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>{firstLegCost > 0 ? firstLegCost.toFixed(2) : <span className='text-[11px] text-muted-foreground'>待补</span>}</TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>{ddpRmb !== null ? ddpRmb.toFixed(2) : '-'}</TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>{ddpUsd !== null ? formatCurrency(ddpUsd) : '-'}</TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'><Input type='number' step='0.0001' className={compactInputClassName} value={draft.usd_to_rmb_rate} onChange={(event) => onDraftChange(item.id, 'usd_to_rmb_rate', event.target.value)} placeholder={result ? formatMetric(result.usd_to_rmb_rate, 4) : systemExchangeRate || '自动'} /></TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'>
                {calculationMode === 'profit-calc' ? (
                  <Input type='number' step='0.01' className={compactInputClassName} value={draft.sale_price_usd} onChange={(event) => onDraftChange(item.id, 'sale_price_usd', event.target.value)} />
                ) : (
                  <Input type='number' step='0.01' className={compactInputClassName} value={draft.target_profit_rate} onChange={(event) => onDraftChange(item.id, 'target_profit_rate', event.target.value)} />
                )}
              </TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'><Input type='number' step='0.01' className={compactInputClassName} value={draft.advertising_rate} onChange={(event) => onDraftChange(item.id, 'advertising_rate', event.target.value)} /></TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>{result ? formatCurrency(result.fees.advertising_fee_usd) : '-'}</TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'><Input type='number' step='0.01' className={compactInputClassName} value={draft.return_loss_rate} onChange={(event) => onDraftChange(item.id, 'return_loss_rate', event.target.value)} /></TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>{result ? formatCurrency(result.fees.return_loss_usd) : '-'}</TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>{result ? formatCurrency(result.fees.referral_fee_usd) : '-'}</TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>{result ? formatCurrency(result.fees.fba_fulfillment_fee_usd) : '-'}</TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>{result ? formatCurrency(result.fees.inbound_config_fee_usd) : '-'}</TableCell>
              <TableCell className='whitespace-nowrap border-r px-2 py-2'><Input type='number' step='0.01' className={compactInputClassName} value={draft.storage_months} onChange={(event) => onDraftChange(item.id, 'storage_months', event.target.value)} /></TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>{result ? formatCurrency(result.fees.storage_fee_usd) : '-'}</TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right tabular-nums'>{result ? formatCurrency(result.fees.total_fee_usd) : '-'}</TableCell>
              <TableCell className='whitespace-nowrap border-r px-3 py-2 text-right font-medium tabular-nums'>{result ? formatCurrency(result.profit.payout_usd) : '-'}</TableCell>
              <TableCell className={cn('whitespace-nowrap border-r px-3 py-2 text-right font-semibold tabular-nums', result ? result.profit.profit_usd >= 0 ? 'text-emerald-600 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground')}>
                {result ? calculationMode === 'profit-reverse' ? formatCurrency(result.sale_price_usd) : formatCurrency(result.profit.profit_usd) : '-'}
              </TableCell>
              <TableCell className={cn('whitespace-nowrap border-r px-3 py-2 text-right font-semibold tabular-nums', result ? result.profit.profit_rate >= 0 ? 'text-emerald-600 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground')}>
                {result ? calculationMode === 'profit-reverse' ? '-' : formatPercent(result.profit.profit_rate) : '-'}
              </TableCell>
              <TableCell className={cn('whitespace-nowrap border-r px-3 py-2', groupStyles['产品核定'].subHeader)}>
                {result ? <div className='leading-5'><div>{result.size_tier_label}</div><div className='text-[11px] text-muted-foreground'>{result.price_band_label}</div></div> : '-'}
              </TableCell>
              <TableCell className={cn('whitespace-nowrap border-r px-3 py-2', groupStyles['产品核定'].subHeader)}>
                {result ? <div className='max-w-[196px] space-y-0.5 overflow-hidden text-ellipsis text-[11px] text-muted-foreground'><p className='truncate'>派送: {result.fulfillment_fee_rule_label}</p><p className='truncate'>配置: {result.inbound_config_fee_rule_label}</p><p className='truncate'>仓储: {result.storage_fee_rule_label}</p></div> : '-'}
              </TableCell>
              <TableCell className='px-3 py-2 text-center'>
                {rowState?.error ? (
                  <div className='max-w-[88px] text-[11px] leading-4 text-destructive'>{rowState.error}</div>
                ) : result?.warnings.length ? (
                  <div className='max-w-[88px] text-[11px] leading-4 text-amber-600 dark:text-amber-300' title={result.warnings.join('；')}>{result.warnings[0]}</div>
                ) : result ? (
                  <Badge variant='secondary' className='whitespace-nowrap'>已测算</Badge>
                ) : (
                  <span className='text-[11px] text-muted-foreground'>待测算</span>
                )}
              </TableCell>
              <TableCell className='px-3 py-2 text-center'>
                <div className='flex flex-col items-center gap-2'>
                  <select value={draft.inbound_placement_mode} onChange={(event) => onDraftChange(item.id, 'inbound_placement_mode', event.target.value)} className={compactSelectClassName}>
                    <option value='single_destination'>单仓</option>
                    <option value='amazon_optimized_split'>优化拆仓</option>
                  </select>
                  <Button type='button' onClick={() => onCalculate(item, calculationMode)} disabled={rowState?.loading} className='h-8 min-w-[92px]'>
                    {rowState?.loading ? <Loader2 className='mr-2 h-4 w-4 animate-spin' /> : <Calculator className='mr-2 h-4 w-4' />}
                    {calculationMode === 'profit-reverse' ? '倒算售价' : '测算'}
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
