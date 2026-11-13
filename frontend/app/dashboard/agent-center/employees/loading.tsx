import styles from './employees-warm.module.css'

const COLUMN_CLASSES = [
  styles.colEmployee,
  styles.colAgentId,
  styles.colCapability,
  styles.colProject,
  styles.colStatus,
  styles.colCalls,
  styles.colErrors,
  styles.colActivity,
]

export default function AgentEmployeesLoading() {
  return (
    <div className={styles.page} data-warm-agent-employees-loading="true">
      <section className={styles.panel} role="status" aria-busy="true">
        <span className={styles.visuallyHidden}>正在加载 Agent 员工</span>
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
        <div className={styles.mobileLoadingList} aria-hidden="true">
          {Array.from({ length: 7 }).map((_, index) => (
            <div className={styles.mobileLoadingCard} key={index}>
              <span className={`${styles.skeletonBar} ${styles.skeletonTitle}`} />
              <span className={`${styles.skeletonBar} ${styles.skeletonHeaderBar}`} />
              <span className={`${styles.skeletonBar} ${styles.skeletonCellBar}`} />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
