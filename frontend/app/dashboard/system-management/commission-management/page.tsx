import { redirect } from 'next/navigation'

export default function CommissionManagementRedirectPage() {
  redirect('/dashboard/system-management/commission-overview')
}
