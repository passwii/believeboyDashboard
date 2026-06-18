'use client'

import { useMemo } from 'react'
import { Flag, Globe2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { DataTableCard, DataTableCardHeader } from '@/components/ui/data-card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  fmtMoneyPrecise,
  fmtNumPrecise,
  renderChangeIndicator,
} from '@/lib/dashboard-format'
import { getCountryLabel } from '@/lib/country'

export interface TopCountrySummaryRow {
  date: string
  order_qty: number
  sales_amount: number
  ad_spend: number
}

export interface DashboardTopCountriesProps {
  /** 当前周期:{ [countryCode]: summaryRows } */
  countryRowsByCode: Record<string, TopCountrySummaryRow[]>
  /** 上一周期:同上结构,用于计算环比 */
  countryCompareRowsByCode: Record<string, TopCountrySummaryRow[]>
  /** 后端 currency_note 文案(用于卡片底部 muted text) */
  currencyNote?: string | null
  /** 由 page.tsx 透传的"代表项目选择器" UI(避免 ProjectSelect 重复 fetch projects) */
  projectSelector?: React.ReactNode
  /** 当前选中的代表项目名称,用于 description 文案展示 */
  representativeProjectName?: string | null
  loading?: boolean
}

interface CountryAggRow {
  code: string
  flag: string
  label: string
  totalSales: number
  totalAdSpend: number
  totalOrders: number
  change: number | null
}

/** 国家代码 → emoji 国旗(用于表格首列视觉锚点) */
const COUNTRY_FLAG: Record<string, string> = {
  US: '🇺🇸',
  DE: '🇩🇪',
  UK: '🇬🇧',
  FR: '🇫🇷',
  IT: '🇮🇹',
  ES: '🇪🇸',
  JP: '🇯🇵',
}

function aggregate(
  countryRowsByCode: Record<string, TopCountrySummaryRow[]>,
  countryCompareRowsByCode: Record<string, TopCountrySummaryRow[]>,
): CountryAggRow[] {
  const rows: CountryAggRow[] = []
  for (const code of Object.keys(countryRowsByCode)) {
    const summaryRows = countryRowsByCode[code]
    if (!Array.isArray(summaryRows) || summaryRows.length === 0) continue
    let totalSales = 0
    let totalAdSpend = 0
    let totalOrders = 0
    for (const r of summaryRows) {
      totalSales += r.sales_amount ?? 0
      totalAdSpend += r.ad_spend ?? 0
      totalOrders += r.order_qty ?? 0
    }
    const compareRows = countryCompareRowsByCode[code]
    let prevSales = 0
    if (Array.isArray(compareRows)) {
      for (const r of compareRows) prevSales += r.sales_amount ?? 0
    }
    const change = prevSales > 0 ? ((totalSales - prevSales) / prevSales) * 100 : null
    rows.push({
      code,
      flag: COUNTRY_FLAG[code] ?? '🏳️',
      label: getCountryLabel(code),
      totalSales,
      totalAdSpend,
      totalOrders,
      change,
    })
  }
  return rows.sort((a, b) => b.totalSales - a.totalSales)
}

export function DashboardTopCountries({
  countryRowsByCode,
  countryCompareRowsByCode,
  currencyNote,
  projectSelector,
  representativeProjectName,
  loading = false,
}: DashboardTopCountriesProps) {
  const rows = useMemo(
    () => aggregate(countryRowsByCode, countryCompareRowsByCode),
    [countryRowsByCode, countryCompareRowsByCode],
  )

  const grandTotal = useMemo(() => rows.reduce((s, r) => s + r.totalSales, 0), [rows])

  return (
    <DataTableCard className="h-full">
      <DataTableCardHeader
        title="跨国家 TOP"
        description={
          representativeProjectName
            ? `基于代表项目:${representativeProjectName}`
            : rows.length > 0
            ? `${rows.length} 个站点`
            : 'US / DE / UK 跨站点对比'
        }
        action={
          <div className="flex items-center gap-2">
            {projectSelector}
            <Badge variant="outline" className="gap-1 font-mono text-[10px]">
              USD
            </Badge>
          </div>
        }
      />
      <div className="px-4 py-3 sm:px-6 sm:py-4">
        {loading && rows.length === 0 ? (
          <SkeletonList />
        ) : rows.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-left text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
                    <th className="w-10 pb-2 font-medium">#</th>
                    <th className="pb-2 font-medium">国家</th>
                    <th className="pb-2 text-right font-medium">销售额</th>
                    <th className="hidden pb-2 text-right font-medium sm:table-cell">广告花费</th>
                    <th className="w-28 pb-2 font-medium">占比</th>
                    <th className="w-20 pb-2 text-right font-medium">环比</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => {
                    const pct = grandTotal > 0 ? (row.totalSales / grandTotal) * 100 : 0
                    return (
                      <tr
                        key={row.code}
                        className="border-b border-border/40 last:border-b-0 transition-colors hover:bg-muted/30"
                      >
                        <td className="py-2.5 align-middle text-xs text-muted-foreground tabular-nums">
                          {idx + 1}
                        </td>
                        <td className="py-2.5 align-middle">
                          <div className="flex min-w-0 items-center gap-2">
                            <span
                              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-base leading-none"
                              aria-hidden
                            >
                              {row.flag}
                            </span>
                            <span className="truncate font-medium text-foreground">{row.label}</span>
                            <span className="shrink-0 text-[10px] font-mono text-muted-foreground/70">{row.code}</span>
                          </div>
                        </td>
                        <td className="py-2.5 align-middle text-right tabular-nums font-medium">
                          {fmtMoneyPrecise(row.totalSales)}
                        </td>
                        <td className="hidden py-2.5 align-middle text-right tabular-nums text-muted-foreground sm:table-cell">
                          {fmtMoneyPrecise(row.totalAdSpend)}
                        </td>
                        <td className="py-2.5 align-middle">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                              <div
                                className={cn(
                                  'h-full rounded-full transition-[width] duration-500',
                                  idx === 0 ? 'bg-primary' : 'bg-primary/60',
                                )}
                                style={{ width: `${Math.max(2, pct)}%` }}
                              />
                            </div>
                            <span className="w-9 text-right text-[11px] tabular-nums text-muted-foreground">
                              {pct.toFixed(0)}%
                            </span>
                          </div>
                        </td>
                        <td className="py-2.5 align-middle text-right tabular-nums">
                          {renderChangeIndicator(row.change)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {currencyNote && (
              <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground/80">
                {currencyNote}
              </p>
            )}
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/60">
              订单量合计 <span className="font-medium text-muted-foreground">{fmtNumPrecise(rows.reduce((s, r) => s + r.totalOrders, 0))}</span> 单
            </p>
          </>
        )}
      </div>
    </DataTableCard>
  )
}

function SkeletonList() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <div className="mb-2 rounded-xl bg-secondary/10 p-2.5 text-secondary">
        <Globe2 className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium text-foreground">暂无跨国家数据</p>
      <p className="mt-1 max-w-[240px] text-xs leading-relaxed text-muted-foreground">
        当前代表项目不支持跨国家聚合(US / DE / UK),或数据加载失败。
      </p>
      <div className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-[11px] text-muted-foreground">
        <Flag className="h-3 w-3" />
        支持:US · DE · UK
      </div>
    </div>
  )
}