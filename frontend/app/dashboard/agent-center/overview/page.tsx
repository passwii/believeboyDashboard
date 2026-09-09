import { Metadata } from 'next'
import AgentOverviewClient from './agent-overview-client'

export const metadata: Metadata = {
  title: '数据流总览',
}

export default function AgentCenterOverviewPage() {
  return <AgentOverviewClient />
}
