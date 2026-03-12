'use client'

import { type ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCcw, Upload, FileDown, Plus, Pencil } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const API_BASE = '/api/backend'

type ProjectOption = {
  id: number
  name: string
}

type ShipmentScheduleListItem = {
  id: number
  project_id: number
  project_name: string
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
  updated_at: string
}

type ShipmentScheduleItemRow = {
  id: number
  item_date: string | null
  sku: string
  quantity: number
  remark: string | null
}

type ShipmentScheduleDetail = ShipmentScheduleListItem & { items: ShipmentScheduleItemRow[] }

type ShipmentScheduleListResponse = {
  items: ShipmentScheduleListItem[]
  page: number
  page_size: number
  total: number | null
  has_next: boolean
}

type ShipmentSchedulesImportResponse = {
  inserted: number
  shipment_nos: string[]
}

type ScheduleFormState = {
  project_id: string
  shipment_no: string
  tracking_no: string
  warehouse_code: string
  forwarder_name: string
  shipping_method: string
  created_date: string
  etd_date: string
  eta_date: string
  actual_inbound_date: string
  remark: string
  shipment_status: string
}

const STATUS_OPTIONS = [
  { value: 'draft', label: '草稿' },
  { value: 'preparing', label: '备货中' },
  { value: 'in_transit', label: '在途' },
  { value: 'arrived_port', label: '已到港' },
  { value: 'inbound_processing', label: '入仓处理中' },
  { value: 'completed', label: '完成' },
  { value: 'cancelled', label: '已取消' },
] as const

const METHOD_OPTIONS = [
  { value: 'sea', label: '海运' },
  { value: 'air', label: '空运' },
  { value: 'express', label: '快递' },
  { value: 'truck', label: '卡航/汽运' },
  { value: 'rail', label: '铁路' },
  { value: 'other', label: '其他' },
] as const

