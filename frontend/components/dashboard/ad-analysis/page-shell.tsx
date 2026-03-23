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
          className="rounded-xl border border-border/50 bg-background/70 px-3 py-2 text-sm text-muted-foreground"
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
      <Card className="overflow-hidden border-border/70 bg-card/90 shadow-sm">
        <CardHeader className="relative overflow-hidden border-b border-border/60 bg-gradient-to-br from-slate-50 via-background to-amber-50/70">
          <div className="absolute inset-y-0 right-0 w-48 bg-[radial-gradient(circle_at_center,rgba(245,158,11,0.12),transparent_70%)]" />
          <div className="relative space-y-3">
            <Badge variant="outline" className="w-fit border-slate-300/80 bg-background/80 text-slate-700">
              广告分析 / {tab.label}
            </Badge>
            <div>
              <CardTitle className="text-2xl">{tab.label}分析</CardTitle>
              <CardDescription className="mt-2 max-w-3xl text-sm leading-6">
                {tab.summary}
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              {tab.keyMetrics.map((metric) => (
                <Badge key={metric} variant="secondary" className="rounded-full">
                  {metric}
                </Badge>
              ))}
            </div>
          </div>
        </CardHeader>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="border-border/70 bg-card/90 shadow-sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Target className="h-4 w-4 text-slate-500" />
              <CardTitle className="text-lg">核心分析目标</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <SimpleList items={tab.goals} />
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/90 shadow-sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-slate-500" />
              <CardTitle className="text-lg">建议关联原始报表</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <SimpleList items={tab.sourceReports} />
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/90 shadow-sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-slate-500" />
              <CardTitle className="text-lg">建议 Drill 路径</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {tab.drillPath.map((path) => (
              <div
                key={path}
                className="flex items-center justify-between rounded-xl border border-border/50 bg-background/70 px-3 py-3 text-sm"
              >
                <span>{path}</span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/90 shadow-sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-slate-500" />
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
