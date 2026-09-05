import { describe, expect, it } from 'vitest'

import {
  parseComplaintsOverview,
  parseInspectionOverview,
  usTodayYMD,
} from './use-agent-production'

describe('parseComplaintsOverview(P2c-1 客诉产出)', () => {
  it('有 run + 待回复数', () => {
    expect(
      parseComplaintsOverview({
        shops: [{ shop_id: 's1' }],
        metrics: { total_needs_reply: 3 },
      })
    ).toEqual({ hasRun: true, needsReply: 3 })
  })

  it('无 run(shops 空)→ hasRun=false', () => {
    expect(parseComplaintsOverview({ shops: [], metrics: { total_needs_reply: 0 } })).toEqual({
      hasRun: false,
      needsReply: 0,
    })
  })

  it('非预期形状 → 容错返回无 run', () => {
    expect(parseComplaintsOverview(null)).toEqual({ hasRun: false, needsReply: null })
    expect(parseComplaintsOverview({ metrics: { total_needs_reply: 'x' } })).toEqual({
      hasRun: false,
      needsReply: null,
    })
  })
})

describe('parseInspectionOverview(P2c-1 巡检产出)', () => {
  it('submitted / total 提取', () => {
    expect(parseInspectionOverview({ submitted_count: 2, total_projects: 5 })).toEqual({
      submitted: 2,
      total: 5,
    })
  })

  it('非数字容错 → null', () => {
    expect(parseInspectionOverview({})).toEqual({ submitted: null, total: null })
  })
})

describe('usTodayYMD(美西今天)', () => {
  it('UTC 中午 12 点 → 美西同日', () => {
    expect(usTodayYMD(new Date('2026-09-05T12:00:00Z'))).toBe('2026-09-05')
  })

  it('UTC 06:00 → 美西前一天 23:00', () => {
    expect(usTodayYMD(new Date('2026-09-05T06:00:00Z'))).toBe('2026-09-04')
  })
})
