'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'

import { SearchCommand, OPEN_SEARCH_EVENT } from '@/components/dashboard/search-command'
import {
  DateRangePicker,
  COUNTRY_TIMEZONE_MAP,
  formatDateInputValue,
  parseDateRangeInputValue,
} from '@/components/ui/date-picker'
import {
  HeaderSlotMount,
  MobileStripMount,
  PrimaryFilterSlotMount,
  SecondaryHeaderSlotMount,
  TerminalHeaderSlotProvider,
  useTerminalHeaderSlot,
} from '@/components/terminal/terminal-header-slot'
import {
  defaultGlobalDateRange,
  TerminalGlobalFilterProvider,
  type TerminalDailyAnalysisPageFilters,
  useTerminalGlobalFilter,
} from '@/components/terminal/global-filter-context'
import { WarmNotificationPanel } from './warm-notification-panel'
import { WarmLedgerShell } from './warm-ledger-shell'
import { WarmLedgerTopbar, type WarmLedgerRouteSlots } from './warm-ledger-topbar'
import { WarmButton, WarmSelect, type WarmSelectOption } from '../controls'
import { useServerNotifications } from '@/components/notifications'
import {
  getDashboardPageTitle,
  getDashboardRouteMeta,
  type DashboardRouteMeta,
} from '@/lib/dashboard-route-meta'
import { COUNTRY_LABELS } from '@/lib/country'
import { useManagedProjects } from '@/lib/hooks/use-managed-projects'

const DAILY_ANALYSIS_ROUTE = '/dashboard/operations/daily-analysis'
const ORDER_INFO_ROUTE = '/dashboard/reports/order-info'
const FALLBACK_REFRESH_WATCHDOG_MS = 10_000

const GLOBAL_COUNTRY_OPTIONS: ReadonlyArray<WarmSelectOption> = [
  { value: 'ALL', label: '全部站点' },
  { value: 'US', label: `${COUNTRY_LABELS.US} (US)` },
  { value: 'DE', label: `${COUNTRY_LABELS.DE} (DE)` },
  { value: 'UK', label: `${COUNTRY_LABELS.UK} (UK)` },
]

function readDailyAnalysisPageFilters(): TerminalDailyAnalysisPageFilters {
  if (typeof window === 'undefined') return { projectId: '', country: 'US' }
  const params = new URLSearchParams(window.location.search)
  const country = params.get('country')
  return {
    projectId: params.get('project') ?? '',
    country: country && ['US', 'DE', 'UK', 'ALL'].includes(country) ? country : 'US',
  }
}

export function getWarmLedgerRouteMeta(
  pathname: string
): (DashboardRouteMeta & { warm: true }) | undefined {
  const routeMeta = getDashboardRouteMeta(pathname)
  return routeMeta?.warm ? (routeMeta as DashboardRouteMeta & { warm: true }) : undefined
}

export function isWarmLedgerRoute(pathname: string) {
  return Boolean(getWarmLedgerRouteMeta(pathname))
}

export function getWarmLedgerPageTitle(pathname: string) {
  return getWarmLedgerRouteMeta(pathname)?.title ?? getDashboardPageTitle(pathname)
}

export function WarmLedgerRouteFrame({
  pathname,
  children,
}: {
  pathname: string
  children: ReactNode
}) {
  return (
    <TerminalGlobalFilterProvider>
      <TerminalHeaderSlotProvider>
        <WarmLedgerRouteContent pathname={pathname}>{children}</WarmLedgerRouteContent>
      </TerminalHeaderSlotProvider>
    </TerminalGlobalFilterProvider>
  )
}

