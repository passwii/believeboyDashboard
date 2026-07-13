'use client'

import { CrmCustomerTable } from '@/components/crm'
import { ScopeToggle } from './components/scope-toggle'

export default function CustomersPage() {
  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">客户管理</h1>
          <p className="text-xs text-muted-foreground">
            100 条 mock · 排序 / 筛选 / 批量勾选 · Phase 1 MVP
          </p>
        </div>
        <ScopeToggle />
      </header>
      <div className="min-h-0 flex-1">
        <CrmCustomerTable />
      </div>
    </div>
  )
}
