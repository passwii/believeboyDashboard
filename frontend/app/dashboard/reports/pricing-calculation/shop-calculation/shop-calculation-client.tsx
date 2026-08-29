'use client'

import { useState, useEffect, useCallback } from 'react'
import { Calculator, Download, Loader2, Search } from 'lucide-react'
import { useSession } from 'next-auth/react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

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
import { RefreshProgressBar } from '@/components/ui/refresh-progress-bar'
import { cn } from '@/lib/utils'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { useSmoothRefresh } from '@/hooks/use-smooth-refresh'
import { ShopCalculationUsSection } from '@/components/dashboard/pricing-calculation/shop-calculation-us-section'
import { ShopCalculationEuSection } from '@/components/dashboard/pricing-calculation/shop-calculation-eu-section'
import {
  PricingSnapshotSelector,
  type PricingSnapshotOption,
} from '@/components/dashboard/pricing-calculation/snapshot-selector'
import { CreatePricingSnapshotDialog } from '@/components/dashboard/pricing-calculation/create-snapshot-dialog'
import { EditPricingSnapshotDialog } from '@/components/dashboard/pricing-calculation/edit-snapshot-dialog'
import type {
  ProjectManageOption,
  ProductCostItem,
  ShopCalculationItem,
} from '@/lib/pricing-calculation-types'
import { logClientOperation } from '@/lib/operation-audit'
import { formatLocalTimestampForFilename } from '@/lib/utils'
import { getCountryLabel } from '@/lib/country'
import { useUrlParam } from '@/lib/hooks/use-url-param'
import { useNotifications } from '@/components/notifications'

type StoreCountry = 'US' | 'DE' | 'UK'

const COUNTRY_OPTIONS: { value: StoreCountry; label: string; region: 'US' | 'EU' }[] = [
  { value: 'US', label: '美国站', region: 'US' },
  { value: 'DE', label: '德国站', region: 'EU' },
  { value: 'UK', label: '英国站', region: 'EU' },
]

const API_BASE = '/api/backend'

