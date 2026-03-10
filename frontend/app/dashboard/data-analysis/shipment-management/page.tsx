'use client'

import { type ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Package2, RefreshCcw, Route, ShipWheel, Upload, FileDown, Plus, Pencil } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
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
  supplier_name: string | null
  forwarder_name: string | null
  shipping_method: string
  created_date: string | null
  etd_date: string | null
  eta_date: string | null
  expected_inbound_start_date: string | null
  expected_inbound_end_date: string | null
  shipment_status: string
  stat_date: string | null
  forwarder_update: string | null
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

type ShipmentScheduleDetail = ShipmentScheduleListItem & {
  booking_note: string | null
  items: ShipmentScheduleItemRow[]
}

type ShipmentScheduleListResponse = {
  items: ShipmentScheduleListItem[]
  page: number
  page_size: number
  total: number | null
  has_next: boolean
}

type ScheduleFormState = {
  project_id: string
  shipment_no: string
  tracking_no: string
  warehouse_code: string
  supplier_name: string
  forwarder_name: string
  shipping_method: string
  created_date: string
  etd_date: string
  eta_date: string
  expected_inbound_start_date: string
  expected_inbound_end_date: string
  booking_note: string
  forwarder_update: string
  remark: string
  shipment_status: string
  stat_date: string
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
  supplier_name: '',
  forwarder_name: '',
  shipping_method: 'sea',
  created_date: '',
  etd_date: '',
  eta_date: '',
  expected_inbound_start_date: '',
  expected_inbound_end_date: '',
  booking_note: '',
  forwarder_update: '',
  remark: '',
  shipment_status: 'draft',
  stat_date: '',
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

function formatDateRange(start: string | null | undefined, end: string | null | undefined): string {
  if (!start && !end) return '-'
  if (start && end) return `${start} ~ ${end}`
  return start || end || '-'
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

function statusMeta(status: string): { label: string; className: string } {
  const map: Record<string, { label: string; className: string }> = {
    draft: { label: '草稿', className: 'bg-slate-100 text-slate-700' },
    preparing: { label: '备货中', className: 'bg-amber-100 text-amber-700' },
    in_transit: { label: '在途', className: 'bg-sky-100 text-sky-700' },
    arrived_port: { label: '已到港', className: 'bg-cyan-100 text-cyan-700' },
    inbound_processing: { label: '入仓处理中', className: 'bg-violet-100 text-violet-700' },
    completed: { label: '完成', className: 'bg-emerald-100 text-emerald-700' },
    cancelled: { label: '已取消', className: 'bg-rose-100 text-rose-700' },
  }
  return map[status] || { label: status, className: 'bg-slate-100 text-slate-700' }
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
    supplier_name: detail.supplier_name || '',
    forwarder_name: detail.forwarder_name || '',
    shipping_method: detail.shipping_method,
    created_date: detail.created_date || '',
    etd_date: detail.etd_date || '',
    eta_date: detail.eta_date || '',
    expected_inbound_start_date: detail.expected_inbound_start_date || '',
    expected_inbound_end_date: detail.expected_inbound_end_date || '',
    booking_note: detail.booking_note || '',
    forwarder_update: detail.forwarder_update || '',
    remark: detail.remark || '',
    shipment_status: detail.shipment_status,
    stat_date: detail.stat_date || '',
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

  const [importing, setImporting] = useState(false)
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
        supplier_name: form.supplier_name || null,
        forwarder_name: form.forwarder_name || null,
        created_date: form.created_date || null,
        etd_date: form.etd_date || null,
        eta_date: form.eta_date || null,
        expected_inbound_start_date: form.expected_inbound_start_date || null,
        expected_inbound_end_date: form.expected_inbound_end_date || null,
        booking_note: form.booking_note || null,
        forwarder_update: form.forwarder_update || null,
        remark: form.remark || null,
        stat_date: form.stat_date || null,
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
              supplier_name: payload.supplier_name,
              forwarder_name: payload.forwarder_name,
              shipping_method: payload.shipping_method,
              created_date: payload.created_date,
              etd_date: payload.etd_date,
              eta_date: payload.eta_date,
              expected_inbound_start_date: payload.expected_inbound_start_date,
              expected_inbound_end_date: payload.expected_inbound_end_date,
              booking_note: payload.booking_note,
              forwarder_update: payload.forwarder_update,
              remark: payload.remark,
              shipment_status: payload.shipment_status,
              stat_date: payload.stat_date,
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
    const escapeCsvCell = (value: string | number | null | undefined) => {
      const text = String(value ?? '')
      if (/[",\n\r]/.test(text)) {
        return `"${text.replaceAll('"', '""')}"`
      }
      return text
    }

    const header = ['project_name', 'shipment_no', 'date', 'SKU', 'quantity', 'remark']
    const row = [detail.project_name, detail.shipment_no, detail.created_date || '', 'SKU-DEMO', 100, '']
    const csv = `\uFEFF${header.map(escapeCsvCell).join(',')}\n${row.map(escapeCsvCell).join(',')}\n`
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${detail.shipment_no}-items-template.csv`
    link.click()
    URL.revokeObjectURL(url)
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

  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="space-y-6 p-4 md:p-6">
      <section className="relative overflow-hidden rounded-3xl border border-sky-100 bg-[linear-gradient(135deg,rgba(240,249,255,0.96),rgba(255,255,255,0.92)),radial-gradient(circle_at_top_right,rgba(14,165,233,0.18),transparent_32%),radial-gradient(circle_at_bottom_left,rgba(16,185,129,0.16),transparent_28%)] p-6 shadow-sm">
        <div className="absolute inset-y-0 right-6 hidden w-56 rounded-full bg-sky-200/20 blur-3xl lg:block" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl space-y-3">
            <Badge className="rounded-full bg-white/85 px-3 py-1 text-sky-700 shadow-sm">数据分析 / 发货信息管理</Badge>
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-tight text-slate-900">船期主信息与发货明细统一维护</h1>
              <p className="max-w-2xl text-sm leading-6 text-slate-600">
                左侧管理船期批次，右侧查看当前批次的 SKU 与数量明细。明细按 CSV 覆盖导入，避免多次维护造成重复和统计偏差。
              </p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="border-white/70 bg-white/80 shadow-sm">
              <CardContent className="flex items-center gap-3 p-4">
                <Route className="h-5 w-5 text-sky-600" />
                <div>
                  <div className="text-xs text-slate-500">当前页批次</div>
                  <div className="text-xl font-semibold text-slate-900">{items.length}</div>
                </div>
              </CardContent>
            </Card>
            <Card className="border-white/70 bg-white/80 shadow-sm">
              <CardContent className="flex items-center gap-3 p-4">
                <Package2 className="h-5 w-5 text-emerald-600" />
                <div>
                  <div className="text-xs text-slate-500">SKU 种类</div>
                  <div className="text-xl font-semibold text-slate-900">{summary.totalSku}</div>
                </div>
              </CardContent>
            </Card>
            <Card className="border-white/70 bg-white/80 shadow-sm">
              <CardContent className="flex items-center gap-3 p-4">
                <ShipWheel className="h-5 w-5 text-amber-600" />
                <div>
                  <div className="text-xs text-slate-500">总数量</div>
                  <div className="text-xl font-semibold text-slate-900">{summary.totalQuantity.toLocaleString()}</div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle>筛选条件</CardTitle>
          <CardDescription>按项目、状态、运输方式和货件编号筛选船期批次。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
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

          <Input value={shipmentNoFilter} onChange={(event) => setShipmentNoFilter(event.target.value)} placeholder="货件编号搜索" />

          <div className="flex gap-2 xl:col-span-4">
            <Button onClick={() => void loadList(1)} className="gap-2">
              <RefreshCcw className="h-4 w-4" />
              刷新
            </Button>
            <Button variant="outline" onClick={openCreateDialog} className="gap-2">
              <Plus className="h-4 w-4" />
              新建船期
            </Button>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      ) : null}
      {successMessage ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{successMessage}</div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.95fr]">
        <Card className="overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <div>
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
          </CardHeader>
          <CardContent className="space-y-3">
            {loading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Skeleton key={index} className="h-24 w-full rounded-2xl" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-12 text-center text-sm text-slate-500">
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
                    className={`w-full rounded-2xl border p-4 text-left transition ${
                      selected
                        ? 'border-sky-300 bg-sky-50/80 shadow-sm'
                        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/80'
                    }`}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <div className="text-base font-semibold text-slate-900">{item.shipment_no}</div>
                          <Badge className={status.className}>{status.label}</Badge>
                          <Badge variant="outline">{methodLabel(item.shipping_method)}</Badge>
                        </div>
                        <div className="text-sm text-slate-600">
                          {item.project_name}
                          {item.forwarder_name ? ` · ${item.forwarder_name}` : ''}
                          {item.warehouse_code ? ` · 仓库 ${item.warehouse_code}` : ''}
                        </div>
                        <div className="flex flex-wrap gap-4 text-xs text-slate-500">
                          <span>ETD: {formatDate(item.etd_date)}</span>
                          <span>ETA: {formatDate(item.eta_date)}</span>
                          <span>入仓: {formatDateRange(item.expected_inbound_start_date, item.expected_inbound_end_date)}</span>
                        </div>
                      </div>
                      <div className="grid shrink-0 grid-cols-2 gap-3 rounded-2xl bg-white/70 p-3 text-center sm:min-w-44">
                        <div>
                          <div className="text-xs text-slate-500">SKU</div>
                          <div className="text-lg font-semibold text-slate-900">{item.sku_count}</div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-500">数量</div>
                          <div className="text-lg font-semibold text-slate-900">{item.total_quantity.toLocaleString()}</div>
                        </div>
                      </div>
                    </div>
                  </button>
                )
              })
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>批次详情</CardTitle>
              <CardDescription>查看当前船期的过程信息，并维护 SKU 明细。</CardDescription>
            </div>
            <Button variant="outline" onClick={openEditDialog} disabled={!detail}>
              <Pencil className="mr-2 h-4 w-4" />
              编辑主信息
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {detailLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-10 w-1/2" />
                <Skeleton className="h-40 w-full" />
                <Skeleton className="h-56 w-full" />
              </div>
            ) : detailError ? (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{detailError}</div>
            ) : !detail ? (
              <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-12 text-center text-sm text-slate-500">
                选择一个船期批次后查看详情。
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl bg-slate-50 p-4">
                    <div className="text-xs text-slate-500">项目 / 货件编号</div>
                    <div className="mt-2 text-lg font-semibold text-slate-900">{detail.project_name}</div>
                    <div className="mt-1 text-sm text-slate-600">{detail.shipment_no}</div>
                  </div>
                  <div className="rounded-2xl bg-slate-50 p-4">
                    <div className="text-xs text-slate-500">更新时间</div>
                    <div className="mt-2 text-sm font-medium text-slate-900">{formatTime(detail.updated_at)}</div>
                    <div className="mt-1 text-sm text-slate-600">
                      {statusMeta(detail.shipment_status).label} · {methodLabel(detail.shipping_method)}
                    </div>
                  </div>
                </div>

                <div className="grid gap-4 rounded-2xl border border-slate-200 p-4 sm:grid-cols-2">
                  <div className="space-y-2 text-sm">
                    <div className="text-slate-500">追踪号</div>
                    <div className="font-medium text-slate-900">{detail.tracking_no || '-'}</div>
                  </div>
                  <div className="space-y-2 text-sm">
                    <div className="text-slate-500">货代 / 供应商</div>
                    <div className="font-medium text-slate-900">
                      {detail.forwarder_name || '-'}
                      {detail.supplier_name ? ` / ${detail.supplier_name}` : ''}
                    </div>
                  </div>
                  <div className="space-y-2 text-sm">
                    <div className="text-slate-500">ETD / ETA</div>
                    <div className="font-medium text-slate-900">
                      {formatDate(detail.etd_date)} / {formatDate(detail.eta_date)}
                    </div>
                  </div>
                  <div className="space-y-2 text-sm">
                    <div className="text-slate-500">预计入仓</div>
                    <div className="font-medium text-slate-900">
                      {formatDateRange(detail.expected_inbound_start_date, detail.expected_inbound_end_date)}
                    </div>
                  </div>
                  <div className="space-y-2 text-sm sm:col-span-2">
                    <div className="text-slate-500">货代更新</div>
                    <div className="rounded-xl bg-slate-50 px-3 py-2 text-slate-700">{detail.forwarder_update || '-'}</div>
                  </div>
                  <div className="space-y-2 text-sm sm:col-span-2">
                    <div className="text-slate-500">备注</div>
                    <div className="rounded-xl bg-slate-50 px-3 py-2 text-slate-700">{detail.remark || detail.booking_note || '-'}</div>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200">
                  <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">SKU 明细</div>
                      <div className="text-xs text-slate-500">
                        {detail.sku_count} 个 SKU，合计 {detail.total_quantity.toLocaleString()} 件
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={downloadTemplate} className="gap-2">
                        <FileDown className="h-4 w-4" />
                        下载模板
                      </Button>
                      <Button asChild disabled={importing} className="gap-2">
                        <label>
                          <Upload className="h-4 w-4" />
                          {importing ? '导入中...' : '上传 CSV'}
                          <input type="file" accept=".csv" className="hidden" onChange={handleImportFile} />
                        </label>
                      </Button>
                    </div>
                  </div>
                  <div className="max-h-[420px] overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>日期</TableHead>
                          <TableHead>SKU</TableHead>
                          <TableHead className="text-right">数量</TableHead>
                          <TableHead>备注</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.items.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={4} className="py-10 text-center text-sm text-slate-500">
                              还没有 SKU 明细，先下载模板后上传 CSV。
                            </TableCell>
                          </TableRow>
                        ) : (
                          detail.items.map((item) => (
                            <TableRow key={item.id}>
                              <TableCell>{formatDate(item.item_date)}</TableCell>
                              <TableCell className="font-medium text-slate-900">{item.sku}</TableCell>
                              <TableCell className="text-right">{item.quantity.toLocaleString()}</TableCell>
                              <TableCell>{item.remark || '-'}</TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{dialogMode === 'create' ? '新建船期批次' : '编辑船期批次'}</DialogTitle>
            <DialogDescription>主表维护过程信息，SKU 与数量明细请在详情区通过 CSV 导入。</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2 md:grid-cols-2">
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700">项目</div>
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
              <div className="text-sm font-medium text-slate-700">货件编号</div>
              <Input
                value={form.shipment_no}
                onChange={(event) => handleFormChange('shipment_no', event.target.value)}
                disabled={dialogMode === 'edit'}
                placeholder="如 FBA19647N7ZW"
              />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700">运输方式</div>
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
              <div className="text-sm font-medium text-slate-700">状态</div>
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
              <div className="text-sm font-medium text-slate-700">追踪号</div>
              <Input value={form.tracking_no} onChange={(event) => handleFormChange('tracking_no', event.target.value)} />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700">仓库编码</div>
              <Input value={form.warehouse_code} onChange={(event) => handleFormChange('warehouse_code', event.target.value)} />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700">供应商</div>
              <Input value={form.supplier_name} onChange={(event) => handleFormChange('supplier_name', event.target.value)} />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700">货代公司</div>
              <Input value={form.forwarder_name} onChange={(event) => handleFormChange('forwarder_name', event.target.value)} />
            </div>

            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700">创建日期</div>
              <Input type="date" value={form.created_date} onChange={(event) => handleFormChange('created_date', event.target.value)} />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700">统计日期</div>
              <Input type="date" value={form.stat_date} onChange={(event) => handleFormChange('stat_date', event.target.value)} />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700">ETD</div>
              <Input type="date" value={form.etd_date} onChange={(event) => handleFormChange('etd_date', event.target.value)} />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700">ETA</div>
              <Input type="date" value={form.eta_date} onChange={(event) => handleFormChange('eta_date', event.target.value)} />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700">预计入仓开始</div>
              <Input
                type="date"
                value={form.expected_inbound_start_date}
                onChange={(event) => handleFormChange('expected_inbound_start_date', event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700">预计入仓结束</div>
              <Input
                type="date"
                value={form.expected_inbound_end_date}
                onChange={(event) => handleFormChange('expected_inbound_end_date', event.target.value)}
              />
            </div>

            <div className="space-y-2 md:col-span-2">
              <div className="text-sm font-medium text-slate-700">货代更新</div>
              <textarea
                value={form.forwarder_update}
                onChange={(event) => handleFormChange('forwarder_update', event.target.value)}
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            <div className="space-y-2 md:col-span-2">
              <div className="text-sm font-medium text-slate-700">约仓 / 货信说明</div>
              <textarea
                value={form.booking_note}
                onChange={(event) => handleFormChange('booking_note', event.target.value)}
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            <div className="space-y-2 md:col-span-2">
              <div className="text-sm font-medium text-slate-700">备注 / 约仓信息</div>
              <textarea
                value={form.remark}
                onChange={(event) => handleFormChange('remark', event.target.value)}
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>

          <Separator />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void submitForm()} disabled={submitting}>
              {submitting ? '保存中...' : dialogMode === 'create' ? '创建' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
