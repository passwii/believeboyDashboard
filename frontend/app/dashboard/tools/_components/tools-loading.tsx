import { ToolsPageFrame } from './tools-frame'

import styles from './tools-loading.module.css'

function LoadingPanel() {
  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <span className={styles.titleBar} />
        <span className={styles.actionBar} />
      </div>
      <div className={styles.panelBody}>
        <span className={styles.copyBar} />
        <span className={styles.controlBar} />
        <span className={styles.contentBlock} />
        <span className={styles.statusBar} />
      </div>
    </div>
  )
}

export function ToolsLoading() {
  return (
    <ToolsPageFrame
      aria-busy="true"
      className={styles.loading}
      data-testid="tools-loading"
    >
      <span className={styles.status} role="status" aria-live="polite">
        工具箱页面加载中
      </span>
      <div
        aria-hidden="true"
        className={styles.panels}
        data-testid="tools-loading-panels"
      >
        <LoadingPanel />
        <LoadingPanel />
      </div>
    </ToolsPageFrame>
  )
}
