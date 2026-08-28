'use client'

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  CalendarClock,
  FileDown,
  Gauge,
  LayoutGrid,
  Loader2,
  RefreshCw,
  Save,
  Send,
  CalendarDays,
} from 'lucide-react'
import { useSession } from 'next-auth/react'
import dynamic from 'next/dynamic'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  STICKY_LEFT_HEAD_CELL,
  STICKY_LEFT_CELL_HOVER,
  STICKY_TOP_ROW,
} from '@/components/ui/table'
import { DataTableCard, DataTableCardBody, DataTableCardHeader } from '@/components/ui/data-card'
import { FilterToolbar } from '@/components/ui/filter-toolbar'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { logClientOperation } from '@/lib/operation-audit'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { fetchOpsJsonCached } from '@/lib/ops-client-cache'
import { useAutoSelectFirstProject } from '@/lib/hooks/use-auto-select-first-project'
import { useNotifications } from '@/components/notifications'
import { formatLocalTimestampForFilename, cn } from '@/lib/utils'
import { getCountryLabel } from '@/lib/country'
import { applyBorder, applyHeaderBorder, applyRowBorder } from '@/lib/excel-styles'
import { COUNTRY_OPTIONS } from '@/lib/console-constants'
import { CountrySelect, RefreshButton } from '@/components/dashboard/console'
import { SnapshotSelector } from '@/components/dashboard/inventory-replenishment/snapshot-selector'
import { CreateSnapshotDialog } from '@/components/dashboard/inventory-replenishment/create-snapshot-dialog'
import { EditSnapshotDialog } from '@/components/dashboard/inventory-replenishment/edit-snapshot-dialog'
import type { SnapshotOption } from '@/components/dashboard/inventory-replenishment/snapshot-selector'
import { CockpitOverview } from '@/components/dashboard/inventory-replenishment/cockpit/cockpit-overview'
import { DecisionCockpit } from '@/components/dashboard/inventory-replenishment/cockpit/decision-cockpit'

// recharts 强依赖 window/document，必须 ssr:false 才能从 inventory 页面 bundle 拆出 recharts 主体
// 日历视图只在切到「日历」Tab 时才需要，dynamic 化后默认 Tab 切换不会拉 recharts
const LazyCalendarView = dynamic(
  () =>
    import('@/components/dashboard/inventory-replenishment/calendar-view').then(
      (m) => m.CalendarView
    ),
  {
    ssr: false,
    loading: () => (
      <div className="dashboard-surface space-y-3 rounded-xl p-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-8 w-24" />
        </div>
        <Skeleton className="h-[400px] w-full rounded-lg" />
      </div>
    ),
  }
)

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
  // v1.2: 三段式 state 计数
  critical_count?: number
  deteriorating_count?: number
  watch_count?: number
  healthy_count_v2?: number
  unknown_count?: number
}

type AnalysisRow = {
  project_id: number
  project_name: string
  sku: string
  country: string
  asin: string | null
  product_name: string | null
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
  // v1.2 三段式产物（可选，向后兼容）
  inventory_state?: string
  replenishment_action?: string
  signals?: {
    sellable_days?: number | null
    dms_3?: number | null
    dms_7?: number | null
    dms_14?: number | null
    dms_30?: number | null
    trend_ratio_7_30?: number | null
    trend_ratio_3_7?: number | null
    trend_label?: string | null
    trend_momentum?: string | null
    aging_share?: Record<string, number>
    transit_ratio?: number | null
    data_freshness_days?: number
    confidence?: string
    seasonal_factor?: number | null
    seasonal_phase?: string | null
    seasonal_source?: string | null
  } | null
  // BLF-502：决策路径解释（为什么是这个 state/action）
  decision_path?: {
    state_rule?: string | null
    critical_subtype?: string | null
    action_rule?: string | null
    seasonal_override?: boolean
    seasonal_phase_used?: string | null
  } | null
}

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
  critical_count: 0,
  deteriorating_count: 0,
  watch_count: 0,
  healthy_count_v2: 0,
  unknown_count: 0,
}

function authHeaders(): Record<string, string> {
  return {}
}

