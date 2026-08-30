'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AreaChartCard,
  type ChartConfig,
} from '@/components/charts'
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
import { BarSkeleton } from '@/components/ui/table-skeleton'
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
import { useMobile } from '@/lib/hooks/use-mobile'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useUrlParam, useUrlParams } from '@/lib/hooks/use-url-param'
import { useAutoSelectFirstProject } from '@/lib/hooks/use-auto-select-first-project'
import { getCountryLabel } from '@/lib/country'
import { getExcelNumFmt } from './excel-num-fmt'
import { formatLocalTimestampForFilename } from '@/lib/utils'
import {
  DEFAULT_REPORT_UPLOAD_COUNTRY,
  type ReportUploadCountry,
} from '@/components/report-upload/types'
import { VAT_COUNTRIES } from '@/lib/console-constants'
import { CountrySelect, FilterField, RefreshButton } from '@/components/dashboard/console'

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
  income_vat_total?: number
  income_sales_with_tax?: number
  expense_vat_total?: number
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
  // BEL-43: backend stamps the local currency ISO code (USD/EUR/GBP).
  // Frontend maps this to the symbol/label so values render in the
  // correct currency after the user switches country.
  currency_code?: string | null
  // Row layout discriminator produced by the backend:
  //   "detail" - a regular income/expense line item
  //   "spacer" - a blank separator row between details and totals
  //   "total"  - the bottom row carrying Total_Income and Total_Expense
  //              on the same visual line
  // Defaults to "detail" for backward compatibility with older responses
  // that do not stamp this field.
  kind?: 'detail' | 'spacer' | 'total'
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
const EXCHANGE_RATE_CACHE_KEY_PREFIX = 'financial:exchange-rate'

function getExchangeRateCacheKey(currencyLabel: string): string {
  return `${EXCHANGE_RATE_CACHE_KEY_PREFIX}:${currencyLabel}`
}

function financialSeriesCacheKey(
  projectId: number,
  country: string,
  startMonth: string,
  endMonth: string
): string {
  return `financial:series:${projectId}:${country}:${startMonth || 'none'}:${endMonth || 'none'}`
}

function buildMonthRateMap(
  months: string[],
  sourceMap: Record<string, number>
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

// monthRange URL 参数值：滚动默认窗口（近 12 个月、截至上月）。
// 带此标记的 URL 每次加载都按"当前时间"重算窗口，具体月份随时间推进而不固化。
const ROLLING_MONTH_RANGE_MARKER = 'last12m'

// useUrlParams 的 defaults 必须是稳定引用，否则 setValues 每帧重建。
const MONTH_URL_DEFAULTS = { fromMonth: '', toMonth: '', monthRange: '' }

export function getBrowserDefaultMonthRange(): {
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
            return typeof maybeMsg === 'string' ? maybeMsg : JSON.stringify(item)
          }
          return String(item)
        })
        .join('; ')
    }
    if (payload.detail && typeof payload.detail === 'object') return JSON.stringify(payload.detail)
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

function isMonthWithinRange(month: string, startMonth: string, endMonth: string): boolean {
  return month >= startMonth && month <= endMonth
}

