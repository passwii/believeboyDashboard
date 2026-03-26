import type { ReactNode } from 'react'

import { AdAnalysisPageTransition } from '@/components/dashboard/ad-analysis/page-transition'
import { AdAnalysisTabNav } from '@/components/dashboard/ad-analysis/tab-nav'
import { AdAnalysisTopFilters } from '@/components/dashboard/ad-analysis/top-filters'

export default function AdAnalysisLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-5">
      <AdAnalysisTopFilters />
      <AdAnalysisTabNav />
      <AdAnalysisPageTransition>{children}</AdAnalysisPageTransition>
    </div>
  )
}
