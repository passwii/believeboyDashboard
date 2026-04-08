'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import {
  TrendingUp,
  TrendingDown,
  Wallet,
  Eye,
  EyeOff,
  Download,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import {
  DataCard,
  DataCardHeader,
  DataCardContent,
  DataTableCard,
  DataTableCardHeader,
  DataTableCardBody,
  DataTableCardStatBar,
} from '@/components/ui/data-card'
import { logClientOperation } from '@/lib/operation-audit'
import {
  MonthPicker,
  formatMonthInputValue,
  parseMonthInputValue,
} from '@/components/ui/date-picker'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { StatCard } from '@/components/ui/stat-card'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { getClientCache, setClientCache } from '@/lib/client-cache'
import { resolveProjectCommissionUsd } from '@/lib/commission'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { formatLocalTimestampForFilename } from '@/lib/utils'

export type ProjectOption = {
  id: number | null
  name: string
  commission_basis?: string | null
  commission_rate?: number | null
}

type FinancialSeriesRow = {
  report_month: string
  income_sales: number
  income_refund: number
  income_adjustment: number
  income_other: number
  expense_selling_fee: number
  expense_fba_fee: number
  expense_inventory_fee: number
  expense_service_fee: number
  expense_advertising: number
  expense_other_fees: number
  income_total: number
  expense_total: number
  amazon_pay_back: number
  credit_card_deduction_usd: number
  fob_cost_rmb: number
  first_leg_cost_rmb: number
  has_source_report: boolean
}

type ExchangeRateListResponse = {
  data?: Array<{
    year_month: string
    rate: number
  }>
  pagination?: {
    totalPages: number
  }
}

type FinancialTrendPoint = {
  report_month: string
  income_total: number
  expense_total: number
  amazon_pay_back: number
  net_amount: number
  has_source_report: boolean
}

export type FinancialSeriesResponse = {
  project_id: number
  project_name: string
  start_month: string
  end_month: string
  rows: FinancialSeriesRow[]
  trend: {
    income_total_sum: number
    expense_total_sum: number
    amazon_pay_back_sum: number
    net_amount_sum: number
    points: FinancialTrendPoint[]
  }
}

type FinancialAccountingDetailLine = {
  income_en: string
  income_zh: string
  income_amount_usd: number
  income_source: string
  expense_en: string
  expense_zh: string
  expense_amount_usd: number
  expense_source: string
}

type FinancialAccountingDetailResponse = {
  project_id: number
  project_name: string
  report_month: string
  rows: FinancialAccountingDetailLine[]
}

type FinancialViewTab = 'financial' | 'accounting'

const API_BASE = '/api/backend'
const FINANCIAL_SERIES_CACHE_TTL_MS = 3 * 60 * 1000
const EXCHANGE_RATE_CACHE_TTL_MS = 30 * 60 * 1000
const EXCHANGE_RATE_CACHE_KEY = 'financial:exchange-rate:USD'

function financialSeriesCacheKey(
  projectId: number,
  startMonth: string,
  endMonth: string,
): string {
  return `financial:series:${projectId}:${startMonth || 'none'}:${endMonth || 'none'}`
}

function buildMonthRateMap(
  months: string[],
  sourceMap: Record<string, number>,
): Record<string, number> {
  const map: Record<string, number> = {}
  months.forEach((month) => {
    map[month] = sourceMap[month] ?? 0
  })
  return map
}

function oneYearAgoMonthString(): string {
  const now = new Date()
  now.setFullYear(now.getFullYear() - 1)
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

const chartConfig = {
  income_sales: {
    label: '销售额',
    color: 'hsl(var(--chart-2))',
  },
  income_refund: {
    label: '退款',
    color: 'hsl(var(--destructive))',
  },
} satisfies ChartConfig

function authHeaders(): Record<string, string> {
  return {}
}

function currentMonthString() {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function lastMonthString(): string {
  const now = new Date()
  now.setMonth(now.getMonth() - 1)
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function getBrowserDefaultMonthRange(): {
  startMonth: string
  endMonth: string
} {
  return {
    startMonth: oneYearAgoMonthString(),
    endMonth: lastMonthString(),
  }
}

function parseErrorBody(text: string, status: number): string {
  if (!text) return `请求失败 (${status})`
  try {
    const payload = JSON.parse(text) as {
      detail?: string | unknown[] | Record<string, unknown>
    }
    if (typeof payload.detail === 'string') return payload.detail
    if (Array.isArray(payload.detail)) {
      return payload.detail
        .map((item: unknown) => {
          if (typeof item === 'string') return item
          if (item && typeof item === 'object') {
            const maybeMsg = (item as { msg?: unknown }).msg
            return typeof maybeMsg === 'string'
              ? maybeMsg
              : JSON.stringify(item)
          }
          return String(item)
        })
        .join('; ')
    }
    if (payload.detail && typeof payload.detail === 'object')
      return JSON.stringify(payload.detail)
    return text
  } catch {
    return text
  }
}

function extractFilenameFromHeader(contentDisposition: string | null) {
  if (!contentDisposition) return null
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1])
  const basicMatch = contentDisposition.match(/filename="?([^"]+)"?/i)
  return basicMatch?.[1] ?? null
}

function formatMonth(month: string): string {
  const [year, mon] = month.split('-')
  const monInt = Number(mon)
  if (!year || Number.isNaN(monInt)) return month
  return `${year}年${monInt}月`
}

function calculateNetProfitUsd(row: FinancialSeriesRow, exchangeRate: number): number {
  const totalCostUsd =
    exchangeRate > 0
      ? (row.fob_cost_rmb + row.first_leg_cost_rmb) / exchangeRate
      : 0
  return row.amazon_pay_back - totalCostUsd - row.credit_card_deduction_usd
}

function calculateNetProfitRmb(row: FinancialSeriesRow, exchangeRate: number): number {
  return (
    row.amazon_pay_back * exchangeRate -
    row.fob_cost_rmb -
    row.first_leg_cost_rmb -
    row.credit_card_deduction_usd * exchangeRate
  )
}

function formatCurrency(value: number): string {
  const abs = Math.abs(value)
  const text = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${value < 0 ? '-' : ''}$${text}`
}

function formatRmb(value: number): string {
  const abs = Math.abs(value)
  const text = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${value < 0 ? '-' : ''}¥${text}`
}

function toPositiveRatio(numerator: number, denominator: number): number {
  const base = Math.abs(denominator)
  if (base === 0) return 0
  return Math.abs(numerator) / base
}

function toSignedRatio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0
  return numerator / denominator
}

function formatRatio(value: number): string {
  return `${(Math.abs(value) * 100).toFixed(1)}%`
}

function formatSignedRatio(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function formatRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '-'
  return value.toFixed(4)
}

function applyExcelBorder(cell: import('exceljs').Cell, color = 'FFE2E8F0') {
  cell.border = {
    top: { style: 'thin', color: { argb: color } },
    left: { style: 'thin', color: { argb: color } },
    bottom: { style: 'thin', color: { argb: color } },
    right: { style: 'thin', color: { argb: color } },
  }
}

function autosizeExcelColumns(worksheet: import('exceljs').Worksheet) {
  worksheet.columns?.forEach((column) => {
    let maxLength = 10
    column.eachCell?.({ includeEmpty: true }, (cell) => {
      const raw = cell.value
      const text = raw === null || raw === undefined ? '' : String(raw)
      maxLength = Math.max(maxLength, Math.min(text.length + 2, 20))
    })
    column.width = maxLength
  })
}

type FinancialExportDetailRow = {
  monthLabel: string
  incomeSales: number
  incomeRefund: number
  incomeAdjustment: number
  incomeOther: number
  expenseSellingFee: number
  expenseFbaFee: number
  expenseInventoryFee: number
  expenseServiceFee: number
  expenseAdvertising: number
  expenseOtherFees: number
  incomeTotal: number
  expenseTotal: number
  amazonPayBack: number
  creditCardDeductionUsd: number
  fobCostRmb: number
  firstLegCostRmb: number
  netProfitRmb: number
  netProfitUsd: number
  netProfitRate: number
  evaluationFeeRmb: number
  prepaymentOtherRmb: number
  operationCommissionRmb: number | null
  payableTotalRmb: number | null
  exchangeRate: number
  platformRatio: number
  deliveryRatio: number
  storageRatio: number
  serviceRatio: number
  adRatio: number
  refundRatio: number
  paybackRatio: number
  hasSourceReport: boolean
}

