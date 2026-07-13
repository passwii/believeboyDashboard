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
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
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
            <span className="font-medium">{row.original.project_name}</span>
          </div>
        ),
        size: 160,
      },
      {
        accessorKey: 'sales_amount',
        header: '销售额',
        cell: ({ getValue }) => (
          <span className="tabular-nums">{formatMoney(getValue() as number, country)}</span>
        ),
        size: 120,
      },
      {
        accessorKey: 'sales_contribution',
        header: '占比',
        cell: ({ getValue }) => (
          <span className="tabular-nums text-muted-foreground">
            {formatPercent(getValue() as number)}
          </span>
        ),
        size: 80,
      },
      {
        accessorKey: 'order_qty',
        header: '订单量',
        cell: ({ getValue }) => (
          <span className="tabular-nums">{(getValue() as number).toLocaleString()}</span>
        ),
        size: 80,
      },
      {
        accessorKey: 'ad_spend',
        header: '广告费',
        cell: ({ getValue }) => (
          <span className="tabular-nums">{formatMoney(getValue() as number, country)}</span>
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
          if (clicks === 0) return <span className="text-muted-foreground">--</span>
          return (
            <span className="tabular-nums">
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
          <span className="tabular-nums">{formatPercent(getValue() as number)}</span>
        ),
        size: 80,
      },
      {
        accessorKey: 'clicks',
        header: '点击量',
        cell: ({ getValue }) => (
          <span className="tabular-nums">{(getValue() as number).toLocaleString()}</span>
        ),
        size: 80,
      },
      {
        accessorKey: 'sessions',
        header: '访问量',
        cell: ({ getValue }) => (
          <span className="tabular-nums">{(getValue() as number).toLocaleString()}</span>
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
            className="h-7 gap-1 text-xs"
            onClick={(e) => {
              e.stopPropagation()
              router.push(
                `/dashboard/data-analysis/daily-analysis?projectId=${row.original.project_id}`
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
    <div className="dashboard-surface rounded-xl">
      <div className="overflow-auto">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    style={{ width: header.getSize() }}
                    className="cursor-pointer select-none"
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
              <TableRow key={row.id} className="group">
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
