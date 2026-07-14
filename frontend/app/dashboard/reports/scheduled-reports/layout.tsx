'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'

import { Tabs, TabsList } from '@/components/ui/tabs'
import { SlidingTabsTrigger, TabsMotionGroup } from '@/components/ui/tab-motion'
import { cn } from '@/lib/utils'

import SubscriptionsView from './_components/SubscriptionsView'
import LedgerView from './_components/LedgerView'

type ScheduledReportTabKey = 'subscriptions' | 'ledger'

const TAB_LAYOUT_ID = 'scheduled-reports-tab-indicator'

function resolveInitialTab(pathname: string): ScheduledReportTabKey {
  return pathname.includes('/ledger') ? 'ledger' : 'subscriptions'
}

export default function ScheduledReportsLayout() {
  const pathname = usePathname()
  const [activeTab, setActiveTab] = useState<ScheduledReportTabKey>(() =>
    resolveInitialTab(pathname)
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

      {/* 两个 view 常驻挂载，靠 hidden 切换可见性：切 tab 不卸载、不重新拉取数据，
          骨架屏仅在各自首次加载时出现一次。 */}
      <div className={cn(activeTab === 'subscriptions' ? 'block' : 'hidden')}>
        <SubscriptionsView />
      </div>
      <div className={cn(activeTab === 'ledger' ? 'block' : 'hidden')}>
        <LedgerView />
      </div>
    </Tabs>
  )
}
