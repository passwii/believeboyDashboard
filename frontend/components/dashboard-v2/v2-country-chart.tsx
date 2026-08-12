'use client'

import { Bar, BarChart, XAxis, YAxis } from 'recharts'
import { Globe2 } from 'lucide-react'

import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import { getCountryLabel } from '@/lib/country'

import { V2Card } from './v2-card'

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

const chartConfig = {
  sales: {
    label: '销售额',
    color: '#60a5fa',
  },
} satisfies ChartConfig

export function V2CountryChart({
  countryRowsByCode,
  representativeProjectName,
  loading,
}: V2CountryChartProps) {
  const rows = computeCountryTotals(countryRowsByCode).map((r) => ({
    name: r.label,
    sales: r.totalSales,
  }))

  return (
    <V2Card className="gap-0 transition-colors hover:bg-blue-50/60 dark:hover:bg-[hsl(var(--surface-subtle)/0.4)] col-span-2">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-blue-100 text-blue-600 dark:bg-[hsl(var(--surface-subtle))] dark:text-muted-foreground">
            <Globe2 className="size-4" />
          </span>
          <CardTitle>跨国家销售额</CardTitle>
        </div>
        <CardDescription>
          {representativeProjectName
            ? `${representativeProjectName} · 各站点销售额分布`
            : '各站点销售额分布'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading && rows.length === 0 ? (
          <Skeleton className="h-52 w-full" />
        ) : rows.length > 0 ? (
          <ChartContainer className="aspect-auto h-52 w-full md:h-64" config={chartConfig}>
            <BarChart accessibilityLayer data={rows} layout="vertical" margin={{ left: 0, right: 8 }}>
              <XAxis axisLine={false} tickFormatter={(value) => `$${Number(value) / 1000}k`} tickLine={false} type="number" />
              <YAxis
                axisLine={false}
                dataKey="name"
                tickFormatter={(value) => String(value)}
                tickLine={false}
                tickMargin={8}
                type="category"
                width={64}
              />
              <ChartTooltip content={<ChartTooltipContent hideLabel />} cursor={false} />
              <Bar dataKey="sales" fill="var(--color-sales)" radius={[0, 2, 2, 0]} />
            </BarChart>
          </ChartContainer>
        ) : (
          <div className="flex h-52 items-center justify-center text-sm text-muted-foreground">
            暂无国家数据
          </div>
        )}
      </CardContent>
    </V2Card>
  )
}
