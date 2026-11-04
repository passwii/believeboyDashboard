'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, Plus, X } from 'lucide-react'
import { useTerminalGlobalFilter } from '@/components/terminal/global-filter-context'
import { useNotifications } from '@/components/notifications'
import { Input } from '@/components/ui/input'
import { COUNTRY_TIMEZONE_MAP } from '@/components/ui/date-picker'
import { COUNTRY_LABELS } from '@/lib/country'
import { useManagedProjects } from '@/lib/hooks/use-managed-projects'
import { WarmBadge, WarmButton, WarmSelect, type WarmSelectOption } from '@/components/dashboard-v2/warm-ledger/controls'
import {
  useHeaderRefresh,
  useMobileFilterStrip,
  usePrimaryFilterSlot,
} from '@/components/terminal/terminal-header-slot'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'
import { ForecastChart } from './components/forecast-chart'
import { ShipmentHistoryChart } from './components/shipment-history-chart'
import { SkuForecastTable } from './components/sku-forecast-table'
import styles from './shipping-plan-warm.module.css'
import type { components } from '@/types/api-generated/api'

const API_BASE = '/api/backend/api/v1/shipping-plan'
const BACKEND_API_BASE = '/api/backend/api/v1'
const MAX_SCHEDULE_CANDIDATES_PER_STATUS = 25
const SUPPORTED_COUNTRIES = ['US', 'DE', 'UK'] as const

type DecimalValue = number | string

type ShippingPlanSku = components['schemas']['ShippingPlanSkuItem']
type ShippingPlanSkuListResponse = components['schemas']['ShippingPlanSkuListResponse']
type ForecastPoint = components['schemas']['ForecastPoint']
type ForecastResponse = components['schemas']['ShippingPlanForecastResponse']
type ShipmentHistory = components['schemas']['ShipmentHistoryResponse']
type PlanItem = components['schemas']['ShippingPlanBatchItemResponse']
type PlanBatch = components['schemas']['ShippingPlanBatchResponse']
type PlanBatchesResponse = components['schemas']['ShippingPlanBatchListResponse']
const EMPTY_PLAN_BATCHES: PlanBatch[] = []
type ShipmentCandidate = Pick<
  components['schemas']['ShipmentScheduleListItem'],
  'id' | 'shipment_no' | 'shipment_status' | 'etd_date' | 'eta_date'
> & { shipment_status: 'draft' | 'in_transit'; available_quantity: number }
type EditablePlanItem = { id: number | string; sku: string; quantity: string; allocated: number }
type ShipmentScheduleListResponse = components['schemas']['ShipmentScheduleListResponse']
type ShipmentScheduleDetail = components['schemas']['ShipmentScheduleDetail']
type ApiErrorPayload = { detail?: unknown }
type ScopeRequestState = { scopeKey: string; loading: boolean; error: string | null }
type ScopedResult<T> = { scopeKey: string; data: T }
type BatchDraft = {
  scopeKey: string
  name: string
  arrival: string
  rows: Array<{ sku: string; quantity: string }>
}

function emptyBatchDraft(scopeKey: string): BatchDraft {
  return { scopeKey, name: '', arrival: '', rows: [{ sku: '', quantity: '' }] }
}

function sameBatchDraft(left: BatchDraft, right: BatchDraft): boolean {
  return left.scopeKey === right.scopeKey &&
    left.name === right.name &&
    left.arrival === right.arrival &&
    left.rows.length === right.rows.length &&
    left.rows.every((row, index) =>
      row.sku === right.rows[index]?.sku && row.quantity === right.rows[index]?.quantity
    )
}

function formatNumber(value: DecimalValue | null | undefined, digits = 1): string {
  const numeric = value == null ? null : Number(value)
  if (numeric == null || !Number.isFinite(numeric)) return '—'
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(numeric)
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '未知'
  const parsed = new Date(`${value}T00:00:00`)
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('zh-CN').format(parsed)
}

function queryString(values: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  })
  return params.toString()
}

function getApiErrorMessage(detail: unknown): string | null {
  if (typeof detail === 'string') return detail
  if (!Array.isArray(detail)) return null
  const messages = detail.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const validationError = entry as { loc?: unknown; msg?: unknown }
    if (typeof validationError.msg !== 'string') return []
    const location = Array.isArray(validationError.loc)
      ? validationError.loc.filter((part) => part !== 'body').map(String).join('.')
      : ''
    return [location ? `${location}: ${validationError.msg}` : validationError.msg]
  })
  return messages.length ? messages.join('；') : null
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith(`${BACKEND_API_BASE}/`) ? path : `${API_BASE}${path}`
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    let message = `请求失败（HTTP ${response.status}）`
    try {
      const payload = (await response.json()) as ApiErrorPayload
      message = getApiErrorMessage(payload.detail) || message
    } catch {
      // Keep the status-based message when the proxy did not return JSON.
    }
    throw new Error(message)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

function qualityKey(reasons: string[] | undefined): 'ready' | 'missing_inventory' | 'missing_sales' | 'inventory_stale' | 'inventory_pending' {
  if (!reasons?.length) return 'ready'
  if (reasons?.includes('inventory_snapshot_missing') || reasons?.includes('sku_inventory_snapshot_missing')) return 'missing_inventory'
  if (reasons?.includes('sales_baseline_missing')) return 'missing_sales'
  if (reasons?.includes('post_snapshot_inbound_before_forecast_start')) return 'inventory_stale'
  return 'inventory_pending'
}

function qualityReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    inventory_snapshot_missing: '缺少库存快照日期',
    sku_inventory_snapshot_missing: '快照中没有该 SKU 的可售数量',
    sales_baseline_missing: '缺少可用的销量基线',
    completed_inbound_unverified: '已完成货件缺少可核对的实际入仓日期或库存快照',
    post_snapshot_inbound_before_forecast_start: '库存快照后、预测开始前已有货件入仓；请更新快照',
    shipment_eta_missing: '部分正式货件没有可用 ETA',
    shipment_eta_overdue: '部分正式货件 ETA 已早于预测开始日期',
    plan_eta_overdue: '部分预期计划日期已早于预测开始日期',
  }
  return labels[reason] ?? reason
}

function getSiteDates(country: string): { asOfDate: string; etdFrom: string; etdTo: string } {
  const timezone = COUNTRY_TIMEZONE_MAP[country] ?? COUNTRY_TIMEZONE_MAP.US
  const asOfDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
  const [year, month, day] = asOfDate.split('-').map(Number)
  const from = new Date(Date.UTC(year!, month! - 1, day! - 365))
  return { asOfDate, etdFrom: from.toISOString().slice(0, 10), etdTo: asOfDate }
}

function StatLine({ label, value }: { label: string; value: string | number }) {
  return (
    <div className={styles.summaryMetric}>
      <dt className={styles.summaryLabel}>{label}</dt>
      <dd className={styles.summaryValue}>{value}</dd>
    </div>
  )
}

