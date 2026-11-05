import styles from './warm-route-loading.module.css'

type WarmRouteLoadingVariant = 'dashboard' | 'detail' | 'table'

type WarmRouteLoadingProps = {
  variant?: WarmRouteLoadingVariant
  columns?: number
  rows?: number
  label?: string
}

export function WarmRouteLoading({
  variant = 'dashboard',
  columns = 8,
  rows = 7,
  label = '页面加载中',
}: WarmRouteLoadingProps) {
  const safeColumns = Math.max(1, columns)
  const safeRows = Math.max(1, rows)

  return (
    <div
      className={styles.page}
      data-warm-loading={variant}
      aria-busy="true"
      aria-label={label}
    >
      <div className={styles.toolbar}>
        <div className={`${styles.bar} ${styles.titleBar}`} />
        <div className={`${styles.bar} ${styles.actionBar}`} />
      </div>

      {variant === 'dashboard' ? (
        <div className={styles.grid}>
          {Array.from({ length: 4 }).map((_, index) => (
            <div className={styles.card} key={`metric-${index}`}>
              <div className={`${styles.bar} ${styles.labelBar}`} />
              <div className={`${styles.bar} ${styles.valueBar}`} />
              <div className={`${styles.bar} ${styles.metaBar}`} />
            </div>
          ))}
          {Array.from({ length: 2 }).map((_, index) => (
            <div className={`${styles.card} ${styles.wideCard}`} key={`panel-${index}`}>
              <div className={`${styles.bar} ${styles.valueBar}`} />
              <div className={`${styles.bar} ${styles.chartBar}`} />
            </div>
          ))}
        </div>
      ) : null}

      {variant === 'detail' ? (
        <div className={styles.detailGrid}>
          <div className={styles.card}>
            {Array.from({ length: 5 }).map((_, index) => (
              <div className={`${styles.bar} ${styles.rowBar}`} key={`left-${index}`} />
            ))}
          </div>
          <div className={styles.card}>
            <div className={`${styles.bar} ${styles.valueBar}`} />
            <div className={`${styles.bar} ${styles.detailPanelBar}`} />
          </div>
        </div>
      ) : null}

      {variant === 'table' ? (
        <div className={styles.tableLayout}>
          <div className={styles.statGrid}>
            {Array.from({ length: 4 }).map((_, index) => (
              <div className={styles.statCard} key={`stat-${index}`}>
                <div className={`${styles.bar} ${styles.labelBar}`} />
                <div className={`${styles.bar} ${styles.valueBar}`} />
              </div>
            ))}
          </div>
          <div className={styles.tablePanel}>
            <div
              className={styles.tableRow}
              style={{ gridTemplateColumns: `repeat(${safeColumns}, minmax(0, 1fr))` }}
            >
              {Array.from({ length: safeColumns }).map((_, index) => (
                <div className={`${styles.bar} ${styles.cellBar}`} key={`head-${index}`} />
              ))}
            </div>
            {Array.from({ length: safeRows }).map((_, rowIndex) => (
              <div
                className={styles.tableRow}
                style={{ gridTemplateColumns: `repeat(${safeColumns}, minmax(0, 1fr))` }}
                key={`row-${rowIndex}`}
              >
                {Array.from({ length: safeColumns }).map((_, columnIndex) => (
                  <div className={`${styles.bar} ${styles.cellBar}`} key={`cell-${rowIndex}-${columnIndex}`} />
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
