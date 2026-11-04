import { WideDataTableSkeleton } from '@/components/dashboard/page-skeletons'
import { Skeleton } from '@/components/ui/skeleton'
import styles from './insights-warm.module.css'

export default function AiInsightsLoading() {
  return (
    <div className={styles.page} aria-busy="true" aria-label="页面加载中">
      <div className={styles.tabs}>
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-24" />
      </div>
      <div className={styles.stack}>
        <Skeleton className="h-32 rounded-[var(--warm-ledger-radius-panel)]" />
        <WideDataTableSkeleton columns={6} rows={7} />
      </div>
    </div>
  )
}
