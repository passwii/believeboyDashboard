'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { CrmCustomerTable, CrmFormCreate } from '@/components/crm'
import { ScopeToggle } from './components/scope-toggle'
import {
  WarmCrmPage,
  WarmCrmRecordDrawer,
  WarmCrmToolbar,
} from '@/components/dashboard-v2/warm-ledger/crm'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
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
    <WarmCrmPage>
      <WarmCrmToolbar
        ariaLabel="客户工具栏"
        start={<ScopeToggle />}
        end={
          <WarmButton variant="primary" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" /> 新建客户
          </WarmButton>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <CrmCustomerTable />
      </div>

      <WarmCrmRecordDrawer open={open} onOpenChange={setOpen} title="新建客户">
        <CrmFormCreate users={users} onSubmit={handleCreate} submitText="创建客户" />
      </WarmCrmRecordDrawer>
    </WarmCrmPage>
  )
}