function DailyAnalysisGlobalFilters() {
  const globalFilter = useTerminalGlobalFilter()
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)
  const {
    projectId: globalProjectId,
    country: globalCountry,
    dateFrom: globalDateFrom,
    dateTo: globalDateTo,
    syncDailyAnalysisFilters,
  } = globalFilter
  const { projects, loading, error, refetch } = useManagedProjects()
  const [retryRequested, setRetryRequested] = useState(false)

  useEffect(() => {
    setPortalContainer(document.getElementById('warm-ledger-portal-root'))
  }, [])

  const validProjects = useMemo(
    () => projects.filter((project) => project.id > 0),
    [projects]
  )

  const retryProjectList = useCallback(async () => {
    setRetryRequested(true)
    try {
      await refetch()
    } finally {
      setRetryRequested(false)
    }
  }, [refetch])

  const projectValue = globalProjectId
  let projectPlaceholder = '选择项目'
  if (loading) projectPlaceholder = '加载项目…'
  else if (error) projectPlaceholder = '项目列表加载失败'
  else if (validProjects.length === 0) projectPlaceholder = '暂无可用项目'

  const projectOptions = useMemo<ReadonlyArray<WarmSelectOption>>(() => {
    const options: WarmSelectOption[] = [
      { value: 'all', label: '全部项目' },
      ...validProjects.map((project) => ({ value: String(project.id), label: project.name })),
    ]

    if (globalProjectId && globalProjectId !== 'all' &&
      !validProjects.some((project) => String(project.id) === globalProjectId)) {
      options.unshift({
        value: globalProjectId,
        label: loading ? '加载项目…' : globalProjectId,
      })
    }

    return options
  }, [globalProjectId, loading, validProjects])

  const timezone = COUNTRY_TIMEZONE_MAP[
    globalFilter.country === 'ALL' ? 'US' : globalFilter.country
  ]

  return (
    <div
      className="warm-ledger__route-global-filters"
      role="group"
      aria-label="全局筛选"
      aria-busy={loading || retryRequested || undefined}
    >
      <WarmSelect
        id="warm-ledger-route-project-filter"
        label="项目筛选"
        value={projectValue}
        placeholder={projectPlaceholder}
        options={projectOptions}
        onChange={(projectId) => {
          syncDailyAnalysisFilters(
            {
              projectId,
              country: globalCountry,
              dateFrom: globalDateFrom,
              dateTo: globalDateTo,
            },
            { projectId, country: globalCountry }
          )
        }}
        disabled={loading || Boolean(error)}
        error={error}
        className="warm-ledger__route-project-select"
      />
      {error || retryRequested ? (
        <WarmButton
          className="warm-ledger__route-project-retry"
          variant="quiet"
          aria-label="重试加载项目列表"
          loading={retryRequested && loading}
          loadingLabel="正在重试项目列表"
          disabled={loading}
          onClick={retryProjectList}
        >
          重试
        </WarmButton>
      ) : null}
      <WarmSelect
        id="warm-ledger-route-country-filter"
        label="站点筛选"
        value={globalCountry}
        options={GLOBAL_COUNTRY_OPTIONS}
        onChange={(country) => {
          const pageFilters = readDailyAnalysisPageFilters()
          const defaultRange = defaultGlobalDateRange(
            COUNTRY_TIMEZONE_MAP[country === 'ALL' ? 'US' : country] ??
              COUNTRY_TIMEZONE_MAP.US
          )
          syncDailyAnalysisFilters(
            {
              projectId: globalProjectId,
              country,
              dateFrom: defaultRange.dateFrom,
              dateTo: defaultRange.dateTo,
            },
            {
              projectId: globalProjectId || pageFilters.projectId,
              country,
            }
          )
        }}
        className="warm-ledger__route-country-select"
      />
      <DateRangePicker
        value={parseDateRangeInputValue(globalDateFrom, globalDateTo)}
        timezone={timezone}
        onChange={(range) => {
          const pageFilters = readDailyAnalysisPageFilters()
          const country = globalProjectId ? globalCountry : pageFilters.country
          syncDailyAnalysisFilters(
            {
              projectId: globalProjectId,
              country,
              dateFrom: formatDateInputValue(range?.from),
              dateTo: formatDateInputValue(range?.to),
            },
            {
              projectId: globalProjectId || pageFilters.projectId,
              country,
            }
          )
        }}
        placeholder="选择日期范围"
        className="warm-ledger__route-date-range"
        portalContainer={portalContainer}
        popoverClassName="warm-ledger__date-picker-content"
      />
    </div>
  )
}