const EMPTY_FORM: ScheduleFormState = {
  project_id: '',
  shipment_no: '',
  tracking_no: '',
  warehouse_code: '',
  forwarder_name: '',
  shipping_method: 'sea',
  created_date: '',
  etd_date: '',
  eta_date: '',
  actual_inbound_date: '',
  remark: '',
  shipment_status: 'draft',
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

function statusMeta(status: string): { label: string; className: string } {
  const map: Record<string, { label: string; className: string }> = {
    draft: { label: '草稿', className: 'border border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200' },
    preparing: { label: '备货中', className: 'border border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-900/80 dark:bg-amber-950/60 dark:text-amber-300' },
    in_transit: { label: '在途', className: 'border border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-900/80 dark:bg-sky-950/60 dark:text-sky-300' },
    arrived_port: { label: '已到港', className: 'border border-cyan-200 bg-cyan-100 text-cyan-700 dark:border-cyan-900/80 dark:bg-cyan-950/60 dark:text-cyan-300' },
    inbound_processing: { label: '入仓处理中', className: 'border border-violet-200 bg-violet-100 text-violet-700 dark:border-violet-900/80 dark:bg-violet-950/60 dark:text-violet-300' },
    completed: { label: '完成', className: 'border border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-900/80 dark:bg-emerald-950/60 dark:text-emerald-300' },
    cancelled: { label: '已取消', className: 'border border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-900/80 dark:bg-rose-950/60 dark:text-rose-300' },
  }
  return map[status] || { label: status, className: 'border border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200' }
}

function methodLabel(method: string): string {
  return METHOD_OPTIONS.find((item) => item.value === method)?.label || method
}

function buildFormFromDetail(detail: ShipmentScheduleDetail): ScheduleFormState {
  return {
    project_id: String(detail.project_id),
    shipment_no: detail.shipment_no,
    tracking_no: detail.tracking_no || '',
    warehouse_code: detail.warehouse_code || '',
    forwarder_name: detail.forwarder_name || '',
    shipping_method: detail.shipping_method,
    created_date: detail.created_date || '',
    etd_date: detail.etd_date || '',
    eta_date: detail.eta_date || '',
    actual_inbound_date: detail.actual_inbound_date || '',
    remark: detail.remark || '',
    shipment_status: detail.shipment_status,
  }
}

export default function ShipmentManagementPage() {
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)

  const [items, setItems] = useState<ShipmentScheduleListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [hasNext, setHasNext] = useState(false)

  const [projectFilter, setProjectFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [methodFilter, setMethodFilter] = useState('all')
  const [shipmentNoFilter, setShipmentNoFilter] = useState('')

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<ShipmentScheduleDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogMode, setDialogMode] = useState<'create' | 'edit'>('create')
  const [form, setForm] = useState<ScheduleFormState>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)

  const [skuDialogOpen, setSkuDialogOpen] = useState(false)
  const [skuDialogScheduleId, setSkuDialogScheduleId] = useState<number | null>(null)
  const [skuDialogDetail, setSkuDialogDetail] = useState<ShipmentScheduleDetail | null>(null)
  const [skuDialogLoading, setSkuDialogLoading] = useState(false)

  const [importing, setImporting] = useState(false)
  const [batchImporting, setBatchImporting] = useState(false)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

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

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true)
    try {
      const response = await fetch(`${API_BASE}/api/v1/projects`, { headers: authHeaders(), cache: 'no-store' })
      if (!response.ok) throw new Error(await parseError(response))
      const payload = (await response.json()) as ProjectOption[]
      setProjects(payload)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '项目列表加载失败')
    } finally {
      setProjectsLoading(false)
    }
  }, [])

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
      if (statusFilter !== 'all') params.set('shipment_status', statusFilter)
      if (methodFilter !== 'all') params.set('shipping_method', methodFilter)
      if (shipmentNoFilter.trim()) params.set('shipment_no', shipmentNoFilter.trim())

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
  }, [methodFilter, pageSize, projectFilter, shipmentNoFilter, statusFilter])

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
    } catch (loadError) {
      setDetail(null)
      setDetailError(loadError instanceof Error ? loadError.message : '详情加载失败')
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  useEffect(() => {
    void loadList(1)
  }, [loadList])

  useEffect(() => {
    if (selectedId) {
      void loadDetail(selectedId)
    } else {
      setDetail(null)
      setDetailError(null)
    }
  }, [loadDetail, selectedId])

  const openCreateDialog = () => {
    setDialogMode('create')
    setForm(EMPTY_FORM)
    setDialogOpen(true)
  }

  const openEditDialog = () => {
    if (!detail) return
    setDialogMode('edit')
    setForm(buildFormFromDetail(detail))
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
      setDetail(payload)
      setDialogMode('edit')
      setForm(buildFormFromDetail(payload))
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

  const submitForm = async () => {
    if (!form.project_id) {
      setError('请选择项目')
      return
    }
    if (!form.shipment_no.trim()) {
      setError('请输入货件编号')
      return
    }

    setSubmitting(true)
    setError(null)
    setSuccessMessage(null)
    try {
      const payload = {
        ...form,
        project_id: Number(form.project_id),
        shipment_no: form.shipment_no.trim(),
        tracking_no: form.tracking_no || null,
        warehouse_code: form.warehouse_code || null,
        forwarder_name: form.forwarder_name || null,
        created_date: form.created_date || null,
        etd_date: form.etd_date || null,
        eta_date: form.eta_date || null,
        actual_inbound_date: form.actual_inbound_date || null,
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
              tracking_no: payload.tracking_no,
              warehouse_code: payload.warehouse_code,
              forwarder_name: payload.forwarder_name,
              shipping_method: payload.shipping_method,
              created_date: payload.created_date,
              etd_date: payload.etd_date,
              eta_date: payload.eta_date,
              actual_inbound_date: payload.actual_inbound_date,
              remark: payload.remark,
              shipment_status: payload.shipment_status,
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
      await loadDetail(selectedId)
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
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : '批量导入失败')
    } finally {
      setBatchImporting(false)
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="space-y-6">
      <Card className="dashboard-surface">
        <CardHeader className="gap-4 pb-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-primary">Shipment Console</div>
              <CardTitle className="text-2xl tracking-tight">控制台</CardTitle>
              <CardDescription className="max-w-2xl text-sm leading-6">集中筛选批次、导入 CSV，并快速查看当前页发货规模。</CardDescription>
            </div>
            <div className="grid grid-cols-3 gap-2 xl:min-w-[360px]">
              <div className="rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">批次</div>
                <div className="mt-1 text-xl font-semibold">{items.length}</div>
              </div>
              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">SKU</div>
                <div className="mt-1 text-xl font-semibold">{summary.totalSku}</div>
              </div>
              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">数量</div>
                <div className="mt-1 text-xl font-semibold">{summary.totalQuantity.toLocaleString()}</div>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_auto] xl:gap-5">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 xl:col-span-1">

          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">项目</div>
            <Select value={projectFilter} onValueChange={setProjectFilter} disabled={projectsLoading}>
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
            <div className="text-xs font-medium text-muted-foreground">运输方式</div>
            <Select value={methodFilter} onValueChange={setMethodFilter}>
            <SelectTrigger>
              <SelectValue placeholder="全部方式" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部方式</SelectItem>
              {METHOD_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">货件编号</div>
            <Input value={shipmentNoFilter} onChange={(event) => setShipmentNoFilter(event.target.value)} placeholder="搜索 shipment no." />
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

      <div className="grid gap-6">
        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="overview">总览</TabsTrigger>
            <TabsTrigger value="edit">编辑</TabsTrigger>
          </TabsList>
          
          <TabsContent value="overview" className="mt-0">
            <Card className="dashboard-surface">
              <CardHeader className="border-b border-border/70">
                <div className="flex flex-row items-center justify-between gap-4">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Overview</div>
                    <CardTitle>船期批次总览</CardTitle>
                    <CardDescription>
                      共 {total} 条记录，当前第 {page} / {pageCount} 页
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
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
                {loading ? (
                  <div className="p-4">
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="mt-2 h-12 w-full" />
                    <Skeleton className="mt-2 h-12 w-full" />
                    <Skeleton className="mt-2 h-12 w-full" />
                    <Skeleton className="mt-2 h-12 w-full" />
                  </div>
                ) : items.length === 0 ? (
                  <div className="rounded-[28px] border border-dashed border-border px-4 py-14 text-center text-sm text-muted-foreground">
                    当前没有符合筛选条件的船期记录。
                  </div>
                ) : (
                  <div className="overflow-auto">
                    <Table className="w-full min-w-[1000px]">
                      <TableHeader>
                        <TableRow className="bg-muted/50">
                          <TableHead className="w-[90px] text-sm whitespace-nowrap">项目</TableHead>
                          <TableHead className="w-[90px] text-sm whitespace-nowrap">创建日期</TableHead>
                          <TableHead className="w-[120px] text-sm whitespace-nowrap">货件编号</TableHead>
                          <TableHead className="w-[70px] text-sm whitespace-nowrap">状态</TableHead>
                          <TableHead className="w-[80px] text-sm whitespace-nowrap">货代</TableHead>
                          <TableHead className="w-[70px] text-sm whitespace-nowrap">仓库</TableHead>
                          <TableHead className="w-[90px] text-sm whitespace-nowrap">ETD</TableHead>
                          <TableHead className="w-[90px] text-sm whitespace-nowrap">ETA</TableHead>
                          <TableHead className="w-[90px] text-sm whitespace-nowrap">ATA</TableHead>
                          <TableHead className="w-[50px] text-sm whitespace-nowrap text-right">SKU</TableHead>
                          <TableHead className="w-[60px] text-sm whitespace-nowrap text-right">数量</TableHead>
                          <TableHead className="w-[60px] text-sm whitespace-nowrap">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {items.map((item) => {
                          const status = statusMeta(item.shipment_status)
                          return (
                            <TableRow key={item.id} className={item.id === selectedId ? 'bg-primary/5' : ''}>
                              <TableCell className="text-sm font-medium">{item.project_name}</TableCell>
                              <TableCell className="text-sm">{formatDate(item.created_date)}</TableCell>
                              <TableCell className="text-sm font-medium">{item.shipment_no}</TableCell>
                              <TableCell>
                                <Badge className={`${status.className} text-[11px] py-0 h-5`}>{status.label}</Badge>
                              </TableCell>
                              <TableCell className="text-sm">{item.forwarder_name || '-'}</TableCell>
                              <TableCell className="text-sm">{item.warehouse_code || '-'}</TableCell>
                              <TableCell className="text-sm">{formatDate(item.etd_date)}</TableCell>
                              <TableCell className="text-sm">{formatDate(item.eta_date)}</TableCell>
                              <TableCell className="text-sm">{formatDate(item.actual_inbound_date)}</TableCell>
                              <TableCell className="text-sm text-right">{item.sku_count}</TableCell>
                              <TableCell className="text-sm text-right">{item.total_quantity.toLocaleString()}</TableCell>
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
          
          <TabsContent value="edit" className="mt-0">
            <Card className="dashboard-surface">
              <CardHeader className="border-b border-border/70">
                <div className="flex flex-row items-center justify-between gap-4">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Batches</div>
                    <CardTitle>船期批次</CardTitle>
                    <CardDescription>
                      共 {total} 条记录，当前第 {page} / {pageCount} 页
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" disabled={page <= 1 || loading} onClick={() => void loadList(page - 1)}>
                      上一页
                    </Button>
                    <Button variant="outline" disabled={!hasNext || loading} onClick={() => void loadList(page + 1)}>
                      下一页
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 p-4">
                {loading ? (
                  <div className="space-y-3">
                    {Array.from({ length: 5 }).map((_, index) => (
                      <Skeleton key={index} className="h-28 w-full rounded-[28px]" />
                    ))}
                  </div>
                ) : items.length === 0 ? (
                  <div className="rounded-[28px] border border-dashed border-border px-4 py-14 text-center text-sm text-muted-foreground">
                    当前没有符合筛选条件的船期记录。
                  </div>
                ) : (
                  items.map((item) => {
                    const selected = item.id === selectedId
                    const status = statusMeta(item.shipment_status)
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedId(item.id)}
                        className={`group relative w-full overflow-hidden rounded-[28px] border p-5 text-left transition ${
                          selected
                            ? 'border-primary/50 bg-primary/5 shadow-md dark:bg-primary/10'
                            : 'border-border/70 bg-card/50 hover:border-border hover:bg-muted/50'
                        }`}
                      >
                        <div className="flex flex-col gap-4">
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex flex-col gap-2 pl-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="text-base font-semibold">{item.project_name}</div>
                                <Badge className={status.className}>{status.label}</Badge>
                              </div>
                              <div className="text-xl font-semibold tracking-tight">{item.shipment_no}</div>
                              <div className="text-sm text-muted-foreground">
                                创建于 {item.created_date || '待补充'}
                              </div>
                            </div>
                            <div className="grid shrink-0 grid-cols-3 gap-2 sm:min-w-[280px]">
                              <button
                                type="button"
                                className="cursor-pointer rounded-2xl border border-border/70 bg-muted/50 p-3 text-center transition hover:border-primary/50 hover:bg-primary/5 dark:bg-muted/30"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void openSkuDialog(item.id)
                                }}
                              >
                                <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">SKU</div>
                                <div className="text-lg font-semibold text-foreground">{item.sku_count}</div>
                              </button>
                              <div className="rounded-2xl border border-border/70 bg-muted/50 p-3 text-center dark:bg-muted/30">
                                <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">数量</div>
                                <div className="text-lg font-semibold text-foreground">{item.total_quantity.toLocaleString()}</div>
                              </div>
                              <Button
                                type="button"
                                variant={selected ? 'default' : 'outline'}
                                className="h-auto rounded-2xl"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void handleEditSchedule(item.id)
                                }}
                              >
                                <span className="flex items-center justify-center gap-2">
                                  <Pencil className="h-4 w-4" />
                                  编辑
                                </span>
                              </Button>
                            </div>
                          </div>
                          <div className="grid gap-3 md:grid-cols-5">
                            <div className="rounded-2xl border border-border/70 bg-muted/50 px-3 py-2 dark:bg-muted/30">
                              <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">货代</div>
                              <div className="mt-1 text-sm font-medium truncate">{item.forwarder_name || '待补充'}</div>
                            </div>
                            <div className="rounded-2xl border border-border/70 bg-muted/50 px-3 py-2 dark:bg-muted/30">
                              <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">仓库</div>
                              <div className="mt-1 text-sm font-medium truncate">{item.warehouse_code || '待补充'}</div>
                            </div>
                            <div className="rounded-2xl border border-border/70 bg-muted/50 px-3 py-2 dark:bg-muted/30">
                              <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">ETD</div>
                              <div className="mt-1 text-sm font-medium">{formatDate(item.etd_date)}</div>
                            </div>
                            <div className="rounded-2xl border border-border/70 bg-muted/50 px-3 py-2 dark:bg-muted/30">
                              <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">ETA</div>
                              <div className="mt-1 text-sm font-medium">{formatDate(item.eta_date)}</div>
                            </div>
                            <div className="rounded-2xl border border-border/70 bg-muted/50 px-3 py-2 dark:bg-muted/30">
                              <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">ATA</div>
                              <div className="mt-1 text-sm font-medium">{formatDate(item.actual_inbound_date)}</div>
                            </div>
                          </div>
                        </div>
                      </button>
                    )
                  })
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-auto dark:border-slate-800 dark:bg-slate-950 sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="dark:text-slate-100">{dialogMode === 'create' ? '新建船期批次' : '编辑船期批次'}</DialogTitle>
            <DialogDescription className="dark:text-slate-400">主表维护过程信息，SKU 与数量明细请在详情区通过 CSV 导入。</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2 md:grid-cols-2">
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
                disabled={dialogMode === 'edit'}
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
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">创建日期</div>
              <Input type="date" value={form.created_date} onChange={(event) => handleFormChange('created_date', event.target.value)} />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">ETD</div>
              <Input type="date" value={form.etd_date} onChange={(event) => handleFormChange('etd_date', event.target.value)} />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">ETA</div>
              <Input type="date" value={form.eta_date} onChange={(event) => handleFormChange('eta_date', event.target.value)} />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">实际入仓日期</div>
              <Input
                type="date"
                value={form.actual_inbound_date}
                onChange={(event) => handleFormChange('actual_inbound_date', event.target.value)}
              />
            </div>

            <div className="space-y-2 md:col-span-2">
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
                      {detail.sku_count} 个 SKU，合计 {detail.total_quantity.toLocaleString()} 件
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
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
                  </div>
                </div>
                <div className="overflow-hidden rounded-[28px] border border-border/70">
                  <div className="max-h-[300px] overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>SKU</TableHead>
                          <TableHead>数量</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.items.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={2} className="py-8 text-center text-sm text-muted-foreground">
                              还没有 SKU 明细
                            </TableCell>
                          </TableRow>
                        ) : (
                          detail.items.map((item) => (
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
              </div>
            </>
          )}

          <Separator className="dark:bg-slate-800" />
          <DialogFooter>
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
    </div>
  )
}