async function parseError(response: Response): Promise<string> {
  // 先读 text（body stream 只能读一次），再尝试 JSON 解析
  const text = await response.text()
  try {
    const payload = JSON.parse(text) as { detail?: string }
    return payload.detail || `请求失败 (${response.status})`
  } catch {
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

function riskMeta(riskStatus: string): { label: string; className: string } {
  const map: Record<string, { label: string; className: string }> = {
    长期断货: {
      label: '长期断货',
      className:
        'border-rose-300 bg-rose-200 text-rose-800 dark:border-rose-900 dark:bg-rose-950/70 dark:text-rose-200',
    },
    短期断货: {
      label: '短期断货',
      className:
        'border-orange-200 bg-orange-100 text-orange-700 dark:border-orange-900/80 dark:bg-orange-950/50 dark:text-orange-300',
    },
    断货风险: {
      label: '断货风险',
      className:
        'border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-900/80 dark:bg-rose-950/50 dark:text-rose-300',
    },
    健康库存: {
      label: '健康库存',
      className:
        'border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-900/80 dark:bg-emerald-950/50 dark:text-emerald-300',
    },
    滞销: {
      label: '滞销',
      className:
        'border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-900/80 dark:bg-amber-950/50 dark:text-amber-300',
    },
    严重滞销: {
      label: '严重滞销',
      className:
        'border-fuchsia-200 bg-fuchsia-100 text-fuchsia-700 dark:border-fuchsia-900/80 dark:bg-fuchsia-950/50 dark:text-fuchsia-300',
    },
    待补数据: {
      label: '待补数据',
      className:
        'border-border/70 bg-[hsl(var(--surface-soft))] text-muted-foreground dark:border-border/80 dark:bg-[hsl(var(--surface-strong))] dark:text-foreground/72',
    },
  }
  return (
    map[riskStatus] || {
      label: riskStatus,
      className:
        'border-border/70 bg-[hsl(var(--surface-soft))] text-muted-foreground dark:border-border/80 dark:bg-[hsl(var(--surface-strong))] dark:text-foreground/72',
    }
  )
}

// v1.2: 三段式产物的颜色映射
function stateMeta(state: string | undefined): { label: string; className: string } {
  const map: Record<string, { label: string; className: string }> = {
    critical: {
      label: '危险',
      className:
        'border-rose-300 bg-rose-100 text-rose-700 dark:border-rose-900/80 dark:bg-rose-950/50 dark:text-rose-300',
    },
    deteriorating: {
      label: '趋势转差',
      className:
        'border-orange-200 bg-orange-100 text-orange-700 dark:border-orange-900/80 dark:bg-orange-950/50 dark:text-orange-300',
    },
    watch: {
      label: '关注',
      className:
        'border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-900/80 dark:bg-amber-950/50 dark:text-amber-300',
    },
    healthy: {
      label: '健康',
      className:
        'border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-900/80 dark:bg-emerald-950/50 dark:text-emerald-300',
    },
    unknown: {
      label: '数据缺失',
      className:
        'border-border/70 bg-[hsl(var(--surface-soft))] text-muted-foreground dark:border-border/80 dark:bg-[hsl(var(--surface-strong))] dark:text-foreground/72',
    },
  }
  return (
    map[state ?? ''] || {
      label: state ?? '—',
      className:
        'border-border/70 bg-[hsl(var(--surface-soft))] text-muted-foreground dark:border-border/80 dark:bg-[hsl(var(--surface-strong))] dark:text-foreground/72',
    }
  )
}

function actionMeta(action: string | undefined): { label: string; className: string } {
  const map: Record<string, { label: string; className: string }> = {
    REPLENISH_NOW: {
      label: '紧急补货',
      className:
        'border-rose-300 bg-rose-100 text-rose-700 dark:border-rose-900/80 dark:bg-rose-950/50 dark:text-rose-300',
    },
    REPLENISH_NORMAL: {
      label: '按计划补货',
      className:
        'border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-900/80 dark:bg-sky-950/50 dark:text-sky-300',
    },
    HOLD: {
      label: '暂停补货',
      className:
        'border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-900/80 dark:bg-amber-950/50 dark:text-amber-300',
    },
    REDUCE_PRICE: {
      label: '降价清货',
      className:
        'border-orange-200 bg-orange-100 text-orange-700 dark:border-orange-900/80 dark:bg-orange-950/50 dark:text-orange-300',
    },
    REMOVE: {
      label: '创建移除订单',
      className:
        'border-fuchsia-200 bg-fuchsia-100 text-fuchsia-700 dark:border-fuchsia-900/80 dark:bg-fuchsia-950/50 dark:text-fuchsia-300',
    },
    NO_ACTION: {
      label: '不动',
      className:
        'border-border/70 bg-[hsl(var(--surface-soft))] text-muted-foreground dark:border-border/80 dark:bg-[hsl(var(--surface-strong))] dark:text-foreground/72',
    },
  }
  return (
    map[action ?? ''] || {
      label: action ?? '—',
      className:
        'border-border/70 bg-[hsl(var(--surface-soft))] text-muted-foreground dark:border-border/80 dark:bg-[hsl(var(--surface-strong))] dark:text-foreground/72',
    }
  )
}

function shipmentStatusMeta(status: string): { label: string; className: string } {
  const map: Record<string, { label: string; className: string }> = {
    draft: {
      label: '草稿',
      className:
        'border border-border/70 bg-[hsl(var(--surface-soft))] text-muted-foreground dark:border-border/80 dark:bg-[hsl(var(--surface-strong))] dark:text-foreground/72',
    },
    preparing: {
      label: '备货中',
      className:
        'border border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-900/80 dark:bg-amber-950/60 dark:text-amber-300',
    },
    in_transit: {
      label: '在途',
      className:
        'border border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-900/80 dark:bg-sky-950/60 dark:text-sky-300',
    },
    arrived_port: {
      label: '已到港',
      className:
        'border border-cyan-200 bg-cyan-100 text-cyan-700 dark:border-cyan-900/80 dark:bg-cyan-950/60 dark:text-cyan-300',
    },
    inbound_processing: {
      label: '入仓处理中',
      className:
        'border border-violet-200 bg-violet-100 text-violet-700 dark:border-violet-900/80 dark:bg-violet-950/60 dark:text-violet-300',
    },
    completed: {
      label: '完成',
      className:
        'border border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-900/80 dark:bg-emerald-950/60 dark:text-emerald-300',
    },
    cancelled: {
      label: '取消',
      className:
        'border border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-900/80 dark:bg-rose-950/60 dark:text-rose-300',
    },
  }
  return (
    map[status] || {
      label: status,
      className:
        'border border-border/70 bg-[hsl(var(--surface-soft))] text-muted-foreground dark:border-border/80 dark:bg-[hsl(var(--surface-strong))] dark:text-foreground/72',
    }
  )
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
  const { notify } = useNotifications()
  const { data: session } = useSession()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectId, setProjectId] = useState<string>(() => searchParams.get('project') || '')

  // 进入页面默认选中第一个真实项目,内容立即加载（跳过 all / 空白意图）
  useAutoSelectFirstProject(projects, projectId, setProjectId)
  const [country, setCountry] = useState(() => searchParams.get('country') || 'US')
  const [snapshotRefreshNonce, setSnapshotRefreshNonce] = useState(0)
  const initializedFromUrl = useRef(false)
  const [keyword, setKeyword] = useState('')
  const [riskFilter, setRiskFilter] = useState('all')
  // BLF-491：三段式客户端筛选（后端只支持 risk_status 服务端过滤）
  const [stateFilter, setStateFilter] = useState<string | null>(null)
  const [actionFilter, setActionFilter] = useState<string | null>(null)
  const deferredKeyword = useDeferredValue(keyword)

  const [rows, setRows] = useState<AnalysisRow[]>([])
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)

  const [edits, setEdits] = useState<Record<string, RowEditState>>({})
  const [savingSku, setSavingSku] = useState<string | null>(null)

  const [sheetOpen, setSheetOpen] = useState(false)
  const [selectedRow, setSelectedRow] = useState<AnalysisRow | null>(null)
  const [shipments, setShipments] = useState<ShipmentItem[]>([])
  const [shipmentsLoading, setShipmentsLoading] = useState(false)

  // Snapshot state
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<number | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [creatingSnapshot, setCreatingSnapshot] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editingSnapshot, setEditingSnapshot] = useState<SnapshotOption | null>(null)

  // View mode: cockpit (default) / table / calendar
  const [viewMode, setViewMode] = useState<'cockpit' | 'table' | 'calendar'>('cockpit')

  const isAdmin = Boolean(session?.user?.isAdmin)
  const isSnapshotMode = selectedSnapshotId !== null

  // BLF-491：三段式 state/action 客户端叠加筛选（作用于工作台/表格/导出）
  const filteredRows = useMemo(() => {
    if (!stateFilter && !actionFilter) return rows
    return rows.filter((row) => {
      if (stateFilter && (row.inventory_state ?? 'unknown') !== stateFilter) return false
      if (actionFilter && (row.replenishment_action ?? 'NO_ACTION') !== actionFilter) return false
      return true
    })
  }, [actionFilter, rows, stateFilter])

  const currentProjectId = useMemo(() => {
    const parsed = Number(projectId)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }, [projectId])

  function syncUrlParams(nextProjectId: string, nextCountry: string) {
    const params = new URLSearchParams()
    if (nextProjectId) params.set('project', nextProjectId)
    if (nextCountry) params.set('country', nextCountry)
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }

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
        }
      ),
    [rows]
  )

  useEffect(() => {
    let active = true
    async function loadProjects() {
      setProjectsLoading(true)
      try {
        const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
        if (!active) return
        setProjects(payload)
        if (payload.length > 0) {
          const urlProjectId = searchParams.get('project')
          const existsInList = urlProjectId && payload.some((p) => String(p.id) === urlProjectId)
          if (existsInList) {
            // URL has a valid projectId — keep it and mark as initialized
            if (!initializedFromUrl.current) {
              initializedFromUrl.current = true
            }
          } else if (!projectId || !existsInList) {
            // No valid projectId in URL, fall back to first
            setProjectId(String(payload[0].id))
            if (!initializedFromUrl.current) {
              initializedFromUrl.current = true
              syncUrlParams(String(payload[0].id), country)
            }
          }
        }
      } catch (loadError) {
        if (!active) return
        notify({
          type: 'error',
          title: '项目列表加载失败',
          message: loadError instanceof Error ? loadError.message : '项目列表加载失败',
        })
      } finally {
        if (active) setProjectsLoading(false)
      }
    }
    void loadProjects()
    return () => {
      active = false
    }
  }, [notify, projectId, session])

  useEffect(() => {
    if (!currentProjectId) {
      setRows([])
      setSummary(EMPTY_SUMMARY)
      return
    }
    let active = true
    async function loadAnalysis() {
      setLoading(true)
      try {
        let url: string
        let params = new URLSearchParams({
          country,
          page: '1',
          page_size: '200',
        })
        if (deferredKeyword.trim()) params.set('keyword', deferredKeyword.trim())
        if (riskFilter !== 'all') params.set('risk_status', riskFilter)

        if (selectedSnapshotId !== null) {
          // Load from snapshot
          url = `${API_BASE}/api/v1/inventory-replenishment-snapshots/${selectedSnapshotId}/items?${params.toString()}`
        } else {
          // Load real-time data
          params.set('project_id', String(currentProjectId))
          url = `${API_BASE}/api/v1/inventory-replenishment-analysis?${params.toString()}`
        }

        // BEL-423：只读分析数据走 2min 客户端缓存（重复 mount 0 请求）；
        // 保存行设置后的重载走 reloadAnalysis 的 force 路径。
        const payload = await fetchOpsJsonCached<AnalysisResponse>(url, { session })
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
        notify({
          type: 'error',
          title: '分析数据加载失败',
          message: loadError instanceof Error ? loadError.message : '分析数据加载失败',
        })
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadAnalysis()
    return () => {
      active = false
    }
  }, [
    notify,
    country,
    currentProjectId,
    deferredKeyword,
    refreshNonce,
    riskFilter,
    selectedSnapshotId,
    session,
  ])

  async function openShipments(row: AnalysisRow) {
    setSelectedRow(row)
    setSheetOpen(true)
    setShipmentsLoading(true)
    try {
      const params = new URLSearchParams({
        project_id: String(row.project_id),
        sku: row.sku,
      })
      const response = await fetch(
        `${API_BASE}/api/v1/inventory-replenishment-shipments?${params.toString()}`,
        {
          headers: authHeaders(),
          cache: 'no-store',
        }
      )
      if (!response.ok) throw new Error(await parseError(response))
      const payload = (await response.json()) as ShipmentResponse
      setShipments(payload.items)
    } catch (loadError) {
      setShipments([])
      notify({
        type: 'error',
        title: '发货信息加载失败',
        message: loadError instanceof Error ? loadError.message : '发货信息加载失败',
      })
    } finally {
      setShipmentsLoading(false)
    }
  }

  function parseRowEdit(
    row: AnalysisRow,
    edit: RowEditState
  ): {
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
    const response = await fetch(
      `${API_BASE}/api/v1/inventory-replenishment-settings/${row.project_id}/${encodeURIComponent(row.sku)}?${requestParams.toString()}`,
      {
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
      }
    )
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
    // BEL-423：保存后的重载必须拿最新数据，force 跳过缓存读取并覆写。
    const refreshed = await fetchOpsJsonCached<AnalysisResponse>(
      `${API_BASE}/api/v1/inventory-replenishment-analysis?${params.toString()}`,
      { session, force: true }
    )
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
    try {
      await persistRowSettings(row, edit)
      await reloadAnalysis()
    } catch (saveError) {
      notify({
        type: 'error',
        title: '保存失败',
        message: saveError instanceof Error ? saveError.message : '保存失败',
      })
    } finally {
      setSavingSku(null)
    }
  }

  async function refreshWithSave() {
    if (!currentProjectId || loading || refreshingAll) return
    setRefreshingAll(true)
    try {
      const changedRows = rows.filter((row) => {
        const edit = edits[rowKey(row)] || buildEditState(row)
        return (
          edit.production_lead_days !== String(row.production_lead_days) ||
          edit.shipping_days !== String(row.shipping_days) ||
          edit.safety_factor !== String(Math.round(row.safety_factor * 100))
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
      notify({
        type: 'error',
        title: '刷新失败',
        message: refreshError instanceof Error ? refreshError.message : '刷新失败',
      })
    } finally {
      setSavingSku(null)
      setRefreshingAll(false)
    }
  }

  async function exportToExcel() {
    if (filteredRows.length === 0) {
      notify({ type: 'error', title: '当前没有可导出的补货分析数据' })
      return
    }

    setExporting(true)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()

      const worksheet = workbook.addWorksheet('补货分析', {
        views: [{ state: 'frozen', ySplit: 1, xSplit: 1, showGridLines: false }],
      })

      const columns = [
        { header: 'SKU', key: 'sku', width: 18 },
        { header: '产品名称', key: 'product_name', width: 28 },
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
        // v1.2 三段式（spec §5.1）+ BLF-491 决策驾驶舱（趋势/置信度）
        { header: '状态', key: 'inventory_state', width: 12 },
        { header: '行动', key: 'replenishment_action', width: 14 },
        { header: '趋势', key: 'signals.trend_label', width: 12 },
        { header: '季节性', key: 'signals.seasonal_phase', width: 12 },
        { header: '置信度', key: 'signals.confidence', width: 10 },
      ] as const

      const selectedProjectName =
        projects.find((project) => String(project.id) === projectId)?.name ?? '全部项目'

      worksheet.columns = columns.map((column) => ({ key: column.key, width: column.width }))

      const headerRow = worksheet.getRow(1)
      headerRow.values = columns.map((column) => column.header)
      headerRow.height = 24
      headerRow.eachCell((cell) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
        applyHeaderBorder(cell)
      })

      filteredRows.forEach((row, index) => {
        const sheetRow = worksheet.getRow(index + 2)
        sheetRow.values = [
          row.sku,
          row.product_name || '-',
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
          // v1.2 三段式
          row.inventory_state || '-',
          row.replenishment_action || '-',
          row.signals?.trend_label || '-',
          row.signals?.seasonal_phase || '-',
          row.signals?.confidence || '-',
        ]

        // 显式遍历 1-21 列应用样式和边框：
        // 默认的 sheetRow.eachCell(cb) 会跳过 null 单元格，导致 dms_30 / weighted_dms /
        // sellable_days / estimated_replenishment_quantity 等列在数据缺失时缺少边框。
        // 改成 for 循环 + getCell(col) 可以保证每个单元格都被处理（与 totalRow 的
        // applyRowBorder(totalRow, 1, 24) 保持一致），且不改变原始数据（null 仍为 null）。
        for (let col = 1; col <= 26; col++) {
          const cell = sheetRow.getCell(col)
          cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
          cell.alignment = {
            vertical: 'middle',
            horizontal: col >= 3 && col <= 16 ? 'right' : 'left',
            // 产品名称列（col === 2）：单行显示，文本超出列宽时直接截断。
            // 完整品名以 cell.note 形式保留，鼠标悬停可看。
            // 其它列保留 wrapText 以防未来加长字段时溢出。
            // v1.2 新增列（22=状态, 23=行动, 24=季节性）都是文本，左对齐 + wrapText。
            wrapText: col !== 2,
          }
          // 产品名称完整文本写到 cell.note，鼠标悬停可看（不论是否被列宽截断）。
          if (col === 2 && row.product_name && row.product_name !== '-') {
            cell.note = row.product_name
          }
          if (col === 21) {
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
          if (col === 3 || col === 4 || col === 15 || col === 16) cell.numFmt = '#,##0'
          if (col >= 5 && col <= 9) cell.numFmt = '0.0000'
          if (col === 10) cell.numFmt = '0.00%'
          if (col === 11 || col === 12) cell.numFmt = '0.00'
          if (col === 20) cell.numFmt = '#,##0'
          applyBorder(cell)
        }
      })

      const totalRow = worksheet.getRow(filteredRows.length + 2)
      totalRow.getCell(1).value = '筛选结果合计'
      totalRow.getCell(3).value = tableTotals.available_inventory
      totalRow.getCell(4).value = tableTotals.in_transit_quantity
      totalRow.getCell(5).value = tableTotals.dms_30
      totalRow.getCell(6).value = tableTotals.dms_14
      totalRow.getCell(7).value = tableTotals.dms_7
      totalRow.getCell(8).value = tableTotals.dms_3
      totalRow.getCell(9).value = tableTotals.base_dms
      totalRow.getCell(11).value = tableTotals.weighted_dms
      totalRow.getCell(20).value = tableTotals.estimated_replenishment_quantity
      totalRow.getCell(21).value = `SKU: ${summary.sku_count}`
      applyRowBorder(totalRow, 1, 26)
      totalRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.alignment = { vertical: 'middle', wrapText: true }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
      })
      totalRow.getCell(3).numFmt = '#,##0'
      totalRow.getCell(4).numFmt = '#,##0'
      totalRow.getCell(5).numFmt = '0.0000'
      totalRow.getCell(6).numFmt = '0.0000'
      totalRow.getCell(7).numFmt = '0.0000'
      totalRow.getCell(8).numFmt = '0.0000'
      totalRow.getCell(9).numFmt = '0.0000'
      totalRow.getCell(11).numFmt = '0.00'
      totalRow.getCell(20).numFmt = '#,##0'

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const safeTimestamp = formatLocalTimestampForFilename()
      const safeProjectName = (selectedProjectName || '未选项目').replace(/[\\/:*?"<>|]/g, '-')
      const safeCountryLabel = getCountryLabel(country).replace(/[\\/:*?"<>|]/g, '-')
      link.href = url
      link.download = `${safeProjectName}_${safeCountryLabel}-补货分析-${safeTimestamp}.xlsx`
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
          row_count: filteredRows.length,
          filename: link.download,
        },
      })
    } catch (exportError) {
      notify({
        type: 'error',
        title: '导出 Excel 失败',
        message: exportError instanceof Error ? exportError.message : '导出 Excel 失败',
      })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="w-full space-y-6">
      {/* 控制台 — 头部 = 页面 PILL + 右侧操作（BLF-634：汉字换 PILL，与操作按钮等高） */}
      <div className="dashboard-surface">
        {/* 标题行 */}
        <div className="flex flex-col gap-3 border-b border-border/70 bg-[hsl(var(--surface-subtle))] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div />
          <div className="flex flex-wrap items-center gap-2">
            <SnapshotSelector
              projectId={currentProjectId}
              country={country}
              selectedSnapshotId={selectedSnapshotId}
              onSnapshotSelect={setSelectedSnapshotId}
              onCreateSnapshot={() => setCreateDialogOpen(true)}
              onEditSnapshot={(snapshot) => {
                setEditingSnapshot(snapshot)
                setEditDialogOpen(true)
              }}
              disabled={!currentProjectId || loading}
              refreshNonce={snapshotRefreshNonce}
              isAdmin={isAdmin}
              onDeleteSnapshot={() => setSnapshotRefreshNonce((n) => n + 1)}
            />
            {!isSnapshotMode && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!currentProjectId || loading || refreshingAll}
                onClick={() => void refreshWithSave()}
              >
                <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                {loading || refreshingAll ? '重算中...' : '刷新重算'}
              </Button>
            )}
          </div>
        </div>

        {/* 筛选项（BLF-505：收口为 FilterToolbar 原语 §8.2）
         * BLF-629：字段外层 w-full 在桌面 md:flex 容器里占满整行导致竖排，
         * 加 md:w-auto 让桌面按内容宽度横排（手机 2 列网格仍由 w-full 撑满）。
         */}
        <FilterToolbar>
          <div className="w-full min-w-0 md:w-auto">
            {projectsLoading ? (
              <Skeleton className="h-9 w-full rounded-lg md:w-[180px]" />
            ) : (
              <Select
                value={projectId}
                onValueChange={(id) => {
                  setProjectId(id)
                  setSelectedSnapshotId(null)
                  syncUrlParams(id, country)
                }}
              >
                <SelectTrigger className="h-9 w-full rounded-lg border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground md:w-[180px]">
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
          <div className="w-full min-w-0 md:w-auto">
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索 SKU / ASIN"
              className="h-9 w-full rounded-lg border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground md:w-[200px]"
            />
          </div>
          <div className="w-full min-w-0 md:w-auto">
            <CountrySelect
              value={country}
              onChange={(c) => {
                setCountry(c)
                setSelectedSnapshotId(null)
                syncUrlParams(projectId, c)
              }}
              triggerClassName="h-9 w-full rounded-lg border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground md:w-[140px]"
            />
          </div>
          <div className="w-full min-w-0 md:w-auto">
            <Select value={riskFilter} onValueChange={setRiskFilter}>
              <SelectTrigger className="h-9 w-full rounded-lg border-border/70 bg-[hsl(var(--surface-panel))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground md:w-[160px]">
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
        </FilterToolbar>

        {/* 统计条 → 三段式指挥带（BLF-491） */}
        <div className="border-t border-border/70 px-4 py-3">
          <CockpitOverview
            rows={filteredRows}
            summary={summary}
            loading={loading}
            stateFilter={stateFilter}
            actionFilter={actionFilter}
            onStateFilter={setStateFilter}
            onActionFilter={setActionFilter}
          />
        </div>
      </div>

      <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as 'cockpit' | 'table' | 'calendar')}>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <TabsList variant="term" className="w-fit justify-start">
            <TabsTrigger value="cockpit" variant="term">
              <Gauge aria-hidden />
              决策工作台
            </TabsTrigger>
            <TabsTrigger value="table" variant="term">
              <LayoutGrid aria-hidden />
              表格视图
            </TabsTrigger>
            <TabsTrigger value="calendar" variant="term">
              <CalendarDays aria-hidden />
              日历视图
            </TabsTrigger>
          </TabsList>
          {viewMode !== 'calendar' && (
            <Button
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
              disabled={loading || exporting || filteredRows.length === 0}
              onClick={() => void exportToExcel()}
            >
              <FileDown className="h-3.5 w-3.5" />
              {exporting ? '导出中...' : '导出 Excel'}
            </Button>
          )}
        </div>

        <TabsContent value="cockpit">
          {!currentProjectId && !projectsLoading ? (
            <div className="dashboard-surface px-6 py-16 text-center text-sm text-muted-foreground">
              请先选择项目。
            </div>
          ) : loading && filteredRows.length === 0 ? (
            <div className="dashboard-surface space-y-3 p-6">
              <Skeleton className="h-40 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : (
            <DecisionCockpit
              rows={filteredRows}
              isSnapshotMode={isSnapshotMode}
              edits={edits}
              savingSku={savingSku}
              rowKeyOf={rowKey}
              onEditChange={(key, patch) =>
                setEdits((prev) => {
                  const existing = prev[key]
                  if (existing) return { ...prev, [key]: { ...existing, ...patch } }
                  const row = rows.find((r) => rowKey(r) === key)
                  if (!row) return prev
                  return { ...prev, [key]: { ...buildEditState(row), ...patch } }
                })
              }
              onSaveRow={(row) => void saveRow(row)}
              onOpenShipments={(row) => void openShipments(row)}
            />
          )}
        </TabsContent>

        <TabsContent value="table">
          {/* 共享的加载/空状态 */}
          {!currentProjectId && !projectsLoading ? (
            <div className="dashboard-surface px-6 py-16 text-center text-sm text-muted-foreground">
              请先选择项目。
            </div>
          ) : loading && rows.length === 0 ? (
            <div className="dashboard-surface space-y-3 p-6">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <div className="dashboard-surface px-6 py-16 text-center text-sm text-muted-foreground">
              当前筛选条件下没有可分析的 SKU。
            </div>
          ) : (
            <>
              {/* 桌面端：完整表格 */}
              <div className="hidden md:block">
                <DataTableCard>
                  <DataTableCardHeader className="px-4 py-3">
                    <div className="space-y-1">
                      <h3 className="text-base font-semibold text-foreground">SKU 补货主表</h3>
                    </div>
                  </DataTableCardHeader>
                  <DataTableCardBody>
                    <div className="relative">
                      {loading && rows.length > 0 ? (
                        <div className="pointer-events-none absolute right-4 top-4 z-20 rounded-full border border-border/70 bg-[hsl(var(--surface-panel))/0.95] px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))/0.96] dark:text-foreground/72">
                          补货主表更新中...
                        </div>
                      ) : null}
                      <Table
                        containerClassName="max-h-[72vh] overflow-auto border-t border-border/70 bg-transparent dark:border-border/85 rounded-none"
                        className="min-w-[2050px] table-auto border-separate border-spacing-0 bg-transparent text-[13px]"
                      >
                        <TableHeader>
                          <TableRow className="bg-transparent">
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} ${STICKY_LEFT_HEAD_CELL} min-w-[132px]`}
                            >
                              SKU
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[200px]`}
                            >
                              产品名称
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[96px] text-right`}
                            >
                              店铺库存
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[88px] text-right`}
                            >
                              在途
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[72px] text-right`}
                            >
                              30D
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[72px] text-right`}
                            >
                              14D
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[72px] text-right`}
                            >
                              7D
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[72px] text-right`}
                            >
                              3D
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[88px] text-right`}
                            >
                              DMS
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[112px]`}
                            >
                              加权系数
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[100px] text-right`}
                            >
                              加权DMS
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[100px] text-right`}
                            >
                              可售天数
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[116px]`}
                            >
                              售卖截止
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[116px]`}
                            >
                              含在途截止
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[104px]`}
                            >
                              生产交货
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[104px]`}
                            >
                              运输时间
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[116px]`}
                            >
                              补货指令
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[116px]`}
                            >
                              建仓指令
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[116px]`}
                            >
                              发货指令
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[104px]`}
                            >
                              预计数量
                            </TableHead>
                            {/* v1.2: 三段式产物 */}
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[104px]`}
                            >
                              状态
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[116px]`}
                            >
                              行动
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[104px]`}
                            >
                              风险状态
                            </TableHead>
                            <TableHead
                              className={`h-11 whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground last:border-r-0 dark:border-border/80 dark:text-foreground/72 ${STICKY_TOP_ROW} min-w-[154px]`}
                            >
                              操作
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          <>
                            {rows.map((row) => {
                              const key = rowKey(row)
                              const edit = edits[key] || buildEditState(row)
                              const risk = riskMeta(row.risk_status)
                              const invState = stateMeta(row.inventory_state)
                              const action = actionMeta(row.replenishment_action)
                              return (
                                <TableRow
                                  key={key}
                                  className="group align-top odd:bg-[hsl(var(--surface-panel))] even:bg-[hsl(var(--surface-overlay))] hover:bg-sky-50/80 dark:odd:bg-[hsl(var(--surface-panel))] dark:even:bg-[hsl(var(--surface-overlay))] dark:hover:bg-sky-950/20"
                                >
                                  <TableCell
                                    className={`whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 ${STICKY_LEFT_CELL_HOVER} font-medium`}
                                  >
                                    {row.sku}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 font-medium text-foreground">
                                    {row.product_name || '--'}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                    {formatInt(row.available_inventory)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                    {formatInt(row.in_transit_quantity)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                    {formatNumber(row.dms_30)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                    {formatNumber(row.dms_14)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                    {formatNumber(row.dms_7)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                    {formatNumber(row.dms_3)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right font-medium text-foreground">
                                    {formatNumber(row.base_dms)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80">
                                    {isSnapshotMode ? (
                                      <span>{formatNumber(row.safety_factor)}%</span>
                                    ) : (
                                      <div className="flex items-center gap-2">
                                        <Input
                                          value={edit.safety_factor}
                                          onChange={(event) =>
                                            setEdits((prev) => ({
                                              ...prev,
                                              [key]: { ...edit, safety_factor: event.target.value },
                                            }))
                                          }
                                          className="h-8 w-[72px] rounded-md border-border/70 bg-[hsl(var(--surface-panel))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground"
                                        />
                                        <span className="text-xs text-muted-foreground">%</span>
                                      </div>
                                    )}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right font-medium text-foreground">
                                    {formatNumber(row.weighted_dms)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                    {formatNumber(row.sellable_days)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80">
                                    {formatDate(row.sellout_date)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80">
                                    {formatDate(row.sellout_date_with_transit)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80">
                                    {isSnapshotMode ? (
                                      <span>{row.production_lead_days}</span>
                                    ) : (
                                      <Input
                                        value={edit.production_lead_days}
                                        onChange={(event) =>
                                          setEdits((prev) => ({
                                            ...prev,
                                            [key]: {
                                              ...edit,
                                              production_lead_days: event.target.value,
                                            },
                                          }))
                                        }
                                        className="h-8 w-[72px] rounded-md border-border/70 bg-[hsl(var(--surface-panel))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground"
                                      />
                                    )}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80">
                                    {isSnapshotMode ? (
                                      <span>{row.shipping_days}</span>
                                    ) : (
                                      <Input
                                        value={edit.shipping_days}
                                        onChange={(event) =>
                                          setEdits((prev) => ({
                                            ...prev,
                                            [key]: { ...edit, shipping_days: event.target.value },
                                          }))
                                        }
                                        className="h-8 w-[72px] rounded-md border-border/70 bg-[hsl(var(--surface-panel))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground"
                                      />
                                    )}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80">
                                    {formatDate(row.replenishment_order_date)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80">
                                    {formatDate(row.warehouse_entry_date)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80">
                                    {formatDate(row.shipment_order_date)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right font-medium text-foreground">
                                    {formatInt(row.estimated_replenishment_quantity)}
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80">
                                    <Badge variant="outline" className={invState.className}>
                                      {invState.label}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80">
                                    <Badge variant="outline" className={action.className}>
                                      {action.label}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80">
                                    <Badge variant="outline" className={risk.className}>
                                      {risk.label}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80">
                                    <div className="flex flex-col gap-1.5">
                                      <div className="flex items-center gap-2">
                                        {!isSnapshotMode && (
                                          <Button
                                            size="sm"
                                            className="h-8 gap-1.5 whitespace-nowrap px-2.5 text-xs dark:bg-[hsl(var(--surface-strong))] dark:text-foreground"
                                            onClick={() => void saveRow(row)}
                                            disabled={savingSku === key}
                                          >
                                            {savingSku === key ? (
                                              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                            ) : (
                                              <Save className="mr-1.5 h-3.5 w-3.5" />
                                            )}
                                            保存
                                          </Button>
                                        )}
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
                              <TableCell
                                className={`whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 ${STICKY_LEFT_CELL_HOVER}`}
                              >
                                合计
                              </TableCell>
                              <TableCell
                                className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80"
                                colSpan={1}
                              />
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                {formatInt(tableTotals.available_inventory)}
                              </TableCell>
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                {formatInt(tableTotals.in_transit_quantity)}
                              </TableCell>
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                {formatNumber(tableTotals.dms_30, 4)}
                              </TableCell>
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                {formatNumber(tableTotals.dms_14, 4)}
                              </TableCell>
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                {formatNumber(tableTotals.dms_7, 4)}
                              </TableCell>
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                {formatNumber(tableTotals.dms_3, 4)}
                              </TableCell>
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                {formatNumber(tableTotals.base_dms, 4)}
                              </TableCell>
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80" />
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                {formatNumber(tableTotals.weighted_dms)}
                              </TableCell>
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80" />
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80" />
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80" />
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80" />
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80" />
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80" />
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80" />
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80" />
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80 text-right">
                                {formatInt(tableTotals.estimated_replenishment_quantity)}
                              </TableCell>
                              {/* v1.2: 状态 / 行动总计空位（不计算总计） */}
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80" />
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80" />
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80">{`SKU: ${formatInt(summary.sku_count)}`}</TableCell>
                              <TableCell className="whitespace-nowrap border-b border-r border-border/70 px-3 py-2.5 align-middle text-[13px] text-foreground/88 last:border-r-0 dark:border-border/80 dark:text-foreground/80" />
                            </TableRow>
                          </>
                        </TableBody>
                      </Table>
                    </div>
                  </DataTableCardBody>
                </DataTableCard>
              </div>

              {/* 手机端：卡片列表 */}
              <div className="md:hidden space-y-3">
                {loading && rows.length > 0 ? (
                  <div className="text-center text-xs text-muted-foreground py-2">
                    补货主表更新中...
                  </div>
                ) : null}
                {rows.map((row) => {
                  const key = rowKey(row)
                  const edit = edits[key] || buildEditState(row)
                  const risk = riskMeta(row.risk_status)
                  const invState = stateMeta(row.inventory_state)
                  const action = actionMeta(row.replenishment_action)
                  return (
                    <div key={key} className="dashboard-surface p-4 space-y-3">
                      {/* 头部：SKU + 状态 + 行动 */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-semibold text-sm text-foreground truncate">
                            {row.sku}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Badge variant="outline" className={cn('text-xs', invState.className)}>
                            {invState.label}
                          </Badge>
                          <Badge variant="outline" className={cn('text-xs', action.className)}>
                            {action.label}
                          </Badge>
                          <Badge variant="outline" className={cn('text-xs', risk.className)}>
                            {risk.label}
                          </Badge>
                        </div>
                      </div>

                      {/* 产品名称 */}
                      {row.product_name && (
                        <div className="text-xs text-muted-foreground">
                          产品名称: {row.product_name}
                        </div>
                      )}

                      {/* 核心数据 2 列网格 */}
                      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        <div>
                          <span className="text-xs text-muted-foreground">店铺库存</span>
                          <div className="font-medium text-foreground">
                            {formatInt(row.available_inventory)}
                          </div>
                        </div>
                        <div>
                          <span className="text-xs text-muted-foreground">在途</span>
                          <div className="font-medium text-foreground">
                            {formatInt(row.in_transit_quantity)}
                          </div>
                        </div>
                        <div>
                          <span className="text-xs text-muted-foreground">DMS (加权)</span>
                          <div className="font-medium text-foreground">
                            {formatNumber(row.weighted_dms)}
                          </div>
                        </div>
                        <div>
                          <span className="text-xs text-muted-foreground">可售天数</span>
                          <div className="font-medium text-foreground">
                            {formatNumber(row.sellable_days)}
                          </div>
                        </div>
                      </div>

                      {/* 日期信息 */}
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <div>售卖截止: {formatDate(row.sellout_date)}</div>
                        <div>含在途: {formatDate(row.sellout_date_with_transit)}</div>
                        <div>补货指令: {formatDate(row.replenishment_order_date)}</div>
                        <div>发货指令: {formatDate(row.shipment_order_date)}</div>
                      </div>

                      {/* 可编辑字段 */}
                      <div className="border-t border-border/70 pt-3">
                        <div className="grid grid-cols-3 gap-2">
                          <div className="space-y-1">
                            <div className="text-[11px] text-muted-foreground">生产交货</div>
                            {isSnapshotMode ? (
                              <div className="h-8 flex items-center text-sm">
                                {row.production_lead_days} 天
                              </div>
                            ) : (
                              <Input
                                value={edit.production_lead_days}
                                onChange={(event) =>
                                  setEdits((prev) => ({
                                    ...prev,
                                    [key]: { ...edit, production_lead_days: event.target.value },
                                  }))
                                }
                                className="h-8 text-xs rounded-md border-border/70 bg-[hsl(var(--surface-panel))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground"
                              />
                            )}
                          </div>
                          <div className="space-y-1">
                            <div className="text-[11px] text-muted-foreground">运输时间</div>
                            {isSnapshotMode ? (
                              <div className="h-8 flex items-center text-sm">
                                {row.shipping_days} 天
                              </div>
                            ) : (
                              <Input
                                value={edit.shipping_days}
                                onChange={(event) =>
                                  setEdits((prev) => ({
                                    ...prev,
                                    [key]: { ...edit, shipping_days: event.target.value },
                                  }))
                                }
                                className="h-8 text-xs rounded-md border-border/70 bg-[hsl(var(--surface-panel))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground"
                              />
                            )}
                          </div>
                          <div className="space-y-1">
                            <div className="text-[11px] text-muted-foreground">加权系数</div>
                            {isSnapshotMode ? (
                              <div className="h-8 flex items-center text-sm">
                                {formatNumber(row.safety_factor)}%
                              </div>
                            ) : (
                              <div className="flex items-center gap-1">
                                <Input
                                  value={edit.safety_factor}
                                  onChange={(event) =>
                                    setEdits((prev) => ({
                                      ...prev,
                                      [key]: { ...edit, safety_factor: event.target.value },
                                    }))
                                  }
                                  className="h-8 text-xs rounded-md border-border/70 bg-[hsl(var(--surface-panel))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground"
                                />
                                <span className="text-xs text-muted-foreground">%</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* 预计补货数量 */}
                      {row.estimated_replenishment_quantity !== null && (
                        <div className="text-sm">
                          <span className="text-xs text-muted-foreground">预计补货数量: </span>
                          <span className="font-medium text-foreground">
                            {formatInt(row.estimated_replenishment_quantity)}
                          </span>
                        </div>
                      )}

                      {/* 操作按钮 */}
                      <div className="flex gap-2 pt-1">
                        {!isSnapshotMode && (
                          <Button
                            size="sm"
                            className="h-9 flex-1 gap-1.5 text-xs dark:bg-[hsl(var(--surface-strong))] dark:text-foreground"
                            onClick={() => void saveRow(row)}
                            disabled={savingSku === key}
                          >
                            {savingSku === key ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Save className="h-3.5 w-3.5" />
                            )}
                            保存
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          className={cn(
                            'h-9 gap-1.5 text-xs dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:text-foreground',
                            isSnapshotMode ? 'w-full' : 'flex-1'
                          )}
                          onClick={() => void openShipments(row)}
                        >
                          <Send className="h-3.5 w-3.5" />
                          查看发货
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="calendar">
          <LazyCalendarView projectId={currentProjectId} country={country} />
        </TabsContent>
      </Tabs>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="right"
          className="w-full overflow-y-auto dark:border-border/85 dark:bg-[hsl(var(--surface-panel))] sm:max-w-2xl"
        >
          <SheetHeader>
            <SheetTitle className="dark:text-foreground">
              {selectedRow ? `${selectedRow.sku} 发货信息` : '发货信息'}
            </SheetTitle>
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
                    <div className="mt-1 text-lg font-semibold text-foreground">
                      {selectedRow.sku}
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-border/70 dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]">
                  <CardContent className="pt-6">
                    <div className="text-xs text-muted-foreground">店铺库存</div>
                    <div className="mt-1 text-lg font-semibold text-foreground">
                      {formatInt(selectedRow.available_inventory)}
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-border/70 dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]">
                  <CardContent className="pt-6">
                    <div className="text-xs text-muted-foreground">在途数量</div>
                    <div className="mt-1 text-lg font-semibold text-foreground">
                      {formatInt(selectedRow.in_transit_quantity)}
                    </div>
                  </CardContent>
                </Card>
              </div>

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
                      <div
                        key={`${item.schedule_id}-${item.shipment_no}`}
                        className="rounded-lg border border-border/70 bg-[hsl(var(--surface-panel))] p-4 shadow-sm dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))] dark:shadow-none"
                      >
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <div className="font-semibold text-foreground">
                                {item.shipment_no}
                              </div>
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
                                window.open(
                                  `/dashboard/operations/shipment-management?${params.toString()}`,
                                  '_blank',
                                  'noopener,noreferrer'
                                )
                              }}
                            >
                              <Send className="mr-1.5 h-3.5 w-3.5" />
                              去管理
                            </Button>
                          </div>
                        </div>
                        {item.remark ? (
                          <div className="mt-3 rounded-lg bg-[hsl(var(--surface-soft))] px-3 py-2 text-sm text-foreground/80 dark:bg-[hsl(var(--surface-strong))]">
                            {item.remark}
                          </div>
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
                <span className="mr-2 inline-flex rounded-md bg-[hsl(var(--surface-soft))] px-2 py-0.5 text-xs font-medium text-foreground/80 dark:bg-[hsl(var(--surface-strong))]">
                  风险状态
                </span>
                按 <code>含在途截止 - today</code> 判定；若销量数据缺失，则状态为待补数据。
              </div>
              <div className="rounded-xl border border-border/70 bg-[hsl(var(--surface-panel))]/90 px-3 py-2.5 leading-6 dark:border-border/80 dark:bg-[hsl(var(--surface-overlay))]/90">
                <span className="mr-2 inline-flex rounded-md bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
                  预计数量
                </span>
                按 <code>(生产交货时间 + 运输时间) × 加权DMS</code>{' '}
                计算；滞销与严重滞销状态不显示预计补货数量，其余状态在存在有效 <code>加权DMS</code>{' '}
                时显示。
              </div>
              <div className="rounded-xl border border-border/70 bg-[hsl(var(--surface-panel))]/90 px-3 py-2.5 leading-6 dark:border-border/80 dark:bg-[hsl(var(--surface-overlay))]/90">
                <span className="mr-2 inline-flex rounded-md bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-950/60 dark:text-sky-300">
                  销量来源
                </span>
                近 <code>30D / 14D / 7D / 3D</code> 全部改为取 <code>sales_report</code> 明细，其中{' '}
                <code>3D</code> 使用滞后 2 天窗口。
              </div>
              <div className="rounded-xl border border-border/70 bg-[hsl(var(--surface-panel))]/90 px-3 py-2.5 leading-6 dark:border-border/80 dark:bg-[hsl(var(--surface-overlay))]/90">
                <span className="mr-2 inline-flex rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                  权重规则
                </span>
                默认按 <code>30D 10%</code>、<code>14D 30%</code>、<code>7D 30%</code>、
                <code>3D 30%</code> 计算；若 <code>3D</code> 缺失，则其 <code>30%</code>{' '}
                权重全部并给 <code>7D</code>。
              </div>
              <div className="rounded-xl border border-border/70 bg-[hsl(var(--surface-panel))]/90 px-3 py-2.5 leading-6 dark:border-border/80 dark:bg-[hsl(var(--surface-overlay))]/90">
                <span className="mr-2 inline-flex rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
                  窗口示例
                </span>
                若今天是 <code>2026-03-09</code>，则 <code>3D</code> 取 <code>2026-03-05</code> 到{' '}
                <code>2026-03-07</code>。如果当前项目该窗口内没有导入、SKU 未匹配或无可计销量，则{' '}
                <code>3D</code> 显示 <code>--</code>。
              </div>
            </div>
          </div>
        </div>
      </div>

      <CreateSnapshotDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        projectId={currentProjectId}
        country={country}
        onSuccess={(snapshotId) => {
          setSelectedSnapshotId(snapshotId)
          setSnapshotRefreshNonce((n) => n + 1)
        }}
      />

      {editingSnapshot && (
        <EditSnapshotDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          snapshotId={editingSnapshot.id}
          initialName={editingSnapshot.name}
          initialDescription={editingSnapshot.description}
          onSuccess={() => {
            setSnapshotRefreshNonce((n) => n + 1)
          }}
        />
      )}
    </div>
  )
}
