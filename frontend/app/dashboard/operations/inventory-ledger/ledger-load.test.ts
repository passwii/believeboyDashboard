import { afterEach, describe, expect, it, vi } from 'vitest'

import { LedgerApiError, fetchLedgerJson } from './ledger-load'

/**
 * BEL-417 iteration 1: `fetchLedgerJson` is the robustness contract for the
 * inventory-ledger page. Before it existed, a backend 500 body was stored as
 * page data and the render crashed on `snapshot.skus.reduce(...)`.
 */

function jsonResponse(status: number, body: unknown, okText?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (okText === 'NOT_JSON') throw new SyntaxError('Unexpected token')
      return body
    },
  } as unknown as Response
}

describe('fetchLedgerJson (BEL-417)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('returns parsed JSON on 2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { months: ['2026-06-01'] })))
    const data = await fetchLedgerJson<{ months: string[] }>('/x')
    expect(data.months).toEqual(['2026-06-01'])
  })

  it('throws LedgerApiError with backend `detail` on 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(500, { detail: 'Internal Server Error' })),
    )
    await expect(fetchLedgerJson('/x')).rejects.toThrow(LedgerApiError)
    await expect(fetchLedgerJson('/x')).rejects.toThrow('Internal Server Error')
    try {
      await fetchLedgerJson('/x')
    } catch (err) {
      expect(err).toBeInstanceOf(LedgerApiError)
      expect((err as LedgerApiError).status).toBe(500)
    }
  })

  it('falls back to `message` when `detail` is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(502, { message: '后端服务暂时不可用' })),
    )
    await expect(fetchLedgerJson('/x')).rejects.toThrow('后端服务暂时不可用')
  })

  it('uses a generic HTTP-status message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(503, null, 'NOT_JSON')))
    await expect(fetchLedgerJson('/x')).rejects.toThrow('请求失败（HTTP 503）')
  })

  it('uses the generic message when detail/message are empty strings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(422, { detail: '  ' })))
    await expect(fetchLedgerJson('/x')).rejects.toThrow('请求失败（HTTP 422）')
  })

  it('propagates network errors untouched (no r.ok involved)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    await expect(fetchLedgerJson('/x')).rejects.toThrow('fetch failed')
  })
})
