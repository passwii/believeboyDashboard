import { notFound } from 'next/navigation'

import PageRenderer from './page-renderer'

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
  // Use a relative URL so the server-side fetch resolves against the current
  // deployment automatically. Relying on NEXTAUTH_URL / NEXT_PUBLIC_BASE_URL
  // here broke in production: those vars live only in the un-deployed
  // .env.local, so the fallback `http://localhost:3200` was unreachable from
  // the serverless runtime and every public page 404'd with "页面不存在".
  try {
    const res = await fetch(`/api/public/page-render/${id}`, {
      next: { revalidate: 3600 },
    })
    if (res.status === 404) return null
    if (!res.ok) return null
    return (await res.json()) as PublicPayload
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
  return (
    <div className="rounded-lg border border-border/60 bg-background p-8 text-center text-sm text-muted-foreground">
      {message}
    </div>
  )
}
