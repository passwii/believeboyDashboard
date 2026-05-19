'use client'

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyTableState } from '@/components/ui/empty-state'

type CommissionProjectMonthlySummaryMonthItem = {
  report_month: string
  income_total_usd: number
  factory_commission_rmb: number
  received_rmb: number
  receive_rate: number
}

type CommissionProjectYearlySummaryItem = {
  project_id: number
  project_name: string
  months: Record<string, CommissionProjectMonthlySummaryMonthItem>
  total_income_usd: number
  total_commission_rmb: number
  total_received_rmb: number
  receive_rate: number
}

const FULL_BLEED_TABLE_CLASS = "[&_th]:px-3 [&_th]:py-3 [&_td]:px-3 [&_td]:py-3 sm:[&_th]:px-4 sm:[&_td]:px-4"
const FULL_BLEED_TABLE_CONTAINER_CLASS = "-m-px h-[calc(100%+2px)] w-[calc(100%+2px)] rounded-none"

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

function getYearMonths(year: string): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
}

function getReceiveRateColor(rate: number): { bg: string; text: string } {
  if (rate >= 1) return { bg: 'bg-green-100 dark:bg-green-500/20', text: 'text-green-700 dark:text-green-300' }
  if (rate >= 0.5) return { bg: 'bg-orange-100 dark:bg-orange-500/20', text: 'text-orange-700 dark:text-orange-300' }
  if (rate >= 0.2) return { bg: 'bg-yellow-100 dark:bg-yellow-500/20', text: 'text-yellow-700 dark:text-yellow-300' }
  return { bg: 'bg-red-100 dark:bg-red-500/20', text: 'text-red-700 dark:text-red-300' }
}

interface MonthlyCollectionTabProps {
  items: CommissionProjectYearlySummaryItem[]
  year: string
  loading: boolean
}

export function MonthlyCollectionTab({ items, year, loading }: MonthlyCollectionTabProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
      <Table className={FULL_BLEED_TABLE_CLASS} containerClassName={`${FULL_BLEED_TABLE_CONTAINER_CLASS} overflow-auto`}>
        <TableHeader className="bg-slate-100/80 dark:bg-slate-900/45">
          <TableRow>
            <TableHead className="sticky left-0 top-0 z-30 whitespace-nowrap bg-slate-100/90 font-semibold text-foreground dark:bg-slate-900/60">项目名称</TableHead>
            {getYearMonths(year).map((m) => (
              <TableHead key={m} className="sticky top-0 z-20 bg-slate-100/90 text-center text-xs whitespace-nowrap font-semibold text-foreground dark:bg-slate-900/60">
                {m.slice(5)}月
              </TableHead>
            ))}
            <TableHead className="sticky top-0 z-20 bg-slate-100/90 text-center whitespace-nowrap font-semibold text-foreground dark:bg-slate-900/60">年度汇总</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow>
              <TableCell colSpan={14} className="text-center text-muted-foreground">加载中...</TableCell>
            </TableRow>
          ) : items.length === 0 ? (
            <EmptyTableState colSpan={14} message={`${year}年暂无数据`} />
          ) : (
            items.map((project) => (
              <TableRow key={project.project_id}>
                <TableCell className="sticky left-0 bg-background z-20 font-medium">{project.project_name}</TableCell>
                {getYearMonths(year).map((m) => {
                  const monthData = project.months[m]
                  if (!monthData) {
                    return (
                      <TableCell key={m} className="text-center">
                        <span className="inline-block rounded px-1.5 py-0.5 text-xs text-muted-foreground bg-slate-100 dark:bg-slate-800">-</span>
                      </TableCell>
                    )
                  }
                  const { bg, text } = getReceiveRateColor(monthData.receive_rate)
                  return (
                    <TableCell key={m} className="text-center">
                      <span className={`inline-block min-w-[48px] rounded px-1.5 py-1 text-xs font-medium tabular-nums ${bg} ${text}`}>
                        {formatPercent(monthData.receive_rate)}
                      </span>
                    </TableCell>
                  )
                })}
                <TableCell className="text-center">
                  {project.receive_rate > 0 ? (
                    <span className={`inline-block min-w-[56px] rounded px-1.5 py-1 text-xs font-semibold tabular-nums ${getReceiveRateColor(project.receive_rate).bg} ${getReceiveRateColor(project.receive_rate).text}`}>
                      {formatPercent(project.receive_rate)}
                    </span>
                  ) : (
                    <span className="inline-block rounded px-1.5 py-0.5 text-xs text-muted-foreground bg-slate-100 dark:bg-slate-800">-</span>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {/* 图例 */}
      <div className="flex flex-wrap items-center justify-center gap-4 border-t border-border/50 bg-slate-50/50 px-4 py-3 dark:bg-slate-900/30">
        <span className="text-xs text-muted-foreground">回款率色块：</span>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-4 w-12 rounded bg-green-100 dark:bg-green-500/20" />
          <span className="text-xs text-foreground">≥100%</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-4 w-12 rounded bg-orange-100 dark:bg-orange-500/20" />
          <span className="text-xs text-foreground">50%~70%</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-4 w-12 rounded bg-yellow-100 dark:bg-yellow-500/20" />
          <span className="text-xs text-foreground">20%~50%</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-4 w-12 rounded bg-red-100 dark:bg-red-500/20" />
          <span className="text-xs text-foreground">&lt;20%</span>
        </div>
      </div>
    </div>
  )
}