import type { Session } from 'next-auth'

import { buildBackendAuthHeaders } from '@/lib/backend-auth'
import { normalizeFullName, pickSessionDisplayName } from '@/lib/auth/display-name'
import {
  appendApiKeyQuery,
  getBackendApiKey,
  getBackendBaseUrl,
  getBackendTrustedProxySecret,
} from '@/lib/server/backend-api'

export type BackendSessionState = 'valid' | 'invalid' | 'unavailable'

type AuthMePayload = {
  id?: unknown
  email?: unknown
  name?: unknown
  full_name?: unknown
  is_admin?: unknown
  is_active?: unknown
  role_type?: unknown
}

type CacheEntry = {
  expiresAt: number
  state: BackendSessionState
}

const SESSION_VALIDATION_TTL_MS = 5_000
const SESSION_VALIDATION_CACHE_MAX = 512
const sessionValidationCache = new Map<string, CacheEntry>()

function sessionCacheKey(session: Session): string {
  const user = session.user
  const authIssuedAt = (user as typeof user & { authIssuedAt?: number }).authIssuedAt
  const fullNameState = user.fullName === undefined ? 'undefined' : user.fullName ?? 'null'
  return [
    user.id,
    user.sessionId ?? 'no-session-id',
    user.email?.trim().toLowerCase() ?? '',
    user.roleType ?? '',
    String(user.isAdmin),
    fullNameState,
    user.name ?? '',
    String(authIssuedAt ?? ''),
  ].join('\u0000')
}

function remember(key: string, state: BackendSessionState): void {
  if (sessionValidationCache.size >= SESSION_VALIDATION_CACHE_MAX) {
    const oldestKey = sessionValidationCache.keys().next().value
    if (oldestKey) sessionValidationCache.delete(oldestKey)
  }
  sessionValidationCache.set(key, {
    expiresAt: Date.now() + SESSION_VALIDATION_TTL_MS,
    state,
  })
}

function cachedState(key: string): BackendSessionState | undefined {
  const entry = sessionValidationCache.get(key)
  if (!entry) return undefined
  if (Date.now() >= entry.expiresAt) {
    sessionValidationCache.delete(key)
    return undefined
  }
  return entry.state
}

export function invalidateBackendSessionValidation(userId: string, sessionId?: string): void {
  const prefix = `${userId}\u0000`
  for (const key of sessionValidationCache.keys()) {
    if (!key.startsWith(prefix)) continue
    if (sessionId && !key.startsWith(`${prefix}${sessionId}\u0000`)) continue
    sessionValidationCache.delete(key)
  }
}

/**
 * Revalidate the signed NextAuth identity against Go. Infrastructure failures
 * are distinct from invalid credentials so callers can fail closed with 503.
 */
export async function validateBackendSession(session: Session | null): Promise<BackendSessionState> {
  const user = session?.user
  if (!session || !user?.id || !user.email || !user.sessionId) return 'invalid'

  const key = sessionCacheKey(session)
  const cached = cachedState(key)
  if (cached) return cached

  const apiKey = getBackendApiKey()
  const trustedProxySecret = getBackendTrustedProxySecret()
  if (!apiKey || !trustedProxySecret) return 'unavailable'

  try {
    const headers = buildBackendAuthHeaders(session, {
      apiKey,
      accept: 'application/json',
    })
    const authIssuedAt = (user as typeof user & { authIssuedAt?: number }).authIssuedAt
    if (typeof authIssuedAt === 'number' && Number.isFinite(authIssuedAt) && authIssuedAt > 0) {
      headers.set('X-Session-Issued-At', String(Math.floor(authIssuedAt)))
    }
    const response = await fetch(
      `${getBackendBaseUrl()}/api/v1/auth/me${appendApiKeyQuery('')}`,
      {
        method: 'GET',
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(5_000),
      }
    )

    if (response.status === 401 || response.status === 403 || response.status === 404) {
      remember(key, 'invalid')
      return 'invalid'
    }
    if (!response.ok) return 'unavailable'

    const payload = (await response.json()) as AuthMePayload
    const expectedRole = user.roleType ?? (user.isAdmin ? 'admin' : 'operator')
    const expectedFullName = pickSessionDisplayName(user)
    const currentFullName = normalizeFullName(payload.full_name)

    const matches =
      String(payload.id ?? '') === user.id &&
      String(payload.email ?? '').trim().toLowerCase() === user.email.trim().toLowerCase() &&
      payload.is_active === true &&
      payload.is_admin === Boolean(user.isAdmin) &&
      payload.role_type === expectedRole &&
      currentFullName === expectedFullName
    if (!matches) {
      remember(key, 'invalid')
      return 'invalid'
    }

    remember(key, 'valid')
    return 'valid'
  } catch {
    return 'unavailable'
  }
}
