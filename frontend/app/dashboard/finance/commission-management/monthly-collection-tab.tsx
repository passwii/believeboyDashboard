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

import { formatPercent } from './utils'

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

// 回款率色块：term 语义色（≥100% pos 绿 / ≥50% warn 橙 / ≥20% warn / <20% neg 红）
function getReceiveRateTone(
  rate: number
): 'pos' | 'warn' | 'neg' {
  if (rate >= 1 - RATE_EPSILON) return 'pos'
  if (rate >= 0.2 - RATE_EPSILON) return 'warn'
  return 'neg'
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
    <TermRow className="animate-pulse hover:bg-transparent">
      {Array.from({ length: DATA_COLS }).map((_, i) => (
        <TermCell key={i}>
          <Skeleton className="h-3.5 w-10 rounded-none" />
        </TermCell>
      ))}
    </TermRow>
  )
}

// 骨架屏内容
function MonthlyCollectionSkeletonContent() {
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
              <TermHead numeric>年度汇总</TermHead>
            </TermRow>
          </TermTHead>
          <TermBody>
            {Array.from({ length: 5 }).map((_, i) => (
              <MonthlyCollectionSkeletonRow key={i} />
            ))}
          </TermBody>
        </TermTable>
      </div>

      {/* 图例骨架 */}
      <div className="flex flex-wrap items-center justify-center gap-4 border-t border-term-border bg-term-panel px-4 py-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-3.5 w-16 rounded-none" />
        ))}
      </div>
    </div>
  )
}

export function MonthlyCollectionTab({ items, year, loading }: MonthlyCollectionTabProps) {
  const renderRateCell = (rate: number | null, minW: string) => {
    if (rate === null || rate <= 0) {
      return (
        <span className="inline-block rounded-none px-1.5 font-mono text-xs text-term-faint">
          -
        </span>
      )
    }
    const tone = getReceiveRateTone(rate)
    return (
      <span
        className={cn(
          'inline-block rounded-none px-1.5 py-0.5 font-mono text-xs font-medium tabular-nums',
          minW,
          tone === 'pos' && 'bg-term-pos/15 text-term-pos',
          tone === 'warn' && 'bg-term-warn/15 text-term-warn',
          tone === 'neg' && 'bg-term-neg/15 text-term-neg'
        )}
      >
        {formatPercent(rate)}
      </span>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
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
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden transition-opacity duration-200"
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
                <TermHead numeric>年度汇总</TermHead>
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
                items.map((project) => (
                  <TermRow key={project.project_id}>
                    <TermCell
                      title={project.project_name}
                      className="sticky left-0 z-10 min-w-[140px] bg-term-panel font-medium"
                    >
                      {project.project_name}
                    </TermCell>
                    {getYearMonths(year).map((m) => {
                      const monthData = project.months[m]
                      return (
                        <TermCell key={m} numeric>
                          {monthData
                            ? renderRateCell(monthData.receive_rate, 'min-w-[48px]')
                            : '-'}
                        </TermCell>
                      )
                    })}
                    <TermCell numeric>{renderRateCell(project.receive_rate, 'min-w-[56px]')}</TermCell>
                  </TermRow>
                ))
              )}
            </TermBody>
          </TermTable>
        </div>

        {/* 图例 */}
        <div className="flex flex-wrap items-center justify-center gap-4 border-t border-term-border bg-term-panel px-4 py-2.5">
          <span className="text-xs text-term-muted">回款率色块：</span>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-10 bg-term-pos/40" />
            <span className="font-mono text-xs text-term-muted">≥100%</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-10 bg-term-warn/40" />
            <span className="font-mono text-xs text-term-muted">20%~100%</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-10 bg-term-neg/40" />
            <span className="font-mono text-xs text-term-muted">&lt;20%</span>
          </div>
        </div>
      </div>
    </div>
  )
}
