import type { Session } from 'next-auth'

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
 *     Handler that calls the backend directly.
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
  /** When provided, sets `Content-Type` on the returned record. */
  contentType?: string
  /** When provided, sets `Accept` on the returned record. */
  accept?: string
}

const ROLE_HEADER_VALUE_ADMIN = 'true'

function pickUserId(session: Session | null): string | null {
  if (!session) return null
  const userId = session.user?.id?.trim()
  return userId ? userId : null
}

function pickUserName(session: Session | null): string | null {
  if (!session) return null
  return session.user?.operatorNameZh?.trim() || session.user?.name?.trim() || null
}

function pickUserEmail(session: Session | null): string | null {
  if (!session) return null
  const email = session.user?.email?.trim()
  return email ? email : null
}

function pickOperatorName(session: Session | null): string | null {
  if (!session) return null
  return session.user?.operatorNameZh?.trim() || null
}

function pickSessionId(session: Session | null): string | null {
  if (!session) return null
  return session.user?.sessionId?.trim() || null
}

function pickRoleType(session: Session | null): string | null {
  if (!session) return null
  return session.user?.roleType?.trim() || null
}

function isAdmin(session: Session | null): boolean {
  return pickRoleType(session) === 'admin'
}

function pickSessionContextHeaders(
  session: Session | null,
  headers: Record<string, string>
): Record<string, string> {
  const userId = pickUserId(session)
  if (userId) headers['X-User-Id'] = userId

  const userName = pickUserName(session)
  if (userName) headers['X-User-Name'] = encodeURIComponent(userName)

  const userEmail = pickUserEmail(session)
  if (userEmail) headers['X-User-Email'] = encodeURIComponent(userEmail)

  const operatorName = pickOperatorName(session)
  if (operatorName) headers['X-Operator'] = encodeURIComponent(operatorName)

  const roleType = pickRoleType(session)
  if (roleType) headers['X-Role-Type'] = roleType
  if (isAdmin(session)) headers['X-Is-Admin'] = ROLE_HEADER_VALUE_ADMIN

  const sessionId = pickSessionId(session)
  if (sessionId) headers['X-Session-Id'] = sessionId

  return headers
}

/**
 * Server-side: returns a `Record<string, string>` carrying the API key and the
 * full session context. Use this from any file that calls the backend
 * directly (Route Handler, Server Action). Throws if `apiKey` is empty, since
 * the backend would reject the request anyway.
 */
export function buildBackendAuthHeaders(
  session: Session | null,
  options: BuildBackendAuthHeadersOptions & { apiKey: string }
): Record<string, string> {
  if (!options.apiKey) {
    throw new Error('缺少后端 API Key 配置')
  }

  const headers: Record<string, string> = {
    'X-API-Key': options.apiKey,
  }
  if (options.contentType) headers['Content-Type'] = options.contentType
  if (options.accept) headers['Accept'] = options.accept

  return pickSessionContextHeaders(session, headers)
}

/**
 * Client-side: returns the subset of session-derived headers that the proxy
 * would also inject. The browser must NEVER carry `X-API-Key`, so we
 * deliberately omit it. The proxy re-injects the full set server-side.
 */
export function buildBackendClientHeaders(
  session: Session | null | undefined,
  options: BuildBackendAuthHeadersOptions = {}
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (options.contentType) headers['Content-Type'] = options.contentType
  if (options.accept) headers['Accept'] = options.accept

  return pickSessionContextHeaders(session ?? null, headers)
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
  session?: Session | null,
  options: BuildBackendAuthHeadersOptions = {}
): Record<string, string> {
  return buildBackendClientHeaders(session, options)
}
