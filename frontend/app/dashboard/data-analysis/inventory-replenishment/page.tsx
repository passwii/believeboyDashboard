'use client'

import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { Boxes, CalendarClock, CircleAlert, FileDown, Loader2, PackageSearch, RefreshCw, Save, Send, ShipWheel } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { logClientOperation } from '@/lib/operation-audit'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { formatLocalTimestampForFilename } from '@/lib/utils'

const API_BASE = '/api/backend'

type ProjectOption = {
  id: number
  name: string
}

type Summary = {
  sku_count: number
  out_of_stock_risk_count: number
  healthy_count: number
  slow_moving_count: number
  pending_data_count: number
  total_available_inventory: number
  total_in_transit_quantity: number
}

type AnalysisRow = {
  project_id: number
  project_name: string
  sku: string
  country: string
  asin: string | null
  available_inventory: number
  in_transit_quantity: number
  dms_30: number | null
  dms_14: number | null
  dms_7: number | null
  dms_3: number | null
  base_dms: number | null
  safety_factor: number
  weighted_dms: number | null
  sellable_days: number | null
  sellout_date: string | null
  sellout_date_with_transit: string | null
  production_lead_days: number
  shipping_days: number
  replenishment_order_date: string | null
  warehouse_entry_date: string | null
  shipment_order_date: string | null
  estimated_replenishment_quantity: number | null
  risk_status: string
  risk_anchor_date: string | null
}

const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站' },
  { value: 'DE', label: '德国站' },
  { value: 'UK', label: '英国站' },
] as const

function rowKey(row: Pick<AnalysisRow, 'sku' | 'country'>): string {
  return `${row.sku}::${row.country}`
}

type AnalysisResponse = {
  items: AnalysisRow[]
  summary: Summary
  page: number
  page_size: number
  total: number
  has_next: boolean
}

type ShipmentItem = {
  schedule_id: number
  shipment_no: string
  shipment_status: string
  shipping_method: string
  etd_date: string | null
  eta_date: string | null
  actual_inbound_date: string | null
  tracking_no: string | null
  quantity: number
  remark: string | null
  updated_at: string
}

type ShipmentResponse = {
  project_id: number
  sku: string
  items: ShipmentItem[]
}

type RowEditState = {
  production_lead_days: string
  shipping_days: string
  safety_factor: string
}

const EMPTY_SUMMARY: Summary = {
  sku_count: 0,
  out_of_stock_risk_count: 0,
  healthy_count: 0,
  slow_moving_count: 0,
  pending_data_count: 0,
  total_available_inventory: 0,
  total_in_transit_quantity: 0,
}

function authHeaders(): Record<string, string> {
  return {}
}

async function parseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: string }
    return payload.detail || `请求失败 (${response.status})`
  } catch {
    const text = await response.text()
    return text || `请求失败 (${response.status})`
  }
}

function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '--'
  return value.toFixed(digits)
}

function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--'
  return value.toLocaleString('zh-CN')
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--'
  return `${(value * 100).toFixed(0)}%`
}

function formatDate(value: string | null | undefined): string {
  return value || '--'
}

const tableHeadClassName =
  'h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72'

const tableCellClassName =
  'whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80'

const stickyTableHeadClassName =
  'sticky top-0 z-[15] bg-[hsl(var(--surface-panel))/0.98] backdrop-blur-sm shadow-[inset_0_-1px_0_0_hsl(var(--border)/0.35)] dark:bg-[hsl(var(--surface-panel))/0.98] dark:shadow-[inset_0_-1px_0_0_hsl(var(--border)/0.65)]'

const stickySkuHeadClassName =
  'sticky left-0 top-0 z-[16] bg-[hsl(var(--surface-panel))/0.99] backdrop-blur-sm shadow-[inset_-1px_0_0_0_hsl(var(--border)/0.35)] dark:bg-[hsl(var(--surface-panel))/0.99] dark:shadow-[inset_-1px_0_0_0_hsl(var(--border)/0.7)]'

const stickySkuCellClassName =
  'sticky left-0 z-[1] bg-[hsl(var(--surface-panel))/0.99] shadow-[inset_-1px_0_0_0_hsl(var(--border)/0.2)] group-hover:bg-sky-50/90 dark:bg-[hsl(var(--surface-panel))/0.99] dark:shadow-[inset_-1px_0_0_0_hsl(var(--border)/0.65)] dark:group-hover:bg-sky-950/40'

const islandSectionClassName =
  'space-y-4 rounded-lg border border-border/70 bg-[hsl(var(--surface-overlay))/0.92] p-5 shadow-[var(--shadow-soft)] backdrop-blur-sm dark:border-border/80 dark:bg-[hsl(var(--surface-panel))/0.92] dark:shadow-[var(--shadow-soft)]'

const islandHeaderClassName =
  'flex flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between'

const islandTitleWrapClassName = 'space-y-1'

const islandEyebrowClassName = 'text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground'

const islandTitleClassName = 'text-lg font-semibold text-foreground'

const islandDescriptionClassName = 'text-sm text-muted-foreground'

const toolbarButtonClassName =
  'h-9 rounded-md border-border/70 bg-[hsl(var(--surface-soft))] px-4 text-xs shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground'

const filterFieldClassName = 'w-full min-w-0'

const statCardClassName =
  'flex min-h-[112px] flex-col justify-center rounded-lg border border-border/70 p-4 shadow-none dark:border-border/85'

