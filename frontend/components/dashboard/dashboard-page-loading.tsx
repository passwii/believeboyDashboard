import { Skeleton } from '@/components/ui/skeleton'

function SectionCardSkeleton() {
  return (
    <div className="rounded-2xl border border-border/70 bg-card/80 p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-8 w-40" />
        </div>
        <Skeleton className="h-11 w-11 rounded-xl" />
      </div>
      <Skeleton className="mt-6 h-3 w-24" />
    </div>
  )
}

export function DashboardPageLoading() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="space-y-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <div className="flex gap-3">
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-10 w-24" />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SectionCardSkeleton />
        <SectionCardSkeleton />
        <SectionCardSkeleton />
        <SectionCardSkeleton />
      </div>

      <div className="rounded-2xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="space-y-3">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </div>
          <div className="flex flex-wrap gap-3">
            <Skeleton className="h-10 w-40" />
            <Skeleton className="h-10 w-32" />
            <Skeleton className="h-10 w-32" />
          </div>
        </div>

        <div className="mt-6 grid gap-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </div>
    </div>
  )
}
