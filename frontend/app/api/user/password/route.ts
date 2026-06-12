import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { buildBackendAuthHeaders } from '@/lib/backend-auth'
import { normalizeErrorMessage } from '@/lib/error-utils'
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

  // Step 1: verify the current password by hitting the login endpoint. The
  // login endpoint is unauthenticated and only needs `Content-Type`.
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

  // Step 2: persist the new password via the system-management endpoint. This
  // call goes directly to the backend, so we MUST build the API-key + session
  // header record via `buildBackendAuthHeaders` (single source of truth).
  try {
    await backendFetchJson(`/api/v1/system-management/users/${session.user.id}`, {
      method: 'PATCH',
      headers: buildBackendAuthHeaders(session, {
        apiKey: getBackendApiKey(),
        contentType: 'application/json',
      }),
      body: JSON.stringify({ password: newPassword }),
      cache: 'no-store',
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ message: normalizeErrorMessage(err, '修改失败') }, { status: 500 })
  }
}
