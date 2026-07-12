import { describe, it, expect } from 'vitest'
import { isFullBleedDashboardRoute } from './routes'

describe('isFullBleedDashboardRoute', () => {
  it('returns true for /dashboard/ai-chat', () => {
    expect(isFullBleedDashboardRoute('/dashboard/ai-chat')).toBe(true)
  })

  it('returns false for dashboard root', () => {
    expect(isFullBleedDashboardRoute('/dashboard')).toBe(false)
  })

  it('returns false for other dashboard sub-routes', () => {
    expect(isFullBleedDashboardRoute('/dashboard/data-analysis/ad-analysis/overview')).toBe(false)
    expect(isFullBleedDashboardRoute('/dashboard/shipment')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isFullBleedDashboardRoute('')).toBe(false)
  })

  it('does NOT match partial prefix (e.g. /dashboard/ai-chat-v2)', () => {
    expect(isFullBleedDashboardRoute('/dashboard/ai-chat-v2')).toBe(false)
  })
})
