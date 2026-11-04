import styles from './changelog-warm.module.css'

export default function ChangelogLoading() {
  return (
    <div
      className={styles.loadingPage}
      data-warm-changelog-loading="true"
      aria-busy="true"
    >
      <span className="sr-only" role="status" aria-live="polite">
        正在加载更新日志
      </span>
      <div className={styles.loadingRail} aria-hidden="true">
        <span className={`${styles.skeleton} ${styles.skeletonTitle}`} />
        {Array.from({ length: 6 }).map((_, index) => (
          <span
            key={index}
            className={`${styles.skeleton} ${styles.skeletonNav}`}
          />
        ))}
      </div>
      <div className={styles.loadingPanel} aria-hidden="true">
        <span className={`${styles.skeleton} ${styles.skeletonTitle}`} />
        <span className={`${styles.skeleton} ${styles.skeletonCopy}`} />
        <span className={`${styles.skeleton} ${styles.skeletonCopyShort}`} />
        <div className={styles.skeletonGrid}>
          {Array.from({ length: 4 }).map((_, index) => (
            <span
              key={index}
              className={`${styles.skeleton} ${styles.skeletonCard}`}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
