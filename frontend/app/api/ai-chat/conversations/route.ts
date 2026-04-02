import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { normalizeErrorMessage } from '@/lib/error-utils'
import { backendFetchJson, getBackendApiKey } from '@/lib/server/backend-api'

export async function GET() {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  try {
    const apiKey = getBackendApiKey()
    if (!apiKey) {
      throw new Error('缺少后端 API Key 配置')
    }

    const data = await backendFetchJson('/api/v1/ai/conversations', {
      method: 'GET',
      headers: { 'X-API-Key': apiKey },
      cache: 'no-store',
    })
    return NextResponse.json(data)
  } catch (err) {
    return NextResponse.json({ message: normalizeErrorMessage(err, '加载会话失败') }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 })
  }

  const body = (await request.json()) as { title?: string }

  try {
    const apiKey = getBackendApiKey()
    if (!apiKey) {
      throw new Error('缺少后端 API Key 配置')
    }

    const data = await backendFetchJson('/api/v1/ai/conversations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({ title: body.title }),
      cache: 'no-store',
    })
    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    return NextResponse.json({ message: normalizeErrorMessage(err, '创建会话失败') }, { status: 500 })
  }
}
