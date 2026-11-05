export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'

import { requireUserSession } from '@/lib/auth/server'
import { getBackendPublicBaseUrl } from '@/lib/server/backend-api'

/** 暴露后端公共地址给客户端（Agent 调用说明需要真实 API 地址）。 */
export async function GET() {
  const session = await requireUserSession()
  if (!session) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json({ base_url: getBackendPublicBaseUrl() })
}
