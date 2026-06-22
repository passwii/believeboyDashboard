'use client'

import { type ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  RefreshCcw,
  Search,
  X,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DataTableCard,
  DataTableCardBody,
  DataTableCardHeader,
} from '@/components/ui/data-card'
import { DateRangePicker, formatDateInputValue as formatPickerDateInputValue, parseDateRangeInputValue } from '@/components/ui/date-picker'
import { EmptyTableState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { MultiSelect, type Option } from '@/components/ui/multi-select'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { TableSkeletonRows } from '@/components/ui/table-skeleton'
import { cn } from '@/lib/utils'
import { DENSE_CELL, DENSE_HEAD, DataTableCardStatBar } from '@/components/ui/data-card'
import { buildBackendClientHeaders } from '@/lib/backend-auth'

// ======================== 类型 ========================

type OrderItem = {
  id: number
  project_id: number
  project_name: string
  brand_name: string | null
  source_file_id: number
  purchase_at_utc: string
  purchase_at_pt: string
  purchase_date_pt: string
  amazon_order_id: string
  order_status: string
  fulfillment_channel: string
  fulfillment_label: string
  ship_service_level: string | null
  sku: string | null
  asin: string | null
  product_name: string | null
  quantity: number
  item_price: number
  shipping_price: number
  currency: string | null
  country: string
  state: string | null
  city: string | null
  postal_code: string | null
  is_counted_sales: boolean
  created_at: string
}

type OrderStats = {
  total_orders: number
  total_quantity: number
  total_amount: number
  currency: string | null
  fba_count: number
  fbm_count: number
}

type OrderListResponse = {
  items: OrderItem[]
  total: number
  page: number
  page_size: number
}

type FilterOptions = {
  projects: Option[]
  order_statuses: Option[]
  fulfillment_channels: Option[]
  countries: Option[]
  currencies: Option[]
}

type SortKey = 'purchase_at_pt' | 'quantity' | 'item_price'

// ======================== 常量 ========================

const PAGE_SIZE = 50
const ALL_VALUE = '__all__'
const DEFAULT_PROJECT_VALUE = '__all__'

// 表格横向滚动容器：与 shipment-management / 其他宽表格页面保持一致
const TABLE_SCROLL_CONTAINER_CLASS =
  'w-full max-w-full overflow-x-auto overflow-y-visible rounded-[inherit] [-webkit-overflow-scrolling:touch] overscroll-x-contain'

// ======================== 工具函数 ========================

function formatBeijingTime(isoUtc: string | null | undefined): string {
  if (!isoUtc) return '—'
  const d = new Date(isoUtc)
  if (Number.isNaN(d.getTime())) return '—'
  // 将 UTC 转换为北京时间 (+08:00)
  const beijing = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  const yyyy = beijing.getUTCFullYear()
  const mm = String(beijing.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(beijing.getUTCDate()).padStart(2, '0')
  const hh = String(beijing.getUTCHours()).padStart(2, '0')
  const mi = String(beijing.getUTCMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

function formatLocalDate(isoStr: string | null | undefined): string {
  if (!isoStr) return '—'
  const d = new Date(isoStr)
  if (Number.isNaN(d.getTime())) return '—'
  // purchase_at_pt 是 naive datetime（不带 tz），仅按 UTC 字段取 YYYY-MM-DD，
  // 避免被运行时环境时区影响（例如本机 TZ=Asia/Shanghai 时走错日界）。
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  const s = status.toLowerCase()
  if (s.includes('cancel')) return 'destructive'
  if (s.includes('shipped') || s.includes('shipping')) return 'default'
  if (s.includes('pending')) return 'secondary'
  return 'outline'
}

function fulfillmentVariant(label: string): 'default' | 'secondary' {
  return label.startsWith('FBA') ? 'default' : 'secondary'
}

// ======================== 主组件 ========================

export default function OrderInfoPage() {
  // session：用于向后端注入 X-Operator / X-Is-Admin（数据级权限控制）
  const { data: session } = useSession()

  // 筛选状态
  const [projectId, setProjectId] = useState<string>(DEFAULT_PROJECT_VALUE)
  const [fulfillmentChannels, setFulfillmentChannels] = useState<string[]>([])
  const [orderStatuses, setOrderStatuses] = useState<string[]>([])
  const [countries, setCountries] = useState<string[]>([])
  const [currencies, setCurrencies] = useState<string[]>([])
  const [skuKeyword, setSkuKeyword] = useState('')
  const [orderIdKeyword, setOrderIdKeyword] = useState('')
  const [asinKeyword, setAsinKeyword] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('purchase_at_pt')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // 数据状态
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null)
  const [filterOptionsLoading, setFilterOptionsLoading] = useState(true)
  const [items, setItems] = useState<OrderItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [stats, setStats] = useState<OrderStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // ====== 拉取筛选项（一次性） ======
  useEffect(() => {
    let cancelled = false
    async function load() {
      setFilterOptionsLoading(true)
      try {
        const res = await fetch('/api/order-info/filter-options', {
          cache: 'no-store',
          headers: buildBackendClientHeaders(session),
        })
        if (!res.ok) throw new Error('筛选选项加载失败')
        const data = (await res.json()) as FilterOptions
        if (!cancelled) setFilterOptions(data)
      } catch (e) {
        if (!cancelled) setErrorMessage(e instanceof Error ? e.message : '筛选选项加载失败')
      } finally {
        if (!cancelled) setFilterOptionsLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [session])

  // ====== 构建请求 query ======
  const buildQuery = useCallback(() => {
    const params = new URLSearchParams()
    if (projectId && projectId !== DEFAULT_PROJECT_VALUE) {
      params.append('project_ids', projectId)
    }
    fulfillmentChannels.forEach((v) => params.append('fulfillment_channels', v))
    orderStatuses.forEach((v) => params.append('order_statuses', v))
    countries.forEach((v) => params.append('countries', v))
    currencies.forEach((v) => params.append('currencies', v))
    if (skuKeyword.trim()) params.set('sku_keyword', skuKeyword.trim())
    if (orderIdKeyword.trim()) params.set('order_id_keyword', orderIdKeyword.trim())
    if (asinKeyword.trim()) params.set('asin_keyword', asinKeyword.trim())
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)
    params.set('page', String(page))
    params.set('page_size', String(PAGE_SIZE))
    params.set('sort_by', sortKey)
    params.set('sort_dir', sortDir)
    return params
  }, [
    projectId,
    fulfillmentChannels,
    orderStatuses,
    countries,
    currencies,
    skuKeyword,
    orderIdKeyword,
    asinKeyword,
    dateFrom,
    dateTo,
    page,
    sortKey,
    sortDir,
  ])

  // ====== 拉取数据（list + stats 合并） ======
  const fetchData = useCallback(async () => {
    setLoading(true)
    setErrorMessage(null)
    try {
      const params = buildQuery()
      const [listRes, statsRes] = await Promise.all([
        fetch(`/api/order-info/list?${params.toString()}`, {
          cache: 'no-store',
          headers: buildBackendClientHeaders(session),
        }),
        fetch(`/api/order-info/stats?${params.toString()}`, {
          cache: 'no-store',
          headers: buildBackendClientHeaders(session),
        }),
      ])
      if (!listRes.ok) {
        const txt = await listRes.text().catch(() => '')
        throw new Error(txt || `订单列表加载失败 (${listRes.status})`)
      }
      if (!statsRes.ok) {
        const txt = await statsRes.text().catch(() => '')
        throw new Error(txt || `统计加载失败 (${statsRes.status})`)
      }
      const listData = (await listRes.json()) as OrderListResponse
      const statsData = (await statsRes.json()) as OrderStats
      setItems(listData.items)
      setTotal(listData.total)
      setStats(statsData)
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : '数据加载失败')
    } finally {
      setLoading(false)
    }
  }, [buildQuery, session])

  // ====== 副作用：任何筛选变化触发 fetch ======
  useEffect(() => {
    void fetchData()
  }, [fetchData])

  // ====== 翻页时也触发（page 由 fetchData 自身依赖，不放这里） ======
  // 已由 fetchData 依赖 page 自动覆盖

  // ====== 操作 handlers ======
  const handleRefresh = () => {
    void fetchData()
  }

  const handleResetFilters = () => {
    setProjectId(DEFAULT_PROJECT_VALUE)
    setFulfillmentChannels([])
    setOrderStatuses([])
    setCountries([])
    setCurrencies([])
    setSkuKeyword('')
    setOrderIdKeyword('')
    setAsinKeyword('')
    setDateFrom('')
    setDateTo('')
    setPage(1)
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const res = await fetch('/api/order-info/export', {
        method: 'POST',
        headers: buildBackendClientHeaders(session, { contentType: 'application/json' }),
        body: JSON.stringify({
          project_ids: projectId && projectId !== DEFAULT_PROJECT_VALUE ? [Number(projectId)] : [],
          fulfillment_channels: fulfillmentChannels,
          order_statuses: orderStatuses,
          countries,
          currencies,
          sku_keyword: skuKeyword.trim() || null,
          order_id_keyword: orderIdKeyword.trim() || null,
          asin_keyword: asinKeyword.trim() || null,
          date_from: dateFrom || null,
          date_to: dateTo || null,
        }),
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        throw new Error(txt || `导出失败 (${res.status})`)
      }
      const data = (await res.json()) as { filename: string; content_base64: string }
      // 解码 base64 → Blob → 下载
      const binStr = atob(data.content_base64)
      const bytes = new Uint8Array(binStr.length)
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i)
      const blob = new Blob([bytes], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = data.filename
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  // ====== 排序切换 ======
  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
    setPage(1)
  }

  const sortIndicator = (key: SortKey) =>
    sortKey === key ? (
      sortDir === 'asc' ? (
        <ChevronUp className="inline-block h-3 w-3" />
      ) : (
        <ChevronDown className="inline-block h-3 w-3" />
      )
    ) : null

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(total / PAGE_SIZE)),
    [total]
  )

  // ====== 渲染 ======
  return (
    <div className="min-w-0 space-y-6 text-foreground">
      {errorMessage && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      {/* ====== 订单信息总卡：筛选 + StatBar + 表格 + 翻页 ====== */}
      <DataTableCard>
        <DataTableCardHeader
          title="订单信息"
          description="集中查看各店铺订单的下单时间、SKU、商品、收货地、订单类型等明细"
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={loading}
                className="gap-1"
              >
                <RefreshCcw className={cn('h-4 w-4', loading && 'animate-spin')} />
                刷新
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleResetFilters}
                disabled={loading}
                className="gap-1"
              >
                <X className="h-4 w-4" />
                清空筛选
              </Button>
              <Button
                size="sm"
                onClick={handleExport}
                disabled={exporting || loading}
                className="gap-1"
              >
                {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
                导出 CSV
              </Button>
            </div>
          }
        />

        {/* 第二段：聚合指标条 */}
        <DataTableCardStatBar
          items={[
            {
              label: '订单数',
              value: stats ? stats.total_orders.toLocaleString('zh-CN') : '—',
            },
            {
              label: '总数量',
              value: stats ? stats.total_quantity.toLocaleString('zh-CN') : '—',
            },
            {
              label: '总金额（主导币种）',
              value: stats
                ? `${stats.total_amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${stats.currency ?? ''}`.trim()
                : '—',
              highlight: true,
            },
            {
              label: 'FBA 行数',
              value: stats ? stats.fba_count.toLocaleString('zh-CN') : '—',
            },
            {
              label: 'FBM 行数',
              value: stats ? stats.fbm_count.toLocaleString('zh-CN') : '—',
            },
          ]}
        />

        {/* 第三段：筛选条件（与表格顶之间用分割线隔开） */}
        <div className="grid gap-3 border-t border-border/60 bg-[hsl(var(--surface-subtle))] px-4 py-4 md:grid-cols-12 md:px-6">
          <div className="md:col-span-3">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">店铺</label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger>
                <SelectValue placeholder="全部店铺" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_PROJECT_VALUE}>全部店铺</SelectItem>
                {filterOptions?.projects.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="md:col-span-3">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">订单类型</label>
            <MultiSelect
              options={filterOptions?.fulfillment_channels ?? []}
              selected={fulfillmentChannels}
              onChange={setFulfillmentChannels}
              placeholder={filterOptionsLoading ? '加载中…' : 'FBA / FBM'}
            />
          </div>

          <div className="md:col-span-3">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">订单状态</label>
            <MultiSelect
              options={filterOptions?.order_statuses ?? []}
              selected={orderStatuses}
              onChange={setOrderStatuses}
              placeholder={filterOptionsLoading ? '加载中…' : 'Shipped / Pending …'}
            />
          </div>

          <div className="md:col-span-3">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">国家</label>
            <MultiSelect
              options={filterOptions?.countries ?? []}
              selected={countries}
              onChange={setCountries}
              placeholder={filterOptionsLoading ? '加载中…' : 'US / UK / DE'}
            />
          </div>

          <div className="md:col-span-3">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">币种</label>
            <MultiSelect
              options={filterOptions?.currencies ?? []}
              selected={currencies}
              onChange={setCurrencies}
              placeholder={filterOptionsLoading ? '加载中…' : 'USD / EUR / GBP'}
            />
          </div>

          <div className="md:col-span-3">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">SKU 搜索</label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={skuKeyword}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setSkuKeyword(e.target.value)}
                placeholder="例如 JDB-4341-29PCS"
                className="pl-8"
              />
            </div>
          </div>

          <div className="md:col-span-3">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">订单号</label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={orderIdKeyword}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setOrderIdKeyword(e.target.value)}
                placeholder="例如 111-3084457-..."
                className="pl-8"
              />
            </div>
          </div>

          <div className="md:col-span-3">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">ASIN</label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={asinKeyword}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setAsinKeyword(e.target.value)}
                placeholder="例如 B0C12345"
                className="pl-8"
              />
            </div>
          </div>

          <div className="md:col-span-6">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">下单 PT 日期区间</label>
            <DateRangePicker
              value={parseDateRangeInputValue(dateFrom, dateTo)}
              onChange={(range) => {
                setDateFrom(formatPickerDateInputValue(range?.from))
                setDateTo(formatPickerDateInputValue(range?.to))
                setPage(1)
              }}
              placeholder="选择下单 PT 日期范围"
            />
          </div>
        </div>

        {/* 第四段：主表格（横向滚动容器） */}
        <DataTableCardBody>
          <Table containerClassName={TABLE_SCROLL_CONTAINER_CLASS} className="w-full min-w-[1320px]">
            <TableHeader>
              <TableRow className="bg-[hsl(var(--surface-subtle))]">
                <TableHead className={cn(DENSE_HEAD, 'whitespace-nowrap')}>下单时间</TableHead>
                <TableHead className={cn(DENSE_HEAD, 'whitespace-nowrap')}>订单号</TableHead>
                <TableHead className={cn(DENSE_HEAD, 'whitespace-nowrap')}>SKU / ASIN</TableHead>
                <TableHead className={DENSE_HEAD}>产品</TableHead>
                <TableHead
                  className={cn(DENSE_HEAD, 'whitespace-nowrap text-right cursor-pointer select-none')}
                  onClick={() => handleSort('quantity')}
                >
                  数量 {sortIndicator('quantity')}
                </TableHead>
                <TableHead
                  className={cn(DENSE_HEAD, 'whitespace-nowrap text-right cursor-pointer select-none')}
                  onClick={() => handleSort('item_price')}
                >
                  金额 {sortIndicator('item_price')}
                </TableHead>
                <TableHead className={cn(DENSE_HEAD, 'whitespace-nowrap')}>收货地</TableHead>
                <TableHead className={cn(DENSE_HEAD, 'whitespace-nowrap')}>店铺</TableHead>
                <TableHead className={cn(DENSE_HEAD, 'whitespace-nowrap')}>类型</TableHead>
                <TableHead className={cn(DENSE_HEAD, 'whitespace-nowrap')}>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableSkeletonRows columns={10} rows={8} />
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className={DENSE_CELL}>
                    <EmptyTableState
                      colSpan={10}
                      message="暂无订单数据 — 调整筛选条件或等待新的销售报告上传后重试"
                    />
                  </TableCell>
                </TableRow>
              ) : (
                items.map((item) => {
                  const fullAddress = [item.city, item.state, item.postal_code, item.country]
                    .filter(Boolean)
                    .join(', ')
                  return (
                    <TableRow key={item.id} className="hover:bg-muted/40">
                      <TableCell className={DENSE_CELL}>
                        <div className="flex flex-col leading-tight">
                          <span className="text-sm font-medium tabular-nums">
                            {formatBeijingTime(item.purchase_at_utc)}
                          </span>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            PT {formatLocalDate(item.purchase_at_pt)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className={cn(DENSE_CELL, 'font-mono text-xs whitespace-nowrap')}>
                        <a
                          href={`https://www.amazon.com/dp/${item.asin ?? ''}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-foreground hover:underline"
                        >
                          {item.amazon_order_id}
                        </a>
                      </TableCell>
                      <TableCell className={DENSE_CELL}>
                        <div className="flex flex-col leading-tight">
                          {item.sku ? (
                            <Link
                              href={(() => {
                                const params = new URLSearchParams()
                                if (item.project_name) params.set('project_name', item.project_name)
                                params.set('sku', item.sku)
                                if (item.asin) params.set('asin', item.asin)
                                return `/dashboard/data-management/sku-info?${params.toString()}`
                              })()}
                              className="font-mono text-xs text-foreground hover:text-primary hover:underline"
                              title="跳转到 SKU 信息页面（带入项目 + SKU + ASIN）"
                            >
                              {item.sku}
                            </Link>
                          ) : (
                            <span className="font-mono text-xs">—</span>
                          )}
                          {item.asin ? (
                            <Link
                              href={(() => {
                                const params = new URLSearchParams()
                                if (item.project_name) params.set('project_name', item.project_name)
                                if (item.sku) params.set('sku', item.sku)
                                params.set('asin', item.asin)
                                return `/dashboard/data-management/sku-info?${params.toString()}`
                              })()}
                              className="text-xs text-muted-foreground hover:text-primary hover:underline"
                              title="跳转到 SKU 信息页面（按 ASIN 查询）"
                            >
                              ASIN {item.asin}
                            </Link>
                          ) : (
                            <span className="text-xs text-muted-foreground">ASIN —</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className={cn(DENSE_CELL, 'max-w-[260px]')}>
                        <span className="line-clamp-2 text-sm" title={item.product_name ?? ''}>
                          {item.product_name ?? '—'}
                        </span>
                      </TableCell>
                      <TableCell className={cn(DENSE_CELL, 'text-right tabular-nums')}>{item.quantity}</TableCell>
                      <TableCell className={cn(DENSE_CELL, 'text-right tabular-nums')}>
                        <div className="flex flex-col leading-tight">
                          <span>
                            {item.item_price.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}{' '}
                            {item.currency ?? ''}
                          </span>
                          {item.shipping_price > 0 && (
                            <span className="text-xs text-muted-foreground">
                              + 运费 {item.shipping_price.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell
                        className={DENSE_CELL}
                        title={
                          fullAddress
                            ? `服务等级：${item.ship_service_level ?? '—'} · 数据源：source_file #${item.source_file_id}`
                            : undefined
                        }
                      >
                        <span className="text-sm">{fullAddress || '—'}</span>
                      </TableCell>
                      <TableCell className={DENSE_CELL}>
                        <Link
                          href={`/dashboard/system-management/project-info?configure=${item.project_id}`}
                          className="flex flex-col leading-tight hover:opacity-80"
                          title={`跳转到「${item.project_name}」的项目设置`}
                        >
                          <span className="inline-flex items-center gap-1 text-sm text-foreground hover:text-primary hover:underline">
                            {item.project_name}
                            <ExternalLink className="h-3 w-3" />
                          </span>
                          {item.brand_name && (
                            <span className="text-xs text-muted-foreground">{item.brand_name}</span>
                          )}
                        </Link>
                      </TableCell>
                      <TableCell className={DENSE_CELL}>
                        <Badge variant={fulfillmentVariant(item.fulfillment_label)}>
                          {item.fulfillment_label}
                        </Badge>
                      </TableCell>
                      <TableCell className={DENSE_CELL}>
                        <Badge variant={statusVariant(item.order_status)}>{item.order_status}</Badge>
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </DataTableCardBody>

        {/* 第五段：翻页（贴在表格下沿，与表格之间用分割线） */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-4 py-3 text-sm text-muted-foreground md:px-6">
          <span>
            共 {total.toLocaleString('zh-CN')} 行 · 每页 {PAGE_SIZE} 行 · 第 {page} / {totalPages || 1} 页
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              下一页
            </Button>
          </div>
        </div>
      </DataTableCard>
    </div>
  )
}