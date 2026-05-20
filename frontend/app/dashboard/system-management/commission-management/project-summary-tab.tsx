'use client'

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
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

interface ProjectSummaryTabProps {
  items: CommissionProjectYearlySummaryItem[]
  year: string
  loading: boolean
}

const TOTAL_MONTH_COLS = 12
const SITE_COLS = SITE_ORDER.length
const DATA_COLS = TOTAL_MONTH_COLS * SITE_COLS + 3 // months + total commission + received + rate

// 骨架屏行
function ProjectSummarySkeletonRow() {
  return (
    <TableRow className="animate-pulse">
      {/* 项目名称列（sticky） */}
      <TableCell className="sticky left-0 bg-background z-20">
        <Skeleton className="h-5 w-28" />
      </TableCell>
      {/* 数据列：12个月 x 3个站点 + 3个汇总列 */}
      {Array.from({ length: TOTAL_MONTH_COLS * SITE_COLS + 3 }).map((_, i) => (
        <TableCell key={i} className="text-right">
          <Skeleton className="ml-auto h-4 w-12" />
        </TableCell>
      ))}
    </TableRow>
  )
}

// 骨架屏内容
function ProjectSummarySkeletonContent() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
      <Table className={FULL_BLEED_TABLE_CLASS} containerClassName={`${FULL_BLEED_TABLE_CONTAINER_CLASS} overflow-auto`}>
        <TableHeader className="bg-slate-100/80 dark:bg-slate-900/45">
          <TableRow>
            <TableHead className="sticky left-0 z-30 bg-slate-100/90 font-semibold text-foreground" rowSpan={2}>
              项目名称
            </TableHead>
            {getYearMonths(new Date().getFullYear().toString()).map((m) => (
              <TableHead
                key={m}
                className="z-20 bg-slate-100/90 text-center text-xs font-semibold text-foreground"
                colSpan={3}
              >
                {m.slice(5)}月
              </TableHead>
            ))}
            <TableHead className="z-20 bg-slate-100/90 text-right font-semibold text-foreground" rowSpan={2}>
              年度佣金合计
            </TableHead>
            <TableHead className="z-20 bg-slate-100/90 text-right font-semibold text-foreground" rowSpan={2}>
              年度回款
            </TableHead>
            <TableHead className="z-20 bg-slate-100/90 text-right font-semibold text-foreground" rowSpan={2}>
              回款率
            </TableHead>
          </TableRow>
          <TableRow>
            {getYearMonths(new Date().getFullYear().toString()).flatMap((m) =>
              SITE_ORDER.map((site) => (
                <TableHead key={`${m}-${site}`} className="z-10 bg-slate-100/70 text-right text-xs whitespace-nowrap">
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${SITE_INFO[site].dotClass} mr-1`} />
                  {SITE_INFO[site].label}
                </TableHead>
              ))
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <ProjectSummarySkeletonRow key={i} />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function ProjectSummaryTab({ items, year, loading }: ProjectSummaryTabProps) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
      {/* 骨架屏层 */}
      <div
        className="absolute inset-0 transition-opacity duration-200"
        style={{ opacity: loading ? 1 : 0, pointerEvents: loading ? 'auto' : 'none' }}
        aria-hidden={!loading}
      >
        <ProjectSummarySkeletonContent />
      </div>

      {/* 内容层 */}
      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit] transition-opacity duration-200"
        style={{ opacity: loading ? 0 : 1 }}
      >
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
              <TableHead className="z-20 bg-slate-100/90 text-right font-semibold text-foreground" rowSpan={2}>
                年度佣金合计
              </TableHead>
              <TableHead className="z-20 bg-slate-100/90 text-right font-semibold text-foreground" rowSpan={2}>
                年度回款
              </TableHead>
              <TableHead className="z-20 bg-slate-100/90 text-right font-semibold text-foreground" rowSpan={2}>
                回款率
              </TableHead>
            </TableRow>
            <TableRow>
              {getYearMonths(year).flatMap((m) =>
                SITE_ORDER.map((site) => (
                  <TableHead key={`${m}-${site}`} className="z-10 bg-slate-100/70 text-right text-xs whitespace-nowrap">
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${SITE_INFO[site].dotClass} mr-1`} />
                    {SITE_INFO[site].label}
                  </TableHead>
                ))
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
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
                      <TableCell key={`${m}-${site}`} className="text-right tabular-nums text-xs">
                        {monthData ? formatRmb(monthData.factory_commission_rmb) : '-'}
                      </TableCell>
                    ))
                  })}
                  <TableCell className="text-right tabular-nums font-medium">
                    {formatRmb(project.total_commission_rmb)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatRmb(project.total_received_rmb)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatPercent(project.receive_rate)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}