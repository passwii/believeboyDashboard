'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { CrmOpportunityTable } from '@/components/crm/opportunity-table'
import { CrmOpportunityForm } from '@/components/crm/crm-opportunity-form'
import { ScopeToggle } from '../customers/components/scope-toggle'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useNotifications } from '@/components/notifications'
import type { OpportunityInput } from '@/lib/crm/types/opportunity'

export default function OpportunitiesPage() {
  const client = useCrmClient()
  const { notify } = useNotifications()
  const [open, setOpen] = useState(false)

  async function handleCreate(input: OpportunityInput) {
    await client.createOpportunity(input)
    notify({ type: 'success', title: '商机已创建' })
    setOpen(false)
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">商机管理</h1>
          <p className="text-sm text-muted-foreground">商机列表、详情、跟进与新建/编辑</p>
        </div>
        <div className="flex items-center gap-2">
          <ScopeToggle />
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> 新建商机
          </Button>
        </div>
      </div>
      <CrmOpportunityTable />

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full gap-0 p-0 sm:max-w-xl">
          <SheetHeader className="border-b border-border/60 px-5 py-4">
            <SheetTitle>新建商机</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <CrmOpportunityForm users={[]} onSubmit={handleCreate} submitText="创建商机" />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
