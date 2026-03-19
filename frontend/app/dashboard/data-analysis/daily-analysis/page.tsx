'use client'

import { useEffect, useMemo, useState } from 'react'
import { DateRange } from 'react-day-picker'
import { FileDown, Loader2, RefreshCcw, TableProperties } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DateRangePicker } from '@/components/ui/date-picker'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { formatLocalTimestampForFilename } from '@/lib/utils'

type CountryOption = 'US' | 'DE' | 'UK'
type ViewTab = 'summary' | 'details'

type ProjectOption = {
  id: number | null
  name: string
}

type DailyAnalysisConsole = {
  project_id: number
  project_name: string
  country: string
  start_date: string
  end_date: string
  requested_days: number
  summary_days: number
  detail_rows: number
  sales_source_days: number
  ad_source_days: number
  inventory_source_days: number
  missing_dates: string[]
  latest_sales_date: string | null
  latest_ad_date: string | null
  latest_inventory_date: string | null
}

type DailyAnalysisRow = {
  date: string
  order_qty: number
  sales_amount: number
  impressions: number
  clicks: number
  cpc: number
  ad_spend: number
  ad_orders: number
  available_qty: number
}

type DailyAnalysisDetailRow = DailyAnalysisRow & {
  sku: string
  asin: string | null
}

type DailyAnalysisResponse = {
  console: DailyAnalysisConsole
  summary_rows: DailyAnalysisRow[]
  detail_rows: DailyAnalysisDetailRow[]
  available_dates: Record<string, string[]>
}

const API_BASE = '/api/backend'
const COUNTRY_OPTIONS: Array<{ value: CountryOption; label: string }> = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
]

function authHeaders(): Record<string, string> {
  return {}
}

