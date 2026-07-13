import { NextResponse } from 'next/server'

import { buildBackendAuthHeaders, getBackendApiKeyOrFail } from '@/lib/backend-auth'
import { backendFetchJson } from '@/lib/server/backend-api'

/**
 * Public metadata proxy for `/p/{id}` page-render.
 *
 * No `requireUserSession` — this route is intentionally callable without
 * a NextAuth session so the public page can render for logged-out visitors.
 * The browser never carries `X-API-Key`; we inject it server-side here.
 *
 * Cache: 60s browser, 5m CDN, 1h SWR. Content is immutable (uploads have
 * no versioning) so a long revalidate window is safe and reduces R2 egress.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  try {
    const payload = await backendFetchJson<{
      id: string
      title: string
      source_format: 'markdown' | 'html'
      public_url: string
    }>(`/api/v1/page-render/public/${id}`, {
      method: 'GET',
      headers: buildBackendAuthHeaders(null, { apiKey: apiKeyOrResponse.apiKey }),
    })
    return NextResponse.json(payload, {
      headers: {
        'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600',
      },
    })
  } catch (err: unknown) {
    const status =
      typeof err === 'object' && err !== null && 'status' in err
        ? Number((err as { status?: number }).status)
        : 0
    if (status === 404) {
      return NextResponse.json({ message: '页面不存在或已删除' }, { status: 404 })
    }
    return NextResponse.json({ message: '暂时无法加载，请稍后重试' }, { status: 502 })
  }
}
