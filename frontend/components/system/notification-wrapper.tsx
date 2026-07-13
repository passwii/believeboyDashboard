'use client'

import dynamic from 'next/dynamic'
import { NotificationsProvider } from '@/components/notifications'
import { GlobalErrorBridge } from '@/components/system/global-error-bridge'
import { ConfirmProvider } from '@/hooks/use-confirm'

// Toast 容器只在真正弹通知时才挂载，避免把 framer-motion (~50 KB gz) 拖入首屏 bundle。
const NotificationToastContainer = dynamic(
  () => import('@/components/notifications').then((m) => m.NotificationToastContainer),
  { ssr: false }
)

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
