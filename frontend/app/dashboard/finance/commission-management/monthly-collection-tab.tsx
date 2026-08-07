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

import { formatPercent } from './utils'

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

// 容差常量，避免浮点数精度问题导致颜色判断错误
// 例如 0.999999... 应该显示绿色（≥100%），而不是橙色（50%~100%）
const RATE_EPSILON = 1e-9

function getReceiveRateColor(rate: number): { bg: string; text: string } {
  if (rate >= 1 - RATE_EPSILON)
    return { bg: 'bg-green-100 dark:bg-green-500/20', text: 'text-green-700 dark:text-green-300' }
  if (rate >= 0.5 - RATE_EPSILON)
    return {
      bg: 'bg-orange-100 dark:bg-orange-500/20',
      text: 'text-orange-700 dark:text-orange-300',
    }
  if (rate >= 0.2 - RATE_EPSILON)
    return {
      bg: 'bg-yellow-100 dark:bg-yellow-500/20',
      text: 'text-yellow-700 dark:text-yellow-300',
    }
  return { bg: 'bg-red-100 dark:bg-red-500/20', text: 'text-red-700 dark:text-red-300' }
}

interface MonthlyCollectionTabProps {
  items: CommissionProjectYearlySummaryItem[]
  year: string
  loading: boolean
}

const TOTAL_MONTH_COLS = 12
const DATA_COLS = TOTAL_MONTH_COLS + 1 // 12 months + annual summary

// 骨架屏行（回款率色块样式）
function MonthlyCollectionSkeletonRow() {
  return (
    <TableRow className="animate-pulse">
      {/* 项目名称列（sticky） */}
      <TableCell className={STICKY_LEFT_CELL}>
        <Skeleton className="h-5 w-20 mx-auto" />
      </TableCell>
      {/* 数据列：12个月 + 1个汇总列 */}
      {Array.from({ length: TOTAL_MONTH_COLS + 1 }).map((_, i) => (
        <TableCell key={i} className="text-center">
          <Skeleton className="h-6 w-12 mx-auto" />
        </TableCell>
      ))}
    </TableRow>
  )
}

// 骨架屏内容
function MonthlyCollectionSkeletonContent() {
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
            <TableHead className="!pr-0 z-20 bg-[hsl(var(--surface-subtle))] text-center font-semibold text-foreground">
              年度汇总
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <MonthlyCollectionSkeletonRow key={i} />
          ))}
        </TableBody>
      </Table>

      {/* 图例骨架 */}
      <div className="flex flex-wrap items-center justify-center gap-4 border-t border-border/50 bg-[hsl(var(--surface-subtle))] px-4 py-3">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-4 w-12" />
      </div>
    </div>
  )
}

export function MonthlyCollectionTab({ items, year, loading }: MonthlyCollectionTabProps) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
      {/* 骨架屏层 */}
      <div
        className="absolute inset-0 transition-opacity duration-200"
        style={{ opacity: loading ? 1 : 0, pointerEvents: loading ? 'auto' : 'none' }}
        aria-hidden={!loading}
      >
        <MonthlyCollectionSkeletonContent />
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
              <TableHead className="!pr-0 z-20 bg-[hsl(var(--surface-subtle))] text-center font-semibold text-foreground">
                年度汇总
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
                      <TableCell key={m} className="text-center">
                        {monthData ? (
                          <span
                            className={`inline-block min-w-[48px] rounded px-1.5 py-1 text-xs font-medium tabular-nums ${getReceiveRateColor(monthData.receive_rate).bg} ${getReceiveRateColor(monthData.receive_rate).text}`}
                          >
                            {formatPercent(monthData.receive_rate)}
                          </span>
                        ) : (
                          <span className="inline-block rounded px-1.5 py-0.5 text-xs text-muted-foreground bg-[hsl(var(--surface-subtle))]">
                            -
                          </span>
                        )}
                      </TableCell>
                    )
                  })}
                  <TableCell className="!pr-0 text-center">
                    {project.receive_rate > 0 ? (
                      <span
                        className={`inline-block min-w-[56px] rounded px-1.5 py-1 text-xs font-semibold tabular-nums ${getReceiveRateColor(project.receive_rate).bg} ${getReceiveRateColor(project.receive_rate).text}`}
                      >
                        {formatPercent(project.receive_rate)}
                      </span>
                    ) : (
                      <span className="inline-block rounded px-1.5 py-0.5 text-xs text-muted-foreground bg-[hsl(var(--surface-subtle))]">
                        -
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        {/* 图例 */}
        <div className="flex flex-wrap items-center justify-center gap-4 border-t border-border/50 bg-[hsl(var(--surface-subtle))] px-4 py-3">
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
    </div>
  )
}
