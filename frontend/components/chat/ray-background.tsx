'use client'

import styles from './warm-chat.module.css'

export function RayBackground({ arcsUp }: { arcsUp?: boolean }) {
  return (
    <div className={styles.background} aria-hidden="true">
      <div className={styles.backgroundBase} />
      <div className={styles.glowPrimary} />
      <div className={styles.glowSecondary} />
      <div className={styles.horizon} />

      <div className={`${styles.arcs} ${arcsUp ? styles.arcsUp : ''}`}>
        <div className={`${styles.arcLayer} ${styles.arc1}`} />
        <div className={`${styles.arcLayer} ${styles.arc2}`} />
        <div className={`${styles.arcLayer} ${styles.arc3}`} />
        <div className={`${styles.arcLayer} ${styles.arc4}`} />
        <div className={`${styles.arcLayer} ${styles.arc5}`} />
      </div>
    </div>
  )
}
