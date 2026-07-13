'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'

import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import { DirectionalTabTransition, SlidingTabsTrigger, TabsMotionGroup } from '@/components/ui/tab-motion'

import SubscriptionsView from './_components/SubscriptionsView'
import LedgerView from './_components/LedgerView'

type ScheduledReportTabKey = 'subscriptions' | 'ledger'

const TAB_LAYOUT_ID = 'scheduled-reports-tab-indicator'
const TAB_ORDER: readonly ScheduledReportTabKey[] = ['subscriptions', 'ledger']

function resolveInitialTab(pathname: string): ScheduledReportTabKey {
  return pathname.includes('/ledger') ? 'ledger' : 'subscriptions'
}

export default function ScheduledReportsLayout() {
  const pathname = usePathname()
  const [activeTab, setActiveTab] = useState<ScheduledReportTabKey>(() =>
    resolveInitialTab(pathname),
  )

  const handleTabChange = (next: string) => {
    setActiveTab(next as ScheduledReportTabKey)
  }

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4">
      <div className="overflow-x-auto">
        <TabsList className="w-full justify-start rounded-2xl border border-border/70 bg-background/95 p-1 backdrop-blur supports-[backdrop-filter]:bg-background/60 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]/95 sm:w-fit">
          <TabsMotionGroup id="scheduled-reports-tabs">
            <SlidingTabsTrigger
              value="subscriptions"
              activeValue={activeTab}
              layoutId={TAB_LAYOUT_ID}
              className="min-w-[7rem]"
            >
              订阅管理
            </SlidingTabsTrigger>
            <SlidingTabsTrigger
              value="ledger"
              activeValue={activeTab}
              layoutId={TAB_LAYOUT_ID}
              className="min-w-[7rem]"
            >
              调度记录
            </SlidingTabsTrigger>
          </TabsMotionGroup>
        </TabsList>
      </div>

      <DirectionalTabTransition value={activeTab} order={TAB_ORDER}>
        <TabsContent forceMount value={activeTab} className="mt-0">
          {activeTab === 'subscriptions' && <SubscriptionsView />}
          {activeTab === 'ledger' && <LedgerView />}
        </TabsContent>
      </DirectionalTabTransition>
    </Tabs>
  )
}
