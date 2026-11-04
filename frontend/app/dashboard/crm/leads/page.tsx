'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'

import {
  WarmCrmPage,
  WarmCrmRecordDrawer,
  WarmCrmToolbar,
} from '@/components/dashboard-v2/warm-ledger/crm'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { CrmLeadTable } from '@/components/crm/lead-table'
import { CrmLeadForm } from '@/components/crm/crm-lead-form'
import { useNotifications } from '@/components/notifications'
import { useCrmDataScope } from '@/hooks/use-crm-data-scope'
import { useCrmUsers } from '@/hooks/use-crm-users'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import type { LeadInput } from '@/lib/crm/types/lead'
import { cn } from '@/lib/utils'

import styles from './leads-warm.module.css'

function LeadScopeToggle() {
  const { scope, setScope } = useCrmDataScope()

  return (
    <div aria-label="数据范围" className={styles.scopeToggle} role="radiogroup">
      {(
        [
          { value: 'mine', label: '我的' },
          { value: 'all', label: '全部' },
        ] as const
      ).map((option) => (
        <button
          aria-checked={scope === option.value}
          className={cn(
            styles.scopeOption,
            scope === option.value && styles.scopeOptionActive
          )}
          key={option.value}
          onClick={() => setScope(option.value)}
          role="radio"
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

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
    <WarmCrmPage className={styles.page} data-warm-lead-page>
      <WarmCrmToolbar
        ariaLabel="线索工具栏"
        className={styles.pageToolbar}
        start={<LeadScopeToggle />}
        end={
          <WarmButton onClick={() => setOpen(true)} variant="primary">
            <Plus aria-hidden="true" />
            新建线索
          </WarmButton>
        }
      />

      <CrmLeadTable />

      <WarmCrmRecordDrawer onOpenChange={setOpen} open={open} title="新建线索">
        <CrmLeadForm onSubmit={handleCreate} submitText="创建线索" users={users} />
      </WarmCrmRecordDrawer>
    </WarmCrmPage>
  )
}
