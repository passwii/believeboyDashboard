import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { buildBackendAuthHeaders, getBackendApiKeyOrFail } from '@/lib/backend-auth'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { backendFetchJson } from '@/lib/server/backend-api'

type PatchBody = {
  name?: string
  full_name?: string | null
}

export async function GET() {
  const session = await requireUserSession()
  if (!session?.user?.id) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 })
  }

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  try {
    const profile = await backendFetchJson<Record<string, unknown>>(
      '/api/v1/system-management/profile',
      {
        headers: buildBackendAuthHeaders(session, {
          apiKey: apiKeyOrResponse.apiKey,
          accept: 'application/json',
        }),
        cache: 'no-store',
      }
    )
    return NextResponse.json(profile)
  } catch (err) {
    return NextResponse.json(
      { message: normalizeErrorMessage(err, '获取资料失败') },
      { status: 500 }
    )
  }
}

export async function PATCH(request: Request) {
  const session = await requireUserSession()
  if (!session?.user?.id) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 })
  }

  let body: PatchBody
  try {
    body = (await request.json()) as PatchBody
  } catch {
    return NextResponse.json({ message: 'Invalid JSON body' }, { status: 400 })
  }

  // Forward only the fields the backend knows about. Empty strings are
  // normalised to null so a blank input clears the field instead of
  // persisting whitespace.
  const payload: PatchBody = {}
  if (typeof body.name === 'string') {
    const trimmed = body.name.trim()
    if (!trimmed) {
      return NextResponse.json({ message: '姓名不能为空' }, { status: 400 })
    }
    payload.name = trimmed
  }
  if (typeof body.full_name === 'string') {
    payload.full_name = body.full_name.trim() || null
  } else if (body.full_name === null) {
    payload.full_name = null
  }

  if (Object.keys(payload).length === 0) {
    return NextResponse.json({ message: '没有需要更新的字段' }, { status: 400 })
  }

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  try {
    const profile = await backendFetchJson<Record<string, unknown>>(
      '/api/v1/system-management/profile',
      {
        method: 'PATCH',
        headers: buildBackendAuthHeaders(session, {
          apiKey: apiKeyOrResponse.apiKey,
          contentType: 'application/json',
          accept: 'application/json',
        }),
        body: JSON.stringify(payload),
        cache: 'no-store',
      }
    )
    return NextResponse.json(profile)
  } catch (err) {
    return NextResponse.json(
      { message: normalizeErrorMessage(err, '更新资料失败') },
      { status: 500 }
    )
  }
}
