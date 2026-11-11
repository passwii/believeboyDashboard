'use client'

import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { DateRange } from 'react-day-picker'
import {
  Boxes,
  Download,
  Loader2,
  MessageSquare,
  Package,
  Sparkles,
  Table2,
  Tags,
  TrendingUp,
  Trophy,
  type LucideIcon,
} from 'lucide-react'
import { useSession } from 'next-auth/react'
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from 'recharts'
import type { Worksheet } from 'exceljs'

import { Badge } from '@/components/ui/badge'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { DataTableCard, DataTableCardHeader, DataTableCardBody } from '@/components/ui/data-card'
import { EmptyTableState } from '@/components/ui/empty-state'
import {
  DirectionalTabTransition,
  SlidingTabsTrigger,
  TabsMotionGroup,
} from '@/components/ui/tab-motion'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ColGroup,
  STICKY_TOP_ROW,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { fetchOpsJsonCached } from '@/lib/ops-client-cache'
import { useUrlParam } from '@/lib/hooks/use-url-param'
import { useAutoSelectFirstProject } from '@/lib/hooks/use-auto-select-first-project'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'
import {
  HeaderSlotDateRange,
  HeaderSlotSelect,
  TERM_HEADER_W_MD,
  TERM_HEADER_W_SM,
  TERM_HEADER_W_XL,
} from '@/components/terminal/header-filter-suite'
import {
  useHeaderRefresh,
  useHeaderSlot,
  useMobileFilterStrip,
} from '@/components/terminal/terminal-header-slot'
import { useNotifications } from '@/components/notifications'
import { applyBorder, applyDataRowBanding, applyHeaderBorder } from '@/lib/excel-styles'
import { getCountryLabel } from '@/lib/country'
import { cn } from '@/lib/utils'
import { downloadBlob } from '@/lib/download-blob'
import { useSmoothRefresh } from '@/hooks/use-smooth-refresh'
import { RAW_DISPLAY_LIMIT, RETURN_RAW_COLUMNS, type ReturnRawRow } from './return-raw-columns'
import styles from './return-analysis-warm.module.css'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'

const API_BASE = '/api/backend/api/v1'

type CountryOption = 'US' | 'DE' | 'UK'
type ViewTab =
  | 'rankings'
  | 'reason'
  | 'trend'
  | 'product-status'
  | 'inventory-status'
  | 'feedback'
  | 'summary'
  | 'raw'
const VIEW_TAB_ORDER: ViewTab[] = [
  'rankings',
  'reason',
  'trend',
  'product-status',
  'inventory-status',
  'feedback',
  'summary',
  'raw',
]

type ProjectOption = {
  id: number
  name: string
}

/**
 * Top 退货原因磁贴的展示值（BLF-1074，二段式收尾于 BLF-1081）。
 *
 * 只取后端 `summary.top_return_reason_display`——它由后端统一的
 * `translate_return_field("reason", ...)` 产出，与 `reason_rows[].reason_display`
 * 同源（含 `DAMAGED_BY_FC` / `NO_REASON_GIVEN` / `NOT_COMPATIBLE` 等 code）。
 *
 * 后端译文范围是**有界**的——FBA 生产库实测 code + FBA 文档补充项，
 * **不是 Amazon 全集**：MFN / Buy with Prime / `TA-CR-*` / `UND-*` 等其他域 code
 * 不在覆盖承诺内，会原样返回英文。边界以
 * `backend/app/constants/return_translations.py` 的模块 docstring 为准；
 * 本页面只透传后端结果，不为任何 code 自行造译文，「后端没译」不等于「这里漏译」。
 *
 * 不在此处维护任何本地 code→中文对照表：曾有一份 14 项的本地表，只覆盖极少 code，
 * 导致其余 code 裸露英文（BLF-1074）。既然后端两个构造点（`analysis.py`）在
 * `reason_rows` 非空时总会同时填 `top_return_reason` 与 `top_return_reason_display`，
 * 本地兜底分支恒不可达，故连同该表一并删除，避免日后被重新触达时静默重演旧 bug。
 */
function topReturnReasonDisplay(summary: ReturnAnalysisSummary): string {
  return summary.top_return_reason_display ?? '--'
}

const COUNTRY_TIMEZONE_MAP: Record<string, string> = {
  US: 'America/Los_Angeles',
  DE: 'Europe/Berlin',
  UK: 'Europe/London',
}

/** 站点选项：退货分析仅支持 US/DE/UK（无 ALL，保持页面原生选项集） */
const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
]

function getTodayInTimezone(country: string): Date {
  const tz = COUNTRY_TIMEZONE_MAP[country] ?? 'UTC'
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz })
  const now = new Date()
  const [y, m, d] = formatter.format(now).split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

function lastSevenDaysRange(country: string): DateRange {
  const today = getTodayInTimezone(country)
  const end = today
  const start = new Date(today)
  start.setDate(start.getDate() - 6)
  return { from: start, to: end }
}

