import styles from './shipping-plan-warm.module.css'

export default function ShippingPlanLoading() {
  return (
    <main className={styles.page} aria-busy="true" data-testid="shipping-plan-loading">
      <span className={styles.loadingLabel} role="status">正在加载发货规划</span>
      <div className={styles.loadingMetrics} aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => <div className={styles.loadingMetric} key={index} />)}
      </div>
      <div className={styles.loadingFocus} aria-hidden="true">
        <div className={styles.loadingSkuList} />
        <div className={styles.loadingForecast} />
      </div>
      <div className={styles.loadingPlan} aria-hidden="true" />
      <div className={styles.loadingHistory} aria-hidden="true" />
    </main>
  )
}
