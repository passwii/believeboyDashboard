'use client'

import { type ChangeEvent, useEffect, useMemo, useState } from 'react'

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
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { fetchProjectOptionsCached } from '@/lib/project-client-cache'
import { FileDown, Upload } from 'lucide-react'

type ProductCostItem = {
  id: number
  project_name: string
  sku: string
  asin: string
  first_leg_unit_cost: number
  fob_unit_cost: number
  currency: string
  country: string
  sort_order: number
  is_active: boolean
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

const API_BASE = '/api/backend'
const PAGE_SIZE_OPTIONS = [20, 50, 100]
const DEFAULT_PAGE_SIZE = 20
const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
] as const

function normalizeCountry(raw: string): 'US' | 'DE' | 'UK' | null {
  const normalized = raw.trim().toUpperCase()
  if (!normalized) return null
  if (normalized === 'US' || normalized === 'USA' || normalized === '美国' || normalized === '美国站') return 'US'
  if (normalized === 'DE' || normalized === 'GERMANY' || normalized === '德国' || normalized === '德国站') return 'DE'
  if (normalized === 'UK' || normalized === 'GB' || normalized === 'UNITED KINGDOM' || normalized === '英国' || normalized === '英国站') {
    return 'UK'
  }
  return null
}

function authHeaders(): Record<string, string> {
  return {}
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

function downloadTemplate() {
  downloadCsvFile(
    'sku-cost-template.csv',
    ['project_name', 'SKU', 'ASIN', '头程单价(RMB)', 'FOB单价(RMB)', '国家'],
    [
      ['创酷', 'JDB-M35-13PCS', 'B0G1SM4P52', '0.32', '2.57', 'US'],
      ['创酷', 'JDB-M50-20PCS', 'B0G1SM4P53', '0.45', '3.20', 'US'],
    ]
  )
}

function sortProductCosts(rows: ProductCostItem[]): ProductCostItem[] {
  return [...rows].sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
    return a.id - b.id
  })
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

