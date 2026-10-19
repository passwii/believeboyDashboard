import { describe, expect, it, vi } from 'vitest'

/**
 * 回归锁（BLF-1383）：`backendFetchJson` 从 `throw new Error(message)` 改成抛
 * `BackendHttpError`（带 `status`）后，本 route 的 `'status' in err` 判断第一次真正生效：
 * 后端 404 从**恒落 502** 变成返回 404「页面不存在或已删除」。这是改动的连带行为变化，
 * 不是本单的主目标，所以在这里钉一条断言避免以后被无声改回。
 */

const mocks = vi.hoisted(() => ({
  backendFetchJson: vi.fn(),
}))

vi.mock('@/lib/server/backend-api', () => ({
  backendFetchJson: mocks.backendFetchJson,
  BackendHttpError: class BackendHttpError extends Error {
    status: number
    constructor(message: string, init: { status: number }) {
      super(message)
      this.status = init.status
    }
  },
}))

vi.mock('@/lib/backend-auth', () => ({
  buildBackendAuthHeaders: vi.fn(() => new Headers()),
  getBackendApiKeyOrFail: () => ({ apiKey: 'test-key' }),
}))

import { BackendHttpError } from '@/lib/server/backend-api'

import { GET } from './route'

const ctx = { params: Promise.resolve({ id: 'page-1' }) }

describe('page-render 公共元数据代理', () => {
  it('后端 404 直接返回 404，而不是笼统的 502', async () => {
    mocks.backendFetchJson.mockRejectedValue(new BackendHttpError('Not Found', { status: 404 }))

    const response = await GET(new Request('https://dashboard.test/api/public/page-render/page-1'), ctx)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({ message: '页面不存在或已删除' })
  })

  it('其它后端失败仍然回 502，不把状态码直接透传给浏览器', async () => {
    mocks.backendFetchJson.mockRejectedValue(new BackendHttpError('boom', { status: 500 }))

    const response = await GET(new Request('https://dashboard.test/api/public/page-render/page-1'), ctx)

    expect(response.status).toBe(502)
  })
})
