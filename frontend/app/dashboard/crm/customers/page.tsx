'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { CrmCustomerTable, CrmFormCreate } from '@/components/crm'
import { ScopeToggle } from './components/scope-toggle'
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
import type { CustomerInput } from '@/lib/crm/types/customer'

export default function CustomersPage() {
  const client = useCrmClient()
  const { notify } = useNotifications()
  const users = useCrmUsers()
  const [open, setOpen] = useState(false)

  async function handleCreate(input: CustomerInput) {
    await client.createCustomer(input)
    notify({ type: 'success', title: '客户已创建' })
    setOpen(false)
  }

  return (
    // BLF-837：页面标题已由 Top Header 面包屑承载（BLF-824 去重原则），页面只留工具行 + 表格
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-1.5 max-md:justify-between">
        <ScopeToggle />
        <Button
          size="sm"
          className="h-8 shrink-0 rounded-none border border-term-border bg-term-panel px-2 font-mono text-xs text-term-muted hover:border-term-border-strong hover:text-term-text"
          onClick={() => setOpen(true)}
        >
          <Plus className="mr-0.5 h-4 w-4" /> 新建客户
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <CrmCustomerTable />
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full gap-0 rounded-none p-0 sm:max-w-xl">
          <SheetHeader className="rounded-none border-b border-term-border bg-term-panel px-3 py-2">
            <SheetTitle className="text-sm uppercase tracking-wider text-term-muted">
              新建客户
            </SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto bg-term-panel px-3 py-3">
            <CrmFormCreate users={users} onSubmit={handleCreate} submitText="创建客户" />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
