'use client'

import { useMemo } from 'react'
import { ShoppingBag } from 'lucide-react'
import { DataCard, DataCardContent } from '@/components/ui/data-card'
import { Skeleton } from '@/components/ui/skeleton'
import type { SkuSalesDetailItem } from '@/hooks/use-dashboard-overview'

interface SkuSalesDetailTableProps {
  data: SkuSalesDetailItem[] | undefined
  loading?: boolean
  mode?: 'today' | 'weekly'
}

function formatSalesAmount(val: number): string {
  // Always show full dollar amount for values under $10k for clarity
  // Handles up to $9999.99 without abbreviation
  if (val >= 10000) {
    return `$${(val / 1000).toFixed(1)}k`
  }
  return `$${val.toFixed(2)}`
}

export function SkuSalesDetailTable({ data, loading = false, mode = 'today' }: SkuSalesDetailTableProps) {
  // Filter out rows where both quantity and sales_amount are 0
  const filteredData = useMemo(() => {
    if (!data) return undefined
    return data.filter((item) => item.quantity > 0 || item.sales_amount > 0)
  }, [data])

  const periodLabel = mode === 'today' ? '今日' : '本周'

  if (loading && !data) {
    return <SkuSalesDetailSkeleton periodLabel={periodLabel} />
  }

  return (
    <DataCard>
      <div className="flex items-center gap-2 border-b border-border/70 bg-[hsl(var(--surface-subtle))] px-5 py-3">
        <span className="text-secondary">
          <ShoppingBag className="h-4 w-4" />
        </span>
        <span className="text-sm font-medium">{periodLabel}销售SKU明细</span>
        {filteredData && filteredData.length > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">共 {filteredData.length} 个 SKU</span>
        )}
      </div>
      <DataCardContent className="px-5 py-4">
        {(!filteredData || filteredData.length === 0) ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{periodLabel}暂无销售记录</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border/50 text-left">
                  <th className="pb-2.5 pr-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">SKU</th>
                  <th className="pb-2.5 pr-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">品名</th>
                  <th className="pb-2.5 pl-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground w-[5.5rem]">数量</th>
                  <th className="pb-2.5 pl-4 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground w-[7rem]">销售额</th>
                </tr>
              </thead>
              <tbody>
                {filteredData.map((item, index) => (
                  <tr
                    key={item.sku}
                    className={`border-b border-border/30 transition-colors hover:bg-[hsl(var(--surface-subtle))]/50 ${
                      index === filteredData.length - 1 ? 'border-b-0' : ''
                    }`}
                  >
                    <td className="py-3 pr-4">
                      <span className="font-mono text-[13px] font-medium text-foreground">{item.sku}</span>
                    </td>
                    <td className="py-3 pr-4">
                      <span className="text-[13px] text-muted-foreground line-clamp-1">
                        {item.product_name || '-'}
                      </span>
                    </td>
                    <td className="py-3 pl-4 text-right">
                      <span className="text-[1.05rem] font-semibold tabular-nums leading-none">{item.quantity}</span>
                    </td>
                    <td className="py-3 pl-4 text-right">
                      <span className="text-[1.1rem] font-bold tabular-nums leading-none text-secondary">
                        {formatSalesAmount(item.sales_amount)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataCardContent>
    </DataCard>
  )
}

function SkuSalesDetailSkeleton({ periodLabel }: { periodLabel: string }) {
  return (
    <DataCard>
      <div className="flex items-center gap-2 border-b border-border/70 bg-[hsl(var(--surface-subtle))] px-5 py-3">
        <span className="text-secondary">
          <ShoppingBag className="h-4 w-4" />
        </span>
        <span className="text-sm font-medium">{periodLabel}销售SKU明细</span>
      </div>
      <DataCardContent className="px-5 py-4">
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-5 w-14" />
              <Skeleton className="h-5 w-20" />
            </div>
          ))}
        </div>
      </DataCardContent>
    </DataCard>
  )
}
