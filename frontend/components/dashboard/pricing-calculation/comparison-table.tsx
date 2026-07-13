'use client'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export type PricingCalculationRunItem = {
  id: number
  product_name: string
  created_at: string
}

export type ComparisonRow<T extends PricingCalculationRunItem = PricingCalculationRunItem> = {
  label: string
  getDisplayValue: (run: T) => string
}

export type ComparisonSection<T extends PricingCalculationRunItem = PricingCalculationRunItem> = {
  title: string
  rows: ComparisonRow<T>[]
}

type ComparisonTableProps = {
  runs: PricingCalculationRunItem[]
  sections: ComparisonSection[]
  formatCompactDate: (value: string) => string
}

export function ComparisonTable({ runs, sections, formatCompactDate }: ComparisonTableProps) {
  if (runs.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
        暂无可对比的测算结果
      </div>
    )
  }

  const sectionStyles: Record<string, { categoryCell: string; subCell: string }> = {
    货品数据: {
      categoryCell:
        'border-sky-200 bg-sky-100 text-sky-950 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-100',
      subCell: 'bg-sky-50 dark:bg-sky-950',
    },
    'DDP 成本': {
      categoryCell:
        'border-amber-200 bg-amber-100 text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100',
      subCell: 'bg-amber-50 dark:bg-amber-950',
    },
    费用支出: {
      categoryCell:
        'border-rose-200 bg-rose-100 text-rose-950 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-100',
      subCell: 'bg-rose-50 dark:bg-rose-950',
    },
    售价与利润: {
      categoryCell:
        'border-emerald-200 bg-emerald-100 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100',
      subCell: 'bg-emerald-50 dark:bg-emerald-950',
    },
    核算规则: {
      categoryCell:
        'border-violet-200 bg-violet-100 text-violet-950 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-100',
      subCell: 'bg-violet-50 dark:bg-violet-950',
    },
  }

  return (
    <div className="max-h-[600px] overflow-auto rounded-xl border border-border/70">
      <table className="w-max min-w-full border-collapse text-xs">
        <thead className="sticky top-0 z-30 bg-[hsl(var(--surface-subtle))]">
          <tr>
            <th className="sticky left-0 z-20 min-w-[116px] whitespace-nowrap border-b border-r bg-[hsl(var(--surface-subtle))] px-3 py-2 text-left font-semibold">
              分类
            </th>
            <th className="sticky left-[116px] z-20 min-w-[150px] whitespace-nowrap border-b border-l bg-[hsl(var(--surface-subtle))] px-3 py-2 text-left font-semibold">
              明细项
            </th>
            {runs.map((run) => (
              <th
                key={run.id}
                className="min-w-[210px] whitespace-nowrap border-b border-l bg-[hsl(var(--surface-subtle))] px-3 py-2 align-top"
              >
                <div className="space-y-1 py-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="max-w-[150px] truncate font-semibold text-foreground">
                      {run.product_name}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      #{run.id}
                    </Badge>
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {formatCompactDate(run.created_at)}
                  </div>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sections.flatMap((section) =>
            section.rows.map((row, index) => (
              <tr
                key={`${section.title}-${row.label}`}
                className={cn(
                  'hover:bg-[hsl(var(--surface-subtle))]',
                  row.label === '售价' || row.label === '利润率'
                    ? 'bg-yellow-50 dark:bg-yellow-950/20'
                    : ''
                )}
              >
                {index === 0 ? (
                  <td
                    rowSpan={section.rows.length}
                    className={cn(
                      'sticky left-0 z-10 min-w-[116px] border-b border-r bg-[hsl(var(--surface-subtle))] p-2 align-top font-semibold whitespace-nowrap',
                      sectionStyles[section.title]?.categoryCell ??
                        'border-border/70 bg-[hsl(var(--surface-subtle))] text-foreground dark:bg-[hsl(var(--surface-soft))]'
                    )}
                  >
                    {section.title}
                  </td>
                ) : null}
                <td
                  className={cn(
                    'sticky left-[116px] z-10 min-w-[150px] border-b border-l p-2 font-medium whitespace-nowrap',
                    row.label === '售价' || row.label === '利润率'
                      ? 'bg-yellow-50 font-bold text-slate-900 dark:bg-yellow-950/30 dark:text-yellow-100'
                      : 'text-muted-foreground',
                    sectionStyles[section.title]?.subCell ?? 'bg-[hsl(var(--surface-panel))]'
                  )}
                >
                  {row.label}
                </td>
                {runs.map((run) => (
                  <td
                    key={`${row.label}-${run.id}`}
                    className={cn(
                      'whitespace-nowrap border-b border-l p-2 align-top leading-5',
                      row.label === '售价' &&
                        'bg-yellow-50 font-semibold text-foreground dark:bg-yellow-950/30',
                      row.label === '利润率' &&
                        'bg-yellow-50 font-semibold text-foreground dark:bg-yellow-950/30'
                    )}
                  >
                    {row.getDisplayValue(run)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
