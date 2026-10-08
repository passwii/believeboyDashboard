'use client'

import { DataTableCard, DataTableCardBody, DataTableCardHeader } from '@/components/ui/data-card'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

type DecimalValue = number | string

export type ShippingPlanSkuRow = {
  sku: string
  asin: string | null
  product_name: string | null
  available_inventory: number | null
  inventory_snapshot_date: string | null
  base_dms: DecimalValue | null
  growth_factor: DecimalValue
  demand_source: 'manual' | 'default'
  in_transit_quantity: number
  draft_quantity: number
  active_plan_remaining_quantity: number
  confirmed_180d_sales_upper_bound: DecimalValue | null
  planned_180d_sales_upper_bound: DecimalValue | null
  data_quality: string[]
}

function number(value: DecimalValue | null, digits = 0) {
  const numeric = value == null ? null : Number(value)
  return numeric == null || !Number.isFinite(numeric) ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(numeric)
}

function qualityMeta(reasons: string[]): { label: string; ready: boolean } {
  if (!reasons.length) return { label: '可计算', ready: true }
  if (reasons.includes('inventory_snapshot_missing') || reasons.includes('sku_inventory_snapshot_missing')) return { label: '缺少库存', ready: false }
  if (reasons.includes('sales_baseline_missing')) return { label: '缺少销量', ready: false }
  if (reasons.includes('post_snapshot_inbound_before_forecast_start')) return { label: '快照待更新', ready: false }
  return { label: '待核实', ready: false }
}

export function SkuForecastTable({
  rows,
  selectedSku,
  loading,
  onSelect,
}: {
  rows: ShippingPlanSkuRow[]
  selectedSku: string
  loading: boolean
  onSelect: (sku: string) => void
}) {
  return (
    <DataTableCard data-testid="shipping-plan-sku-table">
      <DataTableCardHeader title="SKU 预测清单" description="选择 SKU 查看 180 天时间轴；未知快照或销量基线不按 0 计入上限合计。" />
      <DataTableCardBody>
        {loading ? <div className="p-4 font-mono text-xs text-term-muted" role="status">正在读取 SKU 清单…</div> : null}
        {!loading && rows.length === 0 ? <EmptyState chartHeight="h-28" message="所选项目与站点暂无 SKU 预测数据。" /> : null}
        {!loading && rows.length > 0 ? (
          <div className="max-w-full overflow-x-auto term-scroll">
            <Table className="min-w-[1020px]">
              <TableHeader>
                <TableRow>
                  <TableHead>SKU / 商品</TableHead>
                  <TableHead className="text-right">可售库存</TableHead>
                  <TableHead>库存快照</TableHead>
                  <TableHead className="text-right">基础 DMS</TableHead>
                  <TableHead className="text-right">增长系数</TableHead>
                  <TableHead className="text-right">在途 / 草稿</TableHead>
                  <TableHead className="text-right">计划余额</TableHead>
                  <TableHead className="text-right">确定上限</TableHead>
                  <TableHead className="text-right">计划上限</TableHead>
                  <TableHead>数据状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const selected = row.sku === selectedSku
                  const quality = qualityMeta(row.data_quality)
                  return (
                    <TableRow
                      key={row.sku}
                      data-state={selected ? 'selected' : undefined}
                      className="cursor-pointer"
                      onClick={() => onSelect(row.sku)}
                    >
                      <TableCell className="max-w-56">
                        <button type="button" onClick={() => onSelect(row.sku)} className="block min-w-0 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent">
                          <span className="block truncate font-mono font-semibold text-term-text">{row.sku}</span>
                          <span className="mt-0.5 block truncate text-[11px] text-term-muted">{row.product_name || row.asin || '—'}</span>
                        </button>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{number(row.available_inventory)}</TableCell>
                      <TableCell className="font-mono text-xs tabular-nums">{row.inventory_snapshot_date ?? '未知'}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{number(row.base_dms, 3)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{number(row.growth_factor, 4)}{row.demand_source === 'default' ? <span className="ml-1 text-term-muted">默认</span> : null}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{number(row.in_transit_quantity)} / {number(row.draft_quantity)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{number(row.active_plan_remaining_quantity)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{number(row.confirmed_180d_sales_upper_bound)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{number(row.planned_180d_sales_upper_bound)}</TableCell>
                      <TableCell><Badge variant="outline" className={`whitespace-nowrap rounded-none font-mono text-[10px] ${quality.ready ? 'border-term-pos/40 text-term-pos' : 'border-term-warn/50 text-term-warn'}`}>{quality.label}</Badge></TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </DataTableCardBody>
    </DataTableCard>
  )
}
