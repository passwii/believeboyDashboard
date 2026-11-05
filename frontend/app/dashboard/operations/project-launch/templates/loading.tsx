import styles from './workflow-template-editor-warm.module.css'

export default function WorkflowTemplateEditorLoading() {
  return (
    <main
      className={styles.page}
      data-warm-surface="warm-ledger"
      aria-busy="true"
      aria-label="正在加载流程模板"
    >
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <span className={styles.loadingTitle} />
          <span className={styles.loadingCopy} />
        </div>
      </header>
      <div className={styles.loadingPanel}>
        <div className={styles.loadingList} />
        <div className={styles.loadingDetail} />
      </div>
    </main>
  )
}
