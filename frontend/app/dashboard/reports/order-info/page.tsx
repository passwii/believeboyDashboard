'use client'

import { Suspense, type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'
import {
  AlertCircle,
  ArrowDownToLine,
  Copy,
  ExternalLink,
  Loader2,
  Pencil,
  Search,
  X,
} from 'lucide-react'

import {
  TermBody,
  TermCell,
  TermHead,
  TermRow,
  TermTable,
  TermTHead,
} from '@/components/terminal/term-table'
import { Checkbox } from '@/components/ui/checkbox'
import {
  formatDateInputValue as formatPickerDateInputValue,
  getTodayInTimezone,
  parseDateInputValue,
} from '@/components/ui/date-picker'
import { EmptyTableState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { MultiSelect, type Option } from '@/components/ui/multi-select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { buildBackendClientHeaders } from '@/lib/backend-auth'
import {
  getOrderStatusLabel,
  getOrderStatusTone,
  ORDER_STATUS_TONE_PILL_CLASS,
  type OrderStatusTone,
} from '@/lib/order-status'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { getCountryLabel } from '@/lib/country'
import { useNotifications } from '@/components/notifications'
import { useTerminalGlobalFilter } from '@/components/terminal/global-filter-context'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import { MobileFilterStrip } from '@/components/terminal/mobile-filter-strip'
import {
  useHeaderRefresh,
  useHeaderSlot,
  useMobileFilterStrip,
} from '@/components/terminal/terminal-header-slot'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { OrderEditDialog, type OrderEditResponsePayload } from './components/OrderEditDialog'

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
  // ===== FBM 自发货补录字段（2026-06-27 迁移 200 新增）=====
  carrier: string | null
  tracking_no: string | null
  shipped_at: string | null // UTC ISO
  updated_by: string | null
  updated_at: string | null // UTC ISO
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

// /overview 一次返回 列表 + 统计（不含 filter_options），取代并行的 /list + /stats
type OrderOverviewResponse = OrderListResponse & {
  stats: OrderStats
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
const DEFAULT_PROJECT_VALUE = '__all__'

/** 表格列数（含行选择列）——骨架屏 / 空态 colSpan 用 */
const COLUMN_COUNT = 13

/**
 * BLF-817 终端化控件基类（Stage 3；BLF-887 高度上档：与全局 term-controls h-9 终端档对齐）。
 */
const TERM_TRIGGER =
  'h-9 rounded-none border border-term-border bg-term-bg text-xs leading-5 text-term-text shadow-none focus-visible:outline-none focus-visible:border-term-border-strong data-[state=open]:border-term-border-strong'
const TERM_INPUT =
  'h-9 rounded-none border border-term-border bg-term-bg font-mono text-sm leading-5 text-term-text shadow-none placeholder:font-sans placeholder:text-term-faint focus-visible:outline-none focus-visible:border-term-border-strong focus-visible:ring-0 focus-visible:ring-offset-0'
const TERM_BUTTON =
  'flex h-9 shrink-0 items-center gap-1 rounded-none border border-term-border bg-term-panel px-2 font-mono text-xs leading-5 text-term-muted shadow-none transition-colors hover:border-term-border-strong hover:text-term-text active:bg-term-raised focus-visible:outline-none focus-visible:border-term-border-strong disabled:cursor-not-allowed disabled:opacity-50'

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

function defaultLast7Days(): { from: string; to: string } {
  // 默认近 7 天（含今天）— 直接把 stats 聚合扫描集 bound 在近期订单，
  // 降低首屏与每次筛选的 CPU/内存压力，也匹配用户实际查近期订单的诉求。
  // SSR/CSR 一致性：返回纯字符串、计算确定；调用方在 mount 后 effect 里 setState。
  // 时区与后端 purchase_date_pt 一致（PT），避免跨时区切到下一天导致 7 天窗口跑偏。
  const today = getTodayInTimezone('America/Los_Angeles')
  const sevenDaysAgo = new Date(today)
  sevenDaysAgo.setDate(today.getDate() - 6)
  return {
    from: formatPickerDateInputValue(sevenDaysAgo),
    to: formatPickerDateInputValue(today),
  }
}

/** 终端状态 pill：18px 高、方角、1px 语义色边界（禁投影）。
 * tone 映射与 pill class 已提炼为公共导出（BLF-927）：lib/order-status.ts */
function StatusPill({ label, tone }: { label: string; tone: OrderStatusTone }) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] items-center whitespace-nowrap border px-1 font-mono text-[10px] leading-none',
        ORDER_STATUS_TONE_PILL_CLASS[tone]
      )}
    >
      {label}
    </span>
  )
}

function fulfillmentTone(label: string): 'accent' | 'muted' {
  return label.startsWith('FBA') ? 'accent' : 'muted'
}

