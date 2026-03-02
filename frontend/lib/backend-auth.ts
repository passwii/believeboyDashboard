import type { Session } from 'next-auth'

const API_KEY = process.env.NEXT_PUBLIC_BACKEND_API_KEY ?? ''

type BuildBackendHeadersOptions = {
  contentType?: string
  includeAdmin?: boolean
  includeOperator?: boolean
}

export function buildBackendHeaders(
  session?: Session | null,
  options: BuildBackendHeadersOptions = {}
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (API_KEY) {
    headers['X-API-Key'] = API_KEY
  }
  if (options.contentType) {
    headers['Content-Type'] = options.contentType
  }

  const includeAdmin = options.includeAdmin ?? true
  const includeOperator = options.includeOperator ?? true

  if (includeAdmin && session?.user?.isAdmin) {
    headers['X-Is-Admin'] = 'true'
  }
  if (includeOperator) {
    const operatorName = session?.user?.operatorNameZh?.trim()
    if (operatorName) {
      headers['X-Operator'] = encodeURIComponent(operatorName)
    }
  }

  return headers
}
