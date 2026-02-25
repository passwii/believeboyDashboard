'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, RefreshCcw, Upload } from 'lucide-react'

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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

type ProductCostItem = {
  id: number
  project_name: string
  sku: string
  asin: string
  first_leg_unit_cost: number
  fob_unit_cost: number
  currency: string
}

type ProductCostsPage = {
  items: ProductCostItem[]
  page: number
  page_size: number
  total: number
}

type AddFormState = {
  project_name: string
  sku: string
  asin: string
  first_leg_unit_cost: string
  fob_unit_cost: string
  currency: string
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? ''
const API_KEY = process.env.NEXT_PUBLIC_BACKEND_API_KEY ?? ''
const PAGE_SIZE = 20

function authHeaders() {
  return API_KEY ? { 'X-API-Key': API_KEY } : {}
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

const emptyForm: AddFormState = {
  project_name: '',
  sku: '',
  asin: '',
  first_leg_unit_cost: '0',
  fob_unit_cost: '0',
  currency: 'USD',
}

export default function SkuCostPage() {
  const [items, setItems] = useState<ProductCostItem[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [projectFilter, setProjectFilter] = useState('')
  const [skuFilter, setSkuFilter] = useState('')
  const [asinFilter, setAsinFilter] = useState('')

  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [addForm, setAddForm] = useState<AddFormState>(emptyForm)
  const [addSubmitting, setAddSubmitting] = useState(false)

  const [bulkDialogOpen, setBulkDialogOpen] = useState(false)
  const [bulkFile, setBulkFile] = useState<File | null>(null)
  const [bulkSubmitting, setBulkSubmitting] = useState(false)

  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total])

  const loadData = async (
    targetPage = page,
    filters?: { project_name?: string; sku?: string; asin?: string }
  ) => {
    setLoading(true)
    setError(null)

    const search = new URLSearchParams({
      page: String(targetPage),
      page_size: String(PAGE_SIZE),
    })
    const projectValue = (filters?.project_name ?? projectFilter).trim()
    const skuValue = (filters?.sku ?? skuFilter).trim()
    const asinValue = (filters?.asin ?? asinFilter).trim()
    if (projectValue) search.set('project_name', projectValue)
    if (skuValue) search.set('sku', skuValue)
    if (asinValue) search.set('asin', asinValue)

    try {
      const response = await fetch(`${API_BASE}/api/v1/product-costs?${search.toString()}`, {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      const payload = (await response.json()) as ProductCostsPage
      setItems(payload.items)
      setTotal(payload.total)
      setPage(payload.page)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadData(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onRefresh = async () => {
    setSuccessMessage(null)
    await loadData(page)
  }

  const onSearch = async () => {
    setSuccessMessage(null)
    await loadData(1)
  }

  const onResetFilters = async () => {
    setProjectFilter('')
    setSkuFilter('')
    setAsinFilter('')
    setSuccessMessage(null)
    await loadData(1, { project_name: '', sku: '', asin: '' })
  }

  const onSubmitSingle = async () => {
    setAddSubmitting(true)
    setError(null)
    setSuccessMessage(null)
    try {
      const response = await fetch(`${API_BASE}/api/v1/product-costs`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          project_name: addForm.project_name.trim(),
          sku: addForm.sku.trim(),
          asin: addForm.asin.trim(),
          first_leg_unit_cost: Number(addForm.first_leg_unit_cost || '0'),
          fob_unit_cost: Number(addForm.fob_unit_cost || '0'),
          currency: addForm.currency.trim() || 'USD',
        }),
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      setSuccessMessage('新增/更新成功')
      setAddForm(emptyForm)
      setAddDialogOpen(false)
      await loadData(1)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '提交失败')
    } finally {
      setAddSubmitting(false)
    }
  }

  const onSubmitBulkCsv = async () => {
    if (!bulkFile) {
      setError('请先选择 CSV 文件')
      return
    }
    setBulkSubmitting(true)
    setError(null)
    setSuccessMessage(null)
    try {
      const formData = new FormData()
      formData.append('file', bulkFile)

      const response = await fetch(`${API_BASE}/api/v1/product-costs/import-csv`, {
        method: 'POST',
        headers: authHeaders(),
        body: formData,
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      const payload = (await response.json()) as { inserted: number; updated: number; total: number }
      setSuccessMessage(`批量写入完成：新增 ${payload.inserted} 条，更新 ${payload.updated} 条`)
      setBulkDialogOpen(false)
      setBulkFile(null)
      await loadData(1)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '批量写入失败')
    } finally {
      setBulkSubmitting(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="dashboard-surface overflow-hidden rounded-2xl border border-cyan-200/70 bg-gradient-to-br from-cyan-50 via-white to-amber-50">
        <div className="flex flex-col gap-4 p-5 md:flex-row md:items-end md:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">数据管理 · SKU成本</h1>
            <p className="text-sm text-slate-600">支持 BLF_Basic_Info.csv 批量写入、单条维护与实时刷新。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => void onRefresh()} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
              刷新
            </Button>

            <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
              <DialogTrigger asChild>
                <Button type="button" className="bg-cyan-600 text-white hover:bg-cyan-700">
                  <Plus className="h-4 w-4" />
                  添加
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>新增 SKU 成本</DialogTitle>
                  <DialogDescription>若主键已存在（project_name + sku + asin），会自动更新。</DialogDescription>
                </DialogHeader>
                <div className="grid gap-3">
                  <Input
                    placeholder="项目名（project_name）"
                    value={addForm.project_name}
                    onChange={(e) => setAddForm((prev) => ({ ...prev, project_name: e.target.value }))}
                  />
                  <Input
                    placeholder="SKU"
                    value={addForm.sku}
                    onChange={(e) => setAddForm((prev) => ({ ...prev, sku: e.target.value }))}
                  />
                  <Input
                    placeholder="ASIN"
                    value={addForm.asin}
                    onChange={(e) => setAddForm((prev) => ({ ...prev, asin: e.target.value }))}
                  />
                  <Input
                    placeholder="头程单价"
                    type="number"
                    min="0"
                    step="0.01"
                    value={addForm.first_leg_unit_cost}
                    onChange={(e) => setAddForm((prev) => ({ ...prev, first_leg_unit_cost: e.target.value }))}
                  />
                  <Input
                    placeholder="FOB单价"
                    type="number"
                    min="0"
                    step="0.01"
                    value={addForm.fob_unit_cost}
                    onChange={(e) => setAddForm((prev) => ({ ...prev, fob_unit_cost: e.target.value }))}
                  />
                  <Input
                    placeholder="币种"
                    value={addForm.currency}
                    onChange={(e) => setAddForm((prev) => ({ ...prev, currency: e.target.value }))}
                  />
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setAddDialogOpen(false)} disabled={addSubmitting}>
                    取消
                  </Button>
                  <Button type="button" onClick={() => void onSubmitSingle()} disabled={addSubmitting}>
                    {addSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    保存
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}>
              <DialogTrigger asChild>
                <Button type="button" className="bg-amber-500 text-white hover:bg-amber-600">
                  <Upload className="h-4 w-4" />
                  批量添加
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>批量导入 CSV</DialogTitle>
                  <DialogDescription>仅支持 BLF_Basic_Info.csv 格式（project_name, SKU, ASIN, 头程单价, FOB单价）。</DialogDescription>
                </DialogHeader>
                <Input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => setBulkFile(e.target.files?.[0] ?? null)}
                  disabled={bulkSubmitting}
                />
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setBulkDialogOpen(false)} disabled={bulkSubmitting}>
                    取消
                  </Button>
                  <Button type="button" onClick={() => void onSubmitBulkCsv()} disabled={bulkSubmitting || !bulkFile}>
                    {bulkSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    上传并写入
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </div>

      <Card className="border-slate-200/80">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">筛选</CardTitle>
          <CardDescription>按项目名、SKU、ASIN 查询，默认每页 20 条。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <Input placeholder="项目名" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} />
          <Input placeholder="SKU" value={skuFilter} onChange={(e) => setSkuFilter(e.target.value)} />
          <Input placeholder="ASIN" value={asinFilter} onChange={(e) => setAsinFilter(e.target.value)} />
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => void onSearch()} className="w-full">
              查询
            </Button>
            <Button type="button" variant="ghost" onClick={() => void onResetFilters()} className="w-full">
              重置
            </Button>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
      ) : null}
      {successMessage ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{successMessage}</div>
      ) : null}

      <Card className="overflow-hidden border-slate-200/80">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">SKU 成本数据</CardTitle>
            <CardDescription>共 {total} 条记录</CardDescription>
          </div>
          <Badge variant="secondary">
            第 {page} / {totalPages} 页
          </Badge>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>项目名</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>ASIN</TableHead>
                <TableHead className="text-right">头程单价</TableHead>
                <TableHead className="text-right">FOB单价</TableHead>
                <TableHead>币种</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.id}</TableCell>
                  <TableCell className="font-medium">{row.project_name}</TableCell>
                  <TableCell>{row.sku}</TableCell>
                  <TableCell>{row.asin}</TableCell>
                  <TableCell className="text-right">{row.first_leg_unit_cost.toFixed(2)}</TableCell>
                  <TableCell className="text-right">{row.fob_unit_cost.toFixed(2)}</TableCell>
                  <TableCell>{row.currency}</TableCell>
                </TableRow>
              ))}
              {!loading && items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    暂无数据
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>

          <div className="mt-4 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadData(page - 1)}
              disabled={loading || page <= 1}
            >
              上一页
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadData(page + 1)}
              disabled={loading || page >= totalPages}
            >
              下一页
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
