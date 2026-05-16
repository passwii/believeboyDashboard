import type { Session } from 'next-auth'

import { getBackendApiKey, getBackendBaseUrl } from '@/lib/server/backend-api'

const RESPONSE_HEADER_ALLOWLIST = [
  'content-type',
  'content-disposition',
  'cache-control',
  'x-request-id',
  'x-accel-buffering',
  'connection',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
]
const NULL_BODY_STATUS_CODES = new Set([204, 205, 304])

function isStreamingContentType(value: string | null) {
  const normalized = (value || '').toLowerCase()
  return normalized.includes('text/event-stream') || normalized.includes('application/x-ndjson')
}

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

  const roleType = session?.user?.roleType
  if (roleType === 'admin') {
    headers.set('X-Is-Admin', 'true')
  }
  if (roleType) {
    headers.set('X-Role-Type', roleType)
  }

  const userId = session?.user?.id?.trim()
  if (userId) {
    headers.set('X-User-Id', userId)
  }

  const userName = session?.user?.operatorNameZh?.trim() || session?.user?.name?.trim()
  if (userName) {
    headers.set('X-User-Name', encodeURIComponent(userName))
  }

  const userEmail = session?.user?.email?.trim()
  if (userEmail) {
    headers.set('X-User-Email', encodeURIComponent(userEmail))
  }

  const operatorName = session?.user?.operatorNameZh?.trim()
  if (operatorName) {
    headers.set('X-Operator', encodeURIComponent(operatorName))
  }

  const sessionId = session?.user?.sessionId?.trim()
  if (sessionId) {
    headers.set('X-Session-Id', sessionId)
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

  if (isStreamingContentType(response.headers.get('content-type'))) {
    // SSE / NDJSON streaming path: manually read chunks from the backend
    // and immediately flush them to the client. This avoids Node.js undici's
    // internal buffering which can batch SSE events and break real-time updates.
    const backendBody = response.body
    if (!backendBody) {
      console.error('[proxy] SSE stream has no body, returning empty response')
      return new Response(null, { status: response.status, headers })
    }

    const reader = backendBody.getReader()

    // Create a ReadableStream that pulls data from the backend as fast as possible
    // and enqueues each chunk immediately, bypassing any buffering.
    const streamingBody = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            try {
              controller.close()
            } catch {
              // Controller may already be closed if the client disconnected
            }
            return
          }
          // Immediately enqueue every chunk without buffering
          if (value) {
            controller.enqueue(value)
          }
        } catch (err: unknown) {
          // Backend stream error (e.g. connection closed) or client disconnected
          try {
            controller.error(err instanceof Error ? err : new Error(String(err)))
          } catch {
            // Controller may already be closed
          }
        }
      },
      async cancel() {
        reader.cancel()
      },
    })

    // SSE requires no buffering at any layer
    headers.set('Cache-Control', 'no-cache, no-transform')
    headers.set('X-Accel-Buffering', 'no')
    headers.set('Connection', 'keep-alive')

    console.log('[proxy] Streaming SSE response, status:', response.status)
    return new Response(streamingBody, {
      status: response.status,
      headers,
    })
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
