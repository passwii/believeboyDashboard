import styles from './review-tracking-warm.module.css'

export default function ReviewTrackingLoading() {
  return (
    <div className={styles.loadingPage} role="status" aria-busy="true">
      <span>正在加载评论追踪</span>
      <div className={styles.loadingLayout} aria-hidden="true">
        <div className={styles.loadingSidebar} />
        <div className={styles.loadingMain} />
      </div>
    </div>
  )
}
