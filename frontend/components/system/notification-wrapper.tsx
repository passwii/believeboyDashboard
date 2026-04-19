'use client'

import { NotificationsProvider, NotificationToastContainer } from '@/components/notifications'
import { GlobalErrorBridge } from '@/components/system/global-error-bridge'

export function NotificationWrapper({ children }: { children: React.ReactNode }) {
  return (
    <NotificationsProvider>
      {children}
      <NotificationToastContainer />
      <GlobalErrorBridge />
    </NotificationsProvider>
  )
}
