import { redirect } from 'next/navigation'

// 报表核对已并入「财务月报」Tab（BLF-662）：/monthly-report/reconcile
export default function ReportReconciliationPage() {
  redirect('/dashboard/reports/monthly-report/reconcile')
}
