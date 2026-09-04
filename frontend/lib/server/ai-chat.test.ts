import { describe, it, expect } from 'vitest'
import {
  getScenarioPresetSummaries,
  buildScenarioSystemPrompt,
  validateScenarioIds,
} from './ai-chat'

describe('getScenarioPresetSummaries', () => {
  it('ops-report 启用、email-compose 禁用', () => {
    const { scenarios } = getScenarioPresetSummaries()
    const ops = scenarios.find((s) => s.id === 'ops-report')
    const email = scenarios.find((s) => s.id === 'email-compose')
    expect(ops?.disabled).toBe(false)
    expect(email?.disabled).toBe(true)
    expect(ops?.mode).toBe('refine')
    expect(email?.mode).toBe('compose')
  })
})

describe('buildScenarioSystemPrompt', () => {
  it('拼入 场景+语气+长度+语言 指令', () => {
    const sp = buildScenarioSystemPrompt('ops-report', 'brief', 'zh', 'brief')
    expect(sp).toContain('资深')
    expect(sp).toContain('一句话结论')
    expect(sp).toContain('快速同步')
    expect(sp).toContain('用中文输出')
  })
  it('未知场景回退兜底', () => {
    expect(buildScenarioSystemPrompt('nope')).toContain('乐于助人')
  })
})

describe('validateScenarioIds', () => {
  it('允许空场景', () => expect(validateScenarioIds(null, null)).toBe(true))
  it('拒绝未知场景', () => expect(validateScenarioIds('ghost', null)).toBe(false))
  it('拒绝场景内未知语气', () => expect(validateScenarioIds('ops-report', 'ghost')).toBe(false))
  it('接受已知语气', () => expect(validateScenarioIds('ops-report', 'formal')).toBe(true))
  it('拒绝 disabled 场景（无语气）', () => expect(validateScenarioIds('email-compose', null)).toBe(false))
  it('拒绝 disabled 场景（带语气）', () => expect(validateScenarioIds('email-compose', 'formal')).toBe(false))
})
