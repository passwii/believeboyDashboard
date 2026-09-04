'use client'

import { Globe2 } from 'lucide-react'

import { BarChartCard, TermChartCard, buildChartConfig } from '@/components/charts'
import { getCountryLabel } from '@/lib/country'

export interface V2CountryRow {
  date: string
  sales_amount: number
}

/** 后端 /all-countries 的 country_breakdown 简化形状 */
export interface V2CountryBreakdownEntry {
  summary_rows: V2CountryRow[]
}

export interface V2CountryAggRow {
  code: string
  label: string
  totalSales: number
}

const MAX_COUNTRIES = 6

/** 汇总 country_breakdown 按销售额排序取 Top N（纯函数，供测试） */
export function computeCountryTotals(
  countryRowsByCode: Record<string, V2CountryBreakdownEntry>
): V2CountryAggRow[] {
  const rows: V2CountryAggRow[] = []
  for (const code of Object.keys(countryRowsByCode)) {
    const summaryRows = countryRowsByCode[code]?.summary_rows
    if (!Array.isArray(summaryRows) || summaryRows.length === 0) continue
    const totalSales = summaryRows.reduce((s, r) => s + (r.sales_amount ?? 0), 0)
    rows.push({ code, label: getCountryLabel(code), totalSales })
  }
  return rows.sort((a, b) => b.totalSales - a.totalSales).slice(0, MAX_COUNTRIES)
}

export interface V2CountryChartProps {
  countryRowsByCode: Record<string, V2CountryBreakdownEntry>
  /** 代表项目名（用于描述文案） */
  representativeProjectName?: string | null
  loading?: boolean
}

const chartConfig = buildChartConfig(['sales'], { sales: '销售额' })

export function V2CountryChart({
  countryRowsByCode,
  representativeProjectName,
  loading,
}: V2CountryChartProps) {
  const rows = computeCountryTotals(countryRowsByCode).map((r) => ({
    name: r.label,
    sales: r.totalSales,
  }))
  const hasData = rows.length > 0

  return (
    <TermChartCard
      icon={<Globe2 className="size-4" />}
      title="跨国家销售额"
      description={
        representativeProjectName
          ? `${representativeProjectName} · 各站点销售额分布`
          : '各站点销售额分布'
      }
      loading={loading && !hasData}
      empty={!hasData}
      emptyText="暂无国家数据"
      className="col-span-2"
    >
      <BarChartCard
        data={rows}
        xKey="name"
        series={[{ dataKey: 'sales', barProps: { radius: [0, 0, 0, 0] } }]}
        config={chartConfig}
        layout="horizontal"
        xTickFormatter={(value) => `$${Number(value) / 1000}k`}
        showLegend={false}
      />
    </TermChartCard>
  )
}
