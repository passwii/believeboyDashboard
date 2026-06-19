/**
 * Short-lived cache for high-frequency read-only GETs going through the
 * backend proxy.
 *
 * Why `unstable_cache` and not the in-memory `client-cache.ts`?
 * - Client-side caching only works on the same browser session; a second
 *   tab or a page refresh re-fetches.
 * - `unstable_cache` is the Next.js data cache (file/LRU) and lives on the
 *   server, so every request to `/api/backend/...` benefits within the
 *   `revalidate` window, including Server Components during navigation.
 *
 * Cache key contract (HIGHEST RISK — do not relax):
 *   The key MUST include the user identity (X-User-Id) and a serialization
 *   of the query string. A leak here would cross-pollinate responses
 *   between users — P0 incident, never accept a "global" key.
 *
 * Method contract:
 *   Only GET goes through the cache. POST / PATCH / PUT / DELETE bypass it
 *   entirely, because caching a write would silently re-run a mutation
 *   inside the revalidation window — even more dangerous than the leak.
 */
import { unstable_cache } from 'next/cache'

import { buildBackendUrl, buildBackendProxyHeaders, getProxyRequestBody, toProxyResponse } from '@/lib/server/backend-proxy'
import { getBackendApiKey, getBackendBaseUrl } from '@/lib/server/backend-api'

import type { Session } from 'next-auth'

const DEFAULT_REVALIDATE_SECONDS = 60

/**
 * Endpoint → pattern allowlist. The cache is opt-in: only paths on this
 * list are cached. Anything else falls through to the proxy as before.
 *
 * Patterns are matched against the *normalized* backend path
 * (`api/v1/...`), e.g. `api/v1/projects/manage`. Query strings are
 * matched separately via the `queryContains` field.
 */
export type CacheEndpointRule = {
  /** Human-readable label for logs. */
  readonly label: string
  /**
   * Regex tested against the normalized backend path. The path is the
   * portion after `/api/backend/...`, normalized to start with `api/`.
   */
  readonly pathPattern: RegExp
  /**
   * Optional: if the rule's path alone is ambiguous (e.g. matches both
   * list and detail endpoints), set this to disambiguate. The match
   * becomes a substring search against the lowercased query string.
   */
  readonly queryContains?: string
  /** Cache TTL in seconds. Defaults to 60s. */
  readonly revalidateSeconds?: number
  /**
   * Optional: when true, the cache key is the path + query only (no
   * user scoping). ONLY use this for endpoints that return global data
   * with no per-user filtering on the backend side. Default: false
   * (user-scoped, ALWAYS).
   */
  readonly skipUserScoping?: boolean
}

export const CACHEABLE_ENDPOINTS: ReadonlyArray<CacheEndpointRule> = [
  // ── Original allowlist (kept) ─────────────────────────────────────────────
  { label: 'projects-manage', pathPattern: /\/projects\/manage$/, revalidateSeconds: 60 },
  { label: 'daily-analysis-all', pathPattern: /\/daily-analysis\/all$/, revalidateSeconds: 60 },
  { label: 'exchange-rates', pathPattern: /\/exchange-rates$/, revalidateSeconds: 60 },
  { label: 'inventory-replenishment-snapshots', pathPattern: /\/inventory-replenishment-snapshots$/, revalidateSeconds: 60 },

  // ── BEL-133-step2: extended allowlist (Phase 1 — 4 high-traffic groups) ──
  //
  // All rules below use `\/<segment>$/` strict-anchored path patterns so
  // they only match the list endpoint itself, never detail endpoints like
  // `/monthly-reports/{id}/export`. POST/PUT/DELETE are short-circuited
  // upstream in `tryCachedBackendGet` (method !== 'GET' && method !== 'HEAD'),
  // so write operations on these resources still hit the backend live.

  // 1) ad-analysis: 10 read-only ad-hoc reports under /ad-analysis/*.
  //    All are project-scoped aggregations. 30s is a sweet spot for the
  //    operational team (single-digit-second navigation matters; one minute
  //    of staleness on ad rollups is acceptable).
  { label: 'ad-analysis-overview', pathPattern: /\/ad-analysis\/overview$/, revalidateSeconds: 30 },
  { label: 'ad-analysis-campaigns', pathPattern: /\/ad-analysis\/campaigns$/, revalidateSeconds: 30 },
  { label: 'ad-analysis-products', pathPattern: /\/ad-analysis\/products$/, revalidateSeconds: 30 },
  { label: 'ad-analysis-time-trend', pathPattern: /\/ad-analysis\/time-trend$/, revalidateSeconds: 30 },
  { label: 'ad-analysis-purchased-products', pathPattern: /\/ad-analysis\/purchased-products$/, revalidateSeconds: 30 },
  { label: 'ad-analysis-search-terms', pathPattern: /\/ad-analysis\/search-terms$/, revalidateSeconds: 30 },
  { label: 'ad-analysis-targets', pathPattern: /\/ad-analysis\/targets$/, revalidateSeconds: 30 },
  { label: 'ad-analysis-budget', pathPattern: /\/ad-analysis\/budget$/, revalidateSeconds: 30 },
  { label: 'ad-analysis-placements', pathPattern: /\/ad-analysis\/placements$/, revalidateSeconds: 30 },
  { label: 'ad-analysis-traffic-quality', pathPattern: /\/ad-analysis\/traffic-quality$/, revalidateSeconds: 30 },

  // 2) monthly-reports: ONLY the list endpoint (no `/{id}/...` matches).
  //    Monthly financials are low-frequency edits (manual reconciliation),
  //    so 60s is comfortable.
  { label: 'monthly-reports-list', pathPattern: /\/monthly-reports$/, revalidateSeconds: 60 },

  // 3) product-analysis: list/aggregate reads (sources, pt1, weekly).
  //    60s; users re-open these pages frequently.
  { label: 'product-analysis-sources', pathPattern: /\/product-analysis\/sources$/, revalidateSeconds: 60 },
  { label: 'product-analysis-pt1', pathPattern: /\/product-analysis\/pt1$/, revalidateSeconds: 60 },
  { label: 'product-analysis-weekly', pathPattern: /\/product-analysis\/weekly$/, revalidateSeconds: 60 },

  // 4) daily-analysis: the dashboard's all-countries cross-country view
  //    (separate from `/all` which was already cached). 30s.
  { label: 'daily-analysis-all-countries', pathPattern: /\/daily-analysis\/all-countries$/, revalidateSeconds: 30 },
]

