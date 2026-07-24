'use client'

import { CrmClientProvider } from '@/lib/crm/api/crm-client-provider'
import { CrmDataScopeProvider } from '@/hooks/use-crm-data-scope'
import { FollowUpToast } from '@/components/crm/follow-up-toast'

export default function CrmLayout({ children }: { children: React.ReactNode }) {
  return (
    <CrmClientProvider>
      <CrmDataScopeProvider>
        {children}
        <FollowUpToast />
      </CrmDataScopeProvider>
    </CrmClientProvider>
  )
}