export default function SkuCostPage() {
  const [items, setItems] = useState<ProductCostItem[]>([])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [total, setTotal] = useState(0)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)

  const [projectFilter, setProjectFilter] = useState('')
  const [skuFilter, setSkuFilter] = useState('')
  const [asinFilter, setAsinFilter] = useState('')
  const [countryFilter, setCountryFilter] = useState<'all' | 'US' | 'DE' | 'UK'>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all')

  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [addText, setAddText] = useState('')
  const [addSubmitting, setAddSubmitting] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editSubmitting, setEditSubmitting] = useState(false)
  const [editSku, setEditSku] = useState('')
  const [editAsin, setEditAsin] = useState('')
  const [editFirstLegCost, setEditFirstLegCost] = useState('')
  const [editFobCost, setEditFobCost] = useState('')
  const [editCountry, setEditCountry] = useState<'US' | 'DE' | 'UK'>('US')
  const [editSortOrder, setEditSortOrder] = useState('')
  const [editIsActive, setEditIsActive] = useState(true)
  const [moveSubmittingId, setMoveSubmittingId] = useState<number | null>(null)

  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [batchImporting, setBatchImporting] = useState(false)

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [total, pageSize])

  const loadData = async (
    filters?: {
      project_name?: string
      sku?: string
      asin?: string
      country?: 'all' | 'US' | 'DE' | 'UK'
      status?: 'all' | 'active' | 'inactive'
    },
    options?: { resetPage?: boolean; pageOverride?: number; clearOnMissingProject?: boolean }
  ) => {
    const projectValue = (filters?.project_name ?? projectFilter).trim()
    const skuValue = (filters?.sku ?? skuFilter).trim()
    const asinValue = (filters?.asin ?? asinFilter).trim()
    const countryValue = filters?.country ?? countryFilter
    const statusValue = filters?.status ?? statusFilter
    const nextPage = options?.resetPage ? 1 : (options?.pageOverride ?? page)

    if (!projectValue) {
      if (options?.clearOnMissingProject) {
        setItems([])
        setTotal(0)
        setHasNextPage(false)
      }
      setError('请先在筛选区域选择项目名')
      return
    }

    setLoading(true)
    setError(null)

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

      const response = await fetch(`${API_BASE}/api/v1/product-costs?${search.toString()}`, {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }

      const payload = (await response.json()) as ProductCostsPage
      setItems(sortProductCosts(payload.items))
      setTotal(Math.max(0, payload.total ?? 0))
      setHasNextPage(payload.has_next)
      setPage(nextPage)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      setProjectLoadError(null)
      try {
        const data = await fetchProjectOptionsCached<ProjectOption[]>()
        setProjects(data)
      } catch (loadError) {
        setProjectLoadError(loadError instanceof Error ? loadError.message : '项目列表加载失败')
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [])

  const onRefresh = async () => {
    setSuccessMessage(null)
    await loadData(undefined, { pageOverride: page, clearOnMissingProject: true })
  }

  const onSearch = async () => {
    setSuccessMessage(null)
    await loadData(undefined, { resetPage: true, clearOnMissingProject: true })
  }

  const onResetFilters = async () => {
    setProjectFilter('')
    setSkuFilter('')
    setAsinFilter('')
    setCountryFilter('all')
    setStatusFilter('all')
    setItems([])
    setTotal(0)
    setHasNextPage(false)
    setPage(1)
    setError(null)
    setSuccessMessage(null)
  }

  const onProjectFilterChange = async (value: string) => {
    setProjectFilter(value)
    setError(null)
    setSuccessMessage(null)
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

  const onSubmitSingle = async () => {
    const normalized = addText.replaceAll('，', ',')
    const lines = normalized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    if (lines.length === 0) {
      setError('请先粘贴数据（每行至少 5 列：project_name, SKU, ASIN, 头程单价(RMB), FOB单价(RMB)）')
      return
    }

    const parsedItems: Array<{
      project_name: string
      sku: string
      asin: string
      first_leg_unit_cost: number
      fob_unit_cost: number
      country: 'US' | 'DE' | 'UK'
    }> = []
    const parseErrors: string[] = []

    lines.forEach((line, index) => {
      const cols = line.split(',').map((col) => col.trim())
      if (cols.length < 5) {
        parseErrors.push(`第 ${index + 1} 行列数不足（至少需要 5 列）`)
        return
      }

      const [project_name, sku, asin, firstLegRaw, fobRaw, extra1, extra2] = cols
      if (!project_name || !sku || !asin) {
        parseErrors.push(`第 ${index + 1} 行 project_name/SKU/ASIN 不能为空`)
        return
      }

      const firstLeg = Number(firstLegRaw)
      const fob = Number(fobRaw)
      if (Number.isNaN(firstLeg) || Number.isNaN(fob)) {
        parseErrors.push(`第 ${index + 1} 行成本字段不是数字`)
        return
      }

      let country: 'US' | 'DE' | 'UK' = 'US'
      if (cols.length === 6) {
        const maybeCountry = normalizeCountry(extra1 || '')
        if (maybeCountry) {
          country = maybeCountry
        } else {
          parseErrors.push(`第 ${index + 1} 行第 6 列仅支持国家：US/DE/UK（或 美国站/德国站/英国站）`)
          return
        }
      } else if (cols.length >= 7) {
        const parsedCountry = normalizeCountry(extra2 || '')
        if (!parsedCountry) {
          parseErrors.push(`第 ${index + 1} 行国家仅支持 US/DE/UK（或 美国站/德国站/英国站）`)
          return
        }
        country = parsedCountry
      }

      parsedItems.push({
        project_name,
        sku,
        asin,
        first_leg_unit_cost: firstLeg,
        fob_unit_cost: fob,
        country,
      })
    })

    if (parseErrors.length > 0) {
      setError(`解析失败：${parseErrors.slice(0, 3).join('；')}${parseErrors.length > 3 ? '…' : ''}`)
      return
    }

    setAddSubmitting(true)
    setError(null)
    setSuccessMessage(null)
    try {
      const response = await fetch(`${API_BASE}/api/v1/product-costs/bulk`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          items: parsedItems,
          source_file: 'manual_paste_text',
        }),
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      const payload = (await response.json()) as { inserted: number; updated: number; total: number }
      setSuccessMessage(`写入完成：新增 ${payload.inserted} 条，更新 ${payload.updated} 条`)
      setAddText('')
      setAddDialogOpen(false)
      if (projectFilter.trim()) {
        await loadData(undefined, { resetPage: true, clearOnMissingProject: true })
      } else {
        setItems([])
        setTotal(0)
        setPage(1)
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '提交失败')
    } finally {
      setAddSubmitting(false)
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
      const response = await fetch(`${API_BASE}/api/v1/product-costs/import-csv`, {
        method: 'POST',
        headers: authHeaders(),
        body: formData,
      })
      if (!response.ok) throw new Error(await parseError(response))

      const payload = (await response.json()) as { inserted: number; updated: number; total: number }
      setSuccessMessage(`CSV 批量导入完成：新增 ${payload.inserted} 条，更新 ${payload.updated} 条`)
      if (projectFilter.trim()) {
        await loadData(undefined, { resetPage: true, clearOnMissingProject: true })
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'CSV 批量导入失败')
    } finally {
      setBatchImporting(false)
    }
  }

  const onPageSizeChange = (value: string) => {
    const nextPageSize = Number(value)
    if (!PAGE_SIZE_OPTIONS.includes(nextPageSize)) {
      return
    }
    setPageSize(nextPageSize)
    setPage(1)
  }

  const startEditRow = (row: ProductCostItem) => {
    setEditingId(row.id)
    setEditSku(row.sku)
    setEditAsin(row.asin)
    setEditFirstLegCost(String(row.first_leg_unit_cost))
    setEditFobCost(String(row.fob_unit_cost))
    setEditCountry((normalizeCountry(row.country || 'US') ?? 'US') as 'US' | 'DE' | 'UK')
    setEditSortOrder(String(row.sort_order))
    setEditIsActive(Boolean(row.is_active))
    setError(null)
    setSuccessMessage(null)
  }

  const cancelEditRow = () => {
    setEditingId(null)
    setEditSubmitting(false)
  }

  const onSaveEditRow = async (rowId: number) => {
    const sku = editSku.trim()
    const asin = editAsin.trim()
    const country = editCountry
    const isActive = Boolean(editIsActive)
    const firstLeg = Number(editFirstLegCost)
    const fob = Number(editFobCost)
    const sortOrder = Number(editSortOrder)

    if (!sku || !asin) {
      setError('SKU 和 ASIN 不能为空')
      return
    }
    if (Number.isNaN(firstLeg) || Number.isNaN(fob) || firstLeg < 0 || fob < 0) {
      setError('头程单价和 FOB 单价必须为大于等于 0 的数字')
      return
    }
    if (!Number.isInteger(sortOrder) || sortOrder < 1) {
      setError('SKU序号必须是大于等于 1 的整数')
      return
    }

    setEditSubmitting(true)
    setError(null)
    setSuccessMessage(null)
    try {
      const response = await fetch(`${API_BASE}/api/v1/product-costs/${rowId}`, {
        method: 'PATCH',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sku,
          asin,
          first_leg_unit_cost: firstLeg,
          fob_unit_cost: fob,
          country,
          sort_order: sortOrder,
          is_active: isActive,
          source_file: 'manual_inline_edit',
        }),
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      const updated = (await response.json()) as ProductCostItem
      setItems((currentItems) => sortProductCosts(currentItems.map((item) => (item.id === updated.id ? updated : item))))
      setEditingId(null)
      setSuccessMessage('该行已更新')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存失败')
    } finally {
      setEditSubmitting(false)
    }
  }

  const onMoveRow = async (rowId: number, direction: 'up' | 'down') => {
    setMoveSubmittingId(rowId)
    setError(null)
    setSuccessMessage(null)
    try {
      const response = await fetch(`${API_BASE}/api/v1/product-costs/${rowId}/move`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ direction }),
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      await loadData(undefined, { pageOverride: page, clearOnMissingProject: true })
      setSuccessMessage(direction === 'up' ? '该行已上移' : '该行已下移')
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : '调整排序失败')
    } finally {
      setMoveSubmittingId(null)
    }
  }

  useEffect(() => {
    if (!projectFilter.trim()) return
    const run = async () => {
      await loadData(undefined, { pageOverride: page, clearOnMissingProject: true })
    }
    void run()
    // Page and page size changes should re-fetch the current query.
    // Other filter changes are handled by explicit search actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, projectFilter])

  return (
    <div className="w-full space-y-6">
      <Card className="overflow-hidden border-border/80 shadow-[0_20px_40px_-22px_rgba(15,23,42,0.22)]">
        <CardContent className="space-y-6 p-6 md:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <Badge
                variant="outline"
                className="w-fit rounded-md border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              >
                数据管理
              </Badge>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={() => void onRefresh()} disabled={loading}>
                {loading ? '刷新中...' : '刷新数据'}
              </Button>

              <Button type="button" variant="outline" onClick={downloadTemplate}>
                <FileDown className="mr-2 h-4 w-4" />
                模板下载
              </Button>

              <Button asChild variant="outline" disabled={batchImporting}>
                <label>
                  <Upload className="mr-2 h-4 w-4" />
                  {batchImporting ? '导入中...' : '批量上传'}
                  <input type="file" accept=".csv" className="hidden" onChange={handleBatchImportFile} />
                </label>
              </Button>

              <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
                <DialogTrigger asChild>
                  <Button type="button" variant="outline">
                    粘贴添加
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>粘贴文本导入 SKU 成本</DialogTitle>
                    <DialogDescription>
                      每行格式：project_name,SKU,ASIN,头程单价(RMB),FOB单价(RMB)[,国家]。国家可填 US/DE/UK（或美国站/德国站/英国站）；系统统一按人民币存储，其他分析页面会结合汇率页自动换算。
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-2">
                    <label className="text-sm font-medium text-foreground" htmlFor="sku-paste-input">
                      导入文本
                    </label>
                    <textarea
                      id="sku-paste-input"
                      className="min-h-56 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      placeholder="创酷,JDB-M35-13PCS,B0G1SM4P52,2.30,18.50,US"
                      value={addText}
                      onChange={(e) => setAddText(e.target.value)}
                      disabled={addSubmitting}
                    />
                    <p className="text-xs text-muted-foreground">支持英文逗号或中文逗号，支持一次粘贴多行。</p>
                  </div>
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setAddDialogOpen(false)} disabled={addSubmitting}>
                      取消
                    </Button>
                    <Button type="button" onClick={() => void onSubmitSingle()} disabled={addSubmitting}>
                      {addSubmitting ? '写入中...' : '解析并写入'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>

          <Separator />

          <div className="space-y-3">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-foreground">筛选条件</h2>
              <p className="text-sm text-muted-foreground">按项目名、SKU、ASIN、国家站点查询。SKU 成本统一维护为人民币。</p>
            </div>
            <div className="grid gap-4 md:grid-cols-7">
              <div className="grid gap-2">
                <label className="text-sm font-medium text-foreground" htmlFor="filter-project">
                  项目名
                </label>
                <Select
                  value={projectFilter}
                  onValueChange={(value) => void onProjectFilterChange(value)}
                  disabled={projectsLoading || projects.length === 0}
                >
                  <SelectTrigger id="filter-project">
                    <SelectValue placeholder={projectsLoading ? '项目加载中...' : projects.length ? '请选择项目名' : '暂无可选项目'} />
                  </SelectTrigger>
                  <SelectContent className="max-h-64 overflow-y-auto">
                    {projects.map((project) => (
                      <SelectItem key={project.name} value={project.name}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!projectsLoading && projects.length === 0 ? (
                  <p className="text-xs text-muted-foreground">暂无项目，请先到“项目信息”页面新增。</p>
                ) : null}
                {projectLoadError ? <p className="text-xs text-destructive">{projectLoadError}</p> : null}
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium text-foreground" htmlFor="filter-sku">
                  SKU
                </label>
                <Input id="filter-sku" placeholder="输入 SKU" value={skuFilter} onChange={(e) => setSkuFilter(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium text-foreground" htmlFor="filter-asin">
                  ASIN
                </label>
                <Input id="filter-asin" placeholder="输入 ASIN" value={asinFilter} onChange={(e) => setAsinFilter(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium text-foreground">国家站点</label>
                <Select value={countryFilter} onValueChange={(value) => setCountryFilter(value as 'all' | 'US' | 'DE' | 'UK')}>
                  <SelectTrigger>
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
                <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as 'all' | 'active' | 'inactive')}>
                  <SelectTrigger>
                    <SelectValue placeholder="全部状态" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部</SelectItem>
                    <SelectItem value="active">活跃</SelectItem>
                    <SelectItem value="inactive">不活跃</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium text-foreground">每页显示</label>
                <Select value={String(pageSize)} onValueChange={onPageSizeChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择条数" />
                  </SelectTrigger>
                  <SelectContent>
                    {PAGE_SIZE_OPTIONS.map((option) => (
                      <SelectItem key={option} value={String(option)}>
                        {option} 条
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-2">
                <Button type="button" variant="outline" onClick={() => void onResetFilters()} className="w-full">
                  重置
                </Button>
                <Button type="button" onClick={() => void onSearch()} className="w-full">
                  查询
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      ) : null}
      {successMessage ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
          {successMessage}
        </div>
      ) : null}

      <Card className="overflow-hidden border-border/80">
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-base font-semibold text-foreground">SKU 成本数据</CardTitle>
              <CardDescription>{projectFilter ? `共 ${total} 条记录` : '请选择项目名后查看数据'}</CardDescription>
            </div>
            <Badge variant="outline" className="rounded-md border-border bg-muted text-muted-foreground">
              第 {page} / {totalPages} 页
            </Badge>
          </div>
          <Separator />
        </CardHeader>

        <CardContent className="space-y-4 pt-0">
          <div className="max-h-[560px] overflow-auto rounded-md border border-border/60">
            <table className="w-full caption-bottom text-sm">
              <thead className="[&_tr]:border-b">
                <tr className="border-b bg-background">
                  <th className="sticky top-0 z-10 h-12 bg-background px-4 text-left align-middle font-medium text-muted-foreground">SKU序号</th>
                  <th className="sticky top-0 z-10 h-12 bg-background px-4 text-left align-middle font-medium text-muted-foreground">项目名</th>
                  <th className="sticky top-0 z-10 h-12 bg-background px-4 text-left align-middle font-medium text-muted-foreground">SKU</th>
                  <th className="sticky top-0 z-10 h-12 bg-background px-4 text-left align-middle font-medium text-muted-foreground">ASIN</th>
                  <th className="sticky top-0 z-10 h-12 bg-background px-4 text-right align-middle font-medium text-muted-foreground">头程单价 (RMB)</th>
                  <th className="sticky top-0 z-10 h-12 bg-background px-4 text-right align-middle font-medium text-muted-foreground">FOB单价 (RMB)</th>
                  <th className="sticky top-0 z-10 h-12 bg-background px-4 text-left align-middle font-medium text-muted-foreground">国家站点</th>
                  <th className="sticky top-0 z-10 h-12 bg-background px-4 text-left align-middle font-medium text-muted-foreground">成本币种</th>
                  <th className="sticky top-0 z-10 h-12 bg-background px-4 text-left align-middle font-medium text-muted-foreground">状态</th>
                  <th className="sticky top-0 z-10 h-12 bg-background px-4 text-left align-middle font-medium text-muted-foreground">操作</th>
                </tr>
              </thead>
              <tbody className="[&_tr:last-child]:border-0">
                {loading && items.length === 0
                  ? Array.from({ length: 6 }).map((_, index) => (
                      <tr key={`loading-${index}`} className="border-b transition-colors hover:bg-muted/50">
                        <td className="p-4 align-middle">
                          <Skeleton className="h-4 w-12" />
                        </td>
                        <td className="p-4 align-middle">
                          <Skeleton className="h-4 w-12" />
                        </td>
                        <td className="p-4 align-middle">
                          <Skeleton className="h-4 w-24" />
                        </td>
                        <td className="p-4 align-middle">
                          <Skeleton className="h-4 w-28" />
                        </td>
                        <td className="p-4 align-middle">
                          <Skeleton className="h-4 w-24" />
                        </td>
                        <td className="p-4 align-middle">
                          <Skeleton className="ml-auto h-4 w-16" />
                        </td>
                        <td className="p-4 align-middle">
                          <Skeleton className="ml-auto h-4 w-16" />
                        </td>
                        <td className="p-4 align-middle">
                          <Skeleton className="h-4 w-16" />
                        </td>
                        <td className="p-4 align-middle">
                          <Skeleton className="h-4 w-12" />
                        </td>
                        <td className="p-4 align-middle">
                          <Skeleton className="h-4 w-24" />
                        </td>
                      </tr>
                    ))
                  : null}

                {items.map((row) => (
                  <tr key={row.id} className={`border-b transition-colors hover:bg-muted/50 ${editingId === row.id ? 'bg-muted/30' : ''}`}>
                    <td className="p-4 align-middle">
                      {editingId === row.id ? (
                        <Input
                          type="number"
                          min="1"
                          step="1"
                          value={editSortOrder}
                          onChange={(e) => setEditSortOrder(e.target.value)}
                          className="h-8 w-16"
                        />
                      ) : (
                        row.sort_order
                      )}
                    </td>
                    <td className="p-4 align-middle font-medium text-foreground">{row.project_name}</td>
                    <td className="p-4 align-middle">
                      {editingId === row.id ? (
                        <Input value={editSku} onChange={(e) => setEditSku(e.target.value)} className="h-8 w-24" />
                      ) : (
                        row.sku
                      )}
                    </td>
                    <td className="p-4 align-middle">
                      {editingId === row.id ? (
                        <Input value={editAsin} onChange={(e) => setEditAsin(e.target.value)} className="h-8 w-28" />
                      ) : (
                        row.asin
                      )}
                    </td>
                    <td className="p-4 text-right align-middle tabular-nums">
                      {editingId === row.id ? (
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={editFirstLegCost}
                          onChange={(e) => setEditFirstLegCost(e.target.value)}
                          className="h-8 w-20"
                        />
                      ) : (
                        row.first_leg_unit_cost.toFixed(2)
                      )}
                    </td>
                    <td className="p-4 text-right align-middle tabular-nums">
                      {editingId === row.id ? (
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={editFobCost}
                          onChange={(e) => setEditFobCost(e.target.value)}
                          className="h-8 w-20"
                        />
                      ) : (
                        row.fob_unit_cost.toFixed(2)
                      )}
                    </td>
                    <td className="p-4 align-middle">
                      {editingId === row.id ? (
                        <Select value={editCountry} onValueChange={(value) => setEditCountry(value as 'US' | 'DE' | 'UK')}>
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
                        COUNTRY_OPTIONS.find((option) => option.value === row.country)?.label || row.country
                      )}
                    </td>
                    <td className="p-4 align-middle">
                      人民币 (CNY)
                    </td>
                    <td className="p-4 align-middle">
                      {editingId === row.id ? (
                        <Select value={editIsActive ? 'active' : 'inactive'} onValueChange={(value) => setEditIsActive(value === 'active')}>
                          <SelectTrigger className="h-8 w-20">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="active">活跃</SelectItem>
                            <SelectItem value="inactive">不活跃</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : row.is_active ? (
                        <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                          活跃
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300">
                          不活跃
                        </Badge>
                      )}
                    </td>
                    <td className="p-4 align-middle">
                      {editingId === row.id ? (
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => void onSaveEditRow(row.id)}
                            disabled={editSubmitting}
                            className="h-7 px-2 text-xs"
                          >
                            {editSubmitting ? '保存中...' : '保存'}
                          </Button>
                          <Button type="button" size="sm" variant="outline" onClick={cancelEditRow} disabled={editSubmitting} className="h-7 px-2 text-xs">
                            取消
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void onMoveRow(row.id, 'up')}
                            disabled={editSubmitting || moveSubmittingId === row.id}
                            className="h-7 px-2 text-xs"
                          >
                            上移
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void onMoveRow(row.id, 'down')}
                            disabled={editSubmitting || moveSubmittingId === row.id}
                            className="h-7 px-2 text-xs"
                          >
                            下移
                          </Button>
                          <Button type="button" size="sm" variant="outline" onClick={() => startEditRow(row)} disabled={editSubmitting} className="h-7 px-2 text-xs">
                            编辑
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}

                {!loading && items.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-12 text-center text-sm text-muted-foreground">
                      {projectFilter ? '当前筛选条件下暂无数据，请调整筛选或导入新记录。' : '请先在筛选条件中选择项目名，再读取并展示数据。'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">分页大小：{pageSize} 条。数据更新后建议刷新一次。</p>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => setPage(page - 1)} disabled={loading || page <= 1}>
                上一页
              </Button>
              <Button type="button" variant="outline" onClick={() => setPage(page + 1)} disabled={loading || !hasNextPage}>
                下一页
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
