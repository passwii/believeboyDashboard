import { Suspense } from 'react'
import { BackupManagementClient } from './backup-management-client'

export default function BackupManagementPage() {
  return (
    <Suspense fallback={<div className="p-6">加载中...</div>}>
      <BackupManagementClient />
    </Suspense>
  )
}
