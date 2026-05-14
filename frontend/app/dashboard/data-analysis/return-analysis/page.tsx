'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { DateRange } from 'react-day-picker'
import {
  Download,
  Loader2,
  RefreshCcw,
} from 'lucide-react'
import { useSession } from 'next-auth/react'
import { Bar, CartesianGrid, Cell, ComposedChart, Line, PieChart, XAxis, YAxis } from 'recharts'
import type { Worksheet } from 'exceljs'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { DataCard, DataCardContent, DataCardHeader } from '@/components/ui/data-card'
import { DataTableCard, DataTableCardHeader, DataTableCardBody } from '@/components/ui/data-card'
import { DateRangePicker } from '@/components/ui/date-picker'
import { EmptyTableState } from '@/components/ui/empty-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { DirectionalTabTransition, SlidingTabsTrigger, TabsMotionGroup } from '@/components/ui/tab-motion'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, ColGroup } from '@/components/ui/table'
import { TableSkeletonRows } from '@/components/ui/table-skeleton'
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useNotifications } from '@/components/notifications'
import { applyBorder, applyHeaderBorder } from '@/lib/excel-styles'
import { useSmoothRefresh } from '@/hooks/use-smooth-refresh'
import { RefreshProgressBar } from '@/components/ui/refresh-progress-bar'
import {
  CountrySelect,
  FilterField,
  RefreshButton,
} from '@/components/dashboard/console'

const API_BASE = '/api/backend/api/v1'

type CountryOption = 'US' | 'DE' | 'UK'
type ViewTab = 'rankings' | 'reason' | 'trend' | 'product-status' | 'inventory-status' | 'feedback' | 'summary'
const VIEW_TAB_ORDER: ViewTab[] = [
  'rankings',
  'reason',
  'trend',
  'product-status',
  'inventory-status',
  'feedback',
  'summary',
]

type ProjectOption = {
  id: number
  name: string
}

// Translation helpers
const RETURN_REASON_LABELS: Record<string, string> = {
  APPAREL_TOO_LARGE: '服装过大',
  APPAREL_TOO_SMALL: '服装过小',
  QUALITY_UNACCEPTABLE: '质量不合格',
  DID_NOT_LIKE_FABRIC: '不喜欢面料',
  NOT_AS_DESCRIBED: '与描述不符',
  APPAREL_STYLE: '款式问题',
  DEFECTIVE: '有缺陷',
  UNDELIVERABLE_UNKNOWN: '无法投递',
  NEVER_ARRIVED: '未收到',
  UNWANTED_ITEM: '不需要',
  CHANGED_MIND: '改变主意',
  WRONG_ITEM: '错发商品',
  LATE_ARRIVAL: '到货延迟',
  OTHER: '其他',
}

// Reserved for future use - disposition/status translations
// const DETAILED_DISPOSITION_LABELS: Record<string, string> = { ... }
// const RETURN_STATUS_LABELS: Record<string, string> = { ... }

function translateReason(value: string): string {
  return RETURN_REASON_LABELS[value] || value
}

const COUNTRY_TIMEZONE_MAP: Record<string, string> = {
  US: 'America/Los_Angeles',
  DE: 'Europe/Berlin',
  UK: 'Europe/London',
}

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

const TAB_LABELS: Record<ViewTab, string> = {
  rankings: '高退货排行',
  reason: '退货原因',
  trend: '退货趋势',
  'product-status': '商品状态',
  'inventory-status': '库存状态',
  feedback: '顾客反馈',
  summary: 'AI 总结',
}

const REASON_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
]

