import { Suspense } from 'react'
import DailyAnalysisClient from './daily-analysis-client'

// 页面把项目/国家/日期筛选条件同步到 URL search params（useUrlParam）。
// 静态预渲染（○）时 router.replace 仅改 query 会被当作同路由 no-op，
// 生产构建下 URL 不更新、页面无反馈；force-dynamic 让路由按请求渲染。
export const dynamic = 'force-dynamic'

export default function DailyAnalysisPage() {
  return (
    <Suspense fallback={null}>
      <DailyAnalysisClient />
    </Suspense>
  )
}
