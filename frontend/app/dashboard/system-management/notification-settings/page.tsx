import { Suspense } from 'react'
import { NotificationSettingsClient } from './notification-settings-client'

export default function NotificationSettingsPage() {
  return (
    <Suspense fallback={<div className="p-6">加载中...</div>}>
      <NotificationSettingsClient />
    </Suspense>
  )
}