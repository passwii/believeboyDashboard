'use client'

import { NotificationsProvider, NotificationToastContainer } from '@/components/notifications'
import { GlobalErrorBridge } from '@/components/system/global-error-bridge'
import { ConfirmProvider } from '@/hooks/use-confirm'

export function NotificationWrapper({ children }: { children: React.ReactNode }) {
  return (
    <NotificationsProvider>
      <ConfirmProvider>
        {children}
        <NotificationToastContainer />
        <GlobalErrorBridge />
      </ConfirmProvider>
    </NotificationsProvider>
  )
}
