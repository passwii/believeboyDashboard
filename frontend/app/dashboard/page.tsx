import { ArrowRight, CalendarDays, Download, Sparkles, TriangleAlert } from 'lucide-react'
import { MetricCards } from '@/components/dashboard/metric-cards'
import { VisitorsChart } from '@/components/dashboard/charts'
import { DataTable } from '@/components/dashboard/data-table'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const focusSignals = [
  {
    title: '美国站广告回报在 14:00 后抬升',
    detail: '建议放宽 evening bid cap，并观察 ACOS 是否继续回落。',
    tone: 'positive',
  },
  {
    title: '英国站补货覆盖仅剩 11 天',
    detail: '高周转 SKU 已接近预警阈值，优先安排海运转空派校准。',
    tone: 'alert',
  },
  {
    title: '月报利润差异缩小至 2.1%',
    detail: '财务口径和运营口径已基本对齐，可进入最终归档阶段。',
    tone: 'neutral',
  },
]

const actionQueue = [
  { label: '月报对账', owner: 'Lina', eta: '今天 16:30', status: '进行中' },
  { label: '补货建议复核', owner: 'Sean', eta: '今天 18:00', status: '高优先级' },
  { label: '广告词包整理', owner: 'Nora', eta: '明天 10:00', status: '待确认' },
]

export default function DashboardPage() {
  return (
    <div className="space-y-8 md:space-y-10">
      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_22rem]">
        <div className="dashboard-surface animate-enter px-3 py-5 md:px-5 md:py-6">
          <div className="relative z-10 flex flex-wrap items-start justify-between gap-5">
            <div className="max-w-3xl space-y-4">
              <Badge variant="secondary" className="inline-flex h-8 items-center rounded-full bg-secondary/10 px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-secondary">
                Workbench Intelligence
              </Badge>
              <div className="space-y-3">
                <h2 className="max-w-2xl text-[clamp(2.2rem,4vw,3.6rem)] font-semibold leading-[0.94] tracking-[-0.05em] text-foreground">
                  把关键数据编排成一张可以直接做决定的运营版面。
                </h2>
                <p className="max-w-2xl text-sm leading-7 text-muted-foreground md:text-base">
                  这里聚合今日核心销售、广告和补货异常，用更清晰的版式把“变化本身”推到最前面，而不是把你埋进一堆边框和表格里。
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button variant="outline" className="rounded-2xl border-0 bg-[hsl(var(--surface-low))] shadow-none">
                <CalendarDays className="h-4 w-4" />
                最近 24 小时
              </Button>
              <Button className="rounded-2xl bg-[linear-gradient(135deg,hsl(var(--primary)),hsl(213_100%_47%))]">
                <Download className="h-4 w-4" />
                导出经营快照
              </Button>
            </div>
          </div>
        </div>

        <aside className="dashboard-surface animate-enter px-3 py-5 md:px-4">
          <div className="relative z-10 space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="dashboard-kicker">Live Signal</p>
                <h3 className="mt-1 text-lg font-semibold tracking-tight">今日信号摘要</h3>
              </div>
              <div className="rounded-[1.1rem] bg-primary/10 p-2 text-primary">
                <Sparkles className="h-4 w-4" />
              </div>
            </div>
            <div className="space-y-3">
              {focusSignals.map((signal) => (
                <div key={signal.title} className="rounded-[1.35rem] bg-[hsl(var(--surface-low))] p-4">
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

      <MetricCards />

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_22rem]">
        <VisitorsChart />

        <Card className="hover-lift animate-enter">
          <CardHeader className="relative z-10 pb-4">
            <p className="dashboard-kicker">Action Queue</p>
            <CardTitle>待推进事项</CardTitle>
            <CardDescription>
              把需要人工判断的动作压缩成一个短列表，避免在系统里来回找。
            </CardDescription>
          </CardHeader>
          <CardContent className="relative z-10 space-y-3">
            {actionQueue.map((item) => (
              <div key={item.label} className="rounded-[1.3rem] bg-[hsl(var(--surface-low))] p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-foreground">{item.label}</p>
                  <Badge
                    variant="secondary"
                    className={
                      item.status === '高优先级'
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

            <div className="rounded-[1.35rem] bg-[linear-gradient(135deg,hsl(var(--secondary)/0.12),hsl(var(--primary)/0.08))] p-4">
              <div className="mb-2 flex items-center gap-2 text-secondary">
                <TriangleAlert className="h-4 w-4" />
                <span className="text-sm font-semibold">异常提醒</span>
              </div>
              <p className="text-sm leading-6 text-foreground/88">
                近 3 天存在两个 SKU 的销量增速快于广告预算增速，建议在广告分析页进一步看 placement 和 search term 结构。
              </p>
              <Button variant="ghost" className="mt-3 h-auto px-0 text-primary">
                前往分析页
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      <Card className="animate-enter">
        <CardHeader className="relative z-10 pb-4">
          <p className="dashboard-kicker">Operational Ledger</p>
          <CardTitle>运营工具与当前进度</CardTitle>
          <CardDescription>
            用更轻的表格层次承接日常任务，保持信息密度，同时不让界面重新变回传统 ERP 的“表格墙”。
          </CardDescription>
        </CardHeader>
        <CardContent className="relative z-10">
          <DataTable />
        </CardContent>
      </Card>
    </div>
  )
}
