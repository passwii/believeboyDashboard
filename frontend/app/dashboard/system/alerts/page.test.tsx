import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

// BEL-424 契约测试：告警中心的项目列表改走 projects/manage 2min 客户端缓存，
// mount 不再裸 fetch 共享项目端点。

vi.mock('@/lib/alerts-api', () => ({
  fetchAlertStats: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([{ id: 1, name: '测试项目' }]),
}))

vi.mock('./components/alert-stats-bar', () => ({
  AlertStatsBar: () => <div data-testid="stats-bar" />,
}))
vi.mock('./components/alert-events-tab', () => ({
  AlertEventsTab: () => <div data-testid="events-tab" />,
}))
vi.mock('./components/alert-rules-tab', () => ({
  AlertRulesTab: () => <div data-testid="rules-tab" />,
}))
vi.mock('./components/alert-preferences-tab', () => ({
  AlertPreferencesTab: () => <div data-testid="preferences-tab" />,
}))

import AlertCenterPage from './page'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

describe('AlertCenterPage mount 请求行为（BEL-424）', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('项目列表走 2min 客户端缓存，mount 不裸 fetch projects/manage', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))

    render(<AlertCenterPage />)
    await waitFor(() => expect(fetchManagedProjectsCached).toHaveBeenCalledTimes(1))

    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/api/v1/projects/manage'))
    ).toHaveLength(0)
  })
})
