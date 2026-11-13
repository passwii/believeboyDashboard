import styles from './project-launch-warm.module.css'

export default function ProjectLaunchLoading() {
  return (
    <main
      className={styles.page}
      data-warm-surface="warm-ledger"
      aria-busy="true"
      aria-label="正在加载项目启动台"
    >
      <div className={styles.workspace}>
        <div className={`${styles.panel} ${styles.projectPanel}`}>
          <div className={styles.panelHeader}>
            <span className={styles.loadingTitle} />
          </div>
          <div className={styles.loadingStack}>
            <div className={styles.skeletonRow} />
            <div className={styles.skeletonRow} />
            <div className={styles.skeletonRow} />
          </div>
        </div>
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <span className={styles.loadingTitle} />
          </div>
          <div className={styles.skeletonPanelBody} />
        </div>
      </div>
    </main>
  )
}
