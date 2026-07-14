'use client'

/**
 * AI 广告分析 — 历史记录 + 定时任务 Tab 结构
 * 路径: /dashboard/ai/ad-analysis
 *
 * 与通用 AI 洞察 (/dashboard/ai/insights) 的差异:
 *  - insight_type 固定为 'ad_analysis' — 后端会用 INSIGHT_AD_ANALYSIS_PROMPT
 *    (双角色: 亚马逊运营 + 广告投放优化; 不预设分析维度; 建议可执行)
 *  - 数据聚合 10 种 ad 报表类型 + 销售 + 库存
 *  - UI 极简: 项目 + 日期 + 启动, 流式输出
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'
import { Calendar, Clock, FileText, Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DateRangePicker,
  COUNTRY_TIMEZONE_MAP,
  getTodayInTimezone,
} from '@/components/ui/date-picker'
import { useNotifications } from '@/components/notifications'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { HistoryList, ViewDialog, GenerationDialog } from '@/components/dashboard/ai-ad-analysis'
import { ScheduleList, ScheduleDialog } from '@/components/dashboard/ai-insights'
import { cn } from '@/lib/utils'

const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
]

type Project = {
  id: number
  name: string
  brand_name?: string | null
  project_operator?: string | null
  is_active?: boolean
}

function formatYMD(d: Date | undefined | null): string {
  if (!d) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function defaultRange(country: string) {
  const today = getTodayInTimezone(COUNTRY_TIMEZONE_MAP[country] ?? 'UTC')
  const start = new Date(today)
  start.setDate(start.getDate() - 6) // 近 7 天 (含今天)
  return { from: start, to: today }
}

type TabKey = 'history' | 'schedules'

// ─── History Tab ────────────────────────────────────────────────────────────

function HistoryTab() {
  const { data: session } = useSession()
  const { notify } = useNotifications()

  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<number | null>(null)
  const [country, setCountry] = useState<string>('US')
  const [range, setRange] = useState<{ from: Date; to: Date }>(() => defaultRange('US'))
  const [generationDialogOpen, setGenerationDialogOpen] = useState(false)
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetchManagedProjectsCached<Project[]>(session, false)
      .then((items) => {
        if (cancelled) return
        const list = Array.isArray(items) ? items : []
        setProjects(list)
        if (list.length > 0) {
          setProjectId(list[0].id)
        }
      })
      .catch((err) => {
        notify({ type: 'error', title: '项目列表加载失败', message: String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [session, notify])

  useEffect(() => {
    setRange(defaultRange(country))
  }, [country])

  const startDate = useMemo(() => formatYMD(range.from), [range])
  const endDate = useMemo(() => formatYMD(range.to), [range])

  const canGenerate = !!projectId && !!startDate && !!endDate

  const handleGenerate = useCallback(() => {
    if (!canGenerate) return
    setGenerationDialogOpen(true)
  }, [canGenerate])

  const handleGenerationComplete = useCallback(() => {
    setRefreshTrigger((n) => n + 1)
  }, [])

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
            <div className="md:col-span-4">
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">项目</label>
              <Select
                value={projectId ? String(projectId) : ''}
                onValueChange={(v) => setProjectId(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择项目" />
                </SelectTrigger>
                <SelectContent>
                  {projects.length === 0 ? (
                    <SelectItem value="__empty__" disabled>
                      暂无可用项目
                    </SelectItem>
                  ) : (
                    projects.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.brand_name ? `${p.name} · ${p.brand_name}` : p.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="md:col-span-2">
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">国家</label>
              <Select value={country} onValueChange={setCountry}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COUNTRY_OPTIONS.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="md:col-span-4">
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  日期范围
                </span>
              </label>
              <DateRangePicker
                value={range}
                onChange={(r) => r?.from && r?.to && setRange({ from: r.from, to: r.to })}
                timezone={COUNTRY_TIMEZONE_MAP[country]}
              />
            </div>

            <div className="flex items-end md:col-span-2">
              <Button onClick={handleGenerate} disabled={!canGenerate} className="w-full">
                <Sparkles className="mr-2 h-4 w-4" />
                立即生成
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <HistoryList projectId={projectId} country={country} refreshTrigger={refreshTrigger} />

      <GenerationDialog
        open={generationDialogOpen}
        onOpenChange={setGenerationDialogOpen}
        projectId={projectId}
        country={country}
        dateRange={range}
        onComplete={handleGenerationComplete}
      />
    </div>
  )
}

// ─── Schedules Tab ──────────────────────────────────────────────────────────

function SchedulesTab() {
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState<any>(null)
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  // ScheduleList 自带 onRefresh 触发, 我们用 refreshTrigger 让父组件在保存/删除/切换后重新触发
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">定时任务管理</h2>
          <p className="text-sm text-muted-foreground">
            配置定时任务，自动在指定时间生成 AI 广告分析报告
          </p>
        </div>
        <Button
          onClick={() => {
            setEditingSchedule(null)
            setScheduleDialogOpen(true)
          }}
        >
          <Clock className="mr-2 h-4 w-4" />
          新建定时任务
        </Button>
      </div>

      <ScheduleList
        insightType="ad_analysis"
        onEdit={(schedule) => {
          setEditingSchedule(schedule)
          setScheduleDialogOpen(true)
        }}
        onRefresh={() => setRefreshTrigger((n) => n + 1)}
        isRefreshing={refreshTrigger > 0}
      />

      <ScheduleDialog
        open={scheduleDialogOpen}
        onOpenChange={(open) => {
          setScheduleDialogOpen(open)
          if (!open) setEditingSchedule(null)
        }}
        schedule={editingSchedule}
        fixedInsightType="ad_analysis"
        onSave={async (data) => {
          const res = editingSchedule
            ? await fetch(`/api/backend/v1/ai-insights/schedules/${editingSchedule.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
              })
            : await fetch('/api/backend/v1/ai-insights/schedules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
              })
          if (!res.ok) {
            const err = await res.text()
            throw new Error(err || '保存失败')
          }
          setRefreshTrigger((n) => n + 1)
        }}
      />
    </div>
  )
}

// ─── 主页面 ────────────────────────────────────────────────────────────────

export default function AdAnalysisPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('history')

  return (
    <div className="space-y-6 px-2 py-2 md:px-4 md:py-4">
      <div>
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold tracking-tight">AI 广告分析</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          基于 10 种广告报表 + 销售 + 库存，由 AI 扮演亚马逊运营 +
          广告投放双专家，自主分析并给出可执行的调整建议。
        </p>
      </div>

      <div className="flex items-center gap-1 rounded-lg border border-border/70 bg-[hsl(var(--surface-soft))] p-1 w-fit">
        <button
          onClick={() => setActiveTab('history')}
          className={cn(
            'flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
            activeTab === 'history'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <FileText className="h-4 w-4" />
          历史记录
        </button>
        <button
          onClick={() => setActiveTab('schedules')}
          className={cn(
            'flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
            activeTab === 'schedules'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Clock className="h-4 w-4" />
          定时任务
        </button>
      </div>

      {activeTab === 'history' && <HistoryTab />}
      {activeTab === 'schedules' && <SchedulesTab />}
    </div>
  )
}
