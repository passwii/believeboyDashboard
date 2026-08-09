/**
 * HttpCrmClient.listAuditLogs 多值过滤测试（P5-9）
 *
 * 直接校验 query string 序列化逻辑；mock fetch 不读 response body。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, HttpCrmClient } from './http-crm-client'
import type { RuleInput } from '@/lib/crm/types'

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
describe('HttpCrmClient Task (P7, BLF-512)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let client: HttpCrmClient
  let lastUrl: string | null
  let lastInit: RequestInit | undefined

  beforeEach(() => {
    lastUrl = null
    lastInit = undefined
    fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      lastUrl = String(url)
      lastInit = init
      return new Response(
        JSON.stringify({
          items: [],
          total: 0,
          page: 1,
          page_size: 20,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    client = new HttpCrmClient()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('listTasks 序列化 scope + type + page_size', async () => {
    await client.listTasks({ scope: 'all', type: 'call', pageSize: 50 })
    expect(lastUrl).toContain('/tasks?')
    const qs = lastUrl!.split('?')[1] ?? ''
    const params = new URLSearchParams(qs)
    expect(params.get('scope')).toBe('all')
    expect(params.get('type')).toBe('call')
    expect(params.get('page_size')).toBe('50')
  })

  it('listTasks 缺省筛选不序列化', async () => {
    await client.listTasks({})
    const qs = lastUrl!.split('?')[1] ?? ''
    const params = new URLSearchParams(qs)
    expect(params.has('type')).toBe(false)
    expect(params.has('status')).toBe(false)
  })

  it('setTaskStatus POST /tasks/{id}/status with {status}', async () => {
    fetchMock.mockImplementationOnce(async (url: RequestInfo | URL, init?: RequestInit) => {
      lastUrl = String(url)
      lastInit = init
      return new Response(
        JSON.stringify({
          id: 9,
          title: '确认报价单',
          priority: 'medium',
          status: 'done',
          type: 'follow_up',
          owner_id: 'u1',
          created_at: '2026-08-01T00:00:00+00:00',
          updated_at: '2026-08-08T00:00:00+00:00',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })
    const updated = await client.setTaskStatus('9', 'done')
    expect(lastUrl).toBe('/api/backend/v1/crm/tasks/9/status')
    expect(lastInit?.method).toBe('POST')
    expect(JSON.parse(String(lastInit?.body))).toEqual({ status: 'done' })
    expect(updated.id).toBe('9')
    expect(updated.status).toBe('done')
  })
})

describe('HttpCrmClient Task 创建/编辑/完成/取消（BLF-514）', () => {
  let originalFetch: typeof fetch
  let lastUrl: string | null = null
  let lastInit: RequestInit | undefined

  function taskDto(overrides: Record<string, unknown> = {}) {
    return {
      id: 9,
      title: '确认报价单',
      priority: 'medium',
      status: 'pending',
      type: 'follow_up',
      owner_id: 'u1',
      created_at: '2026-08-01T00:00:00+00:00',
      updated_at: '2026-08-08T00:00:00+00:00',
      ...overrides,
    }
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch
    lastUrl = null
    lastInit = undefined
    globalThis.fetch = vi.fn(async (url, init) => {
      lastUrl = String(url)
      lastInit = init
      return new Response(JSON.stringify(taskDto()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('createTask POST /tasks with snake_case payload（customer_id 转 int）', async () => {
    const client = new HttpCrmClient()
    const created = await client.createTask({
      title: '新任务',
      type: 'call',
      priority: 'high',
      customerId: '42',
    })
    expect(lastUrl).toBe('/api/backend/v1/crm/tasks')
    expect(lastInit?.method).toBe('POST')
    const body = JSON.parse(String(lastInit?.body))
    expect(body).toMatchObject({ title: '新任务', type: 'call', priority: 'high', customer_id: 42 })
    expect(created.id).toBe('9')
  })

  it('updateTask PATCH /tasks/{id} with partial payload', async () => {
    const client = new HttpCrmClient()
    await client.updateTask('9', { title: '改后', priority: 'urgent' })
    expect(lastUrl).toBe('/api/backend/v1/crm/tasks/9')
    expect(lastInit?.method).toBe('PATCH')
    const body = JSON.parse(String(lastInit?.body))
    expect(body).toEqual({ title: '改后', priority: 'urgent' })
  })

  it('completeTask POST /tasks/{id}/complete', async () => {
    const client = new HttpCrmClient()
    await client.completeTask('9')
    expect(lastUrl).toBe('/api/backend/v1/crm/tasks/9/complete')
    expect(lastInit?.method).toBe('POST')
  })

  it('cancelTask POST /tasks/{id}/cancel', async () => {
    const client = new HttpCrmClient()
    await client.cancelTask('9')
    expect(lastUrl).toBe('/api/backend/v1/crm/tasks/9/cancel')
    expect(lastInit?.method).toBe('POST')
  })
})

describe('HttpCrmClient.getFunnelStageDetail (BLF-518)', () => {
  let originalFetch: typeof fetch
  let lastUrl: string | null = null

  beforeEach(() => {
    originalFetch = globalThis.fetch
    lastUrl = null
    globalThis.fetch = vi.fn(async (url) => {
      lastUrl = String(url)
      return new Response(
        JSON.stringify({
          stage: 'contacting',
          count: 0,
          stuck_count: 0,
          inflow: 0,
          outflow: null,
          stuck_days: 7,
          leads: [],
          page: 1,
          page_size: 10,
          total: 0,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('serializes stage + sort_by + stuck_days + pagination', async () => {
    const client = new HttpCrmClient()
    await client.getFunnelStageDetail({ stage: 'contacting', sortBy: 'dwell', stuckDays: 7, page: 2, pageSize: 10 })
    expect(lastUrl).toBe('/api/backend/v1/crm/dashboard/funnel/stage/contacting?sort_by=dwell&stuck_days=7&page=2&page_size=10')
  })

  it('defaults to sort_by=dwell & stuck_days=7', async () => {
    const client = new HttpCrmClient()
    await client.getFunnelStageDetail({ stage: 'new' })
    expect(lastUrl).toBe('/api/backend/v1/crm/dashboard/funnel/stage/new?sort_by=dwell&stuck_days=7')
  })
})

describe('HttpCrmClient.getLifecycleBoard (BLF-520)', () => {
  let originalFetch: typeof fetch
  let lastUrl: string | null = null

  beforeEach(() => {
    originalFetch = globalThis.fetch
    lastUrl = null
    globalThis.fetch = vi.fn(async (url) => {
      lastUrl = String(url)
      return new Response(
        JSON.stringify({
          first_follow: {
            metric: 'first_follow',
            label: '首次跟进',
            description: 'x',
            buckets: [
              { label: '1 天内', min_days: 0, max_days: 1, count: 2, pct: 1, cumulative_pct: 1 },
            ],
            summary: { sample_count: 2, total_count: 2, avg_days: 0.5 },
          },
          conversion: {
            metric: 'conversion',
            label: '转化',
            description: 'x',
            buckets: [],
            summary: { sample_count: 0, total_count: 1 },
          },
          churn: {
            metric: 'churn',
            label: '流失',
            description: 'x',
            buckets: [],
            summary: { sample_count: 0, total_count: 2 },
          },
          now_in_sea: 3,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('请求 /dashboard/lifecycle 并 camel 化映射', async () => {
    const client = new HttpCrmClient()
    const board = await client.getLifecycleBoard()
    expect(lastUrl).toBe('/api/backend/v1/crm/dashboard/lifecycle')
    expect(board.nowInSea).toBe(3)
    expect(board.firstFollow.metric).toBe('first_follow')
    expect(board.firstFollow.summary.sampleCount).toBe(2)
    expect(board.firstFollow.buckets[0]?.maxDays).toBe(1)
    expect(board.conversion.summary.sampleCount).toBe(0)
  })
})

describe('HttpCrmClient 规则引擎（P9，BLF-545）', () => {
  let originalFetch: typeof fetch
  let lastUrl: string | null = null
  let lastInit: RequestInit | undefined

  const ruleDto = {
    id: 1,
    name: '客户 7 天无跟进提醒',
    entity_type: 'customer',
    event_type: 'stale_follow_up',
    enabled: true,
    priority: 0,
    conditions: [
      { id: 10, field: 'days_since_created', operator: 'gte', value: '7', sort_order: 0 },
      { id: 11, field: 'last_follow_at', operator: 'is_null', value: null, sort_order: 1 },
    ],
    actions: [{ id: 20, action_type: 'notify_owner', params: null, sort_order: 0 }],
    created_at: '2026-08-08T00:00:00+00:00',
    updated_at: '2026-08-08T00:00:00+00:00',
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch
    lastUrl = null
    lastInit = undefined
    globalThis.fetch = vi.fn(async (url, init) => {
      lastUrl = String(url)
      lastInit = init
      return new Response(JSON.stringify(ruleDto), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('listRules 请求 GET /rules 并 camel 化映射 conditions/actions', async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      lastUrl = String(url)
      lastInit = init
      return new Response(JSON.stringify([ruleDto]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const client = new HttpCrmClient()
    const rules = await client.listRules()
    expect(lastUrl).toBe('/api/backend/v1/crm/rules')
    expect(lastInit?.method ?? 'GET').toBe('GET')
    expect(rules).toHaveLength(1)
    expect(rules[0]!.entityType).toBe('customer')
    expect(rules[0]!.conditions[0]).toEqual({
      id: 10,
      field: 'days_since_created',
      operator: 'gte',
      value: '7',
      sortOrder: 0,
    })
    expect(rules[0]!.actions[0]!.actionType).toBe('notify_owner')
  })

  it('createRule 请求 POST /rules 并发送 snake_case payload', async () => {
    const client = new HttpCrmClient()
    const input: RuleInput = {
      name: '客户 10 天无跟进提醒',
      entityType: 'customer',
      eventType: 'stale_follow_up',
      enabled: true,
      conditions: [
        { field: 'days_since_created', operator: 'gte', value: '10', sortOrder: 0 },
      ],
      actions: [{ actionType: 'notify_owner', params: null, sortOrder: 0 }],
    }
    await client.createRule(input)
    expect(lastUrl).toBe('/api/backend/v1/crm/rules')
    expect(lastInit?.method).toBe('POST')
    const body = JSON.parse(String(lastInit?.body)) as Record<string, unknown>
    expect(body.entity_type).toBe('customer')
    expect(body.conditions).toEqual([
      { field: 'days_since_created', operator: 'gte', value: '10', sort_order: 0 },
    ])
    expect(body.actions).toEqual([{ action_type: 'notify_owner', params: null, sort_order: 0 }])
  })

  it('updateRule 请求 PATCH /rules/{id}（启停开关复用）', async () => {
    const client = new HttpCrmClient()
    await client.updateRule(1, { enabled: false })
    expect(lastUrl).toBe('/api/backend/v1/crm/rules/1')
    expect(lastInit?.method).toBe('PATCH')
    expect(JSON.parse(String(lastInit?.body))).toEqual({ enabled: false })
  })

  it('deleteRule 请求 DELETE /rules/{id}', async () => {
    const client = new HttpCrmClient()
    await client.deleteRule(1)
    expect(lastUrl).toBe('/api/backend/v1/crm/rules/1')
    expect(lastInit?.method).toBe('DELETE')
  })
})
