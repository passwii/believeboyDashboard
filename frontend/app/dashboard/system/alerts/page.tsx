'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { BellRing, ListChecks, Settings2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fetchAlertStats, type AlertStats } from '@/lib/alerts-api'
import { useNotifications } from '@/components/notifications'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { AlertStatsBar } from './components/alert-stats-bar'
import { AlertEventsTab } from './components/alert-events-tab'
import { AlertRulesTab } from './components/alert-rules-tab'
import { AlertPreferencesTab } from './components/alert-preferences-tab'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import styles from './alerts-warm.module.css'

interface ProjectOption {
  id: number
  name: string
}

export default function AlertCenterPage() {
  const [stats, setStats] = useState<AlertStats | null>(null)
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [activeTab, setActiveTab] = useState('events')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const { notify } = useNotifications()
  const [refreshTabOwner, setRefreshTabOwner] = useState<(() => Promise<void>) | null>(null)
  const registerTabRefreshOwner = useCallback((refresh: () => Promise<void>) => {
    setRefreshTabOwner(() => refresh)
  }, [])

  const loadPageMetadata = useCallback(async () => {
    const [statsResult, projectsResult] = await Promise.allSettled([
      fetchAlertStats(),
      fetchManagedProjectsCached<Array<{ id: number; name: string }>>(),
    ])
    const failures: string[] = []
    if (statsResult.status === 'fulfilled') {
      setStats(statsResult.value)
    } else {
      failures.push(`告警统计：${String(statsResult.reason)}`)
    }
    if (projectsResult.status === 'fulfilled' && Array.isArray(projectsResult.value)) {
      setProjects(projectsResult.value.map((project) => ({ id: project.id, name: project.name })))
    } else if (projectsResult.status === 'rejected') {
      failures.push(`项目列表：${String(projectsResult.reason)}`)
    }
    if (failures.length > 0) {
      notify({
        type: 'error',
        title: '告警中心刷新失败',
        message: failures.join('；'),
      })
    }
  }, [notify])

  useEffect(() => {
    void loadPageMetadata()
  }, [loadPageMetadata])

  const refreshActiveOwner = useCallback(async () => {
    setIsRefreshing(true)
    try {
      await Promise.all([loadPageMetadata(), refreshTabOwner?.()])
    } finally {
      setIsRefreshing(false)
    }
  }, [loadPageMetadata, refreshTabOwner])
  useHeaderRefresh(refreshActiveOwner, { loading: isRefreshing })

  // 稳定 `projects` 引用：内容不变就不产生新数组引用。
  // 对应 Task 5 review 的 parked finding：alert-rule-dialog.tsx 的 useEffect
  // 把 `projects` 放进了依赖数组，若父组件每次渲染都传新引用，会在 Dialog
  // 打开后重置表单、静默丢弃用户编辑。这里用结构化指纹做 useMemo 依赖：
  // id/name 序列不变 → 返回同一数组引用；变化才换新引用，Dialog 才会重置到新数据。
  const projectsKey = useMemo(
    () => projects.map((p) => `${p.id}:${p.name}`).join('|'),
    [projects]
  )
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally derive ref from content key, not from `projects` itself
  const stableProjects = useMemo(() => projects, [projectsKey])

  return (
    <div className={styles.page} data-warm-alerts="true">
      <AlertStatsBar stats={stats} />

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          setActiveTab(value)
          setRefreshTabOwner(null)
        }}
        className={styles.tabs}
      >
        <TabsList className={styles.tabList}>
          <TabsTrigger value="events" className={styles.tab}>
            <BellRing className={styles.tabIcon} aria-hidden />
            告警事件
          </TabsTrigger>
          <TabsTrigger value="rules" className={styles.tab}>
            <ListChecks className={styles.tabIcon} aria-hidden />
            告警规则
          </TabsTrigger>
          <TabsTrigger value="preferences" className={styles.tab}>
            <Settings2 className={styles.tabIcon} aria-hidden />
            通知偏好
          </TabsTrigger>
        </TabsList>
        <TabsContent value="events" className={styles.tabContent}>
          <AlertEventsTab onRefreshReady={registerTabRefreshOwner} />
        </TabsContent>
        <TabsContent value="rules" className={styles.tabContent}>
          <AlertRulesTab projects={stableProjects} onRefreshReady={registerTabRefreshOwner} />
        </TabsContent>
        <TabsContent value="preferences" className={styles.tabContent}>
          <AlertPreferencesTab onRefreshReady={registerTabRefreshOwner} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
