'use client'

import { type ReactNode, Suspense } from 'react'

import { MotionStagger, MotionStaggerItem } from '@/components/motion/MotionStagger'
import { DashboardPageLoading } from '@/components/dashboard/dashboard-page-loading'
import { AdAnalysisTabNav } from '@/components/dashboard/ad-analysis/tab-nav'
import { AdAnalysisTopFilters } from '@/components/dashboard/ad-analysis/top-filters'

export default function AdAnalysisLayout({ children }: { children: ReactNode }) {
  return (
    <MotionStagger className="space-y-5">
      <MotionStaggerItem>
        <AdAnalysisTopFilters />
      </MotionStaggerItem>
      <MotionStaggerItem>
        <AdAnalysisTabNav />
      </MotionStaggerItem>
      <MotionStaggerItem>
        <Suspense fallback={<DashboardPageLoading />}>{children}</Suspense>
      </MotionStaggerItem>
    </MotionStagger>
  )
}
