import styles from './table-showcase-warm.module.css'

export default function TableShowcaseLoading() {
  return (
    <div className={styles.page} data-warm-page="table-showcase" aria-busy="true">
      <header className={styles.header}>
        <span className={`${styles.skeleton} ${styles.skeletonTitle}`} aria-hidden="true" />
        <span className={`${styles.skeleton} ${styles.skeletonLead}`} aria-hidden="true" />
      </header>
      <section className={styles.showcaseSection}>
        <span className={`${styles.skeleton} ${styles.skeletonTable}`} aria-hidden="true" />
      </section>
    </div>
  )
}
