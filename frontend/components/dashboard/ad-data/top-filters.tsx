'use client'

import { useEffect, useState } from 'react'
import type { DateRange } from 'react-day-picker'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'

import {
  DateRangePicker,
  COUNTRY_TIMEZONE_MAP,
  formatDateInputValue,
  parseDateRangeInputValue,
} from '@/components/ui/date-picker'
import {
  HeaderSlotDateRange,
  HeaderSlotSelect,
  TERM_HEADER_W_MD,
  TERM_HEADER_W_SM,
} from '@/components/terminal/header-filter-suite'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'
import { Skeleton } from '@/components/ui/skeleton'
import {
  useHeaderRefresh,
  useHeaderSlot,
  useMobileFilterStrip,
} from '@/components/terminal/terminal-header-slot'
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

function buildHref(pathname: string, searchParams: URLSearchParams) {
  const qs = searchParams.toString()
  return qs ? `${pathname}?${qs}` : pathname
}

/**
 * BLF-887：广告数据页筛选上移 Top Header 中段插槽。
 *
 * Desktop: `HeaderFilterControls isMobileView={false}` + `useHeaderSlot`.
 * Mobile:  `useMobileFilterStrip` + `MobileFilterStrip`.
 * 全局刷新为唯一入口，页面不额外放置 RefreshButton。
 */
export function AdDataTopFilters() {
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

  const updateSearchParam = (
    key: 'projectId' | 'country' | 'dateFrom' | 'dateTo',
    value: string
  ) => {
    const next = new URLSearchParams(searchParams.toString())
    if (value) next.set(key, value)
    else next.delete(key)
    router.replace(buildHref(pathname, next), { scroll: false })
  }

  const updateDateRange = (range?: DateRange) => {
    const next = new URLSearchParams(searchParams.toString())
    const nextDateFrom = formatDateInputValue(range?.from)
    const nextDateTo = formatDateInputValue(range?.to)
    if (nextDateFrom) next.set('dateFrom', nextDateFrom)
    else next.delete('dateFrom')
    if (nextDateTo) next.set('dateTo', nextDateTo)
    else next.delete('dateTo')
    router.replace(buildHref(pathname, next), { scroll: false })
  }

  // 全局刷新语义：重放当前 URL 筛选下的拉取（router.replace 同 href 触发 explorer 重取）。
  useHeaderRefresh(() => router.refresh())

  // Desktop controls using shared HeaderSlot atoms
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
        placeholder="选择国家站点"
        widthClass={TERM_HEADER_W_SM}
        title="站点筛选"
      />

      <HeaderSlotDateRange
        value={parseDateRangeInputValue(dateFrom, dateTo)}
        onChange={updateDateRange}
        timezone={COUNTRY_TIMEZONE_MAP[country]}
        widthClass={TERM_HEADER_W_SM}
      />

      {projectsError ? (
        <div className="flex h-10 items-center gap-1.5 border border-term-neg/50 bg-term-neg/10 px-2 font-mono text-xs text-term-neg">
          {projectsError}
        </div>
      ) : null}
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
      {/* explorer 经 useSearchParams 消费同一份 URL 参数；路由 replace 已触发其重取 */}
    </>
  )
}

/** 占位桥：保留组件树形状，未来刷新逻辑扩展点 */
function HiddenRefreshBridge() {
  return null
}
