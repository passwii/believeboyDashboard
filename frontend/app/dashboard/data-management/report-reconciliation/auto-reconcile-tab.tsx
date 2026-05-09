'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2,
  FileText,
  RefreshCw,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useNotifications } from '@/components/notifications'
import {
  DataCard,
  DataCardHeader,
  DataCardContent,
} from '@/components/ui/data-card'
import { Badge } from '@/components/ui/badge'
import { ProjectSelect } from '@/components/dashboard/console/project-select'
import { MonthNavigation } from '@/components/dashboard/console/month-navigation'
import { CountrySelect } from '@/components/dashboard/console/country-select'
import { cn } from '@/lib/utils'

// ─── Types ───────────────────────────────────────────────────────────────────

type AvailableReport = {
  report_id: number
  project_name: string
  country: string
  report_month: string
  has_summary_pdf: boolean
  pdf_uploaded_at: string | null
  pt3_calculation_complete: boolean
  pt4_calculation_complete: boolean
  status: string
}

type ReconcileItem = {
  field_name: string
  db_value: number | null
  pdf_value: number | null
  match: boolean
  difference: number | null
  difference_percent: number | null
}

type ReconcileResult = {
  summary: {
    db_total_income: number | null
    db_total_expense: number | null
    db_net_amount: number | null
    pdf_total_income: number | null
    pdf_total_expense: number | null
    pdf_net_amount: number | null
  }
  total_items: number
  matched_items: number
  mismatched_items: number
  missing_items: number
  match_rate: number
  items: ReconcileItem[]
  record_id: number | null
}

