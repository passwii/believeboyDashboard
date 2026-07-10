'use client'

import { CrmClientProvider } from '@/lib/crm/api/crm-client-provider'
import { CrmDataScopeProvider } from '@/hooks/use-crm-data-scope'

export default function CrmLayout({ children }: { children: React.ReactNode }) {
 return (
 <CrmClientProvider>
 <CrmDataScopeProvider>{children}</CrmDataScopeProvider>
 </CrmClientProvider>
 )
}