import { WarmCrmPage } from '@/components/dashboard-v2/warm-ledger/crm'

import styles from './dashboard-loading.module.css'

export default function CrmDashboardLoading() {
  return (
    <WarmCrmPage aria-busy="true">
      <span className={styles.srOnly} role="status">
        页面加载中
      </span>
      <div className={styles.kpiGrid} aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className={styles.kpiTile}>
            <span className={styles.label} />
            <span className={styles.value} />
          </div>
        ))}
      </div>
      <div className={styles.panel} aria-hidden="true">
        <span className={styles.heading} />
        <span className={styles.chart} />
        <div className={styles.stepGrid}>
          {Array.from({ length: 3 }, (_, index) => (
            <span key={index} className={styles.step} />
          ))}
        </div>
      </div>
      <div className={styles.panel} aria-hidden="true">
        <span className={styles.heading} />
        <span className={styles.table} />
      </div>
    </WarmCrmPage>
  )
}
