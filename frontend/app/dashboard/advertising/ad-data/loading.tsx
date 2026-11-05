import styles from './ad-data-warm.module.css'

export default function AdDataLoading() {
  return (
    <div
      className={styles.loading}
      aria-busy="true"
      aria-label="页面加载中"
      data-warm-ad-data-loading="true"
    >
      <div className={styles.filterSkeleton}>
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className={styles.filterSkeletonItem} aria-hidden />
        ))}
      </div>
      <div className={styles.tableSkeleton}>
        <div className={styles.tableSkeletonHeader} aria-hidden />
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className={styles.tableSkeletonRow} aria-hidden />
        ))}
      </div>
    </div>
  )
}