/**
 * Looks up a cache rule for a path + query. Returns the matched rule
 * (with its TTL) or `null` if the path is not cacheable.
 */
export function findCacheRule(backendPath: string, query: string): CacheEndpointRule | null {
  const lowerQuery = query.toLowerCase()
  for (const rule of CACHEABLE_ENDPOINTS) {
    if (!rule.pathPattern.test(backendPath)) continue
    if (rule.queryContains && !lowerQuery.includes(rule.queryContains.toLowerCase())) continue
    return rule
  }
  return null
}

/**
 * Returns the cache key for a request. ALWAYS includes the user id
 * (when present) and a serialization of the query string. Two callers
 * with different `X-User-Id` headers get different keys, even if they
 * hit the same path — this is what stops cross-user data leaks.
 */
export function buildCacheKey(rule: CacheEndpointRule, backendPath: string, query: string, userId: string | null): string {
  const scope = rule.skipUserScoping ? 'global' : `user:${userId ?? 'anonymous'}`
  // Sort query params so equivalent queries hash to the same key
  // regardless of param order. The cache itself is path-scoped, so
  // collisions across paths are not possible.
  const normalizedQuery = normalizeQuery(query)
  return `proxy:${rule.label}:${scope}:${backendPath}?${normalizedQuery}`
}

