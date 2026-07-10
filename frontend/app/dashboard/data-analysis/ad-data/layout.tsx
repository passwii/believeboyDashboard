import type { ReactNode } from 'react'

import { AdDataTopFilters } from '@/components/dashboard/ad-data/top-filters'

export default function AdDataLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-5">
      <AdDataTopFilters />
      {children}
    </div>
  )
}
