import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { freshnessFor, reduceDomainSummaries, useAgentDomainSummary } from './use-agent-domain-summary'

const NOW = new Date('2026-09-05T12:00:00Z')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('reduceDomainSummaries(P2b 域活动聚合)', () => {
  it('items 按 domain code 索引', () => {
    const map = reduceDomainSummaries([
      { domain: 'complaint_center', calls_24h: 12, calls_7d: 89, writes_24h: 2, writes_7d: 14, errors_7d: 0 },
      { domain: 'sku_info', calls_24h: 3, calls_7d: 23, writes_24h: 1, writes_7d: 5, errors_7d: 3 },
    ])
    expect(map['complaint_center']?.calls_30d).toBe(89)
    expect(map['complaint_center']?.writes_30d).toBe(14)
    expect(map['sku_info']?.errors_30d).toBe(3)
    expect(Object.keys(map)).toHaveLength(2)
  })

  it('将后端 *_7d 字段规范化为实际请求的 30 天字段', () => {
    const map = reduceDomainSummaries([
      {
        domain: 'sales',
        calls_24h: 2,
        calls_7d: 120,
        writes_24h: 1,
        writes_7d: 42,
        errors_7d: 6,
      },
    ])

    expect(map.sales).toEqual({
      domain: 'sales',
      calls_24h: 2,
      calls_30d: 120,
      writes_24h: 1,
      writes_30d: 42,
      errors_30d: 6,
      last_active_at: undefined,
    })
  })

  it('非数组 / 空 → 空 map;非法条目跳过', () => {
    expect(reduceDomainSummaries(null)).toEqual({})
    expect(reduceDomainSummaries(undefined)).toEqual({})
    expect(reduceDomainSummaries([null as never, {} as never, { domain: '' } as never])).toEqual({})
  })
})

describe('useAgentDomainSummary', () => {
  it('请求 30 天窗口并将后端窗口字段映射为 30d 数据', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            domain: 'sales',
            calls_24h: 2,
            calls_7d: 120,
            writes_24h: 1,
            writes_7d: 42,
            errors_7d: 6,
            last_active_at: '2026-09-05T11:00:00Z',
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useAgentDomainSummary())

    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/backend/api/v1/agent-ops/domain-summary?days=30',
      { cache: 'no-store' }
    )
    expect(result.current.data?.sales).toEqual({
      domain: 'sales',
      calls_24h: 2,
      calls_30d: 120,
      writes_24h: 1,
      writes_30d: 42,
      errors_30d: 6,
      last_active_at: '2026-09-05T11:00:00Z',
    })
  })
})

describe('freshnessFor(新鲜度灯:绿 <24h / 黄 1-7d / 灰 >7d 或从未)', () => {
  it('3 小时前 → green', () => {
    expect(freshnessFor('2026-09-05T09:00:00Z', NOW)).toBe('green')
  })

  it('3 天前 → yellow', () => {
    expect(freshnessFor('2026-09-02T12:00:00Z', NOW)).toBe('yellow')
  })

  it('8 天前 → gray', () => {
    expect(freshnessFor('2026-08-28T12:00:00Z', NOW)).toBe('gray')
  })

  it('缺省 / 非法时间 → gray', () => {
    expect(freshnessFor(null, NOW)).toBe('gray')
    expect(freshnessFor(undefined, NOW)).toBe('gray')
    expect(freshnessFor('not-a-date', NOW)).toBe('gray')
  })
})
