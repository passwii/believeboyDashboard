import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { invalidateBackendSessionValidation } from '@/lib/auth/session-validation'
import { buildBackendAuthHeaders, getBackendApiKeyOrFail } from '@/lib/backend-auth'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { BackendHttpError, backendFetchJson } from '@/lib/server/backend-api'

type ChangePasswordBody = {
  currentPassword?: string
  newPassword?: string
}

export async function PATCH(request: Request) {
  const session = await requireUserSession()
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 })
  }

  let body: ChangePasswordBody
  try {
    body = (await request.json()) as ChangePasswordBody
  } catch {
    return NextResponse.json({ message: 'Invalid JSON body' }, { status: 400 })
  }

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

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  try {
    await backendFetchJson<{ ok: boolean }>('/api/v1/auth/change-password', {
      method: 'PATCH',
      headers: buildBackendAuthHeaders(session, {
        apiKey: apiKeyOrResponse.apiKey,
        contentType: 'application/json',
        accept: 'application/json',
      }),
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword,
      }),
      cache: 'no-store',
    })
    invalidateBackendSessionValidation(session.user.id, session.user.sessionId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    const status = err instanceof BackendHttpError ? err.status : 500
    return NextResponse.json(
      { message: normalizeErrorMessage(err, '修改失败') },
      { status }
    )
  }
}
