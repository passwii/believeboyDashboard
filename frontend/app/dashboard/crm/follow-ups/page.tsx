'use client'

import { CrmFollowUpList } from '@/components/crm/follow-up-list'
import { ScopeToggle } from '../customers/components/scope-toggle'

export default function FollowUpsPage() {
  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">待跟进</h1>
          <p className="text-sm text-muted-foreground">逾期 / 今日 / 本周需要跟进的客户与线索，点开即可记跟进</p>
        </div>
        <ScopeToggle />
      </div>
      <CrmFollowUpList />
    </div>
  )
}
