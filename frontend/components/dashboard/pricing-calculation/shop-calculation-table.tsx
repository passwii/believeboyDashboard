'use client'

import { Calculator } from 'lucide-react'

import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { cn } from '@/lib/utils'
import type { PricingCalculationRunItem, ProductCostItem } from '@/lib/pricing-calculation-types'
import styles from './shop-calculation-table-warm.module.css'

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

type ShopCalculationTableProps = {
  items: ProductCostItem[]
  rowStates: Record<number, StoreSkuRowState>
  onDraftChange: (rowId: number, key: keyof StoreSkuDraft, value: string) => void
  onCalculate: (item: ProductCostItem) => void
  systemExchangeRate: string
  /**
   * 定价历史快照模式：true 时隐藏"测算"按钮和"派送模式"下拉，
   * 因为历史快照是只读视图，不允许重新测算。
   */
  isSnapshotMode?: boolean
}

function buildInitialStoreDraft(item: ProductCostItem): StoreSkuDraft {
  return {
    package_length_cm: item.package_length_cm > 0 ? String(item.package_length_cm) : '',
    package_width_cm: item.package_width_cm > 0 ? String(item.package_width_cm) : '',
    package_height_cm: item.package_height_cm > 0 ? String(item.package_height_cm) : '',
    weight_kg: item.weight_kg > 0 ? String(item.weight_kg) : '',
    first_leg_cost_rmb: item.first_leg_cost_rmb > 0 ? String(item.first_leg_cost_rmb) : '5',
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

const GROUP_CLASSES: Record<
  '店铺产品' | '货品数据' | 'DDP 成本' | '费用支出' | '利润核算' | '产品核定' | '操作',
  { header: string; sub: string }
> = {
  店铺产品: { header: styles.groupHeader, sub: styles.groupShop },
  货品数据: { header: styles.groupHeader, sub: styles.groupProduct },
  'DDP 成本': { header: styles.groupHeader, sub: styles.groupDdp },
  费用支出: { header: styles.groupHeader, sub: styles.groupFees },
  利润核算: { header: styles.groupHeader, sub: styles.groupProfit },
  产品核定: { header: styles.groupHeader, sub: styles.groupCheck },
  操作: { header: styles.groupHeader, sub: styles.groupAction },
}

function getGroupStyle(
  group: keyof typeof GROUP_CLASSES,
  variant: 'header' | 'sub'
) {
  return GROUP_CLASSES[group][variant]
}

export function ShopCalculationTable({
  items,
  rowStates,
  onDraftChange,
  onCalculate,
  systemExchangeRate,
  isSnapshotMode = false,
}: ShopCalculationTableProps) {
  return (
    <div
      className={styles.tableScroll}
      data-warm-shop-calculation-table="true"
    >
      <table className={styles.table}>
      {/* Group-level header row */}
      <thead>
        <tr className={styles.groupRow}>
          <th
            colSpan={1}
            className={styles.stickyHeader}
            data-group="shop"
            data-sticky-column="true"
          >
            店铺产品
          </th>
          <th
            colSpan={6}
            className={styles.groupHeader}
            data-group="product"
          >
            货品数据
          </th>
          <th
            colSpan={4}
            className={styles.groupHeader}
            data-group="ddp"
          >
            DDP 成本
          </th>
          <th
            colSpan={10}
            className={styles.groupHeader}
            data-group="fees"
          >
            费用支出
          </th>
          <th
            colSpan={4}
            className={styles.groupHeader}
            data-group="profit"
          >
            利润核算
          </th>
          <th
            colSpan={3}
            className={styles.groupHeader}
            data-group="check"
          >
            产品核定
          </th>
          <th
            colSpan={2}
            className={styles.groupHeader}
            data-group="action"
          >
            操作
          </th>
        </tr>
        {/* Column-level sub-header row */}
        <tr className={styles.subGroupRow}>
          <th
            className={cn(
              'sticky left-0 z-[55] min-w-[160px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('店铺产品', 'sub')
            )}
            data-sticky-column="true"
          >
            SKU / 项目
          </th>
          <th
            className={cn(
              'min-w-[86px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('货品数据', 'sub')
            )}
          >
            FOB(RMB)
          </th>
          <th
            className={cn(
              'min-w-[84px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('货品数据', 'sub')
            )}
          >
            长(cm)
          </th>
          <th
            className={cn(
              'min-w-[84px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('货品数据', 'sub')
            )}
          >
            宽(cm)
          </th>
          <th
            className={cn(
              'min-w-[84px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('货品数据', 'sub')
            )}
          >
            高(cm)
          </th>
          <th
            className={cn(
              'min-w-[84px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('货品数据', 'sub')
            )}
          >
            重量(kg)
          </th>
          <th
            className={cn(
              'min-w-[96px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('货品数据', 'sub')
            )}
          >
            计费重
          </th>
          <th
            className={cn(
              'min-w-[96px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('DDP 成本', 'sub')
            )}
          >
            头程(RMB)
          </th>
          <th
            className={cn(
              'min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('DDP 成本', 'sub')
            )}
          >
            DDP(RMB)
          </th>
          <th
            className={cn(
              'min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('DDP 成本', 'sub')
            )}
          >
            DDP(USD)
          </th>
          <th
            className={cn(
              'min-w-[88px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('DDP 成本', 'sub')
            )}
          >
            汇率
          </th>
          <th
            className={cn(
              'min-w-[88px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('费用支出', 'sub')
            )}
          >
            售价(USD)
          </th>
          <th
            className={cn(
              'min-w-[88px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('费用支出', 'sub')
            )}
          >
            广告费率%
          </th>
          <th
            className={cn(
              'min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('费用支出', 'sub')
            )}
          >
            广告费
          </th>
          <th
            className={cn(
              'min-w-[96px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('费用支出', 'sub')
            )}
          >
            退货折损率%
          </th>
          <th
            className={cn(
              'min-w-[96px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('费用支出', 'sub')
            )}
          >
            退货损耗
          </th>
          <th
            className={cn(
              'min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('费用支出', 'sub')
            )}
          >
            佣金
          </th>
          <th
            className={cn(
              'min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('费用支出', 'sub')
            )}
          >
            派送费
          </th>
          <th
            className={cn(
              'min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('费用支出', 'sub')
            )}
          >
            配置费
          </th>
          <th
            className={cn(
              'min-w-[84px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('费用支出', 'sub')
            )}
          >
            仓储月数
          </th>
          <th
            className={cn(
              'min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('费用支出', 'sub')
            )}
          >
            仓储费
          </th>
          <th
            className={cn(
              'min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('利润核算', 'sub')
            )}
          >
            费用合计
          </th>
          <th
            className={cn(
              'min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('利润核算', 'sub')
            )}
          >
            回款
          </th>
          <th
            className={cn(
              'min-w-[88px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('利润核算', 'sub')
            )}
          >
            利润
          </th>
          <th
            className={cn(
              'min-w-[92px] whitespace-nowrap border-r px-3 py-2 text-right shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('利润核算', 'sub')
            )}
          >
            利润率
          </th>
          <th
            className={cn(
              'min-w-[112px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('产品核定', 'sub')
            )}
          >
            尺寸等级
          </th>
          <th
            className={cn(
              'min-w-[112px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('产品核定', 'sub')
            )}
          >
            售价带
          </th>
          <th
            className={cn(
              'min-w-[208px] whitespace-nowrap border-r px-3 py-2 shadow-[1px_0_0_0_hsl(var(--border))]',
              getGroupStyle('产品核定', 'sub')
            )}
          >
            规则
          </th>
          <th
            className={cn(
              'min-w-[100px] whitespace-nowrap px-3 py-2 text-center',
              getGroupStyle('操作', 'sub')
            )}
          >
            状态
          </th>
          <th
            className={cn(
              'min-w-[108px] whitespace-nowrap px-3 py-2 text-center',
              getGroupStyle('操作', 'sub')
            )}
          >
            测算
          </th>
        </tr>
      </thead>

      <tbody>
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
            : result?.usd_to_rmb_rate
              ? result.usd_to_rmb_rate
              : toNumber(systemExchangeRate)
          const ddpRmb =
            item.fob_unit_cost > 0 && firstLegCost > 0 ? item.fob_unit_cost + firstLegCost : null
          const ddpUsd = ddpRmb && exchangeRate > 0 ? ddpRmb / exchangeRate : null

          return (
            <tr
              key={item.id}
              className={styles.dataRow}
              data-alt={idx % 2 === 1 ? 'true' : 'false'}
            >
              {/* SKU / 项目 */}
              <td
                className={styles.stickyCell}
                data-sticky-column="true"
              >
                <div className={styles.skuCell}>
                  <p className={styles.sku}>{item.sku}</p>
                  <p className={styles.projectName}>{item.project_name}</p>
                </div>
              </td>

              {/* FOB */}
              <td className="whitespace-nowrap border-r px-3 py-2 text-right font-medium tabular-nums">
                {item.fob_unit_cost > 0 ? (
                  item.fob_unit_cost.toFixed(2)
                ) : (
                  <span className={styles.mutedText}>—</span>
                )}
              </td>

              {/* L / W / H / Weight */}
              <td className="whitespace-nowrap border-r px-2 py-2">
                <input
                  type="number"
                  step="0.01"
                  aria-label="长(cm)"
                  className={styles.compactInput}
                  value={draft.package_length_cm}
                  onChange={(e) => onDraftChange(item.id, 'package_length_cm', e.target.value)}
                />
              </td>
              <td className="whitespace-nowrap border-r px-2 py-2">
                <input
                  type="number"
                  step="0.01"
                  aria-label="宽(cm)"
                  className={styles.compactInput}
                  value={draft.package_width_cm}
                  onChange={(e) => onDraftChange(item.id, 'package_width_cm', e.target.value)}
                />
              </td>
              <td className="whitespace-nowrap border-r px-2 py-2">
                <input
                  type="number"
                  step="0.01"
                  aria-label="高(cm)"
                  className={styles.compactInput}
                  value={draft.package_height_cm}
                  onChange={(e) => onDraftChange(item.id, 'package_height_cm', e.target.value)}
                />
              </td>
              <td className="whitespace-nowrap border-r px-2 py-2">
                <input
                  type="number"
                  step="0.001"
                  aria-label="重量(kg)"
                  className={styles.compactInput}
                  value={draft.weight_kg}
                  onChange={(e) => onDraftChange(item.id, 'weight_kg', e.target.value)}
                />
              </td>

              {/* 计费重 */}
              <td
                className={cn(
                  'whitespace-nowrap border-r px-3 py-2 text-right tabular-nums',
                  chargeableKg > toNumber(draft.weight_kg)
                    ? styles.warningText
                    : undefined
                )}
              >
                {formatMetric(chargeableKg, 2)} kg
              </td>

              {/* DDP */}
              <td
                className={cn(
                  'whitespace-nowrap border-r px-3 py-2 text-right tabular-nums',
                  firstLegCost <= 0 ? styles.warningText : undefined
                )}
              >
                {firstLegCost > 0 ? (
                  firstLegCost.toFixed(2)
                ) : (
                  <span className={styles.warningText}>待补</span>
                )}
              </td>
              <td className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">
                {ddpRmb !== null ? (
                  ddpRmb.toFixed(2)
                ) : (
                  <span className={styles.mutedText}>—</span>
                )}
              </td>
              <td className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">
                {ddpUsd !== null ? (
                  formatCurrency(ddpUsd)
                ) : (
                  <span className={styles.mutedText}>—</span>
                )}
              </td>
              <td className="whitespace-nowrap border-r px-2 py-2">
                <input
                  type="number"
                  step="0.0001"
                  aria-label="汇率"
                  className={styles.compactInput}
                  value={draft.usd_to_rmb_rate}
                  onChange={(e) => onDraftChange(item.id, 'usd_to_rmb_rate', e.target.value)}
                  placeholder={
                    result ? formatMetric(result.usd_to_rmb_rate, 4) : systemExchangeRate || '自动'
                  }
                />
              </td>

              {/* 费用支出 */}
              <td className="whitespace-nowrap border-r px-2 py-2">
                <input
                  type="number"
                  step="0.01"
                  aria-label="售价(USD)"
                  className={styles.compactInput}
                  value={draft.sale_price_usd}
                  onChange={(e) => onDraftChange(item.id, 'sale_price_usd', e.target.value)}
                />
              </td>
              <td className="whitespace-nowrap border-r px-2 py-2">
                <input
                  type="number"
                  step="0.01"
                  aria-label="广告费率%"
                  className={styles.compactInput}
                  value={draft.advertising_rate}
                  onChange={(e) => onDraftChange(item.id, 'advertising_rate', e.target.value)}
                />
              </td>
              <td className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">
                {result ? (
                  formatCurrency(result.fees.advertising_fee_usd)
                ) : (
                  <span className={styles.mutedText}>—</span>
                )}
              </td>
              <td className="whitespace-nowrap border-r px-2 py-2">
                <input
                  type="number"
                  step="0.01"
                  aria-label="退货折损率%"
                  className={styles.compactInput}
                  value={draft.return_loss_rate}
                  onChange={(e) => onDraftChange(item.id, 'return_loss_rate', e.target.value)}
                />
              </td>
              <td className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">
                {result ? (
                  formatCurrency(result.fees.return_loss_usd)
                ) : (
                  <span className={styles.mutedText}>—</span>
                )}
              </td>
              <td className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">
                {result ? (
                  formatCurrency(result.fees.referral_fee_usd)
                ) : (
                  <span className={styles.mutedText}>—</span>
                )}
              </td>
              <td className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">
                {result ? (
                  formatCurrency(result.fees.fba_fulfillment_fee_usd)
                ) : (
                  <span className={styles.mutedText}>—</span>
                )}
              </td>
              <td className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">
                {result ? (
                  formatCurrency(result.fees.inbound_config_fee_usd)
                ) : (
                  <span className={styles.mutedText}>—</span>
                )}
              </td>
              <td className="whitespace-nowrap border-r px-2 py-2">
                <input
                  type="number"
                  step="0.01"
                  aria-label="仓储月数"
                  className={styles.compactInput}
                  value={draft.storage_months}
                  onChange={(e) => onDraftChange(item.id, 'storage_months', e.target.value)}
                />
              </td>
              <td className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">
                {result ? (
                  formatCurrency(result.fees.storage_fee_usd)
                ) : (
                  <span className={styles.mutedText}>—</span>
                )}
              </td>

              {/* 利润核算 */}
              <td className="whitespace-nowrap border-r px-3 py-2 text-right tabular-nums">
                {result ? (
                  formatCurrency(result.fees.total_fee_usd)
                ) : (
                  <span className={styles.mutedText}>—</span>
                )}
              </td>
              <td className="whitespace-nowrap border-r px-3 py-2 text-right font-medium tabular-nums">
                {result ? (
                  formatCurrency(result.profit.payout_usd)
                ) : (
                  <span className={styles.mutedText}>—</span>
                )}
              </td>
              <td
                className={cn(
                  'whitespace-nowrap border-r px-3 py-2 text-right font-semibold tabular-nums',
                  !result
                    ? styles.mutedText
                    : result.profit.profit_usd >= 0
                      ? styles.positiveText
                      : styles.negativeText
                )}
              >
                {result ? (
                  formatCurrency(result.profit.profit_usd)
                ) : (
                  <span className={styles.mutedText}>—</span>
                )}
              </td>
              <td
                className={cn(
                  'whitespace-nowrap border-r px-3 py-2 text-right font-semibold tabular-nums',
                  !result
                    ? styles.mutedText
                    : result.profit.profit_rate >= 0
                      ? styles.positiveText
                      : styles.negativeText
                )}
              >
                {result ? (
                  formatPercent(result.profit.profit_rate)
                ) : (
                  <span className={styles.mutedText}>—</span>
                )}
              </td>

              {/* 产品核定 */}
              <td
                className={cn(
                  'whitespace-nowrap border-r px-3 py-2',
                  getGroupStyle('产品核定', 'sub')
                )}
              >
                {result ? (
                  <div className={styles.tierLine}>
                    <div className={styles.tierBadge}>
                      {result.size_tier_label}
                    </div>
                  </div>
                ) : (
                  <span className={styles.mutedText}>—</span>
                )}
              </td>
              <td
                className={cn(
                  'whitespace-nowrap border-r px-3 py-2',
                  getGroupStyle('产品核定', 'sub')
                )}
              >
                {result ? (
                  <div className={styles.lookupText}>{result.price_band_label}</div>
                ) : (
                  <span className={styles.mutedText}>—</span>
                )}
              </td>
              <td
                className={cn(
                  'whitespace-nowrap border-r px-3 py-2',
                  getGroupStyle('产品核定', 'sub')
                )}
              >
                {result ? (
                  <div className={styles.ruleLines}>
                    <p>派送: {result.fulfillment_fee_rule_label}</p>
                    <p>配置: {result.inbound_config_fee_rule_label}</p>
                    <p>仓储: {result.storage_fee_rule_label}</p>
                  </div>
                ) : (
                  <span className={styles.mutedText}>—</span>
                )}
              </td>

              {/* 状态 */}
              <td className={styles.statusCell}>
                {rowState?.error ? (
                  <div
                    className={styles.statusBlock}
                    data-status-block="error"
                    title={rowState.error}
                  >
                    {rowState.error}
                  </div>
                ) : result?.warnings?.length ? (
                  <div
                    className={styles.statusBlock}
                    data-status-block="warning"
                    title={result.warnings.join('；')}
                  >
                    {result.warnings[0]}
                  </div>
                ) : result ? (
                  <span
                    className={styles.statusBlock}
                    data-status-block="success"
                  >
                    <span className={styles.statusDot} />
                    已测算
                  </span>
                ) : (
                  <span
                    className={styles.statusBlock}
                    data-status-block="pending"
                  >
                    待测算
                  </span>
                )}
              </td>

              {/* 测算按钮 */}
              <td className="px-3 py-2 text-center">
                <div className="flex flex-col items-center gap-1.5">
                  {isSnapshotMode ? (
                    // 历史快照只读视图
                    <span className={styles.readOnly}>只读</span>
                  ) : (
                    <>
                      <select
                        aria-label="派送模式"
                        value={draft.inbound_placement_mode}
                        onChange={(e) =>
                          onDraftChange(item.id, 'inbound_placement_mode', e.target.value)
                        }
                        className={styles.compactSelect}
                      >
                        <option value="single_destination">单仓</option>
                        <option value="amazon_optimized_split">优化拆仓</option>
                      </select>
                      <WarmButton
                        type="button"
                        onClick={() => onCalculate(item)}
                        loading={rowState?.loading}
                        loadingLabel="正在测算"
                        className={styles.calculateButton}
                        data-complete={rowState?.result ? 'true' : 'false'}
                      >
                        {!rowState?.loading && (
                          <Calculator className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        测算
                      </WarmButton>
                    </>
                  )}
                </div>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
    </div>
  )
}
