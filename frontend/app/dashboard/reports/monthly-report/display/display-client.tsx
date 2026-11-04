'use client'

import {
  Area,
  CartesianGrid,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  XAxis,
  YAxis,
  type ChartConfig,
} from '@/components/charts'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Download, Eye, EyeOff, RefreshCw } from 'lucide-react'
import { useSession } from 'next-auth/react'
import { AreaChart } from 'recharts'

import { WarmButton, WarmSelect } from '@/components/dashboard-v2/warm-ledger/controls'
import { logClientOperation } from '@/lib/operation-audit'
import {
  MonthPicker,
  formatMonthInputValue,
  parseMonthInputValue,
} from '@/components/ui/date-picker'
import { getClientCache, setClientCache } from '@/lib/client-cache'
import { resolveProjectCommissionUsd } from '@/lib/commission'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useUrlParam, useUrlParams } from '@/lib/hooks/use-url-param'
import { useAutoSelectFirstProject } from '@/lib/hooks/use-auto-select-first-project'
import { useSharedReportProject } from '../shared-project'
import { getCountryLabel } from '@/lib/country'
import { downloadBlob } from '@/lib/download-blob'
import { getExcelNumFmt } from './excel-num-fmt'
import { cn, formatLocalTimestampForFilename } from '@/lib/utils'
import {
  DEFAULT_REPORT_UPLOAD_COUNTRY,
  type ReportUploadCountry,
} from '@/components/report-upload/types'
import { VAT_COUNTRIES } from '@/lib/console-constants'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'
import {
  useHeaderRefresh,
  useMobileFilterStrip,
  usePrimaryFilterSlot,
} from '@/components/terminal/terminal-header-slot'
import styles from './display-warm.module.css'

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

const FINANCIAL_VIEW_TABS: ReadonlyArray<{ value: FinancialViewTab; label: string }> = [
  { value: 'financial', label: '月度汇总' },
  { value: 'accounting', label: '月度明细' },
]

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
    color: 'var(--warm-ledger-color-accent)',
  },
  income_refund: {
    label: '退款',
    color: 'var(--warm-ledger-color-negative)',
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

const DISPLAY_COUNTRY_SLOT_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
] as const

