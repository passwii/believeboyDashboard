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
  status: 'Done' | 'In Process' | 'Draft'
  target: string
  limit: string
  reviewer: string
}

const data: Document[] = [
  {
    id: '1',
    header: 'Introduction to React',
    sectionType: 'Tutorial',
    status: 'Done',
    target: '1000',
    limit: '2000',
    reviewer: 'John Doe',
  },
  {
    id: '2',
    header: 'Advanced TypeScript',
    sectionType: 'Guide',
    status: 'In Process',
    target: '500',
    limit: '1000',
    reviewer: 'Jane Smith',
  },
  {
    id: '3',
    header: 'Next.js Best Practices',
    sectionType: 'Article',
    status: 'Draft',
    target: '800',
    limit: '1500',
    reviewer: 'Bob Johnson',
  },
  {
    id: '4',
    header: 'Tailwind CSS Tips',
    sectionType: 'Tutorial',
    status: 'Done',
    target: '600',
    limit: '1200',
    reviewer: 'Alice Brown',
  },
  {
    id: '5',
    header: 'API Design Patterns',
    sectionType: 'Guide',
    status: 'In Process',
    target: '400',
    limit: '800',
    reviewer: 'Charlie Wilson',
  },
  {
    id: '6',
    header: 'Database Optimization',
    sectionType: 'Article',
    status: 'Done',
    target: '700',
    limit: '1400',
    reviewer: 'Diana Lee',
  },
  {
    id: '7',
    header: 'Security Best Practices',
    sectionType: 'Guide',
    status: 'Draft',
    target: '900',
    limit: '1800',
    reviewer: 'Eve Davis',
  },
  {
    id: '8',
    header: 'Performance Monitoring',
    sectionType: 'Tutorial',
    status: 'In Process',
    target: '550',
    limit: '1100',
    reviewer: 'Frank Miller',
  },
  {
    id: '9',
    header: 'CI/CD Pipeline Setup',
    sectionType: 'Article',
    status: 'Done',
    target: '650',
    limit: '1300',
    reviewer: 'Grace Taylor',
  },
  {
    id: '10',
    header: 'Testing Strategies',
    sectionType: 'Guide',
    status: 'Draft',
    target: '750',
    limit: '1500',
    reviewer: 'Henry Anderson',
  },
]

const statusStyles = {
  Done: 'bg-green-500/10 text-green-500 hover:bg-green-500/20',
  'In Process': 'bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20',
  Draft: 'bg-gray-500/10 text-gray-500 hover:bg-gray-500/20',
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
          Header
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
          Section Type
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
    header: () => <div className="text-right">Target</div>,
    cell: ({ row }) => {
      const amount = parseFloat(row.getValue('target'))
      return <div className="text-right font-medium">{amount.toLocaleString()}</div>
    },
  },
  {
    accessorKey: 'limit',
    header: () => <div className="text-right">Limit</div>,
    cell: ({ row }) => {
      const amount = parseFloat(row.getValue('limit'))
      return <div className="text-right font-medium">{amount.toLocaleString()}</div>
    },
  },
  {
    accessorKey: 'reviewer',
    header: 'Reviewer',
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
              Copy document ID
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>View details</DropdownMenuItem>
            <DropdownMenuItem>Edit document</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-red-600">
              Delete
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-2 py-4">
        <Input
          placeholder="Filter documents..."
          value={(table.getColumn('header')?.getFilterValue() as string) ?? ''}
          onChange={(event) =>
            table.getColumn('header')?.setFilterValue(event.target.value)
          }
          className="h-10 max-w-sm bg-background/80 text-sm min-w-touch"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="h-10 min-w-touch">
              Columns <ChevronDown className="ml-2 h-4 w-4" />
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
      <div className="rounded-lg border border-border/80 bg-background/60 overflow-x-auto">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  return (
                    <TableHead key={header.id} className="h-11 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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
                  className="transition-colors hover:bg-muted/50"
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="py-3.5 text-sm">
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
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-end space-x-2 py-4">
        <div className="flex-1 text-sm text-muted-foreground">
          {table.getFilteredSelectedRowModel().rows.length} of{' '}
          {table.getFilteredRowModel().rows.length} row(s) selected.
        </div>
        <div className="space-x-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  )
}
