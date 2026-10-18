'use client'

import {
  TermBody,
  TermCell,
  TermHead,
  TermRow,
  TermTHead,
  TermTable,
} from '@/components/terminal/term-table'
import { Skeleton } from '@/components/ui/skeleton'
import { formatUsd, formatRmb, formatPercent } from './utils'

type CommissionYearlyMonthlySummaryItem = {
  report_month: string
  income_total_usd: number
  factory_commission_usd: number
  factory_commission_rmb: number
  received_rmb: number
  receive_rate: number
}

interface MonthlySummaryTabProps {
  items: CommissionYearlyMonthlySummaryItem[]
  year: string
  loading: boolean
}

// 骨架屏行
function MonthlySummarySkeletonRow() {
  return (
    <TermRow className="animate-pulse hover:bg-transparent">
      {Array.from({ length: 6 }).map((_, i) => (
        <TermCell key={i}>
          <Skeleton className="h-3.5 w-16 rounded-none" />
        </TermCell>
      ))}
    </TermRow>
  )
}

// 骨架屏内容
function MonthlySummarySkeletonContent() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-auto term-scroll">
        <TermTable>
          <TermTHead>
            <TermRow className="hover:bg-transparent">
              <TermHead>月份</TermHead>
              <TermHead numeric>销售收入(USD)</TermHead>
              <TermHead numeric>工厂佣金(USD)</TermHead>
              <TermHead numeric>工厂佣金(RMB)</TermHead>
              <TermHead numeric>已回款(RMB)</TermHead>
              <TermHead numeric>回款率</TermHead>
            </TermRow>
          </TermTHead>
          <TermBody>
            {Array.from({ length: 12 }).map((_, i) => (
              <MonthlySummarySkeletonRow key={i} />
            ))}
          </TermBody>
        </TermTable>
      </div>
    </div>
  )
}

export function MonthlySummaryTab({ items, year, loading }: MonthlySummaryTabProps) {
  // BLF-504：年度合计行（汇总行模式），回款率 = 年度已回款 / 年度工厂佣金(RMB)
  const totals = items.reduce(
    (acc, item) => ({
      income: acc.income + item.income_total_usd,
      commissionUsd: acc.commissionUsd + item.factory_commission_usd,
      commissionRmb: acc.commissionRmb + item.factory_commission_rmb,
      received: acc.received + item.received_rmb,
    }),
    { income: 0, commissionUsd: 0, commissionRmb: 0, received: 0 }
  )
  const totalsRate = totals.commissionRmb > 0 ? totals.received / totals.commissionRmb : 0

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 骨架屏层 */}
      <div
        className="absolute inset-0 transition-opacity duration-[var(--duration-fast)]"
        style={{ opacity: loading ? 1 : 0, pointerEvents: loading ? 'auto' : 'none' }}
        aria-hidden={!loading}
      >
        <MonthlySummarySkeletonContent />
      </div>

      {/* 内容层 */}
      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden transition-opacity duration-[var(--duration-fast)]"
        style={{ opacity: loading ? 0 : 1 }}
      >
        <div className="flex-1 overflow-auto term-scroll">
          <TermTable>
            <TermTHead>
              <TermRow className="hover:bg-transparent">
                <TermHead>月份</TermHead>
                <TermHead numeric>销售收入(USD)</TermHead>
                <TermHead numeric>工厂佣金(USD)</TermHead>
                <TermHead numeric>工厂佣金(RMB)</TermHead>
                <TermHead numeric>已回款(RMB)</TermHead>
                <TermHead numeric>回款率</TermHead>
              </TermRow>
            </TermTHead>
            <TermBody>
              {items.length === 0 ? (
                <TermRow className="hover:bg-transparent">
                  <TermCell colSpan={6} className="h-24 text-center" tone="muted">
                    {year}年暂无数据
                  </TermCell>
                </TermRow>
              ) : (
                <>
                  {items.map((item) => (
                    <TermRow key={item.report_month}>
                      <TermCell className="font-mono">{item.report_month}</TermCell>
                      <TermCell numeric>{formatUsd(item.income_total_usd)}</TermCell>
                      <TermCell numeric>{formatUsd(item.factory_commission_usd)}</TermCell>
                      <TermCell numeric>{formatRmb(item.factory_commission_rmb)}</TermCell>
                      <TermCell numeric>{formatRmb(item.received_rmb)}</TermCell>
                      <TermCell
                        numeric
                        tone={
                          item.receive_rate >= 1
                            ? 'pos'
                            : item.receive_rate < 0.2
                              ? 'neg'
                              : 'warn'
                        }
                      >
                        {formatPercent(item.receive_rate)}
                      </TermCell>
                    </TermRow>
                  ))}
                  {/* 年度合计行（BLF-504 汇总行） */}
                  <TermRow
                    highlight
                    className="[&>td]:font-semibold [&>td]:bg-term-raised hover:bg-term-raised"
                  >
                    <TermCell>合计</TermCell>
                    <TermCell numeric>{formatUsd(totals.income)}</TermCell>
                    <TermCell numeric>{formatUsd(totals.commissionUsd)}</TermCell>
                    <TermCell numeric>{formatRmb(totals.commissionRmb)}</TermCell>
                    <TermCell numeric>{formatRmb(totals.received)}</TermCell>
                    <TermCell numeric>{formatPercent(totalsRate)}</TermCell>
                  </TermRow>
                </>
              )}
            </TermBody>
          </TermTable>
        </div>
      </div>
    </div>
  )
}
