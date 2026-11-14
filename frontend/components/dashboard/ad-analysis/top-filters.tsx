'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'

import {
  WarmPill,
  WarmSkeleton,
} from './warm-analysis'
import {
  activeAdAnalysisDatePreset,
  buildAdAnalysisDatePresets,
  isAdAnalysisDateInput,
} from './date-presets'
import {
  useHeaderRefresh,
  useHeaderSlot,
  useMobileFilterStrip,
} from '@/components/terminal/terminal-header-slot'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'
import { requestAdClientRefresh } from '@/components/dashboard/ad-refresh'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import styles from '@/app/dashboard/advertising/ad-analysis/ad-analysis-warm.module.css'

type ProjectOption = {
  id: number
  name: string
}

const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
] as const

const DRILL_PARAM_LABELS = {
  campaign: '活动',
  focusDate: '聚焦日期',
  placement: '广告位',
  purchasedAsin: '关联 ASIN',
  searchTerm: '搜索词',
  sku: 'SKU',
  targetText: '投放',
} as const

function buildHref(pathname: string, searchParams: URLSearchParams) {
  const qs = searchParams.toString()
  return qs ? `${pathname}?${qs}` : pathname
}

/**
 * BLF-889 · 广告分析页筛选上移 Top Header 中段插槽。
 *
 * Desktop: 页面本地 Warm 控件 + `useHeaderSlot`.
 * Mobile:  `useMobileFilterStrip` + `MobileFilterStrip` 渲染等价摘要与控件。
 * 全局刷新为唯一入口，页面不额外放置 RefreshButton。
 */
