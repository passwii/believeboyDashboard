import { Suspense } from 'react'
import { AgentManagementClient } from './agent-management-client'

export default function AgentManagementPage() {
  return (
    <Suspense fallback={<div className="p-6">加载中...</div>}>
      <AgentManagementClient />
    </Suspense>
  )
}
