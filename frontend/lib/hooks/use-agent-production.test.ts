import { describe, expect, it } from 'vitest'

import complaintsWithRunJson from '../../tests/fixtures/complaints-overview-with-run.json'
import complaintsWithoutRunJson from '../../tests/fixtures/complaints-overview-without-run.json'
import {
  COMPLAINTS_OVERVIEW_KEYS,
  parseComplaintsOverview,
  parseInspectionOverview,
  usTodayYMD,
} from './use-agent-production'
import type { ComplaintsOverviewResponse } from './use-agent-production'

/**
 * 真实响应快照(`tests/fixtures/complaints-overview-*.json`)。
 *
 * 抓取口径:本地后端 + 生产库快照 `BLF` + 管理员账号上下文；快照与后端真实响应逐字节同值。
 *
 * 注解为契约类型:快照刷新时若后端换了键名,类型不符会先在编译期报出来;
 * 下方 `COMPLAINTS_OVERVIEW_KEYS` 断言再做一次运行期钉住。
 */
const complaintsWithRun: ComplaintsOverviewResponse = complaintsWithRunJson
const complaintsWithoutRun: ComplaintsOverviewResponse = complaintsWithoutRunJson

describe('parseComplaintsOverview(P2c-1 客诉产出)', () => {
  it('真实响应(有 run)→ hasRun=true + 实测待回复数', () => {
    expect(parseComplaintsOverview(complaintsWithRun)).toEqual({ hasRun: true, needsReply: 1 })
  })

  it('真实响应(无 run,projects 为空)→ hasRun=false', () => {
    expect(parseComplaintsOverview(complaintsWithoutRun)).toEqual({
      hasRun: false,
      needsReply: 0,
    })
  })

  it('形状断言:解析器读的键必须真存在于真实响应里(旧键 shops 已不存在)', () => {
    for (const key of COMPLAINTS_OVERVIEW_KEYS) {
      expect(Object.keys(complaintsWithRun)).toContain(key)
      expect(Object.keys(complaintsWithoutRun)).toContain(key)
    }
    // BLF-981(#556)起店铺行改名为 projects;若哪天又快照回 shops,这条会红
    expect(complaintsWithRun).not.toHaveProperty('shops')
    expect(complaintsWithoutRun).not.toHaveProperty('shops')
  })

  it('非预期形状 → 容错返回无 run', () => {
    expect(parseComplaintsOverview(null)).toEqual({ hasRun: false, needsReply: null })
    expect(parseComplaintsOverview({ metrics: { total_needs_reply: 'x' } })).toEqual({
      hasRun: false,
      needsReply: null,
    })
    expect(
      parseComplaintsOverview({ projects: { project_id: 1 }, metrics: { total_needs_reply: 3 } })
    ).toEqual({ hasRun: false, needsReply: 3 })
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
