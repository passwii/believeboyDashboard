import type { Viewport } from 'next'

import { CrmClientProvider } from '@/lib/crm/api/crm-client-provider'
import { CrmDataScopeProvider } from '@/hooks/use-crm-data-scope'
import { CrmUsersProvider } from '@/hooks/use-crm-users'
import { FollowUpToast } from '@/components/crm/follow-up-toast'
import { FollowUpReminderToast } from '@/components/crm/follow-up-reminder-toast'
import { TaskReminderToast } from '@/components/crm/task-reminder-toast'

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
}

export default function CrmLayout({ children }: { children: React.ReactNode }) {
  return (
    <CrmClientProvider>
      <CrmUsersProvider>
        <CrmDataScopeProvider>
          {children}
          <FollowUpToast />
          <FollowUpReminderToast />
          <TaskReminderToast />
        </CrmDataScopeProvider>
      </CrmUsersProvider>
    </CrmClientProvider>
  )
}
