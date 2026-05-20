'use client'

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
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

const FULL_BLEED_TABLE_CLASS = "[&_th]:px-3 [&_th]:py-3 [&_td]:px-3 [&_td]:py-3 sm:[&_th]:px-4 sm:[&_td]:px-4"
const FULL_BLEED_TABLE_CONTAINER_CLASS = "-m-px h-[calc(100%+2px)] w-[calc(100%+2px)] rounded-none"

interface MonthlySummaryTabProps {
  items: CommissionYearlyMonthlySummaryItem[]
  year: string
  loading: boolean
}

export function MonthlySummaryTab({ items, year, loading }: MonthlySummaryTabProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[inherit]">
      <div className="flex-1 overflow-auto">
        <Table className={FULL_BLEED_TABLE_CLASS} containerClassName={FULL_BLEED_TABLE_CONTAINER_CLASS}>
          <TableHeader className="bg-slate-100/80 dark:bg-slate-900/45 sticky top-0 z-10">
            <TableRow>
              <TableHead className="font-semibold text-foreground">月份</TableHead>
              <TableHead className="text-right font-semibold text-foreground">销售收入(USD)</TableHead>
              <TableHead className="text-right font-semibold text-foreground">工厂佣金(USD)</TableHead>
              <TableHead className="text-right font-semibold text-foreground">工厂佣金(RMB)</TableHead>
              <TableHead className="text-right font-semibold text-foreground">已回款(RMB)</TableHead>
              <TableHead className="text-right font-semibold text-foreground">回款率</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">加载中...</TableCell>
              </TableRow>
            ) : items.length === 0 ? (
              <EmptyTableState colSpan={6} message={`${year}年暂无数据`} />
            ) : (
              items.map((item) => (
                <TableRow key={item.report_month}>
                  <TableCell className="font-medium">{item.report_month}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatUsd(item.income_total_usd)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatUsd(item.factory_commission_usd)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatRmb(item.factory_commission_rmb)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatRmb(item.received_rmb)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(item.receive_rate)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}