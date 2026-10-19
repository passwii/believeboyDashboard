import { Skeleton } from '@/components/ui/skeleton'

export default function ReviewTrackingLoading() {
  return (
    <div className="w-full space-y-4">
      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <div className="space-y-2">
          <Skeleton className="h-4 w-24 rounded-none" />
          <Skeleton className="h-16 w-full rounded-none" />
          <Skeleton className="h-16 w-full rounded-none" />
          <Skeleton className="h-16 w-full rounded-none" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-10 w-72 rounded-none" />
          <Skeleton className="h-[300px] w-full rounded-none" />
        </div>
      </div>
    </div>
  )
}
