'use client'

import { NotificationsProvider, NotificationToastContainer } from '@/components/notifications'
import { ChangeLogDialog } from '@/components/notifications/change-log-dialog'
import { GlobalErrorBridge } from '@/components/system/global-error-bridge'

export function NotificationWrapper({ children }: { children: React.ReactNode }) {
  return (
    <NotificationsProvider>
      {children}
      <NotificationToastContainer />
      <ChangeLogDialog />
      <GlobalErrorBridge />
    </NotificationsProvider>
  )
}