type HistoryRecord = {
  id: number
  report_id: number
  project_name: string
  country: string
  report_month: string
  operator: string
  mode: string
  match_rate: number
  matched_items: number
  mismatched_items: number
  missing_items: number
  total_items: number
  created_at: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FIELD_NAME_LABELS: Record<string, string> = {
  FBA_product_sales: 'FBA 销售额',
  FBA_product_sale_refunds: 'FBA 销售额退款',
  FBA_selling_fees: 'FBA 销售佣金',
  FBA_transaction_fees: 'FBA 派送费',
  FBA_inventory_and_inbound_services: 'FBA 库存和入库服务费',
  service_fees: '服务费',
  advertising_costs: '广告成本',
  total_income: '合计收入',
  total_expense: '合计费用',
}

const COUNTRY_LABELS: Record<string, string> = {
  US: '美国站',
  DE: '德国站',
  UK: '英国站',
  JP: '日本站',
  FR: '法国站',
  IT: '意大利站',
  ES: '西班牙站',
  CA: '加拿大站',
  MX: '墨西哥站',
  AU: '澳大利亚站',
  IN: '印度站',
  BR: '巴西站',
  NL: '荷兰站',
  SE: '瑞典站',
  PL: '波兰站',
  TR: '土耳其站',
  SG: '新加坡站',
  AE: '阿联酋站',
  BE: '比利时站',
  SA: '沙特站',
}

// ─── Utilities ──────────────────────────────────────────────────────────────

const COUNTRY_CURRENCY: Record<string, string> = {
  US: 'USD',
  DE: 'EUR',
  UK: 'GBP',
  JP: 'JPY',
  FR: 'EUR',
  IT: 'EUR',
  ES: 'EUR',
  CA: 'CAD',
  MX: 'MXN',
  AU: 'AUD',
  IN: 'INR',
  BR: 'BRL',
  NL: 'EUR',
  SE: 'SEK',
  PL: 'PLN',
  TR: 'TRY',
  SG: 'SGD',
  AE: 'AED',
  BE: 'EUR',
  SA: 'SAR',
}

function formatCurrency(value: number | null | undefined, country: string): string {
  if (value === null || value === undefined) return '-'
  const currency = COUNTRY_CURRENCY[country] ?? 'EUR'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(value)
}

function formatMonth(monthStr: string): string {
  const [year, m] = monthStr.split('-')
  return `${year}年${m}月`
}

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ─── Components ──────────────────────────────────────────────────────────────

function DetailItem({ item, country }: { item: ReconcileItem; country: string }) {
  const label = FIELD_NAME_LABELS[item.field_name] || item.field_name
  const isMatch = item.match
  const borderColor = isMatch
    ? 'border-emerald-200 dark:border-emerald-800/50'
    : 'border-red-200 dark:border-red-800/50'
  const rowBg = isMatch
    ? 'bg-emerald-50 dark:bg-emerald-900/10'
    : 'bg-red-50 dark:bg-red-900/10'

  return (
    <tr className={cn('transition-colors', rowBg)}>
      <td className={cn('border-r px-4 py-3', borderColor)}>
        <div className='flex items-center gap-2'>
          {isMatch ? (
            <CheckCircle2 className='h-4 w-4 shrink-0 text-emerald-500' />
          ) : (
            <XCircle className='h-4 w-4 shrink-0 text-red-500' />
          )}
          <span className='font-medium text-sm'>{label}</span>
        </div>
      </td>
      <td
        className={cn(
          'border-r px-4 py-3 text-right font-mono',
          borderColor,
          isMatch ? 'text-foreground' : 'text-red-600 dark:text-red-400'
        )}
      >
        {formatCurrency(item.db_value, country)}
      </td>
      <td
        className={cn(
          'border-r px-4 py-3 text-right font-mono',
          borderColor,
          isMatch ? 'text-foreground' : 'text-red-600 dark:text-red-400'
        )}
      >
        {formatCurrency(item.pdf_value, country)}
      </td>
      <td className={cn('px-4 py-3 text-right', borderColor)}>
        {isMatch ? (
          <span className='text-xs font-medium text-emerald-600 dark:text-emerald-400'>OK</span>
        ) : (
          <span className='text-xs font-medium text-red-600 dark:text-red-400'>
            差异: {formatCurrency(item.difference, country)}
            {item.difference_percent !== null && (
              <span className='ml-1 text-muted-foreground'>({item.difference_percent}%)</span>
            )}
          </span>
        )}
      </td>
    </tr>
  )
}

function SummaryCards({ result, country }: { result: ReconcileResult; country: string }) {
  const { summary } = result

  return (
    <div className='grid gap-4 md:grid-cols-3'>
      <div className='rounded-lg border bg-[hsl(var(--surface-subtle))] p-4'>
        <div className='text-sm text-muted-foreground'>收入合计</div>
        <div className='mt-1 font-mono text-2xl font-semibold'>
          {formatCurrency(summary.db_total_income, country)}
        </div>
        <div className='mt-1 text-xs text-muted-foreground'>
          PDF: {formatCurrency(summary.pdf_total_income, country)}
        </div>
      </div>
      <div className='rounded-lg border bg-[hsl(var(--surface-subtle))] p-4'>
        <div className='text-sm text-muted-foreground'>支出合计</div>
        <div className='mt-1 font-mono text-2xl font-semibold'>
          {formatCurrency(summary.db_total_expense, country)}
        </div>
        <div className='mt-1 text-xs text-muted-foreground'>
          PDF: {formatCurrency(summary.pdf_total_expense, country)}
        </div>
      </div>
      <div className='rounded-lg border bg-[hsl(var(--surface-subtle))] p-4'>
        <div className='text-sm text-muted-foreground'>净收款</div>
        <div className='mt-1 font-mono text-2xl font-semibold text-emerald-600 dark:text-emerald-400'>
          {formatCurrency(summary.db_net_amount, country)}
        </div>
        <div className='mt-1 text-xs text-muted-foreground'>
          PDF: {formatCurrency(summary.pdf_net_amount, country)}
        </div>
      </div>
    </div>
  )
}

function ReconcileDetailPanel({
  result,
  projectName,
  reportMonth,
  country,
}: {
  result: ReconcileResult
  projectName: string
  reportMonth: string
  country: string
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <DataCard className='overflow-hidden border-border/70 shadow-[var(--shadow-soft)] dark:border-border/90'>
      <div
        className='flex cursor-pointer items-center justify-between px-6 py-4 hover:bg-[hsl(var(--surface-subtle))]'
        onClick={() => setExpanded(!expanded)}
      >
        <div className='flex items-center gap-4'>
          <div className='flex items-center gap-2'>
            <Badge
              variant='outline'
              className={
                result.match_rate === 100
                  ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                  : 'border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
              }
            >
              {result.match_rate === 100 ? (
                <>
                  <CheckCircle2 className='mr-1 h-4 w-4' />
                  全部匹配
                </>
              ) : (
                <>
                  <AlertCircle className='mr-1 h-4 w-4' />
                  {result.matched_items}/{result.total_items} 匹配
                </>
              )}
            </Badge>
            <span className='text-sm font-medium'>
              {projectName} - {COUNTRY_LABELS[country] || country} - {formatMonth(reportMonth)}
            </span>
          </div>
        </div>
        <Button variant='ghost' size='sm' className='h-8'>
          {expanded ? (
            <ChevronUp className='h-4 w-4' />
          ) : (
            <ChevronDown className='h-4 w-4' />
          )}
        </Button>
      </div>

      {expanded && (
        <DataCardContent className='p-0'>
          <SummaryCards result={result} country={country} />

          <div className='mt-4 overflow-x-auto'>
            <table className='w-full border-collapse'>
              <thead>
                <tr className='border-b bg-[hsl(var(--surface-subtle))] text-xs font-medium uppercase tracking-wider text-muted-foreground'>
                  <th className='border-r px-4 py-3 text-left'>字段</th>
                  <th className='border-r px-4 py-3 text-right'>数据库</th>
                  <th className='border-r px-4 py-3 text-right'>PDF</th>
                  <th className='px-4 py-3 text-right'>状态</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item, index) => (
                  <DetailItem key={index} item={item} country={country} />
                ))}
              </tbody>
            </table>
          </div>
        </DataCardContent>
      )}
    </DataCard>
  )
}