function calculateNetProfitUsd(row: FinancialSeriesRow, exchangeRate: number): number {
  const totalCostUsd =
    exchangeRate > 0 ? (row.fob_cost_rmb + row.first_leg_cost_rmb) / exchangeRate : 0
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

// 销售额展示口径：后端对 US/DE/UK 都返回 ``income_sales_with_tax``，其中
// US = net（sum of product_sales），DE/UK = 含税（product price + VAT）。
// 兜底到 ``income_sales`` 覆盖存量报表或字段缺失场景，让前端无分支消费。
function resolveDisplaySales(row: FinancialSeriesRow): number {
  return row.income_sales_with_tax ?? row.income_sales
}

function formatCurrency(value: number, symbol = '$'): string {
  const abs = Math.abs(value)
  const text = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${value < 0 ? '-' : ''}${symbol}${text}`
}

// 货币符号映射（基于实际支持的站点）。
// 在 BEL-43 之前由前端按 country 维护；现在由后端在月度明细行上
// 返回 `currency_code`，前端保留此表仅作为月度汇总 Tab 的兜底
// （汇总 Tab 的 series 走的是不同接口，目前不返回 currency_code）。
const CURRENCY_SYMBOLS: Record<ReportUploadCountry, string> = {
  US: '$',
  DE: '€',
  UK: '£',
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
  vatTotal?: number
  incomeSalesWithTax?: number
  expenseVatTotal?: number
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

type FinancialExportTotals = {
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
  vatTotal?: number
  incomeVatTotal?: number
  incomeSalesWithTax?: number
  expenseVatTotal?: number
  amazonPayBack: number
  creditCardDeductionUsd: number
  fobCostRmb: number
  firstLegCostRmb: number
  netProfitRmb: number
  netProfitUsd: number
  evaluationFeeRmb: number
  prepaymentOtherRmb: number
  operationCommissionRmb: number
  payableTotalRmb: number
  exchangeRateSum: number
  exchangeRateCount: number
}

function buildFinancialExportTotals(rows: FinancialExportDetailRow[]): FinancialExportTotals {
  return rows.reduce<FinancialExportTotals>(
    (acc, row) => ({
      incomeSales: acc.incomeSales + row.incomeSales,
      incomeRefund: acc.incomeRefund + row.incomeRefund,
      incomeAdjustment: acc.incomeAdjustment + row.incomeAdjustment,
      incomeOther: acc.incomeOther + row.incomeOther,
      expenseSellingFee: acc.expenseSellingFee + row.expenseSellingFee,
      expenseFbaFee: acc.expenseFbaFee + row.expenseFbaFee,
      expenseInventoryFee: acc.expenseInventoryFee + row.expenseInventoryFee,
      expenseServiceFee: acc.expenseServiceFee + row.expenseServiceFee,
      expenseAdvertising: acc.expenseAdvertising + row.expenseAdvertising,
      expenseOtherFees: acc.expenseOtherFees + row.expenseOtherFees,
      incomeTotal: acc.incomeTotal + row.incomeTotal,
      expenseTotal: acc.expenseTotal + row.expenseTotal,
      vatTotal: (acc.vatTotal ?? 0) + (row.vatTotal ?? 0),
      incomeVatTotal: (acc.incomeVatTotal ?? 0) - (row.vatTotal ?? 0),
      incomeSalesWithTax: (acc.incomeSalesWithTax ?? 0) + (row.incomeSalesWithTax ?? 0),
      expenseVatTotal: (acc.expenseVatTotal ?? 0) + (row.expenseVatTotal ?? 0),
      amazonPayBack: acc.amazonPayBack + row.amazonPayBack,
      creditCardDeductionUsd: acc.creditCardDeductionUsd + row.creditCardDeductionUsd,
      fobCostRmb: acc.fobCostRmb + row.fobCostRmb,
      firstLegCostRmb: acc.firstLegCostRmb + row.firstLegCostRmb,
      netProfitRmb: acc.netProfitRmb + row.netProfitRmb,
      netProfitUsd: acc.netProfitUsd + row.netProfitUsd,
      evaluationFeeRmb: acc.evaluationFeeRmb + row.evaluationFeeRmb,
      prepaymentOtherRmb: acc.prepaymentOtherRmb + row.prepaymentOtherRmb,
      operationCommissionRmb: acc.operationCommissionRmb + (row.operationCommissionRmb ?? 0),
      payableTotalRmb: acc.payableTotalRmb + (row.payableTotalRmb ?? 0),
      exchangeRateSum: acc.exchangeRateSum + (row.exchangeRate > 0 ? row.exchangeRate : 0),
      exchangeRateCount: acc.exchangeRateCount + (row.exchangeRate > 0 ? 1 : 0),
    }),
    {
      incomeSales: 0,
      incomeRefund: 0,
      incomeAdjustment: 0,
      incomeOther: 0,
      expenseSellingFee: 0,
      expenseFbaFee: 0,
      expenseInventoryFee: 0,
      expenseServiceFee: 0,
      expenseAdvertising: 0,
      expenseOtherFees: 0,
      incomeTotal: 0,
      expenseTotal: 0,
      vatTotal: 0,
      incomeVatTotal: 0,
      incomeSalesWithTax: 0,
      expenseVatTotal: 0,
      amazonPayBack: 0,
      creditCardDeductionUsd: 0,
      fobCostRmb: 0,
      firstLegCostRmb: 0,
      netProfitRmb: 0,
      netProfitUsd: 0,
      evaluationFeeRmb: 0,
      prepaymentOtherRmb: 0,
      operationCommissionRmb: 0,
      payableTotalRmb: 0,
      exchangeRateSum: 0,
      exchangeRateCount: 0,
    }
  )
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
    key: 'vatTotal',
    title: 'VAT (销售税)',
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

function FinancialFilterSkeleton() {
  return (
    <div className="space-y-1.5">
      <Skeleton className="h-3 w-14" />
      <Skeleton className="h-9 w-full" />
    </div>
  )
}

export default function DisplayTab() {
  const { data: session, status: sessionStatus } = useSession()
  const isAdmin = Boolean(session?.user?.isAdmin)
  const isMobile = useMobile()
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)

  // 项目 / 国家同步到 URL search param，刷新 / 分享链接 / 浏览器后退都能记住选择。
  // 默认值为空串，URL 有值时覆盖。（起止月份见下方 monthUrl，带滚动默认语义）
  const [projectId, setProjectId] = useUrlParam<string>('project', '')

  // 进入页面默认选中第一个真实项目,内容立即加载（跳过 all / 空白意图）
  useAutoSelectFirstProject(projects, projectId, setProjectId)
  const [country, setCountry] = useUrlParam<ReportUploadCountry>(
    'country',
    DEFAULT_REPORT_UPLOAD_COUNTRY,
    { allowed: ['US', 'DE', 'UK'] }
  )
  // 起止月份同步到 URL search param（fromMonth/toMonth），URL 始终携带具体月份，
  // 刷新 / 分享链接 / 浏览器后退都能还原窗口。monthRange 标记窗口来源：
  //  - last12m：滚动默认窗口，每次加载按当前时间重算（近 12 个月、截至上月），
  //    URL 里的具体月份随之推进，不固化为生成 URL 时的月份；
  //  - 无标记：用户动过月份选择器后的显式窗口，具体月份固化、完全按 URL 还原。
  const [monthUrl, setMonthUrl] = useUrlParams(MONTH_URL_DEFAULTS)
  const startMonth = monthUrl.fromMonth
  const endMonth = monthUrl.toMonth

  // DE/UK 报表启用 VAT 列；US 报表无 VAT 数据
  const showVatColumn = useMemo(() => VAT_COUNTRIES.has(country as 'DE' | 'UK'), [country])

  // Currency label and symbol based on country
  const currencySymbol = useMemo(() => {
    return CURRENCY_SYMBOLS[country] || '$'
  }, [country])

  const currencyLabel = useMemo(() => {
    switch (country) {
      case 'DE':
        return 'EUR'
      case 'UK':
        return 'GBP'
      default:
        return 'USD'
    }
  }, [country])

  const [data, setData] = useState<FinancialSeriesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [recalculating, setRecalculating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 重算后触发核算明细刷新的计数器
  const [accountingRefreshKey, setAccountingRefreshKey] = useState(0)
  const [exchangeRateByMonth, setExchangeRateByMonth] = useState<Record<string, number>>({})

  // 图表线条可见性状态
  const [visibleLines, setVisibleLines] = useState({
    income_sales: true,
    income_refund: true,
  })
  const [activeTab, setActiveTab] = useState<FinancialViewTab>('financial')
  const [accountingMonth, setAccountingMonth] = useState('')
  // 月份是否由用户在下拉框里显式挑选过。自动默认（含首屏加载、刷新/重算后
  // 的重新落位）不算显式选择——只有显式选择才允许在数据更新后停留在原月份，
  // 否则默认始终跟随最新有源报表的月份。
  const accountingMonthUserPickedRef = useRef(false)
  const [accountingRows, setAccountingRows] = useState<FinancialAccountingDetailLine[]>([])
  const [accountingLoading, setAccountingLoading] = useState(false)
  const [accountingExporting, setAccountingExporting] = useState(false)
  const [accountingError, setAccountingError] = useState<string | null>(null)

  // BEL-43: derive the accounting detail Tab header label from the
  // first row's backend-stamped currency_code when available, otherwise
  // fall back to the country-based switch. The backend is the single
  // source of truth for which currency the row is denominated in.
  const accountingCurrencyLabel = useMemo(() => {
    const stamped = accountingRows.find((row) => row.currency_code)?.currency_code
    if (stamped === 'EUR' || stamped === 'GBP' || stamped === 'USD') {
      return stamped
    }
    return currencyLabel
  }, [accountingRows, currencyLabel])

  const latestRequestIdRef = useRef(0)

  useEffect(() => {
    // 滚动默认窗口：URL 带 monthRange=last12m，或全新 URL（三个参数都空）。
    // 每次加载按当前时间重算"近 12 个月、截至上月"，并同步刷新 URL 里的具体
    // 月份——窗口随时间推进，不会固化为生成 URL 时的月份。
    // 用户改过月份选择器后标记被摘除（见下方 onChange），不再走这条分支。
    const isRollingDefault =
      monthUrl.monthRange === ROLLING_MONTH_RANGE_MARKER ||
      (!monthUrl.monthRange && !startMonth && !endMonth)
    if (!isRollingDefault) return
    const defaults = getBrowserDefaultMonthRange()
    if (
      startMonth === defaults.startMonth &&
      endMonth === defaults.endMonth &&
      monthUrl.monthRange === ROLLING_MONTH_RANGE_MARKER
    ) {
      return
    }
    setMonthUrl({
      fromMonth: defaults.startMonth,
      toMonth: defaults.endMonth,
      monthRange: ROLLING_MONTH_RANGE_MARKER,
    })
  }, [monthUrl.monthRange, startMonth, endMonth, setMonthUrl])

  // 用户动过月份选择器即视为显式窗口：摘除滚动标记，具体月份固化进 URL。
  // 清空两个选择器（都回到空串）则重新落回滚动默认窗口。
  const handleStartMonthChange = (date?: Date) => {
    setMonthUrl({ fromMonth: formatMonthInputValue(date), monthRange: '' })
  }
  const handleEndMonthChange = (date?: Date) => {
    setMonthUrl({ toMonth: formatMonthInputValue(date), monthRange: '' })
  }

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true)
    setProjectLoadError(null)
    try {
      const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
      setProjects(payload)
      // 1. URL 没指定 projectId（空字符串）→ 选第一个
      // 2. URL 指定了具体项目但项目列表里找不到（用户失去权限、项目被删除）→ 回退到第一个
      // 用 payload（刚 fetch 到的），不用 projects（state 还是旧值）。
      if (payload.length > 0) {
        const existsInList = projectId && payload.some((p) => String(p.id) === projectId)
        if (!projectId || !existsInList) {
          setProjectId(String(payload[0].id))
        }
      }
    } catch (loadError) {
      setProjectLoadError(loadError instanceof Error ? loadError.message : '项目列表加载失败')
    } finally {
      setProjectsLoading(false)
    }
  }, [projectId, session])

  const loadExchangeRates = useCallback(
    async (months: string[]) => {
      const uniqueMonths = Array.from(new Set(months.filter(Boolean)))
      if (uniqueMonths.length === 0) {
        setExchangeRateByMonth({})
        return
      }

      const cacheKey = getExchangeRateCacheKey(currencyLabel)
      const cached = getClientCache<Record<string, number>>(cacheKey, EXCHANGE_RATE_CACHE_TTL_MS)
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
          `/api/exchange-rates?currency=${currencyLabel}&page=${page}&pageSize=200`,
          {
            cache: 'no-store',
          }
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

      setClientCache(getExchangeRateCacheKey(currencyLabel), fetchedMap)
      setExchangeRateByMonth(buildMonthRateMap(uniqueMonths, fetchedMap))
      setError(null)
    },
    [currencyLabel]
  )

  const loadFinancialSeries = useCallback(
    async (options?: { force?: boolean }) => {
      const parsedProjectId = Number(projectId)
      if (!parsedProjectId) {
        setError('请先选择店铺')
        setData(null)
        return
      }

      const useCache = !options?.force
      const cacheKey = financialSeriesCacheKey(parsedProjectId, country, startMonth, endMonth)
      const cachedPayload = useCache
        ? getClientCache<FinancialSeriesResponse>(cacheKey, FINANCIAL_SERIES_CACHE_TTL_MS)
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
          country,
          fill_missing: 'true',
        })
        if (startMonth) search.set('start_month', startMonth)
        if (endMonth) search.set('end_month', endMonth)

        const response = await fetch(
          `${API_BASE}/api/v1/monthly-reports/financial-series?${search.toString()}`,
          {
            cache: 'no-store',
            headers: authHeaders(),
          }
        )
        if (!response.ok) {
          throw new Error(parseErrorBody(await response.text(), response.status))
        }

        const payload = (await response.json()) as FinancialSeriesResponse
        if (latestRequestIdRef.current !== requestId) return
        setData(payload)
        setClientCache(cacheKey, payload)
      } catch (loadError) {
        if (latestRequestIdRef.current !== requestId) return
        if (!hasCachedPayload) {
          setData(null)
          setError(loadError instanceof Error ? loadError.message : '财务数据加载失败')
        }
      } finally {
        if (latestRequestIdRef.current === requestId) {
          setLoading(false)
        }
      }
    },
    [projectId, country, startMonth, endMonth]
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
        country,
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
        }
      )
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }

      const payload = (await response.json()) as FinancialSeriesResponse
      setData(payload)
      const cacheKey = financialSeriesCacheKey(parsedProjectId, country, startMonth, endMonth)
      setClientCache(cacheKey, payload)

      // 重算完成后，如果当前在核算明细 tab，触发明细刷新
      if (activeTab === 'accounting') {
        setAccountingRefreshKey((k) => k + 1)
      }
    } catch (loadError) {
      setData(null)
      setError(loadError instanceof Error ? loadError.message : '重新核算失败')
    } finally {
      setRecalculating(false)
    }
  }, [projectId, country, startMonth, endMonth, activeTab])

  const accountingMonthOptions = useMemo(() => {
    const rows = data?.rows ?? []
    return rows.filter((row) => row.has_source_report).map((row) => row.report_month)
  }, [data?.rows])

  useEffect(() => {
    if (accountingMonthOptions.length === 0) {
      setAccountingMonth('')
      setAccountingRows([])
      return
    }
    const latestMonth = accountingMonthOptions[accountingMonthOptions.length - 1]
    // 用户显式挑过且该月份仍在可选项里 → 不打扰其选择；
    // 其余情况（首次加载的自动落位 / 刷新、重算带来新月份 / 陈旧客户端缓存
    // 回放后最新响应到达）一律跟随最新月份。旧实现只判断 includes，会把
    // 自动落位的旧月份当成用户选择，导致 7 月数据到达后仍停在 6 月。
    if (accountingMonthUserPickedRef.current && accountingMonthOptions.includes(accountingMonth)) {
      return
    }
    accountingMonthUserPickedRef.current = false
    setAccountingMonth(latestMonth)
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
        country,
        report_month: accountingMonth,
      })
      const response = await fetch(
        `${API_BASE}/api/v1/monthly-reports/financial-series/accounting-detail?${search.toString()}`,
        {
          cache: 'no-store',
          headers: authHeaders(),
        }
      )
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }
      const payload = (await response.json()) as FinancialAccountingDetailResponse
      setAccountingRows(payload.rows ?? [])
    } catch (loadError) {
      setAccountingRows([])
      setAccountingError(loadError instanceof Error ? loadError.message : '核算明细加载失败')
    } finally {
      setAccountingLoading(false)
    }
  }, [accountingMonth, projectId, country])

  useEffect(() => {
    if (activeTab !== 'accounting' || !accountingMonth) return
    void loadAccountingDetail()
  }, [activeTab, accountingMonth, loadAccountingDetail, accountingRefreshKey])

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
        country,
        report_month: accountingMonth,
      })
      const response = await fetch(
        `${API_BASE}/api/v1/monthly-reports/financial-series/accounting-detail/export?${search.toString()}`,
        {
          cache: 'no-store',
          headers: authHeaders(),
        }
      )
      if (!response.ok) {
        throw new Error(parseErrorBody(await response.text(), response.status))
      }
      const blob = await response.blob()
      const filename = extractFilenameFromHeader(response.headers.get('Content-Disposition')) ?? ''
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
          country,
          report_month: accountingMonth,
          filename,
        },
      })
    } catch (exportError) {
      setAccountingError(exportError instanceof Error ? exportError.message : '导出核算明细失败')
    } finally {
      setAccountingExporting(false)
    }
  }, [accountingMonth, projectId, country, projects, data])

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
    void loadFinancialSeries()
  }, [endMonth, loadFinancialSeries, projectId, projectsLoading, startMonth])

  useEffect(() => {
    const months = (data?.rows ?? []).map((row) => row.report_month)
    if (months.length === 0) {
      setExchangeRateByMonth({})
      return
    }
    void loadExchangeRates(months).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : '汇率数据加载失败')
    })
  }, [data, loadExchangeRates])

  const trendPoints = useMemo(() => {
    if (!data) return []
    return data.rows.map((row) => ({
      report_month: row.report_month,
      month_label: formatMonth(row.report_month),
      income_sales: resolveDisplaySales(row),
      // 退款统一按正值展示金额规模，避免与销售额方向相反影响可读性
      income_refund: Math.abs(row.income_refund),
      has_source_report: row.has_source_report,
    }))
  }, [data])

  // 计算趋势（最后一个有数据的月份与上一个的比较）
  const trends = useMemo(() => {
    if (!data || data.trend.points.length < 2) return { income: 0, expense: 0, amazon: 0 }
    const points = data.trend.points
    const validPoints = points.filter((p) => p.has_source_report)
    if (validPoints.length < 2) return { income: 0, expense: 0, amazon: 0 }

    const last = validPoints[validPoints.length - 1]
    const prev = validPoints[validPoints.length - 2]

    return {
      income:
        prev.income_total !== 0
          ? ((last.income_total - prev.income_total) / Math.abs(prev.income_total)) * 100
          : 0,
      expense:
        prev.expense_total !== 0
          ? ((last.expense_total - prev.expense_total) / Math.abs(prev.expense_total)) * 100
          : 0,
      amazon:
        prev.amazon_pay_back !== 0
          ? ((last.amazon_pay_back - prev.amazon_pay_back) / Math.abs(prev.amazon_pay_back)) * 100
          : 0,
    }
  }, [data])

  const selectedProject = useMemo(
    () => projects.find((project) => String(project.id) === projectId) ?? null,
    [projects, projectId]
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
        const operationCommissionRmb = operationCommission.commissionUsd * exchangeRate
        const payableTotalRmb = evaluationFeeRmb + prepaymentOtherRmb + operationCommissionRmb
        const netProfitRmb = calculateNetProfitRmb(row, exchangeRate)
        const netProfitUsd = calculateNetProfitUsd(row, exchangeRate)

        return {
          income_sales: acc.income_sales + resolveDisplaySales(row),
          income_refund: acc.income_refund + row.income_refund,
          income_adjustment: acc.income_adjustment + row.income_adjustment,
          income_other: acc.income_other + row.income_other,
          expense_selling_fee: acc.expense_selling_fee + row.expense_selling_fee,
          expense_fba_fee: acc.expense_fba_fee + row.expense_fba_fee,
          expense_inventory_fee: acc.expense_inventory_fee + row.expense_inventory_fee,
          expense_service_fee: acc.expense_service_fee + row.expense_service_fee,
          expense_advertising: acc.expense_advertising + row.expense_advertising,
          expense_other_fees: acc.expense_other_fees + row.expense_other_fees,
          income_total: acc.income_total + row.income_total,
          expense_total: acc.expense_total + row.expense_total,
          income_vat_total: acc.income_vat_total + (row.income_vat_total ?? 0),
          amazon_pay_back: acc.amazon_pay_back + row.amazon_pay_back,
          credit_card_deduction_usd: acc.credit_card_deduction_usd + creditCardUsd,
          fob_cost_rmb: acc.fob_cost_rmb + row.fob_cost_rmb,
          first_leg_cost_rmb: acc.first_leg_cost_rmb + row.first_leg_cost_rmb,
          net_profit_rmb: acc.net_profit_rmb + netProfitRmb,
          net_profit_usd: acc.net_profit_usd + netProfitUsd,
          evaluation_fee_rmb: acc.evaluation_fee_rmb + evaluationFeeRmb,
          prepayment_other_rmb: acc.prepayment_other_rmb + prepaymentOtherRmb,
          operation_commission_rmb: acc.operation_commission_rmb + operationCommissionRmb,
          payable_total_rmb: acc.payable_total_rmb + payableTotalRmb,
          exchange_rate_sum: acc.exchange_rate_sum + (exchangeRate > 0 ? exchangeRate : 0),
          exchange_rate_count: acc.exchange_rate_count + (exchangeRate > 0 ? 1 : 0),
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
        income_vat_total: 0,
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
      }
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
      const operationCommissionRmb = operationCommission.commissionUsd * exchangeRate
      const payableTotalRmb = evaluationFeeRmb + prepaymentOtherRmb + operationCommissionRmb
      const netProfitRmb = calculateNetProfitRmb(row, exchangeRate)
      const netProfitUsd = calculateNetProfitUsd(row, exchangeRate)

      return {
        monthLabel: formatMonth(row.report_month),
        incomeSales: resolveDisplaySales(row),
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
        vatTotal: Math.abs(row.income_vat_total ?? 0),
        incomeSalesWithTax: row.income_sales_with_tax,
        expenseVatTotal: row.expense_vat_total,
        amazonPayBack: row.amazon_pay_back,
        creditCardDeductionUsd: row.credit_card_deduction_usd,
        fobCostRmb: row.fob_cost_rmb,
        firstLegCostRmb: row.first_leg_cost_rmb,
        netProfitRmb,
        netProfitUsd,
        netProfitRate: toSignedRatio(netProfitUsd, row.income_total),
        evaluationFeeRmb,
        prepaymentOtherRmb,
        operationCommissionRmb: disableCommission ? null : operationCommissionRmb,
        payableTotalRmb: disableCommission ? null : payableTotalRmb,
        exchangeRate,
        platformRatio: toPositiveRatio(row.expense_selling_fee, row.income_total),
        deliveryRatio: toPositiveRatio(row.expense_fba_fee, row.income_total),
        storageRatio: toPositiveRatio(row.expense_inventory_fee, row.income_total),
        serviceRatio: toPositiveRatio(row.expense_service_fee, row.income_total),
        adRatio: toPositiveRatio(row.expense_advertising, row.income_total),
        refundRatio: toPositiveRatio(row.income_refund, resolveDisplaySales(row)),
        paybackRatio: toSignedRatio(row.amazon_pay_back, row.income_total),
        hasSourceReport: row.has_source_report,
      }
    })
  }, [commissionBasis, commissionRate, data?.rows, disableCommission, exchangeRateByMonth])

  const exportFinancialAnalysis = useCallback(async () => {
    const usdNumFmt = getExcelNumFmt('currency_usd', currencySymbol) ?? '$#,##0.00;[Red]-$#,##0.00'
    if (!data || detailExportRows.length === 0) {
      setError('当前没有可导出的月度财务数据。')
      return
    }

    const exportTrendPoints = data.trend.points.filter((point) =>
      isMonthWithinRange(point.report_month, data.start_month, data.end_month)
    )
    const exportDetailRows = detailExportRows.filter((_, index) =>
      isMonthWithinRange(data.rows[index]?.report_month ?? '', data.start_month, data.end_month)
    )
    if (exportDetailRows.length === 0) {
      setError('当前没有可导出的月度财务数据。')
      return
    }

    const exportTotals = buildFinancialExportTotals(exportDetailRows)
    const exportTrendSummary = exportTrendPoints
      .filter((point) => point.has_source_report)
      .slice(-2)
    const exportTrends = {
      income:
        exportTrendSummary.length === 2 && exportTrendSummary[0].income_total !== 0
          ? ((exportTrendSummary[1].income_total - exportTrendSummary[0].income_total) /
              Math.abs(exportTrendSummary[0].income_total)) *
            100
          : 0,
      expense:
        exportTrendSummary.length === 2 && exportTrendSummary[0].expense_total !== 0
          ? ((exportTrendSummary[1].expense_total - exportTrendSummary[0].expense_total) /
              Math.abs(exportTrendSummary[0].expense_total)) *
            100
          : 0,
      amazon:
        exportTrendSummary.length === 2 && exportTrendSummary[0].amazon_pay_back !== 0
          ? ((exportTrendSummary[1].amazon_pay_back - exportTrendSummary[0].amazon_pay_back) /
              Math.abs(exportTrendSummary[0].amazon_pay_back)) *
            100
          : 0,
    }

    setExporting(true)
    setError(null)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()
      const activeExportColumns = EXPORT_DETAIL_COLUMNS.filter(
        (column) => isAdmin || !ADMIN_ONLY_EXPORT_KEYS.has(column.key)
      )

      const detailSheet = workbook.addWorksheet('月度财务总览', {
        views: [{ state: 'frozen', ySplit: 2, xSplit: 1, activeCell: 'A3', showGridLines: false }],
      })
      const summarySheet = workbook.addWorksheet('年度财务总览', {
        views: [{ state: 'frozen', ySplit: 1, xSplit: 1, activeCell: 'A2', showGridLines: false }],
      })

      const summaryLastColumn = 4

      const kpiHeader = summarySheet.getRow(1)
      kpiHeader.values = ['指标', '数值', '说明', '趋势']
      kpiHeader.height = 28
      kpiHeader.eachCell((cell) => {
        cell.font = {
          name: 'Microsoft YaHei',
          size: 11,
          bold: true,
          color: { argb: 'FF0F172A' },
        }
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE2E8F0' },
        }
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        }
      })

      const summaryKpis: Array<[string, number, string, number]> = [
        ['收入合计', exportTotals.incomeTotal, '所选区间全部平台收入汇总', exportTrends.income],
        ['支出合计', exportTotals.expenseTotal, '所选区间全部平台支出汇总', exportTrends.expense],
        [
          'VAT (销售税)',
          exportTotals.incomeVatTotal ?? 0,
          '市场代扣销售税（从销售额中扣除，故为负）',
          0,
        ],
        ['亚马逊返款', exportTotals.amazonPayBack, '所选区间返款总额', exportTrends.amazon],
        [
          '净额合计',
          exportTrendPoints.reduce((sum, point) => sum + point.net_amount, 0),
          '收入减支出后的净值',
          0,
        ],
      ]

      summaryKpis.forEach((item, index) => {
        const row = summarySheet.getRow(index + 2)
        row.height = 24
        const isEvenRow = index % 2 === 0
        const rowBgColor = isEvenRow ? 'FFFFFFFF' : 'FFF8FAFC'
        row.getCell(1).value = item[0]
        row.getCell(2).value = item[1]
        row.getCell(2).numFmt = usdNumFmt
        row.getCell(3).value = item[2]
        row.getCell(4).value = item[3] / 100
        row.getCell(4).numFmt = '0.0%'
        row.eachCell((cell, col) => {
          cell.font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF0F172A' } }
          cell.alignment = {
            vertical: 'middle',
            horizontal: col === 2 || col === 4 ? 'right' : 'left',
          }
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: rowBgColor },
          }
          applyExcelBorder(cell)
        })
      })

      const trendStartRow = 8
      summarySheet.mergeCells(trendStartRow, 1, trendStartRow, summaryLastColumn)
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
      trendHeader.height = 28
      trendHeader.eachCell((cell) => {
        cell.font = {
          name: 'Microsoft YaHei',
          size: 11,
          bold: true,
          color: { argb: 'FF0F172A' },
        }
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE2E8F0' },
        }
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        }
      })

      exportTrendPoints.forEach((point, index) => {
        const row = summarySheet.getRow(trendStartRow + 2 + index)
        row.height = 24
        const isEvenRow = index % 2 === 0
        const rowBgColor = isEvenRow ? 'FFFFFFFF' : 'FFF8FAFC'
        row.values = [
          formatMonth(point.report_month),
          point.income_total,
          point.expense_total,
          point.amazon_pay_back,
        ]
        row.eachCell((cell, colNumber) => {
          cell.font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF0F172A' } }
          cell.alignment = {
            vertical: 'middle',
            horizontal: colNumber === 1 ? 'left' : 'right',
          }
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: rowBgColor },
          }
          if (colNumber > 1) cell.numFmt = usdNumFmt
          applyExcelBorder(cell)
        })
      })

      summarySheet.columns = [{ width: 16 }, { width: 16 }, { width: 28 }, { width: 12 }]

      const groupColors: Record<string, string> = {
        基础信息: 'FFF1F5F9',
        平台收入: 'FFDDF7EA',
        平台支出: 'FFFCE7C3',
        结果: 'FFDCEEFF',
        成本核算: 'FFFDE68A',
        运营结算: 'FFFDE6F2',
        费用占比: 'FFEADFEE',
      }

      const groupRow = detailSheet.getRow(1)
      const headRow = detailSheet.getRow(2)
      groupRow.height = 24
      headRow.height = 28
      let currentColumn = 1
      Array.from(new Set(activeExportColumns.map((column) => column.group))).forEach((group) => {
        const groupColumns = activeExportColumns.filter((column) => column.group === group)
        const startColumn = currentColumn
        groupColumns.forEach((column) => {
          headRow.getCell(currentColumn).value = column.title
          currentColumn += 1
        })
        detailSheet.mergeCells(1, startColumn, 1, currentColumn - 1)
        const groupCell = groupRow.getCell(startColumn)
        groupCell.value = group
        groupCell.font = {
          name: 'Microsoft YaHei',
          size: 11,
          bold: true,
          color: { argb: 'FF0F172A' },
        }
        groupCell.alignment = { vertical: 'middle', horizontal: 'center' }
        groupCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: groupColors[group] ?? 'FFE2E8F0' },
        }
        groupCell.border = {
          top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        }
      })
      ;[groupRow, headRow].forEach((row) => {
        row.eachCell((cell) => {
          cell.font = {
            name: 'Microsoft YaHei',
            size: 11,
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
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          }
        })
      })

      const CONTENT_ROW_HEIGHT = 24

      exportDetailRows.forEach((rowData, index) => {
        const row = detailSheet.getRow(index + 3)
        row.height = CONTENT_ROW_HEIGHT
        const isEvenRow = index % 2 === 0
        const rowBgColor = isEvenRow ? 'FFFFFFFF' : 'FFF8FAFC'

        activeExportColumns.forEach((column, columnIndex) => {
          const cell = row.getCell(columnIndex + 1)
          const value = rowData[column.key]
          cell.value = column.format === 'boolean' ? (value ? '有' : '无') : (value ?? '-')
          cell.font = {
            name: 'Microsoft YaHei',
            size: 10,
            color: {
              argb: column.key === 'monthLabel' ? 'FF0F172A' : 'FF334155',
            },
            bold: column.key === 'monthLabel',
          }
          cell.alignment = {
            vertical: 'middle',
            horizontal: column.format === 'text' || column.format === 'boolean' ? 'left' : 'right',
          }
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: rowBgColor },
          }
          const numFmt = getExcelNumFmt(column.format, currencySymbol)
          if (typeof value === 'number' && numFmt) cell.numFmt = numFmt
          applyExcelBorder(cell)
        })
      })

      const totalRow = detailSheet.getRow(exportDetailRows.length + 3)
      totalRow.height = CONTENT_ROW_HEIGHT
      activeExportColumns.forEach((column, columnIndex) => {
        const cell = totalRow.getCell(columnIndex + 1)
        if (column.key === 'monthLabel') {
          cell.value = '合计'
        } else if (column.key === 'hasSourceReport') {
          cell.value = `${exportDetailRows.length} 个月`
        } else if (column.key === 'incomeSales') {
          cell.value = exportTotals.incomeSales
        } else if (column.key === 'incomeRefund') {
          cell.value = exportTotals.incomeRefund
        } else if (column.key === 'incomeAdjustment') {
          cell.value = exportTotals.incomeAdjustment
        } else if (column.key === 'incomeOther') {
          cell.value = exportTotals.incomeOther
        } else if (column.key === 'expenseSellingFee') {
          cell.value = exportTotals.expenseSellingFee
        } else if (column.key === 'expenseFbaFee') {
          cell.value = exportTotals.expenseFbaFee
        } else if (column.key === 'expenseInventoryFee') {
          cell.value = exportTotals.expenseInventoryFee
        } else if (column.key === 'expenseServiceFee') {
          cell.value = exportTotals.expenseServiceFee
        } else if (column.key === 'expenseAdvertising') {
          cell.value = exportTotals.expenseAdvertising
        } else if (column.key === 'expenseOtherFees') {
          cell.value = exportTotals.expenseOtherFees
        } else if (column.key === 'incomeTotal') {
          cell.value = exportTotals.incomeTotal
        } else if (column.key === 'expenseTotal') {
          cell.value = exportTotals.expenseTotal
        } else if (column.key === 'amazonPayBack') {
          cell.value = exportTotals.amazonPayBack
        } else if (column.key === 'creditCardDeductionUsd') {
          cell.value = exportTotals.creditCardDeductionUsd
        } else if (column.key === 'fobCostRmb') {
          cell.value = exportTotals.fobCostRmb
        } else if (column.key === 'firstLegCostRmb') {
          cell.value = exportTotals.firstLegCostRmb
        } else if (column.key === 'netProfitRmb') {
          cell.value = exportTotals.netProfitRmb
        } else if (column.key === 'netProfitUsd') {
          cell.value = exportTotals.netProfitUsd
        } else if (column.key === 'netProfitRate') {
          cell.value = toSignedRatio(exportTotals.netProfitUsd, exportTotals.incomeTotal)
        } else if (column.key === 'evaluationFeeRmb') {
          cell.value = exportTotals.evaluationFeeRmb
        } else if (column.key === 'prepaymentOtherRmb') {
          cell.value = exportTotals.prepaymentOtherRmb
        } else if (column.key === 'operationCommissionRmb') {
          cell.value = disableCommission ? '-' : exportTotals.operationCommissionRmb
        } else if (column.key === 'payableTotalRmb') {
          cell.value = disableCommission ? '-' : exportTotals.payableTotalRmb
        } else if (column.key === 'exchangeRate') {
          cell.value =
            exportTotals.exchangeRateCount > 0
              ? exportTotals.exchangeRateSum / exportTotals.exchangeRateCount
              : 0
        } else if (column.key === 'platformRatio') {
          cell.value = toPositiveRatio(exportTotals.expenseSellingFee, exportTotals.incomeTotal)
        } else if (column.key === 'deliveryRatio') {
          cell.value = toPositiveRatio(exportTotals.expenseFbaFee, exportTotals.incomeTotal)
        } else if (column.key === 'storageRatio') {
          cell.value = toPositiveRatio(exportTotals.expenseInventoryFee, exportTotals.incomeTotal)
        } else if (column.key === 'serviceRatio') {
          cell.value = toPositiveRatio(exportTotals.expenseServiceFee, exportTotals.incomeTotal)
        } else if (column.key === 'adRatio') {
          cell.value = toPositiveRatio(exportTotals.expenseAdvertising, exportTotals.incomeTotal)
        } else if (column.key === 'refundRatio') {
          cell.value = toPositiveRatio(exportTotals.incomeRefund, exportTotals.incomeSales)
        } else if (column.key === 'paybackRatio') {
          cell.value = toSignedRatio(exportTotals.amazonPayBack, exportTotals.incomeTotal)
        } else if (column.key === 'vatTotal') {
          cell.value = exportTotals.vatTotal
        } else {
          cell.value = '-'
        }
        cell.font = {
          name: 'Microsoft YaHei',
          size: 10,
          bold: true,
          color: { argb: 'FF0F172A' },
        }
        cell.alignment = {
          vertical: 'middle',
          horizontal: typeof cell.value === 'number' ? 'right' : 'left',
        }
        const numFmt = getExcelNumFmt(column.format, currencySymbol)
        if (typeof cell.value === 'number' && numFmt) cell.numFmt = numFmt
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE2E8F0' },
        }
        cell.border = {
          top: { style: 'medium', color: { argb: 'FF94A3B8' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'medium', color: { argb: 'FF94A3B8' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        }
      })

      const compactWidthKeys = new Set<string>(['hasSourceReport'])
      detailSheet.columns = activeExportColumns.map((column) => ({
        width: column.key === 'monthLabel' ? 12 : compactWidthKeys.has(column.key) ? 10 : 12,
      }))

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const safeProjectName = data.project_name.replace(/[\\/:*?"<>|]/g, '-')
      const safeCountryLabel = getCountryLabel(country).replace(/[\\/:*?"<>|]/g, '-')
      const endMonthStr = formatMonth(data.end_month)
      link.href = url
      link.download = `${safeProjectName}_${safeCountryLabel}-月度财务汇总分析-${endMonthStr}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)
      await logClientOperation({
        action: 'financial_data.export',
        targetType: 'monthly_financial_analysis',
        targetId: projectId,
        after: {
          project_id: projectId,
          country,
          project_name: data.project_name,
          start_month: startMonth,
          end_month: endMonth,
          row_count: exportDetailRows.length,
          filename: link.download,
        },
      })
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出 Excel 失败')
    } finally {
      setExporting(false)
    }
  }, [
    data,
    detailExportRows,
    disableCommission,
    endMonth,
    isAdmin,
    projectId,
    country,
    startMonth,
    currencySymbol,
  ])
  const showSkeleton = loading && !data

  return (
    <div className="min-w-0 w-full space-y-6 overflow-x-hidden">
      <DataCard>
        <DataCardHeader
          title="财务分析"
          titleClassName="text-2xl tracking-tight"
          badge={<p className="dashboard-kicker">分析控制台</p>}
        />
        <DataCardContent className="px-4 pb-4 pt-4">
          {/* 手机端：2列网格无标签 */}
          <div className="grid grid-cols-2 gap-2 lg:hidden">
            {projectsLoading ? (
              <Skeleton className="h-9 w-full rounded-none bg-term-raised" />
            ) : (
              <Select
                value={projectId}
                onValueChange={setProjectId}
                disabled={projects.length === 0}
              >
                <SelectTrigger className="h-9 w-full rounded-none border-term-border bg-term-bg">
                  <SelectValue placeholder="选择店铺" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={String(project.id)}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <CountrySelect
              value={country}
              onChange={(value) => setCountry(value as ReportUploadCountry)}
              triggerClassName="h-8 w-full rounded-none border-term-border bg-term-bg font-mono text-xs"
            />
            <MonthPicker
              value={parseMonthInputValue(startMonth)}
              onChange={handleStartMonthChange}
              className="h-9 w-full"
            />
            <MonthPicker
              value={parseMonthInputValue(endMonth)}
              onChange={handleEndMonthChange}
              className="h-9 w-full"
            />
            <RefreshButton
              onClick={() => void loadFinancialSeries({ force: true })}
              loading={loading}
              label="刷新"
              variant="outline"
              className="col-span-2 h-9 w-full rounded-none border-term-border bg-term-bg"
            />
          </div>

          {/* 桌面端：横向排列 */}
          <div className="hidden lg:flex lg:flex-row lg:flex-wrap lg:items-end lg:gap-3">
            {projectsLoading ? (
              <div className="min-w-[180px]">
                <FinancialFilterSkeleton />
              </div>
            ) : (
              <FilterField label="店铺">
                <Select
                  value={projectId}
                  onValueChange={setProjectId}
                  disabled={projects.length === 0}
                >
                  <SelectTrigger className="h-9 w-[200px] border-term-border bg-term-bg">
                    <SelectValue placeholder="请选择店铺" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={String(project.id)}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FilterField>
            )}
            <FilterField label="国家站点">
              <CountrySelect
                value={country}
                onChange={(value) => setCountry(value as ReportUploadCountry)}
                triggerClassName="h-9"
              />
            </FilterField>
            <FilterField label="开始月份">
              <MonthPicker
                value={parseMonthInputValue(startMonth)}
                onChange={handleStartMonthChange}
                className="h-9 w-[170px]"
              />
            </FilterField>
            <FilterField label="结束月份">
              <MonthPicker
                value={parseMonthInputValue(endMonth)}
                onChange={handleEndMonthChange}
                className="h-9 w-[170px]"
              />
            </FilterField>
            <RefreshButton
              onClick={() => void loadFinancialSeries({ force: true })}
              loading={loading}
              label="刷新数据"
              variant="outline"
              className="h-9 border-term-border bg-term-bg"
            />
          </div>
        </DataCardContent>
      </DataCard>

      {projectLoadError ? (
        <div className="rounded-none border border-term-neg/40 bg-term-neg/10 px-2 py-1.5 font-mono text-xs text-term-neg">
          {projectLoadError}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-none border border-term-neg/40 bg-term-neg/10 px-2 py-1.5 font-mono text-xs text-term-neg">
          {error}
        </div>
      ) : null}
      {accountingError ? (
        <div className="rounded-none border border-term-neg/40 bg-term-neg/10 px-2 py-1.5 font-mono text-xs text-term-neg">
          {accountingError}
        </div>
      ) : null}

      <DataTableCard>
        <DataTableCardStatBar
          className="border-b border-term-border bg-term-raised"
          items={[
            {
              label: '收入合计',
              value: data
                ? formatCurrency(data.trend.income_total_sum, currencySymbol)
                : `${currencySymbol}0.00`,
              highlight: true,
            },
            {
              label: '支出合计',
              value: data
                ? formatCurrency(data.trend.expense_total_sum, currencySymbol)
                : `${currencySymbol}0.00`,
            },
            {
              label: '亚马逊返款',
              value: data
                ? formatCurrency(data.trend.amazon_pay_back_sum, currencySymbol)
                : `${currencySymbol}0.00`,
            },
          ]}
        />
      </DataTableCard>

      {/* 优化后的图表 - 使用 AreaChart 和渐变 */}
      <DataCard className="animate-enter">
        <DataCardHeader
          title="月度趋势"
          badge={<p className="dashboard-kicker">财务趋势</p>}
          action={
            <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-end">
              <button
                type="button"
                onClick={() =>
                  setVisibleLines((prev) => ({
                    ...prev,
                    income_sales: !prev.income_sales,
                  }))
                }
                className={`flex items-center gap-1.5 rounded-none border px-2 py-1 font-mono text-[11px] font-medium transition-colors ${
                  visibleLines.income_sales
                    ? 'border-term-pos/40 bg-term-pos/10 text-term-pos'
                    : 'border-term-border bg-term-panel text-term-faint line-through'
                }`}
              >
                {visibleLines.income_sales ? (
                  <Eye className="h-3 w-3" />
                ) : (
                  <EyeOff className="h-3 w-3" />
                )}
                <span
                  className="h-2 w-2 rounded-none"
                  style={{ backgroundColor: 'hsl(var(--chart-2))' }}
                />
                销售额
              </button>
              <button
                type="button"
                onClick={() =>
                  setVisibleLines((prev) => ({
                    ...prev,
                    income_refund: !prev.income_refund,
                  }))
                }
                className={`flex items-center gap-1.5 rounded-none border px-2 py-1 font-mono text-[11px] font-medium transition-colors ${
                  visibleLines.income_refund
                    ? 'border-term-neg/40 bg-term-neg/10 text-term-neg'
                    : 'border-term-border bg-term-panel text-term-faint line-through'
                }`}
              >
                {visibleLines.income_refund ? (
                  <Eye className="h-3 w-3" />
                ) : (
                  <EyeOff className="h-3 w-3" />
                )}
                <span
                  className="h-2 w-2 rounded-none"
                  style={{ backgroundColor: 'hsl(var(--destructive))' }}
                />
                退款
              </button>
            </div>
          }
        />
        <DataCardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
          {loading && data ? (
            <div className="mb-4 inline-flex rounded-none border border-term-border bg-term-raised px-2 py-1 font-mono text-[11px] text-term-muted">
              趋势图更新中...
            </div>
          ) : null}
          {showSkeleton ? (
            <Skeleton className="h-[320px] w-full" />
          ) : trendPoints.length > 0 ? (
            <AreaChartCard
              data={trendPoints}
              xKey="month_label"
              config={chartConfig}
              className="aspect-auto h-[320px] w-full"
              yTickFormatter={formatCompactCurrency}
              showLegend={false}
              tooltipFormatter={(value, name) => {
                const nameMap: Record<string, string> = {
                  income_sales: '销售额',
                  income_refund: '退款',
                }
                const displayName = nameMap[name] ?? name
                return (
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">{displayName}</span>
                    <span className="font-medium">
                      {formatCurrency(Number(value), currencySymbol)}
                    </span>
                  </div>
                )
              }}
              series={[
                ...(visibleLines.income_refund
                  ? [{ dataKey: 'income_refund', name: '退款' }]
                  : []),
                ...(visibleLines.income_sales
                  ? [{ dataKey: 'income_sales', name: '销售额' }]
                  : []),
              ]}
            />
          ) : (
            <div className="rounded-none border border-dashed border-term-border px-4 py-10 text-center font-mono text-xs text-term-faint">
              暂无趋势数据
            </div>
          )}
        </DataCardContent>
      </DataCard>

      <DataTableCard className="animate-enter">
        <DataTableCardHeader className="flex flex-wrap items-start justify-between gap-3 px-6 py-4">
          <div>
            <p className="dashboard-kicker">操作台账</p>
            <div className="text-base font-semibold text-foreground">
              {activeTab === 'financial' ? '月度汇总' : '月度明细'}
            </div>
            <p className="text-sm text-muted-foreground">
              {activeTab === 'financial'
                ? data
                  ? `${data.project_name} · ${formatMonth(data.start_month)} 至 ${formatMonth(data.end_month)}`
                  : '按月展示收入/支出结构与返款'
                : accountingMonth
                  ? `报表核算 · ${formatMonth(accountingMonth)}`
                  : '请选择有源报表的月份查看月度明细'}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {activeTab === 'accounting' ? (
              <>
                <Select
                  value={accountingMonth}
                  onValueChange={(month) => {
                    accountingMonthUserPickedRef.current = true
                    setAccountingMonth(month)
                  }}
                  disabled={accountingMonthOptions.length === 0}
                >
                  <SelectTrigger className="h-8 w-[190px] border-term-border bg-term-bg">
                    <SelectValue placeholder="请选择月份" />
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
                  type="button"
                  variant="outline"
                  className="h-8"
                  onClick={() => void loadAccountingDetail()}
                  disabled={accountingLoading || !accountingMonth}
                >
                  {accountingLoading ? '加载中...' : '刷新核算明细'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-8"
                  onClick={() => void exportAccountingDetail()}
                  disabled={
                    accountingExporting || !accountingMonth || accountingMonthOptions.length === 0
                  }
                >
                  {accountingExporting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="mr-2 h-4 w-4" />
                  )}
                  导出 Excel
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className="h-8"
                  onClick={() => void exportFinancialAnalysis()}
                  disabled={exporting || !data || detailExportRows.length === 0}
                >
                  {exporting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="mr-2 h-4 w-4" />
                  )}
                  导出 Excel
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-8"
                  onClick={() => void recalculateFinancialSeries()}
                  disabled={recalculating || !data || data.rows.length === 0}
                >
                  {recalculating ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  重新核算
                </Button>
              </>
            )}
            <div className="inline-flex gap-0 rounded-none border border-term-border bg-term-panel p-0">
              <button
                type="button"
                className={`h-8 rounded-none px-3 font-mono text-xs transition-colors ${activeTab === 'financial' ? 'bg-term-raised text-term-text' : 'text-term-muted hover:text-term-text'}`}
                onClick={() => setActiveTab('financial')}
              >
                月度汇总
              </button>
              <button
                type="button"
                className={`h-8 rounded-none px-3 font-mono text-xs transition-colors ${activeTab === 'accounting' ? 'bg-term-raised text-term-text' : 'text-term-muted hover:text-term-text'}`}
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
                <div className="mb-4 inline-flex rounded-none border border-term-border bg-term-raised px-2 py-1 font-mono text-[11px] text-term-muted">
                  财务明细更新中...
                </div>
              ) : null}
              {showSkeleton ? (
                <BarSkeleton rows={5} />
              ) : data && data.rows.length > 0 ? (
                <Table
                  containerClassName="w-full max-w-full overflow-x-auto"
                  className={`w-max ${isAdmin ? 'min-w-[2500px]' : 'min-w-[2100px]'} table-fixed text-xs`}
                >
                  <TableHeader>
                    <TableRow className="bg-term-panel/30 hover:bg-term-panel/30">
                      <TableHead
                        rowSpan={2}
                        className="sticky z-40 border-r border-term-border bg-term-raised px-2 py-2 text-center font-mono text-xs text-term-muted"
                        style={{ left: 0, minWidth: MONTH_STICKY_WIDTH }}
                      >
                        年/月度
                      </TableHead>
                      <TableHead
                        colSpan={4}
                        className="border-r bg-emerald-100 px-2 py-2 text-center text-foreground dark:bg-emerald-900/80 dark:text-emerald-100"
                      >
                        平台-收入 Income
                      </TableHead>
                      <TableHead
                        colSpan={6}
                        className="border-r bg-term-warn/15 px-2 py-2 text-center text-foreground"
                      >
                        平台-支出 Expense
                      </TableHead>
                      <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                        收入合计
                      </TableHead>
                      <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                        支出合计
                      </TableHead>
                      {showVatColumn ? (
                        <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                          VAT
                        </TableHead>
                      ) : null}
                      <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                        亚马逊回款
                      </TableHead>
                      <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                        信用卡扣款
                      </TableHead>
                      {isAdmin ? (
                        <>
                          <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                            测评费用RMB
                          </TableHead>
                          <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                            垫付其他RMB
                          </TableHead>
                          <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                            运营佣金RMB
                          </TableHead>
                          <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                            应付总计RMB
                          </TableHead>
                          <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                            汇率
                          </TableHead>
                        </>
                      ) : null}
                      <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                        平台占比
                      </TableHead>
                      <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                        配送占比
                      </TableHead>
                      <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                        仓储占比
                      </TableHead>
                      <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                        服务占比
                      </TableHead>
                      <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                        广告占比
                      </TableHead>
                      <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                        退款率
                      </TableHead>
                      <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                        回款率
                      </TableHead>
                      <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                        FOB成本
                      </TableHead>
                      <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                        头程成本
                      </TableHead>
                      <TableHead rowSpan={2} className="border-r px-2 py-2 text-center">
                        净利润RMB
                      </TableHead>
                      <TableHead rowSpan={2} className="px-2 py-2 text-center">
                        净利润{currencyLabel}
                      </TableHead>
                      <TableHead rowSpan={2} className="px-2 py-2 text-center">
                        净利率
                      </TableHead>
                    </TableRow>
                    <TableRow className="bg-term-panel/20 hover:bg-term-panel/20">
                      <TableHead className="border-r bg-emerald-100 px-2 py-1.5 text-center dark:bg-emerald-900/80 dark:text-emerald-100">
                        销售额
                      </TableHead>
                      <TableHead className="border-r bg-emerald-100 px-2 py-1.5 text-center dark:bg-emerald-900/80 dark:text-emerald-100">
                        退款
                      </TableHead>
                      <TableHead className="border-r bg-emerald-100 px-2 py-1.5 text-center dark:bg-emerald-900/80 dark:text-emerald-100">
                        赔偿
                      </TableHead>
                      <TableHead className="border-r bg-emerald-100 px-2 py-1.5 text-center dark:bg-emerald-900/80 dark:text-emerald-100">
                        其他收入
                      </TableHead>
                      <TableHead className="border-r bg-term-warn/10 px-2 py-1.5 text-center">
                        平台费
                      </TableHead>
                      <TableHead className="border-r bg-term-warn/10 px-2 py-1.5 text-center">
                        配送费
                      </TableHead>
                      <TableHead className="border-r bg-term-warn/10 px-2 py-1.5 text-center">
                        仓储费
                      </TableHead>
                      <TableHead className="border-r bg-term-warn/10 px-2 py-1.5 text-center">
                        服务费
                      </TableHead>
                      <TableHead className="border-r bg-term-warn/10 px-2 py-1.5 text-center">
                        广告费
                      </TableHead>
                      <TableHead className="border-r bg-term-warn/10 px-2 py-1.5 text-center">
                        其他费用
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rows.map((row) => {
                      const exchangeRate = exchangeRateByMonth[row.report_month] ?? 0
                      const creditCard = row.credit_card_deduction_usd
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
                      const rowBg = !row.has_source_report ? 'bg-term-panel' : 'bg-term-panel'
                      const platformRatio = toPositiveRatio(
                        row.expense_selling_fee,
                        row.income_total
                      )
                      const deliveryRatio = toPositiveRatio(row.expense_fba_fee, row.income_total)
                      const storageRatio = toPositiveRatio(
                        row.expense_inventory_fee,
                        row.income_total
                      )
                      const serviceRatio = toPositiveRatio(
                        row.expense_service_fee,
                        row.income_total
                      )
                      const adRatio = toPositiveRatio(row.expense_advertising, row.income_total)
                      const refundRatio = toPositiveRatio(
                        row.income_refund,
                        resolveDisplaySales(row)
                      )
                      const paybackRatio = toSignedRatio(row.amazon_pay_back, row.income_total)
                      const netProfitRate = toSignedRatio(netProfitUsd, row.income_total)

                      return (
                        <TableRow
                          key={row.report_month}
                          className={!row.has_source_report ? 'bg-term-panel/20' : undefined}
                        >
                          <TableCell
                            className={`sticky z-20 border-r border-term-border px-2 py-1.5 font-mono text-xs font-medium ${rowBg}`}
                            style={{ left: 0, minWidth: MONTH_STICKY_WIDTH }}
                          >
                            <div className="flex items-center justify-between gap-1">
                              <span className="whitespace-nowrap">
                                {formatMonth(row.report_month)}
                              </span>
                              {!row.has_source_report ? (
                                <Badge
                                  variant="outline"
                                  className="h-4 whitespace-nowrap rounded-sm border-term-warn/30 bg-term-warn/10 px-1 text-[9px] leading-none text-term-warn"
                                >
                                  无
                                </Badge>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatCurrency(resolveDisplaySales(row), currencySymbol)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatCurrency(row.income_refund, currencySymbol)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatCurrency(row.income_adjustment, currencySymbol)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatCurrency(row.income_other, currencySymbol)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatCurrency(row.expense_selling_fee, currencySymbol)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatCurrency(row.expense_fba_fee, currencySymbol)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatCurrency(row.expense_inventory_fee, currencySymbol)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatCurrency(row.expense_service_fee, currencySymbol)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatCurrency(row.expense_advertising, currencySymbol)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatCurrency(row.expense_other_fees, currencySymbol)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right font-semibold tabular-nums">
                            {formatCurrency(row.income_total, currencySymbol)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right font-semibold tabular-nums">
                            {formatCurrency(row.expense_total, currencySymbol)}
                          </TableCell>
                          {showVatColumn ? (
                            <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                              {formatCurrency(Math.abs(row.income_vat_total ?? 0), currencySymbol)}
                            </TableCell>
                          ) : null}
                          <TableCell className="border-r px-2 py-1.5 text-right font-semibold tabular-nums">
                            {formatCurrency(row.amazon_pay_back, currencySymbol)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatCurrency(creditCard, currencySymbol)}
                          </TableCell>
                          {isAdmin ? (
                            <>
                              <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                                {formatRmb(evaluationFeeRmb)}
                              </TableCell>
                              <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                                {formatRmb(prepaymentOtherRmb)}
                              </TableCell>
                              <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                                {disableCommission ? '-' : formatRmb(operationCommissionRmb)}
                              </TableCell>
                              <TableCell className="border-r px-2 py-1.5 text-right font-semibold tabular-nums">
                                {disableCommission ? '-' : formatRmb(payableTotalRmb)}
                              </TableCell>
                              <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                                {formatRate(exchangeRate)}
                              </TableCell>
                            </>
                          ) : null}
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatRatio(platformRatio)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatRatio(deliveryRatio)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatRatio(storageRatio)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatRatio(serviceRatio)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatRatio(adRatio)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatRatio(refundRatio)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatSignedRatio(paybackRatio)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatRmb(row.fob_cost_rmb)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatRmb(row.first_leg_cost_rmb)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right font-semibold tabular-nums">
                            {formatRmb(netProfitRmb)}
                          </TableCell>
                          <TableCell className="px-2 py-1.5 text-right font-semibold tabular-nums">
                            {formatCurrency(netProfitUsd, currencySymbol)}
                          </TableCell>
                          <TableCell className="px-2 py-1.5 text-right font-semibold tabular-nums">
                            {formatSignedRatio(netProfitRate)}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                  <TableFooter>
                    <TableRow className="bg-term-panel font-semibold hover:bg-term-panel">
                      <TableCell
                        className="sticky z-30 border-r border-border bg-term-panel px-2 py-2"
                        style={{ left: 0, minWidth: MONTH_STICKY_WIDTH }}
                      >
                        合计
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatCurrency(totals.income_sales, currencySymbol)}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatCurrency(totals.income_refund, currencySymbol)}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatCurrency(totals.income_adjustment, currencySymbol)}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatCurrency(totals.income_other, currencySymbol)}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatCurrency(totals.expense_selling_fee, currencySymbol)}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatCurrency(totals.expense_fba_fee, currencySymbol)}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatCurrency(totals.expense_inventory_fee, currencySymbol)}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatCurrency(totals.expense_service_fee, currencySymbol)}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatCurrency(totals.expense_advertising, currencySymbol)}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatCurrency(totals.expense_other_fees, currencySymbol)}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatCurrency(totals.income_total, currencySymbol)}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatCurrency(totals.expense_total, currencySymbol)}
                      </TableCell>
                      {showVatColumn ? (
                        <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                          {formatCurrency(totals.income_vat_total ?? 0, currencySymbol)}
                        </TableCell>
                      ) : null}
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatCurrency(totals.amazon_pay_back, currencySymbol)}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatCurrency(totals.credit_card_deduction_usd, currencySymbol)}
                      </TableCell>
                      {isAdmin ? (
                        <>
                          <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                            {formatRmb(totals.evaluation_fee_rmb)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                            {formatRmb(totals.prepayment_other_rmb)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                            {disableCommission ? '-' : formatRmb(totals.operation_commission_rmb)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                            {disableCommission ? '-' : formatRmb(totals.payable_total_rmb)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                            {formatRate(
                              totals.exchange_rate_count > 0
                                ? totals.exchange_rate_sum / totals.exchange_rate_count
                                : 0
                            )}
                          </TableCell>
                        </>
                      ) : null}
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatRatio(
                          toPositiveRatio(totals.expense_selling_fee, totals.income_total)
                        )}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatRatio(toPositiveRatio(totals.expense_fba_fee, totals.income_total))}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatRatio(
                          toPositiveRatio(totals.expense_inventory_fee, totals.income_total)
                        )}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatRatio(
                          toPositiveRatio(totals.expense_service_fee, totals.income_total)
                        )}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatRatio(
                          toPositiveRatio(totals.expense_advertising, totals.income_total)
                        )}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatRatio(toPositiveRatio(totals.income_refund, totals.income_sales))}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatSignedRatio(
                          toSignedRatio(totals.amazon_pay_back, totals.income_total)
                        )}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatRmb(totals.fob_cost_rmb)}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatRmb(totals.first_leg_cost_rmb)}
                      </TableCell>
                      <TableCell className="border-r px-2 py-2 text-right tabular-nums">
                        {formatRmb(totals.net_profit_rmb)}
                      </TableCell>
                      <TableCell className="px-2 py-2 text-right tabular-nums">
                        {formatCurrency(totals.net_profit_usd, currencySymbol)}
                      </TableCell>
                      <TableCell className="px-2 py-2 text-right tabular-nums">
                        {formatSignedRatio(
                          toSignedRatio(totals.net_profit_usd, totals.income_total)
                        )}
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              ) : (
                <div className="rounded-none border border-dashed border-term-border px-4 py-10 text-center font-mono text-xs text-term-faint">
                  当前筛选条件暂无财务数据
                </div>
              )}
            </>
          ) : (
            <>
              {accountingLoading && accountingRows.length > 0 ? (
                <div className="mb-4 inline-flex rounded-none border border-term-border bg-term-raised px-2 py-1 font-mono text-[11px] text-term-muted">
                  月度明细更新中...
                </div>
              ) : null}
              {accountingLoading && accountingRows.length === 0 ? (
                <div className="space-y-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              ) : accountingMonth && accountingRows.length > 0 ? (
                <Table
                  containerClassName="w-full max-w-full overflow-x-auto"
                  className="w-max min-w-[1400px] table-fixed text-xs"
                >
                  <TableHeader>
                    <TableRow className="bg-term-panel/30 hover:bg-term-panel/30">
                      <TableHead
                        colSpan={4}
                        className="border-r bg-emerald-100 px-2 py-2 text-center dark:bg-emerald-900/80 dark:text-emerald-100"
                      >
                        Income（收入）
                      </TableHead>
                      <TableHead className="border-r px-2 py-2 text-center" />
                      <TableHead colSpan={4} className="bg-term-warn/15 px-2 py-2 text-center">
                        Expense（支出）
                      </TableHead>
                    </TableRow>
                    <TableRow className="bg-term-panel/20 hover:bg-term-panel/20">
                      <TableHead className="border-r px-2 py-1.5 text-center">Income</TableHead>
                      <TableHead className="border-r px-2 py-1.5 text-center">收入</TableHead>
                      <TableHead className="border-r px-2 py-1.5 text-center">
                        In金额（{accountingCurrencyLabel}）
                      </TableHead>
                      <TableHead className="border-r px-2 py-1.5 text-center">In源表</TableHead>
                      <TableHead className="border-r px-2 py-1.5 text-center" />
                      <TableHead className="border-r px-2 py-1.5 text-center">Expense</TableHead>
                      <TableHead className="border-r px-2 py-1.5 text-center">支出</TableHead>
                      <TableHead className="border-r px-2 py-1.5 text-center">
                        Ex金额（{accountingCurrencyLabel}）
                      </TableHead>
                      <TableHead className="px-2 py-1.5 text-center">Ex源表</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accountingRows.map((row, index) => {
                      // BEL-43: prefer the backend-stamped currency code;
                      // fall back to the country-based switch for legacy
                      // responses that predate the field.
                      const rowCurrencyCode = row.currency_code ?? null
                      const rowCurrencySymbol =
                        rowCurrencyCode === 'EUR'
                          ? '€'
                          : rowCurrencyCode === 'GBP'
                            ? '£'
                            : rowCurrencyCode === 'USD'
                              ? '$'
                              : currencySymbol
                      // Backward-compat: older responses (no `kind` field) all
                      // route through the "detail" branch.
                      const rowKind = row.kind ?? 'detail'
                      if (rowKind === 'spacer') {
                        return (
                          <TableRow
                            key={`spacer-${index}`}
                            className="h-2 bg-term-panel/30 hover:bg-term-panel/30"
                            aria-hidden="true"
                          >
                            <TableCell colSpan={9} className="border-0 p-0" />
                          </TableRow>
                        )
                      }
                      if (rowKind === 'total') {
                        return (
                          <TableRow
                            key={`total-${index}`}
                            className="border-t-2 border-slate-400 font-semibold hover:bg-transparent"
                          >
                            <TableCell className="border-r bg-emerald-100 px-2 py-2 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100">
                              {row.income_en}
                            </TableCell>
                            <TableCell className="border-r bg-emerald-100 px-2 py-2 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100">
                              {row.income_zh}
                            </TableCell>
                            <TableCell className="border-r bg-emerald-100 px-2 py-2 text-right tabular-nums text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100">
                              {formatCurrency(row.income_amount_usd, rowCurrencySymbol)}
                            </TableCell>
                            <TableCell className="border-r bg-emerald-100 px-2 py-2 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100">
                              {row.income_source || '\u00A0'}
                            </TableCell>
                            <TableCell className="border-r border-term-border bg-term-raised px-2 py-2 text-center font-mono text-xs text-term-muted">
                              |
                            </TableCell>
                            <TableCell className="border-r bg-term-neg/10 px-2 py-2 text-term-neg">
                              {row.expense_en}
                            </TableCell>
                            <TableCell className="border-r bg-term-neg/10 px-2 py-2 text-term-neg">
                              {row.expense_zh}
                            </TableCell>
                            <TableCell className="border-r bg-term-neg/10 px-2 py-2 text-right tabular-nums text-term-neg">
                              {formatCurrency(row.expense_amount_usd, rowCurrencySymbol)}
                            </TableCell>
                            <TableCell className="bg-term-neg/10 px-2 py-2 text-term-neg">
                              {row.expense_source || '\u00A0'}
                            </TableCell>
                          </TableRow>
                        )
                      }
                      return (
                        <TableRow key={`${row.income_en}-${row.expense_en}-${index}`}>
                          <TableCell className="border-r px-2 py-1.5">
                            {row.income_en || '-'}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5">
                            {row.income_zh || '-'}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatCurrency(row.income_amount_usd, rowCurrencySymbol)}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5">
                            {row.income_source || '-'}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-center text-muted-foreground">
                            |
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5">
                            {row.expense_en || '-'}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5">
                            {row.expense_zh || '-'}
                          </TableCell>
                          <TableCell className="border-r px-2 py-1.5 text-right tabular-nums">
                            {formatCurrency(row.expense_amount_usd, rowCurrencySymbol)}
                          </TableCell>
                          <TableCell className="px-2 py-1.5">{row.expense_source || '-'}</TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              ) : (
                <div className="rounded-none border border-dashed border-term-border px-4 py-10 text-center font-mono text-xs text-term-faint">
                  {accountingMonth ? '当前月份暂无月度明细' : '请选择有源报表月份查看月度明细'}
                </div>
              )}
            </>
          )}
        </DataTableCardBody>
      </DataTableCard>
    </div>
  )
}
