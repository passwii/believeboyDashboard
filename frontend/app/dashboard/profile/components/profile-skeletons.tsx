'use client'

import styles from '../profile-warm.module.css'

function SkeletonLine({ width }: { width: string }) {
  return <span className={styles.skeletonLine} style={{ width }} aria-hidden="true" />
}

export function ProfileInfoSkeleton() {
  return (
    <div className={styles.form} aria-busy="true" aria-label="正在加载个人资料">
      <div className={`${styles.field} ${styles.fieldFull}`}>
        <SkeletonLine width="48px" />
        <span className={`${styles.skeleton} ${styles.skeletonInput}`} aria-hidden="true" />
      </div>
      <div className={styles.field}>
        <SkeletonLine width="64px" />
        <span className={`${styles.skeleton} ${styles.skeletonInput}`} aria-hidden="true" />
      </div>
      <div className={styles.field}>
        <SkeletonLine width="64px" />
        <span className={`${styles.skeleton} ${styles.skeletonInput}`} aria-hidden="true" />
      </div>
      <div className={styles.statsGrid}>
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className={styles.statCard}>
            <SkeletonLine width="64px" />
            <span className={`${styles.skeleton} ${styles.skeletonLine} ${styles.skeletonMetric}`} aria-hidden="true" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function ProfileAvatarSkeleton() {
  return (
    <div className={styles.avatarLayout} aria-busy="true" aria-label="正在加载头像设置">
      <div className={styles.avatarColumn}>
        <span className={`${styles.skeleton} ${styles.skeletonAvatar}`} aria-hidden="true" />
        <SkeletonLine width="96px" />
      </div>
      <div className={styles.avatarControls}>
        <div className={styles.subPanel}>
          <SkeletonLine width="96px" />
          <span className={`${styles.skeleton} ${styles.skeletonLine} ${styles.skeletonWide}`} aria-hidden="true" />
          <div className={styles.buttonRow}>
            <span className={`${styles.skeleton} ${styles.skeletonButton}`} aria-hidden="true" />
            <span className={`${styles.skeleton} ${styles.skeletonButton}`} aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  )
}

export function ProfileProjectsSkeleton() {
  return (
    <div className={styles.projectsPanel} aria-busy="true" aria-label="正在加载项目列表">
      <div className={styles.projectsHeader}>
        <SkeletonLine width="96px" />
      </div>
      <div className={styles.skeletonTable} aria-hidden="true">
        {Array.from({ length: 5 }).map((_, index) => (
          <span key={index} className={styles.skeletonTableRow} />
        ))}
      </div>
    </div>
  )
}
