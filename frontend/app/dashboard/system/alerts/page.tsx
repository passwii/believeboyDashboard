'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { BellRing, ListChecks, Settings2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fetchAlertStats, type AlertStats } from '@/lib/alerts-api'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { AlertStatsBar } from './components/alert-stats-bar'
import { AlertEventsTab } from './components/alert-events-tab'
import { AlertRulesTab } from './components/alert-rules-tab'
import { AlertPreferencesTab } from './components/alert-preferences-tab'
import { TermPageShell } from '@/components/terminal/term-controls'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'

interface ProjectOption {
  id: number
  name: string
}

export default function AlertCenterPage() {
  const [stats, setStats] = useState<AlertStats | null>(null)
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [activeTab, setActiveTab] = useState('events')
  const [refreshTabOwner, setRefreshTabOwner] = useState<(() => Promise<void>) | null>(null)
  const registerTabRefreshOwner = useCallback((refresh: () => Promise<void>) => {
    setRefreshTabOwner(() => refresh)
  }, [])

  const loadPageMetadata = useCallback(async () => {
    const [statsResult, projectsResult] = await Promise.allSettled([
      fetchAlertStats(),
      fetchManagedProjectsCached<Array<{ id: number; name: string }>>(),
    ])
    setStats(statsResult.status === 'fulfilled' ? statsResult.value : null)
    setProjects(
      projectsResult.status === 'fulfilled' && Array.isArray(projectsResult.value)
        ? projectsResult.value.map((project) => ({ id: project.id, name: project.name }))
        : []
    )
  }, [])

  useEffect(() => {
    void loadPageMetadata()
  }, [loadPageMetadata])

  const refreshActiveOwner = useCallback(async () => {
    await Promise.all([loadPageMetadata(), refreshTabOwner?.()])
  }, [loadPageMetadata, refreshTabOwner])
  useHeaderRefresh(refreshActiveOwner)

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
    // BLF-838：页面标题由 Top Header 面包屑承载；Tab 列表终端规格
    <TermPageShell>
      <AlertStatsBar stats={stats} />

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          setActiveTab(value)
          setRefreshTabOwner(null)
        }}
      >
        {/* BLF-883 全局统一：variant="term" + 前置 icon */}
        <TabsList variant="term" className="w-fit justify-start">
          <TabsTrigger value="events" variant="term">
            <BellRing aria-hidden />
            告警事件
          </TabsTrigger>
          <TabsTrigger value="rules" variant="term">
            <ListChecks aria-hidden />
            告警规则
          </TabsTrigger>
          <TabsTrigger value="preferences" variant="term">
            <Settings2 aria-hidden />
            通知偏好
          </TabsTrigger>
        </TabsList>
        <TabsContent value="events" className="mt-2">
          <AlertEventsTab onRefreshReady={registerTabRefreshOwner} />
        </TabsContent>
        <TabsContent value="rules" className="mt-2">
          <AlertRulesTab projects={stableProjects} onRefreshReady={registerTabRefreshOwner} />
        </TabsContent>
        <TabsContent value="preferences" className="mt-2">
          <AlertPreferencesTab onRefreshReady={registerTabRefreshOwner} />
        </TabsContent>
      </Tabs>
    </TermPageShell>
  )
}
