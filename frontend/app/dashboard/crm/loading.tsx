import {
  WarmCrmPage,
  WarmCrmTableFrame,
} from '@/components/dashboard-v2/warm-ledger/crm'

import styles from './loading.module.css'

export default function CrmLoading() {
  return (
    <WarmCrmPage data-warm-crm-loading="true" aria-busy="true">
      <span className={styles.srOnly} role="status">
        客户关系加载中
      </span>
      <div className={styles.toolbar}>
        <span className={styles.search} />
        <span className={styles.filter} />
        <span className={styles.action} />
      </div>
      <WarmCrmTableFrame>
        <div className={styles.rows}>
          {Array.from({ length: 7 }, (_, index) => (
            <span className={styles.row} key={index} />
          ))}
        </div>
      </WarmCrmTableFrame>
    </WarmCrmPage>
  )
}
