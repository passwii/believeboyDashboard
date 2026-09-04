import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

import { usePresenceCount } from './use-presence-count'

describe('usePresenceCount（BLF-922 Stage 3）', () => {
  it('presence 响应 4 人 → online 4', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        server_time: '2026-08-31T12:00:00Z',
        items: [
          { user_id: '1', display_name: 'A' },
          { user_id: '2', display_name: 'B' },
          { user_id: '3', display_name: 'C' },
          { user_id: '4', display_name: 'D' },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => usePresenceCount())
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(result.current.online).toBe(4)
    vi.unstubAllGlobals()
  })

  it('空 items → online 0', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        server_time: '2026-08-31T12:00:00Z',
        items: [],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => usePresenceCount())
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(result.current.online).toBe(0)
    vi.unstubAllGlobals()
  })

  it('fetch 失败 → status error, online null', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network error'))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => usePresenceCount())
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.online).toBeNull()
    vi.unstubAllGlobals()
  })

  it('items 不合法 → online 0（容错）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        server_time: '2026-08-31T12:00:00Z',
        items: null,
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => usePresenceCount())
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(result.current.online).toBe(0)
    vi.unstubAllGlobals()
  })
})