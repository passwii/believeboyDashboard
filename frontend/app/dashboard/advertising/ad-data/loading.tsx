import styles from './ad-data-warm.module.css'

const TABLE_CELL_WIDTHS = ['w-1/2', 'w-3/4', 'w-2/3', 'w-1/3', 'w-3/5', 'w-1/2'] as const

export default function AdDataLoading() {
  return (
    <div
      className={styles.loading}
      aria-busy="true"
      data-warm-ad-data-loading="true"
    >
      <div
        role="status"
        aria-live="polite"
        className="font-sans text-xs text-[var(--warm-ledger-color-text-muted)]"
      >
        正在加载广告报表…
      </div>
      <div
        className={styles.filterSkeleton}
        style={{ flexDirection: 'column' }}
        aria-hidden="true"
      >
        <div className="flex items-center gap-3">
          <div className={styles.filterSkeletonItem} style={{ width: '240px' }} />
          <div className={styles.filterSkeletonItem} style={{ width: '260px' }} />
        </div>
        <div className="flex items-center gap-3">
          <div className={styles.filterSkeletonItem} style={{ width: '160px' }} />
          <div className={styles.filterSkeletonItem} style={{ width: '96px' }} />
        </div>
      </div>
      <div className={styles.tableSkeleton} aria-hidden="true">
        <div className={`${styles.tableSkeletonHeader} grid grid-cols-6 items-center gap-4 px-3`}>
          {TABLE_CELL_WIDTHS.map((width, cellIndex) => (
            <div
              key={cellIndex}
              className={`h-3 rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-raised)] ${width}`}
            />
          ))}
        </div>
        {Array.from({ length: 8 }).map((_, rowIndex) => (
          <div
            key={rowIndex}
            className={`${styles.tableSkeletonRow} grid grid-cols-6 items-center gap-4 px-3`}
          >
            {TABLE_CELL_WIDTHS.map((width, cellIndex) => (
              <div
                key={cellIndex}
                className={`h-3 rounded-[var(--warm-ledger-radius-inner)] bg-[var(--warm-ledger-color-raised)] ${width}`}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