function riskMeta(riskStatus: string): { label: string; className: string } {
  const map: Record<string, { label: string; className: string }> = {
    长期断货: { label: '长期断货', className: 'border-rose-300 bg-rose-200 text-rose-800 dark:border-rose-900 dark:bg-rose-950/70 dark:text-rose-200' },
    短期断货: { label: '短期断货', className: 'border-orange-200 bg-orange-100 text-orange-700 dark:border-orange-900/80 dark:bg-orange-950/50 dark:text-orange-300' },
    断货风险: { label: '断货风险', className: 'border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-900/80 dark:bg-rose-950/50 dark:text-rose-300' },
    健康库存: { label: '健康库存', className: 'border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-900/80 dark:bg-emerald-950/50 dark:text-emerald-300' },
    滞销: { label: '滞销', className: 'border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-900/80 dark:bg-amber-950/50 dark:text-amber-300' },
    严重滞销: { label: '严重滞销', className: 'border-fuchsia-200 bg-fuchsia-100 text-fuchsia-700 dark:border-fuchsia-900/80 dark:bg-fuchsia-950/50 dark:text-fuchsia-300' },
    待补数据: { label: '待补数据', className: 'border-border/70 bg-[hsl(var(--surface-soft))] text-muted-foreground dark:border-border/80 dark:bg-[hsl(var(--surface-strong))] dark:text-foreground/72' },
  }
  return map[riskStatus] || { label: riskStatus, className: 'border-border/70 bg-[hsl(var(--surface-soft))] text-muted-foreground dark:border-border/80 dark:bg-[hsl(var(--surface-strong))] dark:text-foreground/72' }
}

function shipmentStatusMeta(status: string): { label: string; className: string } {
  const map: Record<string, { label: string; className: string }> = {
    draft: { label: '草稿', className: 'border border-border/70 bg-[hsl(var(--surface-soft))] text-muted-foreground dark:border-border/80 dark:bg-[hsl(var(--surface-strong))] dark:text-foreground/72' },
    preparing: { label: '备货中', className: 'border border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-900/80 dark:bg-amber-950/60 dark:text-amber-300' },
    in_transit: { label: '在途', className: 'border border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-900/80 dark:bg-sky-950/60 dark:text-sky-300' },
    arrived_port: { label: '已到港', className: 'border border-cyan-200 bg-cyan-100 text-cyan-700 dark:border-cyan-900/80 dark:bg-cyan-950/60 dark:text-cyan-300' },
    inbound_processing: { label: '入仓处理中', className: 'border border-violet-200 bg-violet-100 text-violet-700 dark:border-violet-900/80 dark:bg-violet-950/60 dark:text-violet-300' },
    completed: { label: '完成', className: 'border border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-900/80 dark:bg-emerald-950/60 dark:text-emerald-300' },
    cancelled: { label: '取消', className: 'border border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-900/80 dark:bg-rose-950/60 dark:text-rose-300' },
  }
  return map[status] || { label: status, className: 'border border-border/70 bg-[hsl(var(--surface-soft))] text-muted-foreground dark:border-border/80 dark:bg-[hsl(var(--surface-strong))] dark:text-foreground/72' }
}

function methodLabel(method: string): string {
  const map: Record<string, string> = {
    sea: '海运',
    air: '空运',
    express: '快递',
    truck: '汽运',
    rail: '铁路',
    other: '其他',
  }
  return map[method] || method
}

function buildEditState(row: AnalysisRow): RowEditState {
  return {
    production_lead_days: String(row.production_lead_days),
    shipping_days: String(row.shipping_days),
    safety_factor: String(Math.round(row.safety_factor * 100)),
  }
}

