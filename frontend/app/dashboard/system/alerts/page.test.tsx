import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

const { REFRESH_HANDLER, REFRESH_LOADING, EVENTS_REFRESH, NOTIFY } = vi.hoisted(() => ({
  REFRESH_HANDLER: { current: null as null | (() => Promise<void>) },
  REFRESH_LOADING: { current: false },
  EVENTS_REFRESH: vi.fn(async () => {}),
  NOTIFY: vi.fn(),
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (handler: () => Promise<void>, opts?: { loading?: boolean }) => {
    REFRESH_HANDLER.current = handler
    REFRESH_LOADING.current = opts?.loading ?? false
    return { setLoading: vi.fn() }
  },
}))

// BEL-424 契约测试：告警中心的项目列表改走 projects/manage 2min 客户端缓存，
// mount 不再裸 fetch 共享项目端点。

vi.mock('@/components/notifications', () => ({
  useNotifications: () => ({ notify: NOTIFY }),
}))

vi.mock('@/components/terminal/term-controls', () => ({
  TermPageShell: ({ children }: { children: import('react').ReactNode }) => <>{children}</>,
}))

vi.mock('@/lib/alerts-api', () => ({
  fetchAlertStats: vi.fn().mockResolvedValue(null),
  fetchAlertEvents: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  fetchAlertPreferences: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn().mockResolvedValue([{ id: 1, name: '测试项目' }]),
}))

vi.mock('./components/alert-stats-bar', () => ({
  AlertStatsBar: ({ stats }: { stats: { total_active: number } | null }) => (
    <div data-testid="stats-bar">{stats?.total_active ?? 'empty'}</div>
  ),
}))
vi.mock('./components/alert-events-tab', async () => {
  const React = await import('react')
  return {
    AlertEventsTab: ({ onRefreshReady }: { onRefreshReady?: (refresh: () => Promise<void>) => void }) => {
      React.useEffect(() => {
        onRefreshReady?.(EVENTS_REFRESH)
      }, [onRefreshReady])
      return <div data-testid="events-tab" />
    },
  }
})
vi.mock('./components/alert-rules-tab', async () => {
  const React = await import('react')
  return {
    AlertRulesTab: ({
      onRefreshReady,
      projects,
    }: {
      onRefreshReady?: (refresh: () => Promise<void>) => void
      projects: Array<{ id: number; name: string }>
    }) => {
      React.useEffect(() => {
        onRefreshReady?.(async () => {})
      }, [onRefreshReady])
      return <div data-testid="rules-tab">{projects.map((project) => project.name).join(',')}</div>
    },
  }
})
vi.mock('./components/alert-preferences-tab', async () => {
  const React = await import('react')
  const { fetchAlertPreferences } = await import('@/lib/alerts-api')
  return {
    AlertPreferencesTab: ({ onRefreshReady }: { onRefreshReady?: (refresh: () => Promise<void>) => void }) => {
      React.useEffect(() => {
        onRefreshReady?.(async () => { await fetchAlertPreferences() })
      }, [onRefreshReady])
      return <div data-testid="preferences-tab" />
    },
  }
})

import AlertCenterPage from './page'
import userEvent from '@testing-library/user-event'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