const EXPORT_DETAIL_COLUMNS = [
  { key: 'monthLabel', title: '年月', format: 'text', group: '基础信息' },
  {
    key: 'hasSourceReport',
    title: '是否有源报表',
    format: 'boolean',
    group: '基础信息',
  },
  {
    key: 'incomeSales',
    title: '销售额',
    format: 'currency_usd',
    group: '平台收入',
  },
  {
    key: 'incomeRefund',
    title: '退款',
    format: 'currency_usd',
    group: '平台收入',
  },
  {
    key: 'incomeAdjustment',
    title: '赔偿',
    format: 'currency_usd',
    group: '平台收入',
  },
  {
    key: 'incomeOther',
    title: '其他收入',
    format: 'currency_usd',
    group: '平台收入',
  },
  {
    key: 'expenseSellingFee',
    title: '平台费',
    format: 'currency_usd',
    group: '平台支出',
  },
  {
    key: 'expenseFbaFee',
    title: '配送费',
    format: 'currency_usd',
    group: '平台支出',
  },
  {
    key: 'expenseInventoryFee',
    title: '仓储费',
    format: 'currency_usd',
    group: '平台支出',
  },
  {
    key: 'expenseServiceFee',
    title: '服务费',
    format: 'currency_usd',
    group: '平台支出',
  },
  {
    key: 'expenseAdvertising',
    title: '广告费',
    format: 'currency_usd',
    group: '平台支出',
  },
  {
    key: 'expenseOtherFees',
    title: '其他费用',
    format: 'currency_usd',
    group: '平台支出',
  },
  {
    key: 'incomeTotal',
    title: '收入合计',
    format: 'currency_usd',
    group: '结果',
  },
  {
    key: 'expenseTotal',
    title: '支出合计',
    format: 'currency_usd',
    group: '结果',
  },
  {
    key: 'amazonPayBack',
    title: '亚马逊回款',
    format: 'currency_usd',
    group: '结果',
  },
  {
    key: 'creditCardDeductionUsd',
    title: '信用卡扣款',
    format: 'currency_usd',
    group: '结果',
  },
  {
    key: 'evaluationFeeRmb',
    title: '测评费用RMB',
    format: 'currency_rmb',
    group: '运营结算',
  },
  {
    key: 'prepaymentOtherRmb',
    title: '垫付其他RMB',
    format: 'currency_rmb',
    group: '运营结算',
  },
  {
    key: 'operationCommissionRmb',
    title: '运营佣金RMB',
    format: 'currency_rmb_nullable',
    group: '运营结算',
  },
  {
    key: 'payableTotalRmb',
    title: '应付总计RMB',
    format: 'currency_rmb_nullable',
    group: '运营结算',
  },
  { key: 'exchangeRate', title: '汇率', format: 'rate', group: '运营结算' },
  {
    key: 'platformRatio',
    title: '平台占比',
    format: 'percent',
    group: '费用占比',
  },
  {
    key: 'deliveryRatio',
    title: '配送占比',
    format: 'percent',
    group: '费用占比',
  },
  {
    key: 'storageRatio',
    title: '仓储占比',
    format: 'percent',
    group: '费用占比',
  },
  {
    key: 'serviceRatio',
    title: '服务占比',
    format: 'percent',
    group: '费用占比',
  },
  { key: 'adRatio', title: '广告占比', format: 'percent', group: '费用占比' },
  { key: 'refundRatio', title: '退款率', format: 'percent', group: '费用占比' },
  {
    key: 'paybackRatio',
    title: '回款率',
    format: 'percent_signed',
    group: '费用占比',
  },
  {
    key: 'fobCostRmb',
    title: 'FOB成本RMB',
    format: 'currency_rmb',
    group: '成本核算',
  },
  {
    key: 'firstLegCostRmb',
    title: '头程成本RMB',
    format: 'currency_rmb',
    group: '成本核算',
  },
  {
    key: 'netProfitRmb',
    title: '净利润RMB',
    format: 'currency_rmb',
    group: '成本核算',
  },
  {
    key: 'netProfitUsd',
    title: '净利润USD',
    format: 'currency_usd',
    group: '成本核算',
  },
  {
    key: 'netProfitRate',
    title: '净利率',
    format: 'percent_signed',
    group: '成本核算',
  },
] as const

const ADMIN_ONLY_EXPORT_KEYS = new Set<string>([
  'evaluationFeeRmb',
  'prepaymentOtherRmb',
  'operationCommissionRmb',
  'payableTotalRmb',
  'exchangeRate',
])

function getExcelNumFmt(
  format:
    | (typeof EXPORT_DETAIL_COLUMNS)[number]['format']
    | 'currency_usd'
    | 'currency_rmb'
    | 'percent'
    | 'percent_signed'
    | 'rate'
    | 'integer',
) {
  if (format === 'currency_usd') return '$#,##0.00;[Red]-$#,##0.00'
  if (format === 'currency_rmb' || format === 'currency_rmb_nullable')
    return '¥#,##0.00;[Red]-¥#,##0.00'
  if (format === 'percent' || format === 'percent_signed') return '0.0%'
  if (format === 'rate') return '0.0000'
  if (format === 'integer') return '#,##0'
  return null
}

const MONTH_STICKY_WIDTH = 128

// 简化的数字格式化，用于大数值显示
function formatCompactCurrency(value: number): string {
  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(2)}M`
  }
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`
  }
  return formatCurrency(value)
}

type FinancialDataClientProps = {
  initialProjects: ProjectOption[]
  initialProjectId: string
  initialStartMonth: string
  initialEndMonth: string
  initialData: FinancialSeriesResponse | null
  initialExchangeRateByMonth: Record<string, number>
}

function FinancialFilterSkeleton() {
  return (
    <div className='space-y-1.5'>
      <Skeleton className='h-3 w-14' />
      <Skeleton className='h-9 w-full' />
    </div>
  )
}

