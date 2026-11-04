import styles from './site-navigation-warm.module.css'

export default function SiteNavigationLoading() {
  return (
    <main
      className={styles.page}
      data-warm-surface="warm-ledger"
      aria-busy="true"
      aria-label="正在加载站点导航"
    >
      <div className={styles.loadingHero}>
        <span className={styles.loadingTitle} />
        <div className={styles.loadingStats}>
          <span />
          <span />
          <span />
        </div>
      </div>
      <div className={styles.grid}>
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className={styles.skeletonCard} />
        ))}
      </div>
    </main>
  )
}
