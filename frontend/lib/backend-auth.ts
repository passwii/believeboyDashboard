import type { Session } from 'next-auth'

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
  if (options.contentType) {
    headers['Content-Type'] = options.contentType
  }

  return headers
}
