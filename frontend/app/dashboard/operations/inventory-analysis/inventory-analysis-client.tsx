'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, FileDown, Loader2 } from 'lucide-react'
import { useSession } from 'next-auth/react'

import { fetchOpsJsonCached } from '@/lib/ops-client-cache'

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { TermPanel } from '@/components/terminal/term-panel'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'
import {
  TermBody,
  TermCell,
  TermHead,
  TermRow,
  TermTHead,
  TermTable,
} from '@/components/terminal/term-table'
import { useTerminalGlobalFilter } from '@/components/terminal/global-filter-context'
import { HeaderFilterControls } from '@/components/terminal/header-filter-controls'
import { HeaderSlotBadge, HeaderSlotSelect, HeaderSlotButton, TERM_HEADER_W_SM, TERM_HEADER_W_MD, TERM_HEADER_W_LG } from '@/components/terminal/header-filter-suite'
import {
  useHeaderRefresh,
  useHeaderSlot,
  useMobileFilterStrip,
} from '@/components/terminal/terminal-header-slot'
import { logClientOperation } from '@/lib/operation-audit'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useUrlParam } from '@/lib/hooks/use-url-param'
import { useAutoSelectFirstProject } from '@/lib/hooks/use-auto-select-first-project'
import { useNotifications } from '@/components/notifications'
import { cn, formatLocalTimestampForFilename } from '@/lib/utils'
import { applyBorder, applyHeaderBorder, applyRowBorder } from '@/lib/excel-styles'
import { getCountryLabel } from '@/lib/country'
import { downloadBlob } from '@/lib/download-blob'

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
  product_name: string | null
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
  shipment_quantities: Record<string, number>
}

type ShipmentColumn = {
  shipment_no: string
  label: string
  shipping_method: string | null
  forwarder_name: string | null
  etd_date: string | null
  eta_date: string | null
}

type InventoryResponse = {
  project_id: number
  project_name: string
  country: string
  report_date: string | null
  summary: InventorySummary
  action_options: string[]
  items: InventoryItem[]
  shipment_columns: ShipmentColumn[]
  shipment_column_totals: Record<string, number>
}

type SnapshotOption = {
  report_date: string
  is_current: boolean
}

function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined) return '--'
  return value.toLocaleString('zh-CN')
}

function formatBusinessDate(value: string | null): string {
  if (!value) return '暂无快照'
  const datePart = String(value).split('T')[0]
  if (!datePart) return '暂无快照'
  const [year, month, day] = datePart.split('-')
  if (!year || !month || !day) return '暂无快照'
  return `${year}年${month}月${day}日`
}

type CellTone = 'pos' | 'neg' | 'warn' | undefined

function stockTone(status: string): CellTone {
  return status === 'out_of_stock' ? 'neg' : 'pos'
}

function stockStatusLabel(status: string): string {
  return status === 'out_of_stock' ? '缺货' : '有货'
}

function stockExcelFontColor(status: string): string {
  if (status === 'out_of_stock') return 'FFBE123C'
  return 'FF15803D'
}

function agingTone(status: string): CellTone {
  if (status === 'over_aged') return 'neg'
  if (status === 'aging') return 'warn'
  return undefined
}

function agingStatusLabel(status: string): string {
  if (status === 'over_aged') return '超龄'
  if (status === 'aging') return '偏高'
  return '正常'
}

function agingExcelFontColor(status: string): string {
  if (status === 'over_aged') return 'FFBE123C'
  if (status === 'aging') return 'FFB45309'
  return 'FF0369A1'
}

/** 统计条磁贴：终端规格（1px 边界、mono 数值、语义色） */
function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: CellTone
}) {
  const alert = tone === 'neg' && value > 0
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border border-term-border bg-term-panel px-2 py-1.5">
      <span className="truncate font-mono text-xs uppercase tracking-wider text-term-muted">
        {label}
      </span>
      <span
        className={cn(
          'font-mono text-base leading-6 tabular-nums',
          alert ? 'text-term-neg' : 'text-term-text'
        )}
      >
        {formatInt(value)}
      </span>
    </div>
  )
}

