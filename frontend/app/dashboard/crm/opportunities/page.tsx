import { CrmOpportunityTable } from '@/components/crm/opportunity-table'

export default function OpportunitiesPage() {
  return (
    <div className="space-y-4 p-4 md:p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">商机管理</h1>
        <p className="text-sm text-muted-foreground">商机列表与详情（只读）</p>
      </div>
      <CrmOpportunityTable />
    </div>
  )
}
