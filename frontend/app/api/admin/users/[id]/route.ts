import { NextResponse } from 'next/server'

import { requireAdminSession } from '@/lib/auth/server'
import { buildBackendAuthHeaders, getBackendApiKeyOrFail } from '@/lib/backend-auth'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { backendFetchJson, getBackendBaseUrl } from '@/lib/server/backend-api'

type UserItem = {
  id: string
  name: string
  email: string
  full_name?: string | null
  operator_name_zh?: string | null
  is_admin: boolean
  is_active: boolean
  role_type: 'admin' | 'operator' | 'businessdev'
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

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await requireAdminSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  const body = (await request.json()) as {
    name?: string
    fullName?: string
    isActive?: boolean
    roleType?: 'admin' | 'operator' | 'businessdev'
    password?: string
    operator_name_zh?: string | null
  }

  if (body.password && body.password.length < 8) {
    return NextResponse.json({ message: '密码长度至少 8 位' }, { status: 400 })
  }

  if (id === session.user.id && body.isActive === false) {
    return NextResponse.json({ message: '不能停用当前登录账号' }, { status: 400 })
  }

  try {
    const data = await backendFetchJson<{ item: UserItem }>(
      `/api/v1/system-management/users/${id}`,
      {
        method: 'PATCH',
        headers: buildBackendAuthHeaders(session, {
          apiKey: apiKeyOrResponse.apiKey,
          contentType: 'application/json',
        }),
        body: JSON.stringify({
          name: body.name,
          full_name: body.fullName,
          is_active: body.isActive,
          role_type: body.roleType,
          password: body.password,
          operator_name_zh: body.operator_name_zh,
        }),
        cache: 'no-store',
      }
    )
    return NextResponse.json({ item: toFrontendUser(data.item) })
  } catch (err) {
    const message = normalizeErrorMessage(err, '更新失败')
    const status = message.includes('不存在') ? 404 : 500
    return NextResponse.json({ message }, { status })
  }
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await requireAdminSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  const baseUrl = getBackendBaseUrl()
  const response = await fetch(`${baseUrl}/api/v1/system-management/users/${id}`, {
    method: 'DELETE',
    headers: buildBackendAuthHeaders(session, { apiKey: apiKeyOrResponse.apiKey }),
    cache: 'no-store',
  })

  if (response.ok) {
    return new NextResponse(null, { status: 204 })
  }

  let message = '删除失败'
  try {
    const data = (await response.json()) as { message?: string; detail?: string }
    message = data.message || data.detail || message
  } catch {
    // ignore parse error
  }
  const status = message.includes('不存在') ? 404 : message.includes('不允许') ? 403 : 500
  return NextResponse.json({ message }, { status })
}
