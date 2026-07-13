import { ArrowRight, Database, GitBranch, Target, TrendingUp } from 'lucide-react'

import type { AdAnalysisTabConfig } from '@/components/dashboard/ad-analysis/config'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

type Props = {
  tab: AdAnalysisTabConfig
}

function SimpleList({ items }: { items: string[] }) {
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div
          key={item}
          className="rounded-md border border-border/70 bg-[hsl(var(--surface-soft))] px-3 py-2 text-sm text-muted-foreground dark:border-border/80 dark:bg-[hsl(var(--surface-strong))] dark:text-foreground/80"
        >
          {item}
        </div>
      ))}
    </div>
  )
}

export function AdAnalysisPageShell({ tab }: Props) {
  return (
    <div className="space-y-5">
      <Card className="dashboard-surface overflow-hidden">
        <CardHeader className="relative overflow-hidden pb-5">
          <div className="absolute inset-y-0 right-0 w-48 bg-[radial-gradient(circle_at_center,hsl(var(--primary)/0.14),transparent_72%)] dark:bg-[radial-gradient(circle_at_center,hsl(var(--primary)/0.18),transparent_72%)]" />
          <div className="relative space-y-4">
            <div className="space-y-2">
              <p className="dashboard-kicker">分析控制台</p>
              <div>
                <CardTitle className="text-2xl md:text-[2.2rem]">{tab.label}分析</CardTitle>
                <CardDescription className="mt-2 max-w-3xl text-sm leading-7">
                  {tab.summary}
                </CardDescription>
              </div>
            </div>

            <Badge
              variant="outline"
              className="w-fit border-border/70 bg-[hsl(var(--surface-subtle))] text-foreground dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]"
            >
              广告分析 · {tab.label}
            </Badge>

            <div className="dashboard-toolbar flex flex-wrap gap-2">
              {tab.keyMetrics.map((metric) => (
                <Badge key={metric} variant="secondary">
                  {metric}
                </Badge>
              ))}
            </div>
          </div>
        </CardHeader>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="hover-lift">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Target className="h-4 w-4 text-primary" />
              <CardTitle className="text-lg">核心分析目标</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <SimpleList items={tab.goals} />
          </CardContent>
        </Card>

        <Card className="hover-lift">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-secondary" />
              <CardTitle className="text-lg">建议关联原始报表</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <SimpleList items={tab.sourceReports} />
          </CardContent>
        </Card>

        <Card className="hover-lift">
          <CardHeader>
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-primary" />
              <CardTitle className="text-lg">建议 Drill 路径</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {tab.drillPath.map((path) => (
              <div
                key={path}
                className="flex items-center justify-between rounded-md border border-border/70 bg-[hsl(var(--surface-soft))] px-3 py-3 text-sm dark:border-border/80 dark:bg-[hsl(var(--surface-strong))]"
              >
                <span>{path}</span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="hover-lift">
          <CardHeader>
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-secondary" />
              <CardTitle className="text-lg">建议调控规则</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <SimpleList items={tab.adjustmentRules} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