export default function DisplayTab() {
  const { data: session, status: sessionStatus } = useSession()
  const isAdmin = Boolean(session?.user?.isAdmin)
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)

  // 项目 / 国家同步到 URL search param，刷新 / 分享链接 / 浏览器后退都能记住选择。
  // 默认值为空串，URL 有值时覆盖。（起止月份见下方 monthUrl，带滚动默认语义）
  const [urlProjectId, setProjectId] = useUrlParam<string>('project', '')
  // BLF-1344：URL 没带项目时沿用上次在月报任一 tab 选过的项目（跨 tab 共享，并写回 URL）
  const {
    projectId,
    ready: sharedProjectReady,
    forgetProjectId,
  } = useSharedReportProject({
    projectId: urlProjectId,
    setProjectId,
  })

  // 进入页面默认选中第一个真实项目,内容立即加载（跳过 all / 空白意图）。
  // BLF-1344：共享记忆读出前不兜底——项目列表命中客户端缓存时兜底会先落地，
  // 把其它 tab 刚选的项目覆盖成第一个项目。
  useAutoSelectFirstProject(sharedProjectReady ? projects : [], projectId, setProjectId)
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
  const tabIdBase = useId()
  const [warmPortalContainer, setWarmPortalContainer] = useState<HTMLElement | null>(null)
  const [accountingMonth, setAccountingMonth] = useState('')
  // 月份是否由用户在下拉框里显式挑选过。自动默认（含首屏加载、刷新/重算后
  // 的重新落位）不算显式选择——只有显式选择才允许在数据更新后停留在原月份，
  // 否则默认始终跟随最新有源报表的月份。
  const accountingMonthUserPickedRef = useRef(false)
  const [accountingRows, setAccountingRows] = useState<FinancialAccountingDetailLine[]>([])
  const [accountingLoading, setAccountingLoading] = useState(false)
  const [accountingExporting, setAccountingExporting] = useState(false)
  const [accountingError, setAccountingError] = useState<string | null>(null)

  useEffect(() => {
    setWarmPortalContainer(document.getElementById('warm-ledger-portal-root'))
  }, [])

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
      // BLF-1344：共享记忆读出前不兜底（同上，避免盖掉其它 tab 的选择）。
      if (sharedProjectReady) {
        const existsInList = Boolean(projectId) && payload.some((p) => String(p.id) === projectId)
        if (!projectId || !existsInList) {
          // 不可见（换账号残留 / 权限被收回 / 项目下架）先清掉共享记忆：不清的话 hook 会把
          // 这个不可见的项目再写回 URL；然后回退到第一个可见项目，一个都没有就清空
          // （宁可不选，也不拿未校验的 id 去请求财务序列）。
          if (projectId && !existsInList) forgetProjectId()
          setProjectId(payload.length > 0 ? String(payload[0].id) : '')
        }
      }
    } catch (loadError) {
      setProjectLoadError(loadError instanceof Error ? loadError.message : '项目列表加载失败')
    } finally {
      setProjectsLoading(false)
    }
  }, [projectId, session, sharedProjectReady, forgetProjectId])

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
      downloadBlob(blob, filename)
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
  }, [accountingMonth, projectId, country])

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
      const safeProjectName = data.project_name.replace(/[\\/:*?"<>|]/g, '-')
      const safeCountryLabel = getCountryLabel(country).replace(/[\\/:*?"<>|]/g, '-')
      const endMonthStr = formatMonth(data.end_month)
      const filename = `${safeProjectName}_${safeCountryLabel}-月度财务汇总分析-${endMonthStr}.xlsx`
      downloadBlob(blob, filename)
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
          filename,
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
  const hasFinancialRows = Boolean(data && data.rows.length > 0)
  const showInitialLoading =
    !projectLoadError &&
    !error &&
    !data &&
    (projectsLoading || loading || sessionStatus === 'loading' || Boolean(projectId))
  const showNoVisibleProjects =
    !projectLoadError && !projectsLoading && projects.length === 0 && !projectId
  const showFinancialEmpty =
    !showInitialLoading && !showNoVisibleProjects && !projectLoadError && !error && !hasFinancialRows
  const activeTabId = `${tabIdBase}-${activeTab}-tab`
  const activePanelId = `${tabIdBase}-panel`
  const handleFinancialTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number
  ) => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % FINANCIAL_VIEW_TABS.length
    if (event.key === 'ArrowLeft') {
      nextIndex =
        (currentIndex - 1 + FINANCIAL_VIEW_TABS.length) % FINANCIAL_VIEW_TABS.length
    }
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = FINANCIAL_VIEW_TABS.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    setActiveTab(FINANCIAL_VIEW_TABS[nextIndex].value)
    const nextTab = document.getElementById(`${tabIdBase}-${FINANCIAL_VIEW_TABS[nextIndex].value}-tab`)
    nextTab?.focus()
  }

  // —— BLF-962 · head 插槽（display 试点，确立 generate / reconcile 复用模式）——
  // 刷新语义与原「财务分析」RefreshButton 一致：当前筛选条件下强刷（跳缓存）。
  useHeaderRefresh(() => loadFinancialSeries({ force: true }), { loading })

  // 桌面端：筛选控件 portal 进 Top Header 中段（店铺 / 国家 / 起止月份）。
  // 店铺沿用页面原生选项集（不含 ALL 全选位，与既有行为一致）；国家沿用 US/DE/UK
  // 三站集合（与旧 CountrySelect 默认 options 一致）。
  const projectSlotOptions = projects
    .filter((project) => project.id !== null)
    .map((project) => ({ value: String(project.id), label: project.name }))
  const headerFilterControls = (
    <div className={styles.headerFilters} data-warm-header-filters="true">
      <WarmSelect
        id="monthly-report-project-filter"
        label="店铺"
        value={projectId}
        onChange={setProjectId}
        options={projectSlotOptions}
        placeholder={projectsLoading ? '项目加载中…' : '请选择店铺'}
        disabled={projectsLoading || projects.length === 0}
        className={styles.projectFilter}
      />
      <WarmSelect
        id="monthly-report-country-filter"
        label="国家"
        value={country}
        onChange={(value) => setCountry(value as ReportUploadCountry)}
        options={[...DISPLAY_COUNTRY_SLOT_OPTIONS]}
        className={styles.countryFilter}
      />
      <div className={styles.monthRangeFilter} role="group" aria-label="月度范围">
        <div className={styles.monthField} role="group" aria-label="开始月份">
          <span className={styles.monthRangeLabel} aria-hidden="true">
            起
          </span>
          <MonthPicker
            value={parseMonthInputValue(startMonth)}
            onChange={handleStartMonthChange}
            placeholder="开始月份"
            className={styles.dateTrigger}
            portalContainer={warmPortalContainer}
            popoverClassName={cn(styles.datePopover, 'warm-ledger__date-picker-content')}
          />
        </div>
        <div className={styles.monthField} role="group" aria-label="结束月份">
          <span className={styles.monthRangeLabel} aria-hidden="true">
            止
          </span>
          <MonthPicker
            value={parseMonthInputValue(endMonth)}
            onChange={handleEndMonthChange}
            placeholder="结束月份"
            className={styles.dateTrigger}
            portalContainer={warmPortalContainer}
            popoverClassName={cn(styles.datePopover, 'warm-ledger__date-picker-content')}
          />
        </div>
      </div>
    </div>
  )
  const headerSlotPortal = usePrimaryFilterSlot(headerFilterControls)

  // 移动端：筛选控件下迁为正文顶部可折叠筛选条（短控件 1/2，起止月份占整行）。
  const mobileProjectLabel =
    projects.find((project) => String(project.id) === projectId)?.name || projectId || '选择店铺'
  const mobileCountryLabel =
    DISPLAY_COUNTRY_SLOT_OPTIONS.find((opt) => opt.value === country)?.label ?? country
  const mobileFilterSummary = `${mobileProjectLabel} · ${mobileCountryLabel} · ${startMonth || '——'}~${endMonth || '——'}`
  const mobileFilterStrip = useMobileFilterStrip(
    <MobileFilterStrip
      summary={mobileFilterSummary}
      controls={
        <>
          <WarmSelect
            id="monthly-report-project-filter-mobile"
            label="店铺"
            value={projectId}
            onChange={setProjectId}
            options={projectSlotOptions}
            placeholder={projectsLoading ? '项目加载中…' : '请选择店铺'}
            disabled={projectsLoading || projects.length === 0}
            className={styles.mobileFilterControl}
          />
          <WarmSelect
            id="monthly-report-country-filter-mobile"
            label="国家"
            value={country}
            onChange={(value) => setCountry(value as ReportUploadCountry)}
            options={[...DISPLAY_COUNTRY_SLOT_OPTIONS]}
            className={styles.mobileFilterControl}
          />
          <MobileFilterWide>
            <MonthPicker
              value={parseMonthInputValue(startMonth)}
              onChange={handleStartMonthChange}
              placeholder="开始月份"
              className={styles.dateTrigger}
              portalContainer={warmPortalContainer}
              popoverClassName={cn(styles.datePopover, 'warm-ledger__date-picker-content')}
            />
          </MobileFilterWide>
          <MobileFilterWide>
            <MonthPicker
              value={parseMonthInputValue(endMonth)}
              onChange={handleEndMonthChange}
              placeholder="结束月份"
              className={styles.dateTrigger}
              portalContainer={warmPortalContainer}
              popoverClassName={cn(styles.datePopover, 'warm-ledger__date-picker-content')}
            />
          </MobileFilterWide>
        </>
      }
    />
  )

  return (
    <div
      className={styles.page}
      data-testid="monthly-display-page"
      data-warm-monthly-display="true"
    >
      {headerSlotPortal}
      {/* 移动端折叠筛选条（正文顶部，md:hidden 挂载点内） */}
      {mobileFilterStrip}
      {projectLoadError ? (
        <div className={styles.alert} role="alert" aria-label="店铺列表请求失败">
          <strong>店铺列表请求失败</strong>
          <span>{projectLoadError}</span>
        </div>
      ) : null}
      {error ? (
        <div className={styles.alert} role="alert" aria-label="财务数据请求失败">
          <strong>财务数据请求失败</strong>
          <span>{error}</span>
        </div>
      ) : null}
      {accountingError ? (
        <div className={styles.alert} role="alert" aria-label="月度明细请求失败">
          <strong>月度明细请求失败</strong>
          <span>{accountingError}</span>
        </div>
      ) : null}

      <section
        className={styles.analysis}
        aria-label="月度财务分析"
        data-warm-surface="true"
        aria-busy={showInitialLoading || undefined}
      >
        <div className={styles.kpiGrid}>
          {[
            {
              label: '收入合计',
              value: hasFinancialRows
                ? formatCurrency(data!.trend.income_total_sum, currencySymbol)
                : '—',
              primary: true,
            },
            {
              label: '支出合计',
              value: hasFinancialRows
                ? formatCurrency(data!.trend.expense_total_sum, currencySymbol)
                : '—',
              primary: false,
            },
            {
              label: '亚马逊返款',
              value: hasFinancialRows
                ? formatCurrency(data!.trend.amazon_pay_back_sum, currencySymbol)
                : '—',
              primary: false,
            },
          ].map((item) => (
            <article key={item.label} className={styles.kpi}>
              <h2 className={styles.kpiLabel}>{item.label}</h2>
              {showInitialLoading ? (
                <span className={styles.kpiSkeleton} aria-hidden="true" />
              ) : (
                <p className={styles.kpiValue} data-primary={item.primary ? 'true' : undefined}>
                  {item.value}
                </p>
              )}
            </article>
          ))}
        </div>
        {showInitialLoading ? (
          <p className={styles.loadingState} role="status" aria-label="财务数据加载状态">
            正在加载财务数据…
          </p>
        ) : null}
      </section>

      {showInitialLoading || hasFinancialRows ? (
        <section className={styles.panel} aria-labelledby="monthly-trend-title">
          <header className={styles.panelHeader}>
            <div>
              <h2 id="monthly-trend-title" className={styles.panelTitle}>
                月度趋势
              </h2>
              {loading && data ? (
                <p className={styles.inlineStatus} role="status">
                  趋势更新中…
                </p>
              ) : null}
            </div>
            <div className={styles.seriesControls} aria-label="趋势系列">
              <button
                type="button"
                className={styles.seriesToggle}
                aria-pressed={visibleLines.income_sales}
                data-series="sales"
                onClick={() =>
                  setVisibleLines((prev) => ({
                    ...prev,
                    income_sales: !prev.income_sales,
                  }))
                }
              >
                {visibleLines.income_sales ? (
                  <Eye aria-hidden="true" />
                ) : (
                  <EyeOff aria-hidden="true" />
                )}
                <span className={styles.seriesSwatch} data-series="sales" aria-hidden="true" />
                销售额
              </button>
              <button
                type="button"
                className={styles.seriesToggle}
                aria-pressed={visibleLines.income_refund}
                data-series="refund"
                onClick={() =>
                  setVisibleLines((prev) => ({
                    ...prev,
                    income_refund: !prev.income_refund,
                  }))
                }
              >
                {visibleLines.income_refund ? (
                  <Eye aria-hidden="true" />
                ) : (
                  <EyeOff aria-hidden="true" />
                )}
                <span className={styles.seriesSwatch} data-series="refund" aria-hidden="true" />
                退款
              </button>
            </div>
          </header>
          <div className={styles.chartBody}>
            {showInitialLoading ? (
              <div className={styles.chartSkeleton} aria-hidden="true" />
            ) : trendPoints.length > 0 ? (
              <ChartContainer
                config={chartConfig}
                className={styles.chart}
                aria-label={`月度趋势，销售额与退款，${formatMonth(startMonth)}至${formatMonth(endMonth)}`}
              >
                <AreaChart
                  accessibilityLayer
                  data={trendPoints}
                  margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                >
                  <CartesianGrid
                    stroke="var(--warm-ledger-color-chart-grid)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="month_label"
                    axisLine={false}
                    tickLine={false}
                    tickMargin={8}
                    interval={0}
                    minTickGap={24}
                    tick={{
                      fontSize: 11,
                      fontFamily: 'var(--warm-ledger-font-mono)',
                      fill: 'var(--warm-ledger-color-text-muted)',
                    }}
                  />
                  <YAxis
                    width={56}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(value) => formatCompactCurrency(Number(value))}
                    tick={{
                      fontSize: 11,
                      fontFamily: 'var(--warm-ledger-font-mono)',
                      fill: 'var(--warm-ledger-color-text-muted)',
                    }}
                  />
                  <ChartTooltip
                    cursor={{
                      stroke: 'var(--warm-ledger-color-hairline-strong)',
                      strokeDasharray: '4 4',
                    }}
                    content={
                      <ChartTooltipContent
                        className={styles.tooltip}
                        formatter={(value, name) => {
                          const nameMap: Record<string, string> = {
                            income_sales: '销售额',
                            income_refund: '退款',
                          }
                          const displayName = nameMap[String(name)] ?? String(name)
                          return (
                            <div className={styles.tooltipRow}>
                              <span>{displayName}</span>
                              <span>{formatCurrency(Number(value), currencySymbol)}</span>
                            </div>
                          )
                        }}
                      />
                    }
                  />
                  {visibleLines.income_refund ? (
                    <Area
                      type="monotone"
                      dataKey="income_refund"
                      name="退款"
                      stroke="var(--warm-ledger-color-negative)"
                      fill="var(--warm-ledger-color-negative)"
                      fillOpacity={0.06}
                      strokeWidth={2}
                      isAnimationActive={false}
                    />
                  ) : null}
                  {visibleLines.income_sales ? (
                    <Area
                      type="monotone"
                      dataKey="income_sales"
                      name="销售额"
                      stroke="var(--warm-ledger-color-accent)"
                      fill="var(--warm-ledger-color-accent-area)"
                      fillOpacity={1}
                      strokeWidth={2}
                      isAnimationActive={false}
                    />
                  ) : null}
                </AreaChart>
              </ChartContainer>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className={styles.panel} aria-label="月度财务表格">
        <header className={styles.ledgerHeader}>
          <div className={styles.tabList} role="tablist" aria-label="月度报表视图">
            {FINANCIAL_VIEW_TABS.map((tab, index) => (
              <button
                key={tab.value}
                id={`${tabIdBase}-${tab.value}-tab`}
                type="button"
                role="tab"
                className={styles.tab}
                aria-selected={activeTab === tab.value}
                aria-controls={activePanelId}
                tabIndex={activeTab === tab.value ? 0 : -1}
                onClick={() => setActiveTab(tab.value)}
                onKeyDown={(event) => handleFinancialTabKeyDown(event, index)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className={styles.ledgerActions}>
            {activeTab === 'accounting' ? (
              <>
                <WarmSelect
                  id="monthly-report-accounting-month"
                  label="核算月份"
                  value={accountingMonth}
                  onChange={(month) => {
                    accountingMonthUserPickedRef.current = true
                    setAccountingMonth(month)
                  }}
                  options={accountingMonthOptions.map((month) => ({
                    value: month,
                    label: formatMonth(month),
                  }))}
                  placeholder="请选择月份"
                  disabled={accountingMonthOptions.length === 0}
                  className={styles.monthSelect}
                />
                <WarmButton
                  type="button"
                  onClick={() => void loadAccountingDetail()}
                  loading={accountingLoading}
                  loadingLabel="正在刷新月度明细"
                  disabled={!accountingMonth}
                  className={styles.actionButton}
                >
                  <RefreshCw aria-hidden="true" />
                  刷新月度明细
                </WarmButton>
                <WarmButton
                  type="button"
                  onClick={() => void exportAccountingDetail()}
                  loading={accountingExporting}
                  loadingLabel="正在导出月度明细"
                  disabled={!accountingMonth || accountingMonthOptions.length === 0}
                  className={styles.actionButton}
                >
                  <Download aria-hidden="true" />
                  导出核算明细
                </WarmButton>
              </>
            ) : (
              <>
                <WarmButton
                  type="button"
                  onClick={() => void exportFinancialAnalysis()}
                  loading={exporting}
                  loadingLabel="正在导出财务分析"
                  disabled={!data || detailExportRows.length === 0}
                  className={styles.actionButton}
                >
                  <Download aria-hidden="true" />
                  导出财务分析
                </WarmButton>
                <WarmButton
                  type="button"
                  onClick={() => void recalculateFinancialSeries()}
                  loading={recalculating}
                  loadingLabel="正在重新核算"
                  disabled={!data || data.rows.length === 0}
                  className={styles.actionButton}
                >
                  <RefreshCw aria-hidden="true" />
                  重新核算
                </WarmButton>
              </>
            )}
          </div>
        </header>
        <div
          className={styles.panelBody}
          id={activePanelId}
          role="tabpanel"
          aria-labelledby={activeTabId}
          aria-busy={
            (activeTab === 'financial' ? showInitialLoading || loading : accountingLoading) ||
            undefined
          }
        >
          {activeTab === 'financial' ? (
            <>
              {loading && data ? (
                <p className={styles.inlineStatus} role="status">
                  财务明细更新中…
                </p>
              ) : null}
              {showInitialLoading ? (
                <div className={styles.tableSkeleton} aria-hidden="true">
                  {Array.from({ length: 6 }).map((_, index) => (
                    <span key={index} />
                  ))}
                </div>
              ) : hasFinancialRows ? (
                <div
                  className={styles.tableScroller}
                  data-monthly-table-scroll="true"
                  tabIndex={0}
                  role="region"
                  aria-label="月度财务汇总表滚动区域"
                >
                  <table
                    className={cn(styles.table, isAdmin ? styles.tableAdmin : styles.tableStandard)}
                    aria-label="月度财务汇总表"
                  >
                  <thead>
                    <tr>
                      <th
                        rowSpan={2}
                        className={cn(styles.tableHead, styles.stickyHead)}
                        style={{ left: 0, minWidth: MONTH_STICKY_WIDTH }}
                      >
                        年/月度
                      </th>
                      <th
                        colSpan={4}
                        className={cn(styles.tableHead, styles.groupHead, styles.incomeGroupHead)}
                      >
                        平台-收入 Income
                      </th>
                      <th
                        colSpan={6}
                        className={cn(styles.tableHead, styles.groupHead, styles.expenseGroupHead)}
                      >
                        平台-支出 Expense
                      </th>
                      <th rowSpan={2}>
                        收入合计
                      </th>
                      <th rowSpan={2}>
                        支出合计
                      </th>
                      {showVatColumn ? (
                        <th rowSpan={2}>
                          VAT
                        </th>
                      ) : null}
                      <th rowSpan={2}>
                        亚马逊回款
                      </th>
                      <th rowSpan={2}>
                        信用卡扣款
                      </th>
                      {isAdmin ? (
                        <>
                          <th rowSpan={2}>
                            测评费用RMB
                          </th>
                          <th rowSpan={2}>
                            垫付其他RMB
                          </th>
                          <th rowSpan={2}>
                            运营佣金RMB
                          </th>
                          <th rowSpan={2}>
                            应付总计RMB
                          </th>
                          <th rowSpan={2}>
                            汇率
                          </th>
                        </>
                      ) : null}
                      <th rowSpan={2}>
                        平台占比
                      </th>
                      <th rowSpan={2}>
                        配送占比
                      </th>
                      <th rowSpan={2}>
                        仓储占比
                      </th>
                      <th rowSpan={2}>
                        服务占比
                      </th>
                      <th rowSpan={2}>
                        广告占比
                      </th>
                      <th rowSpan={2}>
                        退款率
                      </th>
                      <th rowSpan={2}>
                        回款率
                      </th>
                      <th rowSpan={2}>
                        FOB成本
                      </th>
                      <th rowSpan={2}>
                        头程成本
                      </th>
                      <th rowSpan={2}>
                        净利润RMB
                      </th>
                      <th rowSpan={2}>
                        净利润{currencyLabel}
                      </th>
                      <th rowSpan={2}>
                        净利率
                      </th>
                    </tr>
                    <tr>
                      <th className={styles.incomeGroupCell}>
                        销售额
                      </th>
                      <th className={styles.incomeGroupCell}>
                        退款
                      </th>
                      <th className={styles.incomeGroupCell}>
                        赔偿
                      </th>
                      <th className={styles.incomeGroupCell}>
                        其他收入
                      </th>
                      <th className={styles.expenseGroupCell}>
                        平台费
                      </th>
                      <th className={styles.expenseGroupCell}>
                        配送费
                      </th>
                      <th className={styles.expenseGroupCell}>
                        仓储费
                      </th>
                      <th className={styles.expenseGroupCell}>
                        服务费
                      </th>
                      <th className={styles.expenseGroupCell}>
                        广告费
                      </th>
                      <th className={styles.expenseGroupCell}>
                        其他费用
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.rows.map((row) => {
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
                        <tr
                          key={row.report_month}
                          className={!row.has_source_report ? styles.missingSourceRow : undefined}
                        >
                          <td
                            className={cn(styles.textCell, styles.stickyCell)}
                            style={{ left: 0, minWidth: MONTH_STICKY_WIDTH }}
                          >
                            <div className={styles.monthCell}>
                              <span>{formatMonth(row.report_month)}</span>
                              {!row.has_source_report ? (
                                <span className={styles.missingSourceBadge}>无</span>
                              ) : null}
                            </div>
                          </td>
                          <td className={styles.numberCell}>
                            {formatCurrency(resolveDisplaySales(row), currencySymbol)}
                          </td>
                          <td className={styles.numberCell}>
                            {formatCurrency(row.income_refund, currencySymbol)}
                          </td>
                          <td className={styles.numberCell}>
                            {formatCurrency(row.income_adjustment, currencySymbol)}
                          </td>
                          <td className={styles.numberCell}>
                            {formatCurrency(row.income_other, currencySymbol)}
                          </td>
                          <td className={styles.numberCell}>
                            {formatCurrency(row.expense_selling_fee, currencySymbol)}
                          </td>
                          <td className={styles.numberCell}>
                            {formatCurrency(row.expense_fba_fee, currencySymbol)}
                          </td>
                          <td className={styles.numberCell}>
                            {formatCurrency(row.expense_inventory_fee, currencySymbol)}
                          </td>
                          <td className={styles.numberCell}>
                            {formatCurrency(row.expense_service_fee, currencySymbol)}
                          </td>
                          <td className={styles.numberCell}>
                            {formatCurrency(row.expense_advertising, currencySymbol)}
                          </td>
                          <td className={styles.numberCell}>
                            {formatCurrency(row.expense_other_fees, currencySymbol)}
                          </td>
                          <td className={cn(styles.numberCell, styles.emphasisCell)}>
                            {formatCurrency(row.income_total, currencySymbol)}
                          </td>
                          <td className={cn(styles.numberCell, styles.emphasisCell)}>
                            {formatCurrency(row.expense_total, currencySymbol)}
                          </td>
                          {showVatColumn ? (
                            <td className={styles.numberCell}>
                              {formatCurrency(Math.abs(row.income_vat_total ?? 0), currencySymbol)}
                            </td>
                          ) : null}
                          <td className={cn(styles.numberCell, styles.emphasisCell)}>
                            {formatCurrency(row.amazon_pay_back, currencySymbol)}
                          </td>
                          <td className={styles.numberCell}>
                            {formatCurrency(creditCard, currencySymbol)}
                          </td>
                          {isAdmin ? (
                            <>
                              <td className={styles.numberCell}>
                                {formatRmb(evaluationFeeRmb)}
                              </td>
                              <td className={styles.numberCell}>
                                {formatRmb(prepaymentOtherRmb)}
                              </td>
                              <td className={styles.numberCell}>
                                {disableCommission ? '-' : formatRmb(operationCommissionRmb)}
                              </td>
                              <td className={cn(styles.numberCell, styles.emphasisCell)}>
                                {disableCommission ? '-' : formatRmb(payableTotalRmb)}
                              </td>
                              <td className={styles.numberCell}>
                                {formatRate(exchangeRate)}
                              </td>
                            </>
                          ) : null}
                          <td className={styles.numberCell}>
                            {formatRatio(platformRatio)}
                          </td>
                          <td className={styles.numberCell}>
                            {formatRatio(deliveryRatio)}
                          </td>
                          <td className={styles.numberCell}>
                            {formatRatio(storageRatio)}
                          </td>
                          <td className={styles.numberCell}>
                            {formatRatio(serviceRatio)}
                          </td>
                          <td className={styles.numberCell}>
                            {formatRatio(adRatio)}
                          </td>
                          <td className={styles.numberCell}>
                            {formatRatio(refundRatio)}
                          </td>
                          <td className={styles.numberCell}>
                            {formatSignedRatio(paybackRatio)}
                          </td>
                          <td className={styles.numberCell}>
                            {formatRmb(row.fob_cost_rmb)}
                          </td>
                          <td className={styles.numberCell}>
                            {formatRmb(row.first_leg_cost_rmb)}
                          </td>
                          <td className={cn(styles.numberCell, styles.emphasisCell)}>
                            {formatRmb(netProfitRmb)}
                          </td>
                          <td className={cn(styles.numberCellNoBorder, styles.emphasisCell)}>
                            {formatCurrency(netProfitUsd, currencySymbol)}
                          </td>
                          <td className={cn(styles.numberCellNoBorder, styles.emphasisCell)}>
                            {formatSignedRatio(netProfitRate)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className={styles.footerRow}>
                      <td
                        className={cn(styles.textCell, styles.stickyCell, styles.footerCell)}
                        style={{ left: 0, minWidth: MONTH_STICKY_WIDTH }}
                      >
                        合计
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatCurrency(totals.income_sales, currencySymbol)}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatCurrency(totals.income_refund, currencySymbol)}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatCurrency(totals.income_adjustment, currencySymbol)}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatCurrency(totals.income_other, currencySymbol)}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatCurrency(totals.expense_selling_fee, currencySymbol)}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatCurrency(totals.expense_fba_fee, currencySymbol)}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatCurrency(totals.expense_inventory_fee, currencySymbol)}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatCurrency(totals.expense_service_fee, currencySymbol)}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatCurrency(totals.expense_advertising, currencySymbol)}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatCurrency(totals.expense_other_fees, currencySymbol)}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatCurrency(totals.income_total, currencySymbol)}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatCurrency(totals.expense_total, currencySymbol)}
                      </td>
                      {showVatColumn ? (
                        <td className={cn(styles.numberCell, styles.footerCell)}>
                          {formatCurrency(totals.income_vat_total ?? 0, currencySymbol)}
                        </td>
                      ) : null}
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatCurrency(totals.amazon_pay_back, currencySymbol)}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatCurrency(totals.credit_card_deduction_usd, currencySymbol)}
                      </td>
                      {isAdmin ? (
                        <>
                          <td className={cn(styles.numberCell, styles.footerCell)}>
                            {formatRmb(totals.evaluation_fee_rmb)}
                          </td>
                          <td className={cn(styles.numberCell, styles.footerCell)}>
                            {formatRmb(totals.prepayment_other_rmb)}
                          </td>
                          <td className={cn(styles.numberCell, styles.footerCell)}>
                            {disableCommission ? '-' : formatRmb(totals.operation_commission_rmb)}
                          </td>
                          <td className={cn(styles.numberCell, styles.footerCell)}>
                            {disableCommission ? '-' : formatRmb(totals.payable_total_rmb)}
                          </td>
                          <td className={cn(styles.numberCell, styles.footerCell)}>
                            {formatRate(
                              totals.exchange_rate_count > 0
                                ? totals.exchange_rate_sum / totals.exchange_rate_count
                                : 0
                            )}
                          </td>
                        </>
                      ) : null}
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatRatio(
                          toPositiveRatio(totals.expense_selling_fee, totals.income_total)
                        )}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatRatio(toPositiveRatio(totals.expense_fba_fee, totals.income_total))}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatRatio(
                          toPositiveRatio(totals.expense_inventory_fee, totals.income_total)
                        )}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatRatio(
                          toPositiveRatio(totals.expense_service_fee, totals.income_total)
                        )}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatRatio(
                          toPositiveRatio(totals.expense_advertising, totals.income_total)
                        )}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatRatio(toPositiveRatio(totals.income_refund, totals.income_sales))}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatSignedRatio(
                          toSignedRatio(totals.amazon_pay_back, totals.income_total)
                        )}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatRmb(totals.fob_cost_rmb)}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatRmb(totals.first_leg_cost_rmb)}
                      </td>
                      <td className={cn(styles.numberCell, styles.footerCell)}>
                        {formatRmb(totals.net_profit_rmb)}
                      </td>
                      <td className={cn(styles.numberCellNoBorder, styles.footerCell)}>
                        {formatCurrency(totals.net_profit_usd, currencySymbol)}
                      </td>
                      <td className={cn(styles.numberCellNoBorder, styles.footerCell)}>
                        {formatSignedRatio(
                          toSignedRatio(totals.net_profit_usd, totals.income_total)
                        )}
                      </td>
                    </tr>
                  </tfoot>
                  </table>
                </div>
              ) : showNoVisibleProjects ? (
                <div className={styles.emptyState}>当前账号没有可见店铺</div>
              ) : showFinancialEmpty ? (
                <div className={styles.emptyState}>当前筛选条件暂无财务数据</div>
              ) : null}
            </>
          ) : (
            <>
              {accountingLoading && accountingRows.length > 0 ? (
                <p className={styles.inlineStatus} role="status">
                  月度明细更新中…
                </p>
              ) : null}
              {accountingLoading && accountingRows.length === 0 ? (
                <>
                  <p className={styles.loadingState} role="status">
                    正在加载月度明细…
                  </p>
                  <div className={styles.tableSkeleton} aria-hidden="true">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <span key={i} />
                    ))}
                  </div>
                </>
              ) : accountingMonth && accountingRows.length > 0 ? (
                <div
                  className={styles.tableScroller}
                  data-monthly-table-scroll="true"
                  tabIndex={0}
                  role="region"
                  aria-label="月度明细表滚动区域"
                >
                  <table
                    className={cn(styles.table, styles.tableAccounting)}
                    aria-label="月度明细表"
                  >
                  <thead>
                    <tr>
                      <th colSpan={4} className={styles.incomeGroupCell}>
                        Income（收入）
                      </th>
                      <th />
                      <th colSpan={4} className={cn(styles.groupHead, styles.expenseGroupHead)}>
                        Expense（支出）
                      </th>
                    </tr>
                    <tr>
                      <th>Income</th>
                      <th>收入</th>
                      <th>
                        In金额（{accountingCurrencyLabel}）
                      </th>
                      <th>In源表</th>
                      <th />
                      <th>Expense</th>
                      <th>支出</th>
                      <th>
                        Ex金额（{accountingCurrencyLabel}）
                      </th>
                      <th>Ex源表</th>
                    </tr>
                  </thead>
                  <tbody>
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
                          <tr
                            key={`spacer-${index}`}
                            className={styles.spacerRow}
                            aria-hidden="true"
                          >
                            <td colSpan={9} className={styles.spacerCell} />
                          </tr>
                        )
                      }
                      if (rowKind === 'total') {
                        return (
                          <tr key={`total-${index}`} className={styles.totalRow}>
                            <td className={styles.incomeGroupCell}>
                              {row.income_en}
                            </td>
                            <td className={styles.incomeGroupCell}>
                              {row.income_zh}
                            </td>
                            <td className={cn(styles.incomeGroupCell, styles.numberCell)}>
                              {formatCurrency(row.income_amount_usd, rowCurrencySymbol)}
                            </td>
                            <td className={styles.incomeGroupCell}>
                              {row.income_source || '\u00A0'}
                            </td>
                            <td className={styles.dividerCell}>
                              |
                            </td>
                            <td className={styles.expenseGroupCell}>
                              {row.expense_en}
                            </td>
                            <td className={styles.expenseGroupCell}>
                              {row.expense_zh}
                            </td>
                            <td className={cn(styles.expenseGroupCell, styles.numberCell)}>
                              {formatCurrency(row.expense_amount_usd, rowCurrencySymbol)}
                            </td>
                            <td className={cn(styles.expenseGroupCell, styles.textCellNoBorder)}>
                              {row.expense_source || '\u00A0'}
                            </td>
                          </tr>
                        )
                      }
                      return (
                        <tr key={`${row.income_en}-${row.expense_en}-${index}`}>
                          <td className={styles.textCell}>
                            {row.income_en || '-'}
                          </td>
                          <td className={styles.textCell}>
                            {row.income_zh || '-'}
                          </td>
                          <td className={styles.numberCell}>
                            {formatCurrency(row.income_amount_usd, rowCurrencySymbol)}
                          </td>
                          <td className={styles.textCell}>
                            {row.income_source || '-'}
                          </td>
                          <td className={styles.dividerCell}>
                            |
                          </td>
                          <td className={styles.textCell}>
                            {row.expense_en || '-'}
                          </td>
                          <td className={styles.textCell}>
                            {row.expense_zh || '-'}
                          </td>
                          <td className={styles.numberCell}>
                            {formatCurrency(row.expense_amount_usd, rowCurrencySymbol)}
                          </td>
                          <td className={styles.textCellNoBorder}>{row.expense_source || '-'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  </table>
                </div>
              ) : !accountingError && !error ? (
                <div className={styles.emptyState}>
                  {accountingMonth ? '当前月份暂无月度明细' : '请选择有源报表月份查看月度明细'}
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  )
}