function fmtAmount(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** BLF-940 · 移动端折叠筛选条摘要：拼合「关键字 + 状态/类型/币种条数」到一行。 */
function buildMobileFilterSummary(params: {
  orderStatuses: string[]
  fulfillmentChannels: string[]
  currencies: string[]
  orderIdKeyword: string
  skuKeyword: string
  asinKeyword: string
}): string {
  const counts: string[] = []
  const keyword = params.orderIdKeyword || params.skuKeyword || params.asinKeyword
  if (keyword) counts.push(`关键字：${keyword}`)
  if (params.orderStatuses.length > 0) counts.push(`状态 ×${params.orderStatuses.length}`)
  if (params.fulfillmentChannels.length > 0) counts.push(`类型 ×${params.fulfillmentChannels.length}`)
  if (params.currencies.length > 0) counts.push(`币种 ×${params.currencies.length}`)
  return counts.length > 0 ? counts.join(' · ') : '未设置筛选'
}

// ======================== 主组件 ========================

function OrderInfoPageInner() {
  // session：用于向后端注入 X-Operator / X-Is-Admin（数据级权限控制）
  const { data: session, status: sessionStatus } = useSession()
  const { notify } = useNotifications()

  // 筛选状态（关键字类用 _committed 版本做 debounce，原始 input 用 onChange 实时）
  const [projectId, setProjectId] = useState<string>(DEFAULT_PROJECT_VALUE)
  const [fulfillmentChannels, setFulfillmentChannels] = useState<string[]>([])
  const [orderStatuses, setOrderStatuses] = useState<string[]>([])
  const [countries, setCountries] = useState<string[]>([])
  const [currencies, setCurrencies] = useState<string[]>([])
  const [skuKeyword, setSkuKeyword] = useState('')
  const [skuKeywordCommitted, setSkuKeywordCommitted] = useState('')
  const [orderIdKeyword, setOrderIdKeyword] = useState('')
  const [orderIdKeywordCommitted, setOrderIdKeywordCommitted] = useState('')
  const [asinKeyword, setAsinKeyword] = useState('')
  const [asinKeywordCommitted, setAsinKeywordCommitted] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('purchase_at_pt')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // 数据状态
  // BEL-422：filter-options 不再随 mount 预拉（后端是 3 个 distinct 全表扫，3-6s），
  // 改为用户首次打开任一筛选下拉时按需加载；首屏店铺自动选中改走带客户端
  // 缓存的 fetchManagedProjectsCached，不再被 filter-options 阻塞。
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null)
  const [filterOptionsLoading, setFilterOptionsLoading] = useState(false)
  const filterOptionsRequested = useRef(false)
  // 店铺自动选中是否已落定（manage 项目列表 resolve 后置 true，驱动首屏 fetch）
  const [projectAutoselectDone, setProjectAutoselectDone] = useState(false)
  const [items, setItems] = useState<OrderItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [stats, setStats] = useState<OrderStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // 行选择状态（仅客户端聚合展示，不参与任何请求）
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())

  // FBM 编辑 Dialog 状态
  const [editingOrder, setEditingOrder] = useState<OrderItem | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  // BLF-819 头部 → 页面同步：全局筛选就绪时，头部四件套的选择写入本页对应筛选。
  // 项目：'__all__'（全部店铺）↔ 'all'（全部项目）语义对齐；
  // 站点：取头部第一个国家映射到 countries 多选（ALL → 清空 = 不限）；
  // 日期：头部完整范围覆盖 dateFrom/dateTo。
  const globalFilter = useTerminalGlobalFilter()
  const gfProjectId = globalFilter.ready ? globalFilter.projectId : null
  const gfCountry = globalFilter.ready ? globalFilter.country : null
  const gfDateFrom = globalFilter.ready ? globalFilter.dateFrom : null
  const gfDateTo = globalFilter.ready ? globalFilter.dateTo : null
  const lastAppliedGfRef = useRef('')
  // 头部是否已接管本页项目选择；接管后「自动选第一个店铺」不再覆盖（见下方 autoselect effect）
  const gfProjectOwnedRef = useRef(false)
  useEffect(() => {
    if (!globalFilter.ready) return
    const signature = `${gfProjectId}|${gfCountry}|${gfDateFrom}|${gfDateTo}`
    if (signature === lastAppliedGfRef.current) return
    const isFirstApply = lastAppliedGfRef.current === ''
    lastAppliedGfRef.current = signature
    if (isFirstApply) {
      // 首次水合：仅当头部带用户上次选择（URL/localStorage 有项目）时才覆盖，
      // 否则保留本页既有行为（自动选第一个店铺），与 daily-analysis-client 守卫一致。
      if (!gfProjectId) return
    }
    if (gfProjectId) {
      gfProjectOwnedRef.current = true
      const nextProjectId = gfProjectId === 'all' ? DEFAULT_PROJECT_VALUE : gfProjectId
      if (nextProjectId !== projectId) {
        setProjectId(nextProjectId)
        setPage(1)
      }
    }
    if (gfCountry) {
      const nextCountries = gfCountry === 'ALL' || !['US', 'DE', 'UK'].includes(gfCountry)
        ? []
        : [gfCountry]
      if (nextCountries.join(',') !== countries.join(',')) {
        setCountries(nextCountries)
        setPage(1)
      }
    }
    if (gfDateFrom && gfDateTo) {
      const from = parseDateInputValue(gfDateFrom)
      const to = parseDateInputValue(gfDateTo)
      if (from && to) {
        setDateFrom(formatPickerDateInputValue(from))
        setDateTo(formatPickerDateInputValue(to))
        setPage(1)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只响应头部四件套的变化
  }, [globalFilter.ready, gfProjectId, gfCountry, gfDateFrom, gfDateTo])

  // 首次加载时自动选中第一个店铺，避免默认全部店铺导致全量数据慢查询
  const initialProjectAutoselected = useRef(false)
  // BLF-927：URL order_statuses 预填（如 ?order_statuses=Pending）。
  // BLF-939：URL project_id / date_from / date_to 预填（从首页订单流面板跳转时带入）。
  // 仅 mount 时读一次，与 BLF-819 全局头部水合互不冲突（g* 参数走 globalFilter，本机制只写页面级状态）。
  const searchParams = useSearchParams()
  const urlPrefillApplied = useRef(false)
  useEffect(() => {
    if (urlPrefillApplied.current) return
    let changed = false

    // order_statuses
    const rawStatuses = searchParams.getAll('order_statuses').join(',')
    const statuses = rawStatuses
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
    if (statuses.length > 0) {
      setOrderStatuses(statuses)
      changed = true
    }

    // project_id（与 globalFilter 的 gProject 不同，本参数直写页面 projectId）
    const pid = searchParams.get('project_id')
    if (pid && pid !== DEFAULT_PROJECT_VALUE) {
      setProjectId(pid)
      gfProjectOwnedRef.current = true
      changed = true
    }

    // date_from / date_to
    const df = searchParams.get('date_from')
    const dt = searchParams.get('date_to')
    if (df && dt) {
      setDateFrom(df)
      setDateTo(dt)
      urlDatePrefilledRef.current = true
      changed = true
    }

    if (changed) setPage(1)
    urlPrefillApplied.current = true
  }, [searchParams])

  // 当前在飞的 list/stats 请求控制器：发新请求前 abort 上一次，
  // 避免快速切换筛选时多个重型请求并发堆积压垮后端（CPU/内存飙升根因之一）。
  const fetchAbortRef = useRef<AbortController | null>(null)

  // ====== 关键字输入 debounce（250ms）======
  useEffect(() => {
    const timer = setTimeout(() => {
      setSkuKeywordCommitted(skuKeyword.trim())
      setOrderIdKeywordCommitted(orderIdKeyword.trim())
      setAsinKeywordCommitted(asinKeyword.trim())
      setPage(1)
    }, 250)
    return () => clearTimeout(timer)
  }, [skuKeyword, orderIdKeyword, asinKeyword])

  // 当前登录用户名（默认填到 updated_by）
  const currentUserName = useMemo(() => {
    const u = session?.user
    if (!u) return undefined
    const candidates = [u.operatorNameZh, u.name, u.email]
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim()
    }
    return undefined
  }, [session])

  // ====== 筛选项按需加载（首次打开筛选下拉触发，一次性） ======
  // 8s 客户端超时护栏：collect_filter_options 在大表上 3 个 distinct 全表扫会拖到 3–6s，
  // 这里给一个上限避免下拉无限转圈；同时超时/失败走 fallback 让下拉可用。
  const ensureFilterOptions = useCallback(() => {
    if (filterOptionsRequested.current) return
    filterOptionsRequested.current = true
    const ctrl = new AbortController()
    const timeoutId = setTimeout(() => ctrl.abort(), 8000)
    async function load() {
      setFilterOptionsLoading(true)
      try {
        const res = await fetch('/api/backend/api/v1/order-info/filter-options', {
          cache: 'no-store',
          headers: buildBackendClientHeaders(session),
          signal: ctrl.signal,
        })
        if (!res.ok) throw new Error('筛选选项加载失败')
        const data = (await res.json()) as FilterOptions
        setFilterOptions(data)
      } catch {
        // 超时 / 失败不弹红色错误，用空壳让下拉至少可开；数据表格不受影响。
        setFilterOptions({
          projects: [],
          order_statuses: [],
          fulfillment_channels: [],
          countries: [],
          currencies: [],
        })
      } finally {
        clearTimeout(timeoutId)
        setFilterOptionsLoading(false)
      }
    }
    void load()
  }, [session])

  // ====== 首次加载：店铺自动选中改走带缓存的 manage 项目列表 ======
  // 不再等 filter-options 返回才选中第一个店铺：manage 列表带 2 分钟客户端缓存，
  // SPA 内跨页导航时通常零请求，且不会阻塞首屏 /overview。
  // 失败/空列表时照旧放行（projectId 维持 DEFAULT 全店铺），与旧逻辑空壳分支等价。
  useEffect(() => {
    // 等 session 落定再拉项目列表，保证请求带上 X-Operator 头（与旧 filter-options 时序一致）
    if (sessionStatus === 'loading') return
    if (initialProjectAutoselected.current) return
    let active = true
    void fetchManagedProjectsCached<Array<{ id?: number | null; name?: string }>>(session)
      .then((payload) => {
        if (!active || initialProjectAutoselected.current) return
        const rows = payload.filter(
          (item): item is { id: number; name: string } =>
            typeof item.id === 'number' && item.id > 0 && typeof item.name === 'string'
        )
        // BLF-819 review 修复：头部已写入具体项目时不自动选第一个店铺，
        // 否则本 effect 会把用户在头部选的项目又覆盖回 rows[0]。
        if (rows.length > 0 && !gfProjectOwnedRef.current) {
          setProjectId(String(rows[0].id))
        }
        initialProjectAutoselected.current = true
        // 显式置位驱动首屏 fetch（不依赖 setState 附带重渲染）
        setProjectAutoselectDone(true)
      })
      .catch(() => {
        if (!active || initialProjectAutoselected.current) return
        initialProjectAutoselected.current = true
        setProjectAutoselectDone(true)
      })
    return () => {
      active = false
    }
  }, [session, sessionStatus])

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
    if (skuKeywordCommitted) params.set('sku_keyword', skuKeywordCommitted)
    if (orderIdKeywordCommitted) params.set('order_id_keyword', orderIdKeywordCommitted)
    if (asinKeywordCommitted) params.set('asin_keyword', asinKeywordCommitted)
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
    skuKeywordCommitted,
    orderIdKeywordCommitted,
    asinKeywordCommitted,
    dateFrom,
    dateTo,
    page,
    sortKey,
    sortDir,
  ])

  // ====== 拉取数据（list + stats 合并） ======
  const fetchData = useCallback(async () => {
    // 取消上一次还在飞的请求：快速筛选/翻页时只有最后一次生效，
    // 杜绝 N 次 list+stats 并发同时压到后端。
    fetchAbortRef.current?.abort()
    const ctrl = new AbortController()
    fetchAbortRef.current = ctrl

    setLoading(true)
    setErrorMessage(null)
    try {
      const params = buildQuery()
      // 单请求 /overview 一次拿 列表+统计，取代原先并行的 /list + /stats：
      // 后端不再在两个会话里对大表重复全扫描，消除 CPU/内存峰值。
      const res = await fetch(
        `/api/backend/api/v1/order-info/overview?${params.toString()}`,
        {
          cache: 'no-store',
          headers: buildBackendClientHeaders(session),
          signal: ctrl.signal,
        }
      )
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        throw new Error(txt || `订单数据加载失败 (${res.status})`)
      }
      const data = (await res.json()) as OrderOverviewResponse
      // 走到这里说明没被 abort，安全落 state
      setItems(data.items)
      setTotal(data.total)
      setStats(data.stats)
      // 新数据落定后清空行选择：选中态合计只对本页数据负责，跨页保留会算错
      setSelectedIds(new Set())
    } catch (e) {
      // 被新请求取代（abort）不算错误，忽略；否则才提示用户
      if (ctrl.signal.aborted) return
      setErrorMessage(e instanceof Error ? e.message : '数据加载失败')
    } finally {
      // 已被 abort 时不要动 loading，交给接管的新请求维护其加载态
      if (!ctrl.signal.aborted) setLoading(false)
    }
  }, [buildQuery, session])

  // 卸载时取消在飞请求，避免对已卸载组件 setState
  useEffect(() => {
    return () => {
      fetchAbortRef.current?.abort()
    }
  }, [])

  // 首屏默认近 7 天：仅在 URL 未预填日期时设置
  // 在 mount 后 effect 里 setState 而不是 useState 初值，
  // 避免 SSR pre-render 与 CSR hydrate 不一致导致 React hydration mismatch。
  const urlDatePrefilledRef = useRef(false)
  useEffect(() => {
    if (urlDatePrefilledRef.current) return
    const { from, to } = defaultLast7Days()
    setDateFrom(from)
    setDateTo(to)
  }, [])

  // ====== 副作用：任何筛选变化触发 fetch ======
  // gate 只看 autoselect 是否完成（manage 项目列表失败时也会放行，与旧逻辑等价），
  // 保证首屏 /overview 不会被任何前置加载永久拦住。
  // 首次加载时等待店铺自动选中后再 fetch，避免默认"全部店铺"拉全量数据慢查询。
  useEffect(() => {
    if (!initialProjectAutoselected.current) return
    // 250ms debounce：下拉/排序/日期/翻页连点时合并成一次请求，
    // 配合 fetchData 内的 abort，彻底消除筛选风暴下的并发堆积。
    // 手动 head 全局刷新按钮走 useHeaderRefresh 直调 fetchData（不受此 debounce 影响）。
    const timer = setTimeout(() => {
      void fetchData()
    }, 250)
    return () => clearTimeout(timer)
  }, [fetchData, projectId, projectAutoselectDone])

  // ====== 操作 handlers ======
  const handleResetFilters = () => {
    setProjectId(DEFAULT_PROJECT_VALUE)
    setFulfillmentChannels([])
    setOrderStatuses([])
    setCountries([])
    setCurrencies([])
    setSkuKeyword('')
    setSkuKeywordCommitted('')
    setOrderIdKeyword('')
    setOrderIdKeywordCommitted('')
    setAsinKeyword('')
    setAsinKeywordCommitted('')
    // 重置回退到默认 = 近 7 天（与首次加载默认一致），不是空=全部
    const { from, to } = defaultLast7Days()
    setDateFrom(from)
    setDateTo(to)
    setPage(1)
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const res = await fetch('/api/backend/api/v1/order-info/export', {
        method: 'POST',
        headers: buildBackendClientHeaders(session, { contentType: 'application/json' }),
        body: JSON.stringify({
          project_ids: projectId && projectId !== DEFAULT_PROJECT_VALUE ? [Number(projectId)] : [],
          fulfillment_channels: fulfillmentChannels,
          order_statuses: orderStatuses,
          countries,
          currencies,
          sku_keyword: skuKeywordCommitted || null,
          order_id_keyword: orderIdKeywordCommitted || null,
          asin_keyword: asinKeywordCommitted || null,
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
      notify({ type: 'success', title: '导出已开始', message: data.filename })
    } catch (e) {
      const msg = e instanceof Error ? e.message : '导出失败'
      setErrorMessage(msg)
      notify({ type: 'error', title: '导出失败', message: normalizeErrorMessage(e, '导出失败') })
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

  // ====== 行选择切换 ======
  const toggleRowSelected = (id: number, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) {
        next.add(id)
      } else {
        next.delete(id)
      }
      return next
    })
  }

  const pageSelectedCount = useMemo(
    () => items.reduce((acc, it) => acc + (selectedIds.has(it.id) ? 1 : 0), 0),
    [items, selectedIds]
  )
  const allPageSelected = items.length > 0 && pageSelectedCount === items.length

  const toggleAllPageSelected = (checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) {
        items.forEach((it) => next.add(it.id))
      } else {
        items.forEach((it) => next.delete(it.id))
      }
      return next
    })
  }

  // 选中态合计：金额口径 = Σ(item_price + shipping_price)，不重复乘 quantity
  const selectedAgg = useMemo(() => {
    let amount = 0
    let quantity = 0
    for (const it of items) {
      if (!selectedIds.has(it.id)) continue
      amount += it.item_price + it.shipping_price
      quantity += it.quantity
    }
    return { count: pageSelectedCount, amount, quantity }
  }, [items, selectedIds, pageSelectedCount])

  // ====== FBM 编辑：打开 / 局部刷新 ======
  const handleOpenEditDialog = (item: OrderItem) => {
    setEditingOrder(item)
    setDialogOpen(true)
  }

  const handleEditSaved = (updated: OrderEditResponsePayload) => {
    setItems((prev) =>
      prev.map((it) =>
        it.id === updated.id
          ? {
              ...it,
              carrier: updated.carrier,
              tracking_no: updated.tracking_no,
              shipped_at: updated.shipped_at,
              updated_by: updated.updated_by,
              updated_at: updated.updated_at,
            }
          : it
      )
    )
  }

  // ====== 复制订单号 ======
  const handleCopyOrderId = async (amazonOrderId: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(amazonOrderId)
      } else {
        // 兼容旧浏览器：textarea 兜底
        const ta = document.createElement('textarea')
        ta.value = amazonOrderId
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      notify({ type: 'success', title: '已复制订单号', message: amazonOrderId })
    } catch (err) {
      notify({
        type: 'error',
        title: '复制失败',
        message: normalizeErrorMessage(err, '浏览器拒绝复制'),
      })
    }
  }

  // 排序指示符：终端风格文字箭头（激活列 accent 色）
  const sortIndicator = (key: SortKey) =>
    sortKey === key ? (
      <span className="ml-0.5 text-term-accent">{sortDir === 'asc' ? '▲' : '▼'}</span>
    ) : null

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total])

  // 当前账号没有可见店铺：filterOptions 已加载完成且返回了 0 个项目。
  // 后端 _ensure_project_access_for_orders 在非 admin + operator 不在任一项目
  // 的 project_operator / assistant_operator token 里时，会返回空列表——
  // 这里把这条"权限投影层 = 0"的失败模式单独提示，避免用户误以为是「真没数据」。
  const hasNoAccessibleProjects = useMemo(
    () => !!filterOptions && filterOptions.projects.length === 0,
    [filterOptions]
  )

  // —— BLF-940 · Stage 2：head/页面 slot 去重 ——
  // 项目 / 站点 / 日期 = BLF-819 全局四件套，已由 TerminalHeader head 中段承担（pilot 路由含本路径），
  // 本页不再渲染重复控件（移除原「Console 工具栏」div）。其余页面独有维度（类型/状态/币种/搜索/
  // 清空/刷新）走 useHeaderSlot portal 进 head 中段，刷新走 head 全局按钮 + useHeaderRefresh。
  useHeaderRefresh(() => {
    void fetchData()
  }, { loading })

  // 页面独有维度的 head slot 控件（不与 head 全局四件套重叠的部分）
  const headerSlotControls = (
    <>
      <MultiSelect
        className={cn(TERM_TRIGGER, 'w-[120px]')}
        options={filterOptions?.fulfillment_channels ?? []}
        selected={fulfillmentChannels}
        onChange={setFulfillmentChannels}
        onOpen={ensureFilterOptions}
        placeholder={filterOptionsLoading ? '类型 · 加载中…' : '类型 · FBA/FBM'}
      />
      <MultiSelect
        className={cn(TERM_TRIGGER, 'w-[130px]')}
        options={filterOptions?.order_statuses ?? []}
        selected={orderStatuses}
        onChange={setOrderStatuses}
        onOpen={ensureFilterOptions}
        placeholder={filterOptionsLoading ? '状态 · 加载中…' : '状态 · 全部'}
      />
      <MultiSelect
        className={cn(TERM_TRIGGER, 'w-[110px]')}
        options={filterOptions?.currencies ?? []}
        selected={currencies}
        onChange={setCurrencies}
        onOpen={ensureFilterOptions}
        placeholder={filterOptionsLoading ? '币种 · 加载中…' : '币种 · 全部'}
      />
      <span className="mx-0.5 hidden h-4 w-px bg-term-border md:block" aria-hidden />
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-term-faint"
          aria-hidden
        />
        <Input
          value={orderIdKeyword}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setOrderIdKeyword(e.target.value)}
          placeholder="订单号 111-…"
          title="按订单号搜索"
          className={cn(TERM_INPUT, 'w-[150px] pl-7')}
        />
      </div>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-term-faint"
          aria-hidden
        />
        <Input
          value={skuKeyword}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setSkuKeyword(e.target.value)}
          placeholder="SKU"
          title="按 SKU 搜索"
          className={cn(TERM_INPUT, 'w-[130px] pl-7')}
        />
      </div>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-term-faint"
          aria-hidden
        />
        <Input
          value={asinKeyword}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setAsinKeyword(e.target.value)}
          placeholder="ASIN"
          title="按 ASIN 搜索"
          className={cn(TERM_INPUT, 'w-[120px] pl-7')}
        />
      </div>
      <button
        type="button"
        onClick={handleResetFilters}
        disabled={loading}
        className={cn(TERM_BUTTON, 'ml-auto')}
        title="清空全部筛选条件"
      >
        <X className="h-3 w-3" aria-hidden />
        清空筛选
      </button>
    </>
  )

  // BLF-940 · 桌面端（≥md）：head 中段挂载点 portal
  const headerSlotPortal = useHeaderSlot(
    <HeaderFilterControls isMobileView={false} controls={headerSlotControls} />
  )

  // BLF-940 · 移动端（<md）：正文顶部折叠筛选条（同上控件 + 清空）
  // 摘要 = 筛选状态文字，展开态用 grid-cols-2 排列
  const mobileFilterSummary = buildMobileFilterSummary({
    orderStatuses,
    fulfillmentChannels,
    currencies,
    orderIdKeyword,
    skuKeyword,
    asinKeyword,
  })
  const mobileFilterStrip = useMobileFilterStrip(
    <MobileFilterStrip summary={mobileFilterSummary} controls={headerSlotControls} />
  )

  // ====== 渲染 ======
  return (
    /*
     * BLF-817 Pattern A 布局：整页 h-full 锁死在 main 内容区高度内 ——
     * 文档（main 滚动容器）不出现滚动条，工具栏 + 底部聚合条 pinned，
     * 只有表格区独立滚动（sticky 表头 + 内部 overflow-auto）。
     */
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* 全局错误条（终端 warn/neg 样式） */}
      {errorMessage && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border border-term-neg/50 bg-term-neg/10 px-2 py-1 font-mono text-xs text-term-neg"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate" title={errorMessage}>
            ERR · {errorMessage}
          </span>
        </div>
      )}

      {/* 权限投影为空的醒目提示 */}
      {hasNoAccessibleProjects && (
        <div
          role="alert"
          aria-live="polite"
          className="flex shrink-0 items-start gap-2 border border-term-warn/50 bg-term-warn/10 px-2 py-1 font-mono text-xs text-term-warn"
        >
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <div className="space-y-0.5 leading-relaxed">
            <div>当前账号未关联任何店铺</div>
            <div className="text-term-muted">
              本页订单数据已按账号权限过滤——你的中文运营名未出现在任何店铺的「主运营」或「运营助理」字段里。请联系管理员补录后访问。
            </div>
          </div>
        </div>
      )}

      {/* BLF-940 · 筛选控件上移 head 中段（桌面）/ 正文顶部折叠条（移动端），
          原「Console 工具栏」div 已移除（项目/站点/日期由 head 全局四件套承担，重复消除）。
          详情见上方 headerSlotControls / headerSlotPortal / mobileFilterStrip 构造。 */}
      {headerSlotPortal}
      {mobileFilterStrip}

      {/* ====== 高密度订单大表面板：标题条 32px + 表格区独立滚动 ====== */}
      <section
        className="flex min-h-0 flex-1 flex-col border border-term-border bg-term-panel"
        aria-label="订单信息"
      >
        {/* 面板标题条 */}
        <header className="flex h-9 shrink-0 items-center gap-2 border-b border-term-border pl-2 pr-1.5">
          <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-term-muted">
            订单信息 <span className="text-term-faint">ORDER INFO</span>
          </h2>
          <span className="font-mono text-[11px] tabular-nums text-term-faint">
            {total.toLocaleString('zh-CN')} rows
          </span>
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={exporting || loading}
            className={cn(TERM_BUTTON, 'ml-auto')}
            title="按当前筛选条件导出 CSV"
          >
            {exporting ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            ) : (
              <ArrowDownToLine className="h-3 w-3" aria-hidden />
            )}
            导出 CSV
          </button>
        </header>

        {/* 表格独立滚动区（sticky 表头依赖此滚动容器） */}
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain term-scroll">
          <TermTable className="min-w-[1560px]" aria-label="订单列表">
            <TermTHead>
              <TermRow>
                <TermHead className="w-8 px-2">
                  <Checkbox
                    checked={items.length > 0 ? (allPageSelected ? true : pageSelectedCount > 0 ? 'indeterminate' : false) : false}
                    onCheckedChange={(checked) => toggleAllPageSelected(checked === true)}
                    disabled={items.length === 0}
                    aria-label={allPageSelected ? '取消全选本页' : '全选本页'}
                    className="h-3.5 w-3.5 translate-y-px rounded-none border-term-border-strong data-[state=checked]:border-term-accent"
                  />
                </TermHead>
                <TermHead>下单时间</TermHead>
                <TermHead>订单号</TermHead>
                <TermHead>SKU / ASIN</TermHead>
                <TermHead>产品</TermHead>
                <TermHead numeric className="cursor-pointer select-none" onClick={() => handleSort('quantity')}>
                  数量{sortIndicator('quantity')}
                </TermHead>
                <TermHead numeric className="cursor-pointer select-none" onClick={() => handleSort('item_price')}>
                  金额{sortIndicator('item_price')}
                </TermHead>
                <TermHead>收货地</TermHead>
                <TermHead>店铺</TermHead>
                <TermHead>类型</TermHead>
                <TermHead>状态</TermHead>
                <TermHead>物流</TermHead>
                <TermHead numeric>操作</TermHead>
              </TermRow>
            </TermTHead>
            <TermBody>
              {loading ? (
                <SkeletonRows />
              ) : errorMessage ? (
                <EmptyTableState
                  colSpan={COLUMN_COUNT}
                  message={`加载失败：${errorMessage} — 可点击工具栏「刷新」重试`}
                  className="bg-term-panel font-mono text-xs text-term-neg"
                />
              ) : items.length === 0 ? (
                <EmptyTableState
                  colSpan={COLUMN_COUNT}
                  message={
                    // 三档优先级：
                    // 1) 账号未关联任何店铺（filterOptions 已加载完成、projects 为空）
                    // 2) 当前筛选条件下无订单
                    // 3) 真实「暂无订单数据」
                    hasNoAccessibleProjects
                      ? '当前账号未关联任何店铺 — 请联系管理员把你的名字补录到目标店铺的「主运营」或「运营助理」字段'
                      : skuKeywordCommitted ||
                          orderIdKeywordCommitted ||
                          asinKeywordCommitted ||
                          projectId !== DEFAULT_PROJECT_VALUE ||
                          fulfillmentChannels.length > 0 ||
                          orderStatuses.length > 0 ||
                          countries.length > 0 ||
                          currencies.length > 0 ||
                          dateFrom ||
                          dateTo
                        ? '当前筛选条件下无订单 — 可调整筛选或点击「清空筛选」重置'
                        : '暂无订单数据 — 等待新的销售报告上传后重试'
                  }
                  className="bg-term-panel font-mono text-xs"
                />
              ) : (
                items.map((item, index) => {
                  const fullAddress = [
                    item.city,
                    item.state,
                    item.postal_code,
                    getCountryLabel(item.country),
                  ]
                    .filter(Boolean)
                    .join(', ')
                  const isFbm = item.fulfillment_channel === 'Merchant'
                  // 斑马纹：偶数行叠 raised 层级色（#1a1a1e）；hover 时被 term-hover 覆盖
                  const zebra = index % 2 === 1 ? 'bg-term-raised' : undefined
                  const totalAmount = item.item_price + item.shipping_price
                  return (
                    <TermRow key={item.id} className={zebra} aria-label={`订单 ${item.amazon_order_id} · ${item.project_name} · ${item.fulfillment_label}`}>
                      <TermCell className="px-2">
                        <Checkbox
                          checked={selectedIds.has(item.id)}
                          onCheckedChange={(checked) => toggleRowSelected(item.id, checked === true)}
                          aria-label={`选中订单 ${item.amazon_order_id}`}
                          className="h-3.5 w-3.5 translate-y-px rounded-none border-term-border-strong data-[state=checked]:border-term-accent"
                        />
                      </TermCell>
                      <TermCell tone="muted">
                        <div className="flex flex-col leading-tight">
                          <span>{formatBeijingTime(item.purchase_at_utc)}</span>
                          <span className="text-term-faint">PT {formatLocalDate(item.purchase_at_pt)}</span>
                        </div>
                      </TermCell>
                      <TermCell>
                        <div className="flex items-center gap-1">
                          <span title={`订单号 ${item.amazon_order_id}`}>{item.amazon_order_id}</span>
                          <button
                            type="button"
                            onClick={() => void handleCopyOrderId(item.amazon_order_id)}
                            className="inline-flex h-5 w-5 items-center justify-center text-term-faint transition-colors hover:text-term-text focus:outline-none focus:ring-1 focus:ring-term-accent"
                            aria-label={`复制订单号 ${item.amazon_order_id}`}
                            title="复制订单号"
                          >
                            <Copy className="h-3 w-3" aria-hidden />
                          </button>
                        </div>
                      </TermCell>
                      <TermCell>
                        <div className="flex flex-col leading-tight">
                          {item.sku ? (
                            <Link
                              href={(() => {
                                const params = new URLSearchParams()
                                if (item.project_name) params.set('project_name', item.project_name)
                                params.set('sku', item.sku)
                                if (item.asin) params.set('asin', item.asin)
                                return `/dashboard/operations/sku-info?${params.toString()}`
                              })()}
                              className="hover:text-term-accent hover:underline"
                              title="跳转到 SKU 信息页面（带入项目 + SKU + ASIN）"
                            >
                              {item.sku}
                            </Link>
                          ) : (
                            <span className="text-term-faint">—</span>
                          )}
                          {item.asin ? (
                            <Link
                              href={(() => {
                                const params = new URLSearchParams()
                                if (item.project_name) params.set('project_name', item.project_name)
                                if (item.sku) params.set('sku', item.sku)
                                params.set('asin', item.asin)
                                return `/dashboard/operations/sku-info?${params.toString()}`
                              })()}
                              className="text-term-muted hover:text-term-accent hover:underline"
                              title="跳转到 SKU 信息页面（按 ASIN 查询）"
                            >
                              ASIN {item.asin}
                            </Link>
                          ) : (
                            <span className="text-term-faint">ASIN —</span>
                          )}
                        </div>
                      </TermCell>
                      <TermCell className="max-w-[260px]">
                        <span className="line-clamp-2 whitespace-normal" title={item.product_name ?? ''}>
                          {item.product_name ?? '—'}
                        </span>
                      </TermCell>
                      <TermCell numeric>{item.quantity}</TermCell>
                      <TermCell numeric>
                        <div className="flex flex-col leading-tight">
                          <span>
                            {fmtAmount(totalAmount)} {item.currency ?? ''}
                          </span>
                          {item.shipping_price > 0 && (
                            <span className="text-term-faint">+ 运费 {fmtAmount(item.shipping_price)}</span>
                          )}
                        </div>
                      </TermCell>
                      <TermCell
                        tone="muted"
                        className="max-w-[200px]"
                        title={
                          fullAddress
                            ? `${fullAddress} · 服务等级：${item.ship_service_level ?? '—'} · 数据源：source_file #${item.source_file_id}`
                            : undefined
                        }
                      >
                        <span className="line-clamp-1 whitespace-normal">{fullAddress || '—'}</span>
                      </TermCell>
                      <TermCell>
                        <Link
                          href={`/dashboard/system/project-info?configure=${item.project_id}`}
                          className="inline-flex items-center gap-1 hover:text-term-accent hover:underline"
                          title={`跳转到「${item.project_name}」的项目设置`}
                        >
                          {item.project_name}
                          <ExternalLink className="h-3 w-3 text-term-faint" aria-hidden />
                        </Link>
                        {item.brand_name && (
                          <div className="text-term-faint">{item.brand_name}</div>
                        )}
                      </TermCell>
                      <TermCell>
                        <span
                          className={cn(
                            'font-medium',
                            fulfillmentTone(item.fulfillment_label) === 'accent'
                              ? 'text-term-accent'
                              : 'text-term-muted'
                          )}
                        >
                          {item.fulfillment_label}
                        </span>
                      </TermCell>
                      <TermCell>
                        <StatusPill
                          label={getOrderStatusLabel(item.order_status)}
                          tone={getOrderStatusTone(item.order_status)}
                        />
                      </TermCell>
                      <TermCell tone="muted">
                        {isFbm ? (
                          <div className="flex flex-col leading-tight" aria-label="FBM 物流信息">
                            {item.carrier && <span className="text-term-text">{item.carrier}</span>}
                            {item.tracking_no && (
                              <span className="text-term-muted" title={item.tracking_no}>
                                {item.tracking_no.length > 14
                                  ? `${item.tracking_no.slice(0, 14)}…`
                                  : item.tracking_no}
                              </span>
                            )}
                            {item.shipped_at && (
                              <span className="text-term-faint">发货 {formatLocalDate(item.shipped_at)}</span>
                            )}
                            {!item.carrier && !item.tracking_no && !item.shipped_at && (
                              <span className="italic text-term-faint">未填写</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-term-faint">—</span>
                        )}
                      </TermCell>
                      <TermCell numeric>
                        {isFbm ? (
                          <button
                            type="button"
                            onClick={() => handleOpenEditDialog(item)}
                            disabled={loading}
                            className="inline-flex items-center gap-1 font-mono text-xs text-term-accent transition-colors hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                            title="编辑 FBM 物流信息"
                            aria-label={`编辑订单 ${item.amazon_order_id} 的物流信息`}
                          >
                            <Pencil className="h-3 w-3" aria-hidden />
                            编辑
                          </button>
                        ) : (
                          <span className="text-term-faint">—</span>
                        )}
                      </TermCell>
                    </TermRow>
                  )
                })
              )}
            </TermBody>
          </TermTable>
        </div>
      </section>

      {/* ====== 底部 pinned 聚合分页条：总单量 / 总金额 / 选中态合计 + 翻页 ====== */}
      <footer className="flex h-8 shrink-0 items-center gap-3 border border-term-border bg-term-raised px-2 font-mono text-sm tabular-nums text-term-muted">
        <span>
          Σ 单量 <span className="text-term-text">{stats ? stats.total_orders.toLocaleString('zh-CN') : '—'}</span>
        </span>
        <span>
          Σ 金额{' '}
          <span className="text-term-text">
            {stats ? `${fmtAmount(stats.total_amount)} ${stats.currency ?? ''}` : '—'}
          </span>
        </span>
        <span className="hidden lg:inline">
          FBA <span className="text-term-text">{stats ? stats.fba_count.toLocaleString('zh-CN') : '—'}</span>
          {' / '}
          FBM <span className="text-term-text">{stats ? stats.fbm_count.toLocaleString('zh-CN') : '—'}</span>
        </span>
        {selectedAgg.count > 0 && (
          <span className="border border-term-accent/40 bg-term-accent/10 px-1.5 py-0.5 text-term-accent">
            已选 {selectedAgg.count} 行 · Σ 金额 {fmtAmount(selectedAgg.amount)} · Σ 数量{' '}
            {selectedAgg.quantity.toLocaleString('zh-CN')}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <span>
            共 <span className="text-term-text">{total.toLocaleString('zh-CN')}</span> 行 · 第{' '}
            <span className="text-term-text">{page}</span>/{totalPages} 页 · 每页 {PAGE_SIZE}
          </span>
          <button
            type="button"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="flex h-5 items-center border border-term-border bg-term-panel px-1.5 text-[11px] transition-colors hover:border-term-border-strong hover:text-term-text disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="上一页"
          >
            ◀ 上一页
          </button>
          <button
            type="button"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="flex h-5 items-center border border-term-border bg-term-panel px-1.5 text-[11px] transition-colors hover:border-term-border-strong hover:text-term-text disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="下一页"
          >
            下一页 ▶
          </button>
        </span>
      </footer>

      {/* ====== FBM 编辑 Dialog ====== */}
      {editingOrder && (
        <OrderEditDialog
          open={dialogOpen}
          onOpenChange={(open) => {
            setDialogOpen(open)
            if (!open) {
              // 关闭后清掉 editingOrder，避免下次打开残留旧值
              setTimeout(() => setEditingOrder(null), 150)
            }
          }}
          order={{
            id: editingOrder.id,
            amazon_order_id: editingOrder.amazon_order_id,
            sku: editingOrder.sku,
            asin: editingOrder.asin,
            product_name: editingOrder.product_name,
            project_name: editingOrder.project_name,
            quantity: editingOrder.quantity,
            country: editingOrder.country,
          }}
          authHeaders={() =>
            buildBackendClientHeaders(session, { contentType: 'application/json' })
          }
          defaultUpdatedBy={currentUserName}
          onSaved={(updated) => {
            handleEditSaved(updated)
            setEditingOrder(null)
          }}
        />
      )}
    </div>
  )
}

// ======================== 局部子组件 ========================

/** 加载骨架：13 列占位、32px 行高对齐真实行高 */
function SkeletonRows({ rows = 12 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr key={`order-skeleton-${rowIndex}`} className="border-b border-term-border">
          <td colSpan={COLUMN_COUNT} className="h-8 px-2 align-middle">
            <Skeleton
              className={cn(
                'h-3 rounded-none',
                rowIndex % 3 === 0 ? 'w-1/2' : rowIndex % 3 === 1 ? 'w-2/3' : 'w-1/3'
              )}
            />
          </td>
        </tr>
      ))}
    </>
  )
}

/**
 * BLF-927：URL 预填支持（`?order_statuses=Pending&order_statuses=Shipped`，逗号分隔亦可）。
 * Dashboard 订单流面板等入口跳转时用 query 告知本页初始状态筛选；
 * 与 BLF-819 全局头部筛选（g* 参数）互不冲突——本机制只读 order_statuses。
 * useSearchParams 在静态预渲染下需要 Suspense 边界（Next.js 构建要求）。
 */
export default function OrderInfoPage() {
  return (
    <Suspense fallback={null}>
      <OrderInfoPageInner />
    </Suspense>
  )
}
