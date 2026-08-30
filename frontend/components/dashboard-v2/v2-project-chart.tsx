'use client'

import { Bar, BarChart, XAxis, YAxis } from 'recharts'
import { Store } from 'lucide-react'

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

import { V2Card } from './v2-card'
import {
  computeTopProjects,
  type V2ProjectBreakdownEntry,
  type V2ProjectOption,
} from './v2-top-projects'

export interface V2ProjectChartProps {
  projectBreakdown: Record<number, V2ProjectBreakdownEntry>
  projects: V2ProjectOption[]
  loading?: boolean
}

const chartConfig = {
  sales: {
    label: '销售额',
    color: '#2563eb',
  },
} satisfies ChartConfig

/** 项目名过长截断（与表格一致） */
function truncateName(name: string, max = 10): string {
  return name.length > max ? `${name.slice(0, max)}…` : name
}

export function V2ProjectChart({ projectBreakdown, projects, loading }: V2ProjectChartProps) {
  const rows = computeTopProjects(projectBreakdown, undefined, projects, 'sales')
    .slice(0, 5)
    .map((r) => ({ name: truncateName(r.projectName), sales: r.totalSales }))

  return (
    <V2Card className="gap-0 transition-colors hover:bg-blue-50/60 dark:hover:bg-[hsl(var(--surface-subtle)/0.4)] col-span-2">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-blue-100 text-blue-600 dark:bg-[hsl(var(--surface-subtle))] dark:text-muted-foreground">
            <Store className="size-4" />
          </span>
          <CardTitle>项目销售额对比</CardTitle>
        </div>
        <CardDescription>近 7 天各项目销售额 Top 5</CardDescription>
      </CardHeader>
      <CardContent>
        {loading && rows.length === 0 ? (
          <Skeleton className="h-52 w-full" />
        ) : rows.length > 0 ? (
          <ChartContainer className="aspect-auto h-52 w-full md:h-64" config={chartConfig}>
            <BarChart accessibilityLayer data={rows} margin={{ left: 0, right: 0, top: 4 }}>
              <XAxis
                axisLine={false}
                dataKey="name"
                interval={0}
                tickFormatter={(value) => String(value)}
                tickLine={false}
                tickMargin={8}
                tick={{ className: 'font-mono text-[11px] tabular-nums fill-term-faint' }}
              />
              <YAxis
                axisLine={false}
                tickFormatter={(value) => `$${Number(value) / 1000}k`}
                tickLine={false}
                width={44}
                tick={{ className: 'font-mono text-[11px] tabular-nums fill-term-faint' }}
              />
            </BarChart>
          </ChartContainer>
        ) : (
          <div className="flex h-52 items-center justify-center text-sm text-muted-foreground">
            暂无项目数据
          </div>
        )}
      </CardContent>
    </V2Card>
  )
}
