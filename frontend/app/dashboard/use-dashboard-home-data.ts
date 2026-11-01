'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  usePendingOrders,
  type UsePendingOrdersResult,
} from '@/components/dashboard-v2/use-pending-orders'
import { useManagedProjects } from '@/lib/hooks/use-managed-projects'
import { formatYMD } from '@/lib/dashboard-format'
import type {
  DashboardCountriesResponse,
  DashboardCountryBreakdownEntry,
  DashboardDailyAnalysisResponse,
  DashboardDailyAnalysisRow,
  DashboardHomeDateRange,
  DashboardProjectBreakdownEntry,
} from '@/components/dashboard-v2/warm-ledger/integration/dashboard-home-types'

const ALL_PROJECTS = 'all'

function addDays(date: Date, amount: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + amount)
  return next
}

function responseDetail(response: Response): Promise<string | null> {
  return response
    .json()
    .then((payload: { detail?: unknown }) =>
      typeof payload?.detail === 'string' ? payload.detail : null
    )
    .catch(() => null)
}

export interface UseDashboardHomeDataParams {
  projectId: string
  dateRange: DashboardHomeDateRange
}

export interface DashboardHomeDataResult {
  projects: ReturnType<typeof useManagedProjects>['projects']
  projectsLoading: boolean
  projectsError: string | null
  refetchProjects: () => Promise<void>
  currentRows: DashboardDailyAnalysisRow[]
  comparisonRows: DashboardDailyAnalysisRow[]
  projectBreakdown: Record<number, DashboardProjectBreakdownEntry>
  compareProjectBreakdown: Record<number, DashboardProjectBreakdownEntry>
  countryRowsByCode: Record<string, DashboardCountryBreakdownEntry>
  countryCompareRowsByCode: Record<string, DashboardCountryBreakdownEntry>
  dataLoading: boolean
  dataError: string | null
  countriesLoading: boolean
  pendingOrders: UsePendingOrdersResult
  refresh: () => Promise<void>
}

