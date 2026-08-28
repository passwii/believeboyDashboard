'use client'

import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import {
  RefreshCcw,
  Upload,
  FileDown,
  FileSpreadsheet,
  Plus,
  Pencil,
  Trash2,
  X,
  ChevronsUpDown,
  Check,
  Tag,
  LayoutDashboard,
  Coins,
  Package,
  Boxes,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  DirectionalTabTransition,
  SlidingTabsTrigger,
  TabsMotionGroup,
} from '@/components/ui/tab-motion'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { CardTitle } from '@/components/ui/card'
import {
  DataCardContent,
  DataTableCard,
  DataTableCardHeader,
  DataTableCardBody,
} from '@/components/ui/data-card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DateRangePicker,
  SingleDatePicker,
  formatDateInputValue as formatPickerDateInputValue,
  parseDateInputValue,
  parseDateRangeInputValue,
} from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyTableState } from '@/components/ui/empty-state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { TableSkeletonRows } from '@/components/ui/table-skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { ShipmentBatchCombobox } from '@/components/dashboard/shipment/shipment-batch-combobox'
import { useNotifications } from '@/components/notifications'
import { normalizeErrorMessage, parseResponseError } from '@/lib/error-utils'
import { logClientOperation } from '@/lib/operation-audit'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { cn, formatLocalTimestampForFilename } from '@/lib/utils'
import { getCountryLabel } from '@/lib/country'
import { DENSE_CELL, DENSE_HEAD, DataTableCardStatBar } from '@/components/ui/data-card'
import {
  applyBorder,
  applyGroupBanding,
  applyHeaderBorder,
  applyHeaderRowStyle,
  applyTotalRowStyle,
} from '@/lib/excel-styles'
import type { Cell } from 'exceljs'
import { ImageLightbox } from '@/components/dashboard/sku-info/image-lightbox'

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
  shipment_batch: string | null
}

type ShipmentScheduleItemRow = {
  id: number
  item_date: string | null
  sku: string
  quantity: number
  carton_count: number | null
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
const SHIPMENT_TAB_ORDER: ShipmentPageTab[] = ['overview', 'cost', 'sku-summary', 'fba-box-detail']

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
  project_id: number
  project_name: string
  country: string
  shipment_no: string
  warehouse_code: string | null
  sku: string
  product_name: string | null
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
  fba_label_prefix: string
  tracking_no: string | null
  product_image_thumbnail_r2_url: string | null
  product_image_r2_url: string | null
}

type ShipmentFbaBoxDetailResponse = {
  project_ids: number[]
  project_names: string[]
  countries: string[]
  shipment_nos: string[]
  items: ShipmentFbaBoxDetailItem[]
}

type ProjectSkuOption = {
  sku: string
  asin: string
  fnsku: string | null
  product_name: string | null
  units_per_carton: number
  carton_length_cm: number | null
  carton_width_cm: number | null
  carton_height_cm: number | null
  carton_weight_kg: number | null
}

type EditableShipmentItem = {
  tempId: string
  sku: string
  cartonCount: string
  originalQuantity: number | null
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
  shipment_batch: string
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
  'w-full max-w-full overflow-x-auto overflow-y-visible rounded-[inherit] [-webkit-overflow-scrolling:touch] overscroll-x-contain'

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
    shipment_batch: '',
  }
}

function authHeaders(): Record<string, string> {
  return {}
}

async function parseError(response: Response): Promise<string> {
  return parseResponseError(response, '请求失败')
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

/** 导出 Excel 时状态列的底色（与页面徽章配色对应），需在分组带状底纹之后叠加。 */
const SHIPMENT_STATUS_EXPORT_FILLS: Record<string, string> = {
  草稿: 'FFF1F5F9',
  在途: 'FFE0F2FE',
  已完成: 'FFDCFCE7',
}

/** 给导出表格的状态单元格着色；未知状态回退白底。 */
function paintExportStatusCell(cell: Cell) {
  cell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: SHIPMENT_STATUS_EXPORT_FILLS[String(cell.value)] ?? 'FFFFFFFF' },
  }
}

