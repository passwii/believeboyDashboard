'use client'

import { useCallback, useState } from 'react'
import { usePathname } from 'next/navigation'
import { CalendarClock, History } from 'lucide-react'

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'

import SubscriptionsView from './_components/SubscriptionsView'
import LedgerView from './_components/LedgerView'
import styles from './scheduled-reports-warm.module.css'

type ScheduledReportTabKey = 'subscriptions' | 'ledger'

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
  const [refreshers, setRefreshers] = useState<Partial<Record<ScheduledReportTabKey, () => Promise<void>>>>({})
  const [refreshing, setRefreshing] = useState(false)
  const registerRefresher = useCallback((tab: ScheduledReportTabKey, refresh: () => Promise<void>) => {
    setRefreshers((current) => ({ ...current, [tab]: refresh }))
  }, [])
  const registerSubscriptionsRefresher = useCallback(
    (refresh: () => Promise<void>) => registerRefresher('subscriptions', refresh),
    [registerRefresher]
  )
  const registerLedgerRefresher = useCallback(
    (refresh: () => Promise<void>) => registerRefresher('ledger', refresh),
    [registerRefresher]
  )

  const handleTabChange = useCallback((next: string) => {
    const key = next as ScheduledReportTabKey
    setActiveTab(key)
    setActivatedTabs((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
  }, [])
  const activeRefresher = refreshers[activeTab]
  const refreshActiveTab = useCallback(async () => {
    setRefreshing(true)
    try {
      await activeRefresher?.()
    } finally {
      setRefreshing(false)
    }
  }, [activeRefresher])
  useHeaderRefresh(refreshActiveTab, { loading: refreshing })

  return (
    <div className={styles.page} data-warm-scheduled-reports="true">
      <Tabs value={activeTab} onValueChange={handleTabChange} className={styles.tabs}>
        <TabsList className={styles.tabList} data-warm-tablist="true">
          <TabsTrigger value="subscriptions" className={styles.tab}>
            <CalendarClock aria-hidden />
            订阅管理
          </TabsTrigger>
          <TabsTrigger value="ledger" className={styles.tab}>
            <History aria-hidden />
            调度记录
          </TabsTrigger>
        </TabsList>

        {activatedTabs.has('subscriptions') && (
          <div className={cn(activeTab === 'subscriptions' ? 'block' : 'hidden')}>
            <SubscriptionsView onRefreshReady={registerSubscriptionsRefresher} />
          </div>
        )}
        {activatedTabs.has('ledger') && (
          <div className={cn(activeTab === 'ledger' ? 'block' : 'hidden')}>
            <LedgerView onRefreshReady={registerLedgerRefresher} />
          </div>
        )}
      </Tabs>
    </div>
  )
}
