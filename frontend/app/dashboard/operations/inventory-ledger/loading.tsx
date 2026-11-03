import styles from './inventory-ledger-warm.module.css'

export default function InventoryLedgerLoading() {
  return (
    <div className={styles.routeLoading} role="status" aria-busy="true">
      <span className={styles.routeLoadingLabel}>正在加载库存分类账</span>
      <div className={styles.skeletonKpiGrid} aria-hidden="true">
        {Array.from({ length: 8 }, (_, index) => (
          <div className={styles.skeletonKpi} key={index} />
        ))}
      </div>
      <div className={styles.routeLoadingPanels} aria-hidden="true">
        <div className={styles.routeLoadingPanel} />
        <div className={styles.routeLoadingPanel} />
      </div>
      <div className={styles.routeLoadingTable} aria-hidden="true" />
    </div>
  )
}
