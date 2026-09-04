import { Suspense } from 'react'
import DisplayTab from './display-client'

// 页面依赖 URL search params（useUrlParam 同步 project/country/month 到 URL）。
// 若被静态预渲染（○），生产构建下 router.replace 只改 query 的导航会被
// Next.js 视为"同路由 no-op"（RSC payload 相同）——URL 不更新、页面无反馈。
// force-dynamic 让路由按请求渲染，query 变化才能触发客户端导航。
export const dynamic = 'force-dynamic'

export default function DisplayPage() {
  return (
    <Suspense fallback={null}>
      <DisplayTab />
    </Suspense>
  )
}
