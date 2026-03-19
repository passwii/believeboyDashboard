'use client'

import { type ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'
import { RefreshCcw, Upload, FileDown, Plus, Pencil, Trash2, X, ChevronsUpDown, Check } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DateRangePicker, SingleDatePicker, formatDateInputValue as formatPickerDateInputValue, parseDateInputValue, parseDateRangeInputValue } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { cn, formatLocalTimestampForFilename } from '@/lib/utils'

const API_BASE = '/api/backend'
const HISTORY_SHIPMENT_STATUSES = ['completed', 'in_transit'] as const

type ProjectOption = {
  id: number
  name: string
}

type ShipmentScheduleListItem = {
  id: number
  project_id: number
  project_name: string
  country: string
  shipment_no: string
  tracking_no: string | null
  warehouse_code: string | null
  forwarder_name: string | null
  shipping_method: string
  created_date: string | null
  etd_date: string | null
  eta_date: string | null
  actual_inbound_date: string | null
  shipment_status: string
  remark: string | null
  sku_count: number
  total_quantity: number
  logistics_unit_price: number
  total_volume_m3: number
  total_chargeable_weight_kg: number
  logistics_total_price: number
  include_in_history_shipping_calc: boolean
  updated_at: string
}

type ShipmentScheduleItemRow = {
  id: number
  item_date: string | null
  sku: string
  quantity: number
  remark: string | null
  volume_m3: number
  actual_weight_kg: number
  volumetric_weight_kg: number
  chargeable_weight_kg: number
  estimated_logistics_cost: number
  average_logistics_unit_price: number
}

type ShipmentScheduleDetail = ShipmentScheduleListItem & { items: ShipmentScheduleItemRow[] }

type ShipmentScheduleListResponse = {
  items: ShipmentScheduleListItem[]
  page: number
  page_size: number
  total: number | null
  has_next: boolean
}

type ShipmentScheduleCostSummary = {
  shipment_count: number
  total_sku: number
  total_quantity: number
  total_chargeable_weight_kg: number
  total_logistics_cost: number
}

type ShipmentSchedulesImportResponse = {
  inserted: number
  shipment_nos: string[]
}

type ShipmentPageTab = 'overview' | 'cost' | 'sku-summary' | 'fba-box-detail'

type ShipmentCostPreviewRow = {
  id: number
  sku: string
  quantity: number
  volumeM3: number
  actualWeightKg: number
  volumetricWeightKg: number
  chargeableWeightKg: number
  estimatedCost: number
  averageUnitPrice: number
}

type ShipmentSkuSummaryItem = {
  project_id: number
  project_name: string
  country: string
  sku: string
  shipment_count: number
  total_quantity: number
  total_chargeable_weight_kg: number
  total_logistics_cost: number
  average_logistics_unit_price: number
}

type ShipmentSkuSummaryResponse = {
  items: ShipmentSkuSummaryItem[]
}

type ShipmentFbaBoxDetailItem = {
  warehouse_code: string | null
  sku: string
  asin: string | null
  fnsku: string | null
  package_length_cm: number | null
  package_width_cm: number | null
  package_height_cm: number | null
  weight_kg: number | null
  length_cm: number
  width_cm: number
  height_cm: number
  carton_weight_kg: number | null
  quantity: number
  units_per_carton: number
  carton_count: number
  full_carton_count: number
  partial_carton_units: number
  outer_box_text: string
  total_weight_kg: number
  total_volume_m3: number
}

type ShipmentFbaBoxDetailResponse = {
  project_id: number
  project_name: string
  country: string
  shipment_no: string
  items: ShipmentFbaBoxDetailItem[]
}

type ProjectSkuOption = {
  sku: string
  asin: string
  fnsku: string | null
}

type EditableShipmentItem = {
  tempId: string
  sku: string
  quantity: string
}

type ScheduleFormState = {
  project_id: string
  country: string
  shipment_no: string
  tracking_no: string
  warehouse_code: string
  forwarder_name: string
  shipping_method: string
  created_date: string
  etd_date: string
  eta_date: string
  actual_inbound_date: string
  include_in_history_shipping_calc: string
  remark: string
  shipment_status: string
}

const STATUS_OPTIONS = [
  { value: 'draft', label: '草稿' },
  { value: 'in_transit', label: '在途' },
  { value: 'completed', label: '已完成' },
] as const

const METHOD_OPTIONS = [
  { value: 'sea', label: '海运' },
  { value: 'air', label: '空运' },
  { value: 'express', label: '快递' },
  { value: 'truck', label: '卡航/汽运' },
  { value: 'rail', label: '铁路' },
  { value: 'other', label: '其他' },
] as const

const COUNTRY_OPTIONS = [
  { value: 'US', label: 'US' },
  { value: 'UK', label: 'UK' },
  { value: 'DE', label: 'DE' },
] as const

const TABLE_SCROLL_CONTAINER_CLASS =
  'w-full max-w-full overflow-x-auto overflow-y-visible rounded-[inherit] [-webkit-overflow-scrolling:touch] touch-pan-x overscroll-x-contain'

function formatDateInputValue(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function createEmptyForm(): ScheduleFormState {
  return {
    project_id: '',
    country: 'US',
    shipment_no: '',
    tracking_no: '',
    warehouse_code: '',
    forwarder_name: '',
    shipping_method: 'sea',
    created_date: formatDateInputValue(new Date()),
    etd_date: '',
    eta_date: '',
    actual_inbound_date: '',
    include_in_history_shipping_calc: 'yes',
    remark: '',
    shipment_status: 'draft',
  }
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

function formatDate(value: string | null | undefined): string {
  if (!value) return '-'
  return value
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

function formatDecimal(value: number, digits = 3): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  })
}

