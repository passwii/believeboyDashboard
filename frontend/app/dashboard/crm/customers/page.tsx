'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { CrmCustomerTable, CrmFormCreate } from '@/components/crm'
import { ScopeToggle } from './components/scope-toggle'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
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
    <div className="flex h-full flex-col gap-3 p-4">
      {/* §8.1 PageHeader 原语 */}
      <PageHeader
        kicker="CRM"
        title="客户管理"
        description="100 条 mock · 排序 / 筛选 / 批量勾选 · Phase 1 MVP"
        actions={
          <>
            <ScopeToggle />
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="mr-1 h-4 w-4" /> 新建客户
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1">
        <CrmCustomerTable />
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full gap-0 p-0 sm:max-w-xl">
          <SheetHeader className="border-b border-border/60 px-5 py-4">
            <SheetTitle>新建客户</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <CrmFormCreate users={users} onSubmit={handleCreate} submitText="创建客户" />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
