/**
 * 汇总视图 tab（BLF-428 前端重构）— Summary 视图每日水位账。
 *
 * 上半部分：每 SKU 期末水位线（按当前筛选范围求和）；
 * 下半部分：原始水位表（主列 + 可展开次级列）+ 客户端分页 + CSV 导出。
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import {
  DataTableCard,
  DataTableCardBody,
  DataTableCardHeader,
  DENSE_CELL,
} from '@/components/ui/data-card'
import { EmptyTableState } from '@/components/ui/empty-state'
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import { DispositionBadge } from './ledger-badges'
import { skuEndingSummary, waterLevelSeries } from './ledger-derive'
import { ColumnHeader, PaginationBar } from './ledger-table-parts'
import { summaryEn, summaryLabel } from './ledger-glossary'
import type { LedgerSummaryRow } from './ledger-types'
import styles from './inventory-ledger-warm.module.css'

const PAGE_SIZE = 50
const SKU_LINE_COLORS = [
  'var(--warm-ledger-color-accent)',
  'var(--warm-ledger-color-text-soft)',
  'var(--warm-ledger-color-text-muted)',
  'var(--warm-ledger-color-text-faint)',
  'var(--warm-ledger-color-raised-hover)',
  'var(--warm-ledger-color-panel-strong)',
]

const waterChartConfig = Object.fromEntries(
  SKU_LINE_COLORS.map((_, i) => [`sku${i}`, { label: `SKU ${i + 1}` }]),
) as ChartConfig

// ── 列定义 ────────────────────────────────────────────────────────────────────

type ColumnDef = {
  key: string
  label: string
  /** 英文列名（spec 表头）→ hover tooltip（BLF-431） */
  tooltip?: string
  align?: 'right'
  render: (r: LedgerSummaryRow) => ReactNode
  csv: (r: LedgerSummaryRow) => unknown
}

const num = (v: number) => (
  <span className={cn('tabular-nums', v > 0 && styles.positive, v < 0 && styles.negative)}>
    {v}
  </span>
)

const PRIMARY_COLUMNS: ColumnDef[] = [
  { key: 'date', label: summaryLabel('date'), tooltip: summaryEn('date'), render: (r) => r.date, csv: (r) => r.date },
  {
    key: 'msku',
    label: summaryLabel('msku'),
    tooltip: summaryEn('msku'),
    render: (r) => <span className="font-mono text-xs">{r.msku}</span>,
    csv: (r) => r.msku,
  },
  {
    key: 'title',
    label: summaryLabel('title'),
    tooltip: summaryEn('title'),
    render: (r) => (
      <span className="block max-w-[180px] truncate text-xs text-muted-foreground" title={r.title ?? ''}>
        {r.title || '—'}
      </span>
    ),
    csv: (r) => r.title ?? '',
  },
  {
    key: 'location',
    label: summaryLabel('location'),
    tooltip: summaryEn('location'),
    render: (r) => <span className="font-mono text-xs">{r.location}</span>,
    csv: (r) => r.location,
  },
  {
    key: 'disposition',
    label: summaryLabel('disposition'),
    tooltip: summaryEn('disposition'),
    render: (r) => <DispositionBadge disposition={r.disposition} />,
    csv: (r) => r.disposition,
  },
  {
    key: 'starting_balance',
    label: summaryLabel('starting_balance'),
    tooltip: summaryEn('starting_balance'),
    align: 'right',
    render: (r) => <span className="tabular-nums">{r.starting_balance}</span>,
    csv: (r) => r.starting_balance,
  },
  { key: 'receipts', label: summaryLabel('receipts'), tooltip: summaryEn('receipts'), align: 'right', render: (r) => num(r.receipts), csv: (r) => r.receipts },
  {
    key: 'customer_shipments',
    label: summaryLabel('customer_shipments'),
    tooltip: summaryEn('customer_shipments'),
    align: 'right',
    render: (r) => num(r.customer_shipments),
    csv: (r) => r.customer_shipments,
  },
  {
    key: 'customer_returns',
    label: summaryLabel('customer_returns'),
    tooltip: summaryEn('customer_returns'),
    align: 'right',
    render: (r) => num(r.customer_returns),
    csv: (r) => r.customer_returns,
  },
  {
    key: 'warehouse_transfer_io',
    label: summaryLabel('warehouse_transfer_io'),
    tooltip: summaryEn('warehouse_transfer_io'),
    align: 'right',
    render: (r) => num(r.warehouse_transfer_io),
    csv: (r) => r.warehouse_transfer_io,
  },
  { key: 'damaged', label: summaryLabel('damaged'), tooltip: summaryEn('damaged'), align: 'right', render: (r) => num(r.damaged), csv: (r) => r.damaged },
  {
    key: 'ending_balance',
    label: summaryLabel('ending_balance'),
    tooltip: summaryEn('ending_balance'),
    align: 'right',
    render: (r) => <span className="font-medium tabular-nums">{r.ending_balance}</span>,
    csv: (r) => r.ending_balance,
  },
]

