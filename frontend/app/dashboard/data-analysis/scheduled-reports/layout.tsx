'use client'

import type { ReactNode } from 'react'
import { useCallback } from 'react'
import { usePathname, useRouter } from 'next/navigation'

import { SlidingTabsTrigger, TabsMotionGroup } from '@/components/ui/tab-motion'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'

const TABS = [
  {
    key: 'subscriptions',
    label: '订阅管理',
    href: '/dashboard/data-analysis/scheduled-reports/subscriptions',
  },
  {
    key: 'ledger',
    label: '调度记录',
    href: '/dashboard/data-analysis/scheduled-reports/ledger',
  },
] as const

type ScheduledReportTabKey = (typeof TABS)[number]['key']

function resolveActiveTab(pathname: string): ScheduledReportTabKey {
  return TABS.find((tab) => pathname.startsWith(tab.href))?.key ?? 'subscriptions'
}

function isScheduledReportTab(value: string): value is ScheduledReportTabKey {
  return TABS.some((tab) => tab.key === value)
}

export default function ScheduledReportsLayout({
  children,
}: {
  children: ReactNode
}) {
  const pathname = usePathname()
  const router = useRouter()
  const activeTab = resolveActiveTab(pathname)

  const handleTabChange = useCallback(
    (nextValue: string) => {
      if (!isScheduledReportTab(nextValue)) return

      const nextTab = TABS.find((tab) => tab.key === nextValue)
      if (!nextTab || pathname.startsWith(nextTab.href)) return

      router.push(nextTab.href)
    },
    [pathname, router],
  )

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4">
      <div className="overflow-x-auto">
        <TabsList className="w-full justify-start rounded-2xl border border-border/70 bg-background/95 p-1 backdrop-blur supports-[backdrop-filter]:bg-background/60 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]/95 sm:w-fit">
          <TabsMotionGroup id="scheduled-reports-tabs">
            {TABS.map((tab) => (
              <SlidingTabsTrigger
                key={tab.key}
                value={tab.key}
                activeValue={activeTab}
                layoutId="scheduled-reports-tabs"
                className="min-w-[7rem]"
              >
                {tab.label}
              </SlidingTabsTrigger>
            ))}
          </TabsMotionGroup>
        </TabsList>
      </div>

      {TABS.map((tab) => (
        <TabsContent key={tab.key} value={tab.key} className="mt-0">
          {activeTab === tab.key ? children : null}
        </TabsContent>
      ))}
    </Tabs>
  )
}
