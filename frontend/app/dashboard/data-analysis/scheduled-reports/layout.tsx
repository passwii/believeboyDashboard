'use client'

import { useState } from 'react'
import { usePathname } from 'next/navigation'

import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
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
    resolveInitialTab(pathname),
  )
  // 懒挂载：首次访问该 tab 时才挂载其视图（避免一开始两个 tab 都发请求），
  // 挂载后常驻，切回时已加载的数据与状态保留，切换零重拉、零卡顿。
  const [mounted, setMounted] = useState<Set<ScheduledReportTabKey>>(
    () => new Set<ScheduledReportTabKey>([resolveInitialTab(pathname)]),
  )

  const handleTabChange = (next: string) => {
    setActiveTab(next as ScheduledReportTabKey)
    setMounted((prev) => {
      if (prev.has(next as ScheduledReportTabKey)) return prev
      const nextSet = new Set(prev)
      nextSet.add(next as ScheduledReportTabKey)
      return nextSet
    })
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

      <TabsContent
        value="subscriptions"
        forceMount
        className={cn('mt-0', !mounted.has('subscriptions') && 'hidden')}
      >
        {mounted.has('subscriptions') && <SubscriptionsView />}
      </TabsContent>
      <TabsContent
        value="ledger"
        forceMount
        className={cn('mt-0', !mounted.has('ledger') && 'hidden')}
      >
        {mounted.has('ledger') && <LedgerView />}
      </TabsContent>
    </Tabs>
  )
}
