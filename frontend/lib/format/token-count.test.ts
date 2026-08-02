import { describe, it, expect } from 'vitest'
import { formatTokenCount } from './token-count'

describe('formatTokenCount', () => {
  it('null/undefined/非有限数回退为 "0"', () => {
    expect(formatTokenCount(null)).toBe('0')
    expect(formatTokenCount(undefined)).toBe('0')
    expect(formatTokenCount(NaN)).toBe('0')
    expect(formatTokenCount(Infinity)).toBe('0')
    expect(formatTokenCount(-Infinity)).toBe('0')
  })

  it('负数夹到 0', () => {
    expect(formatTokenCount(-42)).toBe('0')
  })

  it('小于 1000 显示完整数字', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(1)).toBe('1')
    expect(formatTokenCount(842)).toBe('842')
    expect(formatTokenCount(999)).toBe('999')
  })

  it('1000~999_499 走 k 档', () => {
    expect(formatTokenCount(1000)).toBe('1k')
    expect(formatTokenCount(1200)).toBe('1.2k')
    expect(formatTokenCount(12_345)).toBe('12.3k')
    expect(formatTokenCount(999_499)).toBe('999.5k')
  })

  it('999_500 起走 m 档', () => {
    expect(formatTokenCount(999_500)).toBe('1m')
    expect(formatTokenCount(1_234_567)).toBe('1.2m')
    expect(formatTokenCount(12_345_678)).toBe('12.3m')
  })

  it('十亿级走 b 档', () => {
    expect(formatTokenCount(1_500_000_000)).toBe('1.5b')
  })

  it('非整数输入向下取整', () => {
    expect(formatTokenCount(842.9)).toBe('842')
    expect(formatTokenCount(1599.4)).toBe('1.6k')
  })
})