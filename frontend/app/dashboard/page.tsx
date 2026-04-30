'use client'

import { useSession } from 'next-auth/react'

import { DashboardSalesChart } from '@/components/dashboard/dashboard-sales-chart'
import { DashboardPlanPlaceholder } from '@/components/dashboard/dashboard-plan-placeholder'
import { DashboardPageLoading } from '@/components/dashboard/dashboard-page-loading'
import { FactoryDashboard } from '@/components/dashboard/factory-dashboard'

export default function DashboardPage() {
  const { data: session, status } = useSession()
  const roleType = session?.user?.roleType as string | undefined
  const operatorName = session?.user?.operatorNameZh ?? session?.user?.name ?? undefined

  if (status === 'loading') {
    return <DashboardPageLoading />
  }

  if (roleType === 'factory') {
    return <FactoryDashboard operatorName={operatorName} />
  }

  return (
    <div className="space-y-6">
      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_22rem]">
        <DashboardSalesChart session={session} />
        <DashboardPlanPlaceholder />
      </section>
    </div>
  )
}
