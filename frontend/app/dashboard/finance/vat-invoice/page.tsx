import { Suspense } from 'react'
import type { Metadata } from 'next'
import VatInvoiceClient from './vat-invoice-client'

export const metadata: Metadata = {
  title: 'VAT 发票',
  description: '为欧洲订单快速生成 VAT 发票，并查看已签发/草稿/作废的发票历史。',
}

export default function VatInvoicePage() {
  return (
    <Suspense fallback={null}>
      <VatInvoiceClient />
    </Suspense>
  )
}
