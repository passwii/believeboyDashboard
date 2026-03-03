'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from 'recharts'
import { Loader2, Upload, Database, TrendingUp, Table as TableIcon } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? ''
const API_KEY = process.env.NEXT_PUBLIC_BACKEND_API_KEY ?? ''

type CategoryResearchDataset = {
  id: number
  marketplace: string
  category_keyword_en: string
  category_name_zh: string
  version: number
  is_current: boolean
  row_count_products: number
  row_count_trends: number
  quality_warnings: Record<string, number>
  created_at: string | null
}

type CategoryResearchOverview = {
  dataset: CategoryResearchDataset
  kpis: {
    sample_count: number
    brand_count: number
    average_price_usd: number
    total_monthly_sales: number
    total_monthly_revenue_usd: number
    amazon_share: number
  }
  brand_sales_share: Array<{ brand: string; monthly_sales: number; share: number }>
  listing_age_distribution: Array<{ label: string; count: number }>
  fulfillment_distribution: Array<{ label: string; count: number }>
  fixed_price_bands: Array<{ label: string; count: number }>
  quantile_price_bands: Array<{ label: string; min_price: number; max_price: number; count: number }>
  price_stats: { mean: number; median: number; p25: number; p75: number }
  price_sales_correlation: number
  fba_fee_distribution: Array<{ label: string; count: number }>
  price_sales_points: Array<{ asin: string | null; price_usd: number; monthly_sales: number }>
  available_asins: string[]
}

type CategoryResearchProductRow = {
  id: number
  source_row_no: number
  asin: string | null
  parent_asin: string | null
  product_name: string | null
  brand: string | null
  seller: string | null
  price_usd: number | null
  monthly_sales: number
  monthly_revenue_usd: number | null
  rating: number | null
  review_count: number
  listing_age_days: number | null
  fba_fee_usd: number | null
  fulfillment_method: string | null
  is_amazon: boolean
  is_new_90d: boolean
}

type ProductsPayload = {
  dataset_id: number
  page: number
  page_size: number
  has_next: boolean
  rows: CategoryResearchProductRow[]
}

type TrendPayload = {
  dataset_id: number
  asin: string
  points: Array<{ year_month: string; monthly_sales: number }>
}

type ViewTab = 'market' | 'price' | 'trend' | 'table'

const marketChartConfig = {
  monthly_sales: { label: '月销量', color: 'hsl(var(--chart-2))' },
  count: { label: '数量', color: 'hsl(var(--chart-3))' },
} satisfies ChartConfig

const priceChartConfig = {
  count: { label: '数量', color: 'hsl(var(--chart-1))' },
  monthly_sales: { label: '月销量', color: 'hsl(var(--chart-2))' },
} satisfies ChartConfig

const trendChartConfig = {
  monthly_sales: { label: '月销量', color: 'hsl(var(--chart-2))' },
} satisfies ChartConfig

function authHeaders(operator?: string, isAdmin = false): Record<string, string> {
  const headers: Record<string, string> = {}
  if (API_KEY) headers['X-API-Key'] = API_KEY
  if (isAdmin) headers['X-Is-Admin'] = 'true'
  if (operator && operator.trim()) headers['X-Operator'] = encodeURIComponent(operator.trim())
  return headers
}

