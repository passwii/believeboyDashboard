import type { ReactNode } from 'react'

import { AdDataTopFilters } from '@/components/dashboard/ad-data/top-filters'
import styles from './ad-data-warm.module.css'

export default function AdDataLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className={styles.layout}
      data-warm-ad-data-layout="true"
    >
      <AdDataTopFilters />
      {children}
    </div>
  )
}