function escapeCsvCell(value: string | number | null | undefined): string {
  const text = String(value ?? '')
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`
  }
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

function ShipmentControlSkeleton() {
  return (
    <div className="flex min-w-0 flex-col space-y-2">
      <Skeleton className="h-4 w-14" />
      <Skeleton className="h-10 w-full" />
    </div>
  )
}

function ShipmentMetricSkeleton() {
  return (
    <div className="rounded-2xl border border-border/60 bg-[hsl(var(--surface-subtle))] px-4 py-3">
      <Skeleton className="h-3 w-12" />
      <Skeleton className="mt-3 h-7 w-20" />
    </div>
  )
}

function statusMeta(status: string): { label: string; className: string } {
  const map: Record<string, { label: string; className: string }> = {
    draft: {
      label: '草稿',
      className:
        'border border-border/70 bg-[hsl(var(--surface-subtle))] text-muted-foreground dark:bg-[hsl(var(--surface-soft))] dark:text-foreground',
    },
    in_transit: {
      label: '在途',
      className:
        'border border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-900/80 dark:bg-sky-950/60 dark:text-sky-300',
    },
    completed: {
      label: '已完成',
      className:
        'border border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-900/80 dark:bg-emerald-950/60 dark:text-emerald-300',
    },
  }
  return (
    map[status] || {
      label: status,
      className:
        'border border-border/70 bg-[hsl(var(--surface-subtle))] text-muted-foreground dark:bg-[hsl(var(--surface-soft))] dark:text-foreground',
    }
  )
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
      className:
        'border border-blue-200 bg-blue-100 text-blue-700 dark:border-blue-900/80 dark:bg-blue-950/60 dark:text-blue-300',
    },
    UK: {
      label: 'UK',
      className:
        'border border-violet-200 bg-violet-100 text-violet-700 dark:border-violet-900/80 dark:bg-violet-950/60 dark:text-violet-300',
    },
    DE: {
      label: 'DE',
      className:
        'border border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-900/80 dark:bg-amber-950/60 dark:text-amber-300',
    },
  }
  return (
    map[country] || {
      label: countryLabel(country),
      className:
        'border border-border/70 bg-[hsl(var(--surface-subtle))] text-muted-foreground dark:bg-[hsl(var(--surface-soft))] dark:text-foreground',
    }
  )
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
    shipment_batch: detail.shipment_batch || '',
  }
}

function buildCostPreviewRows(detail: ShipmentScheduleDetail): ShipmentCostPreviewRow[] {
  return detail.items
    .filter(
      (item) =>
        item.chargeable_weight_kg > 0 || item.volume_m3 > 0 || item.estimated_logistics_cost > 0
    )
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
    cartonCount: '',
    originalQuantity: null,
  }
}

function buildEditableItems(detail: ShipmentScheduleDetail): EditableShipmentItem[] {
  if (detail.items.length === 0) {
    return [createEmptyEditableShipmentItem()]
  }
  return detail.items.map((item) => ({
    tempId: `item-${item.id}`,
    sku: item.sku,
    cartonCount:
      item.carton_count !== undefined && item.carton_count !== null
        ? String(item.carton_count)
        : '',
    originalQuantity: item.quantity,
  }))
}

function editableItemsChanged(
  detail: ShipmentScheduleDetail | null,
  rows: EditableShipmentItem[]
): boolean {
  if (!detail) return false
  const normalizedRows = rows
    .map((item) => ({
      sku: item.sku.trim(),
      originalQuantity: item.originalQuantity,
    }))
    .filter((item) => item.sku || item.originalQuantity !== null)

  if (normalizedRows.length !== detail.items.length) return true
  return normalizedRows.some((item, index) => {
    const source = detail.items[index]
    return item.sku !== source.sku || item.originalQuantity !== source.quantity
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
        className="h-7 w-full justify-between px-2 font-normal text-xs"
        onClick={() => setOpen(true)}
      >
        <span className="truncate text-left">
          {selectedSku ? selectedSku.sku : loading ? '加载中...' : '选择 SKU'}
        </span>
        <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
      </Button>
      <DialogContent
        aria-describedby="shipment-sku-search-dialog-description"
        className="max-w-[calc(100%-2rem)] overflow-hidden rounded-lg p-0 sm:max-w-xl"
      >
        <span id="shipment-sku-search-dialog-description" className="sr-only">
          搜索并选择 SKU
        </span>
        <Command className="max-h-[70vh]">
          <CommandInput placeholder="搜索 SKU" />
          <CommandList>
            <CommandEmpty>{loading ? 'SKU 加载中...' : '没有匹配的 SKU'}</CommandEmpty>
            {options.map((option) => {
              const missingUnits = !option.units_per_carton || option.units_per_carton <= 0
              return (
                <CommandItem
                  key={option.sku}
                  value={option.sku}
                  disabled={missingUnits}
                  onSelect={() => {
                    if (!missingUnits) {
                      onChange(option.sku)
                      setOpen(false)
                    }
                  }}
                  className={cn(missingUnits && 'opacity-50 cursor-not-allowed')}
                >
                  <Check
                    className={cn(
                      'h-4 w-4 shrink-0',
                      value === option.sku ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate flex-1 font-medium">{option.sku}</span>
                    {option.product_name && (
                      <span className="shrink-0 truncate max-w-[200px] text-muted-foreground text-xs">
                        {option.product_name}
                      </span>
                    )}
                    {missingUnits && (
                      <span className="shrink-0 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                        未维护单箱数
                      </span>
                    )}
                  </div>
                </CommandItem>
              )
            })}
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
  onOpen,
}: {
  value: string[]
  options: string[]
  loading: boolean
  onChange: (value: string[]) => void
  /** BEL-423：下拉首次打开时回调（父级据此懒加载选项列表）。 */
  onOpen?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const normalizedQuery = query.trim()
  const canUseTypedValue =
    normalizedQuery.length > 0 && !options.some((option) => option === normalizedQuery)
  const selectedLabel =
    value.length === 0 ? '全部货件' : value.length === 1 ? value[0] : `已选 ${value.length} 个货件`

  const toggleValue = (nextValue: string) => {
    onChange(
      value.includes(nextValue) ? value.filter((item) => item !== nextValue) : [...value, nextValue]
    )
  }

  return (
    <div className="space-y-2">
      <DropdownMenu
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen)
          if (nextOpen) onOpen?.()
          if (!nextOpen) setQuery('')
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="h-10 w-full justify-between px-3 font-normal">
            <span
              className={cn(
                'truncate text-left',
                value.length > 0 ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {selectedLabel}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[280px] p-0"
        >
          <Command shouldFilter className="max-h-[320px]">
            <CommandInput placeholder="搜索货件编号" value={query} onValueChange={setQuery} />
            <CommandList>
              <CommandItem
                value="__all__ 全部货件"
                onSelect={() => {
                  onChange([])
                }}
              >
                <Check
                  className={cn('h-4 w-4', value.length === 0 ? 'opacity-100' : 'opacity-0')}
                />
                <span>全部货件</span>
              </CommandItem>
              {canUseTypedValue ? (
                <CommandItem
                  value={`__typed__ ${normalizedQuery}`}
                  onSelect={() => {
                    toggleValue(normalizedQuery)
                  }}
                >
                  <Check
                    className={cn(
                      'h-4 w-4',
                      value.includes(normalizedQuery) ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate">{normalizedQuery}</span>
                    <span className="text-xs text-muted-foreground">添加当前输入到筛选</span>
                  </div>
                </CommandItem>
              ) : null}
              {options.map((option) => (
                <CommandItem
                  key={option}
                  value={option}
                  onSelect={() => {
                    toggleValue(option)
                  }}
                >
                  <Check
                    className={cn('h-4 w-4', value.includes(option) ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className="truncate">{option}</span>
                </CommandItem>
              ))}
              <CommandEmpty>{loading ? '货件编号加载中...' : '没有匹配的货件编号'}</CommandEmpty>
            </CommandList>
          </Command>
        </DropdownMenuContent>
      </DropdownMenu>
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onChange(value.filter((current) => current !== item))}
              className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-[hsl(var(--surface-subtle))] px-2 py-1 text-[11px] text-foreground transition hover:border-border"
            >
              <span className="max-w-[180px] truncate">{item}</span>
              <X className="h-3 w-3" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function dedupeTrimmedValues(values: string[]): string[] {
  const normalized: string[] = []
  const seen = new Set<string>()
  values.forEach((value) => {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    normalized.push(trimmed)
  })
  return normalized
}

function normalizeShipmentNoList(values: string[]): string[] {
  const parts = values.flatMap((value) => value.split(','))
  return dedupeTrimmedValues(parts)
}

function formatShipmentNoFilterLabel(values: string[]): string {
  if (values.length === 0) return '货件编号：全部'
  if (values.length <= 3) return `货件编号：${values.join('、')}`
  return `货件编号：已选 ${values.length} 个`
}

function formatDimensionText(length: number, width: number, height: number): string {
  if (length <= 0 || width <= 0 || height <= 0) return '-'
  return `${formatDecimal(length, 2)} × ${formatDecimal(width, 2)} × ${formatDecimal(height, 2)} cm`
}

export default function ShipmentManagementPage() {
  const { data: session, status } = useSession()
  const searchParams = useSearchParams()
  const { notify } = useNotifications()
  const isAdmin = Boolean(session?.user?.isAdmin)
  // BEL-423 页内懒加载：cost / sku-summary 两个 tab 的数据仅在首次激活后取数，
  // 避免 mount 即并发拉全部汇总；激活过的 tab 仍随筛选条件变化重载。
  const [activeTab, setActiveTab] = useState<ShipmentPageTab>(() => {
    const requested = searchParams.get('tab')
    return SHIPMENT_TAB_ORDER.includes(requested as ShipmentPageTab)
      ? (requested as ShipmentPageTab)
      : 'overview'
  })
  const [activatedTabs, setActivatedTabs] = useState<ReadonlySet<ShipmentPageTab>>(
    () => new Set<ShipmentPageTab>([activeTab])
  )
  const activateTab = useCallback((tab: ShipmentPageTab) => {
    setActiveTab(tab)
    setActivatedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)))
  }, [])
  // BEL-423 页内懒加载：货件编号筛选选项推迟到下拉首次打开再取数（该请求按 200 条分页
  // 遍历全部船期，货件多时是多个请求），mount 不再发。
  const shipmentNoOptionsRequestedRef = useRef(false)
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

  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [hasNext, setHasNext] = useState(false)

  const [projectFilter, setProjectFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [countryFilter, setCountryFilter] = useState('all')
  const [shipmentNoFilter, setShipmentNoFilter] = useState<string[]>([])
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
  const [fbaBoxMeta, setFbaBoxMeta] = useState<{
    projectNames: string[]
    countries: string[]
    shipmentNos: string[]
  } | null>(null)
  const [fbaBoxItems, setFbaBoxItems] = useState<ShipmentFbaBoxDetailItem[]>([])
  const [fbaLightboxItem, setFbaLightboxItem] = useState<ShipmentFbaBoxDetailItem | null>(null)
  const [labelDownloading, setLabelDownloading] = useState(false)

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
        if (item.originalQuantity !== null) {
          acc.totalQuantity += item.originalQuantity
        } else {
          const cartonCount = Number(item.cartonCount)
          const selectedSku = projectSkuOptions.find((o) => o.sku === item.sku)
          const unitsPerCarton = selectedSku?.units_per_carton ?? 0
          const computedQty =
            Number.isFinite(cartonCount) && cartonCount > 0 && unitsPerCarton > 0
              ? cartonCount * unitsPerCarton
              : Number.isFinite(cartonCount) && cartonCount > 0
                ? cartonCount
                : 0
          acc.totalQuantity += computedQty
        }
        return acc
      },
      { skuCount: 0, totalQuantity: 0 }
    )
  }, [editableItems, projectSkuOptions])

  const hasPendingItemChanges = useMemo(
    () => editableItemsChanged(detail, editableItems),
    [detail, editableItems]
  )

  const selectedShipmentNoFilter = useMemo(
    () => normalizeShipmentNoList(shipmentNoFilter),
    [shipmentNoFilter]
  )
  const shipmentNoParam = useMemo(
    () => normalizeShipmentNoList(searchParams.getAll('shipment_no')),
    [searchParams]
  )
  const requestedTab = searchParams.get('tab')

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
    const groups: {
      shipmentNo: string
      warehouseCode: string | null
      startIndex: number
      endIndex: number
    }[] = []
    if (fbaBoxItems.length === 0) return groups

    // Initialize with the first item so null warehouse_code is handled correctly
    let currentShipmentNo = fbaBoxItems[0].shipment_no
    let currentWarehouse: string | null = fbaBoxItems[0].warehouse_code
    let startIndex = 0

    fbaBoxItems.forEach((item, index) => {
      if (index === 0) return // skip first, already initialized
      const warehouse = item.warehouse_code
      if (warehouse !== currentWarehouse || item.shipment_no !== currentShipmentNo) {
        groups.push({
          shipmentNo: currentShipmentNo,
          warehouseCode: currentWarehouse,
          startIndex,
          endIndex: index - 1,
        })
        currentShipmentNo = item.shipment_no
        currentWarehouse = warehouse
        startIndex = index
      }
    })

    groups.push({
      shipmentNo: currentShipmentNo,
      warehouseCode: currentWarehouse,
      startIndex,
      endIndex: fbaBoxItems.length - 1,
    })

    return groups
  }, [fbaBoxItems])

  const fbaBoxShipmentGroups = useMemo(() => {
    const groups: { shipmentNo: string; startIndex: number; endIndex: number }[] = []
    if (fbaBoxItems.length === 0) return groups

    let currentShipmentNo = fbaBoxItems[0].shipment_no
    let startIndex = 0

    fbaBoxItems.forEach((item, index) => {
      if (index === 0) return
      if (item.shipment_no !== currentShipmentNo) {
        groups.push({
          shipmentNo: currentShipmentNo,
          startIndex,
          endIndex: index - 1,
        })
        currentShipmentNo = item.shipment_no
        startIndex = index
      }
    })

    groups.push({
      shipmentNo: currentShipmentNo,
      startIndex,
      endIndex: fbaBoxItems.length - 1,
    })

    return groups
  }, [fbaBoxItems])

  const fbaBoxTrackingGroups = useMemo(() => {
    const groups: {
      shipmentNo: string
      trackingNo: string | null
      startIndex: number
      endIndex: number
    }[] = []
    if (fbaBoxItems.length === 0) return groups

    let currentShipmentNo = fbaBoxItems[0].shipment_no
    let currentTracking: string | null = fbaBoxItems[0].tracking_no
    let startIndex = 0

    fbaBoxItems.forEach((item, index) => {
      if (index === 0) return
      if (item.tracking_no !== currentTracking || item.shipment_no !== currentShipmentNo) {
        groups.push({
          shipmentNo: currentShipmentNo,
          trackingNo: currentTracking,
          startIndex,
          endIndex: index - 1,
        })
        currentShipmentNo = item.shipment_no
        currentTracking = item.tracking_no
        startIndex = index
      }
    })

    groups.push({
      shipmentNo: currentShipmentNo,
      trackingNo: currentTracking,
      startIndex,
      endIndex: fbaBoxItems.length - 1,
    })

    return groups
  }, [fbaBoxItems])

  const openFbaImageLightbox = useCallback((item: ShipmentFbaBoxDetailItem) => {
    setFbaLightboxItem(item)
  }, [])

  const closeFbaImageLightbox = useCallback(() => {
    setFbaLightboxItem(null)
  }, [])

  const fbaBoxLabelRanges = useMemo(() => {
    const ranges: string[] = []
    const countersByShipment = new Map<string, number>()

    fbaBoxItems.forEach((item) => {
      const count = item.carton_count ?? 0
      if (count <= 0) {
        ranges.push('-')
      } else {
        const shipmentNo = item.shipment_no
        const counter = countersByShipment.get(shipmentNo) ?? 1
        countersByShipment.set(shipmentNo, counter + count)
        const start = counter
        const end = counter + count - 1
        ranges.push(
          `${item.fba_label_prefix}U000${String(start).padStart(3, '0')}-${String(end).padStart(3, '0')}`
        )
      }
    })
    return ranges
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
      notify({ type: 'error', title: normalizeErrorMessage(loadError, '项目列表加载失败') })
    } finally {
      setProjectsLoading(false)
    }
  }, [notify, isAdmin, session, status])

  const loadProjectSkus = useCallback(
    async (projectIdText: string, country: string) => {
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
            items: Array<{
              sku: string
              asin: string
              fnsku: string | null
              product_name: string | null
              units_per_carton: number
              carton_length_cm: number | null
              carton_width_cm: number | null
              carton_height_cm: number | null
              carton_weight_kg: number | null
            }>
            has_next: boolean
          }
          allItems.push(
            ...payload.items.map((item) => ({
              sku: item.sku,
              asin: item.asin,
              fnsku: item.fnsku,
              product_name: item.product_name,
              units_per_carton: item.units_per_carton,
              carton_length_cm: item.carton_length_cm,
              carton_width_cm: item.carton_width_cm,
              carton_height_cm: item.carton_height_cm,
              carton_weight_kg: item.carton_weight_kg,
            }))
          )
          hasNextPage = payload.has_next
          nextPage += 1
        }

        setProjectSkuOptions(allItems)
      } catch (loadError) {
        setProjectSkuOptions([])
        notify({ type: 'error', title: normalizeErrorMessage(loadError, '项目 SKU 列表加载失败') })
      } finally {
        setProjectSkuLoading(false)
      }
    },
    [notify, projects]
  )

  const loadList = useCallback(
    async (targetPage: number) => {
      setLoading(true)
      try {
        const params = new URLSearchParams({
          page: String(targetPage),
          page_size: String(pageSize),
          include_total: 'true',
        })
        if (projectFilter !== 'all') params.set('project_id', projectFilter)
        if (countryFilter !== 'all') params.set('country', countryFilter)
        if (statusFilter !== 'all') params.set('shipment_status', statusFilter)
        selectedShipmentNoFilter.forEach((shipmentNo) => params.append('shipment_no', shipmentNo))
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
        notify({ type: 'error', title: normalizeErrorMessage(loadError, '船期列表加载失败') })
        setItems([])
      } finally {
        setLoading(false)
      }
    },
    [
      notify,
      countryFilter,
      pageSize,
      projectFilter,
      selectedShipmentNoFilter,
      shipmentDateFrom,
      shipmentDateTo,
      statusFilter,
    ]
  )

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

      setShipmentNoOptions(Array.from(new Set(shipmentNos)))
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
      setDetailError(normalizeErrorMessage(loadError, '详情加载失败'))
      return null
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const syncEditDialogFromDetail = useCallback((payload: ShipmentScheduleDetail) => {
    setDetail(payload)
    setForm(buildFormFromDetail(payload))
    setEditableItems(buildEditableItems(payload))
    setLogisticsUnitPrice(
      payload.logistics_unit_price > 0 ? String(payload.logistics_unit_price) : ''
    )
    setCostPreviewRows(buildCostPreviewRows(payload))
    setCostPreviewError(null)
  }, [])

  const loadSkuSummary = useCallback(async () => {
    setSkuSummaryLoading(true)
    try {
      const params = new URLSearchParams()
      if (projectFilter !== 'all') params.set('project_id', projectFilter)
      if (countryFilter !== 'all') params.set('country', countryFilter)
      if (statusFilter !== 'all') params.set('shipment_status', statusFilter)
      selectedShipmentNoFilter.forEach((shipmentNo) => params.append('shipment_no', shipmentNo))
      if (shipmentDateFrom) params.set('created_date_from', shipmentDateFrom)
      if (shipmentDateTo) params.set('created_date_to', shipmentDateTo)
      const response = await fetch(
        `${API_BASE}/api/v1/shipment-schedules/sku-summary?${params.toString()}`,
        {
          headers: authHeaders(),
          cache: 'no-store',
        }
      )
      if (!response.ok) throw new Error(await parseError(response))
      const payload = (await response.json()) as ShipmentSkuSummaryResponse
      setSkuSummaryItems(payload.items)
    } catch (loadError) {
      setSkuSummaryItems([])
      notify({ type: 'error', title: normalizeErrorMessage(loadError, 'SKU 汇总加载失败') })
    } finally {
      setSkuSummaryLoading(false)
    }
  }, [
    notify,
    countryFilter,
    projectFilter,
    selectedShipmentNoFilter,
    shipmentDateFrom,
    shipmentDateTo,
    statusFilter,
  ])

  const loadCostSummary = useCallback(async () => {
    setCostSummaryLoading(true)
    try {
      const params = new URLSearchParams()
      if (projectFilter !== 'all') params.set('project_id', projectFilter)
      if (countryFilter !== 'all') params.set('country', countryFilter)
      if (statusFilter !== 'all') params.set('shipment_status', statusFilter)
      selectedShipmentNoFilter.forEach((shipmentNo) => params.append('shipment_no', shipmentNo))
      if (shipmentDateFrom) params.set('created_date_from', shipmentDateFrom)
      if (shipmentDateTo) params.set('created_date_to', shipmentDateTo)

      const response = await fetch(
        `${API_BASE}/api/v1/shipment-schedules/cost-summary?${params.toString()}`,
        {
          headers: authHeaders(),
          cache: 'no-store',
        }
      )
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
      notify({ type: 'error', title: normalizeErrorMessage(loadError, '发货费用汇总加载失败') })
    } finally {
      setCostSummaryLoading(false)
    }
  }, [
    notify,
    countryFilter,
    projectFilter,
    selectedShipmentNoFilter,
    shipmentDateFrom,
    shipmentDateTo,
    statusFilter,
  ])

  const loadFbaBoxDetails = useCallback(
    async (shipmentNos: string[]) => {
      setFbaBoxLoading(true)
      try {
        const params = new URLSearchParams()
        shipmentNos.forEach((shipmentNo) => params.append('shipment_no', shipmentNo))
        const response = await fetch(
          `${API_BASE}/api/v1/shipment-schedules/fba-box-details?${params.toString()}`,
          {
            headers: authHeaders(),
            cache: 'no-store',
          }
        )
        if (!response.ok) throw new Error(await parseError(response))
        const payload = (await response.json()) as ShipmentFbaBoxDetailResponse
        setFbaBoxMeta({
          projectNames: dedupeTrimmedValues(payload.project_names),
          countries: dedupeTrimmedValues(payload.countries),
          shipmentNos: normalizeShipmentNoList(payload.shipment_nos),
        })
        setFbaBoxItems(payload.items)
      } catch (loadError) {
        setFbaBoxMeta(null)
        setFbaBoxItems([])
        notify({ type: 'error', title: normalizeErrorMessage(loadError, 'FBA 箱单明细加载失败') })
      } finally {
        setFbaBoxLoading(false)
      }
    },
    [notify]
  )

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  useEffect(() => {
    if (!requestedTab && shipmentNoParam.length === 0) return
    if (shipmentNoParam.length > 0) {
      setShipmentNoFilter((current) => {
        const currentNormalized = normalizeShipmentNoList(current)
        return currentNormalized.join(',') === shipmentNoParam.join(',') ? current : shipmentNoParam
      })
    }
    if (requestedTab && SHIPMENT_TAB_ORDER.includes(requestedTab as ShipmentPageTab)) {
      activateTab(requestedTab as ShipmentPageTab)
    }
  }, [requestedTab, shipmentNoParam, activateTab])

  useEffect(() => {
    void loadList(1)
  }, [loadList])

  useEffect(() => {
    if (!activatedTabs.has('sku-summary')) return
    void loadSkuSummary()
  }, [loadSkuSummary, activatedTabs])

  useEffect(() => {
    if (!activatedTabs.has('cost')) return
    void loadCostSummary()
  }, [loadCostSummary, activatedTabs])

  useEffect(() => {
    if (!shipmentNoOptionsRequestedRef.current) return
    void loadShipmentNoOptions()
  }, [loadShipmentNoOptions])

  const handleShipmentNoFilterOpen = useCallback(() => {
    if (shipmentNoOptionsRequestedRef.current) return
    shipmentNoOptionsRequestedRef.current = true
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
    if (selectedShipmentNoFilter.length === 0) {
      setFbaBoxMeta(null)
      setFbaBoxItems([])
      return
    }
    void loadFbaBoxDetails(selectedShipmentNoFilter)
  }, [activeTab, loadFbaBoxDetails, selectedShipmentNoFilter])

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
      setDetailError(normalizeErrorMessage(loadError, '详情加载失败'))
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

  const handleEditableItemChange = (
    tempId: string,
    field: keyof EditableShipmentItem,
    value: string
  ) => {
    setEditableItems((current) =>
      current.map((item) => (item.tempId === tempId ? { ...item, [field]: value } : item))
    )
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

  const handleCalculateShipmentCosts = useCallback(
    async (sourceDetail: ShipmentScheduleDetail) => {
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
        const response = await fetch(
          `${API_BASE}/api/v1/shipment-schedules/${sourceDetail.id}/costs/calculate`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...authHeaders(),
            },
            body: JSON.stringify({
              logistics_unit_price: unitPrice,
            }),
          }
        )
        if (!response.ok) throw new Error(await parseError(response))

        const payload = (await response.json()) as ShipmentScheduleDetail
        setDetail(payload)
        setItems((current) =>
          current.map((item) => (item.id === payload.id ? { ...item, ...payload } : item))
        )
        // Sync carton_count back into editableItems after calculation
        setEditableItems((current) =>
          current.map((editableItem) => {
            const updatedItem = payload.items.find((p) => p.sku === editableItem.sku)
            if (updatedItem?.carton_count !== undefined && updatedItem?.carton_count !== null) {
              return { ...editableItem, cartonCount: String(updatedItem.carton_count) }
            }
            return editableItem
          })
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
        setCostPreviewError(normalizeErrorMessage(calculateError, '核算失败'))
      } finally {
        setCostPreviewLoading(false)
      }
    },
    [logisticsUnitPrice]
  )

  const submitForm = async () => {
    if (!form.project_id) {
      notify({ type: 'error', title: '请选择项目' })
      return
    }
    if (!form.shipment_no.trim()) {
      notify({ type: 'error', title: '请输入货件编号' })
      return
    }
    const normalizedEditableItems =
      dialogMode === 'edit'
        ? editableItems
            .map((item, index) => {
              let quantity: number
              let cartonCount: number | null = null
              if (item.originalQuantity !== null) {
                // 历史数据：直接用原始数量，不改 carton_count
                quantity = item.originalQuantity
              } else {
                // 新数据：装箱率 × 外箱数
                const selectedSku = projectSkuOptions.find((o) => o.sku === item.sku.trim())
                const unitsPerCarton = selectedSku?.units_per_carton ?? 0
                const cartonCountNum = Number(item.cartonCount.trim())
                if (Number.isFinite(cartonCountNum) && cartonCountNum > 0) {
                  cartonCount = cartonCountNum
                  quantity = unitsPerCarton > 0 ? cartonCountNum * unitsPerCarton : cartonCountNum
                } else {
                  quantity = 0
                }
              }
              return { index, sku: item.sku.trim(), quantity, cartonCount }
            })
            .filter((item) => item.sku || item.quantity > 0)
        : []

    if (dialogMode === 'edit') {
      const seenSkus = new Set<string>()
      for (const item of normalizedEditableItems) {
        if (!item.sku) {
          notify({ type: 'error', title: `第 ${item.index + 1} 行请选择 SKU` })
          return
        }
        if (item.quantity <= 0) {
          notify({ type: 'error', title: `第 ${item.index + 1} 行请输入有效的数量` })
          return
        }
        if (seenSkus.has(item.sku)) {
          notify({ type: 'error', title: `SKU 明细中存在重复 SKU：${item.sku}` })
          return
        }
        seenSkus.add(item.sku)
      }
    }

    setSubmitting(true)
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
        shipment_batch: form.shipment_batch.trim() || null,
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
              shipment_batch: payload.shipment_batch,
              items:
                dialogMode === 'edit' && hasPendingItemChanges
                  ? normalizedEditableItems.map((item) => ({
                      sku: item.sku,
                      quantity: Number(item.quantity),
                      carton_count: item.cartonCount,
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
      notify({
        type: 'success',
        title: dialogMode === 'create' ? '船期记录已创建' : '船期记录已更新',
      })
      await loadList(dialogMode === 'create' ? 1 : page)
      await loadSkuSummary()
      await loadDetail(saved.id)
    } catch (submitError) {
      notify({ type: 'error', title: normalizeErrorMessage(submitError, '保存失败') })
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
    try {
      const formData = new FormData()
      formData.append('file', file)
      const response = await fetch(
        `${API_BASE}/api/v1/shipment-schedules/${selectedId}/items/import-csv`,
        {
          method: 'POST',
          headers: authHeaders(),
          body: formData,
        }
      )
      if (!response.ok) throw new Error(await parseError(response))

      const payload = (await response.json()) as {
        inserted: number
        replaced: number
        total_quantity: number
      }
      notify({
        type: 'success',
        title: `明细导入完成：新增 ${payload.inserted} 行，替换旧数据 ${payload.replaced} 行，总数量 ${payload.total_quantity}`,
      })
      await loadList(page)
      await loadSkuSummary()
      const refreshedDetail = await loadDetail(selectedId)
      if (refreshedDetail) {
        syncEditDialogFromDetail(refreshedDetail)
      }
    } catch (importError) {
      notify({ type: 'error', title: normalizeErrorMessage(importError, 'CSV 导入失败') })
    } finally {
      setImporting(false)
    }
  }

  const handleBatchImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setBatchImporting(true)
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
      const suffix =
        payload.shipment_nos.length > 5 ? ` 等 ${payload.shipment_nos.length} 个批次` : ''
      notify({
        type: 'success',
        title: `批量导入完成：新增 ${payload.inserted} 个发货批次${preview ? `（${preview}${suffix}）` : ''}`,
      })
      await loadList(1)
      await loadSkuSummary()
    } catch (importError) {
      notify({ type: 'error', title: normalizeErrorMessage(importError, '批量导入失败') })
    } finally {
      setBatchImporting(false)
    }
  }

  const handleDeleteSchedule = async () => {
    if (!isAdmin || !detail) return

    setDeleting(true)
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
      notify({ type: 'success', title: `船期批次 ${deletedShipmentNo} 已删除` })
      await loadList(1)
      await loadSkuSummary()
    } catch (deleteError) {
      notify({ type: 'error', title: normalizeErrorMessage(deleteError, '删除失败') })
    } finally {
      setDeleting(false)
    }
  }

  const exportOverviewToExcel = async () => {
    if (items.length === 0) {
      notify({ type: 'error', title: '当前没有可导出的船期批次数据' })
      return
    }

    setExporting(true)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()

      const worksheet = workbook.addWorksheet('船期批次总览', {
        views: [{ state: 'frozen', ySplit: 1, xSplit: 1, showGridLines: false }],
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

      worksheet.columns = columns.map((column) => ({
        header: column.header,
        key: column.key,
        width: column.width,
      }))

      const headerRow = worksheet.getRow(1)
      headerRow.values = columns.map((column) => column.header)
      applyHeaderRowStyle(headerRow, lastColumn)

      items.forEach((item, index) => {
        const row = worksheet.getRow(index + 2)
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
            // 数量列右对齐；日期 / 状态 / 更新时间居中；其余文本左对齐
            horizontal:
              colNumber === 11 || colNumber === 12
                ? 'right'
                : colNumber === 3 ||
                    colNumber === 5 ||
                    colNumber === 9 ||
                    colNumber === 10 ||
                    colNumber === 15
                  ? 'center'
                  : 'left',
            wrapText: colNumber === 14,
          }
          if (colNumber === 11 || colNumber === 12) {
            cell.numFmt = '#,##0'
          }
          applyBorder(cell)
        })
      })

      // 分组带状底纹：相邻同项目的批次归为一组并合并“项目”列；
      // 列表按创建时间倒序、项目分散时自动退化为逐行斑马纹。
      applyGroupBanding({
        worksheet,
        startRow: 2,
        rowCount: items.length,
        groupKeys: items.map((item) => item.project_name),
        columnCount: lastColumn,
        mergeColumn: 1,
      })

      // 状态列底色在分组底纹之后叠加，避免被覆盖（原实现误涂在第 4 列“货件编号”上，永不生效）
      items.forEach((_, index) => {
        paintExportStatusCell(worksheet.getRow(index + 2).getCell(5))
      })

      const totalRow = worksheet.getRow(items.length + 2)
      totalRow.getCell(1).value = '当前页合计'
      totalRow.getCell(11).value = summary.totalSku
      totalRow.getCell(12).value = summary.totalQuantity
      applyTotalRowStyle(totalRow, lastColumn, { numericColumns: [11, 12] })
      totalRow.getCell(11).numFmt = '#,##0'
      totalRow.getCell(12).numFmt = '#,##0'

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
      await logClientOperation({
        action: 'shipment_schedules.overview.export',
        targetType: 'shipment_schedule',
        after: {
          row_count: items.length,
          filename: link.download,
          project_filter: projectFilter,
          country_filter: countryFilter,
          status_filter: statusFilter,
        },
      })
    } catch (exportError) {
      notify({ type: 'error', title: normalizeErrorMessage(exportError, '导出 Excel 失败') })
    } finally {
      setExporting(false)
    }
  }

  const exportCostToExcel = async () => {
    if (items.length === 0) {
      notify({ type: 'error', title: '当前没有可导出的发货费用数据' })
      return
    }

    setCostExporting(true)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()

      const worksheet = workbook.addWorksheet('发货费用', {
        views: [{ state: 'frozen', ySplit: 1, xSplit: 1, showGridLines: false }],
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
      const totalWeight = items.reduce((acc, item) => acc + item.total_chargeable_weight_kg, 0)
      const totalVolume = items.reduce((acc, item) => acc + item.total_volume_m3, 0)
      const totalLogisticsCost = items.reduce((acc, item) => acc + item.logistics_total_price, 0)

      worksheet.columns = columns.map((column) => ({
        header: column.header,
        key: column.key,
        width: column.width,
      }))

      const headerRow = worksheet.getRow(1)
      headerRow.values = columns.map((column) => column.header)
      applyHeaderRowStyle(headerRow, lastColumn)

      items.forEach((item, index) => {
        const row = worksheet.getRow(index + 2)
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
          item.total_quantity > 0 && item.logistics_total_price > 0
            ? item.logistics_total_price / item.total_quantity
            : null,
          item.logistics_total_price > 0 ? item.logistics_total_price : null,
        ]

        row.eachCell((cell, colNumber) => {
          cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
          cell.alignment = {
            vertical: 'middle',
            // 费用 / 数量列右对齐；日期与状态居中；其余文本左对齐
            horizontal:
              colNumber >= 6 ? 'right' : colNumber === 2 || colNumber === 4 ? 'center' : 'left',
            wrapText: colNumber === 5,
          }
          if (colNumber === 6) cell.numFmt = '#,##0'
          if (colNumber === 7) cell.numFmt = '#,##0.000'
          if (colNumber === 8) cell.numFmt = '#,##0.0000'
          if (colNumber === 9 || colNumber === 11) cell.numFmt = '#,##0.00'
          if (colNumber === 10) cell.numFmt = '#,##0.0000'
          applyBorder(cell)
        })
      })

      // 分组带状底纹：相邻同项目的批次归为一组并合并“项目”列；
      // 列表按创建时间倒序、项目分散时自动退化为逐行斑马纹。
      applyGroupBanding({
        worksheet,
        startRow: 2,
        rowCount: items.length,
        groupKeys: items.map((item) => item.project_name),
        columnCount: lastColumn,
        mergeColumn: 1,
      })

      // 状态列底色在分组底纹之后叠加，避免被覆盖
      items.forEach((_, index) => {
        paintExportStatusCell(worksheet.getRow(index + 2).getCell(4))
      })

      const totalRow = worksheet.getRow(items.length + 2)
      totalRow.getCell(1).value = '当前页合计'
      totalRow.getCell(6).value = summary.totalQuantity
      totalRow.getCell(7).value = totalWeight
      totalRow.getCell(8).value = totalVolume
      totalRow.getCell(11).value = totalLogisticsCost
      applyTotalRowStyle(totalRow, lastColumn, { numericColumns: [6, 7, 8, 11] })
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
      await logClientOperation({
        action: 'shipment_schedules.costs.export',
        targetType: 'shipment_schedule',
        after: {
          row_count: items.length,
          filename: link.download,
          project_filter: projectFilter,
          country_filter: countryFilter,
          status_filter: statusFilter,
        },
      })
    } catch (exportError) {
      notify({ type: 'error', title: normalizeErrorMessage(exportError, '导出 Excel 失败') })
    } finally {
      setCostExporting(false)
    }
  }

  const exportSkuSummaryToExcel = async () => {
    if (skuSummaryItems.length === 0) {
      notify({ type: 'error', title: '当前没有可导出的 SKU 汇总数据' })
      return
    }

    setSkuSummaryExporting(true)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()

      const worksheet = workbook.addWorksheet('SKU汇总', {
        views: [{ state: 'frozen', ySplit: 1, xSplit: 1, showGridLines: false }],
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
      const totalShipmentCount = skuSummaryItems.reduce((acc, item) => acc + item.shipment_count, 0)
      const totalQuantity = skuSummaryItems.reduce((acc, item) => acc + item.total_quantity, 0)
      const totalChargeableWeight = skuSummaryItems.reduce(
        (acc, item) => acc + item.total_chargeable_weight_kg,
        0
      )
      const totalLogisticsCost = skuSummaryItems.reduce(
        (acc, item) => acc + item.total_logistics_cost,
        0
      )

      worksheet.columns = columns.map((column) => ({
        header: column.header,
        key: column.key,
        width: column.width,
      }))

      const headerRow = worksheet.getRow(1)
      headerRow.values = columns.map((column) => column.header)
      applyHeaderRowStyle(headerRow, lastColumn)

      skuSummaryItems.forEach((item, index) => {
        const row = worksheet.getRow(index + 2)
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
            // 数量 / 费用列右对齐；国家居中；其余文本左对齐
            horizontal:
              colNumber >= 4 ? 'right' : colNumber === 2 ? 'center' : 'left',
            wrapText: colNumber === 3,
          }
          if (colNumber === 4 || colNumber === 5) cell.numFmt = '#,##0'
          if (colNumber === 6) cell.numFmt = '#,##0.000'
          if (colNumber === 7) cell.numFmt = '#,##0.00'
          if (colNumber === 8) cell.numFmt = '#,##0.0000'
          applyBorder(cell)
        })
      })

      // 分组带状底纹：接口按项目名排序返回，同项目 SKU 天然聚簇，
      // 合并“项目”列后与 daily-analysis 明细表的分组观感一致。
      applyGroupBanding({
        worksheet,
        startRow: 2,
        rowCount: skuSummaryItems.length,
        groupKeys: skuSummaryItems.map((item) => item.project_name),
        columnCount: lastColumn,
        mergeColumn: 1,
      })

      const totalRow = worksheet.getRow(skuSummaryItems.length + 2)
      totalRow.getCell(1).value = '合计'
      totalRow.getCell(4).value = totalShipmentCount
      totalRow.getCell(5).value = totalQuantity
      totalRow.getCell(6).value = totalChargeableWeight
      totalRow.getCell(7).value = totalLogisticsCost
      applyTotalRowStyle(totalRow, lastColumn, { numericColumns: [4, 5, 6, 7] })
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
      await logClientOperation({
        action: 'shipment_schedules.sku_summary.export',
        targetType: 'shipment_schedule',
        after: {
          row_count: skuSummaryItems.length,
          filename: link.download,
          project_filter: projectFilter,
          country_filter: countryFilter,
        },
      })
    } catch (exportError) {
      notify({ type: 'error', title: normalizeErrorMessage(exportError, '导出 Excel 失败') })
    } finally {
      setSkuSummaryExporting(false)
    }
  }

  const exportFbaBoxDetailsToExcel = async () => {
    if (fbaBoxItems.length === 0 || !fbaBoxMeta) {
      notify({ type: 'error', title: '当前没有可导出的 FBA 箱单明细' })
      return
    }

    setFbaBoxExporting(true)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()

      const worksheet = workbook.addWorksheet('FBA箱单明细', {
        views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
      })

      const maxSkuLen = Math.max(8, ...fbaBoxItems.map((item) => item.sku.length))
      const skuWidth = Math.max(12, maxSkuLen + 4)

      const columns = [
        { header: '货件编号', key: 'shipment_no', width: 20 },
        { header: '追踪 ID', key: 'tracking_no', width: 18 },
        { header: '仓库 ID', key: 'warehouse_code', width: 16 },
        { header: 'SKU', key: 'sku', width: skuWidth },
        { header: '品名', key: 'product_name', width: 28 },
        { header: '产品图片', key: 'product_image', width: 16 },
        { header: 'ASIN', key: 'asin', width: 20 },
        { header: 'FNSKU', key: 'fnsku', width: 20 },
        { header: '外箱长(cm)', key: 'carton_length', width: 13 },
        { header: '外箱宽(cm)', key: 'carton_width', width: 13 },
        { header: '外箱高(cm)', key: 'carton_height', width: 13 },
        { header: '外箱重量(kg)', key: 'carton_weight', width: 14 },
        { header: '装箱率', key: 'packing_rate', width: 12 },
        { header: '总箱数', key: 'carton_count', width: 10 },
        { header: '标签号段', key: 'label_range', width: 14 },
        { header: '总数量', key: 'quantity', width: 10 },
        { header: '总体积(m³)', key: 'total_volume', width: 14 },
        { header: '总重量(kg)', key: 'total_weight', width: 14 },
      ] as const
      const dataStartRow = 2
      const imageColumnIndex = 6 // 产品图片列（品名插入在 SKU 之后，图片列顺延为第 6 列）

      const headerRow = worksheet.getRow(1)
      headerRow.values = columns.map((column) => column.header)
      applyHeaderRowStyle(headerRow, columns.length)

      fbaBoxItems.forEach((item, index) => {
        const row = worksheet.getRow(index + dataStartRow)
        row.values = [
          item.shipment_no, // 1 货件编号
          item.tracking_no || '-', // 2 追踪 ID
          item.warehouse_code || '-', // 3 仓库 ID
          item.sku, // 4 SKU
          item.product_name || '-', // 5 品名（来自 SKU info）
          null, // 6 产品图片（由 addImage 嵌入）
          item.asin || '-', // 7 ASIN
          item.fnsku || '-', // 8 FNSKU
          item.length_cm > 0 ? formatDecimal(item.length_cm, 2) : '-', // 8 外箱长
          item.width_cm > 0 ? formatDecimal(item.width_cm, 2) : '-', // 9 外箱宽
          item.height_cm > 0 ? formatDecimal(item.height_cm, 2) : '-', // 10 外箱高
          item.carton_weight_kg ? formatDecimal(item.carton_weight_kg, 3) : '-', // 11 外箱重量
          item.units_per_carton > 0 ? `${item.units_per_carton} / 箱` : '-', // 12 装箱率
          item.carton_count > 0 ? item.carton_count : '-', // 13 总箱数
          fbaBoxLabelRanges[index] ?? '-', // 14 标签号段
          item.quantity > 0 ? item.quantity : '-', // 15 总数量
          item.total_volume_m3, // 16 总体积
          item.total_weight_kg, // 17 总重量
        ]
        row.height = 100
        row.eachCell((cell, colNumber) => {
          cell.font = { name: 'Microsoft YaHei', size: 9, color: { argb: 'FF0F172A' } }
          cell.alignment = {
            vertical: 'middle',
            horizontal:
              colNumber >= 13 ? 'right' : colNumber === imageColumnIndex ? 'center' : 'left',
          }
          if (colNumber === 13 || colNumber === 16) cell.numFmt = '#,##0'
          if (colNumber === 17) cell.numFmt = '#,##0.0000'
          if (colNumber === 18) cell.numFmt = '#,##0.000'
          applyBorder(cell)
        })
      })

      // 分组带状底纹：接口按货件聚簇返回，相邻同货件行归为一组；
      // 列 1-3 的纵向合并沿用下方既有逻辑，此处只铺底纹与边框。
      applyGroupBanding({
        worksheet,
        startRow: dataStartRow,
        rowCount: fbaBoxItems.length,
        groupKeys: fbaBoxItems.map((item) => item.shipment_no),
        columnCount: columns.length,
      })

      // ── 合并单元格：货件编号(列 1) 按 shipment_no，追踪 ID(列 2) 按 (shipment_no, tracking_no)，仓库 ID(列 3) 按 (shipment_no, warehouse_code) ──
      const mergeAndCenterAnchor = (colNumber: number, startIndex: number, endIndex: number) => {
        worksheet.mergeCells(
          startIndex + dataStartRow,
          colNumber,
          endIndex + dataStartRow,
          colNumber
        )
        const anchorCell = worksheet.getCell(startIndex + dataStartRow, colNumber)
        anchorCell.font = { name: 'Microsoft YaHei', size: 9, bold: true, color: { argb: 'FF0F172A' } }
        anchorCell.alignment = { vertical: 'middle', horizontal: 'center' }
      }
      let shipStart = 0
      let whStart = 0
      let tkStart = 0
      let currentShipNo = fbaBoxItems[0]?.shipment_no ?? ''
      let currentShipWhKey = fbaBoxItems[0]
        ? `${fbaBoxItems[0].shipment_no}|${fbaBoxItems[0].warehouse_code ?? ''}`
        : ''
      let currentShipTkKey = fbaBoxItems[0]
        ? `${fbaBoxItems[0].shipment_no}|${fbaBoxItems[0].tracking_no ?? ''}`
        : ''

      fbaBoxItems.forEach((item, index) => {
        const itemShipWhKey = `${item.shipment_no}|${item.warehouse_code ?? ''}`
        const itemShipTkKey = `${item.shipment_no}|${item.tracking_no ?? ''}`
        const isLast = index === fbaBoxItems.length - 1

        if (item.shipment_no !== currentShipNo) {
          if (index - shipStart > 1) {
            mergeAndCenterAnchor(1, shipStart, index - 1)
          } else if (isLast) {
            // 单行不合并（ExcelJS 不允许单行 merge）
          }
          currentShipNo = item.shipment_no
          shipStart = index
          whStart = index
          currentShipWhKey = itemShipWhKey
          tkStart = index
          currentShipTkKey = itemShipTkKey
        }

        if (itemShipTkKey !== currentShipTkKey) {
          if (index - tkStart > 1) {
            mergeAndCenterAnchor(2, tkStart, index - 1)
          }
          tkStart = index
          currentShipTkKey = itemShipTkKey
        }

        if (itemShipWhKey !== currentShipWhKey) {
          if (index - whStart > 1) {
            mergeAndCenterAnchor(3, whStart, index - 1)
          }
          whStart = index
          currentShipWhKey = itemShipWhKey
        }

        if (isLast) {
          if (index - shipStart >= 1) {
            mergeAndCenterAnchor(1, shipStart, index)
          }
          if (index - tkStart >= 1) {
            mergeAndCenterAnchor(2, tkStart, index)
          }
          if (index - whStart >= 1) {
            mergeAndCenterAnchor(3, whStart, index)
          }
        }
      })

      // ── 嵌入产品图片（100x100 像素） ──
      const uniqueImageUrls = Array.from(
        new Set(
          fbaBoxItems.map((it) => it.product_image_r2_url).filter((u): u is string => Boolean(u))
        )
      )

      if (uniqueImageUrls.length > 0) {
        const CONCURRENCY = 6
        const imageBuffers = new Map<
          string,
          { buffer: ArrayBuffer; extension: 'png' | 'jpeg' | 'gif' }
        >()
        const failedUrls = new Set<string>()

        const fetchOne = async (url: string) => {
          try {
            const resp = await fetch(url, { cache: 'no-store' })
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
            const buffer = await resp.arrayBuffer()
            const lower = url.toLowerCase()
            const ext: 'png' | 'jpeg' | 'gif' = lower.endsWith('.png')
              ? 'png'
              : lower.endsWith('.gif')
                ? 'gif'
                : 'jpeg'
            imageBuffers.set(url, { buffer, extension: ext })
          } catch (err) {
            failedUrls.add(url)
            // eslint-disable-next-line no-console
            console.warn('FBA 箱单导出：图片获取失败', url, err)
          }
        }

        const queue = [...uniqueImageUrls]
        const workers = Array.from({ length: CONCURRENCY }, async () => {
          while (queue.length > 0) {
            const url = queue.shift()
            if (url) await fetchOne(url)
          }
        })
        await Promise.all(workers)

        const imageIdMap = new Map<string, number>()
        imageBuffers.forEach(({ buffer, extension }, url) => {
          const id = workbook.addImage({ buffer, extension })
          imageIdMap.set(url, id)
        })

        fbaBoxItems.forEach((item, index) => {
          const url = item.product_image_r2_url
          if (!url || failedUrls.has(url)) return
          const imageId = imageIdMap.get(url)
          if (imageId === undefined) return
          worksheet.addImage(imageId, {
            tl: { col: imageColumnIndex - 1, row: index + dataStartRow - 1 },
            ext: { width: 100, height: 100 },
          })
        })
      }

      const totalRow = worksheet.getRow(fbaBoxItems.length + dataStartRow)
      totalRow.getCell(1).value = '合计'
      totalRow.getCell(14).value = fbaBoxSummary.totalCartons
      totalRow.getCell(16).value = fbaBoxSummary.totalQuantity
      totalRow.getCell(17).value = fbaBoxSummary.totalVolumeM3
      totalRow.getCell(18).value = fbaBoxSummary.totalWeightKg
      applyTotalRowStyle(totalRow, columns.length, { numericColumns: [14, 16, 17, 18] })
      totalRow.getCell(14).numFmt = '#,##0'
      totalRow.getCell(16).numFmt = '#,##0'
      totalRow.getCell(17).numFmt = '#,##0.0000'
      totalRow.getCell(18).numFmt = '#,##0.000'

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const safeTimestamp = formatLocalTimestampForFilename()
      const projectSegment =
        fbaBoxMeta.projectNames.length === 1
          ? (fbaBoxMeta.projectNames[0] || '未选项目').replace(/[\\/:*?\"<>|]/g, '-')
          : `${fbaBoxMeta.projectNames.length}个项目`
      const siteSegment =
        fbaBoxMeta.countries.length === 1
          ? getCountryLabel(fbaBoxMeta.countries[0])
          : `${fbaBoxMeta.countries.length}个站点`
      link.href = url
      link.download = `${projectSegment}_${siteSegment}-FBA箱单明细-${fbaBoxMeta.shipmentNos.length}个货件-${safeTimestamp}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)
      await logClientOperation({
        action: 'shipment_schedules.fba_box_details.export',
        targetType: 'shipment_schedule',
        after: {
          shipment_nos: fbaBoxMeta.shipmentNos,
          row_count: fbaBoxItems.length,
          filename: link.download,
        },
      })
    } catch (exportError) {
      notify({ type: 'error', title: normalizeErrorMessage(exportError, '导出 Excel 失败') })
    } finally {
      setFbaBoxExporting(false)
    }
  }

  // FBA发货模板导出 (Create workflow – template)
  const exportFbaDeliveryTemplateToExcel = async () => {
    if (!detail) {
      notify({ type: 'error', title: '请先选择一个船期批次' })
      return
    }

    setExporting(true)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()

      // 所有国家均需在模板前 2 行写入亚马逊必需的 Default prep/labeling owner 行，
      // 第 3 行为表头，第 4 行起为数据。仅单位（cm/kg 或 in/lb）按国家区分。
      const useMetric = detail.country === 'DE' || detail.country === 'UK'

      // Sheet name: Create workflow – template
      const worksheet = workbook.addWorksheet('Create workflow – template', {
        views: [{ state: 'frozen', ySplit: 3, showGridLines: false }],
      })

      // 列定义（Prep owner / Labeling owner 已在顶部两行单独设置，列不再包含）
      // 列顺序：Merchant SKU, Quantity, Units per box, Number of boxes, ...
      const columns = [
        { header: 'Merchant SKU', key: 'merchant_sku', width: 24 },
        { header: 'Quantity', key: 'quantity', width: 12 },
        { header: 'Units per box', key: 'units_per_box', width: 14 },
        { header: 'Number of boxes', key: 'number_of_boxes', width: 16 },
        { header: useMetric ? 'Box length (cm)' : 'Box length (in)', key: 'box_length', width: 16 },
        { header: useMetric ? 'Box width (cm)' : 'Box width (in)', key: 'box_width', width: 16 },
        { header: useMetric ? 'Box height (cm)' : 'Box height (in)', key: 'box_height', width: 16 },
        { header: useMetric ? 'Box weight (kg)' : 'Box weight (lb)', key: 'box_weight', width: 14 },
      ]

      worksheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }))

      // ---- 前两行固定内容：亚马逊标签预处理的必需行（所有国家均写入）----
      const infoRow1 = worksheet.getRow(1)
      infoRow1.height = 18
      infoRow1.values = ['Default prep owner', 'Seller']
      infoRow1.eachCell((cell) => {
        cell.font = { name: 'Microsoft YaHei', size: 9, color: { argb: 'FF0F172A' } }
        cell.alignment = { vertical: 'middle', horizontal: 'left' }
        applyBorder(cell)
      })

      const infoRow2 = worksheet.getRow(2)
      infoRow2.height = 18
      infoRow2.values = ['Default labeling owner', 'Seller']
      infoRow2.eachCell((cell) => {
        cell.font = { name: 'Microsoft YaHei', size: 9, color: { argb: 'FF0F172A' } }
        cell.alignment = { vertical: 'middle', horizontal: 'left' }
        applyBorder(cell)
      })

      // ---- 表头行（固定第 3 行；worksheet.columns 已把表头写到第 1 行，此处重排到第 3 行）----
      const headerRow = worksheet.getRow(3)
      headerRow.height = 22
      headerRow.values = columns.map((c) => c.header)
      headerRow.eachCell((cell) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.alignment = { vertical: 'middle', horizontal: 'center' }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
        applyHeaderBorder(cell)
      })

      // cm to inches: 1 inch = 2.54 cm
      // kg to lb: 1 kg = 2.20462 lb
      const CM_TO_INCH = 2.54
      const KG_TO_LB = 2.20462

      // Build SKU info map from product costs (projectSkuOptions already loaded)
      const skuInfoMap = new Map<string, (typeof projectSkuOptions)[0]>()
      for (const opt of projectSkuOptions) {
        skuInfoMap.set(opt.sku, opt)
      }

      // Build editable carton_count map: tempId → cartonCount string
      const editableCartonMap = new Map<string, string>()
      for (const item of editableItems) {
        editableCartonMap.set(item.sku, item.cartonCount)
      }

      // ---- 数据行（所有国家均从第 4 行开始）----
      const dataStartRow = 4
      detail.items.forEach((item, index) => {
        const row = worksheet.getRow(dataStartRow + index)
        const skuInfo = skuInfoMap.get(item.sku)
        const userCartonCount = editableCartonMap.get(item.sku)
        const cartonCount =
          userCartonCount && Number(userCartonCount) > 0
            ? Number(userCartonCount)
            : (item.carton_count ?? 0)
        const unitsPerBox = skuInfo?.units_per_carton ?? 0

        // DE/UK: keep cm/kg; US: convert to in/lb
        const boxLength = useMetric
          ? skuInfo?.carton_length_cm
            ? Number(skuInfo.carton_length_cm.toFixed(2))
            : ''
          : skuInfo?.carton_length_cm
            ? Number((skuInfo.carton_length_cm / CM_TO_INCH).toFixed(2))
            : ''
        const boxWidth = useMetric
          ? skuInfo?.carton_width_cm
            ? Number(skuInfo.carton_width_cm.toFixed(2))
            : ''
          : skuInfo?.carton_width_cm
            ? Number((skuInfo.carton_width_cm / CM_TO_INCH).toFixed(2))
            : ''
        const boxHeight = useMetric
          ? skuInfo?.carton_height_cm
            ? Number(skuInfo.carton_height_cm.toFixed(2))
            : ''
          : skuInfo?.carton_height_cm
            ? Number((skuInfo.carton_height_cm / CM_TO_INCH).toFixed(2))
            : ''
        const boxWeight = useMetric
          ? skuInfo?.carton_weight_kg
            ? Number(skuInfo.carton_weight_kg.toFixed(2))
            : ''
          : skuInfo?.carton_weight_kg
            ? Number((skuInfo.carton_weight_kg * KG_TO_LB).toFixed(2))
            : ''

        // 所有国家均为 8 列（Prep/Labeling owner 已在顶部行设置；boxLength 等已按单位换算）
        row.values = [
          item.sku,
          item.quantity,
          unitsPerBox > 0 ? unitsPerBox : '',
          cartonCount > 0 ? cartonCount : '',
          boxLength,
          boxWidth,
          boxHeight,
          boxWeight,
        ]

        row.height = 18
        row.eachCell((cell, colNumber) => {
          cell.font = { name: 'Microsoft YaHei', size: 9, color: { argb: 'FF0F172A' } }
          cell.alignment = { vertical: 'middle', horizontal: colNumber >= 3 ? 'right' : 'left' }
          applyBorder(cell)
        })
      })

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      const safeProjectName = (detail.project_name || '未选项目').replace(/[\\/:*?"<>|]/g, '-')
      const siteLabel = getCountryLabel(detail.country)
      link.download = `${safeProjectName}_${siteLabel}-FBA发货模板-${detail.shipment_no}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)

      await logClientOperation({
        action: 'shipment_schedules.fba_delivery_template.export',
        targetType: 'shipment_schedule',
        after: {
          shipment_no: detail.shipment_no,
          row_count: detail.items.length,
          filename: link.download,
        },
      })
    } catch (exportError) {
      notify({ type: 'error', title: normalizeErrorMessage(exportError, '导出 FBA 发货模板失败') })
    } finally {
      setExporting(false)
    }
  }

  // 下载产品标签
  const handleDownloadProductLabels = async () => {
    if (!detail || editableItems.length === 0) {
      notify({ type: 'error', title: '无可下载的产品标签' })
      return
    }

    setLabelDownloading(true)
    try {
      // 1. 获取 fnsku_label_r2_key 信息
      const skus = editableItems.map((item) => item.sku)
      const response = await fetch(`${API_BASE}/api/v1/sku-info/fnsku-labels/by-skus`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_name: detail.project_name, skus }),
      })

      if (!response.ok) throw new Error(await parseResponseError(response, '请求失败'))

      const data = (await response.json()) as {
        sku_records: Array<{ id: number; sku: string; fnsku_label_r2_key: string | null }>
      }
      const skuRecords = data.sku_records.filter((r) => r.fnsku_label_r2_key)

      if (skuRecords.length === 0) {
        notify({ type: 'error', title: '所选 SKU 均无 FNSKU 标签' })
        return
      }

      // 2. 调用批量下载 API
      const downloadResponse = await fetch(
        `${API_BASE}/api/v1/sku-info/fnsku-labels/batch-download`,
        {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ sku_record_ids: skuRecords.map((r) => r.id) }),
        }
      )

      if (!downloadResponse.ok)
        throw new Error(await parseResponseError(downloadResponse, '下载失败'))

      // 3. 处理下载
      const blob = await downloadResponse.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${detail.shipment_no}-fnsku-labels.zip`
      link.click()
      URL.revokeObjectURL(url)

      const downloaded = downloadResponse.headers.get('X-Downloaded-Count') || skuRecords.length
      const skipped = downloadResponse.headers.get('X-Skipped-Count') || '0'
      notify({
        type: 'success',
        title: '下载完成',
        message: `共 ${downloaded} 个标签${Number(skipped) > 0 ? `，跳过 ${skipped} 个无标签的 SKU` : ''}`,
      })
    } catch (downloadError) {
      notify({
        type: 'error',
        title: '下载失败',
        message: normalizeErrorMessage(downloadError, '下载失败'),
      })
    } finally {
      setLabelDownloading(false)
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="min-w-0 space-y-6 text-foreground">
      {/* 控制台 — dashboard-surface 承载，替代旧 DataCard 平铺；头部 = 页面 PILL 合并（BLF-605：顶部 PILL 并入首卡，替换「控制台」标题） */}
      <div className="dashboard-surface animate-enter overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3 md:px-6">
          <div />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => void loadList(1)}
              className="h-9 gap-1.5 px-3 text-xs"
            >
              <RefreshCcw className="h-4 w-4" />
              刷新
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={openCreateDialog}
              className="h-9 gap-1.5 px-3 text-xs"
            >
              <Plus className="h-4 w-4" />
              新建批次
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={downloadBatchTemplate}
              className="h-9 gap-1.5 px-3 text-xs"
            >
              <FileDown className="h-4 w-4" />
              下载模板
            </Button>
            <Button
              asChild
              size="sm"
              variant="outline"
              disabled={batchImporting}
              className="h-9 gap-1.5 px-3 text-xs"
            >
              <label>
                <Upload className="h-4 w-4" />
                {batchImporting ? '导入中...' : '批量导入'}
                <input
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={handleBatchImportFile}
                />
              </label>
            </Button>
          </div>
        </div>
        <DataCardContent className="grid gap-4 p-4 md:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-5">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4 xl:col-span-1 [&>div]:min-w-0">
            {projectsLoading ? (
              <ShipmentControlSkeleton />
            ) : (
              <div className="flex min-w-0 flex-col space-y-2">
                <div className="text-xs font-medium text-muted-foreground">项目</div>
                <Select value={projectFilter} onValueChange={setProjectFilter}>
                  <SelectTrigger className="w-full">
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

            <div className="flex min-w-0 flex-col space-y-2">
              <div className="text-xs font-medium text-muted-foreground">状态</div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full">
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

            <div className="flex min-w-0 flex-col space-y-2">
              <div className="text-xs font-medium text-muted-foreground">国家地区</div>
              <Select value={countryFilter} onValueChange={setCountryFilter}>
                <SelectTrigger className="w-full">
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

            <div className="flex min-w-0 flex-col space-y-2">
              <div className="text-xs font-medium text-muted-foreground">货件编号</div>
              <SearchableShipmentNoFilter
                value={shipmentNoFilter}
                options={shipmentNoOptions}
                loading={shipmentNoOptionsLoading}
                onChange={setShipmentNoFilter}
                onOpen={handleShipmentNoFilterOpen}
              />
            </div>
          </div>
        </DataCardContent>
      </div>

      <div className="grid min-w-0 gap-6">
        <Tabs
          value={activeTab}
          onValueChange={(value) => activateTab(value as ShipmentPageTab)}
          className="min-w-0 w-full"
        >
          <div className="mb-4">
            <TabsMotionGroup id="shipment-management-tabs">
              <TabsList variant="term" className="w-fit max-w-full justify-start">
                <SlidingTabsTrigger
                  value="overview"
                  activeValue={activeTab}
                  layoutId="shipment-management-tab-indicator"
                  variant="term"
                >
                  <LayoutDashboard aria-hidden />
                  总览
                </SlidingTabsTrigger>
                <SlidingTabsTrigger
                  value="cost"
                  activeValue={activeTab}
                  layoutId="shipment-management-tab-indicator"
                  variant="term"
                >
                  <Coins aria-hidden />
                  发货费用
                </SlidingTabsTrigger>
                <SlidingTabsTrigger
                  value="sku-summary"
                  activeValue={activeTab}
                  layoutId="shipment-management-tab-indicator"
                  variant="term"
                >
                  <Package aria-hidden />
                  SKU汇总
                </SlidingTabsTrigger>
                <SlidingTabsTrigger
                  value="fba-box-detail"
                  activeValue={activeTab}
                  layoutId="shipment-management-tab-indicator"
                  variant="term"
                >
                  <Boxes aria-hidden />
                  FBA 箱单明细
                </SlidingTabsTrigger>
              </TabsList>
            </TabsMotionGroup>
          </div>

          <DirectionalTabTransition value={activeTab} order={SHIPMENT_TAB_ORDER}>
            <TabsContent forceMount value={activeTab} className="mt-0 min-w-0">
              {activeTab === 'overview' ? (
                <DataTableCard className="min-w-0">
                  {/* 上半部分：标题 + 按钮 */}
                  <DataTableCardHeader className="flex min-w-0 flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <CardTitle className="text-base">船期批次总览</CardTitle>
                      <p className="text-sm text-muted-foreground">
                        共 {total} 条记录，当前第 {page} / {pageCount} 页
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        disabled={loading || exporting || items.length === 0}
                        onClick={() => void exportOverviewToExcel()}
                      >
                        <FileDown className="h-4 w-4" />
                        {exporting ? '导出中...' : '导出 Excel'}
                      </Button>
                      <Button
                        variant="outline"
                        className="max-md:min-h-[44px]"
                        disabled={page <= 1 || loading}
                        onClick={() => void loadList(page - 1)}
                      >
                        上一页
                      </Button>
                      <Button
                        variant="outline"
                        className="max-md:min-h-[44px]"
                        disabled={!hasNext || loading}
                        onClick={() => void loadList(page + 1)}
                      >
                        下一页
                      </Button>
                    </div>
                  </DataTableCardHeader>
                  {/* 下半部分：表格 */}
                  <DataTableCardBody>
                    {items.length === 0 && !loading ? (
                      <div className="m-4 rounded-lg border border-dashed border-border/70 bg-[hsl(var(--surface-subtle))] py-14 text-center text-sm text-muted-foreground">
                        当前没有符合筛选条件的船期记录。
                      </div>
                    ) : (
                      <div className="relative">
                        {loading && items.length > 0 ? (
                          <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-border/70 bg-[hsl(var(--surface-panel))] px-3 py-1 text-xs text-muted-foreground shadow-sm">
                            列表更新中...
                          </div>
                        ) : null}
                        <Table
                          containerClassName={TABLE_SCROLL_CONTAINER_CLASS}
                          className="w-full min-w-[1080px]"
                        >
                          <TableHeader>
                            <TableRow className="bg-[hsl(var(--surface-subtle))]">
                              <TableHead
                                className={`w-[90px] whitespace-nowrap border-r border-border/70 text-sm last:border-r-0 ${DENSE_HEAD}`}
                              >
                                项目
                              </TableHead>
                              <TableHead
                                className={`w-[72px] whitespace-nowrap border-r border-border/70 text-sm last:border-r-0 ${DENSE_HEAD}`}
                              >
                                国家
                              </TableHead>
                              <TableHead
                                className={`w-[90px] whitespace-nowrap border-r border-border/70 text-sm last:border-r-0 ${DENSE_HEAD}`}
                              >
                                发货时间
                              </TableHead>
                              <TableHead
                                className={`w-[120px] whitespace-nowrap border-r border-border/70 text-sm last:border-r-0 ${DENSE_HEAD}`}
                              >
                                货件编号
                              </TableHead>
                              <TableHead
                                className={`w-[70px] whitespace-nowrap border-r border-border/70 text-sm last:border-r-0 ${DENSE_HEAD}`}
                              >
                                状态
                              </TableHead>
                              <TableHead
                                className={`w-[80px] whitespace-nowrap border-r border-border/70 text-sm last:border-r-0 ${DENSE_HEAD}`}
                              >
                                货代
                              </TableHead>
                              <TableHead
                                className={`w-[70px] whitespace-nowrap border-r border-border/70 text-sm last:border-r-0 ${DENSE_HEAD}`}
                              >
                                仓库
                              </TableHead>
                              <TableHead
                                className={`w-[90px] whitespace-nowrap border-r border-border/70 text-sm last:border-r-0 ${DENSE_HEAD}`}
                              >
                                ETD
                              </TableHead>
                              <TableHead
                                className={`w-[90px] whitespace-nowrap border-r border-border/70 text-sm last:border-r-0 ${DENSE_HEAD}`}
                              >
                                ETA
                              </TableHead>
                              <TableHead
                                className={`w-[50px] whitespace-nowrap border-r border-border/70 text-right text-sm last:border-r-0 ${DENSE_HEAD}`}
                              >
                                SKU
                              </TableHead>
                              <TableHead
                                className={`w-[60px] whitespace-nowrap border-r border-border/70 text-right text-sm last:border-r-0 ${DENSE_HEAD}`}
                              >
                                数量
                              </TableHead>
                              <TableHead
                                className={`w-[60px] whitespace-nowrap text-sm ${DENSE_HEAD}`}
                              >
                                操作
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {loading && items.length === 0 ? (
                              <TableSkeletonRows columns={12} />
                            ) : null}
                            {items.map((item) => {
                              const status = statusMeta(item.shipment_status)
                              const country = countryMeta(item.country)
                              return (
                                <TableRow
                                  key={item.id}
                                  className={
                                    item.id === selectedId ? 'bg-primary/8 dark:bg-primary/10' : ''
                                  }
                                >
                                  <TableCell
                                    className={`w-[90px] border-r border-border/60 text-sm font-medium ${DENSE_CELL}`}
                                  >
                                    {item.project_name}
                                  </TableCell>
                                  <TableCell
                                    className={`w-[72px] border-r border-border/60 text-sm ${DENSE_CELL}`}
                                  >
                                    <Badge className={`${country.className} h-5 px-2 text-[11px]`}>
                                      {country.label}
                                    </Badge>
                                  </TableCell>
                                  <TableCell
                                    className={`w-[90px] border-r border-border/60 text-sm ${DENSE_CELL}`}
                                  >
                                    {formatDate(item.created_date)}
                                  </TableCell>
                                  <TableCell
                                    className={`w-[120px] border-r border-border/60 text-sm font-medium ${DENSE_CELL}`}
                                  >
                                    {item.shipment_no}
                                  </TableCell>
                                  <TableCell
                                    className={`w-[70px] border-r border-border/60 ${DENSE_CELL}`}
                                  >
                                    <Badge className={`${status.className} text-[11px] py-0 h-5`}>
                                      {status.label}
                                    </Badge>
                                  </TableCell>
                                  <TableCell
                                    className={`w-[80px] border-r border-border/60 text-sm ${DENSE_CELL}`}
                                  >
                                    {item.forwarder_name || '-'}
                                  </TableCell>
                                  <TableCell
                                    className={`w-[70px] border-r border-border/60 text-sm ${DENSE_CELL}`}
                                  >
                                    {item.warehouse_code || '-'}
                                  </TableCell>
                                  <TableCell
                                    className={`w-[90px] border-r border-border/60 text-sm ${DENSE_CELL}`}
                                  >
                                    {formatDate(item.etd_date)}
                                  </TableCell>
                                  <TableCell
                                    className={`w-[90px] border-r border-border/60 text-sm ${DENSE_CELL}`}
                                  >
                                    {formatDate(item.eta_date)}
                                  </TableCell>
                                  <TableCell
                                    className={`w-[50px] border-r border-border/60 text-right text-sm ${DENSE_CELL}`}
                                  >
                                    {item.sku_count}
                                  </TableCell>
                                  <TableCell
                                    className={`w-[60px] border-r border-border/60 text-right text-sm ${DENSE_CELL}`}
                                  >
                                    {item.total_quantity.toLocaleString()}
                                  </TableCell>
                                  <TableCell className={`w-[60px] ${DENSE_CELL}`}>
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
                  </DataTableCardBody>
                </DataTableCard>
              ) : activeTab === 'cost' ? (
                <DataTableCard className="min-w-0">
                  {/* Row1: 标题 + 筛选/按钮 */}
                  <DataTableCardHeader className="flex min-w-0 flex-col gap-3 px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                        Shipping Cost
                      </div>
                      <CardTitle>发货费用</CardTitle>
                    </div>
                    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end xl:flex-nowrap xl:gap-3">
                      <div className="min-w-[220px] space-y-1">
                        <div className="text-[11px] font-medium text-muted-foreground">
                          日期范围
                        </div>
                        <DateRangePicker
                          value={parseDateRangeInputValue(shipmentDateFrom, shipmentDateTo)}
                          onChange={(range) => {
                            setShipmentDateFrom(formatPickerDateInputValue(range?.from))
                            setShipmentDateTo(formatPickerDateInputValue(range?.to))
                          }}
                          className="h-9 w-full"
                        />
                      </div>
                      <Button
                        variant="outline"
                        disabled={loading || costExporting || items.length === 0}
                        onClick={() => void exportCostToExcel()}
                      >
                        <FileDown className="h-4 w-4" />
                        {costExporting ? '导出中...' : '导出 Excel'}
                      </Button>
                    </div>
                  </DataTableCardHeader>
                  {/* Row2: 统计条 */}
                  {costSummaryLoading ? (
                    <DataTableCardStatBar
                      items={[
                        { label: '批次', value: <Skeleton className="h-6 w-12" /> },
                        { label: '数量', value: <Skeleton className="h-6 w-16" /> },
                        { label: '重量', value: <Skeleton className="h-6 w-14" /> },
                        { label: '总运费', value: <Skeleton className="h-6 w-16" /> },
                      ]}
                    />
                  ) : (
                    <DataTableCardStatBar
                      items={[
                        { label: '批次', value: costSummary.shipment_count },
                        { label: '数量', value: costSummary.total_quantity.toLocaleString() },
                        {
                          label: '重量',
                          value: `${formatDecimal(costSummary.total_chargeable_weight_kg)} kg`,
                        },
                        {
                          label: '总运费',
                          value: `¥ ${formatDecimal(costSummary.total_logistics_cost, 2)}`,
                          highlight: true,
                        },
                      ]}
                    />
                  )}
                  {/* 表格 */}
                  <DataTableCardBody>
                    {items.length === 0 && !loading ? (
                      <div className="py-14 text-center text-sm text-muted-foreground">
                        当前没有符合筛选条件的发货批次。
                      </div>
                    ) : (
                      <div className="relative">
                        {loading && items.length > 0 ? (
                          <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-border/70 bg-[hsl(var(--surface-panel))] px-3 py-1 text-xs text-muted-foreground shadow-sm">
                            发货费用计算中...
                          </div>
                        ) : null}
                        <Table
                          containerClassName={TABLE_SCROLL_CONTAINER_CLASS}
                          className="w-full min-w-[1320px]"
                        >
                          <TableHeader>
                            <TableRow className="bg-[hsl(var(--surface-subtle))]">
                              <TableHead className={`w-[100px] whitespace-nowrap ${DENSE_HEAD}`}>
                                项目
                              </TableHead>
                              <TableHead className={`w-[90px] whitespace-nowrap ${DENSE_HEAD}`}>
                                发货时间
                              </TableHead>
                              <TableHead className={`w-[120px] whitespace-nowrap ${DENSE_HEAD}`}>
                                货件编号
                              </TableHead>
                              <TableHead className={`w-[70px] whitespace-nowrap ${DENSE_HEAD}`}>
                                状态
                              </TableHead>
                              <TableHead className={`w-[80px] whitespace-nowrap ${DENSE_HEAD}`}>
                                货代
                              </TableHead>
                              <TableHead
                                className={`w-[90px] whitespace-nowrap text-right ${DENSE_HEAD}`}
                              >
                                总发货数量
                              </TableHead>
                              <TableHead
                                className={`w-[90px] whitespace-nowrap text-right ${DENSE_HEAD}`}
                              >
                                总重量(kg)
                              </TableHead>
                              <TableHead
                                className={`w-[90px] whitespace-nowrap text-right ${DENSE_HEAD}`}
                              >
                                总体积(m³)
                              </TableHead>
                              <TableHead
                                className={`w-[90px] whitespace-nowrap text-right ${DENSE_HEAD}`}
                              >
                                物流单价
                              </TableHead>
                              <TableHead
                                className={`w-[100px] whitespace-nowrap text-right ${DENSE_HEAD}`}
                              >
                                单品物流单价
                              </TableHead>
                              <TableHead
                                className={`w-[100px] whitespace-nowrap text-right ${DENSE_HEAD}`}
                              >
                                物流总价
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {loading && items.length === 0 ? (
                              <TableSkeletonRows columns={11} />
                            ) : null}
                            {items.map((item) => {
                              const status = statusMeta(item.shipment_status)
                              return (
                                <TableRow
                                  key={`cost-${item.id}`}
                                  className={
                                    item.id === selectedId ? 'bg-primary/8 dark:bg-primary/10' : ''
                                  }
                                >
                                  <TableCell className={`w-[100px] font-medium ${DENSE_CELL}`}>
                                    {item.project_name}
                                  </TableCell>
                                  <TableCell className={`w-[90px] ${DENSE_CELL}`}>
                                    {formatDate(item.created_date || item.etd_date)}
                                  </TableCell>
                                  <TableCell className={`w-[120px] font-medium ${DENSE_CELL}`}>
                                    {item.shipment_no}
                                  </TableCell>
                                  <TableCell className={`w-[70px] ${DENSE_CELL}`}>
                                    <Badge className={`${status.className} text-[11px] py-0 h-5`}>
                                      {status.label}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className={`w-[80px] ${DENSE_CELL}`}>
                                    {item.forwarder_name || '-'}
                                  </TableCell>
                                  <TableCell className={`w-[90px] text-right ${DENSE_CELL}`}>
                                    {item.total_quantity.toLocaleString()}
                                  </TableCell>
                                  <TableCell className={`w-[90px] text-right ${DENSE_CELL}`}>
                                    {formatDecimal(item.total_chargeable_weight_kg)}
                                  </TableCell>
                                  <TableCell className={`w-[90px] text-right ${DENSE_CELL}`}>
                                    {formatDecimal(item.total_volume_m3, 4)}
                                  </TableCell>
                                  <TableCell className={`w-[90px] text-right ${DENSE_CELL}`}>
                                    {item.logistics_unit_price > 0
                                      ? formatDecimal(item.logistics_unit_price, 2)
                                      : '-'}
                                  </TableCell>
                                  <TableCell className={`w-[100px] text-right ${DENSE_CELL}`}>
                                    {item.total_quantity > 0 && item.logistics_total_price > 0
                                      ? formatDecimal(
                                          item.logistics_total_price / item.total_quantity,
                                          4
                                        )
                                      : '-'}
                                  </TableCell>
                                  <TableCell className={`w-[100px] text-right ${DENSE_CELL}`}>
                                    {item.logistics_total_price > 0
                                      ? formatDecimal(item.logistics_total_price, 2)
                                      : '-'}
                                  </TableCell>
                                </TableRow>
                              )
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </DataTableCardBody>
                </DataTableCard>
              ) : activeTab === 'sku-summary' ? (
                <DataTableCard className="min-w-0">
                  {/* Row1: 标题 + 按钮 */}
                  <DataTableCardHeader className="flex min-w-0 flex-col gap-3 px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                        SKU Summary
                      </div>
                      <CardTitle>SKU 汇总</CardTitle>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        disabled={
                          skuSummaryLoading || skuSummaryExporting || skuSummaryItems.length === 0
                        }
                        onClick={() => void exportSkuSummaryToExcel()}
                      >
                        <FileDown className="h-4 w-4" />
                        {skuSummaryExporting ? '导出中...' : '导出 Excel'}
                      </Button>
                    </div>
                  </DataTableCardHeader>
                  {/* Row2: 统计条 */}
                  {skuSummaryLoading ? (
                    <DataTableCardStatBar
                      items={[
                        { label: 'SKU 数', value: <Skeleton className="h-6 w-12" /> },
                        { label: '总数量', value: <Skeleton className="h-6 w-16" /> },
                        { label: '总计费重', value: <Skeleton className="h-6 w-14" /> },
                        { label: '总费用', value: <Skeleton className="h-6 w-16" /> },
                      ]}
                    />
                  ) : (
                    <DataTableCardStatBar
                      items={[
                        { label: 'SKU 数', value: skuSummaryItems.length },
                        {
                          label: '总数量',
                          value: skuSummaryItems
                            .reduce((acc, item) => acc + item.total_quantity, 0)
                            .toLocaleString(),
                        },
                        {
                          label: '总计费重',
                          value: `${formatDecimal(skuSummaryItems.reduce((acc, item) => acc + item.total_chargeable_weight_kg, 0))} kg`,
                        },
                        {
                          label: '总费用',
                          value: `¥ ${formatDecimal(
                            skuSummaryItems.reduce(
                              (acc, item) => acc + item.total_logistics_cost,
                              0
                            ),
                            2
                          )}`,
                          highlight: true,
                        },
                      ]}
                    />
                  )}
                  {/* 表格 */}
                  <DataTableCardBody>
                    {skuSummaryItems.length === 0 && !skuSummaryLoading ? (
                      <div className="py-14 text-center text-sm text-muted-foreground">
                        当前没有符合口径的 SKU 汇总数据。
                      </div>
                    ) : (
                      <div className="relative">
                        {skuSummaryLoading && skuSummaryItems.length > 0 ? (
                          <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-border/70 bg-[hsl(var(--surface-panel))] px-3 py-1 text-xs text-muted-foreground shadow-sm">
                            SKU 汇总更新中...
                          </div>
                        ) : null}
                        <Table
                          containerClassName={TABLE_SCROLL_CONTAINER_CLASS}
                          className="w-full min-w-[1120px]"
                        >
                          <TableHeader>
                            <TableRow className="bg-[hsl(var(--surface-subtle))]">
                              <TableHead className={`w-[100px] whitespace-nowrap ${DENSE_HEAD}`}>
                                项目
                              </TableHead>
                              <TableHead className={`w-[70px] whitespace-nowrap ${DENSE_HEAD}`}>
                                国家
                              </TableHead>
                              <TableHead className={`w-[120px] whitespace-nowrap ${DENSE_HEAD}`}>
                                SKU
                              </TableHead>
                              <TableHead
                                className={`w-[80px] whitespace-nowrap text-right ${DENSE_HEAD}`}
                              >
                                参与批次数
                              </TableHead>
                              <TableHead
                                className={`w-[80px] whitespace-nowrap text-right ${DENSE_HEAD}`}
                              >
                                总数量
                              </TableHead>
                              <TableHead
                                className={`w-[90px] whitespace-nowrap text-right ${DENSE_HEAD}`}
                              >
                                总计费重(kg)
                              </TableHead>
                              <TableHead
                                className={`w-[90px] whitespace-nowrap text-right ${DENSE_HEAD}`}
                              >
                                总发货费用
                              </TableHead>
                              <TableHead
                                className={`w-[100px] whitespace-nowrap text-right ${DENSE_HEAD}`}
                              >
                                平均发运单价
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {skuSummaryLoading && skuSummaryItems.length === 0 ? (
                              <TableSkeletonRows columns={8} />
                            ) : null}
                            {skuSummaryItems.map((item) => {
                              const country = countryMeta(item.country)
                              return (
                                <TableRow key={`${item.project_id}-${item.country}-${item.sku}`}>
                                  <TableCell className={`w-[100px] font-medium ${DENSE_CELL}`}>
                                    {item.project_name}
                                  </TableCell>
                                  <TableCell className={`w-[70px] ${DENSE_CELL}`}>
                                    <Badge className={`${country.className} h-5 px-2 text-[11px]`}>
                                      {country.label}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className={`w-[120px] font-medium ${DENSE_CELL}`}>
                                    {item.sku}
                                  </TableCell>
                                  <TableCell className={`w-[80px] text-right ${DENSE_CELL}`}>
                                    {item.shipment_count}
                                  </TableCell>
                                  <TableCell className={`w-[80px] text-right ${DENSE_CELL}`}>
                                    {item.total_quantity.toLocaleString()}
                                  </TableCell>
                                  <TableCell className={`w-[90px] text-right ${DENSE_CELL}`}>
                                    {formatDecimal(item.total_chargeable_weight_kg)}
                                  </TableCell>
                                  <TableCell className={`w-[90px] text-right ${DENSE_CELL}`}>
                                    ¥ {formatDecimal(item.total_logistics_cost, 2)}
                                  </TableCell>
                                  <TableCell className={`w-[100px] text-right ${DENSE_CELL}`}>
                                    ¥ {formatDecimal(item.average_logistics_unit_price, 4)}
                                  </TableCell>
                                </TableRow>
                              )
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </DataTableCardBody>
                </DataTableCard>
              ) : (
                <DataTableCard className="min-w-0">
                  {/* Row1: 标题 + 按钮 */}
                  <DataTableCardHeader className="flex min-w-0 flex-col gap-2 px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
                    <div className="flex min-w-0 flex-col gap-1 xl:flex-row xl:items-center xl:gap-6">
                      <div className="min-w-0">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                          FBA Box List
                        </div>
                        <CardTitle>FBA 箱单明细</CardTitle>
                      </div>
                      {/* Row2: 项目/国家/货件数量 — 扁平无边框 */}
                      {fbaBoxMeta ? (
                        <div className="flex items-center gap-4 xl:gap-5">
                          <div className="flex items-center gap-1.5 text-sm">
                            <span className="text-muted-foreground">项目:</span>
                            <span className="font-medium">
                              {fbaBoxMeta.projectNames.length === 1
                                ? fbaBoxMeta.projectNames[0]
                                : `${fbaBoxMeta.projectNames.length} 个项目`}
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5 text-sm">
                            <span className="text-muted-foreground">国家:</span>
                            {(() => {
                              const singleCountry =
                                fbaBoxMeta.countries.length === 1
                                  ? countryMeta(fbaBoxMeta.countries[0])
                                  : null
                              return singleCountry ? (
                                <Badge
                                  className={`${singleCountry.className} h-5 px-2 text-[11px]`}
                                >
                                  {singleCountry.label}
                                </Badge>
                              ) : (
                                <Badge variant="secondary" className="h-5 px-2 text-[11px]">
                                  {fbaBoxMeta.countries.length} 个
                                </Badge>
                              )
                            })()}
                          </div>
                          <div className="flex items-center gap-1.5 text-sm">
                            <span className="text-muted-foreground">货件:</span>
                            <span className="font-medium">{fbaBoxMeta.shipmentNos.length}</span>
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        disabled={selectedShipmentNoFilter.length === 0 || fbaBoxLoading}
                        onClick={() => {
                          if (selectedShipmentNoFilter.length > 0)
                            void loadFbaBoxDetails(selectedShipmentNoFilter)
                        }}
                      >
                        <RefreshCcw className="h-4 w-4" />
                        刷新
                      </Button>
                      <Button
                        variant="outline"
                        disabled={fbaBoxItems.length === 0 || fbaBoxExporting}
                        onClick={() => void exportFbaBoxDetailsToExcel()}
                      >
                        <FileDown className="h-4 w-4" />
                        {fbaBoxExporting ? '导出中...' : '导出 Excel'}
                      </Button>
                    </div>
                  </DataTableCardHeader>
                  {/* Row2: 统计条 */}
                  {fbaBoxLoading ? (
                    <DataTableCardStatBar
                      items={[
                        { label: 'SKU', value: <Skeleton className="h-6 w-12" /> },
                        { label: '外箱数', value: <Skeleton className="h-6 w-12" /> },
                        { label: '总重量', value: <Skeleton className="h-6 w-14" /> },
                        { label: '总体积', value: <Skeleton className="h-6 w-14" /> },
                      ]}
                    />
                  ) : (
                    <DataTableCardStatBar
                      items={[
                        { label: 'SKU', value: fbaBoxItems.length },
                        { label: '外箱数', value: fbaBoxSummary.totalCartons },
                        {
                          label: '总重量',
                          value: `${formatDecimal(fbaBoxSummary.totalWeightKg)} kg`,
                        },
                        {
                          label: '总体积',
                          value: `${formatDecimal(fbaBoxSummary.totalVolumeM3, 4)} m³`,
                          highlight: true,
                        },
                      ]}
                    />
                  )}
                  {/* 表格 */}
                  <DataTableCardBody>
                    {selectedShipmentNoFilter.length === 0 ? (
                      <div className="py-14 text-center text-sm text-muted-foreground">
                        请选择一个或多个 FBA 货件编号后再加载箱单明细。
                      </div>
                    ) : fbaBoxItems.length === 0 && !fbaBoxLoading ? (
                      <div className="py-14 text-center text-sm text-muted-foreground">
                        当前筛选货件暂无可展示的 FBA 箱单明细。
                      </div>
                    ) : (
                      <div className="relative">
                        {fbaBoxLoading && fbaBoxItems.length > 0 ? (
                          <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-border/70 bg-[hsl(var(--surface-panel))] px-3 py-1 text-xs text-muted-foreground shadow-sm">
                            箱单明细更新中...
                          </div>
                        ) : null}
                        <Table
                          containerClassName={TABLE_SCROLL_CONTAINER_CLASS}
                          className="w-full min-w-[1300px]"
                        >
                          <TableHeader>
                            <TableRow className="bg-[hsl(var(--surface-subtle))]">
                              <TableHead className={`whitespace-nowrap w-[140px] ${DENSE_HEAD}`}>
                                货件编号
                              </TableHead>
                              <TableHead className={`whitespace-nowrap w-[120px] ${DENSE_HEAD}`}>
                                追踪 ID
                              </TableHead>
                              <TableHead className={`whitespace-nowrap w-[80px] ${DENSE_HEAD}`}>
                                仓库 ID
                              </TableHead>
                              <TableHead className={`whitespace-nowrap w-[140px] ${DENSE_HEAD}`}>
                                SKU
                              </TableHead>
                              <TableHead className={`whitespace-nowrap w-[80px] ${DENSE_HEAD}`}>
                                产品图片
                              </TableHead>
                              <TableHead className={`whitespace-nowrap w-[180px] ${DENSE_HEAD}`}>
                                外箱尺寸和重量
                              </TableHead>
                              <TableHead
                                className={`whitespace-nowrap w-[80px] text-right ${DENSE_HEAD}`}
                              >
                                装箱率
                              </TableHead>
                              <TableHead
                                className={`whitespace-nowrap w-[60px] text-right ${DENSE_HEAD}`}
                              >
                                总箱数
                              </TableHead>
                              <TableHead
                                className={`whitespace-nowrap w-[100px] text-right ${DENSE_HEAD}`}
                              >
                                标签号段
                              </TableHead>
                              <TableHead
                                className={`whitespace-nowrap w-[80px] text-right ${DENSE_HEAD}`}
                              >
                                总数量
                              </TableHead>
                              <TableHead
                                className={`whitespace-nowrap w-[80px] text-right ${DENSE_HEAD}`}
                              >
                                总体积(m³)
                              </TableHead>
                              <TableHead
                                className={`whitespace-nowrap w-[80px] text-right ${DENSE_HEAD}`}
                              >
                                总重量(kg)
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {fbaBoxLoading && fbaBoxItems.length === 0 ? (
                              <TableSkeletonRows columns={12} />
                            ) : null}
                            {fbaBoxItems.map((item, index) => {
                              const warehouseGroup = fbaBoxWarehouseGroups.find(
                                (g) =>
                                  g.shipmentNo === item.shipment_no &&
                                  index >= g.startIndex &&
                                  index <= g.endIndex
                              )
                              const warehouseRowSpan = warehouseGroup
                                ? warehouseGroup.endIndex - warehouseGroup.startIndex + 1
                                : 1
                              const showWarehouse =
                                warehouseGroup && warehouseGroup.startIndex === index

                              const shipmentGroup = fbaBoxShipmentGroups.find(
                                (g) =>
                                  g.shipmentNo === item.shipment_no &&
                                  index >= g.startIndex &&
                                  index <= g.endIndex
                              )
                              const shipmentRowSpan = shipmentGroup
                                ? shipmentGroup.endIndex - shipmentGroup.startIndex + 1
                                : 1
                              const showShipment =
                                shipmentGroup && shipmentGroup.startIndex === index

                              const trackingGroup = fbaBoxTrackingGroups.find(
                                (g) =>
                                  g.shipmentNo === item.shipment_no &&
                                  index >= g.startIndex &&
                                  index <= g.endIndex
                              )
                              const trackingRowSpan = trackingGroup
                                ? trackingGroup.endIndex - trackingGroup.startIndex + 1
                                : 1
                              const showTracking =
                                trackingGroup && trackingGroup.startIndex === index

                              const cartonInfo =
                                item.length_cm || item.width_cm || item.height_cm
                                  ? `${formatDimensionText(item.length_cm, item.width_cm, item.height_cm)}${item.carton_weight_kg ? ` / ${formatDecimal(item.carton_weight_kg, 3)} kg` : ''}`
                                  : '-'

                              return (
                                <TableRow key={`fba-box-${item.shipment_no}-${item.sku}-${index}`}>
                                  {showShipment ? (
                                    <TableCell
                                      className={`w-[140px] font-semibold text-primary bg-primary/5 ${DENSE_CELL}`}
                                      rowSpan={shipmentRowSpan}
                                    >
                                      {item.shipment_no}
                                    </TableCell>
                                  ) : null}
                                  {showTracking ? (
                                    <TableCell
                                      className={`w-[120px] font-mono text-xs ${DENSE_CELL}`}
                                      rowSpan={trackingRowSpan}
                                    >
                                      {item.tracking_no || '-'}
                                    </TableCell>
                                  ) : null}
                                  {showWarehouse ? (
                                    <TableCell
                                      className={`w-[80px] font-semibold text-primary bg-primary/5 ${DENSE_CELL}`}
                                      rowSpan={warehouseRowSpan}
                                    >
                                      {item.warehouse_code || '-'}
                                    </TableCell>
                                  ) : null}
                                  <TableCell className={`w-[140px] font-medium ${DENSE_CELL}`}>
                                    {item.sku}
                                  </TableCell>
                                  <TableCell className={`w-[80px] ${DENSE_CELL}`}>
                                    {item.product_image_thumbnail_r2_url ? (
                                      <button
                                        type="button"
                                        onClick={() => openFbaImageLightbox(item)}
                                        className="block h-[60px] w-[60px] overflow-hidden rounded border border-border/50 transition-opacity hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-primary/50"
                                        aria-label={`查看 ${item.sku} 产品大图`}
                                      >
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img
                                          src={item.product_image_thumbnail_r2_url}
                                          alt={item.sku}
                                          className="h-full w-full object-cover"
                                        />
                                      </button>
                                    ) : (
                                      <div className="flex h-[60px] w-[60px] items-center justify-center rounded border border-dashed border-border/50 text-[10px] text-muted-foreground">
                                        无图
                                      </div>
                                    )}
                                  </TableCell>
                                  <TableCell className={`w-[180px] ${DENSE_CELL}`}>
                                    {cartonInfo}
                                  </TableCell>
                                  <TableCell className={`w-[80px] text-right ${DENSE_CELL}`}>
                                    {item.units_per_carton > 0
                                      ? `${item.units_per_carton} / 箱`
                                      : '-'}
                                  </TableCell>
                                  <TableCell className={`w-[60px] text-right ${DENSE_CELL}`}>
                                    {item.carton_count > 0 ? item.carton_count : '-'}
                                  </TableCell>
                                  <TableCell
                                    className={`w-[100px] text-right font-mono text-xs ${DENSE_CELL}`}
                                  >
                                    {fbaBoxLabelRanges[index] ?? '-'}
                                  </TableCell>
                                  <TableCell className={`w-[80px] text-right ${DENSE_CELL}`}>
                                    {item.quantity > 0 ? item.quantity : '-'}
                                  </TableCell>
                                  <TableCell className={`w-[80px] text-right ${DENSE_CELL}`}>
                                    {formatDecimal(item.total_volume_m3, 4)}
                                  </TableCell>
                                  <TableCell className={`w-[80px] text-right ${DENSE_CELL}`}>
                                    {item.total_weight_kg > 0
                                      ? formatDecimal(item.total_weight_kg)
                                      : '0'}
                                  </TableCell>
                                </TableRow>
                              )
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </DataTableCardBody>
                </DataTableCard>
              )}
            </TabsContent>
          </DirectionalTabTransition>
        </Tabs>
      </div>

      <ImageLightbox
        open={fbaLightboxItem !== null}
        onOpenChange={(open) => {
          if (!open) closeFbaImageLightbox()
        }}
        src={fbaLightboxItem?.product_image_r2_url || ''}
        alt={fbaLightboxItem?.sku || ''}
        meta={{
          sku: fbaLightboxItem?.sku,
          productName: null,
        }}
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          aria-describedby="shipment-dialog-description"
          className="max-w-[calc(100%-2rem)] max-h-[calc(100vh-3rem)] overflow-auto rounded-lg border-border/70 bg-[hsl(var(--surface-panel))] dark:border-border/90 sm:max-w-5xl"
        >
          <span id="shipment-dialog-description" className="sr-only">
            {dialogMode === 'create' ? '新建船期批次' : '编辑船期批次'}
          </span>
          <DialogHeader>
            <DialogTitle className="text-foreground">
              {dialogMode === 'create' ? '新建船期批次' : '编辑船期批次'}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {dialogMode === 'create'
                ? '先创建批次，再在编辑页维护 SKU 明细。'
                : '可直接在下方维护 SKU 明细，支持项目 SKU 下拉选择与手动增行。'}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2 md:grid-cols-2 lg:grid-cols-4 [&>div]:min-w-0">
            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">项目</div>
              <Select
                value={form.project_id}
                onValueChange={(value) => handleFormChange('project_id', value)}
              >
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
              <div className="text-sm font-medium text-foreground">发货批次</div>
              <ShipmentBatchCombobox
                value={form.shipment_batch}
                onChange={(value) => handleFormChange('shipment_batch', value)}
                projectId={form.project_id}
                country={form.country}
              />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">货件编号</div>
              <Input
                value={form.shipment_no}
                onChange={(event) => handleFormChange('shipment_no', event.target.value)}
                placeholder="如 FBA19647N7ZW"
              />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">运输方式</div>
              <Select
                value={form.shipping_method}
                onValueChange={(value) => handleFormChange('shipping_method', value)}
              >
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
              <div className="text-sm font-medium text-foreground">国家地区</div>
              <Select
                value={form.country}
                onValueChange={(value) => handleFormChange('country', value)}
              >
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
              <div className="text-sm font-medium text-foreground">状态</div>
              <Select
                value={form.shipment_status}
                onValueChange={(value) => handleFormChange('shipment_status', value)}
              >
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
              <div className="text-sm font-medium text-foreground">追踪号</div>
              <Input
                value={form.tracking_no}
                onChange={(event) => handleFormChange('tracking_no', event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">仓库编码</div>
              <Input
                value={form.warehouse_code}
                onChange={(event) => handleFormChange('warehouse_code', event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">货代公司</div>
              <Input
                value={form.forwarder_name}
                onChange={(event) => handleFormChange('forwarder_name', event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">发货时间</div>
              <SingleDatePicker
                value={parseDateInputValue(form.created_date)}
                onChange={(date) =>
                  handleFormChange('created_date', formatPickerDateInputValue(date))
                }
              />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">ETD</div>
              <SingleDatePicker
                value={parseDateInputValue(form.etd_date)}
                onChange={(date) => handleFormChange('etd_date', formatPickerDateInputValue(date))}
              />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">ETA</div>
              <SingleDatePicker
                value={parseDateInputValue(form.eta_date)}
                onChange={(date) => handleFormChange('eta_date', formatPickerDateInputValue(date))}
              />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">实际入仓日期</div>
              <SingleDatePicker
                value={parseDateInputValue(form.actual_inbound_date)}
                onChange={(date) =>
                  handleFormChange('actual_inbound_date', formatPickerDateInputValue(date))
                }
              />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">物流报价（物流单价）</div>
              <Input
                inputMode="decimal"
                placeholder="例如 8.50"
                value={logisticsUnitPrice}
                onChange={(event) => setLogisticsUnitPrice(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-foreground">是否参与历史发货核算</div>
              <Select
                value={form.include_in_history_shipping_calc}
                onValueChange={(value) =>
                  handleFormChange('include_in_history_shipping_calc', value)
                }
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
              <div className="text-sm font-medium text-foreground">备注</div>
              <textarea
                value={form.remark}
                onChange={(event) => handleFormChange('remark', event.target.value)}
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring dark:border-border/70 dark:bg-[hsl(var(--surface-soft))] dark:text-foreground"
              />
            </div>
          </div>

          {dialogMode === 'edit' && detail && (
            <>
              <div className="pt-2" />
              <div className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-sm font-semibold">SKU 明细</div>
                    <div className="text-xs text-muted-foreground">
                      {editableItemStats.skuCount} 个 SKU，合计{' '}
                      {editableItemStats.totalQuantity.toLocaleString()} 件
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
                            ['project_name', 'shipment_no', 'SKU', 'carton_count', 'quantity'],
                            [[detail.project_name, detail.shipment_no, 'SKU-DEMO', 10, '']]
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
                    <Button
                      variant="outline"
                      onClick={() => void handleDownloadProductLabels()}
                      disabled={editableItems.length === 0 || labelDownloading}
                      className="gap-2"
                    >
                      <Tag className="h-4 w-4" />
                      {labelDownloading ? '下载中...' : '下载产品标签'}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void exportFbaDeliveryTemplateToExcel()}
                      disabled={!detail || exporting}
                      className="gap-2"
                    >
                      <FileSpreadsheet className="h-4 w-4" />
                      {exporting ? '导出中...' : 'FBA发货模板'}
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <div className="rounded-2xl border border-border/70 bg-[hsl(var(--surface-subtle))] px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                      SKU 数
                    </div>
                    <div className="mt-1 text-lg font-semibold">{detail.sku_count}</div>
                  </div>
                  <div className="rounded-2xl border border-border/70 bg-[hsl(var(--surface-subtle))] px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                      体积
                    </div>
                    <div className="mt-1 text-lg font-semibold">
                      {costPreviewRows.length > 0
                        ? `${formatDecimal(costPreviewSummary.totalVolumeM3, 4)} m³`
                        : '待核算'}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-border/70 bg-[hsl(var(--surface-subtle))] px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                      计费重
                    </div>
                    <div className="mt-1 text-lg font-semibold">
                      {costPreviewRows.length > 0
                        ? `${formatDecimal(costPreviewSummary.totalChargeableWeightKg)} kg`
                        : '待核算'}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-border/70 bg-[hsl(var(--surface-subtle))] px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                      预估运费
                    </div>
                    <div className="mt-1 text-lg font-semibold">
                      {costPreviewRows.length > 0
                        ? `¥ ${formatDecimal(costPreviewSummary.totalEstimatedCost, 2)}`
                        : '待核算'}
                    </div>
                  </div>
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
                <div className="overflow-hidden rounded-lg border border-border/70">
                  <div className="max-h-[280px] overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-border/70">
                          <TableHead className="w-[140px] text-xs font-medium">SKU</TableHead>
                          <TableHead className="w-20 text-right text-xs font-medium">
                            装箱率
                          </TableHead>
                          <TableHead className="w-20 text-right text-xs font-medium">
                            外箱数
                          </TableHead>
                          <TableHead className="w-20 text-right text-xs font-medium">
                            数量
                          </TableHead>
                          <TableHead className="w-16 text-right text-xs font-medium">
                            实际重
                          </TableHead>
                          <TableHead className="w-16 text-right text-xs font-medium">
                            体积重
                          </TableHead>
                          <TableHead className="w-20 text-right text-xs font-medium">
                            发货费用
                          </TableHead>
                          <TableHead className="w-16 text-right text-xs font-medium">
                            单价
                          </TableHead>
                          <TableHead className="w-10 text-right text-xs font-medium">
                            操作
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {editableItems.length === 0 ? (
                          <EmptyTableState colSpan={9} message="还没有 SKU 明细" />
                        ) : (
                          editableItems.map((item) => {
                            const preview = detail.items.find(
                              (detailItem) => detailItem.sku === item.sku
                            )
                              ? costPreviewRows.find((row) => row.sku === item.sku)
                              : undefined
                            const selectedSku = projectSkuOptions.find(
                              (option) => option.sku === item.sku
                            )
                            const unitsPerCarton = selectedSku?.units_per_carton ?? 0
                            const cartonCountNum = Number(item.cartonCount)
                            const computedQty =
                              unitsPerCarton > 0 &&
                              Number.isFinite(cartonCountNum) &&
                              cartonCountNum > 0
                                ? cartonCountNum * unitsPerCarton
                                : Number.isFinite(cartonCountNum) && cartonCountNum > 0
                                  ? cartonCountNum
                                  : 0
                            // 历史数据优先显示原始数量；新数据有箱数则显示换算值；均无则显示 -
                            const displayQty =
                              item.originalQuantity !== null
                                ? item.originalQuantity
                                : computedQty > 0
                                  ? computedQty
                                  : 0
                            return (
                              <TableRow key={item.tempId} className="border-border/70">
                                <TableCell className="py-1.5">
                                  <SearchableSkuField
                                    value={item.sku}
                                    options={projectSkuOptions}
                                    loading={projectSkuLoading}
                                    onChange={(value) =>
                                      handleEditableItemChange(item.tempId, 'sku', value)
                                    }
                                  />
                                  {item.originalQuantity === null &&
                                  item.sku &&
                                  selectedSku &&
                                  (selectedSku.units_per_carton ?? 0) <= 0 ? (
                                    <p className="mt-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                                      ⚠️ 该 SKU 未维护装箱率，请先在 SKU 信息中补充
                                    </p>
                                  ) : null}
                                </TableCell>
                                <TableCell className="py-1.5 text-right text-xs text-muted-foreground">
                                  {unitsPerCarton > 0 ? unitsPerCarton : '-'}
                                </TableCell>
                                <TableCell className="py-1.5 text-right">
                                  <Input
                                    inputMode="numeric"
                                    value={item.cartonCount}
                                    onChange={(event) =>
                                      handleEditableItemChange(
                                        item.tempId,
                                        'cartonCount',
                                        event.target.value
                                      )
                                    }
                                    className="h-7 w-full text-right text-xs"
                                    placeholder="箱数"
                                  />
                                </TableCell>
                                <TableCell className="py-1.5 text-right text-xs font-medium text-foreground">
                                  {displayQty > 0 ? displayQty.toLocaleString() : '-'}
                                </TableCell>
                                <TableCell className="py-1.5 text-right text-xs text-muted-foreground">
                                  {preview ? formatDecimal(preview.actualWeightKg, 2) : '-'}
                                </TableCell>
                                <TableCell className="py-1.5 text-right text-xs text-muted-foreground">
                                  {preview ? formatDecimal(preview.volumetricWeightKg, 2) : '-'}
                                </TableCell>
                                <TableCell className="py-1.5 text-right text-xs text-muted-foreground">
                                  {preview ? `¥ ${formatDecimal(preview.estimatedCost, 2)}` : '-'}
                                </TableCell>
                                <TableCell className="py-1.5 text-right text-xs text-muted-foreground">
                                  {preview
                                    ? `¥ ${formatDecimal(preview.averageUnitPrice, 2)}`
                                    : '-'}
                                </TableCell>
                                <TableCell className="py-1.5 text-right">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6"
                                    onClick={() => handleRemoveEditableItem(item.tempId)}
                                  >
                                    <X className="h-3.5 w-3.5" />
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
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2"
                  onClick={handleAddEditableItem}
                >
                  <Plus className="h-4 w-4" />
                  增加一行
                </Button>
              </div>
            </>
          )}

          <Separator className="bg-border" />
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
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              className="dark:border-border/70 dark:bg-[hsl(var(--surface-soft))] dark:text-foreground"
            >
              取消
            </Button>
            <Button onClick={() => void submitForm()} disabled={submitting}>
              {submitting ? '保存中...' : dialogMode === 'create' ? '创建' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={skuDialogOpen} onOpenChange={setSkuDialogOpen}>
        <DialogContent
          aria-describedby="sku-detail-dialog-description"
          className="max-w-[calc(100%-2rem)] max-h-[calc(100vh-3rem)] overflow-auto rounded-lg border-border/70 bg-[hsl(var(--surface-panel))] dark:border-border/90 sm:max-w-2xl"
        >
          <span id="sku-detail-dialog-description" className="sr-only">
            SKU 明细：
            {skuDialogDetail
              ? `${skuDialogDetail.shipment_no} - ${skuDialogDetail.sku_count} 个 SKU，合计 ${skuDialogDetail.total_quantity.toLocaleString()} 件`
              : ''}
          </span>
          <DialogHeader>
            <DialogTitle className="text-foreground">SKU 明细</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {skuDialogDetail
                ? `${skuDialogDetail.shipment_no} - ${skuDialogDetail.sku_count} 个 SKU，合计 ${skuDialogDetail.total_quantity.toLocaleString()} 件`
                : ''}
            </DialogDescription>
          </DialogHeader>

          {skuDialogLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : skuDialogDetail ? (
            <div className="overflow-hidden rounded-lg border border-border/70">
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
                      <EmptyTableState colSpan={2} message="还没有 SKU 明细" />
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
            <Button
              variant="outline"
              onClick={() => setSkuDialogOpen(false)}
              className="dark:border-border/70 dark:bg-[hsl(var(--surface-soft))] dark:text-foreground"
            >
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent
          aria-describedby="delete-shipment-dialog-description"
          className="max-w-[calc(100%-2rem)] rounded-lg sm:max-w-md"
        >
          <span id="delete-shipment-dialog-description" className="sr-only">
            确认删除船期批次
            {detail
              ? `，确定删除船期批次 ${detail.shipment_no} 吗？该批次下的 SKU 明细也会一并删除，且无法恢复。`
              : '，此操作不可恢复。'}
          </span>
          <DialogHeader>
            <DialogTitle>确认删除批次</DialogTitle>
            <DialogDescription>
              {detail
                ? `确定删除船期批次 ${detail.shipment_no} 吗？该批次下的 SKU 明细也会一并删除，且无法恢复。`
                : '此操作不可恢复。'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={deleting}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDeleteSchedule()}
              disabled={deleting}
            >
              {deleting ? '删除中...' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
