'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowDown, ArrowUp, CheckCircle2, Download, Loader2, XCircle } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { cn } from '@/lib/utils'

type CountryOption = 'US' | 'DE' | 'UK'

type ProjectOption = {
  id?: number
  name: string
}

type CheckState = 'idle' | 'checking' | 'done' | 'error'
type RunState = 'idle' | 'running' | 'done' | 'error'

type PaymentPeriodOverlap = {
  period_start_date: string
  period_end_date: string
  source_id: number
}

type DataAvailability = {
  business_report_missing: string[]
  ad_report_missing: string[]
  inventory_missing: string[]
  payment_periods_overlapping: PaymentPeriodOverlap[]
  payment_full_period_covered: boolean
  payment_daily_covered_dates: string[]
  has_minimum_data: boolean
}

type CalculationPeriod = {
  report_start_date: string
  report_end_date: string
  summary: Record<string, unknown>
  details: Record<string, unknown>[]
}

type CalculationRunResponse = {
  project_id: number
  project_name: string
  country: string
  total_periods: number
  periods: CalculationPeriod[]
}

const API_BASE = '/api/backend'
const COUNTRY_OPTIONS: Array<{ value: CountryOption; label: string }> = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
]

function toDateInputValue(date: Date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

const REPORT_ROWS = [
  { key: 'business_report', label: '业务报告', getMissing: (a: DataAvailability) => a.business_report_missing },
  { key: 'ad_report', label: '广告报告', getMissing: (a: DataAvailability) => a.ad_report_missing },
  { key: 'inventory', label: '库存报告', getMissing: (a: DataAvailability) => a.inventory_missing },
] as const

function parseDateStr(s: string) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

function formatDayAbbr(dateStr: string) {
  const d = parseDateStr(dateStr)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function buildWeekDates(startDate: string, endDate: string): string[] {
  const start = parseDateStr(startDate)
  const end = parseDateStr(endDate)
  const dates: string[] = []
  const cur = new Date(start)
  while (cur <= end) {
    dates.push(toDateInputValue(cur))
    cur.setDate(cur.getDate() + 1)
  }
  return dates
}

interface AvailabilityGridProps {
  startDate: string
  endDate: string
  availability: DataAvailability
}

function AvailabilityGrid({ startDate, endDate, availability }: AvailabilityGridProps) {
  const dates = useMemo(() => buildWeekDates(startDate, endDate), [startDate, endDate])
  const missingSet = useMemo(() => ({
    business_report: new Set(availability.business_report_missing),
    ad_report: new Set(availability.ad_report_missing),
    inventory: new Set(availability.inventory_missing),
  }), [availability])
  const paymentDailyCoveredSet = useMemo(
    () => new Set(availability.payment_daily_covered_dates),
    [availability.payment_daily_covered_dates],
  )

  return (
    <div className="overflow-x-auto">
      <div
        className="grid min-w-[480px]"
        style={{ gridTemplateColumns: `120px repeat(${dates.length}, 1fr)` }}
      >
        {/* Header row */}
        <div className="flex items-center border border-b-0 border-border/60 bg-[hsl(var(--surface-subtle))] px-2 py-2 text-xs font-semibold text-muted-foreground">
          报表类型
        </div>
        {dates.map((d) => {
          const weekdayIdx = (parseDateStr(d).getDay() + 6) % 7 // Mon=0
          return (
            <div
              key={d}
              className="flex flex-col items-center justify-center border border-b-0 border-border/60 bg-[hsl(var(--surface-subtle))] px-1 py-2 text-xs"
            >
              <span className="text-[10px] text-muted-foreground">{WEEKDAY_LABELS[weekdayIdx]}</span>
              <span className="font-medium">{formatDayAbbr(d)}</span>
            </div>
          )
        })}

        {/* Data rows */}
        {REPORT_ROWS.map((row) => {
          const missing = missingSet[row.key]
          return (
            <React.Fragment key={row.key}>
              <div className="flex items-center border border-t-0 border-border/60 bg-[hsl(var(--surface-panel))] px-2 py-2.5 text-sm font-medium">
                {row.label}
              </div>
              {dates.map((d) => {
                const isMissing = missing.has(d)
                return (
                  <div
                    key={d}
                    title={isMissing ? `${row.label} 缺少 ${d}` : `${row.label} ${d} 有数据`}
                    className={cn(
                      'flex items-center justify-center border border-t-0 border-border/60 py-2.5 transition-colors',
                      isMissing ? 'bg-rose-500' : 'bg-emerald-500',
                    )}
                  >
                    {isMissing ? (
                      <XCircle className="h-4 w-4 text-white" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 text-white" />
                    )}
                  </div>
                )
              })}
            </React.Fragment>
          )
        })}

        {/* Payment report row */}
        <div className="flex items-center border border-t-0 border-border/60 bg-[hsl(var(--surface-panel))] px-2 py-2.5 text-sm font-medium">
          付款报告
        </div>
        {availability.payment_full_period_covered ? (
          <div
            style={{ gridColumn: `span ${dates.length} / span ${dates.length}` }}
            className="flex items-center justify-center gap-1.5 border border-t-0 border-border/60 bg-emerald-500 py-2.5 text-sm font-medium text-white"
            title={availability.payment_periods_overlapping.length > 0 ? `全周期数据覆盖（${availability.payment_periods_overlapping.length} 个重叠周期）` : '全周期数据覆盖'}
          >
            <CheckCircle2 className="h-4 w-4" />
            <span>全周期数据覆盖</span>
          </div>
        ) : dates.map((d) => {
          const isCovered = paymentDailyCoveredSet.has(d)
          return (
            <div
              key={d}
              title={isCovered ? `付款报告 ${d} 有单日数据` : `付款报告 缺少 ${d}`}
              className={cn(
                'flex items-center justify-center border border-t-0 border-border/60 py-2.5 transition-colors',
                isCovered ? 'bg-emerald-500' : 'bg-rose-500',
              )}
            >
              {isCovered ? (
                <CheckCircle2 className="h-4 w-4 text-white" />
              ) : (
                <XCircle className="h-4 w-4 text-white" />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function getLastWeekRange() {
  const now = new Date()
  const day = now.getDay()
  const distanceToCurrentMonday = day === 0 ? 6 : day - 1
  const currentMonday = new Date(now)
  currentMonday.setDate(now.getDate() - distanceToCurrentMonday)
  const lastWeekMonday = new Date(currentMonday)
  lastWeekMonday.setDate(currentMonday.getDate() - 7)
  const lastWeekSunday = new Date(lastWeekMonday)
  lastWeekSunday.setDate(lastWeekMonday.getDate() + 6)
  return {
    start: toDateInputValue(lastWeekMonday),
    end: toDateInputValue(lastWeekSunday),
  }
}

function formatNumber(value: unknown, fractionDigits = 2): string {
  if (value === null || value === undefined) return '-'
  const num = Number(value)
  if (isNaN(num)) return String(value)
  return num.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })
}

function formatPercent(value: unknown): string {
  if (value === null || value === undefined) return '-'
  const num = Number(value)
  if (isNaN(num)) return String(value)
  return `${(num * 100).toFixed(1)}%`
}

const SUMMARY_DISPLAY_COLUMNS = [
  { key: '总销售额', label: '总销售额' },
  { key: '总销量', label: '总销量' },
  { key: '实际销售额', label: '实际销售额' },
  { key: '利润', label: '利润' },
  { key: '利润率', label: '利润率', fmt: 'percent' as const },
  { key: '广告花费', label: '广告花费' },
  { key: 'ACOS', label: 'ACOS', fmt: 'percent' as const },
  { key: 'CPC', label: 'CPC' },
  { key: '页面浏览量', label: '页面浏览量' },
  { key: '总访客', label: '总访客' },
  { key: '总转化', label: '总转化', fmt: 'percent' as const },
]

const DETAIL_DISPLAY_COLUMNS = [
  { key: 'SKU', label: 'SKU' },
  { key: 'ASIN', label: 'ASIN' },
  { key: '总销量', label: '总销量' },
  { key: '总销售额', label: '总销售额' },
  { key: '广告花费', label: '广告花费' },
  { key: '广告销售额', label: '广告销售额' },
  { key: 'ACOS', label: 'ACOS', fmt: 'percent' as const },
  { key: '利润', label: '利润' },
  { key: '利润率', label: '利润率', fmt: 'percent' as const },
]

interface ProductCalculationPanelProps {
  session: ReturnType<typeof useSession>['data']
}

export default function ProductCalculationPanel({ session }: ProductCalculationPanelProps) {
  const isAdmin = Boolean(session?.user?.isAdmin)
  const currentOperator = (
    session?.user?.operatorNameZh ||
    session?.user?.name ||
    session?.user?.email ||
    session?.user?.id ||
    ''
  ).trim()

  const initialDateRange = getLastWeekRange()

  // Projects
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)

  // Filters
  const [selectedProjectName, setSelectedProjectName] = useState('')
  const [country, setCountry] = useState<CountryOption>('US')
  const [startDate, setStartDate] = useState(initialDateRange.start)
  const [endDate, setEndDate] = useState(initialDateRange.end)

  // Check
  const [checkState, setCheckState] = useState<CheckState>('idle')
  const [availability, setAvailability] = useState<DataAvailability | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)

  // Run
  const [runState, setRunState] = useState<RunState>('idle')
  const [periods, setPeriods] = useState<CalculationPeriod[]>([])
  const [runError, setRunError] = useState<string | null>(null)

  // UI
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      setProjectLoadError(null)
      try {
        const data = await fetchManagedProjectsCached<ProjectOption[]>(session)
        setProjects(data as ProjectOption[])
      } catch (error) {
        setProjectLoadError(normalizeErrorMessage(error, '项目列表加载失败'))
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [session])

  const selectedProject = useMemo(
    () => projects.find((p) => p.name === selectedProjectName),
    [projects, selectedProjectName],
  )

  const dateRangeValid = !!startDate && !!endDate && startDate <= endDate
  const canCheck =
    Boolean(selectedProject?.id) && dateRangeValid && checkState !== 'checking'

  const isLastWeekRange =
    startDate === initialDateRange.start && endDate === initialDateRange.end

  const authHeaders: Record<string, string> = {}
  if (isAdmin) authHeaders['X-Is-Admin'] = 'true'

  async function handleCheck() {
    if (!selectedProject?.id) return
    setCheckState('checking')
    setCheckError(null)
    setAvailability(null)
    setRunState('idle')
    setPeriods([])
    setExpandedIndex(null)

    try {
      const res = await fetch(`${API_BASE}/api/v1/product-analysis/calculation/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          project_id: selectedProject.id,
          country,
          start_date: startDate,
          end_date: endDate,
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: '检查数据失败' }))
        throw new Error(typeof err.detail === 'string' ? err.detail : '检查数据失败')
      }

      const data: DataAvailability = await res.json()
      setAvailability(data)
      setCheckState('done')
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : '检查数据失败')
      setCheckState('error')
    }
  }

  async function handleRun() {
    if (!selectedProject?.id) return
    setRunState('running')
    setRunError(null)
    setPeriods([])
    setExpandedIndex(null)

    try {
      const res = await fetch(`${API_BASE}/api/v1/product-analysis/calculation/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          project_id: selectedProject.id,
          country,
          start_date: startDate,
          end_date: endDate,
          current_only: true,
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: '执行核算失败' }))
        throw new Error(typeof err.detail === 'string' ? err.detail : '执行核算失败')
      }

      const data: CalculationRunResponse = await res.json()
      setPeriods(data.periods || [])
      setRunState('done')
    } catch (err) {
      setRunError(err instanceof Error ? err.message : '执行核算失败')
      setRunState('error')
    }
  }

  async function handleExport() {
    if (periods.length === 0) return

    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()

    const ws = wb.addWorksheet('产品核算')

    const headers = [
      '日期', 'SKU', 'ASIN',
      '总销量', '总销售额', '实际销售额',
      '广告花费', '广告销售额', 'ACOS',
      '利润', '利润率',
    ]
    ws.addRow(headers)
    ws.getRow(1).font = { bold: true }

    for (const period of periods) {
      const periodLabel = `${period.report_start_date} ~ ${period.report_end_date}`
      const sepRow = ws.addRow([`周期: ${periodLabel}`, '', '', '', '', '', '', '', '', '', ''])
      sepRow.font = { bold: true, color: { argb: 'FF0F766E' } }

      for (const detail of period.details) {
        const row = headers.map((h) => {
          if (h === '日期') return period.report_end_date
          if (h === 'SKU') return detail['SKU'] ?? ''
          if (h === 'ASIN') return detail['ASIN'] ?? ''
          const val = detail[h]
          if (val === null || val === undefined) return ''
          if (['ACOS', '利润率', '总转化'].includes(h)) return Number(val)
          return Number(val) || val
        })
        ws.addRow(row)
      }

      const summaryRow = headers.map((h) => {
        if (h === '日期') return period.report_end_date
        if (h === 'SKU') return '汇总'
        if (h === 'ASIN') return '汇总'
        const val = period.summary[h]
        if (val === null || val === undefined) return ''
        if (['ACOS', '利润率', '总转化'].includes(h)) return Number(val)
        return Number(val) || val
      })
      const summaryExcelRow = ws.addRow(summaryRow)
      summaryExcelRow.font = { bold: true }
      summaryExcelRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDF4' } }

      ws.addRow([''])
    }

    // Auto-size columns by header length
    ws.columns.forEach((_col, idx) => {
      ws.getColumn(idx + 1).width = Math.max(...headers.map((h) => h.length + 2), 12)
    })

    const buffer = await wb.xlsx.writeBuffer()
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `产品核算-${selectedProjectName}-${country}-${startDate}~${endDate}.xlsx`
    link.click()
    URL.revokeObjectURL(url)
  }

  function renderCell(value: unknown, fmt?: 'percent') {
    if (value === null || value === undefined) return <span className="text-muted-foreground">-</span>
    if (fmt === 'percent') return <span>{formatPercent(value)}</span>
    return <span>{formatNumber(value)}</span>
  }

  const detailColCount = DETAIL_DISPLAY_COLUMNS.length

  return (
    <div className="space-y-4">
      {/* Filter Controls */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">核算参数</CardTitle>
          <CardDescription className="text-xs">
            选择项目、站点和日期范围，系统将检查数据完整性后执行核算。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            {/* Project */}
            <div className="space-y-1.5">
              <label className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                项目
              </label>
              <select
                className="flex h-10 w-full rounded-md border border-[hsl(var(--input))] bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={selectedProjectName}
                onChange={(e) => {
                  setSelectedProjectName(e.target.value)
                  setCheckState('idle')
                  setAvailability(null)
                  setRunState('idle')
                  setPeriods([])
                  setExpandedIndex(null)
                }}
              >
                <option value="">请选择项目</option>
                {projectsLoading ? (
                  <option value="" disabled>加载中…</option>
                ) : projectLoadError ? (
                  <option value="" disabled>{projectLoadError}</option>
                ) : (
                  projects.map((p) => (
                    <option key={p.name} value={p.name}>{p.name}</option>
                  ))
                )}
              </select>
            </div>

            {/* Country */}
            <div className="space-y-1.5">
              <label className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                站点
              </label>
              <select
                className="flex h-10 w-full rounded-md border border-[hsl(var(--input))] bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={country}
                onChange={(e) => {
                  setCountry(e.target.value as CountryOption)
                  setCheckState('idle')
                  setAvailability(null)
                  setRunState('idle')
                  setPeriods([])
                }}
              >
                {COUNTRY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Start Date */}
            <div className="space-y-1.5">
              <label className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                开始日期
              </label>
              <input
                type="date"
                className="flex h-10 w-full rounded-md border border-[hsl(var(--input))] bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value)
                  setCheckState('idle')
                  setAvailability(null)
                  setRunState('idle')
                  setPeriods([])
                }}
              />
            </div>

            {/* End Date */}
            <div className="space-y-1.5">
              <label className="text-[0.72rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                结束日期
              </label>
              <input
                type="date"
                className="flex h-10 w-full rounded-md border border-[hsl(var(--input))] bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value)
                  setCheckState('idle')
                  setAvailability(null)
                  setRunState('idle')
                  setPeriods([])
                }}
              />
            </div>
          </div>

          {/* Buttons */}
          <div className="flex items-center gap-3">
            <button
              className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                isLastWeekRange
                  ? 'border-blue-400 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-200'
                  : 'border-[hsl(var(--border))] text-muted-foreground hover:border-blue-400'
              }`}
              onClick={() => {
                setStartDate(initialDateRange.start)
                setEndDate(initialDateRange.end)
                setCheckState('idle')
                setAvailability(null)
                setRunState('idle')
                setPeriods([])
              }}
            >
              上周
            </button>

            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleCheck()}
              disabled={!canCheck}
            >
              {checkState === 'checking' ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-1 h-4 w-4" />
              )}
              检查数据
            </Button>

            <Button
              size="sm"
              onClick={() => void handleRun()}
              disabled={
                checkState !== 'done' ||
                !availability ||
                !availability.has_minimum_data ||
                runState === 'running'
              }
            >
              {runState === 'running' ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : null}
              执行核算
            </Button>
          </div>

          {checkError && (
            <div className="flex items-center gap-2 rounded-md border border-rose-300/60 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/20 dark:text-rose-200">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {checkError}
            </div>
          )}

          {runError && (
            <div className="flex items-center gap-2 rounded-md border border-rose-300/60 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/20 dark:text-rose-200">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {runError}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Data Availability */}
      {availability && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">数据可用性</CardTitle>
            <CardDescription className="text-xs">
              {startDate} — {endDate}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Grid table */}
            <AvailabilityGrid
              startDate={startDate}
              endDate={endDate}
              availability={availability}
            />

            {/* Minimum Data Summary */}
            <div className="flex items-center gap-2 border-t border-[hsl(var(--border))] pt-2.5">
              {availability.has_minimum_data ? (
                <div className="flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-300">
                  <CheckCircle2 className="h-4 w-4" />
                  可执行核算
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-sm font-medium text-rose-600 dark:text-rose-300">
                  <XCircle className="h-4 w-4" />
                  数据不足，无法执行核算（缺少核心报表数据）
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {runState === 'done' && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">核算结果</CardTitle>
                <CardDescription className="text-xs">
                  共 {periods.length} 个周期
                </CardDescription>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleExport()}
                disabled={periods.length === 0}
              >
                <Download className="mr-1 h-4 w-4" />
                导出 Excel
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {periods.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                无核算数据
              </div>
            ) : (
              <div className="space-y-3">
                {periods.map((period, idx) => {
                  const isExpanded = expandedIndex === idx
                  return (
                    <div key={idx} className="space-y-1">
                      {/* Summary row */}
                      <div
                        className={`flex items-center gap-2 rounded-md border px-3 py-2 cursor-pointer transition-colors ${
                          isExpanded
                            ? 'border-blue-300 bg-blue-50 dark:bg-blue-950/30'
                            : 'hover:bg-muted/30'
                        }`}
                        onClick={() => setExpandedIndex(isExpanded ? null : idx)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            setExpandedIndex(isExpanded ? null : idx)
                          }
                        }}
                      >
                        <button
                          className="rounded p-0.5 hover:bg-accent shrink-0"
                          onClick={(e) => {
                            e.stopPropagation()
                            setExpandedIndex(isExpanded ? null : idx)
                          }}
                          title={isExpanded ? '收起明细' : '展开明细'}
                        >
                          {isExpanded ? (
                            <ArrowUp className="h-4 w-4" />
                          ) : (
                            <ArrowDown className="h-4 w-4" />
                          )}
                        </button>

                        <span className="shrink-0 font-medium text-sm">
                          {period.report_start_date} ~ {period.report_end_date}
                        </span>

                        <span className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
                          <span>总销售额: {renderCell(period.summary['总销售额'])}</span>
                          <span>利润: {renderCell(period.summary['利润'])}</span>
                          <span>利润率: {renderCell(period.summary['利润率'], 'percent')}</span>
                          <span>ACOS: {renderCell(period.summary['ACOS'], 'percent')}</span>
                        </span>
                      </div>

                      {/* Detail table */}
                      {isExpanded && (
                        <div className="overflow-x-auto rounded-md border">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b bg-muted/50">
                                {DETAIL_DISPLAY_COLUMNS.map((col) => (
                                  <th
                                    key={col.key}
                                    className="px-3 py-2 text-right font-semibold whitespace-nowrap"
                                  >
                                    {col.label}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {period.details.length === 0 ? (
                                <tr>
                                  <td
                                    colSpan={detailColCount}
                                    className="px-3 py-4 text-center text-muted-foreground"
                                  >
                                    无 SKU 明细
                                  </td>
                                </tr>
                              ) : (
                                period.details.map((detail, dIdx) => (
                                  <tr
                                    key={dIdx}
                                    className="border-b border-[hsl(var(--border))] hover:bg-muted/20"
                                  >
                                    {DETAIL_DISPLAY_COLUMNS.map((col) => (
                                      <td
                                        key={col.key}
                                        className="px-3 py-1.5 text-right whitespace-nowrap"
                                      >
                                        {renderCell(detail[col.key], col.fmt)}
                                      </td>
                                    ))}
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
