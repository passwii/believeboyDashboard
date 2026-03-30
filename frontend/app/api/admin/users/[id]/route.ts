import { NextResponse } from 'next/server'

import { requireAdminSession } from '@/lib/auth/server'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { backendFetchJson, getBackendApiKey } from '@/lib/server/backend-api'

type UserItem = {
  id: string
  name: string
  email: string
  full_name?: string | null
  operator_name_zh?: string | null
  is_admin: boolean
  is_active: boolean
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
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  }
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const session = await requireAdminSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const apiKey = getBackendApiKey()
  if (!apiKey) {
    return NextResponse.json({ message: '缺少后端 API Key 配置' }, { status: 500 })
  }

  const body = (await request.json()) as {
    name?: string
    fullName?: string
    isAdmin?: boolean
    isActive?: boolean
    password?: string
  }

  if (body.password && body.password.length < 8) {
    return NextResponse.json({ message: '密码长度至少 8 位' }, { status: 400 })
  }

  if (params.id === session.user.id && (body.isAdmin === false || body.isActive === false)) {
    return NextResponse.json({ message: '不能禁用或降级当前登录管理员' }, { status: 400 })
  }

  try {
    const data = await backendFetchJson<{ item: UserItem }>(`/api/v1/system-management/users/${params.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({
        name: body.name,
        full_name: body.fullName,
        is_admin: body.isAdmin,
        is_active: body.isActive,
        password: body.password,
      }),
      cache: 'no-store',
    })
    return NextResponse.json({ item: toFrontendUser(data.item) })
  } catch (err) {
    const message = normalizeErrorMessage(err, '更新失败')
    const status = message.includes('不存在') ? 404 : 500
    return NextResponse.json({ message }, { status })
  }
}
