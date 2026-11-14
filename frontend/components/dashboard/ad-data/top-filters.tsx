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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  useHeaderRefresh,
  useHeaderSlot,
  useMobileFilterStrip,
} from '@/components/terminal/terminal-header-slot'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'
import { requestAdClientRefresh } from '@/components/dashboard/ad-refresh'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { cn } from '@/lib/utils'

import styles from './ad-data-explorer.module.css'

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

export function AdDataTopFilters() {
  const { data: session } = useSession()
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)

  const projectId = searchParams.get('projectId') || ''
  const country = searchParams.get('country') || 'US'
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''

  useEffect(() => {
    setPortalContainer(document.getElementById('warm-ledger-portal-root'))
  }, [])

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

  useHeaderRefresh(() => {
    requestAdClientRefresh()
    router.refresh()
  })

  const projectControl = (label: string) =>
    projectsLoading ? (
      <div className={styles.headerSkeleton} aria-hidden />
    ) : (
      <Select
        value={projectId}
        onValueChange={(value) => updateSearchParam('projectId', value)}
      >
        <SelectTrigger className={styles.headerControl} aria-label={label}>
          <SelectValue placeholder="选择项目" />
        </SelectTrigger>
        <SelectContent className={styles.selectContent}>
          {projects.map((project) => (
            <SelectItem
              key={project.id}
              value={String(project.id)}
              className={styles.selectItem}
            >
              {project.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )

  const countryControl = (
    <Select
      value={country}
      onValueChange={(value) => updateSearchParam('country', value)}
    >
      <SelectTrigger
        className={cn(styles.headerControl, styles.headerCountry)}
        aria-label="站点筛选"
      >
        <SelectValue placeholder="选择国家站点" />
      </SelectTrigger>
      <SelectContent className={styles.selectContent}>
        {COUNTRY_OPTIONS.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            className={styles.selectItem}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  const dateRangeControl = (className?: string) => (
    <DateRangePicker
      value={parseDateRangeInputValue(dateFrom, dateTo)}
      onChange={updateDateRange}
      timezone={COUNTRY_TIMEZONE_MAP[country]}
      placeholder="选择日期范围"
      className={cn(styles.headerDateRangeTrigger, className)}
      portalContainer={portalContainer}
      popoverClassName={cn(
        'warm-ledger__date-picker-content',
        styles.headerDatePopover
      )}
    />
  )

  const controls = (
    <div className={styles.headerFilters} data-warm-ad-data-filters="true">
      {projectControl('项目筛选')}
      {countryControl}
      {dateRangeControl()}

      {projectsError ? (
        <div className={styles.headerError} role="alert">
          {projectsError}
        </div>
      ) : null}
    </div>
  )

  const selectedProjectName =
    projects.find((project) => String(project.id) === projectId)?.name ?? '全部项目'
  const mobileSummary = `${selectedProjectName} · ${country} · ${dateFrom || ''} ~ ${dateTo || ''}`

  const mobileControls = (
    <>
      <MobileFilterWide>{projectControl('移动项目筛选')}</MobileFilterWide>
      <MobileFilterWide>{countryControl}</MobileFilterWide>
      <MobileFilterWide>{dateRangeControl(styles.headerDateRangeMobile)}</MobileFilterWide>
      {projectsError ? (
        <MobileFilterWide>
          <div className={styles.headerError} role="alert">
            {projectsError}
          </div>
        </MobileFilterWide>
      ) : null}
    </>
  )

  const desktopSlot = useHeaderSlot(controls)
  const mobileStrip = useMobileFilterStrip(
    <MobileFilterStrip
      summary={mobileSummary}
      controls={mobileControls}
      variant="warm-ledger"
      className={styles.mobileFilterStrip}
    />
  )

  return (
    <>
      {desktopSlot}
      {mobileStrip}
    </>
  )
}
