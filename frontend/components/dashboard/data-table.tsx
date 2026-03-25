'use client'

import * as React from 'react'
import {
  ColumnDef,
  ColumnFiltersState,
  SortingState,
  VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { ArrowUpDown, ChevronDown, MoreHorizontal } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

// Sample data
export type Document = {
  id: string
  header: string
  sectionType: string
  status: '已完成' | '处理中' | '待补充'
  target: string
  limit: string
  reviewer: string
}

const data: Document[] = [
  {
    id: '1',
    header: '北美站点周度投放复盘',
    sectionType: '广告分析',
    status: '已完成',
    target: '92',
    limit: '100',
    reviewer: 'Ariel',
  },
  {
    id: '2',
    header: 'Q2 补货节奏校准方案',
    sectionType: '补货分析',
    status: '处理中',
    target: '68',
    limit: '100',
    reviewer: 'Lina',
  },
  {
    id: '3',
    header: '英国店铺 SKU 成本核对',
    sectionType: 'SKU 信息',
    status: '待补充',
    target: '44',
    limit: '100',
    reviewer: 'Carter',
  },
  {
    id: '4',
    header: '三月月报利润异常追踪',
    sectionType: '财务月报',
    status: '已完成',
    target: '97',
    limit: '100',
    reviewer: 'Faye',
  },
  {
    id: '5',
    header: '新品关键词调研卡片',
    sectionType: '调研分析',
    status: '处理中',
    target: '56',
    limit: '100',
    reviewer: 'Nora',
  },
  {
    id: '6',
    header: '站点导航资源清单',
    sectionType: '运营导航',
    status: '已完成',
    target: '88',
    limit: '100',
    reviewer: 'Dean',
  },
  {
    id: '7',
    header: '异常退款订单排查',
    sectionType: '销售日报',
    status: '待补充',
    target: '39',
    limit: '100',
    reviewer: 'Mika',
  },
  {
    id: '8',
    header: '广告流量质量对照看板',
    sectionType: '流量分析',
    status: '处理中',
    target: '71',
    limit: '100',
    reviewer: 'Sean',
  },
  {
    id: '9',
    header: '店铺导航快捷入口整理',
    sectionType: '店铺导航',
    status: '已完成',
    target: '81',
    limit: '100',
    reviewer: 'Ivy',
  },
  {
    id: '10',
    header: '项目佣金归档复核',
    sectionType: '佣金管理',
    status: '待补充',
    target: '52',
    limit: '100',
    reviewer: 'Yuna',
  },
]

const statusStyles = {
  已完成: 'bg-secondary/10 text-secondary hover:bg-secondary/15',
  处理中: 'bg-primary/10 text-primary hover:bg-primary/15',
  待补充: 'bg-destructive/10 text-destructive hover:bg-destructive/15',
}

export const columns: ColumnDef<Document>[] = [
  {
    id: 'select',
    header: ({ table }) => (
      <Checkbox
        checked={
          table.getIsAllPageRowsSelected() ||
          (table.getIsSomePageRowsSelected() && 'indeterminate')
        }
        onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
        aria-label="Select all"
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(value) => row.toggleSelected(!!value)}
        aria-label="Select row"
      />
    ),
    enableSorting: false,
    enableHiding: false,
  },
  {
    accessorKey: 'header',
    header: ({ column }) => {
      return (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
        >
          条目
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      )
    },
    cell: ({ row }) => <div className="font-medium">{row.getValue('header')}</div>,
  },
  {
    accessorKey: 'sectionType',
    header: ({ column }) => {
      return (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
        >
          类型
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      )
    },
    cell: ({ row }) => <div>{row.getValue('sectionType')}</div>,
  },
  {
    accessorKey: 'status',
    header: ({ column }) => {
      return (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
        >
          Status
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      )
    },
    cell: ({ row }) => {
      const status = row.getValue('status') as Document['status']
      return (
        <Badge variant="secondary" className={statusStyles[status]}>
          {status}
        </Badge>
      )
    },
  },
  {
    accessorKey: 'target',
    header: () => <div className="text-right">进度</div>,
    cell: ({ row }) => {
      const amount = parseFloat(row.getValue('target'))
      return <div className="text-right font-medium">{amount.toLocaleString()}</div>
    },
  },
  {
    accessorKey: 'limit',
    header: () => <div className="text-right">目标</div>,
    cell: ({ row }) => {
      const amount = parseFloat(row.getValue('limit'))
      return <div className="text-right font-medium">{amount.toLocaleString()}</div>
    },
  },
  {
    accessorKey: 'reviewer',
    header: '负责人',
    cell: ({ row }) => <div>{row.getValue('reviewer')}</div>,
  },
  {
    id: 'actions',
    enableHiding: false,
    cell: ({ row }) => {
      const document = row.original

      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 p-0">
              <span className="sr-only">Open menu</span>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => navigator.clipboard.writeText(document.id)}
            >
              复制任务 ID
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>查看详情</DropdownMenuItem>
            <DropdownMenuItem>编辑条目</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-red-600">
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )
    },
  },
]

export function DataTable() {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({})
  const [rowSelection, setRowSelection] = React.useState({})

  const table = useReactTable({
    data,
    columns,
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      rowSelection,
    },
  })

  return (
    <div className="w-full space-y-4">
      <div className="dashboard-toolbar flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
        <Input
          placeholder="筛选任务、报表或条目..."
          value={(table.getColumn('header')?.getFilterValue() as string) ?? ''}
          onChange={(event) =>
            table.getColumn('header')?.setFilterValue(event.target.value)
          }
          className="h-11 max-w-sm min-w-touch border-white/40 bg-background/88 text-sm shadow-none"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="h-11 min-w-touch border-white/40 bg-background/88 shadow-none">
              视图列 <ChevronDown className="ml-2 h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {table
              .getAllColumns()
              .filter((column) => column.getCanHide())
              .map((column) => {
                return (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    className="capitalize"
                    checked={column.getIsVisible()}
                    onCheckedChange={(value) =>
                      column.toggleVisibility(!!value)
                    }
                  >
                    {column.id}
                  </DropdownMenuCheckboxItem>
                )
              })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="rounded-lg border border-white/45 bg-[hsl(var(--surface-subtle))] p-1.5">
        <Table className="overflow-hidden rounded-lg bg-background/96">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  return (
                    <TableHead key={header.id}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && 'selected'}
                  className="transition-colors hover:bg-[hsl(var(--surface-subtle))]"
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="px-3 py-3">
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center"
                >
                  暂无结果。
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-end space-x-2 py-2">
        <div className="flex-1 text-sm text-muted-foreground">
          已选择 {table.getFilteredSelectedRowModel().rows.length} / {table.getFilteredRowModel().rows.length} 条。
        </div>
        <div className="space-x-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            下一页
          </Button>
        </div>
      </div>
    </div>
  )
}
