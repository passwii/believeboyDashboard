import { Suspense } from 'react'
import InventoryReplenishmentClient from './inventory-replenishment-client'

// 页面把筛选条件同步到 URL search params（useSearchParams + router.replace）。
// 静态预渲染（○）时仅改 query 的导航会被当作同路由 no-op（生产构建必现）；
// force-dynamic 让路由按请求渲染，query 变化才能触发客户端导航。
export const dynamic = 'force-dynamic'

export default function InventoryReplenishmentPage() {
  return (
    <Suspense fallback={null}>
      <InventoryReplenishmentClient />
    </Suspense>
  )
}
