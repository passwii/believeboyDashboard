'use client'

import { ArrowRight, ArrowUp, ArrowDown, CalendarDays, Download, Factory, Package, Truck, CheckCircle2, Clock, TriangleAlert } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const factorySignals = [
  {
    title: '本周发货计划已确认',
    detail: '全部 SKU 已完成质检，物流已揽收，等待出港。',
    tone: 'positive',
  },
  {
    title: '2 个 SKU 需要补料',
    detail: '库存预警触发，请尽快安排原材料采购，避免断货。',
    tone: 'alert',
  },
  {
    title: '上月对账完成率 98.3%',
    detail: '所有批次已核验，仅剩一笔尾款待收。',
    tone: 'neutral',
  },
]

const factoryTasks = [
  { label: '质检报告上传', owner: '车间A', eta: '今天 14:00', status: '进行中' },
  { label: '包装规格确认', owner: '车间B', eta: '今天 16:00', status: '待确认' },
  { label: '物流单号录入', owner: '仓库', eta: '明天 09:00', status: '待处理' },
]

const factoryMetrics = [
  {
    title: '本月产量',
    value: '12,480',
    unit: '件',
    change: '+8.3%',
    changeType: 'up' as const,
    trend: [80, 85, 82, 90, 88, 95, 100],
    icon: <Package className="h-4 w-4" />,
  },
  {
    title: '待发货',
    value: '2,340',
    unit: '件',
    change: '+5.1%',
    changeType: 'up' as const,
    trend: [50, 55, 60, 58, 65, 70, 68],
    icon: <Truck className="h-4 w-4" />,
  },
  {
    title: '质检合格率',
    value: '99.2%',
    change: '+0.4%',
    changeType: 'up' as const,
    trend: [97, 98, 97.5, 98.5, 99, 99, 99.2],
    icon: <CheckCircle2 className="h-4 w-4" />,
  },
  {
    title: '交期准时率',
    value: '96.8%',
    change: '-0.5%',
    changeType: 'down' as const,
    trend: [98, 97, 98, 97.5, 97, 96.5, 96.8],
    icon: <Clock className="h-4 w-4" />,
  },
]

const recentOrders = [
  { sku: 'BB-7732-BK', product: '多功能收纳包', qty: 800, status: '待发货', deadline: '04-23' },
  { sku: 'BB-5510-GY', product: '轻量旅行背包', qty: 1200, status: '生产中', deadline: '04-26' },
  { sku: 'BB-3391-WT', product: '防水收纳袋', qty: 600, status: '待发货', deadline: '04-25' },
  { sku: 'BB-6620-NV', product: '商务单肩包', qty: 400, status: '质检中', deadline: '04-28' },
]

const statusStyles: Record<string, string> = {
  '待发货': 'bg-secondary/10 text-secondary',
  '生产中': 'bg-primary/10 text-primary',
  '质检中': 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
}

interface MetricCardProps {
  title: string
  value: string
  unit?: string
  change: string
  changeType: 'up' | 'down' | 'neutral'
  trend: number[]
  icon: React.ReactNode
}

