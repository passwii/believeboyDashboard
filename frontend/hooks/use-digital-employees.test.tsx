import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchDigitalEmployees = vi.hoisted(() => vi.fn())

vi.mock('@/lib/digital-employee-api', () => ({
  fetchDigitalEmployees,
}))

import { useDigitalEmployees } from './use-digital-employees'

describe('useDigitalEmployees', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fetchDigitalEmployees.mockResolvedValue({
      items: [
        {
          id: 1,
          name: '测试员工',
          description: null,
          avatar_url: null,
          employee_type: 'AI_AGENT',
          status: 'IDLE',
          last_heartbeat_at: null,
          is_silent_alert_threshold_minutes: 30,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
      total: 1,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('keeps the existing 10-second polling and manual mutate contract', async () => {
    const { result } = renderHook(() => useDigitalEmployees())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchDigitalEmployees).toHaveBeenCalledTimes(1)
    expect(result.current.employees).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(fetchDigitalEmployees).toHaveBeenCalledTimes(2)

    act(() => {
      result.current.mutate()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchDigitalEmployees).toHaveBeenCalledTimes(3)
  })
})