function formatMoney(value: number) {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

async function exportDailyAnalysisToExcel(
  summaryRows: DailyAnalysisRow[],
  detailRows: DailyAnalysisDetailRow[],
  projectName: string,
  country: string,
  dateRange: string
) {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Codex'
  workbook.created = new Date()

  const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false })
  const safeTimestamp = formatLocalTimestampForFilename(new Date())

  // Sheet 1: 汇总
  const summarySheet = workbook.addWorksheet('日报汇总', {
    views: [{ state: 'frozen', ySplit: 3 }],
  })

  const summaryCols = [
    { header: '日期', key: 'date', width: 14 },
    { header: '订单量', key: 'order_qty', width: 12 },
    { header: '销售额', key: 'sales_amount', width: 14 },
    { header: '曝光量', key: 'impressions', width: 14 },
    { header: '点击量', key: 'clicks', width: 12 },
    { header: 'CPC', key: 'cpc', width: 12 },
    { header: '广告花费', key: 'ad_spend', width: 14 },
    { header: '广告订单', key: 'ad_orders', width: 14 },
    { header: '可售库存', key: 'available_qty', width: 14 },
  ]

  summarySheet.columns = summaryCols

  summarySheet.mergeCells(1, 1, 1, summaryCols.length)
  summarySheet.getCell(1, 1).value = `日报分析汇总 - ${projectName} - ${country}`
  summarySheet.getCell(1, 1).font = { name: 'Microsoft YaHei', size: 16, bold: true, color: { argb: 'FF0F172A' } }
  summarySheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
  summarySheet.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'left' }

  summarySheet.mergeCells(2, 1, 2, summaryCols.length)
  summarySheet.getCell(2, 1).value = `导出时间：${exportedAt}    日期范围：${dateRange}`
  summarySheet.getCell(2, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF475569' } }
  summarySheet.getCell(2, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
  summarySheet.getCell(2, 1).alignment = { vertical: 'middle', horizontal: 'left' }

  const summaryHeaderRow = summarySheet.getRow(3)
  summaryHeaderRow.values = summaryCols.map((c) => c.header)
  summaryHeaderRow.height = 22
  summaryHeaderRow.eachCell((cell) => {
    cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    }
  })

  summaryRows.forEach((row, rowIndex) => {
    const excelRow = summarySheet.getRow(rowIndex + 4)
    excelRow.getCell(1).value = row.date
    excelRow.getCell(2).value = row.order_qty
    excelRow.getCell(3).value = row.sales_amount
    excelRow.getCell(3).numFmt = '#,##0.00'
    excelRow.getCell(4).value = row.impressions
    excelRow.getCell(5).value = row.clicks
    excelRow.getCell(6).value = row.cpc
    excelRow.getCell(6).numFmt = '#,##0.00'
    excelRow.getCell(7).value = row.ad_spend
    excelRow.getCell(7).numFmt = '#,##0.00'
    excelRow.getCell(8).value = row.ad_orders
    excelRow.getCell(9).value = row.available_qty

    excelRow.eachCell((cell, colNumber) => {
      cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
      cell.alignment = { vertical: 'middle', horizontal: colNumber === 1 ? 'center' : 'right' }
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      }
    })
  })

  // Sheet 2: SKU明细
  const detailSheet = workbook.addWorksheet('SKU明细', {
    views: [{ state: 'frozen', ySplit: 3 }],
  })

  const detailCols = [
    { header: '日期', key: 'date', width: 14 },
    { header: 'SKU', key: 'sku', width: 18 },
    { header: 'ASIN', key: 'asin', width: 16 },
    { header: '订单量', key: 'order_qty', width: 12 },
    { header: '销售额', key: 'sales_amount', width: 14 },
    { header: '曝光量', key: 'impressions', width: 14 },
    { header: '点击量', key: 'clicks', width: 12 },
    { header: 'CPC', key: 'cpc', width: 12 },
    { header: '广告花费', key: 'ad_spend', width: 14 },
    { header: '广告订单', key: 'ad_orders', width: 14 },
    { header: '可售库存', key: 'available_qty', width: 14 },
  ]

  detailSheet.columns = detailCols

  detailSheet.mergeCells(1, 1, 1, detailCols.length)
  detailSheet.getCell(1, 1).value = `日报分析SKU明细 - ${projectName} - ${country}`
  detailSheet.getCell(1, 1).font = { name: 'Microsoft YaHei', size: 16, bold: true, color: { argb: 'FF0F172A' } }
  detailSheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
  detailSheet.getCell(1, 1).alignment = { vertical: 'middle', horizontal: 'left' }

  detailSheet.mergeCells(2, 1, 2, detailCols.length)
  detailSheet.getCell(2, 1).value = `导出时间：${exportedAt}    日期范围：${dateRange}    共 ${detailRows.length} 条`
  detailSheet.getCell(2, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF475569' } }
  detailSheet.getCell(2, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
  detailSheet.getCell(2, 1).alignment = { vertical: 'middle', horizontal: 'left' }

  const detailHeaderRow = detailSheet.getRow(3)
  detailHeaderRow.values = detailCols.map((c) => c.header)
  detailHeaderRow.height = 22
  detailHeaderRow.eachCell((cell) => {
    cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
      right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    }
  })

  detailRows.forEach((row, rowIndex) => {
    const excelRow = detailSheet.getRow(rowIndex + 4)
    excelRow.getCell(1).value = row.date
    excelRow.getCell(2).value = row.sku
    excelRow.getCell(3).value = row.asin || ''
    excelRow.getCell(4).value = row.order_qty
    excelRow.getCell(5).value = row.sales_amount
    excelRow.getCell(5).numFmt = '#,##0.00'
    excelRow.getCell(6).value = row.impressions
    excelRow.getCell(7).value = row.clicks
    excelRow.getCell(8).value = row.cpc
    excelRow.getCell(8).numFmt = '#,##0.00'
    excelRow.getCell(9).value = row.ad_spend
    excelRow.getCell(9).numFmt = '#,##0.00'
    excelRow.getCell(10).value = row.ad_orders
    excelRow.getCell(11).value = row.available_qty

    excelRow.eachCell((cell, colNumber) => {
      cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
      cell.alignment = { vertical: 'middle', horizontal: colNumber <= 3 ? 'left' : 'right' }
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      }
    })
  })

  let mergeStartRow = 4
  let groupIndex = 0
  for (let rowIndex = 1; rowIndex <= detailRows.length; rowIndex += 1) {
    const currentDate = detailRows[rowIndex]?.date
    const previousDate = detailRows[rowIndex - 1]?.date
    const isGroupBoundary = currentDate !== previousDate

    if (!isGroupBoundary) continue

    const mergeEndRow = rowIndex + 3
    const groupStartRow = mergeStartRow
    const groupRowCount = mergeEndRow - groupStartRow + 1
    const isEvenGroup = groupIndex % 2 === 0
    const groupFill = isEvenGroup ? 'FFFFFFFF' : 'FFF8FAFC'
    const groupBorder = 'FFCBD5E1'
    const strongGroupBorder = 'FF94A3B8'

    for (let currentRow = groupStartRow; currentRow <= mergeEndRow; currentRow += 1) {
      const row = detailSheet.getRow(currentRow)
      for (let colNumber = 1; colNumber <= detailCols.length; colNumber += 1) {
        const cell = row.getCell(colNumber)
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: groupFill },
        }
        cell.border = {
          top: { style: currentRow === groupStartRow ? 'medium' : 'thin', color: { argb: strongGroupBorder } },
          left: { style: colNumber === 1 ? 'medium' : 'thin', color: { argb: groupBorder } },
          bottom: { style: currentRow === mergeEndRow ? 'medium' : 'thin', color: { argb: strongGroupBorder } },
          right: { style: colNumber === detailCols.length ? 'medium' : 'thin', color: { argb: groupBorder } },
        }
      }
    }

    if (groupRowCount > 1) {
      detailSheet.mergeCells(groupStartRow, 1, mergeEndRow, 1)
    }

    const mergedDateCell = detailSheet.getCell(groupStartRow, 1)
    mergedDateCell.alignment = { vertical: 'middle', horizontal: 'center' }
    mergedDateCell.font = { name: 'Microsoft YaHei', size: 11, bold: true, color: { argb: 'FF0F172A' } }
    mergedDateCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: groupFill } }
    mergedDateCell.border = {
      top: { style: 'medium', color: { argb: strongGroupBorder } },
      left: { style: 'medium', color: { argb: groupBorder } },
      bottom: { style: 'medium', color: { argb: strongGroupBorder } },
      right: { style: 'medium', color: { argb: groupBorder } },
    }

    mergeStartRow = rowIndex + 4
    groupIndex += 1
  }

  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `日报分析-${projectName}-${country}-${safeTimestamp}.xlsx`
  link.click()
  window.URL.revokeObjectURL(url)
}

