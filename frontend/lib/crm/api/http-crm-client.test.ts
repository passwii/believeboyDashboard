/**
 * HttpCrmClient.listAuditLogs 多值过滤测试（P5-9）
 *
 * 直接校验 query string 序列化逻辑；mock fetch 不读 response body。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, HttpCrmClient } from './http-crm-client'

describe('HttpCrmClient.listAuditLogs (P5-9)', () => {
  let originalFetch: typeof fetch
  let lastUrl: string | null = null
  let lastInit: RequestInit | undefined

  beforeEach(() => {
    originalFetch = globalThis.fetch
    lastUrl = null
    lastInit = undefined
    globalThis.fetch = vi.fn(async (url, init) => {
      lastUrl = String(url)
      lastInit = init
      return new Response(JSON.stringify({ items: [], total: 0, page: 1, page_size: 20 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('serializes entity_types + entity_ids multi-value params', async () => {
    const client = new HttpCrmClient()
    await client.listAuditLogs({
      entityTypes: ['customer', 'contact'],
      entityIds: [100, 201, 202],
      pageSize: 50,
    })
    expect(lastUrl).not.toBeNull()
    // fetch 可能重复 append entity_types / entity_ids；用 URLSearchParams 检查
    const qs = lastUrl!.split('?')[1] ?? ''
    const params = new URLSearchParams(qs)
    expect(params.getAll('entity_types').sort()).toEqual(['contact', 'customer'])
    expect(params.getAll('entity_ids').sort()).toEqual(['100', '201', '202'])
    expect(params.get('page_size')).toBe('50')
  })

  it('falls back to single-value entity_type / entity_id when arrays empty', async () => {
    const client = new HttpCrmClient()
    await client.listAuditLogs({
      entityType: 'lead',
      entityId: '7',
      pageSize: 10,
    })
    const qs = lastUrl!.split('?')[1] ?? ''
    const params = new URLSearchParams(qs)
    expect(params.get('entity_type')).toBe('lead')
    expect(params.get('entity_id')).toBe('7')
    expect(params.has('entity_types')).toBe(false)
    expect(params.has('entity_ids')).toBe(false)
  })
})

describe('ApiError (P5-11)', () => {
  it('exposes status + body', () => {
    const e = new ApiError(403, 'forbidden', { detail: 'no perm' })
    expect(e).toBeInstanceOf(Error)
    expect(e.status).toBe(403)
    expect(e.message).toBe('forbidden')
    expect(e.body).toEqual({ detail: 'no perm' })
    expect(e.name).toBe('ApiError')
  })
})

describe('HttpCrmClient.updateValueScores (P6a)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let client: HttpCrmClient
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 7,
        name: 'X',
        rating: 'A',
        score_scale: 'A',
        score_pay: 'A',
        score_fit: 'A',
        score_coop: 'A',
        owner_id: 'u1',
        owner_name: null,
        contact_name: null,
        contact_phone: null,
        contact_email: null,
        contact_wechat: null,
        address: null,
        website: null,
        annual_revenue: null,
        employee_count: null,
        remark: null,
        last_follow_at: null,
        next_follow_at: null,
        created_by: 'u1',
        created_at: '',
        updated_at: '',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    client = new HttpCrmClient()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  it('PATCH /customers/{id}/value-scores with body', async () => {
    await client.updateValueScores('7', {
      score_scale: 'A',
      score_pay: 'A',
      score_fit: 'A',
      score_coop: 'A',
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/customers/7/value-scores')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({
      score_scale: 'A',
      score_pay: 'A',
      score_fit: 'A',
      score_coop: 'A',
    })
  })
  it('partial body sends only provided', async () => {
    await client.updateValueScores('7', { score_scale: 'A', score_pay: 'B' })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      score_scale: 'A',
      score_pay: 'B',
    })
  })
})