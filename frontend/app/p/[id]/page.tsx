import { notFound } from 'next/navigation'

import { buildBackendAuthHeaders } from '@/lib/backend-auth'
import { backendFetchJson, getBackendApiKey } from '@/lib/server/backend-api'

import PageRenderer from './page-renderer'
import styles from './page-renderer.module.css'

// Public content is immutable (no versioning). A long revalidate window
// keeps the R2 bucket egress low without ever serving stale data.
export const revalidate = 3600
export const dynamic = 'force-dynamic' // ensure per-request fetch (Next.js 16 default behaviour)

type Metadata = {
  title: string
  description?: string
  robots?: { index: boolean; follow: boolean }
}

type PublicPayload = {
  id: string
  title: string
  source_format: 'markdown' | 'html'
  public_url: string
}

async function fetchPublic(id: string): Promise<PublicPayload | null> {
  // Call the backend directly instead of self-fetching our own `/api/public`
  // route. Two previous approaches both failed in production:
  //   1. Absolute URL from NEXTAUTH_URL/NEXT_PUBLIC_BASE_URL — those vars live
  //      only in the un-deployed .env.local, so it fell back to
  //      `http://localhost:3200` and 404'd.
  //   2. Relative URL `/api/public/...` — in a Next server component on Vercel
  //      this resolves against the function's loopback (`localhost`), which has
  //      no `/api/public`, so it hung then 404'd.
  // Talking to the backend (BACKEND_API_BASE_URL / BACKEND_API_KEY, both set on
  // Vercel) is the same path the working `/api/public` route handler uses.
  const apiKey = getBackendApiKey()
  if (!apiKey) return null
  try {
    return await backendFetchJson<PublicPayload>(`/api/v1/page-render/public/${id}`, {
      method: 'GET',
      headers: buildBackendAuthHeaders(null, { apiKey }),
    })
  } catch {
    return null
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const payload = await fetchPublic(id)
  if (!payload) {
    return { title: '页面不存在 | believeboy Dashboard' }
  }
  const formatLabel = payload.source_format === 'markdown' ? 'Markdown' : 'HTML'
  return {
    title: `${payload.title} | believeboy Dashboard`,
    description: `由 believeboy Dashboard 渲染的 ${formatLabel} 页面`,
    robots: { index: true, follow: true },
  }
}

export default async function PublicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const payload = await fetchPublic(id)
  if (!payload) notFound()

  // Fetch the actual content from R2 (public, server-side — no CORS issue).
  let content = ''
  try {
    const res = await fetch(payload.public_url, {
      next: { revalidate: 3600 },
    })
    if (!res.ok) {
      return <ErrorPanel message="页面内容加载失败" />
    }
    content = await res.text()
  } catch {
    return <ErrorPanel message="页面内容加载失败" />
  }

  return <PageRenderer content={content} format={payload.source_format} title={payload.title} />
}

function ErrorPanel({ message }: { message: string }) {
  return <div className={styles.errorState}>{message}</div>
}
