import { FilterBarSkeleton, WideDataTableSkeleton } from '@/components/dashboard/page-skeletons'

export default function AdDataLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="页面加载中">
      <FilterBarSkeleton count={4} />
      <WideDataTableSkeleton columns={8} rows={8} />
    </div>
  )
}