export default function InventoryAnalysisPage() {
  const { notify } = useNotifications()
  const { data: session } = useSession()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  // 项目 / 国家 / 报表快照日期 同步到 URL search param，刷新 / 分享链接 / 浏览器后退都能记住选择。
  // reportDate 是后端响应里带回来的"数据是几号的"，属于衍生展示值，不放 URL。
  const [projectId, setProjectId] = useUrlParam<string>('project', '')

  // 进入页面默认选中第一个真实项目,内容立即加载（跳过 all / 空白意图）
  useAutoSelectFirstProject(projects, projectId, setProjectId)
  const [country, setCountry] = useUrlParam('country', 'US', {
    allowed: ['US', 'DE', 'UK', 'ALL'],
  })
  const [reportDate, setReportDate] = useState<string | null>(null)
  const [snapshotOptions, setSnapshotOptions] = useState<SnapshotOption[]>([])
  const [selectedSnapshotDate, setSelectedSnapshotDate] = useUrlParam<string>('snapshot', 'current')
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
  const [loadError, setLoadError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [shipmentColumns, setShipmentColumns] = useState<ShipmentColumn[]>([])
  const [shipmentColumnTotals, setShipmentColumnTotals] = useState<Record<string, number>>({})

  const currentProjectId = useMemo(() => {
    const parsed = Number(projectId)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }, [projectId])

  const detailTotals = useMemo(
    () => ({
      available_qty: summary.total_available_qty,
      age_0_90_qty: summary.total_age_0_90_qty,
      age_91_180_qty: summary.total_age_91_180_qty,
      age_181_270_qty: summary.total_age_181_270_qty,
      age_271_365_qty: summary.total_age_271_365_qty,
      age_365_plus_qty: summary.total_age_365_plus_qty,
    }),
    [summary]
  )

  useEffect(() => {
    let active = true
    async function loadProjects() {
      setProjectsLoading(true)
      try {
        const payload = await fetchManagedProjectsCached<ProjectOption[]>(session)
        if (!active) return
        setProjects(payload)
        // 1. URL 没指定 projectId（空字符串）→ 选第一个
        // 2. URL 指定了具体项目但项目列表里找不到（用户失去权限、项目被删除）→ 回退到第一个
        // 用 payload（刚 fetch 到的），不用 projects（state 还是旧值）。
        if (payload.length > 0) {
          const existsInList = projectId && payload.some((p) => String(p.id) === projectId)
          if (!projectId || !existsInList) {
            const first = payload.find((p) => p.id !== null && p.id !== undefined)
            if (first?.id != null) setProjectId(String(first.id))
          }
        }
      } catch (loadError) {
        if (!active) return
        notify({
          type: 'error',
          title: '项目列表加载失败',
          message: loadError instanceof Error ? loadError.message : '项目列表加载失败',
        })
      } finally {
        if (active) setProjectsLoading(false)
      }
    }
    void loadProjects()
    return () => {
      active = false
    }
  }, [notify, projectId, session])

  const loadData = async (force = false) => {
    if (!currentProjectId) return
    setLoading(true)
    setLoadError(null)
    try {
      const query = new URLSearchParams({
        project_id: String(currentProjectId),
        country,
      })
      if (selectedSnapshotDate !== 'current') {
        query.set('report_date', selectedSnapshotDate)
      }
      const payload = await fetchOpsJsonCached<InventoryResponse>(
        `${API_BASE}/inventory-analysis?${query.toString()}`,
        { session, fallbackError: '库存分析加载失败', force }
      )
      setReportDate(payload.report_date)
      setSummary(payload.summary)
      setRows(payload.items)
      setShipmentColumns(payload.shipment_columns || [])
      setShipmentColumnTotals(payload.shipment_column_totals || {})
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '库存分析加载失败')
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 筛选条件变化即拉取；手动刷新走 loadDataRef
  }, [country, currentProjectId, selectedSnapshotDate])

  // —— BLF-826 阶段 B/C：head 插槽 + 全局刷新 ——
  // 刷新语义：当前筛选条件下强刷（跳客户端缓存）。
  const loadDataRef = useRef(loadData)
  loadDataRef.current = loadData
  const { setLoading: setHeaderRefreshLoading } = useHeaderRefresh(() => loadDataRef.current(true), {
    loading,
  })

  // BEL-423 页内懒加载：业务日期选项推迟到下拉首次打开才取数。
  const [snapshotSelectOpen, setSnapshotSelectOpen] = useState(false)
  useEffect(() => {
    if (!snapshotSelectOpen) return
    if (!currentProjectId) return
    let active = true
    async function loadSnapshotOptions() {
      try {
        const query = new URLSearchParams({
          project_id: String(currentProjectId),
          country,
        })
        const response = await fetch(`${API_BASE}/inventory-snapshot-options?${query.toString()}`, {
          headers: {},
          cache: 'no-store',
        })
        if (!active) return
        if (response.ok) {
          const payload = (await response.json()) as SnapshotOption[]
          setSnapshotOptions(payload)
        }
      } catch {
        // ignore error
      }
    }
    void loadSnapshotOptions()
    return () => {
      active = false
    }
  }, [snapshotSelectOpen, country, currentProjectId])

  const exportToExcel = async () => {
    if (rows.length === 0) {
      notify({ type: 'error', title: '当前没有可导出的库存明细数据' })
      return
    }

    setExporting(true)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      workbook.creator = 'Codex'
      workbook.created = new Date()

      const worksheet = workbook.addWorksheet('库存分析', {
        views: [{ state: 'frozen', ySplit: 4, xSplit: 3, showGridLines: false }],
      })

      const selectedProject = projects.find((project) => String(project.id) === projectId)
      const baseColumns = [
        { header: 'SKU', key: 'sku', width: 22 },
        { header: 'ASIN', key: 'asin', width: 18 },
        { header: '品名', key: 'product_name', width: 24 },
        { header: '库存', key: 'available_qty', width: 12 },
        { header: '0-90天', key: 'age_0_90_qty', width: 12 },
        { header: '91-180天', key: 'age_91_180_qty', width: 12 },
        { header: '181-270天', key: 'age_181_270_qty', width: 12 },
        { header: '271-365天', key: 'age_271_365_qty', width: 12 },
        { header: '超过365天', key: 'age_365_plus_qty', width: 14 },
        { header: '建议操作', key: 'recommended_action_label', width: 20 },
        { header: '库存状态', key: 'stock_status', width: 12 },
        { header: '库龄状态', key: 'aging_status', width: 12 },
      ]
      const shipmentExportColumns = shipmentColumns.map((col) => ({
        header: col.label,
        key: `ship_${col.shipment_no}`,
        width: 14,
      }))
      const columns = [...baseColumns, ...shipmentExportColumns]

      const lastColumn = columns.length
      worksheet.columns = columns.map((column) => ({
        header: column.header,
        key: column.key,
        width: column.width,
      }))
      void lastColumn

      const headerRow = worksheet.getRow(1)
      headerRow.values = columns.map((column) => column.header)
      headerRow.height = 24
      headerRow.eachCell((cell) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
        applyHeaderBorder(cell)
      })

      rows.forEach((row, index) => {
        const excelRow = worksheet.getRow(index + 2)
        excelRow.values = [
          row.sku,
          row.asin || '--',
          row.product_name || '--',
          row.available_qty,
          row.age_0_90_qty,
          row.age_91_180_qty,
          row.age_181_270_qty,
          row.age_271_365_qty,
          row.age_365_plus_qty,
          row.recommended_action_label || '--',
          stockStatusLabel(row.stock_status),
          agingStatusLabel(row.aging_status),
          ...shipmentColumns.map((col) => row.shipment_quantities?.[col.shipment_no] ?? ''),
        ]

        excelRow.eachCell((cell, colNumber) => {
          cell.font = { name: 'Microsoft YaHei', color: { argb: 'FF0F172A' } }
          cell.alignment = {
            vertical: 'middle',
            horizontal: (colNumber >= 4 && colNumber <= 9) || colNumber > 12 ? 'right' : 'left',
            wrapText: true,
          }
          if ((colNumber >= 4 && colNumber <= 9) || colNumber > 12) {
            cell.numFmt = '#,##0'
          }
          if (colNumber === 11) {
            cell.font = {
              name: 'Microsoft YaHei',
              bold: true,
              color: { argb: stockExcelFontColor(row.stock_status) },
            }
          }
          if (colNumber === 12) {
            cell.font = {
              name: 'Microsoft YaHei',
              bold: true,
              color: { argb: agingExcelFontColor(row.aging_status) },
            }
          }
          applyBorder(cell)
        })
      })

      const totalRow = worksheet.getRow(rows.length + 2)
      totalRow.values = [
        '合计',
        '--',
        '--',
        detailTotals.available_qty,
        detailTotals.age_0_90_qty,
        detailTotals.age_91_180_qty,
        detailTotals.age_181_270_qty,
        detailTotals.age_271_365_qty,
        detailTotals.age_365_plus_qty,
        '--',
        '--',
        '--',
        ...shipmentColumns.map((col) => shipmentColumnTotals[col.shipment_no] ?? ''),
      ]
      applyRowBorder(totalRow, 1, columns.length)
      totalRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.font = { name: 'Microsoft YaHei', bold: true, color: { argb: 'FF0F172A' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
        cell.alignment = {
          vertical: 'middle',
          horizontal: (colNumber >= 4 && colNumber <= 9) || colNumber > 12 ? 'right' : 'left',
        }
        if ((colNumber >= 4 && colNumber <= 9) || colNumber > 12) {
          cell.numFmt = '#,##0'
        }
      })

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const safeTimestamp = formatLocalTimestampForFilename()
      const safeProjectName = (selectedProject?.name || '未选项目').replace(/[\\/:*?"<>|]/g, '-')
      const safeCountryLabel = getCountryLabel(country).replace(/[\\/:*?"<>|]/g, '-')
      const filename = `${safeProjectName}_${safeCountryLabel}-库存分析-${safeTimestamp}.xlsx`
      downloadBlob(blob, filename)
      await logClientOperation({
        action: 'inventory_analysis.export',
        targetType: 'inventory_analysis',
        targetId: currentProjectId,
        after: {
          project_id: currentProjectId,
          project_name: projects.find((project) => project.id === currentProjectId)?.name ?? null,
          country,
          row_count: rows.length,
          filename,
        },
      })
    } catch (exportError) {
      notify({
        type: 'error',
        title: '导出 Excel 失败',
        message: exportError instanceof Error ? exportError.message : '导出 Excel 失败',
      })
    } finally {
      setExporting(false)
    }
  }

  const filterControls = (
    <>
      <HeaderSlotSelect
        value={projectId}
        onChange={setProjectId}
        options={projects.map((project) => ({ value: String(project.id), label: project.name }))}
        widthClass={TERM_HEADER_W_MD}
        placeholder="请选择项目"
      />
      <HeaderSlotSelect
        value={country}
        onChange={(value) => setCountry(value as 'US' | 'DE' | 'UK' | 'ALL')}
        options={[
          { value: 'ALL', label: '全部站点' },
          { value: 'US', label: '美国站 (US)' },
          { value: 'DE', label: '德国站 (DE)' },
          { value: 'UK', label: '英国站 (UK)' },
        ]}
        widthClass={TERM_HEADER_W_SM}
      />
      <Select
        value={selectedSnapshotDate}
        onValueChange={setSelectedSnapshotDate}
        open={snapshotSelectOpen}
        onOpenChange={setSnapshotSelectOpen}
      >
        <SelectTrigger className={cn('h-10 w-full border-term-border bg-term-panel text-xs shadow-none', TERM_HEADER_W_LG)}>
          <SelectValue placeholder="选择业务日期" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="current">最新业务日期</SelectItem>
          {snapshotOptions.map((option) => (
            <SelectItem key={option.report_date} value={option.report_date}>
              {formatBusinessDate(option.report_date)}
              {option.is_current ? ' (当前)' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <HeaderSlotBadge title="业务日期">
        <span className="font-mono text-xs uppercase tracking-wider text-term-faint">业务日期</span>
        <span className="truncate font-mono text-xs tabular-nums text-term-text">
          {reportDate ? formatBusinessDate(reportDate) : '--'}
        </span>
      </HeaderSlotBadge>
    </>
  )

  const headerSlotPortal = useHeaderSlot(
    <HeaderFilterControls isMobileView={false} controls={filterControls} />
  )

  // BLF-931 · 移动端：筛选控件下迁为正文顶部可折叠筛选条
  const mobileProjectLabel = projects.find((p) => String(p.id) === projectId)?.name ?? projectId
  const mobileCountryLabel = country === 'ALL' ? '全部站点' : getCountryLabel(country)
  const mobileSnapshotLabel =
    selectedSnapshotDate === 'current'
      ? '最新'
      : selectedSnapshotDate
        ? formatBusinessDate(selectedSnapshotDate)
        : '未选'
  const mobileFilterSummary = `${mobileProjectLabel} · ${mobileCountryLabel} · ${mobileSnapshotLabel}`
  const mobileFilterStrip = useMobileFilterStrip(
    <MobileFilterStrip
      summary={mobileFilterSummary}
      controls={
        <>
          <HeaderSlotSelect
            value={projectId}
            onChange={setProjectId}
            options={projects.map((project) => ({ value: String(project.id), label: project.name }))}
            widthClass="w-full"
            placeholder="请选择项目"
          />
          <HeaderSlotSelect
            value={country}
            onChange={(value) => setCountry(value as 'US' | 'DE' | 'UK' | 'ALL')}
            options={[
              { value: 'ALL', label: '全部站点' },
              { value: 'US', label: '美国站 (US)' },
              { value: 'DE', label: '德国站 (DE)' },
              { value: 'UK', label: '英国站 (UK)' },
            ]}
            widthClass="w-full"
          />
          <MobileFilterWide>
            <Select
              value={selectedSnapshotDate}
              onValueChange={setSelectedSnapshotDate}
              open={snapshotSelectOpen}
              onOpenChange={setSnapshotSelectOpen}
            >
              <SelectTrigger className="h-10 w-full border-term-border bg-term-panel text-xs shadow-none">
                <SelectValue placeholder="选择业务日期" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="current">最新业务日期</SelectItem>
                {snapshotOptions.map((option) => (
                  <SelectItem key={option.report_date} value={option.report_date}>
                    {formatBusinessDate(option.report_date)}
                    {option.is_current ? ' (当前)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </MobileFilterWide>
          <MobileFilterWide>
            <div className="flex h-10 items-center gap-1.5 border border-term-border bg-term-panel px-2">
              <span className="font-mono text-xs uppercase tracking-wider text-term-faint">业务日期</span>
              <span className="truncate font-mono text-xs tabular-nums text-term-text">
                {reportDate ? formatBusinessDate(reportDate) : '--'}
              </span>
            </div>
          </MobileFilterWide>
        </>
      }
    />
  )

  const colCount = 12 + shipmentColumns.length

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* BLF-826 阶段 C：筛选控件已上移 Top Header 中段插槽；页面仅渲染 portal 宿主 */}
      {headerSlotPortal}
      {/* BLF-931：移动端折叠筛选条（正文顶部，md:hidden 挂载点内） */}
      {mobileFilterStrip}

      {/* 统计条：终端磁贴（mono 数值 + 语义色） */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryTile label="SKU 总数" value={summary.sku_count} />
        <SummaryTile label="可售总量" value={summary.total_available_qty} />
        <SummaryTile label="缺货 SKU" value={summary.out_of_stock_count} tone="neg" />
        <SummaryTile label="365+ 库龄" value={summary.total_age_365_plus_qty} tone="neg" />
      </div>

      <TermPanel
        title="库存明细"
        bodyClassName="min-h-0 overflow-hidden"
        actions={
          <HeaderSlotButton variant="muted" onClick={exportToExcel} disabled={exporting || loading || rows.length === 0}>
            {exporting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <FileDown className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
            {exporting ? '导出中...' : '导出 Excel'}
          </HeaderSlotButton>
        }
      >
        {/* 滚动收口在面板内（Canvas 内滚动），表头 sticky */}
        <div className="max-h-[calc(100vh-320px)] min-h-[240px] overflow-auto term-scroll">
          <TermTable>
            <TermTHead>
              <TermRow className="hover:bg-transparent">
                <TermHead>SKU</TermHead>
                <TermHead>ASIN</TermHead>
                <TermHead>品名</TermHead>
                <TermHead numeric>库存</TermHead>
                <TermHead numeric>0-90天</TermHead>
                <TermHead numeric>91-180天</TermHead>
                <TermHead numeric>181-270天</TermHead>
                <TermHead numeric>271-365天</TermHead>
                <TermHead numeric>&gt;365天</TermHead>
                <TermHead>建议操作</TermHead>
                <TermHead>库存状态</TermHead>
                <TermHead>库龄状态</TermHead>
                {shipmentColumns.map((col) => (
                  <TermHead
                    key={col.shipment_no}
                    numeric
                    title={[col.shipment_no, col.eta_date ? `预计 ${col.eta_date.slice(5)} 到港` : '预计到港未知'].join('\n')}
                  >
                    {col.label}
                  </TermHead>
                ))}
              </TermRow>
            </TermTHead>
            <TermBody>
              {loading ? (
                <TermRow className="hover:bg-transparent">
                  <TermCell colSpan={colCount} className="h-24 text-center" tone="muted">
                    <span className="inline-flex items-center justify-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                      正在加载库存数据...
                    </span>
                  </TermCell>
                </TermRow>
              ) : loadError ? (
                <TermRow className="hover:bg-transparent">
                  <TermCell colSpan={colCount} className="h-24 text-center" tone="neg">
                    <span className="inline-flex items-center justify-center gap-2">
                      <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                      {loadError}
                    </span>
                  </TermCell>
                </TermRow>
              ) : rows.length === 0 ? (
                <TermRow className="hover:bg-transparent">
                  <TermCell colSpan={colCount} className="h-24 text-center" tone="muted">
                    当前筛选下暂无库存快照数据
                  </TermCell>
                </TermRow>
              ) : (
                <>
                  {rows.map((row) => (
                    <TermRow key={`${row.sku}::${row.asin || 'na'}`}>
                      <TermCell>{row.sku}</TermCell>
                      <TermCell tone="muted">{row.asin || '--'}</TermCell>
                      <TermCell title={row.product_name || undefined}>
                        {row.product_name || '--'}
                      </TermCell>
                      <TermCell numeric>{formatInt(row.available_qty)}</TermCell>
                      <TermCell numeric>{formatInt(row.age_0_90_qty)}</TermCell>
                      <TermCell numeric>{formatInt(row.age_91_180_qty)}</TermCell>
                      <TermCell numeric>{formatInt(row.age_181_270_qty)}</TermCell>
                      <TermCell numeric>{formatInt(row.age_271_365_qty)}</TermCell>
                      <TermCell
                        numeric
                        tone={row.age_365_plus_qty > 0 ? 'neg' : undefined}
                      >
                        {formatInt(row.age_365_plus_qty)}
                      </TermCell>
                      <TermCell>{row.recommended_action_label || '--'}</TermCell>
                      <TermCell tone={stockTone(row.stock_status)}>
                        {stockStatusLabel(row.stock_status)}
                      </TermCell>
                      <TermCell tone={agingTone(row.aging_status)}>
                        {agingStatusLabel(row.aging_status)}
                      </TermCell>
                      {shipmentColumns.map((col) => {
                        const qty = row.shipment_quantities?.[col.shipment_no]
                        return (
                          <TermCell key={col.shipment_no} numeric>
                            {qty !== undefined ? formatInt(qty) : '--'}
                          </TermCell>
                        )
                      })}
                    </TermRow>
                  ))}
                  <TermRow highlight className="[&>td]:font-semibold [&>td]:bg-term-raised hover:bg-term-raised">
                    <TermCell colSpan={3}>合计</TermCell>
                    <TermCell numeric>{formatInt(detailTotals.available_qty)}</TermCell>
                    <TermCell numeric>{formatInt(detailTotals.age_0_90_qty)}</TermCell>
                    <TermCell numeric>{formatInt(detailTotals.age_91_180_qty)}</TermCell>
                    <TermCell numeric>{formatInt(detailTotals.age_181_270_qty)}</TermCell>
                    <TermCell numeric>{formatInt(detailTotals.age_271_365_qty)}</TermCell>
                    <TermCell numeric tone={detailTotals.age_365_plus_qty > 0 ? 'neg' : undefined}>
                      {formatInt(detailTotals.age_365_plus_qty)}
                    </TermCell>
                    <TermCell colSpan={3} />
                    {shipmentColumns.map((col) => (
                      <TermCell key={col.shipment_no} numeric>
                        {shipmentColumnTotals[col.shipment_no]
                          ? formatInt(shipmentColumnTotals[col.shipment_no])
                          : '--'}
                      </TermCell>
                    ))}
                  </TermRow>
                </>
              )}
            </TermBody>
          </TermTable>
        </div>
      </TermPanel>

      {/* 加载骨架（首次进入 / 项目切换时统计条同步占位） */}
      {projectsLoading && <Skeleton className="hidden h-10 w-full rounded-none" />}
    </div>
  )
}
