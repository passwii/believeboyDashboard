import '@/components/dashboard-v2/warm-ledger/shell/theme.css'

import styles from './public-page.module.css'

export const metadata = {
  title: '公开页面 | believeboy Dashboard',
}

export default function PublicPageLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`warm-ledger ${styles.page}`} data-public-page="true">
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.headerInner}>
            <span className={styles.brand}>believeboy Dashboard</span>
            <span className={styles.label}>公开页面</span>
          </div>
        </header>
        <main id="main-content" className={styles.main}>
          {children}
        </main>
        <footer className={styles.footer}>由 believeboy Dashboard 生成</footer>
      </div>
    </div>
  )
}
