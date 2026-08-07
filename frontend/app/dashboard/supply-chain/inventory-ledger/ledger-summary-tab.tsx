/**
 * 汇总视图 tab（BLF-428 前端重构）— Summary 视图每日水位账。
 *
 * 上半部分：每 SKU 期末水位线（跨仓库/状态求和）；
 * 下半部分：原始水位表（主列 + 可展开次级列）+ 客户端分页 + CSV 导出。
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'

import { Button } from '@/components/ui/button'
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
  DENSE_HEAD,
} from '@/components/ui/data-card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

import { DispositionBadge } from './ledger-badges'
import { waterLevelSeries } from './ledger-derive'
import { ExportCsvButton, PaginationBar } from './ledger-table-parts'
import type { LedgerSummaryRow } from './ledger-types'

const PAGE_SIZE = 50
const SKU_LINE_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
  'hsl(var(--chart-6))',
]

const waterChartConfig = Object.fromEntries(
  SKU_LINE_COLORS.map((_, i) => [`sku${i}`, { label: `SKU ${i + 1}` }]),
) as ChartConfig

// ── 列定义 ────────────────────────────────────────────────────────────────────

type ColumnDef = {
  key: string
  label: string
  align?: 'right'
  render: (r: LedgerSummaryRow) => ReactNode
  csv: (r: LedgerSummaryRow) => unknown
}

const num = (v: number) => (
  <span className={cn('tabular-nums', v > 0 && 'text-green-600', v < 0 && 'text-red-600')}>
    {v}
  </span>
)

const PRIMARY_COLUMNS: ColumnDef[] = [
  { key: 'date', label: '日期', render: (r) => r.date, csv: (r) => r.date },
  {
    key: 'msku',
    label: 'MSKU',
    render: (r) => <span className="font-mono text-xs">{r.msku}</span>,
    csv: (r) => r.msku,
  },
  {
    key: 'title',
    label: '品名',
    render: (r) => (
      <span className="block max-w-[180px] truncate text-xs text-muted-foreground" title={r.title ?? ''}>
        {r.title || '—'}
      </span>
    ),
    csv: (r) => r.title ?? '',
  },
  {
    key: 'location',
    label: '仓库',
    render: (r) => <span className="font-mono text-xs">{r.location}</span>,
    csv: (r) => r.location,
  },
  {
    key: 'disposition',
    label: '状态',
    render: (r) => <DispositionBadge disposition={r.disposition} />,
    csv: (r) => r.disposition,
  },
  {
    key: 'starting_balance',
    label: '期初',
    align: 'right',
    render: (r) => <span className="tabular-nums">{r.starting_balance}</span>,
    csv: (r) => r.starting_balance,
  },
  { key: 'receipts', label: '入库', align: 'right', render: (r) => num(r.receipts), csv: (r) => r.receipts },
  {
    key: 'customer_shipments',
    label: '出库',
    align: 'right',
    render: (r) => num(r.customer_shipments),
    csv: (r) => r.customer_shipments,
  },
  {
    key: 'customer_returns',
    label: '客户退货',
    align: 'right',
    render: (r) => num(r.customer_returns),
    csv: (r) => r.customer_returns,
  },
  {
    key: 'warehouse_transfer_io',
    label: '调拨',
    align: 'right',
    render: (r) => num(r.warehouse_transfer_io),
    csv: (r) => r.warehouse_transfer_io,
  },
  { key: 'damaged', label: '损坏', align: 'right', render: (r) => num(r.damaged), csv: (r) => r.damaged },
  {
    key: 'ending_balance',
    label: '期末',
    align: 'right',
    render: (r) => <span className="font-medium tabular-nums">{r.ending_balance}</span>,
    csv: (r) => r.ending_balance,
  },
]

const SECONDARY_COLUMNS: ColumnDef[] = [
  {
    key: 'in_transit_between',
    label: '在途',
    align: 'right',
    render: (r) => num(r.in_transit_between),
    csv: (r) => r.in_transit_between,
  },
  {
    key: 'vendor_returns',
    label: '供应商退货',
    align: 'right',
    render: (r) => num(r.vendor_returns),
    csv: (r) => r.vendor_returns,
  },
  { key: 'found', label: '盘盈', align: 'right', render: (r) => num(r.found), csv: (r) => r.found },
  { key: 'lost', label: '盘亏', align: 'right', render: (r) => num(r.lost), csv: (r) => r.lost },
  { key: 'disposed', label: '报废', align: 'right', render: (r) => num(r.disposed), csv: (r) => r.disposed },
  {
    key: 'other_events',
    label: '其他',
    align: 'right',
    render: (r) => num(r.other_events),
    csv: (r) => r.other_events,
  },
  {
    key: 'unknown_events',
    label: '未知',
    align: 'right',
    render: (r) => num(r.unknown_events),
    csv: (r) => r.unknown_events,
  },
  {
    key: 'store',
    label: 'Store',
    render: (r) => <span className="text-xs text-muted-foreground">{r.store || '—'}</span>,
    csv: (r) => r.store ?? '',
  },
]

// ── 组件 ──────────────────────────────────────────────────────────────────────

export function LedgerSummaryTab({
  rows,
  failed,
  period,
}: {
  /** 已按全局筛选过滤的 summary 行（date desc） */
  rows: LedgerSummaryRow[]
  failed?: boolean
  period: string
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
  const chartMskus = mskus.slice(0, SKU_LINE_COLORS.length)

  const columns = showAllColumns
    ? [...PRIMARY_COLUMNS.slice(0, 6), ...SECONDARY_COLUMNS, ...PRIMARY_COLUMNS.slice(6)]
    : PRIMARY_COLUMNS

  const emptyText = failed ? '数据加载失败，请点击右上角刷新按钮重试' : '无汇总水位数据'

  const csvRows = useMemo(
    () => rows.map((r) => columns.map((c) => c.csv(r))),
    [rows, columns],
  )

  return (
    <div className="space-y-4">
      {/* 每 SKU 期末水位线 */}
      {rows.length > 0 && (
        <DataTableCard>
          <DataTableCardHeader
            title="每 SKU 期末水位"
            description={`按日期汇总各 MSKU 期末库存（跨仓库/状态）${
              mskus.length > SKU_LINE_COLORS.length
                ? ` · 仅显示前 ${SKU_LINE_COLORS.length} 个 SKU`
                : ''
            }`}
          />
          <DataTableCardBody>
            <ChartContainer className="h-56 w-full" config={waterChartConfig}>
              <LineChart accessibilityLayer data={data} margin={{ left: 4, right: 12, top: 8 }}>
                <CartesianGrid className="stroke-border" vertical={false} />
                <XAxis
                  axisLine={false}
                  dataKey="date"
                  interval="preserveStartEnd"
                  tick={{ fontSize: 10 }}
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
      <DataTableCard>
        <DataTableCardHeader
          title="每日水位明细"
          description={`${rows.length} 行 · 每行 = 1 个 MSKU × 仓库 × 状态 × 日期的水位快照`}
          action={
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAllColumns((v) => !v)}
              >
                {showAllColumns ? '收起次级列' : '展开全部列'}
              </Button>
              <ExportCsvButton
                filename={`库存分类账-汇总水位-${period || 'all'}.csv`}
                headers={columns.map((c) => c.label)}
                rows={csvRows}
              />
            </div>
          }
        />
        <DataTableCardBody>
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c) => (
                  <TableHead key={c.key} className={cn(DENSE_HEAD, c.align === 'right' && 'text-right')}>
                    {c.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                    {emptyText}
                  </td>
                </tr>
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
