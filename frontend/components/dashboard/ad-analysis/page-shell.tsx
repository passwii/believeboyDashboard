import { ArrowRight, Database, GitBranch, Target, TrendingUp } from 'lucide-react'

import type { AdAnalysisTabConfig } from '@/components/dashboard/ad-analysis/config'
import { TermPanel } from '@/components/terminal/term-panel'
import { TermPill } from '@/components/terminal/term-controls'

type Props = {
  tab: AdAnalysisTabConfig
}

function SimpleList({ items }: { items: string[] }) {
  return (
    <div className="space-y-1">
      {items.map((item) => (
        <div
          key={item}
          className="rounded-none border border-term-border bg-term-panel px-2 py-1.5 font-mono text-xs leading-5 text-term-muted"
        >
          {item}
        </div>
      ))}
    </div>
  )
}

export function AdAnalysisPageShell({ tab }: Props) {
  return (
    <div className="flex flex-col gap-3">
      <TermPanel title={`${tab.label}分析`} bodyClassName="p-3">
        <div className="flex flex-col gap-2">
          <p className="font-mono text-xs leading-5 text-term-muted">{tab.summary}</p>
          <div className="flex flex-wrap gap-1">
            <TermPill tone="info">广告分析 · {tab.label}</TermPill>
            {tab.keyMetrics.map((metric) => (
              <TermPill key={metric} tone="muted">{metric}</TermPill>
            ))}
          </div>
        </div>
      </TermPanel>

      <div className="grid gap-2 xl:grid-cols-2">
        <TermPanel title="核心分析目标" bodyClassName="p-2">
          <div className="flex items-center gap-1.5 pb-2 font-mono text-[11px] uppercase tracking-wider text-term-faint">
            <Target className="h-3.5 w-3.5" aria-hidden />
            目标
          </div>
          <SimpleList items={tab.goals} />
        </TermPanel>

        <TermPanel title="建议关联原始报表" bodyClassName="p-2">
          <div className="flex items-center gap-1.5 pb-2 font-mono text-[11px] uppercase tracking-wider text-term-faint">
            <Database className="h-3.5 w-3.5" aria-hidden />
            原始报表
          </div>
          <SimpleList items={tab.sourceReports} />
        </TermPanel>

        <TermPanel title="建议 Drill 路径" bodyClassName="p-2">
          <div className="flex items-center gap-1.5 pb-2 font-mono text-[11px] uppercase tracking-wider text-term-faint">
            <GitBranch className="h-3.5 w-3.5" aria-hidden />
            路径
          </div>
          <div className="space-y-1">
            {tab.drillPath.map((path) => (
              <div
                key={path}
                className="flex items-center justify-between rounded-none border border-term-border bg-term-panel px-2 py-1.5 font-mono text-xs text-term-muted"
              >
                <span>{path}</span>
                <ArrowRight className="h-3.5 w-3.5 text-term-faint" />
              </div>
            ))}
          </div>
        </TermPanel>

        <TermPanel title="建议调控规则" bodyClassName="p-2">
          <div className="flex items-center gap-1.5 pb-2 font-mono text-[11px] uppercase tracking-wider text-term-faint">
            <TrendingUp className="h-3.5 w-3.5" aria-hidden />
            规则
          </div>
          <SimpleList items={tab.adjustmentRules} />
        </TermPanel>
      </div>
    </div>
  )
}
