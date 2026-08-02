import { describe, it, expect } from 'vitest'
import { buildLeadFunnelStages, leadConversionRate } from './lead-funnel'

describe('buildLeadFunnelStages（累计转化漏斗）', () => {
  it('各层按累计口径计算：每层 = 该阶段及以上之和', () => {
    const stages = buildLeadFunnelStages({
      new: 18,
      contacting: 14,
      qualified: 9,
      converted: 4,
      discarded: 5,
    })
    // 总量=18+14+9+4=45 联系=14+9+4=27 验证=9+4=13 转化=4
    expect(stages.map((s) => s.value)).toEqual([45, 27, 13, 4])
  })

  it('漏斗恒单调收窄（后一层 ≤ 前一层）', () => {
    // 即使原始快照"联系中比新线索多"（旧实现的 bug 场景），累计口径也不会变宽
    const stages = buildLeadFunnelStages({ new: 3, contacting: 20, qualified: 8, converted: 6 })
    for (let i = 1; i < stages.length; i++) {
      expect(stages[i].value).toBeLessThanOrEqual(stages[i - 1].value)
    }
  })

  it('discarded 不计入主漏斗', () => {
    const stages = buildLeadFunnelStages({ discarded: 10 })
    expect(stages[0].value).toBe(0)
  })

  it('空输入返回全 0 但保留四档结构', () => {
    const stages = buildLeadFunnelStages({})
    expect(stages).toHaveLength(4)
    expect(stages.every((s) => s.value === 0)).toBe(true)
  })

  it('四档 label 与渐变配置固定', () => {
    const stages = buildLeadFunnelStages({ new: 1 })
    expect(stages.map((s) => s.label)).toEqual(['线索总量', '跟进联系', '验证', '转化'])
    for (const s of stages) {
      expect(s.gradient).toHaveLength(2)
      expect(s.gradient?.[0].offset).toBe(0)
      expect(s.gradient?.[1].offset).toBe(1)
    }
  })
})

describe('leadConversionRate（整体转化率）', () => {
  it('= 转化 / 线索总量', () => {
    const rate = leadConversionRate({ new: 18, contacting: 14, qualified: 9, converted: 4 })
    expect(rate).toBeCloseTo(4 / 45)
  })

  it('总量为 0 时返回 null', () => {
    expect(leadConversionRate({})).toBeNull()
    expect(leadConversionRate({ discarded: 3 })).toBeNull()
  })
})