export function AdAnalysisTopFilters() {
  const { data: session } = useSession()
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)

  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''
  const datePresets = useMemo(() => buildAdAnalysisDatePresets(country), [country])
  const todayInSiteTimezone = datePresets.find((preset) => preset.key === 'today')?.dateFrom ?? ''
  const activeDatePreset = activeAdAnalysisDatePreset(datePresets, dateFrom, dateTo)
  const drillTokens: Array<{ key: string; label: string; value: string }> = []
  Object.entries(DRILL_PARAM_LABELS).forEach(([key, label]) => {
    const value = searchParams.get(key)
    if (value) drillTokens.push({ key, label, value })
  })

  useEffect(() => {
    let active = true

    async function loadProjects() {
      setProjectsLoading(true)
      setProjectsError(null)
      try {
        const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
        if (!active) return
        setProjects(payload)
        if (!projectId && payload[0]?.id) {
          const next = new URLSearchParams(searchParams.toString())
          next.set('projectId', String(payload[0].id))
          if (!next.get('country')) next.set('country', country)
          router.replace(buildHref(pathname, next), { scroll: false })
        }
      } catch (error) {
        if (!active) return
        setProjectsError(error instanceof Error ? error.message : '项目列表加载失败')
      } finally {
        if (active) setProjectsLoading(false)
      }
    }

    void loadProjects()
    return () => {
      active = false
    }
  }, [country, pathname, projectId, router, searchParams, session])

  const replaceSearchParams = (mutate: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(searchParams.toString())
    mutate(next)
    router.replace(buildHref(pathname, next), { scroll: false })
  }

  const updateSearchParam = (key: 'projectId' | 'country', value: string) => {
    replaceSearchParams((next) => {
      if (value) next.set(key, value)
      else next.delete(key)
    })
  }

  const updateDate = (key: 'dateFrom' | 'dateTo', value: string) => {
    if (value && (!isAdAnalysisDateInput(value) || value > todayInSiteTimezone)) return
    if (key === 'dateTo' && value && dateFrom && value < dateFrom) return

    replaceSearchParams((next) => {
      if (!value) {
        next.delete(key)
        return
      }

      next.set(key, value)
      if (key === 'dateFrom' && dateTo && value > dateTo) {
        next.set('dateTo', value)
      }
    })
  }

  const applyDatePreset = (key: string) => {
    const preset = datePresets.find((item) => item.key === key)
    if (!preset) return
    replaceSearchParams((next) => {
      next.set('dateFrom', preset.dateFrom)
      next.set('dateTo', preset.dateTo)
    })
  }

  const clearDrillParams = () => {
    replaceSearchParams((next) => {
      Object.keys(DRILL_PARAM_LABELS).forEach((key) => next.delete(key))
    })
  }

  // 分析结果在已挂载的 client subtree 中读取；先清缓存并通知当前数据 owner 重取，
  // router.refresh 只负责可能存在的 RSC 内容，不作为客户端数据刷新的依据。
  useHeaderRefresh(() => {
    requestAdClientRefresh()
    router.refresh()
  })

  // Desktop controls
  const desktopControls = (
    <div className={styles.headerFilters} data-warm-header-filters="true">
      {projectsLoading ? (
        <WarmSkeleton className="h-10 w-[150px]" />
      ) : (
        <select
          aria-label="项目筛选"
          className={styles.headerSelect}
          value={projectId}
          onChange={(event) => updateSearchParam('projectId', event.target.value)}
        >
          <option value="">选择项目</option>
          {projects.map((item) => (
            <option key={item.id} value={String(item.id)}>
              {item.name}
            </option>
          ))}
        </select>
      )}

      <select
        aria-label="站点筛选"
        className={styles.headerSelect}
        value={country}
        onChange={(event) => updateSearchParam('country', event.target.value)}
      >
        {COUNTRY_OPTIONS.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>

      <div className={styles.dateGroup}>
        <select
          aria-label="日期快捷范围"
          className={styles.datePreset}
          value={activeDatePreset ?? ''}
          onChange={(event) => applyDatePreset(event.target.value)}
        >
          <option value="">自定义</option>
          {datePresets.map((preset) => (
            <option key={preset.key} value={preset.key}>
              {preset.label}
            </option>
          ))}
        </select>
        <input
          type="date"
          aria-label="开始日期"
          className={styles.dateInput}
          value={dateFrom}
          max={todayInSiteTimezone || undefined}
          onChange={(event) => updateDate('dateFrom', event.target.value)}
        />
        <input
          type="date"
          aria-label="结束日期"
          className={styles.dateInput}
          value={dateTo}
          min={dateFrom || undefined}
          max={todayInSiteTimezone || undefined}
          onChange={(event) => updateDate('dateTo', event.target.value)}
        />
      </div>

      {drillTokens.length > 0 && (
        <div className={styles.headerFilters}>
          {drillTokens.map((item) => (
            <WarmPill key={item.key} tone="accent" className="shrink-0">
              {item.label}：{item.value}
            </WarmPill>
          ))}
          <button
            type="button"
            onClick={clearDrillParams}
            className={styles.clearButton}
          >
            清空下钻
          </button>
        </div>
      )}

      {projectsError && (
        <span className={styles.projectError}>{projectsError}</span>
      )}
    </div>
  )

  const desktopSlot = useHeaderSlot(desktopControls)

  // Mobile filter strip
  const selectedProjectName =
    projects.find((project) => String(project.id) === projectId)?.name ?? '全部项目'
  const mobileSummary = [
    selectedProjectName,
    country,
    dateFrom && dateTo ? `${dateFrom} ~ ${dateTo}` : '日期未选择',
  ].join(' · ')
  const mobileControls = (
    <>
      <MobileFilterWide>
        {projectsLoading ? (
          <WarmSkeleton className="h-10 w-full" />
        ) : (
          <select
            aria-label="项目筛选"
            className={styles.mobileControl}
            value={projectId}
            onChange={(event) => updateSearchParam('projectId', event.target.value)}
          >
            <option value="">选择项目</option>
            {projects.map((item) => (
              <option key={item.id} value={String(item.id)}>
                {item.name}
              </option>
            ))}
          </select>
        )}
      </MobileFilterWide>
      <MobileFilterWide>
        <select
          aria-label="站点筛选"
          className={styles.mobileControl}
          value={country}
          onChange={(event) => updateSearchParam('country', event.target.value)}
        >
          {COUNTRY_OPTIONS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </MobileFilterWide>
      <MobileFilterWide>
        <select
          aria-label="日期快捷范围"
          className={styles.mobileControl}
          value={activeDatePreset ?? ''}
          onChange={(event) => applyDatePreset(event.target.value)}
        >
          <option value="">自定义</option>
          {datePresets.map((preset) => (
            <option key={preset.key} value={preset.key}>
              {preset.label}
            </option>
          ))}
        </select>
      </MobileFilterWide>
      <MobileFilterWide>
        <div className="grid grid-cols-2 gap-2">
          <input
            type="date"
            aria-label="开始日期"
            className={styles.mobileControl}
            value={dateFrom}
            max={todayInSiteTimezone || undefined}
            onChange={(event) => updateDate('dateFrom', event.target.value)}
          />
          <input
            type="date"
            aria-label="结束日期"
            className={styles.mobileControl}
            value={dateTo}
            min={dateFrom || undefined}
            max={todayInSiteTimezone || undefined}
            onChange={(event) => updateDate('dateTo', event.target.value)}
          />
        </div>
      </MobileFilterWide>
      {drillTokens.length > 0 && (
        <MobileFilterWide>
          <div className="flex flex-wrap items-center gap-2">
            {drillTokens.map((item) => (
              <WarmPill key={item.key} tone="accent">
                {item.label}：{item.value}
              </WarmPill>
            ))}
            <button
              type="button"
              onClick={clearDrillParams}
              className={styles.clearButton}
            >
              清空下钻
            </button>
          </div>
        </MobileFilterWide>
      )}
    </>
  )
  const mobileStrip = useMobileFilterStrip(
    <MobileFilterStrip
      summary={mobileSummary}
      controls={mobileControls}
      variant="warm-ledger"
    />
  )

  return (
    <>
      {desktopSlot}
      {mobileStrip}
    </>
  )
}