export default function ShippingPlanClient() {
  const globalFilter = useTerminalGlobalFilter()
  const { notify } = useNotifications()
  const {
    projects,
    loading: projectsLoading,
    error: projectLoadError,
    refetch: refetchProjects,
  } = useManagedProjects()
  const { projectId, country, setProjectId, setCountry } = globalFilter
  const validProjects = useMemo(() => projects.filter((project) => project.id > 0), [projects])
  const projectListReady = !projectsLoading && !projectLoadError
  const selectedProjectExists = projectListReady && validProjects.some((project) => String(project.id) === projectId)
  const supportedCountry = SUPPORTED_COUNTRIES.some((site) => site === country)
  const scopeReady = globalFilter.ready && selectedProjectExists && supportedCountry
  const currentScopeKey = scopeReady ? `${projectId}::${country}` : null
  const projectOptions = useMemo<ReadonlyArray<WarmSelectOption>>(() => {
    return [
      { value: 'all', label: '全部项目' },
      ...validProjects.map((project) => ({ value: String(project.id), label: project.name })),
    ]
  }, [validProjects])
  const siteOptions = useMemo<ReadonlyArray<WarmSelectOption>>(
    () => SUPPORTED_COUNTRIES.map((site) => ({
      value: site,
      label: `${COUNTRY_LABELS[site]} (${site})`,
    })),
    []
  )

  const [skuResult, setSkuResult] = useState<ScopedResult<{
    rows: ShippingPlanSku[]
    summary: ShippingPlanSkuListResponse
  }> | null>(null)
  const [skuRequest, setSkuRequest] = useState<ScopeRequestState>({ scopeKey: '', loading: false, error: null })
  const [historyResult, setHistoryResult] = useState<ScopedResult<ShipmentHistory> | null>(null)
  const [historyRequest, setHistoryRequest] = useState<ScopeRequestState>({ scopeKey: '', loading: false, error: null })
  const [planResult, setPlanResult] = useState<ScopedResult<PlanBatch[]> | null>(null)
  const [planRequest, setPlanRequest] = useState<ScopeRequestState>({ scopeKey: '', loading: false, error: null })
  const [forecastResult, setForecastResult] = useState<{
    scopeKey: string
    sku: string
    data: ForecastResponse
  } | null>(null)
  const [forecastRequest, setForecastRequest] = useState<{
    scopeKey: string
    sku: string
    loading: boolean
    error: string | null
  } | null>(null)
  const [forecastRetryKey, setForecastRetryKey] = useState(0)
  const [selectedSkuState, setSelectedSkuState] = useState<{ scopeKey: string; sku: string } | null>(null)
  const skuRequestIdRef = useRef(0)
  const historyRequestIdRef = useRef(0)
  const planRequestIdRef = useRef(0)
  const forecastRequestIdRef = useRef(0)
  const currentScopeKeyRef = useRef<string | null>(currentScopeKey)
  currentScopeKeyRef.current = currentScopeKey
  const selectedSku = currentScopeKey && selectedSkuState?.scopeKey === currentScopeKey
    ? selectedSkuState.sku
    : ''
  const setSelectedSku = useCallback((sku: string) => {
    if (!currentScopeKey || currentScopeKeyRef.current !== currentScopeKey) return
    setSelectedSkuState({ scopeKey: currentScopeKey, sku })
  }, [currentScopeKey])
  const selectedSkuRef = useRef(selectedSku)
  selectedSkuRef.current = selectedSku
  const [factorDraftState, setFactorDraftState] = useState<{ scopeKey: string; sku: string; value: string } | null>(null)
  const [batchDraftState, setBatchDraftState] = useState<BatchDraft | null>(null)
  const [savingFactorByScope, setSavingFactorByScope] = useState<Record<string, symbol>>({})
  const [creatingBatchByScope, setCreatingBatchByScope] = useState<Record<string, symbol>>({})
  const [editingBatchId, setEditingBatchId] = useState<number | null>(null)
  const [editingScopeKey, setEditingScopeKey] = useState<string | null>(null)
  const [editBatchName, setEditBatchName] = useState('')
  const [editBatchArrival, setEditBatchArrival] = useState('')
  const [editBatchRows, setEditBatchRows] = useState<EditablePlanItem[]>([])
  const [savingBatchEditByScope, setSavingBatchEditByScope] = useState<Record<string, symbol>>({})
  const [cancellingBatchByScope, setCancellingBatchByScope] = useState<Record<string, number>>({})
  const [candidates, setCandidates] = useState<ShipmentCandidate[]>([])
  const [candidateScopeKey, setCandidateScopeKey] = useState<string | null>(null)
  const [candidatesLoading, setCandidatesLoading] = useState(false)
  const [candidateError, setCandidateError] = useState<string | null>(null)
  const [candidatesTruncated, setCandidatesTruncated] = useState(false)
  const candidatesRequestIdRef = useRef(0)
  const [allocationItemId, setAllocationItemId] = useState<number | null>(null)
  const [allocationScopeKey, setAllocationScopeKey] = useState<string | null>(null)
  const [allocationScheduleId, setAllocationScheduleId] = useState('')
  const [allocationQuantity, setAllocationQuantity] = useState('')
  const [savingAllocationByScope, setSavingAllocationByScope] = useState<Record<string, symbol>>({})
  const allocationSubmitInFlightByScopeRef = useRef(new Set<string>())
  const updateBatchDraft = (update: (draft: BatchDraft) => BatchDraft) => {
    if (!currentScopeKey || currentScopeKeyRef.current !== currentScopeKey) return
    setBatchDraftState((current) => update(
      current?.scopeKey === currentScopeKey ? current : emptyBatchDraft(currentScopeKey)
    ))
  }

  const scopeQuery = useMemo(() => queryString({ project_id: projectId, country }), [country, projectId])
  const batchDraft = currentScopeKey && batchDraftState?.scopeKey === currentScopeKey
    ? batchDraftState
    : emptyBatchDraft(currentScopeKey ?? '')

  const skus = scopeReady && currentScopeKey && skuResult?.scopeKey === currentScopeKey
    ? skuResult.data.rows
    : []
  const skuSummary = scopeReady && currentScopeKey && skuResult?.scopeKey === currentScopeKey
    ? skuResult.data.summary
    : null
  const history = scopeReady && currentScopeKey && historyResult?.scopeKey === currentScopeKey
    ? historyResult.data
    : null
  const batches = scopeReady && currentScopeKey && planResult?.scopeKey === currentScopeKey
    ? planResult.data
    : EMPTY_PLAN_BATCHES
  const savingFactor = Boolean(currentScopeKey && savingFactorByScope[currentScopeKey])
  const creatingBatch = Boolean(currentScopeKey && creatingBatchByScope[currentScopeKey])
  const savingBatchEdit = Boolean(currentScopeKey && savingBatchEditByScope[currentScopeKey])
  const savingAllocation = Boolean(currentScopeKey && savingAllocationByScope[currentScopeKey])
  const skuLoading = scopeReady && Boolean(currentScopeKey) &&
    (skuRequest.scopeKey !== currentScopeKey || skuRequest.loading)
  const historyLoading = scopeReady && Boolean(currentScopeKey) &&
    (historyRequest.scopeKey !== currentScopeKey || historyRequest.loading)
  const planLoading = scopeReady && Boolean(currentScopeKey) &&
    (planRequest.scopeKey !== currentScopeKey || planRequest.loading)
  const skuError = scopeReady && currentScopeKey && skuRequest.scopeKey === currentScopeKey
    ? skuRequest.error
    : null
  const historyError = scopeReady && currentScopeKey && historyRequest.scopeKey === currentScopeKey
    ? historyRequest.error
    : null
  const planError = scopeReady && currentScopeKey && planRequest.scopeKey === currentScopeKey
    ? planRequest.error
    : null

  const loadSkuData = useCallback(async () => {
    if (!scopeReady || !currentScopeKey) return
    const requestScopeKey = currentScopeKey
    const requestId = ++skuRequestIdRef.current
    const isCurrent = () => requestId === skuRequestIdRef.current && currentScopeKeyRef.current === requestScopeKey
    setSkuRequest({ scopeKey: requestScopeKey, loading: true, error: null })
    try {
      const window = getSiteDates(country)
      const firstPage = await requestJson<ShippingPlanSkuListResponse>(
        `/skus?${scopeQuery}&as_of_date=${window.asOfDate}&page=1&page_size=200`
      )
      if (!isCurrent()) return
      const pageCount = Math.ceil(firstPage.total / firstPage.page_size)
      const remainingPages = await Promise.all(
        Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) =>
          requestJson<ShippingPlanSkuListResponse>(
            `/skus?${scopeQuery}&as_of_date=${window.asOfDate}&page=${index + 2}&page_size=200`
          )
        )
      )
      if (!isCurrent()) return
      const allSkus = [firstPage, ...remainingPages].flatMap((page) => page.items ?? [])
      setSkuResult({ scopeKey: requestScopeKey, data: { rows: allSkus, summary: firstPage } })
      setSelectedSkuState((current) => {
        const currentSku = current?.scopeKey === requestScopeKey ? current.sku : ''
        return {
          scopeKey: requestScopeKey,
          sku: allSkus.some((item) => item.sku === currentSku) ? currentSku : (allSkus[0]?.sku ?? ''),
        }
      })
    } catch (error) {
      if (isCurrent()) {
        setSkuRequest({
          scopeKey: requestScopeKey,
          loading: false,
          error: error instanceof Error ? error.message : 'SKU 清单加载失败',
        })
      }
      return
    }
    if (isCurrent()) setSkuRequest({ scopeKey: requestScopeKey, loading: false, error: null })
  }, [country, currentScopeKey, scopeQuery, scopeReady])

  const loadHistoryData = useCallback(async () => {
    if (!scopeReady || !currentScopeKey) return
    const requestScopeKey = currentScopeKey
    const requestId = ++historyRequestIdRef.current
    const isCurrent = () => requestId === historyRequestIdRef.current && currentScopeKeyRef.current === requestScopeKey
    setHistoryRequest({ scopeKey: requestScopeKey, loading: true, error: null })
    try {
      const window = getSiteDates(country)
      const result = await requestJson<ShipmentHistory>(
        `/shipment-history?${scopeQuery}&etd_from=${window.etdFrom}&etd_to=${window.etdTo}`
      )
      if (!isCurrent()) return
      setHistoryResult({ scopeKey: requestScopeKey, data: result })
      setHistoryRequest({ scopeKey: requestScopeKey, loading: false, error: null })
    } catch (error) {
      if (isCurrent()) {
        setHistoryRequest({
          scopeKey: requestScopeKey,
          loading: false,
          error: error instanceof Error ? error.message : '发货历史加载失败',
        })
      }
    }
  }, [country, currentScopeKey, scopeQuery, scopeReady])

  const loadPlanData = useCallback(async () => {
    if (!scopeReady || !currentScopeKey) return
    const requestScopeKey = currentScopeKey
    const requestId = ++planRequestIdRef.current
    const isCurrent = () => requestId === planRequestIdRef.current && currentScopeKeyRef.current === requestScopeKey
    setPlanRequest({ scopeKey: requestScopeKey, loading: true, error: null })
    try {
      const result = await requestJson<PlanBatchesResponse>(`/batches?${scopeQuery}`)
      if (!isCurrent()) return
      setPlanResult({ scopeKey: requestScopeKey, data: result.items ?? [] })
      setPlanRequest({ scopeKey: requestScopeKey, loading: false, error: null })
    } catch (error) {
      if (isCurrent()) {
        setPlanRequest({
          scopeKey: requestScopeKey,
          loading: false,
          error: error instanceof Error ? error.message : '预期计划加载失败',
        })
      }
    }
  }, [currentScopeKey, scopeQuery, scopeReady])

  const reload = useCallback(async () => {
    if (!scopeReady) return
    await Promise.all([loadSkuData(), loadHistoryData(), loadPlanData()])
  }, [loadHistoryData, loadPlanData, loadSkuData, scopeReady])

  useEffect(() => {
    void reload()
    return () => {
      skuRequestIdRef.current += 1
      historyRequestIdRef.current += 1
      planRequestIdRef.current += 1
      forecastRequestIdRef.current += 1
      candidatesRequestIdRef.current += 1
    }
  }, [reload])

  const previousScopeKeyRef = useRef<string | null>(currentScopeKey)
  useEffect(() => {
    if (previousScopeKeyRef.current === currentScopeKey) return
    previousScopeKeyRef.current = currentScopeKey
    candidatesRequestIdRef.current += 1
    setCandidateScopeKey(null)
    setCandidates([])
    setCandidatesLoading(false)
    setCandidateError(null)
    setCandidatesTruncated(false)
    setAllocationItemId(null)
    setAllocationScopeKey(null)
    setAllocationScheduleId('')
    setAllocationQuantity('')
    setEditingBatchId(null)
    setEditingScopeKey(null)
    setEditBatchRows([])
  }, [currentScopeKey])

  const scopedCandidates = candidateScopeKey === currentScopeKey ? candidates : []
  const scopedAllocationItemId = allocationScopeKey === currentScopeKey ? allocationItemId : null
  const scopedEditingBatchId = currentScopeKey && editingScopeKey === currentScopeKey ? editingBatchId : null
  const selectedRow = skus.find((item) => item.sku === selectedSku) ?? null
  const selectedRowReady = Boolean(selectedRow)
  useEffect(() => {
    if (!currentScopeKey || !selectedRow) return
    setFactorDraftState({ scopeKey: currentScopeKey, sku: selectedSku, value: String(selectedRow.growth_factor ?? 1) })
  }, [currentScopeKey, selectedRow, selectedSku])

  const factorDraft = selectedRow && currentScopeKey && factorDraftState?.scopeKey === currentScopeKey && factorDraftState.sku === selectedSku
    ? factorDraftState.value
    : String(selectedRow?.growth_factor ?? 1)
  const cancellingBatchId = currentScopeKey
    ? cancellingBatchByScope[currentScopeKey] ?? null
    : null
  const forecast = currentScopeKey && forecastResult?.scopeKey === currentScopeKey && forecastResult.sku === selectedSku
    ? forecastResult.data
    : null
  const forecastRequestMatches = Boolean(
    currentScopeKey && forecastRequest?.scopeKey === currentScopeKey && forecastRequest.sku === selectedSku
  )
  const forecastLoading = Boolean(
    scopeReady && selectedRow && (!forecastRequestMatches || forecastRequest?.loading)
  )
  const forecastError = forecastRequestMatches ? forecastRequest?.error ?? null : null

  useEffect(() => {
    if (!scopeReady || !currentScopeKey || !selectedSku || !selectedRowReady || skuLoading) return
    const requestScopeKey = currentScopeKey
    const requestSku = selectedSku
    const requestId = ++forecastRequestIdRef.current
    const controller = new AbortController()
    const isCurrent = () =>
      !controller.signal.aborted &&
      requestId === forecastRequestIdRef.current &&
      currentScopeKeyRef.current === requestScopeKey &&
      selectedSkuRef.current === requestSku
    setForecastRequest({ scopeKey: requestScopeKey, sku: requestSku, loading: true, error: null })
    const asOfDate = getSiteDates(country).asOfDate
    requestJson<ForecastResponse>(`/forecast?${scopeQuery}&as_of_date=${asOfDate}&sku=${encodeURIComponent(requestSku)}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!isCurrent()) return
        setForecastResult({ scopeKey: requestScopeKey, sku: requestSku, data: result })
        setForecastRequest({ scopeKey: requestScopeKey, sku: requestSku, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return
        const message = error instanceof Error ? error.message : '请稍后重试'
        setForecastRequest({ scopeKey: requestScopeKey, sku: requestSku, loading: false, error: message })
        notify({ type: 'error', title: 'SKU 预测加载失败', message })
      })
    return () => controller.abort()
  }, [country, currentScopeKey, forecastRetryKey, notify, scopeQuery, scopeReady, selectedRowReady, selectedSku, skuLoading])

  const validSkuCount = skuSummary?.valid_forecast_sku_count ?? skus.filter((item) => qualityKey(item.data_quality) === 'ready').length
  const missingSkuCount = skuSummary?.missing_forecast_sku_count ?? Math.max(0, skus.length - validSkuCount)
  const selectedPlanItems = useMemo(
    () => batches.flatMap((batch) => batch.items.map((item) => ({ ...item, batch }))),
    [batches]
  )
  const activePlanQuantity = selectedPlanItems
    .filter(({ batch, sku }) => batch.status === 'active' && sku === selectedSku)
    .reduce((sum, item) => sum + item.remaining_quantity, 0)

  const reloadRef = useRef(reload)
  reloadRef.current = reload
  const refreshPage = useCallback(async (expectedScopeKey?: string) => {
    const targetScopeKey = expectedScopeKey ?? currentScopeKeyRef.current
    if (!targetScopeKey || targetScopeKey !== currentScopeKeyRef.current) return
    await reloadRef.current()
  }, [])

  useHeaderRefresh(refreshPage, {
    loading: skuLoading || historyLoading || planLoading || forecastLoading,
  })

  const saveGrowthFactor = async () => {
    const mutationScopeKey = currentScopeKey
    const mutationSku = selectedSku
    const mutationProjectId = projectId
    const mutationCountry = country
    const factor = Number(factorDraft)
    if (!scopeReady || !mutationScopeKey || mutationScopeKey !== currentScopeKeyRef.current || !selectedRow || !mutationSku || !Number.isFinite(factor) || factor < 0) {
      notify({ type: 'error', title: '倍率无效', message: '请输入大于或等于 0 的数字。' })
      return
    }
    const operationId = Symbol()
    setSavingFactorByScope((current) => ({ ...current, [mutationScopeKey]: operationId }))
    try {
      await requestJson(`/skus/${encodeURIComponent(mutationSku)}/growth-factor`, {
        method: 'PUT',
        body: JSON.stringify({ project_id: Number(mutationProjectId), country: mutationCountry, growth_factor: factor }),
      })
      if (currentScopeKeyRef.current !== mutationScopeKey) return
      notify({ type: 'success', title: '增长系数已保存', message: `${mutationSku} × ${factorDraft}` })
      const forecastRequestIdBeforeRefresh = forecastRequestIdRef.current
      await refreshPage(mutationScopeKey)
      if (
        currentScopeKeyRef.current !== mutationScopeKey ||
        selectedSkuRef.current !== mutationSku
      ) return
      // The refreshed SKU request normally retriggers this effect through skuLoading.
      // Fall back to the existing effect trigger if no current-SKU request started.
      if (forecastRequestIdRef.current === forecastRequestIdBeforeRefresh) {
        setForecastRetryKey((current) => current + 1)
      }
    } catch (error) {
      if (currentScopeKeyRef.current === mutationScopeKey) {
        notify({ type: 'error', title: '保存失败', message: error instanceof Error ? error.message : '请重试' })
      }
    } finally {
      setSavingFactorByScope((current) => {
        if (current[mutationScopeKey] !== operationId) return current
        const next = { ...current }
        delete next[mutationScopeKey]
        return next
      })
    }
  }

  const createPlanBatch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const mutationScopeKey = currentScopeKey
    const mutationProjectId = projectId
    const mutationCountry = country
    const mutationDraft: BatchDraft = {
      scopeKey: batchDraft.scopeKey,
      name: batchDraft.name,
      arrival: batchDraft.arrival,
      rows: batchDraft.rows.map((row) => ({ ...row })),
    }
    const mutationBatchName = mutationDraft.name
    const mutationBatchArrival = mutationDraft.arrival
    const normalizedItems = mutationDraft.rows.map((row) => ({ sku: row.sku.trim(), quantity: Number(row.quantity) }))
    const uniqueSkus = new Set(normalizedItems.map((item) => item.sku))
    const validItems = normalizedItems.every((item) =>
      item.sku && skus.some((sku) => sku.sku === item.sku) && Number.isInteger(item.quantity) && item.quantity > 0
    )
    if (!scopeReady || !mutationScopeKey || mutationScopeKey !== currentScopeKeyRef.current || !mutationBatchName.trim() || !mutationBatchArrival || !validItems || uniqueSkus.size !== normalizedItems.length) {
      notify({ type: 'error', title: '计划信息不完整', message: '请填写批次、预计到仓日期，以及一个或多个不重复 SKU 的正整数数量。' })
      return
    }
    const operationId = Symbol()
    setCreatingBatchByScope((current) => ({ ...current, [mutationScopeKey]: operationId }))
    try {
      await requestJson('/batches', {
        method: 'POST',
        body: JSON.stringify({
          project_id: Number(mutationProjectId), country: mutationCountry, name: mutationBatchName.trim(),
          expected_arrival_date: mutationBatchArrival,
          items: normalizedItems,
        }),
      })
      if (mutationScopeKey) {
        setBatchDraftState((current) => {
          if (!current || current.scopeKey !== mutationScopeKey || !sameBatchDraft(current, mutationDraft)) return current
          return emptyBatchDraft(mutationScopeKey)
        })
      }
      if (currentScopeKeyRef.current !== mutationScopeKey) return
      notify({ type: 'success', title: '预期计划已创建', message: `已加入 ${normalizedItems.length} 个 SKU` })
      await refreshPage(mutationScopeKey)
    } catch (error) {
      if (currentScopeKeyRef.current === mutationScopeKey) {
        notify({ type: 'error', title: '计划创建失败', message: error instanceof Error ? error.message : '请重试' })
      }
    } finally {
      setCreatingBatchByScope((current) => {
        if (current[mutationScopeKey] !== operationId) return current
        const next = { ...current }
        delete next[mutationScopeKey]
        return next
      })
    }
  }

  const beginBatchEdit = (batch: PlanBatch) => {
    if (!currentScopeKey || currentScopeKey !== currentScopeKeyRef.current) return
    setEditingBatchId(batch.id)
    setEditingScopeKey(currentScopeKey)
    setEditBatchName(batch.name)
    setEditBatchArrival(batch.expected_arrival_date)
    setEditBatchRows(batch.items.map((item) => ({
      id: item.id, sku: item.sku, quantity: String(item.quantity), allocated: item.allocated_quantity,
    })))
  }

  const saveBatchEdit = async (batch: PlanBatch) => {
    const mutationScopeKey = currentScopeKey
    const mutationScopeQuery = scopeQuery
    const items = editBatchRows.map((row) => ({ sku: row.sku, quantity: Number(row.quantity) }))
    const uniqueSkus = new Set(items.map((item) => item.sku))
    if (!scopeReady || !mutationScopeKey || mutationScopeKey !== currentScopeKeyRef.current || editingScopeKey !== mutationScopeKey || !editBatchName.trim() || !editBatchArrival || !items.length || uniqueSkus.size !== items.length ||
      editBatchRows.some((row) => !row.sku || !skus.some((sku) => sku.sku === row.sku) || !Number.isInteger(Number(row.quantity)) || Number(row.quantity) <= 0 || Number(row.quantity) < row.allocated)) {
      notify({ type: 'error', title: '计划信息无效', message: 'SKU 不可重复；数量必须为正整数且不能小于已关联量。' })
      return
    }
    const operationId = Symbol()
    setSavingBatchEditByScope((current) => ({ ...current, [mutationScopeKey]: operationId }))
    try {
      await requestJson(`/batches/${batch.id}?${mutationScopeQuery}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editBatchName.trim(), expected_arrival_date: editBatchArrival, items }),
      })
      if (currentScopeKeyRef.current !== mutationScopeKey) return
      setEditingBatchId(null)
      setEditingScopeKey(null)
      notify({ type: 'success', title: '计划批次已更新', message: `${batch.name} 的计划明细已保存。` })
      await refreshPage(mutationScopeKey)
    } catch (error) {
      if (currentScopeKeyRef.current === mutationScopeKey) {
        notify({ type: 'error', title: '计划更新失败', message: error instanceof Error ? error.message : '请重试' })
      }
    } finally {
      setSavingBatchEditByScope((current) => {
        if (current[mutationScopeKey] !== operationId) return current
        const next = { ...current }
        delete next[mutationScopeKey]
        return next
      })
    }
  }

  const cancelBatch = async (batch: PlanBatch) => {
    const mutationScopeKey = currentScopeKey
    const mutationScopeQuery = scopeQuery
    if (!scopeReady || !mutationScopeKey || mutationScopeKey !== currentScopeKeyRef.current || batch.status !== 'active') return
    const remaining = batch.items.reduce((sum, item) => sum + item.remaining_quantity, 0)
    if (!window.confirm(`取消「${batch.name}」？未关联的 ${remaining} 件将退出计划情景；已关联货件不受影响。`) || currentScopeKeyRef.current !== mutationScopeKey) return
    if (cancellingBatchByScope[mutationScopeKey] !== undefined) return
    setCancellingBatchByScope((current) => ({ ...current, [mutationScopeKey]: batch.id }))
    try {
      await requestJson(`/batches/${batch.id}/cancel?${mutationScopeQuery}`, { method: 'POST', body: '{}' })
      if (currentScopeKeyRef.current !== mutationScopeKey) return
      notify({ type: 'success', title: '计划批次已取消', message: '记录已保留，已关联的正式货件仍按货件状态统计。' })
      await refreshPage(mutationScopeKey)
    } catch (error) {
      if (currentScopeKeyRef.current === mutationScopeKey) {
        notify({ type: 'error', title: '取消失败', message: error instanceof Error ? error.message : '请重试' })
      }
    } finally {
      setCancellingBatchByScope((current) => {
        if (current[mutationScopeKey] !== batch.id) return current
        const next = { ...current }
        delete next[mutationScopeKey]
        return next
      })
    }
  }

  const startAllocation = async (item: PlanItem) => {
    const requestScopeKey = currentScopeKey
    const requestProjectId = projectId
    const requestCountry = country
    if (!scopeReady || !requestScopeKey || requestScopeKey !== currentScopeKeyRef.current) return
    const requestId = ++candidatesRequestIdRef.current
    setAllocationItemId(item.id)
    setAllocationScopeKey(requestScopeKey)
    setAllocationQuantity(String(item.remaining_quantity))
    setAllocationScheduleId('')
    setCandidateScopeKey(requestScopeKey)
    setCandidates([])
    setCandidatesLoading(true)
    setCandidateError(null)
    setCandidatesTruncated(false)
    try {
      const schedulesByStatus = await Promise.all(
        (['draft', 'in_transit'] as const).map(async (shipmentStatus) => {
          const schedules: ShipmentScheduleListResponse['items'] = []
          let page = 1
          let hasNext = true
          while (hasNext && schedules.length < MAX_SCHEDULE_CANDIDATES_PER_STATUS) {
            const response = await requestJson<ShipmentScheduleListResponse>(
              `${BACKEND_API_BASE}/shipment-schedules?${queryString({ project_id: requestProjectId, country: requestCountry, shipment_status: shipmentStatus, page, page_size: MAX_SCHEDULE_CANDIDATES_PER_STATUS, include_total: 'false' })}`
            )
            schedules.push(...response.items.slice(0, MAX_SCHEDULE_CANDIDATES_PER_STATUS - schedules.length))
            hasNext = response.has_next
            page += 1
          }
          return { schedules, wasTruncated: hasNext }
        })
      )
      const schedules = schedulesByStatus.flatMap((result) => result.schedules)
      const details = await Promise.all(
        schedules.map((schedule) => requestJson<ShipmentScheduleDetail>(`${BACKEND_API_BASE}/shipment-schedules/${schedule.id}`))
      )
      if (requestId !== candidatesRequestIdRef.current || currentScopeKeyRef.current !== requestScopeKey) return
      const existingAllocations = batches.flatMap((batch) => batch.items.flatMap((planItem) => planItem.allocations))
      const available = details.flatMap((detail) => {
        if (detail.shipment_status !== 'draft' && detail.shipment_status !== 'in_transit') return []
        const skuQuantity = detail.items.find((shipmentItem) => shipmentItem.sku === item.sku)?.quantity
        if (skuQuantity == null) return []
        if (existingAllocations.some((allocation) => allocation.plan_item_id === item.id && allocation.shipment_schedule_id === detail.id)) return []
        const alreadyAllocated = existingAllocations
          .filter((allocation) => allocation.shipment_schedule_id === detail.id && allocation.sku === item.sku)
          .reduce((sum, allocation) => sum + allocation.quantity, 0)
        const availableQuantity = Math.max(0, skuQuantity - alreadyAllocated)
        if (!availableQuantity) return []
        return [{
          id: detail.id,
          shipment_no: detail.shipment_no,
          shipment_status: detail.shipment_status as 'draft' | 'in_transit',
          etd_date: detail.etd_date ?? null,
          eta_date: detail.eta_date ?? null,
          available_quantity: availableQuantity,
        }]
      })
      setCandidates(available)
      const wasTruncated = schedulesByStatus.some((result) => result.wasTruncated)
      setCandidatesTruncated(wasTruncated)
      if (wasTruncated) {
        notify({ type: 'error', title: '候选货件已截断', message: '为控制请求量，每种货件状态最多检查 25 件；若未找到目标货件，请联系管理员缩小筛选范围后重试。' })
      }
    } catch (error) {
      if (requestId === candidatesRequestIdRef.current && currentScopeKeyRef.current === requestScopeKey) {
        setCandidates([])
        setCandidateError(error instanceof Error ? error.message : '请重试')
        notify({ type: 'error', title: '正式货件读取失败', message: error instanceof Error ? error.message : '请重试' })
      }
    } finally {
      if (requestId === candidatesRequestIdRef.current && currentScopeKeyRef.current === requestScopeKey) setCandidatesLoading(false)
    }
  }

  const submitAllocation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const mutationScopeKey = currentScopeKey
    const mutationScopeQuery = scopeQuery
    const mutationAllocationItemId = scopedAllocationItemId
    const mutationCandidates = scopedCandidates
    if (!scopeReady || !mutationScopeKey || mutationScopeKey !== currentScopeKeyRef.current || allocationScopeKey !== mutationScopeKey) return
    const quantity = Number(allocationQuantity)
    const selectedCandidate = mutationCandidates.find((candidate) => candidate.id === Number(allocationScheduleId))
    const selectedPlanItem = batches.flatMap((batch) => batch.items).find((item) => item.id === mutationAllocationItemId)
    if (!selectedPlanItem || !selectedCandidate || !Number.isInteger(quantity) || quantity <= 0 ||
      quantity > selectedPlanItem.remaining_quantity || quantity > selectedCandidate.available_quantity) {
      notify({ type: 'error', title: '关联信息不完整', message: '请选择正式货件，并输入不超过计划余额和货件可分配量的正整数。' })
      return
    }
    if (allocationSubmitInFlightByScopeRef.current.has(mutationScopeKey)) return
    allocationSubmitInFlightByScopeRef.current.add(mutationScopeKey)
    const operationId = Symbol()
    setSavingAllocationByScope((current) => ({ ...current, [mutationScopeKey]: operationId }))
    try {
      const batchId = batches.find((batch) => batch.items.some((item) => item.id === mutationAllocationItemId))?.id
      if (!batchId) throw new Error('找不到该计划所属批次，请刷新后重试。')
      await requestJson(`/batches/${batchId}/allocations?${mutationScopeQuery}`, {
        method: 'POST',
        body: JSON.stringify({ plan_item_id: mutationAllocationItemId, shipment_schedule_id: Number(allocationScheduleId), quantity }),
      })
      if (currentScopeKeyRef.current !== mutationScopeKey) return
      notify({ type: 'success', title: '数量关联已保存', message: '正式货件将按自身状态接替计划供给。' })
      setAllocationItemId(null)
      setAllocationScopeKey(null)
      await refreshPage(mutationScopeKey)
    } catch (error) {
      if (currentScopeKeyRef.current === mutationScopeKey) {
        notify({ type: 'error', title: '关联失败', message: error instanceof Error ? error.message : '请检查计划余额与货件可分配量。' })
      }
    } finally {
      allocationSubmitInFlightByScopeRef.current.delete(mutationScopeKey)
      setSavingAllocationByScope((current) => {
        if (current[mutationScopeKey] !== operationId) return current
        const next = { ...current }
        delete next[mutationScopeKey]
        return next
      })
    }
  }

  const removeAllocation = async (allocationId: number) => {
    const mutationScopeKey = currentScopeKey
    const mutationScopeQuery = scopeQuery
    if (!scopeReady || !mutationScopeKey || mutationScopeKey !== currentScopeKeyRef.current) return
    try {
      await requestJson(`/allocations/${allocationId}?${mutationScopeQuery}`, { method: 'DELETE' })
      if (currentScopeKeyRef.current !== mutationScopeKey) return
      notify({ type: 'success', title: '关联已解除', message: '有效计划的剩余数量已恢复。' })
      await refreshPage(mutationScopeKey)
    } catch (error) {
      if (currentScopeKeyRef.current === mutationScopeKey) {
        notify({ type: 'error', title: '解除失败', message: error instanceof Error ? error.message : '请重试' })
      }
    }
  }

  const selectedProjectLabel = projectId === 'all'
    ? '全部项目（不支持）'
    : validProjects.find((project) => String(project.id) === projectId)?.name ??
      (projectId ? '项目不可用，请重新选择' : '未选择项目')
  const selectedCountryLabel = supportedCountry
    ? `${COUNTRY_LABELS[country as keyof typeof COUNTRY_LABELS]} (${country})`
    : country === 'ALL'
      ? '全部站点（不支持）'
      : '未选择受支持站点'
  const renderScopeControls = (suffix: string) => (
    <>
      <WarmSelect
        id={`shipping-plan-project-${suffix}`}
        label="项目"
        value={projectId === 'all' || selectedProjectExists ? projectId : ''}
        onChange={setProjectId}
        options={projectOptions}
        placeholder={projectsLoading ? '加载项目…' : projectLoadError ? '项目列表加载失败' : projectId ? '当前项目不可用，请重新选择' : '选择项目'}
        disabled={projectsLoading || Boolean(projectLoadError) || validProjects.length === 0}
        error={projectLoadError}
        className={`${styles.filterSelect} ${styles.projectSelect}`}
      />
      <WarmSelect
        id={`shipping-plan-site-${suffix}`}
        label="站点"
        value={supportedCountry ? country : ''}
        onChange={setCountry}
        options={siteOptions}
        placeholder={country === 'ALL' ? '全部站点不受支持' : '选择 US、DE 或 UK'}
        className={`${styles.filterSelect} ${styles.siteSelect}`}
      />
      {projectLoadError ? (
        <WarmButton
          className={styles.projectRetry}
          variant="quiet"
          loading={projectsLoading}
          loadingLabel="正在重试项目列表"
          onClick={() => void refetchProjects()}
        >
          重试项目列表
        </WarmButton>
      ) : null}
    </>
  )
  const primaryFilterSlot = usePrimaryFilterSlot(
    <div className={styles.scopeFilters} role="group" aria-label="项目和站点筛选" aria-busy={projectsLoading || undefined}>
      {renderScopeControls('primary')}
    </div>
  )
  const mobileFilterStrip = useMobileFilterStrip(
    <MobileFilterStrip
      className={styles.mobileFilterStrip}
      summary={`${selectedProjectLabel} · ${selectedCountryLabel}`}
      controls={
        <MobileFilterWide className={styles.mobileScopeWide}>
          <div className={styles.mobileScopeFilters} role="group" aria-label="项目和站点筛选">
            {renderScopeControls('mobile')}
          </div>
        </MobileFilterWide>
      }
    />
  )

  if (!globalFilter.ready) {
    return (
      <main className={styles.page} data-testid="shipping-plan-page">
        {primaryFilterSlot}
        {mobileFilterStrip}
        <PageHeading />
        <div className={styles.loadingState} role="status" aria-busy="true">正在读取项目和站点筛选</div>
      </main>
    )
  }
  if (projectsLoading) {
    return (
      <main className={styles.page} data-testid="shipping-plan-page">
        {primaryFilterSlot}
        {mobileFilterStrip}
        <PageHeading />
        <div className={styles.loadingState} role="status" aria-busy="true">正在读取可用项目；项目列表就绪后才能加载发货规划。</div>
      </main>
    )
  }
  if (projectLoadError) {
    return (
      <main className={styles.page} data-testid="shipping-plan-page">
        {primaryFilterSlot}
        {mobileFilterStrip}
        <PageHeading />
        <div className={styles.scopeError} role="alert">
          <AlertTriangle aria-hidden="true" className={styles.stateIcon} />
          <h2 className={styles.stateTitle}>项目列表暂不可用</h2>
          <p className={styles.stateCopy}>{projectLoadError}</p>
          <WarmButton variant="secondary" loading={projectsLoading} loadingLabel="正在重试项目列表" onClick={() => void refetchProjects()}>
            重试项目列表
          </WarmButton>
        </div>
      </main>
    )
  }
  if (!validProjects.length) {
    return (
      <main className={styles.page} data-testid="shipping-plan-page">
        {primaryFilterSlot}
        {mobileFilterStrip}
        <PageHeading />
        <div className={styles.scopeError} role="status">
          <AlertTriangle aria-hidden="true" className={styles.stateIcon} />
          <h2 className={styles.stateTitle}>当前账号没有可用项目</h2>
          <p className={styles.stateCopy}>确认项目访问权限后，可重新读取项目列表。</p>
          <WarmButton variant="secondary" onClick={() => void refetchProjects()}>重新读取项目列表</WarmButton>
        </div>
      </main>
    )
  }
  if (!scopeReady) {
    const scopeCopy = !projectId
      ? '请选择项目和 US、DE 或 UK 站点后查看发货规划。'
      : projectId === 'all'
        ? '发货规划需要单一项目，请从项目列表中选择一个项目。'
        : !selectedProjectExists
          ? '当前项目不在可访问项目列表中，请重新选择项目。'
          : '发货规划需要 US、DE 或 UK 单一站点；全部站点不受支持。'
    return (
      <main className={styles.page} data-testid="shipping-plan-page">
        {primaryFilterSlot}
        {mobileFilterStrip}
        <PageHeading />
        <div className={styles.scopeError} role="alert">
          <AlertTriangle aria-hidden="true" className={styles.stateIcon} />
          <h2 className={styles.stateTitle}>需要选择单一项目和站点</h2>
          <p className={styles.stateCopy}>{scopeCopy}</p>
        </div>
      </main>
    )
  }

  const hasSkuResult = Boolean(currentScopeKey && skuResult?.scopeKey === currentScopeKey)
  const stats = [
    { label: 'SKU', value: hasSkuResult ? skus.length : skuLoading ? '…' : '—' },
    { label: '可计算', value: hasSkuResult ? validSkuCount : skuLoading ? '…' : '—' },
    { label: '数据待核实', value: hasSkuResult ? missingSkuCount : skuLoading ? '…' : '—' },
    { label: 'ETD 缺失货件', value: history ? `${history.missing_etd_shipment_count} 件` : historyLoading ? '…' : '—' },
  ]

  return (
    <main className={styles.page} data-testid="shipping-plan-page">
      {primaryFilterSlot}
      {mobileFilterStrip}
      <PageHeading />

      <dl aria-label="发货规划概览" className={styles.summaryGrid}>
        {stats.map((stat) => <StatLine key={stat.label} {...stat} />)}
      </dl>

      <section className={styles.focusGrid} aria-label="所选 SKU 预测">
        <SkuForecastTable
          rows={skus}
          selectedSku={selectedSku}
          loading={skuLoading}
          error={skuError}
          onRetry={() => void loadSkuData()}
          onSelect={setSelectedSku}
        />

        <section className={`${styles.panel} ${styles.forecastPanel}`} aria-labelledby="shipping-plan-forecast-title">
          <div className={styles.panelHeader}>
            <div className={styles.forecastHeading}>
              <h2 id="shipping-plan-forecast-title" className={styles.sectionTitle}>180 天销量与库存预测</h2>
            </div>
            <WarmSelect
              id="shipping-plan-forecast-sku"
              label="预测 SKU"
              value={selectedSku}
              onChange={setSelectedSku}
              options={skus.map((item) => ({ value: item.sku, label: item.sku }))}
              placeholder={skus.length ? '选择 SKU' : '暂无 SKU'}
              disabled={!hasSkuResult || skus.length === 0}
              className={`${styles.filterSelect} ${styles.forecastSelect}`}
            />
          </div>

          {selectedRow ? (
            <div className={styles.selectedSkuDetails}>
              <div className={styles.selectedIdentity}>
                <div className={styles.selectedProduct}>
                  <span className={styles.selectedProductName}>{selectedRow.product_name || selectedRow.asin || '未维护商品信息'}</span>
                  {selectedRow.asin && selectedRow.product_name ? <span className={styles.selectedAsin}>{selectedRow.asin}</span> : null}
                </div>
                <WarmBadge tone={selectedRow.data_quality?.length ? 'negative' : 'positive'}>
                  {selectedRow.data_quality?.length ? '数据待核实' : '可计算'}
                </WarmBadge>
              </div>
              <dl className={styles.parameterGrid}>
                <Metric label="可售库存" value={formatNumber(selectedRow.available_inventory, 0)} />
                <Metric label="快照日期" value={formatDate(selectedRow.inventory_snapshot_date)} />
                <Metric label="基础 DMS" value={formatNumber(selectedRow.base_dms, 3)} />
                <Metric label="在途 / 草稿" value={`${formatNumber(selectedRow.in_transit_quantity, 0)} / ${formatNumber(selectedRow.draft_quantity, 0)}`} />
                <Metric label="有效计划余额" value={formatNumber(selectedRow.active_plan_remaining_quantity, 0)} />
                <Metric label="确定情景上限" value={formatNumber(selectedRow.confirmed_180d_sales_upper_bound, 0)} />
                <Metric label="计划情景上限" value={formatNumber(selectedRow.planned_180d_sales_upper_bound, 0)} />
              </dl>
              <form className={styles.growthFactorForm} onSubmit={(event) => { event.preventDefault(); void saveGrowthFactor() }}>
                <div className={styles.growthFactorField}>
                  <label htmlFor="growth-factor" className={styles.fieldLabel}>SKU 增长系数</label>
                  <Input
                    id="growth-factor"
                    type="number"
                    min="0"
                    step="0.0001"
                    value={factorDraft}
                    onChange={(event) => {
                      if (currentScopeKey) {
                        setFactorDraftState({ scopeKey: currentScopeKey, sku: selectedSku, value: event.target.value })
                      }
                    }}
                    className={styles.input}
                    aria-label="SKU 增长系数"
                  />
                </div>
                <WarmButton type="submit" variant="secondary" disabled={savingFactor} loading={savingFactor} loadingLabel="正在保存增长系数">
                  保存增长系数
                </WarmButton>
                <span className={styles.demandSource}>来源：{selectedRow.demand_source === 'manual' ? '手工设置' : '系统缺省 1.0'}</span>
              </form>
              {selectedRow.data_quality?.length ? (
                <ul className={styles.qualityReasons} aria-label="SKU 数据质量说明">
                  {selectedRow.data_quality.map((reason) => <li key={reason}>{qualityReasonLabel(reason)}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}

          {forecastLoading ? (
            <div className={styles.forecastStatus} role="status" aria-busy="true">正在计算所选 SKU 的预测</div>
          ) : null}
          {!forecastLoading && forecastError ? (
            <div className={styles.forecastError} role="alert">
              <div><strong>SKU 预测加载失败</strong><p>{forecastError}</p></div>
              <WarmButton variant="secondary" onClick={() => setForecastRetryKey((current) => current + 1)}>重试预测</WarmButton>
            </div>
          ) : null}
          {!forecastLoading && !forecastError && forecast && forecast.daily_points.length > 0 ? (
            <ForecastChart forecast={forecast} />
          ) : null}
          {!forecastLoading && !forecastError && forecast && forecast.daily_points.length === 0 ? (
            <div className={styles.emptyState} role="status">所选 SKU 在当前预测区间没有可展示的数据。</div>
          ) : null}
          {!forecastLoading && !forecastError && !forecast && skus.length > 0 ? (
            <div className={styles.emptyState} role="status">
              {selectedSku ? '正在准备 SKU 预测…' : '选择一个 SKU 查看预测。'}
            </div>
          ) : null}
        </section>
      </section>

      <section className={`${styles.panel} ${styles.arrivalPanel}`} aria-labelledby="shipping-plan-arrival-title">
        <div className={styles.panelHeader}>
          <h2 id="shipping-plan-arrival-title" className={styles.sectionTitle}>预期到货计划</h2>
          {activePlanQuantity > 0 ? (
            <p className={styles.activePlanQuantity}>当前 SKU 有效计划余额 <strong>{formatNumber(activePlanQuantity, 0)} 件</strong></p>
          ) : null}
        </div>
        <form onSubmit={(event) => void createPlanBatch(event)} className={styles.createPlanForm}>
          <div className={styles.batchFields}>
            <Input aria-label="计划批次名称" placeholder="批次名称" value={batchDraft.name} onChange={(event) => updateBatchDraft((draft) => ({ ...draft, name: event.target.value }))} disabled={!hasSkuResult || skuLoading} className={styles.input} />
            <Input aria-label="预计到仓日期" type="date" value={batchDraft.arrival} onChange={(event) => updateBatchDraft((draft) => ({ ...draft, arrival: event.target.value }))} disabled={!hasSkuResult || skuLoading} className={`${styles.input} ${styles.dateInput}`} />
          </div>
          <div className={styles.batchRows}>
            {batchDraft.rows.map((row, index) => (
              <div key={`batch-item-${index}`} className={styles.batchItemRow}>
                <WarmSelect
                  id={`shipping-plan-create-sku-${index}`}
                  label={`计划 SKU ${index + 1}`}
                  value={row.sku}
                  onChange={(sku) => updateBatchDraft((draft) => ({
                    ...draft,
                    rows: draft.rows.map((item, itemIndex) => itemIndex === index ? { ...item, sku } : item),
                  }))}
                  options={skus.map((sku) => ({ value: sku.sku, label: sku.sku }))}
                  placeholder="选择 SKU"
                  disabled={!hasSkuResult || skuLoading || skus.length === 0}
                  className={`${styles.filterSelect} ${styles.planSkuSelect}`}
                />
                <Input aria-label={`计划数量 ${index + 1}`} type="number" min="1" step="1" placeholder="数量" value={row.quantity} onChange={(event) => updateBatchDraft((draft) => ({
                  ...draft,
                  rows: draft.rows.map((item, itemIndex) => itemIndex === index ? { ...item, quantity: event.target.value } : item),
                }))} disabled={!hasSkuResult || skuLoading} className={`${styles.input} ${styles.quantityInput}`} />
                <WarmButton type="button" variant="quiet" aria-label={`移除 SKU ${index + 1}`} disabled={!hasSkuResult || skuLoading || batchDraft.rows.length === 1} onClick={() => updateBatchDraft((draft) => ({
                  ...draft,
                  rows: draft.rows.filter((_, itemIndex) => itemIndex !== index),
                }))}>移除</WarmButton>
              </div>
            ))}
          </div>
          <div className={styles.formActions}>
            <WarmButton type="button" variant="secondary" disabled={!hasSkuResult || skuLoading || !skus.length} onClick={() => updateBatchDraft((draft) => ({
              ...draft,
              rows: [...draft.rows, { sku: '', quantity: '' }],
            }))}>
              <Plus aria-hidden="true" className={styles.actionIcon} />添加 SKU
            </WarmButton>
            <WarmButton type="submit" variant="primary" disabled={creatingBatch || !hasSkuResult || skuLoading || !skus.length} loading={creatingBatch} loadingLabel="正在创建计划批次">
              创建多 SKU 计划
            </WarmButton>
          </div>
        </form>
        {forecast?.arrivals.some((arrival) => arrival.data_quality) ? (
          <section className={styles.arrivalQuality} aria-label="需要关注的到货">
            <div className={styles.arrivalQualityHeader}>
              <AlertTriangle aria-hidden="true" className={styles.arrivalQualityIcon} />
              <h3 className={styles.arrivalQualityTitle}>需要关注的到货</h3>
            </div>
            <ul className={styles.arrivalQualityList}>
              {forecast.arrivals.filter((arrival) => arrival.data_quality).map((arrival, index) => (
                <li key={`${arrival.source_type}-${arrival.sku}-${arrival.reference ?? index}`} className={styles.arrivalQualityItem}>
                  <span className={styles.arrivalReference}>{arrival.reference || arrival.source_type}</span>
                  <span>
                    {arrival.arrival_date ? `日期 ${formatDate(arrival.arrival_date)}` : '日期未知'}，数据状态 {arrival.data_quality}
                  </span>
                  <strong>{formatNumber(arrival.quantity, 0)} 件</strong>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <PlanBatchList
          batches={batches}
          selectedSku={selectedSku}
          allocationItemId={scopedAllocationItemId}
          allocationScheduleId={allocationScheduleId}
          allocationQuantity={allocationQuantity}
          candidates={scopedCandidates}
          candidatesLoading={candidateScopeKey === currentScopeKey && candidatesLoading}
          candidateError={candidateScopeKey === currentScopeKey ? candidateError : null}
          candidatesTruncated={candidateScopeKey === currentScopeKey && candidatesTruncated}
          planLoading={planLoading}
          planError={planError}
          onRetryPlan={() => void loadPlanData()}
          savingAllocation={savingAllocation}
          cancellingBatchId={cancellingBatchId}
          editingBatchId={scopedEditingBatchId}
          editBatchName={editBatchName}
          editBatchArrival={editBatchArrival}
          editBatchRows={editBatchRows}
          skus={skus}
          savingBatchEdit={savingBatchEdit}
          onEditBatch={beginBatchEdit}
          onEditBatchNameChange={setEditBatchName}
          onEditBatchArrivalChange={setEditBatchArrival}
          onEditBatchRowChange={(index, patch) => setEditBatchRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row))}
          onAddEditBatchRow={() => setEditBatchRows((current) => [...current, { id: `new-${current.length}`, sku: '', quantity: '', allocated: 0 }])}
          onRemoveEditBatchRow={(index) => setEditBatchRows((current) => current.filter((_, rowIndex) => rowIndex !== index))}
          onSaveBatchEdit={(batch) => void saveBatchEdit(batch)}
          onCancelBatchEdit={() => {
            setEditingBatchId(null)
            setEditingScopeKey(null)
          }}
          onCancel={(batch) => void cancelBatch(batch)}
          onStartAllocation={(item) => void startAllocation(item)}
          onAllocationScheduleChange={setAllocationScheduleId}
          onAllocationQuantityChange={setAllocationQuantity}
          onSubmitAllocation={(event) => void submitAllocation(event)}
          onDismissAllocation={() => {
            candidatesRequestIdRef.current += 1
            setAllocationItemId(null)
            setAllocationScopeKey(null)
            setCandidateScopeKey(null)
            setCandidatesLoading(false)
          }}
          onRemoveAllocation={(id) => void removeAllocation(id)}
        />
      </section>

      {historyLoading ? (
        <div className={styles.forecastStatus} role="status" aria-busy="true">
          {history ? '正在更新历史发运数据，暂时显示本项目和站点上次成功读取的结果。' : '正在读取历史发运数据'}
        </div>
      ) : null}
      {historyError ? (
        <div className={styles.planError} role="alert">
          <span>
            历史发运数据更新失败：{historyError}
            {history ? ' 当前仍显示本项目和站点上次成功读取的结果。' : ''}
          </span>
          <WarmButton variant="secondary" onClick={() => void loadHistoryData()}>重试历史发运</WarmButton>
        </div>
      ) : null}
      {history ? <ShipmentHistoryChart history={history} /> : null}
    </main>
  )
}

function PageHeading() {
  return (
    <header className={styles.pageHeading}>
      <h1 className={styles.pageTitle}>发货规划</h1>
    </header>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.parameter}>
      <dt className={styles.parameterLabel}>{label}</dt>
      <dd className={styles.parameterValue}>{value}</dd>
    </div>
  )
}

function PlanBatchList({
  batches, skus, selectedSku, allocationItemId, allocationScheduleId, allocationQuantity, candidates,
  candidatesLoading, candidateError, candidatesTruncated, planLoading, planError,
  onRetryPlan,
  savingAllocation, cancellingBatchId, editingBatchId, editBatchName, editBatchArrival, editBatchRows,
  savingBatchEdit, onEditBatch, onEditBatchNameChange, onEditBatchArrivalChange, onEditBatchRowChange,
  onAddEditBatchRow, onRemoveEditBatchRow, onSaveBatchEdit, onCancelBatchEdit, onCancel, onStartAllocation, onAllocationScheduleChange,
  onAllocationQuantityChange, onSubmitAllocation, onDismissAllocation, onRemoveAllocation,
}: {
  batches: PlanBatch[]
  selectedSku: string
  allocationItemId: number | null
  allocationScheduleId: string
  allocationQuantity: string
  candidates: ShipmentCandidate[]
  candidatesLoading: boolean
  candidateError: string | null
  candidatesTruncated: boolean
  planLoading: boolean
  planError: string | null
  onRetryPlan: () => void
  savingAllocation: boolean
  cancellingBatchId: number | null
  editingBatchId: number | null
  editBatchName: string
  editBatchArrival: string
  editBatchRows: EditablePlanItem[]
  skus: ShippingPlanSku[]
  savingBatchEdit: boolean
  onEditBatch: (batch: PlanBatch) => void
  onEditBatchNameChange: (value: string) => void
  onEditBatchArrivalChange: (value: string) => void
  onEditBatchRowChange: (index: number, patch: { sku?: string; quantity?: string }) => void
  onAddEditBatchRow: () => void
  onRemoveEditBatchRow: (index: number) => void
  onSaveBatchEdit: (batch: PlanBatch) => void
  onCancelBatchEdit: () => void
  onCancel: (batch: PlanBatch) => void
  onStartAllocation: (item: PlanItem) => void
  onAllocationScheduleChange: (value: string) => void
  onAllocationQuantityChange: (value: string) => void
  onSubmitAllocation: (event: FormEvent<HTMLFormElement>) => void
  onDismissAllocation: () => void
  onRemoveAllocation: (id: number) => void
}) {
  if (planLoading && !batches.length) {
    return <div className={styles.planState} role="status" aria-busy="true">正在读取预期计划</div>
  }
  if (planError && !batches.length) {
    return (
      <div className={styles.planError} role="alert">
        <span>预期计划列表未能加载：{planError}</span>
        <WarmButton variant="secondary" onClick={onRetryPlan}>重试计划列表</WarmButton>
      </div>
    )
  }
  if (!batches.length) {
    return (
      <div className={styles.planEmpty} role="status">
        <strong>暂无预期计划</strong>
        <span>创建的计划会列在这里；尚未关联的有效计划量计入计划情景。</span>
      </div>
    )
  }

  return (
    <div className={styles.batchList}>
      {planLoading ? <p className={styles.inlineStatus} role="status" aria-busy="true">正在更新计划列表，暂时显示上次成功读取的结果。</p> : null}
      {planError ? (
        <div className={styles.planError} role="alert">
          <span>计划列表更新失败：{planError}。当前显示上次成功读取的结果。</span>
          <WarmButton variant="secondary" onClick={onRetryPlan}>重试计划列表</WarmButton>
        </div>
      ) : null}
      {batches.map((batch) => (
        <section key={batch.id} className={styles.batch} aria-label={`计划批次 ${batch.name}`}>
          <div className={styles.batchHeader}>
            <div className={styles.batchIdentity}>
              <h3 className={styles.batchName}>{batch.name}</h3>
              <p className={styles.batchMeta}>预计到仓 {formatDate(batch.expected_arrival_date)} · {batch.status === 'active' ? '有效' : '已取消'}</p>
              {batch.remark ? <p className={styles.batchRemark}>{batch.remark}</p> : null}
            </div>
            {batch.status === 'active' ? (
              <div className={styles.batchActions}>
                <WarmButton variant="quiet" onClick={() => onEditBatch(batch)} disabled={editingBatchId === batch.id}>编辑</WarmButton>
                <WarmButton variant="quiet" onClick={() => onCancel(batch)} disabled={cancellingBatchId !== null}>
                  {cancellingBatchId === batch.id ? '取消中…' : '取消计划'}
                </WarmButton>
              </div>
            ) : <WarmBadge tone="neutral">已取消 · 保留记录</WarmBadge>}
          </div>

          <div className={styles.batchItems}>
            {editingBatchId === batch.id ? (
              <div className={styles.batchEditForm}>
                <Input aria-label="编辑计划批次名称" value={editBatchName} onChange={(event) => onEditBatchNameChange(event.target.value)} className={styles.input} />
                <Input aria-label="编辑预计到仓日期" type="date" value={editBatchArrival} onChange={(event) => onEditBatchArrivalChange(event.target.value)} className={`${styles.input} ${styles.dateInput}`} />
                {editBatchRows.map((row, index) => (
                  <div key={row.id} className={styles.editBatchItem}>
                    {row.allocated > 0 ? (
                      <span className={styles.allocatedSku}>{row.sku}</span>
                    ) : (
                      <WarmSelect
                        id={`shipping-plan-edit-sku-${batch.id}-${index}`}
                        label={`编辑计划 SKU ${index + 1}`}
                        value={row.sku}
                        onChange={(sku) => onEditBatchRowChange(index, { sku })}
                        options={skus.map((sku) => ({ value: sku.sku, label: sku.sku }))}
                        placeholder="选择 SKU"
                        className={`${styles.filterSelect} ${styles.planSkuSelect}`}
                      />
                    )}
                    <div className={styles.editQuantityField}>
                      <Input aria-label={`编辑 ${row.sku || `SKU ${index + 1}`} 计划数量`} type="number" min={Math.max(1, row.allocated)} step="1" value={row.quantity} onChange={(event) => onEditBatchRowChange(index, { quantity: event.target.value })} className={styles.input} />
                      <span className={styles.allocatedNote}>已关联至少 {row.allocated}</span>
                    </div>
                    <WarmButton type="button" variant="quiet" aria-label={`移除编辑 SKU ${index + 1}`} disabled={row.allocated > 0} onClick={() => onRemoveEditBatchRow(index)}>移除</WarmButton>
                  </div>
                ))}
                <div className={styles.formActions}>
                  <WarmButton type="button" variant="secondary" disabled={savingBatchEdit || !skus.length} onClick={onAddEditBatchRow}>
                    <Plus aria-hidden="true" className={styles.actionIcon} />添加 SKU
                  </WarmButton>
                  <WarmButton type="button" variant="primary" disabled={savingBatchEdit} loading={savingBatchEdit} loadingLabel="正在保存计划修改" onClick={() => onSaveBatchEdit(batch)}>
                    保存修改
                  </WarmButton>
                  <WarmButton type="button" variant="quiet" onClick={onCancelBatchEdit}>取消编辑</WarmButton>
                </div>
              </div>
            ) : batch.items.map((item) => (
              <div key={item.id} className={`${styles.planItem} ${selectedSku === item.sku ? styles.planItemSelected : ''}`}>
                <div className={styles.planItemHeader}>
                  <span className={styles.planItemSku}>{item.sku}</span>
                  <span className={styles.planItemAmounts}>
                    计划 {formatNumber(item.quantity, 0)} · 已关联 {formatNumber(item.allocated_quantity, 0)} · 余额 {formatNumber(item.remaining_quantity, 0)}
                  </span>
                </div>
                {item.allocations.map((allocation) => (
                  <div key={allocation.id} className={styles.allocationRow}>
                    <span>接替货件 <strong>#{allocation.shipment_schedule_id}</strong> · {allocation.quantity} 件</span>
                    <WarmButton variant="quiet" aria-label={`解除货件 #${allocation.shipment_schedule_id} 关联`} onClick={() => onRemoveAllocation(allocation.id)}>
                      <X aria-hidden="true" className={styles.actionIcon} />解除
                    </WarmButton>
                  </div>
                ))}
                {batch.status === 'active' && item.remaining_quantity > 0 ? (
                  <WarmButton variant="secondary" className={styles.allocateButton} onClick={() => onStartAllocation(item)}>关联正式货件</WarmButton>
                ) : null}
                {allocationItemId === item.id ? (
                  <form onSubmit={onSubmitAllocation} className={styles.allocationForm}>
                    {candidatesLoading ? <p className={styles.inlineStatus} role="status" aria-busy="true">正在读取草稿和在途正式货件</p> : null}
                    {candidateError ? <p className={styles.inlineError} role="alert">正式货件读取失败：{candidateError}</p> : null}
                    {!candidatesLoading && !candidateError && !candidatesTruncated && candidates.length === 0 ? (
                      <p className={styles.inlineStatus} role="status">未找到可关联的草稿或在途正式货件。</p>
                    ) : null}
                    {!candidatesLoading && !candidateError && candidatesTruncated && candidates.length === 0 ? (
                      <p className={styles.inlineStatus} role="status">已检查的候选中未找到可关联货件，后续货件尚未检查。</p>
                    ) : null}
                    {candidatesTruncated ? (
                      <p className={styles.truncatedNotice} role="status">每种货件状态最多检查 25 件；候选列表可能不完整。未找到目标货件时，请联系管理员缩小筛选范围后重试。</p>
                    ) : null}
                    <div className={styles.allocationFields}>
                      <WarmSelect
                        id={`shipping-plan-allocation-candidate-${item.id}`}
                        label="正式货件"
                        value={allocationScheduleId}
                        onChange={onAllocationScheduleChange}
                        options={candidates
                          .filter((candidate) => candidate.available_quantity > 0 && ['draft', 'in_transit'].includes(candidate.shipment_status))
                          .map((candidate) => ({
                            value: String(candidate.id),
                            label: `${candidate.shipment_no} · ${candidate.shipment_status === 'draft' ? '草稿' : '在途'} · ETD ${candidate.etd_date ? formatDate(candidate.etd_date) : '未知'} · ETA ${candidate.eta_date ? formatDate(candidate.eta_date) : '未知'} · 可关联 ${candidate.available_quantity}`,
                          }))}
                        placeholder="选择草稿或在途货件"
                        disabled={candidatesLoading || Boolean(candidateError) || candidates.length === 0}
                        className={`${styles.filterSelect} ${styles.candidateSelect}`}
                      />
                      <Input aria-label="关联数量" type="number" min="1" max={Math.min(item.remaining_quantity, candidates.find((candidate) => candidate.id === Number(allocationScheduleId))?.available_quantity ?? item.remaining_quantity)} step="1" value={allocationQuantity} onChange={(event) => onAllocationQuantityChange(event.target.value)} className={`${styles.input} ${styles.quantityInput}`} />
                      <WarmButton type="submit" variant="primary" disabled={savingAllocation || candidatesLoading || !allocationScheduleId || Number(allocationQuantity) > (candidates.find((candidate) => candidate.id === Number(allocationScheduleId))?.available_quantity ?? 0)} loading={savingAllocation} loadingLabel="正在关联正式货件">
                        确认关联
                      </WarmButton>
                      <WarmButton type="button" variant="quiet" onClick={onDismissAllocation}>取消</WarmButton>
                    </div>
                  </form>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
