import styles from './loading.module.css'

const COLUMNS = ['待办', '进行中', '已完成']

export default function CrmTasksLoading() {
  return (
    <div className={styles.loading} aria-busy="true">
      <span className="sr-only" role="status">
        任务加载中
      </span>
      <div className={styles.toolbar}>
        <span className={styles.control} />
        <div className={styles.toolbarEnd}>
          <span className={styles.segment} />
          <span className={styles.segment} />
        </div>
      </div>
      <div className={styles.board}>
        {COLUMNS.map((column) => (
          <section key={column} className={styles.column}>
            <header className={styles.columnHeader}>
              <span>{column}</span>
              <span className={styles.count} />
            </header>
            <div className={styles.cards}>
              {Array.from({ length: 3 }, (_, index) => (
                <span key={index} className={styles.card} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
