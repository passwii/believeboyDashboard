import { describe, expect, it } from 'vitest'

import { reduceAlertStats } from './use-alert-stats'

describe('reduceAlertStats（BLF-922 Stage 3）', () => {
  it('critical 2 / warning 3 → severity "critical"', () => {
    const result = reduceAlertStats({
      total_active: 5,
      critical_count: 2,
      warning_count: 3,
    })
    expect(result).toEqual({
      totalActive: 5,
      criticalCount: 2,
      warningCount: 3,
      severity: 'critical',
    })
  })

  it('total 3 / critical 0 / warning 3 → severity "warning"', () => {
    const result = reduceAlertStats({
      total_active: 3,
      critical_count: 0,
      warning_count: 3,
    })
    expect(result).toEqual({
      totalActive: 3,
      criticalCount: 0,
      warningCount: 3,
      severity: 'warning',
    })
  })

  it('全 0 → severity "none"', () => {
    const result = reduceAlertStats({
      total_active: 0,
      critical_count: 0,
      warning_count: 0,
    })
    expect(result).toEqual({
      totalActive: 0,
      criticalCount: 0,
      warningCount: 0,
      severity: 'none',
    })
  })

  it('null payload → 全 0 / none（容错）', () => {
    expect(reduceAlertStats(null)).toEqual({
      totalActive: 0,
      criticalCount: 0,
      warningCount: 0,
      severity: 'none',
    })
  })
})