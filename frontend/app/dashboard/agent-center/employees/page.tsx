import { Metadata } from 'next'
import AgentEmployeesClient from './employees-client'

export const metadata: Metadata = {
  title: 'Agent 员工',
}

export default function AgentEmployeesPage() {
  return <AgentEmployeesClient />
}
