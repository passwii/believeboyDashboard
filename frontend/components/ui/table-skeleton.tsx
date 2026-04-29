'use client'

import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

interface TableSkeletonRowsProps {
  columns: number
  rows?: number
  widths?: string[]
  cellClassName?: string
  rowClassName?: string
}

export function TableSkeletonRows({
  columns,
  rows = 6,
  widths,
  cellClassName,
  rowClassName,
}: TableSkeletonRowsProps) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <TableRow key={`table-skeleton-${rowIndex}`} className={rowClassName}>
          {Array.from({ length: columns }).map((__, cellIndex) => (
            <TableCell key={cellIndex} className={cellClassName}>
              <Skeleton className={cn('h-4', widths?.[cellIndex] ?? 'w-20')} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  )
}

interface BarSkeletonProps {
  rows?: number
  height?: string
  className?: string
}

export function BarSkeleton({
  rows = 5,
  height = 'h-10',
  className,
}: BarSkeletonProps) {
  return (
    <div className={cn('space-y-3', className)}>
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className={cn(height, 'w-full')} />
      ))}
    </div>
  )
}

interface PricingTableSkeletonProps {
  rows?: number
}

export function PricingTableSkeleton({ rows = 8 }: PricingTableSkeletonProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {Array.from({ length: 6 }).map((_, index) => (
            <TableHead key={index}>
              <Skeleton className='h-4 w-full' />
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <TableRow key={rowIndex}>
            {Array.from({ length: 6 }).map((_, cellIndex) => (
              <TableCell key={cellIndex}>
                <Skeleton className='h-4 w-16' />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
