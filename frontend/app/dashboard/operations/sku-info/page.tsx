'use client'

import { type ChangeEvent, Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import {
  FileDown,
  FileText,
  Image as ImageIcon,
  Package2,
  RefreshCw,
  Ruler,
  Tag,
  Upload,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { HoverCard } from '@/components/ui/hover-card'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { UploadZone } from '@/components/ui/upload-zone'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import {
  DataTableCard,
  DataTableCardHeader,
  DataTableCardBody,
} from '@/components/ui/data-card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { PagePill } from '@/components/ui/page-pill'
import {
  DirectionalTabTransition,
  SlidingTabsTrigger,
  TabsMotionGroup,
} from '@/components/ui/tab-motion'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import FactoryInfoSheet from '@/components/dashboard/sku-info/factory-info-sheet'
import BatchFactoryInfoSheet from '@/components/dashboard/sku-info/batch-factory-info-sheet'
import { ImageTabContent } from '@/components/dashboard/sku-info/image-tab'
import { normalizeErrorMessage, parseResponseError } from '@/lib/error-utils'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { getCountryLabel } from '@/lib/country'
import { formatLocalTimestampForFilename } from '@/lib/utils'
import { formatInch, formatLb } from '@/lib/unit-convert'

export type ProductCostItem = {
  id: number
  project_name: string
  sku: string
  asin: string
  fnsku: string | null
  product_name: string | null
  fob_unit_cost: number
  first_leg_cost_rmb: number
  package_length_cm: number
  package_width_cm: number
  package_height_cm: number
  weight_kg: number
  carton_length_cm: number
  carton_width_cm: number
  carton_height_cm: number
  carton_weight_kg: number
  units_per_carton: number
  currency: string
  country: string
  sort_order: number
  is_active: boolean
  sku_factory_info: Record<string, unknown> | null
  sku_factory_info_updated_at: string | null
  sku_factory_info_updated_by: string | null
  fnsku_label_r2_key?: string | null
  fnsku_label_r2_url?: string | null
  product_image_r2_key?: string | null
  product_image_r2_url?: string | null
  product_image_thumbnail_r2_key?: string | null
  product_image_thumbnail_r2_url?: string | null
  product_image_uploaded_at?: string | null
  product_image_uploaded_by?: string | null
  historical_first_leg_cost_rmb?: number | null
  marketplace_url?: string | null
}

type ProductCostsPage = {
  items: ProductCostItem[]
  page: number
  page_size: number
  total: number | null
  has_next: boolean
}

type ProjectOption = {
  id?: number | null
  name: string
}

type ShipmentSkuSummaryItem = {
  sku: string
  average_logistics_unit_price: number
}

type ShipmentSkuSummaryResponse = {
  items: ShipmentSkuSummaryItem[]
}

type ActiveTab = 'cost' | 'dimension' | 'factory' | 'label' | 'image'
type ImportMode = 'create' | 'update'
const ACTIVE_TAB_ORDER: ActiveTab[] = ['cost', 'dimension', 'factory', 'label', 'image']

const API_BASE = '/api/backend'
const HISTORY_SHIPMENT_STATUSES = ['completed', 'in_transit'] as const
const PAGE_SIZE_OPTIONS = [20, 50, 100, 10000]
const DEFAULT_PAGE_SIZE = 10000
const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
] as const

function normalizeCountry(raw: string): 'US' | 'DE' | 'UK' | null {
  const normalized = raw.trim().toUpperCase()
  if (!normalized) return null
  if (
    normalized === 'US' ||
    normalized === 'USA' ||
    normalized === '美国' ||
    normalized === '美国站'
  )
    return 'US'
  if (
    normalized === 'DE' ||
    normalized === 'GERMANY' ||
    normalized === '德国' ||
    normalized === '德国站'
  )
    return 'DE'
  if (
    normalized === 'UK' ||
    normalized === 'GB' ||
    normalized === 'UNITED KINGDOM' ||
    normalized === '英国' ||
    normalized === '英国站'
  )
    return 'UK'
  return null
}

function authHeaders(): Record<string, string> {
  return {}
}

function escapeCsvCell(value: string | number | null | undefined): string {
  const text = String(value ?? '')
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`
  return text
}

function downloadCsvFile(
  filename: string,
  header: string[],
  rows: Array<Array<string | number | null | undefined>>
) {
  const csvBody = [header, ...rows].map((row) => row.map(escapeCsvCell).join(',')).join('\n')
  const csv = `\uFEFF${csvBody}\n`
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function downloadCostTemplate(projectName: string) {
  // 模板为空白模板（国家列让用户自填），不绑定具体站点 → 命名不带 ${中文站点} 段
  const safeProjectName = (projectName || '未选项目').replace(/[\\/:*?"<>|]/g, '-')
  downloadCsvFile(
    `${safeProjectName}-SKU信息-成本管理新建模板.csv`,
    [
      'project_name',
      'SKU',
      'ASIN(可留空，后续维护)',
      'FNSKU(可留空，后续维护)',
      '品名(可留空)',
      'FOB单价(RMB)',
      '国家',
    ],
    [[projectName, 'JDB-M35-13PCS', '', '', '', '2.57', 'US']]
  )
}

function downloadDimensionTemplate(projectName: string) {
  const safeProjectName = (projectName || '未选项目').replace(/[\\/:*?"<>|]/g, '-')
  downloadCsvFile(
    `${safeProjectName}-SKU信息-尺寸管理新建模板.csv`,
    [
      'project_name',
      'SKU',
      'ASIN(可留空，后续维护)',
      'FNSKU(可留空，后续维护)',
      '品名(可留空)',
      '国家',
      '单品长(cm)',
      '单品宽(cm)',
      '单品高(cm)',
      '单品重量(kg)',
      '外箱长(cm)',
      '外箱宽(cm)',
      '外箱高(cm)',
      '外箱重量(kg)',
      '装箱数量',
    ],
    [
      [
        projectName,
        'JDB-M35-13PCS',
        '',
        '',
        '',
        'US',
        '18.5',
        '12.0',
        '5.2',
        '0.68',
        '42',
        '28',
        '30',
        '9.2',
        '12',
      ],
    ]
  )
}

function sortProductCosts(rows: ProductCostItem[]): ProductCostItem[] {
  return [...rows].sort((a, b) =>
    a.sort_order !== b.sort_order ? a.sort_order - b.sort_order : a.id - b.id
  )
}

function normalizeMoneyToCent(value: number | null | undefined): number {
  return Math.round(Number(value ?? 0) * 100)
}

async function parseError(response: Response): Promise<string> {
  return parseResponseError(response, '请求失败')
}

const EMPTY_EDIT_ROW = {
  sku: '',
  asin: '',
  fnsku: '',
  product_name: '',
  fob_unit_cost: '0',
  first_leg_cost_rmb: '0',
  package_length_cm: '0',
  package_width_cm: '0',
  package_height_cm: '0',
  weight_kg: '0',
  carton_length_cm: '0',
  carton_width_cm: '0',
  carton_height_cm: '0',
  carton_weight_kg: '0',
  units_per_carton: '0',
  country: 'US' as 'US' | 'DE' | 'UK',
  sort_order: '1',
  is_active: true,
}

function FilterFieldSkeleton() {
  return (
    <div className="grid gap-2">
      <Skeleton className="h-4 w-16" />
      <Skeleton className="h-10 w-full" />
    </div>
  )
}

/** ASIN 展示：有 marketplace_url 时渲染为对应 Amazon 站点外链，否则纯文本。 */
function AsinLink({ row }: { row: ProductCostItem }) {
  if (!row.asin) return <>-</>
  if (!row.marketplace_url) return <>{row.asin}</>
  return (
    <a
      href={row.marketplace_url}
      target="_blank"
      rel="noopener noreferrer"
      title={row.marketplace_url}
      className="text-primary underline-offset-2 hover:underline"
    >
      {row.asin} ↗
    </a>
  )
}

function TableSkeletonRows({
  columns,
  rows = 6,
  cellWidth = 'w-20',
}: {
  columns: number
  rows?: number
  cellWidth?: string
}) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr key={`table-skeleton-${rowIndex}`} className="border-b">
          {Array.from({ length: columns }).map((__, cellIndex) => (
            <td key={cellIndex} className="p-4">
              <Skeleton className={`h-4 ${cellWidth}`} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

export default function SkuInfoPage() {
  const { notify } = useNotifications()
  const { confirm } = useConfirm()
  const searchParams = useSearchParams()
  const initialSearchTriggeredRef = useRef(false)
  const [activeTab, setActiveTab] = useState<ActiveTab>('cost')
  const [items, setItems] = useState<ProductCostItem[]>([])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [total, setTotal] = useState(0)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [loading, setLoading] = useState(false)

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)
  const { data: session, status } = useSession()

  const [projectFilter, setProjectFilter] = useState('')
  const [skuFilter, setSkuFilter] = useState('')
  const [asinFilter, setAsinFilter] = useState('')
  const [countryFilter, setCountryFilter] = useState<'all' | 'US' | 'DE' | 'UK'>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all')

  const [batchImporting, setBatchImporting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editRow, setEditRow] = useState(EMPTY_EDIT_ROW)

  const [factorySheetOpen, setFactorySheetOpen] = useState(false)
  const [factoryEditingRow, setFactoryEditingRow] = useState<ProductCostItem | null>(null)

  // 批量编辑产品属性
  const [batchSheetOpen, setBatchSheetOpen] = useState(false)
  const [selectedSkus, setSelectedSkus] = useState<ProductCostItem[]>([])

  // FNSKU 标签
  const [labelUploadingId, setLabelUploadingId] = useState<number | null>(null)
  const [labelDownloading, setLabelDownloading] = useState(false)
  const [selectedLabelSkus, setSelectedLabelSkus] = useState<ProductCostItem[]>([])

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [total, pageSize])
  const visibleActiveCount = useMemo(() => items.filter((item) => item.is_active).length, [items])
  const pendingFirstLegSyncCount = useMemo(
    () =>
      items.filter((item) => {
        if (!item.is_active) return false
        const historicalValue = item.historical_first_leg_cost_rmb
        if (historicalValue == null || historicalValue <= 0) return false
        return (
          normalizeMoneyToCent(item.first_leg_cost_rmb) !== normalizeMoneyToCent(historicalValue)
        )
      }).length,
    [items]
  )
  const selectedProject = useMemo(
    () => projects.find((project) => project.name === projectFilter) ?? null,
    [projectFilter, projects]
  )

  useEffect(() => {
    if (status === 'loading') {
      return
    }

    const loadProjects = async () => {
      setProjectsLoading(true)
      setProjectLoadError(null)
      try {
        const data = await fetchManagedProjectsCached<ProjectOption[]>(session)
        setProjects(data)
      } catch (loadError) {
        setProjectLoadError(normalizeErrorMessage(loadError, '项目列表加载失败'))
      } finally {
        setProjectsLoading(false)
      }
    }

    void loadProjects()
  }, [session, status])

  const loadData = async (
    filters?: {
      project_name?: string
      sku?: string
      asin?: string
      country?: 'all' | 'US' | 'DE' | 'UK'
      status?: 'all' | 'active' | 'inactive'
    },
    options?: {
      resetPage?: boolean
      pageOverride?: number
      clearOnMissingProject?: boolean
    }
  ) => {
    const projectValue = (filters?.project_name ?? projectFilter).trim()
    const skuValue = (filters?.sku ?? skuFilter).trim()
    const asinValue = (filters?.asin ?? asinFilter).trim()
    const countryValue = filters?.country ?? countryFilter
    const statusValue = filters?.status ?? statusFilter
    const nextPage = options?.resetPage ? 1 : (options?.pageOverride ?? page)

    if (!projectValue && !skuValue && !asinValue) {
      notify({ type: 'error', title: '请输入项目名或 SKU/ASIN 进行查询' })
      return
    }

    setLoading(true)
    try {
      const search = new URLSearchParams({
        page: String(nextPage),
        page_size: String(pageSize),
        include_total: 'true',
      })
      if (projectValue) search.set('project_name', projectValue)
      if (skuValue) search.set('sku', skuValue)
      if (asinValue) search.set('asin', asinValue)
      if (countryValue !== 'all') search.set('country', countryValue)
      if (statusValue === 'active') search.set('is_active', 'true')
      if (statusValue === 'inactive') search.set('is_active', 'false')

      const summarySearch = new URLSearchParams({
        include_only_history_calc: 'true',
        shipment_status: HISTORY_SHIPMENT_STATUSES.join(','),
      })
      if (selectedProject?.id) {
        summarySearch.set('project_id', String(selectedProject.id))
      }
      // Only filter by country when a specific country is selected,
      // otherwise sumaryBySku would mix data across all countries for the same SKU
      if (countryValue !== 'all') {
        summarySearch.set('country', countryValue)
      }

      const requests: Promise<Response>[] = [
        fetch(`${API_BASE}/api/v1/sku-info?${search.toString()}`, {
          headers: authHeaders(),
          cache: 'no-store',
        }),
      ]
      if (selectedProject?.id) {
        requests.push(
          fetch(`${API_BASE}/api/v1/shipment-schedules/sku-summary?${summarySearch.toString()}`, {
            headers: authHeaders(),
            cache: 'no-store',
          })
        )
      }

      const [response, summaryResponse] = await Promise.all(requests)
      if (!response.ok) throw new Error(await parseError(response))
      const payload = (await response.json()) as ProductCostsPage
      let summaryBySku = new Map<string, number>()
      if (summaryResponse) {
        if (!summaryResponse.ok) throw new Error(await parseError(summaryResponse))
        const summaryPayload = (await summaryResponse.json()) as ShipmentSkuSummaryResponse
        summaryBySku = new Map(
          summaryPayload.items.map((item) => [item.sku, item.average_logistics_unit_price])
        )
      }
      setItems(
        sortProductCosts(
          payload.items.map((item) => ({
            ...item,
            historical_first_leg_cost_rmb: summaryBySku.get(item.sku) ?? item.first_leg_cost_rmb,
          }))
        )
      )
      setTotal(Math.max(0, payload.total ?? 0))
      setHasNextPage(payload.has_next)
      setPage(nextPage)
    } catch (loadError) {
      notify({
        type: 'error',
        title: '加载失败',
        message: normalizeErrorMessage(loadError, '加载失败'),
      })
    } finally {
      setLoading(false)
    }
  }

  // 从 URL search params 自动触发一次查询（关联跳转场景：从「订单信息」点击 SKU/ASIN 进入）
  // 仅触发一次；触发后用户再修改筛选条件走正常 onSearch 流程
  useEffect(() => {
    if (initialSearchTriggeredRef.current) return
    if (projectsLoading) return
    // 项目列表加载失败时跳过（不要展示误导性空结果）
    if (projectLoadError) return

    const urlProjectName = (searchParams.get('project_name') ?? '').trim()
    const urlSku = (searchParams.get('sku') ?? '').trim()
    const urlAsin = (searchParams.get('asin') ?? '').trim()

    if (!urlProjectName && !urlSku && !urlAsin) return

    // 将 URL 参数同步到筛选输入框（让用户看到查询条件）
    if (urlProjectName) setProjectFilter(urlProjectName)
    if (urlSku) setSkuFilter(urlSku)
    if (urlAsin) setAsinFilter(urlAsin)

    // 显式传 filters，避免依赖尚未提交到 state 的值
    void loadData(
      {
        project_name: urlProjectName,
        sku: urlSku,
        asin: urlAsin,
      },
      { resetPage: true }
    )

    initialSearchTriggeredRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsLoading, projectLoadError, searchParams])

  useEffect(() => {
    if (!projectFilter.trim()) return
    void loadData(undefined, {
      pageOverride: page,
      clearOnMissingProject: true,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, projectFilter, selectedProject])

  const onSearch = async () => {
    await loadData(undefined, { resetPage: true, clearOnMissingProject: true })
  }

  const onResetFilters = () => {
    setProjectFilter('')
    setSkuFilter('')
    setAsinFilter('')
    setCountryFilter('all')
    setStatusFilter('all')
    setItems([])
    setTotal(0)
    setHasNextPage(false)
    setPage(1)
  }

  const onProjectFilterChange = async (value: string) => {
    setProjectFilter(value)
    await loadData(
      {
        project_name: value,
        sku: skuFilter,
        asin: asinFilter,
        country: countryFilter,
        status: statusFilter,
      },
      { resetPage: true, clearOnMissingProject: true }
    )
  }

  const onPageSizeChange = (value: string) => {
    const nextPageSize = Number(value)
    if (!PAGE_SIZE_OPTIONS.includes(nextPageSize)) return
    setPageSize(nextPageSize)
    setPage(1)
  }

  const buildFilterSearchParams = () => {
    const search = new URLSearchParams()
    if (projectFilter.trim()) search.set('project_name', projectFilter.trim())
    if (skuFilter.trim()) search.set('sku', skuFilter.trim())
    if (asinFilter.trim()) search.set('asin', asinFilter.trim())
    if (countryFilter !== 'all') search.set('country', countryFilter)
    if (statusFilter === 'active') search.set('is_active', 'true')
    if (statusFilter === 'inactive') search.set('is_active', 'false')
    return search
  }

  const handleBatchImportFile = async (
    event: ChangeEvent<HTMLInputElement>,
    importMode: ImportMode
  ) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBatchImporting(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const response = await fetch(
        `${API_BASE}/api/v1/sku-info/import-csv?import_mode=${importMode}`,
        { method: 'POST', headers: authHeaders(), body: formData }
      )
      if (!response.ok) throw new Error(await parseError(response))
      const payload = (await response.json()) as {
        inserted: number
        updated: number
        skipped?: number
      }
      notify({
        type: 'success',
        title: `CSV ${importMode === 'create' ? '批量上新' : '批量修改'}完成`,
        message: `新增 ${payload.inserted} 条，更新 ${payload.updated} 条，跳过 ${payload.skipped ?? 0} 条`,
      })
      if (projectFilter.trim())
        await loadData(undefined, {
          resetPage: true,
          clearOnMissingProject: true,
        })
    } catch (importError) {
      notify({
        type: 'error',
        title: 'CSV 批量导入失败',
        message: normalizeErrorMessage(importError, 'CSV 批量导入失败'),
      })
    } finally {
      setBatchImporting(false)
    }
  }

  const handleSyncFirstLeg = async () => {
    if (!selectedProject?.id) {
      notify({ type: 'error', title: '请先选择项目后再同步头程成本' })
      return
    }
    setSyncing(true)
    try {
      let syncUrl = `${API_BASE}/api/v1/sku-info/sync-first-leg-from-shipment?project_id=${selectedProject.id}`
      // Only sync the currently selected country to avoid cross-country data mixing
      if (countryFilter !== 'all') {
        syncUrl += `&country=${countryFilter}`
      }
      const response = await fetch(syncUrl, { headers: authHeaders() })
      if (!response.ok) throw await parseError(response)
      const data = (await response.json()) as { updated?: number }
      if ((data.updated ?? 0) > 0) {
        notify({
          type: 'success',
          title: '头程成本同步完成',
          message: `更新了 ${data.updated} 条记录`,
        })
      }
      await loadData(undefined, { resetPage: true })
    } catch (syncError) {
      notify({
        type: 'error',
        title: '同步失败',
        message: normalizeErrorMessage(syncError, '同步失败'),
      })
    } finally {
      setSyncing(false)
    }
  }

  const handleExportCurrentFiltered = async () => {
    if (!projectFilter.trim()) {
      notify({ type: 'error', title: '请先选择项目后再导出批量修改模板' })
      return
    }
    try {
      const search = buildFilterSearchParams()
      search.set('export_type', activeTab)
      const response = await fetch(`${API_BASE}/api/v1/sku-info/export?${search.toString()}`, {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(await parseError(response))
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      // 统一命名规范：${项目}_${中文站点}-页面名-业务标识.csv
      const safeProjectName = (projectFilter || '未选项目').replace(/[\\/:*?"<>|]/g, '-')
      const stationSegment =
        countryFilter === 'all'
          ? '全部站点'
          : getCountryLabel(countryFilter).replace(/[\\/:*?"<>|]/g, '-')
      const tabSegment = activeTab === 'cost' ? '成本管理' : '尺寸管理'
      link.download = `${safeProjectName}_${stationSegment}-SKU信息-${tabSegment}批量修改模板-${formatLocalTimestampForFilename()}.csv`
      link.click()
      URL.revokeObjectURL(url)
      notify({ type: 'success', title: '已导出当前筛选结果的批量修改模板' })
    } catch (exportError) {
      notify({
        type: 'error',
        title: '导出失败',
        message: normalizeErrorMessage(exportError, '导出失败'),
      })
    }
  }

  const startEditRow = (row: ProductCostItem) => {
    setEditingId(row.id)
    setEditRow({
      sku: row.sku,
      asin: row.asin,
      fnsku: row.fnsku || '',
      product_name: row.product_name || '',
      fob_unit_cost: String(row.fob_unit_cost),
      first_leg_cost_rmb: String(row.first_leg_cost_rmb),
      package_length_cm: String(row.package_length_cm),
      package_width_cm: String(row.package_width_cm),
      package_height_cm: String(row.package_height_cm),
      weight_kg: String(row.weight_kg),
      carton_length_cm: String(row.carton_length_cm),
      carton_width_cm: String(row.carton_width_cm),
      carton_height_cm: String(row.carton_height_cm),
      carton_weight_kg: String(row.carton_weight_kg),
      units_per_carton: String(row.units_per_carton),
      country: (normalizeCountry(row.country || 'US') ?? 'US') as 'US' | 'DE' | 'UK',
      sort_order: String(row.sort_order),
      is_active: Boolean(row.is_active),
    })
  }

  const saveRow = async (rowId: number) => {
    if (!editRow.sku.trim()) {
      notify({ type: 'error', title: 'SKU 不能为空' })
      return
    }
    try {
      const response = await fetch(`${API_BASE}/api/v1/sku-info/${rowId}`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: editRow.sku.trim(),
          asin: editRow.asin.trim(),
          fnsku: editRow.fnsku.trim() || null,
          product_name: editRow.product_name.trim() || null,
          fob_unit_cost: Number(editRow.fob_unit_cost),
          first_leg_cost_rmb: Number(editRow.first_leg_cost_rmb),
          package_length_cm: Number(editRow.package_length_cm),
          package_width_cm: Number(editRow.package_width_cm),
          package_height_cm: Number(editRow.package_height_cm),
          weight_kg: Number(editRow.weight_kg),
          carton_length_cm: Number(editRow.carton_length_cm),
          carton_width_cm: Number(editRow.carton_width_cm),
          carton_height_cm: Number(editRow.carton_height_cm),
          carton_weight_kg: Number(editRow.carton_weight_kg),
          units_per_carton: Number(editRow.units_per_carton),
          country: editRow.country,
          sort_order: Number(editRow.sort_order),
          is_active: editRow.is_active,
          source_file: 'manual_inline_edit',
        }),
      })
      if (!response.ok) throw new Error(await parseError(response))
      await response.json()
      setEditingId(null)
      await loadData(undefined, {
        pageOverride: page,
        clearOnMissingProject: true,
      })
      notify({ type: 'success', title: '该行已更新' })
    } catch (saveError) {
      notify({
        type: 'error',
        title: '保存失败',
        message: normalizeErrorMessage(saveError, '保存失败'),
      })
    }
  }

  const deleteRow = async (rowId: number) => {
    if (!(await confirm({ title: '确定要删除该 SKU 记录吗？', variant: 'destructive' }))) return
    try {
      const response = await fetch(`${API_BASE}/api/v1/sku-info/${rowId}`, {
        method: 'DELETE',
        headers: authHeaders(),
      })
      if (!response.ok) throw new Error(await parseError(response))
      setEditingId(null)
      await loadData(undefined, {
        pageOverride: page,
        clearOnMissingProject: true,
      })
      notify({ type: 'success', title: '该行已删除' })
    } catch (deleteError) {
      notify({
        type: 'error',
        title: '删除失败',
        message: normalizeErrorMessage(deleteError, '删除失败'),
      })
    }
  }

  // ── FNSKU 标签操作 ──

  const handleLabelUploadClick = (skuRecordId: number) => {
    setLabelUploadingId((prev) => (prev === skuRecordId ? null : skuRecordId))
  }

  const handleLabelDownload = async (skuRecordId: number, sku: string) => {
    try {
      const response = await fetch(
        `${API_BASE}/api/v1/sku-info/${skuRecordId}/fnsku-label/download`,
        { headers: authHeaders() }
      )
      if (!response.ok) throw new Error(await parseError(response))
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${sku}-fnsku-label.pdf`
      link.click()
      URL.revokeObjectURL(url)
    } catch (downloadError) {
      notify({
        type: 'error',
        title: '标签下载失败',
        message: normalizeErrorMessage(downloadError, '下载失败'),
      })
    }
  }

  const handleBatchDownloadLabels = async () => {
    const ids = selectedLabelSkus.filter((s) => s.fnsku_label_r2_key).map((s) => s.id)
    if (ids.length === 0) {
      notify({ type: 'error', title: '所选 SKU 均无 FNSKU 标签' })
      return
    }
    setLabelDownloading(true)
    try {
      const response = await fetch(`${API_BASE}/api/v1/sku-info/fnsku-labels/batch-download`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku_record_ids: ids }),
      })
      if (!response.ok) throw new Error(await parseError(response))
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'fnsku-labels.zip'
      link.click()
      URL.revokeObjectURL(url)
      const downloaded = response.headers.get('X-Downloaded-Count') || ids.length
      const skipped = response.headers.get('X-Skipped-Count') || '0'
      notify({
        type: 'success',
        title: `批量下载完成，共 ${downloaded} 个标签`,
        message: Number(skipped) > 0 ? `跳过 ${skipped} 个无标签的 SKU` : undefined,
      })
    } catch (batchError) {
      notify({
        type: 'error',
        title: '批量下载失败',
        message: normalizeErrorMessage(batchError, '下载失败'),
      })
    } finally {
      setLabelDownloading(false)
    }
  }

  return (
    <div className="w-full space-y-6 text-foreground">
      {/* 筛选控制台 — PILL 头 + 右侧查询/重置，筛选区下部（BLF-634：合并顶部头部卡，减少一卡） */}
      <div className="dashboard-surface overflow-hidden animate-enter">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3 md:px-6">
          <PagePill icon={<Package2 />}>运营 · SKU 信息管理</PagePill>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={onResetFilters}>
              重置
            </Button>
            <Button type="button" onClick={() => void onSearch()}>
              查询
            </Button>
          </div>
        </div>
        <div className="p-4 lg:p-6">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 xl:grid-cols-5 xl:items-end lg:gap-4">
            {projectsLoading ? (
              <div className="col-span-1">
                <FilterFieldSkeleton />
              </div>
            ) : (
              <div className="grid gap-2">
                <label className="text-sm font-medium text-foreground">项目名</label>
                <Select
                  value={projectFilter}
                  onValueChange={(value) => void onProjectFilterChange(value)}
                  disabled={projects.length === 0}
                >
                  <SelectTrigger className="h-10 dark:bg-[hsl(var(--surface-soft))]">
                    <SelectValue placeholder={projects.length ? '请选择项目名' : '暂无可选项目'} />
                  </SelectTrigger>
                  <SelectContent className="max-h-64 overflow-y-auto">
                    {projects.map((project) => (
                      <SelectItem key={project.name} value={project.name}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {projectLoadError ? (
                  <p className="text-xs text-destructive">{projectLoadError}</p>
                ) : null}
              </div>
            )}
            <div className="grid gap-2">
              <label className="text-sm font-medium text-foreground">SKU</label>
              <Input
                placeholder="输入 SKU"
                value={skuFilter}
                onChange={(e) => setSkuFilter(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium text-foreground">ASIN</label>
              <Input
                placeholder="输入 ASIN"
                value={asinFilter}
                onChange={(e) => setAsinFilter(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium text-foreground">国家站点</label>
              <Select
                value={countryFilter}
                onValueChange={(value) => setCountryFilter(value as 'all' | 'US' | 'DE' | 'UK')}
              >
                <SelectTrigger className="h-10 dark:bg-[hsl(var(--surface-soft))]">
                  <SelectValue placeholder="全部国家站点" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  {COUNTRY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <label className="text-sm font-medium text-foreground">状态</label>
              <Select
                value={statusFilter}
                onValueChange={(value) => setStatusFilter(value as 'all' | 'active' | 'inactive')}
              >
                <SelectTrigger className="h-10 dark:bg-[hsl(var(--surface-soft))]">
                  <SelectValue placeholder="全部状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="active">活跃</SelectItem>
                  <SelectItem value="inactive">不活跃</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </div>
      <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as ActiveTab)}
          className="space-y-4"
        >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <TabsMotionGroup id="sku-cost-tabs">
            <TabsList className="inline-flex h-auto w-full max-w-[600px] rounded-xl border border-border/70 bg-[hsl(var(--surface-subtle))] p-1 shadow-none">
              <SlidingTabsTrigger
                value="cost"
                activeValue={activeTab}
                layoutId="sku-cost-tab-indicator"
                className="flex-1 gap-2 px-4 py-2"
              >
                <Package2 className="h-4 w-4" />
                成本管理
              </SlidingTabsTrigger>
              <SlidingTabsTrigger
                value="dimension"
                activeValue={activeTab}
                layoutId="sku-cost-tab-indicator"
                className="flex-1 gap-2 px-4 py-2"
              >
                <Ruler className="h-4 w-4" />
                尺寸管理
              </SlidingTabsTrigger>
              <SlidingTabsTrigger
                value="factory"
                activeValue={activeTab}
                layoutId="sku-cost-tab-indicator"
                className="flex-1 gap-2 px-4 py-2"
              >
                <FileText className="h-4 w-4" />
                产品属性
              </SlidingTabsTrigger>
              <SlidingTabsTrigger
                value="label"
                activeValue={activeTab}
                layoutId="sku-cost-tab-indicator"
                className="flex-1 gap-2 px-4 py-2"
              >
                <Tag className="h-4 w-4" />
                产品标签
              </SlidingTabsTrigger>
              <SlidingTabsTrigger
                value="image"
                activeValue={activeTab}
                layoutId="sku-cost-tab-indicator"
                className="flex-1 gap-2 px-4 py-2"
              >
                <ImageIcon className="h-4 w-4" />
                产品图片
              </SlidingTabsTrigger>
            </TabsList>
          </TabsMotionGroup>
          <div className="flex gap-2">
            <Badge
              variant="outline"
              className="border-border/60 bg-[hsl(var(--surface-panel))] text-muted-foreground dark:bg-[hsl(var(--surface-soft))]"
            >
              {loading && items.length === 0
                ? '数据准备中...'
                : `第 ${page} / ${totalPages} 页，共 ${total} 条`}
            </Badge>
          </div>
        </div>

        <DirectionalTabTransition value={activeTab} order={ACTIVE_TAB_ORDER}>
          <TabsContent forceMount value={activeTab}>
            {activeTab === 'cost' ? (
<DataTableCard className="flex flex-col overflow-hidden border-border/70 shadow-[var(--shadow-soft)] dark:border-border/90">
                <DataTableCardHeader className="px-6 py-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-1">
                      <h2 className="text-base font-semibold">成本管理</h2>
                    </div>
                    <ActionsBar
                      batchImporting={batchImporting}
                      syncing={syncing}
                      hasSelectedProject={Boolean(selectedProject?.id)}
                      syncDisabled={!selectedProject?.id || pendingFirstLegSyncCount === 0}
                      syncPendingCount={pendingFirstLegSyncCount}
                      projectName={projectFilter}
                      onDownloadCreateTemplate={downloadCostTemplate}
                      onDownloadUpdateTemplate={handleExportCurrentFiltered}
                      onUpload={handleBatchImportFile}
                      onSync={handleSyncFirstLeg}
                    />
                    {selectedSkus.length > 0 && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setBatchSheetOpen(true)}
                      >
                        批量编辑属性 ({selectedSkus.length})
                      </Button>
                    )}
                  </div>
                </DataTableCardHeader>
                <DataTableCardBody
                  className="relative overflow-auto"
                  style={{ maxHeight: 'calc(100vh - 260px)' }}
                >
                    {loading && items.length > 0 ? (
                      <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-border/60 bg-[hsl(var(--surface-panel))] px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
                        数据更新中...
                      </div>
                    ) : null}
                  <table className="w-full border-separate border-spacing-0 text-sm">
                    <thead className="[&_tr]:border-b">
                      <tr className="border-b bg-[hsl(var(--surface-subtle))]">
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-2 text-center w-10">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-border/60"
                            checked={
                              selectedSkus.length > 0 && selectedSkus.length === items.length
                            }
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedSkus([...items])
                              } else {
                                setSelectedSkus([])
                              }
                            }}
                          />
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          排序
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          项目名
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          SKU / ASIN / FNSKU
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          品名
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-right text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          头程成本(历史加权)
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-right text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          FOB
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          国家
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          状态
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          操作
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {loading && items.length === 0 ? <TableSkeletonRows columns={9} /> : null}
                      {items.map((row) => (
                        <tr
                          key={row.id}
                          className={`border-b border-border/50 transition-colors ${editingId === row.id ? 'bg-[hsl(var(--surface-subtle))]' : 'hover:bg-[hsl(var(--surface-subtle))]'} `}
                        >
                          <td className="border-b border-r border-border/60 p-4 align-top text-center w-10">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-border/60"
                              checked={selectedSkus.some((s) => s.id === row.id)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedSkus((prev) => [...prev, row])
                                } else {
                                  setSelectedSkus((prev) => prev.filter((s) => s.id !== row.id))
                                }
                              }}
                            />
                          </td>
                          <td className="border-b border-r border-border/60 p-4 align-top">
                            {editingId === row.id ? (
                              <Input
                                className="h-8 w-16"
                                value={editRow.sort_order}
                                onChange={(e) =>
                                  setEditRow((current) => ({
                                    ...current,
                                    sort_order: e.target.value,
                                  }))
                                }
                              />
                            ) : (
                              row.sort_order
                            )}
                          </td>
                          <td className="border-b border-r border-border/60 p-4 align-top font-medium">
                            {row.project_name}
                          </td>
                          <td className="border-b border-r border-border/60 p-4 align-top">
                            <div>
                              <div className="font-medium">
                                {editingId === row.id ? (
                                  <Input
                                    className="h-8 w-24"
                                    value={editRow.sku}
                                    onChange={(e) =>
                                      setEditRow((current) => ({
                                        ...current,
                                        sku: e.target.value,
                                      }))
                                    }
                                  />
                                ) : (
                                  row.sku
                                )}
                              </div>
                              <div className="mt-0.5 flex gap-3 text-xs text-muted-foreground">
                                <span>
                                  ASIN:{' '}
                                  {editingId === row.id ? (
                                    <Input
                                      className="h-6 w-20 text-xs"
                                      value={editRow.asin}
                                      onChange={(e) =>
                                        setEditRow((current) => ({
                                          ...current,
                                          asin: e.target.value,
                                        }))
                                      }
                                    />
                                  ) : (
                                    <AsinLink row={row} />
                                  )}
                                </span>
                                <span>
                                  FNSKU:{' '}
                                  {editingId === row.id ? (
                                    <Input
                                      className="h-6 w-24 text-xs"
                                      value={editRow.fnsku}
                                      onChange={(e) =>
                                        setEditRow((current) => ({
                                          ...current,
                                          fnsku: e.target.value,
                                        }))
                                      }
                                    />
                                  ) : (
                                    row.fnsku || '-'
                                  )}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td className="border-b border-r border-border/60 p-4 align-top">
                            {editingId === row.id ? (
                              <Input
                                className="h-8 w-28"
                                value={editRow.product_name}
                                onChange={(e) =>
                                  setEditRow((current) => ({
                                    ...current,
                                    product_name: e.target.value,
                                  }))
                                }
                                placeholder="品名"
                              />
                            ) : (
                              row.product_name || '-'
                            )}
                          </td>
                          <td className="border-b border-r border-border/60 p-4 align-top text-right">
                            {(row.historical_first_leg_cost_rmb ?? row.first_leg_cost_rmb).toFixed(
                              2
                            )}
                          </td>
                          <td className="border-b border-r border-border/60 p-4 align-top text-right">
                            {editingId === row.id ? (
                              <Input
                                className="h-8 w-20"
                                value={editRow.fob_unit_cost}
                                onChange={(e) =>
                                  setEditRow((current) => ({
                                    ...current,
                                    fob_unit_cost: e.target.value,
                                  }))
                                }
                              />
                            ) : (
                              row.fob_unit_cost.toFixed(2)
                            )}
                          </td>
                          <td className="border-b border-r border-border/60 p-4 align-top">
                            {editingId === row.id ? (
                              <Select
                                value={editRow.country}
                                onValueChange={(value) =>
                                  setEditRow((current) => ({
                                    ...current,
                                    country: value as 'US' | 'DE' | 'UK',
                                  }))
                                }
                              >
                                <SelectTrigger className="h-8 w-28">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {COUNTRY_OPTIONS.map((option) => (
                                    <SelectItem key={option.value} value={option.value}>
                                      {option.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : (
                              COUNTRY_OPTIONS.find((option) => option.value === row.country)
                                ?.label || row.country
                            )}
                          </td>
                          <td className="border-b border-r border-border/60 p-4 align-top">
                            {editingId === row.id ? (
                              <Select
                                value={editRow.is_active ? 'active' : 'inactive'}
                                onValueChange={(value) =>
                                  setEditRow((current) => ({
                                    ...current,
                                    is_active: value === 'active',
                                  }))
                                }
                              >
                                <SelectTrigger className="h-8 w-24">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="active">活跃</SelectItem>
                                  <SelectItem value="inactive">不活跃</SelectItem>
                                </SelectContent>
                              </Select>
                            ) : (
                              <Badge
                                variant="outline"
                                className={
                                  row.is_active
                                    ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                                    : 'border-border/70 bg-[hsl(var(--surface-subtle))] text-muted-foreground dark:bg-[hsl(var(--surface-soft))] dark:text-foreground'
                                }
                              >
                                {row.is_active ? '活跃' : '不活跃'}
                              </Badge>
                            )}
                          </td>
                          <td className="border-b border-border/60 p-4 align-top">
                            <div className="flex gap-2">
                              {editingId === row.id ? (
                                <>
                                  <Button
                                    type="button"
                                    size="sm"
                                    onClick={() => void saveRow(row.id)}
                                  >
                                    保存
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => setEditingId(null)}
                                  >
                                    取消
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="destructive"
                                    onClick={() => void deleteRow(row.id)}
                                  >
                                    删除
                                  </Button>
                                </>
                              ) : (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => startEditRow(row)}
                                >
                                  编辑
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                      {!loading && items.length === 0 ? (
                        <EmptyState
                          colSpan={9}
                          message={
                            projectFilter
                              ? '当前筛选条件下暂无 SKU 数据。'
                              : '暂无数据，请输入项目名或 SKU/ASIN 进行查询。'
                          }
                        />
                      ) : null}
                    </tbody>
                  </table>
                </DataTableCardBody>
              </DataTableCard>
            ) : activeTab === 'dimension' ? (
              <DataTableCard className="flex flex-col overflow-hidden border-border/70 shadow-[var(--shadow-soft)] dark:border-border/90">
                <DataTableCardHeader className="px-6 py-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-1">
                      <h2 className="text-base font-semibold">尺寸管理</h2>
                    </div>
                    <ActionsBar
                      batchImporting={batchImporting}
                      syncing={syncing}
                      hasSelectedProject={Boolean(selectedProject?.id)}
                      syncDisabled={!selectedProject?.id || pendingFirstLegSyncCount === 0}
                      syncPendingCount={pendingFirstLegSyncCount}
                      projectName={projectFilter}
                      onDownloadCreateTemplate={downloadDimensionTemplate}
                      onDownloadUpdateTemplate={handleExportCurrentFiltered}
                      onUpload={handleBatchImportFile}
                      onSync={handleSyncFirstLeg}
                    />
                  </div>
                </DataTableCardHeader>
                <DataTableCardBody className="relative flex-1 min-h-0 overflow-auto">
                  {loading && items.length > 0 ? (
                    <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-border/60 bg-[hsl(var(--surface-panel))] px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
                      数据更新中...
                    </div>
                  ) : null}
                  <table className="w-full border-separate border-spacing-0 text-sm">
                    <thead className="[&_tr]:border-b">
                      <tr className="border-b bg-[hsl(var(--surface-subtle))]">
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          项目名
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          SKU / ASIN / FNSKU
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          单品尺寸
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          单品重量
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          外箱尺寸
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          外箱重量
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          装箱数量
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          状态
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          操作
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {loading && items.length === 0 ? (
                        <TableSkeletonRows columns={9} cellWidth="w-24" />
                      ) : null}
                      {items.map((row) => (
                        <tr
                          key={row.id}
                          className={`border-b border-border/50 transition-colors ${editingId === row.id ? 'bg-[hsl(var(--surface-subtle))]' : 'hover:bg-[hsl(var(--surface-subtle))]'} `}
                        >
                          <td className="border-b border-r border-border/60 p-4 align-top font-medium">
                            {row.project_name}
                          </td>
                          <td className="border-b border-r border-border/60 p-4 align-top">
                            <div>
                              <div className="font-medium">
                                {editingId === row.id ? (
                                  <Input
                                    className="h-8 w-24"
                                    value={editRow.sku}
                                    onChange={(e) =>
                                      setEditRow((current) => ({
                                        ...current,
                                        sku: e.target.value,
                                      }))
                                    }
                                  />
                                ) : (
                                  row.sku
                                )}
                              </div>
                              <div className="mt-0.5 flex gap-3 text-xs text-muted-foreground">
                                <span>
                                  ASIN:{' '}
                                  {editingId === row.id ? (
                                    <Input
                                      className="h-6 w-20 text-xs"
                                      value={editRow.asin}
                                      onChange={(e) =>
                                        setEditRow((current) => ({
                                          ...current,
                                          asin: e.target.value,
                                        }))
                                      }
                                    />
                                  ) : (
                                    <AsinLink row={row} />
                                  )}
                                </span>
                                <span>
                                  FNSKU:{' '}
                                  {editingId === row.id ? (
                                    <Input
                                      className="h-6 w-24 text-xs"
                                      value={editRow.fnsku}
                                      onChange={(e) =>
                                        setEditRow((current) => ({
                                          ...current,
                                          fnsku: e.target.value,
                                        }))
                                      }
                                    />
                                  ) : (
                                    row.fnsku || '-'
                                  )}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td className="border-b border-r border-border/60 p-4 align-top">
                            {editingId === row.id ? (
                              <TripleInput
                                values={[
                                  editRow.package_length_cm,
                                  editRow.package_width_cm,
                                  editRow.package_height_cm,
                                ]}
                                onChange={(values) =>
                                  setEditRow((current) => ({
                                    ...current,
                                    package_length_cm: values[0],
                                    package_width_cm: values[1],
                                    package_height_cm: values[2],
                                  }))
                                }
                              />
                            ) : (
                              <div>
                                <div>{row.package_length_cm} × {row.package_width_cm} × {row.package_height_cm} cm</div>
                                <div className="mt-0.5 text-xs text-muted-foreground">
                                  {formatInch(row.package_length_cm)} × {formatInch(row.package_width_cm)} × {formatInch(row.package_height_cm)}
                                </div>
                              </div>
                            )}
                          </td>
                          <td className="border-b border-r border-border/60 p-4 align-top">
                            {editingId === row.id ? (
                              <Input
                                className="h-8 w-24"
                                value={editRow.weight_kg}
                                onChange={(e) =>
                                  setEditRow((current) => ({
                                    ...current,
                                    weight_kg: e.target.value,
                                  }))
                                }
                              />
                            ) : (
                              <div>
                                <div>{row.weight_kg} kg</div>
                                <div className="mt-0.5 text-xs text-muted-foreground">{formatLb(row.weight_kg)}</div>
                              </div>
                            )}
                          </td>
                          <td className="border-b border-r border-border/60 p-4 align-top">
                            {editingId === row.id ? (
                              <TripleInput
                                values={[
                                  editRow.carton_length_cm,
                                  editRow.carton_width_cm,
                                  editRow.carton_height_cm,
                                ]}
                                onChange={(values) =>
                                  setEditRow((current) => ({
                                    ...current,
                                    carton_length_cm: values[0],
                                    carton_width_cm: values[1],
                                    carton_height_cm: values[2],
                                  }))
                                }
                              />
                            ) : (
                              <div>
                                <div>{row.carton_length_cm} × {row.carton_width_cm} × {row.carton_height_cm} cm</div>
                                <div className="mt-0.5 text-xs text-muted-foreground">
                                  {formatInch(row.carton_length_cm)} × {formatInch(row.carton_width_cm)} × {formatInch(row.carton_height_cm)}
                                </div>
                              </div>
                            )}
                          </td>
                          <td className="border-b border-r border-border/60 p-4 align-top">
                            {editingId === row.id ? (
                              <Input
                                className="h-8 w-24"
                                value={editRow.carton_weight_kg}
                                onChange={(e) =>
                                  setEditRow((current) => ({
                                    ...current,
                                    carton_weight_kg: e.target.value,
                                  }))
                                }
                              />
                            ) : (
                              <div>
                                <div>{row.carton_weight_kg} kg</div>
                                <div className="mt-0.5 text-xs text-muted-foreground">{formatLb(row.carton_weight_kg)}</div>
                              </div>
                            )}
                          </td>
                          <td className="border-b border-r border-border/60 p-4 align-top">
                            {editingId === row.id ? (
                              <Input
                                className="h-8 w-24"
                                value={editRow.units_per_carton}
                                onChange={(e) =>
                                  setEditRow((current) => ({
                                    ...current,
                                    units_per_carton: e.target.value,
                                  }))
                                }
                              />
                            ) : (
                              `${row.units_per_carton} pcs/箱`
                            )}
                          </td>
                          <td className="border-b border-r border-border/60 p-4 align-top">
                            {editingId === row.id ? (
                              <Select
                                value={editRow.is_active ? 'active' : 'inactive'}
                                onValueChange={(value) =>
                                  setEditRow((current) => ({
                                    ...current,
                                    is_active: value === 'active',
                                  }))
                                }
                              >
                                <SelectTrigger className="h-8 w-24">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="active">活跃</SelectItem>
                                  <SelectItem value="inactive">不活跃</SelectItem>
                                </SelectContent>
                              </Select>
                            ) : (
                              <Badge
                                variant="outline"
                                className={
                                  row.is_active
                                    ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                                    : 'border-border/70 bg-[hsl(var(--surface-subtle))] text-muted-foreground dark:bg-[hsl(var(--surface-soft))] dark:text-foreground'
                                }
                              >
                                {row.is_active ? '活跃' : '不活跃'}
                              </Badge>
                            )}
                          </td>
                          <td className="border-b border-border/60 p-4 align-top">
                            <div className="flex gap-2">
                              {editingId === row.id ? (
                                <>
                                  <Button
                                    type="button"
                                    size="sm"
                                    onClick={() => void saveRow(row.id)}
                                  >
                                    保存
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => setEditingId(null)}
                                  >
                                    取消
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="destructive"
                                    onClick={() => void deleteRow(row.id)}
                                  >
                                    删除
                                  </Button>
                                </>
                              ) : (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => startEditRow(row)}
                                >
                                  编辑
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                      {!loading && items.length === 0 ? (
                        <EmptyState
                          colSpan={9}
                          message={
                            projectFilter
                              ? '当前筛选条件下暂无尺寸数据。'
                              : '暂无数据，请输入项目名或 SKU/ASIN 进行查询。'
                          }
                        />
                      ) : null}
                    </tbody>
                  </table>
                </DataTableCardBody>
              </DataTableCard>
) : activeTab === 'factory' ? (
               <DataTableCard className="flex flex-col overflow-hidden border-border/70 shadow-[var(--shadow-soft)] dark:border-border/90">
                 <DataTableCardHeader className="px-6 py-5">
                   <div className="flex flex-wrap items-center justify-between gap-3">
                     <div className="space-y-1">
                       <h2 className="text-base font-semibold">产品属性</h2>
                     </div>
                   </div>
                 </DataTableCardHeader>
                 <DataTableCardBody className="relative flex-1 min-h-0 overflow-auto">
                  {loading && items.length > 0 ? (
                    <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-border/60 bg-[hsl(var(--surface-panel))] px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
                      数据更新中...
                    </div>
                  ) : null}
                  <table className="w-full border-separate border-spacing-0 text-sm">
                    <thead className="[&_tr]:border-b">
                      <tr className="border-b bg-[hsl(var(--surface-subtle))]">
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          项目名
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          SKU / ASIN / FNSKU
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          产品属性
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          编辑人
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          更新时间
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          操作
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {loading && items.length === 0 ? (
                        <TableSkeletonRows columns={6} cellWidth="w-24" />
                      ) : null}
                      {items.map((row) => (
                        <Fragment key={row.id}>
                          <tr className="border-b border-border/50 transition-colors hover:bg-[hsl(var(--surface-subtle))]">
                            <td className="border-b border-r border-border/60 p-4 align-top font-medium">
                              {row.project_name}
                            </td>
                            <td className="border-b border-r border-border/60 p-4 align-top">
                              <div>
                                <div className="font-medium">{row.sku}</div>
                                <div className="mt-0.5 flex gap-3 text-xs text-muted-foreground">
                                  <span>ASIN: <AsinLink row={row} /></span>
                                  <span>FNSKU: {row.fnsku || '-'}</span>
                                </div>
                              </div>
                            </td>
                            <td className="border-b border-r border-border/60 p-4 align-top">
                              {row.sku_factory_info &&
                              Object.keys(row.sku_factory_info).length > 0 ? (
                                <HoverCard
                                  side="top"
                                  scaleOnHover={false}
                                  trigger={
                                    <Badge
                                      variant="outline"
                                      className="cursor-help border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                                    >
                                      有描述
                                    </Badge>
                                  }
                                  content={
                                    <div className="space-y-2">
                                      <p className="text-sm font-medium">产品属性信息</p>
                                      <div className="space-y-1">
                                        {Object.entries(row.sku_factory_info)
                                          .slice(0, 5)
                                          .map(([key, value]) => (
                                            <div key={key} className="text-xs">
                                              <span className="font-medium">{key}: </span>
                                              <span className="text-muted-foreground">
                                                {typeof value === 'string'
                                                  ? value
                                                  : JSON.stringify(value)}
                                              </span>
                                            </div>
                                          ))}
                                        {Object.keys(row.sku_factory_info).length > 5 && (
                                          <div className="text-xs text-muted-foreground">
                                            ...还有 {Object.keys(row.sku_factory_info).length - 5}{' '}
                                            个字段
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  }
                                />
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="border-border/70 bg-[hsl(var(--surface-subtle))] text-muted-foreground dark:bg-[hsl(var(--surface-soft))] dark:text-foreground"
                                >
                                  未填写
                                </Badge>
                              )}
                            </td>
                            <td className="border-b border-r border-border/60 p-4 align-top text-sm text-muted-foreground">
                              {row.sku_factory_info_updated_by || '-'}
                            </td>
                            <td className="border-b border-r border-border/60 p-4 align-top text-sm text-muted-foreground">
                              {row.sku_factory_info_updated_at
                                ? new Date(row.sku_factory_info_updated_at).toLocaleString('zh-CN')
                                : '-'}
                            </td>
                            <td className="border-b border-border/60 p-4 align-top">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setFactoryEditingRow(row)
                                  setFactorySheetOpen(true)
                                }}
                              >
                                编辑
                              </Button>
                            </td>
                          </tr>
                        </Fragment>
                      ))}
                      {!loading && items.length === 0 ? (
                        <EmptyState
                          colSpan={6}
                          message={
                            projectFilter
                              ? '当前筛选条件下暂无数据。'
                              : '暂无数据，请输入项目名或 SKU/ASIN 进行查询。'
                          }
                        />
                      ) : null}
                    </tbody>
                  </table>
                </DataTableCardBody>
              </DataTableCard>
) : activeTab === 'label' ? (
               /* ── 产品标签 Tab ── */
               <DataTableCard className="flex flex-col overflow-hidden border-border/70 shadow-[var(--shadow-soft)] dark:border-border/90">
                 <DataTableCardHeader className="px-6 py-5">
                   <div className="flex flex-wrap items-center justify-between gap-3">
                     <div className="space-y-1">
                       <h2 className="text-base font-semibold">产品标签</h2>
                       <p className="text-xs text-muted-foreground">
                         上传和管理每个 SKU 的 FNSKU 标签 PDF
                       </p>
                     </div>
                     {selectedLabelSkus.length > 0 && (
                       <Button
                         type="button"
                         size="sm"
                         variant="default"
                         disabled={labelDownloading}
                         onClick={() => void handleBatchDownloadLabels()}
                       >
                         <FileDown className="mr-2 h-4 w-4" />
                         {labelDownloading
                           ? '下载中...'
                           : `批量下载标签 (${selectedLabelSkus.filter((s) => s.fnsku_label_r2_key).length})`}
                       </Button>
                     )}
                   </div>
                 </DataTableCardHeader>
                 <DataTableCardBody className="relative flex-1 min-h-0 overflow-auto">
                  {loading && items.length > 0 ? (
                    <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-border/60 bg-[hsl(var(--surface-panel))] px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
                      数据更新中...
                    </div>
                  ) : null}
                  <table className="w-full border-separate border-spacing-0 text-sm">
                    <thead className="[&_tr]:border-b">
                      <tr className="border-b bg-[hsl(var(--surface-subtle))]">
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-2 text-center w-10">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-border/60"
                            checked={
                              selectedLabelSkus.length > 0 &&
                              selectedLabelSkus.length === items.length
                            }
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedLabelSkus([...items])
                              } else {
                                setSelectedLabelSkus([])
                              }
                            }}
                          />
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          项目名
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          SKU / ASIN / FNSKU
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          产品名称
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-r border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          标签状态
                        </th>
                        <th className="sticky top-0 z-10 h-12 border-b border-border/60 bg-[hsl(var(--surface-subtle))] px-4 text-left text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                          操作
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {loading && items.length === 0 ? (
                        <TableSkeletonRows columns={6} cellWidth="w-24" />
                      ) : null}
                      {items.map((row) => (
                        <Fragment key={row.id}>
                          <tr className="border-b border-border/50 transition-colors hover:bg-[hsl(var(--surface-subtle))]">
                            <td className="border-b border-r border-border/60 p-4 align-top text-center w-10">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-border/60"
                                checked={selectedLabelSkus.some((s) => s.id === row.id)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setSelectedLabelSkus((prev) => [...prev, row])
                                  } else {
                                    setSelectedLabelSkus((prev) =>
                                      prev.filter((s) => s.id !== row.id)
                                    )
                                  }
                                }}
                              />
                            </td>
                            <td className="border-b border-r border-border/60 p-4 align-top font-medium">
                              {row.project_name}
                            </td>
                            <td className="border-b border-r border-border/60 p-4 align-top">
                              <div>
                                <div className="font-medium">{row.sku}</div>
                                <div className="mt-0.5 flex gap-3 text-xs text-muted-foreground">
                                  <span>ASIN: <AsinLink row={row} /></span>
                                  <span>FNSKU: {row.fnsku || '-'}</span>
                                </div>
                              </div>
                            </td>
                            <td className="border-b border-r border-border/60 p-4 align-top text-sm">
                              {row.product_name || '-'}
                            </td>
                            <td className="border-b border-r border-border/60 p-4 align-top">
                              {row.fnsku_label_r2_key ? (
                                <Badge
                                  variant="outline"
                                  className="border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                                >
                                  已上传
                                </Badge>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="border-border/70 bg-[hsl(var(--surface-subtle))] text-muted-foreground dark:bg-[hsl(var(--surface-soft))] dark:text-foreground"
                                >
                                  未上传
                                </Badge>
                              )}
                            </td>
                            <td className="border-b border-border/60 p-4 align-top">
                              <div className="flex gap-2">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={labelUploadingId === row.id}
                                  onClick={() => handleLabelUploadClick(row.id)}
                                >
                                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                                  {labelUploadingId === row.id ? '上传中...' : '上传标签'}
                                </Button>
                                {row.fnsku_label_r2_key && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => void handleLabelDownload(row.id, row.sku)}
                                  >
                                    <FileDown className="mr-1.5 h-3.5 w-3.5" />
                                    下载
                                  </Button>
                                )}
                              </div>
                            </td>
                          </tr>
                          {labelUploadingId === row.id && (
                            <tr className="border-b border-border/50 bg-[hsl(var(--surface-subtle))]">
                              <td colSpan={6} className="px-6 py-4">
                                <div className="flex items-center justify-between mb-2">
                                  <span className="text-sm font-medium text-foreground">
                                    粘贴、拖拽或选择 PDF 文件上传标签
                                  </span>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-xs"
                                    onClick={() => setLabelUploadingId(null)}
                                  >
                                    取消
                                  </Button>
                                </div>
                                <UploadZone
                                  accept="application/pdf"
                                  maxSize={20}
                                  showPreview={false}
                                  onUpload={async (file) => {
                                    const formData = new FormData()
                                    formData.append('file', file)
                                    try {
                                      const response = await fetch(
                                        `${API_BASE}/api/v1/sku-info/${row.id}/fnsku-label`,
                                        { method: 'POST', headers: authHeaders(), body: formData }
                                      )
                                      if (!response.ok) throw new Error(await parseError(response))
                                      const data = (await response.json()) as {
                                        fnsku_verified?: boolean
                                        fnsku_verification_message?: string
                                      }
                                      if (data.fnsku_verified) {
                                        notify({
                                          type: 'success',
                                          title: 'FNSKU 标签上传成功',
                                          message: data.fnsku_verification_message,
                                        })
                                      } else if (
                                        data.fnsku_verification_message?.includes('不匹配')
                                      ) {
                                        notify({
                                          type: 'warning',
                                          title: '标签已上传，但 FNSKU 不匹配',
                                          message: data.fnsku_verification_message,
                                        })
                                      } else {
                                        notify({
                                          type: 'success',
                                          title: 'FNSKU 标签上传成功',
                                          message: data.fnsku_verification_message,
                                        })
                                      }
                                      setLabelUploadingId(null)
                                      await loadData(undefined, {
                                        pageOverride: page,
                                        clearOnMissingProject: true,
                                      })
                                    } catch (uploadError) {
                                      notify({
                                        type: 'error',
                                        title: '标签上传失败',
                                        message: normalizeErrorMessage(uploadError, '上传失败'),
                                      })
                                    }
                                  }}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                      {!loading && items.length === 0 ? (
                        <EmptyState
                          colSpan={6}
                          message={
                            projectFilter
                              ? '当前筛选条件下暂无数据。'
                              : '暂无数据，请输入项目名或 SKU/ASIN 进行查询。'
                          }
                        />
                      ) : null}
                    </tbody>
                  </table>
                </DataTableCardBody>
              </DataTableCard>
            ) : null}
            {activeTab === 'image' && (
              <ImageTabContent
                projectName={projectFilter}
                skus={items}
                loading={loading}
                onRefresh={() => void loadData()}
              />
            )}
          </TabsContent>
        </DirectionalTabTransition>
      </Tabs>

      {factoryEditingRow && (
        <FactoryInfoSheet
          open={factorySheetOpen}
          productCostId={factoryEditingRow.id}
          skuLabel={factoryEditingRow.sku}
          factoryInfo={factoryEditingRow.sku_factory_info}
          onClose={() => {
            setFactorySheetOpen(false)
            setFactoryEditingRow(null)
          }}
          onSaved={() => {
            setFactorySheetOpen(false)
            setFactoryEditingRow(null)
            void loadData(undefined, { pageOverride: page, clearOnMissingProject: true })
          }}
        />
      )}

      <BatchFactoryInfoSheet
        open={batchSheetOpen}
        selectedSkus={selectedSkus}
        onClose={() => {
          setBatchSheetOpen(false)
          setSelectedSkus([])
        }}
        onSaved={() => {
          setBatchSheetOpen(false)
          setSelectedSkus([])
          void loadData(undefined, { pageOverride: page, clearOnMissingProject: true })
        }}
      />
    </div>
  )
}

function ActionsBar({
  batchImporting,
  syncing,
  hasSelectedProject,
  syncDisabled,
  syncPendingCount,
  projectName,
  onDownloadCreateTemplate,
  onDownloadUpdateTemplate,
  onUpload,
  onSync,
}: {
  batchImporting: boolean
  syncing: boolean
  hasSelectedProject: boolean
  syncDisabled: boolean
  syncPendingCount: number
  projectName: string
  onDownloadCreateTemplate: (projectName: string) => void
  onDownloadUpdateTemplate: () => void
  onUpload: (event: ChangeEvent<HTMLInputElement>, importMode: ImportMode) => void
  onSync: () => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        size="sm"
        variant="default"
        onClick={onSync}
        disabled={syncing || syncDisabled}
        title={
          syncDisabled && !syncing
            ? hasSelectedProject
              ? '当前没有可同步的头程成本变更'
              : '请先选择项目'
            : undefined
        }
      >
        <RefreshCw className={`mr-2 h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
        {syncing
          ? '同步中...'
          : syncPendingCount > 0
            ? `同步头程 (${syncPendingCount})`
            : '同步头程'}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onDownloadCreateTemplate(projectName)}
        disabled={!projectName}
        title={!projectName ? '请先选择项目' : undefined}
      >
        <FileDown className="mr-2 h-4 w-4" />
        下载上新模板
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={onDownloadUpdateTemplate}>
        <FileDown className="mr-2 h-4 w-4" />
        导出批量修改
      </Button>
      <Button asChild size="sm" variant="outline" disabled={batchImporting}>
        <label>
          <Upload className="mr-2 h-4 w-4" />
          {batchImporting ? '导入中...' : '批量上新'}
          <input
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(event) => onUpload(event, 'create')}
          />
        </label>
      </Button>
      <Button asChild size="sm" variant="outline" disabled={batchImporting}>
        <label>
          <Upload className="mr-2 h-4 w-4" />
          {batchImporting ? '导入中...' : '批量修改'}
          <input
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(event) => onUpload(event, 'update')}
          />
        </label>
      </Button>
    </div>
  )
}

function TripleInput({
  values,
  onChange,
}: {
  values: [string, string, string]
  onChange: (values: [string, string, string]) => void
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <Input
        className="h-8"
        value={values[0]}
        onChange={(e) => onChange([e.target.value, values[1], values[2]])}
      />
      <Input
        className="h-8"
        value={values[1]}
        onChange={(e) => onChange([values[0], e.target.value, values[2]])}
      />
      <Input
        className="h-8"
        value={values[2]}
        onChange={(e) => onChange([values[0], values[1], e.target.value])}
      />
    </div>
  )
}
