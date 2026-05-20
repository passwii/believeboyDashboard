'use client'

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyTableState } from '@/components/ui/empty-state'
import { formatRmb, formatPercent, SITE_INFO } from './utils'
import { type SiteCode } from './types'

const SITE_ORDER: SiteCode[] = ['US', 'DE', 'UK']

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

const TOTAL_MONTH_COLS = 12
const SITE_COLS = SITE_ORDER.length
const DATA_COLS = TOTAL_MONTH_COLS * SITE_COLS + 1 // months + annual summary

export function MonthlyCollectionTab({ items, year, loading }: MonthlyCollectionTabProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
      <Table className={FULL_BLEED_TABLE_CLASS} containerClassName={`${FULL_BLEED_TABLE_CONTAINER_CLASS} overflow-auto`}>
        <TableHeader className="bg-slate-100/80 dark:bg-slate-900/45">
          <TableRow>
            <TableHead className="sticky left-0 z-30 bg-slate-100/90 font-semibold text-foreground" rowSpan={2}>
              项目名称
            </TableHead>
            {getYearMonths(year).map((m) => (
              <TableHead
                key={m}
                className="z-20 bg-slate-100/90 text-center text-xs font-semibold text-foreground"
                colSpan={3}
              >
                {m.slice(5)}月
              </TableHead>
            ))}
            <TableHead className="z-20 bg-slate-100/90 text-center font-semibold text-foreground" rowSpan={2}>
              年度汇总
            </TableHead>
          </TableRow>
          <TableRow>
            {getYearMonths(year).flatMap((m) =>
              SITE_ORDER.map((site) => (
                <TableHead key={`${m}-${site}`} className="z-10 bg-slate-100/70 text-center text-xs whitespace-nowrap">
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${SITE_INFO[site].dotClass} mr-1`} />
                  {SITE_INFO[site].label}
                </TableHead>
              ))
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow>
              <TableCell colSpan={DATA_COLS} className="text-center text-muted-foreground">加载中...</TableCell>
            </TableRow>
          ) : items.length === 0 ? (
            <EmptyTableState colSpan={DATA_COLS} message={`${year}年暂无数据`} />
          ) : (
            items.map((project) => (
              <TableRow key={project.project_id}>
                <TableCell className="sticky left-0 bg-background z-20 font-medium">
                  {project.project_name}
                </TableCell>
                {getYearMonths(year).flatMap((m) => {
                  const monthData = project.months[m]
                  return SITE_ORDER.map((site) => (
                    <TableCell key={`${m}-${site}`} className="text-center">
                      {monthData ? (
                        <span className={`inline-block min-w-[48px] rounded px-1.5 py-1 text-xs font-medium tabular-nums ${getReceiveRateColor(monthData.receive_rate).bg} ${getReceiveRateColor(monthData.receive_rate).text}`}>
                          {formatPercent(monthData.receive_rate)}
                        </span>
                      ) : (
                        <span className="inline-block rounded px-1.5 py-0.5 text-xs text-muted-foreground bg-slate-100 dark:bg-slate-800">-</span>
                      )}
                    </TableCell>
                  ))
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