function escapeCsvCell(value: string | number | null | undefined): string {
  const text = String(value ?? '')
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`
  }
  return text
}

function downloadCsvFile(filename: string, header: string[], rows: Array<Array<string | number | null | undefined>>) {
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

function ShipmentControlSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-4 w-14" />
      <Skeleton className="h-10 w-full" />
    </div>
  )
}

function ShipmentMetricSkeleton() {
  return (
    <div className="rounded-2xl border border-border/60 bg-muted/30 px-4 py-3">
      <Skeleton className="h-3 w-12" />
      <Skeleton className="mt-3 h-7 w-20" />
    </div>
  )
}

function ShipmentTableSkeleton({
  columns,
  rows = 5,
}: {
  columns: number
  rows?: number
}) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <TableRow key={`shipment-loading-${rowIndex}`}>
          {Array.from({ length: columns }).map((__, cellIndex) => (
            <TableCell key={cellIndex}>
              <Skeleton className="h-4 w-20" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  )
}

function statusMeta(status: string): { label: string; className: string } {
  const map: Record<string, { label: string; className: string }> = {
    draft: { label: '草稿', className: 'border border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200' },
    in_transit: { label: '在途', className: 'border border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-900/80 dark:bg-sky-950/60 dark:text-sky-300' },
    completed: { label: '已完成', className: 'border border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-900/80 dark:bg-emerald-950/60 dark:text-emerald-300' },
  }
  return map[status] || { label: status, className: 'border border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200' }
}

function methodLabel(method: string): string {
  return METHOD_OPTIONS.find((item) => item.value === method)?.label || method
}

function countryLabel(country: string): string {
  return COUNTRY_OPTIONS.find((item) => item.value === country)?.label || country
}

function countryMeta(country: string): { label: string; className: string } {
  const map: Record<string, { label: string; className: string }> = {
    US: {
      label: 'US',
      className: 'border border-blue-200 bg-blue-100 text-blue-700 dark:border-blue-900/80 dark:bg-blue-950/60 dark:text-blue-300',
    },
    UK: {
      label: 'UK',
      className: 'border border-violet-200 bg-violet-100 text-violet-700 dark:border-violet-900/80 dark:bg-violet-950/60 dark:text-violet-300',
    },
    DE: {
      label: 'DE',
      className: 'border border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-900/80 dark:bg-amber-950/60 dark:text-amber-300',
    },
  }
  return map[country] || {
    label: countryLabel(country),
    className: 'border border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200',
  }
}

function buildFormFromDetail(detail: ShipmentScheduleDetail): ScheduleFormState {
  return {
    project_id: String(detail.project_id),
    country: detail.country,
    shipment_no: detail.shipment_no,
    tracking_no: detail.tracking_no || '',
    warehouse_code: detail.warehouse_code || '',
    forwarder_name: detail.forwarder_name || '',
    shipping_method: detail.shipping_method,
    created_date: detail.created_date || '',
    etd_date: detail.etd_date || '',
    eta_date: detail.eta_date || '',
    actual_inbound_date: detail.actual_inbound_date || '',
    include_in_history_shipping_calc: detail.include_in_history_shipping_calc ? 'yes' : 'no',
    remark: detail.remark || '',
    shipment_status: detail.shipment_status,
  }
}

function buildCostPreviewRows(detail: ShipmentScheduleDetail): ShipmentCostPreviewRow[] {
  return detail.items
    .filter((item) => item.chargeable_weight_kg > 0 || item.volume_m3 > 0 || item.estimated_logistics_cost > 0)
    .map((item) => ({
      id: item.id,
      sku: item.sku,
      quantity: item.quantity,
      volumeM3: item.volume_m3,
      actualWeightKg: item.actual_weight_kg,
      volumetricWeightKg: item.volumetric_weight_kg,
      chargeableWeightKg: item.chargeable_weight_kg,
      estimatedCost: item.estimated_logistics_cost,
      averageUnitPrice: item.average_logistics_unit_price,
    }))
}

function createEmptyEditableShipmentItem(): EditableShipmentItem {
  return {
    tempId: `temp-${Math.random().toString(36).slice(2, 10)}`,
    sku: '',
    quantity: '',
  }
}

function buildEditableItems(detail: ShipmentScheduleDetail): EditableShipmentItem[] {
  if (detail.items.length === 0) {
    return [createEmptyEditableShipmentItem()]
  }
  return detail.items.map((item) => ({
    tempId: `item-${item.id}`,
    sku: item.sku,
    quantity: String(item.quantity),
  }))
}

function editableItemsChanged(detail: ShipmentScheduleDetail | null, rows: EditableShipmentItem[]): boolean {
  if (!detail) return false
  const normalizedRows = rows
    .map((item) => ({
      sku: item.sku.trim(),
      quantity: item.quantity.trim(),
    }))
    .filter((item) => item.sku || item.quantity)

  if (normalizedRows.length !== detail.items.length) return true
  return normalizedRows.some((item, index) => {
    const source = detail.items[index]
    return (
      item.sku !== source.sku ||
      item.quantity !== String(source.quantity)
    )
  })
}

function SearchableSkuField({
  value,
  options,
  loading,
  onChange,
}: {
  value: string
  options: ProjectSkuOption[]
  loading: boolean
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const selectedSku = options.find((option) => option.sku === value)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="outline"
        className="h-9 w-full justify-between px-3 font-normal"
        onClick={() => setOpen(true)}
      >
        <span className="truncate text-left">
          {selectedSku ? selectedSku.sku : loading ? 'SKU 加载中...' : '选择 SKU'}
        </span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </Button>
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl">
        <Command className="max-h-[70vh]">
          <CommandInput placeholder="搜索 SKU" />
          <CommandList>
            <CommandEmpty>{loading ? 'SKU 加载中...' : '没有匹配的 SKU'}</CommandEmpty>
            {options.map((option) => (
              <CommandItem
                key={option.sku}
                value={option.sku}
                onSelect={() => {
                  onChange(option.sku)
                  setOpen(false)
                }}
              >
                <Check className={cn('h-4 w-4', value === option.sku ? 'opacity-100' : 'opacity-0')} />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate">{option.sku}</span>
                </div>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function SearchableShipmentNoFilter({
  value,
  options,
  loading,
  onChange,
}: {
  value: string
  options: string[]
  loading: boolean
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const normalizedQuery = query.trim()
  const canUseTypedValue = normalizedQuery.length > 0 && !options.some((option) => option === normalizedQuery)

  return (
    <DropdownMenu open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen)
      if (!nextOpen) setQuery('')
    }}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-10 w-full justify-between px-3 font-normal">
          <span className={cn('truncate text-left', value ? 'text-foreground' : 'text-muted-foreground')}>
            {value || '全部货件'}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[280px] p-0">
        <Command shouldFilter className="max-h-[320px]">
          <CommandInput placeholder="搜索货件编号" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandItem
              value="__all__ 全部货件"
              onSelect={() => {
                onChange('')
                setOpen(false)
              }}
            >
              <Check className={cn('h-4 w-4', value === '' ? 'opacity-100' : 'opacity-0')} />
              <span>全部货件</span>
            </CommandItem>
            {canUseTypedValue ? (
              <CommandItem
                value={`__typed__ ${normalizedQuery}`}
                onSelect={() => {
                  onChange(normalizedQuery)
                  setOpen(false)
                }}
              >
                <Check className="h-4 w-4 opacity-0" />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate">{normalizedQuery}</span>
                  <span className="text-xs text-muted-foreground">使用当前输入进行筛选</span>
                </div>
              </CommandItem>
            ) : null}
            {options.map((option) => (
              <CommandItem
                key={option}
                value={option}
                onSelect={() => {
                  onChange(option)
                  setOpen(false)
                }}
              >
                <Check className={cn('h-4 w-4', value === option ? 'opacity-100' : 'opacity-0')} />
                <span className="truncate">{option}</span>
              </CommandItem>
            ))}
            <CommandEmpty>{loading ? '货件编号加载中...' : '没有匹配的货件编号'}</CommandEmpty>
          </CommandList>
        </Command>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function formatDimensionText(length: number, width: number, height: number): string {
  if (length <= 0 || width <= 0 || height <= 0) return '-'
  return `${formatDecimal(length, 2)} × ${formatDecimal(width, 2)} × ${formatDecimal(height, 2)} cm`
}

export default function ShipmentManagementPage() {
  const { data: session, status } = useSession()
  const isAdmin = Boolean(session?.user?.isAdmin)
  const [activeTab, setActiveTab] = useState<ShipmentPageTab>('overview')
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)

  const [items, setItems] = useState<ShipmentScheduleListItem[]>([])
  const [skuSummaryItems, setSkuSummaryItems] = useState<ShipmentSkuSummaryItem[]>([])
  const [costSummary, setCostSummary] = useState<ShipmentScheduleCostSummary>({
    shipment_count: 0,
    total_sku: 0,
    total_quantity: 0,
    total_chargeable_weight_kg: 0,
    total_logistics_cost: 0,
  })
  const [loading, setLoading] = useState(false)
  const [skuSummaryLoading, setSkuSummaryLoading] = useState(false)
  const [costSummaryLoading, setCostSummaryLoading] = useState(false)
  const [fbaBoxLoading, setFbaBoxLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fbaBoxError, setFbaBoxError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [hasNext, setHasNext] = useState(false)

  const [projectFilter, setProjectFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [countryFilter, setCountryFilter] = useState('all')
  const [shipmentNoFilter, setShipmentNoFilter] = useState('')
  const [shipmentNoOptions, setShipmentNoOptions] = useState<string[]>([])
  const [shipmentNoOptionsLoading, setShipmentNoOptionsLoading] = useState(false)
  const [shipmentDateFrom, setShipmentDateFrom] = useState('')
  const [shipmentDateTo, setShipmentDateTo] = useState('')

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<ShipmentScheduleDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogMode, setDialogMode] = useState<'create' | 'edit'>('create')
  const [form, setForm] = useState<ScheduleFormState>(() => createEmptyForm())
  const [editableItems, setEditableItems] = useState<EditableShipmentItem[]>([])
  const [projectSkuOptions, setProjectSkuOptions] = useState<ProjectSkuOption[]>([])
  const [projectSkuLoading, setProjectSkuLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const [skuDialogOpen, setSkuDialogOpen] = useState(false)
  const [skuDialogScheduleId, setSkuDialogScheduleId] = useState<number | null>(null)
  const [skuDialogDetail, setSkuDialogDetail] = useState<ShipmentScheduleDetail | null>(null)
  const [skuDialogLoading, setSkuDialogLoading] = useState(false)
  const [logisticsUnitPrice, setLogisticsUnitPrice] = useState('')
  const [costPreviewRows, setCostPreviewRows] = useState<ShipmentCostPreviewRow[]>([])
  const [costPreviewLoading, setCostPreviewLoading] = useState(false)
  const [costPreviewError, setCostPreviewError] = useState<string | null>(null)

  const [importing, setImporting] = useState(false)
  const [batchImporting, setBatchImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [costExporting, setCostExporting] = useState(false)
  const [skuSummaryExporting, setSkuSummaryExporting] = useState(false)
  const [fbaBoxExporting, setFbaBoxExporting] = useState(false)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [fbaBoxMeta, setFbaBoxMeta] = useState<{ projectName: string; country: string; shipmentNo: string } | null>(null)
  const [fbaBoxItems, setFbaBoxItems] = useState<ShipmentFbaBoxDetailItem[]>([])

  const summary = useMemo(() => {
    return items.reduce(
      (acc, item) => {
        acc.totalSku += item.sku_count
        acc.totalQuantity += item.total_quantity
        return acc
      },
      { totalSku: 0, totalQuantity: 0 }
    )
  }, [items])

  const costPreviewSummary = useMemo(() => {
    return costPreviewRows.reduce(
      (acc, item) => {
        acc.totalQuantity += item.quantity
        acc.totalVolumeM3 += item.volumeM3
        acc.totalChargeableWeightKg += item.chargeableWeightKg
        acc.totalEstimatedCost += item.estimatedCost
        return acc
      },
      {
        totalQuantity: 0,
        totalVolumeM3: 0,
        totalChargeableWeightKg: 0,
        totalEstimatedCost: 0,
      }
    )
  }, [costPreviewRows])

  const editableItemStats = useMemo(() => {
    const normalized = editableItems.filter((item) => item.sku.trim())
    return normalized.reduce(
      (acc, item) => {
        acc.skuCount += 1
        const quantity = Number(item.quantity)
        if (Number.isFinite(quantity) && quantity > 0) {
          acc.totalQuantity += quantity
        }
        return acc
      },
      { skuCount: 0, totalQuantity: 0 }
    )
  }, [editableItems])

  const hasPendingItemChanges = useMemo(
    () => editableItemsChanged(detail, editableItems),
    [detail, editableItems]
  )

  const trimmedShipmentNoFilter = shipmentNoFilter.trim()

  const fbaBoxSummary = useMemo(() => {
    return fbaBoxItems.reduce(
      (acc, item) => {
        acc.totalQuantity += item.quantity
        acc.totalCartons += item.carton_count
        acc.totalWeightKg += item.total_weight_kg
        acc.totalVolumeM3 += item.total_volume_m3
        return acc
      },
      { totalQuantity: 0, totalCartons: 0, totalWeightKg: 0, totalVolumeM3: 0 }
    )
  }, [fbaBoxItems])

  const fbaBoxWarehouseGroups = useMemo(() => {
    const groups: { warehouseCode: string | null; startIndex: number; endIndex: number }[] = []
    let currentWarehouse: string | null = null
    let startIndex = 0

    fbaBoxItems.forEach((item, index) => {
      const warehouse = item.warehouse_code
      if (warehouse !== currentWarehouse) {
        if (currentWarehouse !== null) {
          groups.push({
            warehouseCode: currentWarehouse,
            startIndex,
            endIndex: index - 1,
          })
        }
        currentWarehouse = warehouse
        startIndex = index
      }
    })

    if (currentWarehouse !== null) {
      groups.push({
        warehouseCode: currentWarehouse,
        startIndex,
        endIndex: fbaBoxItems.length - 1,
      })
    }

    return groups
  }, [fbaBoxItems])

  const loadProjects = useCallback(async () => {
    if (status === 'loading') {
      return
    }

    setProjectsLoading(true)
    try {
      const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
      setProjects(payload)
      if (!isAdmin && payload.length === 1) {
        setProjectFilter(String(payload[0].id))
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '项目列表加载失败')
    } finally {
      setProjectsLoading(false)
    }
  }, [isAdmin, session, status])

  const loadProjectSkus = useCallback(async (projectIdText: string, country: string) => {
    const projectId = Number(projectIdText)
    const projectName = projects.find((project) => project.id === projectId)?.name
    if (!projectName) {
      setProjectSkuOptions([])
      return
    }

    setProjectSkuLoading(true)
    try {
      const allItems: ProjectSkuOption[] = []
      let nextPage = 1
      let hasNextPage = true

      while (hasNextPage) {
        const params = new URLSearchParams({
          project_name: projectName,
          country,
          page: String(nextPage),
          page_size: '200',
        })
        const response = await fetch(`${API_BASE}/api/v1/sku-info?${params.toString()}`, {
          headers: authHeaders(),
          cache: 'no-store',
        })
        if (!response.ok) throw new Error(await parseError(response))

        const payload = (await response.json()) as {
          items: Array<{ sku: string; asin: string; fnsku: string | null }>
          has_next: boolean
        }
        allItems.push(
          ...payload.items.map((item) => ({
            sku: item.sku,
            asin: item.asin,
            fnsku: item.fnsku,
          }))
        )
        hasNextPage = payload.has_next
        nextPage += 1
      }

      setProjectSkuOptions(allItems)
    } catch (loadError) {
      setProjectSkuOptions([])
      setError(loadError instanceof Error ? loadError.message : '项目 SKU 列表加载失败')
    } finally {
      setProjectSkuLoading(false)
    }
  }, [projects])

  const loadList = useCallback(async (targetPage: number) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        page: String(targetPage),
        page_size: String(pageSize),
        include_total: 'true',
      })
      if (projectFilter !== 'all') params.set('project_id', projectFilter)
      if (countryFilter !== 'all') params.set('country', countryFilter)
      if (statusFilter !== 'all') params.set('shipment_status', statusFilter)
      if (shipmentNoFilter.trim()) params.set('shipment_no', shipmentNoFilter.trim())
      if (shipmentDateFrom) params.set('created_date_from', shipmentDateFrom)
      if (shipmentDateTo) params.set('created_date_to', shipmentDateTo)

      const response = await fetch(`${API_BASE}/api/v1/shipment-schedules?${params.toString()}`, {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(await parseError(response))

      const payload = (await response.json()) as ShipmentScheduleListResponse
      setItems(payload.items)
      setPage(payload.page)
      setTotal(payload.total || 0)
      setHasNext(payload.has_next)
      setSelectedId((current) => {
        if (payload.items.length === 0) return null
        if (current && payload.items.some((item) => item.id === current)) return current
        return payload.items[0].id
      })
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '船期列表加载失败')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [countryFilter, pageSize, projectFilter, shipmentDateFrom, shipmentDateTo, shipmentNoFilter, statusFilter])

  const loadShipmentNoOptions = useCallback(async () => {
    setShipmentNoOptionsLoading(true)
    try {
      const shipmentNos: string[] = []
      let nextPage = 1
      let hasNextPage = true

      while (hasNextPage) {
        const params = new URLSearchParams({
          page: String(nextPage),
          page_size: '200',
          include_total: 'false',
        })
        if (projectFilter !== 'all') params.set('project_id', projectFilter)
        if (countryFilter !== 'all') params.set('country', countryFilter)
        if (statusFilter !== 'all') params.set('shipment_status', statusFilter)
        if (shipmentDateFrom) params.set('created_date_from', shipmentDateFrom)
        if (shipmentDateTo) params.set('created_date_to', shipmentDateTo)

        const response = await fetch(`${API_BASE}/api/v1/shipment-schedules?${params.toString()}`, {
          headers: authHeaders(),
          cache: 'no-store',
        })
        if (!response.ok) throw new Error(await parseError(response))

        const payload = (await response.json()) as ShipmentScheduleListResponse
        shipmentNos.push(...payload.items.map((item) => item.shipment_no))
        hasNextPage = payload.has_next
        nextPage += 1
      }

      const uniqueShipmentNos = Array.from(new Set(shipmentNos)).sort((a, b) => a.localeCompare(b, 'zh-CN'))
      setShipmentNoOptions(uniqueShipmentNos)
    } catch {
      setShipmentNoOptions([])
    } finally {
      setShipmentNoOptionsLoading(false)
    }
  }, [countryFilter, projectFilter, shipmentDateFrom, shipmentDateTo, statusFilter])

  const loadDetail = useCallback(async (scheduleId: number) => {
    setDetailLoading(true)
    setDetailError(null)
    try {
      const response = await fetch(`${API_BASE}/api/v1/shipment-schedules/${scheduleId}`, {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(await parseError(response))
      const payload = (await response.json()) as ShipmentScheduleDetail
      setDetail(payload)
      return payload
    } catch (loadError) {
      setDetail(null)
      setDetailError(loadError instanceof Error ? loadError.message : '详情加载失败')
      return null
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const syncEditDialogFromDetail = useCallback((payload: ShipmentScheduleDetail) => {
    setDetail(payload)
    setForm(buildFormFromDetail(payload))
    setEditableItems(buildEditableItems(payload))
    setLogisticsUnitPrice(payload.logistics_unit_price > 0 ? String(payload.logistics_unit_price) : '')
    setCostPreviewRows(buildCostPreviewRows(payload))
    setCostPreviewError(null)
  }, [])

  const loadSkuSummary = useCallback(async () => {
    setSkuSummaryLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        include_only_history_calc: 'true',
        shipment_status: HISTORY_SHIPMENT_STATUSES.join(','),
      })
      if (projectFilter !== 'all') params.set('project_id', projectFilter)
      if (countryFilter !== 'all') params.set('country', countryFilter)
      const response = await fetch(`${API_BASE}/api/v1/shipment-schedules/sku-summary?${params.toString()}`, {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(await parseError(response))
      const payload = (await response.json()) as ShipmentSkuSummaryResponse
      setSkuSummaryItems(payload.items)
    } catch (loadError) {
      setSkuSummaryItems([])
      setError(loadError instanceof Error ? loadError.message : 'SKU 汇总加载失败')
    } finally {
      setSkuSummaryLoading(false)
    }
  }, [countryFilter, projectFilter])

  const loadCostSummary = useCallback(async () => {
    setCostSummaryLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (projectFilter !== 'all') params.set('project_id', projectFilter)
      if (countryFilter !== 'all') params.set('country', countryFilter)
      if (statusFilter !== 'all') params.set('shipment_status', statusFilter)
      if (shipmentNoFilter.trim()) params.set('shipment_no', shipmentNoFilter.trim())
      if (shipmentDateFrom) params.set('created_date_from', shipmentDateFrom)
      if (shipmentDateTo) params.set('created_date_to', shipmentDateTo)

      const response = await fetch(`${API_BASE}/api/v1/shipment-schedules/cost-summary?${params.toString()}`, {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(await parseError(response))
      const payload = (await response.json()) as ShipmentScheduleCostSummary
      setCostSummary(payload)
    } catch (loadError) {
      setCostSummary({
        shipment_count: 0,
        total_sku: 0,
        total_quantity: 0,
        total_chargeable_weight_kg: 0,
        total_logistics_cost: 0,
      })
      setError(loadError instanceof Error ? loadError.message : '发货费用汇总加载失败')
    } finally {
      setCostSummaryLoading(false)
    }
  }, [countryFilter, projectFilter, shipmentDateFrom, shipmentDateTo, shipmentNoFilter, statusFilter])

  const loadFbaBoxDetails = useCallback(async (shipmentNo: string) => {
    setFbaBoxLoading(true)
    setFbaBoxError(null)
    try {
      const params = new URLSearchParams({ shipment_no: shipmentNo })
      const response = await fetch(`${API_BASE}/api/v1/shipment-schedules/fba-box-details?${params.toString()}`, {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(await parseError(response))
      const payload = (await response.json()) as ShipmentFbaBoxDetailResponse
      setFbaBoxMeta({
        projectName: payload.project_name,
        country: payload.country,
        shipmentNo: payload.shipment_no,
      })
      setFbaBoxItems(payload.items)
    } catch (loadError) {
      setFbaBoxMeta(null)
      setFbaBoxItems([])
      setFbaBoxError(loadError instanceof Error ? loadError.message : 'FBA 箱单明细加载失败')
    } finally {
      setFbaBoxLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  useEffect(() => {
    void loadList(1)
  }, [loadList])

  useEffect(() => {
    void loadSkuSummary()
  }, [loadSkuSummary])

  useEffect(() => {
    void loadCostSummary()
  }, [loadCostSummary])

  useEffect(() => {
    void loadShipmentNoOptions()
  }, [loadShipmentNoOptions])

  useEffect(() => {
    if (selectedId) {
      void loadDetail(selectedId)
    } else {
      setDetail(null)
      setDetailError(null)
    }
  }, [loadDetail, selectedId])

  useEffect(() => {
    if (activeTab !== 'fba-box-detail') return
    if (!trimmedShipmentNoFilter) {
      setFbaBoxMeta(null)
      setFbaBoxItems([])
      setFbaBoxError(null)
      return
    }
    void loadFbaBoxDetails(trimmedShipmentNoFilter)
  }, [activeTab, loadFbaBoxDetails, trimmedShipmentNoFilter])

  useEffect(() => {
    if (!dialogOpen || dialogMode !== 'edit' || !form.project_id) return
    void loadProjectSkus(form.project_id, form.country)
  }, [dialogMode, dialogOpen, form.country, form.project_id, loadProjectSkus])

  const openCreateDialog = () => {
    setDialogMode('create')
    setForm(createEmptyForm())
    setEditableItems([])
    setProjectSkuOptions([])
    setLogisticsUnitPrice('')
    setCostPreviewRows([])
    setCostPreviewError(null)
    setDialogOpen(true)
  }

  const openEditDialog = () => {
    if (!detail) return
    setDialogMode('edit')
    syncEditDialogFromDetail(detail)
    setDialogOpen(true)
  }

  const handleEditSchedule = async (scheduleId: number) => {
    setSelectedId(scheduleId)
    if (detail?.id === scheduleId) {
      openEditDialog()
      return
    }

    setDetailLoading(true)
    setDetailError(null)
    try {
      const response = await fetch(`${API_BASE}/api/v1/shipment-schedules/${scheduleId}`, {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(await parseError(response))
      const payload = (await response.json()) as ShipmentScheduleDetail
      setDialogMode('edit')
      syncEditDialogFromDetail(payload)
      setDialogOpen(true)
    } catch (loadError) {
      setDetail(null)
      setDetailError(loadError instanceof Error ? loadError.message : '详情加载失败')
    } finally {
      setDetailLoading(false)
    }
  }

  const openSkuDialog = async (scheduleId: number) => {
    setSkuDialogScheduleId(scheduleId)
    setSkuDialogOpen(true)
    setSkuDialogLoading(true)
    try {
      const response = await fetch(`${API_BASE}/api/v1/shipment-schedules/${scheduleId}`, {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(await parseError(response))
      const payload = (await response.json()) as ShipmentScheduleDetail
      setSkuDialogDetail(payload)
    } catch (loadError) {
      setSkuDialogDetail(null)
    } finally {
      setSkuDialogLoading(false)
    }
  }

  const handleFormChange = (field: keyof ScheduleFormState, value: string) => {
    setForm((current) => ({ ...current, [field]: value }))
  }

  const handleEditableItemChange = (tempId: string, field: keyof EditableShipmentItem, value: string) => {
    setEditableItems((current) => current.map((item) => (item.tempId === tempId ? { ...item, [field]: value } : item)))
    setCostPreviewRows([])
    setCostPreviewError(null)
  }

  const handleAddEditableItem = () => {
    setEditableItems((current) => [...current, createEmptyEditableShipmentItem()])
    setCostPreviewRows([])
    setCostPreviewError(null)
  }

  const handleRemoveEditableItem = (tempId: string) => {
    setEditableItems((current) => {
      const nextItems = current.filter((item) => item.tempId !== tempId)
      return nextItems.length > 0 ? nextItems : [createEmptyEditableShipmentItem()]
    })
    setCostPreviewRows([])
    setCostPreviewError(null)
  }

  const handleCalculateShipmentCosts = useCallback(async (sourceDetail: ShipmentScheduleDetail) => {
    if (sourceDetail.items.length === 0) {
      setCostPreviewRows([])
      setCostPreviewError('请先导入 SKU 明细，再执行核算')
      return
    }

    const normalizedUnitPrice = logisticsUnitPrice.trim()
    const unitPrice = normalizedUnitPrice ? Number(normalizedUnitPrice) : 0
    if (normalizedUnitPrice && (!Number.isFinite(unitPrice) || unitPrice < 0)) {
      setCostPreviewRows([])
      setCostPreviewError('物流报价必须是大于等于 0 的数字')
      return
    }

    setCostPreviewLoading(true)
    setCostPreviewError(null)
    try {
      const response = await fetch(`${API_BASE}/api/v1/shipment-schedules/${sourceDetail.id}/costs/calculate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify({
          logistics_unit_price: unitPrice,
        }),
      })
      if (!response.ok) throw new Error(await parseError(response))

      const payload = (await response.json()) as ShipmentScheduleDetail
      setDetail(payload)
      setItems((current) =>
        current.map((item) => (item.id === payload.id ? { ...item, ...payload } : item))
      )
      const rows = payload.items.map((item) => ({
        id: item.id,
        sku: item.sku,
        quantity: item.quantity,
        volumeM3: item.volume_m3,
        actualWeightKg: item.actual_weight_kg,
        volumetricWeightKg: item.volumetric_weight_kg,
        chargeableWeightKg: item.chargeable_weight_kg,
        estimatedCost: item.estimated_logistics_cost,
        averageUnitPrice: item.average_logistics_unit_price,
      }))
      setCostPreviewRows(rows)
    } catch (calculateError) {
      setCostPreviewRows([])
      setCostPreviewError(calculateError instanceof Error ? calculateError.message : '核算失败')
    } finally {
      setCostPreviewLoading(false)
    }
  }, [logisticsUnitPrice])

  const submitForm = async () => {
    if (!form.project_id) {
      setError('请选择项目')
      return
    }
    if (!form.shipment_no.trim()) {
      setError('请输入货件编号')
      return
    }
    const normalizedEditableItems =
      dialogMode === 'edit'
        ? editableItems
            .map((item, index) => ({
              index,
              sku: item.sku.trim(),
              quantity: item.quantity.trim(),
            }))
            .filter((item) => item.sku || item.quantity)
        : []

    if (dialogMode === 'edit') {
      const seenSkus = new Set<string>()
      for (const item of normalizedEditableItems) {
        if (!item.sku) {
          setError(`第 ${item.index + 1} 行请选择 SKU`)
          return
        }
        if (!item.quantity) {
          setError(`第 ${item.index + 1} 行请输入数量`)
          return
        }
        const quantity = Number(item.quantity)
        if (!Number.isInteger(quantity) || quantity <= 0) {
          setError(`第 ${item.index + 1} 行数量必须是大于 0 的整数`)
          return
        }
        if (seenSkus.has(item.sku)) {
          setError(`SKU 明细中存在重复 SKU：${item.sku}`)
          return
        }
        seenSkus.add(item.sku)
      }
    }

    setSubmitting(true)
    setError(null)
    setSuccessMessage(null)
    try {
      const payload = {
        ...form,
        project_id: Number(form.project_id),
        country: form.country,
        shipment_no: form.shipment_no.trim(),
        tracking_no: form.tracking_no || null,
        warehouse_code: form.warehouse_code || null,
        forwarder_name: form.forwarder_name || null,
        created_date: form.created_date || null,
        etd_date: form.etd_date || null,
        eta_date: form.eta_date || null,
        actual_inbound_date: form.actual_inbound_date || null,
        logistics_unit_price: logisticsUnitPrice.trim() ? Number(logisticsUnitPrice) : 0,
        include_in_history_shipping_calc: form.include_in_history_shipping_calc === 'yes',
        remark: form.remark || null,
      }

      const url =
        dialogMode === 'create'
          ? `${API_BASE}/api/v1/shipment-schedules`
          : `${API_BASE}/api/v1/shipment-schedules/${selectedId}`
      const method = dialogMode === 'create' ? 'POST' : 'PATCH'
      const body =
        dialogMode === 'create'
          ? payload
          : {
              project_id: payload.project_id,
              country: payload.country,
              shipment_no: payload.shipment_no,
              tracking_no: payload.tracking_no,
              warehouse_code: payload.warehouse_code,
              forwarder_name: payload.forwarder_name,
              shipping_method: payload.shipping_method,
              created_date: payload.created_date,
              etd_date: payload.etd_date,
              eta_date: payload.eta_date,
              actual_inbound_date: payload.actual_inbound_date,
              logistics_unit_price: payload.logistics_unit_price,
              include_in_history_shipping_calc: payload.include_in_history_shipping_calc,
              remark: payload.remark,
              shipment_status: payload.shipment_status,
              items:
                dialogMode === 'edit' && hasPendingItemChanges
                  ? normalizedEditableItems.map((item) => ({
                      sku: item.sku,
                      quantity: Number(item.quantity),
                    }))
                  : undefined,
            }

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(await parseError(response))

      const saved = (await response.json()) as ShipmentScheduleDetail
      setDialogOpen(false)
      setSelectedId(saved.id)
      setSuccessMessage(dialogMode === 'create' ? '船期记录已创建' : '船期记录已更新')
      await loadList(dialogMode === 'create' ? 1 : page)
      await loadSkuSummary()
      await loadDetail(saved.id)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '保存失败')
    } finally {
      setSubmitting(false)
    }
  }

  const downloadTemplate = () => {
    if (!detail) return
    downloadCsvFile(
      `${detail.shipment_no}-items-template.csv`,
      ['project_name', 'shipment_no', 'SKU', 'quantity'],
      [[detail.project_name, detail.shipment_no, 'SKU-DEMO', 100]]
    )
  }

  const downloadBatchTemplate = () => {
    const fallbackProjectName = projects[0]?.name || '项目名称'
    downloadCsvFile(
      'shipment-schedules-template.csv',
      [
        'project_name',
        'country',
        'shipment_no',
        'shipping_method',
        'shipment_status',
        'tracking_no',
        'warehouse_code',
        'forwarder_name',
        'created_date',
        'etd_date',
        'eta_date',
        'actual_inbound_date',
        'remark',
      ],
      [
        [
          fallbackProjectName,
          'US',
          'FBA19647N7ZW',
          'sea',
          'draft',
          '',
          '',
          '',
          '2026-03-11',
          '2026-03-15',
          '2026-04-08',
          '',
          '日期建议统一填 YYYY-MM-DD',
        ],
      ]
    )
  }

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !selectedId) return

    setImporting(true)
    setError(null)
    setSuccessMessage(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const response = await fetch(`${API_BASE}/api/v1/shipment-schedules/${selectedId}/items/import-csv`, {
        method: 'POST',
        headers: authHeaders(),
        body: formData,
      })
      if (!response.ok) throw new Error(await parseError(response))

      const payload = (await response.json()) as {
        inserted: number
        replaced: number
        total_quantity: number
      }
      setSuccessMessage(`明细导入完成：新增 ${payload.inserted} 行，替换旧数据 ${payload.replaced} 行，总数量 ${payload.total_quantity}`)
      await loadList(page)
      await loadSkuSummary()
      const refreshedDetail = await loadDetail(selectedId)
      if (refreshedDetail) {
        syncEditDialogFromDetail(refreshedDetail)
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'CSV 导入失败')
    } finally {
      setImporting(false)
    }
  }

  const handleBatchImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setBatchImporting(true)
    setError(null)
    setSuccessMessage(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const response = await fetch(`${API_BASE}/api/v1/shipment-schedules/import-csv`, {
        method: 'POST',
        headers: authHeaders(),
        body: formData,
      })
      if (!response.ok) throw new Error(await parseError(response))

      const payload = (await response.json()) as ShipmentSchedulesImportResponse
      const preview = payload.shipment_nos.slice(0, 5).join('、')
      const suffix = payload.shipment_nos.length > 5 ? ` 等 ${payload.shipment_nos.length} 个批次` : ''
      setSuccessMessage(`批量导入完成：新增 ${payload.inserted} 个发货批次${preview ? `（${preview}${suffix}）` : ''}`)
      await loadList(1)
      await loadSkuSummary()
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : '批量导入失败')
    } finally {
      setBatchImporting(false)
    }
  }

  const handleDeleteSchedule = async () => {
    if (!isAdmin || !detail) return

    setDeleting(true)
    setError(null)
    setSuccessMessage(null)
    try {
      const response = await fetch(`${API_BASE}/api/v1/shipment-schedules/${detail.id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      })
      if (!response.ok) throw new Error(await parseError(response))

      const deletedShipmentNo = detail.shipment_no
      setDeleteDialogOpen(false)
      setDialogOpen(false)
      setDetail(null)
      setDetailError(null)
      setSelectedId(null)
      setSuccessMessage(`船期批次 ${deletedShipmentNo} 已删除`)
      await loadList(1)
      await loadSkuSummary()
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  const exportOverviewToExcel = async () => {
    if (items.length === 0) {
      setError('当前没有可导出的船期批次数据')
      return
    }

    setExporting(true)
    setError(null)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()

      const worksheet = workbook.addWorksheet('船期批次总览', {
        views: [{ state: 'frozen', ySplit: 4, xSplit: 1 }],
      })

      const columns = [
        { header: '项目', key: 'project_name', width: 18 },
        { header: '国家', key: 'country', width: 10 },
        { header: '发货时间', key: 'created_date', width: 14 },
        { header: '货件编号', key: 'shipment_no', width: 20 },
        { header: '状态', key: 'shipment_status', width: 12 },
        { header: '运输方式', key: 'shipping_method', width: 12 },
        { header: '货代', key: 'forwarder_name', width: 18 },
        { header: '仓库', key: 'warehouse_code', width: 14 },
        { header: 'ETD', key: 'etd_date', width: 14 },
        { header: 'ETA', key: 'eta_date', width: 14 },
        { header: 'SKU 数', key: 'sku_count', width: 12 },
        { header: '总数量', key: 'total_quantity', width: 14 },
        { header: '追踪号', key: 'tracking_no', width: 22 },
        { header: '备注', key: 'remark', width: 28 },
        { header: '更新时间', key: 'updated_at', width: 22 },
      ] as const

      const lastColumn = columns.length
      const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false })

      worksheet.mergeCells(1, 1, 1, lastColumn)
      worksheet.getCell(1, 1).value = '船期批次总览导出'
      worksheet.getCell(1, 1).font = { name: 'Microsoft YaHei', size: 16, bold: true, color: { argb: 'FF0F172A' } }
      worksheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }

      worksheet.mergeCells(2, 1, 2, lastColumn)
      worksheet.getCell(2, 1).value = `导出时间：${exportedAt}    说明：导出当前筛选条件下的本页船期批次总览数据`
      worksheet.getCell(2, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF475569' } }
      worksheet.getCell(2, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }

      const filterText = [
        projectFilter === 'all' ? '项目：全部' : `项目：${projects.find((project) => String(project.id) === projectFilter)?.name ?? projectFilter}`,
        countryFilter === 'all' ? '国家：全部' : `国家：${countryLabel(countryFilter)}`,
        statusFilter === 'all' ? '状态：全部' : `状态：${statusMeta(statusFilter).label}`,
        `发货时间：${shipmentDateFrom || '不限'} ~ ${shipmentDateTo || '不限'}`,
        shipmentNoFilter.trim() ? `货件编号：${shipmentNoFilter.trim()}` : '货件编号：全部',
      ].join('    ')
      worksheet.mergeCells(3, 1, 3, lastColumn)
      worksheet.getCell(3, 1).value = filterText
      worksheet.getCell(3, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF64748B' } }
      worksheet.getCell(3, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }

      worksheet.columns = columns.map((column) => ({ header: column.header, key: column.key, width: column.width }))

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

      items.forEach((item, index) => {
        const row = worksheet.getRow(index + 5)
        row.values = [
          item.project_name,
          item.country,
          formatDate(item.created_date),
          item.shipment_no,
          statusMeta(item.shipment_status).label,
          methodLabel(item.shipping_method),
          item.forwarder_name || '-',
          item.warehouse_code || '-',
          formatDate(item.etd_date),
          formatDate(item.eta_date),
          item.sku_count,
          item.total_quantity,
          item.tracking_no || '-',
          item.remark || '-',
          formatTime(item.updated_at),
        ]

        row.eachCell((cell, colNumber) => {
          cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
          cell.alignment = {
            vertical: 'middle',
            horizontal: colNumber === 10 || colNumber === 11 ? 'right' : 'left',
            wrapText: true,
          }
          if (colNumber === 10 || colNumber === 11) {
            cell.numFmt = '#,##0'
          }
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          }
          if (colNumber === 4) {
            const statusColorMap: Record<string, string> = {
              草稿: 'FFF1F5F9',
              在途: 'FFE0F2FE',
              已完成: 'FFDCFCE7',
            }
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: statusColorMap[String(cell.value)] ?? 'FFFFFFFF' },
            }
          }
        })
      })

      const totalRow = worksheet.getRow(items.length + 5)
      totalRow.getCell(1).value = '当前页合计'
      totalRow.getCell(10).value = summary.totalSku
      totalRow.getCell(11).value = summary.totalQuantity
      totalRow.eachCell((cell) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        }
      })
      totalRow.getCell(10).numFmt = '#,##0'
      totalRow.getCell(11).numFmt = '#,##0'

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const safeTimestamp = formatLocalTimestampForFilename()
      link.href = url
      link.download = `船期批次总览-${safeTimestamp}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出 Excel 失败')
    } finally {
      setExporting(false)
    }
  }

  const exportCostToExcel = async () => {
    if (items.length === 0) {
      setError('当前没有可导出的发货费用数据')
      return
    }

    setCostExporting(true)
    setError(null)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()

      const worksheet = workbook.addWorksheet('发货费用', {
        views: [{ state: 'frozen', ySplit: 4, xSplit: 1 }],
      })

      const columns = [
        { header: '项目', key: 'project_name', width: 18 },
        { header: '发货时间', key: 'created_date', width: 14 },
        { header: '货件编号', key: 'shipment_no', width: 20 },
        { header: '状态', key: 'shipment_status', width: 12 },
        { header: '货代', key: 'forwarder_name', width: 18 },
        { header: '总发货数量', key: 'total_quantity', width: 14 },
        { header: '总重量(kg)', key: 'total_chargeable_weight_kg', width: 14 },
        { header: '总体积(m³)', key: 'total_volume_m3', width: 14 },
        { header: '物流单价', key: 'logistics_unit_price', width: 12 },
        { header: '单品物流单价', key: 'item_unit_price', width: 14 },
        { header: '物流总价', key: 'logistics_total_price', width: 14 },
      ] as const

      const lastColumn = columns.length
      const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false })
      const totalWeight = items.reduce((acc, item) => acc + item.total_chargeable_weight_kg, 0)
      const totalVolume = items.reduce((acc, item) => acc + item.total_volume_m3, 0)
      const totalLogisticsCost = items.reduce((acc, item) => acc + item.logistics_total_price, 0)

      worksheet.mergeCells(1, 1, 1, lastColumn)
      worksheet.getCell(1, 1).value = '发货费用导出'
      worksheet.getCell(1, 1).font = { name: 'Microsoft YaHei', size: 16, bold: true, color: { argb: 'FF0F172A' } }
      worksheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }

      worksheet.mergeCells(2, 1, 2, lastColumn)
      worksheet.getCell(2, 1).value = `导出时间：${exportedAt}    说明：导出当前筛选条件下的发货费用数据`
      worksheet.getCell(2, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF475569' } }
      worksheet.getCell(2, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }

      const filterText = [
        projectFilter === 'all' ? '项目：全部' : `项目：${projects.find((project) => String(project.id) === projectFilter)?.name ?? projectFilter}`,
        countryFilter === 'all' ? '国家：全部' : `国家：${countryLabel(countryFilter)}`,
        statusFilter === 'all' ? '状态：全部' : `状态：${statusMeta(statusFilter).label}`,
        `发货时间：${shipmentDateFrom || '不限'} ~ ${shipmentDateTo || '不限'}`,
        shipmentNoFilter.trim() ? `货件编号：${shipmentNoFilter.trim()}` : '货件编号：全部',
      ].join('    ')
      worksheet.mergeCells(3, 1, 3, lastColumn)
      worksheet.getCell(3, 1).value = filterText
      worksheet.getCell(3, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF64748B' } }
      worksheet.getCell(3, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }

      worksheet.columns = columns.map((column) => ({ header: column.header, key: column.key, width: column.width }))

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

      items.forEach((item, index) => {
        const row = worksheet.getRow(index + 5)
        row.values = [
          item.project_name,
          formatDate(item.created_date || item.etd_date),
          item.shipment_no,
          statusMeta(item.shipment_status).label,
          item.forwarder_name || '-',
          item.total_quantity,
          item.total_chargeable_weight_kg,
          item.total_volume_m3,
          item.logistics_unit_price > 0 ? item.logistics_unit_price : null,
          item.total_quantity > 0 && item.logistics_total_price > 0 ? item.logistics_total_price / item.total_quantity : null,
          item.logistics_total_price > 0 ? item.logistics_total_price : null,
        ]

        row.eachCell((cell, colNumber) => {
          cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
          cell.alignment = {
            vertical: 'middle',
            horizontal: colNumber >= 6 ? 'right' : 'left',
            wrapText: true,
          }
          if (colNumber === 6) cell.numFmt = '#,##0'
          if (colNumber === 7) cell.numFmt = '#,##0.000'
          if (colNumber === 8) cell.numFmt = '#,##0.0000'
          if (colNumber === 9 || colNumber === 11) cell.numFmt = '#,##0.00'
          if (colNumber === 10) cell.numFmt = '#,##0.0000'
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          }
          if (colNumber === 4) {
            const statusColorMap: Record<string, string> = {
              草稿: 'FFF1F5F9',
              在途: 'FFE0F2FE',
              已完成: 'FFDCFCE7',
            }
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: statusColorMap[String(cell.value)] ?? 'FFFFFFFF' },
            }
          }
        })
      })

      const totalRow = worksheet.getRow(items.length + 5)
      totalRow.getCell(1).value = '当前页合计'
      totalRow.getCell(6).value = summary.totalQuantity
      totalRow.getCell(7).value = totalWeight
      totalRow.getCell(8).value = totalVolume
      totalRow.getCell(11).value = totalLogisticsCost
      totalRow.eachCell((cell) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        }
      })
      totalRow.getCell(6).numFmt = '#,##0'
      totalRow.getCell(7).numFmt = '#,##0.000'
      totalRow.getCell(8).numFmt = '#,##0.0000'
      totalRow.getCell(11).numFmt = '#,##0.00'

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const safeTimestamp = formatLocalTimestampForFilename()
      link.href = url
      link.download = `发货费用-${safeTimestamp}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出 Excel 失败')
    } finally {
      setCostExporting(false)
    }
  }

  const exportSkuSummaryToExcel = async () => {
    if (skuSummaryItems.length === 0) {
      setError('当前没有可导出的 SKU 汇总数据')
      return
    }

    setSkuSummaryExporting(true)
    setError(null)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()

      const worksheet = workbook.addWorksheet('SKU汇总', {
        views: [{ state: 'frozen', ySplit: 4, xSplit: 1 }],
      })

      const columns = [
        { header: '项目', key: 'project_name', width: 18 },
        { header: '国家', key: 'country', width: 10 },
        { header: 'SKU', key: 'sku', width: 28 },
        { header: '参与批次数', key: 'shipment_count', width: 14 },
        { header: '总数量', key: 'total_quantity', width: 14 },
        { header: '总计费重(kg)', key: 'total_chargeable_weight_kg', width: 16 },
        { header: '总发货费用', key: 'total_logistics_cost', width: 16 },
        { header: '平均发运单价', key: 'average_logistics_unit_price', width: 16 },
      ] as const

      const lastColumn = columns.length
      const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false })
      const totalShipmentCount = skuSummaryItems.reduce((acc, item) => acc + item.shipment_count, 0)
      const totalQuantity = skuSummaryItems.reduce((acc, item) => acc + item.total_quantity, 0)
      const totalChargeableWeight = skuSummaryItems.reduce((acc, item) => acc + item.total_chargeable_weight_kg, 0)
      const totalLogisticsCost = skuSummaryItems.reduce((acc, item) => acc + item.total_logistics_cost, 0)

      worksheet.mergeCells(1, 1, 1, lastColumn)
      worksheet.getCell(1, 1).value = 'SKU 汇总导出'
      worksheet.getCell(1, 1).font = { name: 'Microsoft YaHei', size: 16, bold: true, color: { argb: 'FF0F172A' } }
      worksheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }

      worksheet.mergeCells(2, 1, 2, lastColumn)
      worksheet.getCell(2, 1).value = `导出时间：${exportedAt}    说明：仅统计“在途 / 已完成”且“参与历史发货核算”的批次`
      worksheet.getCell(2, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF475569' } }
      worksheet.getCell(2, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }

      const filterText = [
        projectFilter === 'all' ? '项目：全部' : `项目：${projects.find((project) => String(project.id) === projectFilter)?.name ?? projectFilter}`,
        countryFilter === 'all' ? '国家：全部' : `国家：${countryLabel(countryFilter)}`,
        `状态：${HISTORY_SHIPMENT_STATUSES.map((status) => statusMeta(status).label).join('、')}`,
        '口径：仅参与历史发货核算',
      ].join('    ')
      worksheet.mergeCells(3, 1, 3, lastColumn)
      worksheet.getCell(3, 1).value = filterText
      worksheet.getCell(3, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF64748B' } }
      worksheet.getCell(3, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }

      worksheet.columns = columns.map((column) => ({ header: column.header, key: column.key, width: column.width }))

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

      skuSummaryItems.forEach((item, index) => {
        const row = worksheet.getRow(index + 5)
        row.values = [
          item.project_name,
          item.country,
          item.sku,
          item.shipment_count,
          item.total_quantity,
          item.total_chargeable_weight_kg,
          item.total_logistics_cost,
          item.average_logistics_unit_price,
        ]

        row.eachCell((cell, colNumber) => {
          cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
          cell.alignment = {
            vertical: 'middle',
            horizontal: colNumber >= 4 ? 'right' : 'left',
            wrapText: true,
          }
          if (colNumber === 4 || colNumber === 5) cell.numFmt = '#,##0'
          if (colNumber === 6) cell.numFmt = '#,##0.000'
          if (colNumber === 7) cell.numFmt = '#,##0.00'
          if (colNumber === 8) cell.numFmt = '#,##0.0000'
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          }
        })
      })

      const totalRow = worksheet.getRow(skuSummaryItems.length + 5)
      totalRow.getCell(1).value = '合计'
      totalRow.getCell(4).value = totalShipmentCount
      totalRow.getCell(5).value = totalQuantity
      totalRow.getCell(6).value = totalChargeableWeight
      totalRow.getCell(7).value = totalLogisticsCost
      totalRow.eachCell((cell) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        }
      })
      totalRow.getCell(4).numFmt = '#,##0'
      totalRow.getCell(5).numFmt = '#,##0'
      totalRow.getCell(6).numFmt = '#,##0.000'
      totalRow.getCell(7).numFmt = '#,##0.00'

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const safeTimestamp = formatLocalTimestampForFilename()
      link.href = url
      link.download = `SKU汇总-${safeTimestamp}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出 Excel 失败')
    } finally {
      setSkuSummaryExporting(false)
    }
  }

  const exportFbaBoxDetailsToExcel = async () => {
    if (fbaBoxItems.length === 0 || !fbaBoxMeta) {
      setFbaBoxError('当前没有可导出的 FBA 箱单明细')
      return
    }

    setFbaBoxExporting(true)
    setFbaBoxError(null)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()

      const worksheet = workbook.addWorksheet('FBA箱单明细', {
        views: [{ state: 'frozen', ySplit: 3 }],
      })

      const columns = [
        { header: '仓库 ID', key: 'warehouse_code', width: 16 },
        { header: 'SKU', key: 'sku', width: 26 },
        { header: 'ASIN', key: 'asin', width: 20 },
        { header: 'FNSKU', key: 'fnsku', width: 20 },
        { header: '单品长(cm)', key: 'package_length', width: 13 },
        { header: '单品宽(cm)', key: 'package_width', width: 13 },
        { header: '单品高(cm)', key: 'package_height', width: 13 },
        { header: '单品重量(kg)', key: 'package_weight', width: 14 },
        { header: '外箱长(cm)', key: 'carton_length', width: 13 },
        { header: '外箱宽(cm)', key: 'carton_width', width: 13 },
        { header: '外箱高(cm)', key: 'carton_height', width: 13 },
        { header: '外箱重量(kg)', key: 'carton_weight', width: 14 },
        { header: '装箱率', key: 'packing_rate', width: 12 },
        { header: '总箱数', key: 'carton_count', width: 10 },
        { header: '总数量', key: 'quantity', width: 10 },
        { header: '总体积(m³)', key: 'total_volume', width: 14 },
        { header: '总重量(kg)', key: 'total_weight', width: 14 },
      ] as const
      const lastColumn = columns.length

      worksheet.mergeCells(1, 1, 1, lastColumn)
      worksheet.getCell(1, 1).value = `项目：${fbaBoxMeta.projectName}    国家：${countryLabel(fbaBoxMeta.country)}    货件编号：${fbaBoxMeta.shipmentNo}`
      worksheet.getCell(1, 1).font = { name: 'Microsoft YaHei', size: 13, bold: true, color: { argb: 'FF000000' } }
      worksheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
      worksheet.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'left' }

      worksheet.mergeCells(2, 1, 2, lastColumn)
      worksheet.getCell(2, 1).value = `导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`
      worksheet.getCell(2, 1).font = { name: 'Microsoft YaHei', size: 9, color: { argb: 'FF64748B' } }

      const headerRow = worksheet.getRow(3)
      headerRow.values = columns.map((column) => column.header)
      headerRow.height = 22
      headerRow.eachCell((cell) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.alignment = { vertical: 'middle', horizontal: 'center' }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        }
      })

      fbaBoxItems.forEach((item, index) => {
        const row = worksheet.getRow(index + 4)
        row.values = [
          item.warehouse_code || '-',
          item.sku,
          item.asin || '-',
          item.fnsku || '-',
          item.package_length_cm ? formatDecimal(item.package_length_cm, 2) : '-',
          item.package_width_cm ? formatDecimal(item.package_width_cm, 2) : '-',
          item.package_height_cm ? formatDecimal(item.package_height_cm, 2) : '-',
          item.weight_kg ? formatDecimal(item.weight_kg, 3) : '-',
          item.length_cm > 0 ? formatDecimal(item.length_cm, 2) : '-',
          item.width_cm > 0 ? formatDecimal(item.width_cm, 2) : '-',
          item.height_cm > 0 ? formatDecimal(item.height_cm, 2) : '-',
          item.carton_weight_kg ? formatDecimal(item.carton_weight_kg, 3) : '-',
          item.units_per_carton > 0 ? `${item.units_per_carton} / 箱` : '-',
          item.carton_count > 0 ? item.carton_count : '-',
          item.quantity > 0 ? item.quantity : '-',
          item.total_volume_m3,
          item.total_weight_kg,
        ]
        row.height = 18
        row.eachCell((cell, colNumber) => {
          cell.font = { name: 'Microsoft YaHei', size: 9, color: { argb: 'FF0F172A' } }
          cell.alignment = {
            vertical: 'middle',
            horizontal: colNumber >= 14 ? 'right' : 'left',
          }
          if (colNumber === 15) cell.numFmt = '#,##0.0000'
          if (colNumber === 16) cell.numFmt = '#,##0.000'
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          }
        })
      })

      const totalRow = worksheet.getRow(fbaBoxItems.length + 4)
      totalRow.getCell(1).value = '合计'
      totalRow.getCell(14).value = fbaBoxSummary.totalCartons
      totalRow.getCell(15).value = fbaBoxSummary.totalQuantity
      totalRow.getCell(16).value = fbaBoxSummary.totalVolumeM3
      totalRow.getCell(17).value = fbaBoxSummary.totalWeightKg
      totalRow.eachCell((cell) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        }
      })
      totalRow.getCell(16).numFmt = '#,##0.0000'
      totalRow.getCell(17).numFmt = '#,##0.000'

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const safeTimestamp = formatLocalTimestampForFilename()
      link.href = url
      link.download = `FBA箱单明细-${fbaBoxMeta.shipmentNo}-${safeTimestamp}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)
    } catch (exportError) {
      setFbaBoxError(exportError instanceof Error ? exportError.message : '导出 Excel 失败')
    } finally {
      setFbaBoxExporting(false)
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="min-w-0 space-y-6">
      <Card className="dashboard-surface">
        <CardHeader className="gap-4 pb-5">
          <div className="flex flex-col gap-4">
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-primary">Shipment Console</div>
              <CardTitle className="text-2xl tracking-tight">控制台</CardTitle>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_auto] xl:gap-5">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 xl:col-span-1">
          {projectsLoading ? (
            <ShipmentControlSkeleton />
          ) : (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">项目</div>
              <Select value={projectFilter} onValueChange={setProjectFilter}>
              <SelectTrigger>
                <SelectValue placeholder="全部项目" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部项目</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={String(project.id)}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">状态</div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger>
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">国家地区</div>
            <Select value={countryFilter} onValueChange={setCountryFilter}>
            <SelectTrigger>
              <SelectValue placeholder="全部国家" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部国家</SelectItem>
              {COUNTRY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">货件编号</div>
            <SearchableShipmentNoFilter
              value={shipmentNoFilter}
              options={shipmentNoOptions}
              loading={shipmentNoOptionsLoading}
              onChange={setShipmentNoFilter}
            />
          </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <Button size="sm" onClick={() => void loadList(1)} className="h-9 gap-1.5 px-3 text-xs">
                <RefreshCcw className="h-4 w-4" />
                刷新
              </Button>
              <Button size="sm" variant="outline" onClick={openCreateDialog} className="h-9 gap-1.5 px-3 text-xs">
                <Plus className="h-4 w-4" />
                新建批次
              </Button>
              <Button size="sm" variant="outline" onClick={downloadBatchTemplate} className="h-9 gap-1.5 px-3 text-xs">
                <FileDown className="h-4 w-4" />
                下载模板
              </Button>
              <Button asChild size="sm" variant="outline" disabled={batchImporting} className="h-9 gap-1.5 px-3 text-xs">
                <label>
                  <Upload className="h-4 w-4" />
                  {batchImporting ? '导入中...' : '批量导入'}
                  <input type="file" accept=".csv" className="hidden" onChange={handleBatchImportFile} />
                </label>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/40 dark:text-rose-200">{error}</div>
      ) : null}
      {successMessage ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-200">{successMessage}</div>
      ) : null}

      <div className="grid min-w-0 gap-6">
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ShipmentPageTab)} className="min-w-0 w-full">
          <div className="mb-4 overflow-x-auto pb-2 [-webkit-overflow-scrolling:touch] touch-pan-x">
            <TabsList className="flex w-max min-w-full justify-start">
              <TabsTrigger value="overview">总览</TabsTrigger>
              <TabsTrigger value="cost">发货费用</TabsTrigger>
              <TabsTrigger value="sku-summary">SKU汇总</TabsTrigger>
              <TabsTrigger value="fba-box-detail">FBA 箱单明细</TabsTrigger>
            </TabsList>
          </div>
          
          <TabsContent value="overview" className="mt-0 min-w-0">
            <Card className="dashboard-surface min-w-0">
              <CardHeader className="border-b border-border/70">
                <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Overview</div>
                    <CardTitle>船期批次总览</CardTitle>
                    <CardDescription>
                      共 {total} 条记录，当前第 {page} / {pageCount} 页
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" disabled={loading || exporting || items.length === 0} onClick={() => void exportOverviewToExcel()}>
                      <FileDown className="h-4 w-4" />
                      {exporting ? '导出中...' : '导出 Excel'}
                    </Button>
                    <Button variant="outline" disabled={page <= 1 || loading} onClick={() => void loadList(page - 1)}>
                      上一页
                    </Button>
                    <Button variant="outline" disabled={!hasNext || loading} onClick={() => void loadList(page + 1)}>
                      下一页
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {items.length === 0 && !loading ? (
                  <div className="rounded-[28px] border border-dashed border-border px-4 py-14 text-center text-sm text-muted-foreground">
                    当前没有符合筛选条件的船期记录。
                  </div>
                ) : (
                  <div className="relative">
                    {loading && items.length > 0 ? (
                      <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-border/70 bg-background/95 px-3 py-1 text-xs text-muted-foreground shadow-sm">
                        列表更新中...
                      </div>
                    ) : null}
                    <Table containerClassName={TABLE_SCROLL_CONTAINER_CLASS} className="w-full min-w-[1080px]">
                      <TableHeader>
                        <TableRow className="bg-muted/50">
                          <TableHead className="w-[90px] whitespace-nowrap border-r border-border/70 text-sm last:border-r-0">项目</TableHead>
                          <TableHead className="w-[72px] whitespace-nowrap border-r border-border/70 text-sm last:border-r-0">国家</TableHead>
                          <TableHead className="w-[90px] whitespace-nowrap border-r border-border/70 text-sm last:border-r-0">发货时间</TableHead>
                          <TableHead className="w-[120px] whitespace-nowrap border-r border-border/70 text-sm last:border-r-0">货件编号</TableHead>
                          <TableHead className="w-[70px] whitespace-nowrap border-r border-border/70 text-sm last:border-r-0">状态</TableHead>
                          <TableHead className="w-[80px] whitespace-nowrap border-r border-border/70 text-sm last:border-r-0">货代</TableHead>
                          <TableHead className="w-[70px] whitespace-nowrap border-r border-border/70 text-sm last:border-r-0">仓库</TableHead>
                          <TableHead className="w-[90px] whitespace-nowrap border-r border-border/70 text-sm last:border-r-0">ETD</TableHead>
                          <TableHead className="w-[90px] whitespace-nowrap border-r border-border/70 text-sm last:border-r-0">ETA</TableHead>
                          <TableHead className="w-[50px] whitespace-nowrap border-r border-border/70 text-right text-sm last:border-r-0">SKU</TableHead>
                          <TableHead className="w-[60px] whitespace-nowrap border-r border-border/70 text-right text-sm last:border-r-0">数量</TableHead>
                          <TableHead className="w-[60px] whitespace-nowrap text-sm">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {loading && items.length === 0 ? <ShipmentTableSkeleton columns={12} /> : null}
                        {items.map((item) => {
                          const status = statusMeta(item.shipment_status)
                          const country = countryMeta(item.country)
                          return (
                            <TableRow key={item.id} className={item.id === selectedId ? 'bg-primary/5' : ''}>
                              <TableCell className="border-r border-border/60 text-sm font-medium">{item.project_name}</TableCell>
                              <TableCell className="border-r border-border/60 text-sm">
                                <Badge className={`${country.className} h-5 px-2 text-[11px]`}>
                                  {country.label}
                                </Badge>
                              </TableCell>
                              <TableCell className="border-r border-border/60 text-sm">{formatDate(item.created_date)}</TableCell>
                              <TableCell className="border-r border-border/60 text-sm font-medium">{item.shipment_no}</TableCell>
                              <TableCell className="border-r border-border/60">
                                <Badge className={`${status.className} text-[11px] py-0 h-5`}>{status.label}</Badge>
                              </TableCell>
                              <TableCell className="border-r border-border/60 text-sm">{item.forwarder_name || '-'}</TableCell>
                              <TableCell className="border-r border-border/60 text-sm">{item.warehouse_code || '-'}</TableCell>
                              <TableCell className="border-r border-border/60 text-sm">{formatDate(item.etd_date)}</TableCell>
                              <TableCell className="border-r border-border/60 text-sm">{formatDate(item.eta_date)}</TableCell>
                              <TableCell className="border-r border-border/60 text-right text-sm">{item.sku_count}</TableCell>
                              <TableCell className="border-r border-border/60 text-right text-sm">{item.total_quantity.toLocaleString()}</TableCell>
                              <TableCell>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 text-xs px-2"
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    void handleEditSchedule(item.id)
                                  }}
                                >
                                  编辑
                                </Button>
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
          </TabsContent>

          <TabsContent value="cost" className="mt-0 min-w-0">
            <Card className="dashboard-surface min-w-0">
              <CardHeader className="border-b border-border/70">
                <div className="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Shipping Cost</div>
                    <CardTitle>发货费用</CardTitle>
                    
                  </div>
                  <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-center xl:justify-end">
                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end xl:flex-nowrap">
                      <div className="min-w-[220px] space-y-1">
                        <div className="text-[11px] font-medium text-muted-foreground">日期范围</div>
                        <DateRangePicker
                          value={parseDateRangeInputValue(shipmentDateFrom, shipmentDateTo)}
                          onChange={(range) => {
                            setShipmentDateFrom(formatPickerDateInputValue(range?.from))
                            setShipmentDateTo(formatPickerDateInputValue(range?.to))
                          }}
                          className="h-9 w-full"
                        />
                      </div>
                      <Button variant="outline" disabled={loading || costExporting || items.length === 0} onClick={() => void exportCostToExcel()}>
                        <FileDown className="h-4 w-4" />
                        {costExporting ? '导出中...' : '导出 Excel'}
                      </Button>
                    </div>
                    <div className="grid min-w-0 grid-cols-2 gap-2 md:grid-cols-4 xl:shrink-0">
                      {costSummaryLoading ? (
                        <>
                          <ShipmentMetricSkeleton />
                          <ShipmentMetricSkeleton />
                          <ShipmentMetricSkeleton />
                          <ShipmentMetricSkeleton />
                        </>
                      ) : (
                        <>
                          <div className="rounded-2xl border border-sky-500/15 bg-sky-500/5 px-4 py-3">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">批次</div>
                            <div className="mt-1 text-xl font-semibold">{costSummary.shipment_count}</div>
                          </div>
                          <div className="rounded-2xl border border-emerald-500/15 bg-emerald-500/5 px-4 py-3">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">数量</div>
                            <div className="mt-1 text-xl font-semibold">
                              {costSummary.total_quantity.toLocaleString()}
                            </div>
                          </div>
                          <div className="rounded-2xl border border-amber-500/15 bg-amber-500/5 px-4 py-3">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">重量</div>
                            <div className="mt-1 text-xl font-semibold">
                              {formatDecimal(costSummary.total_chargeable_weight_kg)}
                            </div>
                          </div>
                          <div className="rounded-2xl border border-primary/15 bg-primary/5 px-4 py-3">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">总运费</div>
                            <div className="mt-1 text-xl font-semibold">
                              {`¥ ${formatDecimal(costSummary.total_logistics_cost, 2)}`}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 p-0">
                {items.length === 0 && !loading ? (
                  <div className="px-4 py-14 text-center text-sm text-muted-foreground">
                    当前没有符合筛选条件的发货批次。
                  </div>
                ) : (
                  <div className="relative">
                    {loading && items.length > 0 ? (
                      <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-border/70 bg-background/95 px-3 py-1 text-xs text-muted-foreground shadow-sm">
                        发货费用计算中...
                      </div>
                    ) : null}
                    <Table containerClassName={TABLE_SCROLL_CONTAINER_CLASS} className="w-full min-w-[1320px]">
                      <TableHeader>
                        <TableRow className="bg-muted/50">
                          <TableHead className="whitespace-nowrap">项目</TableHead>
                          <TableHead className="whitespace-nowrap">发货时间</TableHead>
                          <TableHead className="whitespace-nowrap">货件编号</TableHead>
                          <TableHead className="whitespace-nowrap">状态</TableHead>
                          <TableHead className="whitespace-nowrap">货代</TableHead>
                          <TableHead className="whitespace-nowrap text-right">总发货数量</TableHead>
                          <TableHead className="whitespace-nowrap text-right">总重量(kg)</TableHead>
                          <TableHead className="whitespace-nowrap text-right">总体积(m³)</TableHead>
                          <TableHead className="whitespace-nowrap text-right">物流单价</TableHead>
                          <TableHead className="whitespace-nowrap text-right">单品物流单价</TableHead>
                          <TableHead className="whitespace-nowrap text-right">物流总价</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {loading && items.length === 0 ? <ShipmentTableSkeleton columns={11} /> : null}
                        {items.map((item) => {
                          const status = statusMeta(item.shipment_status)
                          return (
                            <TableRow key={`cost-${item.id}`} className={item.id === selectedId ? 'bg-primary/5' : ''}>
                              <TableCell className="font-medium">{item.project_name}</TableCell>
                              <TableCell>{formatDate(item.created_date || item.etd_date)}</TableCell>
                              <TableCell className="font-medium">{item.shipment_no}</TableCell>
                              <TableCell>
                                <Badge className={`${status.className} text-[11px] py-0 h-5`}>{status.label}</Badge>
                              </TableCell>
                              <TableCell>{item.forwarder_name || '-'}</TableCell>
                              <TableCell className="text-right">{item.total_quantity.toLocaleString()}</TableCell>
                              <TableCell className="text-right">{formatDecimal(item.total_chargeable_weight_kg)}</TableCell>
                              <TableCell className="text-right">{formatDecimal(item.total_volume_m3, 4)}</TableCell>
                              <TableCell className="text-right">
                                {item.logistics_unit_price > 0 ? formatDecimal(item.logistics_unit_price, 2) : '-'}
                              </TableCell>
                              <TableCell className="text-right">
                                {item.total_quantity > 0 && item.logistics_total_price > 0
                                  ? formatDecimal(item.logistics_total_price / item.total_quantity, 4)
                                  : '-'}
                              </TableCell>
                              <TableCell className="text-right">
                                {item.logistics_total_price > 0 ? formatDecimal(item.logistics_total_price, 2) : '-'}
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
          </TabsContent>

          <TabsContent value="sku-summary" className="mt-0 min-w-0">
            <Card className="dashboard-surface min-w-0">
              <CardHeader className="border-b border-border/70">
                <div className="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">SKU Summary</div>
                    <CardTitle>SKU 汇总</CardTitle>
                  </div>
                  <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-center xl:justify-end">
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        disabled={skuSummaryLoading || skuSummaryExporting || skuSummaryItems.length === 0}
                        onClick={() => void exportSkuSummaryToExcel()}
                      >
                        <FileDown className="h-4 w-4" />
                        {skuSummaryExporting ? '导出中...' : '导出 Excel'}
                      </Button>
                    </div>
                    <div className="grid min-w-0 grid-cols-2 gap-2 md:grid-cols-4 xl:shrink-0">
                      <div className="rounded-2xl border border-sky-500/15 bg-sky-500/5 px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">SKU 数</div>
                        <div className="mt-1 text-xl font-semibold">{skuSummaryItems.length}</div>
                      </div>
                      <div className="rounded-2xl border border-emerald-500/15 bg-emerald-500/5 px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">总数量</div>
                        <div className="mt-1 text-xl font-semibold">
                          {skuSummaryItems.reduce((acc, item) => acc + item.total_quantity, 0).toLocaleString()}
                        </div>
                      </div>
                      <div className="rounded-2xl border border-amber-500/15 bg-amber-500/5 px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">总计费重</div>
                        <div className="mt-1 text-xl font-semibold">
                          {formatDecimal(skuSummaryItems.reduce((acc, item) => acc + item.total_chargeable_weight_kg, 0))}
                        </div>
                      </div>
                      <div className="rounded-2xl border border-primary/15 bg-primary/5 px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">总费用</div>
                        <div className="mt-1 text-xl font-semibold">
                          ¥ {formatDecimal(skuSummaryItems.reduce((acc, item) => acc + item.total_logistics_cost, 0), 2)}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {skuSummaryItems.length === 0 && !skuSummaryLoading ? (
                  <div className="px-4 py-14 text-center text-sm text-muted-foreground">
                    当前没有符合口径的 SKU 汇总数据。
                  </div>
                ) : (
                  <div className="relative">
                    {skuSummaryLoading && skuSummaryItems.length > 0 ? (
                      <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-border/70 bg-background/95 px-3 py-1 text-xs text-muted-foreground shadow-sm">
                        SKU 汇总更新中...
                      </div>
                    ) : null}
                    <Table containerClassName={TABLE_SCROLL_CONTAINER_CLASS} className="w-full min-w-[1120px]">
                      <TableHeader>
                        <TableRow className="bg-muted/50">
                          <TableHead className="whitespace-nowrap">项目</TableHead>
                          <TableHead className="whitespace-nowrap">国家</TableHead>
                          <TableHead className="whitespace-nowrap">SKU</TableHead>
                          <TableHead className="whitespace-nowrap text-right">参与批次数</TableHead>
                          <TableHead className="whitespace-nowrap text-right">总数量</TableHead>
                          <TableHead className="whitespace-nowrap text-right">总计费重(kg)</TableHead>
                          <TableHead className="whitespace-nowrap text-right">总发货费用</TableHead>
                          <TableHead className="whitespace-nowrap text-right">平均发运单价</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {skuSummaryLoading && skuSummaryItems.length === 0 ? <ShipmentTableSkeleton columns={8} /> : null}
                        {skuSummaryItems.map((item) => {
                          const country = countryMeta(item.country)
                          return (
                          <TableRow key={`${item.project_id}-${item.country}-${item.sku}`}>
                            <TableCell className="font-medium">{item.project_name}</TableCell>
                            <TableCell>
                              <Badge className={`${country.className} h-5 px-2 text-[11px]`}>
                                {country.label}
                              </Badge>
                            </TableCell>
                            <TableCell className="font-medium">{item.sku}</TableCell>
                            <TableCell className="text-right">{item.shipment_count}</TableCell>
                            <TableCell className="text-right">{item.total_quantity.toLocaleString()}</TableCell>
                            <TableCell className="text-right">{formatDecimal(item.total_chargeable_weight_kg)}</TableCell>
                            <TableCell className="text-right">¥ {formatDecimal(item.total_logistics_cost, 2)}</TableCell>
                            <TableCell className="text-right">¥ {formatDecimal(item.average_logistics_unit_price, 4)}</TableCell>
                          </TableRow>
                        )})}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="fba-box-detail" className="mt-0 min-w-0">
            <Card className="dashboard-surface min-w-0">
              <CardHeader>
                <div className="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">FBA Box List</div>
                    <CardTitle>FBA 箱单明细</CardTitle>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      disabled={!trimmedShipmentNoFilter || fbaBoxLoading}
                      onClick={() => {
                        if (trimmedShipmentNoFilter) void loadFbaBoxDetails(trimmedShipmentNoFilter)
                      }}
                    >
                      <RefreshCcw className="h-4 w-4" />
                      刷新
                    </Button>
                    <Button variant="outline" disabled={fbaBoxItems.length === 0 || fbaBoxExporting} onClick={() => void exportFbaBoxDetailsToExcel()}>
                      <FileDown className="h-4 w-4" />
                      {fbaBoxExporting ? '导出中...' : '导出 Excel'}
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 p-0">
                {fbaBoxError ? (
                  <div className="mx-4 mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/40 dark:text-rose-200">
                    {fbaBoxError}
                  </div>
                ) : null}
                {!trimmedShipmentNoFilter ? (
                  <div className="px-4 py-14 text-center text-sm text-muted-foreground">
                    请输入完整的 FBA 货件编号后再加载箱单明细。
                  </div>
                ) : fbaBoxItems.length === 0 && !fbaBoxLoading ? (
                  <div className="px-4 py-14 text-center text-sm text-muted-foreground">
                    当前货件暂无可展示的 FBA 箱单明细。
                  </div>
                ) : (
                  <>
                    <div className="grid gap-3 px-4 pb-4 md:grid-cols-6 xl:grid-cols-7">
                      {fbaBoxLoading ? (
                        <>
                          <ShipmentMetricSkeleton />
                          <ShipmentMetricSkeleton />
                          <ShipmentMetricSkeleton />
                          <ShipmentMetricSkeleton />
                          <ShipmentMetricSkeleton />
                          <ShipmentMetricSkeleton />
                        </>
                      ) : (
                        <>
                          {fbaBoxMeta ? (
                            <>
                              {(() => {
                                const country = countryMeta(fbaBoxMeta.country)
                                return (
                                  <>
                              <div className="rounded-2xl border border-slate-500/15 bg-slate-500/5 px-4 py-3">
                                <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">项目</div>
                                <div className="mt-1 text-lg font-semibold truncate" title={fbaBoxMeta.projectName}>
                                  {fbaBoxMeta.projectName}
                                </div>
                              </div>
                              <div className="rounded-2xl border border-slate-500/15 bg-slate-500/5 px-4 py-3">
                                <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">国家地区</div>
                                <div className="mt-2">
                                  <Badge className={`${country.className} h-6 px-2.5 text-xs`}>
                                    {country.label}
                                  </Badge>
                                </div>
                              </div>
                              <div className="rounded-2xl border border-slate-500/15 bg-slate-500/5 px-4 py-3">
                                <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">货件编号</div>
                                <div className="mt-1 text-lg font-semibold truncate" title={fbaBoxMeta.shipmentNo}>
                                  {fbaBoxMeta.shipmentNo}
                                </div>
                              </div>
                                  </>
                                )
                              })()}
                            </>
                          ) : null}
                          <div className="rounded-2xl border border-sky-500/15 bg-sky-500/5 px-4 py-3">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">SKU</div>
                            <div className="mt-1 text-xl font-semibold">{fbaBoxItems.length}</div>
                          </div>
                          <div className="rounded-2xl border border-emerald-500/15 bg-emerald-500/5 px-4 py-3">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">外箱数</div>
                            <div className="mt-1 text-xl font-semibold">{fbaBoxSummary.totalCartons}</div>
                          </div>
                          <div className="rounded-2xl border border-amber-500/15 bg-amber-500/5 px-4 py-3">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">总重量</div>
                            <div className="mt-1 text-xl font-semibold">{formatDecimal(fbaBoxSummary.totalWeightKg)} kg</div>
                          </div>
                          <div className="rounded-2xl border border-primary/15 bg-primary/5 px-4 py-3">
                            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">总体积(m³)</div>
                            <div className="mt-1 text-xl font-semibold">{formatDecimal(fbaBoxSummary.totalVolumeM3, 4)}</div>
                          </div>
                        </>
                      )}
                    </div>
                    <div className="relative">
                      {fbaBoxLoading && fbaBoxItems.length > 0 ? (
                        <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-border/70 bg-background/95 px-3 py-1 text-xs text-muted-foreground shadow-sm">
                          箱单明细更新中...
                        </div>
                      ) : null}
                      <Table containerClassName={TABLE_SCROLL_CONTAINER_CLASS} className="w-full min-w-[1000px]">
                        <TableHeader>
                          <TableRow className="bg-muted/50">
                            <TableHead className="whitespace-nowrap w-[80px]">仓库 ID</TableHead>
                            <TableHead className="whitespace-nowrap w-[140px]">SKU</TableHead>
                            <TableHead className="whitespace-nowrap w-[180px]">单品尺寸和重量</TableHead>
                            <TableHead className="whitespace-nowrap w-[180px]">外箱尺寸和重量</TableHead>
                            <TableHead className="whitespace-nowrap w-[80px] text-right">装箱率</TableHead>
                            <TableHead className="whitespace-nowrap w-[60px] text-right">总箱数</TableHead>
                            <TableHead className="whitespace-nowrap w-[80px] text-right">总数量</TableHead>
                            <TableHead className="whitespace-nowrap w-[80px] text-right">总体积(m³)</TableHead>
                            <TableHead className="whitespace-nowrap w-[80px] text-right">总重量(kg)</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {fbaBoxLoading && fbaBoxItems.length === 0 ? <ShipmentTableSkeleton columns={9} /> : null}
                          {fbaBoxItems.map((item, index) => {
                            const group = fbaBoxWarehouseGroups.find(
                              (g) => index >= g.startIndex && index <= g.endIndex
                            )
                            const rowSpan = group ? group.endIndex - group.startIndex + 1 : 1
                            const showWarehouse = group && group.startIndex === index

                            const packageInfo = item.package_length_cm || item.package_width_cm || item.package_height_cm
                              ? `${formatDimensionText(item.package_length_cm || 0, item.package_width_cm || 0, item.package_height_cm || 0)}${item.weight_kg ? ` / ${formatDecimal(item.weight_kg, 3)} kg` : ''}`
                              : '-'
                            const cartonInfo = item.length_cm || item.width_cm || item.height_cm
                              ? `${formatDimensionText(item.length_cm, item.width_cm, item.height_cm)}${item.carton_weight_kg ? ` / ${formatDecimal(item.carton_weight_kg, 3)} kg` : ''}`
                              : '-'

                            return (
                              <TableRow key={`fba-box-${item.sku}`}>
                                {showWarehouse ? (
                                  <TableCell
                                    className="font-medium font-semibold text-primary bg-primary/5"
                                    rowSpan={rowSpan}
                                  >
                                    {item.warehouse_code || '-'}
                                  </TableCell>
                                ) : null}
                                <TableCell className="font-medium">{item.sku}</TableCell>
                                <TableCell>{packageInfo}</TableCell>
                                <TableCell>{cartonInfo}</TableCell>
                                <TableCell className="text-right">{item.units_per_carton > 0 ? `${item.units_per_carton} / 箱` : '-'}</TableCell>
                                <TableCell className="text-right">{item.carton_count > 0 ? item.carton_count : '-'}</TableCell>
                                <TableCell className="text-right">{item.quantity > 0 ? item.quantity : '-'}</TableCell>
                                <TableCell className="text-right">{formatDecimal(item.total_volume_m3, 4)}</TableCell>
                                <TableCell className="text-right">{formatDecimal(item.total_weight_kg)}</TableCell>
                              </TableRow>
                            )
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-auto dark:border-slate-800 dark:bg-slate-950 sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle className="dark:text-slate-100">{dialogMode === 'create' ? '新建船期批次' : '编辑船期批次'}</DialogTitle>
            <DialogDescription className="dark:text-slate-400">
              {dialogMode === 'create' ? '先创建批次，再在编辑页维护 SKU 明细。' : '可直接在下方维护 SKU 明细，支持项目 SKU 下拉选择与手动增行。'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2 md:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">项目</div>
              <Select value={form.project_id} onValueChange={(value) => handleFormChange('project_id', value)}>
                <SelectTrigger>
                  <SelectValue placeholder="选择项目" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={String(project.id)}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">货件编号</div>
              <Input
                value={form.shipment_no}
                onChange={(event) => handleFormChange('shipment_no', event.target.value)}
                placeholder="如 FBA19647N7ZW"
              />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">运输方式</div>
              <Select value={form.shipping_method} onValueChange={(value) => handleFormChange('shipping_method', value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METHOD_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">国家地区</div>
              <Select value={form.country} onValueChange={(value) => handleFormChange('country', value)}>
                <SelectTrigger>
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
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">状态</div>
              <Select value={form.shipment_status} onValueChange={(value) => handleFormChange('shipment_status', value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">追踪号</div>
              <Input value={form.tracking_no} onChange={(event) => handleFormChange('tracking_no', event.target.value)} />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">仓库编码</div>
              <Input value={form.warehouse_code} onChange={(event) => handleFormChange('warehouse_code', event.target.value)} />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">货代公司</div>
              <Input value={form.forwarder_name} onChange={(event) => handleFormChange('forwarder_name', event.target.value)} />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">发货时间</div>
              <SingleDatePicker value={parseDateInputValue(form.created_date)} onChange={(date) => handleFormChange('created_date', formatPickerDateInputValue(date))} />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">ETD</div>
              <SingleDatePicker value={parseDateInputValue(form.etd_date)} onChange={(date) => handleFormChange('etd_date', formatPickerDateInputValue(date))} />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">ETA</div>
              <SingleDatePicker value={parseDateInputValue(form.eta_date)} onChange={(date) => handleFormChange('eta_date', formatPickerDateInputValue(date))} />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">实际入仓日期</div>
              <SingleDatePicker value={parseDateInputValue(form.actual_inbound_date)} onChange={(date) => handleFormChange('actual_inbound_date', formatPickerDateInputValue(date))} />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">物流报价（物流单价）</div>
              <Input
                inputMode="decimal"
                placeholder="例如 8.50"
                value={logisticsUnitPrice}
                onChange={(event) => setLogisticsUnitPrice(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">是否参与历史发货核算</div>
              <Select
                value={form.include_in_history_shipping_calc}
                onValueChange={(value) => handleFormChange('include_in_history_shipping_calc', value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="yes">是</SelectItem>
                  <SelectItem value="no">否</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 xl:col-span-4">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">备注</div>
              <textarea
                value={form.remark}
                onChange={(event) => handleFormChange('remark', event.target.value)}
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          {dialogMode === 'edit' && detail && (
            <>
              <Separator className="dark:bg-slate-800" />
              <div className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-sm font-semibold">SKU 明细</div>
                    <div className="text-xs text-muted-foreground">
                      {editableItemStats.skuCount} 个 SKU，合计 {editableItemStats.totalQuantity.toLocaleString()} 件
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      className="gap-2"
                      disabled={costPreviewLoading || hasPendingItemChanges}
                      onClick={() => void handleCalculateShipmentCosts(detail)}
                    >
                      {costPreviewLoading ? '核算中...' : '核算'}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (detail) {
                          downloadCsvFile(
                            `${detail.shipment_no}-items-template.csv`,
                            ['project_name', 'shipment_no', 'SKU', 'quantity'],
                            [[detail.project_name, detail.shipment_no, 'SKU-DEMO', 100]]
                          )
                        }
                      }}
                      className="gap-2"
                    >
                      <FileDown className="h-4 w-4" />
                      下载模板
                    </Button>
                    <Button asChild variant="outline" disabled={importing} className="gap-2">
                      <label>
                        <Upload className="h-4 w-4" />
                        {importing ? '导入中...' : '上传 CSV'}
                        <input
                          type="file"
                          accept=".csv"
                          className="hidden"
                          onChange={handleImportFile}
                        />
                      </label>
                    </Button>
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-4">
                  <div className="rounded-2xl border border-border/70 bg-muted/40 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">SKU 数</div>
                    <div className="mt-1 text-lg font-semibold">{detail.sku_count}</div>
                  </div>
                  <div className="rounded-2xl border border-border/70 bg-muted/40 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">体积</div>
                    <div className="mt-1 text-lg font-semibold">{costPreviewRows.length > 0 ? `${formatDecimal(costPreviewSummary.totalVolumeM3, 4)} m³` : '待核算'}</div>
                  </div>
                  <div className="rounded-2xl border border-border/70 bg-muted/40 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">计费重</div>
                    <div className="mt-1 text-lg font-semibold">{costPreviewRows.length > 0 ? `${formatDecimal(costPreviewSummary.totalChargeableWeightKg)} kg` : '待核算'}</div>
                  </div>
                  <div className="rounded-2xl border border-border/70 bg-muted/40 px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">预估运费</div>
                    <div className="mt-1 text-lg font-semibold">{costPreviewRows.length > 0 ? `¥ ${formatDecimal(costPreviewSummary.totalEstimatedCost, 2)}` : '待核算'}</div>
                  </div>
                </div>
                <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
                  核算口径：体积按 SKU 信息中的单品长宽高换算为 m³，体积重按长 × 宽 × 高 / 6000，计费重取实际重量与体积重较大值。
                </div>
                {hasPendingItemChanges ? (
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-200">
                    SKU 明细已修改，先点保存，再执行核算。
                  </div>
                ) : null}
                {costPreviewError ? (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/40 dark:text-rose-200">
                    {costPreviewError}
                  </div>
                ) : null}
                <div className="overflow-hidden rounded-[28px] border border-border/70">
                  <div className="max-h-[360px] overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>SKU</TableHead>
                          <TableHead className="w-24 text-right">数量</TableHead>
                          <TableHead className="whitespace-nowrap min-w-[90px] text-right">实际重(kg)</TableHead>
                          <TableHead className="whitespace-nowrap min-w-[90px] text-right">体积重(kg)</TableHead>
                          <TableHead className="whitespace-nowrap min-w-[90px] text-right">体积(m³)</TableHead>
                          <TableHead className="min-w-[100px] text-right">发货费用</TableHead>
                          <TableHead className="min-w-[100px] text-right">平均单价</TableHead>
                          <TableHead className="w-14 text-right">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {editableItems.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                              还没有 SKU 明细
                            </TableCell>
                          </TableRow>
                        ) : (
                          editableItems.map((item) => {
                            const preview = detail.items.find((detailItem) => detailItem.sku === item.sku)
                              ? costPreviewRows.find((row) => row.sku === item.sku)
                              : undefined
                            const selectedSku = projectSkuOptions.find((option) => option.sku === item.sku)
                            return (
                              <TableRow key={item.tempId}>
                                <TableCell className="min-w-[220px]">
                                  <SearchableSkuField
                                    value={item.sku}
                                    options={projectSkuOptions}
                                    loading={projectSkuLoading}
                                    onChange={(value) => handleEditableItemChange(item.tempId, 'sku', value)}
                                  />
                                </TableCell>
                                <TableCell className="w-24 text-right">
                                  <Input
                                    inputMode="numeric"
                                    value={item.quantity}
                                    onChange={(event) => handleEditableItemChange(item.tempId, 'quantity', event.target.value)}
                                    className="h-9 text-right"
                                    placeholder="数量"
                                  />
                                </TableCell>
                                <TableCell className="w-16 text-right">{preview ? formatDecimal(preview.actualWeightKg, 2) : '-'}</TableCell>
                                <TableCell className="w-24 text-right">{preview ? formatDecimal(preview.volumetricWeightKg, 2) : '-'}</TableCell>
                                <TableCell className="w-24 text-right">{preview ? formatDecimal(preview.volumeM3, 2) : '-'}</TableCell>
                                <TableCell className="min-w-[100px] text-right">{preview ? `¥ ${formatDecimal(preview.estimatedCost, 2)}` : '-'}</TableCell>
                                <TableCell className="min-w-[100px] text-right">{preview ? `¥ ${formatDecimal(preview.averageUnitPrice, 2)}` : '-'}</TableCell>
                                <TableCell className="text-right">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => handleRemoveEditableItem(item.tempId)}
                                  >
                                    <X className="h-4 w-4" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            )
                          })
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
                <Button type="button" variant="outline" className="gap-2" onClick={handleAddEditableItem}>
                  <Plus className="h-4 w-4" />
                  增加一行
                </Button>
              </div>
            </>
          )}

          <Separator className="dark:bg-slate-800" />
          <DialogFooter>
            {dialogMode === 'edit' && isAdmin ? (
              <Button
                variant="destructive"
                className="mr-auto"
                onClick={() => setDeleteDialogOpen(true)}
                disabled={submitting || deleting}
              >
                <Trash2 className="h-4 w-4" />
                删除批次
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setDialogOpen(false)} className="dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
              取消
            </Button>
            <Button onClick={() => void submitForm()} disabled={submitting}>
              {submitting ? '保存中...' : dialogMode === 'create' ? '创建' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={skuDialogOpen} onOpenChange={setSkuDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-auto dark:border-slate-800 dark:bg-slate-950 sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="dark:text-slate-100">SKU 明细</DialogTitle>
            <DialogDescription className="dark:text-slate-400">
              {skuDialogDetail ? `${skuDialogDetail.shipment_no} - ${skuDialogDetail.sku_count} 个 SKU，合计 ${skuDialogDetail.total_quantity.toLocaleString()} 件` : ''}
            </DialogDescription>
          </DialogHeader>

          {skuDialogLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : skuDialogDetail ? (
            <div className="overflow-hidden rounded-[28px] border border-border/70">
              <div className="max-h-[500px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>数量</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {skuDialogDetail.items.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={2} className="py-12 text-center text-sm text-muted-foreground">
                          还没有 SKU 明细
                        </TableCell>
                      </TableRow>
                    ) : (
                      skuDialogDetail.items.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="font-medium">{item.sku}</TableCell>
                          <TableCell>{item.quantity.toLocaleString()}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              加载失败
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setSkuDialogOpen(false)} className="dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>确认删除批次</DialogTitle>
            <DialogDescription>
              {detail ? `确定删除船期批次 ${detail.shipment_no} 吗？该批次下的 SKU 明细也会一并删除，且无法恢复。` : '此操作不可恢复。'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)} disabled={deleting}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void handleDeleteSchedule()} disabled={deleting}>
              {deleting ? '删除中...' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