export default function FinancialDataClient({
  initialProjects,
  initialProjectId,
  initialStartMonth,
  initialEndMonth,
  initialData,
  initialExchangeRateByMonth,
}: FinancialDataClientProps) {
  const { data: session, status: sessionStatus } = useSession()
  const isAdmin = Boolean(session?.user?.isAdmin)
  const [projects, setProjects] = useState<ProjectOption[]>(initialProjects)
  const [projectsLoading, setProjectsLoading] = useState(
    initialProjects.length === 0,
  )
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)

  const [projectId, setProjectId] = useState(initialProjectId)
  const [startMonth, setStartMonth] = useState(initialStartMonth)
  const [endMonth, setEndMonth] = useState(initialEndMonth)

  const [data, setData] = useState<FinancialSeriesResponse | null>(initialData)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [recalculating, setRecalculating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exchangeRateByMonth, setExchangeRateByMonth] = useState<
    Record<string, number>
  >(initialExchangeRateByMonth)

  // 图表线条可见性状态
  const [visibleLines, setVisibleLines] = useState({
    income_sales: true,
    income_refund: true,
  })
  const [activeTab, setActiveTab] = useState<FinancialViewTab>('financial')
  const [accountingMonth, setAccountingMonth] = useState('')
  const [accountingRows, setAccountingRows] = useState<
    FinancialAccountingDetailLine[]
  >([])
  const [accountingLoading, setAccountingLoading] = useState(false)
  const [accountingExporting, setAccountingExporting] = useState(false)
  const [accountingError, setAccountingError] = useState<string | null>(null)

  const latestRequestIdRef = useRef(0)
  const skipInitialSeriesLoadRef = useRef(Boolean(initialData))

  useEffect(() => {
    if (initialStartMonth && initialEndMonth) return
    const defaults = getBrowserDefaultMonthRange()
    setStartMonth((current) => current || defaults.startMonth)
    setEndMonth((current) => current || defaults.endMonth)
  }, [initialEndMonth, initialStartMonth])

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true)
    setProjectLoadError(null)
    try {
      const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
      setProjects(payload)
      if (payload.length > 0 && !projectId) {
        setProjectId(String(payload[0].id))
      }
    } catch (loadError) {
      setProjectLoadError(
        loadError instanceof Error ? loadError.message : '项目列表加载失败',
      )
    } finally {
      setProjectsLoading(false)
    }
  }, [projectId, session])

  const loadExchangeRates = useCallback(async (months: string[]) => {
    const uniqueMonths = Array.from(new Set(months.filter(Boolean)))
    if (uniqueMonths.length === 0) {
      setExchangeRateByMonth({})
      return
    }

    const cached = getClientCache<Record<string, number>>(
      EXCHANGE_RATE_CACHE_KEY,
      EXCHANGE_RATE_CACHE_TTL_MS,
    )
    const hasCompleteCachedMonths =
      Boolean(cached) &&
      uniqueMonths.every((month) => month in (cached as Record<string, number>))
    if (cached) {
      setExchangeRateByMonth(buildMonthRateMap(uniqueMonths, cached))
      setError(null)
      if (hasCompleteCachedMonths) {
        return
      }
    }

    let page = 1
    let totalPages = 1
    const fetchedMap: Record<string, number> = {}

    while (page <= totalPages) {
      const response = await fetch(
        `/api/exchange-rates?currency=USD&page=${page}&pageSize=200`,
        {
          cache: 'no-store',
        },
      )
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }
      const payload = (await response.json()) as ExchangeRateListResponse
      const rows = Array.isArray(payload.data) ? payload.data : []
      rows.forEach((row) => {
        if (row.year_month) {
          fetchedMap[row.year_month] = Number(row.rate) || 0
        }
      })
      totalPages = Number(payload.pagination?.totalPages || 1)
      page += 1
    }

    setClientCache(EXCHANGE_RATE_CACHE_KEY, fetchedMap)
    setExchangeRateByMonth(buildMonthRateMap(uniqueMonths, fetchedMap))
    setError(null)
  }, [])

  const loadFinancialSeries = useCallback(
    async (options?: { force?: boolean }) => {
      const parsedProjectId = Number(projectId)
      if (!parsedProjectId) {
        setError('请先选择店铺')
        setData(null)
        return
      }

      const useCache = !options?.force
      const cacheKey = financialSeriesCacheKey(
        parsedProjectId,
        startMonth,
        endMonth,
      )
      const cachedPayload = useCache
        ? getClientCache<FinancialSeriesResponse>(
            cacheKey,
            FINANCIAL_SERIES_CACHE_TTL_MS,
          )
        : null
      const hasCachedPayload = Boolean(cachedPayload)
      if (cachedPayload) {
        setData(cachedPayload)
        setError(null)
      }

      const requestId = latestRequestIdRef.current + 1
      latestRequestIdRef.current = requestId

      setLoading(!hasCachedPayload)
      if (!hasCachedPayload) {
        setError(null)
      }

      try {
        const search = new URLSearchParams({
          project_id: String(parsedProjectId),
          fill_missing: 'true',
        })
        if (startMonth) search.set('start_month', startMonth)
        if (endMonth) search.set('end_month', endMonth)

        const response = await fetch(
          `${API_BASE}/api/v1/monthly-reports/financial-series?${search.toString()}`,
          {
            cache: 'no-store',
            headers: authHeaders(),
          },
        )
        if (!response.ok) {
          throw new Error(
            parseErrorBody(await response.text(), response.status),
          )
        }

        const payload = (await response.json()) as FinancialSeriesResponse
        if (latestRequestIdRef.current !== requestId) return
        setData(payload)
        setClientCache(cacheKey, payload)
      } catch (loadError) {
        if (latestRequestIdRef.current !== requestId) return
        if (!hasCachedPayload) {
          setData(null)
          setError(
            loadError instanceof Error ? loadError.message : '财务数据加载失败',
          )
        }
      } finally {
        if (latestRequestIdRef.current === requestId) {
          setLoading(false)
        }
      }
    },
    [projectId, startMonth, endMonth],
  )

  const recalculateFinancialSeries = useCallback(async () => {
    const parsedProjectId = Number(projectId)
    if (!parsedProjectId) {
      setError('请先选择店铺')
      return
    }

    setRecalculating(true)
    setError(null)

    try {
      const search = new URLSearchParams({
        project_id: String(parsedProjectId),
        fill_missing: 'true',
      })
      if (startMonth) search.set('start_month', startMonth)
      if (endMonth) search.set('end_month', endMonth)

      const response = await fetch(
        `${API_BASE}/api/v1/monthly-reports/financial-series/recalculate?${search.toString()}`,
        {
          method: 'POST',
          cache: 'no-store',
          headers: authHeaders(),
        },
      )
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }

      const payload = (await response.json()) as FinancialSeriesResponse
      setData(payload)
      const cacheKey = financialSeriesCacheKey(
        parsedProjectId,
        startMonth,
        endMonth,
      )
      setClientCache(cacheKey, payload)
    } catch (loadError) {
      setData(null)
      setError(loadError instanceof Error ? loadError.message : '重新核算失败')
    } finally {
      setRecalculating(false)
    }
  }, [projectId, startMonth, endMonth])

  const accountingMonthOptions = useMemo(() => {
    const rows = data?.rows ?? []
    return rows
      .filter((row) => row.has_source_report)
      .map((row) => row.report_month)
  }, [data?.rows])

  useEffect(() => {
    if (accountingMonthOptions.length === 0) {
      setAccountingMonth('')
      setAccountingRows([])
      return
    }
    if (accountingMonthOptions.includes(accountingMonth)) return
    setAccountingMonth(accountingMonthOptions[accountingMonthOptions.length - 1])
  }, [accountingMonth, accountingMonthOptions])

  const loadAccountingDetail = useCallback(async () => {
    const parsedProjectId = Number(projectId)
    if (!parsedProjectId || !accountingMonth) {
      setAccountingRows([])
      return
    }
    setAccountingLoading(true)
    setAccountingError(null)
    try {
      const search = new URLSearchParams({
        project_id: String(parsedProjectId),
        report_month: accountingMonth,
      })
      const response = await fetch(
        `${API_BASE}/api/v1/monthly-reports/financial-series/accounting-detail?${search.toString()}`,
        {
          cache: 'no-store',
          headers: authHeaders(),
        },
      )
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }
      const payload = (await response.json()) as FinancialAccountingDetailResponse
      setAccountingRows(payload.rows ?? [])
    } catch (loadError) {
      setAccountingRows([])
      setAccountingError(
        loadError instanceof Error ? loadError.message : '核算明细加载失败',
      )
    } finally {
      setAccountingLoading(false)
    }
  }, [accountingMonth, projectId])

  useEffect(() => {
    if (activeTab !== 'accounting' || !accountingMonth) return
    void loadAccountingDetail()
  }, [activeTab, accountingMonth, loadAccountingDetail])

  const exportAccountingDetail = useCallback(async () => {
    const parsedProjectId = Number(projectId)
    if (!parsedProjectId || !accountingMonth) {
      setAccountingError('请先选择核算月份')
      return
    }
    setAccountingExporting(true)
    setAccountingError(null)
    try {
      const search = new URLSearchParams({
        project_id: String(parsedProjectId),
        report_month: accountingMonth,
      })
      const response = await fetch(
        `${API_BASE}/api/v1/monthly-reports/financial-series/accounting-detail/export?${search.toString()}`,
        {
          cache: 'no-store',
          headers: authHeaders(),
        },
      )
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }
      const blob = await response.blob()
      const filename =
        extractFilenameFromHeader(response.headers.get('Content-Disposition')) ||
        `${accountingMonth}-核算明细.xlsx`
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.click()
      window.URL.revokeObjectURL(url)
      await logClientOperation({
        action: 'financial_data.accounting_detail.export',
        targetType: 'monthly_financial_accounting_detail',
        targetId: projectId,
        after: {
          project_id: projectId,
          report_month: accountingMonth,
          filename,
        },
      })
    } catch (exportError) {
      setAccountingError(
        exportError instanceof Error ? exportError.message : '导出核算明细失败',
      )
    } finally {
      setAccountingExporting(false)
    }
  }, [accountingMonth, projectId])

  useEffect(() => {
    if (initialData) {
      setClientCache(
        financialSeriesCacheKey(
          initialData.project_id,
          initialStartMonth,
          initialEndMonth,
        ),
        initialData,
      )
    }
    if (Object.keys(initialExchangeRateByMonth).length > 0) {
      setClientCache(EXCHANGE_RATE_CACHE_KEY, initialExchangeRateByMonth)
    }
  }, [
    initialData,
    initialEndMonth,
    initialExchangeRateByMonth,
    initialStartMonth,
  ])

  useEffect(() => {
    if (sessionStatus === 'loading') return
    if (projects.length > 0) {
      setProjectsLoading(false)
      return
    }
    void loadProjects()
  }, [loadProjects, projects.length, sessionStatus])

  useEffect(() => {
    if (!projectId || projectsLoading) return
    const shouldSkipInitialLoad =
      skipInitialSeriesLoadRef.current &&
      initialData &&
      String(initialData.project_id) === projectId &&
      startMonth === initialStartMonth &&
      endMonth === initialEndMonth

    if (shouldSkipInitialLoad) {
      skipInitialSeriesLoadRef.current = false
      return
    }
    void loadFinancialSeries()
  }, [
    endMonth,
    initialData,
    initialEndMonth,
    initialStartMonth,
    loadFinancialSeries,
    projectId,
    projectsLoading,
    startMonth,
  ])

  useEffect(() => {
    const months = (data?.rows ?? []).map((row) => row.report_month)
    if (months.length === 0) {
      setExchangeRateByMonth({})
      return
    }
    void loadExchangeRates(months).catch((loadError) => {
      setError(
        loadError instanceof Error ? loadError.message : '汇率数据加载失败',
      )
    })
  }, [data, loadExchangeRates])

  const trendPoints = useMemo(() => {
    if (!data) return []
    return data.rows.map((row) => ({
      report_month: row.report_month,
      month_label: formatMonth(row.report_month),
      income_sales: row.income_sales,
      // 退款统一按正值展示金额规模，避免与销售额方向相反影响可读性
      income_refund: Math.abs(row.income_refund),
      has_source_report: row.has_source_report,
    }))
  }, [data])

  // 计算趋势（最后一个有数据的月份与上一个的比较）
  const trends = useMemo(() => {
    if (!data || data.trend.points.length < 2)
      return { income: 0, expense: 0, amazon: 0 }
    const points = data.trend.points
    const validPoints = points.filter((p) => p.has_source_report)
    if (validPoints.length < 2) return { income: 0, expense: 0, amazon: 0 }

    const last = validPoints[validPoints.length - 1]
    const prev = validPoints[validPoints.length - 2]

    return {
      income:
        prev.income_total !== 0
          ? ((last.income_total - prev.income_total) /
              Math.abs(prev.income_total)) *
            100
          : 0,
      expense:
        prev.expense_total !== 0
          ? ((last.expense_total - prev.expense_total) /
              Math.abs(prev.expense_total)) *
            100
          : 0,
      amazon:
        prev.amazon_pay_back !== 0
          ? ((last.amazon_pay_back - prev.amazon_pay_back) /
              Math.abs(prev.amazon_pay_back)) *
            100
          : 0,
    }
  }, [data])

  const selectedProject = useMemo(
    () => projects.find((project) => String(project.id) === projectId) ?? null,
    [projects, projectId],
  )
  const commissionRate = selectedProject?.commission_rate ?? 0
  const commissionBasis = selectedProject?.commission_basis ?? null
  const disableCommission = !commissionBasis

  const totals = useMemo(() => {
    const rows = data?.rows ?? []
    return rows.reduce(
      (acc, row) => {
        const exchangeRate = exchangeRateByMonth[row.report_month] ?? 0
        const creditCardUsd = row.credit_card_deduction_usd
        const evaluationFeeRmb = 0
        const prepaymentOtherRmb = 0
        const operationCommission = resolveProjectCommissionUsd({
          commissionBasis,
          configuredCommissionRate: commissionRate,
          incomeTotalUsd: row.income_total,
          amazonPaybackUsd: row.amazon_pay_back,
        })
        const operationCommissionRmb =
          operationCommission.commissionUsd * exchangeRate
        const payableTotalRmb =
          evaluationFeeRmb + prepaymentOtherRmb + operationCommissionRmb
        const netProfitRmb = calculateNetProfitRmb(row, exchangeRate)
        const netProfitUsd = calculateNetProfitUsd(row, exchangeRate)

        return {
          income_sales: acc.income_sales + row.income_sales,
          income_refund: acc.income_refund + row.income_refund,
          income_adjustment: acc.income_adjustment + row.income_adjustment,
          income_other: acc.income_other + row.income_other,
          expense_selling_fee:
            acc.expense_selling_fee + row.expense_selling_fee,
          expense_fba_fee: acc.expense_fba_fee + row.expense_fba_fee,
          expense_inventory_fee:
            acc.expense_inventory_fee + row.expense_inventory_fee,
          expense_service_fee:
            acc.expense_service_fee + row.expense_service_fee,
          expense_advertising:
            acc.expense_advertising + row.expense_advertising,
          expense_other_fees: acc.expense_other_fees + row.expense_other_fees,
          income_total: acc.income_total + row.income_total,
          expense_total: acc.expense_total + row.expense_total,
          amazon_pay_back: acc.amazon_pay_back + row.amazon_pay_back,
          credit_card_deduction_usd:
            acc.credit_card_deduction_usd + creditCardUsd,
          fob_cost_rmb: acc.fob_cost_rmb + row.fob_cost_rmb,
          first_leg_cost_rmb: acc.first_leg_cost_rmb + row.first_leg_cost_rmb,
          net_profit_rmb: acc.net_profit_rmb + netProfitRmb,
          net_profit_usd: acc.net_profit_usd + netProfitUsd,
          evaluation_fee_rmb: acc.evaluation_fee_rmb + evaluationFeeRmb,
          prepayment_other_rmb: acc.prepayment_other_rmb + prepaymentOtherRmb,
          operation_commission_rmb:
            acc.operation_commission_rmb + operationCommissionRmb,
          payable_total_rmb: acc.payable_total_rmb + payableTotalRmb,
          exchange_rate_sum:
            acc.exchange_rate_sum + (exchangeRate > 0 ? exchangeRate : 0),
          exchange_rate_count:
            acc.exchange_rate_count + (exchangeRate > 0 ? 1 : 0),
        }
      },
      {
        income_sales: 0,
        income_refund: 0,
        income_adjustment: 0,
        income_other: 0,
        expense_selling_fee: 0,
        expense_fba_fee: 0,
        expense_inventory_fee: 0,
        expense_service_fee: 0,
        expense_advertising: 0,
        expense_other_fees: 0,
        income_total: 0,
        expense_total: 0,
        amazon_pay_back: 0,
        credit_card_deduction_usd: 0,
        fob_cost_rmb: 0,
        first_leg_cost_rmb: 0,
        net_profit_rmb: 0,
        net_profit_usd: 0,
        evaluation_fee_rmb: 0,
        prepayment_other_rmb: 0,
        operation_commission_rmb: 0,
        payable_total_rmb: 0,
        exchange_rate_sum: 0,
        exchange_rate_count: 0,
      },
    )
  }, [data, exchangeRateByMonth, commissionRate, commissionBasis])

  const detailExportRows = useMemo<FinancialExportDetailRow[]>(() => {
    const rows = data?.rows ?? []
    return rows.map((row) => {
      const exchangeRate = exchangeRateByMonth[row.report_month] ?? 0
      const evaluationFeeRmb = 0
      const prepaymentOtherRmb = 0
      const operationCommission = resolveProjectCommissionUsd({
        commissionBasis,
        configuredCommissionRate: commissionRate,
        incomeTotalUsd: row.income_total,
        amazonPaybackUsd: row.amazon_pay_back,
      })
      const operationCommissionRmb =
        operationCommission.commissionUsd * exchangeRate
      const payableTotalRmb =
        evaluationFeeRmb + prepaymentOtherRmb + operationCommissionRmb
      const netProfitRmb = calculateNetProfitRmb(row, exchangeRate)
      const netProfitUsd = calculateNetProfitUsd(row, exchangeRate)

      return {
        monthLabel: formatMonth(row.report_month),
        incomeSales: row.income_sales,
        incomeRefund: row.income_refund,
        incomeAdjustment: row.income_adjustment,
        incomeOther: row.income_other,
        expenseSellingFee: row.expense_selling_fee,
        expenseFbaFee: row.expense_fba_fee,
        expenseInventoryFee: row.expense_inventory_fee,
        expenseServiceFee: row.expense_service_fee,
        expenseAdvertising: row.expense_advertising,
        expenseOtherFees: row.expense_other_fees,
        incomeTotal: row.income_total,
        expenseTotal: row.expense_total,
        amazonPayBack: row.amazon_pay_back,
        creditCardDeductionUsd: row.credit_card_deduction_usd,
        fobCostRmb: row.fob_cost_rmb,
        firstLegCostRmb: row.first_leg_cost_rmb,
        netProfitRmb,
        netProfitUsd,
        netProfitRate: toSignedRatio(netProfitUsd, row.income_total),
        evaluationFeeRmb,
        prepaymentOtherRmb,
        operationCommissionRmb: disableCommission
          ? null
          : operationCommissionRmb,
        payableTotalRmb: disableCommission ? null : payableTotalRmb,
        exchangeRate,
        platformRatio: toPositiveRatio(
          row.expense_selling_fee,
          row.income_total,
        ),
        deliveryRatio: toPositiveRatio(row.expense_fba_fee, row.income_total),
        storageRatio: toPositiveRatio(
          row.expense_inventory_fee,
          row.income_total,
        ),
        serviceRatio: toPositiveRatio(
          row.expense_service_fee,
          row.income_total,
        ),
        adRatio: toPositiveRatio(row.expense_advertising, row.income_total),
        refundRatio: toPositiveRatio(row.income_refund, row.income_sales),
        paybackRatio: toSignedRatio(row.amazon_pay_back, row.income_total),
        hasSourceReport: row.has_source_report,
      }
    })
  }, [
    commissionBasis,
    commissionRate,
    data?.rows,
    disableCommission,
    exchangeRateByMonth,
  ])

  const exportFinancialAnalysis = useCallback(async () => {
    if (!data || detailExportRows.length === 0) {
      setError('当前没有可导出的月度财务数据。')
      return
    }

    setExporting(true)
    setError(null)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()
      const activeExportColumns = EXPORT_DETAIL_COLUMNS.filter(
        (column) => isAdmin || !ADMIN_ONLY_EXPORT_KEYS.has(column.key),
      )

      const summarySheet = workbook.addWorksheet('汇总', {
        views: [{ state: 'frozen', ySplit: 4, xSplit: 1 }],
      })
      const detailSheet = workbook.addWorksheet('月度财务明细', {
        views: [{ state: 'frozen', ySplit: 5, xSplit: 1 }],
      })

      const summaryLastColumn = 4
      summarySheet.mergeCells(1, 1, 1, summaryLastColumn)
      summarySheet.getCell(1, 1).value = '月度财务分析 - 汇总'
      summarySheet.getCell(1, 1).font = {
        name: 'Microsoft YaHei',
        size: 16,
        bold: true,
        color: { argb: 'FF0F172A' },
      }
      summarySheet.getCell(1, 1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE2E8F0' },
      }

      summarySheet.mergeCells(2, 1, 2, summaryLastColumn)
      summarySheet.getCell(2, 1).value =
        `店铺：${data.project_name}    区间：${formatMonth(data.start_month)} 至 ${formatMonth(data.end_month)}`
      summarySheet.getCell(2, 1).font = {
        name: 'Microsoft YaHei',
        size: 10,
        color: { argb: 'FF475569' },
      }
      summarySheet.getCell(2, 1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF8FAFC' },
      }

      const kpiHeader = summarySheet.getRow(4)
      kpiHeader.values = ['指标', '数值', '说明', '趋势']
      kpiHeader.eachCell((cell) => {
        cell.font = {
          name: 'Microsoft YaHei',
          bold: true,
          color: { argb: 'FF0F172A' },
        }
        cell.alignment = { vertical: 'middle', horizontal: 'center' }
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE2E8F0' },
        }
        applyExcelBorder(cell, 'FFCBD5E1')
      })

      const summaryKpis: Array<[string, number, string, number]> = [
        [
          '收入合计',
          data.trend.income_total_sum,
          '所选区间全部平台收入汇总',
          trends.income,
        ],
        [
          '支出合计',
          data.trend.expense_total_sum,
          '所选区间全部平台支出汇总',
          trends.expense,
        ],
        [
          '亚马逊返款',
          data.trend.amazon_pay_back_sum,
          '所选区间返款总额',
          trends.amazon,
        ],
        ['净额合计', data.trend.net_amount_sum, '收入减支出后的净值', 0],
      ]

      summaryKpis.forEach((item, index) => {
        const row = summarySheet.getRow(index + 5)
        row.getCell(1).value = item[0]
        row.getCell(2).value = item[1]
        row.getCell(2).numFmt = '$#,##0.00;[Red]-$#,##0.00'
        row.getCell(3).value = item[2]
        row.getCell(4).value = item[3] / 100
        row.getCell(4).numFmt = '0.0%'
        row.eachCell((cell, col) => {
          cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
          cell.alignment = {
            vertical: 'middle',
            horizontal: col === 2 || col === 4 ? 'right' : 'left',
          }
          applyExcelBorder(cell)
        })
      })

      const trendStartRow = 11
      summarySheet.mergeCells(
        trendStartRow,
        1,
        trendStartRow,
        summaryLastColumn,
      )
      summarySheet.getCell(trendStartRow, 1).value = '月度趋势'
      summarySheet.getCell(trendStartRow, 1).font = {
        name: 'Microsoft YaHei',
        bold: true,
        color: { argb: 'FF0F172A' },
      }
      summarySheet.getCell(trendStartRow, 1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF1F5F9' },
      }
      applyExcelBorder(summarySheet.getCell(trendStartRow, 1), 'FFCBD5E1')

      const trendHeader = summarySheet.getRow(trendStartRow + 1)
      trendHeader.values = ['月份', '收入合计', '支出合计', '亚马逊返款']
      trendHeader.eachCell((cell) => {
        cell.font = {
          name: 'Microsoft YaHei',
          bold: true,
          color: { argb: 'FF0F172A' },
        }
        cell.alignment = { vertical: 'middle', horizontal: 'center' }
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE2E8F0' },
        }
        applyExcelBorder(cell, 'FFCBD5E1')
      })

      data.trend.points.forEach((point, index) => {
        const row = summarySheet.getRow(trendStartRow + 2 + index)
        row.values = [
          formatMonth(point.report_month),
          point.income_total,
          point.expense_total,
          point.amazon_pay_back,
        ]
        row.eachCell((cell, colNumber) => {
          cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
          cell.alignment = {
            vertical: 'middle',
            horizontal: colNumber === 1 ? 'left' : 'right',
          }
          if (colNumber > 1) cell.numFmt = '$#,##0.00;[Red]-$#,##0.00'
          applyExcelBorder(cell)
        })
      })

      summarySheet.columns = [
        { width: 16 },
        { width: 16 },
        { width: 28 },
        { width: 12 },
      ]

      const detailLastColumn = activeExportColumns.length
      detailSheet.mergeCells(1, 1, 1, detailLastColumn)
      detailSheet.getCell(1, 1).value = '月度财务分析 - 月度财务明细'
      detailSheet.getCell(1, 1).font = {
        name: 'Microsoft YaHei',
        size: 16,
        bold: true,
        color: { argb: 'FF0F172A' },
      }
      detailSheet.getCell(1, 1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE2E8F0' },
      }

      detailSheet.mergeCells(2, 1, 2, detailLastColumn)
      detailSheet.getCell(2, 1).value =
        `店铺：${data.project_name}    区间：${formatMonth(data.start_month)} 至 ${formatMonth(data.end_month)}`
      detailSheet.getCell(2, 1).font = {
        name: 'Microsoft YaHei',
        size: 10,
        color: { argb: 'FF475569' },
      }
      detailSheet.getCell(2, 1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF8FAFC' },
      }

      const groupColors: Record<string, string> = {
        基础信息: 'FFF1F5F9',
        平台收入: 'FFDDF7EA',
        平台支出: 'FFFCE7C3',
        结果: 'FFDCEEFF',
        成本核算: 'FFFDE68A',
        运营结算: 'FFFDE6F2',
        费用占比: 'FFEADFEE',
      }

      const groupRow = detailSheet.getRow(4)
      const headRow = detailSheet.getRow(5)
      let currentColumn = 1
      Array.from(
        new Set(activeExportColumns.map((column) => column.group)),
      ).forEach((group) => {
        const groupColumns = activeExportColumns.filter(
          (column) => column.group === group,
        )
        const startColumn = currentColumn
        groupColumns.forEach((column) => {
          headRow.getCell(currentColumn).value = column.title
          currentColumn += 1
        })
        detailSheet.mergeCells(4, startColumn, 4, currentColumn - 1)
        const groupCell = groupRow.getCell(startColumn)
        groupCell.value = group
        groupCell.font = {
          name: 'Microsoft YaHei',
          bold: true,
          color: { argb: 'FF0F172A' },
        }
        groupCell.alignment = { vertical: 'middle', horizontal: 'center' }
        groupCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: groupColors[group] ?? 'FFE2E8F0' },
        }
        applyExcelBorder(groupCell, 'FFCBD5E1')
      })
      ;[groupRow, headRow].forEach((row) => {
        row.eachCell((cell) => {
          cell.font = {
            name: 'Microsoft YaHei',
            bold: true,
            color: { argb: 'FF0F172A' },
          }
          cell.alignment = {
            vertical: 'middle',
            horizontal: 'center',
            wrapText: true,
          }
          if (!cell.fill) {
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFE2E8F0' },
            }
          }
          applyExcelBorder(cell, 'FFCBD5E1')
        })
      })

      detailExportRows.forEach((rowData, index) => {
        const row = detailSheet.getRow(index + 6)
        activeExportColumns.forEach((column, columnIndex) => {
          const cell = row.getCell(columnIndex + 1)
          const value = rowData[column.key]
          cell.value =
            column.format === 'boolean' ? (value ? '有' : '无') : (value ?? '-')
          cell.font = {
            name: 'Microsoft YaHei',
            color: {
              argb: column.key === 'monthLabel' ? 'FF0F172A' : 'FF334155',
            },
            bold: column.key === 'monthLabel',
          }
          cell.alignment = {
            vertical: 'middle',
            horizontal:
              column.format === 'text' || column.format === 'boolean'
                ? 'left'
                : 'right',
          }
          const numFmt = getExcelNumFmt(column.format)
          if (typeof value === 'number' && numFmt) cell.numFmt = numFmt
          applyExcelBorder(cell)
        })
      })

      const totalRow = detailSheet.getRow(detailExportRows.length + 6)
      activeExportColumns.forEach((column, columnIndex) => {
        const cell = totalRow.getCell(columnIndex + 1)
        if (column.key === 'monthLabel') {
          cell.value = '合计'
        } else if (column.key === 'hasSourceReport') {
          cell.value = `${detailExportRows.length} 个月`
        } else if (column.key === 'incomeSales') {
          cell.value = totals.income_sales
        } else if (column.key === 'incomeRefund') {
          cell.value = totals.income_refund
        } else if (column.key === 'incomeAdjustment') {
          cell.value = totals.income_adjustment
        } else if (column.key === 'incomeOther') {
          cell.value = totals.income_other
        } else if (column.key === 'expenseSellingFee') {
          cell.value = totals.expense_selling_fee
        } else if (column.key === 'expenseFbaFee') {
          cell.value = totals.expense_fba_fee
        } else if (column.key === 'expenseInventoryFee') {
          cell.value = totals.expense_inventory_fee
        } else if (column.key === 'expenseServiceFee') {
          cell.value = totals.expense_service_fee
        } else if (column.key === 'expenseAdvertising') {
          cell.value = totals.expense_advertising
        } else if (column.key === 'expenseOtherFees') {
          cell.value = totals.expense_other_fees
        } else if (column.key === 'incomeTotal') {
          cell.value = totals.income_total
        } else if (column.key === 'expenseTotal') {
          cell.value = totals.expense_total
        } else if (column.key === 'amazonPayBack') {
          cell.value = totals.amazon_pay_back
        } else if (column.key === 'creditCardDeductionUsd') {
          cell.value = totals.credit_card_deduction_usd
        } else if (column.key === 'fobCostRmb') {
          cell.value = totals.fob_cost_rmb
        } else if (column.key === 'firstLegCostRmb') {
          cell.value = totals.first_leg_cost_rmb
        } else if (column.key === 'netProfitRmb') {
          cell.value = totals.net_profit_rmb
        } else if (column.key === 'netProfitUsd') {
          cell.value = totals.net_profit_usd
        } else if (column.key === 'netProfitRate') {
          cell.value = toSignedRatio(totals.net_profit_usd, totals.income_total)
        } else if (column.key === 'evaluationFeeRmb') {
          cell.value = totals.evaluation_fee_rmb
        } else if (column.key === 'prepaymentOtherRmb') {
          cell.value = totals.prepayment_other_rmb
        } else if (column.key === 'operationCommissionRmb') {
          cell.value = disableCommission ? '-' : totals.operation_commission_rmb
        } else if (column.key === 'payableTotalRmb') {
          cell.value = disableCommission ? '-' : totals.payable_total_rmb
        } else if (column.key === 'exchangeRate') {
          cell.value =
            totals.exchange_rate_count > 0
              ? totals.exchange_rate_sum / totals.exchange_rate_count
              : 0
        } else if (column.key === 'platformRatio') {
          cell.value = toPositiveRatio(
            totals.expense_selling_fee,
            totals.income_total,
          )
        } else if (column.key === 'deliveryRatio') {
          cell.value = toPositiveRatio(
            totals.expense_fba_fee,
            totals.income_total,
          )
        } else if (column.key === 'storageRatio') {
          cell.value = toPositiveRatio(
            totals.expense_inventory_fee,
            totals.income_total,
          )
        } else if (column.key === 'serviceRatio') {
          cell.value = toPositiveRatio(
            totals.expense_service_fee,
            totals.income_total,
          )
        } else if (column.key === 'adRatio') {
          cell.value = toPositiveRatio(
            totals.expense_advertising,
            totals.income_total,
          )
        } else if (column.key === 'refundRatio') {
          cell.value = toPositiveRatio(
            totals.income_refund,
            totals.income_sales,
          )
        } else if (column.key === 'paybackRatio') {
          cell.value = toSignedRatio(
            totals.amazon_pay_back,
            totals.income_total,
          )
        } else {
          cell.value = '-'
        }
        cell.font = {
          name: 'Microsoft YaHei',
          bold: true,
          color: { argb: 'FF0F172A' },
        }
        cell.alignment = {
          vertical: 'middle',
          horizontal: typeof cell.value === 'number' ? 'right' : 'left',
        }
        const numFmt = getExcelNumFmt(column.format)
        if (typeof cell.value === 'number' && numFmt) cell.numFmt = numFmt
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF8FAFC' },
        }
        applyExcelBorder(cell, 'FFCBD5E1')
      })

      const compactWidthKeys = new Set<string>([
        'hasSourceReport',
      ])
      detailSheet.columns = activeExportColumns.map((column) => ({
        width:
          column.key === 'monthLabel'
            ? 12
            : compactWidthKeys.has(column.key)
              ? 10
              : 12,
      }))

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const safeProjectName = data.project_name.replace(/[\\/:*?"<>|]/g, '-')
      const safeTimestamp = formatLocalTimestampForFilename()
      link.href = url
      link.download = `月度财务分析-${safeProjectName}-${safeTimestamp}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)
      await logClientOperation({
        action: 'financial_data.export',
        targetType: 'monthly_financial_analysis',
        targetId: projectId,
        after: {
          project_id: projectId,
          project_name: data.project_name,
          start_month: startMonth,
          end_month: endMonth,
          row_count: detailExportRows.length,
          filename: link.download,
        },
      })
    } catch (exportError) {
      setError(
        exportError instanceof Error ? exportError.message : '导出 Excel 失败',
      )
    } finally {
      setExporting(false)
    }
  }, [data, detailExportRows, disableCommission, endMonth, isAdmin, projectId, startMonth, totals, trends])
  const showSkeleton = loading && !data

  return (
    <div className='min-w-0 w-full space-y-6 overflow-x-hidden'>
      <DataCard>
        <DataCardHeader
          title='月度财务分析'
          titleClassName='text-2xl tracking-tight'
          badge={<p className='dashboard-kicker'>Analysis Console</p>}
        />
        <DataCardContent className='flex flex-wrap items-end gap-3'>
          {projectsLoading ? (
            <div className='min-w-[180px]'>
              <FinancialFilterSkeleton />
            </div>
          ) : (
            <div className='min-w-[180px] space-y-1.5'>
              <label className='text-xs text-muted-foreground'>店铺</label>
              <Select
                value={projectId}
                onValueChange={setProjectId}
                disabled={projects.length === 0}
              >
                <SelectTrigger className='h-9 border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]'>
                  <SelectValue placeholder='请选择店铺' />
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
          )}
          <div className='space-y-1.5'>
            <label
              htmlFor='financial_start_month'
              className='text-xs text-muted-foreground'
            >
              开始月份
            </label>
            <MonthPicker
              value={parseMonthInputValue(startMonth)}
              onChange={(date) => setStartMonth(formatMonthInputValue(date))}
              className='h-9 w-[170px]'
            />
          </div>
          <div className='space-y-1.5'>
            <label
              htmlFor='financial_end_month'
              className='text-xs text-muted-foreground'
            >
              结束月份
            </label>
            <MonthPicker
              value={parseMonthInputValue(endMonth)}
              onChange={(date) => setEndMonth(formatMonthInputValue(date))}
              className='h-9 w-[170px]'
            />
          </div>
          <Button
            type='button'
            variant='outline'
            className='h-9 border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]'
            onClick={() => void loadFinancialSeries({ force: true })}
            disabled={loading || !projectId}
          >
            {loading ? '刷新中...' : '刷新数据'}
          </Button>
        </DataCardContent>
      </DataCard>

      {projectLoadError ? (
        <div className='rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive'>
          {projectLoadError}
        </div>
      ) : null}
      {error ? (
        <div className='rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive'>
          {error}
        </div>
      ) : null}
      {accountingError ? (
        <div className='rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive'>
          {accountingError}
        </div>
      ) : null}

      <DataTableCard>
        <DataTableCardStatBar
          className='border-b border-border/70 bg-[hsl(var(--surface-subtle))]'
          items={[
            {
              label: '收入合计',
              value: data
                ? formatCurrency(data.trend.income_total_sum)
                : '$0.00',
              highlight: true,
            },
            {
              label: '支出合计',
              value: data
                ? formatCurrency(data.trend.expense_total_sum)
                : '$0.00',
            },
            {
              label: '亚马逊返款',
              value: data
                ? formatCurrency(data.trend.amazon_pay_back_sum)
                : '$0.00',
            },
          ]}
        />
      </DataTableCard>

      {/* 优化后的图表 - 使用 AreaChart 和渐变 */}
      <DataCard className='animate-enter'>
        <DataCardHeader
          title='月度趋势'
          badge={<p className='dashboard-kicker'>Financial Trend</p>}
          action={
            <div className='flex flex-wrap items-center justify-center gap-2 sm:justify-end'>
              <button
                type='button'
                onClick={() =>
                  setVisibleLines((prev) => ({
                    ...prev,
                    income_sales: !prev.income_sales,
                  }))
                }
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all ${
                  visibleLines.income_sales
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : 'border-border/70 bg-[hsl(var(--surface-soft))]/70 text-muted-foreground line-through dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]'
                }`}
              >
                {visibleLines.income_sales ? (
                  <Eye className='h-3 w-3' />
                ) : (
                  <EyeOff className='h-3 w-3' />
                )}
                <span
                  className='h-2 w-2 rounded-full'
                  style={{ backgroundColor: 'hsl(var(--chart-2))' }}
                />
                销售额
              </button>
              <button
                type='button'
                onClick={() =>
                  setVisibleLines((prev) => ({
                    ...prev,
                    income_refund: !prev.income_refund,
                  }))
                }
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all ${
                  visibleLines.income_refund
                    ? 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
                    : 'border-border/70 bg-[hsl(var(--surface-soft))]/70 text-muted-foreground line-through dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]'
                }`}
              >
                {visibleLines.income_refund ? (
                  <Eye className='h-3 w-3' />
                ) : (
                  <EyeOff className='h-3 w-3' />
                )}
                <span
                  className='h-2 w-2 rounded-full'
                  style={{ backgroundColor: 'hsl(var(--destructive))' }}
                />
                退款
              </button>
            </div>
          }
        />
        <DataCardContent className='px-2 pt-4 sm:px-6 sm:pt-6'>
          {loading && data ? (
            <div className='mb-4 inline-flex rounded-full border border-border/70 bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm'>
              趋势图更新中...
            </div>
          ) : null}
          {showSkeleton ? (
            <Skeleton className='h-[320px] w-full' />
          ) : trendPoints.length > 0 ? (
            <ChartContainer
              config={chartConfig}
              className='aspect-auto h-[320px] w-full'
            >
              <AreaChart
                accessibilityLayer
                data={trendPoints}
                margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id='fillSales' x1='0' y1='0' x2='0' y2='1'>
                    <stop
                      offset='5%'
                      stopColor='var(--color-income_sales)'
                      stopOpacity={0.7}
                    />
                    <stop
                      offset='95%'
                      stopColor='var(--color-income_sales)'
                      stopOpacity={0.05}
                    />
                  </linearGradient>
                  <linearGradient id='fillRefund' x1='0' y1='0' x2='0' y2='1'>
                    <stop
                      offset='5%'
                      stopColor='var(--color-income_refund)'
                      stopOpacity={0.7}
                    />
                    <stop
                      offset='95%'
                      stopColor='var(--color-income_refund)'
                      stopOpacity={0.05}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  vertical={false}
                  stroke='hsl(var(--border))'
                  strokeOpacity={0.5}
                />
                <XAxis
                  dataKey='month_label'
                  tickLine={false}
                  axisLine={false}
                  tickMargin={12}
                  minTickGap={32}
                  tick={{
                    fill: 'hsl(var(--muted-foreground))',
                    fontSize: 12,
                  }}
                />
                <YAxis
                  tickFormatter={(v) => formatCompactCurrency(Number(v))}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={12}
                  tick={{
                    fill: 'hsl(var(--muted-foreground))',
                    fontSize: 12,
                  }}
                  width={70}
                />
                <ChartTooltip
                  cursor={{
                    stroke: 'hsl(var(--muted-foreground))',
                    strokeWidth: 1,
                    strokeDasharray: '4 4',
                  }}
                  content={
                    <ChartTooltipContent
                      labelFormatter={(value) => String(value)}
                      formatter={(value, name) => {
                        // 将英文 dataKey 映射为中文
                        const nameMap: Record<string, string> = {
                          income_sales: '销售额',
                          income_refund: '退款',
                        }
                        const displayName =
                          nameMap[String(name)] || String(name)
                        return (
                          <div className='flex items-center justify-between gap-4'>
                            <span className='text-muted-foreground'>
                              {displayName}
                            </span>
                            <span className='font-medium'>
                              {formatCurrency(Number(value))}
                            </span>
                          </div>
                        )
                      }}
                      indicator='dot'
                    />
                  }
                />
                {visibleLines.income_refund && (
                  <Area
                    type='monotone'
                    dataKey='income_refund'
                    stroke='var(--color-income_refund)'
                    fill='url(#fillRefund)'
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                  />
                )}
                {visibleLines.income_sales && (
                  <Area
                    type='monotone'
                    dataKey='income_sales'
                    stroke='var(--color-income_sales)'
                    fill='url(#fillSales)'
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                  />
                )}
              </AreaChart>
            </ChartContainer>
          ) : (
            <div className='rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground'>
              暂无趋势数据
            </div>
          )}
        </DataCardContent>
      </DataCard>

      <DataTableCard className='animate-enter'>
        <DataTableCardHeader className='flex flex-wrap items-start justify-between gap-3 px-6 py-4'>
          <div>
            <p className='dashboard-kicker'>Operational Ledger</p>
            <div className='text-base font-semibold text-foreground'>
              {activeTab === 'financial' ? '月度汇总' : '月度明细'}
            </div>
            <p className='text-sm text-muted-foreground'>
              {activeTab === 'financial'
                ? data
                  ? `${data.project_name} · ${formatMonth(data.start_month)} 至 ${formatMonth(data.end_month)}`
                  : '按月展示收入/支出结构与返款'
                : accountingMonth
                  ? `报表核算 · ${formatMonth(accountingMonth)}`
                  : '请选择有源报表的月份查看月度明细'}
            </p>
          </div>
          <div className='ml-auto flex flex-wrap items-center justify-end gap-2'>
            {activeTab === 'accounting' ? (
              <>
                <Select
                  value={accountingMonth}
                  onValueChange={setAccountingMonth}
                  disabled={accountingMonthOptions.length === 0}
                >
                  <SelectTrigger className='h-8 w-[190px] border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]'>
                    <SelectValue placeholder='请选择月份' />
                  </SelectTrigger>
                  <SelectContent>
                    {accountingMonthOptions.map((month) => (
                      <SelectItem key={month} value={month}>
                        {formatMonth(month)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type='button'
                  variant='outline'
                  className='h-8'
                  onClick={() => void loadAccountingDetail()}
                  disabled={accountingLoading || !accountingMonth}
                >
                  {accountingLoading ? '加载中...' : '刷新核算明细'}
                </Button>
                <Button
                  type='button'
                  variant='outline'
                  className='h-8'
                  onClick={() => void exportAccountingDetail()}
                  disabled={
                    accountingExporting ||
                    !accountingMonth ||
                    accountingMonthOptions.length === 0
                  }
                >
                  {accountingExporting ? (
                    <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                  ) : (
                    <Download className='mr-2 h-4 w-4' />
                  )}
                  导出 Excel
                </Button>
              </>
            ) : (
              <>
                <Button
                  type='button'
                  variant='outline'
                  className='h-8'
                  onClick={() => void exportAccountingDetail()}
                  disabled={
                    accountingExporting ||
                    !accountingMonth ||
                    accountingMonthOptions.length === 0
                  }
                >
                  {accountingExporting ? (
                    <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                  ) : (
                    <Download className='mr-2 h-4 w-4' />
                  )}
                  导出 Excel
                </Button>
                <Button
                  type='button'
                  variant='outline'
                  className='h-8'
                  onClick={() => void recalculateFinancialSeries()}
                  disabled={recalculating || !data || data.rows.length === 0}
                >
                  {recalculating ? (
                    <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                  ) : (
                    <RefreshCw className='mr-2 h-4 w-4' />
                  )}
                  重新核算
                </Button>
              </>
            )}
            <div className='inline-flex rounded-md border border-border/70 bg-muted/20 p-1 dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]'>
              <button
                type='button'
                className={`rounded px-3 py-1.5 text-xs font-medium transition ${activeTab === 'financial' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
                onClick={() => setActiveTab('financial')}
              >
                月度汇总
              </button>
              <button
                type='button'
                className={`rounded px-3 py-1.5 text-xs font-medium transition ${activeTab === 'accounting' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}
                onClick={() => setActiveTab('accounting')}
              >
                月度明细
              </button>
            </div>
          </div>
        </DataTableCardHeader>
        <DataTableCardBody>
          {activeTab === 'financial' ? (
            <>
              {loading && data ? (
            <div className='mb-4 inline-flex rounded-full border border-border/70 bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm'>
              财务明细更新中...
            </div>
          ) : null}
          {showSkeleton ? (
            <div className='space-y-3'>
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className='h-10 w-full' />
              ))}
            </div>
          ) : data && data.rows.length > 0 ? (
            <Table
              noWrapperRounded
              containerClassName='w-full max-w-full overflow-x-auto'
              className={`w-max ${isAdmin ? 'min-w-[2500px]' : 'min-w-[2100px]'} table-fixed text-xs`}
            >
              <TableHeader>
                <TableRow className='bg-muted/30 hover:bg-muted/30'>
                  <TableHead
                    rowSpan={2}
                    className='sticky z-40 border-r border-border bg-muted px-2 py-2 text-center'
                    style={{ left: 0, minWidth: MONTH_STICKY_WIDTH }}
                  >
                    年/月度
                  </TableHead>
                  <TableHead
                    colSpan={4}
                    className='border-r bg-emerald-100 px-2 py-2 text-center text-foreground dark:bg-emerald-900/80 dark:text-emerald-100'
                  >
                    平台-收入 Income
                  </TableHead>
                  <TableHead
                    colSpan={6}
                    className='border-r bg-amber-500/15 px-2 py-2 text-center text-foreground'
                  >
                    平台-支出 Expense
                  </TableHead>
                  <TableHead
                    rowSpan={2}
                    className='border-r px-2 py-2 text-center'
                  >
                    收入合计
                  </TableHead>
                  <TableHead
                    rowSpan={2}
                    className='border-r px-2 py-2 text-center'
                  >
                    支出合计
                  </TableHead>
                  <TableHead
                    rowSpan={2}
                    className='border-r px-2 py-2 text-center'
                  >
                    亚马逊回款
                  </TableHead>
                  <TableHead
                    rowSpan={2}
                    className='border-r px-2 py-2 text-center'
                  >
                    信用卡扣款
                  </TableHead>
                  {isAdmin ? (
                    <>
                      <TableHead
                        rowSpan={2}
                        className='border-r px-2 py-2 text-center'
                      >
                        测评费用RMB
                      </TableHead>
                      <TableHead
                        rowSpan={2}
                        className='border-r px-2 py-2 text-center'
                      >
                        垫付其他RMB
                      </TableHead>
                      <TableHead
                        rowSpan={2}
                        className='border-r px-2 py-2 text-center'
                      >
                        运营佣金RMB
                      </TableHead>
                      <TableHead
                        rowSpan={2}
                        className='border-r px-2 py-2 text-center'
                      >
                        应付总计RMB
                      </TableHead>
                      <TableHead
                        rowSpan={2}
                        className='border-r px-2 py-2 text-center'
                      >
                        汇率
                      </TableHead>
                    </>
                  ) : null}
                  <TableHead
                    rowSpan={2}
                    className='border-r px-2 py-2 text-center'
                  >
                    平台占比
                  </TableHead>
                  <TableHead
                    rowSpan={2}
                    className='border-r px-2 py-2 text-center'
                  >
                    配送占比
                  </TableHead>
                  <TableHead
                    rowSpan={2}
                    className='border-r px-2 py-2 text-center'
                  >
                    仓储占比
                  </TableHead>
                  <TableHead
                    rowSpan={2}
                    className='border-r px-2 py-2 text-center'
                  >
                    服务占比
                  </TableHead>
                  <TableHead
                    rowSpan={2}
                    className='border-r px-2 py-2 text-center'
                  >
                    广告占比
                  </TableHead>
                  <TableHead
                    rowSpan={2}
                    className='border-r px-2 py-2 text-center'
                  >
                    退款率
                  </TableHead>
                  <TableHead
                    rowSpan={2}
                    className='border-r px-2 py-2 text-center'
                  >
                    回款率
                  </TableHead>
                  <TableHead
                    rowSpan={2}
                    className='border-r px-2 py-2 text-center'
                  >
                    FOB成本
                  </TableHead>
                  <TableHead
                    rowSpan={2}
                    className='border-r px-2 py-2 text-center'
                  >
                    头程成本
                  </TableHead>
                  <TableHead
                    rowSpan={2}
                    className='border-r px-2 py-2 text-center'
                  >
                    净利润RMB
                  </TableHead>
                  <TableHead rowSpan={2} className='px-2 py-2 text-center'>
                    净利润USD
                  </TableHead>
                  <TableHead rowSpan={2} className='px-2 py-2 text-center'>
                    净利率
                  </TableHead>
                </TableRow>
                <TableRow className='bg-muted/20 hover:bg-muted/20'>
                  <TableHead className='border-r bg-emerald-100 px-2 py-1.5 text-center dark:bg-emerald-900/80 dark:text-emerald-100'>
                    销售额
                  </TableHead>
                  <TableHead className='border-r bg-emerald-100 px-2 py-1.5 text-center dark:bg-emerald-900/80 dark:text-emerald-100'>
                    退款
                  </TableHead>
                  <TableHead className='border-r bg-emerald-100 px-2 py-1.5 text-center dark:bg-emerald-900/80 dark:text-emerald-100'>
                    赔偿
                  </TableHead>
                  <TableHead className='border-r bg-emerald-100 px-2 py-1.5 text-center dark:bg-emerald-900/80 dark:text-emerald-100'>
                    其他收入
                  </TableHead>
                  <TableHead className='border-r bg-amber-500/10 px-2 py-1.5 text-center'>
                    平台费
                  </TableHead>
                  <TableHead className='border-r bg-amber-500/10 px-2 py-1.5 text-center'>
                    配送费
                  </TableHead>
                  <TableHead className='border-r bg-amber-500/10 px-2 py-1.5 text-center'>
                    仓储费
                  </TableHead>
                  <TableHead className='border-r bg-amber-500/10 px-2 py-1.5 text-center'>
                    服务费
                  </TableHead>
                  <TableHead className='border-r bg-amber-500/10 px-2 py-1.5 text-center'>
                    广告费
                  </TableHead>
                  <TableHead className='border-r bg-amber-500/10 px-2 py-1.5 text-center'>
                    其他费用
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => {
                  const exchangeRate =
                    exchangeRateByMonth[row.report_month] ?? 0
                  const creditCardUsd = row.credit_card_deduction_usd
                  const evaluationFeeRmb = 0
                  const prepaymentOtherRmb = 0
                  const operationCommission = resolveProjectCommissionUsd({
                    commissionBasis,
                    configuredCommissionRate: commissionRate,
                    incomeTotalUsd: row.income_total,
                    amazonPaybackUsd: row.amazon_pay_back,
                  })
                  const operationCommissionRmb =
                    operationCommission.commissionUsd * exchangeRate
                  const payableTotalRmb =
                    evaluationFeeRmb +
                    prepaymentOtherRmb +
                    operationCommissionRmb
                  const netProfitRmb = calculateNetProfitRmb(row, exchangeRate)
                  const netProfitUsd = calculateNetProfitUsd(row, exchangeRate)
                  const rowBg = !row.has_source_report
                    ? 'bg-muted'
                    : 'bg-background'
                  const platformRatio = toPositiveRatio(
                    row.expense_selling_fee,
                    row.income_total,
                  )
                  const deliveryRatio = toPositiveRatio(
                    row.expense_fba_fee,
                    row.income_total,
                  )
                  const storageRatio = toPositiveRatio(
                    row.expense_inventory_fee,
                    row.income_total,
                  )
                  const serviceRatio = toPositiveRatio(
                    row.expense_service_fee,
                    row.income_total,
                  )
                  const adRatio = toPositiveRatio(
                    row.expense_advertising,
                    row.income_total,
                  )
                  const refundRatio = toPositiveRatio(
                    row.income_refund,
                    row.income_sales,
                  )
                  const paybackRatio = toSignedRatio(
                    row.amazon_pay_back,
                    row.income_total,
                  )
                  const netProfitRate = toSignedRatio(netProfitUsd, row.income_total)

                  return (
                    <TableRow
                      key={row.report_month}
                      className={
                        !row.has_source_report ? 'bg-muted/20' : undefined
                      }
                    >
                      <TableCell
                        className={`sticky z-20 border-r border-border px-2 py-1.5 font-medium ${rowBg}`}
                        style={{ left: 0, minWidth: MONTH_STICKY_WIDTH }}
                      >
                        <div className='flex items-center justify-between gap-1'>
                          <span className='whitespace-nowrap'>
                            {formatMonth(row.report_month)}
                          </span>
                          {!row.has_source_report ? (
                            <Badge
                              variant='outline'
                              className='h-4 whitespace-nowrap rounded-sm border-amber-500/30 bg-amber-500/10 px-1 text-[9px] leading-none text-amber-700 dark:text-amber-300'
                            >
                              无
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatCurrency(row.income_sales)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatCurrency(row.income_refund)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatCurrency(row.income_adjustment)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatCurrency(row.income_other)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatCurrency(row.expense_selling_fee)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatCurrency(row.expense_fba_fee)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatCurrency(row.expense_inventory_fee)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatCurrency(row.expense_service_fee)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatCurrency(row.expense_advertising)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatCurrency(row.expense_other_fees)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right font-semibold tabular-nums'>
                        {formatCurrency(row.income_total)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right font-semibold tabular-nums'>
                        {formatCurrency(row.expense_total)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right font-semibold tabular-nums'>
                        {formatCurrency(row.amazon_pay_back)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatCurrency(creditCardUsd)}
                      </TableCell>
                      {isAdmin ? (
                        <>
                          <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                            {formatRmb(evaluationFeeRmb)}
                          </TableCell>
                          <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                            {formatRmb(prepaymentOtherRmb)}
                          </TableCell>
                          <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                            {disableCommission
                              ? '-'
                              : formatRmb(operationCommissionRmb)}
                          </TableCell>
                          <TableCell className='border-r px-2 py-1.5 text-right font-semibold tabular-nums'>
                            {disableCommission
                              ? '-'
                              : formatRmb(payableTotalRmb)}
                          </TableCell>
                          <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                            {formatRate(exchangeRate)}
                          </TableCell>
                        </>
                      ) : null}
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatRatio(platformRatio)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatRatio(deliveryRatio)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatRatio(storageRatio)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatRatio(serviceRatio)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatRatio(adRatio)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatRatio(refundRatio)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatSignedRatio(paybackRatio)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatRmb(row.fob_cost_rmb)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                        {formatRmb(row.first_leg_cost_rmb)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-1.5 text-right font-semibold tabular-nums'>
                        {formatRmb(netProfitRmb)}
                      </TableCell>
                      <TableCell className='px-2 py-1.5 text-right font-semibold tabular-nums'>
                        {formatCurrency(netProfitUsd)}
                      </TableCell>
                      <TableCell className='px-2 py-1.5 text-right font-semibold tabular-nums'>
                        {formatSignedRatio(netProfitRate)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
              <TableFooter>
                <TableRow className='bg-muted font-semibold hover:bg-muted'>
                  <TableCell
                    className='sticky z-30 border-r border-border bg-muted px-2 py-2'
                    style={{ left: 0, minWidth: MONTH_STICKY_WIDTH }}
                  >
                    合计
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatCurrency(totals.income_sales)}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatCurrency(totals.income_refund)}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatCurrency(totals.income_adjustment)}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatCurrency(totals.income_other)}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatCurrency(totals.expense_selling_fee)}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatCurrency(totals.expense_fba_fee)}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatCurrency(totals.expense_inventory_fee)}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatCurrency(totals.expense_service_fee)}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatCurrency(totals.expense_advertising)}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatCurrency(totals.expense_other_fees)}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatCurrency(totals.income_total)}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatCurrency(totals.expense_total)}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatCurrency(totals.amazon_pay_back)}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatCurrency(totals.credit_card_deduction_usd)}
                  </TableCell>
                  {isAdmin ? (
                    <>
                      <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                        {formatRmb(totals.evaluation_fee_rmb)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                        {formatRmb(totals.prepayment_other_rmb)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                        {disableCommission
                          ? '-'
                          : formatRmb(totals.operation_commission_rmb)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                        {disableCommission
                          ? '-'
                          : formatRmb(totals.payable_total_rmb)}
                      </TableCell>
                      <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                        {formatRate(
                          totals.exchange_rate_count > 0
                            ? totals.exchange_rate_sum /
                                totals.exchange_rate_count
                            : 0,
                        )}
                      </TableCell>
                    </>
                  ) : null}
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatRatio(
                      toPositiveRatio(
                        totals.expense_selling_fee,
                        totals.income_total,
                      ),
                    )}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatRatio(
                      toPositiveRatio(
                        totals.expense_fba_fee,
                        totals.income_total,
                      ),
                    )}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatRatio(
                      toPositiveRatio(
                        totals.expense_inventory_fee,
                        totals.income_total,
                      ),
                    )}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatRatio(
                      toPositiveRatio(
                        totals.expense_service_fee,
                        totals.income_total,
                      ),
                    )}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatRatio(
                      toPositiveRatio(
                        totals.expense_advertising,
                        totals.income_total,
                      ),
                    )}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatRatio(
                      toPositiveRatio(
                        totals.income_refund,
                        totals.income_sales,
                      ),
                    )}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatSignedRatio(
                      toSignedRatio(
                        totals.amazon_pay_back,
                        totals.income_total,
                      ),
                    )}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatRmb(totals.fob_cost_rmb)}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatRmb(totals.first_leg_cost_rmb)}
                  </TableCell>
                  <TableCell className='border-r px-2 py-2 text-right tabular-nums'>
                    {formatRmb(totals.net_profit_rmb)}
                  </TableCell>
                  <TableCell className='px-2 py-2 text-right tabular-nums'>
                    {formatCurrency(totals.net_profit_usd)}
                  </TableCell>
                  <TableCell className='px-2 py-2 text-right tabular-nums'>
                    {formatSignedRatio(
                      toSignedRatio(totals.net_profit_usd, totals.income_total),
                    )}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          ) : (
            <div className='rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground'>
              当前筛选条件暂无财务数据
            </div>
          )}
            </>
          ) : (
            <>
              {accountingLoading && accountingRows.length > 0 ? (
                <div className='mb-4 inline-flex rounded-full border border-border/70 bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm'>
                  月度明细更新中...
                </div>
              ) : null}
              {accountingLoading && accountingRows.length === 0 ? (
                <div className='space-y-3'>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className='h-10 w-full' />
                  ))}
                </div>
              ) : accountingMonth && accountingRows.length > 0 ? (
                <Table
                  noWrapperRounded
                  containerClassName='w-full max-w-full overflow-x-auto'
                  className='w-max min-w-[1400px] table-fixed text-xs'
                >
                  <TableHeader>
                    <TableRow className='bg-muted/30 hover:bg-muted/30'>
                      <TableHead colSpan={4} className='border-r bg-emerald-100 px-2 py-2 text-center dark:bg-emerald-900/80 dark:text-emerald-100'>
                        Income（收入）
                      </TableHead>
                      <TableHead className='border-r px-2 py-2 text-center' />
                      <TableHead colSpan={4} className='bg-amber-500/15 px-2 py-2 text-center'>
                        Expense（支出）
                      </TableHead>
                    </TableRow>
                    <TableRow className='bg-muted/20 hover:bg-muted/20'>
                      <TableHead className='border-r px-2 py-1.5 text-center'>Income</TableHead>
                      <TableHead className='border-r px-2 py-1.5 text-center'>收入</TableHead>
                      <TableHead className='border-r px-2 py-1.5 text-center'>In金额（USD）</TableHead>
                      <TableHead className='border-r px-2 py-1.5 text-center'>In源表</TableHead>
                      <TableHead className='border-r px-2 py-1.5 text-center' />
                      <TableHead className='border-r px-2 py-1.5 text-center'>Expense</TableHead>
                      <TableHead className='border-r px-2 py-1.5 text-center'>支出</TableHead>
                      <TableHead className='border-r px-2 py-1.5 text-center'>Ex金额（USD）</TableHead>
                      <TableHead className='px-2 py-1.5 text-center'>Ex源表</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accountingRows.map((row, index) => (
                      <TableRow key={`${row.income_en}-${row.expense_en}-${index}`}>
                        <TableCell className='border-r px-2 py-1.5'>{row.income_en || '-'}</TableCell>
                        <TableCell className='border-r px-2 py-1.5'>{row.income_zh || '-'}</TableCell>
                        <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                          {formatCurrency(row.income_amount_usd)}
                        </TableCell>
                        <TableCell className='border-r px-2 py-1.5'>{row.income_source || '-'}</TableCell>
                        <TableCell className='border-r px-2 py-1.5 text-center text-muted-foreground'>|</TableCell>
                        <TableCell className='border-r px-2 py-1.5'>{row.expense_en || '-'}</TableCell>
                        <TableCell className='border-r px-2 py-1.5'>{row.expense_zh || '-'}</TableCell>
                        <TableCell className='border-r px-2 py-1.5 text-right tabular-nums'>
                          {formatCurrency(row.expense_amount_usd)}
                        </TableCell>
                        <TableCell className='px-2 py-1.5'>{row.expense_source || '-'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className='rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground'>
                  {accountingMonth
                    ? '当前月份暂无月度明细'
                    : '请选择有源报表月份查看月度明细'}
                </div>
              )}
            </>
          )}
        </DataTableCardBody>
      </DataTableCard>
    </div>
  )
}
