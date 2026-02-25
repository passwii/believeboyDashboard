'use client'

import { useEffect, useMemo, useState } from 'react'

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
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
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
  total: number | null
  has_next: boolean
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

export default function SkuCostPage() {
  const [items, setItems] = useState<ProductCostItem[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasNextPage, setHasNextPage] = useState(false)

  const [projectFilter, setProjectFilter] = useState('')
  const [skuFilter, setSkuFilter] = useState('')
  const [asinFilter, setAsinFilter] = useState('')

  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [addText, setAddText] = useState('')
  const [addSubmitting, setAddSubmitting] = useState(false)

  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const totalPages = useMemo(() => (typeof total === 'number' ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : null), [total])

  const loadData = async (
    targetPage = page,
    filters?: { project_name?: string; sku?: string; asin?: string },
    options?: { includeTotal?: boolean }
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
    if (options?.includeTotal) search.set('include_total', 'true')

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
      if (typeof payload.total === 'number') {
        setTotal(payload.total)
      }
      setHasNextPage(payload.has_next)
      setPage(payload.page)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadData(1, undefined, { includeTotal: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onRefresh = async () => {
    setSuccessMessage(null)
    await loadData(page)
  }

  const onSearch = async () => {
    setSuccessMessage(null)
    await loadData(1, undefined, { includeTotal: true })
  }

  const onResetFilters = async () => {
    setProjectFilter('')
    setSkuFilter('')
    setAsinFilter('')
    setSuccessMessage(null)
    await loadData(1, { project_name: '', sku: '', asin: '' }, { includeTotal: true })
  }

  const onSubmitSingle = async () => {
    const normalized = addText.replaceAll('，', ',')
    const lines = normalized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    if (lines.length === 0) {
      setError('请先粘贴数据（每行 5 列：project_name, SKU, ASIN, 头程单价, FOB单价）')
      return
    }

    const parsedItems: Array<{
      project_name: string
      sku: string
      asin: string
      first_leg_unit_cost: number
      fob_unit_cost: number
      currency: string
    }> = []
    const parseErrors: string[] = []

    lines.forEach((line, index) => {
      const cols = line.split(',').map((col) => col.trim())
      if (cols.length < 5) {
        parseErrors.push(`第 ${index + 1} 行列数不足（需要 5 列）`)
        return
      }

      const [project_name, sku, asin, firstLegRaw, fobRaw, currencyRaw] = cols
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

      parsedItems.push({
        project_name,
        sku,
        asin,
        first_leg_unit_cost: firstLeg,
        fob_unit_cost: fob,
        currency: currencyRaw || 'USD',
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
      await loadData(1, undefined, { includeTotal: true })
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '提交失败')
    } finally {
      setAddSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-6">
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
              <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">SKU 成本中心</h1>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={() => void onRefresh()} disabled={loading}>
                {loading ? '刷新中...' : '刷新数据'}
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
                      每行格式：project_name,SKU,ASIN,头程单价,FOB单价。若主键已存在（project_name + sku + asin），会自动更新。
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-2">
                    <label className="text-sm font-medium text-foreground" htmlFor="sku-paste-input">
                      导入文本
                    </label>
                    <textarea
                      id="sku-paste-input"
                      className="min-h-56 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      placeholder="创酷,JDB-M35-13PCS,B0G1SM4P52,0.32,2.57"
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
              <p className="text-sm text-muted-foreground">按项目名、SKU、ASIN 查询；默认每页 20 条记录。</p>
            </div>
            <div className="grid gap-4 md:grid-cols-4">
              <div className="grid gap-2">
                <label className="text-sm font-medium text-foreground" htmlFor="filter-project">
                  项目名
                </label>
                <Input
                  id="filter-project"
                  placeholder="例如：宝勒1店"
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                />
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
              <CardDescription>{typeof total === 'number' ? `共 ${total} 条记录` : '已启用快速分页'}</CardDescription>
            </div>
            <Badge variant="outline" className="rounded-md border-border bg-muted text-muted-foreground">
              {totalPages ? `第 ${page} / ${totalPages} 页` : `第 ${page} 页`}
            </Badge>
          </div>
          <Separator />
        </CardHeader>

        <CardContent className="space-y-4 pt-0">
          <ScrollArea className="w-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[80px]">ID</TableHead>
                  <TableHead>项目名</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>ASIN</TableHead>
                  <TableHead className="text-right">头程单价</TableHead>
                  <TableHead className="text-right">FOB单价</TableHead>
                  <TableHead>币种</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading
                  ? Array.from({ length: 6 }).map((_, index) => (
                      <TableRow key={`loading-${index}`}>
                        <TableCell>
                          <Skeleton className="h-4 w-12" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-4 w-24" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-4 w-28" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-4 w-24" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="ml-auto h-4 w-16" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="ml-auto h-4 w-16" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-4 w-12" />
                        </TableCell>
                      </TableRow>
                    ))
                  : null}

                {!loading
                  ? items.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell>{row.id}</TableCell>
                        <TableCell className="font-medium text-foreground">{row.project_name}</TableCell>
                        <TableCell>{row.sku}</TableCell>
                        <TableCell>{row.asin}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.first_leg_unit_cost.toFixed(2)}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.fob_unit_cost.toFixed(2)}</TableCell>
                        <TableCell>{row.currency}</TableCell>
                      </TableRow>
                    ))
                  : null}

                {!loading && items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-12 text-center text-sm text-muted-foreground">
                      当前筛选条件下暂无数据，请调整筛选或导入新记录。
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </ScrollArea>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">分页大小：20 条。数据更新后建议刷新一次。</p>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => void loadData(page - 1)} disabled={loading || page <= 1}>
                上一页
              </Button>
              <Button type="button" variant="outline" onClick={() => void loadData(page + 1)} disabled={loading || !hasNextPage}>
                下一页
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