export function useDashboardHomeData({
  projectId,
  dateRange,
}: UseDashboardHomeDataParams): DashboardHomeDataResult {
  const managedProjects = useManagedProjects()
  const { projects, loading: projectsLoading, error: projectsError, refetch } = managedProjects
  const [currentRows, setCurrentRows] = useState<DashboardDailyAnalysisRow[]>([])
  const [comparisonRows, setComparisonRows] = useState<DashboardDailyAnalysisRow[]>([])
  const [projectBreakdown, setProjectBreakdown] = useState<
    Record<number, DashboardProjectBreakdownEntry>
  >({})
  const [compareProjectBreakdown, setCompareProjectBreakdown] = useState<
    Record<number, DashboardProjectBreakdownEntry>
  >({})
  const [countryRowsByCode, setCountryRowsByCode] = useState<
    Record<string, DashboardCountryBreakdownEntry>
  >({})
  const [countryCompareRowsByCode, setCountryCompareRowsByCode] = useState<
    Record<string, DashboardCountryBreakdownEntry>
  >({})
  const [dataLoading, setDataLoading] = useState(false)
  const [dataError, setDataError] = useState<string | null>(null)
  const [countriesLoading, setCountriesLoading] = useState(false)
  const latestDataRequestRef = useRef(0)
  const latestCountriesRequestRef = useRef(0)

  const projectIds = useMemo(() => {
    if (projectId === ALL_PROJECTS) {
      return projects.map((project) => project.id)
    }
    const id = Number(projectId)
    return Number.isInteger(id) && projects.some((project) => project.id === id) ? [id] : []
  }, [projectId, projects])
  const projectIdsParam = projectIds.join(',')
  const startDate = formatYMD(dateRange.from)
  const endDate = formatYMD(dateRange.to)
  const currentDayCount =
    Math.floor((dateRange.to.getTime() - dateRange.from.getTime()) / 86400000) + 1
  const previousFrom = addDays(dateRange.from, -currentDayCount)
  const previousTo = addDays(dateRange.from, -1)
  const previousStartDate = formatYMD(previousFrom)
  const previousEndDate = formatYMD(previousTo)

  const pendingOrders = usePendingOrders({
    enabled: true,
    projectIds,
    dateFrom: startDate,
    dateTo: endDate,
  })
  const refreshPendingOrders = pendingOrders.refresh

  const loadDailyData = useCallback(async () => {
    if (!projectIdsParam) return

    const requestId = ++latestDataRequestRef.current
    setDataLoading(true)
    setDataError(null)

    try {
      const currentParams = new URLSearchParams({
        project_ids: projectIdsParam,
        country: 'US',
        start_date: startDate,
        end_date: endDate,
        include_detail: 'false',
      })
      const compareParams = new URLSearchParams({
        project_ids: projectIdsParam,
        country: 'US',
        start_date: previousStartDate,
        end_date: previousEndDate,
        include_detail: 'false',
      })
      const [response, compareResponse] = await Promise.all([
        fetch(`/api/backend/api/v1/daily-analysis/all?${currentParams.toString()}`, {
          cache: 'no-store',
        }),
        fetch(`/api/backend/api/v1/daily-analysis/all?${compareParams.toString()}`, {
          cache: 'no-store',
        }),
      ])

      if (!response.ok) {
        throw new Error((await responseDetail(response)) || '销售数据加载失败')
      }

      const payload = (await response.json()) as DashboardDailyAnalysisResponse
      const comparePayload = compareResponse.ok
        ? ((await compareResponse.json()) as DashboardDailyAnalysisResponse)
        : null
      if (requestId !== latestDataRequestRef.current) return

      setCurrentRows(Array.isArray(payload.summary_rows) ? payload.summary_rows : [])
      setComparisonRows(
        Array.isArray(comparePayload?.summary_rows) ? comparePayload.summary_rows : []
      )
      setProjectBreakdown(payload.project_breakdown ?? {})
      setCompareProjectBreakdown(comparePayload?.project_breakdown ?? {})
    } catch (error) {
      if (requestId !== latestDataRequestRef.current) return
      setDataError(error instanceof Error ? error.message : '销售数据加载失败')
      setCurrentRows([])
      setComparisonRows([])
      setProjectBreakdown({})
      setCompareProjectBreakdown({})
    } finally {
      if (requestId === latestDataRequestRef.current) setDataLoading(false)
    }
  }, [endDate, previousEndDate, previousStartDate, projectIdsParam, startDate])

  const loadCountriesData = useCallback(async () => {
    if (!projectIdsParam) return

    const requestId = ++latestCountriesRequestRef.current
    setCountriesLoading(true)
    const isAllProjects = projectId === ALL_PROJECTS
    const projectParamKey = isAllProjects ? 'project_ids' : 'project_id'
    const endpoint = isAllProjects
      ? '/api/backend/api/v1/daily-analysis/all-projects-countries'
      : '/api/backend/api/v1/daily-analysis/all-countries'
    const params = new URLSearchParams({
      [projectParamKey]: isAllProjects ? projectIdsParam : projectId,
      start_date: startDate,
      end_date: endDate,
    })
    const compareParams = new URLSearchParams({
      [projectParamKey]: isAllProjects ? projectIdsParam : projectId,
      start_date: previousStartDate,
      end_date: previousEndDate,
    })

    try {
      const [response, compareResponse] = await Promise.all([
        fetch(`${endpoint}?${params.toString()}`, { cache: 'no-store' }),
        fetch(`${endpoint}?${compareParams.toString()}`, { cache: 'no-store' }),
      ])
      let nextRows: Record<string, DashboardCountryBreakdownEntry> = {}
      let nextCompareRows: Record<string, DashboardCountryBreakdownEntry> = {}
      if (response.ok) {
        const payload = (await response.json()) as DashboardCountriesResponse
        nextRows = payload.country_breakdown ?? {}
      }
      if (compareResponse.ok) {
        const payload = (await compareResponse.json()) as DashboardCountriesResponse
        nextCompareRows = payload.country_breakdown ?? {}
      }
      if (requestId !== latestCountriesRequestRef.current) return
      setCountryRowsByCode(nextRows)
      setCountryCompareRowsByCode(nextCompareRows)
    } catch {
      if (requestId !== latestCountriesRequestRef.current) return
      setCountryRowsByCode({})
      setCountryCompareRowsByCode({})
    } finally {
      if (requestId === latestCountriesRequestRef.current) setCountriesLoading(false)
    }
  }, [endDate, previousEndDate, previousStartDate, projectId, projectIdsParam, startDate])

  useEffect(() => {
    if (projectsLoading) return
    if (projectIds.length === 0) {
      latestDataRequestRef.current += 1
      setCurrentRows([])
      setComparisonRows([])
      setProjectBreakdown({})
      setCompareProjectBreakdown({})
      setDataLoading(false)
      return
    }
    void loadDailyData()
  }, [loadDailyData, projectIds.length, projectsLoading])

  useEffect(() => {
    if (projectsLoading) return
    if (projectIds.length === 0) {
      latestCountriesRequestRef.current += 1
      setCountryRowsByCode({})
      setCountryCompareRowsByCode({})
      setCountriesLoading(false)
      return
    }
    void loadCountriesData()
  }, [loadCountriesData, projectIds.length, projectsLoading])

  const refresh = useCallback(async () => {
    refreshPendingOrders()
    if (projectsError) await refetch()
    await Promise.all([loadDailyData(), loadCountriesData()])
  }, [loadCountriesData, loadDailyData, projectsError, refetch, refreshPendingOrders])

  return {
    projects,
    projectsLoading,
    projectsError,
    refetchProjects: refetch,
    currentRows,
    comparisonRows,
    projectBreakdown,
    compareProjectBreakdown,
    countryRowsByCode,
    countryCompareRowsByCode,
    dataLoading,
    dataError,
    countriesLoading,
    pendingOrders,
    refresh,
  }
}

