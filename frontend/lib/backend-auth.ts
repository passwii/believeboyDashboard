import type { Session } from 'next-auth'

import { getBackendApiKey } from '@/lib/server/backend-api'

/**
 * Unified header builder for backend API calls.
 *
 * There are exactly two legitimate ways to talk to the backend from a Next.js
 * Route Handler / Server Action / Server Component:
 *
 *  1. **Through the proxy** at `/api/backend/[...path]`. The proxy
 *     (`app/api/backend/[...path]/route.ts`) calls
 *     `buildBackendProxyHeaders` (in `lib/server/backend-proxy.ts`) to inject
 *     the API key + session context, so callers only need `Content-Type`
 *     (and possibly `Accept`).
 *  2. **Directly from a server-only file** (Route Handler, Server Action) that
 *     holds a NextAuth `Session`. Such a file MUST inject the API key + session
 *     context itself via `buildBackendAuthHeaders` — otherwise the backend
 *     will 401.
 *
 * The previous version of `buildBackendHeaders` silently dropped every header
 * except `Content-Type`, which made it useless (and misleadingly named) for
 * callers on the direct path. It is replaced by:
 *
 *   - `buildBackendAuthHeaders(session, { apiKey, contentType? })` — server
 *     side, injects `X-API-Key` plus the full session context
 *     (`X-User-Id` / `X-User-Name` / `X-User-Email` / `X-Operator` /
 *     `X-Is-Admin` / `X-Role-Type` / `X-Session-Id`). Use this in any Route
 *     Handler that calls the backend directly. The caller is responsible for
 *     resolving `apiKey` (typically via `getBackendApiKey()` / the
 *     `getBackendApiKeyOrFail` early-return helper).
 *   - `buildBackendClientHeaders(session, { contentType? })` — client side,
 *     returns the session-only header subset (no API key, which the browser
 *     must never carry). The proxy re-injects everything anyway; this helper
 *     exists so client fetches that go to `/api/backend/...` can carry the
 *     same context the proxy would inject.
 *   - `buildBackendHeaders(session, { contentType? })` — kept as a thin
 *     redirect to `buildBackendClientHeaders`. Existing call sites in pages
 *     that hit `/api/backend/...` keep working unchanged, and ESLint
 *     `// @deprecated` markers will point new code at the right helper.
 *
 * Anything that wants to talk to the backend MUST go through one of these
 * helpers — there is no fourth path.
 */

type BuildBackendAuthHeadersOptions = {
  /** When provided, sets `Content-Type` on the returned headers. */
  contentType?: string
  /** When provided, sets `Accept` on the returned headers. */
  accept?: string
}

const ROLE_HEADER_VALUE_ADMIN = 'true'

function pickTrimmed(
  session: Session | null,
  key: keyof NonNullable<Session['user']>
): string | null {
  if (!session) return null
  const raw = session.user?.[key]
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed ? trimmed : null
}

function pickUserId(session: Session | null): string | null {
  return pickTrimmed(session, 'id')
}

function pickUserName(session: Session | null): string | null {
  if (!session) return null
  return pickOperatorName(session) ?? pickTrimmed(session, 'name')
}

function pickUserEmail(session: Session | null): string | null {
  return pickTrimmed(session, 'email')
}

function pickOperatorName(session: Session | null): string | null {
  return pickTrimmed(session, 'operatorNameZh')
}

function pickSessionId(session: Session | null): string | null {
  return pickTrimmed(session, 'sessionId')
}

function pickRoleType(session: Session | null): string | null {
  return pickTrimmed(session, 'roleType')
}

function isAdmin(session: Session | null): boolean {
  return pickRoleType(session) === 'admin'
}

