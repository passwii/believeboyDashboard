'use client'

import { useEffect, useMemo, useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fetchAlertStats, type AlertStats } from '@/lib/alerts-api'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { AlertStatsBar } from './components/alert-stats-bar'
import { AlertEventsTab } from './components/alert-events-tab'
import { AlertRulesTab } from './components/alert-rules-tab'
import { AlertPreferencesTab } from './components/alert-preferences-tab'

interface ProjectOption {
  id: number
  name: string
}

export default function AlertCenterPage() {
  const [stats, setStats] = useState<AlertStats | null>(null)
  const [projects, setProjects] = useState<ProjectOption[]>([])

  useEffect(() => {
    void fetchAlertStats().then(setStats).catch(() => setStats(null))
    // 复用 projects/manage 2min 客户端缓存（BEL-424）：跨页共享同一份项目元数据，
    // warm 复访不再重复打后端。
    void fetchManagedProjectsCached<Array<{ id: number; name: string }>>()
      .then((data) =>
        setProjects(Array.isArray(data) ? data.map((p) => ({ id: p.id, name: p.name })) : [])
      )
      .catch(() => setProjects([]))
  }, [])

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
    <div className="space-y-6">
      <PageHeader
        title="告警中心"
        description="配置告警规则、跟踪异常事件、管理通知偏好"
      />

      <AlertStatsBar stats={stats} />

      <Tabs defaultValue="events">
        <TabsList>
          <TabsTrigger value="events">告警事件</TabsTrigger>
          <TabsTrigger value="rules">告警规则</TabsTrigger>
          <TabsTrigger value="preferences">通知偏好</TabsTrigger>
        </TabsList>
        <TabsContent value="events" className="mt-4">
          <AlertEventsTab />
        </TabsContent>
        <TabsContent value="rules" className="mt-4">
          <AlertRulesTab projects={stableProjects} />
        </TabsContent>
        <TabsContent value="preferences" className="mt-4">
          <AlertPreferencesTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
