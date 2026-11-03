import styles from './shipment-management-warm.module.css'

const TABLE_COLUMN_COUNT = 12

export default function ShipmentManagementLoading() {
  return (
    <div className={styles.loadingPage} aria-busy="true" data-testid="shipment-management-loading">
      <span className={styles.loadingLabel} role="status">
        正在加载货件管理
      </span>
      <div className={styles.loadingToolbar} aria-hidden="true">
        <div className={styles.loadingTabs}>
          {Array.from({ length: 4 }, (_, index) => (
            <span className={styles.loadingTab} key={index} />
          ))}
        </div>
        <div className={styles.loadingActions}>
          {Array.from({ length: 3 }, (_, index) => (
            <span className={styles.loadingAction} key={index} />
          ))}
        </div>
      </div>
      <section className={styles.loadingPanel} aria-hidden="true">
        <div className={styles.loadingPanelHeader}>
          <div>
            <span className={styles.loadingTitle} />
            <span className={styles.loadingMeta} />
          </div>
          <span className={styles.loadingAction} />
        </div>
        <div className={styles.loadingScroll}>
          <div className={styles.loadingTable}>
            <div className={styles.loadingTableHeader}>
              {Array.from({ length: TABLE_COLUMN_COUNT }, (_, index) => (
                <span className={styles.loadingCell} key={index} />
              ))}
            </div>
            {Array.from({ length: 7 }, (_, rowIndex) => (
              <div className={styles.loadingTableRow} key={rowIndex}>
                {Array.from({ length: TABLE_COLUMN_COUNT }, (_, columnIndex) => (
                  <span
                    className={styles.loadingCell}
                    key={`${rowIndex}-${columnIndex}`}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
