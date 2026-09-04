import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { buildBackendAuthHeaders, getBackendApiKeyOrFail } from '@/lib/backend-auth'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { appendApiKeyQuery, getBackendBaseUrl } from '@/lib/server/backend-api'

type RouteContext = {
  params: Promise<{
    conversationId: string
  }>
}

// V2 取消：代理到后端 `POST /ai/conversations/{id}/cancel`（Redis GETDEL，跨 worker 生效）。
// 前端 useChatStreamV2 的 stop() 调用此端点乐观取消正在进行的流。
export async function POST(_request: Request, { params }: RouteContext) {
  const { conversationId } = await params
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  try {
    const upstream = await fetch(
      `${getBackendBaseUrl()}${appendApiKeyQuery(`/api/v1/ai/conversations/${conversationId}/cancel`)}`,
      {
        method: 'POST',
        headers: buildBackendAuthHeaders(session, { apiKey: apiKeyOrResponse.apiKey }),
        cache: 'no-store',
      }
    )
    const data = (await upstream.json().catch(() => ({}))) as { cancelled?: boolean }
    if (!upstream.ok) {
      throw new Error('取消生成失败')
    }
    return NextResponse.json({ cancelled: Boolean(data.cancelled) })
  } catch (err) {
    return NextResponse.json(
      { message: normalizeErrorMessage(err, '取消生成失败') },
      { status: 500 }
    )
  }
}
