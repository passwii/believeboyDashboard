import styles from './ad-analysis-warm.module.css'

export function AdAnalysisWarmLoading() {
  return (
    <div className={styles.loading} data-warm-ad-analysis-loading="true" aria-busy="true">
      <div className={styles.loadingTabs} />
      <div className={styles.loadingGrid}>
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className={styles.loadingTile} />
        ))}
      </div>
      <div className={styles.loadingPanel} />
    </div>
  )
}
