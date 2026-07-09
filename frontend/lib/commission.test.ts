import { describe, it, expect } from 'vitest'
import {
  getProjectCashReceivedCommissionRate,
  resolveProjectCommissionUsd,
} from './commission'

describe('getProjectCashReceivedCommissionRate', () => {
  it('returns 0 when payback ratio is below the first tier', () => {
    expect(getProjectCashReceivedCommissionRate(0.3)).toBe(0)
  })

  it('maps ratio to the correct tier rate', () => {
    expect(getProjectCashReceivedCommissionRate(0.45)).toBe(0.07)
    expect(getProjectCashReceivedCommissionRate(0.55)).toBe(0.1)
    expect(getProjectCashReceivedCommissionRate(0.65)).toBe(0.13)
    expect(getProjectCashReceivedCommissionRate(0.8)).toBe(0.15)
  })

  it('treats non-finite input as 0', () => {
    expect(getProjectCashReceivedCommissionRate(NaN)).toBe(0)
    expect(getProjectCashReceivedCommissionRate(Infinity)).toBe(0)
  })
})

describe('resolveProjectCommissionUsd', () => {
  it('uses the configured rate for sales_amount basis', () => {
    const result = resolveProjectCommissionUsd({
      commissionBasis: 'sales_amount',
      configuredCommissionRate: 0.1,
      incomeTotalUsd: 1000,
      amazonPaybackUsd: 500,
    })
    expect(result.commissionRate).toBe(0.1)
    expect(result.baseAmountUsd).toBe(1000)
    expect(result.commissionUsd).toBe(100)
  })

  it('derives rate from payback ratio for cash_received basis', () => {
    const result = resolveProjectCommissionUsd({
      commissionBasis: 'cash_received',
      configuredCommissionRate: 0.2,
      incomeTotalUsd: 1000,
      amazonPaybackUsd: 600,
    })
    expect(result.commissionRate).toBe(0.13) // 0.6 -> 0.13 tier
    expect(result.baseAmountUsd).toBe(600)
    expect(result.commissionUsd).toBeCloseTo(78)
  })

  it('falls back to 0 base when payback is non-finite', () => {
    const result = resolveProjectCommissionUsd({
      commissionBasis: 'cash_received',
      configuredCommissionRate: 0.2,
      incomeTotalUsd: NaN,
      amazonPaybackUsd: NaN,
    })
    expect(result.baseAmountUsd).toBe(0)
    expect(result.commissionUsd).toBe(0)
  })
})
