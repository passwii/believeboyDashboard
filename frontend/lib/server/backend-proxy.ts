import type { Session } from 'next-auth'

import { buildBackendAuthHeaders } from '@/lib/backend-auth'
import { getBackendApiKey, getBackendBaseUrl } from '@/lib/server/backend-api'

const RESPONSE_HEADER_ALLOWLIST = [
  'content-type',
  'content-disposition',
  'cache-control',
  'last-event-id',
  'x-request-id',
  'x-accel-buffering',
  'connection',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
]
const NULL_BODY_STATUS_CODES = new Set([204, 205, 304])

export function isStreamingContentType(value: string | null): boolean {
  const normalized = (value || '').toLowerCase()
  return normalized.includes('text/event-stream') || normalized.includes('application/x-ndjson')
}

function trimLeadingSlash(value: string) {
  return value.startsWith('/') ? value.slice(1) : value
}

export function buildBackendUrl(path: string) {
  return `${getBackendBaseUrl()}/${trimLeadingSlash(path)}`
}

export function buildBackendProxyHeaders(
  session: Session | null,
  requestHeaders?: Headers
): Headers {
  // Delegate the actual session + API-key header construction to
  // `buildBackendAuthHeaders` in `lib/backend-auth.ts` so there is exactly one
  // source of truth for "what headers do we send to the backend".
  const headers = buildBackendAuthHeaders(session, {
    apiKey: getBackendApiKey(),
    contentType: requestHeaders?.get('content-type') ?? undefined,
    accept: requestHeaders?.get('accept') ?? undefined,
  })
  const lastEventId = requestHeaders?.get('last-event-id')
  if (lastEventId) headers.set('Last-Event-ID', lastEventId)
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
    return new Response(streamingBody, {
      status: response.status,
      headers,
    })
  }

  const body = await response.arrayBuffer()
  const responseBody =
    NULL_BODY_STATUS_CODES.has(response.status) || body.byteLength === 0 ? null : body

  return new Response(responseBody, {
    status: response.status,
    headers,
  })
}