function OrderInfoGlobalFilters() {
  const globalFilter = useTerminalGlobalFilter()
  const {
    projectId: globalProjectId,
    country: globalCountry,
    dateFrom: globalDateFrom,
    dateTo: globalDateTo,
    ready: filtersReady,
    setProjectId,
    syncDailyAnalysisFilters,
  } = globalFilter
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)
  const { projects, loading, error, refetch } = useManagedProjects()
  const [retryRequested, setRetryRequested] = useState(false)
  const initialScopeAppliedRef = useRef(false)
  const initialProjectSeededRef = useRef(false)
  const userChangedFiltersRef = useRef({ country: false, date: false })

  useEffect(() => {
    setPortalContainer(document.getElementById('warm-ledger-portal-root'))
  }, [])

  const validProjects = useMemo(
    () => projects.filter((project) => project.id > 0),
    [projects]
  )
  const projectOptions = useMemo<ReadonlyArray<WarmSelectOption>>(() => {
    const options: WarmSelectOption[] = [
      { value: 'all', label: '全部项目' },
      ...validProjects.map((project) => ({ value: String(project.id), label: project.name })),
    ]

    if (globalFilter.projectId && globalFilter.projectId !== 'all' &&
      !validProjects.some((project) => String(project.id) === globalFilter.projectId)) {
      options.unshift({
        value: globalFilter.projectId,
        label: loading ? '加载项目…' : globalFilter.projectId,
      })
    }

    return options
  }, [globalFilter.projectId, loading, validProjects])

  let projectPlaceholder = '选择项目'
  if (loading) projectPlaceholder = '加载项目…'
  else if (error) projectPlaceholder = '项目列表加载失败'
  else if (validProjects.length === 0) projectPlaceholder = '暂无可用项目'

  const timezone = COUNTRY_TIMEZONE_MAP[
    globalFilter.country === 'ALL' ? 'US' : globalFilter.country
  ] ?? COUNTRY_TIMEZONE_MAP.US

  useEffect(() => {
    if (!filtersReady || initialScopeAppliedRef.current) return
    initialScopeAppliedRef.current = true

    const params = new URLSearchParams(window.location.search)
    const rawPageProjectId = params.get('project_id')
    const pageProjectId = rawPageProjectId && rawPageProjectId !== '__all__'
      ? rawPageProjectId
      : ''
    const pageDateFrom = params.get('date_from')
    const pageDateTo = params.get('date_to')
    const hasPageDateRange = Boolean(pageDateFrom && pageDateTo)
    const defaultRange = defaultGlobalDateRange(COUNTRY_TIMEZONE_MAP.US)
    const firstProjectId = !globalProjectId && !loading && !error
      ? String(validProjects[0]?.id ?? '')
      : ''
    const projectId = pageProjectId || globalProjectId || firstProjectId
    if (!globalProjectId && projectId) initialProjectSeededRef.current = true
    const nextCountry = userChangedFiltersRef.current.country || globalProjectId
      ? globalCountry
      : 'ALL'
    const nextDateFrom = userChangedFiltersRef.current.date
      ? globalDateFrom
      : hasPageDateRange
        ? pageDateFrom!
        : globalProjectId
          ? globalDateFrom
          : defaultRange.dateFrom
    const nextDateTo = userChangedFiltersRef.current.date
      ? globalDateTo
      : hasPageDateRange
        ? pageDateTo!
        : globalProjectId
          ? globalDateTo
          : defaultRange.dateTo

    if (
      projectId === globalProjectId &&
      nextCountry === globalCountry &&
      nextDateFrom === globalDateFrom &&
      nextDateTo === globalDateTo
    ) return

    syncDailyAnalysisFilters(
      {
        projectId,
        country: nextCountry,
        dateFrom: nextDateFrom,
        dateTo: nextDateTo,
      },
      { projectId, country: nextCountry }
    )
  }, [
    error,
    filtersReady,
    globalCountry,
    globalDateFrom,
    globalDateTo,
    globalProjectId,
    loading,
    syncDailyAnalysisFilters,
    validProjects,
  ])

  useEffect(() => {
    if (
      !initialScopeAppliedRef.current ||
      initialProjectSeededRef.current ||
      !filtersReady ||
      globalProjectId ||
      loading ||
      error
    ) {
      return
    }

    const params = new URLSearchParams(window.location.search)
    const pageProjectId = params.get('project_id')
    if (pageProjectId && pageProjectId !== '__all__') return

    const firstProjectId = validProjects[0]?.id
    if (firstProjectId) {
      initialProjectSeededRef.current = true
      setProjectId(String(firstProjectId))
    }
  }, [error, filtersReady, globalProjectId, loading, setProjectId, validProjects])

  const retryProjectList = useCallback(async () => {
    setRetryRequested(true)
    try {
      await refetch()
    } finally {
      setRetryRequested(false)
    }
  }, [refetch])

  return (
    <div
      className="warm-ledger__route-global-filters"
      role="group"
      aria-label="全局筛选"
      aria-busy={loading || retryRequested || undefined}
    >
      <WarmSelect
        id="warm-ledger-order-info-project-filter"
        label="项目筛选"
        value={globalFilter.projectId}
        placeholder={projectPlaceholder}
        options={projectOptions}
        onChange={globalFilter.setProjectId}
        disabled={loading || Boolean(error)}
        error={error}
        className="warm-ledger__route-project-select"
      />
      {error || retryRequested ? (
        <WarmButton
          className="warm-ledger__route-project-retry"
          variant="quiet"
          aria-label="重试加载项目列表"
          loading={retryRequested && loading}
          loadingLabel="正在重试项目列表"
          disabled={loading}
          onClick={retryProjectList}
        >
          重试
        </WarmButton>
      ) : null}
      <WarmSelect
        id="warm-ledger-order-info-country-filter"
        label="站点筛选"
        value={globalFilter.country}
        options={GLOBAL_COUNTRY_OPTIONS}
        onChange={(country) => {
          userChangedFiltersRef.current.country = true
          globalFilter.setCountry(country)
        }}
        className="warm-ledger__route-country-select"
      />
      <DateRangePicker
        value={parseDateRangeInputValue(globalFilter.dateFrom, globalFilter.dateTo)}
        timezone={timezone}
        onChange={(range) => {
          userChangedFiltersRef.current.date = true
          globalFilter.setDateRange(
            formatDateInputValue(range?.from),
            formatDateInputValue(range?.to)
          )
        }}
        placeholder="选择日期范围"
        className="warm-ledger__route-date-range"
        portalContainer={portalContainer}
        popoverClassName="warm-ledger__date-picker-content"
      />
    </div>
  )
}

