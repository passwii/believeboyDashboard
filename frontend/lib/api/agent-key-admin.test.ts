import { describe, expect, it } from 'vitest'
import { isValidAgentId, normalizeProjectScope } from './agent-key-admin'

describe('normalizeProjectScope', () => {
  it('空串 → 全部项目 *', () => {
    expect(normalizeProjectScope('')).toBe('*')
    expect(normalizeProjectScope('   ')).toBe('*')
  })

  it('null / undefined → 全部项目 *', () => {
    expect(normalizeProjectScope(null)).toBe('*')
    expect(normalizeProjectScope(undefined)).toBe('*')
  })

  it('* 保持原样', () => {
    expect(normalizeProjectScope('*')).toBe('*')
    expect(normalizeProjectScope(' * ')).toBe('*')
  })

  it('白名单保持 ',' 分隔的 project_id', () => {
    expect(normalizeProjectScope('12,34')).toBe('12,34')
    expect(normalizeProjectScope(' 12 , 34 ')).toBe('12 , 34')
  })
})

describe('isValidAgentId（BLF-861，与 backend AGENT_ID_PATTERN 对齐）', () => {
  it('合法：3-128 小写字母/数字开头 a-z0-9-_', () => {
    expect(isValidAgentId('abc')).toBe(true)
    expect(isValidAgentId('shipment-assistant-prod')).toBe(true)
    expect(isValidAgentId('a-1_b')).toBe(true)
  })
  it('非法：过短 / 大写 / 前导 - / 空白', () => {
    expect(isValidAgentId('ab')).toBe(false)
    expect(isValidAgentId('ABc')).toBe(false)
    expect(isValidAgentId('-lead')).toBe(false)
    expect(isValidAgentId('has space')).toBe(false)
    expect(isValidAgentId('')).toBe(false)
  })
})
