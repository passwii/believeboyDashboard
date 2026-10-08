'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, CalendarDays, LoaderCircle, Plus, RefreshCw, X } from 'lucide-react'
import { useTerminalGlobalFilter } from '@/components/terminal/global-filter-context'
import { useNotifications } from '@/components/notifications'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DataTableCard, DataTableCardBody, DataTableCardHeader } from '@/components/ui/data-card'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import { HeaderCountrySelect, HeaderProjectSelect } from '@/components/terminal/header-filter-suite'
import { useHeaderSlot, useMobileFilterStrip } from '@/components/terminal/terminal-header-slot'
import { MobileFilterStrip } from '@/components/terminal/mobile-filter-strip'
import { EmptyState } from '@/components/ui/empty-state'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ForecastChart } from './components/forecast-chart'
import { SkuForecastTable } from './components/sku-forecast-table'

const API_BASE = '/api/backend/api/v1/shipping-plan'
const DAY_MS = 24 * 60 * 60 * 1000

type Quality = 'ready' | 'missing_inventory' | 'missing_sales' | 'inventory_stale' | 'inventory_pending'

type ShippingPlanSku = {
  project_id: number
  country: string
  sku: string
  asin: string | null
  product_name: string | null
  available_inventory: number | null
  inventory_snapshot_date: string | null
  base_dms: number | null
  growth_factor: number
  demand_source: 'manual' | 'default'
  in_transit_quantity: number
  draft_quantity: number
  planned_remaining_quantity: number
  confirmed_sales_cap: number | null
  planned_sales_cap: number | null
  data_quality: Quality
  data_quality_reasons: string[]
}

type ForecastPoint = {
  forecast_date: string
  demand: number | null
  confirmed_sales: number | null
  planned_sales: number | null
  confirmed_closing_inventory: number | null
  planned_closing_inventory: number | null
  historical_order_sales: number | null
  interval_start?: string
  interval_end?: string
}

type ArrivalWarning = {
  kind: string
  sku: string
  shipment_no?: string | null
  quantity: number
  message: string
}

type ForecastResponse = {
  project_id: number
  country: string
  sku: string
  as_of_date: string
  forecast_start_date: string
  forecast_end_date: string
  inventory_snapshot_date: string | null
  base_dms: number | null
  growth_factor: number
  demand_source: 'manual' | 'default'
  data_quality: Quality
  data_quality_reasons: string[]
  daily_points: ForecastPoint[]
  confirmed_sales_cap: number | null
  planned_sales_cap: number | null
  arrivals: ArrivalWarning[]
}

type ShipmentMonth = { month: string; shipment_count: number; total_quantity: number }
type ShipmentHistory = {
  months: ShipmentMonth[]
  missing_etd_count: number
  missing_etd_quantity: number
  included_statuses: string[]
}

type PlanAllocation = { id: number; shipment_schedule_id: number; shipment_no: string; quantity: number }
type PlanItem = {
  id: number
  sku: string
  quantity: number
  allocated_quantity: number
  remaining_quantity: number
  allocations: PlanAllocation[]
}
type PlanBatch = {
  id: number
  name: string
  expected_arrival_date: string
  status: 'active' | 'cancelled'
  remark: string | null
  items: PlanItem[]
}

type PlanBatchesResponse = { items: PlanBatch[] }
type ShipmentCandidate = {
  id: number
  shipment_no: string
  shipment_status: 'draft' | 'in_transit' | 'completed'
  etd_date: string | null
  eta_date: string | null
  sku_quantity: number
  available_quantity: number
}

type ApiErrorPayload = { detail?: string }

