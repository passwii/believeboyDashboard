import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { buildBackendAuthHeaders } from '@/lib/backend-auth'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { getBackendApiKey, backendFetchJson } from '@/lib/server/backend-api'

export async function POST(request: Request) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

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
      headers: buildBackendAuthHeaders(session, { apiKey: getBackendApiKey() }),
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
