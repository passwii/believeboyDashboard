import styles from './change-password-warm.module.css'

export default function ChangePasswordLoading() {
  return (
    <div className={styles.page} data-warm-page="change-password" aria-busy="true">
      <header className={styles.header}>
        <span className={`${styles.skeleton} ${styles.skeletonTitle}`} aria-hidden="true" />
      </header>
      <section className={styles.panel}>
        <div className={styles.form}>
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className={styles.field}>
              <span className={`${styles.skeleton} ${styles.skeletonLabel}`} aria-hidden="true" />
              <span className={`${styles.skeleton} ${styles.skeletonInput}`} aria-hidden="true" />
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
