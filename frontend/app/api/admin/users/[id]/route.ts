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
    isActive?: boolean
    roleType?: 'admin' | 'operator' | 'businessdev' | 'factory'
    password?: string
    operator_name_zh?: string | null
  }

  if (body.password && body.password.length < 8) {
    return NextResponse.json({ message: '密码长度至少 8 位' }, { status: 400 })
  }

  if (params.id === session.user.id && body.isActive === false) {
    return NextResponse.json({ message: '不能停用当前登录账号' }, { status: 400 })
  }

  try {
    const data = await backendFetchJson<{ item: UserItem }>(
      `/api/v1/system-management/users/${params.id}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({
          name: body.name,
          full_name: body.fullName,
          is_active: body.isActive,
          role_type: body.roleType,
          password: body.password,
          operator_name_zh: body.operator_name_zh,
        }),
        cache: 'no-store',
      },
    )
    return NextResponse.json({ item: toFrontendUser(data.item) })
  } catch (err) {
    const message = normalizeErrorMessage(err, '更新失败')
    const status = message.includes('不存在') ? 404 : 500
    return NextResponse.json({ message }, { status })
  }
}
