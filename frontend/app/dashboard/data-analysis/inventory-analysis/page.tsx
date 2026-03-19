'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Boxes, Clock4, FileDown, Loader2, PackageSearch } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { formatLocalTimestampForFilename } from '@/lib/utils'

const API_BASE = '/api/backend/api/v1'

type ProjectOption = {
  id: number
  name: string
}

type InventorySummary = {
  sku_count: number
  out_of_stock_count: number
  aging_sku_count: number
  over_aged_sku_count: number
  total_available_qty: number
  total_age_0_90_qty: number
  total_age_91_180_qty: number
  total_age_181_270_qty: number
  total_age_271_365_qty: number
  total_age_365_plus_qty: number
  action_type_count: number
}

type InventoryItem = {
  project_id: number
  project_name: string
  country: string
  sku: string
  asin: string | null
  available_qty: number
  age_0_90_qty: number
  age_91_180_qty: number
  age_181_270_qty: number
  age_271_365_qty: number
  age_365_plus_qty: number
  recommended_action: string | null
  recommended_action_label: string
  stock_status: string
  aging_status: string
}

type InventoryResponse = {
  project_id: number
  project_name: string
  country: string
  snapshot_at: string | null
  summary: InventorySummary
  action_options: string[]
  items: InventoryItem[]
}

const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
] as const

function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--'
  return value.toLocaleString('zh-CN')
}

function formatSnapshot(value: string | null): string {
  if (!value) return '暂无快照'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '暂无快照'
  return date.toLocaleString('zh-CN', { hour12: false })
}

function stockMeta(status: string): { label: string; className: string } {
  if (status === 'out_of_stock') {
    return {
      label: '缺货',
      className: 'border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/50 dark:text-rose-300',
    }
  }
  return {
    label: '有货',
    className: 'border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/50 dark:text-emerald-300',
  }
}

function stockExcelFontColor(status: string): string {
  if (status === 'out_of_stock') return 'FFBE123C'
  return 'FF15803D'
}

function agingMeta(status: string): { label: string; className: string } {
  if (status === 'over_aged') {
    return {
      label: '超龄',
      className: 'border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-900/70 dark:bg-rose-950/50 dark:text-rose-300',
    }
  }
  if (status === 'aging') {
    return {
      label: '偏高',
      className: 'border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-900/70 dark:bg-amber-950/50 dark:text-amber-300',
    }
  }
  return {
    label: '正常',
    className: 'border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-900/70 dark:bg-sky-950/50 dark:text-sky-300',
  }
}

function agingExcelFontColor(status: string): string {
  if (status === 'over_aged') return 'FFBE123C'
  if (status === 'aging') return 'FFB45309'
  return 'FF0369A1'
}