function resolveApiUrl(path: string) {
  const base = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE
  if (/^https?:\/\//i.test(path)) return path
  if (!path.startsWith('/')) return `${base}/${path}`
  return `${base}${path}`
}

function formatCurrency(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return `${(value * 100).toFixed(2)}%`
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return value.toLocaleString('en-US')
}

function parseErrorBody(text: string, status: number): string {
  if (!text) return `请求失败 (${status})`
  try {
    const payload = JSON.parse(text) as { detail?: string | unknown[] | Record<string, unknown> }
    if (typeof payload.detail === 'string') return payload.detail
    if (Array.isArray(payload.detail)) return payload.detail.map((item) => String(item)).join('; ')
    if (payload.detail && typeof payload.detail === 'object') return JSON.stringify(payload.detail)
    return text
  } catch {
    return text
  }
}

export default function CategoryResearchPage() {
  const { data: session } = useSession()
  const isAdmin = Boolean(session?.user?.isAdmin)
  const currentOperator = (session?.user?.operatorNameZh || session?.user?.name || session?.user?.email || '').trim()

  const [marketplace, setMarketplace] = useState('US')
  const [keywordEn, setKeywordEn] = useState('')
  const [nameZh, setNameZh] = useState('')
  const [uploadFile, setUploadFile] = useState<File | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [formSuccess, setFormSuccess] = useState<string | null>(null)

  const [datasets, setDatasets] = useState<CategoryResearchDataset[]>([])
  const [datasetLoading, setDatasetLoading] = useState(false)
  const [selectedDatasetId, setSelectedDatasetId] = useState<number | null>(null)

  const [overview, setOverview] = useState<CategoryResearchOverview | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(false)

  const [products, setProducts] = useState<ProductsPayload | null>(null)
  const [productsLoading, setProductsLoading] = useState(false)

  const [trendData, setTrendData] = useState<TrendPayload | null>(null)
  const [trendLoading, setTrendLoading] = useState(false)

  const [tab, setTab] = useState<ViewTab>('market')
  const [brandFilter, setBrandFilter] = useState('all')
  const [fulfillmentFilter, setFulfillmentFilter] = useState('all')
  const [priceBandFilter, setPriceBandFilter] = useState('all')
  const [productPage, setProductPage] = useState(1)
  const [trendAsin, setTrendAsin] = useState('')

  const loadDatasets = useCallback(async () => {
    if (!keywordEn.trim()) {
      setDatasets([])
      return
    }
    setDatasetLoading(true)
    try {
      const params = new URLSearchParams({
        marketplace,
        category_keyword_en: keywordEn.trim(),
        include_history: 'true',
      })
      const response = await fetch(resolveApiUrl(`/api/v1/category-research/datasets?${params.toString()}`), {
        cache: 'no-store',
        headers: authHeaders(currentOperator, isAdmin),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(parseErrorBody(text, response.status))
      }
      const rows = (await response.json()) as CategoryResearchDataset[]
      setDatasets(rows)
      if (rows.length > 0 && !selectedDatasetId) {
        setSelectedDatasetId(rows[0].id)
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '历史版本加载失败')
    } finally {
      setDatasetLoading(false)
    }
  }, [keywordEn, marketplace, currentOperator, isAdmin, selectedDatasetId])

  const loadOverview = useCallback(async (datasetId: number) => {
    setOverviewLoading(true)
    try {
      const response = await fetch(resolveApiUrl(`/api/v1/category-research/datasets/${datasetId}`), {
        cache: 'no-store',
        headers: authHeaders(currentOperator, isAdmin),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(parseErrorBody(text, response.status))
      }
      const payload = (await response.json()) as CategoryResearchOverview
      setOverview(payload)
      if (!trendAsin && payload.available_asins.length > 0) {
        setTrendAsin(payload.available_asins[0])
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '看板数据加载失败')
      setOverview(null)
    } finally {
      setOverviewLoading(false)
    }
  }, [currentOperator, isAdmin, trendAsin])

  const loadProducts = useCallback(async () => {
    if (!selectedDatasetId) {
      setProducts(null)
      return
    }
    setProductsLoading(true)
    try {
      const params = new URLSearchParams({
        page: String(productPage),
        page_size: '50',
      })
      if (brandFilter !== 'all') params.set('brand', brandFilter)
      if (fulfillmentFilter !== 'all') params.set('fulfillment_method', fulfillmentFilter)
      if (priceBandFilter !== 'all') params.set('price_band', priceBandFilter)

      const response = await fetch(
        resolveApiUrl(`/api/v1/category-research/datasets/${selectedDatasetId}/products?${params.toString()}`),
        {
          cache: 'no-store',
          headers: authHeaders(currentOperator, isAdmin),
        }
      )
      if (!response.ok) {
        const text = await response.text()
        throw new Error(parseErrorBody(text, response.status))
      }
      const payload = (await response.json()) as ProductsPayload
      setProducts(payload)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '明细加载失败')
      setProducts(null)
    } finally {
      setProductsLoading(false)
    }
  }, [selectedDatasetId, productPage, brandFilter, fulfillmentFilter, priceBandFilter, currentOperator, isAdmin])

  const loadTrend = useCallback(async () => {
    if (!selectedDatasetId || !trendAsin.trim()) {
      setTrendData(null)
      return
    }
    setTrendLoading(true)
    try {
      const params = new URLSearchParams({ asin: trendAsin.trim() })
      const response = await fetch(
        resolveApiUrl(`/api/v1/category-research/datasets/${selectedDatasetId}/trend?${params.toString()}`),
        {
          cache: 'no-store',
          headers: authHeaders(currentOperator, isAdmin),
        }
      )
      if (!response.ok) {
        const text = await response.text()
        throw new Error(parseErrorBody(text, response.status))
      }
      const payload = (await response.json()) as TrendPayload
      setTrendData(payload)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '趋势数据加载失败')
      setTrendData(null)
    } finally {
      setTrendLoading(false)
    }
  }, [selectedDatasetId, trendAsin, currentOperator, isAdmin])

  useEffect(() => {
    if (selectedDatasetId) {
      void loadOverview(selectedDatasetId)
    }
  }, [selectedDatasetId, loadOverview])

  useEffect(() => {
    void loadProducts()
  }, [loadProducts])

  useEffect(() => {
    void loadTrend()
  }, [loadTrend])

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null
    setUploadFile(file)
  }

  const onSubmit = async () => {
    setFormError(null)
    setFormSuccess(null)

    if (!keywordEn.trim()) {
      setFormError('请输入品类关键词（英文）')
      return
    }
    if (!nameZh.trim()) {
      setFormError('请输入品类名称（中文）')
      return
    }
    if (!uploadFile) {
      setFormError('请上传 xlsx 文件')
      return
    }

    setSubmitting(true)
    try {
      const formData = new FormData()
      formData.append('marketplace', marketplace)
      formData.append('category_keyword_en', keywordEn.trim())
      formData.append('category_name_zh', nameZh.trim())
      formData.append('file', uploadFile)

      const response = await fetch(resolveApiUrl('/api/v1/category-research/datasets/import'), {
        method: 'POST',
        headers: authHeaders(currentOperator, isAdmin),
        body: formData,
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(parseErrorBody(text, response.status))
      }

      const payload = (await response.json()) as {
        dataset_id: number
        version: number
        row_count_products: number
        row_count_trends: number
      }
      setSelectedDatasetId(payload.dataset_id)
      setFormSuccess(`导入成功：版本 V${payload.version}，产品 ${payload.row_count_products} 条，趋势 ${payload.row_count_trends} 条`)
      await loadDatasets()
      await loadOverview(payload.dataset_id)
      setProductPage(1)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '导入失败')
    } finally {
      setSubmitting(false)
    }
  }

  const warningItems = useMemo(() => {
    if (!overview) return []
    const warnings = overview.dataset.quality_warnings || {}
    return [
      { label: 'ASIN 缺失趋势', value: warnings.missing_trend_for_asin_count ?? 0 },
      { label: '无效价格', value: warnings.invalid_price_count ?? 0 },
      { label: '无效 FBA 费用', value: warnings.invalid_fba_fee_count ?? 0 },
      { label: '重复 ASIN', value: warnings.duplicate_asin_count ?? 0 },
    ]
  }, [overview])

  const availableBrands = useMemo(() => {
    if (!overview) return []
    return overview.brand_sales_share.map((item) => item.brand)
  }, [overview])

  const availableFulfillment = useMemo(() => {
    if (!overview) return []
    return overview.fulfillment_distribution.map((item) => item.label)
  }, [overview])

  const tabButtonClass = (target: ViewTab) =>
    `rounded-md border px-3 py-1.5 text-sm transition ${tab === target
      ? 'border-primary bg-primary text-primary-foreground'
      : 'border-border bg-background text-foreground hover:bg-muted'
    }`

  return (
    <div className="w-full space-y-6">
      <Card className="overflow-hidden border-border/80 shadow-[0_20px_45px_-24px_rgba(15,23,42,0.3)]">
        <CardHeader className="border-b bg-gradient-to-r from-cyan-500/10 via-sky-500/5 to-transparent">
          <CardTitle className="flex items-center gap-2 text-xl">
            <Database className="h-5 w-5" />
            类目调研分析
          </CardTitle>
          <CardDescription>上传 BestSeller 类目表（产品详情 + 销量趋势），自动入库并生成调研看板。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 p-6">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">站点</p>
              <Select value={marketplace} onValueChange={setMarketplace}>
                <SelectTrigger>
                  <SelectValue placeholder="选择站点" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="US">US</SelectItem>
                  <SelectItem value="UK">UK</SelectItem>
                  <SelectItem value="DE">DE</SelectItem>
                  <SelectItem value="JP">JP</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 xl:col-span-2">
              <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">品类关键词（英文）</p>
              <Input
                placeholder="例如: reciprocating saws"
                value={keywordEn}
                onChange={(event) => setKeywordEn(event.target.value)}
              />
            </div>
            <div className="space-y-2 xl:col-span-2">
              <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">品类名称（中文）</p>
              <Input
                placeholder="例如: 往复锯"
                value={nameZh}
                onChange={(event) => setNameZh(event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-[1fr_auto_auto] md:items-end">
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">上传文件（xlsx）</p>
              <Input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={onFileChange} />
            </div>
            <Button variant="outline" onClick={() => void loadDatasets()} disabled={datasetLoading || !keywordEn.trim()}>
              {datasetLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Database className="mr-2 h-4 w-4" />}
              加载历史版本
            </Button>
            <Button onClick={onSubmit} disabled={submitting}>
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              上传并分析
            </Button>
          </div>

          {formError ? <p className="text-sm text-rose-600">{formError}</p> : null}
          {formSuccess ? <p className="text-sm text-emerald-600">{formSuccess}</p> : null}

          <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">版本选择</p>
              <Select
                value={selectedDatasetId ? String(selectedDatasetId) : ''}
                onValueChange={(value) => {
                  setSelectedDatasetId(Number(value))
                  setProductPage(1)
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={datasetLoading ? '加载中...' : '请选择版本'} />
                </SelectTrigger>
                <SelectContent>
                  {datasets.map((item) => (
                    <SelectItem key={item.id} value={String(item.id)}>
                      {`V${item.version} · ${item.marketplace} · ${item.category_name_zh}${item.is_current ? ' (Current)' : ''}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {overview ? (
              <div className="flex flex-wrap items-center gap-2 pt-5 md:justify-end">
                <Badge variant="outline">关键词: {overview.dataset.category_keyword_en}</Badge>
                <Badge variant="outline">产品: {formatNumber(overview.dataset.row_count_products)}</Badge>
                <Badge variant="outline">趋势: {formatNumber(overview.dataset.row_count_trends)}</Badge>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {overviewLoading ? (
        <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-24 rounded-lg" />
          ))}
        </div>
      ) : overview ? (
        <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
          <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">样本数</p><p className="text-2xl font-semibold">{formatNumber(overview.kpis.sample_count)}</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">品牌数</p><p className="text-2xl font-semibold">{formatNumber(overview.kpis.brand_count)}</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">均价</p><p className="text-2xl font-semibold">{formatCurrency(overview.kpis.average_price_usd)}</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">月销量总和</p><p className="text-2xl font-semibold">{formatNumber(overview.kpis.total_monthly_sales)}</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">月销售额总和</p><p className="text-2xl font-semibold">{formatCurrency(overview.kpis.total_monthly_revenue_usd)}</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Amazon自营占比</p><p className="text-2xl font-semibold">{formatPercent(overview.kpis.amazon_share)}</p></CardContent></Card>
        </div>
      ) : null}

      {overview ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">数据质量提示</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {warningItems.map((item) => (
              <div key={item.label} className="rounded-md border bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">{item.label}</p>
                <p className="text-lg font-semibold">{formatNumber(item.value)}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {overview ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">分析视图</CardTitle>
            <CardDescription>市场结构、价格利润、趋势与明细视图可切换查看。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <button type="button" className={tabButtonClass('market')} onClick={() => setTab('market')}>市场结构</button>
              <button type="button" className={tabButtonClass('price')} onClick={() => setTab('price')}>价格利润</button>
              <button type="button" className={tabButtonClass('trend')} onClick={() => setTab('trend')}>趋势</button>
              <button type="button" className={tabButtonClass('table')} onClick={() => setTab('table')}>产品明细</button>
            </div>

            {tab === 'market' ? (
              <div className="grid gap-4 xl:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">品牌销售占比（Top10）</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ChartContainer config={marketChartConfig} className="h-[320px] w-full">
                      <BarChart data={overview.brand_sales_share} layout="vertical" margin={{ left: 10, right: 10 }}>
                        <CartesianGrid horizontal={false} />
                        <XAxis type="number" dataKey="monthly_sales" />
                        <YAxis type="category" dataKey="brand" width={92} />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Bar dataKey="monthly_sales" fill="var(--color-monthly_sales)" radius={4} />
                      </BarChart>
                    </ChartContainer>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">上架时间分布</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ChartContainer config={marketChartConfig} className="h-[320px] w-full">
                      <BarChart data={overview.listing_age_distribution}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="label" />
                        <YAxis />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Bar dataKey="count" fill="var(--color-count)" radius={4} />
                      </BarChart>
                    </ChartContainer>
                  </CardContent>
                </Card>

                <Card className="xl:col-span-2">
                  <CardHeader>
                    <CardTitle className="text-sm">物流方式占比</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ChartContainer config={marketChartConfig} className="h-[300px] w-full">
                      <BarChart data={overview.fulfillment_distribution}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="label" />
                        <YAxis />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Bar dataKey="count" fill="var(--color-count)" radius={4} />
                      </BarChart>
                    </ChartContainer>
                  </CardContent>
                </Card>
              </div>
            ) : null}

            {tab === 'price' ? (
              <div className="grid gap-4 xl:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">价格带分布（固定区间）</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ChartContainer config={priceChartConfig} className="h-[280px] w-full">
                      <BarChart data={overview.fixed_price_bands}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="label" />
                        <YAxis />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Bar dataKey="count" fill="var(--color-count)" radius={4} />
                      </BarChart>
                    </ChartContainer>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">价格带分布（分位数）</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ChartContainer config={priceChartConfig} className="h-[280px] w-full">
                      <BarChart data={overview.quantile_price_bands}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="label" />
                        <YAxis />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Bar dataKey="count" fill="var(--color-count)" radius={4} />
                      </BarChart>
                    </ChartContainer>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">价格-销量关联散点</CardTitle>
                    <CardDescription>相关系数: {overview.price_sales_correlation.toFixed(4)}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ChartContainer config={priceChartConfig} className="h-[300px] w-full">
                      <ScatterChart>
                        <CartesianGrid />
                        <XAxis dataKey="price_usd" name="价格" />
                        <YAxis dataKey="monthly_sales" name="月销量" />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Scatter data={overview.price_sales_points} fill="var(--color-monthly_sales)" />
                      </ScatterChart>
                    </ChartContainer>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">FBA费率分布</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ChartContainer config={priceChartConfig} className="h-[300px] w-full">
                      <BarChart data={overview.fba_fee_distribution}>
                        <CartesianGrid vertical={false} />
                        <XAxis dataKey="label" />
                        <YAxis />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Bar dataKey="count" fill="var(--color-count)" radius={4} />
                      </BarChart>
                    </ChartContainer>
                  </CardContent>
                </Card>

                <Card className="xl:col-span-2">
                  <CardHeader>
                    <CardTitle className="text-sm">价格统计</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-3 md:grid-cols-4">
                    <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">均值</p><p className="text-lg font-semibold">{formatCurrency(overview.price_stats.mean)}</p></div>
                    <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">中位数</p><p className="text-lg font-semibold">{formatCurrency(overview.price_stats.median)}</p></div>
                    <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">P25</p><p className="text-lg font-semibold">{formatCurrency(overview.price_stats.p25)}</p></div>
                    <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">P75</p><p className="text-lg font-semibold">{formatCurrency(overview.price_stats.p75)}</p></div>
                  </CardContent>
                </Card>
              </div>
            ) : null}

            {tab === 'trend' ? (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-[360px_auto] md:items-end">
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">选择 ASIN</p>
                    <Select value={trendAsin} onValueChange={setTrendAsin}>
                      <SelectTrigger>
                        <SelectValue placeholder="选择 ASIN" />
                      </SelectTrigger>
                      <SelectContent>
                        {overview.available_asins.map((asin) => (
                          <SelectItem key={asin} value={asin}>{asin}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button variant="outline" onClick={() => void loadTrend()} disabled={trendLoading || !trendAsin}>
                    {trendLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <TrendingUp className="mr-2 h-4 w-4" />}
                    刷新趋势
                  </Button>
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">ASIN 24个月销量趋势</CardTitle>
                    <CardDescription>{trendAsin || '请先选择 ASIN'}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {trendLoading ? (
                      <Skeleton className="h-[320px] w-full" />
                    ) : trendData && trendData.points.length > 0 ? (
                      <ChartContainer config={trendChartConfig} className="h-[320px] w-full">
                        <LineChart data={trendData.points}>
                          <CartesianGrid vertical={false} />
                          <XAxis dataKey="year_month" />
                          <YAxis />
                          <ChartTooltip content={<ChartTooltipContent />} />
                          <Line type="monotone" dataKey="monthly_sales" stroke="var(--color-monthly_sales)" strokeWidth={2} dot={false} />
                        </LineChart>
                      </ChartContainer>
                    ) : (
                      <div className="flex h-[320px] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
                        暂无趋势数据
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            ) : null}

            {tab === 'table' ? (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-4">
                  <Select value={brandFilter} onValueChange={(value) => { setBrandFilter(value); setProductPage(1) }}>
                    <SelectTrigger><SelectValue placeholder="品牌筛选" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部品牌</SelectItem>
                      {availableBrands.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
                    </SelectContent>
                  </Select>

                  <Select value={fulfillmentFilter} onValueChange={(value) => { setFulfillmentFilter(value); setProductPage(1) }}>
                    <SelectTrigger><SelectValue placeholder="物流筛选" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部物流</SelectItem>
                      {availableFulfillment.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
                    </SelectContent>
                  </Select>

                  <Select value={priceBandFilter} onValueChange={(value) => { setPriceBandFilter(value); setProductPage(1) }}>
                    <SelectTrigger><SelectValue placeholder="价格带筛选" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部价格带</SelectItem>
                      <SelectItem value="0-49">$0-49</SelectItem>
                      <SelectItem value="50-99">$50-99</SelectItem>
                      <SelectItem value="100-149">$100-149</SelectItem>
                      <SelectItem value="150+">$150+</SelectItem>
                    </SelectContent>
                  </Select>

                  <Button variant="outline" onClick={() => void loadProducts()} disabled={productsLoading}>
                    {productsLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <TableIcon className="mr-2 h-4 w-4" />}
                    刷新明细
                  </Button>
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">产品明细</CardTitle>
                    <CardDescription>当前页: {productPage}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>ASIN</TableHead>
                            <TableHead>产品名称</TableHead>
                            <TableHead>品牌</TableHead>
                            <TableHead>物流</TableHead>
                            <TableHead className="text-right">价格</TableHead>
                            <TableHead className="text-right">月销量</TableHead>
                            <TableHead className="text-right">月销售额</TableHead>
                            <TableHead className="text-right">FBA费用</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {productsLoading ? (
                            <TableRow>
                              <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">加载中...</TableCell>
                            </TableRow>
                          ) : products && products.rows.length > 0 ? (
                            products.rows.map((item) => (
                              <TableRow key={item.id}>
                                <TableCell className="font-medium">{item.asin || '-'}</TableCell>
                                <TableCell className="max-w-[360px] truncate">{item.product_name || '-'}</TableCell>
                                <TableCell>{item.brand || '-'}</TableCell>
                                <TableCell>{item.fulfillment_method || '-'}</TableCell>
                                <TableCell className="text-right">{formatCurrency(item.price_usd)}</TableCell>
                                <TableCell className="text-right">{formatNumber(item.monthly_sales)}</TableCell>
                                <TableCell className="text-right">{formatCurrency(item.monthly_revenue_usd)}</TableCell>
                                <TableCell className="text-right">{formatCurrency(item.fba_fee_usd)}</TableCell>
                              </TableRow>
                            ))
                          ) : (
                            <TableRow>
                              <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">暂无数据</TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                    </div>

                    <div className="mt-4 flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">支持品牌/物流/价格带组合筛选</p>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setProductPage((prev) => Math.max(1, prev - 1))}
                          disabled={productsLoading || productPage <= 1}
                        >上一页</Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setProductPage((prev) => prev + 1)}
                          disabled={productsLoading || !products?.has_next}
                        >下一页</Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex h-48 flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm text-muted-foreground">先填写站点、英文关键词、中文名称并上传 xlsx 文件，完成后自动生成调研看板。</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
