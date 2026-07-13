'use client'

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyTableState } from '@/components/ui/empty-state'
import { formatUsd, formatRmb, formatPercent } from './utils'

type CommissionYearlyMonthlySummaryItem = {
  report_month: string
  income_total_usd: number
  factory_commission_usd: number
  factory_commission_rmb: number
  received_rmb: number
  receive_rate: number
}

const FULL_BLEED_TABLE_CLASS = '[&_th]:px-0 [&_th]:py-3 [&_td]:px-0 [&_td]:py-3'
const FULL_BLEED_TABLE_CONTAINER_CLASS = 'w-full'

interface MonthlySummaryTabProps {
  items: CommissionYearlyMonthlySummaryItem[]
  year: string
  loading: boolean
}

// 骨架屏行
function MonthlySummarySkeletonRow() {
  return (
    <TableRow className="animate-pulse">
      <TableCell>
        <Skeleton className="h-5 w-16 mx-auto" />
      </TableCell>
      <TableCell className="text-center">
        <Skeleton className="h-5 w-20 mx-auto" />
      </TableCell>
      <TableCell className="text-center">
        <Skeleton className="h-5 w-20 mx-auto" />
      </TableCell>
      <TableCell className="text-center">
        <Skeleton className="h-5 w-20 mx-auto" />
      </TableCell>
      <TableCell className="text-center">
        <Skeleton className="h-5 w-20 mx-auto" />
      </TableCell>
      <TableCell className="text-center">
        <Skeleton className="h-5 w-16 mx-auto" />
      </TableCell>
    </TableRow>
  )
}

// 骨架屏内容
function MonthlySummarySkeletonContent() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
      <div className="flex-1 overflow-auto">
        <Table
          className={FULL_BLEED_TABLE_CLASS}
          containerClassName={FULL_BLEED_TABLE_CONTAINER_CLASS}
        >
          <TableHeader className="bg-slate-100/80 dark:bg-slate-900/45 sticky top-0 z-10">
            <TableRow>
              <TableHead className="!pl-0 text-center font-semibold text-foreground">
                月份
              </TableHead>
              <TableHead className="text-center font-semibold text-foreground">
                销售收入(USD)
              </TableHead>
              <TableHead className="text-center font-semibold text-foreground">
                工厂佣金(USD)
              </TableHead>
              <TableHead className="text-center font-semibold text-foreground">
                工厂佣金(RMB)
              </TableHead>
              <TableHead className="text-center font-semibold text-foreground">
                已回款(RMB)
              </TableHead>
              <TableHead className="!pr-0 text-center font-semibold text-foreground">
                回款率
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 12 }).map((_, i) => (
              <MonthlySummarySkeletonRow key={i} />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

export function MonthlySummaryTab({ items, year, loading }: MonthlySummaryTabProps) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
      {/* 骨架屏层 */}
      <div
        className="absolute inset-0 transition-opacity duration-200"
        style={{ opacity: loading ? 1 : 0, pointerEvents: loading ? 'auto' : 'none' }}
        aria-hidden={!loading}
      >
        <MonthlySummarySkeletonContent />
      </div>

      {/* 内容层 */}
      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit] transition-opacity duration-200"
        style={{ opacity: loading ? 0 : 1 }}
      >
        <div className="flex-1 overflow-auto">
          <Table
            className={FULL_BLEED_TABLE_CLASS}
            containerClassName={FULL_BLEED_TABLE_CONTAINER_CLASS}
          >
            <TableHeader className="bg-slate-100/80 dark:bg-slate-900/45 sticky top-0 z-10">
              <TableRow>
                <TableHead className="!pl-0 text-center font-semibold text-foreground">
                  月份
                </TableHead>
                <TableHead className="text-center font-semibold text-foreground">
                  销售收入(USD)
                </TableHead>
                <TableHead className="text-center font-semibold text-foreground">
                  工厂佣金(USD)
                </TableHead>
                <TableHead className="text-center font-semibold text-foreground">
                  工厂佣金(RMB)
                </TableHead>
                <TableHead className="text-center font-semibold text-foreground">
                  已回款(RMB)
                </TableHead>
                <TableHead className="!pr-0 text-center font-semibold text-foreground">
                  回款率
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <EmptyTableState colSpan={6} message={`${year}年暂无数据`} />
              ) : (
                items.map((item) => (
                  <TableRow key={item.report_month}>
                    <TableCell className="!pl-0 text-center font-medium">
                      {item.report_month}
                    </TableCell>
                    <TableCell className="text-center tabular-nums">
                      {formatUsd(item.income_total_usd)}
                    </TableCell>
                    <TableCell className="text-center tabular-nums">
                      {formatUsd(item.factory_commission_usd)}
                    </TableCell>
                    <TableCell className="text-center tabular-nums">
                      {formatRmb(item.factory_commission_rmb)}
                    </TableCell>
                    <TableCell className="text-center tabular-nums">
                      {formatRmb(item.received_rmb)}
                    </TableCell>
                    <TableCell className="!pr-0 text-center tabular-nums">
                      {formatPercent(item.receive_rate)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}
