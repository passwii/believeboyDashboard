import styles from './sku-info-warm.module.css'

export default function SkuInfoLoading() {
  return (
    <section
      className={styles.loading}
      aria-busy="true"
      data-testid="page-skeleton-sku-info"
    >
      <span className={styles.loadingStatus} role="status" aria-live="polite">
        正在加载 SKU 信息
      </span>
      <div className={styles.loadingTabs} aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <div className={styles.loadingTab} key={index} />
        ))}
      </div>
      <div className={styles.loadingSummary} aria-hidden="true" />
      <section className={styles.loadingCard} aria-hidden="true">
        <div className={styles.loadingCardHeader}>
          <div className={styles.loadingHeading} />
          <div className={styles.loadingActions}>
            {Array.from({ length: 4 }, (_, index) => (
              <div className={styles.loadingAction} key={index} />
            ))}
          </div>
        </div>
        <div className={styles.loadingTableViewport}>
          <div className={styles.loadingTable}>
            <div className={styles.loadingTableHeader}>
              {Array.from({ length: 9 }, (_, index) => (
                <div className={styles.loadingTableCell} key={index} />
              ))}
            </div>
            {Array.from({ length: 7 }, (_, row) => (
              <div className={styles.loadingTableRow} key={row}>
                {Array.from({ length: 9 }, (_, column) => (
                  <div className={styles.loadingTableCell} key={`${row}-${column}`} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>
    </section>
  )
}
