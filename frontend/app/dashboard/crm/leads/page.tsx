'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { CrmLeadTable } from '@/components/crm/lead-table'
import { CrmLeadForm } from '@/components/crm/crm-lead-form'
import { ScopeToggle } from '../customers/components/scope-toggle'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmUsers } from '@/hooks/use-crm-users'
import { useNotifications } from '@/components/notifications'
import type { LeadInput } from '@/lib/crm/types/lead'

export default function LeadsPage() {
  const client = useCrmClient()
  const { notify } = useNotifications()
  const users = useCrmUsers()
  const [open, setOpen] = useState(false)

  async function handleCreate(input: LeadInput) {
    await client.createLead(input)
    notify({ type: 'success', title: '线索已创建' })
    setOpen(false)
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">线索管理</h1>
          <p className="text-sm text-muted-foreground">线索列表、详情、跟进与转化为客户</p>
        </div>
        <div className="flex items-center gap-2">
          <ScopeToggle />
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> 新建线索
          </Button>
        </div>
      </div>
      <CrmLeadTable />

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full gap-0 p-0 sm:max-w-xl">
          <SheetHeader className="border-b border-border/60 px-5 py-4">
            <SheetTitle>新建线索</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <CrmLeadForm users={users} onSubmit={handleCreate} submitText="创建线索" />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
