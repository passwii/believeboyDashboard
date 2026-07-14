'use client'

import FinancialDataClient from '@/app/dashboard/data-analysis/financial-data/financial-data-client'

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