function OverviewTable({ records }: { records: HistoryRecord[] }) {
  if (records.length === 0) {
    return (
      <div className='rounded-lg border border-dashed p-8 text-center text-muted-foreground'>
        暂无核对记录
      </div>
    )
  }

  // Group by project and country
  const grouped: Record<string, HistoryRecord[]> = {}
  records.forEach((r) => {
    const key = `${r.project_name}-${r.country}`
    if (!grouped[key]) grouped[key] = []
    grouped[key].push(r)
  })

  return (
    <div className='overflow-x-auto'>
      <table className='w-full border-collapse'>
        <thead>
          <tr className='border-b bg-[hsl(var(--surface-subtle))] text-xs font-medium uppercase tracking-wider text-muted-foreground'>
            <th className='px-4 py-3 text-left'>项目</th>
            <th className='px-4 py-3 text-left'>月份</th>
            <th className='px-4 py-3 text-right'>匹配率</th>
            <th className='px-4 py-3 text-right'>匹配项</th>
            <th className='px-4 py-3 text-right'>差异项</th>
            <th className='px-4 py-3 text-right'>缺失项</th>
            <th className='px-4 py-3 text-left'>核对时间</th>
            <th className='px-4 py-3 text-left'>操作员</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr
              key={record.id}
              className='border-b transition-colors hover:bg-[hsl(var(--surface-subtle))]'
            >
              <td className='px-4 py-3'>
                <span className='font-medium'>{record.project_name}</span>
              </td>
              <td className='px-4 py-3'>
                <span className='text-sm'>
                  {COUNTRY_LABELS[record.country] || record.country} - {formatMonth(record.report_month)}
                </span>
              </td>
              <td className='px-4 py-3 text-right'>
                <Badge
                  variant='outline'
                  className={
                    record.match_rate === 100
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                      : record.match_rate >= 80
                        ? 'border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                        : 'border-red-500 bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                  }
                >
                  {record.match_rate}%
                </Badge>
              </td>
              <td className='px-4 py-3 text-right font-mono text-emerald-600 dark:text-emerald-400'>
                {record.matched_items}
              </td>
              <td className='px-4 py-3 text-right font-mono text-red-600 dark:text-red-400'>
                {record.mismatched_items}
              </td>
              <td className='px-4 py-3 text-right font-mono text-amber-600 dark:text-amber-400'>
                {record.missing_items}
              </td>
              <td className='px-4 py-3 text-sm text-muted-foreground'>
                {formatDateTime(record.created_at)}
              </td>
              <td className='px-4 py-3 text-sm text-muted-foreground'>{record.operator}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ReportRow({
  report,
  onReconcile,
  reconciling,
}: {
  report: AvailableReport
  onReconcile: (reportId: number, reportCountry: string) => void
  reconciling: boolean
}) {
  const canReconcile = report.has_summary_pdf && report.pt3_calculation_complete

  return (
    <tr className='border-b transition-colors hover:bg-[hsl(var(--surface-subtle))]'>
      <td className='px-4 py-3'>
        <span className='font-medium'>{report.project_name}</span>
      </td>
      <td className='px-4 py-3 text-sm'>
        {COUNTRY_LABELS[report.country] || report.country}
      </td>
      <td className='px-4 py-3 text-sm'>{formatMonth(report.report_month)}</td>
      <td className='px-4 py-3'>
        {report.has_summary_pdf ? (
          <CheckCircle2 className='h-5 w-5 text-emerald-500' />
        ) : (
          <XCircle className='h-5 w-5 text-red-500' />
        )}
      </td>
      <td className='px-4 py-3'>
        {report.pt3_calculation_complete ? (
          <CheckCircle2 className='h-5 w-5 text-emerald-500' />
        ) : (
          <XCircle className='h-5 w-5 text-red-500' />
        )}
      </td>
      <td className='px-4 py-3'>
        <Badge
          variant='outline'
          className={
            report.status === 'success'
              ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
              : 'border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
          }
        >
          {report.status === 'success' ? '已完成' : report.status}
        </Badge>
      </td>
      <td className='px-4 py-3'>
        <Button
          size='sm'
          disabled={!canReconcile || reconciling}
          onClick={() => onReconcile(report.report_id, report.country)}
        >
          {reconciling ? <Loader2 className='mr-1 h-4 w-4 animate-spin' /> : null}
          核对
        </Button>
      </td>
    </tr>
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function AutoReconcileTab() {
  const { notify } = useNotifications()

  // Filter state
  const [projectId, setProjectId] = useState<string>('')
  const [country, setCountry] = useState<string>('US')
  const [selectedMonth, setSelectedMonth] = useState<Date | undefined>(new Date())

  // Data state
  const [availableReports, setAvailableReports] = useState<AvailableReport[]>([])
  const [reconcileResults, setReconcileResults] = useState<Map<number, ReconcileResult>>(new Map())
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [reconciling, setReconciling] = useState(false)
  const [currentReconcileId, setCurrentReconcileId] = useState<number | null>(null)

  // Fetch available reports
  const fetchAvailableReports = useCallback(async () => {
    if (!projectId) {
      setAvailableReports([])
      return
    }

    setLoading(true)
    try {
      const params = new URLSearchParams({
        project_id: projectId,
        ...(country ? { country } : {}),
        ...(selectedMonth
          ? {
              month: `${selectedMonth.getFullYear()}-${String(selectedMonth.getMonth() + 1).padStart(2, '0')}`,
            }
          : {}),
      })

      const response = await fetch(`/api/backend/api/v1/report-reconciliation/available-reports?${params}`)
      if (!response.ok) throw new Error('Failed to fetch available reports')

      const data = await response.json()
      setAvailableReports(data.reports || [])
    } catch (error) {
      notify({
        type: 'error',
        title: '加载失败',
        message: error instanceof Error ? error.message : '未知错误',
      })
    } finally {
      setLoading(false)
    }
  }, [projectId, country, selectedMonth, notify])

  // Fetch history
  const fetchHistory = useCallback(async () => {
    if (!projectId) {
      setHistoryRecords([])
      return
    }

    try {
      const params = new URLSearchParams({
        project_id: projectId,
        limit: '50',
      })

      const response = await fetch(`/api/backend/api/v1/report-reconciliation/history?${params}`)
      if (!response.ok) throw new Error('Failed to fetch history')

      const data = await response.json()
      setHistoryRecords(data.records || [])
    } catch (error) {
      console.error('Failed to fetch history:', error)
    }
  }, [projectId])

  // Auto-fetch when filters change
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchAvailableReports()
      fetchHistory()
    }, 300)
    return () => clearTimeout(timer)
  }, [fetchAvailableReports, fetchHistory])

  // Perform reconciliation
  const handleReconcile = async (reportId: number, reportCountry: string) => {
    setReconciling(true)
    setCurrentReconcileId(reportId)

    try {
      const response = await fetch('/api/backend/api/v1/report-reconciliation/auto-reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_id: reportId,
          tolerance: 0.01,
          country: reportCountry,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.detail || '核对失败')
      }

      const result: ReconcileResult = await response.json()

      // Update results
      setReconcileResults((prev) => {
        const newMap = new Map(prev)
        newMap.set(reportId, result)
        return newMap
      })

      // Refresh history
      await fetchHistory()

      if (result.match_rate === 100) {
        notify({ type: 'success', title: '核对完成', message: '所有数据项均匹配' })
      } else if (result.mismatched_items > 0) {
        notify({
          type: 'warning',
          title: '核对完成',
          message: `发现 ${result.mismatched_items} 项差异，请检查`,
        })
      } else {
        notify({ type: 'success', title: '核对完成', message: '核对成功' })
      }
    } catch (error) {
      notify({
        type: 'error',
        title: '核对失败',
        message: error instanceof Error ? error.message : '未知错误',
      })
    } finally {
      setReconciling(false)
      setCurrentReconcileId(null)
    }
  }

  // Group reports for summary
  const canReconcileReports = availableReports.filter(
    (r) => r.has_summary_pdf && r.pt3_calculation_complete
  )
  const cannotReconcileReports = availableReports.filter(
    (r) => !r.has_summary_pdf || !r.pt3_calculation_complete
  )

  return (
    <div className='space-y-6'>
      {/* Console / Filter Bar */}
      <DataCard className='overflow-hidden border-border/70 shadow-[var(--shadow-soft)] dark:border-border/90'>
        <DataCardContent className='p-4'>
          <div className='flex flex-wrap items-end gap-4'>
            <div className='w-48'>
              <label className='mb-1 block text-xs font-medium text-muted-foreground'>项目</label>
              <ProjectSelect
                value={projectId}
                onChange={setProjectId}
                placeholder='选择项目'
                autoSelectFirst={false}
              />
            </div>
            <div className='w-36'>
              <label className='mb-1 block text-xs font-medium text-muted-foreground'>站点</label>
              <CountrySelect value={country} onChange={setCountry} />
            </div>
            <div className='w-44'>
              <label className='mb-1 block text-xs font-medium text-muted-foreground'>月份</label>
              <MonthNavigation
                value={selectedMonth}
                onChange={setSelectedMonth}
                showCurrentMonth={true}
              />
            </div>
            <Button
              variant='outline'
              size='sm'
              onClick={() => {
                fetchAvailableReports()
                fetchHistory()
              }}
              disabled={loading}
            >
              <RefreshCw className={cn('mr-1 h-4 w-4', loading && 'animate-spin')} />
              刷新
            </Button>
          </div>
        </DataCardContent>
      </DataCard>

      {/* Available Reports Table */}
      {projectId && (
        <>
          <div className='flex items-center justify-between'>
            <h2 className='text-lg font-semibold'>可核对月报</h2>
            <span className='text-sm text-muted-foreground'>
              共 {availableReports.length} 条记录
              {canReconcileReports.length > 0 && (
                <span className='ml-2 text-emerald-600'>
                  ({canReconcileReports.length} 条可核对)
                </span>
              )}
            </span>
          </div>

          <DataCard className='overflow-hidden border-border/70 shadow-[var(--shadow-soft)] dark:border-border/90'>
            {availableReports.length > 0 ? (
              <div className='overflow-x-auto'>
                <table className='w-full border-collapse'>
                  <thead>
                    <tr className='border-b bg-[hsl(var(--surface-subtle))] text-xs font-medium uppercase tracking-wider text-muted-foreground'>
                      <th className='px-4 py-3 text-left'>项目</th>
                      <th className='px-4 py-3 text-left'>站点</th>
                      <th className='px-4 py-3 text-left'>月份</th>
                      <th className='px-4 py-3 text-center'>PDF</th>
                      <th className='px-4 py-3 text-center'>核算</th>
                      <th className='px-4 py-3 text-left'>状态</th>
                      <th className='px-4 py-3 text-left'>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {availableReports.map((report) => (
                      <ReportRow
                        key={report.report_id}
                        report={report}
                        onReconcile={handleReconcile}
                        reconciling={reconciling && currentReconcileId === report.report_id}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <DataCardContent className='p-8 text-center text-muted-foreground'>
                <FileText className='mx-auto h-12 w-12 opacity-50' />
                <p className='mt-4'>暂无月报数据</p>
              </DataCardContent>
            )}
          </DataCard>

          {/* Cannot reconcile reports info */}
          {cannotReconcileReports.length > 0 && (
            <div className='rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800/50 dark:bg-amber-900/20'>
              <div className='flex items-center gap-2 text-amber-700 dark:text-amber-300'>
                <AlertCircle className='h-5 w-5' />
                <span className='font-medium'>无法自动核对的月报</span>
              </div>
              <ul className='mt-2 space-y-1 text-sm text-amber-700 dark:text-amber-400'>
                {!cannotReconcileReports.every((r) => r.has_summary_pdf) && (
                  <li>• PDF 未上传：需要先在月报上传页面补充 PDF</li>
                )}
                {!cannotReconcileReports.every((r) => r.pt3_calculation_complete) && (
                  <li>• 核算未完成：请先完成月度报表计算</li>
                )}
              </ul>
            </div>
          )}
        </>
      )}

      {/* Reconciliation Results */}
      {reconcileResults.size > 0 && (
        <>
          <h2 className='text-lg font-semibold'>核对结果</h2>
          <div className='space-y-4'>
            {Array.from(reconcileResults.entries()).map(([reportId, result]) => {
              const report = availableReports.find((r) => r.report_id === reportId)
              if (!report) return null
              return (
                <ReconcileDetailPanel
                  key={reportId}
                  result={result}
                  projectName={report.project_name}
                  reportMonth={report.report_month}
                  country={report.country}
                />
              )
            })}
          </div>
        </>
      )}

      {/* Overview Table */}
      {projectId && historyRecords.length > 0 && (
        <>
          <h2 className='text-lg font-semibold'>核对汇总</h2>
          <DataCard className='overflow-hidden border-border/70 shadow-[var(--shadow-soft)] dark:border-border/90'>
            <DataCardHeader title={`历史核对记录 (${historyRecords.length})`} />
            <DataCardContent className='p-0'>
              <OverviewTable records={historyRecords} />
            </DataCardContent>
          </DataCard>
        </>
      )}

      {/* Empty state */}
      {projectId && availableReports.length === 0 && !loading && (
        <div className='rounded-lg border border-dashed p-8 text-center'>
          <FileText className='mx-auto h-12 w-12 text-muted-foreground/50' />
          <p className='mt-4 text-muted-foreground'>
            当前筛选条件下没有月报数据
          </p>
        </div>
      )}
    </div>
  )
}
