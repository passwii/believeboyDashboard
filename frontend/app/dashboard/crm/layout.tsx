'use client'

import { CrmClientProvider } from '@/lib/crm/api/crm-client-provider'
import { CrmDataScopeProvider } from '@/hooks/use-crm-data-scope'
import { CrmUsersProvider } from '@/hooks/use-crm-users'
import { FollowUpToast } from '@/components/crm/follow-up-toast'

export default function CrmLayout({ children }: { children: React.ReactNode }) {
  return (
    <CrmClientProvider>
      <CrmUsersProvider>
        <CrmDataScopeProvider>
          {children}
          <FollowUpToast />
        </CrmDataScopeProvider>
      </CrmUsersProvider>
    </CrmClientProvider>
  )
}
