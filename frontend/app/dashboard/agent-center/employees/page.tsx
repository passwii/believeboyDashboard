import { Metadata } from 'next'
import AgentEmployeesClient from './employees-client'

export const metadata: Metadata = {
  title: 'Agent 员工',
  description: '凭据即身份:Agent 员工花名册与最近活动',
}

export default function AgentEmployeesPage() {
  return <AgentEmployeesClient />
}
