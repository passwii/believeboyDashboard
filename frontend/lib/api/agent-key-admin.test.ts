import { describe, expect, it } from 'vitest'
import { normalizeProjectScope } from './agent-key-admin'

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
