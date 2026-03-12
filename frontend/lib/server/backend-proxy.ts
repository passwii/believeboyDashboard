import type { Session } from 'next-auth'

import { getBackendApiKey, getBackendBaseUrl } from '@/lib/server/backend-api'

const RESPONSE_HEADER_ALLOWLIST = ['content-type', 'content-disposition', 'cache-control', 'x-request-id']
const NULL_BODY_STATUS_CODES = new Set([204, 205, 304])

function trimLeadingSlash(value: string) {
  return value.startsWith('/') ? value.slice(1) : value
}

export function buildBackendUrl(path: string) {
  return `${getBackendBaseUrl()}/${trimLeadingSlash(path)}`
}

export function buildBackendProxyHeaders(session: Session | null, requestHeaders?: Headers): Headers {
  const apiKey = getBackendApiKey()
  if (!apiKey) {
    throw new Error('缺少后端 API Key 配置')
  }

  const headers = new Headers()
  headers.set('X-API-Key', apiKey)

  const contentType = requestHeaders?.get('content-type')
  if (contentType) {
    headers.set('Content-Type', contentType)
  }

  const accept = requestHeaders?.get('accept')
  if (accept) {
    headers.set('Accept', accept)
  }

  if (session?.user?.isAdmin) {
    headers.set('X-Is-Admin', 'true')
  }

  const operatorName = session?.user?.operatorNameZh?.trim()
  if (operatorName) {
    headers.set('X-Operator', encodeURIComponent(operatorName))
  }

  return headers
}

export async function getProxyRequestBody(request: Request) {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return undefined
  }

  const body = await request.arrayBuffer()
  return body.byteLength ? body : undefined
}

export async function toProxyResponse(response: Response) {
  const headers = new Headers()
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = response.headers.get(name)
    if (value) {
      headers.set(name, value)
    }
  }

  const body = await response.arrayBuffer()
  const responseBody =
    NULL_BODY_STATUS_CODES.has(response.status) || body.byteLength === 0
      ? null
      : body

  return new Response(responseBody, {
    status: response.status,
    headers,
  })
}
