import styles from './dashboard-loading.module.css'

/** V4 Warm Ledger route-level skeleton. */
export default function DashboardV2Loading() {
  return (
    <div className={styles.page} aria-busy="true" aria-label="页面加载中">
      <div className={styles.toolbar}>
        <div className={`${styles.bar} ${styles.titleBar}`} />
        <div className={`${styles.bar} ${styles.actionBar}`} />
      </div>
      <div className={styles.grid}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div className={styles.card} key={i}>
            <div className={`${styles.bar} ${styles.labelBar}`} />
            <div className={`${styles.bar} ${styles.valueBar}`} />
            <div className={`${styles.bar} ${styles.metaBar}`} />
          </div>
        ))}
        {Array.from({ length: 2 }).map((_, i) => (
          <div className={`${styles.card} ${styles.wideCard}`} key={`wide-${i}`}>
            <div className={`${styles.bar} ${styles.valueBar}`} />
            <div className={`${styles.bar} ${styles.chartBar}`} />
          </div>
        ))}
      </div>
    </div>
  )
}