function applySessionContextHeaders(session: Session | null, headers: Headers): Headers {
  const userId = pickUserId(session)
  if (userId) headers.set('X-User-Id', userId)

  const userName = pickUserName(session)
  if (userName) headers.set('X-User-Name', encodeURIComponent(userName))

  const userEmail = pickUserEmail(session)
  if (userEmail) headers.set('X-User-Email', encodeURIComponent(userEmail))

  const operatorName = pickOperatorName(session)
  if (operatorName) headers.set('X-Operator', encodeURIComponent(operatorName))

  const roleType = pickRoleType(session)
  if (roleType) headers.set('X-Role-Type', roleType)
  if (isAdmin(session)) headers.set('X-Is-Admin', ROLE_HEADER_VALUE_ADMIN)

  const sessionId = pickSessionId(session)
  if (sessionId) headers.set('X-Session-Id', sessionId)

  return headers
}

/**
 * Server-side: returns a `Headers` carrying the API key and the full session
 * context. Use this from any file that calls the backend directly (Route
 * Handler, Server Action). The caller MUST resolve `apiKey` and short-circuit
 * with a structured JSON response when it is missing — this helper does not
 * throw so that error response shape stays under caller control.
 */
export function buildBackendAuthHeaders(
  session: Session | null,
  options: BuildBackendAuthHeadersOptions & { apiKey: string }
): Headers {
  const headers = new Headers()
  headers.set('X-API-Key', options.apiKey)
  // Defense-in-depth: also send `Authorization: Bearer <key>`. Vercel/edge
  // server-to-server fetches may strip the custom `X-API-Key` header, while
  // the standard `Authorization` header is always forwarded. Backend
  // `require_api_key` accepts both (added 2026-07-22, live-chat 401 fix).
  headers.set('Authorization', `Bearer ${options.apiKey}`)
  if (options.contentType) headers.set('Content-Type', options.contentType)
  if (options.accept) headers.set('Accept', options.accept)

  return applySessionContextHeaders(session, headers)
}

/**
 * Client-side: returns the subset of session-derived headers that the proxy
 * would also inject. The browser must NEVER carry `X-API-Key`, so we
 * deliberately omit it. The proxy re-injects the full set server-side.
 */
export function buildBackendClientHeaders(
  session: Session | null,
  options: BuildBackendAuthHeadersOptions = {}
): Headers {
  const headers = new Headers()
  if (options.contentType) headers.set('Content-Type', options.contentType)
  if (options.accept) headers.set('Accept', options.accept)

  return applySessionContextHeaders(session, headers)
}

/**
 * @deprecated since 2026-06-12. The previous no-op signature silently dropped
 * every header except `Content-Type`, which made it dangerous to call from any
 * direct-to-backend code path. Use `buildBackendAuthHeaders` (server) or
 * `buildBackendClientHeaders` (client) instead. Kept as a redirect to the
 * client helper so existing page-side call sites that hit `/api/backend/...`
 * continue to work without modification.
 */
export function buildBackendHeaders(
  session: Session | null = null,
  options: BuildBackendAuthHeadersOptions = {}
): Headers {
  return buildBackendClientHeaders(session, options)
}

/**
 * Server-side helper: resolve the backend API key from the environment and
 * return a structured 500 JSON response when it is missing. Callers SHOULD use
 * this in place of `getBackendApiKey()` whenever they need to fail fast with
 * a user-facing message rather than a raw thrown error. Example:
 *
 *   const apiKeyOrResponse = getBackendApiKeyOrFail()
 *   if (apiKeyOrResponse instanceof NextResponse) return apiKeyOrResponse
 *   const apiKey = apiKeyOrResponse
 *   headers: buildBackendAuthHeaders(session, { apiKey })
 */
export type BackendApiKeyOrResponse =
  | { apiKey: string; error?: undefined }
  | { apiKey?: undefined; error: Response }

export function getBackendApiKeyOrFail(
  missingMessage = '缺少后端 API Key 配置'
): BackendApiKeyOrResponse {
  const apiKey = getBackendApiKey()
  if (!apiKey) {
    // next/server is a static ESM module; the dynamic require keeps this
    // helper out of any non-route unit-test bundle while still being
    // statically analyzable.
    const { NextResponse } = require('next/server') as typeof import('next/server')
    return { error: NextResponse.json({ message: missingMessage }, { status: 500 }) }
  }
  return { apiKey }
}
