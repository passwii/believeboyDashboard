import FinancialDataClient, {
  type FinancialSeriesResponse,
  type ProjectOption,
} from '@/app/dashboard/data-analysis/financial-data/financial-data-client'
import { requireUserSession } from '@/lib/auth/server'
import { buildBackendProxyHeaders, buildBackendUrl } from '@/lib/server/backend-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type BackendExchangeRateResponse = {
  items: Array<{
    year_month: string
    rate: number
  }>
  total: number
  page: number
  page_size: number
}

function oneYearAgoMonthString(): string {
  const now = new Date()
  now.setFullYear(now.getFullYear() - 1)
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function lastMonthString(): string {
  const now = new Date()
  now.setMonth(now.getMonth() - 1)
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

async function fetchBackendJson<T>(session: Awaited<ReturnType<typeof requireUserSession>>, path: string): Promise<T> {
  const response = await fetch(buildBackendUrl(path), {
    method: 'GET',
    headers: buildBackendProxyHeaders(session),
    cache: 'no-store',
  })

  if (!response.ok) {
    let message = `请求失败 (${response.status})`
    try {
      const payload = (await response.json()) as { detail?: string; message?: string }
      message = payload.detail || payload.message || message
    } catch {
      const text = await response.text()
      if (text.trim()) {
        message = text
      }
    }
    throw new Error(message)
  }

  return (await response.json()) as T
}

async function fetchInitialExchangeRateByMonth(
  session: Awaited<ReturnType<typeof requireUserSession>>,
  months: string[]
): Promise<Record<string, number>> {
  const uniqueMonths = Array.from(new Set(months.filter(Boolean)))
  if (uniqueMonths.length === 0) return {}

  let page = 1
  let totalPages = 1
  const map: Record<string, number> = {}

  while (page <= totalPages) {
    const payload = await fetchBackendJson<BackendExchangeRateResponse>(
      session,
      `api/v1/exchange-rates?currency=USD&page=${page}&page_size=200`
    )
    payload.items.forEach((item) => {
      if (uniqueMonths.includes(item.year_month)) {
        map[item.year_month] = Number(item.rate) || 0
      }
    })
    totalPages = Math.max(1, Math.ceil(payload.total / payload.page_size))
    page += 1
  }

  return map
}

export default async function FinancialDataPage() {
  const session = await requireUserSession()
  const initialStartMonth = oneYearAgoMonthString()
  const initialEndMonth = lastMonthString()

  let initialProjects: ProjectOption[] = []
  let initialData: FinancialSeriesResponse | null = null
  let initialExchangeRateByMonth: Record<string, number> = {}

  if (session) {
    try {
      initialProjects = await fetchBackendJson<ProjectOption[]>(session, 'api/v1/projects/manage')
    } catch {
      initialProjects = []
    }
  }

  const initialProjectId = initialProjects.length > 0 ? String(initialProjects[0].id ?? '') : ''

  if (session && initialProjectId) {
    try {
      initialData = await fetchBackendJson<FinancialSeriesResponse>(
        session,
        `api/v1/monthly-reports/financial-series?project_id=${encodeURIComponent(initialProjectId)}&fill_missing=true&start_month=${encodeURIComponent(initialStartMonth)}&end_month=${encodeURIComponent(initialEndMonth)}`
      )
      initialExchangeRateByMonth = await fetchInitialExchangeRateByMonth(
        session,
        initialData.rows.map((row) => row.report_month)
      )
    } catch {
      initialData = null
      initialExchangeRateByMonth = {}
    }
  }

  return (
    <FinancialDataClient
      initialProjects={initialProjects}
      initialProjectId={initialProjectId}
      initialStartMonth={initialStartMonth}
      initialEndMonth={initialEndMonth}
      initialData={initialData}
      initialExchangeRateByMonth={initialExchangeRateByMonth}
    />
  )
}
