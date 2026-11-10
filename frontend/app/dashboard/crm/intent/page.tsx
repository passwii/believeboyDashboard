import { Suspense } from 'react'

import {
  WarmCrmPage,
  WarmCrmState,
} from '@/components/dashboard-v2/warm-ledger/crm'

import IntentWorkbench from './_components/intent-workbench'
import styles from './intent-warm.module.css'

// 页面把筛选 / tab / scope / page / record 同步到 URL search params
// （useSearchParams + router.replace），静态预渲染时仅改 query 的导航会被
// 当作同路由 no-op；force-dynamic 让 query 变化触发客户端导航。
export const dynamic = 'force-dynamic'

export default function CrmIntentPage() {
  return (
    <Suspense
      fallback={
        <WarmCrmPage aria-busy="true" aria-label="页面加载中" className={styles.page}>
          <WarmCrmState kind="loading" title="正在加载意向客户…" />
        </WarmCrmPage>
      }
    >
      <IntentWorkbench />
    </Suspense>
  )
}
