import styles from './agent-overview-warm.module.css'

const COLUMN_CLASSES = [
  styles.colDomain,
  styles.colDescription,
  styles.colCapability,
  styles.colRoute,
  styles.colActivity,
  styles.colCalls,
  styles.colCalls,
  styles.colErrors,
  styles.colProduction,
  styles.colStatus,
  styles.colEntry,
]

export default function AgentOverviewLoading() {
  return (
    <div className={styles.page} data-warm-agent-overview-loading="true">
      <section className={styles.panel} role="status" aria-busy="true">
        <span className={styles.visuallyHidden}>正在加载 Agent 数据流总览</span>
        <div className={styles.loadingHeader}>
          <span className={`${styles.skeletonBar} ${styles.skeletonTitle}`} aria-hidden="true" />
        </div>
        <div className={styles.tableScroll} aria-hidden="true">
          <table className={styles.table}>
            <colgroup>
              {COLUMN_CLASSES.map((className, index) => (
                <col key={index} className={className} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {COLUMN_CLASSES.map((_, index) => (
                  <th key={index} scope="col">
                    <span className={`${styles.skeletonBar} ${styles.skeletonHeaderBar}`} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 7 }).map((_, rowIndex) => (
                <tr key={rowIndex}>
                  {COLUMN_CLASSES.map((_, cellIndex) => (
                    <td key={cellIndex}>
                      <span className={`${styles.skeletonBar} ${styles.skeletonCellBar}`} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
