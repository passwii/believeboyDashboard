import type { ReactNode } from 'react'

import { AdDataTopFilters } from '@/components/dashboard/ad-data/top-filters'

export default function AdDataLayout({ children }: { children: ReactNode }) {
  return (
    // BLF-826：AdDataTopFilters 只渲染 Top Header 插槽 portal 宿主，不占页面布局
    <div className="flex min-w-0 flex-col">
      <AdDataTopFilters />
      {children}
    </div>
  )
}