export default function InventoryAnalysisPage() {
  const { data: session } = useSession()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectId, setProjectId] = useState<string>('')
  const [country, setCountry] = useState('US')

  const [snapshotAt, setSnapshotAt] = useState<string | null>(null)
  const [summary, setSummary] = useState<InventorySummary>({
    sku_count: 0,
    out_of_stock_count: 0,
    aging_sku_count: 0,
    over_aged_sku_count: 0,
    total_available_qty: 0,
    total_age_0_90_qty: 0,
    total_age_91_180_qty: 0,
    total_age_181_270_qty: 0,
    total_age_271_365_qty: 0,
    total_age_365_plus_qty: 0,
    action_type_count: 0,
  })
  const [rows, setRows] = useState<InventoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const currentProjectId = useMemo(() => {
    const parsed = Number(projectId)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }, [projectId])

  useEffect(() => {
    let active = true
    async function loadProjects() {
      setProjectsLoading(true)
      setError(null)
      try {
        const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
        if (!active) return
        setProjects(payload)
        if (!projectId && payload[0]?.id) {
          setProjectId(String(payload[0].id))
        }
      } catch (loadError) {
        if (!active) return
        setError(loadError instanceof Error ? loadError.message : '项目列表加载失败')
      } finally {
        if (active) setProjectsLoading(false)
      }
    }
    void loadProjects()
    return () => {
      active = false
    }
  }, [projectId, session])

  useEffect(() => {
    if (!currentProjectId) return
    let active = true
    async function loadData() {
      setLoading(true)
      setError(null)
      try {
        const query = new URLSearchParams({
          project_id: String(currentProjectId),
          country,
        })
        const response = await fetch(`${API_BASE}/inventory-analysis?${query.toString()}`, {
          headers: {},
          cache: 'no-store',
        })
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { detail?: string }
          throw new Error(payload.detail || `加载失败 (${response.status})`)
        }
        const payload = (await response.json()) as InventoryResponse
        if (!active) return
        setSnapshotAt(payload.snapshot_at)
        setSummary(payload.summary)
        setRows(payload.items)
      } catch (loadError) {
        if (!active) return
        setError(loadError instanceof Error ? loadError.message : '库存分析加载失败')
        setRows([])
      } finally {
        if (active) setLoading(false)
      }
    }
    void loadData()
    return () => {
      active = false
    }
  }, [country, currentProjectId])

  const exportToExcel = async () => {
    if (rows.length === 0) {
      setError('当前没有可导出的库存明细数据')
      return
    }

    setExporting(true)
    setError(null)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()

      const worksheet = workbook.addWorksheet('库存分析', {
        views: [{ state: 'frozen', ySplit: 4, xSplit: 2 }],
      })

      const selectedProject = projects.find((project) => String(project.id) === projectId)
      const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false })
      const columns = [
        { header: 'SKU', key: 'sku', width: 22 },
        { header: 'ASIN', key: 'asin', width: 18 },
        { header: '库存', key: 'available_qty', width: 12 },
        { header: '0-90天', key: 'age_0_90_qty', width: 12 },
        { header: '91-180天', key: 'age_91_180_qty', width: 12 },
        { header: '181-270天', key: 'age_181_270_qty', width: 12 },
        { header: '271-365天', key: 'age_271_365_qty', width: 12 },
        { header: '超过365天', key: 'age_365_plus_qty', width: 14 },
        { header: '建议操作', key: 'recommended_action_label', width: 20 },
        { header: '库存状态', key: 'stock_status', width: 12 },
        { header: '库龄状态', key: 'aging_status', width: 12 },
      ] as const

      const lastColumn = columns.length
      worksheet.mergeCells(1, 1, 1, lastColumn)
      worksheet.getCell(1, 1).value = '库存分析导出'
      worksheet.getCell(1, 1).font = { name: 'Microsoft YaHei', size: 16, bold: true, color: { argb: 'FF0F172A' } }
      worksheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }

      worksheet.mergeCells(2, 1, 2, lastColumn)
      worksheet.getCell(2, 1).value = `导出时间：${exportedAt}    说明：导出当前项目与国家站点下的库存分析明细`
      worksheet.getCell(2, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF475569' } }
      worksheet.getCell(2, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }

      worksheet.mergeCells(3, 1, 3, lastColumn)
      worksheet.getCell(3, 1).value = `项目：${selectedProject?.name || '--'}    国家站点：${COUNTRY_OPTIONS.find((option) => option.value === country)?.label || country}    快照时间：${formatSnapshot(snapshotAt)}`
      worksheet.getCell(3, 1).font = { name: 'Microsoft YaHei', size: 10, color: { argb: 'FF64748B' } }
      worksheet.getCell(3, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }

      worksheet.columns = columns.map((column) => ({
        header: column.header,
        key: column.key,
        width: column.width,
      }))

      const headerRow = worksheet.getRow(4)
      headerRow.values = columns.map((column) => column.header)
      headerRow.height = 24
      headerRow.eachCell((cell) => {
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

      rows.forEach((row, index) => {
        const stock = stockMeta(row.stock_status)
        const aging = agingMeta(row.aging_status)
        const excelRow = worksheet.getRow(index + 5)
        excelRow.values = [
          row.sku,
          row.asin || '--',
          row.available_qty,
          row.age_0_90_qty,
          row.age_91_180_qty,
          row.age_181_270_qty,
          row.age_271_365_qty,
          row.age_365_plus_qty,
          row.recommended_action_label || '--',
          stock.label,
          aging.label,
        ]

        excelRow.eachCell((cell, colNumber) => {
          cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
          cell.alignment = {
            vertical: 'middle',
            horizontal: colNumber >= 3 && colNumber <= 8 ? 'right' : 'left',
            wrapText: true,
          }
          if (colNumber >= 3 && colNumber <= 8) {
            cell.numFmt = '#,##0'
          }
          if (colNumber === 10) {
            cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: stockExcelFontColor(row.stock_status) } }
          }
          if (colNumber === 11) {
            cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: agingExcelFontColor(row.aging_status) } }
          }
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          }
        })
      })

      const totalRow = worksheet.getRow(rows.length + 5)
      totalRow.values = [
        '汇总',
        '--',
        summary.total_available_qty,
        summary.total_age_0_90_qty,
        summary.total_age_91_180_qty,
        summary.total_age_181_270_qty,
        summary.total_age_271_365_qty,
        summary.total_age_365_plus_qty,
        '--',
        '--',
        '--',
      ]
      totalRow.eachCell((cell, colNumber) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
          right: { style: 'thin', color: { argb: 'FFCBD5E1' } },
        }
        cell.alignment = {
          vertical: 'middle',
          horizontal: colNumber >= 3 && colNumber <= 8 ? 'right' : 'left',
        }
        if (colNumber >= 3 && colNumber <= 8) {
          cell.numFmt = '#,##0'
        }
      })

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      const safeTimestamp = formatLocalTimestampForFilename()
      link.href = url
      link.download = `库存分析-${safeTimestamp}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出 Excel 失败')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>库存分析</CardTitle>
          <CardDescription>筛选项目与国家站点，查看库存结构与操作建议</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">项目</div>
              {projectsLoading ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger>
                    <SelectValue placeholder="请选择项目" />
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
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">国家站点</div>
              <Select value={country} onValueChange={setCountry}>
                <SelectTrigger>
                  <SelectValue placeholder="请选择国家站点" />
                </SelectTrigger>
                <SelectContent>
                  {COUNTRY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Card className="border-dashed bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 sm:col-span-2">
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium text-blue-700 dark:text-blue-300">
                    <Clock4 className="h-4 w-4" />
                    当前快照时间
                  </div>
                  <div className="mt-1.5 text-xl font-bold text-blue-900 dark:text-blue-100">
                    {formatSnapshot(snapshotAt)}
                  </div>
                </div>
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/50">
                  <Clock4 className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                </div>
              </CardContent>
            </Card>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Card className="border-dashed">
              <CardContent className="flex items-center justify-between p-3">
                <div>
                  <div className="text-xs text-muted-foreground">SKU 总数</div>
                  <div className="mt-1 text-lg font-semibold">{formatInt(summary.sku_count)}</div>
                </div>
                <PackageSearch className="h-5 w-5 text-muted-foreground" />
              </CardContent>
            </Card>
            <Card className="border-dashed">
              <CardContent className="flex items-center justify-between p-3">
                <div>
                  <div className="text-xs text-muted-foreground">可售库存总量</div>
                  <div className="mt-1 text-lg font-semibold">{formatInt(summary.total_available_qty)}</div>
                </div>
                <Boxes className="h-5 w-5 text-muted-foreground" />
              </CardContent>
            </Card>
            <Card className="border-dashed">
              <CardContent className="flex items-center justify-between p-3">
                <div>
                  <div className="text-xs text-muted-foreground">缺货 SKU</div>
                  <div className="mt-1 text-lg font-semibold text-rose-600">{formatInt(summary.out_of_stock_count)}</div>
                </div>
                <AlertTriangle className="h-5 w-5 text-rose-500" />
              </CardContent>
            </Card>
            <Card className="border-dashed">
              <CardContent className="flex items-center justify-between p-3">
                <div>
                  <div className="text-xs text-muted-foreground">365+ 库龄库存</div>
                  <div className="mt-1 text-lg font-semibold text-amber-600">{formatInt(summary.total_age_365_plus_qty)}</div>
                </div>
                <Clock4 className="h-5 w-5 text-amber-500" />
              </CardContent>
            </Card>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
          <div>
            <CardTitle>库存明细表</CardTitle>
            <CardDescription>展示当前项目站点库存分段与建议操作（英文状态已映射为中文）</CardDescription>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={exportToExcel}
            disabled={exporting || loading || rows.length === 0}
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
            {exporting ? '导出中...' : '导出 Excel'}
          </Button>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </div>
          ) : null}
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="border-r border-border">SKU</TableHead>
                  <TableHead className="border-r border-border">ASIN</TableHead>
                  <TableHead className="border-r border-border text-right">库存</TableHead>
                  <TableHead className="border-r border-border text-right">0-90天</TableHead>
                  <TableHead className="border-r border-border text-right">91-180天</TableHead>
                  <TableHead className="border-r border-border text-right">181-270天</TableHead>
                  <TableHead className="border-r border-border text-right">271-365天</TableHead>
                  <TableHead className="border-r border-border text-right">超过365天</TableHead>
                  <TableHead className="border-r border-border">建议操作</TableHead>
                  <TableHead className="border-r border-border">库存状态</TableHead>
                  <TableHead>库龄状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={11} className="h-24 text-center text-muted-foreground">
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        正在加载库存数据...
                      </span>
                    </TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11} className="h-24 text-center text-muted-foreground">
                      当前筛选下暂无库存快照数据
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => {
                    const stock = stockMeta(row.stock_status)
                    const aging = agingMeta(row.aging_status)
                    return (
                      <TableRow key={`${row.sku}::${row.asin || 'na'}`}>
                        <TableCell className="border-r border-border font-medium">{row.sku}</TableCell>
                        <TableCell className="border-r border-border">{row.asin || '--'}</TableCell>
                        <TableCell className="border-r border-border text-right">{formatInt(row.available_qty)}</TableCell>
                        <TableCell className="border-r border-border text-right">{formatInt(row.age_0_90_qty)}</TableCell>
                        <TableCell className="border-r border-border text-right">{formatInt(row.age_91_180_qty)}</TableCell>
                        <TableCell className="border-r border-border text-right">{formatInt(row.age_181_270_qty)}</TableCell>
                        <TableCell className="border-r border-border text-right">{formatInt(row.age_271_365_qty)}</TableCell>
                        <TableCell className="border-r border-border text-right">{formatInt(row.age_365_plus_qty)}</TableCell>
                        <TableCell className="border-r border-border">
                          {row.recommended_action_label || '--'}
                        </TableCell>
                        <TableCell className="border-r border-border">
                          <Badge variant="outline" className={stock.className}>
                            {stock.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={aging.className}>
                            {aging.label}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
