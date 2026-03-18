'use client'

import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { Boxes, CalendarClock, CircleAlert, Loader2, PackageSearch, Save, ShipWheel } from 'lucide-react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

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
  'h-11 whitespace-nowrap border-b border-r border-slate-200 px-3 py-2.5 text-[14px] font-bold tracking-normal text-slate-700 last:border-r-0 dark:border-slate-800 dark:text-slate-300'

const tableCellClassName =
  'whitespace-nowrap border-b border-r border-slate-200 px-3 py-2 align-middle text-[13px] text-slate-700 last:border-r-0 dark:border-slate-800 dark:text-slate-300'

const stickyTableHeadClassName =
  'sticky top-0 z-[15] bg-slate-50 shadow-[inset_0_-1px_0_0_rgba(148,163,184,0.22)] dark:bg-slate-950 dark:shadow-[inset_0_-1px_0_0_rgba(51,65,85,0.65)]'

const stickySkuHeadClassName =
  'sticky left-0 top-0 z-[16] bg-slate-50 shadow-[inset_-1px_0_0_0_rgba(148,163,184,0.22)] dark:bg-slate-950 dark:shadow-[inset_-1px_0_0_0_rgba(51,65,85,0.65)]'

const stickySkuCellClassName =
  'sticky left-0 z-[1] bg-white shadow-[inset_-1px_0_0_0_rgba(148,163,184,0.16)] group-hover:bg-sky-50 dark:bg-slate-950 dark:shadow-[inset_-1px_0_0_0_rgba(51,65,85,0.65)] dark:group-hover:bg-sky-950/40'