export default function ShopCalculationPage() {
  const { notify } = useNotifications()
  const { data: session } = useSession()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const isAdmin = Boolean(session?.user?.isAdmin)
  // 国家站点 / 选中项目 同步到 URL search param，刷新 / 分享链接 / 浏览器后退都能记住。
  // selectedProjectId 在 URL 里以字符串形式存储（'42' 或 '' 代表 null），读取时再转回 number | null。
  const [selectedCountry, setSelectedCountry] = useUrlParam<StoreCountry>('country', 'US', {
    allowed: ['US', 'DE', 'UK'],
  })
  const [projectIdRaw, setProjectIdRaw] = useUrlParam<string>('project', '')
  const selectedProjectId: number | null = projectIdRaw ? Number(projectIdRaw) : null
  const setSelectedProjectId = (id: number | null) => {
    setProjectIdRaw(id == null ? '' : String(id))
  }
  // Project selection state (lifted from sections)
  const [projects, setProjects] = useState<ProjectManageOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [selectedProjectName, setSelectedProjectName] = useState('')
  const [skuKeyword, setSkuKeyword] = useState('')
  const [exporting, setExporting] = useState(false)

  // Stats state (lifted from sections to render in hero)
  const [statsLoading, setStatsLoading] = useState(false)
  const [stats, setStats] = useState({ total: 0, calculated: 0, profitable: 0, passRate: 0 })

  // ── Pricing history snapshot state ─────────────────────────────────────────
  // selectedSnapshotId 与 URL ?snapshot=<id> 双向同步：
  // - URL 是单一真理之源（与 project / country 一致）
  // - null/0/非法值 → 回退到 "实时数据" 模式
  const rawSnapshotId = searchParams.get('snapshot') ?? ''
  const selectedSnapshotId: number | null =
    rawSnapshotId && Number.isFinite(Number(rawSnapshotId)) && Number(rawSnapshotId) > 0
      ? Number(rawSnapshotId)
      : null
  const [snapshotRefreshNonce, setSnapshotRefreshNonce] = useState(0)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editingSnapshot, setEditingSnapshot] = useState<PricingSnapshotOption | null>(null)

  const setSelectedSnapshotId = useCallback(
    (next: number | null) => {
      const params = new URLSearchParams(searchParams.toString())
      if (next == null || next <= 0) {
        params.delete('snapshot')
      } else {
        params.set('snapshot', String(next))
      }
      const qs = params.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [searchParams, router, pathname]
  )

  // 切换项目 / 站点时，自动退出快照模式（避免历史快照与新项目错配）
  useEffect(() => {
    if (selectedSnapshotId !== null) {
      setSelectedSnapshotId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, selectedCountry])

  // Store data for export (US)
  const [storeSkus, setStoreSkus] = useState<ProductCostItem[]>([])
  const [snapshotMap, setSnapshotMap] = useState<Map<string, ShopCalculationItem>>(new Map())
  // Latest storeRows from US section (updated on every calculation)
  const [usStoreRows, setUsStoreRows] = useState<
    Record<
      number,
      {
        draft: Record<string, string>
        result: import('@/lib/pricing-calculation-types').PricingCalculationRunItem | null
      }
    >
  >({})

  // Store data for export (EU)
  const [euStoreSkus, setEuStoreSkus] = useState<ProductCostItem[]>([])
  const [euStoreRows, setEuStoreRows] = useState<
    Record<
      number,
      {
        draft: Record<string, string>
        result: import('@/lib/pricing-calculation-types').PricingCalculationRunItem | null
      }
    >
  >({})
  const [hasEuCalculatedRows, setHasEuCalculatedRows] = useState(false)

  useEffect(() => {
    async function loadProjects() {
      setProjectsLoading(true)
      try {
        // 复用 projects/manage 2min 客户端缓存（BEL-424）：跨页共享项目列表。
        const data = await fetchManagedProjectsCached<ProjectManageOption[]>(session)
        setProjects(Array.isArray(data) ? data : [])
      } catch {
        setProjects([])
      } finally {
        setProjectsLoading(false)
      }
    }
    void loadProjects()
  }, [session])

  useEffect(() => {
    const project = projects.find((p) => p.name === selectedProjectName)
    setSelectedProjectId(project?.id ?? null)
  }, [selectedProjectName, projects])

  // Load stats when project / country / snapshot changes
  useEffect(() => {
    async function loadStats() {
      if (!selectedProjectName || !selectedProjectId) {
        setStats({ total: 0, calculated: 0, profitable: 0, passRate: 0 })
        return
      }
      setStatsLoading(true)
      try {
        // ── 快照模式：直接取快照明细 + summary ────────────────────────────
        if (selectedSnapshotId !== null) {
          const snapshotResponse = await fetch(
            `${API_BASE}/api/v1/pricing-calculation-snapshots/${selectedSnapshotId}/items`,
            { cache: 'no-store' }
          )
          if (snapshotResponse.ok) {
            const payload = (await snapshotResponse.json()) as {
              items: ShopCalculationItem[]
              summary: { total: number; calculated: number; profitable: number; passRate: number }
            }
            const snapMap = new Map<string, ShopCalculationItem>()
            for (const item of payload.items ?? []) {
              snapMap.set(item.sku, item)
            }
            setSnapshotMap(snapMap)
            setStoreSkus([]) // 快照模式下不显示当前 SKU 列表
            setStats(payload.summary ?? { total: 0, calculated: 0, profitable: 0, passRate: 0 })
          } else {
            // 快照拉取失败（可能快照已删除），回退实时
            notify({ type: 'error', title: '快照加载失败，已切换回实时数据' })
            setSelectedSnapshotId(null)
            setSnapshotMap(new Map())
            setStats({ total: 0, calculated: 0, profitable: 0, passRate: 0 })
          }
          return
        }

        // ── 实时模式：拉 SKU 列表 + 当前态快照 ─────────────────────────────
        const [skuSearch, snapshotSearch] = await Promise.all([
          fetch(
            `${API_BASE}/api/v1/sku-info?project_name=${encodeURIComponent(selectedProjectName)}&country=${selectedCountry}&is_active=true&page=1&page_size=200&include_total=true`,
            { cache: 'no-store' }
          ),
          fetch(
            `${API_BASE}/api/v1/shop-calculation?project_id=${selectedProjectId}&country=${selectedCountry}&page=1&page_size=200`,
            { cache: 'no-store' }
          ),
        ])

        let skus: ProductCostItem[] = []
        if (skuSearch.ok) {
          const payload = (await skuSearch.json()) as { items: ProductCostItem[] }
          skus = payload.items.filter((item) => item.country === selectedCountry && item.is_active)
        }
        setStoreSkus(skus)

        let snapMap = new Map<string, ShopCalculationItem>()
        if (snapshotSearch.ok) {
          const payload = (await snapshotSearch.json()) as { items?: ShopCalculationItem[] }
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
          const profit =
            selectedCountry === 'US'
              ? s.profit?.profit_usd
              : (s.profit?.profit_after_vat_usd ?? s.profit?.profit_usd)
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
    // notify / setSelectedSnapshotId 是稳定的 setter，不需要列入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectName, selectedProjectId, selectedCountry, selectedSnapshotId])

  const isUS = selectedCountry === 'US'
  const hasCalculatedRows = isUS
    ? Object.values(usStoreRows).some((r) => r.result != null)
    : hasEuCalculatedRows

  // Smooth refresh: keep previous stats visible while reloading
  const { showSkeleton, isRefreshing } = useSmoothRefresh({
    loading: statsLoading,
    hasData: stats.total > 0,
  })

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
    // 获取有结果的数据项
    let itemsWithResults: ProductCostItem[] = []
    if (isUS) {
      itemsWithResults = storeSkus.filter((i) => usStoreRows[i.id]?.result != null)
    } else {
      itemsWithResults = euStoreSkus.filter((i) => euStoreRows[i.id]?.result != null)
    }

    if (itemsWithResults.length === 0) {
      notify({ type: 'error', title: '没有可导出的数据' })
      return
    }
    setExporting(true)
    try {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      const countryLabel =
        selectedCountry === 'US' ? '美国' : selectedCountry === 'DE' ? '德国' : '英国'
      const isUS = selectedCountry === 'US'
      const colCount = isUS ? 28 : 25

      const ddpCurrency =
        selectedCountry === 'DE' ? 'EUR' : selectedCountry === 'UK' ? 'GBP' : 'USD'
      const saleCurrency = ddpCurrency

      const groups = isUS
        ? [
            { name: '店铺产品', start: 1, end: 1, dark: 'FF312E81', sub: 'FFE0E7FF' },
            { name: '货品数据', start: 2, end: 7, dark: 'FF0C4A6E', sub: 'FFE0F2FE' },
            { name: 'DDP成本', start: 8, end: 11, dark: 'FF78350F', sub: 'FFFEF3C7' },
            { name: '费用支出', start: 12, end: 22, dark: 'FF881337', sub: 'FFFFE4E6' },
            { name: '利润核算', start: 23, end: 26, dark: 'FF064E3B', sub: 'FFD1FAE5' },
            { name: '产品核定', start: 27, end: 28, dark: 'FF4C1D95', sub: 'FFEDE9FE' },
          ]
        : [
            { name: '店铺产品', start: 1, end: 1, dark: 'FF312E81', sub: 'FFE0E7FF' },
            { name: '货品数据', start: 2, end: 7, dark: 'FF0C4A6E', sub: 'FFE0F2FE' },
            { name: 'DDP成本', start: 8, end: 11, dark: 'FF78350F', sub: 'FFFEF3C7' },
            { name: '费用支出', start: 12, end: 21, dark: 'FF881337', sub: 'FFFFE4E6' },
            { name: '利润核算', start: 22, end: 25, dark: 'FF064E3B', sub: 'FFD1FAE5' },
          ]

      const worksheet = workbook.addWorksheet(`${countryLabel}店铺SKU测算`)
      worksheet.views = [{ showGridLines: false }]

      // Default border style used throughout
      const BORDER = {
        top: { style: 'thin' as const, color: { argb: 'FFD0D5DD' } },
        left: { style: 'thin' as const, color: { argb: 'FFD0D5DD' } },
        bottom: { style: 'thin' as const, color: { argb: 'FFD0D5DD' } },
        right: { style: 'thin' as const, color: { argb: 'FFD0D5DD' } },
      }

      // Row 1: title
      worksheet.mergeCells(1, 1, 1, colCount)
      const titleCell = worksheet.getCell(1, 1)
      titleCell.value = `${countryLabel}店铺SKU测算表 - ${selectedProjectName}`
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
        'SKU',
        'FOB(RMB)',
        '长',
        '宽',
        '高',
        '重量(kg)',
        '计费重',
        '头程(RMB)',
        'DDP(RMB)',
        'DDP(USD)',
        '汇率',
        '售价(USD)',
        '广告费率%',
        '广告费',
        '退货折损率%',
        '退货损耗',
        '佣金',
        '派送费',
        '配置费',
        '仓储月数',
        '仓储费',
        '费用合计',
        '回款',
        '利润',
        '利润率',
        '尺寸等级',
        '售价带',
        '规则',
      ]
      const euHeaders = [
        'SKU',
        'FOB(RMB)',
        '长',
        '宽',
        '高',
        '重量(kg)',
        '计费重',
        '头程(RMB)',
        'DDP(RMB)',
        `DDP(${ddpCurrency})`,
        '汇率',
        `售价(${saleCurrency})`,
        '平台佣金',
        '广告费率%',
        '广告费',
        '退货率%',
        '退货损失',
        '派送费',
        '配置费',
        '仓储费',
        '费用合计',
        '回款',
        '增值税',
        '利润(扣税后)',
        '利润率(扣税)',
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

      const LEFT_COLS = isUS ? new Set([1, 28]) : new Set([1])
      const CENTER_COLS = isUS ? new Set([22, 23, 24, 25, 26, 27]) : new Set([22, 23, 24, 25, 26])

      // Build data rows
      const dataRows = itemsWithResults.map((item) => {
        const snapshot = isUS ? usStoreRows[item.id]?.result : euStoreRows[item.id]?.result
        if (!snapshot) return null

        const s = snapshot as ShopCalculationItem &
          import('@/lib/pricing-calculation-types').PricingCalculationRunItem
        const chargeableWeight = Math.max(
          item.weight_kg,
          (item.package_length_cm * item.package_width_cm * item.package_height_cm) / 6000
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
            s.fees.platform_fee_usd ?? 0,
            s.advertising_rate * 100,
            s.fees.advertising_fee_usd,
            (s.return_loss_rate ?? 0) * 100,
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
        if (!rowData) return
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

          // Profit / profit rate columns: apply percentage format to rate, color to both.
          // US 与 EU 布局一致：col 24 = 利润，col 25 = 利润率
          // （EU 仅在 col 23 多一列「增值税」，不影响 24/25 的列位）。
          const isProfitRateCol = colNum === 25
          const isProfitCol = colNum === 24 || colNum === 25
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
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      // 统一命名规范：${项目}_${中文站点}-页面名-业务标识.xlsx
      const safeProjectName = (selectedProjectName || '未选项目').replace(/[\\/:*?"<>|]/g, '-')
      const safeCountryLabel = getCountryLabel(selectedCountry).replace(/[\\/:*?"<>|]/g, '-')
      link.download = `${safeProjectName}_${safeCountryLabel}-店铺SKU测算-${formatLocalTimestampForFilename()}.xlsx`
      link.click()
      window.URL.revokeObjectURL(url)

      await logClientOperation({
        action: 'pricing_calculation.shop_calculation.export',
        targetType: 'shop_calculation',
        targetId: selectedProjectId ?? undefined,
        after: {
          project_id: selectedProjectId,
          project_name: selectedProjectName,
          country: selectedCountry,
          row_count: itemsWithResults.length,
        },
      })
    } catch (err) {
      notify({
        type: 'error',
        title: '导出失败',
        message: err instanceof Error ? err.message : '导出失败',
      })
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* Card 1: 控制台 */}
      <div className="border border-term-border bg-term-panel p-3">
            {/* Top Row: Icon + Title + Snapshot Selector */}
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-none border border-term-border bg-term-raised text-term-muted">
                <Calculator className="h-5 w-5 text-[hsl(var(--primary))]" strokeWidth={2} />
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="text-[1.15rem] font-semibold tracking-tight text-foreground">
                  控制台
                </h1>
              </div>
              {/* 定价历史快照选择器（仿 inventory-replenishment 的 SnapshotSelector） */}
              <PricingSnapshotSelector
                projectId={selectedProjectId}
                country={selectedCountry}
                selectedSnapshotId={selectedSnapshotId}
                onSnapshotSelect={setSelectedSnapshotId}
                onCreateSnapshot={() => setCreateDialogOpen(true)}
                onEditSnapshot={(snapshot) => {
                  setEditingSnapshot(snapshot)
                  setEditDialogOpen(true)
                }}
                disabled={!selectedProjectId || statsLoading}
                refreshNonce={snapshotRefreshNonce}
                isAdmin={isAdmin}
                onDeleteSnapshot={() => setSnapshotRefreshNonce((n) => n + 1)}
              />
            </div>

            {/* Divider */}
            <div className="mt-4 mb-4 h-px bg-border/60" />

            {/* Bottom Row: Three Modules + Country Switch */}
            {/* 手机端：2列网格去除标签；平板+：横向排列 */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              {/* Left: 项目 + 搜索 SKU + 导出 Excel */}
              {/* 手机: 2列网格；平板+: 3列网格 */}
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
                {/* Module 1: 项目 */}
                <div className="flex min-w-0 flex-col gap-2">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden sm:block">
                    项目
                  </span>
                  {projectsLoading ? (
                    <Skeleton className="h-8 w-full" />
                  ) : (
                    <Select value={selectedProjectName} onValueChange={setSelectedProjectName}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="选择项目" />
                      </SelectTrigger>
                      <SelectContent>
                        {projects.map((p) => (
                          <SelectItem key={p.id} value={p.name} className="text-xs">
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>

                {/* Module 2: 搜索 SKU */}
                <div className="flex min-w-0 flex-col gap-2">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden sm:block">
                    搜索 SKU
                  </span>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={skuKeyword}
                      onChange={(e) => setSkuKeyword(e.target.value)}
                      placeholder="SKU / ASIN"
                      className="h-8 pl-8 text-xs"
                    />
                  </div>
                </div>

                {/* Module 3: 导出 Excel */}
                <div className="flex min-w-0 flex-col gap-2">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden sm:block">
                    导出 Excel
                  </span>
                  <Button
                    variant="outline"
                    onClick={handleExport}
                    disabled={exporting || !hasCalculatedRows}
                    className="h-8 text-xs"
                  >
                    {exporting ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    导出 Excel
                  </Button>
                </div>
              </div>

              {/* Right: 站点 */}
              <div className="flex min-w-0 flex-col gap-2 sm:flex-shrink-0">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide hidden sm:block">
                  站点
                </span>
                <div
                  className="flex h-8 w-full items-stretch gap-0 rounded-none border border-term-border bg-term-panel p-0 sm:w-48"
                  role="group"
                  aria-label="选择站点"
                >
                  {COUNTRY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setSelectedCountry(opt.value)}
                      className={cn(
                        'flex h-full min-h-[calc(44px-2px)] min-w-0 flex-1 items-center justify-center rounded-none px-3 text-center font-mono text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-none',
                        selectedCountry === opt.value
                          ? 'bg-term-raised text-term-text'
                          : 'text-term-muted hover:bg-term-hover hover:text-term-text'
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

      {/* Card 2: DataTableCard with Stats */}
      <div className="animate-fade-slide-up">
        <DataTableCard>
          <DataTableCardStatBar
            items={[
              {
                label: 'SKU',
                value: showSkeleton ? (
                  <Skeleton className="h-6 w-8" />
                ) : (
                  <RefreshProgressBar refreshing={isRefreshing}>
                    <span className="text-sm font-semibold tabular-nums text-foreground">
                      {stats.total}
                    </span>
                  </RefreshProgressBar>
                ),
              },
              {
                label: '已测算',
                value: showSkeleton ? (
                  <Skeleton className="h-6 w-8" />
                ) : (
                  <RefreshProgressBar refreshing={isRefreshing}>
                    <span
                      className={cn(
                        'text-sm font-semibold tabular-nums',
                        stats.calculated > 0
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-foreground'
                      )}
                    >
                      {stats.calculated}
                    </span>
                  </RefreshProgressBar>
                ),
              },
              {
                label: '盈利',
                value: showSkeleton ? (
                  <Skeleton className="h-6 w-8" />
                ) : (
                  <RefreshProgressBar refreshing={isRefreshing}>
                    <span
                      className={cn(
                        'text-sm font-semibold tabular-nums',
                        stats.profitable > 0
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-foreground'
                      )}
                    >
                      {stats.profitable}
                    </span>
                  </RefreshProgressBar>
                ),
              },
              {
                label: '盈利占比',
                value: showSkeleton ? (
                  <Skeleton className="h-6 w-8" />
                ) : (
                  <RefreshProgressBar refreshing={isRefreshing}>
                    <span
                      className={cn(
                        'text-sm font-semibold tabular-nums',
                        !hasCalculatedRows
                          ? 'text-foreground'
                          : stats.passRate >= 50
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : stats.passRate >= 25
                              ? 'text-term-warn'
                              : 'text-term-neg'
                      )}
                    >
                      {hasCalculatedRows ? `${stats.passRate.toFixed(1)}%` : '—'}
                    </span>
                  </RefreshProgressBar>
                ),
              },
            ]}
          />
          <DataTableCardBody>
            {selectedCountry === 'US' ? (
              <ShopCalculationUsSection
                selectedCountry={selectedCountry}
                selectedProjectName={selectedProjectName}
                selectedProjectId={selectedProjectId}
                skuKeyword={skuKeyword}
                onProjectChange={setSelectedProjectName}
                onSkuKeywordChange={setSkuKeyword}
                onStoreRowsChange={setUsStoreRows}
                selectedSnapshotId={selectedSnapshotId}
                onSnapshotInvalid={() => setSelectedSnapshotId(null)}
              />
            ) : (
              <ShopCalculationEuSection
                selectedCountry={selectedCountry}
                projects={projects}
                projectsLoading={projectsLoading}
                selectedProjectName={selectedProjectName}
                selectedProjectId={selectedProjectId}
                skuKeyword={skuKeyword}
                onProjectChange={setSelectedProjectName}
                onSkuKeywordChange={setSkuKeyword}
                onDataReady={({ items, rows }) => {
                  setEuStoreSkus(items)
                  setEuStoreRows(rows as typeof euStoreRows)
                }}
                onHasCalculatedRowsChange={setHasEuCalculatedRows}
                selectedSnapshotId={selectedSnapshotId}
                onSnapshotInvalid={() => setSelectedSnapshotId(null)}
              />
            )}
          </DataTableCardBody>
        </DataTableCard>
      </div>

      {/* ── 定价历史快照对话框 ───────────────────────────────────────────── */}
      <CreatePricingSnapshotDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        projectId={selectedProjectId}
        country={selectedCountry}
        onSuccess={(snapshotId) => {
          setSelectedSnapshotId(snapshotId)
          setSnapshotRefreshNonce((n) => n + 1)
        }}
      />

      {editingSnapshot && (
        <EditPricingSnapshotDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          snapshotId={editingSnapshot.id}
          initialName={editingSnapshot.name}
          initialDescription={editingSnapshot.description}
          onSuccess={() => setSnapshotRefreshNonce((n) => n + 1)}
        />
      )}
    </div>
  )
}
