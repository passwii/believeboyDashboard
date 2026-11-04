import {
  WarmCrmPage,
  WarmCrmState,
} from '@/components/dashboard-v2/warm-ledger/crm'

import styles from './loading-warm.module.css'

export default function CustomerProposalDetailLoading() {
  return (
    <WarmCrmPage
      aria-busy="true"
      aria-label="页面加载中"
      className={styles.loadingPage}
      data-testid="page-skeleton-proposal-detail"
    >
      <div className={styles.loadingSidebar}>
        <WarmCrmState
          className={styles.infoSkeleton}
          kind="loading"
          title="加载中…"
        />
        <WarmCrmState
          className={styles.versionsSkeleton}
          kind="loading"
          title="加载版本…"
        />
      </div>
      <WarmCrmState
        className={styles.previewSkeleton}
        kind="loading"
        title="加载预览…"
      />
    </WarmCrmPage>
  )
}