function normalizeQuery(query: string): string {
  if (!query) return ''
  const stripped = query.startsWith('?') ? query.slice(1) : query
  if (!stripped) return ''
  const params = new URLSearchParams(stripped)
  // URLSearchParams iteration is insertion order, so re-emit with sorted keys
  // to make the cache key stable across clients that re-order params.
  return Array.from(params.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

/**
 * Cached GET against the backend, for use from the proxy route. The
 * wrapper:
 *   1. Builds a user-scoped + query-scoped cache key.
 *   2. Forwards a real `fetch` through `unstable_cache`, which stores
 *      the JSON body keyed by that key.
 *   3. Reconstructs a `Response` from the cached body so the proxy
 *      can hand it back to the client unchanged.
 *
 * Returns `null` when the path is not on the cache allowlist, so the
 * caller can fall through to the uncached proxy path.
 */
export async function tryCachedBackendGet(input: {
  backendPath: string
  search: string
  session: Session | null
  requestHeaders: Headers
  method: string
}): Promise<Response | null> {
  // Cache is GET-only.
  if (input.method !== 'GET' && input.method !== 'HEAD') return null

  const rule = findCacheRule(input.backendPath, input.search)
  if (!rule) return null

  const userId = input.session?.user?.id ?? null
  const cacheKey = buildCacheKey(rule, input.backendPath, input.search, userId)
  const revalidate = rule.revalidateSeconds ?? DEFAULT_REVALIDATE_SECONDS
  const url = `${buildBackendUrl(input.backendPath)}${input.search}`

  const cachedFetch = unstable_cache(
    async () => {
      const response = await fetch(url, {
        method: input.method,
        headers: buildBackendProxyHeaders(input.session, input.requestHeaders),
        body: await getProxyRequestBody(new Request(url, { method: input.method, headers: input.requestHeaders })),
        cache: 'no-store',
      })
      const headers: Record<string, string> = {}
      response.headers.forEach((value, name) => {
        if (isCacheableResponseHeader(name)) {
          headers[name] = value
        }
      })
      const body = await response.arrayBuffer()
      return {
        status: response.status,
        headers,
        body: arrayBufferToBase64(body),
      }
    },
    [cacheKey],
    { revalidate, tags: [`proxy:${rule.label}`, `proxy:${rule.label}:user:${userId ?? 'anonymous'}`] },
  )

  const cached = await cachedFetch()

  // Reconstruct a Response. We don't need to re-serialize the body —
  // base64 round-trip is acceptable for the short revalidate window.
  const responseHeaders = new Headers()
  Object.entries(cached.headers).forEach(([name, value]) => {
    responseHeaders.set(name, value)
  })
  responseHeaders.set('X-Backend-Cache', 'HIT')

  return new Response(base64ToArrayBuffer(cached.body), {
    status: cached.status,
    headers: responseHeaders,
  })
}

const CACHEABLE_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-disposition',
  'cache-control',
  'x-request-id',
])

function isCacheableResponseHeader(name: string): boolean {
  return CACHEABLE_RESPONSE_HEADERS.has(name.toLowerCase())
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  if (buffer.byteLength === 0) return ''
  // Buffer is available in both Node and edge runtimes; for the proxy
  // we run in nodejs runtime so Buffer is the simpler choice.
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buffer).toString('base64')
  }
  // Fallback for non-Node runtimes.
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  if (typeof btoa !== 'undefined') return btoa(binary)
  // Last resort: a hand-rolled base64 encoder. We avoid the dependency
  // to keep this module dependency-free.
  return base64Encode(binary)
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  if (!base64) return new ArrayBuffer(0)
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(base64, 'base64')
    // Slice to a fresh ArrayBuffer so the runtime does not retain a
    // larger pool allocation.
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  }
  if (typeof atob !== 'undefined') {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes.buffer
  }
  return base64Decode(base64)
}

// Minimal base64 fallback. Only reachable on runtimes that lack both
// `Buffer` and `btoa`/`atob` — currently none of the project's targets,
// but the helpers keep the module runnable in unanticipated runtimes.
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64Encode(input: string): string {
  let output = ''
  let i = 0
  for (; i + 2 < input.length; i += 3) {
    const a = input.charCodeAt(i)
    const b = input.charCodeAt(i + 1)
    const c = input.charCodeAt(i + 2)
    output += BASE64_ALPHABET[a >> 2]
    output += BASE64_ALPHABET[((a & 3) << 4) | (b >> 4)]
    output += BASE64_ALPHABET[((b & 15) << 2) | (c >> 6)]
    output += BASE64_ALPHABET[c & 63]
  }
  if (i < input.length) {
    const a = input.charCodeAt(i)
    const b = i + 1 < input.length ? input.charCodeAt(i + 1) : 0
    output += BASE64_ALPHABET[a >> 2]
    output += BASE64_ALPHABET[((a & 3) << 4) | (b >> 4)]
    output += i + 1 < input.length ? BASE64_ALPHABET[(b & 15) << 2] : '='
    output += '='
  }
  return output
}

function base64Decode(input: string): ArrayBuffer {
  const cleaned = input.replace(/=+$/, '')
  const bytes: number[] = []
  for (let i = 0; i < cleaned.length; i += 4) {
    const a = BASE64_ALPHABET.indexOf(cleaned[i] || 'A')
    const b = BASE64_ALPHABET.indexOf(cleaned[i + 1] || 'A')
    const c = BASE64_ALPHABET.indexOf(cleaned[i + 2] || 'A')
    const d = BASE64_ALPHABET.indexOf(cleaned[i + 3] || 'A')
    bytes.push((a << 2) | (b >> 4))
    if (cleaned[i + 2]) bytes.push(((b & 15) << 4) | (c >> 2))
    if (cleaned[i + 3]) bytes.push(((c & 3) << 6) | d)
  }
  return new Uint8Array(bytes).buffer
}

// Surface the base URL + API key exports to keep this file a self-
// contained cache module (helps unit tests that mock the upstream).
export { getBackendApiKey, getBackendBaseUrl }
