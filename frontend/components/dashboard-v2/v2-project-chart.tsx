'use client'

import { Store } from 'lucide-react'

import { BarChartCard, ChartCard, buildChartConfig } from '@/components/charts'

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

const chartConfig = buildChartConfig(['sales'], { sales: '销售额' })

/** 项目名过长截断（与表格一致） */
function truncateName(name: string, max = 10): string {
  return name.length > max ? `${name.slice(0, max)}…` : name
}

export function V2ProjectChart({ projectBreakdown, projects, loading }: V2ProjectChartProps) {
  const rows = computeTopProjects(projectBreakdown, undefined, projects, 'sales')
    .slice(0, 5)
    .map((r) => ({ name: truncateName(r.projectName), sales: r.totalSales }))
  const hasData = rows.length > 0

  return (
    <ChartCard
      icon={<Store className="size-4" />}
      title="项目销售额对比"
      description="近 7 天各项目销售额 Top 5"
      loading={loading && !hasData}
      empty={!hasData}
      emptyText="暂无项目数据"
      className="col-span-2"
    >
      <BarChartCard
        data={rows}
        xKey="name"
        series={[{ dataKey: 'sales' }]}
        config={chartConfig}
        yTickFormatter={(v) => `$${Number(v) / 1000}k`}
        showLegend={false}
      />
    </ChartCard>
  )
}
