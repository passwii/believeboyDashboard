'use client'

import {
  STICKY_LEFT_CELL,
  STICKY_LEFT_HEAD_CELL,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyTableState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils'

import { formatRmb, formatPercent } from './utils'

const FULL_BLEED_TABLE_CLASS = '[&_th]:px-0 [&_th]:py-3 [&_td]:px-0 [&_td]:py-3'
const FULL_BLEED_TABLE_CONTAINER_CLASS = '-m-px h-[calc(100%+2px)] w-[calc(100%+2px)] rounded-none'

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

function getYearMonths(year: string): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
}

interface ProjectSummaryTabProps {
  items: CommissionProjectYearlySummaryItem[]
  year: string
  loading: boolean
}

const TOTAL_MONTH_COLS = 12
const DATA_COLS = TOTAL_MONTH_COLS + 3 // 12 months + total commission + received + rate

// 骨架屏行
function ProjectSummarySkeletonRow() {
  return (
    <TableRow className="animate-pulse">
      {/* 项目名称列（sticky） */}
      <TableCell className={STICKY_LEFT_CELL}>
        <Skeleton className="h-5 w-20 mx-auto" />
      </TableCell>
      {/* 数据列：12个月 + 3个汇总列 */}
      {Array.from({ length: TOTAL_MONTH_COLS + 3 }).map((_, i) => (
        <TableCell key={i} className="text-center">
          <Skeleton className="h-4 w-16 mx-auto" />
        </TableCell>
      ))}
    </TableRow>
  )
}

// 骨架屏内容
function ProjectSummarySkeletonContent() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
      <Table
        className={FULL_BLEED_TABLE_CLASS}
        containerClassName={`${FULL_BLEED_TABLE_CONTAINER_CLASS} overflow-auto`}
      >
        <TableHeader className="bg-[hsl(var(--surface-subtle))]">
          <TableRow>
            <TableHead className={cn(STICKY_LEFT_HEAD_CELL, '!pl-0 text-center text-foreground')}>
              项目名称
            </TableHead>
            {getYearMonths(new Date().getFullYear().toString()).map((m) => (
              <TableHead
                key={m}
                className="z-20 bg-[hsl(var(--surface-subtle))] text-center text-xs font-semibold text-foreground"
              >
                {m.slice(5)}月
              </TableHead>
            ))}
            <TableHead className="z-20 bg-[hsl(var(--surface-subtle))] text-center font-semibold text-foreground">
              年度佣金合计
            </TableHead>
            <TableHead className="z-20 bg-[hsl(var(--surface-subtle))] text-center font-semibold text-foreground">
              年度回款
            </TableHead>
            <TableHead className="!pr-0 z-20 bg-[hsl(var(--surface-subtle))] text-center font-semibold text-foreground">
              回款率
            </TableHead>
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
        <Table
          className={FULL_BLEED_TABLE_CLASS}
          containerClassName={`${FULL_BLEED_TABLE_CONTAINER_CLASS} overflow-auto`}
        >
          <TableHeader className="bg-[hsl(var(--surface-subtle))]">
            <TableRow>
              <TableHead className={cn(STICKY_LEFT_HEAD_CELL, '!pl-0 text-center text-foreground')}>
                项目名称
              </TableHead>
              {getYearMonths(year).map((m) => (
                <TableHead
                  key={m}
                  className="z-20 bg-[hsl(var(--surface-subtle))] text-center text-xs font-semibold text-foreground"
                >
                  {m.slice(5)}月
                </TableHead>
              ))}
              <TableHead className="z-20 bg-[hsl(var(--surface-subtle))] text-center font-semibold text-foreground">
                年度佣金合计
              </TableHead>
              <TableHead className="z-20 bg-[hsl(var(--surface-subtle))] text-center font-semibold text-foreground">
                年度回款
              </TableHead>
              <TableHead className="!pr-0 z-20 bg-[hsl(var(--surface-subtle))] text-center font-semibold text-foreground">
                回款率
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <EmptyTableState colSpan={DATA_COLS} message={`${year}年暂无数据`} />
            ) : (
              items.map((project) => (
                <TableRow key={project.project_id}>
                  <TableCell className={cn(STICKY_LEFT_CELL, '!pl-0 font-medium text-center')}>
                    {project.project_name}
                  </TableCell>
                  {getYearMonths(year).map((m) => {
                    const monthData = project.months[m]
                    return (
                      <TableCell key={m} className="text-center tabular-nums text-xs">
                        {monthData ? formatRmb(monthData.factory_commission_rmb) : '-'}
                      </TableCell>
                    )
                  })}
                  <TableCell className="text-center tabular-nums font-medium">
                    {formatRmb(project.total_commission_rmb)}
                  </TableCell>
                  <TableCell className="text-center tabular-nums">
                    {formatRmb(project.total_received_rmb)}
                  </TableCell>
                  <TableCell className="!pr-0 text-center tabular-nums">
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
