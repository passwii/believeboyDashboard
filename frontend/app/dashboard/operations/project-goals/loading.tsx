import styles from './project-goals-warm.module.css'

export default function ProjectGoalsLoading() {
  return (
    <main
      className={styles.page}
      data-warm-surface="warm-ledger"
      aria-busy="true"
      aria-label="正在加载项目目标"
    >
      <div className={styles.loadingStack}>
        <div className={styles.loadingGrid}>
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className={styles.skeletonMetric} />
          ))}
        </div>
        <div className={styles.skeletonPanel} />
      </div>
    </main>
  )
}
