'use client'

import { useCallback, useState } from 'react'
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
  // BEL-422：非激活 tab 的 view 首次激活前不挂载 —— 避免进入页面就为看不到的
  // tab 拉数（订阅/台账各带 2-3 个 mount 请求）。一旦激活过就保持挂载，
  // 靠 hidden 切换可见性：切 tab 不卸载、不重新拉取数据。
  const [activatedTabs, setActivatedTabs] = useState<Set<ScheduledReportTabKey>>(
    () => new Set([resolveInitialTab(pathname)])
  )

  const handleTabChange = useCallback((next: string) => {
    const key = next as ScheduledReportTabKey
    setActiveTab(key)
    setActivatedTabs((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
  }, [])

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

      {/* 首次激活后才挂载；挂载后常驻，靠 hidden 切换可见性：
          切 tab 不卸载、不重新拉取数据，骨架屏仅在各自首次加载时出现一次。 */}
      {activatedTabs.has('subscriptions') && (
        <div className={cn(activeTab === 'subscriptions' ? 'block' : 'hidden')}>
          <SubscriptionsView />
        </div>
      )}
      {activatedTabs.has('ledger') && (
        <div className={cn(activeTab === 'ledger' ? 'block' : 'hidden')}>
          <LedgerView />
        </div>
      )}
    </Tabs>
  )
}
