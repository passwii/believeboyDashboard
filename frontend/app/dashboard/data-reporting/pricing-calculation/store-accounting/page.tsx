'use client'

import { useState, useEffect } from 'react'
import {
  Calculator,
  Download,
  Loader2,
  Search,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { DataTableCard, DataTableCardBody, DataTableCardStatBar } from '@/components/ui/data-card'
import { cn } from '@/lib/utils'
import { StoreAccountingUsSection } from '@/components/dashboard/pricing-calculation/store-accounting-us-section'
import { StoreAccountingEuSection } from '@/components/dashboard/pricing-calculation/store-accounting-eu-section'
import type { ProjectManageOption, ProductCostItem, StoreAccountingItem } from '@/lib/pricing-calculation-types'
import { logClientOperation } from '@/lib/operation-audit'
import { formatLocalTimestampForFilename } from '@/lib/utils'
import { useNotifications } from '@/components/notifications'

type StoreCountry = 'US' | 'DE' | 'UK'

const COUNTRY_OPTIONS: { value: StoreCountry; label: string; region: 'US' | 'EU' }[] = [
  { value: 'US', label: '美国站', region: 'US' },
  { value: 'DE', label: '德国站', region: 'EU' },
  { value: 'UK', label: '英国站', region: 'EU' },
]

const API_BASE = '/api/backend'

export default function StoreAccountingPage() {
  const { notify } = useNotifications()
  const [selectedCountry, setSelectedCountry] = useState<StoreCountry>('US')

  // Project selection state (lifted from sections)
  const [projects, setProjects] = useState<ProjectManageOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [selectedProjectName, setSelectedProjectName] = useState('')
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const [skuKeyword, setSkuKeyword] = useState('')
  const [exporting, setExporting] = useState(false)

  // Stats state (lifted from sections to render in hero)
  const [statsLoading, setStatsLoading] = useState(false)
  const [stats, setStats] = useState({ total: 0, calculated: 0, profitable: 0, passRate: 0 })

  // Store data for export
  const [storeSkus, setStoreSkus] = useState<ProductCostItem[]>([])
  const [snapshotMap, setSnapshotMap] = useState<Map<string, StoreAccountingItem>>(new Map())

  useEffect(() => {
    async function loadProjects() {
      setProjectsLoading(true)
      try {
        const response = await fetch(`${API_BASE}/api/v1/projects/manage`, { cache: 'no-store' })
        if (!response.ok) throw new Error('项目列表加载失败')
        setProjects(await response.json() as ProjectManageOption[])
      } catch {
        setProjects([])
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [])

  useEffect(() => {
    const project = projects.find((p) => p.name === selectedProjectName)
    setSelectedProjectId(project?.id ?? null)
  }, [selectedProjectName, projects])

  // Load stats when project changes
  useEffect(() => {
    async function loadStats() {
      if (!selectedProjectName || !selectedProjectId) {
        setStats({ total: 0, calculated: 0, profitable: 0, passRate: 0 })
        return
      }
      setStatsLoading(true)
      try {
        const [skuSearch, snapshotSearch] = await Promise.all([
          fetch(
            `${API_BASE}/api/v1/sku-info?project_name=${encodeURIComponent(selectedProjectName)}&country=${selectedCountry}&is_active=true&page=1&page_size=200&include_total=true`,
            { cache: 'no-store' },
          ),
          fetch(
            `${API_BASE}/api/v1/store-accounting?project_id=${selectedProjectId}&country=${selectedCountry}&page=1&page_size=200`,
            { cache: 'no-store' },
          ),
        ])

        let skus: ProductCostItem[] = []
        if (skuSearch.ok) {
          const payload = await skuSearch.json() as { items: ProductCostItem[] }
          skus = payload.items.filter((item) => item.country === selectedCountry && item.is_active)
        }
        setStoreSkus(skus)

        let snapMap = new Map<string, StoreAccountingItem>()
        if (snapshotSearch.ok) {
          const payload = await snapshotSearch.json() as { items?: StoreAccountingItem[] }
          for (const s of payload.items ?? []) {
            snapMap.set(s.sku, s)
          }
        }
        setSnapshotMap(snapMap)

        const total = skus.length
        const calculated = skus.filter((i) => snapMap.has(i.sku)).length
        const profitable = skus.filter((i) => {
          const s = snapMap.get(i.sku)
          if (!s) return false
          const profit = selectedCountry === 'US' ? s.profit?.profit_usd : (s.profit?.profit_after_vat_usd ?? s.profit?.profit_usd)
          return profit !== undefined && profit >= 0
        }).length
        const passRate = calculated > 0 ? (profitable / calculated) * 100 : 0
        setStats({ total, calculated, profitable, passRate })
      } catch {
        setStats({ total: 0, calculated: 0, profitable: 0, passRate: 0 })
      } finally {
        setStatsLoading(false)
      }
    }
    void loadStats()
  }, [selectedProjectName, selectedProjectId, selectedCountry])

  const hasCalculatedRows = stats.calculated > 0

  // Column number helper (supports AA, AB, ...)
  function colToNum(colLetter: string): number {
    let n = 0
    for (let i = 0; i < colLetter.length; i++) {
      n = n * 26 + (colLetter.charCodeAt(i) - 64)
    }
    return n
  }

  // ── Export handler ────────────────────────────────────────────────────────────
  async function handleExport() {
    const itemsWithResults = storeSkus.filter((i) => snapshotMap.has(i.sku))
    if (itemsWithResults.length === 0) {
      notify({ type: 'error', title: '没有可导出的数据' })
      return
    }
    setExporting(true)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      const countryLabel = selectedCountry === 'US' ? '美国' : selectedCountry === 'DE' ? '德国' : '英国'
      const isUS = selectedCountry === 'US'
      const colCount = isUS ? 28 : 25

      const ddpCurrency = selectedCountry === 'DE' ? 'EUR' : selectedCountry === 'UK' ? 'GBP' : 'USD'
      const saleCurrency = ddpCurrency

      const groups = isUS
        ? [
            { name: '店铺产品', start: 1,  end: 1,  dark: 'FF312E81', sub: 'FFE0E7FF' },
            { name: '货品数据', start: 2,  end: 7,  dark: 'FF0C4A6E', sub: 'FFE0F2FE' },
            { name: 'DDP成本',  start: 8,  end: 11, dark: 'FF78350F', sub: 'FFFEF3C7' },
            { name: '费用支出', start: 12, end: 22, dark: 'FF881337', sub: 'FFFFE4E6' },
            { name: '利润核算', start: 23, end: 26, dark: 'FF064E3B', sub: 'FFD1FAE5' },
            { name: '产品核定', start: 27, end: 28, dark: 'FF4C1D95', sub: 'FFEDE9FE' },
          ]
        : [
            { name: '店铺产品', start: 1,  end: 1,  dark: 'FF312E81', sub: 'FFE0E7FF' },
            { name: '货品数据', start: 2,  end: 8,  dark: 'FF0C4A6E', sub: 'FFE0F2FE' },
            { name: 'DDP成本',  start: 9,  end: 12, dark: 'FF78350F', sub: 'FFFEF3C7' },
            { name: '费用支出', start: 13, end: 21, dark: 'FF881337', sub: 'FFFFE4E6' },
            { name: '利润核算', start: 22, end: 25, dark: 'FF064E3B', sub: 'FFD1FAE5' },
          ]

      const worksheet = workbook.addWorksheet(`${countryLabel}店铺SKU核算`)
      worksheet.views = [{ showGridLines: false }]

      // Default border style used throughout
      const BORDER = {
        top:    { style: 'thin' as const, color: { argb: 'FFD0D5DD' } },
        left:   { style: 'thin' as const, color: { argb: 'FFD0D5DD' } },
        bottom: { style: 'thin' as const, color: { argb: 'FFD0D5DD' } },
        right:  { style: 'thin' as const, color: { argb: 'FFD0D5DD' } },
      }

      // Row 1: title
      worksheet.mergeCells(1, 1, 1, colCount)
      const titleCell = worksheet.getCell(1, 1)
      titleCell.value = `${countryLabel}店铺SKU核算表 - ${selectedProjectName}`
      titleCell.font = { name: 'Microsoft YaHei', size: 14, bold: true }
      titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }
      worksheet.getRow(1).height = 24
      for (let c = 1; c <= colCount; c++) {
        worksheet.getCell(1, c).border = BORDER
      }

      // Row 2: group header labels
      const groupHeaderRow = worksheet.addRow(groups.map(() => null))
      groupHeaderRow.height = 20
      groups.forEach((g) => {
        const cell = groupHeaderRow.getCell(g.start)
        cell.value = g.name
        cell.font = { name: 'Microsoft YaHei', size: 10, bold: true, color: { argb: 'FFFFFFFF' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: g.dark } }
        cell.alignment = { horizontal: 'center', vertical: 'middle' }
        cell.border = BORDER
        if (g.end > g.start) {
          worksheet.mergeCells(2, g.start, 2, g.end)
        }
      })

      // Row 3: column headers
      const usHeaders = [
        'SKU', 'FOB(RMB)', '长', '宽', '高', '重量(kg)', '计费重',
        '头程(RMB)', 'DDP(RMB)', 'DDP(USD)', '汇率',
        '售价(USD)', '广告费率%', '广告费', '退货折损率%', '退货损耗',
        '佣金', '派送费', '配置费', '仓储月数', '仓储费',
        '费用合计', '回款', '利润', '利润率',
        '尺寸等级', '售价带', '规则',
      ]
      const euHeaders = [
        'SKU', 'FOB(RMB)', '长', '宽', '高', '重量(kg)', '计费重',
        '头程(RMB)', 'DDP(RMB)', `DDP(${ddpCurrency})`, '汇率',
        `售价(${saleCurrency})`, '广告费率%', '广告费', '退货损耗',
        '派送费', '配置费', '仓储费', '费用合计',
        '回款', '增值税', '利润(扣税后)', '利润率(扣税)',
      ]
      const headers = isUS ? usHeaders : euHeaders

      const headerRow = worksheet.addRow(headers)
      headerRow.height = 20
      headerRow.font = { name: 'Microsoft YaHei', size: 9, bold: true }
      headerRow.alignment = { horizontal: 'center', vertical: 'middle' }
      headerRow.eachCell({ includeEmpty: true }, (cell) => {
        const colNum = colToNum(cell.address.replace(/\d+$/, ''))
        const group = groups.find((g) => colNum >= g.start && colNum <= g.end)
        if (group) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: group.sub } }
        }
        cell.border = BORDER
      })

      const LEFT_COLS  = isUS ? new Set([1, 28])           : new Set([1])
      const CENTER_COLS = isUS ? new Set([22, 23, 24, 25, 26, 27]) : new Set([22, 23, 24, 25])

      // Build data rows
      const dataRows = itemsWithResults.map((item) => {
        const s = snapshotMap.get(item.sku)!
        const chargeableWeight = Math.max(
          item.weight_kg,
          (item.package_length_cm * item.package_width_cm * item.package_height_cm) / 6000,
        )
        if (isUS) {
          return [
            item.sku,
            item.fob_unit_cost,
            item.package_length_cm,
            item.package_width_cm,
            item.package_height_cm,
            item.weight_kg,
            chargeableWeight,
            item.first_leg_cost_rmb,
            s.profit.ddp_cost_rmb,
            s.profit.ddp_cost_usd,
            s.usd_to_rmb_rate,
            s.sale_price_usd,
            s.advertising_rate * 100,
            s.fees.advertising_fee_usd,
            (s.return_loss_rate ?? 0) * 100,
            s.fees.return_loss_usd,
            s.fees.referral_fee_usd,
            s.fees.fba_fulfillment_fee_usd,
            s.fees.inbound_config_fee_usd,
            s.storage_months,
            s.fees.storage_fee_usd,
            s.fees.total_fee_usd,
            s.profit.payout_usd,
            s.profit.profit_usd,
            s.profit.profit_rate,
            s.size_tier_label,
            s.price_band_label,
            `${s.fulfillment_fee_rule_label} / ${s.inbound_config_fee_rule_label} / ${s.storage_fee_rule_label}`,
          ]
        } else {
          const profitAfterVat = s.profit.profit_after_vat_usd ?? s.profit.profit_usd
          const profitRateAfterVat = s.profit.profit_after_vat_rate ?? s.profit.profit_rate
          return [
            item.sku,
            item.fob_unit_cost,
            item.package_length_cm,
            item.package_width_cm,
            item.package_height_cm,
            item.weight_kg,
            chargeableWeight,
            item.first_leg_cost_rmb,
            s.profit.ddp_cost_rmb,
            s.profit.ddp_cost_usd,
            s.usd_to_rmb_rate,
            s.sale_price_usd,
            s.advertising_rate * 100,
            s.fees.advertising_fee_usd,
            s.fees.return_loss_usd,
            s.fees.delivery_fee_usd ?? 0,
            s.fees.inbound_config_fee_usd,
            s.fees.storage_fee_usd,
            s.fees.total_fee_usd,
            s.profit.payout_usd,
            s.profit.vat_usd ?? 0,
            profitAfterVat,
            profitRateAfterVat,
          ]
        }
      })

      // Write data rows with styling
      dataRows.forEach((rowData, idx) => {
        const row = worksheet.addRow(rowData)
        row.height = 20
        const isOdd = idx % 2 === 0
        const bgColor = isOdd ? 'FFF8FAFC' : 'FFFFFFFF'

        row.eachCell({ includeEmpty: true }, (cell) => {
          const colNum = colToNum(cell.address.replace(/\d+$/, ''))
          const val = rowData[colNum - 1]
          const num = Number(val)

          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } }
          cell.font = { name: 'Microsoft YaHei', size: 9 }
          cell.border = BORDER

          cell.alignment = { horizontal: 'center', vertical: 'middle' }

          // Profit / profit rate columns: apply percentage format to rate, color to both
          const isProfitRateCol = (isUS && colNum === 25) || (!isUS && colNum === 23)
          const isProfitCol = (isUS && (colNum === 24 || colNum === 25)) ||
                              (!isUS && (colNum === 22 || colNum === 23))
          if (isProfitRateCol) {
            cell.numFmt = '0.00%'
          } else if (Number.isFinite(num)) {
            if (Number.isInteger(num)) {
              cell.numFmt = '#,##0'
            } else {
              cell.numFmt = '#,##0.00'
            }
          }
          if (isProfitCol) {
            if (num >= 0) {
              cell.font = { name: 'Microsoft YaHei', size: 9, color: { argb: 'FF16A34A' } }
            } else {
              cell.font = { name: 'Microsoft YaHei', size: 9, color: { argb: 'FFDC2626' } }
            }
          }
        })
      })

      // Auto-fit column widths via openpyxl column_dimensions
      const colWidths: number[] = Array.from({ length: colCount }, () => 0)
      const measureText = (text: string, size = 9): number => {
        const chars = String(text ?? '').length
        return Math.max(chars * size * 0.6 + size * 0.2, size)
      }
      worksheet.eachRow({ includeEmpty: true }, (excelRow) => {
        excelRow.eachCell({ includeEmpty: true }, (cell) => {
          const colNum = colToNum(cell.address.replace(/\d+$/, ''))
          if (colNum >= 1 && colNum <= colCount) {
            const w = measureText(String(cell.value ?? ''))
            if (w > colWidths[colNum - 1]) colWidths[colNum - 1] = w
          }
        })
      })
      for (let i = 0; i < colCount; i++) {
        worksheet.getColumn(i + 1).width = Math.max(colWidths[i] * 0.12, 4)
      }

      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${countryLabel}店铺SKU核算-${selectedProjectName}-${formatLocalTimestampForFilename()}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)

      await logClientOperation({
        action: 'pricing_calculation.store_table.export',
        targetType: 'store_sku_pricing_snapshot',
        targetId: selectedProjectId ?? undefined,
        after: { project_id: selectedProjectId, project_name: selectedProjectName, country: selectedCountry, row_count: itemsWithResults.length },
      })
    } catch (err) {
      notify({ type: 'error', title: '导出失败', message: err instanceof Error ? err.message : '导出失败' })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className='dashboard-page-shell space-y-6'>
      {/* Card 1: 控制台 */}
      <div className='animate-enter'>
        <div className='dashboard-surface relative overflow-hidden'>
          {/* Decorative background gradient */}
          <div className='pointer-events-none absolute inset-0 opacity-60 dark:opacity-40'>
            <div className='absolute inset-0 bg-gradient-to-br from-blue-500/6 via-transparent to-amber-500/5' />
            <div className='absolute -right-16 -top-16 h-56 w-56 rounded-full bg-[hsl(var(--primary)/0.06)] blur-3xl' />
          </div>

          <div className='relative z-10 flex flex-col gap-0 px-6 py-4'>
            {/* Top Row: Icon + Title */}
            <div className='flex items-center gap-3'>
              <div className='flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--primary)/0.1)]'>
                <Calculator className='h-5 w-5 text-[hsl(var(--primary))]' strokeWidth={2} />
              </div>
              <div className='min-w-0'>
                <h1 className='text-[1.15rem] font-semibold tracking-tight text-foreground'>
                  控制台
                </h1>
              </div>
            </div>

            {/* Divider */}
            <div className='mt-4 mb-4 h-px bg-border/60' />

            {/* Bottom Row: Three Modules + Country Switch */}
            <div className='flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between'>
              {/* Left: 项目 + 搜索 SKU + 导出 Excel */}
              <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-3'>
                {/* Module 1: 项目 */}
                <div className='flex min-w-0 flex-col gap-2'>
                  <span className='text-xs font-semibold text-muted-foreground uppercase tracking-wide'>项目</span>
                  {projectsLoading ? (
                    <Skeleton className='h-9 w-full' />
                  ) : (
                    <Select value={selectedProjectName} onValueChange={setSelectedProjectName}>
                      <SelectTrigger className='h-9 text-xs'>
                        <SelectValue placeholder='选择项目' />
                      </SelectTrigger>
                      <SelectContent>
                        {projects.map((p) => (
                          <SelectItem key={p.id} value={p.name} className='text-xs'>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>

                {/* Module 2: 搜索 SKU */}
                <div className='flex min-w-0 flex-col gap-2'>
                  <span className='text-xs font-semibold text-muted-foreground uppercase tracking-wide'>搜索 SKU</span>
                  <div className='relative'>
                    <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground' />
                    <Input
                      value={skuKeyword}
                      onChange={(e) => setSkuKeyword(e.target.value)}
                      placeholder='SKU / ASIN'
                      className='h-9 pl-8 text-xs'
                    />
                  </div>
                </div>

                {/* Module 3: 导出 Excel */}
                <div className='flex min-w-0 flex-col gap-2'>
                  <span className='text-xs font-semibold text-muted-foreground uppercase tracking-wide'>导出 Excel</span>
                  <Button
                    variant='outline'
                    onClick={handleExport}
                    disabled={exporting || !hasCalculatedRows}
                    className='h-9 text-xs'
                  >
                    {exporting ? (
                      <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                    ) : (
                      <Download className='mr-1.5 h-3.5 w-3.5' />
                    )}
                    导出 Excel
                  </Button>
                </div>
              </div>

              {/* Right: 站点 */}
              <div className='flex min-w-0 flex-col gap-2 sm:flex-shrink-0'>
                <span className='text-xs font-semibold text-muted-foreground uppercase tracking-wide'>站点</span>
                <div
                  className='flex h-9 min-h-touch w-full items-stretch rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] p-px sm:w-48'
                  role='group'
                  aria-label='选择站点'
                >
                  {COUNTRY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setSelectedCountry(opt.value)}
                      className={cn(
                        'flex h-full min-h-[calc(44px-2px)] min-w-0 flex-1 items-center justify-center rounded-md px-1.5 text-center text-xs font-semibold whitespace-nowrap transition-all duration-[160ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]/40',
                        selectedCountry === opt.value
                          ? opt.region === 'US'
                            ? 'bg-[hsl(var(--primary))] text-primary-foreground shadow-sm'
                            : 'bg-[hsl(var(--chart-3)/0.85)] text-amber-950 dark:text-amber-100 shadow-sm'
                          : 'text-muted-foreground hover:bg-[hsl(var(--accent))] hover:text-foreground',
                      )}
                      aria-pressed={selectedCountry === opt.value}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Card 2: DataTableCard with Stats */}
      <div className='animate-fade-slide-up'>
        <DataTableCard>
          <DataTableCardStatBar
            items={[
              {
                label: 'SKU',
                value: statsLoading ? <Skeleton className='h-6 w-8' /> : <span className='text-sm font-semibold tabular-nums text-foreground'>{stats.total}</span>,
              },
              {
                label: '已测算',
                value: statsLoading ? <Skeleton className='h-6 w-8' /> : (
                  <span className={cn('text-sm font-semibold tabular-nums', stats.calculated > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground')}>{stats.calculated}</span>
                ),
              },
              {
                label: '盈利',
                value: statsLoading ? <Skeleton className='h-6 w-8' /> : (
                  <span className={cn('text-sm font-semibold tabular-nums', stats.profitable > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground')}>{stats.profitable}</span>
                ),
              },
              {
                label: '盈利占比',
                value: statsLoading ? <Skeleton className='h-6 w-8' /> : (
                  <span className={cn(
                    'text-sm font-semibold tabular-nums',
                    !hasCalculatedRows ? 'text-foreground' : stats.passRate >= 50 ? 'text-emerald-600 dark:text-emerald-400' : stats.passRate >= 25 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400'
                  )}>{hasCalculatedRows ? `${stats.passRate.toFixed(1)}%` : '—'}</span>
                ),
              },
            ]}
          />
          <DataTableCardBody>
            {selectedCountry === 'US' ? (
              <StoreAccountingUsSection
                selectedCountry={selectedCountry}
                selectedProjectName={selectedProjectName}
                selectedProjectId={selectedProjectId}
                skuKeyword={skuKeyword}
                onProjectChange={setSelectedProjectName}
                onSkuKeywordChange={setSkuKeyword}
              />
            ) : (
              <StoreAccountingEuSection
                selectedCountry={selectedCountry}
                projects={projects}
                projectsLoading={projectsLoading}
                selectedProjectName={selectedProjectName}
                selectedProjectId={selectedProjectId}
                skuKeyword={skuKeyword}
                onProjectChange={setSelectedProjectName}
                onSkuKeywordChange={setSkuKeyword}
              />
            )}
          </DataTableCardBody>
        </DataTableCard>
      </div>
    </div>
  )
}
