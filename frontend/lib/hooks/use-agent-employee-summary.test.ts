import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { reduceEmployeeSummaries, useAgentEmployeeSummary } from './use-agent-employee-summary'

const RESPONSE_ITEMS = [
  {
    api_key_id: 1,
    calls_24h: 2,
    calls_7d: 30,
    writes_24h: 1,
    writes_7d: 10,
    errors_7d: 2,
    last_active_at: '2026-09-05T11:00:00Z',
  },
]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('reduceEmployeeSummaries(P3b 员工活动聚合)', () => {
  it('items 按 api_key_id 索引(字符串键)', () => {
    const map = reduceEmployeeSummaries([
      { api_key_id: 1, calls_24h: 2, calls_7d: 30, writes_24h: 1, writes_7d: 10, errors_7d: 2 },
      { api_key_id: 2, calls_24h: 0, calls_7d: 1, writes_24h: 0, writes_7d: 1, errors_7d: 1 },
    ])
    expect(map['1']?.calls_30d).toBe(30)
    expect(map['1']?.calls_24h).toBe(2)
    expect(map['1']?.writes_30d).toBe(10)
    expect(map['1']?.errors_30d).toBe(2)
    expect(map['2']?.errors_30d).toBe(1)
    expect(Object.keys(map)).toHaveLength(2)
  })

  it('将后端 *_7d 字段规范化为实际请求的 30 天字段', () => {
    expect(reduceEmployeeSummaries(RESPONSE_ITEMS)).toEqual({
      '1': {
        api_key_id: 1,
        calls_24h: 2,
        calls_30d: 30,
        writes_24h: 1,
        writes_30d: 10,
        errors_30d: 2,
        last_active_at: '2026-09-05T11:00:00Z',
      },
    })
  })

  it('非数组 / 空 → 空 map;非法条目跳过', () => {
    expect(reduceEmployeeSummaries(null)).toEqual({})
    expect(reduceEmployeeSummaries(undefined)).toEqual({})
    expect(reduceEmployeeSummaries([null as never, {} as never])).toEqual({})
  })
})

describe('useAgentEmployeeSummary', () => {
  it('请求 30 天窗口,保留 24 小时数据并映射后端聚合字段', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ window_days: 30, items: RESPONSE_ITEMS }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useAgentEmployeeSummary())

    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/backend/api/v1/agent-ops/employee-summary?days=30',
      { cache: 'no-store' }
    )
    expect(result.current.data?.['1']).toEqual({
      api_key_id: 1,
      calls_24h: 2,
      calls_30d: 30,
      writes_24h: 1,
      writes_30d: 10,
      errors_30d: 2,
      last_active_at: '2026-09-05T11:00:00Z',
    })
  })

  it.each([404, 503])('summary 返回 %s 时保持未知状态', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }))
    const { result } = renderHook(() => useAgentEmployeeSummary())

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.data).toBeNull()
  })
})
