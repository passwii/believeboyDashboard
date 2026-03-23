import type { ReactNode } from 'react'

import { AdAnalysisTabNav } from '@/components/dashboard/ad-analysis/tab-nav'

export default function AdAnalysisLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-5">
      <AdAnalysisTabNav />
      {children}
    </div>
  )
}