function formatNumber(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(value)
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

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!response.ok) {
    let message = `请求失败（HTTP ${response.status}）`
    try {
      const payload = (await response.json()) as ApiErrorPayload
      message = payload.detail || message
    } catch {
      // Keep the status-based message when the proxy did not return JSON.
    }
    throw new Error(message)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

function qualityLabel(quality: Quality): string {
  const labels: Record<Quality, string> = {
    ready: '可计算',
    missing_inventory: '缺少库存快照',
    missing_sales: '缺少销量基线',
    inventory_stale: '库存快照待更新',
    inventory_pending: '库存状态待核实',
  }
  return labels[quality] ?? '数据待核实'
}

function qualityTone(quality: Quality): string {
  if (quality === 'ready') return 'border-term-pos/40 text-term-pos'
  return 'border-term-warn/50 text-term-warn'
}

function getHistoryWindow(): { from: string; to: string } {
  const today = new Date()
  const from = new Date(today.getTime() - 365 * DAY_MS)
  const iso = (date: Date) => date.toISOString().slice(0, 10)
  return { from: iso(from), to: iso(today) }
}

function StatLine({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="min-w-0 border-r border-term-border px-4 py-3 last:border-r-0">
      <div className="font-mono text-[11px] uppercase tracking-wide text-term-muted">{label}</div>
      <div className="mt-1 truncate font-mono text-lg tabular-nums text-term-text">{value}</div>
      {note ? <div className="mt-1 truncate text-xs text-term-muted">{note}</div> : null}
    </div>
  )
}

export default function ShippingPlanClient() {
  const globalFilter = useTerminalGlobalFilter()
  const { notify } = useNotifications()
  const projectId = globalFilter.projectId
  const country = globalFilter.country
  const scopeReady = globalFilter.ready && Boolean(projectId) && projectId !== 'all' && country !== 'ALL'

  const [skus, setSkus] = useState<ShippingPlanSku[]>([])
  const [forecast, setForecast] = useState<ForecastResponse | null>(null)
  const [history, setHistory] = useState<ShipmentHistory | null>(null)
  const [batches, setBatches] = useState<PlanBatch[]>([])
  const [selectedSku, setSelectedSku] = useState('')
  const [loading, setLoading] = useState(false)
  const [forecastLoading, setForecastLoading] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const scopeRequestIdRef = useRef(0)
  const [factorDraft, setFactorDraft] = useState('1')
  const [savingFactor, setSavingFactor] = useState(false)
  const [batchName, setBatchName] = useState('')
  const [batchArrival, setBatchArrival] = useState('')
  const [batchRows, setBatchRows] = useState<Array<{ sku: string; quantity: string }>>([
    { sku: '', quantity: '' },
  ])
  const [creatingBatch, setCreatingBatch] = useState(false)
  const [editingBatchId, setEditingBatchId] = useState<number | null>(null)
  const [editBatchName, setEditBatchName] = useState('')
  const [editBatchArrival, setEditBatchArrival] = useState('')
  const [editBatchRows, setEditBatchRows] = useState<Array<{ id: number; sku: string; quantity: string; allocated: number }>>([])
  const [savingBatchEdit, setSavingBatchEdit] = useState(false)
  const [cancellingBatchId, setCancellingBatchId] = useState<number | null>(null)
  const [candidates, setCandidates] = useState<ShipmentCandidate[]>([])
  const candidatesRequestIdRef = useRef(0)
  const [allocationItemId, setAllocationItemId] = useState<number | null>(null)
  const [allocationScheduleId, setAllocationScheduleId] = useState('')
  const [allocationQuantity, setAllocationQuantity] = useState('')
  const [savingAllocation, setSavingAllocation] = useState(false)

  const scopeQuery = useMemo(() => queryString({ project_id: projectId, country }), [country, projectId])

  const reload = useCallback(async () => {
    const requestId = ++scopeRequestIdRef.current
    if (!scopeReady) {
      setSkus([])
      setForecast(null)
      setHistory(null)
      setBatches([])
      setSelectedSku('')
      return
    }
    setLoading(true)
    setPageError(null)
    try {
      const window = getHistoryWindow()
      const [skuResponse, historyResponse, batchResponse] = await Promise.all([
        requestJson<{ items: ShippingPlanSku[] }>(`/skus?${scopeQuery}&page=1&page_size=500`),
        requestJson<ShipmentHistory>(`/shipment-history?${scopeQuery}&from=${window.from}&to=${window.to}`),
        requestJson<PlanBatchesResponse>(`/batches?${scopeQuery}`),
      ])
      if (requestId !== scopeRequestIdRef.current) return
      setSkus(skuResponse.items ?? [])
      setHistory(historyResponse)
      setBatches(batchResponse.items ?? [])
      setSelectedSku((current) =>
        skuResponse.items?.some((item) => item.sku === current) ? current : (skuResponse.items?.[0]?.sku ?? '')
      )
    } catch (error) {
      if (requestId === scopeRequestIdRef.current) {
        setPageError(error instanceof Error ? error.message : '发货规划数据加载失败')
      }
    } finally {
      if (requestId === scopeRequestIdRef.current) setLoading(false)
    }
  }, [scopeQuery, scopeReady])

  useEffect(() => {
    void reload()
    return () => { scopeRequestIdRef.current += 1 }
  }, [reload])

  useEffect(() => {
    if (!scopeReady || !selectedSku) {
      setForecast(null)
      return
    }
    const controller = new AbortController()
    setForecastLoading(true)
    requestJson<ForecastResponse>(`/forecast?${scopeQuery}&sku=${encodeURIComponent(selectedSku)}`, {
      signal: controller.signal,
    })
      .then(setForecast)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setForecast(null)
        notify({
          type: 'error',
          title: 'SKU 预测加载失败',
          message: error instanceof Error ? error.message : '请稍后重试',
        })
      })
      .finally(() => {
        if (!controller.signal.aborted) setForecastLoading(false)
      })
    return () => controller.abort()
  }, [notify, scopeQuery, scopeReady, selectedSku])

  useEffect(() => {
    const current = skus.find((item) => item.sku === selectedSku)
    if (current) setFactorDraft(String(current.growth_factor ?? 1))
  }, [selectedSku, skus])

  useEffect(() => {
    if (!scopeReady) return
    const controller = new AbortController()
    requestJson<{ items: ShipmentCandidate[] }>(`/batches/allocations/candidates?${scopeQuery}`, { signal: controller.signal })
      .then((response) => { if (!controller.signal.aborted) setCandidates(response.items ?? []) })
      .catch(() => { if (!controller.signal.aborted) setCandidates([]) })
    return () => controller.abort()
  }, [scopeQuery, scopeReady])

  const selectedRow = skus.find((item) => item.sku === selectedSku) ?? null
  const validSkuCount = skus.filter((item) => item.data_quality === 'ready').length
  const missingSkuCount = skus.length - validSkuCount
  const selectedPlanItems = useMemo(
    () => batches.flatMap((batch) => batch.items.map((item) => ({ ...item, batch }))),
    [batches]
  )
  const activePlanQuantity = selectedPlanItems
    .filter(({ batch, sku }) => batch.status === 'active' && sku === selectedSku)
    .reduce((sum, item) => sum + item.remaining_quantity, 0)

  const saveGrowthFactor = async () => {
    const factor = Number(factorDraft)
    if (!selectedSku || !Number.isFinite(factor) || factor < 0) {
      notify({ type: 'error', title: '倍率无效', message: '请输入大于或等于 0 的数字。' })
      return
    }
    setSavingFactor(true)
    try {
      await requestJson(`/skus/${encodeURIComponent(selectedSku)}/growth-factor?${scopeQuery}`, {
        method: 'PUT',
        body: JSON.stringify({ growth_factor: factor }),
      })
      notify({ type: 'success', title: '增长系数已保存', message: `${selectedSku} × ${factorDraft}` })
      await reload()
    } catch (error) {
      notify({ type: 'error', title: '保存失败', message: error instanceof Error ? error.message : '请重试' })
    } finally {
      setSavingFactor(false)
    }
  }

  const createPlanBatch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedItems = batchRows.map((row) => ({ sku: row.sku.trim(), quantity: Number(row.quantity) }))
    const uniqueSkus = new Set(normalizedItems.map((item) => item.sku))
    const validItems = normalizedItems.every((item) =>
      item.sku && skus.some((sku) => sku.sku === item.sku) && Number.isInteger(item.quantity) && item.quantity > 0
    )
    if (!batchName.trim() || !batchArrival || !validItems || uniqueSkus.size !== normalizedItems.length) {
      notify({ type: 'error', title: '计划信息不完整', message: '请填写批次、预计到仓日期，以及一个或多个不重复 SKU 的正整数数量。' })
      return
    }
    setCreatingBatch(true)
    try {
      await requestJson('/batches', {
        method: 'POST',
        body: JSON.stringify({
          project_id: Number(projectId), country, name: batchName.trim(),
          expected_arrival_date: batchArrival,
          items: normalizedItems,
        }),
      })
      setBatchName('')
      setBatchRows([{ sku: '', quantity: '' }])
      notify({ type: 'success', title: '预期计划已创建', message: `已加入 ${normalizedItems.length} 个 SKU` })
      await reload()
    } catch (error) {
      notify({ type: 'error', title: '计划创建失败', message: error instanceof Error ? error.message : '请重试' })
    } finally {
      setCreatingBatch(false)
    }
  }

  const beginBatchEdit = (batch: PlanBatch) => {
    setEditingBatchId(batch.id)
    setEditBatchName(batch.name)
    setEditBatchArrival(batch.expected_arrival_date)
    setEditBatchRows(batch.items.map((item) => ({
      id: item.id, sku: item.sku, quantity: String(item.quantity), allocated: item.allocated_quantity,
    })))
  }

  const saveBatchEdit = async (batch: PlanBatch) => {
    const items = editBatchRows.map((row) => ({ sku: row.sku, quantity: Number(row.quantity) }))
    const uniqueSkus = new Set(items.map((item) => item.sku))
    if (!editBatchName.trim() || !editBatchArrival || !items.length || uniqueSkus.size !== items.length ||
      editBatchRows.some((row) => !Number.isInteger(Number(row.quantity)) || Number(row.quantity) < row.allocated)) {
      notify({ type: 'error', title: '计划信息无效', message: 'SKU 不可重复；数量必须为整数且不能小于已关联量。' })
      return
    }
    setSavingBatchEdit(true)
    try {
      await requestJson(`/batches/${batch.id}?${scopeQuery}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editBatchName.trim(), expected_arrival_date: editBatchArrival, items }),
      })
      setEditingBatchId(null)
      notify({ type: 'success', title: '计划批次已更新', message: `${batch.name} 的计划明细已保存。` })
      await reload()
    } catch (error) {
      notify({ type: 'error', title: '计划更新失败', message: error instanceof Error ? error.message : '请重试' })
    } finally {
      setSavingBatchEdit(false)
    }
  }

  const cancelBatch = async (batch: PlanBatch) => {
    if (batch.status !== 'active') return
    const remaining = batch.items.reduce((sum, item) => sum + item.remaining_quantity, 0)
    if (!window.confirm(`取消「${batch.name}」？未关联的 ${remaining} 件将退出计划情景；已关联货件不受影响。`)) return
    setCancellingBatchId(batch.id)
    try {
      await requestJson(`/batches/${batch.id}/cancel?${scopeQuery}`, { method: 'POST', body: '{}' })
      notify({ type: 'success', title: '计划批次已取消', message: '记录已保留，已关联的正式货件仍按货件状态统计。' })
      await reload()
    } catch (error) {
      notify({ type: 'error', title: '取消失败', message: error instanceof Error ? error.message : '请重试' })
    } finally {
      setCancellingBatchId(null)
    }
  }

  const startAllocation = async (item: PlanItem) => {
    const requestId = ++candidatesRequestIdRef.current
    setAllocationItemId(item.id)
    setAllocationQuantity(String(item.remaining_quantity))
    setAllocationScheduleId('')
    try {
      const response = await requestJson<{ items: ShipmentCandidate[] }>(
        `/batches/allocations/candidates?${scopeQuery}&sku=${encodeURIComponent(item.sku)}`
      )
      if (requestId === candidatesRequestIdRef.current) setCandidates(response.items ?? [])
    } catch (error) {
      if (requestId === candidatesRequestIdRef.current) {
        notify({ type: 'error', title: '正式货件读取失败', message: error instanceof Error ? error.message : '请重试' })
      }
    }
  }

  const submitAllocation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const quantity = Number(allocationQuantity)
    if (!allocationItemId || !allocationScheduleId || !Number.isInteger(quantity) || quantity <= 0) {
      notify({ type: 'error', title: '关联信息不完整', message: '请选择正式货件并输入正整数数量。' })
      return
    }
    setSavingAllocation(true)
    try {
      await requestJson(`/batches/${batches.find((batch) => batch.items.some((item) => item.id === allocationItemId))?.id}/allocations?${scopeQuery}`, {
        method: 'POST',
        body: JSON.stringify({ plan_item_id: allocationItemId, shipment_schedule_id: Number(allocationScheduleId), quantity }),
      })
      notify({ type: 'success', title: '数量关联已保存', message: '正式货件将按自身状态接替计划供给。' })
      setAllocationItemId(null)
      await reload()
    } catch (error) {
      notify({ type: 'error', title: '关联失败', message: error instanceof Error ? error.message : '请检查计划余额与货件可分配量。' })
    } finally {
      setSavingAllocation(false)
    }
  }

  const removeAllocation = async (allocationId: number) => {
    try {
      await requestJson(`/allocations/${allocationId}?${scopeQuery}`, { method: 'DELETE' })
      notify({ type: 'success', title: '关联已解除', message: '有效计划的剩余数量已恢复。' })
      await reload()
    } catch (error) {
      notify({ type: 'error', title: '解除失败', message: error instanceof Error ? error.message : '请重试' })
    }
  }

  const onRefresh = () => void reload()
  const fallbackScopeControls = (
    <div className="flex items-center gap-1.5 xl:hidden">
      <HeaderProjectSelect value={projectId} onChange={globalFilter.setProjectId} />
      <HeaderCountrySelect value={country} onChange={globalFilter.setCountry} />
    </div>
  )
  const headerSlot = useHeaderSlot(
    <HeaderFilterControls isMobileView={false} controls={fallbackScopeControls} />
  )
  const mobileFilterStrip = useMobileFilterStrip(
    <MobileFilterStrip
      summary={`项目 ${projectId || '未选择'} · ${country === 'ALL' ? '全部站点' : country}`}
      controls={
        <>
          <HeaderProjectSelect value={projectId} onChange={globalFilter.setProjectId} />
          <HeaderCountrySelect value={country} onChange={globalFilter.setCountry} />
        </>
      }
    />
  )

  if (!globalFilter.ready) {
    return <div className="p-6 font-mono text-sm text-term-muted" role="status">正在读取全局筛选条件…</div>
  }
  if (!scopeReady) {
    return (
      <main className="space-y-5 p-4 md:p-6" data-testid="shipping-plan-page">
        {headerSlot}
        {mobileFilterStrip}
        <PageHeading />
        <div className="flex min-h-44 flex-col items-center justify-center border border-term-border bg-term-panel px-6 text-center">
          <AlertTriangle className="mb-3 h-5 w-5 text-term-warn" aria-hidden />
          <h2 className="font-mono text-sm font-semibold text-term-text">请先选择项目和单一站点</h2>
          <p className="mt-2 max-w-lg text-sm leading-6 text-term-muted">发货规划不会合并不同站点下的同名 SKU。请在顶部筛选器中选择一个项目和具体站点，不能使用“全部项目”或“全部站点”。</p>
        </div>
      </main>
    )
  }

  const stats = [
    { label: 'SKU', value: loading ? '…' : skus.length },
    { label: '可计算', value: loading ? '…' : validSkuCount },
    { label: '数据待核实', value: loading ? '…' : missingSkuCount },
    { label: 'ETD 缺失货件', value: history ? `${history.missing_etd_count} 件` : '—' },
  ]

  return (
    <main className="min-w-0 space-y-5 p-4 md:p-6" data-testid="shipping-plan-page">
      {headerSlot}
      {mobileFilterStrip}
      <PageHeading onRefresh={onRefresh} loading={loading} />

      {pageError ? (
        <div role="alert" className="flex items-start justify-between gap-4 border border-term-neg/40 bg-term-panel px-4 py-3 text-sm text-term-text">
          <div><strong className="font-mono">数据加载失败</strong><p className="mt-1 text-term-muted">{pageError}</p></div>
          <Button variant="outline" size="sm" onClick={onRefresh}>重试</Button>
        </div>
      ) : null}

      <section aria-label="发货规划概览" className="grid grid-cols-2 border border-term-border bg-term-panel md:grid-cols-4">
        {stats.map((stat) => <StatLine key={stat.label} {...stat} />)}
      </section>

      {history ? <ShipmentHistoryStrip history={history} /> : null}

      <SkuForecastTable rows={skus} selectedSku={selectedSku} loading={loading} onSelect={setSelectedSku} />

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(300px,0.8fr)]">
        <DataTableCard className="min-w-0">
          <DataTableCardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><h2 className="font-mono text-sm font-semibold text-term-text">180 天 SKU 销售上限</h2><p className="mt-1 text-xs leading-5 text-term-muted">需求采用基础加权日均销量 × SKU 增长系数；到货当天计入供给。</p></div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-term-muted">SKU</span>
                <Select value={selectedSku} onValueChange={setSelectedSku} disabled={skus.length === 0}>
                  <SelectTrigger className="h-9 w-[190px] rounded-none border-term-border bg-term-bg font-mono text-xs" aria-label="选择预测 SKU"><SelectValue placeholder="选择 SKU" /></SelectTrigger>
                  <SelectContent className="rounded-none border-term-border bg-term-panel">{skus.map((item) => <SelectItem key={item.sku} value={item.sku}>{item.sku}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
          </DataTableCardHeader>
          <DataTableCardBody className="p-3 md:p-4">
            {forecastLoading ? <div className="flex h-64 items-center justify-center gap-2 font-mono text-xs text-term-muted" role="status"><LoaderCircle className="h-4 w-4 animate-spin" />正在计算 SKU 预测…</div> : null}
            {!forecastLoading && forecast ? <ForecastChart forecast={forecast} /> : null}
            {!forecastLoading && !forecast && !pageError ? <EmptyState chartHeight="h-64" message={skus.length ? '请选择一个 SKU，查看逐日需求、供给情景和去年同期参照。' : '所选项目和站点暂无可用 SKU。'} /> : null}
          </DataTableCardBody>
        </DataTableCard>

        <DataTableCard>
          <DataTableCardHeader title="SKU 预测参数" description="库存与销量基线沿用补货分析；安全库存系数不参与销售上限计算。" />
          <DataTableCardBody className="space-y-4 p-4">
            {selectedRow ? (
              <>
                <div className="flex items-start justify-between gap-3 border-b border-term-border pb-3">
                  <div className="min-w-0"><div className="truncate font-mono text-base font-semibold text-term-text">{selectedRow.sku}</div><div className="mt-1 truncate text-xs text-term-muted">{selectedRow.product_name || selectedRow.asin || '未维护商品信息'}</div></div>
                  <Badge variant="outline" className={`shrink-0 rounded-none font-mono text-[10px] ${qualityTone(selectedRow.data_quality)}`}>{qualityLabel(selectedRow.data_quality)}</Badge>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
                  <Metric label="可售库存" value={formatNumber(selectedRow.available_inventory, 0)} />
                  <Metric label="快照日期" value={formatDate(selectedRow.inventory_snapshot_date)} />
                  <Metric label="基础 DMS" value={formatNumber(selectedRow.base_dms, 3)} />
                  <Metric label="在途数量" value={formatNumber(selectedRow.in_transit_quantity, 0)} />
                  <Metric label="草稿数量" value={formatNumber(selectedRow.draft_quantity, 0)} />
                  <Metric label="有效计划余额" value={formatNumber(selectedRow.planned_remaining_quantity, 0)} />
                  <Metric label="确定情景上限" value={formatNumber(selectedRow.confirmed_sales_cap, 0)} />
                  <Metric label="计划情景上限" value={formatNumber(selectedRow.planned_sales_cap, 0)} />
                </dl>
                <div className="border-t border-term-border pt-3">
                  <label htmlFor="growth-factor" className="mb-2 block font-mono text-xs text-term-muted">SKU 增长系数</label>
                  <div className="flex gap-2">
                    <Input id="growth-factor" type="number" min="0" step="0.0001" value={factorDraft} onChange={(event) => setFactorDraft(event.target.value)} className="h-9 rounded-none border-term-border bg-term-bg font-mono tabular-nums" aria-label="SKU 增长系数" />
                    <Button type="button" variant="outline" size="sm" disabled={savingFactor} onClick={() => void saveGrowthFactor()}>{savingFactor ? '保存中…' : '保存'}</Button>
                  </div>
                  <p className="mt-2 text-[11px] leading-5 text-term-muted">当前来源：{selectedRow.demand_source === 'manual' ? '手工设置' : '系统缺省 1.0'}</p>
                </div>
                {selectedRow.data_quality_reasons.length ? <ul className="space-y-1 border-t border-term-border pt-3 text-xs leading-5 text-term-warn">{selectedRow.data_quality_reasons.map((reason) => <li key={reason}>· {reason}</li>)}</ul> : null}
              </>
            ) : <p className="text-sm text-term-muted">加载 SKU 参数中…</p>}
          </DataTableCardBody>
        </DataTableCard>
      </div>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <DataTableCard>
          <DataTableCardHeader title="预期到货计划" description="仅维护未落实的计划；正式货件请到「货件管理」中创建和更新。" />
          <DataTableCardBody className="space-y-4 p-4">
            <form onSubmit={(event) => void createPlanBatch(event)} className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-2">
                <Input aria-label="计划批次名称" placeholder="批次名称" value={batchName} onChange={(event) => setBatchName(event.target.value)} className="h-9 rounded-none border-term-border bg-term-bg" />
                <Input aria-label="预计到仓日期" type="date" value={batchArrival} onChange={(event) => setBatchArrival(event.target.value)} className="h-9 rounded-none border-term-border bg-term-bg font-mono" />
              </div>
              <div className="space-y-2">
                {batchRows.map((row, index) => (
                  <div key={`batch-item-${index}`} className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_120px_auto]">
                    <select aria-label={`计划 SKU ${index + 1}`} value={row.sku} onChange={(event) => setBatchRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, sku: event.target.value } : item))} className="h-9 min-w-0 rounded-none border border-term-border bg-term-bg px-2 font-mono text-xs text-term-text">
                      <option value="">选择 SKU</option>
                      {skus.map((sku) => <option key={sku.sku} value={sku.sku}>{sku.sku}</option>)}
                    </select>
                    <Input aria-label={`计划数量 ${index + 1}`} type="number" min="1" step="1" placeholder="数量" value={row.quantity} onChange={(event) => setBatchRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, quantity: event.target.value } : item))} className="h-9 rounded-none border-term-border bg-term-bg font-mono" />
                    <Button type="button" variant="ghost" size="sm" aria-label={`移除 SKU ${index + 1}`} disabled={batchRows.length === 1} onClick={() => setBatchRows((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="h-9 rounded-none text-term-muted">移除</Button>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" disabled={!skus.length} onClick={() => setBatchRows((current) => [...current, { sku: '', quantity: '' }])} className="rounded-none"><Plus className="mr-1 h-4 w-4" />添加 SKU</Button>
                <Button type="submit" size="sm" disabled={creatingBatch || !skus.length} className="rounded-none"><Plus className="mr-1 h-4 w-4" />{creatingBatch ? '创建中…' : '创建多 SKU 计划'}</Button>
              </div>
            </form>
            {activePlanQuantity > 0 ? <p className="font-mono text-xs text-term-muted">当前 SKU 有效计划余额：{formatNumber(activePlanQuantity, 0)} 件</p> : null}
            <PlanBatchList batches={batches} selectedSku={selectedSku} allocationItemId={allocationItemId} allocationScheduleId={allocationScheduleId} allocationQuantity={allocationQuantity} candidates={candidates} savingAllocation={savingAllocation} cancellingBatchId={cancellingBatchId} editingBatchId={editingBatchId} editBatchName={editBatchName} editBatchArrival={editBatchArrival} editBatchRows={editBatchRows} savingBatchEdit={savingBatchEdit} onEditBatch={beginBatchEdit} onEditBatchNameChange={setEditBatchName} onEditBatchArrivalChange={setEditBatchArrival} onEditBatchRowChange={(index, patch) => setEditBatchRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row))} onSaveBatchEdit={(batch) => void saveBatchEdit(batch)} onCancelBatchEdit={() => setEditingBatchId(null)} onCancel={(batch) => void cancelBatch(batch)} onStartAllocation={(item) => void startAllocation(item)} onAllocationScheduleChange={setAllocationScheduleId} onAllocationQuantityChange={setAllocationQuantity} onSubmitAllocation={(event) => void submitAllocation(event)} onDismissAllocation={() => setAllocationItemId(null)} onRemoveAllocation={(id) => void removeAllocation(id)} />
          </DataTableCardBody>
        </DataTableCard>

        <DataTableCard>
          <DataTableCardHeader title="数据边界" description="读数说明与质量提醒" />
          <DataTableCardBody className="space-y-3 p-4 text-xs leading-5 text-term-muted">
            <p><strong className="font-mono text-term-text">库存快照：</strong>预测使用最近的库存快照，不是实时库存。快照日期和缺失原因展示在 SKU 参数中。</p>
            <p><strong className="font-mono text-term-text">ETD 发运：</strong>历史发运日期采用货件 ETD 代理口径，仅统计在途和已完成货件；无 ETD 记录单独显示。</p>
            <p><strong className="font-mono text-term-text">同比销量：</strong>去年同期 `orderSales` 仅用于图表参考；覆盖不完整的日期留空，不按零销量绘制。</p>
            <p><strong className="font-mono text-term-text">到货假设：</strong>V1 假设货件到仓日当天可售；实际可售时间可能晚于到仓日期。</p>
            {forecast?.arrivals.length ? <div className="border-t border-term-border pt-3"><div className="mb-2 flex items-center gap-2 text-term-warn"><AlertTriangle className="h-4 w-4" />需要关注的到货</div><ul className="space-y-2">{forecast.arrivals.map((arrival, index) => <li key={`${arrival.kind}-${arrival.sku}-${arrival.shipment_no ?? index}`} className="border-b border-term-border pb-2 last:border-0">{arrival.message} <span className="font-mono">· {formatNumber(arrival.quantity, 0)} 件</span></li>)}</ul></div> : null}
          </DataTableCardBody>
        </DataTableCard>
      </div>
    </main>
  )
}

function PageHeading({ onRefresh, loading }: { onRefresh?: () => void; loading?: boolean }) {
  return (
    <header className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-term-border pb-4">
      <div><h1 className="font-mono text-xl font-semibold tracking-tight text-term-text">发货规划</h1><p className="mt-1 max-w-3xl text-sm leading-6 text-term-muted">把库存、正式货件与预期到货放进同一条 180 天时间轴，比较确定与计划两种供给情景。</p></div>
      {onRefresh ? <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={loading} aria-label="刷新发货规划"><RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />刷新</Button> : null}
    </header>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-term-muted">{label}</dt><dd className="mt-1 truncate font-mono tabular-nums text-term-text">{value}</dd></div>
}

function ShipmentHistoryStrip({ history }: { history: ShipmentHistory }) {
  return (
    <DataTableCard data-testid="shipment-history-strip">
      <DataTableCardHeader title="历史发运量" description="按 ETD 月份汇总；ETD 为计划发运日期代理，不代表实际离港。" />
      <DataTableCardBody>
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto px-4 py-3 term-scroll">
          <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-term-muted"><CalendarDays className="h-3.5 w-3.5" />最近 12 个月</span>
          {history.months.map((month) => <div key={month.month} className="min-w-24 border-l border-term-border pl-3"><div className="font-mono text-xs text-term-text">{month.month}</div><div className="mt-1 font-mono text-[11px] tabular-nums text-term-muted">{month.shipment_count} 件 · {formatNumber(month.total_quantity, 0)} 件数</div></div>)}
          <div className="min-w-28 border-l border-term-warn/50 pl-3 text-xs text-term-warn">缺 ETD：{history.missing_etd_count} 件 / {formatNumber(history.missing_etd_quantity, 0)} 件数</div>
        </div>
        <div className="border-t border-term-border px-4 py-2 text-[11px] text-term-muted">统计状态：{history.included_statuses.map((status) => status === 'in_transit' ? '在途' : status === 'completed' ? '已完成' : status).join('、')}。物流成本历史排除标记不影响本统计。</div>
      </DataTableCardBody>
    </DataTableCard>
  )
}

function PlanBatchList({
  batches, selectedSku, allocationItemId, allocationScheduleId, allocationQuantity, candidates,
  savingAllocation, cancellingBatchId, editingBatchId, editBatchName, editBatchArrival, editBatchRows,
  savingBatchEdit, onEditBatch, onEditBatchNameChange, onEditBatchArrivalChange, onEditBatchRowChange,
  onSaveBatchEdit, onCancelBatchEdit, onCancel, onStartAllocation, onAllocationScheduleChange,
  onAllocationQuantityChange, onSubmitAllocation, onDismissAllocation, onRemoveAllocation,
}: {
  batches: PlanBatch[]
  selectedSku: string
  allocationItemId: number | null
  allocationScheduleId: string
  allocationQuantity: string
  candidates: ShipmentCandidate[]
  savingAllocation: boolean
  cancellingBatchId: number | null
  editingBatchId: number | null
  editBatchName: string
  editBatchArrival: string
  editBatchRows: Array<{ id: number; sku: string; quantity: string; allocated: number }>
  savingBatchEdit: boolean
  onEditBatch: (batch: PlanBatch) => void
  onEditBatchNameChange: (value: string) => void
  onEditBatchArrivalChange: (value: string) => void
  onEditBatchRowChange: (index: number, patch: { quantity?: string }) => void
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
  if (!batches.length) return <EmptyState chartHeight="h-32" message="暂无预期计划。创建的计划批次会出现在这里；尚未关联的有效计划量计入计划情景。" />
  return (
    <div className="space-y-3">
      {batches.map((batch) => (
        <section key={batch.id} className="border-t border-term-border pt-3 first:border-0 first:pt-0" aria-label={`计划批次 ${batch.name}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0"><h3 className="truncate font-mono text-sm font-semibold text-term-text">{batch.name}</h3><p className="mt-1 text-xs text-term-muted">预计到仓 {formatDate(batch.expected_arrival_date)} · {batch.status === 'active' ? '有效' : '已取消'}</p>{batch.remark ? <p className="mt-1 text-xs text-term-muted">{batch.remark}</p> : null}</div>
            {batch.status === 'active' ? <div className="flex gap-1"><Button variant="ghost" size="sm" onClick={() => onEditBatch(batch)} disabled={editingBatchId === batch.id} className="h-8 rounded-none">编辑</Button><Button variant="ghost" size="sm" onClick={() => onCancel(batch)} disabled={cancellingBatchId === batch.id} className="h-8 rounded-none text-term-warn">{cancellingBatchId === batch.id ? '取消中…' : '取消计划'}</Button></div> : <Badge variant="outline" className="rounded-none font-mono text-[10px]">保留记录</Badge>}
          </div>
          <div className="mt-3 space-y-2">
            {editingBatchId === batch.id ? (
              <div className="space-y-2 border border-term-border bg-term-raised p-3">
                <Input aria-label="编辑计划批次名称" value={editBatchName} onChange={(event) => onEditBatchNameChange(event.target.value)} className="h-9 rounded-none border-term-border bg-term-bg" />
                <Input aria-label="编辑预计到仓日期" type="date" value={editBatchArrival} onChange={(event) => onEditBatchArrivalChange(event.target.value)} className="h-9 rounded-none border-term-border bg-term-bg font-mono" />
                {editBatchRows.map((row, index) => <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_110px] items-center gap-2"><span className="truncate font-mono text-xs text-term-text">{row.sku}</span><div><Input aria-label={`编辑 ${row.sku} 计划数量`} type="number" min={row.allocated} step="1" value={row.quantity} onChange={(event) => onEditBatchRowChange(index, { quantity: event.target.value })} className="h-8 rounded-none border-term-border bg-term-bg font-mono" /><span className="mt-1 block text-[10px] text-term-muted">已关联至少 {row.allocated}</span></div></div>)}
                <div className="flex gap-2"><Button type="button" size="sm" disabled={savingBatchEdit} onClick={() => onSaveBatchEdit(batch)} className="h-8 rounded-none">{savingBatchEdit ? '保存中…' : '保存修改'}</Button><Button type="button" variant="ghost" size="sm" onClick={onCancelBatchEdit} className="h-8 rounded-none">取消</Button></div>
              </div>
            ) : batch.items.map((item) => <div key={item.id} className={`border border-term-border px-3 py-2 ${selectedSku === item.sku ? 'bg-term-raised' : 'bg-term-panel'}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="font-mono font-semibold text-term-text">{item.sku}</span><span className="font-mono tabular-nums text-term-muted">计划 {formatNumber(item.quantity, 0)} · 已关联 {formatNumber(item.allocated_quantity, 0)} · 余额 {formatNumber(item.remaining_quantity, 0)}</span></div>
              {item.allocations.map((allocation) => <div key={allocation.id} className="mt-2 flex items-center justify-between gap-2 border-t border-term-border pt-2 text-[11px] text-term-muted"><span className="truncate">接替货件 <strong className="font-mono text-term-text">{allocation.shipment_no}</strong> · {allocation.quantity} 件</span><Button variant="ghost" size="sm" aria-label={`解除 ${allocation.shipment_no} 关联`} onClick={() => onRemoveAllocation(allocation.id)} className="h-7 rounded-none px-2 text-term-warn"><X className="h-3 w-3" />解除</Button></div>)}
              {batch.status === 'active' && item.remaining_quantity > 0 ? <Button variant="outline" size="sm" onClick={() => onStartAllocation(item)} className="mt-2 h-7 rounded-none text-[11px]">关联正式货件</Button> : null}
              {allocationItemId === item.id ? <form onSubmit={onSubmitAllocation} className="mt-3 grid gap-2 border-t border-term-border pt-3 sm:grid-cols-[minmax(0,1fr)_100px_auto_auto]">
                <Select value={allocationScheduleId} onValueChange={onAllocationScheduleChange}><SelectTrigger aria-label="选择正式货件" className="h-8 min-w-0 rounded-none border-term-border bg-term-bg font-mono text-[11px]"><SelectValue placeholder="选择草稿或在途货件" /></SelectTrigger><SelectContent className="rounded-none border-term-border bg-term-panel">{candidates.filter((candidate) => candidate.available_quantity > 0 && ['draft', 'in_transit'].includes(candidate.shipment_status)).map((candidate) => <SelectItem key={candidate.id} value={String(candidate.id)}>{candidate.shipment_no} · {candidate.shipment_status === 'draft' ? '草稿' : '在途'} · 可关联 {candidate.available_quantity}</SelectItem>)}</SelectContent></Select>
                <Input aria-label="关联数量" type="number" min="1" max={item.remaining_quantity} step="1" value={allocationQuantity} onChange={(event) => onAllocationQuantityChange(event.target.value)} className="h-8 rounded-none border-term-border bg-term-bg font-mono" />
                <Button type="submit" size="sm" disabled={savingAllocation} className="h-8 rounded-none">{savingAllocation ? '关联中…' : '确认'}</Button><Button type="button" variant="ghost" size="sm" onClick={onDismissAllocation} className="h-8 rounded-none">取消</Button>
              </form> : null}
            </div>)}
          </div>
        </section>
      ))}
    </div>
  )
}
