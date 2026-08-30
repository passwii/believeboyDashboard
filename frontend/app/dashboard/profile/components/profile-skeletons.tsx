'use client'

import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { TableSkeletonRows } from '@/components/ui/table-skeleton'

export function ProfileInfoSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
      <div className="space-y-2 md:col-span-2">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="space-y-2 md:col-span-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-10 w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 md:col-span-2 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-none border border-dashed border-border/60 bg-term-raised/30 p-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-5 w-24" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function ProfileAvatarSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[200px_1fr]">
      <div className="flex flex-col items-center gap-3">
        <Skeleton className="h-40 w-40 rounded-none" />
        <Skeleton className="h-3 w-24" />
      </div>
      <div className="space-y-4">
        <div className="rounded-none border border-dashed border-border/60 bg-term-raised/20 p-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-2 h-3 w-full" />
          <div className="mt-3 flex gap-2">
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-20" />
            <Skeleton className="h-9 w-24" />
          </div>
        </div>
        <div className="rounded-none border border-border/40 bg-card/40 p-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="mt-2 h-3 w-full" />
          <Skeleton className="mt-1 h-3 w-5/6" />
          <Skeleton className="mt-1 h-3 w-4/6" />
        </div>
      </div>
    </div>
  )
}

export function ProfileProjectsSkeleton() {
  return (
    <div className="overflow-hidden rounded-none border border-border/60">
      <div className="bg-term-raised/50 px-4 py-3">
        <Skeleton className="h-3 w-32" />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            {Array.from({ length: 7 }).map((_, i) => (
              <TableHead key={i}>
                <Skeleton className="h-3 w-16" />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableSkeletonRows columns={7} rows={5} />
        </TableBody>
      </Table>
    </div>
  )
}
