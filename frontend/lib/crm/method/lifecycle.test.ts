import { describe, expect, it } from 'vitest'
import { buildTimeFunnelStages } from './lifecycle'
import type { LifecycleDistribution } from '@/lib/crm/types'

function makeDist(
  sampleCount: number,
  buckets: [label: string, maxDays: number | undefined, cumulativePct: number][]
): LifecycleDistribution {
  return {
    metric: 'conversion',
    label: '转化',
    description: 'x',
    summary: { sampleCount, totalCount: sampleCount },
    buckets: buckets.map(([label, maxDays, cumulativePct]) => ({
      label,
      minDays: 0,
      maxDays,
      count: 0,
      pct: 0,
      cumulativePct,
    })),
  }
}

describe('buildTimeFunnelStages（转化时间漏斗，BLF-520）', () => {
  it('空样本返回空数组', () => {
    expect(buildTimeFunnelStages(makeDist(0, []))).toEqual([])
    expect(buildTimeFunnelStages(undefined)).toEqual([])
  })

  it('宽 → 窄排列：已转化 → 30 天内 → … → 1 天内，值单调不增', () => {
    const dist = makeDist(100, [
      ['1 天内', 1, 0.1],
      ['1-3 天', 3, 0.3],
      ['3-7 天', 7, 0.6],
      ['7-14 天', 14, 0.8],
      ['14-30 天', 30, 0.95],
      ['30 天以上', undefined, 1.0],
    ])
    const stages = buildTimeFunnelStages(dist)
    expect(stages.map((s) => s.label)).toEqual([
      '已转化',
      '30 天内',
      '14 天内',
      '7 天内',
      '3 天内',
      '1 天内',
    ])
    expect(stages.map((s) => s.value)).toEqual([100, 95, 80, 60, 30, 10])
    // 值单调不增（漏斗宽度逐级收窄）
    for (let i = 1; i < stages.length; i++) {
      expect(stages[i].value).toBeLessThanOrEqual(stages[i - 1].value)
    }
    expect(stages[0].pct).toBe(1)
  })

  it('累计计数 = round(cumulative_pct × sample_count)', () => {
    const dist = makeDist(37, [
      ['1 天内', 1, 0.3333],
      ['1-3 天', 3, 0.6667],
      ['3-7 天', 7, 1.0],
      ['7-14 天', 14, 1.0],
      ['14-30 天', 30, 1.0],
      ['30 天以上', undefined, 1.0],
    ])
    const stages = buildTimeFunnelStages(dist)
    expect(stages[1].value).toBe(Math.round(1.0 * 37)) // 30 天内 = 37
    expect(stages[5].value).toBe(Math.round(0.3333 * 37)) // 1 天内 ≈ 12
    expect(stages[5].displayValue).toBe(`${stages[5].value} 个`)
  })
})