function formatYMD(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function normalizeDateRange(range?: DateRange) {
  if (!range?.from || !range?.to) return undefined
  const from = new Date(range.from)
  const to = new Date(range.to)
  from.setHours(0, 0, 0, 0)
  to.setHours(0, 0, 0, 0)
  return { from, to }
}

// API Response Types
type ReturnRankingItem = {
  sku: string
  asin: string | null
  product_name: string | null
  total_quantity: number
  return_count: number
  sales_quantity: number
  return_rate: number
  // 退货周期(天)= 退货日期 - 原单日期,按 (order_id, sku) 精准匹配
  avg_return_cycle_days: number | null
  min_return_cycle_days: number | null
  max_return_cycle_days: number | null
}

type ReturnReasonItem = {
  reason: string
  reason_display: string
  total_quantity: number
  return_count: number
  percentage: number
}

type ReturnTrendItem = {
  date: string
  total_quantity: number
  return_count: number
  sales_quantity: number
  sales_amount: number
  return_rate: number
}

type DispositionItem = {
  detailed_disposition: string
  disposition_display: string
  total_quantity: number
  return_count: number
  percentage: number
}

type StatusItem = {
  status: string
  status_display: string
  total_quantity: number
  return_count: number
  percentage: number
}

type CustomerFeedbackItem = {
  sku: string
  order_id: string
  reason: string
  reason_display: string
  customer_comment: string
  return_date: string
}

type WeekdayItem = {
  weekday: number
  weekday_display: string
  return_count: number
  percentage: number
}

type FulfillmentCenterItem = {
  fulfillment_center_id: string
  return_count: number
  quantity: number
  percentage: number
}

type ReturnAnalysisSummary = {
  total_returns: number
  total_quantity: number
  unique_skus: number
  top_return_sku: string | null
  top_return_reason: string | null
  /** BLF-1074：后端给出的中文译文（与 `reason_rows[].reason_display` 同源、单一翻译源） */
  top_return_reason_display?: string | null
  total_sales_quantity: number
  total_sales_amount: number
  overall_return_rate: number
}

type ReturnAnalysisResponse = {
  project_id: number
  project_name: string
  country: string
  start_date: string
  end_date: string
  summary: ReturnAnalysisSummary
  summary_text: string
  ranking_rows: ReturnRankingItem[]
  reason_rows: ReturnReasonItem[]
  trend_rows: ReturnTrendItem[]
  disposition_rows: DispositionItem[]
  status_rows: StatusItem[]
  feedback_rows: CustomerFeedbackItem[]
  weekday_rows: WeekdayItem[]
  fulfillment_center_rows: FulfillmentCenterItem[]
  multi_item_return_count: number
  multi_item_return_quantity: number
}

type ReturnRawRowsResponse = {
  project_id: number
  country: string
  start_date: string
  end_date: string
  row_count: number
  rows: ReturnRawRow[]
}

const TAB_LABELS: Record<ViewTab, string> = {
  rankings: '高退货排行',
  reason: '退货原因',
  trend: '退货趋势',
  'product-status': '商品状态',
  'inventory-status': '库存状态',
  feedback: '顾客反馈',
  summary: 'AI 总结',
  raw: '原始数据',
}

// BLF-883 全局统一：每个 tab 前置 icon
const TAB_ICONS: Record<ViewTab, LucideIcon> = {
  rankings: Trophy,
  reason: Tags,
  trend: TrendingUp,
  'product-status': Package,
  'inventory-status': Boxes,
  feedback: MessageSquare,
  summary: Sparkles,
  raw: Table2,
}

/**
 * Chart-local neutral categorical palette. Values come from
 * --warm-ledger-color-chart-1..5 so both themes keep >= 3:1 contrast against
 * the panel and stay free of positive/negative/accent meaning.
 */
export const RETURN_REASON_COLORS = [
  'var(--warm-ledger-color-chart-1)',
  'var(--warm-ledger-color-chart-2)',
  'var(--warm-ledger-color-chart-3)',
  'var(--warm-ledger-color-chart-4)',
  'var(--warm-ledger-color-chart-5)',
]
export const RETURN_REASON_SLICE_STROKE = 'var(--warm-ledger-color-panel)'
export const RETURN_REASON_SLICE_STROKE_WIDTH = 2

/** 统计磁贴：Warm 面板、sans 标签、mono/tabular 数值。 */
function SummaryTile({
  label,
  value,
  sub,
  valueClassName,
}: {
  label: string
  value: string
  sub?: string
  valueClassName?: string
}) {
  return (
    <div className={styles.summaryTile}>
      <span className={styles.summaryLabel}>{label}</span>
      <span
        className={cn(styles.summaryValue, valueClassName)}
        title={value}
      >
        {value}
      </span>
      {sub && <span className={styles.summarySub}>{sub}</span>}
    </div>
  )
}

/** 整体退货率语义色：>8% 红 / >3% 黄 / 其余绿（与原控制台口径一致） */
function returnRateTone(rate: number): string {
  if (rate > 8) return 'text-[var(--warm-ledger-color-negative)]'
  if (rate > 3) return 'text-[var(--warm-ledger-color-accent)]'
  return 'text-[var(--warm-ledger-color-positive)]'
}

function WarmTable({
  className,
  containerClassName,
  children,
  ...props
}: ComponentProps<typeof Table>) {
  return (
    <div
      className={cn(styles.tableScroll, 'warm-ledger-table-scroll', containerClassName)}
      data-warm-table-scroll="return-analysis"
      tabIndex={0}
    >
      <Table
        {...props}
        containerClassName="overflow-visible"
        className={cn(styles.table, className)}
      >
        {children}
      </Table>
    </div>
  )
}

function WarmProgressTableBody({
  refreshing,
  busy,
  colSpan,
  children,
}: {
  refreshing: boolean
  busy?: boolean
  colSpan: number
  children: ReactNode
}) {
  const isBusy = refreshing || Boolean(busy)

  return (
    <TableBody aria-busy={isBusy || undefined}>
      {refreshing ? (
        <TableRow
          className={cn(styles.progressRow, 'warm-ledger-table-progress-row')}
          data-testid="refresh-progress-row"
          data-warm-progress-row="return-analysis"
        >
          <TableCell colSpan={colSpan} className={styles.progressCell}>
            <WarmProgressIndicator />
          </TableCell>
        </TableRow>
      ) : null}
      {children}
    </TableBody>
  )
}

function WarmProgressIndicator() {
  return (
    <div
      className={cn(styles.progressTrack, 'warm-ledger-table-progress-track')}
      data-warm-progress="return-analysis"
      data-warm-tone="accent"
      role="progressbar"
      aria-label="正在刷新退货分析数据"
    >
      <div
        className={cn(
          styles.progressBar,
          'warm-ledger-table-progress-bar',
          'animate-shimmer'
        )}
        data-testid="refresh-progress-indicator"
      />
    </div>
  )
}

function WarmProgressRegion({
  refreshing,
  children,
}: {
  refreshing: boolean
  children: ReactNode
}) {
  return (
    <>
      {refreshing ? (
        <div className={styles.progressStandalone}>
          <WarmProgressIndicator />
        </div>
      ) : null}
      <div aria-busy={refreshing || undefined}>{children}</div>
    </>
  )
}

export default function ReturnAnalysisPage() {
  const { notify } = useNotifications()
  const { data: session } = useSession()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  // 项目 / 国家 / 当前 Tab 同步到 URL search param，刷新 / 分享链接 / 浏览器后退都能记住选择。
  // dateRange 暂保留本地 state（按 current country 的 timezone 计算默认值，比较重，先不污染 URL）。
  const [projectId, setProjectId] = useUrlParam<string>('project', '')

  // 进入页面默认选中第一个真实项目,内容立即加载（跳过 all / 空白意图）
  useAutoSelectFirstProject(projects, projectId, setProjectId)
  const [country, setCountry] = useUrlParam<CountryOption>('country', 'US', {
    allowed: ['US', 'DE', 'UK'],
  })
  const defaultRange = useMemo(() => lastSevenDaysRange(country), [country])
  const [dateRange, setDateRange] = useState<DateRange | undefined>(defaultRange)
  const [activeTab, setActiveTab] = useUrlParam<ViewTab>('tab', 'rankings', {
    allowed: [
      'rankings',
      'reason',
      'trend',
      'product-status',
      'inventory-status',
      'feedback',
      'summary',
      'raw',
    ],
  })

  const [data, setData] = useState<ReturnAnalysisResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const hasLoadedDataRef = useRef(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  // 原始行懒加载状态：只在切到「原始数据」Tab 或点导出时才发请求（spec §3.3）
  const [rawRows, setRawRows] = useState<ReturnRawRowsResponse | null>(null)
  const [rawLoading, setRawLoading] = useState(false)
  const [rawError, setRawError] = useState<string | null>(null)
  // 全局刷新（force）时把 force 语义传递给原始行请求，避免命中 2min 客户端缓存。
  // 注意这是「粘性跨 Tab 旗标」：原始数据 Tab 关着时点刷新也会把它置 true 并保留，
  // 直到下一次原始行请求消费它才清零 —— 后续的导出任务依赖这个行为
  //（刷新后导出的原始行必须是新数据，不能是 2min 缓存里的旧周期行）。
  const rawForceRef = useRef(false)
  // 原始行请求世代：loadData 作废旧周期数据时自增，用来丢弃「在途的旧周期响应」
  const rawRequestEpochRef = useRef(0)
  // 原始行请求序号：只有「最后发起」的那次请求可以清 loading。
  // 导出预取（handleExportExcel）与 Tab 懒加载可能同世代并发，旧请求若无条件清 loading，
  // 会把新请求刚置上的 loading 提前打下去（调用方会误判请求已结束）。
  const rawRequestSeqRef = useRef(0)

  const { isRefreshing } = useSmoothRefresh({ loading, hasData: !!data })
  const isInitialDataLoading = loading && !data && !hasLoadedDataRef.current
  const showRefreshProgress = isRefreshing && !isInitialDataLoading
  const warmState =
    loadError
      ? 'error'
      : projectsLoading || (loading && !data)
        ? 'loading'
        : !data || (activeTab === 'rankings' && data.ranking_rows.length === 0)
          ? 'empty'
          : 'ready'

  // 主分析数据尚未成功返回时，原始 Tab 没有可依赖的周期数据。
  const rawNeedsMainData = !data && !loading && !rawRows && !rawError
  const isRawTableLoading =
    activeTab === 'raw' && !!data && !rawError && (rawLoading || !rawRows)
  const loadingStatus = isInitialDataLoading
    ? '正在加载退货分析数据'
    : isRawTableLoading
      ? '正在加载原始退货数据'
      : null

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      try {
        const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
        const validPayload = payload.filter((item) => item.id !== null)
        setProjects(validPayload)
        // 1. URL 没指定 projectId（空字符串）→ 选第一个
        // 2. URL 指定了具体项目但项目列表里找不到（用户失去权限、项目被删除）→ 回退到第一个
        // 用 payload（刚 fetch 到的），不用 projects（state 还是旧值）。
        if (validPayload.length > 0) {
          const existsInList = projectId && validPayload.some((p) => String(p.id) === projectId)
          if (!projectId || !existsInList) {
            setProjectId(String(validPayload[0].id))
          }
        }
      } catch (fetchError) {
        notify({
          type: 'error',
          title: '项目列表加载失败',
          message: fetchError instanceof Error ? fetchError.message : '项目列表加载失败',
        })
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [notify, session])

  useEffect(() => {
    setDateRange(defaultRange)
  }, [country, defaultRange])

  // BEL-423：退货分析只读数据进 2min 客户端缓存（重复 mount 0 请求）；刷新按钮 force。
  const loadData = useCallback(
    async (force = false) => {
      const effectiveRange = normalizeDateRange(dateRange)
      if (!effectiveRange?.from || !effectiveRange?.to) {
        notify({ type: 'error', title: '请选择开始和结束日期' })
        return
      }
      if (!projectId) {
        notify({ type: 'error', title: '请先选择项目' })
        return
      }

      const startDate = formatYMD(effectiveRange.from)
      const endDate = formatYMD(effectiveRange.to)

      // 周期切换防串数据：旧周期的原始行一律作废，等下次进 Tab/导出时重取
      setRawRows(null)
      setRawError(null)
      // 世代自增：在途的旧周期原始行响应回来后会被识别为过期并整体丢弃，
      // 否则它会把旧周期的行（含旧 start_date 至 end_date 表头）写回表格/导出
      rawRequestEpochRef.current += 1
      if (force) rawForceRef.current = true

      setLoading(true)
      setLoadError(null)
      try {
        const search = new URLSearchParams({
          project_id: projectId,
          country,
          start_date: startDate,
          end_date: endDate,
        })
        const payload = await fetchOpsJsonCached<ReturnAnalysisResponse>(
          `${API_BASE}/return-analysis?${search.toString()}`,
          { session, force, fallbackError: '退货数据加载失败' }
        )
        setData(payload)
        hasLoadedDataRef.current = true
        setLoadError(null)
      } catch (fetchError) {
        notify({
          type: 'error',
          title: '退货数据加载失败',
          message: fetchError instanceof Error ? fetchError.message : '退货数据加载失败',
        })
        setData(null)
        setLoadError(fetchError instanceof Error ? fetchError.message : '退货数据加载失败')
      } finally {
        setLoading(false)
      }
    },
    [projectId, country, dateRange, notify, session]
  )

  // 原始行按需拉取：失败返回 null（由调用方决定提示方式），不抛异常
  const loadRawRows = useCallback(
    async (force = false) => {
      const effectiveRange = normalizeDateRange(dateRange)
      if (!effectiveRange?.from || !effectiveRange?.to || !projectId) {
        // 筛选不完整时不发请求，但要给「重试」按钮可见反馈（否则按钮看起来毫无反应）
        setRawError('请先选择项目与日期范围')
        return null
      }

      const search = new URLSearchParams({
        project_id: projectId,
        country,
        start_date: formatYMD(effectiveRange.from),
        end_date: formatYMD(effectiveRange.to),
      })
      // 记下发起时的世代：响应回来若世代已变（用户切了周期/项目/站点），整份结果直接丢弃
      const requestEpoch = rawRequestEpochRef.current
      const requestSeq = (rawRequestSeqRef.current += 1)
      setRawLoading(true)
      setRawError(null)
      try {
        const payload = await fetchOpsJsonCached<ReturnRawRowsResponse>(
          `${API_BASE}/return-analysis/raw-rows?${search.toString()}`,
          { session, force, fallbackError: '原始数据加载失败' }
        )
        if (requestEpoch !== rawRequestEpochRef.current) return null
        setRawRows(payload)
        return payload
      } catch (fetchError) {
        // 过期请求连错误都不上报：它描述的是已经不存在的周期
        if (requestEpoch !== rawRequestEpochRef.current) return null
        setRawError(fetchError instanceof Error ? fetchError.message : '原始数据加载失败')
        return null
      } finally {
        // 世代未变才消费 force 旗标，否则会把新一轮强制刷新刚置上的旗标误清掉
        if (requestEpoch === rawRequestEpochRef.current) rawForceRef.current = false
        // 只有最新一次请求能清 loading：被后发请求超越的旧请求不得提前清掉新请求的 loading。
        // 不能收窄成「世代未变才清」——世代变更后若暂无新请求（Tab 懒加载被 rawLoading 挡住），
        // loading 会永远悬停，新周期永不重取（「在途旧周期响应不覆盖新周期」用例会失败）。
        if (requestSeq === rawRequestSeqRef.current) setRawLoading(false)
      }
    },
    [projectId, country, dateRange, session]
  )

  // 只在切到「原始数据」Tab 时懒加载一次（已有数据不重复请求）。
  // rawError 也参与守卫：失败后不自动重试（否则 rawLoading 回落会让 effect 无限重发），
  // 由用户点「重试」显式再发一次。
  useEffect(() => {
    if (activeTab !== 'raw') return
    if (!projectId || !data) return
    if (rawRows || rawLoading || rawError) return
    void loadRawRows(rawForceRef.current)
  }, [activeTab, projectId, data, rawRows, rawLoading, rawError, loadRawRows])

  const handleExportExcel = useCallback(async () => {
    if (!data) return
    // 先置忙再预取：导出按钮的 disabled 依赖 exporting，若等预取回来才置忙，
    // 预取期间第二次点击会并发起第二次导出 → 两份下载。
    setExporting(true)
    try {
      // 原始行按需拉取：失败即中止导出，不产出缺 sheet 的「假完整包」（spec §3.4）
      // 预取必须消费粘性 force 旗标：原始数据 Tab 关着时的全局刷新也会置 true，
      // 不传就会命中 2min 客户端缓存，导出到与新鲜分析数字对不上的旧原始行。
      const raw = rawRows ?? (await loadRawRows(rawForceRef.current))
      if (!raw) {
        notify({
          type: 'error',
          title: '导出失败',
          message: '原始数据加载失败，已中止导出',
        })
        return
      }
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'BelieveBoy Dashboard'
      workbook.created = new Date()

      // Helper: apply header style
      const styleHeaderRow = (ws: Worksheet, rowIndex: number) => {
        const row = ws.getRow(rowIndex)
        row.eachCell((cell) => {
          cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
          cell.alignment = { vertical: 'middle', horizontal: 'center' }
          applyHeaderBorder(cell)
        })
        return row
      }

      // ── Sheet 1: 退货排行 ──
      {
        const ws = workbook.addWorksheet('退货排行')
        const headers = [
          'SKU',
          'ASIN',
          '产品名称',
          '退货数量',
          '退货单数',
          '销售数量',
          '退货率(%)',
          '平均退货周期(天)',
          '最快退货周期(天)',
          '最慢退货周期(天)',
        ]
        ws.columns = [
          { width: 18 },
          { width: 16 },
          { width: 30 },
          { width: 12 },
          { width: 12 },
          { width: 12 },
          { width: 12 },
          { width: 18 },
          { width: 18 },
          { width: 18 },
        ]
        const headerRow = ws.addRow(headers)
        headerRow.height = 22
        styleHeaderRow(ws, 1)

        data.ranking_rows.forEach((row) => {
          const r = ws.addRow([
            row.sku,
            row.asin ?? '',
            row.product_name ?? '',
            row.total_quantity,
            row.return_count,
            row.sales_quantity,
            row.sales_quantity > 0 ? parseFloat(row.return_rate.toFixed(2)) : null,
            row.avg_return_cycle_days != null ? row.avg_return_cycle_days : '',
            row.min_return_cycle_days != null ? row.min_return_cycle_days : '',
            row.max_return_cycle_days != null ? row.max_return_cycle_days : '',
          ])
          r.font = { name: 'Microsoft YaHei' }
          r.eachCell((cell) => {
            applyBorder(cell)
          })
        })
        applyDataRowBanding({
          worksheet: ws,
          startRow: 2,
          rowCount: data.ranking_rows.length,
          columnCount: headers.length,
        })

        // freeze header row
        ws.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }]
      }

      // ── Sheet 2: 退货原因 ──
      {
        const ws = workbook.addWorksheet('退货原因')
        const headers = ['退货原因', '退货数量', '退货单数', '占比(%)']
        ws.columns = [{ width: 22 }, { width: 14 }, { width: 14 }, { width: 12 }]
        const headerRow = ws.addRow(headers)
        headerRow.height = 22
        styleHeaderRow(ws, 1)

        data.reason_rows.forEach((row) => {
          const r = ws.addRow([
            row.reason_display,
            row.total_quantity,
            row.return_count,
            parseFloat(row.percentage.toFixed(2)),
          ])
          r.font = { name: 'Microsoft YaHei' }
          r.eachCell((cell) => {
            applyBorder(cell)
          })
        })
        applyDataRowBanding({
          worksheet: ws,
          startRow: 2,
          rowCount: data.reason_rows.length,
          columnCount: headers.length,
        })

        ws.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }]
      }

      // ── Sheet 3: 商品状态 ──
      {
        const ws = workbook.addWorksheet('商品状态')
        const headers = ['商品状态', '数量', '退货单数', '占比(%)']
        ws.columns = [{ width: 22 }, { width: 14 }, { width: 14 }, { width: 12 }]
        const headerRow = ws.addRow(headers)
        headerRow.height = 22
        styleHeaderRow(ws, 1)

        data.disposition_rows.forEach((row) => {
          const r = ws.addRow([
            row.disposition_display,
            row.total_quantity,
            row.return_count,
            parseFloat(row.percentage.toFixed(2)),
          ])
          r.font = { name: 'Microsoft YaHei' }
          r.eachCell((cell) => {
            applyBorder(cell)
          })
        })
        applyDataRowBanding({
          worksheet: ws,
          startRow: 2,
          rowCount: data.disposition_rows.length,
          columnCount: headers.length,
        })

        ws.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }]
      }

      // ── Sheet 4: 库存状态 ──
      {
        const ws = workbook.addWorksheet('库存状态')
        const headers = ['库存状态', '数量', '退货单数', '占比(%)']
        ws.columns = [{ width: 22 }, { width: 14 }, { width: 14 }, { width: 12 }]
        const headerRow = ws.addRow(headers)
        headerRow.height = 22
        styleHeaderRow(ws, 1)

        data.status_rows.forEach((row) => {
          const r = ws.addRow([
            row.status_display,
            row.total_quantity,
            row.return_count,
            parseFloat(row.percentage.toFixed(2)),
          ])
          r.font = { name: 'Microsoft YaHei' }
          r.eachCell((cell) => {
            applyBorder(cell)
          })
        })
        applyDataRowBanding({
          worksheet: ws,
          startRow: 2,
          rowCount: data.status_rows.length,
          columnCount: headers.length,
        })

        ws.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }]
      }

      // ── Sheet 5: 顾客反馈 ──
      {
        const ws = workbook.addWorksheet('顾客反馈')
        const headers = ['日期', 'SKU', '订单号', '退货原因', '顾客评论']
        ws.columns = [{ width: 14 }, { width: 18 }, { width: 22 }, { width: 18 }, { width: 60 }]
        const headerRow = ws.addRow(headers)
        headerRow.height = 22
        styleHeaderRow(ws, 1)

        data.feedback_rows.forEach((row) => {
          const r = ws.addRow([
            row.return_date,
            row.sku,
            row.order_id,
            row.reason_display,
            row.customer_comment,
          ])
          r.font = { name: 'Microsoft YaHei' }
          r.eachCell((cell) => {
            applyBorder(cell)
          })
        })
        applyDataRowBanding({
          worksheet: ws,
          startRow: 2,
          rowCount: data.feedback_rows.length,
          columnCount: headers.length,
        })

        ws.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }]
      }

      // ── Sheet 6: 亚马逊原始数据（spec §1.2 的 17 列，列配置与 Tab 共用）──
      {
        const ws = workbook.addWorksheet('亚马逊原始数据')
        ws.columns = RETURN_RAW_COLUMNS.map((column) => ({ width: column.width }))
        const headerRow = ws.addRow(RETURN_RAW_COLUMNS.map((column) => column.label))
        headerRow.height = 22
        styleHeaderRow(ws, 1)

        raw.rows.forEach((row) => {
          const r = ws.addRow(
            RETURN_RAW_COLUMNS.map((column) => {
              const value = row[column.key]
              return value === null || value === undefined ? '' : value
            })
          )
          r.font = { name: 'Microsoft YaHei' }
          r.eachCell((cell) => {
            applyBorder(cell)
          })
        })
        applyDataRowBanding({
          worksheet: ws,
          startRow: 2,
          rowCount: raw.rows.length,
          columnCount: RETURN_RAW_COLUMNS.length,
        })

        ws.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }]
      }

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const safeDateRange = `${data.start_date}_${data.end_date}`
      const safeProjectName = (data.project_name || '未选项目').replace(/[\\/:*?"<>|]/g, '-')
      const safeCountryLabel = getCountryLabel(data.country).replace(/[\\/:*?"<>|]/g, '-')
      downloadBlob(blob, `${safeProjectName}_${safeCountryLabel}-退货分析-${safeDateRange}.xlsx`)

      notify({ type: 'success', title: '导出成功', message: '退货分析 Excel 已下载' })
    } catch (err) {
      notify({
        type: 'error',
        title: '导出失败',
        message: err instanceof Error ? err.message : '导出时发生未知错误',
      })
    } finally {
      setExporting(false)
    }
  }, [data, notify, rawRows, loadRawRows])

  useEffect(() => {
    if (!projectId) return
    void loadData()
  }, [projectId, country, loadData])

  // —— Header 化：head 插槽 + 全局刷新 ——
  // 刷新语义与原控制台 RefreshButton 一致：当前筛选条件下强刷（跳 2min 客户端缓存）。
  const loadDataRef = useRef(loadData)
  loadDataRef.current = loadData
  useHeaderRefresh(() => loadDataRef.current(true), { loading })

  // 筛选控件 portal 进 Top Header 中段插槽（项目 / 站点 / 日期范围）
  const filterControls = (
    <>
      <HeaderSlotSelect
        value={projectId}
        onChange={setProjectId}
        options={projects.map((project) => ({
          value: String(project.id),
          label: project.name,
        }))}
        placeholder={projectsLoading ? '项目加载中…' : '选择项目'}
        disabled={projectsLoading}
        widthClass={TERM_HEADER_W_MD}
        title="项目筛选"
      />
      <HeaderSlotSelect
        value={country}
        onChange={(value) => setCountry(value as CountryOption)}
        options={COUNTRY_OPTIONS}
        widthClass={TERM_HEADER_W_SM}
        title="站点筛选"
      />
      <HeaderSlotDateRange
        value={dateRange}
        onChange={setDateRange}
        onApply={() => void loadData()}
        timezone={COUNTRY_TIMEZONE_MAP[country]}
        widthClass={TERM_HEADER_W_XL}
      />
    </>
  )
  const headerSlotPortal = useHeaderSlot(
    <HeaderFilterControls isMobileView={false} controls={filterControls} />
  )

  // BLF-931 · 移动端：筛选控件下迁为正文顶部可折叠筛选条
  const mobileProjectLabel = projects.find((p) => String(p.id) === projectId)?.name ?? projectId
  const mobileCountryLabel = getCountryLabel(country)
  const mobileDateLabel =
    dateRange?.from && dateRange?.to
      ? `${formatYMD(dateRange.from)} ~ ${formatYMD(dateRange.to)}`
      : '未选日期'
  const mobileFilterSummary = `${mobileProjectLabel} · ${mobileCountryLabel} · ${mobileDateLabel}`
  const mobileFilterStrip = useMobileFilterStrip(
    <MobileFilterStrip
      summary={mobileFilterSummary}
      controls={
        <>
          <HeaderSlotSelect
            value={projectId}
            onChange={setProjectId}
            options={projects.map((project) => ({
              value: String(project.id),
              label: project.name,
            }))}
            placeholder={projectsLoading ? '项目加载中…' : '选择项目'}
            disabled={projectsLoading}
            widthClass={TERM_HEADER_W_MD}
            title="项目筛选"
          />
          <HeaderSlotSelect
            value={country}
            onChange={(value) => setCountry(value as CountryOption)}
            options={COUNTRY_OPTIONS}
            widthClass={TERM_HEADER_W_SM}
            title="站点筛选"
          />
          <MobileFilterWide>
            <HeaderSlotDateRange
              value={dateRange}
              onChange={setDateRange}
              onApply={() => void loadData()}
              timezone={COUNTRY_TIMEZONE_MAP[country]}
              widthClass={TERM_HEADER_W_XL}
            />
          </MobileFilterWide>
        </>
      }
    />
  )

  const chartConfig = {
    sales_quantity: { label: '销售数量', color: 'var(--warm-ledger-color-text-soft)' },
    return_count: { label: '退货量', color: 'var(--warm-ledger-color-accent)' },
    total_quantity: { label: '退货件数', color: 'var(--warm-ledger-color-accent-strong)' },
    percentage: { label: '占比', color: 'var(--warm-ledger-color-positive)' },
    return_rate: { label: '退货率(%)', color: 'var(--warm-ledger-color-negative)' },
  } satisfies ChartConfig

  return (
    <div className={styles.page} data-warm-page="return-analysis" data-warm-state={warmState}>
      {/* Header 化：筛选控件已上移 Top Header 中段插槽，页面仅渲染 portal 宿主 */}
      {headerSlotPortal}
      {/* BLF-931：移动端折叠筛选条（正文顶部，md:hidden 挂载点内） */}
      {mobileFilterStrip}
      {loadingStatus ? (
        <p className={styles.visuallyHidden} role="status">
          {loadingStatus}
        </p>
      ) : null}

      {loadError ? (
        <div className={styles.errorNotice} data-warm-state="error">
          <div className={styles.errorCopy}>
            <h2 className={styles.errorTitle} data-warm-state="error">
              退货数据加载失败
            </h2>
            {loadError !== '退货数据加载失败' ? (
              <p className={styles.errorMessage}>{loadError}</p>
            ) : null}
          </div>
          <WarmButton variant="secondary" onClick={() => void loadData(true)}>
            重试
          </WarmButton>
        </div>
      ) : (
        <>
      {/* 统计磁贴条（原控制台 Summary Stats，终端规格） */}
      {data && (
        <div className={styles.summaryGrid} data-warm-summary="return-analysis">
          <SummaryTile label="退货单数" value={data.summary.total_returns.toLocaleString()} />
          <SummaryTile label="退货总量" value={data.summary.total_quantity.toLocaleString()} />
          <SummaryTile
            label="销售数量"
            value={data.summary.total_sales_quantity.toLocaleString()}
          />
          <SummaryTile
            label="整体退货率"
            value={`${data.summary.overall_return_rate.toFixed(1)}%`}
            valueClassName={returnRateTone(data.summary.overall_return_rate)}
          />
          <SummaryTile label="涉及 SKU" value={data.summary.unique_skus.toLocaleString()} />
          <SummaryTile label="Top 退货原因" value={topReturnReasonDisplay(data.summary)} />
          <SummaryTile
            label="多件退货"
            value={data.multi_item_return_count.toLocaleString()}
            sub={`共 ${data.multi_item_return_quantity.toLocaleString()} 件`}
          />
        </div>
      )}

      {/* Tab 导航条独立于工作区卡片之外（不再嵌在卡头内，对齐 shipment-management / sku-info
          的外置 tab 布局）；卡头仅保留 标题 + 导出 */}
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as ViewTab)}
        className={styles.tabsBar}
      >
        <TabsMotionGroup id="return-analysis-tabs">
          <TabsList>
            {VIEW_TAB_ORDER.map((tab) => {
              const Icon = TAB_ICONS[tab]
              return (
                <SlidingTabsTrigger
                  key={tab}
                  value={tab}
                  activeValue={activeTab}
                  layoutId="return-analysis-tab-indicator"
                >
                  <Icon aria-hidden />
                  {TAB_LABELS[tab]}
                </SlidingTabsTrigger>
              )
            })}
          </TabsList>
        </TabsMotionGroup>
        <DataTableCard className={styles.workspacePanel}>
          <DataTableCardHeader>
            <div className={styles.workspaceTitle}>退货分析工作区</div>
            <WarmButton
              type="button"
              variant="secondary"
              onClick={() => void handleExportExcel()}
              disabled={exporting || loading || !data}
              className="h-10 w-full px-3 sm:w-auto sm:px-4"
            >
              {exporting ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-1.5 h-4 w-4" />
              )}
              导出 Excel
            </WarmButton>
          </DataTableCardHeader>
          <DataTableCardBody>
            <DirectionalTabTransition value={activeTab} order={VIEW_TAB_ORDER}>
              <TabsContent forceMount value={activeTab} className="m-0">
                {activeTab === 'rankings' && (
                  <WarmTable containerClassName="bg-[var(--warm-ledger-color-panel)]" tableLayout="fixed">
                    <ColGroup
                      columns={[
                        { width: 112 },
                        { width: 144 },
                        { width: 80 },
                        { width: 96 },
                        { width: 96 },
                        { width: 80 },
                        { width: 80 },
                        { width: 80 },
                        { width: 80 },
                        { width: 80 },
                      ]}
                    />
                    <TableHeader>
                      <TableRow>
                        <TableHead rowSpan={2} className="align-middle">
                          SKU
                        </TableHead>
                        <TableHead rowSpan={2} className="align-middle">
                          品名
                        </TableHead>
                        <TableHead rowSpan={2} className="align-middle">
                          ASIN
                        </TableHead>
                        <TableHead rowSpan={2} className="text-right align-middle">
                          退货数量
                        </TableHead>
                        <TableHead rowSpan={2} className="text-right align-middle">
                          退货单数
                        </TableHead>
                        <TableHead rowSpan={2} className="text-right align-middle">
                          销售数量
                        </TableHead>
                        <TableHead rowSpan={2} className="text-right align-middle">
                          退货率
                        </TableHead>
                        <TableHead colSpan={3} className="text-center">
                          退货周期(天)
                        </TableHead>
                      </TableRow>
                      <TableRow>
                        <TableHead className="text-right">平均</TableHead>
                        <TableHead className="text-right">最快</TableHead>
                        <TableHead className="text-right">最慢</TableHead>
                      </TableRow>
                    </TableHeader>
                    <WarmProgressTableBody
                      refreshing={showRefreshProgress}
                      busy={isInitialDataLoading}
                      colSpan={10}
                    >
                      {isInitialDataLoading ? (
                        Array.from({ length: 5 }).map((_, i) => (
                          <TableRow key={i} data-warm-skeleton="static">
                            <TableCell>
                              <div className="h-4 w-20 rounded bg-[var(--warm-ledger-color-raised)]" />
                            </TableCell>
                            <TableCell>
                              <div className="h-4 w-28 rounded bg-[var(--warm-ledger-color-raised)]" />
                            </TableCell>
                            <TableCell>
                              <div className="h-4 w-16 rounded bg-[var(--warm-ledger-color-raised)]" />
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="ml-auto h-4 w-16 rounded bg-[var(--warm-ledger-color-raised)]" />
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="ml-auto h-4 w-12 rounded bg-[var(--warm-ledger-color-raised)]" />
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="ml-auto h-4 w-12 rounded bg-[var(--warm-ledger-color-raised)]" />
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="ml-auto h-4 w-12 rounded bg-[var(--warm-ledger-color-raised)]" />
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="ml-auto h-4 w-12 rounded bg-[var(--warm-ledger-color-raised)]" />
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="ml-auto h-4 w-12 rounded bg-[var(--warm-ledger-color-raised)]" />
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="ml-auto h-4 w-12 rounded bg-[var(--warm-ledger-color-raised)]" />
                            </TableCell>
                          </TableRow>
                        ))
                      ) : data?.ranking_rows.length ? (
                        data.ranking_rows.map((row) => (
                          <TableRow key={row.sku}>
                            <TableCell className="font-medium truncate">{row.sku}</TableCell>
                            <TableCell className="truncate text-[var(--warm-ledger-color-text-muted)]">
                              {row.product_name || '--'}
                            </TableCell>
                            <TableCell className="text-[var(--warm-ledger-color-text-muted)]">
                              {row.asin || '--'}
                            </TableCell>
                            <TableCell className="text-right font-semibold">
                              {row.total_quantity.toLocaleString()}
                            </TableCell>
                            <TableCell className="text-right">
                              {row.return_count.toLocaleString()}
                            </TableCell>
                            <TableCell className="text-right">
                              {row.sales_quantity.toLocaleString()}
                            </TableCell>
                            <TableCell
                              className={`text-right font-semibold ${row.return_rate > 8 ? 'text-[var(--warm-ledger-color-negative)]' : row.return_rate > 3 ? 'text-[var(--warm-ledger-color-accent)]' : 'text-[var(--warm-ledger-color-positive)]'}`}
                            >
                              {row.sales_quantity > 0 ? `${row.return_rate.toFixed(1)}%` : '--'}
                            </TableCell>
                            <TableCell className="text-right">
                              {row.avg_return_cycle_days != null
                                ? row.avg_return_cycle_days.toFixed(1)
                                : '--'}
                            </TableCell>
                            <TableCell className="text-right text-[var(--warm-ledger-color-positive)]">
                              {row.min_return_cycle_days != null ? row.min_return_cycle_days : '--'}
                            </TableCell>
                            <TableCell className="text-right text-[var(--warm-ledger-color-accent)]">
                              {row.max_return_cycle_days != null ? row.max_return_cycle_days : '--'}
                            </TableCell>
                          </TableRow>
                        ))
                      ) : (
                        <TableRow>
                          <TableCell
                            colSpan={10}
                            className="py-12 text-center text-[var(--warm-ledger-color-text-muted)]"
                            data-warm-state="empty"
                          >
                            暂无退货排行数据
                          </TableCell>
                        </TableRow>
                      )}
                    </WarmProgressTableBody>
                  </WarmTable>
                )}

                {activeTab === 'reason' && (
                  <div className="space-y-4 p-4">
                    <h3 className={styles.sectionHeading}>退货原因分析</h3>
                    <div className="grid gap-4 lg:grid-cols-2">
                      {/* Table */}
                      <WarmTable containerClassName="bg-[var(--warm-ledger-color-panel)]">
                        <TableHeader>
                          <TableRow>
                            <TableHead>退货原因</TableHead>
                            <TableHead className="text-right">退货数量</TableHead>
                            <TableHead className="text-right">占比</TableHead>
                          </TableRow>
                        </TableHeader>
                        <WarmProgressTableBody
                          refreshing={showRefreshProgress}
                          busy={isInitialDataLoading}
                          colSpan={3}
                        >
                          {data?.reason_rows.length ? (
                            data.reason_rows.map((row) => (
                              <TableRow key={row.reason}>
                                <TableCell className="font-medium">{row.reason_display}</TableCell>
                                <TableCell className="text-right">
                                  {row.total_quantity.toLocaleString()}
                                </TableCell>
                                <TableCell className="text-right text-[var(--warm-ledger-color-text-muted)]">
                                  {row.percentage}%
                                </TableCell>
                              </TableRow>
                            ))
                          ) : (
                            <EmptyTableState colSpan={3} message="暂无退货原因数据" />
                          )}
                        </WarmProgressTableBody>
                      </WarmTable>

                      {/* Pie Chart */}
                      {data?.reason_rows && data.reason_rows.length > 0 && (
                        <div
                          className={styles.chartPanel}
                          data-warm-chart="return-reasons"
                        >
                          <ChartContainer
                            config={chartConfig}
                            className="h-[240px] w-full sm:h-[300px]"
                          >
                            <PieChart>
                              <Pie
                                data={data.reason_rows.slice(0, 5).map((r, i) => ({
                                  name: r.reason_display,
                                  value: r.return_count,
                                  fill:
                                    RETURN_REASON_COLORS[i % RETURN_REASON_COLORS.length],
                                }))}
                                cx="50%"
                                cy="50%"
                                outerRadius={80}
                                dataKey="value"
                                stroke={RETURN_REASON_SLICE_STROKE}
                                strokeWidth={RETURN_REASON_SLICE_STROKE_WIDTH}
                              >
                                {data.reason_rows.slice(0, 5).map((_, i) => (
                                  <Cell
                                    key={i}
                                    fill={RETURN_REASON_COLORS[i % RETURN_REASON_COLORS.length]}
                                  />
                                ))}
                              </Pie>
                              <ChartTooltip content={<ChartTooltipContent nameKey="name" />} />
                            </PieChart>
                          </ChartContainer>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {activeTab === 'trend' && (
                  <div className="space-y-4 p-4">
                    <h3 className={styles.sectionHeading}>销售与退货趋势对比</h3>
                    {data?.trend_rows && data.trend_rows.length > 0 ? (
                      <div
                        className={styles.chartPanel}
                        data-warm-chart="return-trend"
                      >
                        <ChartContainer
                          config={chartConfig}
                          className="h-[280px] w-full sm:h-[350px]"
                        >
                          <ComposedChart
                            data={data.trend_rows}
                            margin={{ top: 12, right: 4, left: -12, bottom: 8 }}
                          >
                            <CartesianGrid vertical={false} stroke="var(--warm-ledger-color-chart-grid)" />
                            <XAxis
                              dataKey="date"
                              axisLine={false}
                              tickLine={false}
                              tickMargin={8}
                              tick={{ fontSize: 10, fill: 'var(--warm-ledger-color-text-muted)' }}
                              tickFormatter={(value) => {
                                const [, month, day] = String(value).split('-')
                                return `${month}/${day}`
                              }}
                            />
                            <YAxis
                              axisLine={false}
                              tickLine={false}
                              tickMargin={8}
                              tick={{ fontSize: 10, fill: 'var(--warm-ledger-color-text-muted)' }}
                              yAxisId="left"
                              width={35}
                            />
                            <YAxis
                              axisLine={false}
                              tickLine={false}
                              tickMargin={8}
                              tick={{ fontSize: 10, fill: 'var(--warm-ledger-color-text-muted)' }}
                              yAxisId="right"
                              orientation="right"
                              tickFormatter={(value) => `${value}%`}
                              width={35}
                            />
                            <ChartTooltip
                              content={
                                <ChartTooltipContent
                                  nameKey="date"
                                  formatter={(value, name) => {
                                    const label =
                                      chartConfig[name as keyof typeof chartConfig]?.label || name
                                    return [value, label]
                                  }}
                                />
                              }
                            />
                            <Bar
                              dataKey="sales_quantity"
                              name="sales_quantity"
                              fill="var(--color-sales_quantity)"
                              radius={[4, 4, 0, 0]}
                              barSize={16}
                              yAxisId="left"
                            />
                            <Bar
                              dataKey="return_count"
                              name="return_count"
                              fill="var(--color-return_count)"
                              radius={[4, 4, 0, 0]}
                              barSize={10}
                              yAxisId="left"
                            />
                            <Line
                              type="monotone"
                              dataKey="return_rate"
                              name="return_rate"
                              stroke="var(--color-return_rate)"
                              strokeWidth={2}
                              dot={false}
                              yAxisId="right"
                            />
                          </ComposedChart>
                        </ChartContainer>
                        <div className={styles.chartLegend}>
                          <span className="flex items-center gap-1.5">
                            <span className="inline-block h-2.5 w-5 rounded-sm bg-[var(--warm-ledger-color-text-soft)]" />
                            销售数量
                          </span>
                          <span className="flex items-center gap-1.5">
                            <span className="inline-block h-2.5 w-5 rounded-sm bg-[var(--warm-ledger-color-accent)]" />
                            退货单数
                          </span>
                          <span className="flex items-center gap-1.5">
                            <span className="inline-block h-2.5 w-5 rounded-sm border-b-2 border-[color:var(--warm-ledger-color-accent)]" />
                            退货率（%）
                          </span>
                        </div>
                      </div>
                    ) : (
                      <EmptyTableState colSpan={1} message="暂无退货趋势数据" />
                    )}
                  </div>
                )}

                {activeTab === 'product-status' && (
                  <div className="space-y-4 p-4">
                    <h3 className={styles.sectionHeading}>商品状态分布</h3>
                    <div>
                      <WarmTable containerClassName="bg-[var(--warm-ledger-color-panel)]">
                        <TableHeader>
                          <TableRow>
                            <TableHead>商品状态</TableHead>
                            <TableHead className="text-right">数量</TableHead>
                            <TableHead className="text-right">占比</TableHead>
                          </TableRow>
                        </TableHeader>
                        <WarmProgressTableBody
                          refreshing={showRefreshProgress}
                          busy={isInitialDataLoading}
                          colSpan={3}
                        >
                          {data?.disposition_rows.length ? (
                            data.disposition_rows.map((row) => (
                              <TableRow key={row.detailed_disposition}>
                                <TableCell className="font-medium">
                                  <Badge variant="outline" className="mr-2">
                                    {row.disposition_display}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-right">
                                  {row.return_count.toLocaleString()}
                                </TableCell>
                                <TableCell className="text-right text-[var(--warm-ledger-color-text-muted)]">
                                  {row.percentage}%
                                </TableCell>
                              </TableRow>
                            ))
                          ) : (
                            <EmptyTableState colSpan={3} message="暂无商品状态数据" />
                          )}
                        </WarmProgressTableBody>
                      </WarmTable>
                    </div>
                  </div>
                )}

                {activeTab === 'inventory-status' && (
                  <div className="space-y-4 p-4">
                    <h3 className={styles.sectionHeading}>库存状态分布</h3>
                    <div>
                      <WarmTable containerClassName="bg-[var(--warm-ledger-color-panel)]">
                        <TableHeader>
                          <TableRow>
                            <TableHead>库存状态</TableHead>
                            <TableHead className="text-right">数量</TableHead>
                            <TableHead className="text-right">占比</TableHead>
                          </TableRow>
                        </TableHeader>
                        <WarmProgressTableBody
                          refreshing={showRefreshProgress}
                          busy={isInitialDataLoading}
                          colSpan={3}
                        >
                          {data?.status_rows.length ? (
                            data.status_rows.map((row) => (
                              <TableRow key={row.status}>
                                <TableCell className="font-medium">
                                  <Badge variant="outline" className="mr-2">
                                    {row.status_display}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-right">
                                  {row.return_count.toLocaleString()}
                                </TableCell>
                                <TableCell className="text-right text-[var(--warm-ledger-color-text-muted)]">
                                  {row.percentage}%
                                </TableCell>
                              </TableRow>
                            ))
                          ) : (
                            <EmptyTableState colSpan={3} message="暂无库存状态数据" />
                          )}
                        </WarmProgressTableBody>
                      </WarmTable>
                    </div>
                  </div>
                )}

                {activeTab === 'feedback' && (
                  <div className="space-y-4 p-4">
                    <h3 className={styles.sectionHeading}>顾客反馈</h3>
                    <WarmTable containerClassName="bg-[var(--warm-ledger-color-panel)]">
                      <TableHeader>
                        <TableRow>
                          <TableHead>日期</TableHead>
                          <TableHead>SKU</TableHead>
                          <TableHead>退货原因</TableHead>
                          <TableHead>顾客评论</TableHead>
                        </TableRow>
                      </TableHeader>
                      <WarmProgressTableBody
                        refreshing={showRefreshProgress}
                        busy={isInitialDataLoading}
                        colSpan={4}
                      >
                        {data?.feedback_rows.length ? (
                          data.feedback_rows.slice(0, 50).map((row, index) => (
                            <TableRow key={`${row.order_id}-${index}`}>
                              <TableCell className="text-[var(--warm-ledger-color-text-muted)]">
                                {row.return_date}
                              </TableCell>
                              <TableCell className="font-medium">{row.sku}</TableCell>
                              <TableCell>
                                <Badge variant="outline" className="text-xs">
                                  {row.reason_display}
                                </Badge>
                              </TableCell>
                              <TableCell
                                className="max-w-[300px] truncate text-[var(--warm-ledger-color-text-muted)]"
                                title={row.customer_comment}
                              >
                                {row.customer_comment}
                              </TableCell>
                            </TableRow>
                          ))
                        ) : (
                          <EmptyTableState colSpan={4} message="暂无顾客反馈数据" />
                        )}
                      </WarmProgressTableBody>
                    </WarmTable>
                  </div>
                )}

                {activeTab === 'raw' && (
                  <div className="space-y-4 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className={styles.sectionHeading}>亚马逊原始数据</h3>
                      <span className="font-mono text-xs text-[var(--warm-ledger-color-text-muted)]">
                        {rawRows
                          ? `${rawRows.start_date} 至 ${rawRows.end_date} · 共 ${rawRows.row_count.toLocaleString()} 条`
                          : '—'}
                      </span>
                    </div>
                    {rawRows && rawRows.row_count > RAW_DISPLAY_LIMIT && (
                      <p className="font-mono text-xs text-[var(--warm-ledger-color-accent)]">
                        页内仅展示前 {RAW_DISPLAY_LIMIT} 条，完整{' '}
                        {rawRows.row_count.toLocaleString()} 条请导出 Excel。
                      </p>
                    )}
                    {rawError ? (
                      <div className={styles.errorNotice} data-warm-state="error">
                        <span
                          className="text-sm text-[var(--warm-ledger-color-negative)]"
                          data-warm-state="error"
                        >
                          {rawError}
                        </span>
                        <WarmButton
                          type="button"
                          variant="secondary"
                          onClick={() => void loadRawRows(true)}
                          disabled={rawLoading}
                        >
                          重试
                        </WarmButton>
                      </div>
                    ) : (
                      <WarmTable
                        className="min-w-[2280px] table-auto text-xs"
                        containerClassName="max-h-[560px] overflow-auto bg-[var(--warm-ledger-color-panel)]"
                      >
                        <TableHeader>
                          <TableRow className={STICKY_TOP_ROW}>
                            {RETURN_RAW_COLUMNS.map((column) => (
                              <TableHead key={column.key} className={column.minWidth}>
                                {column.label}
                              </TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <WarmProgressTableBody
                          refreshing={showRefreshProgress}
                          busy={isInitialDataLoading || isRawTableLoading}
                          colSpan={RETURN_RAW_COLUMNS.length}
                        >
                          {rawNeedsMainData ? (
                            <EmptyTableState
                              colSpan={RETURN_RAW_COLUMNS.length}
                              message="请先加载退货分析数据"
                            />
                          ) : rawLoading || !rawRows ? (
                            Array.from({ length: 8 }).map((_, rowIndex) => (
                              <TableRow
                                key={`raw-skeleton-${rowIndex}`}
                                data-warm-skeleton="static"
                              >
                                {RETURN_RAW_COLUMNS.map((column) => (
                                  <TableCell key={column.key}>
                                    <div className={cn(styles.skeletonBar, 'h-4 w-20')} />
                                  </TableCell>
                                ))}
                              </TableRow>
                            ))
                          ) : rawRows.rows.length ? (
                            rawRows.rows.slice(0, RAW_DISPLAY_LIMIT).map((row, index) => (
                              <TableRow key={`${row.order_id}-${row.sku}-${index}`}>
                                {RETURN_RAW_COLUMNS.map((column) => {
                                  const value = row[column.key]
                                  const text =
                                    value === null || value === undefined ? '' : String(value)
                                  return (
                                    <TableCell
                                      key={column.key}
                                      className={cn(
                                        'text-[var(--warm-ledger-color-text-muted)]',
                                        column.key === 'quantity' && 'text-right tabular-nums',
                                        column.truncate && 'max-w-[320px] truncate'
                                      )}
                                      title={column.truncate ? text : undefined}
                                    >
                                      {text}
                                    </TableCell>
                                  )
                                })}
                              </TableRow>
                            ))
                          ) : (
                            <EmptyTableState
                              colSpan={RETURN_RAW_COLUMNS.length}
                              message="所选周期无原始退货数据"
                            />
                          )}
                        </WarmProgressTableBody>
                      </WarmTable>
                    )}
                  </div>
                )}

                {activeTab === 'summary' && (
                  <div className="space-y-4 p-4">
                    <div className="flex items-center justify-between">
                      <h3 className={styles.sectionHeading}>退货分析总结</h3>
                      {data && (
                        <span className="text-xs text-[var(--warm-ledger-color-text-muted)]">
                          {data.start_date} 至 {data.end_date}
                        </span>
                      )}
                    </div>
                    {isInitialDataLoading ? (
                      <div className="space-y-3">
                        {Array.from({ length: 8 }).map((_, i) => (
                          <div
                            key={i}
                            className={cn(styles.skeletonBar, 'h-4 w-full')}
                            data-warm-skeleton="static"
                          />
                        ))}
                      </div>
                    ) : (
                      <WarmProgressRegion refreshing={showRefreshProgress}>
                        {data?.summary_text ? (
                          <div className="space-y-4">
                            {/* Text Summary */}
                            <div className={styles.summaryText}>
                              <div className="prose prose-sm max-w-none dark:prose-invert whitespace-pre-wrap text-sm leading-relaxed">
                                {data.summary_text.split('\n').map((line, i) => {
                                  if (!line.trim()) {
                                    return <div key={i} className="h-3" />
                                  }
                                  if (
                                    line.startsWith('📊') ||
                                    line.startsWith('⚠️') ||
                                    line.startsWith('🔍') ||
                                    line.startsWith('📈') ||
                                    line.startsWith('📦') ||
                                    line.startsWith('🏭') ||
                                    line.startsWith('💡') ||
                                    line.startsWith('🗓️') ||
                                    line.startsWith('📏') ||
                                    line.startsWith('🖼️') ||
                                    line.startsWith('💬') ||
                                    line.startsWith('📋') ||
                                    line.startsWith('ℹ️') ||
                                    line.startsWith('⚡')
                                  ) {
                                    return (
                                      <p
                                        key={i}
                                        className="font-semibold text-[var(--warm-ledger-color-text)] mt-4 first:mt-0 mb-1"
                                      >
                                        {line}
                                      </p>
                                    )
                                  }
                                  return (
                                    <p key={i} className="text-[var(--warm-ledger-color-text-muted)] my-0.5">
                                      {line}
                                    </p>
                                  )
                                })}
                              </div>
                            </div>

                            {/* Weekday Distribution */}
                            {data.weekday_rows && data.weekday_rows.length > 0 && (
                              <div className={styles.subPanel}>
                                <h4 className="text-sm font-semibold mb-3">📅 星期退货分布</h4>
                                <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                                  {data.weekday_rows.map((row) => (
                                    <div
                                      key={row.weekday}
                                      className={styles.weekdayTile}
                                    >
                                      <div className="text-xs text-[var(--warm-ledger-color-text-muted)]">
                                        {row.weekday_display}
                                      </div>
                                      <div className="text-lg font-semibold mt-1">
                                        {row.return_count}
                                      </div>
                                      <div className="text-xs text-[var(--warm-ledger-color-text-muted)]">
                                        {row.percentage}%
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Fulfillment Center Distribution */}
                            {data.fulfillment_center_rows &&
                              data.fulfillment_center_rows.length > 0 && (
                                <div className={styles.subPanel}>
                                  <h4 className="text-sm font-semibold mb-3">🏭 仓库退货分布</h4>
                                  <WarmTable containerClassName="bg-[var(--warm-ledger-color-panel)]">
                                    <TableHeader>
                                      <TableRow>
                                        <TableHead>仓库</TableHead>
                                        <TableHead className="text-right">退货单数</TableHead>
                                        <TableHead className="text-right">退货件数</TableHead>
                                        <TableHead className="text-right">占比</TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {data.fulfillment_center_rows.slice(0, 10).map((row) => (
                                        <TableRow key={row.fulfillment_center_id}>
                                          <TableCell className="font-medium">
                                            {row.fulfillment_center_id}
                                          </TableCell>
                                          <TableCell className="text-right">
                                            {row.return_count.toLocaleString()}
                                          </TableCell>
                                          <TableCell className="text-right">
                                            {row.quantity.toLocaleString()}
                                          </TableCell>
                                          <TableCell className="text-right text-[var(--warm-ledger-color-text-muted)]">
                                            {row.percentage}%
                                          </TableCell>
                                        </TableRow>
                                      ))}
                                    </TableBody>
                                  </WarmTable>
                                </div>
                              )}
                          </div>
                        ) : (
                          <EmptyTableState colSpan={1} message="暂无总结数据" />
                        )}
                      </WarmProgressRegion>
                    )}
                  </div>
                )}
              </TabsContent>
            </DirectionalTabTransition>
          </DataTableCardBody>
        </DataTableCard>
      </Tabs>
        </>
      )}
    </div>
  )
}
