import styles from './feature-updates-warm.module.css'

export default function FeatureUpdatesLoading() {
  return (
    <div className={styles.page} data-warm-page="feature-updates" aria-busy="true">
      <header className={styles.header}>
        <span className={`${styles.skeleton} ${styles.skeletonTitle}`} aria-hidden="true" />
      </header>
      <section className={styles.introPanel}>
        <span className={`${styles.skeleton} ${styles.skeletonTitle}`} aria-hidden="true" />
      </section>
      <div className={styles.featureGrid}>
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className={`${styles.skeleton} ${styles.skeletonCard}`} aria-hidden="true" />
        ))}
      </div>
    </div>
  )
}
