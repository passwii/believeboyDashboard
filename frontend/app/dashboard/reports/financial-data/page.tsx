'use client'

import FinancialDataClient from '@/app/dashboard/reports/financial-data/financial-data-client'

export default function FinancialDataPage() {
  return (
    <FinancialDataClient
      initialProjects={[]}
      initialProjectId=""
      initialStartMonth=""
      initialEndMonth=""
      initialData={null}
      initialExchangeRateByMonth={{}}
    />
  )
}
