import { CrmLeadTable } from '@/components/crm/lead-table'
import { ScopeToggle } from '../customers/components/scope-toggle'

export default function LeadsPage() {
  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">线索管理</h1>
          <p className="text-sm text-muted-foreground">线索列表、详情、跟进与转化为客户</p>
        </div>
        <ScopeToggle />
      </div>
      <CrmLeadTable />
    </div>
  )
}
