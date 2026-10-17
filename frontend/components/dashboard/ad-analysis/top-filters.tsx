'use client'

import { useEffect, useState } from 'react'
import type { DateRange } from 'react-day-picker'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'

import {
  COUNTRY_TIMEZONE_MAP,
  formatDateInputValue,
  parseDateRangeInputValue,
} from '@/components/ui/date-picker'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import {
  HeaderSlotDateRange,
  HeaderSlotSelect,
  TERM_HEADER_W_MD,
  TERM_HEADER_W_SM,
  TERM_HEADER_W_XL,
} from '@/components/terminal/header-filter-suite'
import { TermPill } from '@/components/terminal/term-controls'
import { Skeleton } from '@/components/ui/skeleton'
import {
  useHeaderRefresh,
  useHeaderSlot,
  useMobileFilterStrip,
} from '@/components/terminal/terminal-header-slot'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'
import { requestAdClientRefresh } from '@/components/dashboard/ad-refresh'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

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
 * Desktop: `HeaderFilterControls isMobileView={false}` + `useHeaderSlot`.
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

  const updateDateRange = (range?: DateRange) => {
    replaceSearchParams((next) => {
      const nextDateFrom = formatDateInputValue(range?.from)
      const nextDateTo = formatDateInputValue(range?.to)
      if (nextDateFrom) next.set('dateFrom', nextDateFrom)
      else next.delete('dateFrom')
      if (nextDateTo) next.set('dateTo', nextDateTo)
      else next.delete('dateTo')
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

  // Desktop controls (fixed: isMobileView={false})
  const desktopControls = (
    <>
      {projectsLoading ? (
        <Skeleton className="h-10 w-full rounded-none md:w-[150px]" />
      ) : (
        <HeaderSlotSelect
          value={projectId}
          onChange={(value) => updateSearchParam('projectId', value)}
          options={projects.map((item) => ({ value: String(item.id), label: item.name }))}
          placeholder="选择项目"
          widthClass={TERM_HEADER_W_MD}
          title="项目筛选"
        />
      )}

      <HeaderSlotSelect
        value={country}
        onChange={(value) => updateSearchParam('country', value)}
        options={COUNTRY_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
        placeholder="选择站点"
        widthClass={TERM_HEADER_W_SM}
        title="站点筛选"
      />

      <HeaderSlotDateRange
        value={parseDateRangeInputValue(dateFrom, dateTo)}
        onChange={updateDateRange}
        timezone={COUNTRY_TIMEZONE_MAP[country]}
        widthClass={TERM_HEADER_W_XL}
      />

      {drillTokens.length > 0 && (
        <div className="flex min-w-0 flex-nowrap items-center gap-1 overflow-hidden">
          {drillTokens.map((item) => (
            <TermPill key={item.key} tone="accent" className="shrink-0">
              {item.label}：{item.value}
            </TermPill>
          ))}
          <button
            type="button"
            onClick={clearDrillParams}
            className="flex h-10 shrink-0 items-center rounded-none border border-term-border bg-term-panel px-2 font-mono text-xs text-term-muted transition-colors hover:bg-term-hover hover:text-term-text"
          >
            清空下钻
          </button>
        </div>
      )}

      {projectsError && (
        <span className="flex h-10 shrink-0 items-center border border-term-neg/50 bg-term-neg/10 px-2 font-mono text-xs text-term-neg">
          {projectsError}
        </span>
      )}
    </>
  )

  const desktopSlot = useHeaderSlot(
    <HeaderFilterControls isMobileView={false} controls={desktopControls} />
  )

  // Mobile filter strip
  const mobileSummary = `${country} · ${dateFrom || ''} ~ ${dateTo || ''}`
  const mobileControls = (
    <>
      <HeaderSlotDateRange
        value={parseDateRangeInputValue(dateFrom, dateTo)}
        onChange={updateDateRange}
        timezone={COUNTRY_TIMEZONE_MAP[country]}
        widthClass={TERM_HEADER_W_SM}
      />
      <MobileFilterWide>
        {projectsLoading ? (
          <Skeleton className="h-10 w-full rounded-none" />
        ) : (
          <HeaderSlotSelect
            value={projectId}
            onChange={(value) => updateSearchParam('projectId', value)}
            options={projects.map((item) => ({ value: String(item.id), label: item.name }))}
            placeholder="选择项目"
            widthClass="w-full"
          />
        )}
      </MobileFilterWide>
      <MobileFilterWide>
        <HeaderSlotSelect
          value={country}
          onChange={(value) => updateSearchParam('country', value)}
          options={COUNTRY_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
          placeholder="站点"
          widthClass="w-full"
        />
      </MobileFilterWide>
    </>
  )
  const mobileStrip = useMobileFilterStrip(
    <MobileFilterStrip summary={mobileSummary} controls={mobileControls} />
  )

  return (
    <>
      {desktopSlot}
      {mobileStrip}
    </>
  )
}
