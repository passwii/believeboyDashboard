'use client'

import { CrmFollowUpList } from '@/components/crm/follow-up-list'
import { ScopeToggle } from '../customers/components/scope-toggle'

export default function FollowUpsPage() {
  return (
    // BLF-837：页面标题已由 Top Header 面包屑承载（BLF-824 去重原则）
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-end max-md:justify-between">
        <ScopeToggle />
      </div>
      <div className="min-h-0 flex-1">
        <CrmFollowUpList />
      </div>
    </div>
  )
}
