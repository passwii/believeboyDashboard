'use client'

import { type ReactNode, Suspense } from 'react'

import { AnalyticsContentLoading } from '@/components/dashboard/page-skeletons'
import { AdAnalysisTabNav } from '@/components/dashboard/ad-analysis/tab-nav'
import { AdAnalysisTopFilters } from '@/components/dashboard/ad-analysis/top-filters'

/**
 * BLF-818 · Pattern B 双轴分析画布（广告分析页终端化）。
 *
 * 布局骨架：h-full 列框架钉死在 #main-content 高度内 ——
 *   h-9 子 Tab 栏 → 内容区（flex-1 独立滚动，各子页自行决定内部滚动策略）。
 * 文档不出现滚动条；Tab 切换只换内容区，Tab 栏不动 → 无布局抖动。
 *
 * BLF-889：项目/站点/日期筛选经 AdAnalysisTopFilters 上移 Top Header 中段插槽
 * （本组件只渲染 portal 宿主，不占页面布局），页面内不再有筛选区块。
 */
export default function AdAnalysisLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      {/* BLF-889：筛选控件 portal 进 Top Header；此处仅渲染宿主 */}
      <AdAnalysisTopFilters />
      <div className="shrink-0">
        <AdAnalysisTabNav />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <Suspense fallback={<AnalyticsContentLoading />}>{children}</Suspense>
      </div>
    </div>
  )
}
