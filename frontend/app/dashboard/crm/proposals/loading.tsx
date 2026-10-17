import { DataTableSkeleton, FilterBarSkeleton } from '@/components/dashboard/page-skeletons'

export default function CustomerProposalsLoading() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="页面加载中" data-testid="page-skeleton-customer-proposals">
      <FilterBarSkeleton count={3} />
      <div className="h-72 overflow-hidden border border-term-border bg-term-panel">
        <DataTableSkeleton columns={7} rows={7} />
      </div>
    </div>
  )
}
