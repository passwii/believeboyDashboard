'use client'

import { useCallback, useState } from 'react'
import { usePathname } from 'next/navigation'
import { CalendarClock, History } from 'lucide-react'

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

  // BLF-883 全局统一：Tab 条一律走 variant="term"（h-8 / 零圆角 / 1px 边界 /
  // 激活态 term-raised + accent 发光指示条）。
  // 修复高度问题：旧实现外层包了 overflow-x-auto 容器 + default 基座残留 min-h-11
  // （trigger min-h-[2.85rem]=46px 溢出 44px 列表 1px），导致 tab 右侧出现滚动按钮；
  // term 基座恒定 h-8 min-h-8 且滚动条隐藏，从根上消除溢出源。
  // 保留 SlidingTabsTrigger 动效；激活态由 tab-motion 填充 term-raised 底。
  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-3">
      <TabsList variant="term" className="w-fit justify-start">
        <TabsMotionGroup id="scheduled-reports-tabs">
          <SlidingTabsTrigger
            value="subscriptions"
            activeValue={activeTab}
            layoutId={TAB_LAYOUT_ID}
            variant="term"
          >
            <CalendarClock aria-hidden />
            订阅管理
          </SlidingTabsTrigger>
          <SlidingTabsTrigger
            value="ledger"
            activeValue={activeTab}
            layoutId={TAB_LAYOUT_ID}
            variant="term"
          >
            <History aria-hidden />
            调度记录
          </SlidingTabsTrigger>
        </TabsMotionGroup>
      </TabsList>

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
