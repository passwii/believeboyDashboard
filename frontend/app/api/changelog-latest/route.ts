export const runtime = 'nodejs'

import { NextResponse } from 'next/server'

import { normalizeErrorMessage } from '@/lib/error-utils'
import { getChangelogSnapshot } from '@/lib/server/changelog'

/**
 * Footer Ticker「更新日志」频道（BLF-816）：
 * 返回最新 release 的摘要，供客户端轻量轮询，避免把整个 changelog 快照打进客户端 bundle。
 */
export async function GET() {
  try {
    const snapshot = getChangelogSnapshot()
    const current = snapshot.currentRelease
    return NextResponse.json({
      version: current.version,
      codename: current.codename,
      summary: current.summary,
      updatedAt: snapshot.source.updatedAt,
    })
  } catch (error) {
    return NextResponse.json(
      { error: normalizeErrorMessage(error, '更新日志加载失败') },
      { status: 500 }
    )
  }
}
