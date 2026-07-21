import { describe, expect, it } from 'vitest'
import { cmToInch, kgToLb, formatInch, formatLb } from './unit-convert'

describe('unit-convert', () => {
  it('cmToInch converts correctly', () => {
    expect(cmToInch(2.54)).toBeCloseTo(1, 4)
    expect(cmToInch(10)).toBeCloseTo(3.937, 2)
    expect(cmToInch(0)).toBe(0)
  })

  it('kgToLb converts correctly', () => {
    expect(kgToLb(1)).toBeCloseTo(2.2046, 3)
    expect(kgToLb(0)).toBe(0)
    expect(kgToLb(0.5)).toBeCloseTo(1.1023, 3)
  })

  it('formatInch returns formatted string', () => {
    expect(formatInch(2.54)).toBe('1.00 in')
    expect(formatInch(10)).toBe('3.94 in')
  })

  it('formatLb returns formatted string', () => {
    expect(formatLb(1)).toBe('2.20 lb')
    expect(formatLb(0.5)).toBe('1.10 lb')
  })
})
