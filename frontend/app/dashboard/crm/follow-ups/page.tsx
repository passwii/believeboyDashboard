'use client'

import { CrmFollowUpList } from '@/components/crm/follow-up-list'
import { ScopeToggle } from '../customers/components/scope-toggle'
import {
  WarmCrmPage,
  WarmCrmToolbar,
} from '@/components/dashboard-v2/warm-ledger/crm'

export default function FollowUpsPage() {
  return (
    // BLF-837：页面标题已由 Top Header 面包屑承载（BLF-824 去重原则）
    <WarmCrmPage>
      <WarmCrmToolbar ariaLabel="待跟进工具栏" end={<ScopeToggle />} />
      <div className="min-h-0 flex-1">
        <CrmFollowUpList />
      </div>
    </WarmCrmPage>
  )
}
