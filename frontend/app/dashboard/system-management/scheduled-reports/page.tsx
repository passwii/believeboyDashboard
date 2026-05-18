import { Suspense } from 'react'
import { ScheduledReportsClient } from './scheduled-reports-client'

export default function ScheduledReportsPage() {
  return (
    <Suspense fallback={<div className="p-6">加载中...</div>}>
      <ScheduledReportsClient />
    </Suspense>
  )
}