function WarmLedgerRouteContent({
  pathname,
  children,
}: {
  pathname: string
  children: ReactNode
}) {
  const router = useRouter()
  const globalFilter = useTerminalGlobalFilter()
  const {
    actionSlotActive,
    primaryFilterSlotActive,
    secondarySlotActive,
    refreshRegistered,
    refreshLoading,
    refreshHandlerPending,
    refreshFeedback,
    announceRefresh,
    triggerRefresh,
  } = useTerminalHeaderSlot()
  const { unreadCount, refresh: refreshNotifications } = useServerNotifications()
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [fallbackPending, startFallbackRefresh] = useTransition()
  const [fallbackTimedOut, setFallbackTimedOut] = useState(false)
  const fallbackRefreshStartedRef = useRef(false)

  const isDailyAnalysis = pathname === DAILY_ANALYSIS_ROUTE
  const isOrderInfo = pathname === ORDER_INFO_ROUTE
  const hasGlobalFilters = (isDailyAnalysis || isOrderInfo) && globalFilter.ready
  const showPrimarySlot = hasGlobalFilters || primaryFilterSlotActive
  const routeMeta = getWarmLedgerRouteMeta(pathname)
  const title = routeMeta?.title ?? getDashboardPageTitle(pathname)
  const breadcrumbs = routeMeta?.sectionLabel
    ? [
        { label: routeMeta.sectionLabel, href: routeMeta.sectionHref },
        { label: title },
      ]
    : [{ label: title }]

  useEffect(() => {
    announceRefresh('', 'idle')
  }, [announceRefresh, pathname])

  useEffect(() => {
    if (!fallbackPending) {
      setFallbackTimedOut(false)
      return
    }
    const timer = setTimeout(() => setFallbackTimedOut(true), FALLBACK_REFRESH_WATCHDOG_MS)
    return () => clearTimeout(timer)
  }, [fallbackPending])

  useEffect(() => {
    if (refreshRegistered || fallbackPending || !fallbackRefreshStartedRef.current) return
    fallbackRefreshStartedRef.current = false
    announceRefresh('刷新请求已返回；请确认页面内容已更新。', 'requested')
  }, [announceRefresh, fallbackPending, refreshRegistered])

  useEffect(() => {
    if (!fallbackTimedOut || refreshRegistered) return
    announceRefresh('刷新仍在后台进行，页面响应后会自动更新。', 'requested')
  }, [announceRefresh, fallbackTimedOut, refreshRegistered])

  const handleRefresh = useCallback(() => {
    if (refreshRegistered) {
      triggerRefresh()
      return
    }

    fallbackRefreshStartedRef.current = true
    announceRefresh('正在刷新当前页。', 'loading')
    startFallbackRefresh(() => router.refresh())
  }, [announceRefresh, refreshRegistered, router, startFallbackRefresh, triggerRefresh])

  const handleSearch = useCallback(() => {
    window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT))
  }, [])

  const handleOpenNotifications = useCallback(() => {
    void refreshNotifications()
    setNotificationsOpen(true)
  }, [refreshNotifications])

  const routeSlots: WarmLedgerRouteSlots = {
    action: actionSlotActive ? (
      <HeaderSlotMount className="warm-ledger__route-slot warm-ledger__route-action-slot" />
    ) : null,
    primary: showPrimarySlot ? (
      <PrimaryFilterSlotMount className="warm-ledger__route-slot warm-ledger__route-primary-slot">
        {isDailyAnalysis && globalFilter.ready ? <DailyAnalysisGlobalFilters /> : null}
        {isOrderInfo && globalFilter.ready ? <OrderInfoGlobalFilters /> : null}
      </PrimaryFilterSlotMount>
    ) : null,
    secondary: secondarySlotActive ? (
      <SecondaryHeaderSlotMount className="warm-ledger__route-slot warm-ledger__route-secondary-slot" />
    ) : null,
  }

  const refreshActive = refreshRegistered
    ? refreshLoading || refreshHandlerPending
    : fallbackPending && !fallbackTimedOut

  return (
    <>
      <WarmLedgerShell
        topbar={(
          <WarmLedgerTopbar
            routeFrame
            breadcrumbs={breadcrumbs}
            routeSlots={routeSlots}
            showScopeMeta={false}
            onRefresh={handleRefresh}
            refreshing={refreshActive}
            refreshFeedbackMessage={refreshFeedback.message}
            refreshFeedbackStatus={refreshFeedback.status}
            onSearch={handleSearch}
            onNotifications={handleOpenNotifications}
            unreadCount={unreadCount}
            profileHref="/dashboard/profile"
            userLabel="个人中心"
          />
        )}
      >
        <MobileStripMount className="warm-ledger__mobile-strip" />
        <WarmNotificationPanel
          open={notificationsOpen}
          onClose={() => setNotificationsOpen(false)}
        />
        {children}
      </WarmLedgerShell>
      <SearchCommand />
    </>
  )
}
