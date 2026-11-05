import { ProfileInfoSkeleton } from './components/profile-skeletons'
import styles from './profile-warm.module.css'

export default function ProfileLoading() {
  return (
    <div className={styles.page} data-warm-page="profile">
      <header className={styles.header}>
        <span className={styles.pageTitle}>我的资料</span>
      </header>
      <section className={styles.panel}>
        <div className={styles.content}>
          <ProfileInfoSkeleton />
        </div>
      </section>
    </div>
  )
}
