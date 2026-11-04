import {
  WarmCrmPage,
  WarmCrmState,
  WarmCrmTableFrame,
} from '@/components/dashboard-v2/warm-ledger/crm'

import styles from './loading-warm.module.css'

export default function CustomerProposalsLoading() {
  return (
    <WarmCrmPage
      aria-busy="true"
      aria-label="页面加载中"
      className={styles.loadingPage}
      data-testid="page-skeleton-customer-proposals"
    >
      <div aria-hidden="true" className={styles.toolbarSkeleton}>
        <span className={styles.controlSkeleton} />
        <span className={styles.actionSkeleton} />
      </div>
      <WarmCrmTableFrame>
        <WarmCrmState kind="loading" title="加载中…" />
      </WarmCrmTableFrame>
    </WarmCrmPage>
  )
}
