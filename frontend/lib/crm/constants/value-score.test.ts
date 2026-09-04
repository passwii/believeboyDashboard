import { describe, it, expect } from 'vitest'
import {
  SCORE_FIELDS,
  GRADE_OPTIONS,
  GRADE_COLOR,
  computeRating,
  DEFAULT_WEIGHTS,
} from './value-score'

describe('constants', () => {
  it('4 维定义', () => {
    expect(SCORE_FIELDS).toHaveLength(4)
    expect(SCORE_FIELDS.map((f) => f.key)).toEqual([
      'score_scale',
      'score_pay',
      'score_fit',
      'score_coop',
    ])
    expect(SCORE_FIELDS.every((f) => f.label && f.tooltip.length > 5)).toBe(true)
  })
  it('档位与配色', () => {
    expect(GRADE_OPTIONS).toEqual(['A', 'B', 'C', 'D'])
    expect(Object.keys(GRADE_COLOR)).toEqual(['A', 'B', 'C', 'D'])
  })
  it('等权向量', () => {
    expect(
      Math.abs(Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0) - 1)
    ).toBeLessThan(1e-9)
  })
})

describe('computeRating', () => {
  it('4A→A / 4D→D', () => {
    expect(
      computeRating({ score_scale: 'A', score_pay: 'A', score_fit: 'A', score_coop: 'A' })
    ).toBe('A')
    expect(
      computeRating({ score_scale: 'D', score_pay: 'D', score_fit: 'D', score_coop: 'D' })
    ).toBe('D')
  })
  it('任一空→null', () => {
    expect(
      computeRating({ score_scale: 'A', score_pay: 'B', score_fit: 'C', score_coop: null })
    ).toBeNull()
  })
  it('A A A D = 3.25 → B', () => {
    expect(
      computeRating({ score_scale: 'A', score_pay: 'A', score_fit: 'A', score_coop: 'D' })
    ).toBe('B')
  })
  it('权重生效', () => {
    const s = { score_scale: 'D', score_pay: 'A', score_fit: 'D', score_coop: 'D' }
    expect(computeRating(s)).toBe('C')
    expect(
      computeRating(s, { score_scale: 0, score_pay: 1, score_fit: 0, score_coop: 0 })
    ).toBe('A')
  })
})