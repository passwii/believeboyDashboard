import { redirect } from 'next/navigation'

export default function FinancialDataRedirectPage() {
  redirect('/dashboard/reports/monthly-report/display')
}
