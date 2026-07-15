import type { Metadata } from 'next'
import VatInvoicesClient from './vat-invoices-client'

export const metadata: Metadata = {
  title: 'VAT 发票历史',
  description: '查看已签发/草稿/作废的 VAT 发票',
}

export default function VatInvoicesHistoryPage() {
  return <VatInvoicesClient />
}