const SECONDARY_COLUMNS: ColumnDef[] = [
  {
    key: 'in_transit_between',
    label: summaryLabel('in_transit_between'),
    tooltip: summaryEn('in_transit_between'),
    align: 'right',
    render: (r) => num(r.in_transit_between),
    csv: (r) => r.in_transit_between,
  },
  {
    key: 'vendor_returns',
    label: summaryLabel('vendor_returns'),
    tooltip: summaryEn('vendor_returns'),
    align: 'right',
    render: (r) => num(r.vendor_returns),
    csv: (r) => r.vendor_returns,
  },
  { key: 'found', label: summaryLabel('found'), tooltip: summaryEn('found'), align: 'right', render: (r) => num(r.found), csv: (r) => r.found },
  { key: 'lost', label: summaryLabel('lost'), tooltip: summaryEn('lost'), align: 'right', render: (r) => num(r.lost), csv: (r) => r.lost },
  { key: 'disposed', label: summaryLabel('disposed'), tooltip: summaryEn('disposed'), align: 'right', render: (r) => num(r.disposed), csv: (r) => r.disposed },
  {
    key: 'other_events',
    label: summaryLabel('other_events'),
    tooltip: summaryEn('other_events'),
    align: 'right',
    render: (r) => num(r.other_events),
    csv: (r) => r.other_events,
  },
  {
    key: 'unknown_events',
    label: summaryLabel('unknown_events'),
    tooltip: summaryEn('unknown_events'),
    align: 'right',
    render: (r) => num(r.unknown_events),
    csv: (r) => r.unknown_events,
  },
  {
    key: 'store',
    label: summaryLabel('store'),
    tooltip: summaryEn('store'),
    render: (r) => <span className="text-xs text-muted-foreground">{r.store || '—'}</span>,
    csv: (r) => r.store ?? '',
  },
]

// ── 组件 ──────────────────────────────────────────────────────────────────────

