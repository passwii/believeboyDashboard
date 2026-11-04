import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { isWarmLedgerRoute } from '@/components/dashboard-v2/warm-ledger/shell/warm-ledger-route-frame'

const { fetchProjectOptionsCachedMock } = vi.hoisted(() => ({
  fetchProjectOptionsCachedMock: vi.fn(),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchProjectOptionsCached: fetchProjectOptionsCachedMock,
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
}))

import DigitalDisplayPage from './page'

describe('DigitalDisplayPage exception', () => {
  it('stays outside Warm Ledger and preserves forced dark/fullscreen behavior', async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    })
    fetchProjectOptionsCachedMock.mockResolvedValue({ items: [] })

    const { container, unmount } = render(<DigitalDisplayPage />)

    expect(isWarmLedgerRoute('/dashboard/system/digital-display')).toBe(false)
    expect(container.firstElementChild).toHaveAttribute(
      'data-digital-display-exception',
      'true',
    )
    expect(container.firstElementChild).not.toHaveClass('warm-ledger')
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'))
    expect(requestFullscreen).toHaveBeenCalledTimes(1)

    unmount()
    expect(document.documentElement).not.toHaveClass('dark')
  })
})
