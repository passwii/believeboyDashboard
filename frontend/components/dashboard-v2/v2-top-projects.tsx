'use client'

import { useMemo, useState } from 'react'

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { fmtMoneyPrecise, fmtNumPrecise, renderChangeIndicator } from '@/lib/dashboard-format'

import { TermChartCard } from '@/components/charts/term-chart-card'

/** 与 v1 dashboard-top-projects 的 ProjectBreakdownEntry 对齐 —— 只声明本组件用到的字段 */
export interface V2TopProjectRow {
  date: string
  order_qty: number
  sales_amount: number
  ad_spend: number
  ad_orders: number
}

export interface V2ProjectBreakdownEntry {
  project_name: string
  summary_rows: V2TopProjectRow[]
}

export interface V2ProjectOption {
  id: number | null
  name: string
}

export type V2TopProjectSort = 'sales' | 'ad_spend'

export interface V2TopProjectAggRow {
  projectId: number
  projectName: string
  totalSales: number
  totalAdSpend: number
  totalOrders: number
  /** 销售额环比（上一周期为空时为 null） */
  change: number | null
}

const MAX_ROWS = 6

/** 汇总 project_breakdown 并按 sortKey 排序取 Top N（纯函数，供测试） */
export function computeTopProjects(
  projectBreakdown: Record<number, V2ProjectBreakdownEntry>,
  compareProjectBreakdown: Record<number, V2ProjectBreakdownEntry> | undefined,
  projects: V2ProjectOption[],
  sortKey: V2TopProjectSort
): V2TopProjectAggRow[] {
  const rows: V2TopProjectAggRow[] = []
  for (const project of projects) {
    if (project.id === null) continue
    const entry = projectBreakdown[project.id]
    if (!entry || !Array.isArray(entry.summary_rows) || entry.summary_rows.length === 0) continue
    let totalSales = 0
    let totalAdSpend = 0
    let totalOrders = 0
    for (const r of entry.summary_rows) {
      totalSales += r.sales_amount ?? 0
      totalAdSpend += r.ad_spend ?? 0
      totalOrders += r.order_qty ?? 0
    }
    const prevRows = compareProjectBreakdown?.[project.id]?.summary_rows ?? []
    const prevSales = prevRows.reduce((s, r) => s + (r.sales_amount ?? 0), 0)
    const change = prevSales > 0 ? ((totalSales - prevSales) / prevSales) * 100 : null
    rows.push({
      projectId: project.id,
      projectName: entry.project_name || project.name,
      totalSales,
      totalAdSpend,
      totalOrders,
      change,
    })
  }
  const key = sortKey === 'sales' ? 'totalSales' : 'totalAdSpend'
  return rows.sort((a, b) => b[key] - a[key]).slice(0, MAX_ROWS)
}

export interface V2TopProjectsProps {
  /** 后端 /daily-analysis/all 返回的 project_breakdown */
  projectBreakdown: Record<number, V2ProjectBreakdownEntry>
  /** 上一周期的 project_breakdown（用于环比） */
  compareProjectBreakdown?: Record<number, V2ProjectBreakdownEntry>
  /** 项目列表（补全名字/顺序） */
  projects: V2ProjectOption[]
  loading?: boolean
}

export function V2TopProjects({
  projectBreakdown,
  compareProjectBreakdown,
  projects,
  loading = false,
}: V2TopProjectsProps) {
  const [sortKey, setSortKey] = useState<V2TopProjectSort>('sales')

  const rows = useMemo(
    () => computeTopProjects(projectBreakdown, compareProjectBreakdown, projects, sortKey),
    [projectBreakdown, compareProjectBreakdown, projects, sortKey]
  )

  return (
    <TermChartCard
      title="项目排行"
      description="各项目销售额与广告花费对比（近 7 天）"
      className="col-span-2 lg:col-span-4"
      actions={
        <div className="flex items-center gap-1 rounded-none border border-term-border p-0.5">
          {(
            [
              { key: 'sales' as const, label: '销售额' },
              { key: 'ad_spend' as const, label: '广告花费' },
            ]
          ).map((tab) => (
            <button
              className={cn(
                'h-8 rounded-none border px-2 font-mono text-xs leading-5 transition-colors',
                sortKey === tab.key
                  ? 'border-term-border bg-term-raised font-semibold text-term-text'
                  : 'border-transparent text-term-muted hover:bg-term-hover hover:text-term-text'
              )}
              key={tab.key}
              onClick={() => setSortKey(tab.key)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
      }
      loading={loading && rows.length === 0}
      empty={rows.length === 0}
      emptyText="暂无项目数据"
    >
      {rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="ps-6">项目</TableHead>
              <TableHead className="text-right">销售额</TableHead>
              <TableHead className="text-right">广告花费</TableHead>
              <TableHead className="text-right">订单量</TableHead>
              <TableHead className="pe-6 text-right">环比</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow className="h-12" key={row.projectId}>
                <TableCell className="max-w-40 truncate ps-6 font-medium">
                  {row.projectName}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {fmtMoneyPrecise(row.totalSales)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {fmtMoneyPrecise(row.totalAdSpend)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {fmtNumPrecise(row.totalOrders)}
                </TableCell>
                <TableCell className="pe-6 text-right">
                  {renderChangeIndicator(row.change)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </TermChartCard>
  )
}