export function LedgerSummaryTab({
  rows,
  failed,
}: {
  /** 已按全局筛选过滤的 summary 行（date desc） */
  rows: LedgerSummaryRow[]
  failed?: boolean
}) {
  const [page, setPage] = useState(0)
  const [showAllColumns, setShowAllColumns] = useState(false)

  // 筛选变化（rows 引用变化）时回到第一页
  useEffect(() => setPage(0), [rows])

  const pageCount = Math.ceil(rows.length / PAGE_SIZE)
  const pageRows = useMemo(
    () => rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [rows, page],
  )

  const { mskus, data } = useMemo(() => waterLevelSeries(rows), [rows])
  const skuSummary = useMemo(() => skuEndingSummary(rows), [rows])
  const chartMskus = mskus.slice(0, SKU_LINE_COLORS.length)

  const columns = showAllColumns
    ? [...PRIMARY_COLUMNS.slice(0, 6), ...SECONDARY_COLUMNS, ...PRIMARY_COLUMNS.slice(6)]
    : PRIMARY_COLUMNS

  const emptyText = failed ? '数据加载失败，请点击右上角刷新按钮重试' : '无汇总水位数据'

  return (
    <div className="space-y-4">
      {skuSummary.length > 0 && (
        <DataTableCard className={styles.tableCard}>
          <DataTableCardHeader
            className={styles.tableHeader}
            title="SKU 月度汇总"
            description={`${skuSummary.length} 个 MSKU · 按当前筛选汇总期末库存`}
          />
          <DataTableCardBody className={styles.tableBody}>
            <div className={styles.tableScroll}>
              <Table className={styles.skuSummaryTable}>
              <TableHeader>
                <TableRow>
                  <ColumnHeader label="MSKU" />
                  <ColumnHeader label="品名" />
                  <ColumnHeader label="期末总库存" className="text-right" />
                  <ColumnHeader label="可售库存" className="text-right" />
                  <ColumnHeader label="损坏库存" className="text-right" />
                  <ColumnHeader label="损坏占比" className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {skuSummary.map((row) => (
                  <TableRow key={row.msku}>
                    <TableCell className={cn(DENSE_CELL, 'font-mono text-xs')}>
                      {row.msku}
                    </TableCell>
                    <TableCell className={DENSE_CELL}>{row.title || '—'}</TableCell>
                    <TableCell className={cn(DENSE_CELL, 'text-right tabular-nums')}>
                      {row.endingQty}
                    </TableCell>
                    <TableCell className={cn(DENSE_CELL, 'text-right tabular-nums')}>
                      {row.sellableQty}
                    </TableCell>
                    <TableCell className={cn(DENSE_CELL, 'text-right tabular-nums')}>
                      {row.damagedQty}
                    </TableCell>
                    <TableCell className={cn(DENSE_CELL, 'text-right tabular-nums')}>
                      {row.damagedPct.toFixed(1)}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              </Table>
            </div>
          </DataTableCardBody>
        </DataTableCard>
      )}

      {/* 每 SKU 期末水位线 */}
      {rows.length > 0 && (
        <DataTableCard className={styles.tableCard}>
          <DataTableCardHeader
            className={styles.tableHeader}
            title="每 SKU 月度水位"
            description={`按当前筛选范围汇总各 MSKU 期末库存${
              mskus.length > SKU_LINE_COLORS.length
                ? ` · 仅显示前 ${SKU_LINE_COLORS.length} 个 SKU`
                : ''
            }`}
          />
          <DataTableCardBody className={styles.tableBody}>
            <ChartContainer className={styles.chartContainer} config={waterChartConfig}>
              <LineChart accessibilityLayer data={data} margin={{ left: 4, right: 12, top: 8 }}>
                <CartesianGrid className="stroke-border" vertical={false} />
                <XAxis
                  axisLine={false}
                  dataKey="date"
                  interval="preserveStartEnd"
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  tickMargin={8}
                />
                <YAxis axisLine={false} tickLine={false} width={40} />
                <ChartTooltip content={<ChartTooltipContent />} />
                {chartMskus.map((msku, i) => (
                  <Line
                    key={msku}
                    dataKey={msku}
                    dot={false}
                    name={msku}
                    stroke={SKU_LINE_COLORS[i]}
                    strokeWidth={2}
                  />
                ))}
              </LineChart>
            </ChartContainer>
          </DataTableCardBody>
        </DataTableCard>
      )}

      {/* 水位表 */}
      <DataTableCard className={styles.tableCard}>
        <DataTableCardHeader
          className={styles.tableHeader}
          title="月度水位明细"
          description={`${rows.length} 行 · 每行 = 1 个 MSKU × 仓库 × 状态 × 日期的水位快照`}
          action={
            <div className="flex items-center gap-2">
                <WarmButton
                className={styles.tableAction}
                variant="secondary"
                onClick={() => setShowAllColumns((v) => !v)}
              >
                {showAllColumns ? '收起次级列' : '展开全部列'}
              </WarmButton>
            </div>
          }
        />
        <DataTableCardBody className={styles.tableBody}>
          <TooltipProvider delayDuration={150}>
            <div className={styles.tableScroll}>
            <Table className={styles.ledgerTable}>
              <TableHeader>
                <TableRow>
                  {columns.map((c) => (
                    <ColumnHeader
                      key={c.key}
                      label={c.label}
                      tooltip={c.tooltip}
                      className={c.align === 'right' ? 'text-right' : undefined}
                    />
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.length === 0 ? (
                  <EmptyTableState colSpan={columns.length} message={emptyText} />
                ) : (
                  pageRows.map((r) => (
                    <TableRow key={r.id}>
                      {columns.map((c) => (
                        <TableCell key={c.key} className={cn(DENSE_CELL, c.align === 'right' && 'text-right')}>
                          {c.render(r)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            </div>
          </TooltipProvider>
          <PaginationBar
            page={page}
            pageCount={pageCount}
            total={rows.length}
            onPageChange={setPage}
          />
        </DataTableCardBody>
      </DataTableCard>
    </div>
  )
}
