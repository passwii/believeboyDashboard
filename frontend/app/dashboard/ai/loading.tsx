import styles from '@/components/chat/warm-chat.module.css'

export default function AiLoading() {
  return (
    <main
      className={`${styles.loadingPage} warm-ledger`}
      data-testid="ai-loading-warm-page"
      data-warm-surface="warm-ledger"
      aria-busy="true"
      aria-label="正在加载 AI 助手"
    >
      <div className={styles.loadingPanel}>
        <div className={styles.skeleton} />
        <div className={`${styles.skeleton} ${styles.skeletonWide}`} />
        <div className={`${styles.skeleton} ${styles.skeletonWide}`} />
        <div className={`${styles.skeleton} ${styles.skeletonInput}`} />
      </div>
    </main>
  )
}