function lastSevenDaysRange(): DateRange {
  const end = new Date()
  end.setDate(end.getDate() - 1)
  const start = new Date(end)
  start.setDate(end.getDate() - 6)
  return { from: start, to: end }
}

function formatYMD(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function FilterSkeleton() {
  return (
    <div className="space-y-1.5">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-10 w-full" />
    </div>
  )
}

export default function DailyAnalysisPage() {
  const { data: session } = useSession()
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)

  const defaultRange = useMemo(() => lastSevenDaysRange(), [])
  const [projectId, setProjectId] = useState('')
  const [country, setCountry] = useState<CountryOption>('US')
  const [dateRange, setDateRange] = useState<DateRange | undefined>(defaultRange)
  const [activeTab, setActiveTab] = useState<ViewTab>('summary')

  const [data, setData] = useState<DailyAnalysisResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsLoading(true)
      setProjectsError(null)
      try {
        const rows = await fetchManagedProjectsCached<ProjectOption[]>(session)
        setProjects(rows.filter((item) => item.id !== null))
      } catch (fetchError) {
        setProjectsError(fetchError instanceof Error ? fetchError.message : '项目列表加载失败')
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [session])

  useEffect(() => {
    if (projectId || projects.length === 0) return
    const first = projects.find((item) => item.id !== null)
    if (first?.id != null) setProjectId(String(first.id))
  }, [projectId, projects])

  const loadData = async () => {
    if (!projectId) {
      setError('请先选择项目')
      return
    }
    if (!dateRange?.from || !dateRange?.to) {
      setError('请选择开始和结束日期')
      return
    }

    const startDate = formatYMD(dateRange.from)
    const endDate = formatYMD(dateRange.to)

    setLoading(true)
    setError(null)
    try {
      const search = new URLSearchParams({
        project_id: projectId,
        country,
        start_date: startDate,
        end_date: endDate,
      })
      const response = await fetch(`${API_BASE}/api/v1/daily-analysis?${search.toString()}`, {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.detail || '日报分析加载失败')
      }
      const payload = (await response.json()) as DailyAnalysisResponse
      setData(payload)
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : '日报分析加载失败')
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!projectId) return
    void loadData()
  }, [projectId, country]) // eslint-disable-line react-hooks/exhaustive-deps

  const summaryRows = data?.summary_rows ?? []
  const detailRows = data?.detail_rows ?? []
  const consoleData = data?.console ?? null

  const selectedProjectName = useMemo(
    () => projects.find((p) => String(p.id) === projectId)?.name ?? '',
    [projects, projectId]
  )
  const dateRangeDisplay = consoleData ? `${consoleData.start_date} ~ ${consoleData.end_date}` : (dateRange ? `${formatYMD(dateRange.from!)}${' ~ ' + formatYMD(dateRange.to!)}` : '')

  const handleExportExcel = async () => {
    if (!data) return
    setExporting(true)
    try {
      await exportDailyAnalysisToExcel(summaryRows, detailRows, selectedProjectName, country, dateRangeDisplay)
    } catch (exportError) {
      console.error('导出失败:', exportError)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card className="border-slate-200/80 bg-[linear-gradient(135deg,rgba(241,245,249,0.9),rgba(255,255,255,0.98))] shadow-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-xl">日报分析控制台</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex gap-3 flex-wrap">
            <div className="flex flex-1 gap-3 flex-wrap min-w-0">
              <div className="space-y-1.5 min-w-[140px] flex-1">
                <div className="text-xs font-medium text-slate-500">项目</div>
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="选择项目" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((item) => (
                      <SelectItem key={item.id} value={String(item.id)}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 min-w-[140px] flex-1">
                <div className="text-xs font-medium text-slate-500">国家站点</div>
                <Select value={country} onValueChange={(value) => setCountry(value as CountryOption)}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="国家站点" />
                  </SelectTrigger>
                  <SelectContent>
                    {COUNTRY_OPTIONS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 min-w-[220px] flex-1">
                <div className="text-xs font-medium text-slate-500">日期范围</div>
                <DateRangePicker
                  value={dateRange}
                  onChange={setDateRange}
                  className="h-9"
                  onApply={() => void loadData()}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-slate-500">&nbsp;</div>
              <Button type="button" variant="outline" onClick={() => void loadData()} disabled={loading || projectsLoading} className="h-9 px-3 shrink-0">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                <span className="ml-1.5">刷新</span>
              </Button>
            </div>
          </div>

          {projectsError ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">{projectsError}</div> : null}
          {error ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</div> : null}
        </CardContent>
      </Card>

      <Card className="overflow-hidden border-slate-200/80">
        <CardHeader className="border-b border-slate-200/80 bg-slate-50/70">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle className="text-lg">日报明细表格</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleExportExcel()}
                disabled={exporting || !data}
              >
                {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileDown className="mr-2 h-4 w-4" />}
                导出 Excel
              </Button>
              <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ViewTab)} className="w-full lg:w-auto">
                <TabsList className="grid w-full grid-cols-2 lg:w-[260px]">
                  <TabsTrigger value="summary">每日汇总</TabsTrigger>
                  <TabsTrigger value="details">SKU 明细</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Tabs value={activeTab} className="w-full">
            <TabsContent value="summary" className="m-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50/70">
                      <TableHead className="min-w-[120px]">日期</TableHead>
                      <TableHead>订单量</TableHead>
                      <TableHead>销售额</TableHead>
                      <TableHead>曝光量</TableHead>
                      <TableHead>点击量</TableHead>
                      <TableHead>CPC</TableHead>
                      <TableHead>广告花费</TableHead>
                      <TableHead>广告订单</TableHead>
                      <TableHead>可售库存</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      Array.from({ length: 6 }).map((_, index) => (
                        <TableRow key={`summary-skeleton-${index}`}>
                          {Array.from({ length: 9 }).map((__, cellIndex) => (
                            <TableCell key={cellIndex}><Skeleton className="h-4 w-full max-w-[90px]" /></TableCell>
                          ))}
                        </TableRow>
                      ))
                    ) : summaryRows.length ? (
                      summaryRows.map((row) => (
                        <TableRow key={row.date}>
                          <TableCell className="font-medium">{row.date}</TableCell>
                          <TableCell>{row.order_qty.toLocaleString('zh-CN')}</TableCell>
                          <TableCell>{formatMoney(row.sales_amount)}</TableCell>
                          <TableCell>{row.impressions.toLocaleString('zh-CN')}</TableCell>
                          <TableCell>{row.clicks.toLocaleString('zh-CN')}</TableCell>
                          <TableCell>{formatMoney(row.cpc)}</TableCell>
                          <TableCell>{formatMoney(row.ad_spend)}</TableCell>
                          <TableCell>{row.ad_orders.toLocaleString('zh-CN')}</TableCell>
                          <TableCell>{row.available_qty.toLocaleString('zh-CN')}</TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={9} className="h-32 text-center text-sm text-slate-500">
                          当前筛选范围内还没有可展示的日报汇总数据。
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="details" className="m-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50/70">
                      <TableHead className="min-w-[120px]">日期</TableHead>
                      <TableHead className="min-w-[140px]">SKU</TableHead>
                      <TableHead className="min-w-[140px]">ASIN</TableHead>
                      <TableHead>订单量</TableHead>
                      <TableHead>销售额</TableHead>
                      <TableHead>曝光量</TableHead>
                      <TableHead>点击量</TableHead>
                      <TableHead>CPC</TableHead>
                      <TableHead>广告花费</TableHead>
                      <TableHead>广告订单</TableHead>
                      <TableHead>可售库存</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loading ? (
                      Array.from({ length: 8 }).map((_, index) => (
                        <TableRow key={`detail-skeleton-${index}`}>
                          {Array.from({ length: 11 }).map((__, cellIndex) => (
                            <TableCell key={cellIndex}><Skeleton className="h-4 w-full max-w-[90px]" /></TableCell>
                          ))}
                        </TableRow>
                      ))
                    ) : detailRows.length ? (
                      detailRows.map((row) => (
                        <TableRow key={`${row.date}-${row.sku}`}>
                          <TableCell className="font-medium">{row.date}</TableCell>
                          <TableCell>{row.sku}</TableCell>
                          <TableCell>{row.asin || '--'}</TableCell>
                          <TableCell>{row.order_qty.toLocaleString('zh-CN')}</TableCell>
                          <TableCell>{formatMoney(row.sales_amount)}</TableCell>
                          <TableCell>{row.impressions.toLocaleString('zh-CN')}</TableCell>
                          <TableCell>{row.clicks.toLocaleString('zh-CN')}</TableCell>
                          <TableCell>{formatMoney(row.cpc)}</TableCell>
                          <TableCell>{formatMoney(row.ad_spend)}</TableCell>
                          <TableCell>{row.ad_orders.toLocaleString('zh-CN')}</TableCell>
                          <TableCell>{row.available_qty.toLocaleString('zh-CN')}</TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={11} className="h-32 text-center text-sm text-slate-500">
                          当前筛选范围内还没有可展示的 SKU 日报明细。
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {consoleData ? (
        <Card className="border-dashed border-slate-300 bg-slate-50/60">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><TableProperties className="h-4 w-4" />数据可用性</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            <div className="rounded-xl bg-white px-4 py-3 text-sm text-slate-600">最新销售日报：<span className="font-medium text-slate-900">{consoleData.latest_sales_date || '--'}</span></div>
            <div className="rounded-xl bg-white px-4 py-3 text-sm text-slate-600">最新广告日报：<span className="font-medium text-slate-900">{consoleData.latest_ad_date || '--'}</span></div>
            <div className="rounded-xl bg-white px-4 py-3 text-sm text-slate-600">最新库存快照：<span className="font-medium text-slate-900">{consoleData.latest_inventory_date || '--'}</span></div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
