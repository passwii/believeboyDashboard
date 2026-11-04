import styles from './agent-overview-warm.module.css'

export default function AgentOverviewLoading() {
  return (
    <div className={styles.page}>
      <section className={styles.panel} role="status" aria-busy="true">
        <span className={styles.visuallyHidden}>正在加载 Agent 数据流总览</span>
        <div className={styles.loadingHeader}>
          <span className={`${styles.skeletonBar} ${styles.skeletonTitle}`} aria-hidden="true" />
        </div>
        <div className={styles.loadingBody} aria-hidden="true">
          {Array.from({ length: 7 }).map((_, index) => (
            <span key={index} className={`${styles.skeletonBar} ${styles.skeletonRow}`} />
          ))}
        </div>
      </section>
    </div>
  )
}
