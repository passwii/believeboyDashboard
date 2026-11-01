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
import { MultiSelect, type Option } from '@/components/ui/multi-select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { buildBackendClientHeaders } from '@/lib/backend-auth'
import { pickSessionDisplayName } from '@/lib/auth/display-name'
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
import { TERM_BUTTON, TERM_INPUT, TERM_TRIGGER } from '@/components/terminal/term-controls'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { normalizeErrorMessage, parseResponseError } from '@/lib/error-utils'
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

/** 页面内工具按钮基类；与 V3 Terminal h-9 控件保持同档。 */
const TERM_BODY_BUTTON =
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
  // BLF-1019：加载失败可重试（null + error 标记），不再用空壳永久锁死下拉。
  const [filterOptionsError, setFilterOptionsError] = useState(false)
  const filterOptionsRequested = useRef(false)
  // 店铺自动选中是否已落定（manage 项目列表 resolve 后置 true，驱动首屏 fetch）
  const [projectAutoselectDone, setProjectAutoselectDone] = useState(false)
  const [projectListLoading, setProjectListLoading] = useState(false)
  const [projectListError, setProjectListError] = useState(false)
  const [projectSelectionExplicit, setProjectSelectionExplicit] = useState(false)
  const [items, setItems] = useState<OrderItem[]>([])
  const [dataQueryKey, setDataQueryKey] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [stats, setStats] = useState<OrderStats | null>(null)
  const [statsQueryKey, setStatsQueryKey] = useState<string | null>(null)
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
      setProjectSelectionExplicit(true)
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
      setProjectSelectionExplicit(true)
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

    const orderIdParam = searchParams.get('order_id_keyword')?.trim()
    if (orderIdParam) {
      setOrderIdKeyword(orderIdParam)
      changed = true
    }

    if (changed) setPage(1)
    urlPrefillApplied.current = true
  }, [searchParams])

  // 当前请求按 query key 去重；generation 防止忽略 AbortSignal 的旧响应覆盖新筛选。
  const activeRequestRef = useRef<{
    key: string
    queryKey: string
    generation: number
    controller: AbortController
  } | null>(null)
  const requestGenerationRef = useRef(0)
  const fetchScheduleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetchScheduleIntentRef = useRef<{ requestKey: string; includeStats: boolean } | null>(null)

  // 关键字即时提交到 query state；统一由下方 query scheduler 做 250ms debounce。
  useEffect(() => {
    setSkuKeywordCommitted(skuKeyword.trim())
    setOrderIdKeywordCommitted(orderIdKeyword.trim())
    setAsinKeywordCommitted(asinKeyword.trim())
    setPage(1)
  }, [skuKeyword, orderIdKeyword, asinKeyword])

  // 当前登录用户名（默认填到 updated_by）。
  // BLF-1441：只取 user_accounts.full_name；没填姓名时留空让用户自己写，
  // 不拿运营名 / 登录名 / 邮箱冒充（那是上一版的口径）。
  const currentUserName = useMemo(
    () => pickSessionDisplayName(session?.user) ?? undefined,
    [session]
  )

  // ====== 筛选项按需加载（首次打开筛选下拉触发，失败可重试） ======
  // BLF-1019：collect_filter_options 在大表上 3 个 distinct 全表扫会拖到 3–6s，
  // 曾因 proxy 默认 5s 超时 + 一次性空壳 fallback 导致下拉永久空白。
  // 现语义：成功才锁存；失败保持 null + error 标记，下次打开重试；
  // session 未落定时不发注定 401 的请求，等下次打开。
  // 客户端超时与 proxy stats 档（15s，见 backend-proxy-timeout-policy）对齐。
  const ensureFilterOptions = useCallback(() => {
    if (filterOptionsRequested.current || filterOptions) return
    // session 落定前不发请求：此时 X-Operator 缺失，后端必 401，
    // 发了也只会烧掉一次机会（现可重试，但省一次无用请求）。
    if (sessionStatus === 'loading') return
    filterOptionsRequested.current = true
    const ctrl = new AbortController()
    const timeoutId = setTimeout(() => ctrl.abort(), 15000)
    async function load() {
      setFilterOptionsLoading(true)
      setFilterOptionsError(false)
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
        // 超时 / 失败不弹红色错误（数据表格不受影响），但释放锁存让下次打开重试。
        filterOptionsRequested.current = false
        setFilterOptionsError(true)
      } finally {
        clearTimeout(timeoutId)
        setFilterOptionsLoading(false)
      }
    }
    void load()
  }, [session, sessionStatus, filterOptions])
  // ====== 首次加载：店铺自动选中改走带缓存的 manage 项目列表 ======
  // 项目列表失败时不能静默放行 DEFAULT 全店铺查询；显式项目范围（含用户主动选「全部」）除外。
  const loadManagedProjects = useCallback(
    async (isActive: () => boolean = () => true) => {
      setProjectListLoading(true)
      try {
        const payload = await fetchManagedProjectsCached<Array<{ id?: number | null; name?: string }>>(session)
        if (!isActive()) return
        const rows = payload.filter(
          (item): item is { id: number; name: string } =>
            typeof item.id === 'number' && item.id > 0 && typeof item.name === 'string'
        )
        // 头部或 URL 已明确项目范围时，自动选店铺不能覆盖用户选择。
        if (rows.length > 0 && !gfProjectOwnedRef.current) {
          setProjectId(String(rows[0].id))
        }
        setProjectListError(false)
      } catch {
        if (!isActive()) return
        setProjectListError(true)
      } finally {
        if (isActive()) {
          initialProjectAutoselected.current = true
          setProjectAutoselectDone(true)
          setProjectListLoading(false)
        }
      }
    },
    [session]
  )

  useEffect(() => {
    // 等 session 落定再拉项目列表，保证请求带上 X-Operator 头。
    if (sessionStatus === 'loading' || initialProjectAutoselected.current) return
    let active = true
    void loadManagedProjects(() => active)
    return () => {
      active = false
    }
  }, [loadManagedProjects, sessionStatus])

  const handleRetryProjectList = useCallback(() => {
    if (projectListLoading) return
    void loadManagedProjects()
  }, [loadManagedProjects, projectListLoading])

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

  // 按页码区分页面数据请求：第一页返回 overview + stats，后续页走 list-only，
  // 并复用同一筛选条件下第一页统计。排序/页码不影响 stats key。
  const requestQuery = useMemo(() => buildQuery().toString(), [buildQuery])
  const authScopeKey = JSON.stringify(session?.user ?? null)
  const statsKey = useMemo(() => {
    const params = new URLSearchParams(requestQuery)
    params.delete('page')
    params.delete('page_size')
    params.delete('sort_by')
    params.delete('sort_dir')
    return `${params.toString()}::${authScopeKey}`
  }, [requestQuery, authScopeKey])
  const requestKey = `${requestQuery}::${authScopeKey}`
  const requestKeyRef = useRef(requestKey)
  requestKeyRef.current = requestKey
  const hasCurrentData = dataQueryKey === requestKey
  const currentStats = statsQueryKey === statsKey ? stats : null

  // ====== 拉取数据：首屏 overview，后续页 list-only ======
  const fetchData = useCallback(async (includeStats = false) => {
    // 项目列表不可用时禁止 refresh 等旁路触发隐式全店铺请求。
    if ((projectListLoading || projectListError) && !projectSelectionExplicit) return

    const endpoint = includeStats || statsQueryKey !== statsKey ? 'overview' : 'list'
    const key = `${requestKey}::${endpoint}`
    if (activeRequestRef.current?.key === key) return
    activeRequestRef.current?.controller.abort()

    const controller = new AbortController()
    const generation = ++requestGenerationRef.current
    activeRequestRef.current = { key, queryKey: requestKey, generation, controller }
    setLoading(true)
    setErrorMessage(null)

    try {
      const res = await fetch(
        `/api/backend/api/v1/order-info/${endpoint}?${requestQuery}`,
        {
          cache: 'no-store',
          headers: buildBackendClientHeaders(session),
          signal: controller.signal,
        }
      )
      if (!res.ok) {
        throw new Error(
          await parseResponseError(res, `订单数据加载失败 (${res.status})`, {
            stripDetailCodePrefix: true,
          })
        )
      }
      const data = (await res.json()) as OrderListResponse & Partial<Pick<OrderOverviewResponse, 'stats'>>
      if (
        controller.signal.aborted ||
        generation !== requestGenerationRef.current ||
        requestKey !== requestKeyRef.current
      ) return

      setItems(data.items)
      setDataQueryKey(requestKey)
      setTotal(data.total)
      if (endpoint === 'overview' && data.stats) {
        setStats(data.stats)
        setStatsQueryKey(statsKey)
      }
      // 新数据落定后清空行选择：选中态合计只对本页数据负责，跨页保留会算错
      setSelectedIds(new Set())
    } catch (e) {
      // 被新请求取代（abort）或 generation 过期不算错误，忽略；已有成功数据留在表格中。
      if (
        controller.signal.aborted ||
        generation !== requestGenerationRef.current ||
        requestKey !== requestKeyRef.current
      ) return
      setErrorMessage(e instanceof Error ? e.message : '数据加载失败')
    } finally {
      if (generation === requestGenerationRef.current) {
        activeRequestRef.current = null
        setLoading(false)
      }
    }
  }, [projectListError, projectListLoading, projectSelectionExplicit, requestKey, requestQuery, session, statsKey, statsQueryKey])

  // 调度器保持稳定，避免 stats 更新导致 query effect 再次排队同一页请求。
  const fetchDataRef = useRef(fetchData)
  fetchDataRef.current = fetchData

  const clearScheduledFetch = useCallback(() => {
    if (fetchScheduleTimerRef.current) clearTimeout(fetchScheduleTimerRef.current)
    fetchScheduleTimerRef.current = null
    fetchScheduleIntentRef.current = null
  }, [])

  // 筛选 debounce、翻页和手动刷新共用一个调度器；强制统计意图只对排队时的 query/page 生效。
  const scheduleFetch = useCallback((delayMs = 250, includeStats = false) => {
    clearScheduledFetch()
    const intent = { requestKey, includeStats }
    fetchScheduleIntentRef.current = intent
    fetchScheduleTimerRef.current = setTimeout(() => {
      fetchScheduleTimerRef.current = null
      if (fetchScheduleIntentRef.current !== intent) return
      fetchScheduleIntentRef.current = null
      if (intent.requestKey !== requestKeyRef.current) return
      void fetchDataRef.current(intent.includeStats)
    }, delayMs)
  }, [clearScheduledFetch, requestKey])

  // 卸载时取消 debounce 与在飞请求，避免后台请求或已卸载组件更新状态。
  useEffect(() => {
    return () => {
      clearScheduledFetch()
      activeRequestRef.current?.controller.abort()
      activeRequestRef.current = null
      requestGenerationRef.current += 1
    }
  }, [clearScheduledFetch])

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

  // ====== 副作用：查询 key 变化时统一 debounce，并立即使旧请求失效 ======
  // 首次加载等待项目自动选择；项目列表失败时阻止隐式全店铺查询。
  useEffect(() => {
    const activeRequest = activeRequestRef.current
    if (activeRequest && activeRequest.queryKey !== requestKey) {
      activeRequest.controller.abort()
      activeRequestRef.current = null
      requestGenerationRef.current += 1
    }

    if (!initialProjectAutoselected.current) return
    if ((projectListLoading || projectListError) && !projectSelectionExplicit) {
      activeRequestRef.current?.controller.abort()
      activeRequestRef.current = null
      requestGenerationRef.current += 1
      setLoading(false)
      return
    }

    scheduleFetch(250)
    return clearScheduledFetch
  }, [
    requestKey,
    scheduleFetch,
    clearScheduledFetch,
    projectAutoselectDone,
    projectListLoading,
    projectListError,
    projectSelectionExplicit,
  ])

  // ====== 操作 handlers ======
  const handleResetFilters = () => {
    // 只清当前页的订单条件；全局项目 / 站点 / 日期由 Header 筛选器管理。
    setFulfillmentChannels([])
    setOrderStatuses([])
    setCurrencies([])
    setSkuKeyword('')
    setSkuKeywordCommitted('')
    setOrderIdKeyword('')
    setOrderIdKeywordCommitted('')
    setAsinKeyword('')
    setAsinKeywordCommitted('')
    setPage(1)
  }

  const handleExport = async () => {
    if ((projectListLoading || projectListError) && !projectSelectionExplicit) return
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
        throw new Error(
          await parseResponseError(res, `导出失败 (${res.status})`, {
            stripDetailCodePrefix: true,
          })
        )
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

  // 当前账号没有可见店铺：filterOptions 成功加载完成且返回了 0 个项目。
  // 后端 _ensure_project_access_for_orders 在非 admin + operator 不在任一项目
  // 的 project_operator / assistant_operator token 里时，会返回空列表——
  // 这里把这条"权限投影层 = 0"的失败模式单独提示，避免用户误以为是「真没数据」。
  // BLF-1019：加载失败（filterOptionsError / null）时不误报，避免把"请求超时"
  // 说成"未关联店铺"误导用户找管理员。
  const hasNoAccessibleProjects = useMemo(
    () => !!filterOptions && !filterOptionsError && filterOptions.projects.length === 0,
    [filterOptions, filterOptionsError]
  )

  // 项目 / 站点 / 日期由全局 TerminalHeader 管理；本页筛选留在订单面板内。
  // 刷新仍复用 TerminalHeader 的全局刷新按钮。
  useHeaderRefresh(() => {
    scheduleFetch(0, true)
  }, { loading })

  // 页面专属筛选：按属性和精确查找两组展示在订单面板内。
  const pageFilterSelects = (
    <>
      <MultiSelect
        className={cn(TERM_TRIGGER, 'w-full min-w-0')}
        options={filterOptions?.fulfillment_channels ?? []}
        selected={fulfillmentChannels}
        onChange={setFulfillmentChannels}
        onOpen={ensureFilterOptions}
        placeholder={filterOptionsLoading ? '类型 · 加载中…' : filterOptionsError ? '类型 · 加载失败，点开重试' : '类型 · FBA/FBM'}
      />
      <MultiSelect
        className={cn(TERM_TRIGGER, 'w-full min-w-0')}
        options={filterOptions?.order_statuses ?? []}
        selected={orderStatuses}
        onChange={setOrderStatuses}
        onOpen={ensureFilterOptions}
        placeholder={filterOptionsLoading ? '状态 · 加载中…' : filterOptionsError ? '状态 · 加载失败，点开重试' : '状态 · 全部'}
      />
      <MultiSelect
        className={cn(TERM_TRIGGER, 'w-full min-w-0')}
        options={filterOptions?.currencies ?? []}
        selected={currencies}
        onChange={setCurrencies}
        onOpen={ensureFilterOptions}
        placeholder={filterOptionsLoading ? '币种 · 加载中…' : filterOptionsError ? '币种 · 加载失败，点开重试' : '币种 · 全部'}
      />
    </>
  )

  const pageFilterSearches = [
    { label: '按订单号搜索', placeholder: '订单号 111-…', value: orderIdKeyword, onChange: setOrderIdKeyword },
    { label: '按 SKU 搜索', placeholder: 'SKU', value: skuKeyword, onChange: setSkuKeyword },
    { label: '按 ASIN 搜索', placeholder: 'ASIN', value: asinKeyword, onChange: setAsinKeyword },
  ].map(({ label, placeholder, value, onChange }) => (
    <div key={label} className={cn('min-w-0', label === '按订单号搜索' && 'col-span-2 sm:col-span-1')}>
      <label className="relative block min-w-0">
        <span className="sr-only">{label}</span>
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-term-faint" aria-hidden />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          title={label}
          className={cn(TERM_INPUT, 'w-full min-w-0 pl-7 pr-2 text-xs')}
        />
      </label>
    </div>
  ))

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

      {projectListError && (
        <div
          role="alert"
          aria-live="polite"
          className="flex shrink-0 items-center gap-2 border border-term-warn/50 bg-term-warn/10 px-2 py-1 font-mono text-xs text-term-warn"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            {projectSelectionExplicit
              ? '店铺列表加载失败；仍按你明确选择的项目范围查询。'
              : '店铺列表加载失败，已暂停订单查询以避免默认查询全部店铺。'}
          </span>
          <button
            type="button"
            onClick={handleRetryProjectList}
            disabled={projectListLoading}
            className="shrink-0 border border-term-warn/60 px-2 py-0.5 text-term-warn hover:bg-term-warn/10 disabled:opacity-50"
            aria-label="重试店铺列表"
          >
            {projectListLoading ? '重试中…' : '重试'}
          </button>
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
              本页订单数据已按账号权限过滤——你的姓名未出现在任何店铺的「主运营」或「运营助理」字段里。请联系管理员补录后访问。
            </div>
          </div>
        </div>
      )}

      {/* ====== 高密度订单大表面板：筛选区常驻，表格区独立滚动 ====== */}
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
            disabled={exporting || loading || ((projectListLoading || projectListError) && !projectSelectionExplicit)}
            className={cn(TERM_BODY_BUTTON, 'ml-auto')}
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

        <div
          role="group"
          aria-label="订单筛选"
          className="shrink-0 border-b border-term-border bg-term-panel px-2 py-2"
        >
          <div className="grid gap-2 border-b border-term-border pb-2 lg:grid-cols-[5.5rem_minmax(0,1fr)] lg:items-center">
            <span className="font-mono text-[10px] leading-4 text-term-muted">订单属性</span>
            <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
              {pageFilterSelects}
              <button
                type="button"
                onClick={handleResetFilters}
                disabled={loading}
                className={cn(TERM_BUTTON, 'w-full justify-center px-2')}
                title="清空订单筛选条件"
              >
                <X className="h-3 w-3" aria-hidden />
                清空订单筛选
              </button>
            </div>
          </div>
          <div className="grid gap-2 pt-2 lg:grid-cols-[5.5rem_minmax(0,1fr)] lg:items-center">
            <span className="font-mono text-[10px] leading-4 text-term-muted">订单查找</span>
            <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3">{pageFilterSearches}</div>
          </div>
        </div>

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
              {loading && !hasCurrentData ? (
                <SkeletonRows />
              ) : projectListError && !projectSelectionExplicit ? (
                <EmptyTableState
                  colSpan={COLUMN_COUNT}
                  message="店铺列表加载失败 — 已暂停订单查询，请重试"
                  className="bg-term-panel font-mono text-xs text-term-warn"
                />
              ) : errorMessage && !hasCurrentData ? (
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
                        ? '当前筛选条件下无订单 — 可调整条件或点击「清空订单筛选」重置订单条件'
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
                      <TermCell numeric className="tabular-nums">{item.quantity}</TermCell>
                      <TermCell numeric className="tabular-nums">
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
          Σ 单量 <span className="text-term-text">{currentStats ? currentStats.total_orders.toLocaleString('zh-CN') : '—'}</span>
        </span>
        <span>
          Σ 金额{' '}
          <span className="text-term-text">
            {currentStats ? `${fmtAmount(currentStats.total_amount)} ${currentStats.currency ?? ''}` : '—'}
          </span>
        </span>
        <span className="hidden lg:inline">
          FBA <span className="text-term-text">{currentStats ? currentStats.fba_count.toLocaleString('zh-CN') : '—'}</span>
          {' / '}
          FBM <span className="text-term-text">{currentStats ? currentStats.fbm_count.toLocaleString('zh-CN') : '—'}</span>
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
