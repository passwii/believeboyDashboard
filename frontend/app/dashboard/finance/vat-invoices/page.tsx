import { redirect } from 'next/navigation'

// VAT 发票历史已并入 /dashboard/finance/vat-invoice（单页 Tab）。
// 保留此路由做 301 跳转，避免旧书签/链接 404。
export default function VatInvoicesHistoryPage() {
  redirect('/dashboard/finance/vat-invoice')
}
