import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { buildBackendAuthHeaders, getBackendApiKeyOrFail } from '@/lib/backend-auth'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { backendFetchJson } from '@/lib/server/backend-api'

export async function POST(request: Request) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const apiKeyOrResponse = getBackendApiKeyOrFail()
  if (apiKeyOrResponse.error) return apiKeyOrResponse.error

  try {
    const formData = new FormData()
    const file = await request.arrayBuffer()
    const blob = new Blob([file])
    const fileName = request.headers.get('x-file-name') || 'file'
    formData.append('file', blob, fileName)

    const payload = await backendFetchJson<{
      file_name: string
      file_type: string
      content: string
      truncated: boolean
      truncated_note: string | null
    }>('/api/v1/ai/upload', {
      method: 'POST',
      headers: buildBackendAuthHeaders(session, { apiKey: apiKeyOrResponse.apiKey }),
      body: formData as unknown as string,
    })

    return NextResponse.json(payload)
  } catch (err) {
    return NextResponse.json(
      { message: normalizeErrorMessage(err, '文件上传失败') },
      { status: 500 }
    )
  }
}
