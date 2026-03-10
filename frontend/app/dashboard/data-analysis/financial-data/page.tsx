import FinancialDataClient, {
  type ProjectOption,
} from '@/app/dashboard/data-analysis/financial-data/financial-data-client'
import { requireUserSession } from '@/lib/auth/server'
import { buildBackendProxyHeaders, buildBackendUrl } from '@/lib/server/backend-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

export default async function FinancialDataPage() {
  const session = await requireUserSession()

  let initialProjects: ProjectOption[] = []

  if (session) {
    try {
      initialProjects = await fetchBackendJson<ProjectOption[]>(session, 'api/v1/projects/manage')
    } catch {
      initialProjects = []
    }
  }

  const initialProjectId = initialProjects.length > 0 ? String(initialProjects[0].id ?? '') : ''

  return (
    <FinancialDataClient
      initialProjects={initialProjects}
      initialProjectId={initialProjectId}
      initialStartMonth=""
      initialEndMonth=""
      initialData={null}
      initialExchangeRateByMonth={{}}
    />
  )
}
