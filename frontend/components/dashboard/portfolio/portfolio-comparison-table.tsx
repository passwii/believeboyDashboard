'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowUpDown, ArrowUp, ArrowDown, ExternalLink } from 'lucide-react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
} from '@tanstack/react-table'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import type { ProjectPortfolioKPI } from '@/lib/hooks/use-portfolio-data'

interface PortfolioComparisonTableProps {
  projects: ProjectPortfolioKPI[]
  country: string
}

const CURRENCY_SYMBOL: Record<string, string> = {
  US: '$',
  DE: '€',
  UK: '£',
}

function formatMoney(value: number, country: string): string {
  const symbol = CURRENCY_SYMBOL[country] ?? '$'
  return `${symbol}${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`
}

export function PortfolioComparisonTable({ projects, country }: PortfolioComparisonTableProps) {
  const router = useRouter()
  const [sorting, setSorting] = useState<Array<{ id: string; desc: boolean }>>([
    { id: 'sales_amount', desc: true },
  ])

  const columns = useMemo<ColumnDef<ProjectPortfolioKPI>[]>(
    () => [
      {
        accessorKey: 'project_name',
        header: '项目',
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs leading-5 text-term-text">
              {row.original.project_name}
            </span>
          </div>
        ),
        size: 160,
      },
      {
        accessorKey: 'sales_amount',
        header: '销售额',
        cell: ({ getValue }) => (
          <span className="font-mono text-xs leading-5 tabular-nums text-term-text">
            {formatMoney(getValue() as number, country)}
          </span>
        ),
        size: 120,
      },
      {
        accessorKey: 'sales_contribution',
        header: '占比',
        cell: ({ getValue }) => (
          <span className="font-mono text-xs leading-5 tabular-nums text-term-muted">
            {formatPercent(getValue() as number)}
          </span>
        ),
        size: 80,
      },
      {
        accessorKey: 'order_qty',
        header: '订单量',
        cell: ({ getValue }) => (
          <span className="font-mono text-xs leading-5 tabular-nums text-term-text">
            {(getValue() as number).toLocaleString()}
          </span>
        ),
        size: 80,
      },
      {
        accessorKey: 'ad_spend',
        header: '广告费',
        cell: ({ getValue }) => (
          <span className="font-mono text-xs leading-5 tabular-nums text-term-text">
            {formatMoney(getValue() as number, country)}
          </span>
        ),
        size: 100,
      },
      {
        accessorKey: 'cpc',
        header: 'CPC',
        cell: ({ getValue, row }) => {
          const val = getValue() as number
          const adSpend = row.original.ad_spend
          const clicks = row.original.clicks
          if (clicks === 0)
            return <span className="font-mono text-xs leading-5 text-term-muted">--</span>
          return (
            <span className="font-mono text-xs leading-5 tabular-nums text-term-text">
              {CURRENCY_SYMBOL[country] ?? '$'}
              {val.toFixed(2)}
            </span>
          )
        },
        size: 80,
      },
      {
        accessorKey: 'conversion_rate',
        header: '转化率',
        cell: ({ getValue }) => (
          <span className="font-mono text-xs leading-5 tabular-nums text-term-text">
            {formatPercent(getValue() as number)}
          </span>
        ),
        size: 80,
      },
      {
        accessorKey: 'clicks',
        header: '点击量',
        cell: ({ getValue }) => (
          <span className="font-mono text-xs leading-5 tabular-nums text-term-text">
            {(getValue() as number).toLocaleString()}
          </span>
        ),
        size: 80,
      },
      {
        accessorKey: 'sessions',
        header: '访问量',
        cell: ({ getValue }) => (
          <span className="font-mono text-xs leading-5 tabular-nums text-term-text">
            {(getValue() as number).toLocaleString()}
          </span>
        ),
        size: 80,
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 rounded-none border border-term-border bg-term-bg font-mono text-[11px] leading-4 text-term-muted hover:border-term-border-strong hover:text-term-text"
            onClick={(e) => {
              e.stopPropagation()
              router.push(
                `/dashboard/operations/daily-analysis?projectId=${row.original.project_id}`
              )
            }}
          >
            详情
            <ExternalLink className="h-3 w-3" />
          </Button>
        ),
        size: 70,
      },
    ],
    [country, router]
  )

  const table = useReactTable({
    data: projects,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    // BLF-893：portfolio 表格终端化——零圆角、term 令牌、mono 等宽数值。
    <div className="rounded-none border border-term-border bg-term-bg">
      <div className="overflow-auto">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="border-term-border hover:bg-transparent">
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    style={{ width: header.getSize() }}
                    className="cursor-pointer select-none font-mono text-[11px] uppercase tracking-wider text-term-muted"
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <div className="flex items-center gap-1">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {{
                        asc: <ArrowUp className="h-3 w-3" />,
                        desc: <ArrowDown className="h-3 w-3" />,
                      }[header.column.getIsSorted() as string] ?? (
                        <ArrowUpDown className="h-3 w-3 opacity-30" />
                      )}
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} className="group border-term-border">
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} style={{ width: cell.column.getSize() }}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
