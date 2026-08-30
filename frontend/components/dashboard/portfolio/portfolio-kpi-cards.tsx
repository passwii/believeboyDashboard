'use client'

import { TrendingUp, ShoppingCart, CreditCard, MousePointer, BarChart3 } from 'lucide-react'
import type { PortfolioSummary } from '@/lib/hooks/use-portfolio-data'

interface PortfolioKPICardsProps {
  data: PortfolioSummary
  country: string
}

const CURRENCY_SYMBOL: Record<string, string> = {
  US: '$',
  DE: '€',
  UK: '£',
}

function formatMoney(value: number, country: string): string {
  const symbol = CURRENCY_SYMBOL[country] ?? '$'
  if (value >= 10000) {
    return `${symbol}${(value / 10000).toFixed(1)}万`
  }
  return `${symbol}${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatNumber(value: number): string {
  if (value >= 10000) {
    return `${(value / 10000).toFixed(1)}万`
  }
  return value.toLocaleString('zh-CN')
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`
}

interface KPICardProps {
  label: string
  value: string
  icon: React.ReactNode
  trend?: string
  description?: string
}

function KPICard({ label, value, icon, trend, description }: KPICardProps) {
  return (
    // BLF-893：portfolio KPI 终端化——零圆角、term 令牌、mono 等宽数值，去掉 emerald 旧式双色。
    <div className="flex min-w-0 flex-col gap-2 rounded-none border border-term-border bg-term-bg p-3 sm:p-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-wider text-term-muted">
          {label}
        </span>
        <div className="flex h-7 w-7 items-center justify-center rounded-none border border-term-border bg-term-panel text-term-accent">
          {icon}
        </div>
      </div>
      <div className="flex flex-col">
        <span className="font-mono text-lg leading-6 tabular-nums text-term-text sm:text-xl">
          {value}
        </span>
        {trend && <span className="font-mono text-[11px] leading-4 text-term-pos">{trend}</span>}
        {description && (
          <span className="font-mono text-[11px] leading-4 text-term-muted">{description}</span>
        )}
      </div>
    </div>
  )
}

export function PortfolioKPICards({ data, country }: PortfolioKPICardsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-5">
      <KPICard
        label="总销售额"
        value={formatMoney(data.total_sales_amount, country)}
        icon={<TrendingUp className="h-4 w-4" />}
      />
      <KPICard
        label="总订单量"
        value={formatNumber(data.total_order_qty)}
        icon={<ShoppingCart className="h-4 w-4" />}
      />
      <KPICard
        label="总广告费"
        value={formatMoney(data.total_ad_spend, country)}
        icon={<CreditCard className="h-4 w-4" />}
      />
      <KPICard
        label="平均转化率"
        value={formatPercent(data.avg_conversion_rate)}
        icon={<MousePointer className="h-4 w-4" />}
        description={`${data.total_sessions.toLocaleString()} 次访问`}
      />
      <KPICard
        label="项目数量"
        value={String(data.projects.length)}
        icon={<BarChart3 className="h-4 w-4" />}
      />
    </div>
  )
}
