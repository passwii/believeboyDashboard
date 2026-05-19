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

function formatRmb(value: number): string {
  const abs = Math.abs(value)
  const text = abs.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${value < 0 ? '-' : ''}¥${text}`
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

function getYearMonths(year: string): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
}

interface ProjectSummaryTabProps {
  items: CommissionProjectYearlySummaryItem[]
  year: string
  loading: boolean
}

export function ProjectSummaryTab({ items, year, loading }: ProjectSummaryTabProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
        <Table className={FULL_BLEED_TABLE_CLASS} containerClassName={`${FULL_BLEED_TABLE_CONTAINER_CLASS} overflow-auto`}>
          <TableHeader className="bg-slate-100/80 dark:bg-slate-900/45">
            <TableRow>
              <TableHead className="sticky left-0 top-0 z-30 whitespace-nowrap bg-slate-100/90 font-semibold text-foreground dark:bg-slate-900/60">项目名称</TableHead>
              {getYearMonths(year).map((m) => (
                <TableHead key={m} className="sticky top-0 z-20 bg-slate-100/90 text-right text-xs whitespace-nowrap font-semibold text-foreground dark:bg-slate-900/60">
                  {m.slice(5)}月佣金
                </TableHead>
              ))}
              <TableHead className="sticky top-0 z-20 bg-slate-100/90 text-right whitespace-nowrap font-semibold text-foreground dark:bg-slate-900/60">年度佣金合计</TableHead>
              <TableHead className="sticky top-0 z-20 bg-slate-100/90 text-right whitespace-nowrap font-semibold text-foreground dark:bg-slate-900/60">年度回款</TableHead>
              <TableHead className="sticky top-0 z-20 bg-slate-100/90 text-right whitespace-nowrap font-semibold text-foreground dark:bg-slate-900/60">回款率</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={16} className="text-center text-muted-foreground">加载中...</TableCell>
              </TableRow>
            ) : items.length === 0 ? (
              <EmptyTableState colSpan={16} message={`${year}年暂无数据`} />
            ) : (
              items.map((project) => (
                <TableRow key={project.project_id}>
                  <TableCell className="sticky left-0 bg-background z-20 font-medium">{project.project_name}</TableCell>
                  {getYearMonths(year).map((m) => {
                    const monthData = project.months[m]
                    return (
                      <TableCell key={m} className="text-right tabular-nums text-xs">
                        {monthData ? formatRmb(monthData.factory_commission_rmb) : '-'}
                      </TableCell>
                    )
                  })}
                  <TableCell className="text-right tabular-nums font-medium">{formatRmb(project.total_commission_rmb)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatRmb(project.total_received_rmb)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(project.receive_rate)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
    </div>
  )
}