function riskMeta(riskStatus: string): { label: string; className: string } {
  const map: Record<string, { label: string; className: string }> = {
    断货风险: { label: '断货风险', className: 'border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-900/80 dark:bg-rose-950/50 dark:text-rose-300' },
    未来健康: { label: '未来健康', className: 'border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-900/80 dark:bg-emerald-950/50 dark:text-emerald-300' },
    滞销风险: { label: '滞销风险', className: 'border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-900/80 dark:bg-amber-950/50 dark:text-amber-300' },
    待补数据: { label: '待补数据', className: 'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  }
  return map[riskStatus] || { label: riskStatus, className: 'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300' }
}

function shipmentStatusMeta(status: string): { label: string; className: string } {
  const map: Record<string, { label: string; className: string }> = {
    draft: { label: '草稿', className: 'border border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200' },
    preparing: { label: '备货中', className: 'border border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-900/80 dark:bg-amber-950/60 dark:text-amber-300' },
    in_transit: { label: '在途', className: 'border border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-900/80 dark:bg-sky-950/60 dark:text-sky-300' },
    arrived_port: { label: '已到港', className: 'border border-cyan-200 bg-cyan-100 text-cyan-700 dark:border-cyan-900/80 dark:bg-cyan-950/60 dark:text-cyan-300' },
    inbound_processing: { label: '入仓处理中', className: 'border border-violet-200 bg-violet-100 text-violet-700 dark:border-violet-900/80 dark:bg-violet-950/60 dark:text-violet-300' },
    completed: { label: '完成', className: 'border border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-900/80 dark:bg-emerald-950/60 dark:text-emerald-300' },
    cancelled: { label: '取消', className: 'border border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-900/80 dark:bg-rose-950/60 dark:text-rose-300' },
  }
  return map[status] || { label: status, className: 'border border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200' }
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
  const router = useRouter()
  const { data: session } = useSession()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectId, setProjectId] = useState<string>('')
  const [country, setCountry] = useState('US')
  const [keyword, setKeyword] = useState('')
  const [riskFilter, setRiskFilter] = useState('all')
  const deferredKeyword = useDeferredValue(keyword)

  const [rows, setRows] = useState<AnalysisRow[]>([])
  const [summary, setSummary] = useState<Summary>({
    sku_count: 0,
    out_of_stock_risk_count: 0,
    healthy_count: 0,
    slow_moving_count: 0,
    pending_data_count: 0,
    total_available_inventory: 0,
    total_in_transit_quantity: 0,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
        setSummary({
          sku_count: 0,
          out_of_stock_risk_count: 0,
          healthy_count: 0,
          slow_moving_count: 0,
          pending_data_count: 0,
          total_available_inventory: 0,
          total_in_transit_quantity: 0,
        })
        setError(loadError instanceof Error ? loadError.message : '分析数据加载失败')
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadAnalysis()
    return () => {
      active = false
    }
  }, [country, currentProjectId, deferredKeyword, riskFilter])

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

  async function saveRow(row: AnalysisRow) {
    const key = rowKey(row)
    const edit = edits[key] || buildEditState(row)
    const productionLeadDays = Number(edit.production_lead_days)
    const shippingDays = Number(edit.shipping_days)
    const safetyFactorPercent = Number(edit.safety_factor)

    if (!Number.isFinite(productionLeadDays) || productionLeadDays < 0) {
      setError(`SKU ${row.sku} 的生产交货时间无效`)
      return
    }
    if (!Number.isFinite(shippingDays) || shippingDays < 0) {
      setError(`SKU ${row.sku} 的运输时间无效`)
      return
    }
    if (!Number.isFinite(safetyFactorPercent) || safetyFactorPercent < 0) {
      setError(`SKU ${row.sku} 的加权系数无效`)
      return
    }

    setSavingSku(key)
    setError(null)
    try {
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

      const params = new URLSearchParams({
        project_id: String(row.project_id),
        country,
        page: '1',
        page_size: '200',
      })
      if (deferredKeyword.trim()) params.set('keyword', deferredKeyword.trim())
      if (riskFilter !== 'all') params.set('risk_status', riskFilter)
      const refreshResponse = await fetch(`${API_BASE}/api/v1/inventory-replenishment-analysis?${params.toString()}`, {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (!refreshResponse.ok) throw new Error(await parseError(refreshResponse))
      const refreshed = (await refreshResponse.json()) as AnalysisResponse
      setRows(refreshed.items)
      setSummary(refreshed.summary)
      setEdits((prev) => {
        const next = { ...prev }
        refreshed.items.forEach((item) => {
          next[rowKey(item)] = buildEditState(item)
        })
        return next
      })
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败')
    } finally {
      setSavingSku(null)
    }
  }

  const cards = [
    {
      title: 'SKU 总数',
      value: formatInt(summary.sku_count),
      description: '当前筛选结果',
      icon: <Boxes className="h-4 w-4" />,
      className: 'from-slate-100 via-white to-slate-50 dark:from-slate-900 dark:via-slate-950 dark:to-slate-900/70',
    },
    {
      title: '断货风险',
      value: formatInt(summary.out_of_stock_risk_count),
      description: '需优先处理',
      icon: <CircleAlert className="h-4 w-4" />,
      className: 'from-rose-100 via-white to-rose-50 dark:from-rose-950/50 dark:via-slate-950 dark:to-slate-900',
    },
    {
      title: '总店铺库存',
      value: formatInt(summary.total_available_inventory),
      description: '最新库存快照',
      icon: <PackageSearch className="h-4 w-4" />,
      className: 'from-sky-100 via-white to-cyan-50 dark:from-sky-950/50 dark:via-slate-950 dark:to-slate-900',
    },
    {
      title: '总在途库存',
      value: formatInt(summary.total_in_transit_quantity),
      description: '来自发货管理',
      icon: <ShipWheel className="h-4 w-4" />,
      className: 'from-amber-100 via-white to-yellow-50 dark:from-amber-950/50 dark:via-slate-950 dark:to-slate-900',
    },
  ]

  return (
    <div className="space-y-6 bg-[radial-gradient(circle_at_top,rgba(245,158,11,0.08),transparent_28%),linear-gradient(180deg,#fbfdff_0%,#f8fafc_50%,#ffffff_100%)] p-1 dark:bg-[radial-gradient(circle_at_top,rgba(245,158,11,0.1),transparent_26%),linear-gradient(180deg,#020617_0%,#07111f_48%,#020617_100%)]">
      <section className="relative overflow-hidden rounded-[28px] border border-slate-200/80 bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.12),_transparent_25%),radial-gradient(circle_at_top_right,_rgba(14,165,233,0.12),_transparent_30%),linear-gradient(135deg,_rgba(248,250,252,0.98),_rgba(255,255,255,0.96))] p-6 shadow-[0_20px_60px_-40px_rgba(15,23,42,0.35)] dark:border-slate-800/80 dark:bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.14),_transparent_24%),radial-gradient(circle_at_top_right,_rgba(14,165,233,0.14),_transparent_28%),linear-gradient(135deg,_rgba(15,23,42,0.96),_rgba(7,18,32,0.94))] dark:shadow-[0_28px_90px_-50px_rgba(0,0,0,0.76)]">
        <div className="absolute inset-y-0 right-0 w-1/3 bg-[linear-gradient(135deg,transparent,rgba(15,23,42,0.04))] dark:bg-[linear-gradient(135deg,transparent,rgba(148,163,184,0.05))]" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          {/* 左侧：标题和4个筛选区域 */}
          <div className="flex-1">
            <div className="mb-4">
              <h2 className="break-keep whitespace-nowrap font-serif text-3xl tracking-tight text-slate-900 dark:text-slate-50">
                控制台
              </h2>
            </div>
            <div className="flex flex-wrap items-end gap-2 lg:max-w-[720px]">
              <div className="w-full min-w-0 sm:w-[160px]">
                <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">项目名称</div>
                {projectsLoading ? (
                  <Skeleton className="h-10 w-full rounded-xl" />
                ) : (
                  <Select value={projectId} onValueChange={setProjectId}>
                    <SelectTrigger className="h-10 rounded-xl border-slate-200 bg-white/85 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100">
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
              <div className="w-full min-w-0 sm:w-[160px]">
                <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">SKU / ASIN</div>
                <Input
                  value={keyword}
                  onChange={(event) => setKeyword(event.target.value)}
                  placeholder="搜索 SKU 或 ASIN"
                  className="h-10 rounded-xl border-slate-200 bg-white/85 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100"
                />
              </div>
              <div className="w-full min-w-0 sm:w-[140px]">
                <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">国家站点</div>
                <Select value={country} onValueChange={setCountry}>
                  <SelectTrigger className="h-10 rounded-xl border-slate-200 bg-white/85 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100">
                    <SelectValue placeholder="选择国家站点" />
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
              <div className="w-full min-w-0 sm:w-[140px]">
                <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">风险状态</div>
                <Select value={riskFilter} onValueChange={setRiskFilter}>
                  <SelectTrigger className="h-10 rounded-xl border-slate-200 bg-white/85 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100">
                    <SelectValue placeholder="全部状态" />
                  </SelectTrigger>
                  <SelectContent align="start" side="bottom" sideOffset={8} collisionPadding={16}>
                    <SelectItem value="all">全部状态</SelectItem>
                    <SelectItem value="断货风险">断货风险</SelectItem>
                    <SelectItem value="未来健康">未来健康</SelectItem>
                    <SelectItem value="滞销风险">滞销风险</SelectItem>
                    <SelectItem value="待补数据">待补数据</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* 右侧：标签卡片 */}
          <div className="flex items-center">
            <div className="grid grid-cols-2 gap-3 lg:w-[480px] lg:grid-cols-4">
            {loading && rows.length === 0 ? (
              <>
                <Skeleton className="h-[100px] w-full rounded-2xl" />
                <Skeleton className="h-[100px] w-full rounded-2xl" />
                <Skeleton className="h-[100px] w-full rounded-2xl" />
                <Skeleton className="h-[100px] w-full rounded-2xl" />
              </>
            ) : (
              cards.map((card) => (
                <div
                  key={card.title}
                  className={`flex flex-col items-center justify-center rounded-2xl border border-slate-200/70 bg-gradient-to-br p-4 dark:border-slate-800 ${card.className}`}
                >
                  <div className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
                    {card.icon}
                    <span className="text-xs font-medium">{card.title}</span>
                  </div>
                  <div className="mt-1 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
                    {card.value}
                  </div>
                </div>
              ))
            )}
            </div>
          </div>
        </div>
        </section>

      <Card className="overflow-visible border-slate-200/80 dark:border-slate-800 dark:bg-slate-950/80">
        <CardHeader className="border-b border-slate-100 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-900/70">
          <CardTitle className="text-slate-900 dark:text-slate-50">SKU 补货主表</CardTitle>
          <CardDescription className="dark:text-slate-400">
            ASIN 默认为只读；行内仅可修改生产交货时间、运输时间和加权系数。发货信息仅查看，维护入口仍在发货管理。
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <div className="border-b border-rose-100 bg-rose-50 px-6 py-3 text-sm text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/40 dark:text-rose-200">{error}</div>
          ) : null}
          {!currentProjectId && !projectsLoading ? (
            <div className="px-6 py-16 text-center text-sm text-slate-500 dark:text-slate-400">请先选择项目。</div>
          ) : loading && rows.length === 0 ? (
            <div className="space-y-3 p-6">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-slate-500 dark:text-slate-400">当前筛选条件下没有可分析的 SKU。</div>
          ) : (
            <div className="relative">
              {loading && rows.length > 0 ? (
                <div className="pointer-events-none absolute right-4 top-4 z-20 rounded-full border border-slate-200/80 bg-white/95 px-3 py-1 text-xs text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-950/95 dark:text-slate-300">
                  补货主表更新中...
                </div>
              ) : null}
              <Table
                containerClassName="max-h-[70vh] overflow-auto"
                className="min-w-[2050px] table-auto border-separate border-spacing-0 bg-white text-[13px] dark:bg-slate-950"
              >
                <TableHeader>
                  <TableRow className="bg-slate-50 dark:bg-slate-950">
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
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[104px]`}>风险状态</TableHead>
                    <TableHead className={`${tableHeadClassName} ${stickyTableHeadClassName} min-w-[154px]`}>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const key = rowKey(row)
                    const edit = edits[key] || buildEditState(row)
                    const risk = riskMeta(row.risk_status)
                    return (
                      <TableRow key={key} className="group align-top hover:bg-sky-50/80 dark:hover:bg-sky-950/20">
                        <TableCell className={`${tableCellClassName} ${stickySkuCellClassName} font-medium text-slate-900 dark:text-slate-100`}>
                          {row.sku}
                        </TableCell>
                        <TableCell className={tableCellClassName}>{row.country}</TableCell>
                        <TableCell className={`${tableCellClassName} font-medium text-slate-900 dark:text-slate-100`}>
                          {row.asin || '--'}
                        </TableCell>
                        <TableCell className={`${tableCellClassName} text-right`}>{formatInt(row.available_inventory)}</TableCell>
                        <TableCell className={`${tableCellClassName} text-right`}>{formatInt(row.in_transit_quantity)}</TableCell>
                        <TableCell className={`${tableCellClassName} text-right`}>{formatNumber(row.dms_30)}</TableCell>
                        <TableCell className={`${tableCellClassName} text-right`}>{formatNumber(row.dms_14)}</TableCell>
                        <TableCell className={`${tableCellClassName} text-right`}>{formatNumber(row.dms_7)}</TableCell>
                        <TableCell className={`${tableCellClassName} text-right`}>{formatNumber(row.dms_3)}</TableCell>
                        <TableCell className={`${tableCellClassName} text-right font-medium text-slate-900 dark:text-slate-100`}>
                          {formatNumber(row.base_dms)}
                        </TableCell>
                        <TableCell className={tableCellClassName}>
                          <div className="flex items-center gap-2">
                            <Input
                              value={edit.safety_factor}
                            onChange={(event) =>
                              setEdits((prev) => ({ ...prev, [key]: { ...edit, safety_factor: event.target.value } }))
                            }
                            className="h-8 w-[72px] bg-white dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                          />
                            <span className="text-xs text-slate-500 dark:text-slate-400">%</span>
                          </div>
                        </TableCell>
                        <TableCell className={`${tableCellClassName} text-right font-medium text-slate-900 dark:text-slate-100`}>
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
                            className="h-8 w-[72px] bg-white dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                          />
                        </TableCell>
                        <TableCell className={tableCellClassName}>
                          <Input
                            value={edit.shipping_days}
                            onChange={(event) =>
                              setEdits((prev) => ({ ...prev, [key]: { ...edit, shipping_days: event.target.value } }))
                            }
                            className="h-8 w-[72px] bg-white dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                          />
                        </TableCell>
                        <TableCell className={tableCellClassName}>{formatDate(row.replenishment_order_date)}</TableCell>
                        <TableCell className={tableCellClassName}>{formatDate(row.warehouse_entry_date)}</TableCell>
                        <TableCell className={tableCellClassName}>{formatDate(row.shipment_order_date)}</TableCell>
                        <TableCell className={tableCellClassName}>
                          <Badge variant="outline" className={risk.className}>
                            {risk.label}
                          </Badge>
                        </TableCell>
                        <TableCell className={tableCellClassName}>
                          <div className="flex flex-col gap-1.5">
                            <Button
                              size="sm"
                              className="h-8 justify-start whitespace-nowrap px-2.5 text-xs dark:bg-slate-100 dark:text-slate-950"
                              onClick={() => void saveRow(row)}
                              disabled={savingSku === key}
                            >
                              {savingSku === key ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
                              保存参数
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 justify-start whitespace-nowrap px-2.5 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                              onClick={() => void openShipments(row)}
                            >
                              查看发货
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 justify-start whitespace-nowrap px-2.5 text-xs dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                              onClick={() => router.push('/dashboard/data-management/shipment-management')}
                            >
                              前往发货管理
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto dark:border-slate-800 dark:bg-slate-950 sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle className="dark:text-slate-100">{selectedRow ? `${selectedRow.sku} 发货信息` : '发货信息'}</SheetTitle>
            <SheetDescription className="dark:text-slate-400">
              在途数量口径包含 `in_transit`、`arrived_port`、`inbound_processing`。本抽屉只读展示，维护请前往发货管理。
            </SheetDescription>
          </SheetHeader>

          {selectedRow ? (
            <div className="mt-6 space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                <Card className="border-slate-200 dark:border-slate-800 dark:bg-slate-900/80">
                  <CardContent className="pt-6">
                    <div className="text-xs text-slate-500 dark:text-slate-400">SKU</div>
                    <div className="mt-1 text-lg font-semibold dark:text-slate-100">{selectedRow.sku}</div>
                  </CardContent>
                </Card>
                <Card className="border-slate-200 dark:border-slate-800 dark:bg-slate-900/80">
                  <CardContent className="pt-6">
                    <div className="text-xs text-slate-500 dark:text-slate-400">店铺库存</div>
                    <div className="mt-1 text-lg font-semibold dark:text-slate-100">{formatInt(selectedRow.available_inventory)}</div>
                  </CardContent>
                </Card>
                <Card className="border-slate-200 dark:border-slate-800 dark:bg-slate-900/80">
                  <CardContent className="pt-6">
                    <div className="text-xs text-slate-500 dark:text-slate-400">在途数量</div>
                    <div className="mt-1 text-lg font-semibold dark:text-slate-100">{formatInt(selectedRow.in_transit_quantity)}</div>
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
                <div className="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                  当前 SKU 暂无发货记录。
                </div>
              ) : (
                <div className="space-y-3">
                  {shipments.map((item) => {
                    const status = shipmentStatusMeta(item.shipment_status)
                    return (
                      <div key={`${item.schedule_id}-${item.shipment_no}`} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/80 dark:shadow-none">
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <div className="font-semibold text-slate-900 dark:text-slate-100">{item.shipment_no}</div>
                              <Badge className={status.className}>{status.label}</Badge>
                            </div>
                            <div className="grid gap-1 text-sm text-slate-600 dark:text-slate-300">
                              <div>物流方式：{methodLabel(item.shipping_method)}</div>
                              <div>数量：{formatInt(item.quantity)}</div>
                              <div>ETD：{formatDate(item.etd_date)}</div>
                              <div>ETA：{formatDate(item.eta_date)}</div>
                              <div>实际入仓：{formatDate(item.actual_inbound_date)}</div>
                              <div>追踪号：{item.tracking_no || '--'}</div>
                            </div>
                          </div>
                          <div className="space-y-3 text-right">
                            <div className="text-xs text-slate-500 dark:text-slate-400">最近更新</div>
                            <div className="text-sm text-slate-700 dark:text-slate-300">{item.updated_at}</div>
                            <Button variant="outline" size="sm" className="dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" onClick={() => router.push('/dashboard/data-management/shipment-management')}>
                              前往发货管理
                            </Button>
                          </div>
                        </div>
                        {item.remark ? (
                          <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:bg-slate-950 dark:text-slate-300">{item.remark}</div>
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

      <div className="rounded-2xl border border-slate-200/80 bg-slate-50/70 px-5 py-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-300">
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white text-slate-500 shadow-sm ring-1 ring-slate-200/80 dark:bg-slate-950 dark:text-slate-300 dark:ring-slate-800">
            <CalendarClock className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-3">
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">口径说明</div>
              <div className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">用于解释风险状态与销量窗口的计算方式。</div>
            </div>
            <div className="grid gap-2">
              <div className="rounded-xl border border-slate-200/80 bg-white/80 px-3 py-2.5 leading-6 dark:border-slate-800 dark:bg-slate-950/80">
                <span className="mr-2 inline-flex rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">风险状态</span>
                按 <code>补货指令 - 运输时间</code> 判定；若销量数据缺失，则状态为“待补数据”。
              </div>
              <div className="rounded-xl border border-slate-200/80 bg-white/80 px-3 py-2.5 leading-6 dark:border-slate-800 dark:bg-slate-950/80">
                <span className="mr-2 inline-flex rounded-md bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-950/60 dark:text-sky-300">销量来源</span>
                近 <code>30D / 14D / 7D</code> 销量取当前版本业务报表，近 <code>3D</code> 销量取 <code>daily_sales_order</code> 的滞后 2 天窗口。
              </div>
              <div className="rounded-xl border border-slate-200/80 bg-white/80 px-3 py-2.5 leading-6 dark:border-slate-800 dark:bg-slate-950/80">
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
