import { Suspense } from 'react'
import type { Metadata } from 'next'
import VatInvoiceClient from './vat-invoice-client'

export const metadata: Metadata = {
  title: 'VAT 发票',
  description: '为欧洲订单快速生成 VAT 发票，并查看已签发/草稿/作废的发票历史。',
}

// invoice-preview-dialog 会 router.push 到同路径 ?tab=history。
// 静态预渲染（○）时仅改 query 的导航被当作同路由 no-op（生产构建必现）；
// force-dynamic 让路由按请求渲染，query 变化才能触发客户端导航。
export const dynamic = 'force-dynamic'

export default function VatInvoicePage() {
  return (
    <Suspense fallback={null}>
      <VatInvoiceClient />
    </Suspense>
  )
}