export default function InventoryReplenishmentPage() {
  const { data: session } = useSession()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectId, setProjectId] = useState<string>('')
  const [country, setCountry] = useState('US')
  const [keyword, setKeyword] = useState('')
  const [riskFilter, setRiskFilter] = useState('all')
  const deferredKeyword = useDeferredValue(keyword)

  const [rows, setRows] = useState<AnalysisRow[]>([])
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)

  const [edits, setEdits] = useState<Record<string, RowEditState>>({})
  const [savingSku, setSavingSku] = useState<string | null>(null)

  const [sheetOpen, setSheetOpen] = useState(false)
  const [selectedRow, setSelectedRow] = useState<AnalysisRow | null>(null)
  const [shipments, setShipments] = useState<ShipmentItem[]>([])
  const [shipmentsLoading, setShipmentsLoading] = useState(false)
  const [shipmentsError, setShipmentsError] = useState<string | null>(null)

  const currentProjectId = useMemo(() => {
    const parsed = Number(projectId)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }, [projectId])

  const tableTotals = useMemo(
    () =>
      rows.reduce(
        (acc, row) => ({
          available_inventory: acc.available_inventory + (row.available_inventory ?? 0),
          in_transit_quantity: acc.in_transit_quantity + (row.in_transit_quantity ?? 0),
          dms_30: acc.dms_30 + (row.dms_30 ?? 0),
          dms_14: acc.dms_14 + (row.dms_14 ?? 0),
          dms_7: acc.dms_7 + (row.dms_7 ?? 0),
          dms_3: acc.dms_3 + (row.dms_3 ?? 0),
          base_dms: acc.base_dms + (row.base_dms ?? 0),
          weighted_dms: acc.weighted_dms + (row.weighted_dms ?? 0),
          estimated_replenishment_quantity:
            acc.estimated_replenishment_quantity + (row.estimated_replenishment_quantity ?? 0),
        }),
        {
          available_inventory: 0,
          in_transit_quantity: 0,
          dms_30: 0,
          dms_14: 0,
          dms_7: 0,
          dms_3: 0,
          base_dms: 0,
          weighted_dms: 0,
          estimated_replenishment_quantity: 0,
        },
      ),
    [rows],
  )

  useEffect(() => {
    let active = true
    async function loadProjects() {
      setProjectsLoading(true)
      try {
        const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
        if (!active) return
        setProjects(payload)
        if (!projectId && payload[0]?.id) {
          setProjectId(String(payload[0].id))
        }
      } catch (loadError) {
        if (!active) return
        setError(loadError instanceof Error ? loadError.message : '项目列表加载失败')
      } finally {
        if (active) setProjectsLoading(false)
      }
    }
    void loadProjects()
    return () => {
      active = false
    }
  }, [projectId, session])

  useEffect(() => {
    if (!currentProjectId) {
      setRows([])
      setSummary(EMPTY_SUMMARY)
      return
    }
    let active = true
    async function loadAnalysis() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({
          project_id: String(currentProjectId),
          country,
          page: '1',
          page_size: '200',
        })
        if (deferredKeyword.trim()) params.set('keyword', deferredKeyword.trim())
        if (riskFilter !== 'all') params.set('risk_status', riskFilter)

        const response = await fetch(`${API_BASE}/api/v1/inventory-replenishment-analysis?${params.toString()}`, {
          headers: authHeaders(),
          cache: 'no-store',
        })
        if (!response.ok) throw new Error(await parseError(response))
        const payload = (await response.json()) as AnalysisResponse
        if (!active) return
        setRows(payload.items)
        setSummary(payload.summary)
        setEdits((prev) => {
          const next = { ...prev }
          payload.items.forEach((row) => {
            const key = rowKey(row)
            next[key] = next[key] || buildEditState(row)
          })
          return next
        })
      } catch (loadError) {
        if (!active) return
        setRows([])
        setSummary(EMPTY_SUMMARY)
        setError(loadError instanceof Error ? loadError.message : '分析数据加载失败')
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadAnalysis()
    return () => {
      active = false
    }
  }, [country, currentProjectId, deferredKeyword, refreshNonce, riskFilter])

  async function openShipments(row: AnalysisRow) {
    setSelectedRow(row)
    setSheetOpen(true)
    setShipmentsLoading(true)
    setShipmentsError(null)
    try {
      const params = new URLSearchParams({
        project_id: String(row.project_id),
        sku: row.sku,
      })
      const response = await fetch(`${API_BASE}/api/v1/inventory-replenishment-shipments?${params.toString()}`, {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(await parseError(response))
      const payload = (await response.json()) as ShipmentResponse
      setShipments(payload.items)
    } catch (loadError) {
      setShipments([])
      setShipmentsError(loadError instanceof Error ? loadError.message : '发货信息加载失败')
    } finally {
      setShipmentsLoading(false)
    }
  }

  function parseRowEdit(row: AnalysisRow, edit: RowEditState): {
    productionLeadDays: number
    shippingDays: number
    safetyFactorPercent: number
  } {
    const productionLeadDays = Number(edit.production_lead_days)
    const shippingDays = Number(edit.shipping_days)
    const safetyFactorPercent = Number(edit.safety_factor)

    if (!Number.isFinite(productionLeadDays) || productionLeadDays < 0) {
      throw new Error(`SKU ${row.sku} 的生产交货时间无效`)
    }
    if (!Number.isFinite(shippingDays) || shippingDays < 0) {
      throw new Error(`SKU ${row.sku} 的运输时间无效`)
    }
    if (!Number.isFinite(safetyFactorPercent) || safetyFactorPercent < 0) {
      throw new Error(`SKU ${row.sku} 的加权系数无效`)
    }

    return {
      productionLeadDays,
      shippingDays,
      safetyFactorPercent,
    }
  }

  async function persistRowSettings(row: AnalysisRow, edit: RowEditState) {
    const { productionLeadDays, shippingDays, safetyFactorPercent } = parseRowEdit(row, edit)
    const requestParams = new URLSearchParams({ country: row.country })
    const response = await fetch(`${API_BASE}/api/v1/inventory-replenishment-settings/${row.project_id}/${encodeURIComponent(row.sku)}?${requestParams.toString()}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
      },
      body: JSON.stringify({
        asin: row.asin,
        production_lead_days: productionLeadDays,
        shipping_days: shippingDays,
        safety_factor: safetyFactorPercent / 100,
      }),
    })
    if (!response.ok) throw new Error(await parseError(response))
  }

  async function reloadAnalysis() {
    if (!currentProjectId) return
    const params = new URLSearchParams({
      project_id: String(currentProjectId),
      country,
      page: '1',
      page_size: '200',
    })
    if (deferredKeyword.trim()) params.set('keyword', deferredKeyword.trim())
    if (riskFilter !== 'all') params.set('risk_status', riskFilter)
    const response = await fetch(`${API_BASE}/api/v1/inventory-replenishment-analysis?${params.toString()}`, {
      headers: authHeaders(),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(await parseError(response))
    const refreshed = (await response.json()) as AnalysisResponse
    setRows(refreshed.items)
    setSummary(refreshed.summary)
    setEdits((prev) => {
      const next = { ...prev }
      refreshed.items.forEach((item) => {
        next[rowKey(item)] = buildEditState(item)
      })
      return next
    })
  }

  async function saveRow(row: AnalysisRow) {
    const key = rowKey(row)
    const edit = edits[key] || buildEditState(row)

    setSavingSku(key)
    setError(null)
    try {
      await persistRowSettings(row, edit)
      await reloadAnalysis()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败')
    } finally {
      setSavingSku(null)
    }
  }

  async function refreshWithSave() {
    if (!currentProjectId || loading || refreshingAll) return
    setRefreshingAll(true)
    setError(null)
    try {
      const changedRows = rows.filter((row) => {
        const edit = edits[rowKey(row)] || buildEditState(row)
        return (
          edit.production_lead_days !== String(row.production_lead_days)
          || edit.shipping_days !== String(row.shipping_days)
          || edit.safety_factor !== String(Math.round(row.safety_factor * 100))
        )
      })

      for (const row of changedRows) {
        const key = rowKey(row)
        setSavingSku(key)
        await persistRowSettings(row, edits[key] || buildEditState(row))
      }

      setSavingSku(null)
      await reloadAnalysis()
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : '刷新失败')
    } finally {
      setSavingSku(null)
      setRefreshingAll(false)
    }
  }

  async function exportToExcel() {
    if (rows.length === 0) {
      setError('当前没有可导出的补货分析数据')
      return
    }

    setExporting(true)
    setError(null)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()

      const worksheet = workbook.addWorksheet('补货分析', {
        views: [{ state: 'frozen', ySplit: 4, xSplit: 1 }],
      })

      const columns = [
        { header: '项目', key: 'project_name', width: 16 },
        { header: '国家', key: 'country', width: 10 },
        { header: 'SKU', key: 'sku', width: 18 },
        { header: 'ASIN', key: 'asin', width: 18 },
        { header: '店铺库存', key: 'available_inventory', width: 12 },
        { header: '在途', key: 'in_transit_quantity', width: 10 },
        { header: '30D', key: 'dms_30', width: 10 },
        { header: '14D', key: 'dms_14', width: 10 },
        { header: '7D', key: 'dms_7', width: 10 },
        { header: '3D', key: 'dms_3', width: 10 },
        { header: 'DMS', key: 'base_dms', width: 10 },
        { header: '加权系数', key: 'safety_factor', width: 12 },
        { header: '加权DMS', key: 'weighted_dms', width: 12 },
        { header: '可售天数', key: 'sellable_days', width: 12 },
        { header: '售卖截止', key: 'sellout_date', width: 14 },
        { header: '含在途截止', key: 'sellout_date_with_transit', width: 14 },
        { header: '生产交货', key: 'production_lead_days', width: 10 },
        { header: '运输时间', key: 'shipping_days', width: 10 },
        { header: '补货指令', key: 'replenishment_order_date', width: 14 },
        { header: '建仓指令', key: 'warehouse_entry_date', width: 14 },
        { header: '发货指令', key: 'shipment_order_date', width: 14 },
        { header: '预计数量', key: 'estimated_replenishment_quantity', width: 12 },
        { header: '风险状态', key: 'risk_status', width: 12 },
      ] as const

      const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false })
      const lastColumn = columns.length
      const selectedProjectName = projects.find((project) => String(project.id) === projectId)?.name ?? '全部项目'
      worksheet.mergeCells(1, 1, 1, lastColumn)
      worksheet.getCell(1, 1).value = '补货核算分析'
      worksheet.getCell(1, 1).font = { name: 'Microsoft YaHei', size: 16, bold: true, color: { argb: 'FF0F172A' } }
      worksheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }

      worksheet.mergeCells(2, 1, 2, lastColumn)
      worksheet.getCell(2, 1).value = `导出时间：${exportedAt}    说明：导出当前筛选条件下的补货主表数据`
      worksheet.getCell(2, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF475569' } }
      worksheet.getCell(2, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }

      const filterText = [
        `项目：${selectedProjectName}`,
        `国家：${COUNTRY_OPTIONS.find((option) => option.value === country)?.label ?? country}`,
        keyword.trim() ? `关键词：${keyword.trim()}` : '关键词：全部',
        riskFilter === 'all' ? '风险状态：全部' : `风险状态：${riskFilter}`,
      ].join('    ')
      worksheet.mergeCells(3, 1, 3, lastColumn)
      worksheet.getCell(3, 1).value = filterText
      worksheet.getCell(3, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF64748B' } }
      worksheet.getCell(3, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }

      worksheet.columns = columns.map((column) => ({ key: column.key, width: column.width }))

      const headerRow = worksheet.getRow(4)
      headerRow.values = columns.map((column) => column.header)
      headerRow.height = 24
      headerRow.eachCell((cell) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        }
      })

      rows.forEach((row, index) => {
        const sheetRow = worksheet.getRow(index + 5)
        sheetRow.values = [
          row.project_name,
          row.country,
          row.sku,
          row.asin || '-',
          row.available_inventory,
          row.in_transit_quantity,
          row.dms_30,
          row.dms_14,
          row.dms_7,
          row.dms_3,
          row.base_dms,
          row.safety_factor,
          row.weighted_dms,
          row.sellable_days,
          row.sellout_date || '-',
          row.sellout_date_with_transit || '-',
          row.production_lead_days,
          row.shipping_days,
          row.replenishment_order_date || '-',
          row.warehouse_entry_date || '-',
          row.shipment_order_date || '-',
          row.estimated_replenishment_quantity,
          row.risk_status,
        ]

        sheetRow.eachCell((cell, colNumber) => {
          cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
          cell.alignment = {
            vertical: 'middle',
            horizontal: colNumber >= 5 && colNumber <= 18 ? 'right' : 'left',
            wrapText: true,
          }
          if (colNumber === 23) {
            const riskStatus = row.risk_status
            if (riskStatus === '断货风险') {
              cell.font = { name: 'Microsoft YaHei', color: { argb: 'FFDC2626' }, bold: true }
            } else if (riskStatus === '长期断货') {
              cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF9F1239' }, bold: true }
            } else if (riskStatus === '短期断货') {
              cell.font = { name: 'Microsoft YaHei', color: { argb: 'FFEA580C' }, bold: true }
            } else if (riskStatus === '健康库存') {
              cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF059669' }, bold: true }
            } else if (riskStatus === '滞销') {
              cell.font = { name: 'Microsoft YaHei', color: { argb: 'FFD97706' }, bold: true }
            } else if (riskStatus === '严重滞销') {
              cell.font = { name: 'Microsoft YaHei', color: { argb: 'FFC026D3' }, bold: true }
            } else if (riskStatus === '待补数据') {
              cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF64748B' } }
            }
          }
          if (colNumber === 5 || colNumber === 6 || colNumber === 17 || colNumber === 18) cell.numFmt = '#,##0'
          if (colNumber >= 7 && colNumber <= 11) cell.numFmt = '0.0000'
          if (colNumber === 12) cell.numFmt = '0.00%'
          if (colNumber === 13 || colNumber === 14) cell.numFmt = '0.00'
          if (colNumber === 22) cell.numFmt = '#,##0'
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          }
        })
      })

      const totalRow = worksheet.getRow(rows.length + 5)
      totalRow.getCell(1).value = '筛选结果合计'
      totalRow.getCell(5).value = tableTotals.available_inventory
      totalRow.getCell(6).value = tableTotals.in_transit_quantity
      totalRow.getCell(7).value = tableTotals.dms_30
      totalRow.getCell(8).value = tableTotals.dms_14
      totalRow.getCell(9).value = tableTotals.dms_7
      totalRow.getCell(10).value = tableTotals.dms_3
      totalRow.getCell(11).value = tableTotals.base_dms
      totalRow.getCell(13).value = tableTotals.weighted_dms
      totalRow.getCell(22).value = tableTotals.estimated_replenishment_quantity
      totalRow.getCell(23).value = `SKU: ${summary.sku_count}`
      totalRow.eachCell((cell) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.alignment = { vertical: 'middle', wrapText: true }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        }
      })
      totalRow.getCell(5).numFmt = '#,##0'
      totalRow.getCell(6).numFmt = '#,##0'
      totalRow.getCell(7).numFmt = '0.0000'
      totalRow.getCell(8).numFmt = '0.0000'
      totalRow.getCell(9).numFmt = '0.0000'
      totalRow.getCell(10).numFmt = '0.0000'
      totalRow.getCell(11).numFmt = '0.0000'
      totalRow.getCell(13).numFmt = '0.00'
      totalRow.getCell(22).numFmt = '#,##0'

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const safeTimestamp = formatLocalTimestampForFilename()
      link.href = url
      link.download = `补货分析-${safeTimestamp}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)
      await logClientOperation({
        action: 'inventory_replenishment.export',
        targetType: 'inventory_replenishment',
        targetId: currentProjectId,
        after: {
          project_id: currentProjectId,
          project_name: selectedProjectName,
          country,
          keyword: keyword.trim() || null,
          risk_status: riskFilter === 'all' ? null : riskFilter,
          row_count: rows.length,
          filename: link.download,
        },
      })
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出 Excel 失败')
    } finally {
      setExporting(false)
    }
  }

  const cards = [
    {
      title: 'SKU 总数',
      value: formatInt(summary.sku_count),
      description: '当前筛选结果',
      icon: <Boxes className="h-4 w-4" />,
      className: 'from-slate-100 via-white to-slate-50 dark:from-slate-900 dark:via-slate-950 dark:to-slate-900',
    },
    {
      title: '断货风险',
      value: formatInt(summary.out_of_stock_risk_count),
      description: '需优先处理',
      icon: <CircleAlert className="h-4 w-4" />,
      className: 'from-rose-100 via-white to-rose-50 dark:from-rose-950/35 dark:via-slate-950 dark:to-slate-900',
    },
    {
      title: '总店铺库存',
      value: formatInt(summary.total_available_inventory),
      description: '最新库存快照',
      icon: <PackageSearch className="h-4 w-4" />,
      className: 'from-sky-100 via-white to-cyan-50 dark:from-sky-950/35 dark:via-slate-950 dark:to-slate-900',
    },
    {
      title: '总在途库存',
      value: formatInt(summary.total_in_transit_quantity),
      description: '来自发货管理',
      icon: <ShipWheel className="h-4 w-4" />,
      className: 'from-amber-100 via-white to-yellow-50 dark:from-amber-950/35 dark:via-slate-950 dark:to-slate-900',
    },
  ]

  return (
    <div className="w-full space-y-6">
      <section className={islandSectionClassName}>
        <div className={islandHeaderClassName}>
          <div className={islandTitleWrapClassName}>
            <p className="dashboard-kicker">Analysis Console</p>
            <h2 className="break-keep whitespace-nowrap text-3xl font-semibold tracking-tight text-foreground">补货分析控制台</h2>
            <p className={islandDescriptionClassName}>把库存风险、在途信息和建议补货动作放进同一个工作区里，优先识别高风险 SKU。</p>
          </div>
          <div className="flex items-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={toolbarButtonClassName}
              disabled={!currentProjectId || loading || refreshingAll}
              onClick={() => void refreshWithSave()}
            >
              <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              {loading || refreshingAll ? '重算中...' : '刷新重算'}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="grid grid-cols-2 gap-2">
            <div className={filterFieldClassName}>
              {projectsLoading ? (
                <Skeleton className="h-9 w-full rounded-lg" />
              ) : (
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger className="h-9 rounded-md border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground">
                    <SelectValue placeholder="选择项目" />
                  </SelectTrigger>
                  <SelectContent align="start" side="bottom" sideOffset={8} collisionPadding={16}>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={String(project.id)}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className={filterFieldClassName}>
              <Input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索 SKU / ASIN"
                className="h-9 rounded-md border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground"
              />
            </div>
            <div className={filterFieldClassName}>
              <Select value={country} onValueChange={setCountry}>
                <SelectTrigger className="h-9 rounded-md border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground">
                  <SelectValue placeholder="国家站点" />
                </SelectTrigger>
                <SelectContent align="start" side="bottom" sideOffset={8} collisionPadding={16}>
                  {COUNTRY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className={filterFieldClassName}>
              <Select value={riskFilter} onValueChange={setRiskFilter}>
                <SelectTrigger className="h-9 rounded-md border-border/70 bg-[hsl(var(--surface-panel))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground">
                  <SelectValue placeholder="风险状态" />
                </SelectTrigger>
                <SelectContent align="start" side="bottom" sideOffset={8} collisionPadding={16}>
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="长期断货">长期断货</SelectItem>
                  <SelectItem value="短期断货">短期断货</SelectItem>
                  <SelectItem value="断货风险">断货风险</SelectItem>
                  <SelectItem value="健康库存">健康库存</SelectItem>
                  <SelectItem value="滞销">滞销</SelectItem>
                  <SelectItem value="严重滞销">严重滞销</SelectItem>
                  <SelectItem value="待补数据">待补数据</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-5 gap-2">
            {loading && rows.length === 0 ? (
              <>
                <Skeleton className="h-16 w-full rounded-xl" />
                <Skeleton className="h-16 w-full rounded-xl" />
                <Skeleton className="h-16 w-full rounded-xl" />
                <Skeleton className="h-16 w-full rounded-xl" />
                <Skeleton className="h-16 w-full rounded-xl" />
              </>
            ) : (
              <>
                {cards.map((card) => (
                  <div
                    key={card.title}
                    className={`flex min-h-[64px] flex-col justify-center rounded-md border border-border/70 p-2.5 shadow-[var(--shadow-soft)] bg-gradient-to-br ${card.className} dark:border-border/85`}
                  >
                    <div className="flex items-center gap-1 text-muted-foreground dark:text-foreground/72">
                      {card.icon}
                      <span className="text-[11px] font-medium">{card.title}</span>
                    </div>
                    <div className="text-lg font-bold tracking-tight text-foreground">{card.value}</div>
                  </div>
                ))}
                <div className="flex min-h-[64px] flex-col justify-center rounded-md border border-border/70 p-2.5 shadow-[var(--shadow-soft)] bg-gradient-to-br from-violet-100 via-white to-sky-50 dark:border-border/85 dark:from-slate-900 dark:via-slate-950 dark:to-sky-950/30">
                  <div className="flex items-center gap-1 text-muted-foreground dark:text-foreground/72">
                    <CalendarClock className="h-4 w-4" />
                    <span className="text-[11px] font-medium">分析状态</span>
                  </div>
                  <div className="text-sm font-semibold text-foreground">{loading ? '刷新中' : '已就绪'}</div>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <section className={islandSectionClassName}>
        <div className={islandHeaderClassName}>
          <div className={islandTitleWrapClassName}>
            <h3 className={islandTitleClassName}>SKU 补货主表</h3>
          </div>
          <Button
            variant="outline"
            className={toolbarButtonClassName}
            disabled={loading || exporting || rows.length === 0}
            onClick={() => void exportToExcel()}
          >
            <FileDown className="h-3.5 w-3.5" />
            {exporting ? '导出中...' : '导出 Excel'}
          </Button>
        </div>

        <div className="p-0">
          {error ? (
            <div className="border-b border-rose-100 bg-rose-50 px-6 py-3 text-sm text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/40 dark:text-rose-200">{error}</div>
          ) : null}
          {!currentProjectId && !projectsLoading ? (
            <div className="px-6 py-16 text-center text-sm text-muted-foreground">请先选择项目。</div>
          ) : loading && rows.length === 0 ? (
            <div className="space-y-3 p-6">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-muted-foreground">当前筛选条件下没有可分析的 SKU。</div>
          ) : (
            <div className="relative">
              {loading && rows.length > 0 ? (
                <div className="pointer-events-none absolute right-4 top-4 z-20 rounded-full border border-border/70 bg-[hsl(var(--surface-panel))/0.95] px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))/0.96] dark:text-foreground/72">
                  补货主表更新中...
                </div>
              ) : null}
              <Table
                containerClassName="max-h-[72vh] overflow-auto border-t border-border/70 bg-transparent dark:border-border/85"
                className="min-w-[2050px] table-auto border-separate border-spacing-0 bg-transparent text-[13px]"
              >
                <TableHeader>
                  <TableRow className="bg-transparent">
                    <TableHead className={`${tableHeadClassName} ${stickySkuHeadClassName} min-w-[132px]`}>SKU</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[88px]`}>国家</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[152px]`}>ASIN</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[96px] text-right`}>店铺库存</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[88px] text-right`}>在途</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[72px] text-right`}>30D</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[72px] text-right`}>14D</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[72px] text-right`}>7D</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[72px] text-right`}>3D</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[88px] text-right`}>DMS</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[112px]`}>加权系数</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[100px] text-right`}>加权DMS</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[100px] text-right`}>可售天数</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[116px]`}>售卖截止</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[116px]`}>含在途截止</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[104px]`}>生产交货</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[104px]`}>运输时间</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[116px]`}>补货指令</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[116px]`}>建仓指令</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[116px]`}>发货指令</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[104px] text-right`}>预计数量</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[104px]`}>风险状态</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[154px]`}>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <>
                    {rows.map((row) => {
                      const key = rowKey(row)
                      const edit = edits[key] || buildEditState(row)
                      const risk = riskMeta(row.risk_status)
                      return (
                        <TableRow key={key} className="group align-top odd:bg-[hsl(var(--surface-panel))] even:bg-[hsl(var(--surface-overlay))] hover:bg-sky-50/80 dark:odd:bg-[hsl(var(--surface-panel))] dark:even:bg-[hsl(var(--surface-overlay))] dark:hover:bg-sky-950/20">
                          <TableCell className={`${tableCellClassName} ${stickySkuCellClassName} font-medium text-foreground`}>
                            {row.sku}
                          </TableCell>
                          <TableCell className={tableCellClassName}>{row.country}</TableCell>
                          <TableCell className={`${tableCellClassName} font-medium text-foreground`}>
                            {row.asin || '--'}
                          </TableCell>
                          <TableCell className={`${tableCellClassName} text-right`}>{formatInt(row.available_inventory)}</TableCell>
                          <TableCell className={`${tableCellClassName} text-right`}>{formatInt(row.in_transit_quantity)}</TableCell>
                          <TableCell className={`${tableCellClassName} text-right`}>{formatNumber(row.dms_30)}</TableCell>
                          <TableCell className={`${tableCellClassName} text-right`}>{formatNumber(row.dms_14)}</TableCell>
                          <TableCell className={`${tableCellClassName} text-right`}>{formatNumber(row.dms_7)}</TableCell>
                          <TableCell className={`${tableCellClassName} text-right`}>{formatNumber(row.dms_3)}</TableCell>
                          <TableCell className={`${tableCellClassName} text-right font-medium text-foreground`}>
                            {formatNumber(row.base_dms)}
                          </TableCell>
                          <TableCell className={tableCellClassName}>
                            <div className="flex items-center gap-2">
                              <Input
                                value={edit.safety_factor}
                                onChange={(event) =>
                                  setEdits((prev) => ({ ...prev, [key]: { ...edit, safety_factor: event.target.value } }))
                                }
                                className="h-8 w-[72px] rounded-md border-border/70 bg-[hsl(var(--surface-panel))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground"
                              />
                              <span className="text-xs text-muted-foreground">%</span>
                            </div>
                          </TableCell>
                          <TableCell className={`${tableCellClassName} text-right font-medium text-foreground`}>
                            {formatNumber(row.weighted_dms)}
                          </TableCell>
                          <TableCell className={`${tableCellClassName} text-right`}>{formatNumber(row.sellable_days)}</TableCell>
                          <TableCell className={tableCellClassName}>{formatDate(row.sellout_date)}</TableCell>
                          <TableCell className={tableCellClassName}>{formatDate(row.sellout_date_with_transit)}</TableCell>
                          <TableCell className={tableCellClassName}>
                            <Input
                              value={edit.production_lead_days}
                              onChange={(event) =>
                                setEdits((prev) => ({
                                  ...prev,
                                  [key]: { ...edit, production_lead_days: event.target.value },
                                }))
                              }
                              className="h-8 w-[72px] rounded-md border-border/70 bg-[hsl(var(--surface-panel))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground"
                            />
                          </TableCell>
                          <TableCell className={tableCellClassName}>
                            <Input
                              value={edit.shipping_days}
                              onChange={(event) =>
                                setEdits((prev) => ({ ...prev, [key]: { ...edit, shipping_days: event.target.value } }))
                              }
                              className="h-8 w-[72px] rounded-md border-border/70 bg-[hsl(var(--surface-panel))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground"
                            />
                          </TableCell>
                          <TableCell className={tableCellClassName}>{formatDate(row.replenishment_order_date)}</TableCell>
                          <TableCell className={tableCellClassName}>{formatDate(row.warehouse_entry_date)}</TableCell>
                          <TableCell className={tableCellClassName}>{formatDate(row.shipment_order_date)}</TableCell>
                          <TableCell className={`${tableCellClassName} text-right font-medium text-foreground`}>
                            {formatInt(row.estimated_replenishment_quantity)}
                          </TableCell>
                          <TableCell className={tableCellClassName}>
                            <Badge variant="outline" className={risk.className}>
                              {risk.label}
                            </Badge>
                          </TableCell>
                          <TableCell className={tableCellClassName}>
                            <div className="flex flex-col gap-1.5">
                              <div className="flex items-center gap-2">
                                <Button
                                  size="sm"
                                  className="h-8 gap-1.5 whitespace-nowrap px-2.5 text-xs dark:bg-[hsl(var(--surface-strong))] dark:text-foreground"
                                  onClick={() => void saveRow(row)}
                                  disabled={savingSku === key}
                                >
                                  {savingSku === key ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
                                  保存
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 gap-1.5 whitespace-nowrap px-2.5 text-xs dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground"
                                  onClick={() => void openShipments(row)}
                                >
                                  <Send className="h-3.5 w-3.5" />
                                  查看发货
                                </Button>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                    <TableRow className="bg-muted/40 font-semibold">
                      <TableCell className={`${tableCellClassName} ${stickySkuCellClassName}`}>合计</TableCell>
                      <TableCell className={tableCellClassName} colSpan={2} />
                      <TableCell className={`${tableCellClassName} text-right`}>{formatInt(tableTotals.available_inventory)}</TableCell>
                      <TableCell className={`${tableCellClassName} text-right`}>{formatInt(tableTotals.in_transit_quantity)}</TableCell>
                      <TableCell className={`${tableCellClassName} text-right`}>{formatNumber(tableTotals.dms_30, 4)}</TableCell>
                      <TableCell className={`${tableCellClassName} text-right`}>{formatNumber(tableTotals.dms_14, 4)}</TableCell>
                      <TableCell className={`${tableCellClassName} text-right`}>{formatNumber(tableTotals.dms_7, 4)}</TableCell>
                      <TableCell className={`${tableCellClassName} text-right`}>{formatNumber(tableTotals.dms_3, 4)}</TableCell>
                      <TableCell className={`${tableCellClassName} text-right`}>{formatNumber(tableTotals.base_dms, 4)}</TableCell>
                      <TableCell className={tableCellClassName} />
                      <TableCell className={`${tableCellClassName} text-right`}>{formatNumber(tableTotals.weighted_dms)}</TableCell>
                      <TableCell className={tableCellClassName} />
                      <TableCell className={tableCellClassName} />
                      <TableCell className={tableCellClassName} />
                      <TableCell className={tableCellClassName} />
                      <TableCell className={tableCellClassName} />
                      <TableCell className={tableCellClassName} />
                      <TableCell className={tableCellClassName} />
                      <TableCell className={tableCellClassName} />
                      <TableCell className={`${tableCellClassName} text-right`}>{formatInt(tableTotals.estimated_replenishment_quantity)}</TableCell>
                      <TableCell className={tableCellClassName}>{`SKU: ${formatInt(summary.sku_count)}`}</TableCell>
                      <TableCell className={tableCellClassName} />
                    </TableRow>
                  </>
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </section>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto dark:border-border/85 dark:bg-[hsl(var(--surface-panel))] sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle className="dark:text-foreground">{selectedRow ? `${selectedRow.sku} 发货信息` : '发货信息'}</SheetTitle>
            <SheetDescription className="dark:text-foreground/72">
              在途数量口径包含 `in_transit`、`draft`。本抽屉只读展示，维护请前往发货管理。
            </SheetDescription>
          </SheetHeader>

          {selectedRow ? (
            <div className="mt-6 space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                <Card className="border-border/70 dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]">
                  <CardContent className="pt-6">
                    <div className="text-xs text-muted-foreground">SKU</div>
                    <div className="mt-1 text-lg font-semibold text-foreground">{selectedRow.sku}</div>
                  </CardContent>
                </Card>
                <Card className="border-border/70 dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]">
                  <CardContent className="pt-6">
                    <div className="text-xs text-muted-foreground">店铺库存</div>
                    <div className="mt-1 text-lg font-semibold text-foreground">{formatInt(selectedRow.available_inventory)}</div>
                  </CardContent>
                </Card>
                <Card className="border-border/70 dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]">
                  <CardContent className="pt-6">
                    <div className="text-xs text-muted-foreground">在途数量</div>
                    <div className="mt-1 text-lg font-semibold text-foreground">{formatInt(selectedRow.in_transit_quantity)}</div>
                  </CardContent>
                </Card>
              </div>

              {shipmentsError ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/40 dark:text-rose-200">{shipmentsError}</div> : null}
              {shipmentsLoading ? (
                <div className="space-y-3">
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-24 w-full" />
                </div>
              ) : shipments.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/70 px-4 py-10 text-center text-sm text-muted-foreground dark:border-border/80">
                  当前 SKU 暂无发货记录。
                </div>
              ) : (
                <div className="space-y-3">
                  {shipments.map((item) => {
                    const status = shipmentStatusMeta(item.shipment_status)
                    return (
                      <div key={`${item.schedule_id}-${item.shipment_no}`} className="rounded-lg border border-border/70 bg-[hsl(var(--surface-panel))] p-4 shadow-sm dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:shadow-none">
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <div className="font-semibold text-foreground">{item.shipment_no}</div>
                              <Badge className={status.className}>{status.label}</Badge>
                            </div>
                            <div className="grid gap-1 text-sm text-muted-foreground dark:text-foreground/80">
                              <div>物流方式：{methodLabel(item.shipping_method)}</div>
                              <div>数量：{formatInt(item.quantity)}</div>
                              <div>ETD：{formatDate(item.etd_date)}</div>
                              <div>ETA：{formatDate(item.eta_date)}</div>
                              <div>实际入仓：{formatDate(item.actual_inbound_date)}</div>
                              <div>追踪号：{item.tracking_no || '--'}</div>
                            </div>
                          </div>
                          <div className="space-y-3 text-right">
                            <div className="text-xs text-muted-foreground">最近更新</div>
                            <div className="text-sm text-foreground/80">{item.updated_at}</div>
                            <Button
                              variant="outline"
                              size="sm"
                              className="dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground"
                              onClick={() => {
                                const params = new URLSearchParams({
                                  shipment_no: item.shipment_no,
                                  tab: 'fba-box-detail',
                                })
                                window.open(`/dashboard/data-management/shipment-management?${params.toString()}`, '_blank', 'noopener,noreferrer')
                              }}
                            >
                              <Send className="mr-1.5 h-3.5 w-3.5" />
                              去管理
                            </Button>
                          </div>
                        </div>
                        {item.remark ? (
                          <div className="mt-3 rounded-lg bg-[hsl(var(--surface-soft))] px-3 py-2 text-sm text-foreground/80 dark:bg-[hsl(var(--surface-strong))]">{item.remark}</div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>

      <div className="rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] px-5 py-4 text-sm text-foreground/80 dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]">
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[hsl(var(--surface-panel))] text-muted-foreground shadow-sm ring-1 ring-border/70 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground/72 dark:ring-border/80">
            <CalendarClock className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-3">
            <div>
              <div className="text-sm font-semibold text-foreground">口径说明</div>
            </div>
            <div className="grid gap-2">
              <div className="rounded-xl border border-border/70 bg-[hsl(var(--surface-panel))]/90 px-3 py-2.5 leading-6 dark:border-border/80 dark:bg-[hsl(var(--surface-overlay))]/90">
                <span className="mr-2 inline-flex rounded-md bg-[hsl(var(--surface-soft))] px-2 py-0.5 text-xs font-medium text-foreground/80 dark:bg-[hsl(var(--surface-strong))]">风险状态</span>
                按 <code>含在途截止 - today</code> 判定；若销量数据缺失，则状态为“待补数据”。
              </div>
              <div className="rounded-xl border border-border/70 bg-[hsl(var(--surface-panel))]/90 px-3 py-2.5 leading-6 dark:border-border/80 dark:bg-[hsl(var(--surface-overlay))]/90">
                <span className="mr-2 inline-flex rounded-md bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">预计数量</span>
                按 <code>(生产交货时间 + 运输时间) × 加权DMS</code> 计算；滞销与严重滞销状态不显示预计补货数量，其余状态在存在有效 <code>加权DMS</code> 时显示。
              </div>
              <div className="rounded-xl border border-border/70 bg-[hsl(var(--surface-panel))]/90 px-3 py-2.5 leading-6 dark:border-border/80 dark:bg-[hsl(var(--surface-overlay))]/90">
                <span className="mr-2 inline-flex rounded-md bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-950/60 dark:text-sky-300">销量来源</span>
                近 <code>30D / 14D / 7D / 3D</code> 全部改为取 <code>sales_report</code> 明细，其中 <code>3D</code> 使用滞后 2 天窗口。
              </div>
              <div className="rounded-xl border border-border/70 bg-[hsl(var(--surface-panel))]/90 px-3 py-2.5 leading-6 dark:border-border/80 dark:bg-[hsl(var(--surface-overlay))]/90">
                <span className="mr-2 inline-flex rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">权重规则</span>
                默认按 <code>30D 10%</code>、<code>14D 30%</code>、<code>7D 30%</code>、<code>3D 30%</code> 计算；若 <code>3D</code> 缺失，则其 <code>30%</code> 权重全部并给 <code>7D</code>。
              </div>
              <div className="rounded-xl border border-border/70 bg-[hsl(var(--surface-panel))]/90 px-3 py-2.5 leading-6 dark:border-border/80 dark:bg-[hsl(var(--surface-overlay))]/90">
                <span className="mr-2 inline-flex rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">窗口示例</span>
                若今天是 <code>2026-03-09</code>，则 <code>3D</code> 取 <code>2026-03-05</code> 到 <code>2026-03-07</code>。如果当前项目该窗口内没有导入、SKU 未匹配或无可计销量，则 <code>3D</code> 显示 <code>--</code>。
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
