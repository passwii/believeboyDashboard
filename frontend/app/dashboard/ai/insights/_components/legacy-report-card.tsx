'use client'

import { InsightMarkdown } from '@/components/insight'

import styles from '../insights-warm.module.css'
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
      className={styles.reportRoot}
      data-warm-insight-report
    >
      <div className={styles.reportHeader}>
        <span className={styles.reportBadge}>AI Insight Report</span>
      </div>
      <div className={styles.reportBody}>
        <InsightMarkdown
          content={content}
          state="final"
          appearance="warm"
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
