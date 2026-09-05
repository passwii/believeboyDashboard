import { Metadata } from 'next'
import AgentOverviewClient from './agent-overview-client'

export const metadata: Metadata = {
  title: '数据流总览',
  description: 'Agent 各业务域活动归集点:接入状态、能力与前端入口',
}

export default function AgentCenterOverviewPage() {
  return <AgentOverviewClient />
}