export default function ReturnAnalysisPage() {
  const { notify } = useNotifications()
  const { data: session } = useSession()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectId, setProjectId] = useState('')
  const [country, setCountry] = useState<CountryOption>('US')
  const defaultRange = useMemo(() => lastSevenDaysRange(country), [country])
  const [dateRange, setDateRange] = useState<DateRange | undefined>(defaultRange)
  const [activeTab, setActiveTab] = useState<ViewTab>('rankings')

  const [data, setData] = useState<ReturnAnalysisResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)

  const { showSkeleton, isRefreshing } = useSmoothRefresh({ loading, hasData: !!data })

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      try {
        const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
        setProjects(payload.filter((item) => item.id !== null))
        if (payload.length > 0 && payload[0].id !== null) {
          setProjectId(String(payload[0].id))
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

  const loadData = useCallback(async () => {
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

    setLoading(true)
    try {
      const search = new URLSearchParams({
        project_id: projectId,
        country,
        start_date: startDate,
        end_date: endDate,
      })
      const response = await fetch(`${API_BASE}/return-analysis?${search.toString()}`, {
        headers: {},
        cache: 'no-store',
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.detail || '退货数据加载失败')
      }
      const payload = (await response.json()) as ReturnAnalysisResponse
      setData(payload)
    } catch (fetchError) {
      notify({
        type: 'error',
        title: '退货数据加载失败',
        message: fetchError instanceof Error ? fetchError.message : '退货数据加载失败',
      })
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [projectId, country, dateRange, notify])

  const handleExportExcel = useCallback(async () => {
    if (!data) return
    setExporting(true)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'BelieveBoy Dashboard'
      workbook.created = new Date()

      const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false })
      const sheetMeta = {
        project: data.project_name,
        country: data.country,
        start: data.start_date,
        end: data.end_date,
      }

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

      const addTitleAndMeta = (
        ws: Worksheet,
        title: string,
        rowCount: number,
        colCount: number,
      ) => {
        ws.mergeCells(1, 1, 1, colCount)
        ws.getCell(1, 1).value = title
        ws.getCell(1, 1).font = {
          name: 'Microsoft YaHei',
          size: 14,
          bold: true,
          color: { argb: 'FF0F172A' },
        }
        ws.getCell(1, 1).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE2E8F0' },
        }
        ws.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'left' }
        ws.mergeCells(2, 1, 2, colCount)
        ws.getCell(2, 1).value =
          `项目：${sheetMeta.project} | 站点：${sheetMeta.country} | 时间：${sheetMeta.start} ~ ${sheetMeta.end} | 导出时间：${exportedAt} | 共 ${rowCount} 条`
        ws.getCell(2, 1).font = {
          name: 'Microsoft YaHei',
          size: 10,
          color: { argb: 'FF475569' },
        }
        ws.getCell(2, 1).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF8FAFC' },
        }
        ws.getCell(2, 1).alignment = { vertical: 'middle', horizontal: 'left' }
      }

      // ── Sheet 1: 退货排行 ──
      {
        const ws = workbook.addWorksheet('退货排行')
        const headers = ['SKU', 'ASIN', '产品名称', '退货数量', '退货单数', '销售数量', '退货率(%)']
        ws.columns = [
          { width: 18 }, { width: 16 }, { width: 30 },
          { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 },
        ]
        addTitleAndMeta(ws, '退货排行', data.ranking_rows.length, headers.length)
        const headerRow = ws.addRow(headers)
        headerRow.height = 22
        styleHeaderRow(ws, 3)

        data.ranking_rows.forEach((row) => {
          const r = ws.addRow([
            row.sku,
            row.asin ?? '',
            row.product_name ?? '',
            row.total_quantity,
            row.return_count,
            row.sales_quantity,
            row.sales_quantity > 0 ? parseFloat(row.return_rate.toFixed(2)) : null,
          ])
          r.font = { name: 'Microsoft YaHei' }
          r.eachCell((cell) => { applyBorder(cell) })
        })

        // freeze title+meta rows
        ws.views = [{ state: 'frozen', ySplit: 3, showGridLines: false }]
      }

      // ── Sheet 2: 退货原因 ──
      {
        const ws = workbook.addWorksheet('退货原因')
        const headers = ['退货原因', '退货数量', '退货单数', '占比(%)']
        ws.columns = [
          { width: 22 }, { width: 14 }, { width: 14 }, { width: 12 },
        ]
        addTitleAndMeta(ws, '退货原因分析', data.reason_rows.length, headers.length)
        const headerRow = ws.addRow(headers)
        headerRow.height = 22
        styleHeaderRow(ws, 3)

        data.reason_rows.forEach((row) => {
          const r = ws.addRow([
            row.reason_display,
            row.total_quantity,
            row.return_count,
            parseFloat(row.percentage.toFixed(2)),
          ])
          r.font = { name: 'Microsoft YaHei' }
          r.eachCell((cell) => { applyBorder(cell) })
        })

        ws.views = [{ state: 'frozen', ySplit: 3, showGridLines: false }]
      }

      // ── Sheet 3: 商品状态 ──
      {
        const ws = workbook.addWorksheet('商品状态')
        const headers = ['商品状态', '数量', '退货单数', '占比(%)']
        ws.columns = [
          { width: 22 }, { width: 14 }, { width: 14 }, { width: 12 },
        ]
        addTitleAndMeta(ws, '商品状态分布', data.disposition_rows.length, headers.length)
        const headerRow = ws.addRow(headers)
        headerRow.height = 22
        styleHeaderRow(ws, 3)

        data.disposition_rows.forEach((row) => {
          const r = ws.addRow([
            row.disposition_display,
            row.total_quantity,
            row.return_count,
            parseFloat(row.percentage.toFixed(2)),
          ])
          r.font = { name: 'Microsoft YaHei' }
          r.eachCell((cell) => { applyBorder(cell) })
        })

        ws.views = [{ state: 'frozen', ySplit: 3, showGridLines: false }]
      }

      // ── Sheet 4: 库存状态 ──
      {
        const ws = workbook.addWorksheet('库存状态')
        const headers = ['库存状态', '数量', '退货单数', '占比(%)']
        ws.columns = [
          { width: 22 }, { width: 14 }, { width: 14 }, { width: 12 },
        ]
        addTitleAndMeta(ws, '库存状态分布', data.status_rows.length, headers.length)
        const headerRow = ws.addRow(headers)
        headerRow.height = 22
        styleHeaderRow(ws, 3)

        data.status_rows.forEach((row) => {
          const r = ws.addRow([
            row.status_display,
            row.total_quantity,
            row.return_count,
            parseFloat(row.percentage.toFixed(2)),
          ])
          r.font = { name: 'Microsoft YaHei' }
          r.eachCell((cell) => { applyBorder(cell) })
        })

        ws.views = [{ state: 'frozen', ySplit: 3, showGridLines: false }]
      }

      // ── Sheet 5: 顾客反馈 ──
      {
        const ws = workbook.addWorksheet('顾客反馈')
        const headers = ['日期', 'SKU', '订单号', '退货原因', '顾客评论']
        ws.columns = [
          { width: 14 }, { width: 18 }, { width: 22 }, { width: 18 }, { width: 60 },
        ]
        addTitleAndMeta(ws, '顾客反馈列表', data.feedback_rows.length, headers.length)
        const headerRow = ws.addRow(headers)
        headerRow.height = 22
        styleHeaderRow(ws, 3)

        data.feedback_rows.forEach((row) => {
          const r = ws.addRow([
            row.return_date,
            row.sku,
            row.order_id,
            row.reason_display,
            row.customer_comment,
          ])
          r.font = { name: 'Microsoft YaHei' }
          r.eachCell((cell) => { applyBorder(cell) })
        })

        ws.views = [{ state: 'frozen', ySplit: 3, showGridLines: false }]
      }

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const safeDateRange = `${data.start_date}_${data.end_date}`
      link.href = url
      link.download = `退货分析-${data.project_name}-${data.country}-${safeDateRange}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)

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
  }, [data, notify])

  useEffect(() => {
    if (!projectId) return
    void loadData()
  }, [projectId, country, loadData])

  const chartConfig = {
    return_count: { label: '退货量', color: 'hsl(var(--chart-1))' },
    total_quantity: { label: '退货件数', color: 'hsl(var(--chart-2))' },
    percentage: { label: '占比', color: 'hsl(var(--chart-3))' },
    return_rate: { label: '退货率(%)', color: 'hsl(var(--chart-1))' },
  } satisfies ChartConfig

  return (
    <div className="flex flex-col gap-5">
      {/* Section 1: 控制台 */}
      <DataCard>
        <DataCardHeader
          title="控制台"
          titleClassName="text-2xl tracking-tight"
          badge={<p className="dashboard-kicker">退货分析控制台</p>}
        />
        <DataCardContent className="space-y-5">
          {/* 筛选区域 */}
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
            <FilterField label="项目">
              {projectsLoading ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger className="border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]">
                    <SelectValue placeholder="选择项目" />
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
            </FilterField>

            <FilterField label="国家站点">
              <CountrySelect
                value={country}
                onChange={(value) => setCountry(value as CountryOption)}
                triggerClassName="border-border/70 bg-[hsl(var(--surface-soft))] shadow-none dark:border-border/85 dark:bg-[hsl(var(--surface-overlay))]"
              />
            </FilterField>

            <FilterField label="日期范围">
              <DateRangePicker
                value={dateRange}
                onChange={setDateRange}
                className="h-10 w-[240px]"
                onApply={() => void loadData()}
              />
            </FilterField>

            <div className="flex items-end gap-2">
              {data && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleExportExcel()}
                  disabled={exporting || loading}
                  className="h-10 px-4"
                >
                  {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  导出 Excel
                </Button>
              )}
              <RefreshButton
                onClick={() => void loadData()}
                loading={loading || projectsLoading}
                label="刷新视图"
                variant="default"
                size="default"
                className="h-10 px-5"
              />
            </div>
          </div>

          {/* Summary Stats */}
          {data && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              <DataCard>
                <DataCardContent className="p-3">
                  <div className="text-xs text-muted-foreground">退货单数</div>
                  <div className="mt-1 text-xl font-semibold">{data.summary.total_returns.toLocaleString()}</div>
                </DataCardContent>
              </DataCard>
              <DataCard>
                <DataCardContent className="p-3">
                  <div className="text-xs text-muted-foreground">退货总量</div>
                  <div className="mt-1 text-xl font-semibold">{data.summary.total_quantity.toLocaleString()}</div>
                </DataCardContent>
              </DataCard>
              <DataCard>
                <DataCardContent className="p-3">
                  <div className="text-xs text-muted-foreground">销售数量</div>
                  <div className="mt-1 text-xl font-semibold">{data.summary.total_sales_quantity.toLocaleString()}</div>
                </DataCardContent>
              </DataCard>
              <DataCard>
                <DataCardContent className="p-3">
                  <div className="text-xs text-muted-foreground">整体退货率</div>
                  <div className={`mt-1 text-xl font-semibold ${data.summary.overall_return_rate > 8 ? 'text-red-500' : data.summary.overall_return_rate > 3 ? 'text-yellow-500' : 'text-green-500'}`}>
                    {data.summary.overall_return_rate.toFixed(1)}%
                  </div>
                </DataCardContent>
              </DataCard>
              <DataCard>
                <DataCardContent className="p-3">
                  <div className="text-xs text-muted-foreground">涉及SKU</div>
                  <div className="mt-1 text-xl font-semibold">{data.summary.unique_skus.toLocaleString()}</div>
                </DataCardContent>
              </DataCard>
              <DataCard>
                <DataCardContent className="p-3">
                  <div className="text-xs text-muted-foreground">Top退货原因</div>
                  <div className="mt-1 truncate text-sm font-semibold">
                    {data.summary.top_return_reason
                      ? translateReason(data.summary.top_return_reason)
                      : '--'}
                  </div>
                </DataCardContent>
              </DataCard>
              <DataCard>
                <DataCardContent className="p-3">
                  <div className="text-xs text-muted-foreground">多件退货单数</div>
                  <div className="mt-1 text-xl font-semibold">{data.multi_item_return_count.toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">
                    共{data.multi_item_return_quantity.toLocaleString()}件
                  </div>
                </DataCardContent>
              </DataCard>
            </div>
          )}
        </DataCardContent>
      </DataCard>

      {/* Section 2: Tab Bar */}
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ViewTab)} className="w-full">
        <TabsMotionGroup id="return-analysis-tabs">
          <TabsList className="grid h-auto w-full grid-cols-3 lg:grid-cols-7 border border-border/70 bg-[hsl(var(--surface-soft))]/90 p-1 dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]">
            {VIEW_TAB_ORDER.map((tab) => (
              <SlidingTabsTrigger
                key={tab}
                value={tab}
                activeValue={activeTab}
                layoutId="return-analysis-tab-indicator"
                className="py-2.5"
              >
                {TAB_LABELS[tab]}
              </SlidingTabsTrigger>
            ))}
          </TabsList>
        </TabsMotionGroup>

        {/* Section 3: Tab Content */}
        <DataTableCard className="relative mt-5 rounded-xl border border-border/70 shadow-none">
          <DataTableCardHeader className="flex flex-row items-center justify-between">
            <h3 className="text-base font-semibold">高退货排行（按SKU）</h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void loadData()}
              disabled={loading}
              className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
              刷新
            </Button>
          </DataTableCardHeader>
          <DataTableCardBody>
            <DirectionalTabTransition value={activeTab} order={VIEW_TAB_ORDER}>
              <TabsContent forceMount value={activeTab} className="m-0">
                {activeTab === 'rankings' && (
                  <Table containerClassName="bg-[hsl(var(--surface-panel))]/94" tableLayout="fixed">
                    <ColGroup columns={[
                      { width: 112 },
                      { width: 144 },
                      { width: 80 },
                      { width: 96 },
                      { width: 96 },
                      { width: 80 },
                      { width: 80 },
                    ]} />
                    <TableHeader>
                      <TableRow>
                        <TableHead>SKU</TableHead>
                        <TableHead>品名</TableHead>
                        <TableHead>ASIN</TableHead>
                        <TableHead className="text-right">退货数量</TableHead>
                        <TableHead className="text-right">退货单数</TableHead>
                        <TableHead className="text-right">销售数量</TableHead>
                        <TableHead className="text-right">退货率</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {showSkeleton ? (
                        Array.from({ length: 5 }).map((_, i) => (
                          <TableRow key={i}>
                            <TableCell><div className="h-4 w-20 animate-pulse rounded bg-muted" /></TableCell>
                            <TableCell><div className="h-4 w-28 animate-pulse rounded bg-muted" /></TableCell>
                            <TableCell><div className="h-4 w-16 animate-pulse rounded bg-muted" /></TableCell>
                            <TableCell className="text-right"><div className="ml-auto h-4 w-16 animate-pulse rounded bg-muted" /></TableCell>
                            <TableCell className="text-right"><div className="ml-auto h-4 w-12 animate-pulse rounded bg-muted" /></TableCell>
                            <TableCell className="text-right"><div className="ml-auto h-4 w-12 animate-pulse rounded bg-muted" /></TableCell>
                            <TableCell className="text-right"><div className="ml-auto h-4 w-12 animate-pulse rounded bg-muted" /></TableCell>
                          </TableRow>
                        ))
                      ) : isRefreshing ? (
                        <RefreshProgressBar refreshing={true}>
                          <TableRow><TableCell colSpan={7} /></TableRow>
                        </RefreshProgressBar>
                      ) : data?.ranking_rows.length ? (
                        data.ranking_rows.map((row) => (
                          <TableRow key={row.sku}>
                            <TableCell className="font-medium truncate">{row.sku}</TableCell>
                            <TableCell className="truncate text-muted-foreground">{row.product_name || '--'}</TableCell>
                            <TableCell className="text-muted-foreground">{row.asin || '--'}</TableCell>
                            <TableCell className="text-right font-semibold">{row.total_quantity.toLocaleString()}</TableCell>
                            <TableCell className="text-right">{row.return_count.toLocaleString()}</TableCell>
                            <TableCell className="text-right">{row.sales_quantity.toLocaleString()}</TableCell>
                            <TableCell className={`text-right font-semibold ${
                              row.return_rate > 8 ? 'text-red-500' : row.return_rate > 3 ? 'text-yellow-500' : 'text-green-500'
                            }`}>
                              {row.sales_quantity > 0 ? `${row.return_rate.toFixed(1)}%` : '--'}
                            </TableCell>
                          </TableRow>
                        ))
                      ) : (
                        <TableRow><TableCell colSpan={7} className="py-12 text-center text-muted-foreground">暂无退货排行数据</TableCell></TableRow>
                      )}
                    </TableBody>
                  </Table>
                )}

                {activeTab === 'reason' && (
                  <div className="space-y-4">
                    <h3 className="text-lg font-semibold">退货原因分析</h3>
                    <div className="grid gap-4 lg:grid-cols-2">
                      {/* Table */}
                      <Table containerClassName="bg-[hsl(var(--surface-panel))]/94">
                        <TableHeader>
                          <TableRow>
                            <TableHead>退货原因</TableHead>
                            <TableHead className="text-right">退货数量</TableHead>
                            <TableHead className="text-right">占比</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {showSkeleton ? (
                            <TableSkeletonRows
                              columns={3}
                              rows={5}
                              widths={['w-24', 'w-12 ml-auto', 'w-12 ml-auto']}
                            />
                          ) : (
                            <RefreshProgressBar refreshing={isRefreshing}>
                              {data?.reason_rows.length ? (
                                data.reason_rows.map((row) => (
                                  <TableRow key={row.reason}>
                                    <TableCell className="font-medium">{row.reason_display}</TableCell>
                                    <TableCell className="text-right">{row.total_quantity.toLocaleString()}</TableCell>
                                    <TableCell className="text-right text-muted-foreground">{row.percentage}%</TableCell>
                                  </TableRow>
                                ))
                              ) : (
                                <EmptyTableState colSpan={3} message="暂无退货原因数据" />
                              )}
                            </RefreshProgressBar>
                          )}
                        </TableBody>
                      </Table>

                      {/* Pie Chart */}
                      {data?.reason_rows && data.reason_rows.length > 0 && (
                        <div className="rounded-lg border border-border/60 bg-[hsl(var(--surface-soft))] p-4">
                          <ChartContainer config={chartConfig} className="h-[300px] w-full">
                            <PieChart>
                              <PieChart
                                data={data.reason_rows.slice(0, 5).map((r, i) => ({
                                  name: r.reason_display,
                                  value: r.return_count,
                                  fill: REASON_COLORS[i % REASON_COLORS.length],
                                }))}
                                cx="50%"
                                cy="50%"
                                outerRadius={100}
                                dataKey="value"
                              >
                                {data.reason_rows.slice(0, 5).map((_, i) => (
                                  <Cell key={i} fill={REASON_COLORS[i % REASON_COLORS.length]} />
                                ))}
                              </PieChart>
                              <ChartTooltip
                                content={<ChartTooltipContent nameKey="name" />}
                              />
                            </PieChart>
                          </ChartContainer>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {activeTab === 'trend' && (
                  <div className="space-y-4">
                    <h3 className="text-lg font-semibold">销售与退货趋势对比</h3>
                    {data?.trend_rows && data.trend_rows.length > 0 ? (
                      <div className="rounded-lg border border-border/60 bg-[hsl(var(--surface-soft))] p-4">
                        <ChartContainer config={chartConfig} className="h-[350px] w-full">
                          <ComposedChart data={data.trend_rows}>
                            <CartesianGrid vertical={false} stroke="rgba(148,163,184,0.18)" />
                            <XAxis
                              dataKey="date"
                              axisLine={false}
                              tickLine={false}
                              tickMargin={12}
                              tick={{ fontSize: 12, fill: '#71717a' }}
                              tickFormatter={(value) => {
                                const [, month, day] = String(value).split('-')
                                return `${month}/${day}`
                              }}
                            />
                            <YAxis
                              axisLine={false}
                              tickLine={false}
                              tickMargin={12}
                              tick={{ fontSize: 12, fill: '#71717a' }}
                              yAxisId="left"
                            />
                            <YAxis
                              axisLine={false}
                              tickLine={false}
                              tickMargin={12}
                              tick={{ fontSize: 12, fill: '#71717a' }}
                              yAxisId="right"
                              orientation="right"
                              tickFormatter={(value) => `${value}%`}
                            />
                            <ChartTooltip
                              content={<ChartTooltipContent nameKey="date" formatter={(value, name) => {
                                const label = chartConfig[name as keyof typeof chartConfig]?.label || name
                                return [value, label]
                              }} />}
                            />
                            <Bar
                              dataKey="sales_quantity"
                              name="sales_quantity"
                              fill="var(--color-sales_quantity)"
                              radius={[6, 6, 0, 0]}
                              barSize={20}
                              yAxisId="left"
                            />
                            <Bar
                              dataKey="return_count"
                              name="return_count"
                              fill="var(--color-return_count)"
                              radius={[6, 6, 0, 0]}
                              barSize={14}
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
                        <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1.5">
                            <span className="inline-block h-2.5 w-5 rounded-sm bg-[hsl(var(--chart-4))]" />销售数量
                          </span>
                          <span className="flex items-center gap-1.5">
                            <span className="inline-block h-2.5 w-5 rounded-sm bg-[hsl(var(--chart-1))]" />退货单数
                          </span>
                          <span className="flex items-center gap-1.5">
                            <span className="inline-block h-2.5 w-5 rounded-sm border-b-2 border-[hsl(var(--chart-1))]" />退货率（%）
                          </span>
                        </div>
                      </div>
                    ) : (
                      <EmptyTableState colSpan={1} message="暂无退货趋势数据" />
                    )}
                  </div>
                )}

                {activeTab === 'product-status' && (
                  <div className="space-y-4">
                    <h3 className="text-lg font-semibold">商品状态分布</h3>
                    <div className="grid gap-4 lg:grid-cols-2">
                      <Table containerClassName="bg-[hsl(var(--surface-panel))]/94">
                        <TableHeader>
                          <TableRow>
                            <TableHead>商品状态</TableHead>
                            <TableHead className="text-right">数量</TableHead>
                            <TableHead className="text-right">占比</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {showSkeleton ? (
                            <TableSkeletonRows
                              columns={3}
                              rows={3}
                              widths={['w-20', 'w-12 ml-auto', 'w-12 ml-auto']}
                            />
                          ) : (
                            <RefreshProgressBar refreshing={isRefreshing}>
                              {data?.disposition_rows.length ? (
                                data.disposition_rows.map((row) => (
                                  <TableRow key={row.detailed_disposition}>
                                    <TableCell className="font-medium">
                                      <Badge variant="outline" className="mr-2">
                                        {row.disposition_display}
                                      </Badge>
                                    </TableCell>
                                    <TableCell className="text-right">{row.return_count.toLocaleString()}</TableCell>
                                    <TableCell className="text-right text-muted-foreground">{row.percentage}%</TableCell>
                                  </TableRow>
                                ))
                              ) : (
                                <EmptyTableState colSpan={3} message="暂无商品状态数据" />
                              )}
                            </RefreshProgressBar>
                          )}
                        </TableBody>
                      </Table>

                      {data?.disposition_rows && data.disposition_rows.length > 0 && (
                        <div className="rounded-lg border border-border/60 bg-[hsl(var(--surface-soft))] p-4">
                          <div className="text-sm text-muted-foreground text-center py-8">
                            图表展示区域（可扩展）
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {activeTab === 'inventory-status' && (
                  <div className="space-y-4">
                    <h3 className="text-lg font-semibold">库存状态分布</h3>
                    <div className="grid gap-4 lg:grid-cols-2">
                      <Table containerClassName="bg-[hsl(var(--surface-panel))]/94">
                        <TableHeader>
                          <TableRow>
                            <TableHead>库存状态</TableHead>
                            <TableHead className="text-right">数量</TableHead>
                            <TableHead className="text-right">占比</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {showSkeleton ? (
                            <TableSkeletonRows
                              columns={3}
                              rows={3}
                              widths={['w-24', 'w-12 ml-auto', 'w-12 ml-auto']}
                            />
                          ) : (
                            <RefreshProgressBar refreshing={isRefreshing}>
                              {data?.status_rows.length ? (
                                data.status_rows.map((row) => (
                                  <TableRow key={row.status}>
                                    <TableCell className="font-medium">
                                      <Badge variant="outline" className="mr-2">
                                        {row.status_display}
                                      </Badge>
                                    </TableCell>
                                    <TableCell className="text-right">{row.return_count.toLocaleString()}</TableCell>
                                    <TableCell className="text-right text-muted-foreground">{row.percentage}%</TableCell>
                                  </TableRow>
                                ))
                              ) : (
                                <EmptyTableState colSpan={3} message="暂无库存状态数据" />
                              )}
                            </RefreshProgressBar>
                          )}
                        </TableBody>
                      </Table>

                      {data?.status_rows && data.status_rows.length > 0 && (
                        <div className="rounded-lg border border-border/60 bg-[hsl(var(--surface-soft))] p-4">
                          <div className="text-sm text-muted-foreground text-center py-8">
                            图表展示区域（可扩展）
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {activeTab === 'feedback' && (
                  <div className="space-y-4">
                    <h3 className="text-lg font-semibold">顾客反馈</h3>
                    <Table containerClassName="bg-[hsl(var(--surface-panel))]/94">
                      <TableHeader>
                        <TableRow>
                          <TableHead>日期</TableHead>
                          <TableHead>SKU</TableHead>
                          <TableHead>退货原因</TableHead>
                          <TableHead>顾客评论</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {showSkeleton ? (
                          <TableSkeletonRows
                            columns={4}
                            rows={5}
                            widths={['w-20', 'w-24', 'w-16', 'w-48']}
                          />
                        ) : (
                          <RefreshProgressBar refreshing={isRefreshing}>
                            {data?.feedback_rows.length ? (
                              data.feedback_rows.slice(0, 50).map((row, index) => (
                                <TableRow key={`${row.order_id}-${index}`}>
                                  <TableCell className="text-muted-foreground">{row.return_date}</TableCell>
                                  <TableCell className="font-medium">{row.sku}</TableCell>
                                  <TableCell>
                                    <Badge variant="outline" className="text-xs">
                                      {row.reason_display}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="max-w-[300px] truncate text-muted-foreground" title={row.customer_comment}>
                                    {row.customer_comment}
                                  </TableCell>
                                </TableRow>
                              ))
                            ) : (
                              <EmptyTableState colSpan={4} message="暂无顾客反馈数据" />
                            )}
                          </RefreshProgressBar>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                )}

                {activeTab === 'summary' && (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-lg font-semibold">退货分析总结</h3>
                      {data && (
                        <span className="text-xs text-muted-foreground">
                          {data.start_date} 至 {data.end_date}
                        </span>
                      )}
                    </div>
                    {showSkeleton ? (
                      <div className="space-y-3">
                        {Array.from({ length: 8 }).map((_, i) => (
                          <Skeleton key={i} className="h-4 w-full" />
                        ))}
                      </div>
                    ) : (
                      <RefreshProgressBar refreshing={isRefreshing}>
                        {data?.summary_text ? (
                          <div className="space-y-4">
                            {/* Text Summary */}
                            <div className="rounded-lg border border-border/60 bg-[hsl(var(--surface-soft))] p-5">
                              <div className="prose prose-sm max-w-none dark:prose-invert whitespace-pre-wrap text-sm leading-relaxed">
                                {data.summary_text.split('\n').map((line, i) => {
                                  if (!line.trim()) {
                                    return <div key={i} className="h-3" />
                                  }
                                  if (line.startsWith('📊') || line.startsWith('⚠️') || line.startsWith('🔍') ||
                                      line.startsWith('📈') || line.startsWith('📦') || line.startsWith('🏭') ||
                                      line.startsWith('💡') || line.startsWith('🗓️') ||
                                      line.startsWith('📏') || line.startsWith('🖼️') ||
                                      line.startsWith('💬') || line.startsWith('📋') ||
                                      line.startsWith('ℹ️') || line.startsWith('⚡')) {
                                    return (
                                      <p key={i} className="font-semibold text-foreground mt-4 first:mt-0 mb-1">
                                        {line}
                                      </p>
                                    )
                                  }
                                  return (
                                    <p key={i} className="text-muted-foreground my-0.5">
                                      {line}
                                    </p>
                                  )
                                })}
                              </div>
                            </div>

                            {/* Weekday Distribution */}
                            {data.weekday_rows && data.weekday_rows.length > 0 && (
                              <div className="rounded-lg border border-border/60 bg-[hsl(var(--surface-soft))] p-4">
                                <h4 className="text-sm font-semibold mb-3">📅 星期退货分布</h4>
                                <div className="grid grid-cols-7 gap-2">
                                  {data.weekday_rows.map((row) => (
                                    <div key={row.weekday} className="flex flex-col items-center p-2 rounded-md bg-[hsl(var(--surface-panel))]">
                                      <div className="text-xs text-muted-foreground">{row.weekday_display}</div>
                                      <div className="text-lg font-semibold mt-1">{row.return_count}</div>
                                      <div className="text-xs text-muted-foreground">{row.percentage}%</div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Fulfillment Center Distribution */}
                            {data.fulfillment_center_rows && data.fulfillment_center_rows.length > 0 && (
                              <div className="rounded-lg border border-border/60 bg-[hsl(var(--surface-soft))] p-4">
                                <h4 className="text-sm font-semibold mb-3">🏭 仓库退货分布</h4>
                                <Table containerClassName="bg-[hsl(var(--surface-panel))]/94">
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
                                        <TableCell className="font-medium">{row.fulfillment_center_id}</TableCell>
                                        <TableCell className="text-right">{row.return_count.toLocaleString()}</TableCell>
                                        <TableCell className="text-right">{row.quantity.toLocaleString()}</TableCell>
                                        <TableCell className="text-right text-muted-foreground">{row.percentage}%</TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            )}
                          </div>
                        ) : (
                          <EmptyTableState colSpan={1} message="暂无总结数据" />
                        )}
                      </RefreshProgressBar>
                    )}
                  </div>
                )}
              </TabsContent>
            </DirectionalTabTransition>
          </DataTableCardBody>
        </DataTableCard>
      </Tabs>
    </div>
  )
}
