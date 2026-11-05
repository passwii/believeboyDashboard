import styles from './store-navigation-warm.module.css'

export default function StoreNavigationLoading() {
  return (
    <main
      className={styles.page}
      data-warm-surface="warm-ledger"
      aria-busy="true"
      aria-label="正在加载店铺导航"
    >
      <div className={styles.loadingHero}>
        <span className={styles.loadingTitle} />
        <div className={styles.loadingStats}>
          <span />
          <span />
          <span />
        </div>
      </div>
      <div className={styles.loadingGrid}>
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className={styles.skeleton} />
        ))}
      </div>
    </main>
  )
}
