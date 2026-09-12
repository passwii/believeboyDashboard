'use client'

import { InsightMarkdown } from '@/components/insight'

import { ChartCodeBlock, LEGACY_CHART_LANGUAGES } from './chart-code-block'

/**
 * 旧洞察正文卡片（兼容 adapter，BLF-1017）。
 *
 * 旧页面的正文渲染被拆成两层：共享 `InsightMarkdown` 负责 Markdown；
 * 这里保留旧的外壳（`#ai-insight-export-root` 卡片 + 徽标），因为 PNG 导出
 * 依赖该 id 截图，`ChartCodeBlock` 依赖 `collectChartSvgs` 出静态 SVG。
 */
export function LegacyReportCard({
  content,
  collectChartSvgs,
  exportFileName,
}: {
  content: string
  collectChartSvgs?: boolean
  exportFileName?: string
}) {
  return (
    <div
      id="ai-insight-export-root"
      className="max-w-full min-w-0 overflow-hidden rounded-none border border-term-border bg-term-panel"
    >
      <div className="border-b border-term-border bg-term-raised px-4 py-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full border border-border/70 bg-background/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-term-faint">
            AI Insight Report
          </span>
        </div>
      </div>
      <div className="px-6 py-6 sm:px-8">
        <InsightMarkdown
          content={content}
          state="final"
          chartLanguages={LEGACY_CHART_LANGUAGES}
          renderChartBlock={(block) => (
            <ChartCodeBlock
              chartType={block.language}
              code={block.code}
              collectChartSvgs={collectChartSvgs}
            />
          )}
          exportFileName={exportFileName}
        />
      </div>
    </div>
  )
}