describe('AlertCenterPage mount 请求行为（BEL-424）', () => {
  afterEach(() => {
    cleanup()
    REFRESH_LOADING.current = false
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

  it('Head 刷新重新读取告警统计与项目列表 owner', async () => {
    const { fetchAlertStats } = await import('@/lib/alerts-api')
    const fetchAlertStatsMock = vi.mocked(fetchAlertStats)
    const fetchManagedProjectsCachedMock = vi.mocked(fetchManagedProjectsCached)
    render(<AlertCenterPage />)
    await waitFor(() => expect(fetchManagedProjectsCachedMock).toHaveBeenCalledTimes(1))
    const statsBefore = fetchAlertStatsMock.mock.calls.length
    const projectsBefore = fetchManagedProjectsCachedMock.mock.calls.length

    await act(async () => { await REFRESH_HANDLER.current?.() })

    expect(fetchAlertStatsMock).toHaveBeenCalledTimes(statsBefore + 1)
    expect(fetchManagedProjectsCachedMock).toHaveBeenCalledTimes(projectsBefore + 1)
  })

  it('Head 元数据刷新失败时保留上次成功的数据并提示错误', async () => {
    const { fetchAlertStats } = await import('@/lib/alerts-api')
    const fetchAlertStatsMock = vi.mocked(fetchAlertStats)
    const fetchManagedProjectsCachedMock = vi.mocked(fetchManagedProjectsCached)
    fetchAlertStatsMock
      .mockReset()
      .mockResolvedValueOnce({
        total_active: 7,
        critical_count: 1,
        warning_count: 2,
        info_count: 4,
        acknowledged_today: 0,
        resolved_today: 0,
      })
      .mockRejectedValueOnce(new Error('stats unavailable'))
    fetchManagedProjectsCachedMock
      .mockReset()
      .mockResolvedValueOnce([{ id: 1, name: '保留项目' }])
      .mockRejectedValueOnce(new Error('projects unavailable'))

    render(<AlertCenterPage />)
    await waitFor(() => expect(screen.getByTestId('stats-bar')).toHaveTextContent('7'))
    expect(screen.getByTestId('events-tab')).toBeInTheDocument()

    await act(async () => { await REFRESH_HANDLER.current?.() })

    expect(screen.getByTestId('stats-bar')).toHaveTextContent('7')
    expect(screen.getByTestId('events-tab')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('tab', { name: '告警规则' }))
    expect(screen.getByTestId('rules-tab')).toHaveTextContent('保留项目')
    expect(NOTIFY).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      title: '告警中心刷新失败',
      message: expect.stringContaining('stats unavailable'),
    }))
    expect(NOTIFY).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('projects unavailable'),
    }))
  })

  it('Head 刷新期间通过 useHeaderRefresh 暴露 loading 状态，结束后复位', async () => {
    const { fetchAlertStats } = await import('@/lib/alerts-api')
    const fetchAlertStatsMock = vi.mocked(fetchAlertStats)
    fetchAlertStatsMock.mockReset().mockResolvedValue({
      total_active: 0,
      critical_count: 0,
      warning_count: 0,
      info_count: 0,
      acknowledged_today: 0,
      resolved_today: 0,
    })
    vi.mocked(fetchManagedProjectsCached).mockReset().mockResolvedValue([{ id: 1, name: '测试项目' }])
    render(<AlertCenterPage />)
    await waitFor(() => expect(fetchAlertStatsMock).toHaveBeenCalledTimes(1))
    let resolveStats!: (value: { total_active: number; critical_count: number; warning_count: number; info_count: number; acknowledged_today: number; resolved_today: number }) => void
    fetchAlertStatsMock.mockReturnValueOnce(new Promise((resolve) => { resolveStats = resolve }))
    const projectsBefore = vi.mocked(fetchManagedProjectsCached).mock.calls.length

    let refreshPromise: Promise<void> | undefined
    await act(async () => {
      refreshPromise = REFRESH_HANDLER.current?.()
      await Promise.resolve()
    })
    await waitFor(() => expect(REFRESH_LOADING.current).toBe(true))

    resolveStats({
      total_active: 3,
      critical_count: 0,
      warning_count: 1,
      info_count: 2,
      acknowledged_today: 0,
      resolved_today: 0,
    })
    await act(async () => { await refreshPromise })

    expect(REFRESH_LOADING.current).toBe(false)
    expect(vi.mocked(fetchManagedProjectsCached).mock.calls.length).toBeGreaterThan(projectsBefore)
  })

  it('活跃 Tab 自己是数据 owner 时注册并调用该 owner 的 refresh callback', async () => {
    render(<AlertCenterPage />)
    await waitFor(() => expect(REFRESH_HANDLER.current).toBeTypeOf('function'))

    await act(async () => { await REFRESH_HANDLER.current?.() })

    expect(EVENTS_REFRESH).toHaveBeenCalledTimes(1)
  })

  it('切换到偏好 Tab 后刷新会重新读取该 Tab owner，不调用事件列表 owner', async () => {
    const { fetchAlertEvents, fetchAlertPreferences } = await import('@/lib/alerts-api')
    const fetchAlertEventsMock = vi.mocked(fetchAlertEvents)
    const fetchAlertPreferencesMock = vi.mocked(fetchAlertPreferences)
    const user = userEvent.setup()
    render(<AlertCenterPage />)
    await user.click(screen.getByRole('tab', { name: '通知偏好' }))
    const eventsBefore = fetchAlertEventsMock.mock.calls.length
    const preferencesBefore = fetchAlertPreferencesMock.mock.calls.length

    await act(async () => { await REFRESH_HANDLER.current?.() })

    expect(fetchAlertPreferencesMock).toHaveBeenCalledTimes(preferencesBefore + 1)
    expect(fetchAlertEventsMock).toHaveBeenCalledTimes(eventsBefore)
  })
})
