import { NextResponse } from 'next/server'

import { requireAdminSession } from '@/lib/auth/server'
import { buildBackendAuthHeaders, getBackendApiKeyOrFail } from '@/lib/backend-auth'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { backendFetchJson } from '@/lib/server/backend-api'

type UserItem = {
  id: string
  name: string
  email: string
  full_name?: string | null
  operator_name_zh?: string | null
  is_admin: boolean
  is_active: boolean
  role_type: 'admin' | 'operator' | 'businessdev' | 'factory'
  created_at: string
  updated_at: string
}

function toFrontendUser(item: UserItem) {
  return {
    id: item.id,
    name: item.name,
    email: item.email,
    fullName: item.full_name ?? null,
    operatorNameZh: item.operator_name_zh ?? null,
    isAdmin: item.is_admin,
    isActive: item.is_active,
    roleType: item.role_type,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  }
}

export async function GET() {
  const session = await requireAdminSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  try {
    const data = await backendFetchJson<{ items: UserItem[] }>('/api/v1/system-management/users', {
      method: 'GET',
      headers: buildBackendAuthHeaders(session, { apiKey: apiKeyOrResponse.apiKey }),
      cache: 'no-store',
    })
    return NextResponse.json({ items: data.items.map(toFrontendUser) })
  } catch (err) {
    return NextResponse.json({ message: normalizeErrorMessage(err, '加载失败') }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const session = await requireAdminSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  const body = (await request.json()) as {
    name?: string
    email?: string
    fullName?: string
    password?: string
    isAdmin?: boolean
    roleType?: 'admin' | 'operator' | 'businessdev' | 'factory'
    operator_name_zh?: string | null
  }

  try {
    const data = await backendFetchJson<{ item: UserItem }>('/api/v1/system-management/users', {
      method: 'POST',
      headers: buildBackendAuthHeaders(session, {
        apiKey: apiKeyOrResponse.apiKey,
        contentType: 'application/json',
      }),
      body: JSON.stringify({
        name: body.name,
        email: body.email,
        full_name: body.fullName,
        password: body.password,
        is_admin: Boolean(body.isAdmin),
        role_type: body.roleType ?? 'operator',
        operator_name_zh: body.operator_name_zh,
      }),
      cache: 'no-store',
    })
    return NextResponse.json({ item: toFrontendUser(data.item) }, { status: 201 })
  } catch (err) {
    const message = normalizeErrorMessage(err, '创建失败')
    const status = message.includes('已存在') ? 409 : 500
    return NextResponse.json({ message }, { status })
  }
}
