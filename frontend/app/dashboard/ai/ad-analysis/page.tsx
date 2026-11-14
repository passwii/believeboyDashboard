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

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import {
  DateRangePicker,
  COUNTRY_TIMEZONE_MAP,
  getTodayInTimezone,
} from '@/components/ui/date-picker'
import { useNotifications } from '@/components/notifications'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { HistoryList, GenerationDialog } from '@/components/dashboard/ai-ad-analysis'
import {
  WarmButton,
  WarmSelect,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { ScheduleList, ScheduleDialog } from '@/components/dashboard/ai-insights'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import styles from '@/components/dashboard/ai-ad-analysis/ai-ad-analysis-warm.module.css'

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

function HistoryTab({
  onRefreshReady,
}: {
  onRefreshReady?: (refresh: () => Promise<void>) => void
}) {
  const { data: session } = useSession()
  const { notify } = useNotifications()

  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<number | null>(null)
  const [isLoadingProjects, setIsLoadingProjects] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)
  const [projectLoadAttempt, setProjectLoadAttempt] = useState(0)
  const [country, setCountry] = useState<string>('US')
  const [range, setRange] = useState<{ from: Date; to: Date }>(() => defaultRange('US'))
  const [generationDialogOpen, setGenerationDialogOpen] = useState(false)
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  useEffect(() => {
    let cancelled = false
    setIsLoadingProjects(true)
    setProjectLoadError(null)
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
        if (cancelled) return
        setProjectLoadError(err instanceof Error ? err.message : String(err))
        notify({ type: 'error', title: '项目列表加载失败', message: String(err) })
      })
      .finally(() => {
        if (!cancelled) setIsLoadingProjects(false)
      })
    return () => {
      cancelled = true
    }
  }, [session, notify, projectLoadAttempt])

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

  const refreshHistory = useCallback(async () => {
    setRefreshTrigger((n) => n + 1)
  }, [])
  useEffect(() => {
    onRefreshReady?.(refreshHistory)
  }, [onRefreshReady, refreshHistory])

  return (
    <div className={styles.stack}>
      <section className={styles.panel}>
        <div className={styles.panelBody}>
          <div className={styles.filters} data-testid="ai-ad-filters">
            <div className={styles.field}>
              <WarmSelect
                id="ad-project"
                label="项目"
                value={projectId ? String(projectId) : ''}
                options={projects.map((project) => ({
                  value: String(project.id),
                  label: project.brand_name
                    ? `${project.name} · ${project.brand_name}`
                    : project.name,
                }))}
                onChange={(value) => setProjectId(Number(value))}
                placeholder={
                  isLoadingProjects
                    ? '加载项目中...'
                    : projectLoadError
                      ? '项目加载失败'
                      : projects.length === 0
                        ? '暂无可用项目'
                        : '选择项目'
                }
                disabled={isLoadingProjects || !!projectLoadError || projects.length === 0}
                error={projectLoadError ? '项目列表加载失败，请重试' : null}
              />
              {projectLoadError ? (
                <WarmButton
                  type="button"
                  variant="quiet"
                  onClick={() => setProjectLoadAttempt((attempt) => attempt + 1)}
                  loading={isLoadingProjects}
                  loadingLabel="正在加载项目"
                >
                  重试
                </WarmButton>
              ) : null}
            </div>

            <WarmSelect
              id="ad-country"
              label="国家"
              value={country}
              options={COUNTRY_OPTIONS}
              onChange={setCountry}
            />

            <div className={styles.field}>
              <span className={styles.fieldLabel}>
                <Calendar aria-hidden />
                日期范围
              </span>
              <DateRangePicker
                value={range}
                onChange={(nextRange) =>
                  nextRange?.from &&
                  nextRange?.to &&
                  setRange({ from: nextRange.from, to: nextRange.to })
                }
                className={styles.dateTrigger}
                popoverClassName={styles.datePopover}
                timezone={COUNTRY_TIMEZONE_MAP[country]}
              />
            </div>

            <div className={styles.generateAction}>
              <WarmButton
                type="button"
                variant="primary"
                onClick={handleGenerate}
                disabled={!canGenerate}
              >
                <Sparkles aria-hidden />
                立即生成
              </WarmButton>
            </div>
          </div>
        </div>
      </section>

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

function SchedulesTab({
  onRefreshReady,
}: {
  onRefreshReady?: (refresh: () => Promise<void>) => void
}) {
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState<any>(null)
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  const refreshSchedules = useCallback(async () => {
    setRefreshTrigger((n) => n + 1)
  }, [])
  useEffect(() => {
    onRefreshReady?.(refreshSchedules)
  }, [onRefreshReady, refreshSchedules])

  // ScheduleList 自带 onRefresh 触发, 我们用 refreshTrigger 让父组件在保存/删除/切换后重新触发
  return (
    <div className={styles.stack}>
      <section className={styles.panel}>
        <header className={styles.panelHeader}>
          <h2 className={styles.panelTitle}>定时任务管理</h2>
          <div className={styles.panelActions}>
            <WarmButton
              type="button"
              variant="primary"
              onClick={() => {
                setEditingSchedule(null)
                setScheduleDialogOpen(true)
              }}
            >
              <Clock aria-hidden />
              新建定时任务
            </WarmButton>
          </div>
        </header>
        <div className={styles.panelBody}>
          <p className={styles.helperText}>
            配置定时任务，自动在指定时间生成 AI 广告分析报告
          </p>

          <div className={styles.scheduleSurface}>
            <ScheduleList
              insightType="ad_analysis"
              onEdit={(schedule) => {
                setEditingSchedule(schedule)
                setScheduleDialogOpen(true)
              }}
              onRefresh={() => setRefreshTrigger((n) => n + 1)}
              isRefreshing={refreshTrigger > 0}
            />
          </div>
        </div>
      </section>

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
  const [refreshTabOwner, setRefreshTabOwner] = useState<(() => Promise<void>) | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const registerTabRefreshOwner = useCallback((refresh: () => Promise<void>) => {
    setRefreshTabOwner(() => refresh)
  }, [])
  const refreshActiveTab = useCallback(async () => {
    setRefreshing(true)
    try {
      await refreshTabOwner?.()
    } finally {
      setRefreshing(false)
    }
  }, [refreshTabOwner])
  useHeaderRefresh(refreshActiveTab, { loading: refreshing })

  return (
    // BLF-838：页面标题由 Top Header 面包屑承载；Tab 切换终端规格
    <div className={styles.page} data-warm-ad-analysis>
      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          setActiveTab(v as TabKey)
          setRefreshTabOwner(null)
        }}
        className={styles.tabs}
      >
        <TabsList className={styles.tabList}>
          <TabsTrigger value="history">
            <FileText aria-hidden />
            历史记录
          </TabsTrigger>
          <TabsTrigger value="schedules">
            <Clock aria-hidden />
            定时任务
          </TabsTrigger>
        </TabsList>

        <TabsContent value="history" className={styles.tabContent}>
          <HistoryTab onRefreshReady={registerTabRefreshOwner} />
        </TabsContent>
        <TabsContent value="schedules" className={styles.tabContent}>
          <SchedulesTab onRefreshReady={registerTabRefreshOwner} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