function MetricCard({ title, value, unit, change, changeType, trend, icon }: MetricCardProps) {
  const max = Math.max(...trend)
  const min = Math.min(...trend)
  const path = trend
    .map((point, index) => {
      const x = (index / (trend.length - 1)) * 100
      const y = 28 - ((point - min) / Math.max(max - min, 1)) * 22
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`
    })
    .join(' ')

  return (
    <Card className="hover-lift animate-enter min-w-[13rem]">
      <CardHeader className="relative z-10 flex flex-row items-start justify-between space-y-0 pb-4">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="dashboard-kicker">{title}</p>
            <span
              className={`inline-flex items-center text-xs font-medium ${
                changeType === 'up'
                  ? 'text-secondary'
                  : changeType === 'down'
                  ? 'text-destructive'
                  : 'text-muted-foreground'
              }`}
            >
              {changeType === 'up' && <ArrowUp className="mr-0.5 h-3 w-3" />}
              {changeType === 'down' && <ArrowDown className="mr-0.5 h-3 w-3" />}
              {change}
            </span>
          </div>
          <CardTitle className="dashboard-display text-[clamp(2rem,2.4vw,2.55rem)]">
            {value}
            {unit && <span className="ml-1 text-base font-medium text-muted-foreground">{unit}</span>}
          </CardTitle>
        </div>
        <div className="rounded-lg bg-secondary/10 p-2.5 text-secondary">{icon}</div>
      </CardHeader>
      <CardContent className="relative z-10">
        <div className="h-12 w-full rounded-md bg-[hsl(var(--surface-subtle))] px-1 py-1">
          <svg viewBox="0 0 100 30" className="h-full w-full overflow-visible">
            <path d={`${path} L 100 30 L 0 30 Z`} fill="hsl(var(--secondary) / 0.12)" />
            <path d={path} fill="none" stroke="hsl(var(--secondary))" strokeWidth="2.25" strokeLinecap="round" />
          </svg>
        </div>
      </CardContent>
    </Card>
  )
}

interface FactoryDashboardProps {
  operatorName?: string | null
}

export function FactoryDashboard({ operatorName }: FactoryDashboardProps) {
  return (
    <div className="space-y-8 md:space-y-10">
      {/* Hero */}
      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_22rem]">
        <div className="dashboard-surface animate-enter px-3 py-5 md:px-5 md:py-6 dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
          <div className="relative z-10 flex flex-wrap items-start justify-between gap-5">
            <div className="max-w-3xl space-y-4">
              <Badge variant="secondary" className="inline-flex h-8 items-center rounded-md bg-secondary/10 px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-secondary">
                Factory Dashboard
              </Badge>
              <div className="space-y-3">
                <h2 className="max-w-2xl text-[clamp(2.2rem,4vw,3.6rem)] font-semibold leading-[0.94] tracking-[-0.05em] text-foreground">
                  专注生产进度，掌控每一批次准时交付。
                </h2>
                <p className="max-w-2xl text-sm leading-7 text-muted-foreground md:text-base">
                  这里展示您的店铺专属产量、发货与质检数据，实时追踪生产节奏，确保交期无误。
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button variant="outline" className="rounded-md border-white/45 bg-[hsl(var(--surface-subtle))] shadow-none dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
                <CalendarDays className="h-4 w-4" />
                本月数据
              </Button>
              <Button className="rounded-md bg-[linear-gradient(135deg,hsl(var(--primary)),hsl(213_100%_47%))]">
                <Download className="h-4 w-4" />
                导出生产报告
              </Button>
            </div>
          </div>
        </div>

        {/* Signals */}
        <aside className="dashboard-surface animate-enter px-3 py-5 md:px-4 dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
          <div className="relative z-10 space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="dashboard-kicker">实时信号</p>
                <h3 className="mt-1 text-lg font-semibold tracking-tight">今日生产信号</h3>
              </div>
              <div className="rounded-md bg-secondary/10 p-2 text-secondary">
                <Factory className="h-4 w-4" />
              </div>
            </div>
            <div className="space-y-3">
              {factorySignals.map((signal) => (
                <div key={signal.title} className="rounded-md bg-[hsl(var(--surface-subtle))] p-4 dark:border dark:border-border/70 dark:bg-[hsl(var(--surface-soft))]">
                  <div className="mb-2 flex items-start gap-3">
                    <div className={`mt-0.5 h-2.5 w-2.5 rounded-full ${signal.tone === 'positive' ? 'bg-secondary' : signal.tone === 'alert' ? 'bg-destructive' : 'bg-primary'}`} />
                    <p className="text-sm font-semibold leading-6 text-foreground">{signal.title}</p>
                  </div>
                  <p className="text-sm leading-6 text-muted-foreground">{signal.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </section>

      {/* Metrics */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {factoryMetrics.map((metric) => (
          <MetricCard key={metric.title} {...metric} />
        ))}
      </div>

      {/* Orders table + Task queue */}
      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_22rem]">
        <Card className="animate-enter dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
          <CardHeader className="relative z-10 pb-4">
            <p className="dashboard-kicker">店铺订单</p>
            <CardTitle>当前批次概览</CardTitle>
            <CardDescription>
              您店铺专属的批次生产与发货状态一览。
            </CardDescription>
          </CardHeader>
          <CardContent className="relative z-10">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/70">
                    <th className="pb-3 pr-4 text-left font-medium text-muted-foreground">SKU</th>
                    <th className="pb-3 pr-4 text-left font-medium text-muted-foreground">产品</th>
                    <th className="pb-3 pr-4 text-right font-medium text-muted-foreground">数量</th>
                    <th className="pb-3 pr-4 text-center font-medium text-muted-foreground">状态</th>
                    <th className="pb-3 text-right font-medium text-muted-foreground">交期</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {recentOrders.map((order) => (
                    <tr key={order.sku} className="hover:bg-[hsl(var(--surface-subtle))] dark:hover:bg-[hsl(var(--surface-soft))]">
                      <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">{order.sku}</td>
                      <td className="py-3 pr-4 font-medium">{order.product}</td>
                      <td className="py-3 pr-4 text-right font-mono">{order.qty.toLocaleString()}</td>
                      <td className="py-3 pr-4 text-center">
                        <Badge className={statusStyles[order.status] ?? 'bg-muted text-muted-foreground'}>
                          {order.status}
                        </Badge>
                      </td>
                      <td className="py-3 text-right text-muted-foreground">{order.deadline}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Task queue */}
        <Card className="hover-lift animate-enter dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
          <CardHeader className="relative z-10 pb-4">
            <p className="dashboard-kicker">待办队列</p>
            <CardTitle>待推进事项</CardTitle>
            <CardDescription>
              本周车间待处理任务列表，优先处理即将到期的批次。
            </CardDescription>
          </CardHeader>
          <CardContent className="relative z-10 space-y-3">
            {factoryTasks.map((item) => (
              <div key={item.label} className="rounded-md bg-[hsl(var(--surface-subtle))] p-4 dark:border dark:border-border/70 dark:bg-[hsl(var(--surface-soft))]">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-foreground">{item.label}</p>
                  <Badge
                    variant="secondary"
                    className={
                      item.status === '待处理'
                        ? 'bg-destructive/10 text-destructive'
                        : item.status === '进行中'
                        ? 'bg-primary/10 text-primary'
                        : 'bg-secondary/10 text-secondary'
                    }
                  >
                    {item.status}
                  </Badge>
                </div>
                <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                  <span>{item.owner}</span>
                  <span>{item.eta}</span>
                </div>
              </div>
            ))}

            <div className="rounded-lg bg-[linear-gradient(135deg,hsl(var(--amber-500)/0.08),hsl(var(--primary)/0.06))] p-4 dark:border dark:border-border/70 dark:bg-[linear-gradient(135deg,hsl(var(--surface-soft)),hsl(var(--surface-strong)/0.65))]">
              <div className="mb-2 flex items-center gap-2 text-amber-500 dark:text-amber-400">
                <TriangleAlert className="h-4 w-4" />
                <span className="text-sm font-semibold">缺料预警</span>
              </div>
              <p className="text-sm leading-6 text-foreground/88">
                SKU BB-5510-GY 原材料库存不足 200 件，请尽快联系采购补料，避免影响交期。
              </p>
              <Button variant="ghost" className="mt-3 h-auto px-0 text-primary">
                查看详情
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
