'use client'

import { type ReactNode, Suspense } from 'react'

import { AnalyticsContentLoading } from '@/components/dashboard/page-skeletons'
import { AdAnalysisTabNav } from '@/components/dashboard/ad-analysis/tab-nav'
import { AdAnalysisTopFilters } from '@/components/dashboard/ad-analysis/top-filters'
import { TermErrorBar } from '@/components/dashboard/ad-analysis/term-chrome'

/**
 * BLF-818 · Pattern B 双轴分析画布（广告分析页终端化）。
 *
 * 布局骨架：h-full 列框架钉死在 #main-content 高度内 ——
 *   顶部 Console 工具条（项目/站点/日期筛选，终端化）→ h-8 子 Tab 栏 →
 *   内容区（flex-1 独立滚动，各子页自行决定内部滚动策略）。
 * 文档不出现滚动条；Tab 切换只换内容区，工具条/Tab 栏不动 → 无布局抖动。
 */
export default function AdAnalysisLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      <div className="shrink-0">
        <AdAnalysisTopFilters />
      </div>
      <TermErrorBar />
      <div className="shrink-0">
        <AdAnalysisTabNav />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <Suspense fallback={<AnalyticsContentLoading />}>{children}</Suspense>
      </div>
    </div>
  )
}
