import { describe, it, expect } from 'vitest'
import { buildUserContent } from './build-prompt'
import type { ScenarioField } from '@/lib/server/ai-chat'

const schema: ScenarioField[] = [
  { key: 'period', label: '汇报周期', type: 'text' },
  { key: 'metrics', label: '核心指标', type: 'textarea' },
]

describe('buildUserContent', () => {
  it('仅自由文本', () => {
    const out = buildUserContent({ freeText: '本周 ACOS 升高', guidedFields: {}, schema })
    expect(out).toContain('本周 ACOS 升高')
    expect(out).not.toContain('补充信息')
  })
  it('合并引导字段', () => {
    const out = buildUserContent({
      freeText: '草稿',
      guidedFields: { period: '本周', metrics: '销售额 1w' },
      schema,
    })
    expect(out).toContain('【原始内容】')
    expect(out).toContain('【补充信息】')
    expect(out).toContain('汇报周期：本周')
    expect(out).toContain('核心指标：销售额 1w')
  })
})
