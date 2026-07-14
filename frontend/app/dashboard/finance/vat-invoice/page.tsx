import type { Metadata } from 'next'
import VatInvoiceClient from './vat-invoice-client'

export const metadata: Metadata = {
  title: 'VAT 发票生成器',
  description: '为欧洲订单快速生成 VAT 发票，支持店铺级 Seller 预填、多商品行、多 VAT 率汇总。',
}

export default function VatInvoicePage() {
  return <VatInvoiceClient />
}
