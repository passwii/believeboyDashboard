import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AlertStatsBar } from './alert-stats-bar'

describe('AlertStatsBar Warm Ledger', () => {
  it('使用 Warm 指标面板并展示真实统计字段', () => {
    const { container } = render(
      <AlertStatsBar
        stats={{
          total_active: 9,
          critical_count: 2,
          warning_count: 3,
          info_count: 4,
          acknowledged_today: 5,
          resolved_today: 6,
        }}
      />
    )

    expect(container.querySelector('[data-warm-alert-stats="true"]')).toBeTruthy()
    expect(container.querySelector('[class*="term-"]')).toBeNull()
    expect(container.querySelector('.rounded-none')).toBeNull()
    expect(screen.getByText('活跃告警')).toBeTruthy()
    expect(screen.getByText('9')).toBeTruthy()
    expect(screen.getByText('6')).toBeTruthy()
  })
})
