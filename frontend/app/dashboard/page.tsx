import { MetricCards } from '@/components/dashboard/metric-cards'
import { VisitorsChart } from '@/components/dashboard/charts'
import { DataTable } from '@/components/dashboard/data-table'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Sparkles } from 'lucide-react'

export default function DashboardPage() {
  return (
    <div className="space-y-6 md:space-y-7">
      <section className="dashboard-surface animate-enter px-5 py-5 md:px-7 md:py-7">
        <div className="relative z-10 flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl space-y-2.5">
            <Badge variant="secondary" className="inline-flex h-7 items-center rounded-full px-3 text-[11px] font-medium uppercase tracking-[0.14em]">
              Dashboard Overview
            </Badge>
            <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
              运营总览与关键数据面板
            </h1>
            <p className="text-sm leading-6 text-muted-foreground md:text-base">
              Welcome back. 这里集中展示关键指标、趋势变化与运营事项，帮助你更快完成每日判断与执行。
            </p>
          </div>
          <div className="relative z-10 rounded-xl border border-primary/20 bg-primary/10 p-3 text-primary shadow-sm animate-float">
            <Sparkles className="h-5 w-5" />
          </div>
        </div>
      </section>

      <MetricCards />

      <div className="grid gap-5 md:gap-6 lg:grid-cols-7">
        <VisitorsChart />
        <Card className="col-span-3 dashboard-surface hover-lift">
          <CardHeader className="relative z-10">
            <CardTitle className="text-xl">Recent Activity</CardTitle>
            <CardDescription className="text-sm md:text-[15px]">
              Your latest actions and updates
            </CardDescription>
          </CardHeader>
          <CardContent className="relative z-10">
            <div className="space-y-4">
              <div className="flex items-center gap-4 rounded-lg border border-transparent p-1.5 transition-colors hover:border-border/70 hover:bg-muted/40">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                  <span className="text-sm font-semibold">JD</span>
                </div>
                <div className="flex-1 space-y-1">
                  <p className="text-sm font-medium leading-none">John Doe</p>
                  <p className="text-sm text-muted-foreground">
                    Created a new document
                  </p>
                </div>
                <div className="text-sm text-muted-foreground">2m ago</div>
              </div>
              <div className="flex items-center gap-4 rounded-lg border border-transparent p-1.5 transition-colors hover:border-border/70 hover:bg-muted/40">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                  <span className="text-sm font-semibold">JS</span>
                </div>
                <div className="flex-1 space-y-1">
                  <p className="text-sm font-medium leading-none">Jane Smith</p>
                  <p className="text-sm text-muted-foreground">
                    Updated the API documentation
                  </p>
                </div>
                <div className="text-sm text-muted-foreground">15m ago</div>
              </div>
              <div className="flex items-center gap-4 rounded-lg border border-transparent p-1.5 transition-colors hover:border-border/70 hover:bg-muted/40">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                  <span className="text-sm font-semibold">BJ</span>
                </div>
                <div className="flex-1 space-y-1">
                  <p className="text-sm font-medium leading-none">Bob Johnson</p>
                  <p className="text-sm text-muted-foreground">
                    Completed review of PR #42
                  </p>
                </div>
                <div className="text-sm text-muted-foreground">1h ago</div>
              </div>
              <div className="flex items-center gap-4 rounded-lg border border-transparent p-1.5 transition-colors hover:border-border/70 hover:bg-muted/40">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                  <span className="text-sm font-semibold">AB</span>
                </div>
                <div className="flex-1 space-y-1">
                  <p className="text-sm font-medium leading-none">Alice Brown</p>
                  <p className="text-sm text-muted-foreground">
                    Deployed to production
                  </p>
                </div>
                <div className="text-sm text-muted-foreground">3h ago</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="dashboard-surface animate-enter">
        <CardHeader className="relative z-10">
          <CardTitle className="text-xl">运营工具</CardTitle>
          <CardDescription className="text-sm md:text-[15px]">
            常用运营工具与近期文件状态。
          </CardDescription>
        </CardHeader>
        <CardContent className="relative z-10">
          <DataTable />
        </CardContent>
      </Card>
    </div>
  )
}
