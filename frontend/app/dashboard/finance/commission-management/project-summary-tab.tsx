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
import { EmptyTableState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils'

import { formatRmb, formatPercent } from './utils'

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
    <TermRow className="animate-pulse hover:bg-transparent">
      {Array.from({ length: 16 }).map((_, i) => (
        <TermCell key={i}>
          <Skeleton className="h-3.5 w-14 rounded-none" />
        </TermCell>
      ))}
    </TermRow>
  )
}

// 骨架屏内容
function ProjectSummarySkeletonContent() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="overflow-auto term-scroll">
        <TermTable>
          <TermTHead>
            <TermRow className="hover:bg-transparent">
              <TermHead className="sticky left-0 z-20 min-w-[140px] bg-term-raised">项目名称</TermHead>
              {getYearMonths(new Date().getFullYear().toString()).map((m) => (
                <TermHead key={m} numeric>
                  {m.slice(5)}月
                </TermHead>
              ))}
              <TermHead numeric>年度佣金合计</TermHead>
              <TermHead numeric>年度回款</TermHead>
              <TermHead numeric>回款率</TermHead>
            </TermRow>
          </TermTHead>
          <TermBody>
            {Array.from({ length: 5 }).map((_, i) => (
              <ProjectSummarySkeletonRow key={i} />
            ))}
          </TermBody>
        </TermTable>
      </div>
    </div>
  )
}

export function ProjectSummaryTab({ items, year, loading }: ProjectSummaryTabProps) {
  // BLF-504：年度合计行（汇总行模式）—— 按月列加总工厂佣金(RMB) + 年度汇总列
  const totals = items.reduce(
    (acc, project) => {
      let monthSum = 0
      for (const m of getYearMonths(year)) {
        const monthData = project.months[m]
        const v = monthData?.factory_commission_rmb ?? 0
        monthSum += v
        acc.months[m] = (acc.months[m] ?? 0) + v
      }
      acc.commission = acc.commission + project.total_commission_rmb
      acc.received = acc.received + project.total_received_rmb
      return acc
    },
    { months: {} as Record<string, number>, commission: 0, received: 0 }
  )
  const totalsRate = totals.commission > 0 ? totals.received / totals.commission : 0

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 骨架屏层 */}
      <div
        className="absolute inset-0 transition-opacity duration-[var(--duration-fast)]"
        style={{ opacity: loading ? 1 : 0, pointerEvents: loading ? 'auto' : 'none' }}
        aria-hidden={!loading}
      >
        <ProjectSummarySkeletonContent />
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
                <TermHead className="sticky left-0 z-20 min-w-[140px] bg-term-raised">项目名称</TermHead>
                {getYearMonths(year).map((m) => (
                  <TermHead key={m} numeric>
                    {m.slice(5)}月
                  </TermHead>
                ))}
                <TermHead numeric>年度佣金合计</TermHead>
                <TermHead numeric>年度回款</TermHead>
                <TermHead numeric>回款率</TermHead>
              </TermRow>
            </TermTHead>
            <TermBody>
              {items.length === 0 ? (
                <TermRow className="hover:bg-transparent">
                  <TermCell colSpan={DATA_COLS} className="h-24 text-center" tone="muted">
                    {year}年暂无数据
                  </TermCell>
                </TermRow>
              ) : (
                <>
                  {items.map((project) => (
                    <TermRow key={project.project_id}>
                      <TermCell
                        title={project.project_name}
                        className="sticky left-0 z-10 min-w-[140px] bg-term-panel font-medium group-hover:bg-term-hover"
                      >
                        {project.project_name}
                      </TermCell>
                      {getYearMonths(year).map((m) => {
                        const monthData = project.months[m]
                        return (
                          <TermCell key={m} numeric tone="muted">
                            {monthData ? formatRmb(monthData.factory_commission_rmb) : '-'}
                          </TermCell>
                        )
                      })}
                      <TermCell numeric className="font-medium">
                        {formatRmb(project.total_commission_rmb)}
                      </TermCell>
                      <TermCell numeric>{formatRmb(project.total_received_rmb)}</TermCell>
                      <TermCell
                        numeric
                        tone={
                          project.receive_rate >= 1
                            ? 'pos'
                            : project.receive_rate < 0.2
                              ? 'neg'
                              : 'warn'
                        }
                      >
                        {formatPercent(project.receive_rate)}
                      </TermCell>
                    </TermRow>
                  ))}
                  {/* 年度合计行（BLF-504 汇总行） */}
                  <TermRow
                    highlight
                    className="[&>td]:font-semibold [&>td]:bg-term-raised hover:bg-term-raised [&>td]:!bg-term-raised"
                  >
                    <TermCell className="sticky left-0 z-10 min-w-[140px] !bg-term-raised text-center">
                      合计
                    </TermCell>
                    {getYearMonths(year).map((m) => (
                      <TermCell key={m} numeric>
                        {totals.months[m] !== undefined && totals.months[m] > 0
                          ? formatRmb(totals.months[m])
                          : '-'}
                      </TermCell>
                    ))}
                    <TermCell numeric>{formatRmb(totals.commission)}</TermCell>
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
