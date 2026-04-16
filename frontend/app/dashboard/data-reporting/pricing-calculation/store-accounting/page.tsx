'use client'

import { useState, useEffect } from 'react'
import {
  Calculator,
  Download,
  Globe,
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

  // Export handler
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
      const worksheet = workbook.addWorksheet(`${countryLabel}店铺SKU核算`)

      worksheet.mergeCells(1, 1, 1, 20)
      const titleCell = worksheet.getCell(1, 1)
      titleCell.value = `${countryLabel}店铺SKU核算表 - ${selectedProjectName}`
      titleCell.font = { name: 'Microsoft YaHei', size: 14, bold: true }
      titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }

      const headers = [
        'SKU', '项目', 'FOB(RMB)', '长', '宽', '高', '重量(kg)', '计费重',
        '头程(RMB)', 'DDP(RMB)', 'DDP(USD)', '汇率',
        '售价(USD)', '广告费率%', '广告费', '退货损耗',
        '佣金', '派送费', '配置费', '仓储月数', '仓储费',
        '费用合计', '回款', '利润', '利润率',
        '尺寸等级', '售价带', '规则',
      ]
      const headerRow = worksheet.addRow(headers)
      headerRow.font = { name: 'Microsoft YaHei', bold: true }
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCBD5E1' } }

      itemsWithResults.forEach((item) => {
        const snapshot = snapshotMap.get(item.sku)!
        const row = worksheet.addRow([
          item.sku, item.project_name, item.fob_unit_cost,
          item.package_length_cm, item.package_width_cm, item.package_height_cm, item.weight_kg,
          Math.max(item.weight_kg, (item.package_length_cm * item.package_width_cm * item.package_height_cm) / 6000),
          item.first_leg_cost_rmb,
          snapshot.profit.ddp_cost_rmb, snapshot.profit.ddp_cost_usd, snapshot.usd_to_rmb_rate,
          snapshot.sale_price_usd,
          snapshot.advertising_rate * 100,
          snapshot.fees.advertising_fee_usd, snapshot.fees.return_loss_usd,
          snapshot.fees.referral_fee_usd, snapshot.fees.fba_fulfillment_fee_usd,
          snapshot.fees.inbound_config_fee_usd,
          snapshot.storage_months,
          snapshot.fees.storage_fee_usd,
          snapshot.fees.total_fee_usd, snapshot.profit.payout_usd,
          snapshot.profit.profit_usd, snapshot.profit.profit_rate,
          snapshot.size_tier_label, snapshot.price_band_label,
          `${snapshot.fulfillment_fee_rule_label} / ${snapshot.inbound_config_fee_rule_label} / ${snapshot.storage_fee_rule_label}`,
        ])
        row.font = { name: 'Microsoft YaHei' }
      })

      worksheet.columns = headers.map(() => ({ width: 14 }))
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
        after: { project_id: selectedProjectId, project_name: selectedProjectName, row_count: itemsWithResults.length },
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

          <div className='relative z-10 flex flex-col gap-4 px-6 py-4'>
            {/* Top: Title */}
            <div className='flex min-w-0 items-center gap-3'>
              <div className='flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--primary)/0.1)]'>
                <Calculator className='h-5 w-5 text-[hsl(var(--primary))]' strokeWidth={2} />
              </div>
              <div className='min-w-0'>
                <h1 className='text-[1.15rem] font-semibold tracking-tight text-foreground'>
                  控制台
                </h1>
              </div>
            </div>

            {/* Bottom: Filters + Actions */}
            <div className='flex flex-wrap items-end gap-3'>
              {/* Left: Project + SKU Search + Export */}
              <div className='flex flex-wrap items-end gap-3'>
                {/* Project selector */}
                <div className='flex flex-col gap-1'>
                  <Label className='dashboard-kicker h-4 leading-4'>项目</Label>
                  {projectsLoading ? (
                    <Skeleton className='h-8 w-[180px]' />
                  ) : (
                    <Select value={selectedProjectName} onValueChange={setSelectedProjectName}>
                      <SelectTrigger className='h-8 w-[180px] text-xs'>
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

                {/* SKU search */}
                <div className='flex flex-col gap-1'>
                  <Label className='dashboard-kicker h-4 leading-4'>搜索 SKU</Label>
                  <div className='relative'>
                    <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground' />
                    <Input
                      value={skuKeyword}
                      onChange={(e) => setSkuKeyword(e.target.value)}
                      placeholder='SKU / ASIN'
                      className='h-8 w-[180px] pl-8 text-xs'
                    />
                  </div>
                </div>

                {/* Export button */}
                <Button
                  variant='outline'
                  onClick={handleExport}
                  disabled={exporting || !hasCalculatedRows}
                  className='h-8 w-[100px] text-xs'
                >
                  {exporting ? (
                    <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                  ) : (
                    <Download className='mr-1.5 h-3.5 w-3.5' />
                  )}
                  导出 Excel
                </Button>
              </div>

              {/* Right: Country Switch */}
              <div className='ml-auto flex items-center gap-3'>
                <Globe className='h-3.5 w-3.5 flex-shrink-0 text-muted-foreground' />
                <div
                  className='inline-flex rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] p-0.5'
                  role='group'
                  aria-label='选择站点'
                >
                  {COUNTRY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => {
                        setSelectedCountry(opt.value)
                        setSelectedProjectName('')
                      }}
                      className={cn(
                        'rounded-md px-3 py-1.5 text-xs font-semibold transition-all duration-[160ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]/40',
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
