import { WideDataTableSkeleton } from '@/components/dashboard/page-skeletons'
import { Skeleton } from '@/components/ui/skeleton'

export default function AiInsightsLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="页面加载中">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-term-border pb-3">
        <div className="space-y-2"><Skeleton className="h-5 w-44 rounded-none" /><Skeleton className="h-3 w-64 max-w-full rounded-none" /></div>
        <div className="flex gap-2"><Skeleton className="h-9 w-28 rounded-none" /><Skeleton className="h-9 w-24 rounded-none" /></div>
      </div>
      <div className="flex flex-wrap items-center gap-2"><Skeleton className="h-9 w-40 rounded-none" /><Skeleton className="h-9 w-32 rounded-none" /><Skeleton className="h-9 w-28 rounded-none" /><Skeleton className="h-9 w-24 rounded-none" /></div>
      <WideDataTableSkeleton columns={6} rows={7} />
    </div>
  )
}
