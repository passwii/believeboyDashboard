'use client'

import { Skeleton } from '@/components/ui/skeleton'
import {
  TermBody,
  TermCell,
  TermHead,
  TermRow,
  TermTHead,
  TermTable,
} from '@/components/terminal/term-table'

export type DailyAnalysisTableRow = {
  date: string
  order_qty: number
  sales_amount: number
  impressions: number
  clicks: number
  cpc: number
  ad_spend: number
  ad_orders: number
  page_views: number
  units_ordered: number
  conversion_rate: number
}

const numberFmt = new Intl.NumberFormat('en-US')
const currencyFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

/** 环比涨跌 tone：>=前日 涨绿 / <前日 跌红 / 无对比 muted */
function deltaTone(current: number, previous: number): 'pos' | 'neg' | 'muted' {
  if (!Number.isFinite(previous) || previous === 0 || !Number.isFinite(current)) return 'muted'
  return current >= previous ? 'pos' : 'neg'
}

/**
 * 近 N 天销售明细高密度表（BLF-809 Pattern A 示范列）：
 * 行高 28px、等宽数字右对齐、订单/销售额按日环比着色。
 */
export function DailyAnalysisTable({
  rows,
  loading,
  maxRows = 14,
}: {
  rows: DailyAnalysisTableRow[]
  loading?: boolean
  maxRows?: number
}) {
  if (loading) {
    return (
      <div className="space-y-px p-px">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-7 w-full rounded-none" />
        ))}
      </div>
    )
  }

  // 接口按日期升序返回；倒序展示（最新在上），prev 取时间上的前一天用于环比
  const withPrev = rows.map((row, index) => ({ row, prev: rows[index - 1] }))
  const sorted = withPrev.slice(-maxRows).reverse()

  if (sorted.length === 0) {
    return <p className="p-4 text-xs text-term-faint">暂无数据</p>
  }

  return (
    <div className="max-h-[336px] overflow-y-auto term-scroll">
      <TermTable>
        <TermTHead>
          <TermRow>
            <TermHead>日期</TermHead>
            <TermHead numeric>订单</TermHead>
            <TermHead numeric>销量</TermHead>
            <TermHead numeric>销售额</TermHead>
            <TermHead numeric>广告花费</TermHead>
            <TermHead numeric>CPC</TermHead>
            <TermHead numeric>点击</TermHead>
            <TermHead numeric>曝光</TermHead>
            <TermHead numeric>转化率</TermHead>
          </TermRow>
        </TermTHead>
        <TermBody>
          {sorted.map(({ row, prev }) => (
            <TermRow key={row.date}>
              <TermCell tone="muted">{row.date}</TermCell>
              <TermCell numeric tone={deltaTone(row.order_qty, prev?.order_qty ?? Number.NaN)}>
                {numberFmt.format(row.order_qty)}
              </TermCell>
              <TermCell numeric>{numberFmt.format(row.units_ordered)}</TermCell>
              <TermCell numeric tone={deltaTone(row.sales_amount, prev?.sales_amount ?? Number.NaN)}>
                ${currencyFmt.format(row.sales_amount)}
              </TermCell>
              <TermCell numeric>${currencyFmt.format(row.ad_spend)}</TermCell>
              <TermCell numeric>${row.cpc.toFixed(2)}</TermCell>
              <TermCell numeric>{numberFmt.format(row.clicks)}</TermCell>
              <TermCell numeric>{numberFmt.format(row.impressions)}</TermCell>
              <TermCell numeric>{fmtPct(row.conversion_rate)}</TermCell>
            </TermRow>
          ))}
        </TermBody>
      </TermTable>
    </div>
  )
}
