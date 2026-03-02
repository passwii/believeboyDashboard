import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { backendFetchJson, getBackendApiKey } from '@/lib/server/backend-api'

type ChangePasswordBody = {
  currentPassword?: string
  newPassword?: string
}

export async function PATCH(request: Request) {
  const session = await requireUserSession()
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 })
  }

  const apiKey = getBackendApiKey()
  if (!apiKey) {
    return NextResponse.json({ message: '缺少后端 API Key 配置' }, { status: 500 })
  }

  const body = (await request.json()) as ChangePasswordBody
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''

  if (!currentPassword || !newPassword) {
    return NextResponse.json({ message: '请填写完整信息' }, { status: 400 })
  }
  if (newPassword.length < 8) {
    return NextResponse.json({ message: '新密码长度至少 8 位' }, { status: 400 })
  }
  if (currentPassword === newPassword) {
    return NextResponse.json({ message: '新密码不能与当前密码一致' }, { status: 400 })
  }

  try {
    await backendFetchJson('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: session.user.email.trim().toLowerCase(),
        password: currentPassword,
      }),
      cache: 'no-store',
    })
  } catch {
    return NextResponse.json({ message: '当前密码不正确' }, { status: 400 })
  }

  try {
    await backendFetchJson(`/api/v1/system-management/users/${session.user.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({ password: newPassword }),
      cache: 'no-store',
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ message: err instanceof Error ? err.message : '修改失败' }, { status: 500 })
  }
}
