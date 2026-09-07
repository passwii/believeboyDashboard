import { describe, expect, it } from 'vitest'

import { reduceEmployeeSummaries } from './use-agent-employee-summary'

describe('reduceEmployeeSummaries(P3b 员工活动聚合)', () => {
  it('items 按 api_key_id 索引(字符串键)', () => {
    const map = reduceEmployeeSummaries([
      { api_key_id: 1, calls_24h: 2, calls_7d: 3, writes_24h: 1, writes_7d: 1, errors_7d: 0 },
      { api_key_id: 2, calls_24h: 0, calls_7d: 1, writes_24h: 0, writes_7d: 1, errors_7d: 1 },
    ])
    expect(map['1']?.calls_7d).toBe(3)
    expect(map['2']?.errors_7d).toBe(1)
    expect(Object.keys(map)).toHaveLength(2)
  })

  it('非数组 / 空 → 空 map;非法条目跳过', () => {
    expect(reduceEmployeeSummaries(null)).toEqual({})
    expect(reduceEmployeeSummaries(undefined)).toEqual({})
    expect(reduceEmployeeSummaries([null as never, {} as never])).toEqual({})
  })
})
