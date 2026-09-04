'use client'

import { useEffect, useMemo, useState } from 'react'
import { BellRing, ListChecks, Settings2 } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fetchAlertStats, type AlertStats } from '@/lib/alerts-api'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { AlertStatsBar } from './components/alert-stats-bar'
import { AlertEventsTab } from './components/alert-events-tab'
import { AlertRulesTab } from './components/alert-rules-tab'
import { AlertPreferencesTab } from './components/alert-preferences-tab'
import { TermPageShell } from '@/components/terminal/term-controls'

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
    // BLF-838：页面标题由 Top Header 面包屑承载；Tab 列表终端规格
    <TermPageShell>
      <AlertStatsBar stats={stats} />

      <Tabs defaultValue="events">
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
          <AlertEventsTab />
        </TabsContent>
        <TabsContent value="rules" className="mt-2">
          <AlertRulesTab projects={stableProjects} />
        </TabsContent>
        <TabsContent value="preferences" className="mt-2">
          <AlertPreferencesTab />
        </TabsContent>
      </Tabs>
    </TermPageShell>
  )
}
